/**
 * tests/surfaces-container-api.test.ts —— 容器状态查询与重置。
 *
 * 现场（2026-10-19）：连续压测 12 个任务，4 个失败都报"容器处于 quarantined 状态"，
 * 但容器本身 `Up`、runtime 端口可达、日志正常。查 `containers` 表才发现：
 * `recreate_count = 7`，而保护阈值是 >3/24h —— 当天为重建镜像反复 recreate 了 7 次，
 * 系统按设计把它隔离了。
 *
 * 这是**保护机制正常工作**，但代价是所有依赖容器的任务都失败，而报错信息
 * 指向"模型说容器有问题"，很难让人联想到"这是主动隔离"。
 *
 * 所以加两个入口：
 *   GET  /api/container        看状态 + 隔离时给提示
 *   POST /api/container/reset  确认容器正常后重置
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { matchRoute } from '../src/surfaces/http.ts';

test('GET /api/container 命中 route=container（无 action）', () => {
  const m = matchRoute('GET', '/api/container');
  assert.ok(m !== null, '应能匹配');
  assert.equal(m!.route, 'container');
  assert.equal(m!.params['action'], undefined, '查询不应带 action');
});

test('POST /api/container/reset 命中 route=container（action=reset）', () => {
  const m = matchRoute('POST', '/api/container/reset');
  assert.ok(m !== null);
  assert.equal(m!.route, 'container');
  assert.equal(m!.params['action'], 'reset');
});

test('错误方法不误命中（防止把 POST /api/container 当成重置）', () => {
  assert.equal(matchRoute('POST', '/api/container'), null, 'POST 到查询路径不应匹配');
  assert.equal(matchRoute('GET', '/api/container/reset'), null, 'GET 到重置路径不应匹配');
});
