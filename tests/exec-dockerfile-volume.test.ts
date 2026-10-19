/**
 * tests/exec-dockerfile-volume.test.ts —— Dockerfile 的 VOLUME 指令不得带行尾注释。
 *
 * 现场（2026-10-19）：Dockerfile 里写的是
 *
 *     VOLUME ["/dot/home", "/dot/profiles"]     # state 卷与 token bind 在容器创建参数里挂
 *
 * 看着像普通注释，但 **docker 对 JSON 数组形式的指令不做行尾注释剥离** ——
 * `#` 之后的文字会被按空格拆开当成数组元素。实测镜像声明了 8 个卷：
 *
 *   "/dot/home", "/dot/profiles", "#", "state", "卷与", "token", "bind",
 *   "在容器创建参数里挂", "[/dot/home,", "/dot/profiles]"
 *
 * 后果：每次创建容器都白建 8 个匿名卷（累积 168 个、129 个孤儿），
 * 容器里还多出 `/dot/profiles]`、`/dot/home,` 这种畸形目录。
 *
 * 这个测试用**正则扫描 Dockerfile**：任何 `VOLUME [...]` 同一行后面跟 `#` 都算失败。
 * 不依赖 docker 环境，纯文本检查，确保下次改不回去。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(join(here, '..', 'exec-image', 'Dockerfile'), 'utf8');

test('Dockerfile: VOLUME 指令不得带行尾注释（会被当成数组元素）', () => {
  const lines = dockerfile.split('\n');
  const bad: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!/^VOLUME\s+\[/i.test(trimmed)) continue;
    // JSON 数组里不可能合法地出现 # 注释，出现了就是被当成元素了
    if (trimmed.includes('#')) bad.push(`第 ${i + 1} 行: ${trimmed}`);
  }
  assert.deepEqual(bad, [], `VOLUME 行不能带 # 注释，否则 docker 会把它拆成卷路径：\n${bad.join('\n')}`);
});

test('Dockerfile: VOLUME 恰好声明 home 与 profiles 两个', () => {
  const m = /^VOLUME\s+(\[[^\]]*\])/im.exec(dockerfile);
  assert.ok(m !== null, 'Dockerfile 应有 VOLUME 指令');
  const arr = JSON.parse(m[1]!) as string[];
  assert.deepEqual(arr.sort(), ['/dot/home', '/dot/profiles'], `VOLUME 只能是这两个，实际：${JSON.stringify(arr)}`);
});
