/**
 * tests/memory-inject.test.ts —— 任务开始注入预算（READ-INJECT，§4.2）与
 * 会话重建（§4.1，契约 M1 恢复唯一入口 = buildSessionReplay）。
 *
 * 依据（行号指 docs/design/modules/memory.md）：
 * - §4.2 预算函数：注入内容 = MEMORY.md（≤4KB，经 /fs/ops 桥原文读取，必进）
 *   + manuals 匹配片段（top-2，每篇截前 1KB）+ context_summary + 近 8 条消息；
 *   预算：文件记忆部分 ≤2500 tokens、会话历史部分 ≤4000 tokens；
 *   超预算砍序：manuals 片段 → 消息条数 → context_summary 最后才动。估算统一 chars/3.5。
 * - §3.1 铁律 B：daemon 侧唯一读路径 = /fs/ops 桥；桥不可用 → 本次跳过并在
 *   messages 记 kind='system_error' 注记 + memory_missed=1，不阻塞任务。
 * - §4.1 恢复重建：Runner 重领任务 → load(task.session_id) → 按 §4.2 预算从新到旧
 *   装填，最老未装部分由 summary 兜底（合成 system 消息排最前）。
 *
 * 全部用 StubFsOpsBridge（CONVENTIONS §7 stub 哲学：不起容器、不发 HTTP）。
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { makeTempDataDir } from './helpers.ts';
import type { TempDataDir } from './helpers.ts';
import { MemoryServiceImpl } from '../src/memory/MemoryService.ts';
import { makeStubFsOpsBridge } from '../src/memory/fsops-stub.ts';
import type { StubFsOpsBridge } from '../src/memory/fsops-stub.ts';
import { BUDGET_FILE_MEMORY_TOKENS, BUDGET_SESSION_TOKENS } from '../src/memory/limits.ts';

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

/** 造一个 manuals 索引行（mem_files_index 的 title/tags 参与匹配打分）。 */
function indexManual(path: string, title: string, tags: string[]): void {
  tmp.db
    .prepare(
      `INSERT INTO mem_files_index (dot_id, path, area, tags, title, size_bytes, mtime_ms)
       VALUES ('dot1', ?, 'manuals', ?, ?, 100, ?)`,
    )
    .run(path, JSON.stringify(tags), title, Date.now());
}

describe('buildContextBundle：MEMORY.md 必进（§4.2）', () => {
  it('桥可达时注入 MEMORY.md 原文', async () => {
    bridge.put('MEMORY.md', 'updated: 2026-01-01\n\n## Interests\n- dotd\n');
    const bundle = await mem.buildContextBundle('dot1', '部署 dotd', 4000);
    assert.ok(bundle.memoryMd.includes('Interests'));
    assert.ok(bundle.memoryMd.includes('dotd'));
    assert.ok(bundle.usedTokens > 0);
  });

  it('没有 threadId 时也走文件记忆部分（事件/心跳任务可能还没建 thread）', async () => {
    bridge.put('MEMORY.md', 'x'.repeat(100));
    const bundle = await mem.buildContextBundle('dot1', '任意任务', 4000);
    assert.equal(bundle.memoryMd.length, 100);
    assert.equal(bundle.recentMessages.length, 0);
    assert.equal(bundle.summary, null);
  });

  it('MEMORY.md 超 4KB 时截断（§4.2「≤4KB」）', async () => {
    bridge.put('MEMORY.md', 'a'.repeat(10 * 1024));
    const bundle = await mem.buildContextBundle('dot1', '任务', 4000);
    assert.equal(Buffer.byteLength(bundle.memoryMd, 'utf8'), 4 * 1024);
  });

  it('MEMORY.md 缺失时 memoryMd 为空串但照样返回 bundle（不阻塞）', async () => {
    const bundle = await mem.buildContextBundle('dot1', '任务', 4000);
    assert.equal(bundle.memoryMd, '');
  });
});

describe('buildContextBundle：桥不可用降级（§3.1 铁律 B / §4.2）', () => {
  it('桥不可用 → 仅 SQLite 部分 + 落 system_error 注记 + memory_missed 计数', async () => {
    const t = await mem.create();
    bridge.availableFlag = false;
    const bundle = await mem.buildContextBundle('dot1', '任务', 4000, { threadId: t });
    assert.equal(bundle.memoryMd, '');
    assert.equal(bundle.manualExcerpts.length, 0);

    // §4.2：messages 里记 kind='system_error' 注记
    const loaded = await mem.load(t);
    const note = loaded?.messages.find((m) => m.kind === 'system_error');
    assert.ok(note !== undefined, '应落 system_error 注记');
    assert.ok(note!.content.includes('memoryMissed'));

    // memory_missed 计数 +1（seal.missed）
    const st = await mem.status();
    assert.equal(st.seal.missed, 1);
  });

  it('无桥（NULL bridge）时同样降级', async () => {
    const noBridge = new MemoryServiceImpl({ db: tmp.db });
    const t = await noBridge.create();
    const bundle = await noBridge.buildContextBundle('dot1', '任务', 4000, { threadId: t });
    assert.equal(bundle.memoryMd, '');
    const st = await noBridge.status();
    assert.equal(st.bridge.available, false);
    assert.equal(st.bridge.kind, 'none');
  });
});

describe('buildContextBundle：manuals 关键词匹配（§4.2 朴素匹配 top-2）', () => {
  it('命中标题/路径词的手册优先，取 top-2 且每篇截前 1KB', async () => {
    indexManual('manuals/deploy/wsl.md', 'WSL 部署手册', ['dotd', 'docker']);
    indexManual('manuals/deploy/wsl2.md', 'WSL2 手册', ['dotd']);
    indexManual('manuals/cooking.md', '烹饪', ['food']);
    bridge.put('manuals/deploy/wsl.md', 'w'.repeat(2 * 1024)); // 2KB → 截 1KB
    bridge.put('manuals/deploy/wsl2.md', 'x'.repeat(100));
    bridge.put('manuals/cooking.md', 'y'.repeat(100));

    const bundle = await mem.buildContextBundle('dot1', '把 dotd 部署到 WSL2', 4000);
    assert.equal(bundle.manualExcerpts.length, 2);
    const paths = bundle.manualExcerpts.map((e) => e.path);
    assert.ok(paths.includes('manuals/deploy/wsl.md'), '命中 WSL + 部署 的排前');
    assert.ok(paths.includes('manuals/deploy/wsl2.md'));
    assert.ok(!paths.includes('manuals/cooking.md'), '不命中烹饪');
    const wsl = bundle.manualExcerpts.find((e) => e.path === 'manuals/deploy/wsl.md')!;
    assert.equal(wsl.text.length, 1024, '每篇截前 1KB');
  });

  it('任务文本无命中 → 不硬塞 manuals', async () => {
    indexManual('manuals/cooking.md', '烹饪', ['food']);
    bridge.put('manuals/cooking.md', '菜谱');
    const bundle = await mem.buildContextBundle('dot1', '修数据库索引', 4000);
    assert.equal(bundle.manualExcerpts.length, 0);
  });

  it('tag 命中计 1 分、标题/路径词命中计 2 分（§4.2 打分口径）', async () => {
    indexManual('manuals/a.md', 'Alpha', ['db']);   // 标题词 alpha
    indexManual('manuals/b.md', 'Beta', ['db']);    // tag 词 db
    bridge.put('manuals/a.md', 'A');
    bridge.put('manuals/b.md', 'B');
    const bundle = await mem.buildContextBundle('dot1', 'alpha db', 4000);
    // alpha 命中 a.md 标题（2 分），db 命中两者 tag（各 1 分）→ a(3) > b(1)
    assert.equal(bundle.manualExcerpts[0]!.path, 'manuals/a.md');
  });
});

describe('buildContextBundle：会话历史预算（§4.2 ≤4000 tokens / 近 8 条）', () => {
  it('默认只注入近 8 条消息（从旧到新输出）', async () => {
    const t = await mem.create();
    for (let i = 1; i <= 12; i++) {
      await mem.appendMessage(t, { role: 'user', kind: 'text', content: `m${i}` });
    }
    const bundle = await mem.buildContextBundle('dot1', '任务', 4000, { threadId: t });
    assert.equal(bundle.recentMessages.length, 8);
    assert.deepEqual(
      bundle.recentMessages.map((m) => m.content),
      ['m5', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12'],
    );
  });

  it('会话部分超预算 → 停装（砍序第二站：消息条数）', async () => {
    const t = await mem.create();
    // 每条 400 字符 ≈ 115 tokens；budget=400 → sessionBudget=400，只能装 3 条（345）
    for (let i = 1; i <= 20; i++) {
      await mem.appendMessage(t, { role: 'user', kind: 'text', content: 'c'.repeat(400) });
    }
    const bundle = await mem.buildContextBundle('dot1', '任务', 400, { threadId: t });
    assert.ok(bundle.recentMessages.length < 8, `预算内应装不满 8 条（实际 ${bundle.recentMessages.length}）`);
    assert.equal(bundle.recentMessages.length, 3);
    // 会话部分不超过 sessionBudget
    const sessionTokens = bundle.recentMessages.reduce((a, m) => a + m.tokenEst, 0);
    assert.ok(sessionTokens <= 400, `会话 tokens ${sessionTokens} ≤ 400`);
  });

  it('context_summary 参与会话部分预算', async () => {
    const t = await mem.create();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: 'hi' });
    await mem.updateContextSummary(t, '这是摘要内容', 1);
    const bundle = await mem.buildContextBundle('dot1', '任务', 4000, { threadId: t });
    assert.equal(bundle.summary, '这是摘要内容');
  });

  it('summary 放不下时整段丢（砍序末端，最后才动）', async () => {
    const t = await mem.create();
    for (let i = 0; i < 6; i++) {
      await mem.appendMessage(t, { role: 'user', kind: 'text', content: 'c'.repeat(350) }); // 100 tokens each
    }
    await mem.updateContextSummary(t, 'S'.repeat(3500), 6); // 1000 tokens
    // budget=800 → 消息占 600，summary 1000 放不下 → 丢
    const bundle = await mem.buildContextBundle('dot1', '任务', 800, { threadId: t });
    assert.equal(bundle.summary, null);
    assert.ok(bundle.recentMessages.length > 0, '消息优先于 summary');
  });

  it('文件部分与会话部分各自独立预算（budget 传入更大也不越界）', async () => {
    const t = await mem.create();
    bridge.put('MEMORY.md', 'M'.repeat(3 * 1024)); // ≈875 tokens < 2500
    for (let i = 0; i < 4; i++) {
      await mem.appendMessage(t, { role: 'user', kind: 'text', content: 'c'.repeat(350) }); // 100 tokens
    }
    const bundle = await mem.buildContextBundle('dot1', '任务', 100_000, { threadId: t });
    const fileTokens = bundle.manualExcerpts.reduce((a, e) => a + Math.ceil(e.text.length / 3.5), 0)
      + Math.ceil(bundle.memoryMd.length / 3.5);
    assert.ok(fileTokens <= BUDGET_FILE_MEMORY_TOKENS, `文件部分 ${fileTokens} ≤ 2500`);
    const sessionTokens = bundle.recentMessages.reduce((a, m) => a + m.tokenEst, 0)
      + (bundle.summary === null ? 0 : Math.ceil(bundle.summary.length / 3.5));
    assert.ok(sessionTokens <= BUDGET_SESSION_TOKENS, `会话部分 ${sessionTokens} ≤ 4000`);
  });
});

describe('buildContextBundle：files 部分超预算时 manuals 先被砍（§4.2 砍序第一站）', () => {
  it('MEMORY.md 撑满文件预算 → manuals 全丢', async () => {
    indexManual('manuals/a.md', 'A', ['a']);
    bridge.put('MEMORY.md', 'M'.repeat(9 * 1024)); // ≈2571 tokens > 2500
    bridge.put('manuals/a.md', 'manual text');
    const bundle = await mem.buildContextBundle('dot1', 'a', 4000);
    assert.equal(bundle.manualExcerpts.length, 0, '文件预算被 MEMORY.md 占满');
  });
});

describe('buildSessionReplay（§4.1 / 契约 M1 恢复唯一入口）', () => {
  it('按预算从新到旧装填，输出从旧到新', async () => {
    const t = await mem.create();
    for (let i = 1; i <= 5; i++) {
      await mem.appendMessage(t, { role: 'user', kind: 'text', content: `m${i}` });
    }
    const replay = await mem.buildSessionReplay(t, 'task_1', 4000);
    assert.deepEqual(replay.map((m) => m.content), ['m1', 'm2', 'm3', 'm4', 'm5']);
  });

  it('装不下的老消息由 summary 兜底（合成 system 消息排最前）', async () => {
    const t = await mem.create();
    for (let i = 1; i <= 10; i++) {
      await mem.appendMessage(t, { role: 'user', kind: 'text', content: 'c'.repeat(350) }); // 100 tokens
    }
    await mem.updateContextSummary(t, '前情提要', 5);
    // budget=350 → 只装 3 条新消息；summary 兜底
    const replay = await mem.buildSessionReplay(t, 'task_1', 350);
    assert.ok(replay.length >= 1);
    assert.equal(replay[0]!.role, 'system');
    assert.equal(replay[0]!.content, '前情提要');
    assert.equal(replay[0]!.id, `sum_${t}`);
  });

  it('thread 不存在 → 空数组（不抛）', async () => {
    const replay = await mem.buildSessionReplay('thr_nope', 'task_1', 4000);
    assert.deepEqual(replay, []);
  });

  it('无 summary 时不合成 system 消息', async () => {
    const t = await mem.create();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: 'only' });
    const replay = await mem.buildSessionReplay(t, 'task_1', 4000);
    assert.equal(replay.length, 1);
    assert.equal(replay[0]!.content, 'only');
  });

  it('恢复入口包含 task_start/task_end 原样（交互面可回看收口）', async () => {
    const t = await mem.create();
    await mem.appendMessage(t, { role: 'system', kind: 'task_start', content: '{"taskId":"t1"}', taskId: 't1' });
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: '干活' });
    await mem.appendMessage(t, { role: 'system', kind: 'task_end', content: '{"outcome":"done"}', taskId: 't1' });
    const replay = await mem.buildSessionReplay(t, 't1', 4000);
    assert.deepEqual(replay.map((m) => m.kind), ['task_start', 'text', 'task_end']);
  });
});

/**
 * §4.2 骨架补建（2026-10-17 实测缺口：home 命名卷空白起步，无任何代码路径
 * 建初始 MEMORY.md → 每个任务都记一次 memory_missed 降级）。
 *
 * 背景事实：Dockerfile 无 COPY 种子、agent-runtime 启动序列不含 home 初始化、
 * FsOpsHttpBridge 没有 write 原语（契约 S4' 只 read/list/stat/rename）。
 */
describe('buildContextBundle：MEMORY.md 骨架补建（§4.2）', () => {
  it('home 空白 + 有 homeWriter → 落骨架后本次注入到骨架内容', async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const seeded = new MemoryServiceImpl({
      db: tmp.db,
      bridge,
      outboxPath: tmp.outboxPath,
      homeWriter: (_dot, path, content) => {
        writes.push({ path, content });
        bridge.put(path, content);
        return true;
      },
    });
    const bundle = await seeded.buildContextBundle('dot1', '任意任务', 4000);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.path, 'MEMORY.md');
    assert.ok(bundle.memoryMd.includes('# MEMORY (index)'));
    assert.ok(bundle.memoryMd.includes('## Interests'));
    assert.ok(bundle.memoryMd.includes('## Pointers'));
    assert.match(bundle.memoryMd, /^# MEMORY \(index\)\nupdated: \S+Z\n/);
  });

  it('已有 MEMORY.md → 绝不覆盖（fs.write 是覆盖写，误伤即丢记忆）', async () => {
    bridge.put('MEMORY.md', 'updated: 2026-01-01\n\n## Interests\n- 主人关注 CVE\n');
    let calls = 0;
    const seeded = new MemoryServiceImpl({
      db: tmp.db,
      bridge,
      outboxPath: tmp.outboxPath,
      homeWriter: (_dot, path, content) => {
        calls += 1;
        bridge.put(path, content);
        return true;
      },
    });
    const bundle = await seeded.buildContextBundle('dot1', '任务', 4000);
    assert.equal(calls, 0);
    assert.ok(bundle.memoryMd.includes('主人关注 CVE'));
  });

  it('homeWriter 未注入 → 不补建，照旧降级（不炸主循环）', async () => {
    const t = await mem.create();
    const bundle = await mem.buildContextBundle('dot1', '任务', 4000, { threadId: t });
    assert.equal(bundle.memoryMd, '');
    const loaded = await mem.load(t);
    const note = loaded?.messages.find((m) => m.kind === 'system_error');
    assert.ok(note !== undefined, '无 homeWriter 时仍走降级注记');
  });

  it('桥不可用 → 不补建（"连不上"不能误判成"没建过"）', async () => {
    bridge.availableFlag = false;
    let calls = 0;
    const seeded = new MemoryServiceImpl({
      db: tmp.db,
      bridge,
      outboxPath: tmp.outboxPath,
      homeWriter: (_dot, path, content) => {
        calls += 1;
        bridge.put(path, content);
        return true;
      },
    });
    const bundle = await seeded.buildContextBundle('dot1', '任务', 4000);
    assert.equal(calls, 0);
    assert.equal(bundle.memoryMd, '');
  });

  it('homeWriter 写失败 → 不抛、不索引、降级如常', async () => {
    const seeded = new MemoryServiceImpl({
      db: tmp.db,
      bridge,
      outboxPath: tmp.outboxPath,
      homeWriter: () => false,
    });
    const t = await seeded.create();
    const bundle = await seeded.buildContextBundle('dot1', '任务', 4000, { threadId: t });
    assert.equal(bundle.memoryMd, '');
    const row = tmp.db
      .prepare("SELECT COUNT(*) AS c FROM mem_files_index WHERE dot_id = 'dot1' AND path = 'MEMORY.md'")
      .get() as { c?: number };
    assert.equal(row.c, 0, '写失败不进索引');
  });

  it('补建成功后 mem_files_index 有 memory 行（不依赖心跳对账）', async () => {
    const seeded = new MemoryServiceImpl({
      db: tmp.db,
      bridge,
      outboxPath: tmp.outboxPath,
      homeWriter: (_dot, path, content) => {
        bridge.put(path, content);
        return true;
      },
    });
    await seeded.buildContextBundle('dot1', '任务', 4000);
    const row = tmp.db
      .prepare("SELECT area, size_bytes AS sizeBytes FROM mem_files_index WHERE dot_id = 'dot1' AND path = 'MEMORY.md'")
      .get() as { area?: string; sizeBytes?: number } | undefined;
    assert.ok(row !== undefined);
    assert.equal(row.area, 'memory');
    assert.ok((row.sizeBytes ?? 0) > 0);
  });
});
