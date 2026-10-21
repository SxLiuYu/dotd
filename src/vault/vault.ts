/**
 * src/vault/vault.ts —— A2 密码保险库（2026-10-21）。
 *
 * 设计约束（muse-tasks.md A2 段）：
 * - 静止即密文：条目 AES-256-GCM（12B 随机 iv + authTag），钥匙复用 DOTD_MAIL_KEY
 *   （32B base64，_tokens_src.env，chmod 600 的目录里）——不引入第二把钥匙的托管问题。
 * - 明文不进模型上下文/日志/journal：模型只写 `$vault:<site>:<user>` 占位符；
 *   宿主在 ExecService.runTool 顶部替换（journal 已在 runTool 之前落原始 args，
 *   见 control-plane/journal.ts startStep）；替换出来的明文在本模块内即用即弃，
 *   回包清洗（见 substitute.ts）保证 result_json 也不落明文。
 * - 写入路径只有 daemon（契约 D2 单写者精神）：CLI/HTTP 都打到 daemon，
 *   vault 文件只由 daemon 进程写（原子写 tmp+rename，mode 600）。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 保险库条目（文件里的形态：全密文字段）。 */
export interface VaultEntry {
  site: string;
  user: string;
  iv: string;
  tag: string;
  ct: string;
}

export interface VaultFile {
  version: 1;
  entries: VaultEntry[];
}

/** 占位符语法：$vault:<site>:<user>（site/user 不含冒号和空白）。 */
export const VAULT_PLACEHOLDER = /\$vault:([^:\s]+):([^:\s]+)/g;

/** 钥匙解码并校验长度（32B = AES-256）。坏钥匙 fail-fast，绝不静默降级。 */
export function decodeKey(keyB64: string): Buffer {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) {
    throw new Error(`vault key 必须 32 字节（收到 ${key.length}）`);
  }
  return key;
}

function vaultPath(dir: string): string {
  return join(dir, 'vault.json');
}

function readVaultFile(dir: string): VaultFile {
  const p = vaultPath(dir);
  if (!existsSync(p)) return { version: 1, entries: [] };
  const parsed = JSON.parse(readFileSync(p, 'utf8')) as VaultFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error('vault.json 形状不合法');
  }
  return parsed;
}

function writeVaultFile(dir: string, v: VaultFile): void {
  mkdirSync(dir, { recursive: true });
  const tmp = vaultPath(dir) + '.tmp';
  // mode 600：文件本体就别让同机其他用户读（目录权限另算，父目录是 ~/.dotd）。
  writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 });
  renameSync(tmp, vaultPath(dir));
}

function encrypt(key: Buffer, secret: string): { iv: string; tag: string; ct: string } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

function decrypt(key: Buffer, e: VaultEntry): string {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
  d.setAuthTag(Buffer.from(e.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(e.ct, 'base64')), d.final()]).toString('utf8');
}

/** 写入/覆盖一条（同 site+user 覆盖）。secret 允许空串（有人就存空占位）。 */
export function vaultPut(
  dir: string,
  keyB64: string,
  site: string,
  user: string,
  secret: string,
): void {
  const key = decodeKey(keyB64);
  const v = readVaultFile(dir);
  const enc = encrypt(key, secret);
  const i = v.entries.findIndex((e) => e.site === site && e.user === user);
  const entry: VaultEntry = { site, user, ...enc };
  if (i >= 0) v.entries[i] = entry;
  else v.entries.push(entry);
  writeVaultFile(dir, v);
}

/** 取明文。没有该条目返回 null（调用方 fail-closed，不猜）。 */
export function vaultGet(dir: string, keyB64: string, site: string, user: string): string | null {
  const key = decodeKey(keyB64);
  const v = readVaultFile(dir);
  const e = v.entries.find((x) => x.site === site && x.user === user);
  if (e === undefined) return null;
  return decrypt(key, e);
}

/** 删除一条。返回是否真删了。 */
export function vaultDelete(dir: string, site: string, user: string): boolean {
  const v = readVaultFile(dir);
  const before = v.entries.length;
  v.entries = v.entries.filter((e) => !(e.site === site && e.user === user));
  if (v.entries.length === before) return false;
  writeVaultFile(dir, v);
  return true;
}

/** 列条目：只有 site/user（用户名一般不敏感；密码永远不出这个模块）。 */
export function vaultList(dir: string): Array<{ site: string; user: string }> {
  return readVaultFile(dir).entries.map((e) => ({ site: e.site, user: e.user }));
}
