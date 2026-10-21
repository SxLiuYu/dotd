/**
 * tests/proactive-announce.test.ts —— proactive=0 的定时任务不该主动说话
 * （2026-10-21，A1 最后一块缺口）
 *
 * 现场（实测发现）：crontabs 的 proactive / quiet_hours / throttle_hours 三闸
 * 在 fireHeartbeat 里由 shouldPush() 算出结论，写进 events.payload.proactive，
 * 然后**没有任何地方读它**。建一条 proactive=0 和一条 proactive=1 同时触发，
 * 两条都发到了飞书（surf_outbound_log 811/812）——
 * 也就是说"主动推送开关"此前完全不生效，关着的任务照样天天打扰。
 *
 * 这组用例钉死消费端的判据。重点不在"关着的要静默"（那很简单），
 * 而在"其余情况必须照常回" —— 吞掉主人的回答比多发一条糟糕得多。
 */
import { DatabaseSync } from 'node:sqlite';
import { shouldAnnounce } from '../src/surfaces/feishu-outbound.ts';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++;
    console.log('  PASS ' + name + (detail ? ' -- ' + detail : ''));
  } else {
    fail++;
    console.log('  FAIL ' + name + (detail ? ' -- ' + detail : ''));
  }
};

const SCHEMA = `
CREATE TABLE tasks (id TEXT PRIMARY KEY, source_event_id INTEGER);
CREATE TABLE events (id INTEGER PRIMARY KEY, source TEXT NOT NULL, payload TEXT NOT NULL);
`;

/** 造一个最小的 task←event 关系；payload 按需拼。 */
function mk(opts: {
  sourceEventId: number | null;
  event?: { source: string; payload: string };
}): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO tasks(id, source_event_id) VALUES(?,?)').run('tk1', opts.sourceEventId);
  if (opts.event !== undefined) {
    db.prepare('INSERT INTO events(id, source, payload) VALUES(?,?,?)').run(
      opts.sourceEventId ?? 1,
      opts.event.source,
      opts.event.payload,
    );
  }
  return db;
}

console.log('');
console.log('  proactive=0 要静默');

{
  const db = mk({ sourceEventId: 7, event: { source: 'heartbeat', payload: '{"proactive":false,"title":"x"}' } });
  ok('定时任务判定不推送 → 不打扰', shouldAnnounce(db, 'tk1') === false);
  db.close();
}

console.log('');
console.log('  proactive=1 要说话');

{
  const db = mk({ sourceEventId: 8, event: { source: 'heartbeat', payload: '{"proactive":true}' } });
  ok('定时任务判定推送 → 说', shouldAnnounce(db, 'tk1') === true);
  db.close();
}

console.log('');
console.log('  非定时任务一律照常回（应答不是打扰）');

{
  // 主人在飞书里说的话：没有 source_event_id
  const db = mk({ sourceEventId: null });
  ok('对话任务（无来源事件）→ 回', shouldAnnounce(db, 'tk1') === true);
  db.close();
}

{
  // http/file 等外部事件触发的任务
  const db = mk({ sourceEventId: 9, event: { source: 'http', payload: '{"proactive":false}' } });
  ok('非 heartbeat 来源 → 回（不看 proactive）', shouldAnnounce(db, 'tk1') === true);
  db.close();
}

console.log('');
console.log('  坏数据/老数据一律朝"多说一句"倒');

{
  // 老版本事件没有 proactive 字段
  const db = mk({ sourceEventId: 10, event: { source: 'heartbeat', payload: '{"title":"老事件"}' } });
  ok('payload 缺 proactive 字段 → 回（向后兼容）', shouldAnnounce(db, 'tk1') === true);
  db.close();
}

{
  // 事件行被清理了（外键没约束，指向不存在的 id）
  const db = mk({ sourceEventId: 999 });
  ok('来源事件查不到 → 回', shouldAnnounce(db, 'tk1') === true);
  db.close();
}

{
  const db = mk({ sourceEventId: 11, event: { source: 'heartbeat', payload: '{坏 JSON' } });
  ok('payload 不是合法 JSON → 回（不因解析失败吞回答）', shouldAnnounce(db, 'tk1') === true);
  db.close();
}

{
  // task 本身查不到（比如刚被 gc）
  const db = mk({ sourceEventId: null });
  ok('task 不存在 → 回', shouldAnnounce(db, 'tk_nope') === true);
  db.close();
}

{
  // proactive 是字符串 "false" 而不是布尔 false —— 严格看 === false，
  // 非布尔的脏值不该被当成"关"，否则一个数据格式变化就能让主人收不到回复
  const db = mk({ sourceEventId: 12, event: { source: 'heartbeat', payload: '{"proactive":"false"}' } });
  ok('proactive 非布尔 false → 保守回', shouldAnnounce(db, 'tk1') === true);
  db.close();
}

{
  const db = mk({ sourceEventId: 13, event: { source: 'heartbeat', payload: '{"proactive":0}' } });
  ok('proactive=0（数字）→ 保守回（只认布尔 false）', shouldAnnounce(db, 'tk1') === true);
  db.close();
}

console.log('');
console.log('  合计 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
