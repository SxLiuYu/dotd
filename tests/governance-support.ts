/**
 * tests/governance-support.ts —— 治理模块测试脚手架（只服务 tests/governance-*.test.ts）。
 *
 * 依据 CONVENTIONS「测试约定」：测试绝不碰真实 ~/.dotd，一律走 tests/helpers.ts 的
 * makeTempDataDir()；GOV 依赖（控制面钩子/journal/router/bus）用显式 stub 注入，
 * 不 import 其他模块的实现。
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { EventBus } from '../src/shared/bus.ts';
import { makeTempDataDir, registerTempPath, removeTempPath } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { createGovernance, initGovernance } from '../src/governance/gate.ts';
import { loadCatalog } from '../src/governance/catalog.ts';
import type { Catalog } from '../src/governance/catalog.ts';
import type { GovDeps } from '../src/governance/types.ts';
import type { GovernanceRuntime } from '../src/governance/gate.ts';

/** 记录控制面钩子调用（断言"提交后立即联动"）。 */
export interface CpRecorder {
  settled: Array<{
    taskId: string;
    approvalId: number;
    ok: boolean;
    meta?: { note?: string; revoke?: string };
  }>;
  awaiting: Array<{ taskId: string; epoch: number; approvalId: number }>;
  resumed: string[];
  onApprovalSettled(
    taskId: string,
    approvalId: number,
    ok: boolean,
    meta?: { note?: string; revoke?: string },
  ): void;
}

export function makeCpRecorder(): CpRecorder {
  const settled: CpRecorder['settled'] = [];
  const awaiting: CpRecorder['awaiting'] = [];
  const resumed: string[] = [];
  return {
    settled,
    awaiting,
    resumed,
    onApprovalSettled(taskId, approvalId, ok, meta) {
      settled.push({ taskId, approvalId, ok, meta });
    },
  };
}

/** stub 低智能轨 router：按脚本回放；脚本耗尽即抛错（迫使测试显式声明交互次数）。 */
export interface RouterStub {
  requests: Array<{
    track: string;
    messages: Array<{ role: string; content: string }>;
    attemptId: string;
    deadlineMs?: number;
    maxTokens?: number;
  }>;
  /** 预置响应内容（行协议：`S|…` / `R|…` / `OK|…`）。 */
  script: string[];
  /** 设为 true 时所有调用抛错（模拟审查器不可用）。 */
  broken: boolean;
  complete(req: {
    track: 'light';
    messages: Array<{ role: 'system' | 'user'; content: string }>;
    attemptId: string;
    deadlineMs?: number;
    maxTokens?: number;
  }): Promise<{ response: { content: string } }>;
}

export function makeRouterStub(script: string[] = []): RouterStub {
  const requests: RouterStub['requests'] = [];
  const queue = [...script];
  return {
    requests,
    script: queue,
    broken: false,
    async complete(req) {
      requests.push(req);
      if (this.broken) throw new Error('审查器不可用（stub）');
      const content = queue.shift();
      if (content === undefined) {
        throw new Error(`router stub 预置响应耗尽（已收 ${requests.length} 次调用）`);
      }
      return { response: { content } };
    },
  };
}

/** 组装测试用治理运行态：真库（临时目录）+ stub 依赖 + 真 tools.yml/rules.yml。 */
export interface GovFixture {
  tmp: TempDataDir;
  db: DatabaseSync;
  bus: EventBus;
  catalog: Catalog;
  cp: CpRecorder;
  router: RouterStub;
  journal: { stepExists(callId: string): boolean };
  rt: GovernanceRuntime;
  cleanup(): void;
}

export function makeGovFixture(
  opts: {
    /** 自定义 tools.yml 内容（缺省用仓库真实 config/tools.yml）。 */
    toolsYml?: string;
    /** 自定义 rules.yml 内容（缺省 `rules: []`）。 */
    rulesYml?: string;
    /** 预置的 precheck/postReview 响应。 */
    script?: string[];
    /** 覆写 GOV_DEFAULTS（如 TTL/熔断阈值）。 */
    defaults?: Partial<import('../src/governance/config.ts').GovDefaults>;
  } = {},
): GovFixture {
  const tmp = makeTempDataDir();
  const root = mkdtempSync(join(tmpdir(), 'dotd-gov-cfg-'));
  // 登记进 helpers 的临时路径表：即使调用方忘了 cleanup()，`sweepTempPaths()` 也会回收
  // （此前这里每个 fixture 泄漏一个目录，TEMP 里积了数百个 dotd-gov-cfg-*）。
  registerTempPath(root);
  // **不指望调用方调 cleanup()**（2026-10-19 修，真缺陷）：
  // 实测这 3 个 governance 测试文件共 12 处 `makeGovFixture`，
  // **一处都没有调用 `.cleanup()`** —— 于是每个 fixture 留下一个
  // `dotd-gov-cfg-*`，另有 `makeTempDataDir` 留一个 `dotd-test-*`。
  // 逐文件扫描确认残留：governance-memory 13、quarantine-audit 15、review-catalog 24，
  // 合计正是全量运行净增的 52 个。
  // 把清理挂到**进程退出**上：只要建过 fixture 就一定会被兜底，
  // 与"调用方记不记得 cleanup"无关。exit 里只能做同步操作 —— 这里全是同步的。
  process.once('exit', () => {
    try {
      tmp.cleanup();
    } catch {
      /* 尽力而为 */
    }
    removeTempPath(root);
  });
  const toolsPath = join(root, 'tools.yml');
  const rulesPath = join(root, 'rules.yml');
  writeFileSync(
    toolsPath,
    opts.toolsYml ?? DEFAULT_TOOLS_YML,
    'utf8',
  );
  writeFileSync(rulesPath, opts.rulesYml ?? 'rules: []\n', 'utf8');

  const { catalog } = loadCatalog(toolsPath, rulesPath);

  const cp = makeCpRecorder();
  const router = makeRouterStub(opts.script ?? []);
  const bus = tmp.bus;
  const journal = { stepExists: (_callId: string) => true };

  const deps: GovDeps = {
    controlPlane: {
      setAwaitingApproval(taskId, epoch, approvalId) {
        cp.awaiting.push({ taskId, epoch, approvalId });
      },
      onApprovalSettled: cp.onApprovalSettled,
      resumeDotQueue(dotId) {
        cp.resumed.push(dotId);
      },
    },
    journal,
    router,
    bus: {
      publish: (topic, payload, o) => bus.publish(topic, payload, o),
      on: (topic, handler) => bus.on(topic, handler),
    },
  };

  const defaults =
    opts.defaults === undefined
      ? undefined
      : ({
          approvalTtlMs: 24 * 3600_000,
          expireScanMs: 5 * 60_000,
          precheckTimeoutMs: 45_000,
          precheckBudget: { goalBytes: 800, paramsBytes: 1500, maxOutputTokens: 40 },
          reviewFailThreshold: { windowMs: 600_000, fails: 5, openMs: 900_000 },
          auditRetentionDays: 90,
          auditRetentionRows: 20_000,
          auditArchiveCapMb: 200,
          chunkBytes: 10 * 1024 * 1024,
          memoryPerTierCap: 50,
          memoryDefaultExpiryDays: 90,
          ...opts.defaults,
        } satisfies import('../src/governance/config.ts').GovDefaults);

  const rt = createGovernance(tmp.db, catalog, deps, { defaults });
  // 同时设为模块单例：测试可以直接调 decide/claim/revoke 的默认参数形态，
  // 与装配层 initGovernance 后的真实调用面一致（node --test 每文件独立进程）。
  initGovernance(tmp.db, catalog, deps, { defaults });

  return {
    tmp,
    db: tmp.db,
    bus,
    catalog,
    cp,
    router,
    journal,
    rt,
    cleanup() {
      tmp.cleanup();
      // **`dotd-gov-cfg-*` 也必须在这里删掉**（2026-10-19 修，真缺陷）：
      // 上面 `registerTempPath(root)` 只保证"**如果**有人调 sweepTempPaths() 就会回收"，
      // 而实测 57 个用临时目录的测试文件里**只有 16 个**写了 `test.after(sweepTempPaths)`。
      // 于是这 3 个 governance 文件每跑一次就留下 13~24 个 `dotd-gov-cfg-*`
      // （逐文件扫描确认：governance-memory 13、quarantine-audit 15、review-catalog 24）。
      // 残留目录堆到一万多个后 `rmSync`/目录枚举变慢，会把整份测试文件拖到超时崩溃，
      // 表现为间歇性 `pass 1527 / fail 2`（总数少于 1575）—— 见 temp-cleanup.test.ts 的说明。
      // 所以清理要放在**每个使用者本来就会调用的 cleanup() 里**，而不是指望约定。
      removeTempPath(root);
    },
  };
}

/** 与仓库 config/tools.yml 等价的目录（测试不依赖仓库工作目录路径）。 */
export const DEFAULT_TOOLS_YML = `tools:
  - name: fs.read
    tier: read
  - name: fs.write
    tier: write_file
    pathPrefixes: ["/dot/home/"]
  - name: fs.list
    tier: read
  - name: shell.run
    tier: write_file
    upgrade:
      tier: dangerous
      whenContains: ["rm ", "sudo ", "docker ", "> /dev/"]
  - name: browser.open
    tier: read
  - name: browser.act
    tier: browser
  - name: browser.snapshot
    tier: read
  - name: browser.close
    tier: read
  - name: net.get
    tier: read
  - name: net.post
    tier: write_file
  - name: shop.checkout
    tier: spend
    spendParams:
      required: [amountCents, currency, category]
`;

/** 常用 GovCtx。 */
export function ctxOf(over: Partial<{ dotId: string; taskId: string; emergency: boolean }> = {}): import('../src/shared/contracts.ts').GovCtx {
  return {
    dotId: over.dotId ?? 'dot1',
    taskRef: { taskId: over.taskId ?? 'tk_1', journalStepId: 'step_1' },
    emergency: over.emergency ?? false,
  };
}

/** 读 approvals 行（测试断言用；直读库不经过治理投影）。 */
export function approvalRow(db: DatabaseSync, id: number): Record<string, unknown> {
  const r = db.prepare('SELECT * FROM approvals WHERE id=$id').get({ id }) as
    | Record<string, unknown>
    | undefined;
  if (r === undefined) throw new Error(`审批单 #${id} 不存在`);
  return r;
}

/** 读 audit_log（测试断言用）。 */
export function auditRows(db: DatabaseSync, action?: string): Array<Record<string, unknown>> {
  const sql =
    action === undefined
      ? 'SELECT * FROM audit_log ORDER BY id ASC'
      : 'SELECT * FROM audit_log WHERE action=$action ORDER BY id ASC';
  const stmt = db.prepare(sql);
  const rows = (
    action === undefined ? stmt.all() : stmt.all({ action })
  ) as unknown as Record<string, unknown>[];
  return rows;
}
