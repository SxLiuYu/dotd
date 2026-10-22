/**
 * A1 浏览器登录态持久化 —— 身份解析纯函数（2026-10-21）。
 * 覆盖：派发（site:<host>）、显式覆盖（含 anon）、任务内继承、非浏览器工具不挂身份。
 * 真机持久性（跨 docker restart 的 cookie 存活）由 scripts/regress/browser-identity-e2e.sh 验。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../src/shared/contracts.ts';
import { resolveBrowserIdentity, siteIdentityOf, toolCall } from '../src/runner/dot.ts';

describe('A1 siteIdentityOf：网址 → 站点身份', () => {
  it('https 网址派生 site:<host>', () => {
    assert.equal(siteIdentityOf('https://www.example.com/login?a=1'), 'site:www.example.com');
  });
  it('端口号不进身份（host 不含 port）', () => {
    assert.equal(siteIdentityOf('http://127.0.0.1:8899/read'), 'site:127.0.0.1');
  });
  it('无 hostname 的 URL（file:/data:/about:）→ undefined，治理 fail-closed 拒绝', () => {
    // 2026-10-22 真机实测反复踩到：用 file:// 试浏览器时，browser.open 连续拿到
    // 8 次一模一样的 `deny:identity_missing`，很像是「浏览器坏了」。
    // 实际是**设计正确**：这些 URL 解析不出 hostname，派生不出 site:<host> 身份，
    // 于是 identity=undefined → isLoginSensitive 判 true → 治理按登录态 fail-closed。
    // 这条判据必须留住：它是「不许用浏览器读宿主本地文件」的底层保证之一
    // （另一层在 webtools 里只放行 http(s)）。
    assert.equal(siteIdentityOf('file:///tmp/form.html'), undefined);
    assert.equal(siteIdentityOf('data:text/html,hi'), undefined);
    assert.equal(siteIdentityOf('about:blank'), undefined);
    // 对照：正常站点必须能派生，否则上面的断言会因为「全都返回 undefined」而假绿
    assert.equal(siteIdentityOf('https://example.com/'), 'site:example.com');
  });
  it('解析不了 → undefined（不派发，fail-closed 由治理兜）', () => {
    assert.equal(siteIdentityOf('not a url'), undefined);
    assert.equal(siteIdentityOf(''), undefined);
    assert.equal(siteIdentityOf(42), undefined);
    assert.equal(siteIdentityOf(undefined), undefined);
  });
});

describe('A1 resolveBrowserIdentity：派发与治理共用的判定', () => {
  it('非 browser.* 一律 undefined（不挂 identity 字段）', () => {
    assert.equal(resolveBrowserIdentity('fs.read', { path: 'x' }, undefined), undefined);
    assert.equal(resolveBrowserIdentity('mail.list', { account: '163' }, 'site:a.com'), undefined);
    assert.equal(resolveBrowserIdentity('shell.run', {}, 'site:a.com'), undefined);
  });
  it('browser.open 缺省派发 site:<host>', () => {
    assert.equal(
      resolveBrowserIdentity('browser.open', { url: 'https://a.com/x' }, undefined),
      'site:a.com',
    );
  });
  it('显式 args.identity 永远优先（含 anon=无痕）', () => {
    assert.equal(
      resolveBrowserIdentity('browser.open', { url: 'https://a.com', identity: 'mybank' }, 'site:old.com'),
      'mybank',
    );
    assert.equal(
      resolveBrowserIdentity('browser.open', { url: 'https://a.com', identity: 'anon' }, undefined),
      'anon',
    );
  });
  it('act/snapshot/close 继承任务内最近一次 open 的身份', () => {
    assert.equal(resolveBrowserIdentity('browser.act', { action: 'click' }, 'site:a.com'), 'site:a.com');
    assert.equal(resolveBrowserIdentity('browser.snapshot', {}, 'site:b.com'), 'site:b.com');
    assert.equal(resolveBrowserIdentity('browser.close', {}, 'site:a.com'), 'site:a.com');
  });
  it('没有继承源（prev=undefined）→ undefined（fail-closed）', () => {
    assert.equal(resolveBrowserIdentity('browser.act', { action: 'click' }, undefined), undefined);
  });
  it('显式身份连 act 也生效（模型显式 anon → 无痕）', () => {
    assert.equal(resolveBrowserIdentity('browser.act', { identity: 'anon' }, 'site:a.com'), 'anon');
  });
});

/**
 * A1 端到端（2026-10-21 补）：identity 在两条路径上必须**各得其所**。
 *
 * 踩过的真实现场：曾在 toolCall() 里统一剥掉 args.identity（理由是"容器 schema
 * additionalProperties:false 会 400 拒"）。但 browser.* 已由宿主 agent-browser
 * 承接、根本不进容器，而宿主侧身份 100% 从 args 读（webtools.identityOf），
 * 于是 runner 决议出 mybank、宿主却只看到 undefined → 静默退回匿名登录态。
 *
 * 这组用例钉住：宿主拿得到、容器收不到。
 */
describe('A1 身份分配：宿主吃 args，容器不吃', () => {
  const task = { id: 't1', dotId: 'dot1' } as unknown as Task;

  it('toolCall() 不剥 args.identity（宿主侧要靠它派生 session）', () => {
    const c = toolCall(task, 'c1', 'browser.open', { url: 'https://a.com', identity: 'mybank' }, 5000);
    assert.equal(c.args['identity'], 'mybank', 'toolCall 剥掉就等于宿主拿不到身份');
    assert.equal(c.identity, 'mybank', '顶层 identity 仍按契约 G1 承载');
  });

  it('缺省派发的 site:<host> 只落顶层，不往 args 里塞', () => {
    const c = toolCall(task, 'c2', 'browser.open', { url: 'https://a.com/x' }, 5000);
    assert.equal(c.identity, 'site:a.com');
    assert.equal(c.args['identity'], undefined, '不该凭空往 args 加字段');
  });

  it('非 browser.* 工具完全不碰 args', () => {
    const args = { path: '/x', identity: 'whatever' };
    const c = toolCall(task, 'c3', 'fs.read', args, 5000);
    assert.deepEqual(c.args, args, '非浏览器工具不该被动过');
  });
});
