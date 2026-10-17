/**
 * src/router/paths.ts —— 模块内路径小工具（`~` 展开）。
 *
 * 依据：config/dotd.yml「加载约定」——路径支持 `~` 展开为 daemon 用户 HOME；
 * 契约 T3：alerts.outbox_path 值 = ~/.dotd/OUTBOX.md。
 */

import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/** 把 `~/x` / `~` 展开为 HOME；已是绝对路径或相对路径原样返回（相对路径按 cwd 解析）。 */
export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return resolve(homedir(), p.slice(2));
  }
  if (isAbsolute(p)) return p;
  return resolve(process.cwd(), p);
}
