/**
 * tests/exec-host-side-tools.test.ts —— 宿主侧工具白名单必须覆盖全部宿主侧工具。
 *
 * 现场（2026-10-19）：加了 `schedule.remove` 能力、注册了宿主处理器、登记了治理档位，
 * 唯独**忘了往 `HOST_SIDE_TOOLS` 白名单里加**。后果：模型看到的工具清单里没有它，
 * 回答"我拿不到 schedule.remove 这个工具"，删除功能形同不存在。
 *
 * 这个坑很隐蔽：能力目录里有、治理登记了、处理器也注册了 —— 但 `getCapabilities`
 * 用容器目录 + 白名单合并，白名单漏了就等于没暴露。
 *
 * 守卫思路：把所有以 `schedule.` 开头的宿主侧工具都找出来，逐个断言在白名单里。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'exec', 'ExecService.ts'), 'utf8');

function hostSideSet(): string[] {
  const m = /const HOST_SIDE_TOOLS = new Set\(\[([^\]]*)\]\)/.exec(src);
  assert.ok(m !== null, 'ExecService.ts 里应有 HOST_SIDE_TOOLS 白名单');
  return m![1]!
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter((s) => s.length > 0);
}

test('HOST_SIDE_TOOLS 覆盖所有 schedule.* 宿主侧工具', () => {
  const set = hostSideSet();
  // 这些是由 daemon 直接执行（不进容器）的工具，必须全部在白名单里
  for (const name of ['schedule.create', 'schedule.list', 'schedule.remove']) {
    assert.ok(set.includes(name), `${name} 必须在 HOST_SIDE_TOOLS 里，否则模型看不到它`);
  }
});

test('HOST_SIDE_TOOLS 里的每一项都真的被 registerHostTool 注册了', () => {
  const fs = readFileSync(join(here, '..', 'src', 'daemon.ts'), 'utf8');
  for (const name of hostSideSet()) {
    assert.ok(
      fs.includes(`registerHostTool('${name}'`),
      `${name} 在白名单里但 daemon 没注册处理器 —— 模型看得到却调不通`,
    );
  }
});

test('容器侧工具（fs.*/shell.*）不得出现在宿主侧白名单里', () => {
  const set = hostSideSet();
  for (const name of ['fs.read', 'fs.write', 'fs.remove', 'fs.stat', 'fs.list', 'shell.run']) {
    assert.ok(!set.includes(name), `${name} 是容器工具，不该进宿主侧白名单（会合并出重复项）`);
  }
});
