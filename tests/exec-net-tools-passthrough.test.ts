/**
 * tests/exec-net-tools-passthrough.test.ts —— 出网开关必须真的传进容器。
 *
 * 现场（2026-10-18）：主人在飞书问"今天天气"，模型调 net.get 拿到 \`not_implemented\`，
 * 回复"出网工具没接通"。查下来是**三层叠加**：
 *
 *   ① 容器侧 agent-runtime/server.ts 读的是**容器自己的** process.env['DOTD_NET_TOOLS']；
 *   ② 宿主侧 containerEnvAndLabels 只传 5 个变量，**从来不传 DOTD_NET_TOOLS** ——
 *      所以无论宿主怎么设，容器里永远走缺省 off；
 *   ③ 默认 off（有意为之，符合"唯一外部依赖是可换 base_url 的模型 API"这条立身之本）。
 *
 * ①③ 是对的，②是缺陷。本文件钉住 ②：开关配了就必须出现在容器 spec 的 Env 里；
 * 没配时必须**不出现**（保持默认关闭，不能因为代码改动就意外放开出网）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { containerEnvAndLabels } from '../src/exec/protocol.ts';
import { DEFAULT_EXEC_CONFIG, execConfigFromEnv } from '../src/exec/types.ts';

const limits = { memMb: 1536, cpuMillis: 2000 };

test('未配置出网 → 容器 spec 里不出现 DOTD_NET_TOOLS（默认关闭不被意外放开）', () => {
  const cfg = { ...DEFAULT_EXEC_CONFIG };
  const { env } = containerEnvAndLabels(cfg, 'dot1', limits);
  assert.equal(
    env.some((e) => e.startsWith('DOTD_NET_TOOLS=')),
    false,
    '没配开关时容器不该收到任何 DOTD_NET_TOOLS（容器侧缺省 off）',
  );
});

test('DOTD_NET_TOOLS=get → 真的出现在容器 spec 的 Env 里', () => {
  const cfg = execConfigFromEnv({ DOTD_NET_TOOLS: 'get' } as NodeJS.ProcessEnv);
  const { env } = containerEnvAndLabels(cfg, 'dot1', limits);
  assert.ok(
    env.includes('DOTD_NET_TOOLS=get'),
    `容器必须收到开关，实际 Env=${JSON.stringify(env)}`,
  );
});

test('DOTD_NET_TOOLS=all → 收到 all', () => {
  const cfg = execConfigFromEnv({ DOTD_NET_TOOLS: 'all' } as NodeJS.ProcessEnv);
  const { env } = containerEnvAndLabels(cfg, 'dot1', limits);
  assert.ok(env.includes('DOTD_NET_TOOLS=all'));
});

test('拼错（GET / enabled / 空串）→ 按 off 处理，绝不意外放开出网', () => {
  for (const bad of ['GET', 'enabled', 'on', '', 'true']) {
    const cfg = execConfigFromEnv({ DOTD_NET_TOOLS: bad } as NodeJS.ProcessEnv);
    const { env } = containerEnvAndLabels(cfg, 'dot1', limits);
    assert.equal(
      env.some((e) => e.startsWith('DOTD_NET_TOOLS=')),
      false,
      `'${bad}' 不该被当成开启出网`,
    );
  }
});

test('off 显式声明 → 也不传（与缺省等价）', () => {
  const cfg = execConfigFromEnv({ DOTD_NET_TOOLS: 'off' } as NodeJS.ProcessEnv);
  const { env } = containerEnvAndLabels(cfg, 'dot1', limits);
  assert.equal(env.some((e) => e.startsWith('DOTD_NET_TOOLS=')), false);
});

test('其它关键变量不受影响（回归）', () => {
  const cfg = execConfigFromEnv({ DOTD_NET_TOOLS: 'get' } as NodeJS.ProcessEnv);
  const { env } = containerEnvAndLabels(cfg, 'dot1', limits);
  assert.ok(env.includes('DOTD_TOKEN_PATH=/run/dotd/token'));
  assert.ok(env.includes('DISPLAY=:99'));
  assert.ok(env.some((e) => e.startsWith('DOTD_RUNTIME_PORT=')));
  // 契约 T5：容器内不得注入模型 base_url
  assert.equal(env.some((e) => /MODEL|BASE_URL/.test(e)), false);
});
