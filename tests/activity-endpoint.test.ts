/**
 * tests/activity-endpoint.test.ts —— 9.3 活动/回执总览（2026-10-21）
 *
 * `GET /api/activity` 是「它最近都干了什么」的数据源。这组用例钉死四件事：
 *   1. 路由确实注册了（否则 CLI 拿到 404，症状是"命令没输出"而不是"报错"）
 *   2. limit 三向夹逼：负数/0 → 1，超大 → 100，非数字 → 默认 20
 *   3. status 过滤真的进 SQL（不是拿全表再前端过滤）
 *   4. 与 /api/queue 的分工：queue 只有在途，activity 必须有已完成
 *
 * 不启真 HTTP：直接验证路由表 + 源码契约，真端点由 CLI 实跑覆盖。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

const HERE = resolve(import.meta.url.replace('file://', ''), '..');
const httpSrc = readFileSync(resolve(HERE, '../src/surfaces/http.ts'), 'utf8');
const cliSrc = readFileSync(resolve(HERE, '../src/surfaces/cli.ts'), 'utf8');

console.log('');
console.log('  路由注册');

// 直接 import http.ts 会撞上 TS parameter property（Node strip-only 不支持），
// 所以这里验证**源码契约**：路由确实注册为 GET，且处理器确实存在。
// 真端点的行为由 CLI 实跑覆盖（dotd activity --limit/--status 都跑过）。
ok(
  'GET /api/activity 注册为 GET',
  httpSrc.includes("if (m === 'GET' && p === '/api/activity')") &&
    httpSrc.includes("return { route: 'activity', params: {} };"),
);
// 只读端点：不能也放行 POST（否则成写操作开口）
ok('只注册了 GET，没放行 POST', !httpSrc.includes("if (m === 'POST' && p === '/api/activity')"));
ok('RouteName 里有 activity', httpSrc.includes("| 'activity'"));
ok('处理器 case 存在', httpSrc.includes("case 'activity': {"));
// 必须精确匹配整个路径，不能用前缀（否则 /api/activityxxx 也命中）
ok('是精确匹配不是前缀', httpSrc.includes("p === '/api/activity'"));
// 不能误伤近邻
ok('/api/tasks/:id 仍在', httpSrc.includes("return { route: 'task_by_id', params: { id: decodeURIComponent(mm[1]!) } };"));

console.log('');
console.log('  limit 三向夹逼（读实现，防回归）');

// 这条是行为契约：夹到 [1,100]，非数字回落 20
ok('上限 100 写在代码里', httpSrc.includes('Math.min(Math.max(Math.trunc(rawLimit), 1), 100)'));
ok('非有限数回落 20', httpSrc.includes('Number.isFinite(rawLimit)'));
ok('缺省值 20', httpSrc.includes("?? '20'"));

console.log('');
console.log('  查询正确性（静态契约）');

// 必须真按 status 过滤，而不是把全部捞出来再筛
ok('status 进 WHERE 子句', httpSrc.includes("const where = statusFilter !== null && statusFilter !== '' ? 'WHERE status = ?' : ''"));
// 步数用子查询而不是 JOIN（避免一任务多步时行数爆炸）
ok('步数用子查询聚合', httpSrc.includes('SELECT count(*) FROM steps s WHERE s.task_id = t.id'));
ok('失败步数单独统计', httpSrc.includes("s.status = 'failed'"));
// 总数不受 limit 影响 —— 否则「全部任务」会显示成「这页任务」
ok('counts 不受 limit 影响', httpSrc.includes('SELECT status, count(*) AS n FROM tasks GROUP BY status'));

console.log('');
console.log('  CLI 接线');

ok('activity 命令已注册', cliSrc.includes(".command('activity')"));
ok('CLI 打的是 /api/activity', cliSrc.includes('/api/activity${q}'));
ok('CLI 有 --limit', cliSrc.includes("'--limit <n>'"));
ok('CLI 有 --status', cliSrc.includes("'--status <s>'"));
// 认不出的状态原样返回，不编一个中文名出来
ok('状态中文表有兜底', cliSrc.includes('return m[status] ?? status'));

console.log('');
console.log('  与 queue 的分工');

// activity 必须能看到已完成；queue 只有在途。两者谓词互补。
ok('activity 不带状态谓词时看全部', !httpSrc.includes("WHERE status IN ('queued','running')"));
// 失败步数要在输出里体现（这是「卡在哪」的第一眼线索）
ok('CLI 输出失败步数提示', cliSrc.includes('失败 ${tk.failedSteps} 步'));

console.log('');
console.log('  合计 ' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail === 0 ? 0 : 1);
