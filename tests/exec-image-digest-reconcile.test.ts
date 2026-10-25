/**
 * tests/exec-image-digest-reconcile.test.ts —— ensureImage 以 docker 实况校正账上 digest。
 *
 * 现场（2026-10-25）：宿主侧 `scripts/rebuild-image.sh` 用**同一个 tag** 重建镜像
 * （`dotd/exec:slim-0.2.1`），构建成功、tag 也指向新镜像了，但 `image_builds` 里最新
 * 的 ready 行还是旧 digest。`ensureImage()` 秒回旧 digest，`buildSpec()` 又用
 * `digest ?? tag` 建容器 —— 容器一直在旧镜像里跑，而漂移检测比较的正是"旧 digest
 * vs 旧容器 ImageID"，两边一致所以连漂移都不报。结果是"重建永远不生效"，只能手工改库。
 *
 * 修法：docker 是真相、image_builds 只是缓存。秒回前 `imageId(tag)` 问一次实况，
 * 不一致就回写。取不到实况（stub / 404）保持原值，绝不凭猜测改账。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ImageManager } from '../src/exec/image.ts';
import { EventBus } from '../src/shared/bus.ts';
import { makeTempDataDir } from './helpers.ts';

const TAG = 'dotd/exec:slim-0.2.1';
const OLD = 'sha256:' + '1'.repeat(64);
const NEW = 'sha256:' + '2'.repeat(64);

function makeManager(tmp: ReturnType<typeof makeTempDataDir>, imageId: () => Promise<string | null>) {
  const bus = new EventBus();
  const lines: string[] = [];
  bus.on('exec.image.build', (e: { payload: unknown }) => {
    lines.push(JSON.stringify(e.payload));
  });
  const mgr = new ImageManager({
    db: tmp.db,
    bus,
    cfg: { baseImageTag: 'slim', runtimeVer: '0.2.1', logTailChars: 100, repoRoot: '', dockerSocketPath: '' },
    backend: {
      kind: 'docker',
      hasImage: async () => true,
      imageId,
      buildImage: async () => {
        throw new Error('不应触发构建');
      },
    },
  } as unknown as ConstructorParameters<typeof ImageManager>[0]);
  return { mgr, lines };
}

function seedReady(tmp: ReturnType<typeof makeTempDataDir>, digest: string): number {
  const now = new Date().toISOString();
  const ins = tmp.db
    .prepare(
      `INSERT INTO image_builds (tag, digest, base_image_tag, status, log_tail, started_at, finished_at)
       VALUES (?, ?, 'slim', 'ready', '', ?, ?)`,
    )
    .run(TAG, digest, now, now);
  return Number(ins.lastInsertRowid);
}

test('账上 digest 与 tag 实况不一致 → 返回实况并回写账本', async () => {
  const tmp = makeTempDataDir();
  try {
    const id = seedReady(tmp, OLD);
    const { mgr, lines } = makeManager(tmp, async () => NEW);
    const r = await mgr.ensureImage();
    assert.deepEqual(r, { tag: TAG, digest: NEW, ready: true, built: false });
    const row = tmp.db.prepare('SELECT digest FROM image_builds WHERE id = ?').get(id) as { digest: string };
    assert.equal(row.digest, NEW, '账本必须回写成 docker 实况');
    assert.equal(lines.length, 1, '回写要留一条构建通道日志（否则排障时看不出账被改过）');
    assert.match(lines[0] ?? '', /以 docker 为准/);
  } finally {
    tmp.cleanup();
  }
});

test('账上 digest 与实况一致 → 秒回且不写库', async () => {
  const tmp = makeTempDataDir();
  try {
    const id = seedReady(tmp, OLD);
    const { mgr, lines } = makeManager(tmp, async () => OLD);
    const r = await mgr.ensureImage();
    assert.equal(r.digest, OLD);
    assert.equal(r.built, false);
    assert.equal(lines.length, 0);
    const row = tmp.db.prepare('SELECT digest FROM image_builds WHERE id = ?').get(id) as { digest: string };
    assert.equal(row.digest, OLD);
  } finally {
    tmp.cleanup();
  }
});

test('取不到实况（null）→ 保持账上 digest，不猜、不改库', async () => {
  const tmp = makeTempDataDir();
  try {
    const id = seedReady(tmp, OLD);
    const { mgr } = makeManager(tmp, async () => null);
    const r = await mgr.ensureImage();
    assert.deepEqual(r, { tag: TAG, digest: OLD, ready: true, built: false });
    const row = tmp.db.prepare('SELECT digest FROM image_builds WHERE id = ?').get(id) as { digest: string };
    assert.equal(row.digest, OLD);
  } finally {
    tmp.cleanup();
  }
});

test('imageId 抛错 → 同上，异常不得把 boot 打挂', async () => {
  const tmp = makeTempDataDir();
  try {
    seedReady(tmp, OLD);
    const { mgr } = makeManager(tmp, async () => {
      throw new Error('docker 抖动');
    });
    const r = await mgr.ensureImage();
    assert.equal(r.digest, OLD);
    assert.equal(r.ready, true);
  } finally {
    tmp.cleanup();
  }
});
