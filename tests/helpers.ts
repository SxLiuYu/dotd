/**
 * tests/helpers.ts —— 公共测试脚手架（八个模块共用）。
 *
 * 提供三件工厂：
 * 1. `makeTempDataDir()`：临时数据目录（DB、OUTBOX、journal-blobs 的根），
 *    自动返回清理函数。测试**绝不**碰真实的 ~/.dotd。
 * 2. `makeStubTransport()`：stub 模型 transport（DOTD_MODEL_TRANSPORT=stub），
 *    不发真实 HTTP，按脚本回放预置响应——MR/CP/Runner 测试靠它跑主循环。
 * 3. `makeStubFleet()`：stub fleet（DOTD_FLEET=stub），不起 Docker 容器，
 *    进程内假执行面——EX/CP/GOV 测试靠它拿 ToolResult。
 *
 * 依据（dotd/CONVENTIONS.md「stub 模式环境变量约定」）：
 * - DOTD_MODEL_TRANSPORT=stub：模型调用走内存 stub，不发网络请求
 * - DOTD_FLEET=stub：执行面 fleet 走内存 stub，不起容器
 * 两变量由 daemon.ts 装配层在启动时读取；测试直接调本文件的工厂，不经装配层。
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../db/conn.ts';
import { migrate } from '../db/migrate.ts';
import { openMigratedTemplateDb, acquirePooledDb, releasePooledDb } from '../db/template.ts';
import { EventBus } from '../src/shared/bus.ts';
import type {
  ExecToolCall,
  ExecToolResult,
  RouteRequest,
  RouteResult,
  Track,
} from '../src/shared/contracts.ts';

// ── 0. 审批总开关的测试口径 ────────────────────────────────────────

/**
 * 产品默认 `DOTD_APPROVALS=off`（2026-10-26 主人要求去掉审批）。
 * 但**测试必须显式选边**：绝大多数治理/Runner 用例断言的正是"要不要开单"
 * （suspended / pending / approve_once …）。这里的默认值给 `on`，
 * 让这些用例继续验它本来要验的东西；验 off 的用例在文件里自己设 off。
 *
 * 为什么放在 helpers 而不是每个文件：`node --test` 每个文件一个进程，
 * 而所有会走到 `evaluate()` 的测试文件都直接或间接 import 本文件
 * （governance-* 经 governance-support，runner-* 直接用）。
 * 一处默认，等价于"除显式声明外，测试跑旧口径"。
 */
if (process.env['DOTD_APPROVALS'] === undefined) {
  process.env['DOTD_APPROVALS'] = 'on';
}

// ── 1. 临时数据目录 ────────────────────────────────────────────────

/**
 * 按需建库文件（池模式下用）：池库是内存库，`dir.dbPath` 只在真有独立连接/子进程要用时
 * 才需要存在。建出来的文件与池库同结构（同一模板），且同样是迁移终态 user_version。
 */
function ensureOwnDbFile(dbPath: string): void {
  if (existsSync(dbPath)) return;
  const own = openMigratedTemplateDb(dbPath);
  own.close();
}

export interface TempDataDir {
  /** 临时根目录（已创建）。 */
  root: string;
  /** 库文件路径（尚未创建文件；openDb 会建）。 */
  dbPath: string;
  /** OUTBOX.md 路径（已创建空文件）。 */
  outboxPath: string;
  /** journal-blobs 目录路径（已创建）。 */
  blobDir: string;
  /** 打开并迁移好的唯一连接（迁移终态 user_version）。 */
  db: DatabaseSync;
  bus: EventBus;
  /** 清理：关库 + 删目录。测试 afterEach 调用；重复调用安全。 */
  cleanup(): void;
}

/**
 * 建一棵临时数据树并返回已迁移的库连接。
 *
 * 契约 D1 的库路径解析（db/conn.ts resolveDbPath）优先显式参数 > DOTD_DB_PATH，
 * 因此这里显式传 dbPath，不受宿主真实 ~/.dotd 影响。
 *
 * ⚡ 加速（2026-10-17，测试套件加速任务）：建库走 `db/template.ts` 的空库模板
 * （进程内首次仍完整跑一次真 `migrate()`，之后按"初始 CREATE TABLE + ALTER 回放"重建），
 * 实测单次建库（磁盘库）~110ms → ~60ms；`{pool:true}` 再省掉重复建表（~15ms → ~2ms）。
 *
 * 门禁口径不变：**列定义 / 索引 / `user_version` 与真迁移逐字等价**由
 * `tests/db-template.test.ts` 钉死（逐库比对 `sqlite_master` + `pragma_table_info`）。
 * 需要"真跑一遍迁移"的用例（迁移 runner 自身）请直接用 `migrate()`，不要用本工厂。
 *
 * @param opts.pool 从**空库池**借库（`db/template.ts` 的 acquire/release）：每用例仍拿到
 *   "空表 + 迁移终态 user_version"，但复用已建好的表结构。要求：该用例**不自带库文件路径假设**
 *   （默认全满足）；`dir.dbPath` 指向的子进程会用**独立的新库文件**（池库是内存库，
 *   无法给子进程用），仅 `{pool:true}` 时成立。
 */
export function makeTempDataDir(opts: { pool?: boolean } = {}): TempDataDir {
  const root = mkdtempSync(join(tmpdir(), 'dotd-test-'));
  const dbPath = join(root, 'dotd.db');
  const outboxPath = join(root, 'OUTBOX.md');
  const blobDir = join(root, 'journal-blobs');
  mkdirSync(blobDir, { recursive: true });
  writeFileSync(outboxPath, '', 'utf8');

  let db: DatabaseSync;
  if (opts.pool === true) {
    db = acquirePooledDb();
    // 子进程/独立连接要用的库文件：按需建一份（与池库表结构相同），仅当有人真的去开它。
    ensureOwnDbFile(dbPath);
  } else {
    db = openMigratedTemplateDb(dbPath); // 终态 schema（与旧 openDb+migrate 相同，版本号跟随迁移目录）
  }

  const bus = new EventBus();

  let cleaned = false;
  registerTempPath(root);
  return {
    root,
    dbPath,
    outboxPath,
    blobDir,
    db,
    bus,
    cleanup(): void {
      if (cleaned) return;
      cleaned = true;
      if (opts.pool === true) {
        releasePooledDb(db); // 清空数据后归池（不 close）
      } else {
        try {
          db.close();
        } catch {
          // 已关
        }
      }
      // 必须先关库再删目录：SQLite 的 db-wal/db-shm 句柄没释放时 rmSync 会 EBUSY/EPERM。
      removeTempPath(root);
    },
  };
}

// ── 1b. 临时路径登记表（防泄漏 + 自检）─────────────────────────────
//
// 背景（2026-10-17 实测）：TEMP 里积了 4600+ 个 `dotd-test-*` 目录。逐个排查后**不是**
// `cleanup()` 删不掉（实测：先 `db.close()` 再 `rmSync`，30/30 干净），而是**有些测试根本
// 没调 cleanup**——典型是 `tests/governance-support.ts:makeGovFixture()` 额外 mkdtemp 的
// `dotd-gov-cfg-*`（它从来没人删）。所以这里做两件事：
//   1. 所有经本文件的 temp 路径登记在案，`cleanup()` 时**自检目录确实消失**（删不掉重试并报警）；
//   2. 提供 `sweepTempPaths()`：测试文件用 `t.after(sweepTempPaths)` 兜底回收，
//      用例忘了 cleanup 也不会把目录丢在 TEMP 里。

/** 已登记、尚未删除的临时路径（进程内）。 */
const liveTempPaths = new Set<string>();

/** 删除失败时的重试次数（Windows 上杀毒/索引器偶发持有句柄）。 */
const RM_RETRIES = 5;

/** 登记一个临时路径（`cleanup()` 与 `sweepTempPaths()` 都会处理它）；**返回原路径**以便内联使用。 */
export function registerTempPath<T extends string>(p: T): T {
  liveTempPaths.add(p);
  armAutoSweep();
  return p;
}

// ── 自动兜底：不依赖每个测试文件手写 `test.after(sweepTempPaths)` ────────────
//
// 背景（2026-10-19 实测，真缺陷）：兜底靠**约定**——每个测试文件自己写一行
// `test.after(sweepTempPaths)`。实测 57 个文件用了 `makeTempDataDir`，
// **只有 16 个写了那一行**，剩下 41 个没有任何兜底。
// 结果：`%TEMP%` 里积到 **12123 个** `dotd-test-*`（全部当天新建），
// 一次全量 `npm test` 净增 **52 个**、一个都不删。
//
// 这不只是脏：目录堆到一万多个后，`rmSync` 与目录枚举变慢，
// 最终把整份测试文件拖到超时崩溃 —— 表现为间歇性的
// `pass 1527 / fail 2`（**总数少于 1575**，整份文件没跑完，不是断言失败）。
// **这个泄漏会自己把 S1 判据"0 失败"弄红**，而且时红时绿、极难归因。
//
// 修法：登记时就**自动挂上进程退出钩子**，把清理从"使用者的记性"
// 变成"登记这个动作的副作用"——只要用过 makeTempDataDir，就一定会被兜底。
// 用 `process.once('exit')` 而不是 `test.after`：
//   · `exit` 对"文件级测试跑完"和"进程异常退出"都生效；
//   · 不依赖是否 import 了 node:test 的 before/after 钩子；
//   · 每个进程只挂一次（once + 幂等标志）。
// 注意：`exit` 里**只能做同步操作** —— 这里正好全是同步的（rmSync/close）。
let autoSweepArmed = false;
function armAutoSweep(): void {
  if (autoSweepArmed) return;
  autoSweepArmed = true;
  process.once('exit', () => {
    // 尽力而为：删不掉的（句柄仍被持有）不在这里报错，交给 temp-cleanup 自检暴露
    for (const p of [...liveTempPaths]) {
      try {
        rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 });
      } catch {
        // 忽略
      }
    }
  });
}

/**
 * 删掉一个临时路径：最多重试 `RM_RETRIES` 次（每次 20ms），成功后从登记表移除。
 * @returns 删除后目录是否确实不存在（`false` = 删不掉，调用方应报警）。
 */
export function removeTempPath(p: string): boolean {
  for (let i = 0; i < RM_RETRIES; i++) {
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 10 });
    } catch {
      // 句柄还没放：下一轮再来
    }
    if (!existsSync(p)) {
      liveTempPaths.delete(p);
      return true;
    }
    // 同步自旋等 20ms（cleanup 是同步 API；不引入异步等待以免改变测试时序）
    const until = Date.now() + 20;
    while (Date.now() < until) {
      // busy-wait：20ms 级别的等待，避免 rm 的“关库尚未完成 → EBUSY”竞态
    }
  }
  return !existsSync(p);
}

/**
 * 兜底清理：把本文件登记过、仍存在的临时路径全部删掉。
 * 测试文件可写 `test.after(sweepTempPaths)` 一行兜底（忘了 cleanup 也不泄漏）。
 *
 * 注意：sweep 只能删**没人再持有连接**的目录。库连接还开着时 Windows 上删不掉
 * （WAL/SHM 句柄）——这是设计上的安全边界，不是缺陷；用例写完数据后仍应自己 `cleanup()`。
 * @returns 仍删不掉的路径（正常情况下应为空）。
 */
export function sweepTempPaths(): string[] {
  const left: string[] = [];
  for (const p of [...liveTempPaths]) {
    if (!removeTempPath(p)) left.push(p);
  }
  return left;
}

/**
 * 强制回收一个临时目录（供**忘调 cleanup 的用例**兜底）：若路径登记过且其库连接仍开着，
 * 由调用方显式关库（`closeOwner`）后再删。
 * @returns 目录是否已不存在。
 */
export function forceRemoveTempPath(p: string, closeOwner?: () => void): boolean {
  if (!existsSync(p)) {
    liveTempPaths.delete(p);
    return true;
  }
  if (closeOwner !== undefined) {
    try {
      closeOwner();
    } catch {
      // 已关
    }
  }
  return removeTempPath(p);
}

/** 当前登记但未删除的临时路径数量（诊断/自检用）。 */
export function liveTempPathCount(): number {
  return liveTempPaths.size;
}

// ── 2. stub 模型 transport（DOTD_MODEL_TRANSPORT=stub）──────────────

/** 一条预置响应。按入队顺序消费；`match` 命中则优先生效（便于分轨脚本）。 */
export interface StubResponse {
  /** 命中条件：轨道匹配才用这条（缺省 = 任意轨）。 */
  track?: Track;
  /** 请求内容含该子串时命中（缺省 = 任意内容）。 */
  contains?: string;
  content: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  usage?: { promptTokens: number; completionTokens: number };
}

export interface StubTransport {
  /** 冒充 ModelRouter.complete 的调用面：消费一条预置响应。 */
  complete(req: RouteRequest): Promise<RouteResult>;
  /** 追加预置响应（可在测试中途追加）。 */
  push(resp: StubResponse): void;
  /** 已收到的请求（断言 attemptId/track/deadlineMs 用）。 */
  requests: RouteRequest[];
  /** 剩余未消费的预置响应数。 */
  pending(): number;
}

/**
 * stub transport：不发任何网络请求。
 * 预置耗尽时的行为 = 抛错（等价 AllEndpointsDownError 的"全灭"语义），
 * 迫使测试显式声明预期交互次数，而不是静默拿到空响应。
 */
export function makeStubTransport(initial: StubResponse[] = []): StubTransport {
  const queue: StubResponse[] = [...initial];
  const requests: RouteRequest[] = [];
  return {
    async complete(req: RouteRequest): Promise<RouteResult> {
      requests.push(req);
      const idx = queue.findIndex(
        (r) =>
          (r.track === undefined || r.track === req.track) &&
          (r.contains === undefined ||
            req.messages.some((m) => m.content.includes(r.contains!))),
      );
      if (idx === -1) {
        throw new Error(
          `stub transport 预置响应耗尽（track=${req.track} attemptId=${req.attemptId}）`,
        );
      }
      const resp = queue[idx];
      if (resp === undefined) {
        throw new Error('stub transport 内部错误：索引命中但取不到响应');
      }
      queue.splice(idx, 1);
      return {
        meta: {
          endpointId: 'stub',
          tier: 2,
          model: 'stub-model',
          degraded: false,
          attemptSeq: 0,
          tried: [],
          streamStarted: false,
        },
        response: { content: resp.content, toolCalls: resp.toolCalls },
        usage: resp.usage ?? { promptTokens: 10, completionTokens: 5 },
      };
    },
    push(resp: StubResponse): void {
      queue.push(resp);
    },
    requests,
    pending(): number {
      return queue.length;
    },
  };
}

// ── 3. stub fleet（DOTD_FLEET=stub）────────────────────────────────

/** 按工具名预先登记的假结果；未登记的工具返回 ok + 空 result。 */
export type StubFleetHandlers = Partial<
  Record<string, (call: ExecToolCall) => ExecToolResult | Promise<ExecToolResult>>
>;

export interface StubFleet {
  /** 冒充 ExecService.runTool：查表执行，记录全部调用。 */
  runTool(call: ExecToolCall): Promise<ExecToolResult>;
  /** 收到的全部调用（断言 call_id 幂等/工具名用）。 */
  calls: ExecToolCall[];
  /** 按 call_id 索引的已执行次数（验证"同 call_id 至多一次"）。 */
  countByCallId(callId: string): number;
  reset(): void;
}

/**
 * stub fleet：不起 Docker、不发 HTTP。
 * 幂等语义与真实 ledger 对齐（EX §5.4）：同 call_id 第二次进入直接重放首次结果，
 * **不再次执行 handler**——测试用它验证 journal/调用方没有重复派发。
 */
export function makeStubFleet(handlers: StubFleetHandlers = {}): StubFleet {
  const calls: ExecToolCall[] = [];
  const results = new Map<string, ExecToolResult>();
  return {
    async runTool(call: ExecToolCall): Promise<ExecToolResult> {
      const seen = results.get(call.call_id);
      if (seen !== undefined) return seen; // ledger 重放（EX §5.4：done 项直接重放）
      calls.push(call);
      const h = handlers[call.tool];
      const result =
        h !== undefined
          ? await h(call)
          : {
              call_id: call.call_id,
              status: 'ok' as const,
              result: {},
              usage: { wall_ms: 1, peak_mem_mb: 1 },
              finished_at: new Date().toISOString(),
            };
      results.set(call.call_id, result);
      return result;
    },
    calls,
    countByCallId(callId: string): number {
      return calls.filter((c) => c.call_id === callId).length;
    },
    reset(): void {
      calls.length = 0;
      results.clear();
    },
  };
}
