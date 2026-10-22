import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 静态守卫：GitHub token 的保险库注入**不许再静默吞错**（2026-10-22）。
 *
 * 现场（真机，不是推演）：
 *   1. /api/connections 显示 connector github = `public_only`，看起来像「没配 token」。
 *   2. echo $DOTD_GITHUB_TOKEN 确实是空 → 更确信没配。
 *   3. 直接调 vaultGet('/root/.dotd', key, 'github.com', 'token') 却**抛异常**：
 *      Error: Unsupported state or unable to authenticate data
 *   4. 同一把 key 解 163.com 条目成功（len=16）→ 说明不是密钥全错，是 github 那条坏了。
 *
 * 真实原因是「条目存在但解不开」，而 daemon.ts 里那个 `catch { }` 是**空的**，
 * 于是它和「压根没配」走同一条静默降级路径，把排查方向彻底带偏。
 *
 * 判据：daemon.ts 里 GitHub 注入的 try 必须有 catch 且 catch 体里**有 log**。
 * 为什么不查运行时：这个分支要构造「vault.json 存在但密钥不匹配」才触发，
 * 而启动路径的静默性本身就是缺陷要防的东西——静态查最直接。
 */
test('静态守卫：GitHub token 注入失败必须留痕，不许空 catch 静默降级', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'src', 'daemon.ts'), 'utf8');

  const start = src.indexOf("vaultGet(vaultDir(), process.env.DOTD_MAIL_KEY, 'github.com', 'token')");
  assert.ok(start > 0, '没有找到 GitHub token 的保险库注入点（被重写？请同步更新本测试）');

  // 取注入点前后的一段，够覆盖整个 try/catch
  const window = src.slice(Math.max(0, start - 700), start + 1400);

  assert.match(
    window,
    /catch\s*\(\s*e\s*\)/,
    'catch 不接收错误对象 → 无法记录失败原因，等于静默吞错',
  );

  // catch 块内必须有 log(...)，否则又是一次静默
  const catchIdx = window.search(/catch\s*\(\s*e\s*\)\s*\{/);
  assert.ok(catchIdx > 0, 'catch 结构不符预期');
  const afterCatch = window.slice(catchIdx);
  const braceEnd = afterCatch.indexOf('\n    }');
  const catchBody = braceEnd > 0 ? afterCatch.slice(0, braceEnd) : afterCatch;

  assert.match(
    catchBody,
    /log\(/,
    'catch 体里没有 log(...) → 解密失败会被完全吞掉，连接器静默降级成 public_only',
  );

  // 两种情况必须分开表述（有条目但解不开 vs 没有条目）
  assert.match(
    src,
    /保险库里没有\s*github\.com\/token/,
    '「没有条目」这条分支没有日志 → 合法未配置和故障仍然分不清',
  );
  assert.match(
    src,
    /GitHub token 解密失败/,
    '「条目存在但解不开」没有专门的日志行 → 排查时看不出真实原因',
  );
});
