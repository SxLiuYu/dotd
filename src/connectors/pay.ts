/**
 * src/connectors/pay.ts —— 一等支付工具 `pay.charge` 的执行体（2026-10-25）。
 *
 * 为什么要有它（主人的原话："审批操作不能是 shell.run，得是具体操作，
 * 比如点外卖支付这种操作"）：
 *   让模型用 shell.run + curl 去调支付接口，治理只能拦住"一条命令"，
 *   主人的卡片上是一段脚本，台账里也没有金额。支付是一个**有结构**的动作：
 *   金额、币种、类别、收款方、幂等单号。把它做成 spend 档工具后：
 *     - 审批卡写"支付 CNY 35.00 给 美团"；
 *     - 治理按 spend 契约校验参数，成功后自动记 spend_ledger；
 *     - 每次都要主人点头（spend 档永不复用）。
 *
 * 协议（最小、可对接任意网关）：
 *   POST <DOTD_PAY_ENDPOINT>
 *   headers: content-type: application/json
 *            authorization: Bearer <DOTD_PAY_TOKEN>   （配了才发）
 *            idempotency-key: <orderId>
 *   body: { amountCents, currency, category, payee, memo, orderId }
 *   成功：HTTP 2xx + JSON 里带 receiptId（或 id）；其它一律按失败处理。
 *
 * 安全边界：
 *   - 单笔上限 `DOTD_PAY_MAX_CENTS`（默认 100000 = ¥1000），超了直接拒，**不问主人**；
 *   - 当日累计上限 `DOTD_PAY_DAILY_CENTS`（默认 200000 = ¥2000），由装配层传入
 *     "今天已花"（读 spend_ledger，连接器不直接碰治理库）；
 *   - `DOTD_PAY_DRY_RUN=1`：不联网、返回合成回执 —— 用来把整条审批链跑通；
 *   - token 只从环境读，既不进参数、也不进回执/日志。
 *
 * 不做的事：
 *   - 不自动重试支付。超时/5xx 一律报 `PAY_AMBIGUOUS`/`PAY_REJECTED`，
 *     让主人确认后再决定 —— 钱的动作不能靠碎碎念重试。
 *   - 不解析各家网关的千奇百怪响应。只认 receiptId/id，其它当"结果不明"。
 */

import { createHash } from 'node:crypto';

export interface PayConfig {
  /** 真实支付网关（dryRun 时可为空串）。 */
  endpoint: string;
  /** Bearer token；空串 = 不带 Authorization。 */
  token: string;
  dryRun: boolean;
  /** 单笔上限（分）。 */
  maxCents: number;
  /** 当日累计上限（分）。 */
  dailyCents: number;
  timeoutMs: number;
}

export interface PayReceipt {
  receiptId: string;
  orderId: string;
  amountCents: number;
  currency: string;
  category: string;
  payee: string;
  status: string;
  dryRun: boolean;
}

export type PayResult =
  | { ok: true; value: PayReceipt }
  | { ok: false; code: string; message: string; retryable?: boolean };

export interface PayDeps {
  /** 幂等作用域：同一任务 + 同一参数 → 同一 orderId。 */
  taskId?: string;
  /** 今天已经花掉多少（分）。缺省 0（仍受单笔上限约束）。 */
  spentTodayCents?: () => number;
  /** 回执缓存（宿主 KV）：同一 orderId 命中直接返回，绝不重复扣款。 */
  getReceipt?: (orderId: string) => PayReceipt | null;
  putReceipt?: (receipt: PayReceipt) => void;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
    throw new Error(`${name} 非法：${raw}（要求整数 ≥ ${min}）`);
  }
  return n;
}

/**
 * 从环境读支付配置。**完全没配**（既没 endpoint 也没 dry-run）返回 null ——
 * 装配层据此不注册工具，模型也就看不到一个永远失败的口子。
 */
export function payConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PayConfig | null {
  const dryRun = env.DOTD_PAY_DRY_RUN === '1' || env.DOTD_PAY_DRY_RUN?.toLowerCase() === 'true';
  const endpoint = (env.DOTD_PAY_ENDPOINT ?? '').trim();
  if (!dryRun && endpoint === '') return null;
  if (!dryRun && !/^https?:\/\//i.test(endpoint)) {
    throw new Error(`DOTD_PAY_ENDPOINT 必须是 http(s) URL：${endpoint}`);
  }
  const maxCents = intEnv(env, 'DOTD_PAY_MAX_CENTS', 100_000, 1);
  const dailyCents = intEnv(env, 'DOTD_PAY_DAILY_CENTS', 200_000, 1);
  if (dailyCents < maxCents) {
    throw new Error(
      `DOTD_PAY_DAILY_CENTS(${dailyCents}) 不能小于 DOTD_PAY_MAX_CENTS(${maxCents})`,
    );
  }
  return {
    endpoint,
    token: (env.DOTD_PAY_TOKEN ?? '').trim(),
    dryRun,
    maxCents,
    dailyCents,
    timeoutMs: intEnv(env, 'DOTD_PAY_TIMEOUT_MS', 30_000, 1_000),
  };
}

function bad(message: string): PayResult {
  return { ok: false, code: 'BAD_ARG', message };
}

interface PayArgs {
  amountCents: number;
  currency: string;
  category: string;
  payee: string;
  memo: string;
  orderId: string;
}

/** 参数校验：与 `config/tools.yml` 的 spendParams 同口径，另外要求 payee。 */
function readArgs(raw: Record<string, unknown>): PayArgs | PayResult {
  const amountCents = raw.amountCents ?? raw.amount_cents;
  if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents <= 0) {
    return bad('amountCents 必须是正整数（单位：分；35.00 元 = 3500）');
  }
  const currency = typeof raw.currency === 'string' ? raw.currency.trim() : '';
  if (!/^[A-Z]{3}$/.test(currency)) return bad('currency 必须是 ISO4217 三字母（如 CNY）');
  const category = typeof raw.category === 'string' ? raw.category.trim() : '';
  if (category === '') return bad('category 不能为空（如 food / topup / shopping）');
  const payee = typeof raw.payee === 'string' ? raw.payee.trim() : '';
  if (payee === '') return bad('payee 不能为空：收款方/商户名要写在审批卡上');
  const memo = typeof raw.memo === 'string' ? raw.memo.trim().slice(0, 200) : '';
  const orderId =
    typeof raw.orderId === 'string' && raw.orderId.trim() !== ''
      ? raw.orderId.trim().slice(0, 80)
      : '';
  return { amountCents, currency, category, payee, memo, orderId };
}

function isPayResult(v: unknown): v is PayResult {
  return typeof v === 'object' && v !== null && 'ok' in (v as Record<string, unknown>);
}

/** 幂等单号：优先用调用方给的；否则按"任务 + 参数"确定性生成。 */
export function deriveOrderId(taskId: string, a: { amountCents: number; currency: string; payee: string; memo: string }): string {
  const h = createHash('sha256')
    .update(`${taskId}|${a.amountCents}|${a.currency}|${a.payee}|${a.memo}`)
    .digest('hex')
    .slice(0, 24);
  return `pay_${h}`;
}

function receiptOf(body: unknown, base: Omit<PayReceipt, 'receiptId' | 'status'>): PayReceipt | null {
  if (body === null || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  const id = typeof o.receiptId === 'string' && o.receiptId !== '' ? o.receiptId : typeof o.id === 'string' && o.id !== '' ? o.id : '';
  if (id === '') return null;
  const status = typeof o.status === 'string' && o.status !== '' ? o.status : 'succeeded';
  return { ...base, receiptId: id, status };
}

/**
 * 执行一次支付（宿主侧调用；**到达这里时治理已经批准过**）。
 */
export async function payCharge(
  cfg: PayConfig,
  rawArgs: Record<string, unknown>,
  deps: PayDeps = {},
): Promise<PayResult> {
  const args = readArgs(rawArgs);
  if (isPayResult(args)) return args;

  if (args.amountCents > cfg.maxCents) {
    return {
      ok: false,
      code: 'PAY_LIMIT',
      message: `单笔上限 ${cfg.maxCents} 分，本次 ${args.amountCents} 分；请拆单或改配置`,
    };
  }
  if (deps.spentTodayCents !== undefined) {
    const spent = Math.max(0, Math.round(deps.spentTodayCents()));
    if (spent + args.amountCents > cfg.dailyCents) {
      return {
        ok: false,
        code: 'PAY_DAILY_LIMIT',
        message: `当日上限 ${cfg.dailyCents} 分，今天已花 ${spent} 分，本次 ${args.amountCents} 分`,
      };
    }
  }

  const orderId = args.orderId !== '' ? args.orderId : deriveOrderId(deps.taskId ?? 'adhoc', args);
  const base = {
    orderId,
    amountCents: args.amountCents,
    currency: args.currency,
    category: args.category,
    payee: args.payee,
    dryRun: cfg.dryRun,
  };

  // 幂等：同一单号只要有过回执，就不再发请求。
  const cached = deps.getReceipt?.(orderId) ?? null;
  if (cached !== null) return { ok: true, value: cached };

  if (cfg.dryRun) {
    const receipt: PayReceipt = { ...base, receiptId: `dryrun_${orderId}`, status: 'succeeded' };
    deps.putReceipt?.(receipt);
    return { ok: true, value: receipt };
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'idempotency-key': orderId,
  };
  if (cfg.token !== '') headers.authorization = `Bearer ${cfg.token}`;

  const doFetch = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(cfg.endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        amountCents: args.amountCents,
        currency: args.currency,
        category: args.category,
        payee: args.payee,
        memo: args.memo,
        orderId,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (cause) {
    // 网络层失败 = 结果不明。**不自动重试**：钱可能已经动了。
    return {
      ok: false,
      code: 'PAY_UNREACHABLE',
      message: `支付网关不可达（${String(cause)}）。结果未知，请先在网关侧确认再重试`,
      retryable: false,
    };
  }

  const text = await res.text().catch(() => '');
  let body: unknown = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = null;
  }

  if (!res.ok) {
    const o = body as Record<string, unknown> | null;
    const detail =
      (typeof o?.message === 'string' && o.message) ||
      (typeof o?.error === 'string' && o.error) ||
      text.slice(0, 200) ||
      `HTTP ${res.status}`;
    return {
      ok: false,
      code: 'PAY_REJECTED',
      message: `网关拒绝（HTTP ${res.status}）：${detail}`,
      // 5xx/429 是"网关自己没接住"，可以重新发起；4xx 是参数/业务拒绝，重试没意义。
      retryable: res.status >= 500 || res.status === 429,
    };
  }

  const receipt = receiptOf(body, base);
  if (receipt === null) {
    return {
      ok: false,
      code: 'PAY_AMBIGUOUS',
      message: `网关 ${res.status} 但响应里没有 receiptId，无法确认是否扣款；请先核对再决定`,
      retryable: false,
    };
  }
  deps.putReceipt?.(receipt);
  return { ok: true, value: receipt };
}
