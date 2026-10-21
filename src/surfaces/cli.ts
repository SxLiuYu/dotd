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
import { renderTaskView, type TaskView } from './task-view.ts';

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

/**
 * A2（2026-10-21）：不回显读一行。TTY 用 raw mode（逐字符收，Ctrl-C 退出）；
 * 非交互（管道）整行读。密码别走参数、别进 shell history。
 */
function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolvePw) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    if (stdin.isTTY === true && typeof stdin.setRawMode === 'function') {
      let buf = '';
      const onData = (ch: Buffer): void => {
        const c = ch.toString('utf8');
        if (c === '\r' || c === '\n') {
          stdin.removeListener('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          resolvePw(buf);
          return;
        }
        if (c === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (c === '\u007f' || c === '\b') {
          buf = buf.slice(0, -1);
          return;
        }
        buf += c;
      };
      stdin.resume();
      stdin.on('data', onData);
    } else {
      let all = '';
      stdin.on('data', (c: Buffer) => {
        all += c.toString('utf8');
      });
      stdin.on('end', () => resolvePw(all.replace(/\r?\n$/, '')));
    }
  });
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
  method: 'GET' | 'POST' | 'DELETE',
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
      // 服务端错误体有两种形状：{error, message}（如 memory/restore）与 {message}。
      // 2026-10-18 实测：只读 message 时，返回 {ok:false,error:"..."} 的端点会退化成
      // 干巴巴的 "HTTP 400"，用户不知道到底哪儿错了。两个字段都看。
      const p2 = parsed as { message?: unknown; error?: unknown } | null;
      const fromMsg = typeof p2?.message === 'string' && p2.message.length > 0 ? p2.message : null;
      const fromErr = typeof p2?.error === 'string' && p2.error.length > 0 ? p2.error : null;
      const msg = fromMsg ?? fromErr ?? `HTTP ${res.status}`;
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

  // ── 记忆备份（2026-10-18）：.archive/ 的查询与回滚 ────────────────────────
  //
  // 背景：fs.write 覆盖前会把旧版本归档，但恢复原先只能 `docker exec cp`——
  // 等于"有能力、没入口"。这两条命令把它变成一句 CLI。
  const mem = program.command('memory').description('记忆备份：查看历史版本 / 回滚');

  mem
    .command('archive')
    .description('列出 .archive/ 里的历史版本（按时间倒序）')
    .option('-p, --path <path>', '只看某个文件的备份（如 MEMORY.md）')
    .option('-l, --limit <n>', '条数上限（默认 20）', '20')
    .action(async (opts: { path?: string; limit?: string }) => {
      const o = merged();
      const qs = new URLSearchParams();
      if (opts.path !== undefined) qs.set('path', opts.path);
      qs.set('limit', String(Math.max(1, Math.min(500, Number(opts.limit) || 20))));
      const r = await api<{
        items: Array<{ name: string; archivedAt: string; originalPath: string; sizeBytes: number }>;
        total?: number;
        totalBytes?: number;
        quotaBytes?: number;
        usedPct?: number;
        warning?: string;
      }>('GET', `/api/memory/archive?${qs.toString()}`, undefined, o);
      if (!r.ok) return fail(o, r.message, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
      const items = r.body.items ?? [];
      if (o.json === true) {
        emit(o, JSON.stringify(items, null, 2));
        return;
      }
      if (items.length === 0) {
        console.log(opts.path === undefined ? '（还没有任何备份）' : `（${opts.path} 没有备份）`);
        return;
      }
      console.log(`共 ${items.length} 份备份：`);
      for (const it of items) {
        console.log(`  ${it.archivedAt}  ${it.originalPath}  (${it.sizeBytes}B)`);
        console.log(`     ${it.name}`);
      }
      console.log('');
      // 配额提示（2026-10-18）：快满时说清楚，别让人某天发现老备份被悄悄删掉。
      const body = r.body ?? {};
      if (typeof body.totalBytes === 'number' && typeof body.quotaBytes === 'number') {
        const pct = typeof body.usedPct === 'number' ? body.usedPct : 0;
        console.log(`占用：${body.totalBytes}/${body.quotaBytes} 字节（${pct}%），共 ${body.total ?? items.length} 份`);
      }
      if (typeof body.warning === 'string') {
        console.log(`⚠️  ${body.warning}`);
      }
      console.log('回滚：dotd memory restore <上面对应的文件名>');
    });

  mem
    .command('restore <archive>')
    .description('把某个历史版本写回原文件（当前版本也会被归档，可再回滚）')
    .action(async (archive: string) => {
      const o = merged();
      const r = await api<{ ok: boolean; restoredTo?: string; error?: string }>(
        'POST', '/api/memory/restore', { archive }, o,
      );
      if (!r.ok) {
        // 400 时服务端会带 {ok:false, error:"..."}，把它显示出来而不是只给 HTTP 400
        // （2026-10-18 实测：只显示 "HTTP 400" 让人不知道到底哪儿错了）。
        const why = (r as unknown as { body?: { error?: string } }).body?.error;
        return fail(o, why === undefined ? r.message : `回滚失败：${why}`, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
      }
      const body = r.body ?? { ok: false };
      if (o.json === true) {
        emit(o, JSON.stringify(body, null, 2));
        return;
      }
      if (body.ok === true) {
        console.log(`✅ 已回滚：${body.restoredTo}（原版本已归档，如需撤销可再 restore 回去）`);
        return;
      }
      console.error(`❌ 回滚失败：${body.error ?? '未知原因'}`);
      process.exitCode = 1;
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

  // A2（2026-10-21）：保险库三件事。secret 只走本机回环 + master token；
  // 交互输入不回显；--secret 供管道/脚本（注意 shell history）。
  const vaultCmd = program.command('vault').description('密码保险库：add|list|rm（值只存 daemon 侧密文）');
  vaultCmd
    .command('add <site> <user>')
    .description('写入/覆盖一条；交互模式下密码不回显')
    .option('--secret <text>', '非交互直给（脚本用；交互别用）')
    .action(async (site: string, user: string, vo: { secret?: string }) => {
      const o = merged();
      const token = resolveToken(o.token);
      if (token === null) {
        return fail(o, '没有 token（--token / DOTD_MASTER_TOKEN / ~/.dotd/cli_token）', 2);
      }
      let secret = vo.secret;
      if (secret === undefined) {
        secret = await promptHidden(`  ${site} / ${user} 的密码（输入不回显）：`);
        if (secret.length === 0) return fail(o, '空密码没存（要删用 vault rm）', 2);
      }
      const r = await api('POST', '/api/vault/entries', { site, user, secret }, o);
      if (!r.ok) return fail(o, r.message, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
      emit(o, `已存 ${site} / ${user}（agent 侧引用：$vault:${site}:${user}）`);
    });
  vaultCmd
    .command('list')
    .description('列出条目（只有 site/user，永远没有值）')
    .action(async () => {
      const o = merged();
      const token = resolveToken(o.token);
      if (token === null) return fail(o, '没有 token', 2);
      const r = await api<{ entries: Array<{ site: string; user: string }> }>(
        'GET', '/api/vault', undefined, o,
      );
      if (!r.ok) return fail(o, r.message, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
      const es = r.body?.entries ?? [];
      if (es.length === 0) return emit(o, '（保险库是空的）');
      emit(o, es.map((e) => `${e.site} / ${e.user}`).join('\n'));
    });
  vaultCmd
    .command('rm <site> <user>')
    .description('删除一条')
    .action(async (site: string, user: string) => {
      const o = merged();
      const token = resolveToken(o.token);
      if (token === null) return fail(o, '没有 token', 2);
      const r = await api('DELETE', '/api/vault/entries', { site, user }, o);
      if (!r.ok) return fail(o, r.message, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
      emit(o, `已删 ${site} / ${user}`);
    });

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
    .description('入站拒绝审计（surf_ingress_rejects，GET /api/logs）')
    .option('--limit <n>', '条数（1..500）', '50')
    .action(async (lo: { limit: string }) => {
      const o = merged();
      // P1-6：`/api/logs` 路由已补齐（此前这里只能拿 /api/guard 凑近似值并附"待补"说明）。
      const r = await api<{ rejects: Array<{ at: string; source: string; actor: string | null; reason: string; detail: string | null }>; limit: number }>(
        'GET',
        `/api/logs?limit=${encodeURIComponent(lo.limit)}`,
        undefined,
        o,
      );
      if (!r.ok) return fail(o, r.message, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
      const rejects = r.body.rejects ?? [];
      if (o.json === true) {
        emit(o, render(r.body, true));
        return;
      }
      if (rejects.length === 0) {
        emit(o, `最近没有入站被拒记录（已查最近 ${r.body.limit} 条）。`);
        return;
      }
      const lines = [`入站被拒 ${rejects.length} 条（最近的在前）：`];
      for (const x of rejects) {
        const who = x.actor !== null && x.actor.length > 0 ? x.actor : '匿名';
        lines.push(`  ${x.at}  ${x.source.padEnd(10)} ${x.reason.padEnd(9)} ${who}${x.detail !== null ? `  ${x.detail}` : ''}`);
      }
      emit(o, lines.join('\n'));
    });

  program
    .command('task <taskId>')
    .description('查看任务（--verbose 给出花了多少 / 卡在哪 / 每一步多久）')
    .option('--verbose', '详细视图：成本、耗时、瓶颈（GET /api/tasks/:id?verbose=1）', false)
    .action(async (taskId: string, opts: { verbose?: boolean }) => {
      const o = merged();
      // P1-6：`/api/tasks/:id` 路由已补齐（此前用 /api/queue 的一行凑，且只覆盖 queued/running）。
      const q = opts.verbose === true ? '?verbose=1' : '';
      const r = await api<{
        task: { id: string; title: string; status: string; attempt: number; priority: number };
        steps: unknown[];
        view?: TaskView;
        error?: string;
        message?: string;
      }>('GET', `/api/tasks/${encodeURIComponent(taskId)}${q}`, undefined, o);
      if (!r.ok) {
        // 404 = 任务不存在：给出人话 + 下一步，而不是一个裸 error
        if (r.kind === 'http' && r.status === 404) {
          emit(o, `任务 ${taskId} 不存在。可用 \`dotd queue\` 看待办、\`dotd events\` 看最近入站事件。`);
          return;
        }
        return fail(o, r.message, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
      }
      if (o.json === true) {
        emit(o, render(r.body, true));
        return;
      }
      if (r.body.view !== undefined) {
        emit(o, renderTaskView(r.body.view));
        return;
      }
      const t = r.body.task;
      emit(o, `任务 ${t.id}「${t.title}」\n状态：${t.status}（attempt ${t.attempt}，priority ${t.priority}）\n步骤 ${r.body.steps?.length ?? 0} 条（加 --verbose 看耗时与成本）`);
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
    .command('container')
    .description('容器状态与重置（GET /api/container；--reset 清隔离状态）')
    .option('--reset', '重置为 ready 并清零 recreate_count（容器被 quarantined 时用）')
    .action(async (opts: { reset?: boolean }) => {
      const o = merged();
      if (opts.reset === true) {
        const r = await api<{ ok?: boolean; note?: string; error?: string }>(
          'POST',
          '/api/container/reset',
          {},
          o,
        );
        if (!r.ok) return fail(o, r.message, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
        emit(o, r.body.note ?? '已重置');
        return;
      }
      const r = await api<{
        container?: {
          dotId: string;
          state: string;
          dockerId: string | null;
          recreateCount: number;
          lastHealthAt: string | null;
          hint?: string;
        };
        error?: string;
      }>('GET', '/api/container', undefined, o);
      if (!r.ok) return fail(o, r.kind === 'unreachable' ? 'daemon 不可达' : r.message, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
      const c = r.body.container;
      if (c === undefined) return fail(o, r.body.error ?? 'daemon 回的 /api/container 不是预期形状', 1);
      emit(o, `dot=${c.dotId}  状态=${c.state}  24h 重建次数=${c.recreateCount}`);
      emit(o, `docker=${c.dockerId ?? '-'}  最近健康=${c.lastHealthAt ?? '-'}`);
      if (c.hint !== undefined) emit(o, `提示：${c.hint}`);
    });

  program
    .command('outbound')
    .description('出站审计（GET /api/outbound：飞书回复有没有发出去、发到哪个会话、失败原因）')
    .option('-n, --limit <n>', '条数（默认 20）', '20')
    .option('-k, --kind <kind>', '按类型过滤（task_reply / approval）')
    .action(async (opts: { limit?: string; kind?: string }) => {
      const o = merged();
      const qs = new URLSearchParams();
      if (opts.limit !== undefined) qs.set('limit', opts.limit);
      if (opts.kind !== undefined) qs.set('kind', opts.kind);
      const q = qs.toString();
      const r = await api<{
        count?: number;
        items?: Array<{ kind: string; chatId: string; ok: boolean; error: string | null; textPreview: string; at: string }>;
        error?: string;
      }>('GET', `/api/outbound${q === '' ? '' : `?${q}`}`, undefined, o);
      if (!r.ok) return fail(o, r.kind === 'unreachable' ? 'daemon 不可达' : r.message, r.kind === 'unreachable' ? EXIT_UNREACHABLE : 1);
      const items = r.body.items ?? [];
      if (items.length === 0) {
        emit(o, '（还没有出站记录）');
        return;
      }
      emit(o, `最近 ${items.length} 条出站：`);
      for (const x of items) {
        const mark = x.ok ? 'OK ' : 'FAIL';
        emit(o, `  [${mark}] ${x.at}  ${x.kind} → ${x.chatId}${x.ok ? '' : `  (${x.error ?? '?'})`}`);
        emit(o, `         ${x.textPreview.replace(/\s+/g, ' ').slice(0, 70)}`);
      }
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
