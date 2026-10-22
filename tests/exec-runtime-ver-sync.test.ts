/**
 * tests/exec-runtime-ver-sync.test.ts —— exec_dots.runtime_ver 必须跟着配置走。
 *
 * 现场（2026-10-22 升级 runtime 到 0.2.1 时）：
 *   容器起来了，状态却是 quarantined，所有 fs.* 返回
 *   `container_not_ready: 容器状态 quarantined 不可派发（需 ready）`。
 *   模型一个文件工具都用不了 —— 上下文修复全部落空。
 *
 * 根因：ensureDot 更新已有行的语句是 `o.runtimeVer ?? existing.runtime_ver`，
 * 而所有调用方都不传 runtimeVer。于是：
 *   - 镜像 tag 由 cfg.runtimeVer 决定 → 变成新的；
 *   - 库里的 runtime_ver 停在首次 create 的值 → 没变。
 * 每次 boot 都判「镜像漂移」→ 重建容器；重建后库里还是旧版本号 → 下次 boot 再判漂移。
 * 24 小时内累计 >3 次触发上限，dot 转 quarantined，永久不可派发（除非手动改库）。
 *
 * 这是「升一次版本锁死一次」的自锁缺陷，不是一次性环境问题，所以要钉住。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'exec', 'fleet.ts'), 'utf8');

test('ensureDot 更新已有行时，runtime_ver 对齐当前配置而不是沿用旧值', () => {
  // 反例守卫：只看**代码行**，不能连注释里的说明一起匹配（否则自伤）。
  const codeLines = src
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
  assert.ok(
    !codeLines.some((l) => l.includes('o.runtimeVer ?? existing.runtime_ver')),
    'runtime_ver 不能沿用 existing —— 升级后永远不更新，会触发镜像漂移重建循环',
  );
  assert.ok(
    src.includes('o.runtimeVer ?? cfg.runtimeVer'),
    'runtime_ver 缺省必须对齐 cfg.runtimeVer（配置是唯一真相源）',
  );
});

test('迁移/新插入路径也用 cfg.runtimeVer', () => {
  // INSERT 分支本来就对，钉住防止将来被改坏
  assert.match(src, /o\.runtimeVer \?\? cfg\.runtimeVer/);
});

test('镜像 tag 由 defaultExecConfig.runtimeVer 驱动（改版本必须改这里）', () => {
  const types = readFileSync(join(here, '..', 'src', 'exec', 'types.ts'), 'utf8');
  const m = /runtimeVer:\s*'([0-9.]+)'/.exec(types);
  assert.ok(m !== null, 'types.ts 里必须能读到 runtimeVer');
  // 与镜像 tag 拼装处保持一致
  const proto = readFileSync(join(here, '..', 'src', 'exec', 'protocol.ts'), 'utf8');
  assert.match(proto, /exec:\$\{|exec:\{/, 'imageTag 里应拼接 runtimeVer');
});
