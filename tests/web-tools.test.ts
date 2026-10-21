/**
 * tests/web-tools.test.ts —— 宿主侧浏览器工具（web.*，W2，2026-10-21）
 *
 * ## 为什么有这个文件
 * web.* 的实现（src/exec/webtools.ts）靠 spawn 外部 CLI（agent-browser）。
 * 直接跑真浏览器不适合进单测（要下载 190MB Chrome、要网络、慢），所以这里
 * 用一个假的 agent-browser 脚本来验证**我们自己的逻辑**：
 *   - 只放行 http(s)（挡住 file:// 之类越界读取）
 *   - action 白名单（模型不能借 action 注入任意子命令）
 *   - 参数缺失时给人话错误，而不是崩
 *   - 输出截断（页面正文可能几十万字，不能整坨塞进模型上下文）
 * 真浏览器那一层由 scripts/regress/web-tools-criteria.sh 端到端验证。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 造一个假 agent-browser：按参数回显，模拟成功/失败。
 * 放在 temp 目录里，通过 DOTD_AGENT_BROWSER_BIN 指过去。
 */
function fakeBin(dir: string, script: string): string {
  const p = join(dir, 'agent-browser');
  writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`, 'utf8');
  chmodSync(p, 0o755);
  return p;
}

/** 每个用例独立设环境变量并重新 import（BIN 在模块加载时读取）。 */
async function withBin<T>(script: string, fn: (m: typeof import('../src/exec/webtools.ts')) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'webtools-'));
  const bin = fakeBin(dir, script);
  const prev = process.env['DOTD_AGENT_BROWSER_BIN'];
  process.env['DOTD_AGENT_BROWSER_BIN'] = bin;
  try {
    // 缓存 busting：每次换 query 让 ESM 重新求值，从而重读 BIN
    const m = (await import(`../src/exec/webtools.ts?b=${Date.now()}${Math.random()}`)) as typeof import('../src/exec/webtools.ts');
    return await fn(m);
  } finally {
    if (prev === undefined) delete process.env['DOTD_AGENT_BROWSER_BIN'];
    else process.env['DOTD_AGENT_BROWSER_BIN'] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('web.read 拒绝非 http(s)：file:// 不能读宿主文件', async () => {
  await withBin('echo SHOULD_NOT_RUN', async (m) => {
    const r = await m.webRead({ url: 'file:///etc/passwd' });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /只支持 http\(s\)/);
  });
});

test('web.read 拒绝 javascript: 伪协议', async () => {
  await withBin('echo SHOULD_NOT_RUN', async (m) => {
    const r = await m.webRead({ url: 'javascript:alert(1)' });
    assert.equal(r.ok, false);
  });
});

test('web.snapshot 缺 url 时沿用当前页（不报错）', async () => {
  await withBin('echo "- link \\"x\\" [ref=e1]"', async (m) => {
    const r = await m.webSnapshot({});
    assert.equal(r.ok, true);
    assert.match(r.output ?? '', /ref=e1/);
  });
});

test('web.snapshot 传给 CLI 的是 open + snapshot -i 两条', async () => {
  // 假 CLI 把收到的参数打出来，供断言
  await withBin('echo "ARGS:$*"', async (m) => {
    const r = await m.webSnapshot({ url: 'https://example.com' });
    assert.equal(r.ok, true);
    // open 那一步的输出被丢弃，最终返回的是 snapshot 那一步
    assert.match(r.output ?? '', /ARGS:snapshot -i/);
  });
});

test('web.snapshot interactive_only=false 时不带 -i', async () => {
  await withBin('echo "ARGS:$*"', async (m) => {
    const r = await m.webSnapshot({ url: 'https://example.com', interactive_only: false });
    assert.equal(r.ok, true);
    assert.match(r.output ?? '', /ARGS:snapshot$/m);
  });
});

test('web.act 只接受白名单 action：拒掉注入尝试', async () => {
  await withBin('echo SHOULD_NOT_RUN', async (m) => {
    const r = await m.webAct({ action: 'rm -rf /', ref: '@e1' });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /action 只能是/);
  });
});

test('web.act click 需要 ref', async () => {
  await withBin('echo SHOULD_NOT_RUN', async (m) => {
    const r = await m.webAct({ action: 'click' });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /需要 ref/);
  });
});

test('web.act press 不需要 ref，但需要键名', async () => {
  await withBin('echo "ARGS:$*"', async (m) => {
    const bad = await m.webAct({ action: 'press' });
    assert.equal(bad.ok, false);
    const ok = await m.webAct({ action: 'press', text: 'Enter' });
    assert.equal(ok.ok, true);
  });
});

test('输出过长时截断并标注（不整坨塞进上下文）', async () => {
  // 造 200KB 输出
  await withBin('python3 -c "print(\\"x\\" * 200000)"', async (m) => {
    const r = await m.webRead({ url: 'https://example.com' });
    assert.equal(r.ok, true);
    const out = r.output ?? '';
    assert.ok(out.length < 61_000, `应截断，实际 ${out.length}`);
    assert.match(out, /已截断/);
  });
});

test('CLI 不存在时给可执行的修复提示，而不是裸 ENOENT', async () => {
  const prev = process.env['DOTD_AGENT_BROWSER_BIN'];
  process.env['DOTD_AGENT_BROWSER_BIN'] = '/nonexistent/definitely-not-here';
  try {
    const m = (await import(`../src/exec/webtools.ts?c=${Date.now()}`)) as typeof import('../src/exec/webtools.ts');
    const r = await m.webRead({ url: 'https://example.com' });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /npm i -g agent-browser/);
  } finally {
    if (prev === undefined) delete process.env['DOTD_AGENT_BROWSER_BIN'];
    else process.env['DOTD_AGENT_BROWSER_BIN'] = prev;
  }
});
