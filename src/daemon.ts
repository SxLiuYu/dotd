/**
 * src/daemon.ts —— dotd 装配层（`dotd serve` 的唯一真入口）。
 *
 * 职责边界（CONVENTIONS.md §4「模块边界」铁律）：
 *   - 本文件是**唯一**知道全部八个模块的地方：openDb → migrate → 模块 init
 *     （顺序 CP→MR→GOV→EX→MEM→SF）→ HTTP listen → Runner 常驻循环 → 优雅退出。
 *   - 模块内部不知道装配细节；跨模块依赖一律走 src/shared/contracts.ts 的接口面。
 *   - 本文件不做业务判断，只做"把谁的哪个实现递给谁"。
 *
 * 启动序列逐条落地（control-plane.md §7.1）：
 *   1 openDb + migrate（失败 → MigrationError → 拒启动 + 追加 OUTBOX.md）
 *   2 优雅标记（CP §7.1 步骤 2）：退出时调 recovery.markGracefulShutdown(db)，
 *     无标记 = 崩溃。CP 不建 meta 表（契约 D3），标记落在 resource_events。
 *   3–6 recoverInFlight / recoverAwaiting / catchUpHeartbeats / replayUndecidedEvents：
 *     全部在 cp.recover() 内（见 control-plane/index.ts:334），治理 approvals 只读
 *     探针由本装配层注入（ApprovalsReader.listForTask）。
 *   7 guard.calibrateOrUseFallback（recover 内）+ scheduler.start（recover 内）
 *     + http.listen（本文件）。
 *
 * 优雅退出（CP §2.1-4）：
 *   SIGTERM/SIGINT → ①停 pop 与心跳投递 ②向在跑 Runner 协程传 AbortSignal，
 *   Runner 在当前步边界落 journal 后自然退出，上限 shutdownGraceMs=30s
 *   ③超时不 SIGSTOP（协程模型无此原语），直接 process.exit()，由 CP §7 恢复兜底。
 *
 * 环境变量（CONVENTIONS §7）：
 *   - DOTD_MODEL_TRANSPORT=stub → 模型走内存 stub（零网络请求）
 *   - DOTD_FLEET=stub → fleet 走内存 stub（不起容器）
 *   - DOTD_DB_PATH → 覆盖唯一库文件路径（契约 D1；测试/冒烟必设）
 *   - DOTD_CONFIG → config.yml 路径（surfaces 节加载）
 *   - DOTD_HOME → 数据目录根；缺省 ~/.dotd。OUTBOX/journal-blobs/exec-tokens/
 *     通知留痕都在它下面，冒烟脚本用它把整棵状态树指到临时目录。
 */

import type { Server } from 'node:http';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';

import { openDb, resolveDbPath } from '../db/conn.ts';
import { MailService } from './mail/MailService.ts';
import { CardRegistry, parseOwnerChatIds, resolveApprovalCards } from './surfaces/feishu-approval.ts';
import { startProgressPush } from './surfaces/progress-push.ts';
import { startProgressReaction } from './surfaces/progress-reaction.ts';
import {
  addLocalEvent,
  deleteLocalEvent,
  editLocalEvent,
  listConflicts,
  listEvents,
  renderConflicts,
  renderList,
  type LocalEventInput,
} from './calendar/CalendarService.ts';
import { buildApprovalCard } from './surfaces/feishu-card.ts';
import { migrate } from '../db/migrate.ts';

import { EventBus } from './shared/bus.ts';
import { MigrationError } from './shared/errors.ts';
import type {
  ApprovalView,
  ControlPlane,
  ExecServiceApi,
  GovernanceApi,
  GovernancePort,
  MemoryPort,
  MemoryServiceApi,
  ModelRouterApi,
  NotificationChannels,
  RouterPort,
  Task,
} from './shared/contracts.ts';

import { createControlPlane } from './control-plane/index.ts';
import type { ControlPlaneInstance } from './control-plane/index.ts';
import type { ApprovalsReader, RecoveryReport } from './control-plane/recovery.ts';
import { markGracefulShutdown } from './control-plane/recovery.ts';
import type { EventRule, LowBrain } from './control-plane/match.ts';
import type { ExecPorts, GuardDeps } from './control-plane/guard.ts';
import type { ExecReconciler, GovernanceForcer } from './control-plane/journal.ts';
import { ModelRouter } from './router/ModelRouter.ts';
import {
  initGovernance,
  initSeq,
  loadCatalog,
  watchEmergency,
} from './governance/index.ts';
import {
  claim as govClaim,
  decide as govDecide,
  evaluate as govEvaluate,
  forceApproval as govForceApproval,
  getApproval as govGetApproval,
  listPending as govListPending,
  resolveExecution as govResolveExecution,
} from './governance/gate.ts';
import type { GovDeps } from './governance/types.ts';
import { ExecServiceImpl } from './exec/ExecService.ts';
import { McpClient } from './exec/mcp-client.ts';
import { loadMcpServers } from './exec/mcp-config.ts';
import { execConfigFromEnv } from './exec/types.ts';
import { toHomeAbs } from './exec/protocol.ts';
import { makeExecFsOpsBridge } from './memory/exec-fsops-bridge.ts';
import { createSchedule, listSchedules, removeSchedule } from './control-plane/schedules.ts';
import type { ExecToolCall, ExecToolResult } from './shared/contracts.ts';
import { CronExpressionParser } from 'cron-parser';
import { createMemoryService } from './memory/MemoryService.ts';
import { memoryWritePathsOfStep } from './memory/step-paths.ts';
import type { MemoryServiceImpl } from './memory/MemoryService.ts';
import { assertHttpConfig, startHttpServer } from './surfaces/http.ts';
import { loadSurfacesConfig } from './surfaces/config.ts';
import { SseBus } from './surfaces/sse.ts';
import {
  NULL_TELEGRAM_GATEWAY,
  NULL_FEISHU_GATEWAY,
  FeishuGateway,
  SurfacesNotificationChannels,
} from './surfaces/channels.ts';
import { startFeishuWs } from './surfaces/feishu-ws.ts';
import { recordOutbound, startFeishuOutbound } from './surfaces/feishu-outbound.ts';
import { briefDayKey } from './surfaces/daily-brief.ts';
import { startDailyBriefPush } from './surfaces/daily-brief-push.ts';
import { startConnectionWatch } from './surfaces/connection-watch-push.ts';
import { buildBrief, buildConnectionsView, type InsightDeps } from './surfaces/insight.ts';
import { vaultDelete, vaultGet, vaultList, vaultPut } from './vault/vault.ts';

/** A2：保险库目录（DOTD_VAULT_DIR 可覆盖；缺省 /root/.dotd——钥匙也在那台机上）。 */
const vaultDir = (): string => process.env.DOTD_VAULT_DIR ?? '/root/.dotd';
import { connectorCatalog } from './connectors/registry.ts';
import { loadModelsConfig } from './router/config.ts';
import { githubNotifications, githubIssues, githubPulls } from './connectors/github.ts';
import { fetchFeed } from './connectors/rss.ts';
import { legacyBrowser, webAct, webRead, webSnapshot } from './exec/webtools.ts';
import { searchFetch, searchWeb } from './exec/searchtools.ts';
import { fetchDay, weekdayOf } from './connectors/holiday.ts';
import { restPlan } from './connectors/rest-plan.ts';
import { DotRunner } from './runner/dot.ts';
import { loadEventRules } from './event-rules.ts';

// ── 路径解析（cwd 无关：一切以本文件位置或 DOTD_HOME 为基准）─────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** `~/x` → HOME 展开（config/dotd.yml「路径支持 ~ 展开为 daemon 用户 HOME」）。 */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return homedir() + p.slice(1);
  return p;
}

/** 数据目录根：DOTD_HOME > 默认 ~/.dotd。 */
export function resolveDataDir(): string {
  const env = process.env.DOTD_HOME;
  if (env !== undefined && env.length > 0) return resolve(expandHome(env));
  return join(homedir(), '.dotd');
}

/** 仓库 config/ 目录（MR models.yml / free-models.yml；GOV tools.yml / rules.yml；CP event-rules.yml）。 */
export function resolveConfigDir(): string {
  const env = process.env.DOTD_CONFIG_DIR;
  if (env !== undefined && env.length > 0) return resolve(expandHome(env));
  return join(REPO_ROOT, 'config');
}

/** web-ui 构建产物目录（SF web.ts 静态托管；缺 dist 时静态请求 404，不拒启动）。 */
export function resolveWebRoot(): string {
  const env = process.env.DOTD_WEB_ROOT;
  if (env !== undefined && env.length > 0) return resolve(expandHome(env));
  return join(REPO_ROOT, 'web-ui', 'dist');
}

// ── 配置 ────────────────────────────────────────────────────────────────────

export interface DaemonConfig {
  dataDir: string;
  dbPath: string;
  configDir: string;
  webRoot: string;
  /** config.yml 路径（SF surfaces 节；DOTD_CONFIG 覆盖）。 */
  configPath: string | undefined;
  /** stub 模式（CONVENTIONS §7）。 */
  stubTransport: boolean;
  /** 阶段一恒 ['dot1']（契约 §9：无 dots 表）。 */
  dotIds: string[];
  /** 优雅退出宽限（CP §2.1-4：shutdownGraceMs）。 */
  shutdownGraceMs: number;
  /** Runner 空转轮询间隔。 */
  idlePollMs: number;
}

const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

export function loadDaemonConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  const envConfigPath = process.env.DOTD_CONFIG;
  return {
    dataDir: resolveDataDir(),
    dbPath: resolveDbPath(),
    configDir: resolveConfigDir(),
    webRoot: resolveWebRoot(),
    configPath:
      envConfigPath !== undefined && envConfigPath.length > 0 ? envConfigPath : undefined,
    stubTransport: process.env.DOTD_MODEL_TRANSPORT === 'stub',
    dotIds: ['dot1'],
    shutdownGraceMs: DEFAULT_SHUTDOWN_GRACE_MS,
    idlePollMs: 1_000,
    ...overrides,
  };
}

// ── OUTBOX 追加（CP §7.1 步骤 1：迁移失败 → 拒启动 + 追加）──────────────────

/**
 * 契约 T3：OUTBOX.md 的块格式归 MR；**装配层只负责"追加"这个动作**，不自造格式
 * （CONVENTIONS.md §5 原文）。故这里只写一行时间戳+错误摘要，无 HELP 头。
 */
export function appendOutbox(dataDir: string, line: string): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    appendFileSync(join(dataDir, 'OUTBOX.md'), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    // OUTBOX 本身写不动时只能让原始错误继续上抛（拒启动）
  }
}

/**
 * P1-1 并发配置读取：**只有显式声明才返回键**（返回空对象 = 全走 DEFAULT_CP_CONFIG）。
 *
 * 环境变量（前缀 DOTD_）：
 *  - `DOTD_MAX_RUNNING`（int ≥1）：并发额度，**默认 3**（2026-10-19 从 1 提上来）；
 *  - `DOTD_INTERACTIVE_RESERVE`（int ≥0）：给主人对话预留的额外名额，默认 0；
 *  - `DOTD_PREEMPTIBLE_PRIORITY`（int 0..10）：可被对话抢占的后台优先级阈值，默认 0=关闭。
 *
 * 为什么不全用 `truthyEnv`：并发额度必须能表达"3 个"，不是开关。
 * 非法值**抛错拒启动**（与 DOTD_RESERVE_MB 同口径）：静默回落默认值会让
 * "我明明设了 4 却还是串行"变成最难排查的那种坑。
 */
/**
 * 列出 .archive/ 里的记忆备份（按时间倒序）。
 * 走执行面的 fs.list（.archive/ 就是 home 下的普通目录）。
 */
async function listMemoryArchiveViaExec(
  exec: ExecServiceApi,
): Promise<Array<{ name: string; archivedAt: string; originalPath: string; sizeBytes: number }>> {
  try {
    const r = await exec.runTool({
      call_id: `arch-list-${Date.now()}`,
      task_id: 'admin-archive-list',
      dot_id: 'dot1',
      issued_at: new Date().toISOString(),
      tool: 'fs.list',
      args: { path: '.archive' },
      deadline_ms: 30_000,
    });
    if (r.status !== 'ok') return [];
    const entries = (r.result as { entries?: Array<{ name?: string; type?: string; size_bytes?: number }> } | null)
      ?.entries ?? [];
    const out: Array<{ name: string; archivedAt: string; originalPath: string; sizeBytes: number }> = [];
    for (const e of entries) {
      if (typeof e.name !== 'string' || e.type === 'dir') continue;
      const sep = e.name.indexOf('__');
      out.push({
        name: e.name,
        archivedAt: sep > 0 ? e.name.slice(0, sep) : '',
        originalPath: sep > 0 ? e.name.slice(sep + 2).replace(/_/g, '/') : e.name,
        sizeBytes: typeof e.size_bytes === 'number' ? e.size_bytes : 0,
      });
    }
    return out.sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : a.archivedAt > b.archivedAt ? -1 : 0));
  } catch {
    return [];
  }
}

/**
 * 把某个归档写回原路径。
 *
 * 走执行面的 fs.read + fs.write，于是**恢复本身也会触发归档**（当前版本先进 .archive/）
 * —— 这样"恢复"这个动作同样可回滚。
 */
async function restoreMemoryArchiveViaExec(
  exec: ExecServiceApi,
  archive: string,
): Promise<{ ok: boolean; restoredTo?: string; error?: string }> {
  try {
    const name = archive.replace(/^\.?\/?archive\//, '');
    if (name.length === 0 || name.includes('/') || name.includes('..')) {
      return { ok: false, error: '非法的归档名' };
    }
    const sep = name.indexOf('__');
    const target = sep > 0 ? name.slice(sep + 2).replace(/_/g, '/') : '';
    if (target.length === 0) return { ok: false, error: '无法从归档名还原目标路径' };

    const rd = await exec.runTool({
      call_id: `arch-read-${Date.now()}`,
      task_id: 'admin-archive-restore',
      dot_id: 'dot1',
      issued_at: new Date().toISOString(),
      tool: 'fs.read',
      args: { path: `.archive/${name}` },
      deadline_ms: 60_000,
    });
    if (rd.status !== 'ok') return { ok: false, error: '读不到该归档' };
    const content = (rd.result as { content?: unknown } | null)?.content;
    if (typeof content !== 'string') return { ok: false, error: '归档内容不可读' };

    const wr = await exec.runTool({
      call_id: `arch-write-${Date.now()}`,
      task_id: 'admin-archive-restore',
      dot_id: 'dot1',
      issued_at: new Date().toISOString(),
      tool: 'fs.write',
      args: { path: target, content },
      deadline_ms: 60_000,
    });
    if (wr.status !== 'ok') {
      const err = (wr.error as { message?: string } | null)?.message ?? '写回失败';
      return { ok: false, error: `写回失败：${err}` };
    }
    return { ok: true, restoredTo: target };
  } catch (cause) {
    return { ok: false, error: String(cause) };
  }
}

/**
 * 飞书图片下载器（2026-10-18 多模态）。
 *
 * 为什么下载走执行面而不是宿主直写：home 卷挂在**容器**里，宿主没有它的路径。
 * 所以流程是「宿主取 token 下载 → base64 交给容器的 fs.write 落盘」。
 *
 * 失败不抛：入站路径上抛错会让主人看到"消息被拒"，而真相只是"图没拿到"。
 * 交给 handleFeishuCallback 把失败原因写进任务目标，让模型如实转告。
 */
function makeFeishuMedia(
  getExec: () => { runTool: (call: ExecToolCall) => Promise<ExecToolResult> },
  cfg: { appId: string; appSecret: string },
): {
  downloadImage(
    imageKey: string,
  ): Promise<{ ok: true; media: { path: string; sizeBytes: number; contentType: string } } | { ok: false; error: string }>;
  /**
   * 下载文件消息（2026-10-19）：PDF/Excel/Word 等。
   *
   * 与图片的区别：飞书用**另一个端点** `im/v1/messages/{message_id}/resources/{file_key}`
   * 下载文件（不是 im/v1/images），且要带 `type=file` 查询参数。
   * 文件名用飞书给的 file_name（已做过安全过滤），保留原扩展名——模型靠扩展名判断格式。
   */
  downloadFile(
    fileKey: string,
    fileName: string,
    messageId: string,
  ): Promise<{ ok: true; media: { path: string; sizeBytes: number; contentType: string; fileName: string } } | { ok: false; error: string }>;
} {
  return {
    async downloadImage(imageKey) {
      try {
        // ① 取 tenant_access_token（与 channels.ts 同源逻辑，2h 有效；这里每次现取，量小）
        const tokRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
          signal: AbortSignal.timeout(10_000),
        });
        const tokJson = (await tokRes.json()) as { code?: number; tenant_access_token?: string };
        if (tokJson.code !== 0 || typeof tokJson.tenant_access_token !== 'string') {
          return { ok: false, error: `取飞书 token 失败（code=${tokJson.code ?? '?'}）` };
        }
        // ② 下载图片本体
        const imgRes = await fetch(
          `https://open.feishu.cn/open-apis/im/v1/images/${encodeURIComponent(imageKey)}`,
          { headers: { authorization: `Bearer ${tokJson.tenant_access_token}` }, signal: AbortSignal.timeout(20_000) },
        );
        if (!imgRes.ok) return { ok: false, error: `下载图片失败：HTTP ${imgRes.status}` };
        const ct = imgRes.headers.get('content-type') ?? '';
        const buf = Buffer.from(await imgRes.arrayBuffer());
        if (buf.byteLength === 0) return { ok: false, error: '下载到的图片为空' };
        if (buf.byteLength > 12 * 1024 * 1024) return { ok: false, error: `图片过大（${buf.byteLength} 字节）` };
        if (ct.includes('application/json')) {
          return { ok: false, error: `飞书返回错误：${buf.toString('utf8').slice(0, 160)}` };
        }
        // ③ 按魔数定扩展名
        const ext =
          buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 ? 'png'
          : buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 ? 'jpg'
          : buf.length >= 6 && buf.subarray(0, 3).toString('ascii') === 'GIF' ? 'gif'
          : buf.length >= 12 && buf.subarray(8, 12).toString('ascii') === 'WEBP' ? 'webp'
          : null;
        if (ext === null) return { ok: false, error: `不认识的图片格式（content-type=${ct || '空'}）` };
        // ④ 交给容器写进 home 卷
        const rel = `media/${imageKey.replace(/[^A-Za-z0-9_-]/g, '_')}.${ext}`;
        const w = await getExec().runTool({
          call_id: `feishu-img-${Date.now()}`,
          task_id: 'feishu-inbound-media',
          dot_id: 'dot1',
          issued_at: new Date().toISOString(),
          tool: 'fs.write',
          args: { path: rel, content_base64: buf.toString('base64') },
          deadline_ms: 30_000,
        });
        if (w.status !== 'ok') {
          const m = (w.error as { message?: string } | null)?.message ?? '写入失败';
          return { ok: false, error: `图片保存失败：${m}` };
        }
        return { ok: true, media: { path: rel, sizeBytes: buf.byteLength, contentType: ct } };
      } catch (cause) {
        return { ok: false, error: String(cause) };
      }
    },

    /**
     * 下载文件消息（PDF/Excel/Word 等）—— 2026-10-19。
     *
     * 端点与图片**不同**：GET /im/v1/messages/{message_id}/resources/{file_key}?type=file。
     *
     * **file_key 必须取自消息体**（2026-10-19 实测确认）：飞书在发送消息时会**重新生成**
     * file_key —— 上传接口返回的 key 与消息里的是两个不同的值。用上传时那个去下载会报
     * `234003 File not in msg`（看起来像"没权限"，实际是"key 不属于这条消息"）。
     * 本函数收到的 fileKey 来自 handleFeishuCallback 里的 decision.fileKey（即消息体），是对的。
     * 文件名保留（只做危险字符过滤），因为**扩展名决定模型怎么处理**
     * （.pdf 用 pdftotext，.xlsx 用 python 解 zip）。落盘到 media/ 下，与图片同目录。
     */
    async downloadFile(fileKey, fileName, messageId) {
      try {
        const tokRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
          signal: AbortSignal.timeout(10_000),
        });
        const tokJson = (await tokRes.json()) as { code?: number; tenant_access_token?: string };
        if (tokJson.code !== 0 || typeof tokJson.tenant_access_token !== 'string') {
          return { ok: false, error: `取飞书 token 失败（code=${tokJson.code ?? '?'}）` };
        }
        const url =
          `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}` +
          `/resources/${encodeURIComponent(fileKey)}?type=file`;
        const res = await fetch(url, {
          headers: { authorization: `Bearer ${tokJson.tenant_access_token}` },
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) return { ok: false, error: `下载文件失败：HTTP ${res.status}` };
        const ct = res.headers.get('content-type') ?? '';
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength === 0) return { ok: false, error: '下载到的文件为空' };
        if (buf.byteLength > 50 * 1024 * 1024) {
          return { ok: false, error: `文件过大（${buf.byteLength} 字节 > 50MB 上限）` };
        }
        if (ct.includes('application/json')) {
          return { ok: false, error: `飞书返回错误：${buf.toString('utf8').slice(0, 160)}` };
        }
        const safe = fileName.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(-120);
        const rel = `media/${Date.now()}-${safe}`;
        const w = await getExec().runTool({
          call_id: `feishu-file-${Date.now()}`,
          task_id: 'feishu-inbound-media',
          dot_id: 'dot1',
          issued_at: new Date().toISOString(),
          tool: 'fs.write',
          args: { path: rel, content_base64: buf.toString('base64') },
          deadline_ms: 60_000,
        });
        if (w.status !== 'ok') {
          const m = (w.error as { message?: string } | null)?.message ?? '写入失败';
          return { ok: false, error: `文件保存失败：${m}` };
        }
        return { ok: true, media: { path: rel, sizeBytes: buf.byteLength, contentType: ct, fileName } };
      } catch (cause) {
        return { ok: false, error: String(cause) };
      }
    },
  };
}

export function cpConcurrencyFromEnv(): Partial<{
  maxRunningTasks: number;
  interactiveReserve: number;
  preemptiblePriority: number;
}> {
  const out: Partial<{
    maxRunningTasks: number;
    interactiveReserve: number;
    preemptiblePriority: number;
  }> = {};
  const intOf = (name: string, min: number): number | null => {
    const raw = process.env[name];
    if (raw === undefined || raw.length === 0) return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
      throw new Error(`${name} 非法：${raw}（要求整数 ≥ ${min}）`);
    }
    return n;
  };
  const maxRunning = intOf('DOTD_MAX_RUNNING', 1);
  if (maxRunning !== null) out.maxRunningTasks = maxRunning;
  const reserve = intOf('DOTD_INTERACTIVE_RESERVE', 0);
  if (reserve !== null) out.interactiveReserve = reserve;
  const preemptible = intOf('DOTD_PREEMPTIBLE_PRIORITY', 0);
  if (preemptible !== null) out.preemptiblePriority = preemptible;
  return out;
}

/**
 * P1-1 容器内工具并发闸的取值（**只在 `DOTD_MAX_RUNNING > 1` 时被调用**）。
 *
 * 分档依据（Lead 批准）：
 *  - `browser.*` = 1：Playwright 的页面/上下文上限是硬约束，浏览器实例本身串行；
 *  - `shell.run` = 2：CPU 竞争与吞吐的折中，再多只会互相拖慢；
 *  - `fs.*` = 不限：本地快操作，排队成本大于收益。
 *
 * 三个键都可用环境变量覆盖（调优用）：`DOTD_JAIL_BROWSER` / `DOTD_JAIL_SHELL` /
 * `DOTD_JAIL_QUEUE_MS`。**排队超时才降级**（`container_busy`，retryable），不直接拒。
 */
export function containerJailFromEnv(): { browser: number; shell: number; fs: number; queueMs: number } {
  const num = (name: string, fallback: number, min: number): number => {
    const raw = process.env[name];
    if (raw === undefined || raw.length === 0) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < min) {
      throw new Error(`${name} 非法：${raw}（要求整数 ≥ ${min}）`);
    }
    return n;
  };
  return {
    browser: num('DOTD_JAIL_BROWSER', 1, 0),
    shell: num('DOTD_JAIL_SHELL', 2, 0),
    fs: 0,
    queueMs: num('DOTD_JAIL_QUEUE_MS', 30_000, 0),
  };
}

/**
 * 水位预留（MB）读取：DOTD_RESERVE_MB 环境变量优先，其次 ~/.dotd/config.yml 顶层
 * `dotdReserveMb:` 键（只按行匹配这一个标量，不引 YAML 库），都没有则返回 null 用默认。
 * 背景：装配层此前不读 dotd.yml 的 dotdReserveMb（接线缺口），本机内存紧张时无法调档。
 */
export function cpReserveMbFromEnvOrConfig(cfg: DaemonConfig): number | null {
  const envV = process.env.DOTD_RESERVE_MB;
  if (envV !== undefined && envV.length > 0) {
    const n = Number(envV);
    if (Number.isFinite(n) && n >= 0) return Math.round(n);
    throw new Error(`DOTD_RESERVE_MB 非法：${envV}`);
  }
  try {
    const txt = readFileSync(join(cfg.dataDir, 'config.yml'), 'utf8');
    const g = txt.match(/^dotdReserveMb:\s*([0-9_]+)\s*(?:#.*)?$/m)?.[1];
    if (g !== undefined) return Number(g.replace(/_/g, ''));
  } catch {
    // 配置文件缺失/不可读 → 回落默认（fail-open 只对本键，其余仍走各自 fail-closed）
  }
  return null;
}

// ── 治理面（模块单例已 initGovernance；此处只做端口投影）─────────────────────
/** GOV 的 router 依赖（契约 G4/T1：统一走 complete({track:'light'})）。 */
function govRouterOf(router: ModelRouter): GovDeps['router'] {
  return {
    async complete(req) {
      const r = await router.complete({
        track: 'light',
        // GOV 只发 system/user 两色（review.ts:114 precheckMessages）；CP 侧
        // 的 matchByLlm 也只发 system/user。assistant/tool 角色在此面不存在，
        // 但 contracts.ChatMessage 是四色——降级映射保证任何上游形状都能过类型。
        messages: req.messages.map((m) => ({
          role: m.role === 'system' || m.role === 'user' ? m.role : 'user',
          content: m.content,
        })),
        attemptId: req.attemptId,
        deadlineMs: req.deadlineMs,
        ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      });
      // RouteResult.response 是 ChatResponse | AsyncIterable<ChatChunk> 联合；
      // GOV 只取非流式文本，流式迭代器没有 .content，收敛为空串。
      const resp: unknown = r.response;
      const content =
        typeof resp === 'object' &&
        resp !== null &&
        'content' in resp &&
        typeof resp.content === 'string'
          ? resp.content
          : '';
      return { response: { content } };
    },
  };
}

/**
 * CP 的 lowBrain 端口（契约 T1 / CP §6.1：事件→目标匹配的模型层分流）。
 *
 * 与 govRouterOf 的分工：两者都把调用打到 `router.complete({track:'light'})`，
 * 但入参词表不同——CP 的 LowBrain 允许 assistant 角色（match.ts:51），GOV 的
 * router 端口只收 system/user（governance/types.ts:144）。统一收敛到
 * system/user（assistant → user）后再出网，两个端口各取所需。
 */
function lowBrainOf(router: ModelRouter): LowBrain {
  return {
    async complete(req) {
      const r = await router.complete({
        track: 'light',
        messages: req.messages.map((m) => ({
          role: m.role === 'system' || m.role === 'user' ? m.role : 'user',
          content: m.content,
        })),
        attemptId: req.attemptId,
        deadlineMs: req.deadlineMs,
      });
      const resp: unknown = r.response;
      const content =
        typeof resp === 'object' &&
        resp !== null &&
        'content' in resp &&
        typeof resp.content === 'string'
          ? resp.content
          : '';
      return { response: { content } };
    },
  };
}

/** CP 的治理 forceApproval 端口（unknown 孤儿步转审批，CP §5.3 / journal.ts:41）。 */
function govForcerOf(): GovernanceForcer {
  return {
    requestApproval: (req) =>
      govForceApproval(req.taskId, {
        kind: req.kind,
        subject: req.subject as unknown as Record<string, unknown>,
        reason: req.reason,
      }),
  };
}

/** SF 的治理端口（契约 S-2：唯一裁决写路径在 GOV decide()）。 */
function govPortOf(): GovernancePort {
  return {
    decide: (approvalId, channel, verdict, actor, note) =>
      govDecide(approvalId, channel, verdict, actor, note),
    listPending: (limit) => govListPending(limit) as ApprovalView[],
    getApproval: (idOrSeq) => govGetApproval(idOrSeq),
  };
}

/** Runner 的治理面（接缝 §8 ⑧/⑨：evaluate/claim/forceApproval）。 */
function govApiOf(): GovernanceApi {
  return {
    evaluate: (ctx, call, opts) => govEvaluate(ctx, call, opts ?? {}),
    claim: (approvalId) => govClaim(approvalId),
    forceApproval: (taskId, req) => govForceApproval(taskId, req),
    resolveExecution: (approvalId, outcome) => govResolveExecution(approvalId, outcome),
  };
}

/** SF 的记忆端口（契约 S-1：会话历史属主 = MEM）。 */
function memPortOf(memory: MemoryServiceImpl): MemoryPort {
  return {
    openThread: (dotId, channel, o) => memory.openThread(dotId, channel, o),
    appendMessage: (threadId, msg) => memory.appendMessage(threadId, msg),
    listThreads: async (dotId, o) => {
      // contracts.ts §7 ThreadSummary（最小投影）与 MEM §8 ThreadSummary（整行投影）
      // 字段名不同：MEM 用 lastActiveAt，契约用 updatedAt。装配层做形状适配——
      // SF 只消费契约投影（http.ts:520 只把它透传给前端）。
      const rows = await memory.listThreads(dotId, o);
      return rows.map((t) => ({
        id: t.id,
        title: t.title,
        channel: t.channel,
        status: t.status,
        createdAt: t.lastActiveAt,
        updatedAt: t.lastActiveAt,
      }));
    },
    listMessages: (threadId, o) => memory.listMessages(threadId, o),
    // **必须转发**（2026-10-19 实测发现）：契约里它是可选方法，适配器起初漏了这一行，
    // 于是 Runner 拿到的 memory 端口上 refreshContextSummary 是 undefined，
    // 走的是"旧装配没有它时跳过"的降级分支 —— 结果是**422 个线程一条摘要都没生成**，
    // 长会话只能靠 8000 token 硬裁，越聊越记不住开头。
    // Runner 侧日志形如：DIAG-SUM ... hasFn=false。
    refreshContextSummary: (threadId) => memory.refreshContextSummary(threadId),
  };
}

/** Runner 的执行面（contracts.ts §9 ExecServiceApi）。 */
function execApiOf(exec: ExecServiceImpl): ExecServiceApi {
  return {
    runTool: (call) => exec.runTool(call),
    getCapabilities: (dotId) => exec.getCapabilities(dotId),
    // 词表适配：契约 §9 的 ExecReconciler 用 'done'|'aborted'|'unknown'|'unknown_host'，
    // 而 ExecServiceImpl.reconcileCall 返回 ReconcileEntry{outcome:'done'|'doing'|
    // 'interrupted'|'skipped'}（EX §5.3 三分流）。Runner 主循环不调它（⑫ 对账归
    // CP/Journal.reconcileAndResolve），此处只做形状适配（tests/runner-main.test.ts 同款）。
    reconcileCall: async (callId) => {
      const entry = await exec.reconcileCall(callId);
      return entry.outcome === 'done' ? 'done' : 'unknown';
    },
    getCallResult: (callId) => exec.getCallResult(callId),
    cancelTool: (callId, reason) => exec.cancelTool(callId, reason),
  };
}

/** Runner 的记忆面（契约 M3/M1：sealTask 全覆盖 + buildSessionReplay 唯一重建入口）。 */
function memApiOf(memory: MemoryServiceImpl): MemoryServiceApi {
  return {
    openThread: (dotId, channel, o) => memory.openThread(dotId, channel, o),
    appendMessage: (threadId, msg) => memory.appendMessage(threadId, msg),
    appendSystemMessage: (threadId, msg) => memory.appendSystemMessage(threadId, msg),
    buildContextBundle: (dotId, taskText, budgetTokens, o) =>
      memory.buildContextBundle(dotId, taskText, budgetTokens, o),
    buildSessionReplay: (threadId, taskId, budgetTokens) =>
      memory.buildSessionReplay(threadId, taskId, budgetTokens),
    beforeWrite: (dotId, path, content) => memory.beforeWrite(dotId, path, content),
    sealTask: (task, outcome, reason) => memory.sealTask(task, outcome, reason),
    // P1-4：收口前"补写一轮"的判定与幂等（sealTask 在 finish 之后才跑，来不及）
    needsMemoryRedo: (task, outcome) => memory.needsMemoryRedo(task, outcome),
    hasMemoryReminder: (taskId) => memory.hasMemoryReminder(taskId),
    markMemoryReminder: (taskId, at) => memory.markMemoryReminder(taskId, at),
    // **会话摘要刷新**（2026-10-19 实测发现）：这是 Runner 实际用的适配器（memApiOf），
    // 而契约里 refreshContextSummary 是可选方法——漏了这一行，Runner 拿到的就是 undefined，
    // 走"旧装配没有它"的降级分支 → **422 个线程一条摘要都没生成**。
    // （上一轮我误改到 memPortOf 上，那个是 SF 面用的，Runner 不看它。）
    refreshContextSummary: (threadId) => memory.refreshContextSummary(threadId),
  };
}

/** MR 的模型面（契约 T1：主循环 track:'primary'）。 */
function routerApiOf(router: ModelRouter): ModelRouterApi {
  return {
    complete: (req) => router.complete(req),
    stream: (req) => router.stream(req),
    trackForEvent: (eventType) => router.trackForEvent(eventType),
    trackForRequest: (req) => router.trackForRequest(req),
    snapshot: () => router.snapshot(),
    get emergencyActive(): boolean {
      return router.emergencyActive;
    },
  };
}

// ── 装配 ────────────────────────────────────────────────────────────────────

export interface Daemon {
  cfg: DaemonConfig;
  db: DatabaseSync;
  bus: EventBus;
  sse: SseBus;
  cp: ControlPlaneInstance;
  router: ModelRouter;
  exec: ExecServiceImpl;
  memory: MemoryServiceImpl;
  runner: DotRunner;
  server: Server;
  /** 启动恢复报告（CP §7.1 步骤 3–6）。 */
  recovery: RecoveryReport;
  /** 优雅退出（幂等）。 */
  shutdown(reason: string): Promise<void>;
}

/**
 * 装配 daemon（含 listen 与恢复，但**不**自动起 Runner 循环以外的常驻）——
 * 供 `dotd serve` 与后续集成测试复用。
 *
 * 顺序（CONVENTIONS §4）：CP → MR → GOV → EX → MEM → SF。
 * CP 先建：GOV/EX 的回调要写回 CP（setAwaitingApproval/onApprovalSettled），
 * 而 CP 的 recover 又要读治理 approvals 与执行面对账结果。环用"先建后注"打破：
 * 建 CP → 建 MR → 建 GOV（cp 钩子回填到真 CP）→ 建 EX → 把 exec 补注进 CP 的
 * journal/recovery deps → 建 MEM → 建 SF → recover → Runner 循环。
 */
export async function assembleDaemon(opts: { cfg?: DaemonConfig } = {}): Promise<Daemon> {
  const cfg = opts.cfg ?? loadDaemonConfig();
  const log = (m: string): void => {
    process.stdout.write(`[dotd] ${m}\n`);
  };

  // ① openDb + migrate（CP §7.1 步骤 1；失败 → 拒启动 + 追加 OUTBOX.md）
  const db = openDb(cfg.dbPath);
  try {
    // expectedVersion 必须等于 db/migrations/ 里最大的 NNN（当前 190）。
    // 少写一位 → 新库首次启动就 MigrationError 拒启动（实测：加 100 包忘了改这里，
    // 六个装配测试全挂在这一句）。新增迁移包时同步改这里与 tests/helpers.ts 的注释。
    const res = migrate(db, { expectedVersion: 190 });
    if (res.from !== res.to) log(`迁移 ${res.from}→${res.to}（应用 ${res.applied.length} 包）`);
    else log(`库已是最新（user_version=${res.to}）`);
  } catch (cause) {
    db.close();
    appendOutbox(cfg.dataDir, `启动失败：${String(cause)}`);
    throw cause instanceof MigrationError ? cause : new MigrationError(String(cause), null, { cause });
  }

  const blobDir = join(cfg.dataDir, 'journal-blobs');
  mkdirSync(blobDir, { recursive: true });
  const outboxPath = join(cfg.dataDir, 'OUTBOX.md');

  // ② EventBus + SSE 总线（bus_seq 从 surf_sse_cursor 续读，SF §4.5）
  const cursorProbe = new SseBus({ db, bus: new EventBus() });
  const persistedSeq = cursorProbe.persistedSeq();
  const bus = new EventBus({ startSeq: persistedSeq });
  // SF §4.5 重放快照数据源（approval/queue 两通道可重建）。CP 与 GOV 在本步之后才
  // init，故与下面的 execHolder/memHolder 同模式用惰性 holder：SseBus 构造期只收
  // 闭包，运行期（首个订阅者接入 / 断线补档）才真读。缺省（holder 为空）时
  // SseBus.snapshotFrames 返回 []，只发 resync 帧——不因装配顺序把总线降级。
  const cpHolder: { cp: ControlPlaneInstance | null } = { cp: null };
  const govHolderForSse: { listPending: (() => ApprovalView[]) | null } = { listPending: null };
  const sseBus = new SseBus({
    db,
    bus,
    snapshot: {
      approvals: () => govHolderForSse.listPending?.() ?? [],
      queue: () =>
        (cpHolder.cp?.list({ status: ['queued', 'running'] }) ?? []).map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          dotId: t.dotId,
        })),
    },
  });
  sseBus.attach();

  // ③ CP（先建：其余模块的回调都指向它）。sealTask 钩子经 holder 惰性取 MEM
  //    （契约 M3：MEM 在 CP 之后 init，但 Queue.finish 运行期才调钩子）；
  //    exec/governance 同理经 holder 惰性取（EX/GOV 在 CP 之后 init，
  //    而 CP 的 journal/guard/recovery 只在运行期读它们）。
  const rules: EventRule[] = loadEventRules(join(cfg.configDir, 'event-rules.yml'));
  if (rules.length > 0) log(`事件规则层载入 ${rules.length} 条`);
  const memHolder: { svc: MemoryServiceImpl | null } = { svc: null };
  const execHolder: { svc: ExecServiceImpl | null } = { svc: null };
  const govHolder: { forcer: GovernanceForcer | null } = { forcer: null };
  const routerHolder: { r: ModelRouter | null } = { r: null };

  const execPortsOf = (): ExecPorts & ExecReconciler => {
    const svc = execHolder.svc;
    if (svc === null) {
      throw new Error('exec 尚未装配（CP 的 exec 端口在运行期才被读取，不应提前触发）');
    }
    // 词表适配：契约 journal.ts 的 ExecReconciler.reconcileCall 返回
    // 'done'|'unknown'|'aborted'|'unknown_host'，而 ExecServiceImpl.reconcileCall
    // 返回 ReconcileEntry{outcome:'done'|'doing'|'interrupted'|'skipped'}（EX §5.3
    // 三分流）。CP 的 journal.reconcileAndResolve 只判 'done' 与否，故映射：
    // done→done；doing/interrupted→aborted（重试可再入）；skipped→unknown。
    return {
      pauseContainer: (dotId) => svc.pauseContainer(dotId),
      unpauseContainer: (dotId) => svc.unpauseContainer(dotId),
      destroyDotContainer: (dotId, opts) => svc.destroyDotContainer(dotId, opts),
      getContainerStats: (dotId) => svc.getContainerStats(dotId),
      reconcileCall: async (callId) => {
        const entry = await svc.reconcileCall(callId);
        if (entry.outcome === 'done') return 'done';
        if (entry.outcome === 'doing' || entry.outcome === 'interrupted') return 'aborted';
        return 'unknown';
      },
      // 词表适配：ExecServiceImpl.getCallResult 回 unknown（容器终态 ToolResult 或
      // {result_hash}）；契约面只要 {resultJson}。取不到明文时回落 null
      // （CP 按「无结果」走 unknown 路径，与 EX §5.4「明文由容器 ledger 持有」一致）。
      getCallResult: async (callId) => {
        const r: unknown = await svc.getCallResult(callId);
        if (r === null || typeof r !== 'object') return null;
        const o = r as { result?: unknown; result_hash?: unknown };
        if (o.result !== undefined) return { resultJson: JSON.stringify(o.result) };
        if (typeof o.result_hash === 'string') return { resultJson: JSON.stringify({ result_hash: o.result_hash }) };
        return { resultJson: JSON.stringify(r) };
      },
    };
  };

  // CP §6.3 水位预留：dotd.yml 声明了 dotdReserveMb 但装配层此前未读（接线缺口）。
  // 优先级：DOTD_RESERVE_MB（调试覆盖）> ~/.dotd/config.yml 顶层键 > DEFAULT_CP_CONFIG。
  const reserveMbOverride = cpReserveMbFromEnvOrConfig(cfg);

  // P1-1 并发：**显式声明才开**（默认值纪律：默认 1 = 与既有行为逐字相同）。
  const concurrencyCfg = cpConcurrencyFromEnv();

  const cp = createControlPlane({
    db,
    bus,
    rules,
    dotIds: cfg.dotIds,
    blobDirAbs: blobDir,
    ...(reserveMbOverride === null ? {} : { cfg: { dotdReserveMb: reserveMbOverride } }),
    // P1-1：并发相关键只在**显式声明**时覆盖（否则完全走 DEFAULT_CP_CONFIG，行为不变）。
    ...(Object.keys(concurrencyCfg).length === 0 ? {} : { cfg: concurrencyCfg }),
    // 模型层（契约 T1 / CP §6.1）：事件→目标匹配的 LLM 分流走 light 轨。
    // MR 在 CP 之后 init（它要 cp 的 taskImpact/registerInternalJob），故经 holder
    // 惰性取——matcher 只在事件匹配运行期调 lowBrain.complete。
    lowBrain: {
      complete: (req) => {
        const r = routerHolder.r;
        if (r === null) {
          throw new Error('router 尚未装配（CP 的 lowBrain 在运行期才被读取，不应提前触发）');
        }
        return lowBrainOf(r).complete(req);
      },
    },
    // 惰性门面：EX/GOV 在 CP 之后 init，CP 只在运行期（guard 容器指令 /
    // journal 对账 / unknown 孤儿步转审批）才经这两个闭包读它们。
    exec: {
      pauseContainer: (dotId) => execPortsOf().pauseContainer(dotId),
      unpauseContainer: (dotId) => execPortsOf().unpauseContainer(dotId),
      destroyDotContainer: (dotId, opts) => execPortsOf().destroyDotContainer(dotId, opts),
      getContainerStats: (dotId) => execPortsOf().getContainerStats(dotId),
      reconcileCall: (callId) => execPortsOf().reconcileCall(callId),
      getCallResult: (callId) => execPortsOf().getCallResult(callId),
    },
    governance: {
      requestApproval: (req) => {
        const forcer = govHolder.forcer;
        if (forcer === null) {
          throw new Error('governance 尚未装配（GOV 在 CP 之后 init，不应提前触发）');
        }
        return forcer.requestApproval(req);
      },
    },
    sealTask: (task: Task, outcome, reason) => {
      const svc = memHolder.svc;
      // MEM 未就绪时不封（装配顺序保证 SF/MEM 先于任何任务终态）
      return svc === null ? Promise.resolve() : svc.sealTask(task, outcome, reason);
    },
  });

  // ④ 前置：求救通知通道。原在 ⑧ 才装配，MR 只能收到 null → 求救永远落 OUTBOX.md，
  // 飞书机器人（主人 2026-10-16 指定通道）一条都收不到。SF 配置是纯读取，提前无副作用。
  const surfCfg = loadSurfacesConfig(cfg.configPath);
  assertHttpConfig(surfCfg);
  // 飞书：App ID + App Secret 都配了才装配真网关，否则 NULL 占位（available 恒 false）
  const feishuGw =
    surfCfg.feishu.appId.length > 0 && surfCfg.feishu.appSecret.length > 0
      ? new FeishuGateway(surfCfg.feishu)
      : NULL_FEISHU_GATEWAY;
  const channels: NotificationChannels = new SurfacesNotificationChannels({
    telegram: NULL_TELEGRAM_GATEWAY,
    feishu: feishuGw,
    filePath: join(cfg.dataDir, 'notifications.log'),
    defaultChatId: surfCfg.telegram.ownerChatId ?? surfCfg.telegram.allowlist[0],
    // owner_chat_id 允许逗号分隔多会话（入站闸门放行全部）；出站通知发第一个。
    // 求救通道是**单会话语义**：channels.ts 的 feishuChatId?: string 会被原样塞进
    // 飞书 API 的 chat_id，传 'oc_a,oc_b' 直接 400 → 求救静默降级到 OUTBOX.md，
    // 比「只发第一个」更糟。所以这里显式取主会话（不再是手切字符串）。
    // 要让求救也广播，得先把 channels.ts 的接口改成 chatIds: string[] + 逐会话发。
    feishuChatId: parseOwnerChatIds(surfCfg.feishu.ownerChatId)[0],
  });
  // 飞书可用性预热：拿到 token 即置位。否则 daemon 刚起来时 available('feishu') 恒 false
  // （只在 sendText 成功后才置位），第一封求救——常是重启后两轨齐挂那一刻——会白白
  // 绕过飞书落进 OUTBOX.md。fire-and-forget：失败不阻启动，可用性保持 false，求救
  // 照旧走 OUTBOX 兜底。
  if (feishuGw !== NULL_FEISHU_GATEWAY) {
    void feishuGw.warm().then((ok) => {
      if (ok) log('[surfaces] 飞书凭证校验通过（求救可走飞书）');
      else log('[surfaces] 飞书凭证预热失败（求救暂落 OUTBOX，待后续成功发送置位）');
    });
  }

  // ④-a 审批卡片（T3，2026-10-20）
  //
  // **注意：这里不订阅 approval:created。**
  // feishu-outbound.ts 已经订阅了同一个事件发纯文本审批通知。两个订阅者
  // 会导致同一条审批推两次 —— 实测发现（grep approval:created 见两处）。
  //
  // 所以卡片能力注入给 feishu-outbound，由它**二选一**：
  //   能发卡片就发卡片（带按钮），发不出去才退回纯文本。
  // 去重交给它的 claimAndSend（同一 approvalId 只发一次）。
  const cardRegistry = new CardRegistry();
  // B1（F5）：owner_chat_id 允许逗号分隔多会话，入站闸门放行全部，
  // **出站也要投全部** —— 原来这里取 [0]，第二个会话永远收不到审批卡片，
  // 任务卡在 awaiting_approval 直到 24h 过期。切换点收敛到 parseOwnerChatIds。
  const ownerChats = parseOwnerChatIds(surfCfg.feishu.ownerChatId);
  // 单会话消费方（进度推送 9.1、求救通道）仍取第一个：那是高频播报/兜底，
  // 广播会变成打扰；真要多会话得先改各自的接口，见 docs backlog。
  const ownerChatForApproval = ownerChats[0] ?? '';
  const approvalCardSender =
    feishuGw !== NULL_FEISHU_GATEWAY && ownerChats.length > 0
      ? {
          chatIds: ownerChats,
          // 循环由 feishu-outbound.ts 的 claimAndSend 驱动（发送/审计/去重一处），
          // 这里只负责「往指定会话发一张」并把 messageId 记进 registry。
          send: async (view: import('./shared/contracts.ts').ApprovalView, chatId: string) => {
            const r = await feishuGw.sendCard(chatId, buildApprovalCard(view));
            if (r.ok && r.messageId !== undefined) cardRegistry.set(view.id, r.messageId);
            return r;
          },
        }
      : undefined;

  // ④ MR（TaskImpact 由 CP 提供，契约 T2；channels = 上面的 SF 适配器）
  const router = ModelRouter.load({
    db,
    configDir: cfg.configDir,
    scheduler: cp,
    channels,
    bus,
    taskImpact: () => cp.taskImpact(),
  });
  routerHolder.r = router; // 回填：CP 的 lowBrain 从此刻起可读
  cpHolder.cp = cp; // 回填：SSE queue 通道快照从此刻起可读

  // ⑤ GOV（cp 钩子回填到真 CP；模块单例 initGovernance）
  const { catalog, warnings } = loadCatalog(
    join(cfg.configDir, 'tools.yml'),
    join(cfg.configDir, 'rules.yml'),
  );
  for (const w of warnings) log(`[governance] 目录告警：${w.kind} ${w.detail}`);
  const govDeps: GovDeps = {
    controlPlane: {
      setAwaitingApproval: (taskId, epoch, approvalId) =>
        cp.setAwaitingApproval(taskId, epoch, approvalId),
      onApprovalSettled: (taskId, approvalId, ok, meta) =>
        cp.onApprovalSettled(taskId, approvalId, ok, meta),
      resumeDotQueue: (dotId) => cp.resumeDotQueue(dotId),
    },
    journal: {
      // GOV §1.2：治理绝不写 journal，只读核对
      stepExists: (callId) => cp.journal.getStepByCallId(callId) !== null,
    },
    router: govRouterOf(router),
    bus: {
      publish: (topic, payload, o) => bus.publish(topic, payload, o),
      on: (topic, handler) => bus.on(topic, handler),
    },
  };
  initSeq(db);
  const govRt = initGovernance(db, catalog, govDeps);
  // 契约 S5：订阅 router.mode_changed，路由进/出 EMERGENCY 时写 emergency_on/off
  // 审计并清审查熔断窗口。这个 watcher 此前全库没有调用方——紧急切换既不审计也不
  // 清窗口，旧策略的失败样本会一直压着审查熔断（2026-10-17 接线）。
  const emergencyWatch = watchEmergency(govRt, bus);

  // ⑥ EX（fleet 的唯一开关是 DOTD_FLEET，经 execConfigFromEnv 落到 ExecConfig.fleet；
  //     未设时 DEFAULT_EXEC_CONFIG.fleet='stub'。真 fleet 要求 daemon 跑在 WSL 里：
  //     dockerSocketPath 硬编码 /var/run/docker.sock，HttpRuntime 又走容器 IP:9223。）
  const exec = new ExecServiceImpl({
    db,
    bus,
    cfg: {
      ...execConfigFromEnv(),
      tokenDir: process.env.DOTD_TOKEN_DIR ?? join(cfg.dataDir, 'exec-tokens'),
      // P1-1 容器内工具并发闸：**只在开了并发时才生效**。
      // maxRunningTasks=1（默认）时 Runner 一次只派发一个工具，闸永远不该触发 →
      // 此时不传该键，走 ExecConfig 的默认"全不限"，保证默认行为与改动前逐字一致。
      ...(concurrencyCfg.maxRunningTasks !== undefined && concurrencyCfg.maxRunningTasks > 1
        ? { containerJail: containerJailFromEnv() }
        : {}),
    },
    // P0-3 在途心跳：工具在途期间由执行面轮询驱动心跳（CP 的 heartbeat 在此注入，
    // EX 不 import CP、不直写 tasks 表——CONVENTIONS §4 模块边界）。
    // 语义：每轮**成功**的 GET /jobs 续一次；getJob 抛错/容器判死/本地 deadline 都很
    // 不再续 → 真卡死仍会被看门狗按 180s 回收（不掩盖卡死）。
    liveness: {
      live: ({ taskId, epoch, now }) => {
        cp.heartbeat(taskId, epoch, undefined, { live: { at: now } });
      },
    },
    // P2-1：MCP 外部工具通道。**默认关闭**——config/mcp-servers.yml 未声明 server 时
    // 这里是空列表，`mcp.call` 不会出现在模型工具面里（见 getCapabilities 的过滤）。
    // 配置解析失败会抛错 → 拒启动（静默忽略一份写错的安全配置最危险）。
    mcp: new McpClient(
      loadMcpServers(process.env.DOTD_MCP_CONFIG ?? join(cfg.configDir, 'mcp-servers.yml')),
    ),
  });

  // 宿主侧工具（2026-10-18）：定时任务的操作对象是控制面的 crontabs 表，
  // 容器只是沙箱，不能也不该让容器去改它。注册到执行面后对模型与普通工具无差别。
  const cronNext = (cron: string, from: number): number =>
    CronExpressionParser.parse(cron, { currentDate: new Date(from) }).next().getTime();
  exec.registerHostTool('schedule.create', async (args) => {
    const r = createSchedule(
      db,
      {
        title: typeof args['title'] === 'string' ? args['title'] : '',
        prompt: typeof args['prompt'] === 'string' ? args['prompt'] : '',
        cron: typeof args['cron'] === 'string' ? args['cron'] : '',
        ...(typeof args['quiet_hours'] === 'string' ? { quietHours: args['quiet_hours'] } : {}),
        // 一次性任务（迁移 150）：触发成功即停用
        ...(args['once'] === true ? { once: true } : {}),
      },
      cronNext,
    );
    if (!r.ok) return { ok: false, code: 'schedule_invalid', message: r.error ?? '创建失败' };
    return {
      ok: true,
      value: {
        id: r.schedule!.id,
        title: r.schedule!.title,
        cron: r.schedule!.cron,
        next_fire_at: new Date(r.schedule!.nextFireAt).toISOString(),
        note: '定时任务已创建，到点会自动以任务形式执行 prompt 里的事',
      },
    };
  });
  exec.registerHostTool('schedule.remove', async (args) => {
    const id = typeof args['id'] === 'string' ? args['id'].trim() : '';
    if (id.length === 0) {
      return { ok: false, code: 'schedule_invalid', message: '要停用哪一条？给我 id（可用 schedule.list 查）' };
    }
    const r = removeSchedule(db, id);
    if (!r.ok) return { ok: false, code: 'schedule_not_found', message: r.error ?? '没找到这条定时任务' };
    return { ok: true, value: { id, removed: true, note: '已停用（不是硬删，能在管理界面恢复）' } };
  });

  exec.registerHostTool('schedule.list', async () => {
    const rows = listSchedules(db);
    return {
      ok: true,
      value: {
        count: rows.length,
        schedules: rows.map((x) => ({
          id: x.id,
          title: x.title,
          cron: x.cron,
          next_fire_at: new Date(x.nextFireAt).toISOString(),
          last_fire_status: x.lastFireStatus,
        })),
      },
    };
  });
  // ── 邮件工具（T1/T2，2026-10-20）──────────────────────────────────
  //
  // 为什么在 daemon 里而不是容器里：
  //   邮箱凭证是**主人的身份**，不能进容器。容器是 agent 的工作区，
  //   agent 能跑任意 bash —— 把密码放进容器等于让 agent 能读到自己不该读的东西。
  //   放宿主侧，agent 只能通过这六个工具间接操作邮箱。
  //
  // 密钥从哪来：DOTD_MAIL_KEY（32 字节 base64）。
  //   没配的话**不注册邮件工具** —— 让"没配置"表现为"工具不存在"，
  //   而不是"工具存在但一调用就崩"。
  const mailKey = process.env.DOTD_MAIL_KEY ?? '';
  let mail: MailService | null = null;
  if (mailKey !== '') {
    try {
      mail = new MailService(db, mailKey);
      const dotOf = () => cfg.dotIds[0] ?? 'dot1';

      exec.registerHostTool('mail.account.add', async (args) => {
        const a = args as Record<string, unknown>;
        const need = ['label', 'email', 'imapHost', 'smtpHost', 'password'] as const;
        for (const k of need) {
          if (typeof a[k] !== 'string' || (a[k] as string) === '') {
            return { ok: false as const, code: 'BAD_ARG', message: `缺参数 ${k}` };
          }
        }
        const row = mail!.addAccount(dotOf(), {
          label: String(a.label),
          email: String(a.email),
          imapHost: String(a.imapHost),
          // 常见默认值：163/QQ/Gmail 都是 993/465
          imapPort: typeof a.imapPort === 'number' ? a.imapPort : 993,
          smtpHost: String(a.smtpHost),
          smtpPort: typeof a.smtpPort === 'number' ? a.smtpPort : 465,
          password: String(a.password),
        });
        return {
          ok: true as const,
          value: { id: row.id, label: row.label, email: row.email, note: '凭证已加密存储' },
        };
      });

      exec.registerHostTool('mail.account.list', async () => {
        const rows = mail!.listAccounts(dotOf());
        return {
          ok: true as const,
          value: {
            count: rows.length,
            accounts: rows.map((r) => ({
              id: r.id,
              label: r.label,
              email: r.email,
              imap: `${r.imap_host}:${r.imap_port}`,
              smtp: `${r.smtp_host}:${r.smtp_port}`,
              last_ok_at: r.last_ok_at,
              last_error: r.last_error,
            })),
          },
        };
      });

      exec.registerHostTool('mail.account.remove', async (args) => {
        const label = String((args as Record<string, unknown>).account ?? '');
        const done = mail!.removeAccount(dotOf(), label);
        return done
          ? { ok: true as const, value: { removed: label } }
          : { ok: false as const, code: 'NOT_FOUND', message: `找不到账号 ${label}` };
      });

      exec.registerHostTool('mail.list', async (args) => {
        const a = args as Record<string, unknown>;
        const account = String(a.account ?? '');
        try {
          const items = await mail!.list(dotOf(), account, typeof a.limit === 'number' ? a.limit : 20);
          return { ok: true as const, value: { count: items.length, messages: items } };
        } catch (e) {
          return { ok: false as const, code: 'MAIL_ERROR', message: (e as Error).message, retryable: true };
        }
      });

      exec.registerHostTool('mail.read', async (args) => {
        const a = args as Record<string, unknown>;
        try {
          const m = await mail!.read(dotOf(), String(a.account ?? ''), String(a.uid ?? ''));
          if (m === null) return { ok: false as const, code: 'NOT_FOUND', message: '没有这封邮件' };
          return { ok: true as const, value: m };
        } catch (e) {
          return { ok: false as const, code: 'MAIL_ERROR', message: (e as Error).message, retryable: true };
        }
      });

      exec.registerHostTool('mail.search', async (args) => {
        const a = args as Record<string, unknown>;
        const kw = String(a.keyword ?? '');
        if (kw === '') return { ok: false as const, code: 'BAD_ARG', message: '缺 keyword' };
        try {
          const items = await mail!.search(dotOf(), String(a.account ?? ''), kw, typeof a.limit === 'number' ? a.limit : 20);
          return { ok: true as const, value: { count: items.length, messages: items } };
        } catch (e) {
          return { ok: false as const, code: 'MAIL_ERROR', message: (e as Error).message, retryable: true };
        }
      });

      // 起草：只入库，不发。返回 draftId 供后续 mail.send 引用。
      exec.registerHostTool('mail.draft', async (args) => {
        const a = args as Record<string, unknown>;
        const to = Array.isArray(a.to) ? (a.to as string[]) : [];
        if (to.length === 0) return { ok: false as const, code: 'BAD_ARG', message: '缺收件人 to' };
        try {
          const id = mail!.createDraft(dotOf(), String(a.account ?? ''), {
            to,
            cc: Array.isArray(a.cc) ? (a.cc as string[]) : [],
            subject: String(a.subject ?? ''),
            body: String(a.body ?? ''),
            inReplyTo: typeof a.inReplyTo === 'string' ? a.inReplyTo : undefined,
            taskId: typeof a.taskId === 'string' ? a.taskId : undefined,
          });
          return {
            ok: true as const,
            value: {
              draftId: id,
              note: '草稿已生成，**尚未发送**。要发出去需调用 mail.send（需主人审批）。',
            },
          };
        } catch (e) {
          return { ok: false as const, code: 'MAIL_ERROR', message: (e as Error).message };
        }
      });

      // 发送：tier=dangerous，gate 会在执行前拦下来开审批单。
      // 这里拿到的是**已经批准过**的调用（gate 保证），所以直接发。
      exec.registerHostTool('mail.send', async (args) => {
        const draftId = String((args as Record<string, unknown>).draftId ?? '');
        if (draftId === '') return { ok: false as const, code: 'BAD_ARG', message: '缺 draftId' };
        const r = await mail!.sendDraft(dotOf(), draftId);
        if (!r.ok) return { ok: false as const, code: 'SEND_FAILED', message: r.error ?? '发送失败', retryable: true };
        return { ok: true as const, value: { sent: true, messageId: r.messageId } };
      });

      log(`[mail] 邮件工具已注册（8 个），凭证加密密钥已加载`);

    } catch (e) {
      // 密钥格式不对 → 不注册，但要吼一声。静默降级会让人以为配好了。
      log(`[mail] 邮件工具未启用：${(e as Error).message}`);
      mail = null;
    }
  } else {
    log('[mail] 未配置 DOTD_MAIL_KEY，邮件工具不注册（这是预期行为，配了密钥才启用）');
  }

  // ── 日历工具（T6 只读订阅，2026-10-20；T7 本地写回，2026-10-21）─────────────────
  //
  // 读两个（calendar.list / conflicts）是 read 档；写三个（add/edit/delete，
  // T7）是 write_file 档，**只动本地日历文件**（<dataDir>/calendar/local.ics），
  // 订阅 .ics 是别人系统的投影，在写路径上永远只读。
  // 读写分工具名而不是共用一个带开关的工具 —— 让"读"和"写"共用同一个工具名
  // 等于把审批绕过去了。
  //
  // 为什么不需要密钥：读的是本地 .ics 文件。不连 Google/Outlook，
  // 所以没有 OAuth、没有 token 过期、没有申请审核。
  const calendarDir = join(cfg.dataDir, 'calendar');
  try {
    mkdirSync(calendarDir, { recursive: true });
  } catch {
    // 建不出来也不影响启动：listEvents 会如实报"目录不存在"
  }

  exec.registerHostTool('calendar.list', async (args) => {
    const a = (args ?? {}) as { window_days?: unknown; source?: unknown };
    const days =
      typeof a.window_days === 'number' && a.window_days > 0 ? Math.min(365, Math.floor(a.window_days)) : 7;
    const source = typeof a.source === 'string' ? a.source : undefined;
    const r = listEvents({ dir: calendarDir }, Date.now(), days, source);
    // 结果里总是带上文字版：模型拿到的就是能直接转告主人的人话，
    // 不用自己再拼一遍（拼错了反而更糟）。
    return { ok: true, value: { ...r, text: renderList(r) } };
  });

  exec.registerHostTool('calendar.conflicts', async (args) => {
    const a = (args ?? {}) as { window_days?: unknown };
    const days =
      typeof a.window_days === 'number' && a.window_days > 0 ? Math.min(365, Math.floor(a.window_days)) : 7;
    const r = listConflicts({ dir: calendarDir }, Date.now(), days);
    return { ok: true, value: { ...r, text: renderConflicts(r) } };
  });

  exec.registerHostTool('calendar.add', async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const input: LocalEventInput = {
      summary: typeof a.summary === 'string' ? a.summary : '',
      start: typeof a.start === 'string' ? a.start : '',
    };
    if (typeof a.end === 'string') input.end = a.end;
    if (typeof a.durationMin === 'number') input.durationMin = a.durationMin;
    if (typeof a.location === 'string') input.location = a.location;
    if (typeof a.notes === 'string') input.notes = a.notes;
    const r = addLocalEvent({ dir: calendarDir }, Date.now(), input);
    if (!r.ok) return { ok: false, code: 'BAD_ARG', message: r.error, retryable: false };
    // 加完顺手查 14 天冲突（本地+订阅合并后查），把"撞车"直接递到模型眼前
    const c = listConflicts({ dir: calendarDir }, Date.now(), 14);
    const mine = c.conflicts.filter((x) => x.a.uid === r.event.uid || x.b.uid === r.event.uid);
    const dupNote = r.duplicate === true ? '（同一条此前已加过，未重复添加）' : '';
    const conflictNote = mine.length > 0 ? `；注意：与已有日程冲突 ${mine.length} 处` : '';
    return {
      ok: true,
      value: {
        event: r.event,
        ...(r.duplicate === true ? { duplicate: true } : {}),
        conflicts: mine,
        text: `已加日程：${r.event.summary}${dupNote}${conflictNote}。`,
      },
    };
  });

  exec.registerHostTool('calendar.edit', async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const patch: Partial<LocalEventInput> = {};
    if (typeof a.summary === 'string') patch.summary = a.summary;
    if (typeof a.start === 'string') patch.start = a.start;
    if (typeof a.end === 'string') patch.end = a.end;
    if (typeof a.durationMin === 'number') patch.durationMin = a.durationMin;
    if (typeof a.location === 'string') patch.location = a.location;
    if (typeof a.notes === 'string') patch.notes = a.notes;
    const r = editLocalEvent(
      { dir: calendarDir },
      Date.now(),
      typeof a.id === 'string' ? a.id : '',
      patch,
    );
    if (!r.ok) return { ok: false, code: 'BAD_ARG', message: r.error, retryable: false };
    return { ok: true, value: { event: r.event, text: `已改日程：${r.event.summary}。` } };
  });

  exec.registerHostTool('calendar.delete', async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const r = deleteLocalEvent({ dir: calendarDir }, Date.now(), typeof a.id === 'string' ? a.id : '');
    if (!r.ok) return { ok: false, code: 'BAD_ARG', message: r.error, retryable: false };
    return {
      ok: true,
      value: { removed: r.removed, text: r.removed ? '已删除该日程。' : '本地日历里没有这个 id，没有日程被删。' },
    };
  });

  // 2026-10-22：节假日/调休 —— 主人日常问的是「明天上不上班」「这个月还剩几天假」
  // 「哪几天适合出去」，这些只要日历事实，不该要求主人先维护日历源。
  // 数据源是公开节假日表（多源降级 + 本地缓存，见 src/connectors/holiday.ts）；
  // 天气用 open-meteo（零 key）。两者都不碰主人的日历文件 ⇒ read 档，不审批。
  const holidayCacheDir = join(cfg.dataDir, 'cache');

  exec.registerHostTool('calendar.day', async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const rawDate = a['date'];
    const date =
      typeof rawDate === 'string' && rawDate !== ''
        ? rawDate
        : new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { ok: false as const, code: 'BAD_ARG', message: 'date 要 YYYY-MM-DD', retryable: false };
    }
    const r = await fetchDay(date, { cacheDir: holidayCacheDir });
    if (!r.ok || r.day === undefined) {
      return {
        ok: false as const,
        code: 'HOLIDAY_SOURCE_DOWN',
        message: '节假日数据源暂时不可用（已试多个源）',
        retryable: true,
      };
    }
    const d = r.day;
    return {
      ok: true as const,
      value: {
        date: d.date,
        weekday: weekdayOf(d.date),
        rest: d.rest,
        answer: d.rest ? '不用上班' : '要上班',
        legalHoliday: d.legal,
        weekend: d.weekend,
        makeupWorkday: d.makeup,
        holidayName: d.holiday,
      },
    };
  });

  exec.registerHostTool('calendar.rest', async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const opt: { withinDays?: number; lookBackDays?: number; lat?: number; lon?: number; cacheDir?: string } = {
      cacheDir: holidayCacheDir,
    };
    if (typeof a['withinDays'] === 'number') opt.withinDays = a['withinDays'];
    if (typeof a['lookBackDays'] === 'number') opt.lookBackDays = a['lookBackDays'];
    if (typeof a['lat'] === 'number' && typeof a['lon'] === 'number') {
      opt.lat = a['lat'];
      opt.lon = a['lon'];
    }
    const r = await restPlan(opt);
    if (!r.ok) {
      return {
        ok: false as const,
        code: 'HOLIDAY_SOURCE_DOWN',
        message: '节假日数据源暂时不可用（已试多个源）',
        retryable: true,
      };
    }
    return {
      ok: true as const,
      value: {
        windows: r.windows,
        makeupDays: r.makeupDays,
        holidayRuns: r.holidayRuns,
        weather: r.weather,
        assumedBeijing: r.assumedLocation === true,
        note:
          r.assumedLocation === true
            ? '天气按北京坐标取的；主人没说地点时要在回复里说明这是假设。'
            : undefined,
      },
    };
  });

  log('[calendar] 节假日工具已注册（2 个：day/rest，多源+本地缓存，不弹审批）');

  log(`[calendar] 日历工具已注册（5 个：读 2 + 写 3，写只动本地日历），日历目录：${calendarDir}`);

  // === 连接器第一批（2026-10-21，task-2 接线）：github x3 + rss.read ===
  // 连接器实现永不抛、失败返回 {ok:false, error:"前缀: 详情"}；这里只做
  // 形状适配（宿主工具约定 {ok,value} / {ok:false,code,message}）与 limit->per_page。
  const connectorWrap = (r: { ok: boolean; error?: string }) =>
    r.ok
      ? { ok: true as const, value: r }
      : {
          ok: false as const,
          code: String(r.error ?? 'connector_error').split(/[：:]/, 1)[0] || 'connector_error',
          message: r.error ?? '连接器失败',
          retryable: false,
        };
  exec.registerHostTool('github.notifications', async () => connectorWrap(await githubNotifications()));
  const pageOf = (a: Record<string, unknown>) =>
    typeof a['page'] === 'number' ? Math.max(1, Math.floor(a['page'])) : 1;
  const limitOf = (a: Record<string, unknown>) =>
    typeof a['limit'] === 'number' ? Math.max(1, Math.min(50, Math.floor(a['limit']))) : 20;
  exec.registerHostTool('github.issues', async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    return connectorWrap(
      await githubIssues(
        typeof a['owner'] === 'string' ? a['owner'] : '',
        typeof a['repo'] === 'string' ? a['repo'] : '',
        { page: pageOf(a), perPage: limitOf(a) },
      ),
    );
  });
  exec.registerHostTool('github.pulls', async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    return connectorWrap(
      await githubPulls(
        typeof a['owner'] === 'string' ? a['owner'] : '',
        typeof a['repo'] === 'string' ? a['repo'] : '',
        { page: pageOf(a), perPage: limitOf(a) },
      ),
    );
  });
  exec.registerHostTool('rss.read', async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    return connectorWrap(await fetchFeed(typeof a['url'] === 'string' ? a['url'] : ''));
  });

  // A2（2026-10-21）：vault.sites —— 模型只能看到「有哪些条目」（site/user），
  // 永远看不到值；值只经 runTool 的 $vault: 替换进执行路径。
  exec.registerHostTool('vault.sites', async () => {
    return { ok: true as const, value: { entries: vaultList(vaultDir()) } };
  });

  // W2（2026-10-21）：web.* —— 宿主侧浏览器（agent-browser CLI）。
  //
  // 为什么在宿主而不在容器：容器 rootfs 只读，Chrome 200MB+ 进不了镜像；
  // 而且 agent-browser 的价值是 snapshot 返回带 @eN 引用的可交互元素，
  // 模型据此操作，不用猜 CSS 选择器。浏览器够不到宿主文件系统，只是访问
  // 网络，宿主侧跑不扩大真实风险。
  //
  // 三个工具都**不用审批**：snapshot/read 是只读；act 虽然改外部状态，但它是
  // 网页操作的唯一出口，每步都批等于网页能力不可用（主人 2026-10-21 明确：
  // "浏览器控制不需要审批，重大决定才需要我审批"）。危险动作（花钱、提交订单）
  // 由 tools.yml 的 spend 档单独把关。
  /** search.* 的包装：与 hostWrap 同形，只是错误码分开，便于模型区分"搜索坏了"与"页面打不开"。 */
  const searchWrap = (r: { ok: boolean; output?: string; error?: string }) =>
    r.ok
      ? { ok: true as const, value: { output: r.output ?? '' } }
      : {
          ok: false as const,
          code: 'search_tool_error',
          message: r.error ?? '搜索工具失败',
          retryable: true,
        };

  const hostWrap = (r: { ok: boolean; output?: string; error?: string }) =>
    r.ok
      ? { ok: true as const, value: { output: r.output ?? '' } }
      : {
          ok: false as const,
          code: 'web_tool_error',
          message: r.error ?? '浏览器工具失败',
          retryable: true,
        };

  exec.registerHostTool('web.snapshot', async (args) =>
    hostWrap(await webSnapshot((args ?? {}) as Record<string, unknown>)),
  );
  exec.registerHostTool('web.read', async (args) =>
    hostWrap(await webRead((args ?? {}) as Record<string, unknown>)),
  );
  exec.registerHostTool('web.act', async (args) =>
    hostWrap(await webAct((args ?? {}) as Record<string, unknown>)),
  );
  log('[web] 浏览器工具已注册（3 个：snapshot/read/act，走 agent-browser CLI）');

  // 2026-10-22：宿主侧搜索（argo CLI）。
  //
  // 为什么加：实测本机直连只到 baidu/bing/zhihu/github，jd/taobao/tmall/amazon
  // 直连与代理都不通（docs/net-reachability-20261022.md）。模型查"某物多少钱"
  // 时 net.get / web.read 全废，不是工具坏了而是通路本身不存在。
  // argo 走自己的 272 个源，不受本机出口限制。
  //
  // 都不审批：只读网络，参数只影响 query/url，可执行文件与子命令名写死。
  exec.registerHostTool('search.web', async (args) =>
    searchWrap(await searchWeb((args ?? {}) as Record<string, unknown>)),
  );
  exec.registerHostTool('search.fetch', async (args) =>
    searchWrap(await searchFetch((args ?? {}) as Record<string, unknown>)),
  );
  log('[search] 搜索工具已注册（2 个：web/fetch，走 argo CLI）');

  // 2026-10-21：browser.* 统一到 agent-browser。
  //
  // ExecService.runTool 先查 hostTools 再发容器，所以在这里注册同名工具就是
  // **覆盖**掉容器里那套 playwright 实现——既统一成一条路径，又不用删容器代码
  // （想回滚只需删掉这几行）。参数形状完全不动：老的 browser.act 传
  // {action, selector, value} 照样能用，selector 里写 @e1 也行、写 CSS 也行。
  //
  // identity 语义照抄 resolveBrowserIdentity：显式优先 / anon 无痕 / 缺省按域名
  // 派生 site:<host> 做持久登录态。落地成 agent-browser 的 --session（实测跨进程
  // 保留 cookie，等价于容器版 launchPersistentContext + /dot/profiles 卷）。
  for (const name of [
    'browser.open',
    'browser.snapshot',
    'browser.act',
    'browser.screenshot',
    'browser.close',
  ] as const) {
    exec.registerHostTool(name, async (args, taskId) =>
      hostWrap(await legacyBrowser(name, (args ?? {}) as Record<string, unknown>, taskId)),
    );
  }
  log('[web] browser.* 已由宿主 agent-browser 承接（容器内实现已于 2026-10-21 删除）');

  // A2-C 收尾（2026-10-21）：GitHub token 从保险库注入（site='github.com', user='token'）。
  // 没配就维持 public-only 降级模式，不报错不挡启动。
  try {
    if (process.env.DOTD_GITHUB_TOKEN === undefined && process.env.DOTD_MAIL_KEY !== undefined) {
      const gh = vaultGet(vaultDir(), process.env.DOTD_MAIL_KEY, 'github.com', 'token');
      if (gh !== null && gh.length > 0) {
        process.env.DOTD_GITHUB_TOKEN = gh;
        log('[vault] GitHub token 已从保险库注入（连接器完整模式）');
      }
    }
  } catch {
    // 保险库不可用不挡启动
  }

  const bootReport = await exec.boot(cfg.dotIds);
  for (const w of bootReport.warnings) log(`[exec] boot 告警：${w}`);
  // failed/orphans 必须见光：阶段一只打 warnings+degraded，占名 409 曾静默瘫痪整个 fleet。
  for (const f of bootReport.failed) log(`[exec] boot 失败 dot=${f.dotId}：${f.reason}`);
  for (const o of bootReport.orphans) log(`[exec] boot 未托管容器（保留不擅杀）：${o.slice(0, 12)}`);
  if (bootReport.created.length > 0) log(`[exec] boot 新建容器：${bootReport.created.join(', ')}`);
  if (bootReport.adopted.length > 0) log(`[exec] boot 接管容器：${bootReport.adopted.join(', ')}`);
  if (!bootReport.dockerAvailable) {
    log('[exec] docker 不可用 —— degraded 启动（真实 fleet 下容器动作将被拒）');
  }

  // ⑥b 把 EX/GOV 补注进 CP 的惰性 holder（建 CP 时它们还不存在；CP 内部只在
  //     运行期经 execPortsOf / governance.requestApproval 读它们）
  execHolder.svc = exec;
  govHolder.forcer = govForcerOf();
  // 回填：SSE approval 通道快照（GOV listPending，与 GET /api/approvals 同源）
  govHolderForSse.listPending = () => govListPending(200) as ApprovalView[];
  const approvalsReader: ApprovalsReader = {
    listForTask: (taskId) => {
      const rows = db
        .prepare(
          `SELECT id, status FROM approvals WHERE task_id = ? AND status IN ('pending','approved','executing')`,
        )
        .all(taskId) as Array<{ id: number; status: string }>;
      return rows;
    },
  };

  // ⑦ MEM（bridge = exec.fsOps 包一层，契约 S4'/M4；journal 探针供 §4.3 wroteMemory 判据）。
  // 路径口径与失败降级都在 makeExecFsOpsBridge 里收口，见该函数注释。
  const memory = createMemoryService({
    db,
    outboxPath,
    taskStatusProbe: (taskId) => cp.getTask(taskId)?.status ?? null,
    // §4.3 `anyMemoryFileTouchedSince`：探针必须交出**真实路径**。
    // 老实现返回 `fs.write:<callId>`（没有路径），而 MEM 侧按路径前缀判定
    // （isMemoryWritePathLoose：/dot/home/{MEMORY.md,notes/,manuals/}），于是**永远判不出"写过"**
    // → WRITE-SEAL 每次都认为没写记忆（P1-4 的第二个根因，与"终态之后才提醒"叠加）。
    // 现在从 steps.args_json 取 path；同时把 fs.write 与 shell.run（写 home 的常用手段）都算上。
    journalMemoryProbe: (taskId, sinceMs) =>
      cp
        .getJournal(taskId)
        .filter((s) => s.startedAt >= sinceMs && s.status === 'succeeded')
        .flatMap((s) => memoryWritePathsOfStep(s)),
    // §4.4 会话摘要（P1-2）：MEM 只负责"够阈值就压增量"，**生成走注入的低智能轨**——
    // 这里接 router.complete({track:'light'})，MEM 绝不自己发 HTTP（密钥只在 MR 手里）。
    // 摘要失败由 MEM 侧软降级（不写、不抛），这里不需要再兜。
    summarize: async (_threadId, transcript, { maxTokens }) => {
      const r = await router.complete({
        track: 'light',
        messages: [
          {
            role: 'system',
            content:
              // 2026-10-22：补三条硬约束，针对实测发现的"摘要写自己"退化。
              //
              // 现场：一段 501 字的摘要，正文是「你这次发来的还是摘要 + 上一轮对话，
              // 没有新的指令……请给路径」。摘要把**自己的输入形态**写成了内容，
              // 于是"上下文"变成了"抱怨没有上下文"。
              // 这类输出有个共同点：都在描述压缩这件事本身，而不是对话里发生过什么。
              '你是会话压缩器。把下面的对话压成一段可长期沿用的摘要：保留事实、结论、' +
              '未完成事项与关键约束；不要复述原话，不要编造，不要加标题或前言。只输出摘要正文。\n' +
              '【硬约束】\n' +
              '1. 只写对话里**确实发生过**的事实、决定、结论、未完成事项。\n' +
              '2. **绝不描述你自己的处境**：不要写"你发来的是摘要""没有新指令""请提供路径/文件/"' +
              '内容"这类话。这些是压缩器的内部状态，不是对话内容。\n' +
              '3. 若新增对话里没有值得记住的东西，就**只保留背景里的既有事实**，' +
              '不要为了凑字数而评论对话质量。',
          },
          { role: 'user', content: transcript },
        ],
        attemptId: `sum:${Date.now()}`,
        maxTokens,
      });
      const resp = r.response as { content?: string };
      return typeof resp.content === 'string' ? resp.content : '';
    },
    bridge: makeExecFsOpsBridge(exec),
    // §4.2 骨架补建落盘：经工具层 fs.write（FsOpsBridge 只读，无 write 原语）。
    // task_id 用 dotId 派生——这不是任务调用，是装配期一次性补建；exec_calls
    // 只按 call_id 幂等，不与真实任务流水冲突。
    homeWriter: async (dotId, path, content) => {
      const callId = `memseed_${dotId}_${path.replace(/[^a-zA-Z0-9]+/g, '_')}`;
      const res = await exec.runTool({
        call_id: callId,
        task_id: `memseed_${dotId}`,
        dot_id: dotId,
        tool: 'fs.write',
        args: { path: toHomeAbs(path), content },
        deadline_ms: 30_000,
        issued_at: new Date().toISOString(),
      });
      return res.status === 'ok';
    },
    onCorruption: (error) => {
      appendOutbox(cfg.dataDir, `记忆库完整性检查失败：${error.message}`);
    },
  });
  memHolder.svc = memory;

  // 2026-10-22：memory.search —— 把 MEM 早就有的 searchMessages 暴露给模型。
  //
  // 为什么放在这个位置：它要闭包引用 `memory`，所以必须在 createMemoryService
  // 之后注册（前面的搜索/浏览器工具在 1535 行一带，那里 `memory` 还不存在）。
  // ExecService.runTool 先查 hostTools 再发容器，所以注册名即生效。
  //
  // 为什么要这个工具：MEM 的 searchMessages（FTS5 + 中文 bigram + bm25）实现了很久，
  // 但**没有任何工具入口**。模型手上的检索能力只有 fs.grep（只能搜 /dot/home 的文件），
  // 而 11423 条历史对话全在 mem_messages 里 —— 够不着。于是被问"我们之前定过什么"
  // 时只能答"我没有上下文"。能力在、入口不在，等于没有。
  //
  // 不审批：只读本地库，参数只影响 query/limit/sinceDays，无副作用。
  exec.registerHostTool('memory.search', async (args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    const query = typeof a['query'] === 'string' ? a['query'].trim() : '';
    if (query.length === 0) {
      return { ok: false, code: 'bad_args', message: 'query 不能为空' };
    }
    const rawLimit = typeof a['limit'] === 'number' ? a['limit'] : 8;
    const limit = Math.max(1, Math.min(50, Math.floor(rawLimit)));
    const sinceDays =
      typeof a['sinceDays'] === 'number' && a['sinceDays'] > 0
        ? Math.floor(a['sinceDays'])
        : undefined;
    try {
      // 不传 dotId = 搜全部会话。本机只有一个主人一个 dot，
      // 而"想不起过去"恰恰最可能发生在这个 dot 的其它会话里 —— 按 dot 过滤
      // 只会让模型搜得更少，不解决问题。
      const hits = await memory.searchMessages(query, {
        limit,
        ...(sinceDays !== undefined ? { sinceDays } : {}),
      });
      // 只回模型需要的：谁说的、什么时候、说了什么。不带 id / token / 内部字段。
      return {
        ok: true,
        value: {
          query,
          sinceDays: sinceDays ?? null,
          count: hits.length,
          hits: hits.map((h) => ({
            at: h.message.createdAt,
            role: h.message.role,
            kind: h.message.kind,
            text: h.snippet.length > 0 ? h.snippet : h.message.content.slice(0, 400),
          })),
          // 明确告诉模型"没搜到"时该怎么办，省一轮瞎试
          ...(hits.length === 0
            ? { hint: '没搜到。换关键词（中文按词搜，别整句）、放宽 sinceDays，或先用 fs.grep 搜 MEMORY.md/notes。' }
            : {}),
        },
      };
    } catch (cause) {
      return { ok: false, code: 'search_failed', message: String(cause), retryable: false };
    }
  });
  log('[memory] memory.search 已注册（搜对话历史，FTS5 + 中文 bigram）');

  // ⑧ SF：HTTP（listen 在此；契约 H2 唯一监听）。surfCfg/channels/feishuGw 已在
  // ④ 前置段装配（MR 要注入 channels），这里只起服务。
  // ⑧a 只读洞察（D1/D3，2026-10-22）：简报与连接总览的取数。
  //
  // 两个闭包放在这里而不是 http.ts 里：它们要的四样事实（库、日历目录、连接器目录、
  // 模型端点）只有装配层同时握在手上。HTTP 层只做序列化，CLI 只是瘦客户端，
  // 于是「手机看到的」与「命令行看到的」永远是同一份数据。
  //
  // 模型端点与 MCP 都**只取展示字段**（tier / base_url / 模型名 / server 名 + 工具数），
  // 不含 api_key 与任何 env 值 —— 总览是拿来判断"哪条线断了"的，不是凭证清单。
  const insightDeps: InsightDeps = {
    db,
    calendarDir,
    dotId: 'dot1',
    connectors: connectorCatalog(process.env),
    mcpServers: (() => {
      try {
        return loadMcpServers(process.env.DOTD_MCP_CONFIG ?? join(cfg.configDir, 'mcp-servers.yml')).map(
          (s) => ({ name: s.name, toolCount: s.allowTools?.length ?? 0 }),
        );
      } catch {
        // MCP 配置写坏时 daemon 早在装配 exec 时就该拒启动；走到这里说明只是没配。
        return [];
      }
    })(),
    models: (() => {
      try {
        return loadModelsConfig(join(cfg.configDir, 'models.yml')).endpoints.map((e) => ({
          tier: String(e.tier),
          endpoint: e.baseUrl,
          model: e.models.primary ?? e.models.light ?? '',
          enabled: e.enabled,
        }));
      } catch {
        return [];
      }
    })(),
  };
  // enabled 只给 CLI/前端说人话（「已启用」还是「想每天自动收到」），
  // 不参与简报内容，也不影响 daemon 内部任何判断。
  const briefOf = (nowMs: number = Date.now()) => ({
    ...buildBrief(insightDeps, nowMs, surfCfg.brief.maxChars),
    enabled: surfCfg.brief.enabled,
  });
  const connectionsOf = () =>
    buildConnectionsView(insightDeps, {
      feishuAppId: surfCfg.feishu.appId,
      ownerChatCount: ownerChats.length,
      httpHost: surfCfg.http.host,
      httpPort: surfCfg.http.port,
    });

  const server = await startHttpServer({
    db,
    bus,
    cp: cp as unknown as ControlPlane,
    gov: govPortOf(),
    mem: memPortOf(memory),
    router: router as unknown as RouterPort,
    channels,
    sse: sseBus,
    // A2 保险库（2026-10-21）：文件只由 daemon 进程写（D2 单写者）；
    // secret 走本机回环 + master token，vault.json 静止即 AES-256-GCM 密文。
    vault: {
      list: () => vaultList(vaultDir()),
      put: (site, user, secret) => {
        const key = process.env.DOTD_MAIL_KEY;
        if (key === undefined || key.length === 0) {
          throw new Error('vault_unconfigured：daemon 缺 DOTD_MAIL_KEY');
        }
        vaultPut(vaultDir(), key, site, user, secret);
      },
      remove: (site, user) => vaultDelete(vaultDir(), site, user),
    },
    cfg: surfCfg,

    // 仪表盘（D2，2026-10-22）：`/d/<slug>` 读容器 home 里的 `dashboards/<slug>.html`。
    // 刻意用箭头包一层而不是直接传引用：readHomeFileForShot 在本文件后面才定义
    // （const 有 TDZ），这里只需要「调用时已存在」。
    // 为什么不直接挂宿主目录：dashboards 是 agent 用 fs.write 写的容器内文件，
    // 宿主没有它的路径；容器 home 的唯一读入口就是 exec 的 fs.read。
    readHomeFile: (dotId: string, path: string) => readHomeFileForShot(dotId, path),
    dotId: 'dot1',
    // D1/D3：同一份取数闭包同时供 HTTP（`dotd brief` / `dotd connections`）与飞书推送。
    brief: briefOf,
    connections: connectionsOf,
    webRoot: cfg.webRoot,
    // §5.7 求救自检要真值：顺序/兜底文件直接从 router 的 alerts 配置取，
    // 不让 /api/channels 与 `dotd sos-test` 拿编译期默认值猜（2026-10-17）。
    // 记忆备份入口（2026-10-18）：列表走 bridge.list（.archive/ 是 home 下的目录），
    // 恢复走 exec 的 fs.write 工具（bridge 只读、无 write 原语）。
    listMemoryArchive: () => listMemoryArchiveViaExec(execApiOf(exec)),
    restoreMemoryArchive: (archive: string) => restoreMemoryArchiveViaExec(execApiOf(exec), archive),
    alertsRoute: () => router.alertsRoute(),
  });
  log(`HTTP 监听 ${surfCfg.http.host}:${surfCfg.http.port}（契约 H2 默认 127.0.0.1:7788）`);

  // ⑧b 飞书长连接入站（主人 2026-10-16 拍板：无公网回调，事件订阅走出站 WS）。
  // App 凭据齐了就拨出去；owner_chat_id 为空时连接照建、消息全 403（fail-closed）。
  const stopFeishuWs =
    surfCfg.feishu.appId.length > 0 && surfCfg.feishu.appSecret.length > 0
      ? startFeishuWs({
          cp: cp as unknown as ControlPlane,
          mem: memPortOf(memory),
          db,
          bus,
          cfg: surfCfg.feishu,
          log,
          // 图片下载器（2026-10-18 多模态）：飞书图片只有 image_key，本体要另取。
          // 落盘位置是**容器内**的 /dot/home（宿主不直接持有 home 卷），
          // 所以下载走容器的 fs.write 工具更合适——见下方 media 实现。
          media: makeFeishuMedia(() => exec, { appId: surfCfg.feishu.appId, appSecret: surfCfg.feishu.appSecret }),
          // ── 2026-10-21：审批卡片的**回调决策**（主人报「点同意没反应」）──
          //
          // 现场：卡片发得出去（surf_outbound_log 记 approval_card），主人点了也
          // 确实到服务端（日志 `飞书长连接收到事件 card.action.trigger` 出现 7 次），
          // 但 `handleFeishuCallback` 里 `deps.approval === undefined` → 直接
          // `{ignored:true, reason:'approval_not_wired'}`，静默丢弃。
          // 于是审批永远停在 pending，任务卡在 awaiting_approval。
          //
          // 这里把 GOV 的 decide() 接上（契约 S-2：唯一裁决写路径在 GOV）。
          // 卡片按钮给的是 'approve'/'reject'，GOV §3.3.1 要
          // 'approve_once'/'approve_remember'/'reject' —— 卡片只有一次性和拒绝两个
          // 按钮，所以 'approve' 一律映射成 'approve_once'（不擅自"记住"，
          // 记住是主人的决定，不该由一次点击替他做）。
          approval: {
            decide: async (approvalId, verdict, operatorId) => {
              const v = verdict === 'approve' ? 'approve_once' : 'reject';
              const r = await govDecide(approvalId, 'web', v, operatorId);
              return r.ok
                ? { ok: true, ...(r.finalStatus !== undefined ? { status: r.finalStatus } : {}) }
                : { ok: false, ...(r.reason !== undefined ? { reason: r.reason } : {}) };
            },
            resolveCard: async (cardMessageId, approvalId) => {
              // 改卡片：把按钮换成结论，避免主人重复点。失败不影响裁决。
              // B1（F5）：广播之后一个 approvalId 在 N 个会话里有 N 张卡片。
              // **必须遍历全部** —— 只改被点的那一张 = 另一端挂着可点按钮的旧卡片，
              // 主人换个会话又点一次；裁决先到先得不会重复执行，但审计里会堆
              // 「迟到裁决」噪音，而且主人会怀疑「我到底批了没有」。
              // 并入 cardMessageId：registry 是内存态，daemon 重启后为空，
              // 这时入站带来的那一张仍要改。
              const mids = Array.from(
                new Set([
                  ...(cardMessageId.length > 0 ? [cardMessageId] : []),
                  ...cardRegistry.getMany(approvalId),
                ]),
              );
              if (mids.length === 0) return;
              await resolveApprovalCards(
                {
                  sender: feishuGw,
                  chatIds: ownerChats,
                  log,
                  // 同步查最新状态：resolveApprovalCards 的 getApprovalView 是同步签名，
                  // 而 govGetApproval 返回 Promise。这里只要 status/verdict 用于改卡片文案。
                  getApprovalView: (id) => {
                    const row = db
                      .prepare('SELECT id, seq, status FROM approvals WHERE id = ?')
                      .get(id) as { id: number; seq: number; status: string } | undefined;
                    if (row === undefined) return null;
                    return { id: row.id, seq: row.seq, status: row.status } as unknown as ApprovalView;
                  },
                },
                mids,
                approvalId,
                '飞书',
              );
            },
          },
        })
      : null;

  // 截图取回 / 发图：两个消费方（随单推送 A3、进度推送 9.1）共用同一份实现。
  // 分开写会漂 —— 比如一边加了 8MB 上限、另一边忘了，症状是"有时能发有时不能"。
  const readHomeFileForShot = async (dotId: string, path: string): Promise<Buffer | null> => {
    const call: ExecToolCall = {
      call_id: `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      task_id: 'screenshot-push',
      dot_id: dotId,
      tool: 'fs.read',
      args: { path, encoding: 'base64' },
      deadline_ms: 30_000,
      issued_at: new Date().toISOString(),
    };
    const r = await exec.runTool(call);
    if (r.status !== 'ok') return null;
    const b64 = (r.result as { content_base64?: string } | undefined)?.content_base64;
    return typeof b64 === 'string' && b64.length > 0 ? Buffer.from(b64, 'base64') : null;
  };
  const sendImageToChat = (chatId: string, png: Buffer) => feishuGw.sendImage(chatId, png);

  // ⑧c 飞书出站回路：feishu 来源任务终态（done/failed）→ 回复发回原会话。
  // 订阅方永远排在发布方前（handler 同步入 emitter 数组，runner 的 cp.finish
  // 触发 publish 时本订阅已就位）；发送失败只落日志，不影响任务落库。
  const stopFeishuOutbound =
    surfCfg.feishu.appId.length > 0 && surfCfg.feishu.appSecret.length > 0
      ? startFeishuOutbound({
          db,
          bus,
          gateway: feishuGw,
          log,
          // 2026-10-21：Web 发起的任务不再镜像到飞书（实测 32/50 任务来自 Web，
          // 44 条回复全推了飞书 —— 人在 Web 看结果，手机又收一遍）。
          mirrorWebToFeishu: surfCfg.feishu.mirrorWebToFeishu ?? false,
          // T3：能发卡片就发卡片，发不出去才退回纯文本（避免重复推送）
          ...(approvalCardSender !== undefined ? { approvalCards: approvalCardSender } : {}),
          // 系统级通知（如 dot 被隔离）：没有来源会话，兜底给主人 = **全部会话**（B1/F5）。
          // 只投第一个时，第二个会话的主人看到的只有「任务莫名其妙挂了」。
          fallbackChatIds: ownerChats,
          // A3：截图随单推送 —— 文本回复发出成功后触发（见 screenshot-push.ts）。
          // 读图走容器 fs.read(base64)；发图走 FeishuGateway.sendImage。
          // 9.1（2026-10-21）：这两个能力现在也供进度推送复用（见 readHomeFileForShot 注释）。
          screenshotPush: {
            db,
            log,
            readHomeFile: readHomeFileForShot,
            sendImage: sendImageToChat,
          },
        })
      : null;

// ⑧c 每日简报（D1 的发送侧，2026-10-22）
//
// 三个关键决定：
//   ① 判据「今天发过没有」查的是 `surf_outbound_log` 里 kind='brief' 的成功记录，
//      不是内存变量 —— daemon 重启不该让主人收第二份。
//   ② 迟到 `window_min`（默认 180 分钟）之外放弃：中午重启补发的「早间简报」
//      里日程已经过时，是噪音。
//   ③ 文案与 `dotd brief`、`/api/brief` 共用同一个闭包（briefOf），
//      不会出现「手机看到的和命令行看到的不是一份」。
const briefPush = startDailyBriefPush({
  cfg: surfCfg.brief,
  now: () => Date.now(),
  lastSentDay: () => {
    try {
      const row = db
        .prepare("SELECT at FROM surf_outbound_log WHERE kind = 'brief' AND ok = 1 ORDER BY id DESC LIMIT 1")
        .get() as { at?: string } | undefined;
      if (row?.at === undefined) return null;
      const t = Date.parse(row.at);
      return Number.isFinite(t) ? briefDayKey(t) : null;
    } catch {
      return null;
    }
  },
  record: (r) =>
    recordOutbound(db, {
      kind: 'brief',
      dedupKey: `brief:${briefDayKey(Date.parse(r.at))}:${r.chatId}`,
      chatId: r.chatId,
      ok: r.ok,
      error: r.error,
      textPreview: r.text.slice(0, 200),
      at: r.at,
    }),
  buildText: (nowMs) => briefOf(nowMs).text,
  targets: () => (surfCfg.brief.chatId !== null ? [surfCfg.brief.chatId] : ownerChats),
  sendText: (chatId, text) => feishuGw.sendText(chatId, text),
  log,
});
log(
  surfCfg.brief.enabled
    ? `[brief] 每日简报已启用：每天 ${surfCfg.brief.time}（迟到 ${surfCfg.brief.windowMin} 分钟后放弃）`
    : '[brief] 每日简报未启用（surfaces.brief.enabled=false）',
);

// ⑧cc 连接看门狗（U3「持续在线」那一半，2026-10-22）
//
// 简报是「到点说一次」，看门狗是「有变化才说」。两者的取数闭包是同一个
// （connectionsOf），所以主人收到的消息与 `dotd connections` 看到的不会互相矛盾。
//
// 状态落 surf_kv（迁移 190）：重启后不该把已经说过的话再说一遍。
const connWatch = startConnectionWatch({
  cfg: surfCfg.connWatch,
  now: () => Date.now(),
  rows: () => connectionsOf(),
  loadState: () => {
    try {
      const row = db
        .prepare('SELECT value FROM surf_kv WHERE key = ?')
        .get('connwatch:dot1') as { value?: string } | undefined;
      if (row?.value === undefined) return {};
      const parsed: unknown = JSON.parse(row.value);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  },
  saveState: (state) => {
    try {
      db.prepare('INSERT INTO surf_kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
        .run('connwatch:dot1', JSON.stringify(state), Date.now());
    } catch (cause) {
      log(`[connwatch] 状态落库失败（下轮会重复报一次）：${String(cause)}`);
    }
  },
  targets: () => ownerChats,
  sendText: (chatId, text) => feishuGw.sendText(chatId, text),
  record: (r) =>
    recordOutbound(db, {
      kind: 'connwatch',
      dedupKey: `connwatch:${r.at}:${r.chatId}`,
      chatId: r.chatId,
      ok: r.ok,
      error: r.error,
      textPreview: r.text.slice(0, 200),
      at: r.at,
    }),
  log,
});
log(
  surfCfg.connWatch.enabled
    ? `[connwatch] 连接看门狗已启用：每 ${surfCfg.connWatch.intervalMin} 分钟检查一次` +
      (surfCfg.connWatch.quietHours !== null
        ? `（安静时段 ${surfCfg.connWatch.quietHours.start}-${surfCfg.connWatch.quietHours.end} 只记不推）`
        : '')
    : '[connwatch] 连接看门狗未启用（surfaces.conn_watch.enabled=false）',
);

  // ⑧d 过程可视化（T5，2026-10-20）
  //
  // 一个跑 10 分钟的任务，主人在飞书那边原本**什么都看不到** ——
  // 问"在干嘛"没反应，只能等。而等待和"卡死了"在他眼里是一样的。
  //
  // 默认关（surfaces.progress.enabled = false）。打开是显式动作，
  // 因为"多久说一次"很主观，只有主人自己知道能忍多少条。
  const stopProgress = startProgressPush({
    db,
    bus: { on: (t, h) => bus.on(t, h) },
    ...(feishuGw !== NULL_FEISHU_GATEWAY && ownerChatForApproval !== ''
      ? {
          sender: { send: (chat: string, text: string) => feishuGw.sendText(chat, text) },
          chatId: ownerChatForApproval,
          // 9.1（2026-10-21）：进度也能带真截图了。
          // 条件是"读得到字节 + 发得出图"，两个能力都要有；缺一个就退化为纯文字
          // （旧行为），而不是发一条没有图的空消息。
          image: { readHomeFile: readHomeFileForShot, sendImage: sendImageToChat },
        }
      : {}),
    cfg: surfCfg.progress,
    log,
  });

  // ⑧e 「在做」表情标识（2026-10-22）
  //
  // 主人原话：「不需要输出过程，给我答案就行，**或者给我一个助手在做的标识就行了**」。
  // 播报的问题不是措辞而是形态——它是消息，23 条就把答案冲没了。
  // 这里改成在**主人那条消息**上挂一个表情：零新增消息、零未读、会话列表干净。
  //
  // 与 ⑧d 相互独立：播报关着（默认）也能只开这个。
  const progressReaction =
    feishuGw !== NULL_FEISHU_GATEWAY
      ? startProgressReaction({
          db,
          bus: { on: (t, h) => bus.on(t, h) },
          port: {
            addReaction: (mid: string, emoji: string) => feishuGw.addReaction(mid, emoji),
            removeReaction: (mid: string, rid: string) => feishuGw.removeReaction(mid, rid),
          },
          log,
        })
      : null;

  // ⑨ Runner 常驻协程（CP §12：pop 循环；AbortSignal 让位）
  // `bus` = roadmap P0-2 的会话增量通道：Runner 每步把模型正文增量推到 `chat.delta`。
  // 总线**只认装配层这一个实例**（SSE 订阅的就是它），故这里是唯一的接线点；
  // 不注入时 Runner 逐字走 complete() 路径（零行为变化）。
  const runner = new DotRunner(
    {
      cp,
      router: routerApiOf(router),
      exec: execApiOf(exec),
      memory: memApiOf(memory),
      governance: govApiOf(),
    },
    {
      dotId: cfg.dotIds[0] ?? 'dot1',
      idlePollMs: cfg.idlePollMs,
      log,
      bus: { publish: (topic, payload, o) => bus.publish(topic, payload, o) },
      // P1-4 §4.3「补写一轮」：**生产语义由装配层显式声明**。
      // RunnerOptions.memoryRedo 缺省 false（= 与既有行为逐字相同，不悄悄给每个任务
      // 多加一轮模型调用）；这里显式打开，才让"任务 done 但没写记忆"时真的再问一轮。
      // 关掉它 = 回到老行为：sealTask 记 missed，但不会再提醒（也就不会补写）。
      memoryRedo: true,
      // P2-2 显式计划：**与 memoryRedo 相反——默认关闭**，由 `DOTD_PLAN=on` 显式开启。
      // 打开后每个任务多一次模型调用（写一份 3–7 条的计划），之后每轮把它作为一条
      // system 注记带上（抗跑偏 + 可在 `dotd task --verbose` 看到）。
      // 关着 = 请求体与改动前逐字一致（静态守卫见 tests/runner-plan.test.ts）。
      plan: process.env.DOTD_PLAN === 'on',
    },
  );

  // ⑩ 恢复（CP §7.1 步骤 3–6；在 Runner 起循环之前）
  const recovery = await cp.recover(approvalsReader);
  log(
    `启动恢复：在途回队 ${recovery.inFlightRecovered.length} / 孤儿步 ${recovery.openStepsResolved.length} / ` +
      `审批续跑 ${recovery.approvalsResumed.length} / 心跳补投 ${recovery.heartbeatsCaughtUp} / ` +
      `事件重放 ${recovery.eventsReplayed}`,
  );
  // 对账失败的任务不得静默（recovery.ts 已兜底归位为 queued，这里让它见光）
  for (const f of recovery.inFlightFailed) {
    log(`[recovery] 在途对账失败 task=${f.taskId}（已兜底回 queued）：${f.error}`);
  }
  // 副作用未知的孤儿步已降级为「等主人审批」——必须在启动时就喊出来，
  // 否则主人只会看到一条莫名卡住的任务（审批单本身经 approval:created → SSE 可见，
  // 也可 GET /api/approvals?state=pending 拉取）。
  if (recovery.inFlightDeferred.length > 0) {
    log(
      `[recovery] ${recovery.inFlightDeferred.length} 个孤儿步副作用未知，已转审批等确认：` +
        recovery.inFlightDeferred
          .map((d) => `${d.tool}(task=${d.taskId}#${d.seq} approval=${d.approvalId ?? '无单'})`)
          .join(', '),
    );
    appendOutbox(
      cfg.dataDir,
      `启动恢复：${recovery.inFlightDeferred.length} 个孤儿步副作用未知，已转审批（见 GET /api/approvals?state=pending）`,
    );
  }

  // ⑩b CP §7.1 步骤 7：scheduler.start（registerInternalJob 全部就位后起 tick）。
  //     recoverOnStartup 只做恢复动作、不起定时器（recovery.ts:170-203），起 tick
  //     是装配层的活。心跳 tick / queue.gc / 看门狗 / memory guard 都靠它。
  // **memory-retention 每日 job**（2026-10-19 实测发现：全仓库零调用方）。
  // 文档里写着"§6.1 保留策略（心跳 job memory-retention 每日）"，接口有、实现有、
  // 但**没有任何地方调它** —— 于是 90 天归档、库清理、以及会话摘要的存量补做
  // 全都永远不会发生。实测：423 个线程里只有 1 个有摘要，其余 5 个 >64 条的大线程
  // 因为"只在任务收口时触发"而永远补不上。
  //
  // 挂成 heavy job，每 10 分钟检查一次是否到点（isDailyDue 之内逻辑幂等，
  // 同 queue.gc 的写法）。首次启动时立刻跑一次，把存量的补上。
  let lastRetentionAt = 0;
  // **容器运行期探活**（2026-10-19 补）。
  // 原来 healthcheck 只在 boot 跑一次，运行期容器挂了数据库 state 还是 ready，
  // 任务派发过去直接 transport_error —— 状态失真 + 无重试 = 容器一抖任务就挂。
  // 实测：docker stop 后 state 仍显示 ready，任务失败两次后由模型自己放弃。
  cp.scheduler.registerInternalJob({
    name: 'exec.healthcheck',
    kind: 'light',
    everyMs: 60_000,
    run: async () => {
      try {
        await exec.periodicHealthCheck('dot1');
      } catch (err) {
        log(`[exec] 探活异常（忽略）：${String(err)}`);
      }
    },
  });

  cp.scheduler.registerInternalJob({
    name: 'memory-retention',
    kind: 'heavy',
    everyMs: 10 * 60_000,
    run: async () => {
      const nowMs = Date.now();
      // 每日一次；但首次（lastRetentionAt=0）立刻跑
      if (lastRetentionAt !== 0 && nowMs - lastRetentionAt < 24 * 3600_000) return;
      lastRetentionAt = nowMs;
      try {
        const report = await memory.runRetention(nowMs);
        log(
          `[memory] retention 完成：封存违规 ${report.sealViolations.length}、补 task_end ${report.orphanTaskEndsBackfilled.length}`,
        );
      } catch (err) {
        log(`[memory] retention 失败（不影响主循环）：${String(err)}`);
      }
    },
  });

  cp.scheduler.start();
  log('scheduler 已启动（heartbeat.tick / queue.gc / watchdog / guard / memory-retention / exec.healthcheck）');

  // **FTS 全量对账放在启动期**（2026-10-19 实测改）。
  // 原来这一步藏在 MemoryService.ftsProbe() 里，由 appendMessage 首次触发 ——
  // 也就是**主人发第一条消息时**才做全量重灌索引（5349 条 → appendMessage 耗时 15884 ms）。
  // 挪到这里：启动时一次性做完，用户请求不再承担这笔开销。
  // 失败不影响启动（检索会自动降级到 LIKE）。
  try {
    const n = memory.ensureMessageFts();
    if (n > 0) log(`[memory] FTS 索引已对账（重灌 ${n} 条）`);
  } catch (err) {
    log(`[memory] FTS 对账失败（检索将降级 LIKE）：${String(err)}`);
  }

  // ⑪ Runner 循环（常驻，数量 = 并发额度）
  //
  // **每个消费者一个循环**（2026-10-18 修）：原来只起 1 个 DotRunner.start()，
  // 于是 DOTD_MAX_RUNNING=2 时额度根本没被用上 —— 全量实测反复出现"并发度恒为 1"。
  // 配置项承诺了并发能力，实现却只起一个消费协程，是名不副实。
  // 默认额度 1 → 仍只起 1 个循环，行为与改动前逐字一致。
  const abort = new AbortController();
  const consumers = Math.max(1, cpConcurrencyFromEnv().maxRunningTasks ?? 1);
  const runnerLoops: Array<Promise<void>> = [];
  for (let i = 0; i < consumers; i += 1) {
    runnerLoops.push(
      (async () => {
        try {
          await runner.start(abort.signal);
        } catch (cause) {
          log(`Runner 循环#${i} 异常退出：${String(cause)}`);
          appendOutbox(cfg.dataDir, `Runner 循环异常：${String(cause)}`);
        }
      })(),
    );
  }
  if (consumers > 1) log(`Runner 消费者已启动 ${consumers} 个（DOTD_MAX_RUNNING=${consumers}）`);
  const runnerLoop = Promise.all(runnerLoops).then(() => undefined);

  // ⑫ 优雅退出（CP §2.1-4）
  let closing = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    log(`收到 ${reason}，开始优雅退出（宽限 ${cfg.shutdownGraceMs}ms）…`);
    // ⓪ 先断外来源：飞书长连接停止投递新事件（否则关停中还在建任务）
    stopFeishuWs?.();
    emergencyWatch.stop();
    // ① 停 pop 与心跳投递（scheduler.stop 内部停全部 registerInternalJob）
    cp.shutdown();
    // ② 向在跑 Runner 协程传 AbortSignal，等它在当前步边界落 journal 后退出
    abort.abort();
    const grace = new Promise<void>((done) => setTimeout(done, cfg.shutdownGraceMs));
    await Promise.race([runnerLoop.catch(() => {}), grace]);
    // ②b 出站订阅此刻才解订：在跑任务若正好在宽限内 finish，回复仍发得出去
    stopFeishuOutbound?.();
    // ②c 两个定时推送器跟着停：它们的 tick 会发消息，宽限期过后不该再触发
    briefPush.stop();
    connWatch.stop();
    // ③ 关 HTTP（SSE 长连接会拖住 close；补一次强关）
    await new Promise<void>((done) => {
      server.close(() => done());
      setTimeout(() => {
        server.closeAllConnections?.();
      }, 1_000).unref();
    });
    markGracefulShutdown(db);
    try {
      db.close();
    } catch {
      // 已关
    }
    appendOutbox(cfg.dataDir, `优雅退出（${reason}）`);
    log('优雅退出完成');
  };

  const onSignal = (sig: NodeJS.Signals): void => {
    void shutdown(sig).then(
      () => process.exit(0),
      (cause: unknown) => {
        process.stderr.write(`[dotd] 退出异常：${String(cause)}\n`);
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  // Windows 原生 node 下，跨进程 kill(SIGTERM/SIGINT/SIGBREAK)、cmd.exe 包装、进程组
  // kill 一律被 OS 直接终止，子进程 handler **不执行**（本机实测四类通道均 12–25ms 即死、
  // 无留痕；唯一能触发 handler 的是进程内 process.emit）。冒烟/CI 需要一条不依赖 OS 信号
  // 投递的自停通道：父进程经 IPC 发 { type: 'shutdown' }，本进程再自投递 SIGTERM，
  // 走与真信号**完全相同**的 shutdown() 路径（停投递 → AbortSignal → 落 journal →
  // markGracefulShutdown → OUTBOX 留痕 → exit 0）。Linux/WSL 下此通道同样可用，
  // 真 SIGTERM 路径不变。
  process.on('message', (msg: unknown) => {
    const t = typeof msg === 'object' && msg !== null && 'type' in msg ? String((msg as { type: unknown }).type) : '';
    if (t !== 'shutdown') return;
    log('收到 IPC shutdown 请求（Windows 跨进程信号不可达的等效通道）');
    process.emit('SIGTERM');
  });

  return { cfg, db, bus, sse: sseBus, cp, router, exec, memory, runner, server, recovery, shutdown };
}

// ── 入口 ────────────────────────────────────────────────────────────────────

/** 本文件被直接执行（node --import tsx src/daemon.ts）时为真。 */
function isMainModule(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  return resolve(argv1) === resolve(HERE, 'daemon.ts');
}

async function main(): Promise<void> {
  const daemon = await assembleDaemon();
  process.stdout.write('[dotd] daemon 就绪（Ctrl-C / SIGTERM 退出）\n');
  // 常驻：event loop 由 Runner 循环 + HTTP server + scheduler 定时器持有
  await new Promise<void>(() => {});
  void daemon;
}

if (isMainModule()) {
  void main().catch((cause: unknown) => {
    process.stderr.write(`[dotd] 启动失败：${String(cause)}\n`);
    appendOutbox(resolveDataDir(), `启动失败：${String(cause)}`);
    process.exit(1);
  });
}
