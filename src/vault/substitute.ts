/**
 * src/vault/substitute.ts —— `$vault:` 占位符替换 + 回包清洗（A2）。
 *
 * 位置纪律：只在 ExecService.runTool 顶部调用（journal 已落过原始 args——
 * 落的是占位符）；替换表在本调用内即用即弃，明文不过夜。
 */
import { VAULT_PLACEHOLDER } from './vault.ts';

export type VaultLookup = (site: string, user: string) => string | null;

export interface SubstituteOutcome {
  /** 替换后的 args（深拷贝，原对象不动）。 */
  args: unknown;
  /** 本调用用到的明文（用于结果清洗），按长度降序（防短串先替换破坏长串）。 */
  secrets: string[];
  /** 缺条目的占位符（原样字符串），有缺即 fail-closed。 */
  missing: string[];
}

/** 深遍历，字符串值里的 `$vault:site:user` 全替换。非字符串（数字/布尔/null）不动。 */
export function substituteVaultArgs(args: unknown, lookup: VaultLookup): SubstituteOutcome {
  const secrets: string[] = [];
  const missing: string[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(VAULT_PLACEHOLDER, (_m, site: string, user: string) => {
        const secret = lookup(site, user);
        if (secret === null) {
          missing.push(`$vault:${site}:${user}`);
          return `$vault:${site}:${user}`; // 保持占位符原样，让上层报错
        }
        secrets.push(secret);
        return secret;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  const replaced = walk(args);
  // 长的先洗，避免"短串是长串子串"把长串洗剩一半
  secrets.sort((a, b) => b.length - a.length);
  return { args: replaced, secrets, missing };
}

/**
 * 回包清洗：把明文从序列化形态里抹掉（result/error 都会进 journal 的
 * result_json 与模型上下文）。没有用到任何明文时原样返回（零拷贝路径）。
 */
export function scrubSecrets<T>(value: T, secrets: string[]): T {
  if (secrets.length === 0) return value;
  let s = JSON.stringify(value);
  // 防御式排序：长的先洗（短串若是长串的子串，先洗短串会把长串洗剩一半）。
  const ordered = secrets.length > 1 ? [...secrets].sort((a, b) => b.length - a.length) : secrets;
  for (const secret of ordered) {
    if (secret.length === 0) continue;
    s = s.split(secret).join('$vault:redacted');
  }
  return JSON.parse(s) as T;
}
