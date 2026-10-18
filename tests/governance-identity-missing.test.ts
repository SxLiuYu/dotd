/**
 * tests/governance-identity-missing.test.ts —— 缺 identity 不该走审批。
 *
 * 现场（2026-10-18 真实飞书会话）：
 *   模型想验证"浏览器能力"→ 调 browser.open → 治理弹出审批卡（reason=identity_missing）
 *   → 主人批准 → **执行面照样以 identity_required 拒绝** → 模型再调一次 → 又弹一张审批卡。
 *
 * 这暴露一个真实缺陷：**缺 identity 是配置问题，不是权限问题**。
 * 主人点"批准"解决不了它（身份不会因为批准就出现），走审批只会白弹卡片、白等一轮、
 * 还让模型误以为"再调一次就能过"。
 *
 * 正确行为：直接 deny + 说清缺什么，让模型立刻换路或如实告诉主人。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'governance', 'gate.ts'), 'utf8');

test('缺 identity 时走 deny，不走 approve', () => {
  // 必须有 isIdentityMissing 的早退分支，且返回 kind: 'deny'
  const block = /if \(isIdentityMissing\(call\)\) \{[\s\S]{0,900}?return \{ kind: 'deny'[\s\S]{0,80}\};/.exec(src);
  assert.ok(block !== null, '缺 identity 必须直接 deny 早退');
  assert.ok(
    block[0].includes('identity_missing'),
    'deny 的 reason 里要害含 identity_missing（可排查）',
  );
});

test('审批路径不再用 identity_missing 作为 reason', () => {
  // 反例守卫：loginSensitive 分支不该再出现 'identity_missing' 三元
  assert.equal(
    /loginReason = isIdentityMissing\(call\) \? 'identity_missing' : 'login-sensitive'/.test(src),
    false,
    '缺 identity 已改为 deny，不该再进审批分支',
  );
  assert.ok(
    /const loginReason = 'login-sensitive';/.test(src),
    '真实登录敏感动作仍应走审批（reason=login-sensitive）',
  );
});

test('deny 分支仍写 decisions 与 audit（可追溯）', () => {
  // 用"到下一个 return 为止"作边界，避免被对象字面量的 } 提前截断
  const start = src.indexOf("if (isIdentityMissing(call)) {");
  assert.ok(start >= 0, '必须有缺 identity 的分支');
  const end = src.indexOf("return { kind: 'deny'", start);
  assert.ok(end > start, '分支内必须有 deny 返回');
  const block = src.slice(start, end);
  assert.ok(block.includes('insertDecision'), '必须落 decisions');
  assert.ok(block.includes('appendAudit'), '必须落审计');
});
