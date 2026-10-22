/**
 * src/surfaces/insight.ts —— 「每日简报」与「已连接应用总览」的取数层
 *
 * 为什么单独一层（而不是塞进 http.ts 或 daemon.ts）
 *   `daily-brief.ts` / `connections.ts` 是**纯函数**：给数据、出文字，可单测、不碰库。
 *   `http.ts` 是路由与鉴权，`daemon.ts` 是装配。中间这层「从 SQLite 与日历目录
 *   把事实读出来」如果写在路由里，路由会长出 SQL；写在 daemon 里，daemon 已经
 *   1800 行。分开之后，口径只有一处：`/api/brief`、`/api/connections`、`dotd brief`、
 *   飞书每天那条推送**全都走这两个函数**，不会出现「手机看到的和 CLI 看到的不一样」。
 *
 * 两条刻意的边界
 *   1. **不联网**。简报里的邮件段只报「上次检查失败的原因」，不现场连 IMAP：
 *      每天 08:30 去连三家邮箱，慢的时候会拖到几十秒，而简报的价值在「一眼看完」。
 *      要看邮件，让它跑一次 mail.list（那是任务，有审批与超时）。
 *   2. **不猜**。日历读不出来时如实带上 errors，简报与总览都会把「读不了」和
 *      「没有日程」区分开 —— 这两件事对主人的含义完全相反。
 */

import type { DatabaseSync } from 'node:sqlite';

import { listEvents } from '../calendar/CalendarService.ts';
import type { ConnectorInfo } from '../connectors/registry.ts';
import {
  buildDailyBrief,
  type BriefApproval,
  type BriefCrontab,
  type BriefInput,
  type BriefTaskStats,
  type DailyBrief,
} from './daily-brief.ts';
import {
  buildConnections,
  type ConnectionInput,
  type ConnectionMcpServer,
  type ConnectionModelEndpoint,
  type ConnectionRow,
} from './connections.ts';

/** 取数依赖。刻意只收「数据在哪」，不收任何能力对象 —— 两个函数都不发消息、不写库。 */
export interface InsightDeps {
  db: DatabaseSync;
  /** 日历目录（`<dataDir>/calendar`；不存在属正常，listEvents 会如实报错）。 */
  calendarDir: string;
  /** 阶段一恒 dot1，留着是为了多 Dot（阶段三）不用改调用方。 */
  dotId: string;
  /** 连接器目录（daemon 传 connectorCatalog()）；注入而不是内部读环境变量，便于测试。 */
  connectors: ConnectorInfo[];
  /** MCP server（daemon 传 loadMcpServers() 的结果，**只有名字与工具数**）。 */
  mcpServers: ConnectionMcpServer[];
  /** 模型端点（daemon 从 models.yml 投影，不带任何 key）。 */
  models: ConnectionModelEndpoint[];
}

/** 本地当天 00:00 的时刻。 */
function startOfLocalDay(nowMs: number): number {
  const d = new Date(nowMs);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本地当天 24:00 的时刻（次日 00:00）。 */
function endOfLocalDay(nowMs: number): number {
  return startOfLocalDay(nowMs) + 24 * 3_600_000;
}

/** 读一行 COUNT(*)（表缺/查询失败一律 0：简报不该因为一张表没建就整条不发）。 */
function countOf(db: DatabaseSync, sql: string, ...args: Array<string | number>): number {
  try {
    const row = db.prepare(sql).get(...args) as { n?: number } | undefined;
    return typeof row?.n === 'number' ? row.n : 0;
  } catch {
    return 0;
  }
}

/** 读多行；失败返回空数组并**不抛**（同上）。 */
function rowsOf<T>(db: DatabaseSync, sql: string, ...args: Array<string | number>): T[] {
  try {
    return db.prepare(sql).all(...args) as unknown as T[];
  } catch {
    return [];
  }
}

/**
 * 汇总简报所需的事实。
 *
 * 时间口径统一用**本地日**：主人说的「今天」是手机上的今天，不是 UTC 的今天。
 * 库里 `created_at` 是 SQLite 的 UTC 文本，所以「近 24 小时」直接用 `datetime('now','-1 day')`
 * 由 SQLite 算，不经过 JS（避免两套时区推导打架）。
 */
export function collectBriefInput(deps: InsightDeps, nowMs: number): BriefInput {
  const { db } = deps;

  // ① 日历：窗口取 1 天，再按本地日夹逼（跨天事件不该出现在「今日日程」里）
  const cal = listEvents({ dir: deps.calendarDir }, nowMs, 1);
  const dayStart = startOfLocalDay(nowMs);
  const dayEnd = endOfLocalDay(nowMs);
  const events = cal.events
    .filter((e) => e.startMs !== null && e.startMs >= dayStart && e.startMs < dayEnd)
    .map((e) => ({
      startMs: e.startMs,
      allDay: e.allDay,
      summary: e.summary,
      ...(e.location !== '' ? { location: e.location } : {}),
    }));

  // ② 审批：只报 pending。executing 是**卡住**的那批（历史遗留 126 条），单独报数量。
  const approvals = rowsOf<BriefApproval>(
    db,
    `SELECT seq, summary, tier, created_at AS createdAt
       FROM approvals WHERE status = 'pending' ORDER BY id DESC LIMIT 50`,
  );
  const executingApprovals = countOf(db, "SELECT COUNT(*) AS n FROM approvals WHERE status = 'executing'");

  // ③ 任务：近 24 小时按状态计数 + 最多 3 条失败标题
  const taskCounts = rowsOf<{ status: string; n: number }>(
    db,
    `SELECT status, COUNT(*) AS n FROM tasks
      WHERE created_at >= datetime('now', '-1 day') GROUP BY status`,
  );
  const byStatus = new Map(taskCounts.map((r) => [r.status, r.n]));
  const failedTitles = rowsOf<{ title: string }>(
    db,
    `SELECT title FROM tasks
      WHERE status = 'failed' AND created_at >= datetime('now', '-1 day')
      ORDER BY created_at DESC LIMIT 3`,
  ).map((r) => r.title);
  const tasks: BriefTaskStats = {
    done: byStatus.get('done') ?? 0,
    failed: byStatus.get('failed') ?? 0,
    running: byStatus.get('running') ?? 0,
    queued: byStatus.get('queued') ?? 0,
    failedTitles,
  };

  // ④ 定时任务：今天还会触发的（next_fire 是 epoch ms）
  const crontabs = rowsOf<BriefCrontab>(
    db,
    `SELECT title AS name, next_fire AS nextFireAt FROM crontabs
      WHERE enabled = 1 AND next_fire >= ? AND next_fire < ?
      ORDER BY next_fire ASC LIMIT 20`,
    nowMs,
    dayEnd,
  );

  // ⑤ 邮件：**不现场收信**，只报最近一次失败（成功过的不提，没信息量）
  const mailErrors = rowsOf<{ last_error: string }>(
    db,
    `SELECT last_error FROM mail_accounts
      WHERE status = 'active' AND last_error IS NOT NULL AND last_error != ''
      ORDER BY updated_at DESC LIMIT 1`,
  );
  const mailError = mailErrors[0]?.last_error;

  return {
    nowMs,
    calendar: { events, errors: cal.errors },
    approvals,
    executingApprovals,
    tasks,
    crontabs,
    ...(mailError !== undefined
      ? { mail: { unread: null, error: mailError } }
      : {}),
  };
}

/** 生成简报（取数 + 纯函数渲染）。`maxChars` 缺省用 `BRIEF_MAX_CHARS`。 */
export function buildBrief(deps: InsightDeps, nowMs: number, maxChars?: number): DailyBrief {
  const input = collectBriefInput(deps, nowMs);
  return maxChars === undefined ? buildDailyBrief(input) : buildDailyBrief(input, maxChars);
}

/** 连接总览的渠道事实（不需要 db 的那部分，daemon 装配时传）。 */
export interface ChannelFacts {
  feishuAppId: string;
  ownerChatCount: number;
  httpHost: string;
  httpPort: number;
}

/** 汇总「哪些已连接、哪个断了」所需的事实。 */
export function collectConnectionsInput(deps: InsightDeps, channel: ChannelFacts): ConnectionInput {
  const { db } = deps;

  // 邮箱账号：只取展示需要的列，**secret_enc 一个字都不进来**（这也是它不 SELECT * 的原因）
  const mailAccounts = rowsOf<{
    id: string;
    label: string;
    email: string;
    imapHost: string;
    status: string;
    lastOkAt: string | null;
    lastError: string | null;
  }>(
    db,
    `SELECT id, label, email, imap_host AS imapHost, status,
            last_ok_at AS lastOkAt, last_error AS lastError
       FROM mail_accounts ORDER BY id`,
  );

  // 日历：用真实扫描结果（源数 + 事件数 + 错误），不用配置里的路径猜
  const cal = listEvents({ dir: deps.calendarDir }, Date.now(), 14);

  return {
    mailAccounts,
    calendar: { dir: deps.calendarDir, sources: cal.sources, errors: cal.errors },
    connectors: deps.connectors,
    mcpServers: deps.mcpServers,
    models: deps.models,
    channel,
  };
}

/** 生成连接总览（取数 + 纯函数判定）。 */
export function buildConnectionsView(deps: InsightDeps, channel: ChannelFacts): ConnectionRow[] {
  return buildConnections(collectConnectionsInput(deps, channel));
}