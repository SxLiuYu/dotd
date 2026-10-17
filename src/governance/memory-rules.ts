/**
 * src/governance/memory-rules.ts —— 持久化记忆：已批端点与已批规则（GOV §4）。
 *
 * 逐字来源：governance.md §4.1 两个概念、§4.2 规则键派生、§4.3 匹配与命中语义、
 * §4.4 优先级、§4.5 安全阀；表结构见 db/migrations/020_governance.sql:56-75
 * （approval_rules / endpoint_grants）+ 090（endpoint_grants.last_hit_at）。
 *
 * 三条不可谈判的规则：
 * 1. `spend` / `dangerous` 永不入记忆（§4.1「每次花钱必是独立人工决定」）；
 * 2. 登录态调用永不命中记忆（`isLoginSensitive ⇒ 跳过 matchMemory`，§4.3）；
 * 3. `rules.yml`（人工收紧）> 记忆（历史放宽）——匹配发生在规则之后，记忆永远
 *    不能推翻人工规则（§4.4）。
 */

import type { DatabaseSync } from 'node:sqlite';
import type { ToolTier } from '../shared/contracts.ts';
import { isLoginSensitive } from '../shared/contracts.ts';
import { appendAudit } from './audit.ts';
import { govDefaults } from './config.ts';
import type { GovDefaults } from './config.ts';
import { hostOfUrl } from './catalog.ts';
import { MEMORY_TIERS, memoryEligible } from './policy.ts';
import type { ToolCall } from './types.ts';

/** matchMemory 命中（§4.3：命中即 allow，decision 带 fromRule=refId）。 */
export interface MemoryHit {
  kind: 'allow';
  source: 'rule' | 'grant';
  refId: number;
  /** 人读文本（审计/decision reason 用）。 */
  text: string;
}

/** deriveRule 的产物：一条 approval_rules 或一条 endpoint_grants（§4.2）。 */
export interface DerivedMemory {
  source: 'rule' | 'grant';
  tier: ToolTier;
  /** approval_rules.rule_key / endpoint_grants 的 (origin,path_glob) 组合键。 */
  ruleKey: string;
  /** approval_rules.matcher JSON（结构化谓词）。 */
  matcher: Record<string, unknown>;
  /** 人读文本（Web 确认框与 TG 预览必须展示，§4.5 第三阀）。 */
  text: string;
  /** endpoint_grants 专用。 */
  origin?: string;
  pathGlob?: string;
}

// ── glob 匹配（§4.2/§4.3 的 `*` 通配）─────────────────────────────────────────

/**
 * 把 `*` 通配串编译成正则（只支持 `*` 与 `?`；其余逐字）。
 *
 * 语义细节：`/home/*` 必须同时匹配 `/home` 自身与 `/home/x/y`——
 * 否则"授权了 /home 前缀却放不过 /home 本身"，每次首访都要重新批。
 * `?` 语义同 glob：恰好一个字符。
 */
export function globToRegExp(glob: string): RegExp {
  // `/*` 结尾 ⇒ 目录自身也算命中：/home/* 匹配 /home 与 /home/…（授权前缀必须覆盖根）。
  // 去掉结尾的 `/*` 后逐字转义，再接 `(?:/.*)?`：可选的一段"/…"。
  const dirPrefix = glob.endsWith('/*') ? glob.slice(0, -2) : null; // '/home'
  const body = dirPrefix === null ? glob : dirPrefix;
  let out = '';
  for (const ch of body) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // 例：'/home/*' ⇒ `^\/home(?:\/.*)?$`（命中 /home、/home/、/home/a/b）
  if (dirPrefix !== null) out += '(?:/.*)?';
  return new RegExp(`^${out}$`, 'i');
}

export function globMatch(glob: string, value: string): boolean {
  return globToRegExp(glob).test(value);
}

// ── §4.2 规则键派生 ───────────────────────────────────────────────────────────

function firstString(params: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = params[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * GOV §4.2 deriveRule(tier, call)（磁盘稿逐字的三个例子）：
 * ```
 * fs.write  /dot/home/notes/x.md → key = "rule:fs.write:path=/dot/home/notes/*"
 * net.post  https://api.x.com/v1/jobs → key = "grant:api.x.com:/v1/*"
 * browser.act url=https://x.com/home → key = "rule:browser.act:host=x.com,actions=navigate,click"
 * ```
 * 兜底：无法稳定派生 ⇒ 仅记 origin 级（宁粗勿漏）；派生失败 ⇒ 调用方退化为 approve_once。
 *
 * 契约 G1 连锁修改：磁盘稿"仅当 withIdentity=false 才可派生（登录态永不入记忆）"改为
 * 顶层 `isLoginSensitive(call)` 判定（见 contracts.ts §8）。
 */
export function deriveRule(tier: ToolTier, call: ToolCall): DerivedMemory | null {
  // 登录态永不入记忆（§4.3/契约 G1）——在派生之前就挡掉，比派生了再过滤更稳。
  if (isLoginSensitive(call)) return null;
  if (!memoryEligible(tier)) return null; // spend/dangerous 永不（§4.1）

  const p = call.params;
  const path = firstString(p, ['path', 'filePath', 'file', 'target', 'dest', 'outputPath']);
  const url = firstString(p, ['url', 'target', 'link', 'href']);
  const actions = firstString(p, ['actions', 'action']);
  const selector = firstString(p, ['selector', 'element']);

  // 1) URL 类（net.* / browser.*）：优先 origin 级 grant（宁粗勿漏）。
  const host = url !== null ? hostOfUrl(url) : null;
  if (host !== null) {
    let pathGlob = '/*';
    try {
      const u = new URL(url!);
      const segs = u.pathname.split('/').filter((s) => s.length > 0);
      pathGlob = segs.length === 0 ? '/*' : `/${segs[0]}/*`;
    } catch {
      pathGlob = '/*';
    }
    return {
      source: 'grant',
      tier,
      ruleKey: `grant:${host}:${pathGlob}`,
      matcher: { origin: host, pathGlob, tool: call.tool },
      text: `已批端点 ${host}${pathGlob}（来源 ${call.tool}，档位 ${tier}）`,
      origin: host,
      pathGlob,
    };
  }

  // 2) 文件路径类（fs.write 等）：路径前缀 glob。
  if (path !== null) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    const glob = `${dir}*`;
    return {
      source: 'rule',
      tier,
      ruleKey: `rule:${call.tool}:path=${glob}`,
      matcher: { tool: call.tool, pathGlob: glob },
      text: `已批规则 ${call.tool} 路径 ${glob}（档位 ${tier}）`,
    };
  }

  // 3) browser.act 的动作类：host + actions。
  if (call.tool.startsWith('browser.')) {
    const act = actions ?? 'navigate';
    const actKey = act.split(',').slice(0, 4).join(',');
    return {
      source: 'rule',
      tier,
      ruleKey: `rule:${call.tool}:actions=${actKey}`,
      matcher: { tool: call.tool, actions: actKey, selector: selector ?? undefined },
      text: `已批规则 ${call.tool} 动作 ${actKey}（档位 ${tier}）`,
    };
  }

  // 4) 兜底：工具级规则（仍受 50 条/LRU/90 天约束）。
  return {
    source: 'rule',
    tier,
    ruleKey: `rule:${call.tool}:tool`,
    matcher: { tool: call.tool },
    text: `已批规则 ${call.tool} 全部调用（档位 ${tier}，兜底派生）`,
  };
}

// ── §4.3 匹配与命中语义 ───────────────────────────────────────────────────────

/**
 * GOV §4.3 matchMemory(tier, call)：
 * - 命中即 allow，decision 带 fromRule=refId；
 * - 同时 `UPDATE hits=hits+1, last_hit_at=now`；
 * - `expires_at`（默认 90 天）或主人撤销即失效；
 * - 记忆按 tier 分桶：read 记忆不放行 browser 调用；
 * - **登录态调用永不命中记忆**；
 * - emergency 下 browser 记忆休眠（emergency 期间对 browser 档直接返回 null）。
 */
export function matchMemory(
  db: DatabaseSync,
  dotId: string,
  tier: ToolTier,
  call: ToolCall,
  opts: { emergency?: boolean; now?: string } = {},
): MemoryHit | null {
  if (isLoginSensitive(call)) return null; // 登录态永不命中
  if (!memoryEligible(tier)) return null; // spend/dangerous 无记忆
  if (opts.emergency === true && tier === 'browser') return null; // 应急休眠，解除即恢复

  const nowIso = opts.now ?? new Date().toISOString();
  const hits: MemoryHit[] = [];

  // 1) endpoint_grants：URL 类命中（origin + path_glob + tier_ceiling >= tier）。
  const url = firstString(call.params, ['url', 'target', 'link', 'href']);
  const host = url !== null ? hostOfUrl(url) : null;
  if (host !== null) {
    const grants = db
      .prepare(
        `SELECT id, origin, path_glob, tier_ceiling FROM endpoint_grants
          WHERE dot_id=$dotId AND status='active' AND expires_at > $now`,
      )
      .all({ dotId, now: nowIso }) as unknown as {
      id: number;
      origin: string;
      path_glob: string;
      tier_ceiling: string;
    }[];
    let path = '/*';
    try {
      path = new URL(url!).pathname || '/';
    } catch {
      path = '/';
    }
    for (const g of grants) {
      if (g.origin.toLowerCase() !== host.toLowerCase()) continue;
      if (!globMatch(g.path_glob, path)) continue;
      if (!ceilingCovers(g.tier_ceiling as ToolTier, tier)) continue;
      hits.push({
        kind: 'allow',
        source: 'grant',
        refId: Number(g.id),
        text: `已批端点 ${g.origin}${g.path_glob}`,
      });
    }
  }

  // 2) approval_rules：结构化谓词命中（同 tier 桶内）。
  const rules = db
    .prepare(
      `SELECT id, rule_key, matcher FROM approval_rules
        WHERE dot_id=$dotId AND tier=$tier AND status='active' AND expires_at > $now`,
    )
    .all({ dotId, tier, now: nowIso }) as unknown as {
    id: number;
    rule_key: string;
    matcher: string;
  }[];
  for (const r of rules) {
    let matcher: Record<string, unknown> = {};
    try {
      matcher = JSON.parse(r.matcher) as Record<string, unknown>;
    } catch {
      continue; // 坏行不猜：宁可漏放也不误放
    }
    if (matcherApplies(matcher, call)) {
      hits.push({ kind: 'allow', source: 'rule', refId: Number(r.id), text: r.rule_key });
    }
  }

  if (hits.length === 0) return null;
  // 多条命中：取 id 最小者（最早授权，行为可预期）；命中即记账。
  const hit = hits.reduce((a, b) => (a.refId <= b.refId ? a : b));
  bumpHit(db, hit, dotId, nowIso);
  return hit;
}

/** tier_ceiling 语义：授权时可放行的最高档位（grant 的档位不低于本次调用才生效）。 */
function ceilingCovers(ceiling: ToolTier, tier: ToolTier): boolean {
  const order: ToolTier[] = ['read', 'write_file', 'browser', 'spend', 'dangerous'];
  return order.indexOf(ceiling) >= order.indexOf(tier);
}

/** approval_rules.matcher 谓词判定（全部命中才算匹配；缺字段视为通配）。 */
function matcherApplies(matcher: Record<string, unknown>, call: ToolCall): boolean {
  const p = call.params;
  const mTool = matcher.tool;
  if (typeof mTool === 'string' && mTool !== call.tool) return false;
  const mPathGlob = matcher.pathGlob;
  if (typeof mPathGlob === 'string') {
    const path = firstString(p, ['path', 'filePath', 'file', 'target', 'dest', 'outputPath']);
    if (path === null || !globMatch(mPathGlob, path)) return false;
  }
  const mHost = matcher.origin;
  if (typeof mHost === 'string') {
    const url = firstString(p, ['url', 'target', 'link', 'href']);
    const host = url !== null ? hostOfUrl(url) : null;
    if (host === null || host.toLowerCase() !== mHost.toLowerCase()) return false;
  }
  const mActions = matcher.actions;
  if (typeof mActions === 'string') {
    const act = firstString(p, ['actions', 'action']);
    if (act === null) return false;
    const want = mActions.split(',').map((s) => s.trim());
    const got = act.split(',').map((s) => s.trim());
    if (!want.every((w) => got.includes(w))) return false;
  }
  return true;
}

/**
 * §4.3：命中即记账。两张表都写 `hits=hits+1, last_hit_at=now`——endpoint_grants
 * 自 090 起也有 last_hit_at，LRU 判据（enforceTierCap）靠它才分得清冷热。
 *
 * §6 首行「所有治理动作唯一落点」：命中本身也是治理动作 ⇒ 落 `memory_hit`
 * 审计（不落则审计日志说不清某次 allow 为何发生）。
 */
function bumpHit(
  db: DatabaseSync,
  hit: MemoryHit,
  dotId: string | null = null,
  nowIso = new Date().toISOString(),
): void {
  if (hit.source === 'grant') {
    db.prepare('UPDATE endpoint_grants SET hits = hits + 1, last_hit_at = $now WHERE id = $id').run({
      now: nowIso,
      id: hit.refId,
    });
  } else {
    db.prepare('UPDATE approval_rules SET hits = hits + 1, last_hit_at = $now WHERE id = $id').run({
      now: nowIso,
      id: hit.refId,
    });
  }
  appendAudit(db, {
    dotId,
    approvalId: null,
    actor: 'system',
    channel: 'system',
    action: 'memory_hit',
    decision: 'allow',
    reason: hit.text,
    details: { source: hit.source, refId: hit.refId, hits: hit.source === 'grant' ? 'endpoint_grants.hits+1' : 'approval_rules.hits+1' },
  });
}

// ── 落库 / 撤销 / 列举 ────────────────────────────────────────────────────────

export interface PersistMemoryResult {
  id: number;
  source: 'rule' | 'grant';
  /** true = 命中 uniq_rule / UNIQUE(dot_id,origin,path_glob,tier_ceiling)，复用既有行。 */
  reused: boolean;
}

/**
 * 把派生结果落库（`approve_remember` 路径，Web 确认框确认后才调）。
 * 幂等：同 (dot_id, tier, rule_key) 活动行已存在 ⇒ 复用（刷新 expires_at）。
 */
export function persistMemory(
  db: DatabaseSync,
  dotId: string,
  approvalId: number,
  derived: DerivedMemory,
  opts: { defaults?: GovDefaults } = {},
): PersistMemoryResult {
  const defaults = opts.defaults ?? govDefaults();
  const expiresAt = new Date(
    Date.now() + defaults.memoryDefaultExpiryDays * 86_400_000,
  ).toISOString();

  if (derived.source === 'grant') {
    const existing = db
      .prepare(
        `SELECT id FROM endpoint_grants
          WHERE dot_id=$dotId AND origin=$origin AND path_glob=$pathGlob AND tier_ceiling=$tier`,
      )
      .get({
        dotId,
        origin: derived.origin!,
        pathGlob: derived.pathGlob!,
        tier: derived.tier,
      }) as { id: number } | undefined;
    if (existing !== undefined) {
      db.prepare(
        `UPDATE endpoint_grants SET status='active', expires_at=$expiresAt,
                source_approval=$approvalId WHERE id=$id`,
      ).run({ expiresAt, approvalId, id: Number(existing.id) });
      return { id: Number(existing.id), source: 'grant', reused: true };
    }
    const res = db
      .prepare(
        `INSERT INTO endpoint_grants (dot_id, origin, path_glob, tier_ceiling, source_approval,
                                       status, expires_at, hits)
         VALUES ($dotId, $origin, $pathGlob, $tier, $approvalId, 'active', $expiresAt, 0)`,
      )
      .run({
        dotId,
        origin: derived.origin!,
        pathGlob: derived.pathGlob ?? '/*',
        tier: derived.tier,
        approvalId,
        expiresAt,
      }) as unknown as { lastInsertRowid: number | bigint };
    enforceTierCap(db, dotId, derived.tier, 'endpoint_grants', defaults);
    return { id: Number(res.lastInsertRowid), source: 'grant', reused: false };
  }

  const existing = db
    .prepare(
      `SELECT id FROM approval_rules
        WHERE dot_id=$dotId AND tier=$tier AND rule_key=$ruleKey AND status='active'`,
    )
    .get({ dotId, tier: derived.tier, ruleKey: derived.ruleKey }) as { id: number } | undefined;
  if (existing !== undefined) {
    db.prepare(
      `UPDATE approval_rules SET expires_at=$expiresAt, source_approval=$approvalId WHERE id=$id`,
    ).run({ expiresAt, approvalId, id: Number(existing.id) });
    return { id: Number(existing.id), source: 'rule', reused: true };
  }
  const res = db
    .prepare(
      `INSERT INTO approval_rules (dot_id, tier, rule_key, matcher, text, source_approval,
                                   status, expires_at, hits)
       VALUES ($dotId, $tier, $ruleKey, $matcher, $text, $approvalId, 'active', $expiresAt, 0)`,
    )
    .run({
      dotId,
      tier: derived.tier,
      ruleKey: derived.ruleKey,
      matcher: JSON.stringify(derived.matcher),
      text: derived.text,
      approvalId,
      expiresAt,
    }) as unknown as { lastInsertRowid: number | bigint };
  enforceTierCap(db, dotId, derived.tier, 'approval_rules', defaults);
  return { id: Number(res.lastInsertRowid), source: 'rule', reused: false };
}

/**
 * §4.5 第一阀：每 Dot 每档位记忆上限 50 条，超出按 LRU（last_hit_at）自动 expired，
 * 防授权沉积。从未命中的行 last_hit_at 为 NULL，排在最前（最先被淘汰）。
 *
 * 列名差异：`approval_rules.tier` vs `endpoint_grants.tier_ceiling`
 * ——见 db/migrations/020_governance.sql:58/69。两张表自 090 起都有 last_hit_at，
 * LRU 判据因此完全同构（此前 endpoint_grants 退化成 id 正序：天天在用的热授权
 * 反而先被 expired，冷授权躺着占位——2026-10-17 修）。
 */
export function enforceTierCap(
  db: DatabaseSync,
  dotId: string,
  tier: ToolTier,
  table: 'approval_rules' | 'endpoint_grants',
  defaults: GovDefaults = govDefaults(),
): number {
  const cap = defaults.memoryPerTierCap;
  const tierCol = table === 'approval_rules' ? 'tier' : 'tier_ceiling';
  // 排在最前的先淘汰：没命中过的（IS NOT NULL 为 0）→ 命中最早的 → id 最小的。
  // 注意别写成 `(last_hit_at IS NULL)`：那个表达式把 0 给了命中过的行，ASC 之下
  // 反而先砍热授权、让从没用过的冷授权躺着占位——与上面注释说的正好相反
  // （2026-10-17 修，两张表同受益）。
  const order = 'ORDER BY (last_hit_at IS NOT NULL), last_hit_at ASC, id ASC';
  const rows = db
    .prepare(
      `SELECT id FROM ${table}
        WHERE dot_id=$dotId AND ${tierCol}=$tier AND status='active'
        ${order}`,
    )
    .all({ dotId, tier }) as unknown as { id: number }[];
  if (rows.length <= cap) return 0;
  const victims = rows.slice(0, rows.length - cap);
  const nowIso = new Date().toISOString();
  let expired = 0;
  for (const v of victims) {
    db.prepare(`UPDATE ${table} SET status='expired' WHERE id=$id AND status='active'`).run({
      id: Number(v.id),
    });
    expired++;
  }
  return expired;
}

/** §4.5 第二阀：Web「记忆」页 + CLI `dotd memory ls` 全量可见。 */
export function listMemory(
  db: DatabaseSync,
  dotId: string,
  opts: { tier?: ToolTier; includeTerminal?: boolean } = {},
): Array<{
  id: number;
  source: 'rule' | 'grant';
  tier: string;
  key: string;
  text: string;
  status: string;
  expiresAt: string;
  hits: number;
  lastHitAt: string | null;
  createdAt: string;
}> {
  const out: Array<{
    id: number;
    source: 'rule' | 'grant';
    tier: string;
    key: string;
    text: string;
    status: string;
    expiresAt: string;
    hits: number;
    lastHitAt: string | null;
    createdAt: string;
  }> = [];
  const clause = (extra: string): string =>
    `${extra}${opts.tier !== undefined ? ' AND tier=$tier' : ''}${
      opts.includeTerminal === true ? '' : " AND status='active'"
    }`;
  const params: Record<string, string> = { dotId };
  if (opts.tier !== undefined) params.tier = opts.tier;

  const rules = db
    .prepare(
      `SELECT id, tier, rule_key, text, status, expires_at, hits, last_hit_at, created_at
         FROM approval_rules WHERE dot_id=$dotId ${clause('')}`,
    )
    .all(params as Record<string, never>) as unknown as Record<string, unknown>[];
  for (const r of rules) {
    out.push({
      id: Number(r.id),
      source: 'rule',
      tier: String(r.tier),
      key: String(r.rule_key),
      text: String(r.text),
      status: String(r.status),
      expiresAt: String(r.expires_at),
      hits: Number(r.hits),
      lastHitAt: r.last_hit_at === null ? null : String(r.last_hit_at),
      createdAt: String(r.created_at),
    });
  }
  const grants = db
    .prepare(
      `SELECT id, tier_ceiling, origin, path_glob, status, expires_at, hits, created_at
         FROM endpoint_grants WHERE dot_id=$dotId ${
           opts.tier !== undefined ? 'AND tier_ceiling=$tier ' : ''
         }${opts.includeTerminal === true ? '' : "AND status='active'"}`,
    )
    .all(params) as unknown as Record<string, unknown>[];
  for (const g of grants) {
    out.push({
      id: Number(g.id),
      source: 'grant',
      tier: String(g.tier_ceiling),
      key: `grant:${String(g.origin)}${String(g.path_glob)}`,
      text: `已批端点 ${String(g.origin)}${String(g.path_glob)}`,
      status: String(g.status),
      expiresAt: String(g.expires_at),
      hits: Number(g.hits),
      // endpoint_grants 无 last_hit_at 列（DDL 一字不改）⇒ 恒 null。
      lastHitAt: null,
      createdAt: String(g.created_at),
    });
  }
  return out;
}

/**
 * §4.5 第二阀：CLI `dotd memory revoke <id>`（主人撤销即时失效）。
 *
 * §6 首行「所有治理动作唯一落点」：撤销记忆必须落 `memory_revoked`
 * 审计（带 dot_id/tier/key，供事后回答"谁在何时撤了什么授权"）。
 */
export function revokeMemory(
  db: DatabaseSync,
  id: number,
): { ok: true; source: 'rule' | 'grant' } | { ok: false; reason: string } {
  const r = db
    .prepare(`UPDATE approval_rules SET status='revoked' WHERE id=$id AND status='active'`)
    .run({ id }) as unknown as { changes: number };
  if (Number(r.changes) > 0) {
    const row = db
      .prepare('SELECT dot_id, tier, rule_key, text FROM approval_rules WHERE id=$id')
      .get({ id }) as { dot_id: string; tier: string; rule_key: string; text: string };
    appendAudit(db, {
      dotId: String(row.dot_id),
      actor: 'owner',
      channel: 'cli',
      action: 'memory_revoked',
      tier: row.tier as ToolTier,
      decision: 'revoked',
      reason: `规则记忆撤销：${String(row.text)}`,
      details: { source: 'rule', refId: id, key: String(row.rule_key) },
    });
    return { ok: true, source: 'rule' };
  }
  const g = db
    .prepare(`UPDATE endpoint_grants SET status='revoked' WHERE id=$id AND status='active'`)
    .run({ id }) as unknown as { changes: number };
  if (Number(g.changes) > 0) {
    const row = db
      .prepare(
        'SELECT dot_id, tier_ceiling, origin, path_glob FROM endpoint_grants WHERE id=$id',
      )
      .get({ id }) as {
      dot_id: string;
      tier_ceiling: string;
      origin: string;
      path_glob: string;
    };
    appendAudit(db, {
      dotId: String(row.dot_id),
      actor: 'owner',
      channel: 'cli',
      action: 'memory_revoked',
      tier: row.tier_ceiling as ToolTier,
      decision: 'revoked',
      reason: `端点授权撤销：${String(row.origin)}${String(row.path_glob)}`,
      details: { source: 'grant', refId: id, key: `grant:${String(row.origin)}${String(row.path_glob)}` },
    });
    return { ok: true, source: 'grant' };
  }
  return { ok: false, reason: `记忆 #${id} 不存在或已终态` };
}

/**
 * 到期记忆置 expired（cron 日任务；返回置失效的条数）。
 *
 * §6 首行「所有治理动作唯一落点」：逐条落 `memory_expired`
 * 审计（先查后改，逐条写，避免一次 UPDATE 批量吞掉可追溯性）。
 */
export function expireMemory(db: DatabaseSync, nowIso = new Date().toISOString()): number {
  const dueRules = db
    .prepare(
      `SELECT id, dot_id, tier, rule_key, text FROM approval_rules
        WHERE status='active' AND expires_at <= $now`,
    )
    .all({ now: nowIso }) as unknown as Array<{
    id: number;
    dot_id: string;
    tier: string;
    rule_key: string;
    text: string;
  }>;
  const dueGrants = db
    .prepare(
      `SELECT id, dot_id, tier_ceiling, origin, path_glob FROM endpoint_grants
        WHERE status='active' AND expires_at <= $now`,
    )
    .all({ now: nowIso }) as unknown as Array<{
    id: number;
    dot_id: string;
    tier_ceiling: string;
    origin: string;
    path_glob: string;
  }>;

  for (const r of dueRules) {
    db.prepare(`UPDATE approval_rules SET status='expired' WHERE id=$id AND status='active'`).run({
      id: r.id,
    });
    appendAudit(db, {
      dotId: String(r.dot_id),
      actor: 'system',
      channel: 'system',
      action: 'memory_expired',
      tier: r.tier as ToolTier,
      decision: 'expired',
      reason: `规则记忆到期失效：${String(r.text)}`,
      details: { source: 'rule', refId: r.id, key: String(r.rule_key), expiresAt: nowIso },
    });
  }
  for (const g of dueGrants) {
    db.prepare(`UPDATE endpoint_grants SET status='expired' WHERE id=$id AND status='active'`).run({
      id: g.id,
    });
    appendAudit(db, {
      dotId: String(g.dot_id),
      actor: 'system',
      channel: 'system',
      action: 'memory_expired',
      tier: g.tier_ceiling as ToolTier,
      decision: 'expired',
      reason: `端点授权到期失效：${String(g.origin)}${String(g.path_glob)}`,
      details: {
        source: 'grant',
        refId: g.id,
        key: `grant:${String(g.origin)}${String(g.path_glob)}`,
        expiresAt: nowIso,
      },
    });
  }
  return dueRules.length + dueGrants.length;
}

/** 记忆适用档位（§4.1：read / write_file / browser）。 */
export { MEMORY_TIERS, memoryEligible };
