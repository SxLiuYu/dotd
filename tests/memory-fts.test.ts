/**
 * tests/memory-fts.test.ts —— P1-3 记忆检索进 FTS5（零依赖）+ rankManuals 的 TF-IDF。
 *
 * 六条验收（任务书原文）：
 *   ① 迁移后 fts 表存在且已有消息被回填（count 与 mem_messages 一致）；
 *   ② 中文查询能命中（"会议记录" 里查 "会议"）—— unicode61 直查必 0 条，本文件是它的反证；
 *   ③ bm25 排序：两文档都命中时，命中密度更高的排前面；
 *   ④ 增删改同步：append 后即可搜到、改内容后旧词搜不到、删后搜不到；
 *   ⑤ FTS 不可用（DROP 表）→ 降级 LIKE，结果不丢，降级被记录（非静默）；
 *   ⑥ rankManuals 的 IDF 前后对比：同一组输入旧算法命中 A、新算法命中 B，且 B 更合理。
 *
 * 另含：CJK 切分纯函数的边界、contentless 方案的核心判据（不存原文但可检索）、
 * 迁移包与建库模板的一致性（模板建出来的库同样能检索，且 user_version=120）。
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeTempDataDir, type TempDataDir } from './helpers.ts';
import { MemoryServiceImpl } from '../src/memory/MemoryService.ts';
import {
  ftsIndexText,
  ftsMatchQuery,
  highlightSnippet,
  isCjk,
  tokenizeForFts,
} from '../src/memory/cjk-tokenize.ts';
import { rankManuals, rankManualsLegacy, rankManualsScored } from '../src/memory/inject.ts';
import { migrate } from '../db/migrate.ts';
import { openMigratedTemplateDb } from '../db/template.ts';

let tmp: TempDataDir;
let mem: MemoryServiceImpl;

beforeEach(() => {
  tmp = makeTempDataDir();
  mem = new MemoryServiceImpl({ db: tmp.db });
});
afterEach(() => {
  tmp.cleanup();
});

async function thread(): Promise<string> {
  return mem.create();
}

function kv(key: string): string | null {
  const row = tmp.db.prepare('SELECT value FROM mem_maintenance_state WHERE key = ?').get(key) as
    | { value?: string }
    | undefined;
  return row?.value ?? null;
}

// ═══════════════════════════════════════════════════════════════════
// 零、CJK 切分纯函数（方案的心脏）
// ═══════════════════════════════════════════════════════════════════

describe('tokenizeForFts：CJK bigram + 拉丁整词', () => {
  test('连续中文切成相邻二元组；"会议记录" 里含 "会议" 这个 token', () => {
    assert.deepEqual(tokenizeForFts('会议记录'), ['会议', '议记', '记录']);
    assert.ok(tokenizeForFts('这是一条会议记录').includes('会议'));
  });

  test('拉丁/数字整词小写化（Hello 与 hello 同词），标点丢弃', () => {
    assert.deepEqual(tokenizeForFts('Hello, World! 2026'), ['hello', 'world', '2026']);
  });

  test('中英混排：两类片段各自切分，保持顺序', () => {
    assert.deepEqual(tokenizeForFts('会议 Meeting 2026'), ['会议', 'meeting', '2026']);
  });

  test('单个 CJK 字符保留自身（否则单字查询永远 0 命中）', () => {
    assert.deepEqual(tokenizeForFts('会'), ['会']);
    assert.ok(isCjk('会'));
    assert.ok(!isCjk('abc'));
  });

  test('空串/纯标点 → 无 token；MATCH 表达式为空', () => {
    assert.deepEqual(tokenizeForFts(''), []);
    assert.deepEqual(tokenizeForFts('，。！？'), []);
    assert.equal(ftsMatchQuery(''), '');
  });

  test('MATCH 表达式：每个 token 加引号，避免 FTS5 把 AND/OR/NEAR 当运算符', () => {
    assert.equal(ftsMatchQuery('会议'), '"会议"');
    assert.equal(ftsMatchQuery('会议 记录'), '"会议" "记录"');
    // 关键回归：拉丁短词不得被误切成单字母（曾因 isCjk 的正则带 g 标志产生 lastIndex 状态而踩中）
    assert.equal(ftsMatchQuery('WSL'), '"wsl"');
    assert.equal(ftsMatchQuery('a'), '"a"');
  });

  test('ftsIndexText：token 以空格连接，供 unicode61 再切一次', () => {
    assert.equal(ftsIndexText('会议记录'), '会议 议记 记录');
  });
});

describe('highlightSnippet：片段里能看到主人查的词', () => {
  test('整串命中 → 截取上下文', () => {
    const s = highlightSnippet('今天开了一场很重要的会议记录整理工作', '会议记录');
    assert.ok(s.includes('会议记录'), s);
  });
  test('查询词是子串但不连续命中（bigram）→ 用首个出现的 token 定位', () => {
    const s = highlightSnippet('会议纪要如下：记录', '会议记录');
    assert.ok(s.includes('会议'), s);
  });
  test('完全不命中 → 返回开头（不抛错）', () => {
    assert.equal(highlightSnippet('abc', 'xyz').length, 3);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 一、迁移与回填（验收 ①）
// ═══════════════════════════════════════════════════════════════════

describe('① 迁移：fts 表存在、user_version=120、已有消息可回填', () => {
  test('真迁移后 mem_messages_fts 是虚表，user_version=120', () => {
    const db = new DatabaseSync(':memory:');
    try {
      const r = migrate(db);
      assert.equal(r.to, 120);
      const row = db
        .prepare("SELECT name, sql FROM sqlite_master WHERE name = 'mem_messages_fts'")
        .get() as { name?: string; sql?: string } | undefined;
      assert.equal(row?.name, 'mem_messages_fts');
      assert.match(String(row?.sql), /CREATE VIRTUAL TABLE.*fts5/i, '必须是 FTS5 虚表');
      assert.match(String(row?.sql), /content\s*=\s*''/, 'contentless（只存倒排索引）');
    } finally {
      db.close();
    }
  });

  test('旁路写入（绕过 appendMessage 直接 INSERT）后，ensureMessageFts 回填使条数一致且可检索', async () => {
    const t = await thread();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: '先有一条正常消息' });
    // 先让 mem 完成首次探测（含一次性自动对账）；不先做这一步，下面的 ftsStatus()
    // 会顺带触发对账，就测不到"索引落后 → 手工修复"这条路径了。
    assert.equal(mem.ftsStatus().inSync, true);
    // 模拟"迁移前就存在的老消息"：直接写 SQL，不经过 appendMessage 的双写
    const msgs = ['历史的会议记录 A', '历史的会议记录 B', '无关内容 C'];
    for (let i = 0; i < msgs.length; i++) {
      tmp.db
        .prepare(
          `INSERT INTO mem_messages (id, thread_id, seq, role, kind, content, task_id, event_id, token_est, created_at)
           VALUES (?, ?, ?, 'user', 'text', ?, NULL, NULL, 1, ?)`,
        )
        .run(`msg_bypass_${i}`, t, 100 + i, msgs[i]!, 1_000 + i);
    }
    const before = mem.ftsStatus();
    assert.equal(before.available, true);
    assert.equal(before.inSync, false, '旁路写入后索引必然落后');
    assert.equal(before.indexed, 1, '索引里只有那条正常消息');

    const filled = mem.ensureMessageFts();
    assert.equal(filled, 4, '回填条数 = 消息总数');

    const after = mem.ftsStatus();
    assert.equal(after.inSync, true);
    assert.equal(after.indexed, after.messages);
    // 回填出来的消息必须**真的可检索**（不只是条数一致）
    const hits = await mem.searchMessages('会议', { limit: 10 });
    assert.equal(hits.length, 2, `回填后中文应可检索，实际命中 ${hits.length}`);
    // 幂等：已经同步时再调不重灌
    assert.equal(mem.ensureMessageFts(), 0, '已同步时 ensureMessageFts 是 no-op');
  });

  test('首次探测时的自动对账：新实例遇到"索引落后"会自己补上', async () => {
    // 模拟带老数据的库：写入消息（走双写）→ 清空索引 → 换一个新 MemoryService 实例，
    // 它的首次 ftsProbe() 会做一次性对账，把落后的索引补齐（迁移后首次启动的真实路径）。
    const t = await thread();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: '自动对账要能救回的会议记录' });
    tmp.db.exec("INSERT INTO mem_messages_fts(mem_messages_fts) VALUES('delete-all')");
    assert.equal(mem.ftsStatus().indexed, 0);

    const fresh = new MemoryServiceImpl({ db: tmp.db });
    const hits = await fresh.searchMessages('会议', { limit: 5 });
    assert.equal(hits.length, 1, '新实例首次探测即自动回填，检索立刻可用');
    assert.equal(fresh.ftsStatus().inSync, true);
  });

  test('建库模板（db/template.ts）同样建出可检索的库——迁移包与模板一致性', async () => {
    // 模板是从"真迁移库"反推脚本重建的；这里断言模板库同样有 fts 表、版本 120，
    // 且用同一个 MemoryService 写入后能检索（等价性由 tests/db-template.test.ts 逐库比对）。
    const root = mkdtempSync(join(tmpdir(), 'dotd-fts-tpl-'));
    const db = openMigratedTemplateDb(join(root, 'dotd.db'));
    try {
      const uv = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
      assert.equal(uv?.user_version, 120, '模板库 user_version 必须跟着迁移到 120');
      const fts = db
        .prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'mem_messages_fts'")
        .get() as { x?: number } | undefined;
      assert.equal(fts?.x, 1, '模板库必须包含 120 迁移建的表');

      const m = new MemoryServiceImpl({ db });
      const th = await m.create();
      await m.appendMessage(th, { role: 'user', kind: 'text', content: '模板库里的会议记录' });
      const hits = await m.searchMessages('会议', { limit: 5 });
      assert.equal(hits.length, 1, '模板库上同样可检索（否则每个用例的检索都不可信）');
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// 二、中文查询（验收 ② —— 最容易漏的一条）
// ═══════════════════════════════════════════════════════════════════

describe('② 中文查询：bigram 让"会议"能搜到"会议记录"', () => {
  test('"会议记录" 里查 "会议" 命中（unicode61 整段切分下这条必 0 条）', async () => {
    const t = await thread();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: '今天的会议记录已整理' });
    const hits = await mem.searchMessages('会议', { limit: 10 });
    assert.equal(hits.length, 1, '中文二元组检索必须命中');
    assert.equal(hits[0]!.message.threadId, t);
    assert.ok(hits[0]!.snippet.includes('会议'), `片段应包含查询词，实际：${hits[0]!.snippet}`);
  });

  test('对照：不切分的裸 unicode61 查不到（证明这不是 SQLite 自带能力）', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("CREATE VIRTUAL TABLE raw USING fts5(content, tokenize='unicode61')");
      db.prepare('INSERT INTO raw(content) VALUES (?)').run('今天的会议记录已整理');
      const n = (
        db.prepare('SELECT count(*) AS c FROM raw WHERE raw MATCH ?').get('会议') as { c?: number } | undefined
      )?.c;
      assert.equal(n, 0, '裸 unicode61 对中文整段切分 → "会议" 查不到，这正是我们要绕开的行为');
    } finally {
      db.close();
    }
  });

  test('两字中文词、三字中文词、混合中英都能命中', async () => {
    const t = await thread();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: '报销流程要走财务系统' });
    await mem.appendMessage(t, { role: 'assistant', kind: 'text', content: 'deploy 到 kubernetes 集群的步骤' });
    assert.equal((await mem.searchMessages('报销', { limit: 5 })).length, 1);
    assert.equal((await mem.searchMessages('财务系统', { limit: 5 })).length, 1);
    assert.equal((await mem.searchMessages('kubernetes', { limit: 5 })).length, 1);
    assert.equal((await mem.searchMessages('集群', { limit: 5 })).length, 1);
  });

  test('不相关的中文查询仍然 0 命中（不是"任何中文都命中"）', async () => {
    const t = await thread();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: '今天的会议记录已整理' });
    assert.equal((await mem.searchMessages('飞机票', { limit: 5 })).length, 0);
  });

  test('英文查询保持原有行为（大小写不敏感）', async () => {
    const t = await thread();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: '部署 dotd 到 WSL' });
    assert.equal((await mem.searchMessages('WSL', { limit: 5 })).length, 1);
    assert.equal((await mem.searchMessages('wsl', { limit: 5 })).length, 1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 三、bm25 排序（验收 ③）
// ═══════════════════════════════════════════════════════════════════

describe('③ bm25 排序：命中密度高的排前面', () => {
  test('同样的查询词，出现多次/占比高的文档排在前面', async () => {
    const t = await thread();
    // doc A：短，主题就是部署
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: '部署 部署 部署' });
    // doc B：长，只在末尾顺带提一次部署
    await mem.appendMessage(t, {
      role: 'assistant',
      kind: 'text',
      content: `无关内容 ${'填充文字 '.repeat(40)} 最后提一次部署`,
    });
    const hits = await mem.searchMessages('部署', { limit: 10 });
    assert.equal(hits.length, 2);
    assert.ok(
      hits[0]!.message.content.startsWith('部署 部署 部署'),
      `密度高者应排第一，实际第一是：${hits[0]!.message.content.slice(0, 30)}`,
    );
  });

  test('中文密度排序同样生效', async () => {
    const t = await thread();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: '会议 会议 会议 会议' });
    await mem.appendMessage(t, {
      role: 'assistant',
      kind: 'text',
      content: `很长的其他内容 ${'一些无关的话 '.repeat(30)} 偶尔一次会议`,
    });
    const hits = await mem.searchMessages('会议', { limit: 10 });
    assert.equal(hits.length, 2);
    assert.ok(hits[0]!.message.content.includes('会议 会议 会议'), '中文高密度文档应排第一');
  });

  test('bm25 打平时按时间倒序（与 LIKE 版"最新优先"一致）', async () => {
    const t = await thread();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: '同样内容 部署' });
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: '同样内容 部署' });
    const hits = await mem.searchMessages('部署', { limit: 10 });
    assert.equal(hits.length, 2);
    assert.ok(hits[0]!.message.seq > hits[1]!.message.seq, '打平时新的在前');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 四、增删改同步（验收 ④）
// ═══════════════════════════════════════════════════════════════════

describe('④ 索引同步：append 立即可搜；UPDATE/DELETE 后旧词消失', () => {
  test('append 之后立刻可搜到', async () => {
    const t = await thread();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: '新增的会议记录' });
    assert.equal((await mem.searchMessages('会议', { limit: 5 })).length, 1);
  });

  test('改内容（UPDATE mem_messages.content）后：旧词搜不到、新词搜得到（resync 之后）', async () => {
    const t = await thread();
    const { id } = await mem.appendMessage(t, { role: 'user', kind: 'text', content: '旧内容：会议记录' });
    tmp.db.prepare('UPDATE mem_messages SET content = ? WHERE id = ?').run('新内容：报销流程', id);
    // 索引需要重新同步（contentless 表无法自动感知外部 UPDATE）
    mem.resyncMessageFts();
    assert.equal((await mem.searchMessages('会议', { limit: 5 })).length, 0, 'UPDATE 后旧词不得再命中');
    assert.equal((await mem.searchMessages('报销', { limit: 5 })).length, 1, 'UPDATE 后新词应命中');
  });

  test('DELETE 之后搜不到（resync 之后）', async () => {
    const t = await thread();
    const { id } = await mem.appendMessage(t, { role: 'user', kind: 'text', content: '待删除的会议记录' });
    tmp.db.prepare('DELETE FROM mem_messages WHERE id = ?').run(id);
    mem.resyncMessageFts();
    assert.equal((await mem.searchMessages('会议', { limit: 5 })).length, 0, 'DELETE 之后不得命中');
    assert.equal(mem.ftsStatus().inSync, true);
  });

  test('resyncMessageFts 幂等且条数正确', async () => {
    const t = await thread();
    for (let i = 0; i < 5; i++) await mem.appendMessage(t, { role: 'user', kind: 'text', content: `消息 ${i} 会议` });
    assert.equal(mem.resyncMessageFts(), 5);
    assert.equal(mem.resyncMessageFts(), 5, '重复 resync 结果一致');
    assert.equal(mem.ftsStatus().inSync, true);
    assert.equal((await mem.searchMessages('会议', { limit: 20 })).length, 5);
  });
});

// ═══════════════════════════════════════════════════════════════════
// 五、降级路径（验收 ⑤ —— 不可静默）
// ═══════════════════════════════════════════════════════════════════

describe('⑤ 降级：FTS 不可用 → LIKE，结果不丢且留痕', () => {
  test('DROP 掉 fts 表后，检索自动降级 LIKE，结果不丢', async () => {
    const t = await thread();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: '降级前写入的会议记录' });
    // 先确认 FTS 生效
    assert.equal((await mem.searchMessages('会议', { limit: 5 })).length, 1);

    tmp.db.exec('DROP TABLE mem_messages_fts');

    // 新实例（缓存为空）会重新探测 → unavailable → LIKE
    const mem2 = new MemoryServiceImpl({ db: tmp.db });
    const hits = await mem2.searchMessages('会议', { limit: 5 });
    assert.equal(hits.length, 1, 'LIKE 降级后结果不丢');
    assert.ok(hits[0]!.snippet.includes('会议'));
  });

  test('降级被记录（fts_degraded_count 自增 + fts_degraded_last 带原因），不是静默', async () => {
    const t = await thread();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: '会议记录' });
    tmp.db.exec('DROP TABLE mem_messages_fts');

    const mem2 = new MemoryServiceImpl({ db: tmp.db });
    assert.equal(kv('fts_degraded_count'), null, '降级前无记录');
    await mem2.searchMessages('会议', { limit: 5 });
    assert.equal(kv('fts_degraded_count'), '1', '首次降级即计数');
    const last = JSON.parse(String(kv('fts_degraded_last'))) as { reason?: string; at?: number };
    assert.equal(last.reason, 'unavailable');
    assert.ok(typeof last.at === 'number');

    await mem2.searchMessages('会议', { limit: 5 });
    assert.equal(kv('fts_degraded_count'), '2', '每次降级都计数（可观测到频率）');
  });

  test('降级后写入不炸（记忆写入不能被检索能力拖死）', async () => {
    const t = await thread();
    tmp.db.exec('DROP TABLE mem_messages_fts');
    const mem2 = new MemoryServiceImpl({ db: tmp.db });
    assert.equal(mem2.ftsStatus().available, false);
    const { id } = await mem2.appendMessage(t, { role: 'user', kind: 'text', content: '降级期间的写入' });
    assert.ok(id.startsWith('msg_'));
    // 之后仍能用 LIKE 查到这条
    const hits = await mem2.searchMessages('降级期间', { limit: 5 });
    assert.equal(hits.length, 1);
  });

  test('老库（未迁移、无 fts 表）走 LIKE 且不抛', async () => {
    // 用一个只有 040 记忆表的裸库模拟"老库"
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('CREATE TABLE mem_threads (id TEXT PRIMARY KEY, dot_id TEXT NOT NULL DEFAULT \'dot1\', channel TEXT NOT NULL DEFAULT \'web\', external_ref TEXT, title TEXT, origin_task_id TEXT, status TEXT NOT NULL DEFAULT \'active\', pinned INTEGER NOT NULL DEFAULT 0, context_summary TEXT, context_summary_upto_seq INTEGER NOT NULL DEFAULT 0, last_active_at INTEGER NOT NULL, last_task_finished_at INTEGER, created_at INTEGER NOT NULL)');
      db.exec("CREATE TABLE mem_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, seq INTEGER NOT NULL, role TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, task_id TEXT, event_id TEXT, token_est INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(thread_id, seq))");
      db.exec("CREATE TABLE mem_maintenance_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)");
      db.exec("INSERT INTO mem_threads(id, last_active_at, created_at) VALUES('thr_old', 1, 1)");
      db.exec("INSERT INTO mem_messages(id, thread_id, seq, role, kind, content, token_est, created_at) VALUES('m1','thr_old',1,'user','text','老库里的会议记录',1,1)");
      const m = new MemoryServiceImpl({ db });
      assert.equal(m.ftsStatus().available, false);
      const hits = await m.searchMessages('会议', { limit: 5 });
      assert.equal(hits.length, 1, '老库降级 LIKE 仍能检索');
      assert.equal(db.prepare("SELECT value FROM mem_maintenance_state WHERE key='fts_degraded_count'").get() !== undefined, true);
    } finally {
      db.close();
    }
  });

  test('空查询：不触发降级、不报错、返回空', async () => {
    const t = await thread();
    await mem.appendMessage(t, { role: 'user', kind: 'text', content: '任意内容' });
    assert.deepEqual(await mem.searchMessages('   ', { limit: 5 }), []);
    assert.equal(kv('fts_degraded_count'), null, '空查询不算降级');
  });
});

// ═══════════════════════════════════════════════════════════════════
// 六、rankManuals：TF-IDF 前后对比（验收 ⑥）
// ═══════════════════════════════════════════════════════════════════

describe('⑥ rankManuals：旧算法 vs 新算法（IDF 前后对比）', () => {
  const mk = (path: string, title: string | null, tags: string[]) => ({
    path,
    area: 'manuals' as const,
    title,
    tags,
    sizeBytes: 100,
  });

  test('反例：噪声词（每篇路径都有）让旧算法选错，新算法选对', () => {
    // 场景：B/C 的路径里都有噪声词 dotd（df=N → IDF≈1，几乎不该计分）；
    // A 的标题里有真题面词 kafka（df=1 → IDF 高），但路径里没有噪声词。
    // 分词细节（inject.ts:120 的 TOKEN_RE）：拉丁词可含 '.'，所以 `kafka.md` 是一个 token
    // （不是 `kafka`）；中文会被切成整段（`部署手册`）。噪声词要写成独立段才命中。
    const manuals = [
      mk('manuals/release.md', 'kafka 部署手册', ['部署']),
      mk('manuals/dotd misc.md', '杂项', ['杂项']),
      mk('manuals/dotd todo.md', '待办', ['待办']),
    ];
    const taskText = 'dotd kafka';
    const scored = rankManualsScored(taskText, manuals, 3);
    const kafka = scored.find((s) => s.candidate.path === 'manuals/release.md')!;
    const misc = scored.find((s) => s.candidate.path === 'manuals/dotd misc.md')!;
    // 旧算法口径：两者都是 2 分（标题命中 ×2）——同分，只能靠路径字典序
    assert.equal(kafka.score.weighted, 2, '旧口径：kafka 标题命中 ×2');
    assert.equal(misc.score.weighted, 2, '旧口径：噪声词 dotd 路径命中 ×2 —— 同分！');
    // 新算法：同样 2 分口径，但 IDF 让稀有词 kafka 稳超噪声词 dotd（实测 3.0 vs 2.0）
    assert.ok(
      kafka.score.final >= misc.score.final * 1.5,
      `稀有词文档应显著领先：kafka=${kafka.score.final.toFixed(3)} misc=${misc.score.final.toFixed(3)}`,
    );
    // 旧算法同分 → 按路径字典序 → 'manuals/dotd misc.md' 胜出（噪声文档）
    assert.equal(
      rankManualsLegacy(taskText, manuals, 1)[0]!.path,
      'manuals/dotd misc.md',
      '旧算法：同分按路径序，噪声文档胜出',
    );
    // 新算法：真实相关文档胜出
    assert.equal(rankManuals(taskText, manuals, 1)[0]!.path, 'manuals/release.md', '新算法：真实命中胜出');
  });

  test('词频：同一 token 在标题重复出现的手册排前面（旧算法只看 0/1 命中）', () => {
    const manuals = [
      mk('manuals/a.md', '部署', ['部署']), // 标题+tag 各 1 次
      mk('manuals/b.md', '部署 部署', ['部署']), // 标题 2 次 + tag 1 次
    ];
    const scored = rankManualsScored('部署', manuals, 2);
    assert.equal(scored.length, 2);
    assert.equal(scored[0]!.candidate.path, 'manuals/b.md', '词频高的排第一');
    assert.ok(scored[0]!.score.tf > scored[1]!.score.tf, 'tf 明细应体现差异');
    // 旧算法两者同分（都只是"命中 2 个位置"），按路径字典序 → a.md 在前
    const legacy = rankManualsLegacy('部署', manuals, 2).map((c) => c.path);
    assert.equal(legacy[0], 'manuals/a.md', '旧算法对词频无感知（同分按路径序）');
  });

  test('IDF：稀有词命中 > 常见词命中（旧算法两者同权）', () => {
    const manuals = [
      mk('manuals/common1.md', '周报', ['会议']),
      mk('manuals/common2.md', '周报', ['会议']),
      mk('manuals/common3.md', '周报', ['会议']),
      mk('manuals/rare.md', '周报', ['kafka']),
    ];
    // 查询同时含"会议"（df=3，常见）与"kafka"（df=1，稀有）
    const scored = rankManualsScored('会议 kafka', manuals, 4);
    const rare = scored.find((s) => s.candidate.path === 'manuals/rare.md')!;
    const common = scored.find((s) => s.candidate.path === 'manuals/common1.md')!;
    assert.ok(rare.score.final > common.score.final, `稀有词文档应得分更高：rare=${rare.score.final} common=${common.score.final}`);
    assert.ok(rare.score.idfSum > common.score.idfSum, 'IDF 明细应体现稀有度');
  });

  test('无命中返回空（不硬塞）的语义没变', () => {
    const manuals = [mk('manuals/a.md', '部署手册', ['部署'])];
    assert.deepEqual(rankManuals('完全无关的词', manuals), []);
    assert.deepEqual(rankManuals('', manuals), []);
    assert.deepEqual(rankManuals('部署', []), []);
  });

  test('topN 截断与稳定排序（同分按路径字典序）', () => {
    const manuals = ['c', 'a', 'b'].map((n) => mk(`manuals/${n}.md`, '部署', []));
    const out = rankManuals('部署', manuals, 2).map((c) => c.path);
    assert.deepEqual(out, ['manuals/a.md', 'manuals/b.md']);
  });

  test('已知局限（诚实记录）：整句中文查询不切词，命中靠"整词 token 一致"', () => {
    // tokenize()（inject.ts）的正则把**整段连续中文**当一个 token，没有切词。所以：
    //   - 查询 "报销" 能命中 tag ["报销"] 或标题里独立的 "报销"；
    //   - 但查询 "怎么报销这笔差旅" 一个 token，不会命中任何手册。
    // 这不是本次改动引入的，是既有 §4.2「朴素匹配」的边界；TF-IDF 只在此基础上加权。
    // 这里把它钉成测试，避免以后误以为"中文手册匹配已经做好了"。
    const manuals = [
      mk('manuals/deploy.md', '部署流程', ['部署', '运维']),
      mk('manuals/expense.md', '报销', ['财务']),
      mk('manuals/meeting.md', '会议', ['会议']),
    ];
    assert.deepEqual(rankManuals('怎么报销这笔差旅', manuals, 1), [], '整句中文 → 不命中（既有边界）');
    assert.equal(rankManuals('报销', manuals, 1)[0]!.path, 'manuals/expense.md');
    assert.equal(rankManuals('会议', manuals, 1)[0]!.path, 'manuals/meeting.md');
    assert.equal(rankManuals('部署', manuals, 1)[0]!.path, 'manuals/deploy.md');
  });
});
