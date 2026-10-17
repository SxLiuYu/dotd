/**
 * tests/router-pool.test.ts —— Tier3 池：两级测试、合格证、频率守卫、YAML 往返。
 *
 * 依据（docs/design/modules/model-router.md，行号为该文档内位置）：
 * - §4.4 第 1 条 health：`GET {base_url}/models` 5s 超时，期望 200 且 JSON 数组含
 *   声明模型名；失败 → 向 light/primary 两轨各记一个 `pool_unverified` 样本。
 * - §4.4 第 2 条 tool_roundtrip：两轮（tool_choice 定点 echo + auto 续话），每 round
 *   20s；任一轮超时/格式非法 → 失败 kind=bad_protocol；成功 → 写合格证（last_verified）。
 * - §4.4 频率守卫：同端点 tool_roundtrip 每 15min 至多一次。
 * - §4.4 记账：测试请求计 breaker_sample，**不计 model_call_log**（probe=true）。
 * - §4.6 第 4 步：批准后写 free-models.yml，同 base_url+model 幂等（只 touch updated_at）。
 * - §2.2：合格证默认过期 24h（verify_staleness_ms）。
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeTempDataDir, type TempDataDir } from './helpers.ts';
import {
  POOL_ROUNDTRIP_GUARD_MS,
  PoolManager,
  parseFreeModelsYaml,
  serializeFreeModelsYaml,
} from '../src/router/pool.ts';
import { StubTransport } from '../src/router/transport.ts';
import { ModelRouter } from '../src/router/ModelRouter.ts';
import type { EndpointDef } from '../src/shared/contracts.ts';
import type { ChatOutcome, GetOutcome, ModelTransport } from '../src/router/types.ts';

/**
 * 可控 fake transport（池探测专用）。
 *
 * StubTransport.get 对 /models 只能给固定形状（{data:[]} 或 {status:'ok'}），构造不出
 * "含声明模型名"的成功分支；PoolManager 只依赖 ModelTransport 的 get/chat 两个方法，
 * 故在测试里手写一个最小 fake，把 health 的三种返回（含模型/不含模型/非 2xx）都覆盖。
 */
function makeFakeTransport(
  getImpl: (url: string) => GetOutcome,
  chatImpl?: () => ChatOutcome,
): ModelTransport {
  return {
    async get(_ep: EndpointDef, url: string): Promise<GetOutcome> {
      return getImpl(url);
    },
    async chat(): Promise<ChatOutcome> {
      if (chatImpl === undefined) throw new Error('fake transport: 未预置 chat');
      return chatImpl();
    },
    stream(): never {
      throw new Error('fake transport: 池探测不走流式');
    },
    async metadata() {
      return { ok: false, items: [], error: 'fake' };
    },
  } as ModelTransport;
}

let tmp: TempDataDir;
let cfgDir: string;

beforeEach(() => {
  tmp = makeTempDataDir();
  cfgDir = join(tmp.root, 'config');
  mkdirSync(cfgDir, { recursive: true });
});

afterEach(() => {
  tmp.cleanup();
});

/** 造一个 PoolManager（时钟可注入）。 */
function makePool(now: () => number = Date.now): { pool: PoolManager; path: string } {
  const path = join(cfgDir, 'free-models.yml');
  const pool = new PoolManager({ db: tmp.db, now });
  pool.loadFile(path);
  return { pool, path };
}

/** 池条目 → EndpointDef（tier 3）。 */
function poolEp(id: string, over: Partial<EndpointDef> = {}): EndpointDef {
  return {
    id,
    tier: 3,
    baseUrl: 'https://pool.example/api/v1',
    apiKeyEnv: null,
    models: { primary: 'vendor/free-model', light: 'vendor/free-model' },
    style: 'openai',
    enabled: true,
    timeouts: { connect_ms: 1000, idle_ms: 5000, total_ms: 10_000 },
    emergencyEligible: true,
    ...over,
  };
}

/** 一份含一个池条目的 free-models.yml 文本。 */
function poolYaml(lastVerified: number | null): string {
  return `version: 1
updated_at: null
models:
  - id: pool-free-1
    base_url: https://pool.example/api/v1
    api_key_env: none
    models: [vendor/free-model]
    style: openai
    capabilities: { tool_calling: unknown, context: 0 }
    last_verified: ${lastVerified === null ? 'null' : new Date(lastVerified).toISOString()}
    verify_staleness_ms: 86400000
    emergency_eligible: true
`;
}

/** 测试专用查询助手（node:sqlite 的绑定参数只接受标量/ Buffer/ null）。 */
function rows(sql: string, ...args: Array<string | number | null>): Array<Record<string, unknown>> {
  return tmp.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
}

describe('health 探测（MR §4.4 第 1 条）', () => {
  it('/models 200 且含声明模型 → ok，落 pool_probe_result(health,1)', async () => {
    const { pool } = makePool();
    const stub = makeFakeTransport(() => ({
      ok: true,
      status: 200,
      json: { data: [{ id: 'vendor/free-model' }, { id: 'other/model' }] },
      latencyMs: 4,
    }));
    const r = await pool.probeHealth(stub, poolEp('pool-free-1'));
    assert.equal(r.ok, true, r.detail);
    assert.match(r.detail, /health 通过/);
    const pr = rows(`SELECT probe_kind, ok FROM pool_probe_result WHERE endpoint_id='pool-free-1'`);
    assert.equal(pr.length, 1);
    assert.equal(pr[0]?.probe_kind, 'health');
    assert.equal(pr[0]?.ok, 1);
  });

  it('/models 200 但不含声明模型 → health 失败（判据是"含模型名"）', async () => {
    const { pool } = makePool();
    const stub = makeFakeTransport(() => ({
      ok: true,
      status: 200,
      json: { data: [{ id: 'vendor/other-model' }] },
      latencyMs: 4,
    }));
    const r = await pool.probeHealth(stub, poolEp('pool-free-1'));
    assert.equal(r.ok, false);
    assert.match(r.detail, /health 失败/);
    assert.equal(
      Number(rows(`SELECT ok FROM pool_probe_result WHERE endpoint_id='pool-free-1'`)[0]?.ok),
      0,
    );
  });

  it('/models 503 → health 失败', async () => {
    const { pool } = makePool();
    const stub = new StubTransport();
    // 借 local 预置把 health 打成 503（stub.get 的 local 分支）
    stub.setLocal('pool-free-1', { health: false });
    const r = await pool.probeHealth(stub, poolEp('pool-free-1'));
    assert.equal(r.ok, false);
    assert.match(r.detail, /HTTP 503/);
  });

  it('health 失败在 ModelRouter 里向两轨各记 pool_unverified（§4.4 逐字）', async () => {
    const path = join(cfgDir, 'free-models.yml');
    writeFileSync(path, poolYaml(null), 'utf8');
    writeConfigWithPool();
    const stub = new StubTransport();
    stub.setLocal('pool-free-1', { health: false });
    const router = ModelRouter.load({
      db: tmp.db,
      configDir: cfgDir,
      scheduler: { registerInternalJob: () => {} },
      channels: null,
      bus: tmp.bus,
      transport: stub,
    });
    await router.runPoolProbe('pool-free-1');
    const s = rows(
      `SELECT track, ok, kind FROM breaker_sample WHERE endpoint_id='pool-free-1' AND kind='pool_unverified'`,
    );
    assert.equal(s.length, 2, 'light + primary 两轨各一条');
    assert.deepEqual(
      s.map((r) => r.track).sort(),
      ['light', 'primary'],
    );
    router.dispose();
  });
});

describe('tool_roundtrip 两级测试（MR §4.4 第 2 条）', () => {
  it('round1 echo 定点 + round2 auto 续话都过 → 写合格证', async () => {
    let clock = 1_800_000_000_000;
    const { pool, path } = makePool(() => clock);
    writeFileSync(path, poolYaml(null), 'utf8');
    pool.loadFile(path);
    const stub = new StubTransport({
      script: [
        // round1：tool_choice=required → 必须回 echo 且参数 text=ping-dotd
        {
          endpointId: 'pool-free-1',
          track: 'primary',
          content: '',
          toolCalls: [{ id: 'call_probe_1', name: 'echo', arguments: '{"text":"ping-dotd"}' }],
        },
        // round2：tool_choice=auto → 非空 content
        { endpointId: 'pool-free-1', track: 'primary', content: 'pong' },
      ],
    });
    const r = await pool.toolRoundtrip(stub, poolEp('pool-free-1'));
    assert.equal(r.ok, true, r.detail);
    assert.equal(pool.hasFreshCertification(pool.findEntry('pool-free-1')!), true, '合格证已写');

    // 合格证落文件（§4.4 末句：原子写文件 + 同步内存态）
    const text = readFileSync(path, 'utf8');
    assert.match(text, /last_verified:/);
    assert.ok(!/last_verified:\s*null/.test(text), '不再是 null');
    const pr = rows(
      `SELECT probe_kind, ok FROM pool_probe_result WHERE endpoint_id='pool-free-1' AND probe_kind='tool_roundtrip'`,
    );
    assert.equal(pr.length, 1);
    assert.equal(pr[0]?.ok, 1);
  });

  it('round1 工具名不对 → bad_protocol 且不写证', async () => {
    const { pool } = makePool();
    const path = join(cfgDir, 'free-models.yml');
    writeFileSync(path, poolYaml(null), 'utf8');
    pool.loadFile(path);
    const stub = new StubTransport({
      script: [
        {
          endpointId: 'pool-free-1',
          track: 'primary',
          content: '',
          toolCalls: [{ id: 'c1', name: 'not_echo', arguments: '{"text":"ping-dotd"}' }],
        },
      ],
    });
    const r = await pool.toolRoundtrip(stub, poolEp('pool-free-1'));
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'bad_protocol');
    assert.match(r.detail, /round1 未过判据/);
    assert.equal(pool.hasFreshCertification(pool.findEntry('pool-free-1')!), false);
  });

  it('round1 参数 text 不符 → bad_protocol（不能只说"会调工具"）', async () => {
    const { pool } = makePool();
    const path = join(cfgDir, 'free-models.yml');
    writeFileSync(path, poolYaml(null), 'utf8');
    pool.loadFile(path);
    const stub = new StubTransport({
      script: [
        {
          endpointId: 'pool-free-1',
          track: 'primary',
          content: '',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"text":"hello"}' }],
        },
      ],
    });
    const r = await pool.toolRoundtrip(stub, poolEp('pool-free-1'));
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'bad_protocol');
    assert.match(r.detail, /round1 未过判据/);
  });

  it('round1 完全不给工具调用 → bad_protocol', async () => {
    const { pool } = makePool();
    const path = join(cfgDir, 'free-models.yml');
    writeFileSync(path, poolYaml(null), 'utf8');
    pool.loadFile(path);
    const stub = new StubTransport({
      script: [{ endpointId: 'pool-free-1', track: 'primary', content: '我不想调工具' }],
    });
    const r = await pool.toolRoundtrip(stub, poolEp('pool-free-1'));
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'bad_protocol');
  });

  it('round2 content 为空 → bad_protocol（不能吃工具结果继续说话）', async () => {
    const { pool } = makePool();
    const path = join(cfgDir, 'free-models.yml');
    writeFileSync(path, poolYaml(null), 'utf8');
    pool.loadFile(path);
    const stub = new StubTransport({
      script: [
        {
          endpointId: 'pool-free-1',
          track: 'primary',
          content: '',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"text":"ping-dotd"}' }],
        },
        { endpointId: 'pool-free-1', track: 'primary', content: '   ' },
      ],
    });
    const r = await pool.toolRoundtrip(stub, poolEp('pool-free-1'));
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'bad_protocol');
    assert.match(r.detail, /round2 content 为空/);
  });

  it('round1 抛超时 → kind=timeout', async () => {
    const { pool } = makePool();
    const path = join(cfgDir, 'free-models.yml');
    writeFileSync(path, poolYaml(null), 'utf8');
    pool.loadFile(path);
    const stub = new StubTransport({
      script: [
        {
          endpointId: 'pool-free-1',
          track: 'primary',
          content: '',
          fail: Object.assign(new Error('idle timeout'), { kind: 'timeout' }),
        },
      ],
    });
    const r = await pool.toolRoundtrip(stub, poolEp('pool-free-1'));
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'timeout');
    assert.match(r.detail, /round1 失败/);
  });

  it('频率守卫：15min 内第二次直接拒绝，不发任何请求（§4.4 末条）', async () => {
    let clock = 1_800_000_000_000;
    const { pool } = makePool(() => clock);
    const path = join(cfgDir, 'free-models.yml');
    writeFileSync(path, poolYaml(null), 'utf8');
    pool.loadFile(path);
    const stub = new StubTransport({
      script: [
        {
          endpointId: 'pool-free-1',
          track: 'primary',
          content: '',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: '{"text":"ping-dotd"}' }],
        },
        { endpointId: 'pool-free-1', track: 'primary', content: 'pong' },
      ],
    });
    const r1 = await pool.toolRoundtrip(stub, poolEp('pool-free-1'));
    assert.equal(r1.ok, true);
    const callsAfterFirst = stub.calls.length;
    assert.equal(callsAfterFirst, 2, '第一轮两回合');

    // 窗口内：守卫拦下，且一个请求都不发
    clock += POOL_ROUNDTRIP_GUARD_MS - 1000;
    const r2 = await pool.toolRoundtrip(stub, poolEp('pool-free-1'));
    assert.equal(r2.ok, false);
    assert.match(r2.detail, /频率守卫/);
    assert.equal(stub.calls.length, callsAfterFirst, '守卫拦下，未发新请求');

    // 窗口外放行（预置补足第三轮的脚本）
    clock += 2000;
    stub.push('pool-free-1', {
      content: '',
      toolCalls: [{ id: 'c3', name: 'echo', arguments: '{"text":"ping-dotd"}' }],
    });
    stub.push('pool-free-1', { content: 'pong again' });
    const r3 = await pool.toolRoundtrip(stub, poolEp('pool-free-1'));
    assert.equal(r3.ok, true, r3.detail);
    assert.equal(stub.calls.length, callsAfterFirst + 2, '窗口外真发了两回合');
  });
});

describe('合格证新鲜度（MR §2.2/§4.4）', () => {
  it('last_verified 在 verify_staleness_ms 内 → 新鲜', () => {
    const now = 1_800_000_000_000;
    const { pool } = makePool(() => now);
    const f = parseFreeModelsYaml(poolYaml(now - 60_000));
    assert.equal(pool.hasFreshCertification(f.models[0]!), true);
  });

  it('超 24h（默认 staleness）→ 过期', () => {
    const now = 1_800_000_000_000;
    const { pool } = makePool(() => now);
    const f = parseFreeModelsYaml(poolYaml(now - 86_400_001));
    assert.equal(pool.hasFreshCertification(f.models[0]!), false);
  });

  it('从未验证（null）→ 不新鲜', () => {
    const { pool } = makePool();
    const f = parseFreeModelsYaml(poolYaml(null));
    assert.equal(pool.hasFreshCertification(f.models[0]!), false);
  });
});

describe('YAML 解析/序列化往返（MR §2.2）', () => {
  it('parse → serialize → parse 形状不变', () => {
    const text = poolYaml(1_800_000_000_000);
    const f1 = parseFreeModelsYaml(text);
    assert.equal(f1.models.length, 1);
    assert.equal(f1.models[0]?.id, 'pool-free-1');
    assert.equal(f1.models[0]?.base_url, 'https://pool.example/api/v1');
    assert.deepEqual(f1.models[0]?.models, ['vendor/free-model']);
    assert.equal(f1.models[0]?.api_key_env, null, "api_key_env: none → null");
    assert.equal(f1.models[0]?.emergency_eligible, true);
    assert.equal(f1.models[0]?.last_verified, 1_800_000_000_000);

    const f2 = parseFreeModelsYaml(serializeFreeModelsYaml(f1));
    assert.deepEqual(f2.models, f1.models);
  });

  it('注释与空行被忽略', () => {
    const f = parseFreeModelsYaml(`# 头部注释
version: 1

models:
  # 条目注释
  - id: a
    base_url: https://a.example/v1   # 行尾注释
    models: [m1]
    api_key_env: none
`);
    assert.equal(f.models.length, 1);
    assert.equal(f.models[0]?.base_url, 'https://a.example/v1');
    assert.deepEqual(f.models[0]?.models, ['m1']);
  });

  it('多条目 + 多模型行内数组', () => {
    const f = parseFreeModelsYaml(`version: 1
models:
  - id: a
    base_url: https://a.example/v1
    models: [m1, m2]
    api_key_env: none
  - id: b
    base_url: https://b.example/v1
    models: [m3]
    api_key_env: SOME_KEY
`);
    assert.equal(f.models.length, 2);
    assert.deepEqual(f.models[1]?.models, ['m3']);
    assert.equal(f.models[1]?.api_key_env, 'SOME_KEY');
  });
});

describe('批准候选写文件幂等（MR §4.6 第 4 步）', () => {
  it('同 base_url+model 已存在 → 只 touch updated_at，不重复追加', () => {
    const { pool, path } = makePool(() => 1_800_000_000_000);
    writeFileSync(path, poolYaml(null), 'utf8');
    pool.loadFile(path);
    const r1 = pool.addApprovedCandidate({
      id: 'pool-free-1',
      base_url: 'https://pool.example/api/v1',
      model: 'vendor/free-model',
      api_key_env: null,
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.duplicate, true, '已存在 → duplicate');
    assert.equal(pool.findEntry('pool-free-1')?.models.length, 1);

    const r2 = pool.addApprovedCandidate({
      id: 'recon:abcd',
      base_url: 'https://new.example/api/v1',
      model: 'vendor/other-free',
      api_key_env: null,
    });
    assert.equal(r2.ok, true);
    assert.equal(r2.duplicate, false);
    assert.equal(pool.filePairs().length, 2);
    // 池内条目默认 emergency_eligible=true（池本身就是应急档，§2.2）
    assert.equal(pool.findEntry('recon:abcd')?.emergency_eligible, true);
  });

  it('写文件失败 → 进待重写队列，心跳重试成功后出队', () => {
    const { pool } = makePool();
    // 指向一个不可写的路径（用文件当目录，mkdirSync/ writeFileSync 必然失败）
    const blocker = join(cfgDir, 'blocker');
    writeFileSync(blocker, 'not a dir', 'utf8');
    const badPath = join(blocker, 'sub', 'free-models.yml');
    pool.loadFile(badPath);
    const r = pool.addApprovedCandidate({
      id: 'recon:zzz',
      base_url: 'https://x.example/v1',
      model: 'm',
      api_key_env: null,
    });
    assert.equal(r.ok, false);
    assert.equal(pool.pendingFileWriteCount(), 1);
    // 阻塞还在 → 重试仍失败，行留队列
    assert.deepEqual(pool.retryPendingFileWrites(), []);
    assert.equal(pool.pendingFileWriteCount(), 1);
    // 磁盘恢复（清掉阻塞）→ 重试成功出队
    rmSync(blocker, { force: true });
    const done = pool.retryPendingFileWrites();
    assert.deepEqual(done, ['recon:zzz']);
    assert.equal(pool.pendingFileWriteCount(), 0);
  });
});

describe('池探测历史回收（§3.2 体积）', () => {
  it('janitor 删 7 天前的历史，但每端点保留最新一条', async () => {
    let clock = 1_800_000_000_000;
    const { pool } = makePool(() => clock);
    const stub = makeFakeTransport(() => ({
      ok: true,
      status: 200,
      json: { data: [] },
      latencyMs: 1,
    }));
    // 两个端点各造两条"旧"历史（都在 7 天窗口外，且 id 均小于后续探测）
    for (const [id, ts] of [
      ['pool-other', clock - 10 * 86_400_000],
      ['pool-other', clock - 9 * 86_400_000],
    ] as const) {
      tmp.db
        .prepare('INSERT INTO pool_probe_result (endpoint_id, probe_kind, ok, detail, ts) VALUES (?,?,?,?,?)')
        .run(id, 'health', 0, '{}', ts);
    }
    // 3 次新鲜探测（pool-free-1；都在 7 天窗口内）
    for (let i = 0; i < 3; i++) {
      clock += 1000;
      await pool.probeHealth(stub, poolEp('pool-free-1'));
    }
    assert.equal(Number(rows(`SELECT COUNT(*) AS n FROM pool_probe_result`)[0]?.n), 5);

    const removed = pool.janitor();
    // pool-other 的较早那条被删；它的 MAX(id)（较新那条）被豁免保留
    assert.equal(removed, 1);

    const left = rows(`SELECT endpoint_id, ts FROM pool_probe_result ORDER BY id`);
    assert.equal(left.length, 4);
    assert.equal(left[0]?.endpoint_id, 'pool-other', 'pool-other 只留最新一条（MAX(id) 豁免）');
    assert.equal(Number(left[0]?.ts), 1_800_000_000_000 - 9 * 86_400_000);
    assert.ok(
      left.slice(1).every((r) => r.endpoint_id === 'pool-free-1'),
      '3 条新鲜探测全保留（7 天窗口内）',
    );
  });

  it('recordProbe 即时回收：每端点只留最新一条 + 7 天内历史', async () => {
    let clock = 1_800_000_000_000;
    const { pool } = makePool(() => clock);
    const stub = makeFakeTransport(() => ({
      ok: true,
      status: 200,
      json: { data: [] },
      latencyMs: 1,
    }));
    for (let i = 0; i < 3; i++) {
      clock += 1000;
      await pool.probeHealth(stub, poolEp('pool-free-1'));
    }
    assert.equal(Number(rows(`SELECT COUNT(*) AS n FROM pool_probe_result`)[0]?.n), 3, '都在 7 天内，全留');
    // 推进 8 天后再探一次：旧行被即时回收，只留刚写的这条
    clock += 8 * 86_400_000;
    await pool.probeHealth(stub, poolEp('pool-free-1'));
    const left = rows(`SELECT ts FROM pool_probe_result`);
    assert.equal(left.length, 1);
    assert.equal(Number(left[0]?.ts), clock);
  });
});

/** 一份含池端点的 models.yml（用于 ModelRouter 侧断言）。 */
function writeConfigWithPool(): void {
  writeFileSync(
    join(cfgDir, 'models.yml'),
    `version: 1
endpoints:
  - id: cloud-main
    tier: 1
    base_url: https://openrouter.example/api/v1
    api_key_env: OPENROUTER_API_KEY
    models: { primary: vendor/model-a, light: vendor/model-a-mini }
    style: openai
    timeouts: { connect_ms: 1000, idle_ms: 5000, total_ms: 10000 }
    emergency_eligible: true

routing:
  default_track: primary
  light_events: [event.classify]

breaker:
  window_size: 20
  window_ms: 300000
  min_samples: 5
  failure_ratio: 0.5
  consec_failures: 3
  backoff_initial_ms: 60000
  backoff_max_ms: 3600000
  half_open_success_needed: 2
  half_open_max_concurrency: 1
  throttle_max_ms: 120000
  busy_consec_limit: 3

alerts:
  dedup_window_ms: 86400000
  outbox_path: ${join(tmp.root, 'OUTBOX.md').replace(/\\/g, '/')}
  channel_order: [telegram, email, outbox]
  channel_timeout_ms: 10000

recon:
  interval_ms: 21600000
  max_candidates_per_scan: 10
  sources:
    - type: openrouter_models
      filter: ":free"
  candidate_ttl_ms: 604800000
  rejected_cooldown_ms: 2592000000
`,
    'utf8',
  );
}
