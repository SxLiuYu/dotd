// scripts/align-live-config.mts —— 把 ~/.dotd/config.yml 向仓库模板对齐（外科手术式，保留全部注释与 secret 引用）。
//
// 为什么需要它：2026-10-17 全方位测试发现 live daemon 的端口停在 7789（CLI 默认 7788，
// 契约 H2 也是 7788），仓库里早已改成 7788 —— 两边没有任何机制同步，日志里也看不出
// 异常（"配置漂移炸弹"）。同时 telegram 段在 live 里还活着（TG_BOT_TOKEN 已退役，
// 真配了反而会在通道枚举里冒出一个永不投递的选项）。db.expected_user_version 停在 50，
// 而 src/daemon.ts 硬编码 90。
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
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface AlignOptions {
  /** 契约 H2 + CLI 默认端口（src/surfaces/cli.ts:23）。 */
  port?: string;
  /** src/daemon.ts:415 migrate(db, { expectedVersion: 90 })。 */
  version?: string;
  /** 退役段名（2026-10-16 主人拍板飞书机器人取代 Telegram）。 */
  retired?: readonly string[];
}

export const DEFAULTS: Required<AlignOptions> = {
  port: '7788',
  version: '90',
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
  const wantVersion = opts.version ?? DEFAULTS.version;
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

    if (name === 'expected_user_version' && path.length >= 2 && path[path.length - 2] === 'db') {
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
    console.log(`[align] ${CFG} 已对齐（port=${DEFAULTS.port} version=${DEFAULTS.version}，无 ${DEFAULTS.retired.join('/')} 段），无需修改`);
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
