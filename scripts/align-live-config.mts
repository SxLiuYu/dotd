// scripts/align-live-config.mts —— 把 ~/.dotd/config.yml 向仓库模板对齐（外科手术式，保留全部注释与 secret 引用）。
//
// 为什么需要它：2026-10-17 全方位测试发现 live daemon 的端口停在 7789（CLI 默认 7788，
// 契约 H2 也是 7788），仓库里早已改成 7788 —— 两边没有任何机制同步，日志里也看不出
// 异常（"配置漂移炸弹"）。同时 telegram 段在 live 里还活着（TG_BOT_TOKEN 已退役，
// 真配了反而会在通道枚举里冒出一个永不投递的选项）。
//
// `db.expected_user_version` 这一项在 2026-10-26 被重新想了一遍：
//
//   它**从来没有被读过**。真正的期望版本硬编码在 `src/daemon.ts:823`
//   （`migrate(db, { expectedVersion: 212 })`），而 `db:` 节连解析入口都没有
//   （`loadSurfacesConfig` 只读 `surfaces:`）。所以这一行是纯注记 ——
//   但它之前写死 `90`，于是每次部署都热情地把 live 改成 90，而实际是 212：
//   一次"对齐"把一份本来就错的东西，从旧错改成新错，还写进了备份目录。
//
//   现在改成**从 db/migrations 推导**（最大 NNN），与 `doctor` 的
//   `expectedUserVersion()` 同源。这样它至少不会自己过期：加迁移包时两者一起走。
//   要真让它有约束力，得让 daemon 去读它 —— 那是另一个决定，不在本脚本里假装。
//
// 做法是逐行外科手术而不是整体覆盖：live 文件里有 ${VAR} 引用和运维手改的注释，
// 覆盖会连这些一起抹掉。改前必备份到 ~/.dotd/backups/。
//
// 作用域按键路径判（surfaces.http.port / db.expected_user_version /
// surfaces.telegram），不是"见到 port: 就改"——将来别的节也有 port 时不能误伤。
//
// 用法（.mts，需 tsx）：node --import tsx scripts/align-live-config.mts [--dry-run] [--config <path>]
//   --dry-run  只打印会改什么，不落盘
//   --config   覆盖目标文件（默认 $DOTD_CONFIG 或 ~/.dotd/config.yml）
// 幂等：已经对齐时输出"无需修改"并以 0 退出。
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AlignOptions {
  /** 契约 H2 + CLI 默认端口（src/surfaces/cli.ts:23）。 */
  port?: string;
  /**
   * 期望的 user_version。**不写死**：缺省从 `db/migrations/` 的最大 NNN 推导
   * （与 doctor 的 expectedUserVersion 同源）。显式传值只为测试与特殊部署；
   * 传 `null` 表示"推导不出来"——那就跳过这一项，**不要编一个数字**。
   */
  version?: string | null;
  /** 退役段名（2026-10-16 主人拍板飞书机器人取代 Telegram）。 */
  retired?: readonly string[];
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `db/migrations/` 里最大的 NNN —— 也就是 `src/daemon.ts` 该硬编码的那个数。
 *
 * 同一份推导在 `scripts/doctor.mjs` 的 `expectedUserVersion()` 里也有一份；
 * 两处必须同源（doctor 用它判"库落后了没"，本脚本用它写注记）。
 * 读不到目录时返回 `null`，调用方跳过这一项，**不要编一个数字**。
 */
export function migrationsMax(repoRoot: string = REPO_ROOT): string | null {
  let names: string[];
  try {
    names = readdirSync(join(repoRoot, 'db', 'migrations'));
  } catch {
    return null;
  }
  const nums: number[] = [];
  for (const f of names) {
    const m = /^(\d{3})_.*\.sql$/.exec(f);
    if (m !== null) nums.push(Number(m[1]));
  }
  if (nums.length === 0) return null;
  return String(Math.max(...nums));
}

export const DEFAULTS: Required<Omit<AlignOptions, 'version'>> & { version: string | null } = {
  port: '7788',
  version: migrationsMax(),
  retired: ['telegram'],
};

export interface AlignResult {
  text: string;
  changes: string[];
}

const indentOf = (s: string): string => /^(\s*)/.exec(s)?.[1] ?? '';
const KEY = /^(\s*)([A-Za-z_][\w-]*):/;

/**
 * 纯函数：给出配置文本，返回对齐后的文本与改动清单。
 * 幂等由调用方用 changes.length 判断（零改动时 text 与入参逐字节相同）。
 */
export function alignConfigText(text: string, opts: AlignOptions = {}): AlignResult {
  const wantPort = opts.port ?? DEFAULTS.port;
  const wantVersion = opts.version === undefined ? DEFAULTS.version : opts.version;
  const retired = opts.retired ?? DEFAULTS.retired;
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';

  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const changes: string[] = [];
  const stack: Array<{ indent: number; key: string }> = []; // 当前所在的键路径

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const km = KEY.exec(line);
    if (!km) {
      out.push(line);
      continue;
    }

    const indent = km[1]!.length;
    const name = km[2]!;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const path = [...stack.map((s) => s.key), name];
    stack.push({ indent, key: name });

    if (name === 'port' && path.length >= 3 && path[path.length - 2] === 'http') {
      const vm = /^(\s*)port:\s*(\d+)\s*$/.exec(line);
      if (vm && vm[2] !== wantPort) {
        changes.push(`端口 ${vm[2]} → ${wantPort}（${path.join('.')}，第 ${i + 1} 行）`);
        out.push(`${km[1]}port: ${wantPort}`);
        continue;
      }
    }

    // 推导不出目标版本（migrations 目录读不到）时**不动这一行**：
    // 宁可留着旧值，也不要把一个编出来的数字写进 live 配置。
    if (
      wantVersion !== null &&
      name === 'expected_user_version' &&
      path.length >= 2 &&
      path[path.length - 2] === 'db'
    ) {
      const vm = /^(\s*)expected_user_version:\s*(\d+)\s*$/.exec(line);
      if (vm && vm[2] !== wantVersion) {
        changes.push(`expected_user_version ${vm[2]} → ${wantVersion}（${path.join('.')}，第 ${i + 1} 行）`);
        out.push(`${km[1]}expected_user_version: ${wantVersion}`);
        continue;
      }
    }

    if (retired.includes(name)) {
      // 收整个块：后续行只要空行或缩进更深，都算这个段的。
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.trim() === '' || indentOf(l).length > indent) j++;
        else break;
      }
      changes.push(`删 ${path.join('.')} 段（第 ${i + 1}-${j} 行，共 ${j - i} 行）`);
      i = j - 1;
      stack.pop();
      continue;
    }

    out.push(line);
  }

  return { text: out.join(eol), changes };
}

function main(): void {
  const argv = process.argv.slice(2);
  const DRY = argv.includes('--dry-run');
  const cfgIdx = argv.indexOf('--config');
  const cfgArg = cfgIdx >= 0 ? argv[cfgIdx + 1] : undefined;
  const CFG = cfgArg ?? process.env.DOTD_CONFIG ?? join(homedir(), '.dotd', 'config.yml');

  const { text, changes } = alignConfigText(readFileSync(CFG, 'utf8'));
  if (changes.length === 0) {
    const v = DEFAULTS.version ?? '（推导不出，已跳过）';
    console.log(`[align] ${CFG} 已对齐（port=${DEFAULTS.port} version=${v}，无 ${DEFAULTS.retired.join('/')} 段），无需修改`);
    return;
  }

  for (const c of changes) console.log(`[align] ${c}`);
  if (DRY) {
    console.log('[align] --dry-run：未落盘');
    return;
  }

  const backupDir = join(dirname(CFG), 'backups');
  mkdirSync(backupDir, { recursive: true });
  const backup = join(backupDir, `config-${new Date().toISOString().replace(/[:.]/g, '-')}.yml`);
  copyFileSync(CFG, backup);
  writeFileSync(CFG, text, 'utf8');
  console.log(`[align] 已写入 ${CFG}（备份 ${backup}）`);
}

if (import.meta.filename === process.argv[1]) main();
