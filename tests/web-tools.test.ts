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

// ══════════════════════════════════════════════════════════════════
// browser.* 兼容层（2026-10-21，统一到 agent-browser）
// ══════════════════════════════════════════════════════════════════
//
// 宿主侧注册同名 browser.* 覆盖容器里那套 playwright 实现。这里验的是
// **翻译层**：老参数形状要能正确变成 agent-browser 的子命令，且 identity
// 派生规则必须和 runner 的 resolveBrowserIdentity 一致（否则治理与执行会错位）。

test('browser.open 把 url 变成 open 子命令，并回 {url,title}', async () => {
  await withBin('echo "✓ My Title"', async (m) => {
    const r = await m.legacyBrowser('browser.open', { url: 'https://example.com/x' });
    assert.equal(r.ok, true);
    const info = JSON.parse(r.output ?? '{}') as { url?: string; title?: string };
    assert.equal(info.url, 'https://example.com/x');
    assert.equal(info.title, 'My Title');
  });
});

test('browser.open 拒绝非 http(s)', async () => {
  await withBin('echo SHOULD_NOT_RUN', async (m) => {
    const r = await m.legacyBrowser('browser.open', { url: 'file:///etc/passwd' });
    assert.equal(r.ok, false);
  });
});

test('browser.act 翻译 click/type/submit/scroll/wait', async () => {
  await withBin('echo "ARGS:$*"', async (m) => {
    const click = await m.legacyBrowser('browser.act', { action: 'click', selector: '@e1' });
    assert.equal(click.ok, true);
    assert.match(click.output ?? '', /ARGS:click @e1/);

    const type = await m.legacyBrowser('browser.act', { action: 'type', selector: '#q', value: 'hi' });
    assert.equal(type.ok, true);
    assert.match(type.output ?? '', /ARGS:type #q hi/);

    // submit 是 click 的同义词（老接口有它，agent-browser 没有单独命令）
    const submit = await m.legacyBrowser('browser.act', { action: 'submit', selector: 'form' });
    assert.equal(submit.ok, true);
    assert.match(submit.output ?? '', /ARGS:click form/);

    // wait 不传 selector 时给一个默认时长，而不是空命令
    const wait = await m.legacyBrowser('browser.act', { action: 'wait' });
    assert.equal(wait.ok, true);
    assert.match(wait.output ?? '', /ARGS:wait 500/);

    const scroll = await m.legacyBrowser('browser.act', { action: 'scroll', value: 'up' });
    assert.equal(scroll.ok, true);
    assert.match(scroll.output ?? '', /ARGS:scroll up/);
  });
});

test('browser.act 未知 action 给可用清单，不静默失败', async () => {
  await withBin('echo SHOULD_NOT_RUN', async (m) => {
    const r = await m.legacyBrowser('browser.act', { action: 'teleport', selector: 'x' });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /不支持 action=teleport/);
  });
});

test('browser.act 缺 selector 时说清哪个动作需要它', async () => {
  await withBin('echo SHOULD_NOT_RUN', async (m) => {
    const r = await m.legacyBrowser('browser.act', { action: 'click' });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /click 需要 selector/);
  });
});

test('browser.snapshot 不带 url（沿用当前页）', async () => {
  await withBin('echo "- link \\"x\\" [ref=e1]"', async (m) => {
    const r = await m.legacyBrowser('browser.snapshot', {});
    assert.equal(r.ok, true);
    assert.match(r.output ?? '', /ref=e1/);
  });
});

test('browser.close 翻译成 close', async () => {
  await withBin('echo closed', async (m) => {
    const r = await m.legacyBrowser('browser.close', {});
    assert.equal(r.ok, true);
    assert.match(r.output ?? '', /已关闭/);
  });
});

test('identity 派生：显式优先，anon 无痕，缺省按域名 site:<host>', async () => {
  // 假 CLI 把 --session 打出来，间接验证 sessionOf(identityOf(args)) 的结果
  await withBin('echo "ARGS:$*"', async (m) => {
    // 显式 identity → 有 --session
    const explicit = await m.legacyBrowser('browser.open', {
      url: 'https://a.example.com',
      identity: 'work',
    });
    assert.equal(explicit.ok, true);
    assert.match(explicit.output ?? '', /--session/);

    // anon → 无痕，不该出现 --session
    const anon = await m.legacyBrowser('browser.open', {
      url: 'https://a.example.com',
      identity: 'anon',
    });
    assert.equal(anon.ok, true);
    assert.doesNotMatch(anon.output ?? '', /--session/);

    // 缺省 + 有 url → 按域名派生，仍会有 --session
    const derived = await m.legacyBrowser('browser.open', { url: 'https://b.example.com/z' });
    assert.equal(derived.ok, true);
    assert.match(derived.output ?? '', /--session/);
  });
});

test('identity 派生稳定：同一域名两次调用落到同一 session', async () => {
  await withBin('echo "ARGS:$*"', async (m) => {
    const a = await m.legacyBrowser('browser.open', { url: 'https://same.example.com/1' });
    const b = await m.legacyBrowser('browser.open', { url: 'https://same.example.com/2' });
    const sessA = /--session (\S+)/.exec(a.output ?? '')?.[1];
    const sessB = /--session (\S+)/.exec(b.output ?? '')?.[1];
    assert.ok(sessA !== undefined && sessA === sessB, `同一域名应同 session：${sessA} vs ${sessB}`);
  });
});

test('identity 派生不撞车：不同域名用不同 session', async () => {
  await withBin('echo "ARGS:$*"', async (m) => {
    const a = await m.legacyBrowser('browser.open', { url: 'https://one.example.com' });
    const b = await m.legacyBrowser('browser.open', { url: 'https://two.example.com' });
    const sessA = /--session (\S+)/.exec(a.output ?? '')?.[1];
    const sessB = /--session (\S+)/.exec(b.output ?? '')?.[1];
    assert.ok(sessA !== sessB, `不同域名必须分开：${sessA} vs ${sessB}`);
  });
});

test('会话继承：open 之后的 snapshot 用同一个 session（否则看到空白页）', async () => {
  // 这是实机踩到的缺陷：browser.open 带 url 能派生 session，但随后的
  // browser.snapshot 没有 url → 早先退化成匿名 session，看到的是另一个空白页，
  // 返回 "(no interactive elements)"。修法是按 taskKey 记住当前站点。
  await withBin('echo "ARGS:$*"', async (m) => {
    const opened = await m.legacyBrowser('browser.open', { url: 'https://ext.example.com/p' }, 'task-1');
    const sessOpen = /--session (\S+)/.exec(opened.output ?? '')?.[1];
    assert.ok(sessOpen !== undefined, 'open 应带 --session');

    const snap = await m.legacyBrowser('browser.snapshot', {}, 'task-1');
    const sessSnap = /--session (\S+)/.exec(snap.output ?? '')?.[1];
    assert.equal(sessSnap, sessOpen, 'snapshot 必须继承 open 的 session');
  });
});

test('会话继承：不同任务互不串（各有各的浏览器）', async () => {
  await withBin('echo "ARGS:$*"', async (m) => {
    await m.legacyBrowser('browser.open', { url: 'https://a.example.com' }, 'task-A');
    const snapA = await m.legacyBrowser('browser.snapshot', {}, 'task-A');
    assert.match(snapA.output ?? '', /--session/);

    // task-B 还没 open 过：不该凭空继承 task-A 的
    const snapB = await m.legacyBrowser('browser.snapshot', {}, 'task-B');
    assert.doesNotMatch(snapB.output ?? '', /--session/);
  });
});

test('会话继承：browser.close 之后清掉，不再凭空继承', async () => {
  await withBin('echo "ARGS:$*"', async (m) => {
    await m.legacyBrowser('browser.open', { url: 'https://c.example.com' }, 'task-C');
    await m.legacyBrowser('browser.close', {}, 'task-C');
    const after = await m.legacyBrowser('browser.snapshot', {}, 'task-C');
    assert.doesNotMatch(after.output ?? '', /--session/, 'close 后不该再继承');
  });
});

test('会话继承：anon 显式无痕不被记进继承表', async () => {
  await withBin('echo "ARGS:$*"', async (m) => {
    await m.legacyBrowser('browser.open', { url: 'https://d.example.com', identity: 'anon' }, 'task-D');
    const snap = await m.legacyBrowser('browser.snapshot', {}, 'task-D');
    assert.doesNotMatch(snap.output ?? '', /--session/, 'anon 之后不该继承出登录态 session');
  });
});
