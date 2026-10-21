/**
 * tests/exec-browser-identity-strip.test.ts —— args.identity 只在"真要去容器"时剥。
 *
 * 现场（2026-10-21）：补丁原先写在 runner 的 toolCall() 里，理由是"容器侧 args
 * schema 是 additionalProperties:false，多带 identity 会被 400 拒"。
 *
 * 但同一天 browser.* 改由宿主 agent-browser 承接（daemon.ts registerHostTool）
 * **不进容器**，而宿主侧身份 100% 从 args 读（webtools.identityOf(args, taskKey)；
 * runToolInner 只把 call.args 交给宿主，call.identity 不进 args）。
 *
 * 于是实测复现：runner 决议 call.identity = 'mybank'，宿主 handler 收到的
 * args.identity === undefined → 退回匿名 session，登录态静默丢失。
 *
 * 修法：剥离搬到 ExecService.dispatch()（唯一确定要进容器的点）。
 * 这组用例把两个方向都钉死：宿主拿得到、容器收不到。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stripIdentityForContainer } from '../src/exec/ExecService.ts';
import type { ExecToolCall } from '../src/shared/contracts.ts';

function callOf(tool: string, args: Record<string, unknown>): ExecToolCall {
  return {
    call_id: 'c1',
    task_id: 't1',
    dot_id: 'dot1',
    tool: tool as ExecToolCall['tool'],
    args,
    identity: 'mybank',
    deadline_ms: 5000,
    issued_at: new Date().toISOString(),
  };
}

describe('stripIdentityForContainer：只对 browser.* 生效', () => {
  it('browser.open 的 args.identity 被剥掉（容器 schema 会 400 拒它）', () => {
    const out = stripIdentityForContainer(callOf('browser.open', { url: 'https://a.com', identity: 'mybank' }));
    assert.equal(out.args['identity'], undefined);
    assert.equal(out.args['url'], 'https://a.com', '其余参数必须原样保留');
  });

  it('顶层 call.identity 不受影响（契约 G1 仍承载身份）', () => {
    const out = stripIdentityForContainer(callOf('browser.open', { url: 'https://a.com', identity: 'mybank' }));
    assert.equal(out.identity, 'mybank');
  });

  it('browser.act / snapshot / close 同样剥', () => {
    for (const t of ['browser.act', 'browser.snapshot', 'browser.close']) {
      const out = stripIdentityForContainer(callOf(t, { identity: 'anon', action: 'click' }));
      assert.equal(out.args['identity'], undefined, `${t} 的 identity 应被剥`);
      assert.equal(out.args['action'], 'click', `${t} 的其他参数不能丢`);
    }
  });

  it('非 browser.* 工具一个字节都不动（含 fs/shell/mail）', () => {
    for (const t of ['fs.read', 'shell.run', 'mail.send', 'web.snapshot']) {
      const args = { path: '/x', identity: 'keep-me' };
      const out = stripIdentityForContainer(callOf(t, args));
      assert.deepEqual(out.args, args, `${t} 不属于容器 browser 路径，不该被动`);
    }
  });

  it('没有 identity 时返回原对象（不做无意义拷贝）', () => {
    const c = callOf('browser.open', { url: 'https://a.com' });
    assert.equal(stripIdentityForContainer(c), c, '无 identity 应原样返回，避免多余分配');
  });
});
