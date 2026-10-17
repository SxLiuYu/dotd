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

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDb } from '../db/conn.ts';
import { migrate } from '../db/migrate.ts';
import { EventBus } from '../src/shared/bus.ts';
import type {
  ExecToolCall,
  ExecToolResult,
  RouteRequest,
  RouteResult,
  Track,
} from '../src/shared/contracts.ts';

// ── 1. 临时数据目录 ────────────────────────────────────────────────

export interface TempDataDir {
  /** 临时根目录（已创建）。 */
  root: string;
  /** 库文件路径（尚未创建文件；openDb 会建）。 */
  dbPath: string;
  /** OUTBOX.md 路径（已创建空文件）。 */
  outboxPath: string;
  /** journal-blobs 目录路径（已创建）。 */
  blobDir: string;
  /** 打开并迁移好的唯一连接（user_version=100）。 */
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
 */
export function makeTempDataDir(): TempDataDir {
  const root = mkdtempSync(join(tmpdir(), 'dotd-test-'));
  const dbPath = join(root, 'dotd.db');
  const outboxPath = join(root, 'OUTBOX.md');
  const blobDir = join(root, 'journal-blobs');
  mkdirSync(blobDir, { recursive: true });
  writeFileSync(outboxPath, '', 'utf8');

  const db = openDb(dbPath);
  migrate(db); // 推到 user_version=100，测试直接面对终态 schema

  const bus = new EventBus();

  let cleaned = false;
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
      try {
        db.close();
      } catch {
        // 已关
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
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
