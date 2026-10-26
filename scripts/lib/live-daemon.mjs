/**
 * scripts/lib/live-daemon.mjs —— 「现在跑着的那个 daemon，它的环境是什么」。
 *
 * 2026-10-26 live 现场（同一类缺陷的第四例）：
 *
 * ```
 * 体检：⚠️ DOTD_FLEET 未设置 → 实际生效 stub（不起容器）
 * 实际：/proc/<daemon>/environ → DOTD_FLEET=docker
 *
 * 体检：⚠️ openrouter-main 的默认地址 127.0.0.1:3065 连不上
 * 实际：/proc/<daemon>/environ → DOTD_MODEL_HOST=http://172.17.48.1:13065（relay，通着）
 * ```
 *
 * 原因和 §18.13 一模一样：`DOTD_FLEET` / `DOTD_MODEL_HOST` 由启动器导出给
 * **daemon 子进程**，人手动跑 `npm run doctor` 的那个 shell 里什么都没有。
 * doctor 于是把自己 shell 的缺席报成"这台机器的实际生效值"——用的词正是
 * "实际生效"，而它看的是**自己**。
 *
 * 判据：**能看见运行中的 daemon 时，就以它的环境为准**（那是"实际生效"的字面含义）；
 * 看不见时（Windows、无权限、没在跑）明说"按当前 shell 判断"，不许把缺席当结论。
 *
 * 只读：仅读 `/proc/<pid>/cmdline` 与 `/proc/<pid>/environ`，不碰任何配置/库文件。
 * 非 Linux 上 `procRoot` 不存在 → 返回 `null`，调用方走"看不见"的分支。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * daemon 进程的识别记号。
 *
 * 托管部署里 `one_system.dotd_command()` 优先用 **`<repo>/dist/daemon.js`**（有构建产物时），
 * 否则才 `node --import tsx src/daemon.ts`。只认 `src/daemon.ts` 的话，一旦有人跑了
 * 构建，体检就会报「看不见运行中的 daemon」，然后拿**自己 shell** 的环境当
 * "实际生效值" —— 正是本模块存在的理由（同类缺陷第五例，2026-10-26）。
 *
 * 两种形态都认，但都必须**恰好是那个入口**：
 *   · 某参数以 `/src/daemon.ts`、`\src\daemon.ts` 或 `src/daemon.ts` 结尾
 *   · 某参数以 `/dist/daemon.js`、`\dist\daemon.js` 或 `dist/daemon.js` 结尾
 *
 * 刻意**不**用 `pgrep -f dotd` 这类模糊匹配：那会把 doctor 自己、
 * 部署脚本、`vim dotd` 都算进来（本项目被误杀的 shell 就是这么来的）。
 */
const DAEMON_ARG = /(?:^|[\\/])(?:src[\\/]daemon\.ts|dist[\\/]daemon\.js)$/;

function splitNul(text) {
  return text.split('\u0000').filter((x) => x.length > 0);
}

/** 解析 `NAME=value\0NAME2=value2\0` 形态（`/proc/<pid>/environ`）。 */
export function parseProcEnv(text) {
  const out = {};
  for (const entry of splitNul(String(text))) {
    const i = entry.indexOf('=');
    if (i <= 0) continue;
    out[entry.slice(0, i)] = entry.slice(i + 1);
  }
  return out;
}

/**
 * 扫描 `/proc` 找运行中的 dotd daemon。
 *
 * @returns {Array<{pid:number, cmdline:string[], env:Record<string,string>}>}
 *          按 pid 升序；读不到（非 Linux / environ 权限不足）的条目跳过。
 */
export function scanDaemons({
  procRoot = '/proc',
  readdir = readdirSync,
  read = (p) => readFileSync(p, 'utf8'),
  selfPid = process.pid,
} = {}) {
  let names;
  try {
    names = readdir(procRoot);
  } catch {
    return []; // 没有 /proc（Windows / macOS）—— 这不是错误，是看不见
  }
  const out = [];
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === selfPid) continue;
    const base = join(procRoot, name);
    let cmdline;
    try {
      cmdline = splitNul(read(join(base, 'cmdline')));
    } catch {
      continue; // 进程刚退出 / 无权限
    }
    if (!cmdline.some((a) => DAEMON_ARG.test(a))) continue;
    let env = {};
    try {
      env = parseProcEnv(read(join(base, 'environ')));
    } catch {
      env = {}; // cmdline 认出来了但 environ 读不到（hidepid）—— 仍然算"在跑"
    }
    out.push({ pid, cmdline, env });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

/**
 * doctor 会用运行期环境覆盖"自己 shell 里那几个变量"的白名单。
 *
 * 为什么是白名单而不是"DOTD_* 全要"：其中还有令牌（`DOTD_MASTER_TOKEN` /
 * `DOTD_RO_TOKEN` / `DOTD_MAIL_KEY`）。本模块**不需要**它们，多取一分就多一分
 * 泄漏面；白名单只放"决定行为、不决定身份"的旋钮。
 */
export const RUNTIME_KNOBS = Object.freeze([
  'DOTD_FLEET',
  'DOTD_MODEL_TRANSPORT',
  'DOTD_MODEL_HOST',
  'DOTD_TIER2_HOST',
  'DOTD_NET_TOOLS',
  'DOTD_MAX_RUNNING',
  'DOTD_HOME',
  'DOTD_CONFIG',
  'DOTD_CONFIG_DIR',
  'DOTD_DB_PATH',
]);

/**
 * 把运行期环境叠到 shell 环境上（**只叠白名单里的键**，且运行期优先）。
 *
 * 返回 `overlaid`（真正被改写的键名）以便报告如实交代"这些值不是我看的这个
 * shell 里的"。
 */
export function overlayRuntimeEnv({ shellEnv = process.env, liveEnv = {}, knobs = RUNTIME_KNOBS } = {}) {
  const env = { ...shellEnv };
  const overlaid = [];
  for (const key of knobs) {
    const v = liveEnv[key];
    if (typeof v !== 'string' || v.length === 0) continue;
    if (env[key] === v) continue;
    env[key] = v;
    overlaid.push(key);
  }
  return { env, overlaid };
}

/**
 * 一句话结论用的取数：找到唯一的运行中 daemon 时返回 `{ pid, env, overlaid }`，
 * 否则 null（看不见 / 一个都没有 / 多个 —— 多个由调用方单独报）。
 */
export function liveDaemon({
  procRoot = '/proc',
  shellEnv = process.env,
  scan = scanDaemons,
  knobs = RUNTIME_KNOBS,
} = {}) {
  const found = scan({ procRoot });
  if (found.length !== 1) return found.length === 0 ? null : { ambiguous: found };
  const d = found[0];
  const { env, overlaid } = overlayRuntimeEnv({ shellEnv, liveEnv: d.env, knobs });
  return { pid: d.pid, env, overlaid };
}
