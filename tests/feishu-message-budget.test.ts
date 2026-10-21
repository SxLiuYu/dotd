/**
 * tests/feishu-message-budget.test.ts —— 飞书消息精简（2026-10-21）
 *
 * 主人的原话是「飞书的消息精简一下，推送的太多了」。
 * 先量了一遍才动手，数据（24 小时）：
 *
 *   出站 56 条 = 12 张审批卡 + 44 条回复
 *   44 条回复里 13 条是我自己造的测试消息，真实对话 31 条
 *   真实对话里 28 条（90%）顶到 200 字预览上限 —— 全是被截断的长文
 *   库里 assistant 正文最长 1364 字，111 条超 500 字
 *   而 MAX_REPLY_CHARS = 3800，等于原样全发
 *
 * 另外 50 个任务里 32 个来自 Web，但 44 条回复**全部**推到飞书：
 * 人在电脑前看 Web，手机上又收一遍。这不是通知，是重复。
 *
 * 三条改动，各有对应的用例：
 *   1. clipForFeishu   —— 长文折叠到 600 字并指路（正文一个字不丢，在库里）
 *   2. isLowValueReply —— 「我没有 xx 工具」这类自我否定静音（只落库）
 *   3. mirrorWebToFeishu = false —— Web 发起的任务不再镜像到飞书
 */
import { DatabaseSync } from 'node:sqlite';
import {
  clipForFeishu,
  isLowValueReply,
  shouldMirrorToFeishu,
  FEISHU_REPLY_MAX_CHARS,
} from '../src/surfaces/feishu-outbound.ts';

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

console.log('');
console.log('  一、长文折叠（clipForFeishu）');

ok('短回复原样返回，不加任何尾巴', clipForFeishu('好的，已完成。') === '好的，已完成。');
ok('恰好等于上限也原样', clipForFeishu('x'.repeat(FEISHU_REPLY_MAX_CHARS)).length === FEISHU_REPLY_MAX_CHARS);

const long = '第一段结论。\n\n' + '细节内容。'.repeat(300);
const clipped = clipForFeishu(long);
ok('超长会被截断', clipped.length < long.length, clipped.length + ' < ' + long.length);
ok('截断留在上限附近（不超太多）', clipped.length <= FEISHU_REPLY_MAX_CHARS + 80, String(clipped.length));
ok('带上了「还有多少字」的指路', clipped.includes('还有') && clipped.includes('Web'));
ok('指路里说明了 dotd task 用法', clipped.includes('dotd task'));

// 关键的诚实性检查：不能丢字还不说
const m = /还有 (\d+) 字/.exec(clipped);
ok('声明的剩余字数与实际吻合', m !== null && Number(m[1]) === long.length - clipped.slice(0, clipped.indexOf('\n\n…')).length,
   m === null ? '没匹配到' : m[1]);

// 切点不该切在词中间
const cn = ('这是一句完整的话。').repeat(200);
const cnCut = clipForFeishu(cn);
ok('中文按句号断句，不硬切', cnCut.includes('。'), cnCut.slice(0, 40));

console.log('');
console.log('  二、无信息量回复静音（isLowValueReply）');

ok('英文「我没有这个工具」', isLowValueReply("I don't have `browser.open` in this environment."));
ok('英文 I cannot', isLowValueReply('I cannot do that: no such tool.'));
ok('英文 I am unable', isLowValueReply("I'm unable to access that."));
ok('中文「我无法执行」', isLowValueReply('我无法执行这个请求：我的工具里没有 browser.open。'));
ok('中文「我没有」', isLowValueReply('我没有可用的 browser.open / browser.snapshot 工具。'));
ok('中文「我这边看不到」', isLowValueReply('我这边看不到任何审批记录。'));
ok('空回复也算无信息量', isLowValueReply('   '));

// 红线：绝不能吞掉真回答
ok('真回答不静音', !isLowValueReply('页面标题是 Example Domain，只有一个链接。'));
ok('否认开头但后面有实质内容 → 不静音', !isLowValueReply('我无法连接那个站点，但我查了本地缓存，发现上次抓到的标题是 Example。'));
ok('长回复一律不静音（能写长说明有内容）',
   !isLowValueReply("I don't have browser tools. " + 'x'.repeat(300)));

console.log('');
console.log('  三、Web 发起的任务不镜像到飞书（shouldMirrorToFeishu）');

function mkDb(channel: string | null): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE mem_threads (id TEXT PRIMARY KEY, channel TEXT)');
  if (channel !== null) db.prepare('INSERT INTO mem_threads (id,channel) VALUES (?,?)').run('thr_1', channel);
  return db;
}

ok('web 线程 + 默认关闭 → 不镜像', shouldMirrorToFeishu(mkDb('web'), 'thr_1', false) === false);
ok('web 线程 + 显式开启 → 镜像', shouldMirrorToFeishu(mkDb('web'), 'thr_1', true) === true);
ok('feishu 线程 → 永远镜像（那是应答）', shouldMirrorToFeishu(mkDb('feishu'), 'thr_1', false) === true);
ok('event 线程 → 镜像（定时任务走 shouldAnnounce 判）', shouldMirrorToFeishu(mkDb('event'), 'thr_1', false) === true);
// 红线：渠道读不到时必须发，不能因为"查不到"就静默
ok('线程不存在 → 镜像（读不到≠不用发）', shouldMirrorToFeishu(mkDb(null), 'thr_x', false) === true);
ok('未知渠道 → 镜像', shouldMirrorToFeishu(mkDb('telegram'), 'thr_1', false) === true);

console.log('');
console.log('  四、上限值本身');

ok('上限是 600（不是原来的 3800）', FEISHU_REPLY_MAX_CHARS === 600, String(FEISHU_REPLY_MAX_CHARS));
ok('上限能容下结论+两条理由', FEISHU_REPLY_MAX_CHARS >= 400);

console.log('');
console.log('  合计 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
