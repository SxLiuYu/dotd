/**
 * tests/router-recon.test.ts —— Tier4 侦察候选状态机、审批回调、启动对账、janitor。
 *
 * 依据（docs/design/modules/model-router.md，行号为该文档内位置）：
 * - §4.6 流程 1：拉数据源只读**元数据**（绝不向候选发 chat/completions 推理请求）。
 * - §4.6 流程 2：八行状态分支表（表内无行 / needs_approval 未超 7d / expired / retired /
 *   rejected 冷却内外 / approved / live），`UNIQUE(base_url, model)` 下走 UPDATE。
 * - §4.6 流程 3：排序取 top N 发 `router.recon_proposal` 事件。
 * - §4.6 流程 4：批准 = 事务内先 UPDATE state='live'，提交后再写 free-models.yml
 *   （文件写失败留 approved，心跳重试转 live）。
 * - §4.6 流程 5：拒绝 → rejected + reject_reason，30d 冷却；7 天无人理会 → janitor expired。
 * - §4.6 流程 7：侦察源不可达不额外求救（sourceError 上报，不提案）。
 * - §4.7 启动对账第 2/3 步：approved 且文件无条目 → 重写文件转 live；live 但文件无条目 → retired。
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeTempDataDir, type TempDataDir } from './helpers.ts';
import { PoolManager } from '../src/router/pool.ts';
import { ReconScanner, candidateId } from '../src/router/recon.ts';
import { StubTransport } from '../src/router/transport.ts';
import type { ReconConfig } from '../src/router/types.ts';
import type { RouterMode } from '../src/shared/contracts.ts';

let tmp: TempDataDir;
let cfgDir: string;
let poolPath: string;

const CFG: ReconConfig = {
  interval_ms: 21_600_000,
  max_candidates_per_scan: 2,
  sources: [{ type: 'openrouter_models', filter: ':free' }],
  candidate_ttl_ms: 7 * 86_400_000,
  rejected_cooldown_ms: 30 * 86_400_000,
};

const ITEM_A = {
  base_url: 'https://openrouter.ai/api/v1',
  model: 'vendor/model-a:free',
  api_key_note: 'OPENROUTER_API_KEY',
  evidence: { source_url: 'https://openrouter.ai/api/v1/models' },
};
const ITEM_B = { ...ITEM_A, model: 'vendor/model-b:free', api_key_note: undefined };

beforeEach(() => {
  tmp = makeTempDataDir();
  cfgDir = join(tmp.root, 'config');
  mkdirSync(cfgDir, { recursive: true });
  poolPath = join(cfgDir, 'free-models.yml');
  writeFileSync(poolPath, 'version: 1\nupdated_at: null\nmodels: []\n', 'utf8');
});

afterEach(() => {
  tmp.cleanup();
});

/** 造侦察器（时钟可注入，池文件指向临时目录）。 */
function makeRecon(now: () => number = Date.now, cfg: ReconConfig = CFG): ReconScanner {
  const pool = new PoolManager({ db: tmp.db, now });
  pool.loadFile(poolPath);
  return new ReconScanner({ db: tmp.db, bus: tmp.bus, cfg, pool, now });
}

/** 测试专用查询助手（node:sqlite 的绑定参数只接受标量/ Buffer/ null）。 */
function rows(sql: string, ...args: Array<string | number | null>): Array<Record<string, unknown>> {
  return tmp.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
}

describe('扫描：八行状态分支（MR §4.6 流程 2）', () => {
  it('表内无行 → 提案 + 发 router.recon_proposal 事件', async () => {
    let clock = 1_800_000_000_000;
    const recon = makeRecon(() => clock);
    const events: string[] = [];
    tmp.bus.on('router.recon_proposal', () => {
      events.push('proposal');
    });
    const stub = new StubTransport({ metadata: { openrouter_models: { items: [ITEM_A, ITEM_B] } } });

    const r = await recon.scan(stub, 'LOCAL_FALLBACK' as RouterMode);
    assert.equal(r.ok, true);
    assert.equal(r.sourceError, null);
    assert.equal(r.proposed.length, 2, 'top N=2 全提案');
    assert.equal(events.length, 2, '每条提案一个事件');
    assert.equal(r.pending.length, 2);
    // 行落库为 needs_approval
    const st = rows(`SELECT state FROM recon_candidate WHERE model=?`, ITEM_A.model);
    assert.equal(st[0]?.state, 'needs_approval');
    // 候选 id 形状（§3.2 DDL 注释）
    assert.match(r.proposed[0]?.id ?? '', /^recon:[0-9a-f]{12}$/);
    assert.equal(r.proposed[0]?.id, candidateId('openrouter_models', ITEM_A.base_url, ITEM_A.model));
  });

  it('超过 max_candidates_per_scan 只提案 top N', async () => {
    const recon = makeRecon();
    const items = [ITEM_A, ITEM_B, { ...ITEM_A, model: 'vendor/model-c:free' }];
    const stub = new StubTransport({ metadata: { openrouter_models: { items } } });
    const r = await recon.scan(stub, 'EMERGENCY' as RouterMode);
    assert.equal(r.proposed.length, 2, 'CFG.max_candidates_per_scan=2');
  });

  it('needs_approval 未超 7d → 只 touch evidence，不重复提案', async () => {
    let clock = 1_800_000_000_000;
    const recon = makeRecon(() => clock);
    const stub = new StubTransport({ metadata: { openrouter_models: { items: [ITEM_A] } } });
    const r1 = await recon.scan(stub, 'LOCAL_FALLBACK' as RouterMode);
    assert.equal(r1.proposed.length, 1);
    clock += 3 * 86_400_000;
    const r2 = await recon.scan(stub, 'LOCAL_FALLBACK' as RouterMode);
    assert.equal(r2.proposed.length, 0, '不重复提案');
    assert.equal(r2.pending.length, 1, '仍是待批');
    const ev = rows(`SELECT evidence FROM recon_candidate WHERE model=?`, ITEM_A.model);
    assert.match(String(ev[0]?.evidence), /rescanned_at/, 'evidence 被刷新');
  });

  it('已在 free-models.yml 里的条目 → 跳过（主人渠道优先，§4.6 流程 2 首行）', async () => {
    // 先把该 pair 写进池文件，再造侦察器（侦察器的池实例读同一文件）
    const pool = new PoolManager({ db: tmp.db });
    pool.loadFile(poolPath);
    pool.addApprovedCandidate({
      id: 'recon:manual',
      base_url: ITEM_A.base_url,
      model: ITEM_A.model,
      api_key_env: null,
    });
    const recon = makeRecon();
    const stub = new StubTransport({ metadata: { openrouter_models: { items: [ITEM_A] } } });
    const r = await recon.scan(stub, 'LOCAL_FALLBACK' as RouterMode);
    assert.equal(r.proposed.length, 0);
    assert.equal(rows(`SELECT COUNT(*) AS n FROM recon_candidate`)[0]?.n, 0, '表内不落行');
  });

  it('expired / retired → 复活为 needs_approval 并重新提案', async () => {
    let clock = 1_800_000_000_000;
    const recon = makeRecon(() => clock);
    const id = candidateId('openrouter_models', ITEM_A.base_url, ITEM_A.model);
    tmp.db
      .prepare(
        `INSERT INTO recon_candidate (id, source, base_url, model, api_key_note, evidence, state, found_at, updated_at)
         VALUES (?,?,?,?,?,?,'expired',?,?)`,
      )
      .run(
        id,
        'openrouter_models',
        ITEM_A.base_url,
        ITEM_A.model,
        null,
        '{}',
        clock - 10 * 86_400_000,
        clock - 10 * 86_400_000,
      );
    const stub = new StubTransport({ metadata: { openrouter_models: { items: [ITEM_A] } } });
    const r = await recon.scan(stub, 'TOTAL_OUTAGE' as RouterMode);
    assert.equal(r.proposed.length, 1);
    assert.equal(r.proposed[0]?.id, id, '复活沿用原 id（不是新行）');
    assert.equal(
      rows(`SELECT state, found_at, decided_at FROM recon_candidate WHERE id=?`, id)[0]?.state,
      'needs_approval',
    );
    assert.equal(Number(rows(`SELECT COUNT(*) AS n FROM recon_candidate`)[0]?.n), 1, '不撞 UNIQUE 插新行');
  });

  it('rejected 冷却期内 → 跳过，不出现', async () => {
    let clock = 1_800_000_000_000;
    const recon = makeRecon(() => clock);
    const id = candidateId('openrouter_models', ITEM_A.base_url, ITEM_A.model);
    tmp.db
      .prepare(
        `INSERT INTO recon_candidate (id, source, base_url, model, api_key_note, evidence, state, decided_at, found_at, updated_at)
         VALUES (?,?,?,?,?,?,'rejected',?,?,?)`,
      )
      .run(
        id,
        'openrouter_models',
        ITEM_A.base_url,
        ITEM_A.model,
        null,
        '{}',
        clock - 10 * 86_400_000,
        clock - 10 * 86_400_000,
        clock - 10 * 86_400_000,
      );
    const stub = new StubTransport({ metadata: { openrouter_models: { items: [ITEM_A] } } });
    const r = await recon.scan(stub, 'LOCAL_FALLBACK' as RouterMode);
    assert.equal(r.proposed.length, 0, '30d 冷却期内不提案');
    assert.equal(r.pending.length, 0);
  });

  it('rejected 超 30d 冷却 → 复活重提案', async () => {
    let clock = 1_800_000_000_000;
    const recon = makeRecon(() => clock);
    const id = candidateId('openrouter_models', ITEM_A.base_url, ITEM_A.model);
    tmp.db
      .prepare(
        `INSERT INTO recon_candidate (id, source, base_url, model, api_key_note, evidence, state, decided_at, reject_reason, found_at, updated_at)
         VALUES (?,?,?,?,?,?,'rejected',?,'不要',?,?)`,
      )
      .run(
        id,
        'openrouter_models',
        ITEM_A.base_url,
        ITEM_A.model,
        null,
        '{}',
        clock - 31 * 86_400_000,
        clock - 31 * 86_400_000,
        clock - 31 * 86_400_000,
      );
    const stub = new StubTransport({ metadata: { openrouter_models: { items: [ITEM_A] } } });
    const r = await recon.scan(stub, 'LOCAL_FALLBACK' as RouterMode);
    assert.equal(r.proposed.length, 1, '冷却结束重新提案');
    const row = rows(`SELECT state, reject_reason FROM recon_candidate WHERE id=?`, id)[0];
    assert.equal(row?.state, 'needs_approval');
    assert.equal(row?.reject_reason, null, '复活清掉拒绝理由');
  });

  it('approved / live → 跳过（不重复提案）', async () => {
    let clock = 1_800_000_000_000;
    const recon = makeRecon(() => clock);
    for (const state of ['approved', 'live'] as const) {
      const id = candidateId('openrouter_models', ITEM_A.base_url, `vendor/${state}:free`);
      tmp.db
        .prepare(
          `INSERT INTO recon_candidate (id, source, base_url, model, api_key_note, evidence, state, found_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          'openrouter_models',
          ITEM_A.base_url,
          `vendor/${state}:free`,
          null,
          '{}',
          state,
          clock,
          clock,
        );
    }
    const stub = new StubTransport({
      metadata: {
        openrouter_models: {
          items: [
            ITEM_A,
            { ...ITEM_A, model: 'vendor/approved:free' },
            { ...ITEM_A, model: 'vendor/live:free' },
          ],
        },
      },
    });
    const r = await recon.scan(stub, 'LOCAL_FALLBACK' as RouterMode);
    // 只有 ITEM_A（表内无行）被提案；approved/live 两条跳过
    assert.deepEqual(
      r.proposed.map((p) => p.model),
      [ITEM_A.model],
    );
  });

  it('源不可达 → 不提案、不落行，sourceError 上报（§4.6 流程 7）', async () => {
    const recon = makeRecon();
    const stub = new StubTransport(); // 未预置 metadata → stub 返回 ok:false
    const r = await recon.scan(stub, 'TOTAL_OUTAGE' as RouterMode);
    assert.equal(r.ok, false);
    assert.match(r.sourceError ?? '', /未预置元数据源/);
    assert.equal(r.proposed.length, 0);
    assert.equal(rows(`SELECT COUNT(*) AS n FROM recon_candidate`)[0]?.n, 0);
  });

  it('只读元数据：扫描全程不产生任何 chat/completions 调用（§4.6 流程 1 逐字）', async () => {
    const recon = makeRecon();
    const stub = new StubTransport({ metadata: { openrouter_models: { items: [ITEM_A] } } });
    await recon.scan(stub, 'TOTAL_OUTAGE' as RouterMode);
    assert.equal(stub.calls.length, 0, 'stub.chat/stream 一次都没被调');
    assert.equal(stub.gets.length, 0, 'stub.get 也没被调（metadata 走独立路径）');
  });
});

describe('审批回调（MR §4.6 流程 4/5；契约 J6）', () => {
  it('批准 → 事务内置 live + 提交后写 free-models.yml', async () => {
    let clock = 1_800_000_000_000;
    const recon = makeRecon(() => clock);
    const stub = new StubTransport({ metadata: { openrouter_models: { items: [ITEM_A] } } });
    // 先扫一遍提案
    const r = await recon.scan(stub, 'LOCAL_FALLBACK' as RouterMode);
    const id = r.proposed[0]!.id;
    const res = recon.approve(id, 'owner');
    assert.equal(res.ok, true);
    assert.equal(res.state, 'live');
    const row = rows(`SELECT state, decided_by, decided_at FROM recon_candidate WHERE id=?`, id)[0];
    assert.equal(row?.state, 'live');
    assert.equal(row?.decided_by, 'owner');
    assert.equal(Number(row?.decided_at), clock);
    // 池文件有条目
    const text = readFileSync(poolPath, 'utf8');
    assert.match(text, /vendor\/model-a:free/);
    assert.match(text, /api_key_env: OPENROUTER_API_KEY/, 'api_key_note 全大写 env 名 → api_key_env');
  });

  it('批准幂等：重复批准同一条不重复写文件', async () => {
    const recon = makeRecon();
    const stub = new StubTransport({ metadata: { openrouter_models: { items: [ITEM_A] } } });
    const r = await recon.scan(stub, 'LOCAL_FALLBACK' as RouterMode);
    const id = r.proposed[0]!.id;
    assert.equal(recon.approve(id).state, 'live');
    assert.equal(recon.approve(id).state, 'live', '再批一次仍 ok');
    const pool = new PoolManager({ db: tmp.db });
    pool.loadFile(poolPath);
    assert.equal(pool.filePairs().length, 1, '不重复追加');
  });

  it('批准不存在的候选 → ok:false', () => {
    const recon = makeRecon();
    assert.equal(recon.approve('recon:deadbeef').ok, false);
  });

  it('拒绝 → rejected + reject_reason（30d 冷却起算点）', async () => {
    let clock = 1_800_000_000_000;
    const recon = makeRecon(() => clock);
    const stub = new StubTransport({ metadata: { openrouter_models: { items: [ITEM_A] } } });
    const r = await recon.scan(stub, 'LOCAL_FALLBACK' as RouterMode);
    const id = r.proposed[0]!.id;
    assert.equal(recon.reject(id, '额度不够', 'owner'), true);
    const row = rows(
      `SELECT state, decided_by, decided_at, reject_reason FROM recon_candidate WHERE id=?`,
      id,
    )[0];
    assert.equal(row?.state, 'rejected');
    assert.equal(row?.decided_by, 'owner');
    assert.equal(row?.reject_reason, '额度不够');
    assert.equal(Number(row?.decided_at), clock);
  });

  it('批准时文件写失败 → 留 approved + 心跳对账补写转 live（§4.7 第 2 步）', async () => {
    const recon = makeRecon();
    const stub = new StubTransport({ metadata: { openrouter_models: { items: [ITEM_A] } } });
    const r = await recon.scan(stub, 'LOCAL_FALLBACK' as RouterMode);
    const id = r.proposed[0]!.id;

    // 磁盘故障：把池文件路径换成一个不可写位置（用文件当目录）
    const blocker = join(cfgDir, 'blocker');
    writeFileSync(blocker, 'not a dir', 'utf8');
    const badPool = new PoolManager({ db: tmp.db });
    badPool.loadFile(join(blocker, 'sub', 'free-models.yml'));
    const badRecon = new ReconScanner({ db: tmp.db, bus: tmp.bus, cfg: CFG, pool: badPool });
    const res = badRecon.approve(id, 'owner');
    assert.equal(res.ok, true);
    assert.equal(res.state, 'approved', '文件写失败 → 留 approved 等重试');
    assert.ok((res.fileError ?? '').length > 0);
    assert.equal(badPool.pendingFileWriteCount(), 1);

    // 心跳重试：磁盘恢复（清掉阻塞）后写成功出队，随后对账把 approved 转 live
    rmSync(blocker, { force: true });
    const done = badPool.retryPendingFileWrites();
    assert.deepEqual(done, [id]);
    const rec = new ReconScanner({ db: tmp.db, bus: tmp.bus, cfg: CFG, pool: badPool });
    assert.deepEqual(rec.reconcile().promoted, [id]);
    assert.equal(rows(`SELECT state FROM recon_candidate WHERE id=?`, id)[0]?.state, 'live');
  });
});

describe('启动对账（MR §4.7 第 2/3 步）', () => {
  it('approved 且文件无条目 → 重写文件并转 live', () => {
    const recon = makeRecon();
    const id = 'recon:aaaabbbbcccc';
    tmp.db
      .prepare(
        `INSERT INTO recon_candidate (id, source, base_url, model, api_key_note, evidence, state, found_at, updated_at)
         VALUES (?,?,?,?,?,?,'approved',?,?)`,
      )
      .run(
        id,
        'openrouter_models',
        ITEM_A.base_url,
        ITEM_A.model,
        'OPENROUTER_API_KEY',
        '{}',
        1_800_000_000_000,
        1_800_000_000_000,
      );
    const r = recon.reconcile();
    assert.deepEqual(r.promoted, [id]);
    assert.equal(rows(`SELECT state FROM recon_candidate WHERE id=?`, id)[0]?.state, 'live');
    assert.match(readFileSync(poolPath, 'utf8'), /vendor\/model-a:free/);
  });

  it('live 但文件里没有（主人手工删了）→ 置 retired', () => {
    const recon = makeRecon();
    const id = 'recon:ddddeeeeffff';
    tmp.db
      .prepare(
        `INSERT INTO recon_candidate (id, source, base_url, model, api_key_note, evidence, state, found_at, updated_at)
         VALUES (?,?,?,?,?,?,'live',?,?)`,
      )
      .run(
        id,
        'openrouter_models',
        'https://gone.example/api/v1',
        'vendor/gone:free',
        null,
        '{}',
        1_800_000_000_000,
        1_800_000_000_000,
      );
    const r = recon.reconcile();
    assert.deepEqual(r.retired, [id]);
    assert.equal(rows(`SELECT state FROM recon_candidate WHERE id=?`, id)[0]?.state, 'retired');
  });

  it('live 且文件有条目 → 不动', () => {
    // 先把 pair 写进池文件，再造侦察器（侦察器的池实例读同一文件）
    const pool = new PoolManager({ db: tmp.db });
    pool.loadFile(poolPath);
    pool.addApprovedCandidate({
      id: 'recon:live1',
      base_url: ITEM_A.base_url,
      model: ITEM_A.model,
      api_key_env: null,
    });
    const recon = makeRecon();
    tmp.db
      .prepare(
        `INSERT INTO recon_candidate (id, source, base_url, model, api_key_note, evidence, state, found_at, updated_at)
         VALUES (?,?,?,?,?,?,'live',?,?)`,
      )
      .run(
        'recon:live1',
        'openrouter_models',
        ITEM_A.base_url,
        ITEM_A.model,
        null,
        '{}',
        1_800_000_000_000,
        1_800_000_000_000,
      );
    const r = recon.reconcile();
    assert.deepEqual(r.promoted, []);
    assert.deepEqual(r.retired, []);
  });
});

describe('janitor（MR §4.6 流程 5 后半 + §3.2 体积回收）', () => {
  it('needs_approval 超 7 天无人理会 → expired', () => {
    let clock = 1_800_000_000_000;
    const recon = makeRecon(() => clock);
    tmp.db
      .prepare(
        `INSERT INTO recon_candidate (id, source, base_url, model, api_key_note, evidence, state, found_at, updated_at)
         VALUES (?,?,?,?,?,?,'needs_approval',?,?)`,
      )
      .run(
        'recon:old1',
        'openrouter_models',
        'https://a.example/v1',
        'm:free',
        null,
        '{}',
        clock - 8 * 86_400_000,
        clock - 8 * 86_400_000,
      );
    tmp.db
      .prepare(
        `INSERT INTO recon_candidate (id, source, base_url, model, api_key_note, evidence, state, found_at, updated_at)
         VALUES (?,?,?,?,?,?,'needs_approval',?,?)`,
      )
      .run(
        'recon:new1',
        'openrouter_models',
        'https://b.example/v1',
        'm:free',
        null,
        '{}',
        clock,
        clock,
      );
    const r = recon.janitor();
    assert.equal(r.expired, 1);
    assert.equal(rows(`SELECT state FROM recon_candidate WHERE id='recon:old1'`)[0]?.state, 'expired');
    assert.equal(
      rows(`SELECT state FROM recon_candidate WHERE id='recon:new1'`)[0]?.state,
      'needs_approval',
    );
  });

  it('expired/retired 超 90 天 → 物理删除', () => {
    let clock = 1_800_000_000_000;
    const recon = makeRecon(() => clock);
    for (const id of ['recon:e1', 'recon:r1']) {
      tmp.db
        .prepare(
          `INSERT INTO recon_candidate (id, source, base_url, model, api_key_note, evidence, state, found_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          'openrouter_models',
          `https://${id}.example/v1`,
          'm:free',
          null,
          '{}',
          id === 'recon:e1' ? 'expired' : 'retired',
          clock - 100 * 86_400_000,
          clock - 100 * 86_400_000,
        );
    }
    // 一条刚 expired 的（90 天内）不该被删
    tmp.db
      .prepare(
        `INSERT INTO recon_candidate (id, source, base_url, model, api_key_note, evidence, state, found_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'recon:e2',
        'openrouter_models',
        'https://e2.example/v1',
        'm:free',
        null,
        '{}',
        'expired',
        clock - 80 * 86_400_000,
        clock - 80 * 86_400_000,
      );
    const r = recon.janitor();
    assert.equal(r.deleted, 2, '只删 100 天前的两条');
    assert.equal(rows(`SELECT COUNT(*) AS n FROM recon_candidate`)[0]?.n, 1);
  });
});
