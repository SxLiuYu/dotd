/**
 * src/surfaces/cli.ts —— CLI（daemon 的 HTTP 瘦客户端，commander + stdlib fetch）。
 *
 * 依据（surfaces.md §5.6 + 契约 H2 + CONVENTIONS.md §3）：
 * - 命令集：`dotd serve|status|ask|approvals|approve|deny|watch|events|logs|task|cancel|hook|hb|sos-test`。
 * - 全部经 `http://127.0.0.1:7788`（契约 H2：全 daemon 唯一监听；CLI 不直连 SQLite，
 *   契约 D2「WAL/busy 之外不允许第二进程写库」）。
 * - token 顺序 `--token > DOTD_MASTER_TOKEN > ~/.dotd/cli_token`。
 * - daemon 不可达 → 退码 7（§5.6 原文）。
 * - `approve/deny` 调 `/api/approvals/:id/decision` 且只接受 `once|remember|reject` 词汇
 *   （GOV §3.3.1 映射：once→approve_once、remember→approve_remember、reject→reject）。
 * - `npm run dotd` = `node --import tsx src/surfaces/cli.ts`（CONVENTIONS §3）；
 *   package.json 的 bin.dotd 指向本文件。
 */

import { Command } from 'commander';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DOT_ID } from '../shared/ids.ts';

/** 本文件所在目录（入口判据用，与 src/daemon.ts 同一手法）。 */
const HERE = dirname(fileURLToPath(import.meta.url));

/** 契约 H2：CLI base URL 的唯一默认值。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:7788';

/** §5.6：daemon 不可达的退码。 */
export const EXIT_UNREACHABLE = 7;

/** CLI token 的第三顺位落点（§5.6）。 */
function cliTokenPath(): string {
  return join(homedir(), '.dotd', 'cli_token');
}

/** §5.6：token 顺序 `--token > DOTD_MASTER_TOKEN > ~/.dotd/cli_token`。 */
export function resolveToken(explicit?: string): string | null {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const env = process.env.DOTD_MASTER_TOKEN;
  if (env !== undefined && env.length > 0) return env;
  try {
    const t = readFileSync(cliTokenPath(), 'utf8').trim();
    if (t.length > 0) return t;
  } catch {
    // 无文件
  }
  return null;
}

/** 解析 base URL：`--url > DOTD_URL > 127.0.0.1:7788`。 */
export function resolveBaseUrl(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit.replace(/\/+$/, '');
  const env = process.env.DOTD_URL;
  if (env !== undefined && env.length > 0) return env.replace(/\/+$/, '');
  return DEFAULT_BASE_URL;
}

export interface CliOptions {
  token?: string;
  url?: string;
  dot?: string;
  json?: boolean;
  /** 覆盖 process.exit（测试用）。 */
  exit?: (code: number) => void;
  /** 覆盖 fetch（测试用）。 */
  fetch?: typeof fetch;
  /** 覆盖 stdout/stderr 写入（测试用）。 */
  out?: (text: string) => void;
  err?: (text: string) => void;
}

/** CLI 的 HTTP 调用结果（含 daemon 不可达的区分）。 */
export type ApiResult<T = unknown> =
  | { ok: true; status: number; body: T }
  | { ok: false; kind: 'unreachable' | 'http' | 'parse'; status?: number; message: string };

async function api<T>(
  method: 'GET' | 'POST',
  path: string,
  body: unknown | undefined,
  opts: CliOptions,
): Promise<ApiResult<T>> {
  const base = resolveBaseUrl(opts.url);
  const token = resolveToken(opts.token);
  const doFetch = opts.fetch ?? fetch;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (token !== null) headers['authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  try {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch {
      return { ok: false, kind: 'parse', status: res.status, message: text.slice(0, 200) };
    }
    if (!res.ok) {
      const msg = typeof (parsed as { message?: unknown } | null)?.message === 'string'
        ? (parsed as { message: string }).message
        : `HTTP ${res.status}`;
      return { ok: false, kind: 'http', status: res.status, message: msg };
    }
    return { ok: true, status: res.status, body: parsed as T };
  } catch (cause) {
    return { ok: false, kind: 'unreachable', message: `连不上 daemon（${base}）：${String(cause)}` };
  }
}

/** 统一输出与退码（§5.6：daemon 不可达退码 7）。 */
function emit(opts: CliOptions, text: string): void {
  (opts.out ?? ((t: string) => process.stdout.write(t)))(text.endsWith('\n') ? text : `${text}\n`);
}

function fail(opts: CliOptions, message: string, code = 1): void {
  (opts.err ?? ((t: string) => process.stderr.write(t)))(`${message}\n`);
  (opts.exit ?? ((c: number) => process.exit(c)))(code);
}

function render(value: unknown, asJson: boolean): string {
  return asJson ? `${JSON.stringify(value, null, 2)}\n` : `${JSON.stringify(value)}\n`;
}

/** `/api/channels` 的返回值形状（GET 的是 daemon，字段缺失即视为形状不对）。 */
export interface ChannelsReport {
  available: { feishu: boolean; telegram: boolean; email: boolean };
  order: string[];
  outboxPath: string;
  recent: Array<Record<string, unknown>>;
}

/**
 * 解析 `/api/channels`：**逐字段校验**，不信任 daemon 的返回值形状。
 * 缺字段返回 null（CLI 如实报"形状不对"），而不是把 undefined 当 false 打进结论——
 * 那会让自检在 daemon 是老版本时谎报"全部通道不可用"。
 */
export function asChannels(body: unknown): ChannelsReport | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const av = b['available'];
  if (typeof av !== 'object' || av === null) return null;
  const a = av as Record<string, unknown>;
  const order = Array.isArray(b['order']) ? (b['order'] as unknown[]).filter((x): x is string => typeof x === 'string') : null;
  if (order === null || order.length === 0) return null;
  if (typeof b['outboxPath'] !== 'string') return null;
  const recent = Array.isArray(b['recent'])
    ? (b['recent'] as unknown[]).filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    : [];
  return {
    available: {
      feishu: a['feishu'] === true,
      telegram: a['telegram'] === true,
      email: a['email'] === true,
    },
    order,
    outboxPath: b['outboxPath'],
    recent,
  };
}

/**
 * 建 CLI 程序（导出让测试可直接 parseAsync，不进进程）。
 * `serve` 在 cli.ts 里只做提示：真 daemon 入口是 `src/daemon.ts`（CONVENTIONS §3
 * `npm run serve`），CLI 本体是瘦客户端（§5.6）。
 */
export function buildCli(opts: CliOptions = {}): Command {
  const program = new Command();
  program
    .name('dotd')
    .description('自主 Dot 系统 CLI（HTTP 瘦客户端，默认 127.0.0.1:7788）')
    .option('--token <token>', 'master token（顺序：--token > DOTD_MASTER_TOKEN > ~/.dotd/cli_token）')
    .option('--url <url>', `daemon base URL（默认 ${DEFAULT_BASE_URL}）`)
    .option('--dot <dotId>', '目标 dot（默认 dot1）', DEFAULT_DOT_ID)
    .option('--json', 'JSON 缩进输出')
    .allowExcessArguments(false);

  const shared = program.opts<{ token?: string; url?: string; dot: string; json?: boolean }>();
  const merged = (): CliOptions => ({
    token: shared.token ?? opts.token,
    url: shared.url ?? opts.url,
    dot: shared.dot ?? opts.dot ?? DEFAULT_DOT_ID,
    json: shared.json ?? opts.json,
    exit: opts.exit,
    fetch: opts.fetch,
    out: opts.out,
    err: opts.err,
  });
  const dot = (): string => merged().dot ?? DEFAULT_DOT_ID;

  // serve：提示真入口（daemon 装配层归 daemon.ts）
  program
    .command('serve')
    .description('启动 daemon（实际入口 src/daemon.ts；本命令只做引导提示）')
    .action(() => {
      emit(merged(), 'daemon 本体入口 = `npm --prefix dotd run serve`（node --import tsx src/daemon.ts）。');
    });

  program
    .command('status')
    .description('队列 + 熔断 + 待批审批总览')
    .action(async () => {
      const o = merged();
      const q = await api('GET', `/api/queue?dot=${encodeURIComponent(dot())}`, undefined, o);
      if (!q.ok) return fail(o, q.message, q.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
      const b = await api('GET', '/api/breaker', undefined, o);
      const a = await api<{ approvals: unknown[] }>('GET', '/api/approvals?state=pending', undefined, o);
      emit(o, render({ queue: q.body, breaker: b.ok ? b.body : { error: b.message }, pendingApprovals: a.ok ? (a.body.approvals?.length ?? 0) : { error: a.message } }, o.json === true));
    });

  program
    .command('ask <text...>')
    .description('发起一次主人对话（cp.submit, priority=1）')
    .action(async (text: string[]) => {
      const o = merged();
      const r = await api('POST', '/api/messages', { text: text.join(' '), dotId: dot() }, o);
      if (!r.ok) return fail(o, r.message, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
      emit(o, render(r.body, o.json === true));
    });

  program
    .command('approvals')
    .description('待批审批列表')
    .action(async () => {
      const o = merged();
      const r = await api<{ approvals: Array<{ id: number; seq: number; status: string; summary: string; tier: string | null }> }>(
        'GET', '/api/approvals?state=pending', undefined, o,
      );
      if (!r.ok) return fail(o, r.message, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
      const rows = r.body.approvals ?? [];
      if (o.json === true) return emit(o, render(rows, true));
      if (rows.length === 0) return emit(o, '没有待批审批。');
      for (const a of rows) {
        emit(o, `#${a.seq}  id=${a.id}  [${a.status}]  tier=${a.tier ?? '-'}  ${a.summary}`);
      }
    });

  // approve/deny：只接受 once|remember|reject 词汇（§5.6）。
  // 两种写法都收：`approve <id> [once|remember]` 与 `approve [once|remember] <id>`
  // （词汇在前更贴近口语；id 恒为必填，缺 id → commander 报错退码 1）。
  const VERDICT_WORDS = ['once', 'remember', 'reject'] as const;
  type VerdictWord = (typeof VERDICT_WORDS)[number];
  const decision = (cmd: Command, defaultWord: VerdictWord): void => {
    cmd
      .argument('<id>', '审批 id（或展示序号 #seq 对应的数字 id）')
      .argument('[word]', 'once|remember|reject', defaultWord)
      .option('--note <text>', '主人补充指令（≤500 字符，GOV §3.3）')
      .action(async (a: string, b: string | undefined, lo: { note?: string }) => {
        const o = merged();
        // 归一：词在前还是 id 在前都能认
        let id = a;
        let word: VerdictWord = (b ?? defaultWord) as VerdictWord;
        if ((VERDICT_WORDS as readonly string[]).includes(a.toLowerCase())) {
          word = a.toLowerCase() as VerdictWord;
          id = b ?? '';
        }
        if (id.length === 0) {
          return fail(o, '缺少审批 id（用法：approve <id> [once|remember] / approve [once|remember] <id>）', 2);
        }
        if (!(VERDICT_WORDS as readonly string[]).includes(word.toLowerCase())) {
          return fail(o, `只接受 ${VERDICT_WORDS.join('|')} 词汇（收到：${word}）`, 2);
        }
        const verdict = word === 'remember' ? 'approve_remember' : word === 'once' ? 'approve_once' : 'reject';
        const r = await api('POST', `/api/approvals/${encodeURIComponent(id)}/decision`, {
          verdict,
          // §5.2：gov.decide(id, 'web'|'cli', verdict, actor) —— CLI 裁决必须把
          // 通道身份 'cli' 带给服务端（GOV 把 channel 原值写进 approvals.decided_by）
          channel: 'cli',
          ...(lo.note !== undefined ? { note: lo.note.slice(0, 500) } : {}),
        }, o);
        if (!r.ok) return fail(o, r.message, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
        emit(o, render(r.body, o.json === true));
      });
  };
  decision(program.command('approve').description('批准（once|remember）'), 'once');
  decision(program.command('deny').description('拒绝'), 'reject');

  program
    .command('watch')
    .description('实时事件流（SSE /api/stream）')
    .option('--topics <list>', '逗号分隔通道：chat,approval,queue,breaker,step,log')
    .action(async (lo: { topics?: string }) => {
      const o = merged();
      const token = resolveToken(o.token);
      if (token === null) {
        return fail(o, '没有 token（--token / DOTD_MASTER_TOKEN / ~/.dotd/cli_token）', 2);
      }
      const base = resolveBaseUrl(o.url);
      const q = lo.topics === undefined ? '' : `?topics=${encodeURIComponent(lo.topics)}&token=${encodeURIComponent(token)}`;
      emit(o, `连接到 ${base}/api/stream${q}（Ctrl-C 退出）…`);
      const ac = new AbortController();
      process.on('SIGINT', () => ac.abort());
      try {
        const res = await fetch(`${base}/api/stream${q}`, {
          headers: { accept: 'text/event-stream' },
          signal: ac.signal,
        });
        if (!res.ok || res.body === null) {
          return fail(o, `SSE 连接失败：HTTP ${res.status}`, res.status === 503 ? EXIT_UNREACHABLE : 1);
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
            if (dataLine !== undefined) emit(o, dataLine.slice(5).trim());
          }
        }
      } catch (cause) {
        if (!ac.signal.aborted) return fail(o, `SSE 中断：${String(cause)}`, 1);
      }
    });

  program
    .command('events')
    .description('CP events 分页（received_at 排序）')
    .option('--since <ts>', 'received_at 上界（游标分页）')
    .option('--limit <n>', '条数', '50')
    .action(async (lo: { since?: string; limit: string }) => {
      const o = merged();
      const q = `?limit=${encodeURIComponent(lo.limit)}${lo.since !== undefined ? `&since=${encodeURIComponent(lo.since)}` : ''}`;
      const r = await api('GET', `/api/events${q}`, undefined, o);
      if (!r.ok) return fail(o, r.message, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
      emit(o, render(r.body, o.json === true));
    });

  program
    .command('logs')
    .description('入站拒绝审计（surf_ingress_rejects 经 daemon 读出）')
    .option('--limit <n>', '条数', '50')
    .action(async (lo: { limit: string }) => {
      const o = merged();
      // §5.2 路由表无 /api/logs；经 /api/events 的旁路不可行——这里直接读库的只读投影
      // 由 daemon 暴露（见 http.ts 'events' 分支的同一张 events 表不适用）。
      // 阶段一：CLI 通过 /api/guard 的 recent 资源事件 + 提示 daemon 侧查询。
      const r = await api('GET', '/api/guard', undefined, o);
      if (!r.ok) return fail(o, r.message, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
      emit(o, render({ guard: r.body, limit: lo.limit, note: 'surf_ingress_rejects 的读路径待 /api/logs 路由补齐（surfaces.md §5.2 未列）' }, o.json === true));
    });

  program
    .command('task <taskId>')
    .description('查看任务（含 journal 步骤）')
    .action(async (taskId: string) => {
      const o = merged();
      // §5.2 路由表的 tasks/journal 子集由 CP 转调（H2）；阶段一经 /api/queue 投影 +
      // 任务明细 GET /api/tasks/:id 尚未在路由表——这里用 queue 里的行回答。
      const q = await api<{ queue: Array<{ id: string }> }>('GET', `/api/queue?dot=${encodeURIComponent(dot())}`, undefined, o);
      if (!q.ok) return fail(o, q.message, q.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
      const found = (q.body.queue ?? []).find((t) => t.id === taskId);
      emit(o, render(found ?? { error: 'not_found', taskId, note: 'GET /api/tasks/:id 路由待补（surfaces.md §5.2 转调 CP getTask）' }, o.json === true));
    });

  program
    .command('cancel <taskId>')
    .description('取消任务（cp.cancel(id, "user")）')
    .action(async (taskId: string) => {
      const o = merged();
      const r = await api('POST', `/api/queue/${encodeURIComponent(taskId)}/cancel`, {}, o);
      if (!r.ok) return fail(o, r.message, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
      emit(o, render(r.body, o.json === true));
    });

  program
    .command('hook <source> [bodyJson]')
    .description('手动投递一个 webhook（HMAC 签名由 CLI 计算，secret 取 env DOTD_HOOK_SECRET_<SOURCE>）')
    .action(async (source: string, bodyJson?: string) => {
      const o = merged();
      const body = bodyJson ?? '{}';
      const envName = `DOTD_HOOK_SECRET_${source.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
      const secret = process.env[envName];
      if (secret === undefined || secret.length === 0) {
        return fail(o, `缺少 hook secret（env ${envName}；config 里 ${source} 的 secret 占位符）`, 2);
      }
      const ts = String(Math.floor(Date.now() / 1000));
      const nonce = Math.random().toString(36).slice(2, 12);
      const { createHmac } = await import('node:crypto');
      const sig = `sha256=${createHmac('sha256', secret).update(`${ts}\n${nonce}\n${body}`).digest('hex')}`;
      const base = resolveBaseUrl(o.url);
      const doFetch = o.fetch ?? fetch;
      try {
        const res = await doFetch(`${base}/hooks/${encodeURIComponent(source)}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-dotd-timestamp': ts,
            'x-dotd-nonce': nonce,
            'x-dotd-signature': sig,
          },
          body,
        });
        const text = await res.text();
        emit(o, `${res.status} ${text}`);
        if (!res.ok) (o.exit ?? ((c: number) => process.exit(c)))(1);
      } catch (cause) {
        return fail(o, `连不上 daemon（${base}）：${String(cause)}`, EXIT_UNREACHABLE);
      }
    });

  program
    .command('hb')
    .description('心跳（crontabs）管理：list / add / remove / enable / disable')
    .argument('[op]', 'list|add|remove|enable|disable', 'list')
    .option('--id <ctId>', 'crontab id（remove/enable/disable）')
    .option('--cron <expr>', 'cron 表达式（add）')
    .option('--title <title>', '标题（add）')
    .option('--prompt <text>', 'prompt/goal（add）')
    .option('--quiet <spec>', '安静时段，如 23:00-07:30')
    .option('--no-skip-if-busy', '忙时也触发')
    .action(async (op: string, lo: { id?: string; cron?: string; title?: string; prompt?: string; quiet?: string; skipIfBusy?: boolean }) => {
      const o = merged();
      if (op === 'list') {
        const r = await api('POST', '/api/heartbeat', { op: 'list', dotId: dot() }, o);
        if (!r.ok) return fail(o, r.message, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
        emit(o, render(r.body, o.json === true));
        return;
      }
      if (op === 'add') {
        if (lo.cron === undefined || lo.prompt === undefined) {
          return fail(o, 'hb add 需要 --cron 与 --prompt', 2);
        }
        const r = await api('POST', '/api/heartbeat', {
          op: 'add', dotId: dot(), cron: lo.cron, prompt: lo.prompt,
          title: lo.title ?? lo.prompt.slice(0, 30),
          ...(lo.quiet !== undefined ? { quietHours: lo.quiet } : {}),
          ...(lo.skipIfBusy === false ? { skipIfBusy: false } : {}),
        }, o);
        if (!r.ok) return fail(o, r.message, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
        emit(o, render(r.body, o.json === true));
        return;
      }
      if (op === 'remove' || op === 'enable' || op === 'disable') {
        if (lo.id === undefined) return fail(o, `${op} 需要 --id <ctId>`, 2);
        const r = await api('POST', '/api/heartbeat', {
          op: op === 'remove' ? 'remove' : 'set_enabled',
          ctId: lo.id,
          ...(op !== 'remove' ? { enabled: op === 'enable' } : {}),
        }, o);
        if (!r.ok) return fail(o, r.message, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
        emit(o, render(r.body, o.json === true));
        return;
      }
      fail(o, `未知 hb 操作：${op}（list|add|remove|enable|disable）`, 2);
    });

  program
    .command('sos-test')
    .description('求救通道自检（GET /api/channels：如实报每个通道的当前可用性、投递顺序与最近台账）')
    .action(async () => {
      const o = merged();
      const r = await api<unknown>('GET', '/api/channels', undefined, o);
      if (!r.ok) return fail(o, r.message, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
      const c = asChannels(r.body);
      if (c === null) {
        return fail(o, 'daemon 回的 /api/channels 不是预期形状（先把 daemon 升到同版本）', 1);
      }
      emit(o, `求救投递顺序：${c.order.join(' → ')}`);
      const avail = (['feishu', 'telegram', 'email'] as const)
        .map((k) => `${k}=${c.available[k] ? '可用' : '不可用'}`)
        .join('，');
      emit(o, `通道现状：${avail}；兜底文件 ${c.outboxPath}`);
      const last = c.recent[0];
      if (last === undefined) {
        emit(o, '台账：alert_dispatch 暂无记录（没发过求救）。');
      } else {
        const via = typeof last.deliveredVia === 'string' ? last.deliveredVia : 'pending';
        const tried = typeof last.channelsTried === 'string' ? last.channelsTried : '';
        const kind = typeof last.kind === 'string' ? last.kind : '?';
        const mode = typeof last.mode === 'string' ? last.mode : '?';
        emit(o, `最近一条台账：kind=${kind} mode=${mode} 实际投递=${via}（试过 ${tried}）`);
      }
      const usable = (['feishu', 'telegram', 'email'] as const).some((k) => c.available[k]);
      emit(o, usable
        ? '结论：有可用通道，求救能送到你眼前。'
        : `结论：三个实时通道全不可用，求救只会落进 ${c.outboxPath}（得人去翻文件）。`);
      emit(o, render(c, o.json === true));
    });

  // 未知命令：明确报错（commander 默认会建议）
  program.on('command:*', (args: string[]) => {
    fail(merged(), `未知命令：${args.join(' ')}（dotd --help 看全部）`, 2);
  });

  return program;
}

/** 进程入口（bin.dotd / npm run dotd）。 */
export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildCli();
  await program.parseAsync(argv);
}

// 仅当作为入口直接运行时才执行（被 import 时不跑，方便测试）
// 判据与 src/daemon.ts 的 isMainModule() 一致：都比对解析后的绝对路径，
// 不能拿 import.meta.url 和手拼的 `file://${argv[1]}` 比——import.meta.url
// 会把非 ASCII 路径百分号编码（中文路径 %E7%A0%94…），手拼的不编码，
// 两者永不相等，入口守卫会恒假，npm run dotd 就静默什么都不做。
function isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  return resolve(argv1) === resolve(HERE, 'cli.ts');
}

if (isMainModule()) {
  void main();
}

/** 供 daemon 装配层/测试写 CLI token 文件（§5.6 第三顺位）。 */
export function writeCliToken(token: string): string {
  const p = cliTokenPath();
  mkdirSync(join(homedir(), '.dotd'), { recursive: true });
  writeFileSync(p, `${token}\n`, 'utf8');
  return p;
}
