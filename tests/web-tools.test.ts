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
  // 2026-10-22 修（Windows 上这个测试整套报红）：
  // 原实现只会写一个 **bash 脚本**（无扩展名），Windows 上
  // spawn 无法执行它 → 全部 web.* 断言失败（实测 19 个红）。
  //
  // Windows 上为什么不用 .cmd/.bat：产品用 execFile 的**数组形式且不过 shell**
  // （安全要求：不能为了测试放开），而 Node 从 18.20/20.12 起禁止无 shell
  // 调用 .cmd/.bat（CVE-2024-27980）→ spawn EINVAL（实测确认）。
  //
  // 解法：Windows 上直接把 **node.exe 本身**当假 CLI（真 .exe，能被 execFile 调起），
  // 再用 NODE_OPTIONS=--require 预载一个 shim：shim 打印并 exit(0)，node 还没开始解析
  // "open" 这个主脚本就退出了。实测：execFile(node.exe,['open','https://x'])
  // 输出 SHIM-OK args=...，退出码 0。
  // 两边输出必须一致：测试断言的是 stdout 内容（如 ARGS:$* 的参数串接）。
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'ab-shim.cjs'), nodeFake(script), 'utf8');
    return process.execPath; // 真正的 BIN 返回值 = node.exe
  }
  const p = join(dir, 'agent-browser');
  writeFileSync(p, `#!/usr/bin/env bash\n${script}\n`, 'utf8');
  chmodSync(p, 0o755);
  return p;
}

/**
 * Windows 版假 CLI：把测试里那些 bash 片段的**输出**等价地用 Node 重现。
 * 只支持测试实际用到的几种：
 *   - `echo X`            → 输出 X
 *   - `echo "ARGS:$*"`    → 输出 ARGS: + 全部参数（逐个用空格分隔）
 *   - `python3 -c "print(...)"` → 用 Node 的等价表达（输出长字符串）
 *   - 其余：原样输出一行文本（让测试能看到可诊断的错误）
 */
function nodeFake(script: string): string {
  const echoArgs = script.match(/echo "ARGS:\$\*"/);
  // 双引号的 echo 要把引号内容取出来（否则输出的是原始脚本文本）：
  //   echo "✓ My Title"      → ✓ My Title
  //   echo "- link \"x\" [ref=e1]" → - link "x" [ref=e1]
  // 原实现用了 `(?!")` 负向预览，导致**引号形式全部走到 else 分支**→
  // 输出的是脚本原文（测试断言的 title 就是「✓ My Title」。实测：14 个 web.* 断言全红。
  const echoQuoted = script.match(/^echo "(.*)"$/);
  const echoPlain = script.match(/^echo (.*)$/);
  // 长输出：python3 -c "print(\"x\" * 200000)"。脚本里的引号是**转义输的**（\"），
  // 原正则只匹配未转义的引号，因此这条落到 else 分支 → 输出的是脚本原文。
  const longStr = script.match(/print\(\\?"([^"]*)\\?" \* (\d+)\)/) ?? script.match(/print\(\?"([^"]*)\?" \* (\d+)\)/);
  // Windows 版的 argv 形状（实测）：用 --require 预载 shim 时，
  // node 把第一个位置参数当作"主脚本路径"并位于 argv[1]（已被解析成
  // 绝对路径，如 D:\toagi\dotd\press），真正的 CLI 参数从 argv[1] 开始。
  // bash 版的 $*是"脚本名之后的全部参数"，所以这里取 argv[1..] 并把第一个
  // 只留本名（否则断言会看到一个绝对路径）。
  const argsExpr = "process.argv.slice(1).map((a, i) => (i === 0 ? a.split(/[\\\\/]/).pop() : a)).join(' ')";
  let body: string;
  if (echoArgs !== null) {
    body = `process.stdout.write('ARGS:' + ${argsExpr} + '\\n');`;
  } else if (longStr !== null && longStr[1] !== undefined && longStr[2] !== undefined) {
    const text = longStr[1].replace(/\\\\"/g, '"').replace(/\\\\\\\\/g, '\\');
    const times = Number(longStr[2]);
    body = `process.stdout.write(${JSON.stringify(text)}.repeat(${times}));`;
  } else if (echoQuoted !== null && echoQuoted[1] !== undefined) {
    // 双引号内容：去掉外层引号，内容里的 \" 恢复为普通引号
    const inner = echoQuoted[1].replace(/\\\\"/g, '"').replace(/\\\\\\\\/g, '\\');
    body = `process.stdout.write(${JSON.stringify(inner)} + '\\n');`;
  } else if (echoPlain !== null && echoPlain[1] !== undefined) {
    body = `process.stdout.write(${JSON.stringify(echoPlain[1].replace(/\\\\/g, '\\'))} + '\\n');`;
  } else {
    body = `process.stdout.write(${JSON.stringify(script)} + '\\n');`;
  }
  return [
    '// 自动生成：Windows 上的假 agent-browser（与 bash 版输出等价）',
    body,
    // 必须 exit(0)：bash 版假 CLI 执行完 echo 就自然退出 0；而 node 预载 shim 写完
    // 输出后会继续把第一个位置参数（如 "open"）当主脚本去解析 → 报
    // "Cannot find module 'D:\toagi\dotd\open'"，下游把这个错误当成 CLI 失败（实测 14 个 web.* 全红）。
    'process.exit(0);',
  ].join('\n');
}

/** 每个用例独立设环境变量并重新 import（BIN 在模块加载时读取）。 */
async function withBin<T>(script: string, fn: (m: typeof import('../src/exec/webtools.ts')) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'webtools-'));
  const bin = fakeBin(dir, script);
  const prev = process.env['DOTD_AGENT_BROWSER_BIN'];
  const prevNodeOpts = process.env['NODE_OPTIONS'];
  if (process.platform === 'win32') {
    // 让 node.exe 以 shim 起手（见 fakeBin 的说明）
    process.env['NODE_OPTIONS'] = `--require ${join(dir, 'ab-shim.cjs').replace(/\\/g, '/')}`;
  }
  process.env['DOTD_AGENT_BROWSER_BIN'] = bin;
  try {
    // 缓存 busting：每次换 query 让 ESM 重新求值，从而重读 BIN
    const m = (await import(`../src/exec/webtools.ts?b=${Date.now()}${Math.random()}`)) as typeof import('../src/exec/webtools.ts');
    return await fn(m);
  } finally {
    if (prev === undefined) delete process.env['DOTD_AGENT_BROWSER_BIN'];
    else process.env['DOTD_AGENT_BROWSER_BIN'] = prev;
    if (prevNodeOpts === undefined) delete process.env['NODE_OPTIONS'];
    else process.env['NODE_OPTIONS'] = prevNodeOpts;
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


test('agent-browser 退出码 0 但输出 ✗ 时，必须判失败（2026-10-22 真机）', async () => {
  // 现场：填表任务点 `button[type="submit"]`，agent-browser 输出
  //   `✗ Element not found: button[type="submit"]. Verify the selector…`
  // 而**退出码是 0**。老代码只看 code，于是回一句 `✓ Done`。
  // 模型以为点了 5 次提交，其实一次都没点中，最后判定「我没有浏览器能力」——
  // 前 28 步全白做。
  //
  // 同一份输出还曾被 friendlyFailure 判成「agent-browser 不可用：请确认已安装」，
  // 因为老正则 `/ENOENT|not found/i` 把 `Element not found` 也吞了。
  await withBin('echo "✗ Element not found: button"', async (m) => {
    const r = await m.webAct({ action: 'click', ref: '@e1' });
    assert.equal(r.ok, false, '退出码 0 但输出 ✗ 的调用不能报成功');
    assert.match(r.error ?? '', /没找到这个元素/, '要说清是页面元素没了，不是环境没装');
    assert.doesNotMatch(r.error ?? '', /请确认已安装/, '不能把元素不存在误报成没装');
  });
});

test('元素不存在时不要谎报「agent-browser 没装」', async () => {
  // 真机第二次踩：点 submit 报「请确认已安装」，紧接着 browser.open 又成功。
  // 环境明明是好的，一句假话就足以让模型放弃整个任务。
  await withBin('echo "✗ Element not found: button[type=submit]"', async (m) => {
    const r = await m.webAct({ action: 'fill', ref: '@e9', text: 'x' });
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.error ?? '', /npm i -g agent-browser/);
    assert.match(r.error ?? '', /web\.snapshot|重新取/, '要给出可执行的下一步');
  });
});
