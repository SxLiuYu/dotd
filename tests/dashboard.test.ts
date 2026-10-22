/**
 * tests/dashboard.test.ts —— 仪表盘纯函数（slug 白名单 / HTML 校验 / CSP / 链接 / 标题）
 *
 * 这些函数守着两件事，都必须钉住：
 *   ① 外部输入（URL 里的 slug）不能变成路径穿越；
 *   ② 模型写的页面不能被当成「可执行内容」托管给主人的浏览器（CSP 不许出现 script-src）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DASHBOARD_MAX_BYTES,
  dashboardCsp,
  dashboardHomePath,
  dashboardUrl,
  extractDashboardTitle,
  formatBytes,
  parseDashboardSlug,
  renderDashboardList,
  validateDashboardHtml,
} from '../src/surfaces/dashboard.ts';

test('slug：合法值原样通过（含数字开头与中划线）', () => {
  for (const s of ['a', 'sales', 'q3-2026', 'x1', 'a'.repeat(63)]) {
    const r = parseDashboardSlug(s);
    assert.equal(r.ok, true, s);
    if (r.ok) assert.equal(r.slug, s);
  }
});

test('slug：路径穿越与编码变体一律拒绝', () => {
  for (const s of ['../etc/passwd', 'a/../b', 'a/b', '..', '.', '%2e%2e', 'a\\b', 'a\0b']) {
    const r = parseDashboardSlug(s);
    assert.equal(r.ok, false, s);
    if (!r.ok) assert.equal(r.reason, 'bad_slug');
  }
});

test('slug：大写、下划线、空格、超长都拒绝（不做归一化）', () => {
  for (const s of ['Sales', 'my_dash', 'my dash', 'a'.repeat(64), '-lead']) {
    assert.equal(parseDashboardSlug(s).ok, false, s);
  }
});

test('slug：空输入给出 empty 而不是 bad_slug', () => {
  for (const s of ['', '   ', null, undefined]) {
    const r = parseDashboardSlug(s);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'empty');
  }
});

test('HTML 校验：正常页面通过（doctype 或 <html 都认）', () => {
  assert.deepEqual(validateDashboardHtml('<!doctype html><html><body>x</body></html>'), { ok: true });
  assert.deepEqual(validateDashboardHtml('<html lang="zh"><body>x</body></html>'), { ok: true });
  // 前面有注释/空行也算（只查前 512 字）
  assert.deepEqual(validateDashboardHtml('\n\n<!-- c -->\n<!DOCTYPE HTML>\n<html></html>'), { ok: true });
});

test('HTML 校验：空 / 非 HTML / 超大都拒绝', () => {
  assert.deepEqual(validateDashboardHtml(''), { ok: false, reason: 'empty' });

  const json = JSON.stringify({ tasks: [1, 2, 3] });
  assert.deepEqual(validateDashboardHtml(json), { ok: false, reason: 'not_html' });

  const md = '# 昨天做了什么\n\n- 三个任务\n';
  assert.deepEqual(validateDashboardHtml(md), { ok: false, reason: 'not_html' });

  // 刚好超一点就该拒（用 ASCII 让长度等于字节数）
  const big = '<!doctype html><html>' + 'x'.repeat(DASHBOARD_MAX_BYTES) + '</html>';
  assert.deepEqual(validateDashboardHtml(big), { ok: false, reason: 'too_large' });
});

test('HTML 校验：上限按字节算，不按字符算（中文 3 字节）', () => {
  // 字符数远小于上限、字节数超上限 —— 必须按字节判成 too_large
  const chars = Math.ceil(DASHBOARD_MAX_BYTES / 3) + 10;
  const html = '<!doctype html><html>' + '中'.repeat(chars) + '</html>';
  assert.ok(html.length < DASHBOARD_MAX_BYTES, '字符数应小于上限（否则这条用例没意义）');
  assert.deepEqual(validateDashboardHtml(html), { ok: false, reason: 'too_large' });
});

test('home 路径：固定 dashboards/<slug>.html，且不带 /dot/home 前缀', () => {
  assert.equal(dashboardHomePath('sales'), 'dashboards/sales.html');
  assert.ok(!dashboardHomePath('sales').startsWith('/'));
});

test('CSP：默认全禁，且绝不给脚本开口子', () => {
  const csp = dashboardCsp();
  assert.ok(csp.startsWith("default-src 'none'"));
  assert.ok(csp.includes("style-src 'unsafe-inline'"));
  assert.ok(csp.includes('img-src data:'));
  assert.ok(csp.includes("frame-ancestors 'none'"));
  assert.ok(!csp.includes('script-src'), 'CSP 一旦出现 script-src，页面就能在主人浏览器里跑代码');
  assert.ok(!csp.includes('connect-src'));
});

test('链接：合法 base 拼接、尾部斜杠不重复；空/非法 base 返回 null', () => {
  assert.equal(dashboardUrl('http://192.168.1.9:7788', 'sales'), 'http://192.168.1.9:7788/d/sales');
  assert.equal(dashboardUrl('http://192.168.1.9:7788/', 'sales'), 'http://192.168.1.9:7788/d/sales');
  assert.equal(dashboardUrl('https://box.example.com/base', 'sales'), 'https://box.example.com/base/d/sales');
  assert.equal(dashboardUrl(null, 'sales'), null);
  assert.equal(dashboardUrl('', 'sales'), null);
  assert.equal(dashboardUrl('   ', 'sales'), null);
  assert.equal(dashboardUrl('192.168.1.9:7788', 'sales'), null, '没有协议头的 base 拼出来点了必然失败');
});

test('标题：取 <title> 并做最小实体解码', () => {
  assert.equal(extractDashboardTitle('<title>Q3 销售</title>'), 'Q3 销售');
  assert.equal(extractDashboardTitle('<TITLE lang="zh">R&amp;D 概览</TITLE>'), 'R&D 概览');
  assert.equal(extractDashboardTitle('<title>  a\n b  </title>'), 'a b');
  assert.equal(extractDashboardTitle('<title></title>'), null);
  assert.equal(extractDashboardTitle('<html><body>没有标题</body></html>'), null);
});

test('字节数格式化：B / KB / MB 三档，异常输入不炸', () => {
  assert.equal(formatBytes(0), '0B');
  assert.equal(formatBytes(-1), '0B');
  assert.equal(formatBytes(Number.NaN), '0B');
  assert.equal(formatBytes(999), '999B');
  assert.equal(formatBytes(2048), '2.0KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0MB');
});

test('列表：没有页面时给「怎么做一个」而不是空白', () => {
  const text = renderDashboardList([]);
  assert.ok(text.includes('还没有仪表盘'));
  assert.ok(text.includes('dashboards/'));
});

test('列表：有页面时带 slug、体积与可点链接', () => {
  const text = renderDashboardList(
    [
      { slug: 'sales', title: 'Q3 销售', bytes: 2048 },
      { slug: 'ops', title: null, bytes: 100 },
    ],
    'http://10.0.0.5:7788',
  );
  assert.ok(text.includes('共 2 个仪表盘'));
  assert.ok(text.includes('Q3 销售（sales，2.0KB）'));
  assert.ok(text.includes('http://10.0.0.5:7788/d/sales'));
  assert.ok(text.includes('· ops（ops，100B）'), '没有 title 时用 slug 顶上');
});