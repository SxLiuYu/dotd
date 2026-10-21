/**
 * A1 浏览器登录态持久化 —— 身份解析纯函数（2026-10-21）。
 * 覆盖：派发（site:<host>）、显式覆盖（含 anon）、任务内继承、非浏览器工具不挂身份。
 * 真机持久性（跨 docker restart 的 cookie 存活）由 scripts/regress/browser-identity-e2e.sh 验。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBrowserIdentity, siteIdentityOf } from '../src/runner/dot.ts';

describe('A1 siteIdentityOf：网址 → 站点身份', () => {
  it('https 网址派生 site:<host>', () => {
    assert.equal(siteIdentityOf('https://www.example.com/login?a=1'), 'site:www.example.com');
  });
  it('端口号不进身份（host 不含 port）', () => {
    assert.equal(siteIdentityOf('http://127.0.0.1:8899/read'), 'site:127.0.0.1');
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