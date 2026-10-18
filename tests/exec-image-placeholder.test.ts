/**
 * tests/exec-image-placeholder.test.ts —— stub 模式下写入的占位 digest 不得被真 docker 使用。
 *
 * 现场（2026-10-18）：库是历史遗留的，先从 stub 模式跑过，`image_builds` 里留下多条
 * `status='ready'` + `digest='sha256:000…0'` 的记录。后来切到 `DOTD_FLEET=docker`，
 * boot 拿最新那条 ready 记录的 digest 去 `docker create`，得到
 *
 *     (HTTP code 404) no such container - No such image: sha256:000000…0
 *
 * 连报两次，容器永远起不来。更糟的是 `readyBuild()` 认为"已构建"，所以 rebuild 不会触发，
 * 现象是"daemon 正常起、容器一直 boot 失败"，日志里只有一句 404。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeTempDataDir } from './helpers.ts';
import { ImageManager, isPlaceholderDigest } from '../src/exec/image.ts';

const PLACEHOLDER = 'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const REAL = 'sha256:29f06d0e8ce1b00ad0891f9d19adf0bddac1ec00619ad5f6fd1fb461520c476a';

test('isPlaceholderDigest：全零 sha256 判真，真实 digest 判假', () => {
  assert.equal(isPlaceholderDigest(PLACEHOLDER), true);
  assert.equal(isPlaceholderDigest(PLACEHOLDER.slice('sha256:'.length)), true, '不带前缀的全零也算');
  assert.equal(isPlaceholderDigest(REAL), false);
  assert.equal(isPlaceholderDigest(null), false);
  assert.equal(isPlaceholderDigest(undefined), false);
  assert.equal(isPlaceholderDigest(''), false, '空串不是占位（另走"无 digest"分支）');
});

test('readyBuild：最新一行是占位 digest 时，退回到更早的真实那一行', () => {
  const tmp = makeTempDataDir();
  try {
    const tag = 'dotd/exec:1.49.1-0.1.0';
    const ins = tmp.db.prepare(
      `INSERT INTO image_builds (tag, digest, pw_version, status, log_tail, started_at, finished_at)
       VALUES (?, ?, ?, 'ready', '', ?, ?)`,
    );
    const now = new Date().toISOString();
    // 先真实、后占位（模拟 stub 模式在之后跑过）
    ins.run(tag, REAL, '1.49.1', now, now);
    ins.run(tag, PLACEHOLDER, '1.49.1', now, now);

    const mgr = new ImageManager({
      db: tmp.db,
      cfg: { pwVersion: '1.49.1', runtimeVer: '0.1.0', logTailChars: 100, repoRoot: '', dockerSocketPath: '' },
    } as unknown as ConstructorParameters<typeof ImageManager>[0]);

    const row = mgr.readyBuild(tag);
    assert.ok(row !== null, '应当返回一条可用的 ready 行');
    assert.equal(row.digest, REAL, '必须跳过占位 digest，返回真实的那条');
    assert.notEqual(row.digest, PLACEHOLDER, '绝不能把全零 digest 交给 docker create');
  } finally {
    tmp.cleanup();
  }
});

test('readyBuild：只有占位 digest 时返回 null（触发重建，而不是拿假 ID 去 create）', () => {
  const tmp = makeTempDataDir();
  try {
    const tag = 'dotd/exec:1.49.1-0.1.0';
    const now = new Date().toISOString();
    tmp.db
      .prepare(
        `INSERT INTO image_builds (tag, digest, pw_version, status, log_tail, started_at, finished_at)
         VALUES (?, ?, '1.49.1', 'ready', '', ?, ?)`,
      )
      .run(tag, PLACEHOLDER, now, now);

    const mgr = new ImageManager({
      db: tmp.db,
      cfg: { pwVersion: '1.49.1', runtimeVer: '0.1.0', logTailChars: 100, repoRoot: '', dockerSocketPath: '' },
    } as unknown as ConstructorParameters<typeof ImageManager>[0]);

    assert.equal(mgr.readyBuild(tag), null, '全是占位 → 视为没有可用镜像 → 触发重建');
  } finally {
    tmp.cleanup();
  }
});
