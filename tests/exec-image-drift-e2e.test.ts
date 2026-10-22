/**
 * tests/exec-image-drift-e2e.test.ts —— F9/F4 的**端到端**回归（2026-10-22）。
 *
 * 与 exec-image-drift.test.ts 的分工：那边测纯函数判定与源码接线，这边测
 * 「boot 真的会把跑旧镜像的容器重建掉」和「回收镜像真的会绕开还在用的那份」。
 *
 * 为什么必须有这条：现场 bug 的形状就是「代码看起来对、线上没生效」——
 * exec-image 已换 node:24-slim，而 boot 日志写"容器已就绪"，容器内 node 还是 v22、
 * /ms-playwright 还占 1.4GB。纯函数测试抓不住这种漏接线的情况（本轮项目吃过两次）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { makeTempDataDir } from './helpers.ts';
import { ExecServiceImpl } from '../src/exec/ExecService.ts';
import { ImageManager } from '../src/exec/image.ts';
import { createStubBackend } from '../src/exec/fleet.ts';
import { DEFAULT_EXEC_CONFIG } from '../src/exec/types.ts';

const PLACEHOLDER = `sha256:${'0'.repeat(64)}`;
/** stub 后端 buildImage 返回的就是全零占位 digest，"在用/期望"都拿它当当前镜像标识。 */

function stubOf(svc: ExecServiceImpl): {
  seedContainer(c: {
    id: string;
    state?: string;
    labels?: Record<string, string>;
    name?: string;
    image?: string;
  }): void;
  listAll(): Array<{ id: string; status: string; spec: unknown }>;
} {
  return (svc as unknown as { backend: never }).backend as never;
}

test('F9 端到端：容器在跑但用的是旧镜像 → boot 必须重建它，不能再 adopted', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    const first = await svc.boot(['dot-a']);
    assert.deepEqual(first.created, ['dot-a'], '前置条件：首次 boot 建出容器');
    const row = svc.fleet.getContainer('dot-a');
    assert.ok(row !== null && row.docker_container_id !== null, '前置条件：账上有 docker id');
    const oldDockerId = row.docker_container_id;

    // 实况注入：把"这个容器其实是用另一个镜像建的"这件事做出来。
    // 保留同一个 docker id 与 running 状态 —— 这正是 2026-10-22 线上那台
    // dotd-dot-dot1 的形状（容器 Up、/healthz 通，但镜像是旧的 fb98ec90ef9e）。
    const OTHER = `sha256:${'b'.repeat(64)}`;
    stubOf(svc).seedContainer({
      id: oldDockerId,
      name: 'dotd-dot-dot-a',
      state: 'running',
      labels: { 'dotd.managed': '1', 'dotd.dot': 'dot-a' },
      image: OTHER,
    });

    const again = await svc.boot(['dot-a']);
    assert.ok(!again.adopted.includes('dot-a'), `漂移的容器不能被采纳：adopted=${JSON.stringify(again.adopted)}`);
    assert.ok(again.recreated.includes('dot-a'), `必须走重建：recreated=${JSON.stringify(again.recreated)}`);
    assert.ok(
      again.warnings.some((w) => w.includes('镜像漂移')),
      `必须留下可读告警，否则排障的人只看到"重建了"不知道为什么：${JSON.stringify(again.warnings)}`,
    );
    assert.deepEqual(again.failed, [], `漂移不该变成 boot 失败：${JSON.stringify(again.failed)}`);

    const after = svc.fleet.getContainer('dot-a');
    assert.equal(after?.state, 'ready', '重建后应回到 ready');
    assert.notEqual(after?.docker_container_id, oldDockerId, '必须是新容器（旧的那台是旧镜像）');
  } finally {
    t.cleanup();
  }
});

test('F9 反例守卫：镜像一致时不许重建（防"每次都重建"这种过度修复）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    const first = await svc.boot(['dot-a']);
    const dockerId = svc.fleet.getContainer('dot-a')?.docker_container_id ?? '';

    // 同一个镜像标识（stub 构建出的占位 digest）→ 不是漂移
    stubOf(svc).seedContainer({
      id: dockerId,
      name: 'dotd-dot-dot-a',
      state: 'running',
      labels: { 'dotd.managed': '1', 'dotd.dot': 'dot-a' },
      image: PLACEHOLDER,
    });

    const again = await svc.boot(['dot-a']);
    assert.ok(again.adopted.includes('dot-a'), `镜像没变就该原样接管：adopted=${JSON.stringify(again.adopted)}`);
    assert.deepEqual(again.recreated, [], '不该重建：每次 boot 重建一次是比原 bug 更糟的修复');
    assert.equal(svc.fleet.getContainer('dot-a')?.docker_container_id, dockerId, '容器必须还是那一台');
  } finally {
    t.cleanup();
  }
});

test('F9 反例守卫 2：实况拿不到镜像标识 → 不判漂移（没证据不动生产容器）', async () => {
  const t = makeTempDataDir();
  try {
    const svc = new ExecServiceImpl({ db: t.db, bus: t.bus, cfg: { tokenDir: t.root } });
    await svc.boot(['dot-a']);
    const dockerId = svc.fleet.getContainer('dot-a')?.docker_container_id ?? '';
    // 不传 image：等于 docker 侧这个字段读不到
    stubOf(svc).seedContainer({
      id: dockerId,
      name: 'dotd-dot-dot-a',
      state: 'running',
      labels: { 'dotd.managed': '1', 'dotd.dot': 'dot-a' },
    });
    const again = await svc.boot(['dot-a']);
    assert.ok(again.adopted.includes('dot-a'), '读不到标识时应按原逻辑接管');
    assert.deepEqual(again.recreated, [], '绝不能因为"判断不了"就重建容器');
  } finally {
    t.cleanup();
  }
});

test('F4 端到端：构建新镜像后，仍有容器在用的旧镜像不许删（那是唯一退路）', async () => {
  const t = makeTempDataDir();
  try {
    const cfg = { ...DEFAULT_EXEC_CONFIG, tokenDir: t.root };
    const be = createStubBackend({ cfg });
    const OLD_IN_USE = 'dotd/exec:1.49.1-0.1.0'; // 现网容器就是用它建的
    const OLD_UNUSED = 'dotd/exec:0.0.0-0.1.0'; // 真正的历史垃圾
    be.seedContainer({
      id: 'live1',
      name: 'dotd-dot-dot1',
      state: 'running',
      labels: { 'dotd.managed': '1' },
      image: OLD_IN_USE,
    });
    be.seedImage(OLD_IN_USE);
    be.seedImage(OLD_UNUSED);

    const ins = t.db.prepare(
      `INSERT INTO image_builds (tag, digest, base_image_tag, status, log_tail, started_at, finished_at)
       VALUES (?, ?, ?, 'ready', '', ?, ?)`,
    );
    const now = new Date().toISOString();
    ins.run(OLD_IN_USE, `sha256:${'a'.repeat(64)}`, '1.49.1', now, now);
    ins.run(OLD_UNUSED, `sha256:${'c'.repeat(64)}`, '1.49.1', now, now);

    const mgr = new ImageManager({
      db: t.db,
      bus: t.bus,
      cfg,
      backend: be,
    } as unknown as ConstructorParameters<typeof ImageManager>[0]);

    const r = await mgr.ensureImage();
    assert.equal(r.ready, true, '前置条件：当前镜像构建成功');

    assert.equal(await be.hasImage(OLD_IN_USE), true, '有容器在用的镜像必须留着（删了就无路可退）');
    assert.equal(await be.hasImage(OLD_UNUSED), false, '没人在用的旧镜像仍要回收（否则这条保护变成永不删）');
    const st = t.db
      .prepare('SELECT status FROM image_builds WHERE tag = ?')
      .get(OLD_IN_USE) as { status?: string } | undefined;
    assert.equal(st?.status, 'superseded', '在用的那份要降级但保留本体');
  } finally {
    t.cleanup();
  }
});