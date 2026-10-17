/**
 * tests/memory-limits.test.ts —— 文件记忆策略层限额（§3.4）与
 * 写前/原子写检查点（§5.2 检查点 1+2）+ 维护用检索（§5.2 检查点 3）。
 *
 * 依据（行号指 docs/design/modules/memory.md）：
 * - §3.4 大小上限表：软限（告警）/ 硬限（拒绝/强制整理）逐行。
 *   rev2「与执行面限额的关系」：EX 物理兜底（fs.read≤4MB/fs.write≤8MB/home 卷 2GB）保留不动，
 *   本表是策略层、全部严于兜底；冲突时以更严者生效（接缝契约 M6 同款裁定）。
 * - §3.4 末段：一个 20 KB 的 note 会被记忆层拒绝，即使 fs.write 允许——
 *   即 checkFileLimits 返回 error='HARD_LIMIT' 而非放行。
 * - §3.4 告警实现：写工具返回值附 {warning:"MEMORY.md 3.1/4 KB，建议合并 Interests 第4、7条"}。
 * - §3.2 格式约定：notes 命名 `YYYY-MM-DD-<kebab-slug>.md`（月度摘要 `YYYY-MM-digest.md`、
 *   `_compactions.md` 下划线留痕不计入文件数上限）。
 * - §5.2 检查点 1：fs.write 前调 beforeWrite；检查点 2：atomicWrite 返回 tmp+rename 计划，
 *   commitAtomicWrite 经 /fs/ops rename 落规范路径（契约 S4'）；
 *   检查点 3：searchHome 是维护用检索，不进模型工具面（避免双轨检索）。
 * - §3.4 只读期：home 全量超硬限 → 进入只读期，整理后放行。
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { MemoryServiceImpl } from '../src/memory/MemoryService.ts';
import { makeStubFsOpsBridge } from '../src/memory/fsops-stub.ts';
import type { StubFsOpsBridge } from '../src/memory/fsops-stub.ts';
import {
  LIMIT_MEMORY_MD,
  LIMIT_NOTE_OR_MANUAL,
  LIMIT_NOTES_COUNT,
  checkFileLimits,
  classifyHomeArea,
  isManualPath,
  isNotePath,
  isReservedPath,
  normalizeHomePath,
} from '../src/memory/limits.ts';

let tmp: TempDataDir;
let bridge: StubFsOpsBridge;
let mem: MemoryServiceImpl;

beforeEach(() => {
  tmp = makeTempDataDir();
  bridge = makeStubFsOpsBridge();
  mem = new MemoryServiceImpl({ db: tmp.db, bridge, outboxPath: tmp.outboxPath });
});

afterEach(() => {
  tmp.cleanup();
});

// ═══════════════════════════════════════════════════════════════════
// §1 路径域（§3.2 / §6.2 索引范围）
// ═══════════════════════════════════════════════════════════════════

describe('normalizeHomePath / classifyHomeArea / isReservedPath（§6.2）', () => {
  it('拒绝绝对路径、盘符、.. 逃逸', () => {
    assert.equal(normalizeHomePath('/etc/passwd'), null);
    assert.equal(normalizeHomePath('C:\\x'), null);
    assert.equal(normalizeHomePath('../escape.md'), null);
    assert.equal(normalizeHomePath('a/../../b.md'), null);
    assert.equal(normalizeHomePath(''), null);
  });

  it('统一正斜杠、去掉前导 ./', () => {
    assert.equal(normalizeHomePath('./MEMORY.md'), 'MEMORY.md');
    assert.equal(normalizeHomePath('notes\\2026-01-01-a.md'), 'notes/2026-01-01-a.md');
  });

  it('classifyHomeArea：仅 MEMORY.md/notes/*.md/manuals/**/*.md 入索', () => {
    assert.equal(classifyHomeArea('MEMORY.md'), 'memory');
    assert.equal(classifyHomeArea('notes/2026-01-01-a.md'), 'notes');
    assert.equal(classifyHomeArea('manuals/deploy/wsl.md'), 'manuals');
    assert.equal(classifyHomeArea('notes/2026-01-01-a.txt'), null);
    assert.equal(classifyHomeArea('random.md'), null);
  });

  it('保留前缀永不入索：.archive/.tmp/.dotd', () => {
    assert.equal(isReservedPath('.tmp/x.md'), true);
    assert.equal(isReservedPath('.archive/outbox-1.md'), true);
    assert.equal(isReservedPath('.dotd/state.json'), true);
    assert.equal(isReservedPath('MEMORY.md'), false);
    assert.equal(classifyHomeArea('.archive/notes/2026-01-01-a.md'), null);
    assert.equal(classifyHomeArea('.tmp/foo.md'), null);
  });

  it('notes 子目录不算 notes 区（§3.2 notes/ 扁平）', () => {
    assert.equal(classifyHomeArea('notes/sub/a.md'), null);
  });

  it('isNotePath 认规范名 + 月度摘要 + 下划线留痕', () => {
    assert.equal(isNotePath('notes/2026-01-01-wsl-deploy.md'), true);
    assert.equal(isNotePath('notes/2026-01-digest.md'), true);
    assert.equal(isNotePath('notes/_compactions.md'), true);
    assert.equal(isNotePath('notes/随意命名.md'), false);
    assert.equal(isNotePath('notes/2026-1-01-a.md'), false, '月/日须两位');
  });

  it('isManualPath 要求至少两层（manuals/<domain>/*.md）', () => {
    assert.equal(isManualPath('manuals/deploy/wsl.md'), true);
    assert.equal(isManualPath('manuals/a.md'), false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// §2 单文件/目录限额（§3.4）
// ═══════════════════════════════════════════════════════════════════

describe('checkFileLimits：单文件软/硬限（§3.4）', () => {
  const empty = { targetBytes: 0, activeBytes: 0, notesCount: 0, manualsBytes: 0, readonlyPhase: false };

  it('20 KB 的 note 被拒（§3.4 末段：策略层严于 EX 物理兜底）', () => {
    const r = checkFileLimits('notes/2026-01-01-big.md', 'x'.repeat(20 * 1024), empty);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'HARD_LIMIT');
    assert.ok(r.warning !== undefined && r.warning.includes('20.0/16.0'), `实际 warning: ${r.warning}`);
  });

  it('MEMORY.md 超软限放行但附精简建议（§3.4 告警文案）', () => {
    const r = checkFileLimits('MEMORY.md', 'x'.repeat(3.5 * 1024), empty);
    assert.equal(r.ok, true, '软限不拒绝');
    assert.ok(r.warning?.includes('3.5/3.0 KB'), `实际 warning: ${r.warning}`);
    assert.ok(r.warning?.includes('建议合并 Interests'), `实际 warning: ${r.warning}`);
  });

  it('note 超软限（8KB）也放行 + 附建议', () => {
    const r = checkFileLimits('notes/2026-01-01-a.md', 'x'.repeat(9 * 1024), empty);
    assert.equal(r.ok, true);
    assert.ok(r.warning?.includes('9.0/8.0 KB'), `实际 warning: ${r.warning}`);
    assert.ok(r.warning?.includes('建议拆分'));
  });

  it('MEMORY.md 超硬限（4KB）拒绝', () => {
    const r = checkFileLimits('MEMORY.md', 'x'.repeat(5 * 1024), empty);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'HARD_LIMIT');
  });

  it('路径不在记忆规范内直接拒（如 random.md / .tmp/x.md）', () => {
    assert.equal(checkFileLimits('random.md', 'x', empty).error, 'HARD_LIMIT');
    assert.equal(checkFileLimits('.tmp/x.md', 'x', empty).error, 'HARD_LIMIT');
  });

  it('note 命名不合规拒绝', () => {
    const r = checkFileLimits('notes/随意.md', 'x', empty);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'HARD_LIMIT');
    assert.ok(r.warning?.includes('YYYY-MM-DD'));
  });

  it('写后大小按"当前占用 - 目标已存在字节 + 新内容字节"算（覆盖旧文件）', () => {
    // 已有 10KB 的旧文件，新内容 3KB → 写后 = activeBytes - 10KB + 3KB
    const r = checkFileLimits(
      'notes/2026-01-01-a.md',
      'x'.repeat(3 * 1024),
      { targetBytes: 10 * 1024, activeBytes: 10 * 1024, notesCount: 1, manualsBytes: 0, readonlyPhase: false },
    );
    assert.equal(r.ok, true, '覆盖后 3KB 不超软限');
    assert.equal(r.warning, undefined);
  });
});

describe('checkFileLimits：目录级限额（§3.4 notes 数 / manuals 合计 / home 全量）', () => {
  it('notes 未归档数超硬限 120 → NOTES_COUNT_LIMIT', () => {
    const r = checkFileLimits('notes/2026-01-01-new.md', 'x', {
      targetBytes: 0,
      activeBytes: 0,
      notesCount: LIMIT_NOTES_COUNT.hard, // 120
      manualsBytes: 0,
      readonlyPhase: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'NOTES_COUNT_LIMIT');
  });

  it('notes 未归档数超软限 60 → 放行 + 建议投递 memory-compaction', () => {
    const r = checkFileLimits('notes/2026-01-01-new.md', 'x', {
      targetBytes: 0,
      activeBytes: 0,
      notesCount: LIMIT_NOTES_COUNT.soft + 1, // 61
      manualsBytes: 0,
      readonlyPhase: false,
    });
    assert.equal(r.ok, true);
    assert.ok(r.warning?.includes('memory-compaction'));
  });

  it('月度摘要/下划线留痕不计入文件数（不触发计数告警）', () => {
    const r = checkFileLimits('notes/2026-01-digest.md', 'x', {
      targetBytes: 0,
      activeBytes: 0,
      notesCount: 200, // 已爆表，但 exempt 文件不受限
      manualsBytes: 0,
      readonlyPhase: false,
    });
    assert.equal(r.ok, true);
    assert.equal(r.warning, undefined);
  });

  it('manuals 合计超硬限 512KB → HARD_LIMIT', () => {
    const r = checkFileLimits('manuals/deploy/x.md', 'x'.repeat(10 * 1024), {
      targetBytes: 0,
      activeBytes: 0,
      notesCount: 0,
      manualsBytes: 510 * 1024,
      readonlyPhase: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'HARD_LIMIT');
    assert.ok(r.warning?.includes('manuals/'));
  });

  it('home 活跃集超硬限 2MB → HOME_CAPACITY', () => {
    const r = checkFileLimits('MEMORY.md', 'x'.repeat(100), {
      targetBytes: 0,
      activeBytes: 2 * 1024 * 1024 + 1,
      notesCount: 0,
      manualsBytes: 0,
      readonlyPhase: false,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'HOME_CAPACITY');
  });

  it('只读期（readonlyPhase）→ READONLY_PHASE，整理后放行', () => {
    const r = checkFileLimits('MEMORY.md', 'x', {
      targetBytes: 0,
      activeBytes: 0,
      notesCount: 0,
      manualsBytes: 0,
      readonlyPhase: true,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'READONLY_PHASE');
  });

  it('home 超软限 1MB → 放行 + 告警', () => {
    const r = checkFileLimits('MEMORY.md', 'x'.repeat(100), {
      targetBytes: 0,
      activeBytes: 1024 * 1024 + 1,
      notesCount: 0,
      manualsBytes: 0,
      readonlyPhase: false,
    });
    assert.equal(r.ok, true);
    assert.ok(r.warning?.includes('home 活跃集'));
  });
});

// ═══════════════════════════════════════════════════════════════════
// §3 检查点 1：MemoryService.beforeWrite（§5.2）
// ═══════════════════════════════════════════════════════════════════

describe('MemoryService.beforeWrite（§5.2 检查点 1）', () => {
  it('从 mem_files_index 汇总当前画像并判定', async () => {
    tmp.db
      .prepare(
        `INSERT INTO mem_files_index (dot_id, path, area, tags, title, size_bytes, mtime_ms)
         VALUES ('dot1', 'MEMORY.md', 'memory', NULL, NULL, 1024, ?)`,
      )
      .run(Date.now());
    const ok = await mem.beforeWrite('dot1', 'MEMORY.md', 'x'.repeat(2048));
    assert.equal(ok.ok, true);

    const tooBig = await mem.beforeWrite('dot1', 'MEMORY.md', 'x'.repeat(5 * 1024));
    assert.equal(tooBig.ok, false);
    assert.equal(tooBig.error, 'HARD_LIMIT');
  });

  it('索引缺失但桥上有真文件 → 用桥 stat 补 targetBytes', async () => {
    bridge.put('notes/2026-01-01-a.md', 'x'.repeat(9 * 1024)); // 索引里没有这行
    // 覆盖写 3KB：若 targetBytes=0 会把 activeBytes 也算错；这里主要验不炸
    const r = await mem.beforeWrite('dot1', 'notes/2026-01-01-a.md', 'x'.repeat(3 * 1024));
    assert.equal(r.ok, true);
  });

  it('非法路径直接拒', async () => {
    const r = await mem.beforeWrite('dot1', '../evil.md', 'x');
    assert.equal(r.ok, false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// §4 检查点 2：atomicWrite / commitAtomicWrite（§5.2 + 契约 S4'）
// ═══════════════════════════════════════════════════════════════════

describe('MemoryService.atomicWrite / commitAtomicWrite（§5.2 检查点 2）', () => {
  it('超限时返回错误计划，不给 tmp 路径', async () => {
    const plan = await mem.atomicWrite('dot1', 'notes/2026-01-01-big.md', 'x'.repeat(20 * 1024));
    assert.equal(plan.ok, false);
    assert.equal(plan.error, 'HARD_LIMIT');
    assert.equal(plan.tmpPath, undefined);
  });

  it('合法时给 .tmp/<ulid>.md 计划，commit 经桥 rename 落规范路径并刷新索引', async () => {
    const plan = await mem.atomicWrite('dot1', 'notes/2026-01-01-wsl.md', '内容');
    assert.equal(plan.ok, true);
    assert.ok(plan.tmpPath !== undefined && plan.tmpPath.startsWith('.tmp/'), `tmpPath: ${plan.tmpPath}`);
    assert.equal(plan.finalPath, 'notes/2026-01-01-wsl.md');

    // 工具层把内容写到 tmp（等价容器内 fs.write），再 commit
    bridge.put(plan.tmpPath!, '内容');
    const ok = await mem.commitAtomicWrite('dot1', plan.tmpPath!, plan.finalPath!);
    assert.equal(ok, true);
    assert.equal(bridge.snapshot()['notes/2026-01-01-wsl.md'], '内容');
    assert.equal(bridge.snapshot()[plan.tmpPath!], undefined, 'tmp 已 rename 走');

    // commit 后索引刷新（§5.2：rename 落规范路径后同步索引）
    const row = tmp.db
      .prepare('SELECT area FROM mem_files_index WHERE path = ?')
      .get('notes/2026-01-01-wsl.md') as { area?: string } | undefined;
    assert.equal(row?.area, 'notes');
  });

  it('rename 失败（源不存在）→ 返回 false，不写索引', async () => {
    const ok = await mem.commitAtomicWrite('dot1', '.tmp/nope.md', 'notes/2026-01-01-x.md');
    assert.equal(ok, false);
    const rows = tmp.db.prepare('SELECT * FROM mem_files_index').all();
    assert.equal(rows.length, 0);
  });

  it('桥不可用 → commit 返回 false（降级，不抛）', async () => {
    const plan = await mem.atomicWrite('dot1', 'notes/2026-01-01-x.md', '内容');
    bridge.availableFlag = false;
    const ok = await mem.commitAtomicWrite('dot1', plan.tmpPath!, plan.finalPath!);
    assert.equal(ok, false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// §5 检查点 3：searchHome（维护用检索，不进模型工具面）
// ═══════════════════════════════════════════════════════════════════

describe('MemoryService.searchHome（§5.2 检查点 3）', () => {
  it('经桥逐文件 LIKE，命中给片段', async () => {
    bridge.put('MEMORY.md', 'updated: 2026-01-01\n\n## Interests\n- WSL 部署');
    bridge.put('notes/2026-01-01-a.md', '记一下 docker 的事');
    await mem.syncFilesIndex('dot1');
    const hits = await mem.searchHome('dot1', 'WSL');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.path, 'MEMORY.md');
    assert.ok(hits[0]!.snippet.includes('WSL'));
  });

  it('无命中返回空数组', async () => {
    bridge.put('MEMORY.md', 'nothing here');
    await mem.syncFilesIndex('dot1');
    assert.deepEqual(await mem.searchHome('dot1', 'zzz'), []);
  });

  it('limit 生效', async () => {
    for (let i = 0; i < 5; i++) bridge.put(`notes/2026-01-0${i + 1}-a.md`, '命中词出现');
    await mem.syncFilesIndex('dot1');
    const hits = await mem.searchHome('dot1', '命中词', { limit: 2 });
    assert.equal(hits.length, 2);
  });

  it('桥不可用 → 空数组（不抛）', async () => {
    bridge.put('MEMORY.md', 'x');
    await mem.syncFilesIndex('dot1');
    bridge.availableFlag = false;
    assert.deepEqual(await mem.searchHome('dot1', 'x'), []);
  });
});

// ═══════════════════════════════════════════════════════════════════
// §6 syncFilesIndex / touchManualsLastUsed（§6.2 对账）
// ═══════════════════════════════════════════════════════════════════

describe('MemoryService.syncFilesIndex（§6.2 心跳增量对账）', () => {
  it('把桥上的规范文件 upsert 进 mem_files_index，并解析 notes/manuals 头', async () => {
    bridge.put('MEMORY.md', 'updated: 2026-01-01');
    bridge.put('notes/2026-01-01-wsl.md', '# WSL 笔记\n\ntags: [deploy, dotd]\n\n正文');
    bridge.put('manuals/deploy/wsl.md', '# WSL 手册\n\ndomain: deploy\n');
    const r = await mem.syncFilesIndex('dot1');
    assert.equal(r.dotId, 'dot1');
    assert.equal(r.scanned, 3);
    assert.equal(r.added, 3);
    assert.equal(r.errors.length, 0);

    const rows = tmp.db
      .prepare('SELECT path, area, tags, title FROM mem_files_index ORDER BY path')
      .all() as Array<{ path?: string; area?: string; tags?: string | null; title?: string | null }>;
    assert.deepEqual(
      rows.map((x) => x.path),
      ['MEMORY.md', 'manuals/deploy/wsl.md', 'notes/2026-01-01-wsl.md'],
    );
    const note = rows.find((x) => x.path === 'notes/2026-01-01-wsl.md')!;
    assert.deepEqual(JSON.parse(note.tags ?? '[]'), ['deploy', 'dotd']);
    assert.equal(note.title, 'WSL 笔记');
  });

  it('保留前缀与不合规路径不入索', async () => {
    bridge.put('.tmp/residue.md', 'x');
    bridge.put('.archive/old.md', 'x');
    bridge.put('notes/sub/a.md', 'x');
    bridge.put('random.md', 'x');
    const r = await mem.syncFilesIndex('dot1');
    assert.equal(r.added, 0, '无一入索');
  });

  it('删掉的文件从索引移除（removed）', async () => {
    bridge.put('notes/2026-01-01-a.md', 'x');
    await mem.syncFilesIndex('dot1');
    // stub 桥没有 delete；用 rename 把它移出索引域模拟"文件没了"
    await bridge.rename('dot1', 'notes/2026-01-01-a.md', '.archive/gone.md');
    const r = await mem.syncFilesIndex('dot1');
    assert.equal(r.removed, 1);
    const rows = tmp.db.prepare('SELECT * FROM mem_files_index').all();
    assert.equal(rows.length, 0);
  });

  it('桥不可用 → errors 记 bridge_unavailable，不炸', async () => {
    bridge.availableFlag = false;
    const r = await mem.syncFilesIndex('dot1');
    assert.deepEqual(r.errors, ['bridge_unavailable']);
    assert.equal(r.added, 0);
  });

  it('.tmp/ 中 mtime>1 天的残留经 rename 移入 .archive/tmp-residue/（§6.2）', async () => {
    const now = Date.now();
    bridge.put('.tmp/stale.md', '残留', now - 3 * 24 * 60 * 60 * 1000); // 3 天前
    bridge.put('.tmp/fresh.md', '新鲜', now); // 现在
    const r = await mem.syncFilesIndex('dot1');
    assert.deepEqual(r.tmpResidueMoved, ['.tmp/stale.md']);
    const snap = bridge.snapshot();
    assert.equal(snap['.tmp/stale.md'], undefined, '旧残留已移走');
    assert.equal(snap['.archive/tmp-residue/stale.md'], '残留');
    assert.equal(snap['.tmp/fresh.md'], '新鲜', '新残留不动');
  });

  it('重复跑幂等（第二次 scanned 相同，added=0）', async () => {
    bridge.put('MEMORY.md', 'x');
    const r1 = await mem.syncFilesIndex('dot1');
    const r2 = await mem.syncFilesIndex('dot1');
    assert.equal(r1.added, 1);
    assert.equal(r2.added, 0);
    assert.equal(r2.scanned, 1);
  });
});

describe('MemoryService.touchManualsLastUsed（§4.3 / §3.5 老化判据）', () => {
  it('只刷新 manuals 的 mtime_ms', async () => {
    tmp.db
      .prepare(
        `INSERT INTO mem_files_index (dot_id, path, area, tags, title, size_bytes, mtime_ms)
         VALUES ('dot1', 'manuals/deploy/wsl.md', 'manuals', NULL, NULL, 5, 1000)`,
      )
      .run();
    await mem.touchManualsLastUsed('dot1', ['manuals/deploy/wsl.md']);
    const row = tmp.db
      .prepare('SELECT mtime_ms FROM mem_files_index WHERE path = ?')
      .get('manuals/deploy/wsl.md') as { mtime_ms?: number } | undefined;
    assert.ok((row?.mtime_ms ?? 0) > 1000);
  });
});
