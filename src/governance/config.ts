/**
 * src/governance/config.ts —— GOV_DEFAULTS 与 SANITIZE_PATTERNS（GOV §7 尾段）。
 *
 * 逐字来源：governance.md §7「配置与上限常量」。契约 G2 定稿 TTL=24h（O3 关闭）；
 * 契约 G4 定稿 precheck 走 complete({track:'light'})、45s 超时由治理控制。
 *
 * 环境变量覆盖（GOV §7 原文括号内标注）：
 *   DOTD_APPROVAL_TTL_H / DOTD_EXPIRE_SCAN_MIN / DOTD_AUDIT_RETENTION_DAYS
 *   DOTD_AUDIT_RETENTION_ROWS / DOTD_AUDIT_ARCHIVE_MB
 */

/** GOV §7 GOV_DEFAULTS（环境变量覆盖后的生效值）。 */
export interface GovDefaults {
  approvalTtlMs: number;
  expireScanMs: number;
  precheckTimeoutMs: number;
  precheckBudget: { goalBytes: number; paramsBytes: number; maxOutputTokens: number };
  reviewFailThreshold: { windowMs: number; fails: number; openMs: number };
  auditRetentionDays: number;
  auditRetentionRows: number;
  auditArchiveCapMb: number;
  chunkBytes: number;
  memoryPerTierCap: number;
  memoryDefaultExpiryDays: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 读环境变量构造 GOV_DEFAULTS（每次调用重读，便于测试改 env 后刷新）。 */
export function govDefaults(): GovDefaults {
  return {
    // 契约 G2：TTL 定稿 24h（surfaces 的 60min 随其表删除自然消失；O3 关闭）。
    approvalTtlMs: envInt('DOTD_APPROVAL_TTL_H', 24) * 3600_000,
    expireScanMs: envInt('DOTD_EXPIRE_SCAN_MIN', 5) * 60_000,
    // GOV §5.1.1 容量核算结果：输入 ≈850 tok + 输出 ≈30 tok，7 tok/s 下 prefill 20–40s。
    precheckTimeoutMs: envInt('DOTD_PRECHECK_TIMEOUT_MS', 45_000),
    precheckBudget: { goalBytes: 800, paramsBytes: 1500, maxOutputTokens: 40 },
    // GOV §5.1.2：10min 内 5 次超时/不可用 ⇒ degraded，开 15 分钟，半开探测恢复。
    reviewFailThreshold: { windowMs: 600_000, fails: 5, openMs: 900_000 },
    auditRetentionDays: envInt('DOTD_AUDIT_RETENTION_DAYS', 90),
    auditRetentionRows: envInt('DOTD_AUDIT_RETENTION_ROWS', 20_000),
    auditArchiveCapMb: envInt('DOTD_AUDIT_ARCHIVE_MB', 200),
    chunkBytes: 10 * 1024 * 1024,
    // GOV §4.5：每 Dot 每档位记忆上限 50 条，超出按 LRU 自动 expired。
    memoryPerTierCap: 50,
    memoryDefaultExpiryDays: 90,
  };
}

/**
 * GOV §7 SANITIZE_PATTERNS：入库与出图前各跑一遍（GOV §5.2/§6.2）。
 * 覆盖 cookie、Authorization、token/api key 形态、13–19 位卡号（Luhn 前粗筛）。
 * 顺序即优先级：前面的替换后不再被后面的误伤（替换文本本身不含敏感形态）。
 */
export const SANITIZE_PATTERNS: readonly { re: RegExp; to: string }[] = [
  // Set-Cookie / Cookie 头形态
  { re: /set-cookie\s*[:=]\s*[^\s;,"'}]+/gi, to: 'set-cookie:[REDACTED]' },
  { re: /\bcookie\s*[:=]\s*[^\s;,"'}]+/gi, to: 'cookie:[REDACTED]' },
  // Authorization / Bearer
  { re: /\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s;,"'}]+/gi, to: 'authorization:[REDACTED]' },
  { re: /\bbearer\s+[A-Za-z0-9._\-]{8,}/gi, to: 'bearer [REDACTED]' },
  // api key / token / secret 形态（键值对或裸串）
  { re: /\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|secret|password|passwd|pwd)\s*[:=]\s*["']?[^\s;,"'}]{4,}/gi, to: '$1:[REDACTED]' },
  { re: /\b(?:sk|pk|rk|tok|key)-[A-Za-z0-9]{16,}/gi, to: '[REDACTED_KEY]' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/gi, to: '[REDACTED_KEY]' },
  // JWT 形态
  { re: /\beyJ[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{5,}/gi, to: '[REDACTED_JWT]' },
  // 13–19 位连续数字（卡号粗筛；空格/连字符分组也算）
  { re: /\b(?:\d[ -]?){12,18}\d\b/g, to: '[REDACTED_PAN]' },
];

/** 5.2/6.2：脱敏（返回新串，不改入参）。 */
export function sanitizeText(input: string): string {
  let out = input;
  for (const p of SANITIZE_PATTERNS) out = out.replace(p.re, p.to);
  return out;
}
