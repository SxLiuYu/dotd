/**
 * src/router/recon.ts —— Tier4 互联网侦察（只侦察、只提案，接入必须主人批准）。
 *
 * 依据（逐字可溯，行号指 docs/design/modules/model-router.md）：
 * - §4.6 触发：mode ≠ NORMAL 时每 6h（recon.interval_ms）；TOTAL_OUTAGE 时侦察与真实重试交替。
 * - §4.6 流程 1：拉数据源只读**元数据**（绝不向候选发 chat/completions 推理请求）；
 *   `openrouter_models` 源 GET /api/v1/models 过滤 `:free`；`github_curated` 源经
 *   api.github.com/repos/…/contents/ base64 取回。**禁止直连 github.com/huggingface.co**
 *   （本机实测超时），如需人工参考镜像一律用 hf-mirror.com。
 * - §4.6 流程 2：八行状态分支表（needs_approval/expired/retired/rejected 冷却内外/approved/live/
 *   表内无行），`UNIQUE(base_url, model)` 下走 UPDATE 永不撞 INSERT 约束。
 * - §4.6 流程 4：批准落库幂等定序——事务内先 UPDATE state='live'，提交后再写 free-models.yml
 *   （文件写失败留 approved + reject_reason=null + 记 updated_at 与内部错误，1min 心跳重试）。
 * - §4.6 流程 5：拒绝 → state='rejected' + reject_reason，30d 冷却；7 天无人理会 → janitor 置 expired。
 * - §4.6 流程 6：主人手工删条目 → 启动对账把对应 live 行置 retired。
 * - §4.6 流程 7：侦察源不可达不额外求救，下条 help 附"侦察候选: 无（源不可达: <错误>）"。
 * - §4.7 启动对账第 2/3 步：approved 且文件无条目 → 重试写文件转 live；有条目但未 live → 直接转
 *   live；文件被手工删的 live 行置 retired。
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { EventBus } from '../shared/bus.ts';
import type { ReconItem, ModelTransport, ReconConfig, ReconSourceConfig } from './types.ts';
import type { PoolManager } from './pool.ts';

/** 候选 id：'recon:' + sha1(source|base_url|model) 前 12 位（§3.2 DDL 注释）。 */
export function candidateId(source: string, baseUrl: string, model: string): string {
  const h = createHash('sha1').update(`${source}|${baseUrl}|${model}`).digest('hex');
  return `recon:${h.slice(0, 12)}`;
}

export type ReconState =
  | 'needs_approval'
  | 'approved'
  | 'rejected'
  | 'live'
  | 'expired'
  | 'retired';

interface CandidateRow {
  id: string;
  source: string;
  base_url: string;
  model: string;
  api_key_note: string | null;
  rate_note: string | null;
  evidence: string | null;
  state: ReconState;
  decided_by: string | null;
  decided_at: number | null;
  reject_reason: string | null;
  found_at: number;
  updated_at: number;
}

export interface ReconStore {
  db: DatabaseSync;
  bus: EventBus;
  cfg: ReconConfig;
  pool: PoolManager;
  now?: () => number;
}

/** 一次扫描的结果（供 help 模板"侦察候选"段与测试断言）。 */
export interface ScanResult {
  ok: boolean;
  /** 源不可达原因（§4.6 流程 7：不额外求救，附在下条 help 里）。 */
  sourceError: string | null;
  /** 本次新提案的候选（已发 recon_proposal 事件）。 */
  proposed: Array<{ id: string; base_url: string; model: string; summary: string }>;
  /** 已存在的 needs_approval 候选（供 help 段列出待批候选）。 */
  pending: Array<{ id: string; base_url: string; model: string }>;
}

/**
 * 侦察器。
 *
 * 与审批模块的接缝（契约 J6/§6.3）：治理发 `approval:decided`（载荷
 * `subject.kind='recon_candidate'`, id, verdict），由 ModelRouter.onApprovalResult 转调
 * `applyApproval()`。
 */
export class ReconScanner {
  private readonly db: DatabaseSync;
  private readonly bus: EventBus;
  private readonly cfg: ReconConfig;
  private readonly pool: PoolManager;
  private readonly now: () => number;

  constructor(store: ReconStore) {
    this.db = store.db;
    this.bus = store.bus;
    this.cfg = store.cfg;
    this.pool = store.pool;
    this.now = store.now ?? Date.now;
  }

  // ── 扫描（§4.6 流程 1–3）─────────────────────────────────────────

  /**
   * 跑一遍全部数据源并按 §4.6 八行分支表去重。
   *
   * 只读元数据：`transport.metadata()` 只 GET 模型列表/清单文件，绝不 POST
   * chat/completions（§4.6 流程 1 逐字）。
   */
  async scan(transport: ModelTransport, mode: import('../shared/contracts.ts').RouterMode): Promise<ScanResult> {
    void mode; // 触发条件（mode ≠ NORMAL）由调用方（心跳任务）判定
    const result: ScanResult = { ok: true, sourceError: null, proposed: [], pending: [] };
    const found: ReconItem[] = [];
    const sourceOf = new Map<string, string>();
    for (const src of this.cfg.sources) {
      const r = await transport.metadata(this.toQuery(src));
      if (!r.ok) {
        result.ok = false;
        result.sourceError = r.error ?? `源 ${src.type} 不可达`;
        continue;
      }
      for (const item of r.items) found.push(item), sourceOf.set(`${item.base_url}|${item.model}`, src.type);
    }
    if (result.sourceError !== null) return result;

    // §4.6 流程 2 八行分支 + 流程 3 排序取 top N 发事件
    const proposals: Array<{ id: string; base_url: string; model: string; item: ReconItem; source: string }> = [];
    const filePairs = new Set(this.pool.filePairs().map((p) => `${p.base_url}|${p.model}`));
    for (const item of found) {
      const key = `${item.base_url}|${item.model}`;
      const source = sourceOf.get(key) ?? 'manual';
      const row = this.findByPair(item.base_url, item.model);
      if (row === undefined) {
        // 表内无行：查 models.yml/free-models.yml，主人渠道优先 → 跳过
        if (filePairs.has(key)) continue;
        proposals.push({ id: candidateId(source, item.base_url, item.model), base_url: item.base_url, model: item.model, item, source });
        continue;
      }
      switch (row.state) {
        case 'needs_approval': {
          // 未超 7d：只刷新 evidence/updated_at，不重复发事件
          if (this.now() - row.found_at < this.cfg.candidate_ttl_ms) {
            this.touch(row, item);
            break;
          }
          // 超 7d 仍无人理会：落 expired 由 janitor 走；此处不提案（避免抖动）
          this.touch(row, item);
          break;
        }
        case 'expired':
        case 'retired':
          this.revive(row, item);
          proposals.push({ id: row.id, base_url: row.base_url, model: row.model, item, source: row.source });
          break;
        case 'rejected': {
          const cooled = this.now() - (row.decided_at ?? row.updated_at) >= this.cfg.rejected_cooldown_ms;
          if (!cooled) break; // 30d 冷却期内跳过，不出现
          this.revive(row, item);
          proposals.push({ id: row.id, base_url: row.base_url, model: row.model, item, source: row.source });
          break;
        }
        case 'approved':
        case 'live':
          break; // 跳过（不重复提案）
        default:
          break;
      }
    }

    const top = proposals.slice(0, this.cfg.max_candidates_per_scan);
    for (const p of top) {
      const summary = `${p.base_url} ${p.model}`;
      this.upsertProposal(p);
      this.bus.publish('router.recon_proposal', {
        type: 'recon_proposal',
        candidateId: p.id,
        summary,
      });
      result.proposed.push({ id: p.id, base_url: p.base_url, model: p.model, summary });
    }
    result.pending = this.pendingCandidates();
    return result;
  }

  private toQuery(src: ReconSourceConfig): import('./types.ts').MetadataQuery {
    if (src.type === 'openrouter_models') {
      return {
        kind: 'openrouter_models',
        url: 'https://openrouter.ai/api/v1/models',
        filter: src.filter,
      };
    }
    return {
      kind: 'github_curated',
      url: src.api_url ?? '',
      raw_via: src.raw_via,
    };
  }

  // ── 行操作 ───────────────────────────────────────────────────────

  findByPair(baseUrl: string, model: string): CandidateRow | undefined {
    return this.db
      .prepare('SELECT * FROM recon_candidate WHERE base_url = ? AND model = ?')
      .get(baseUrl, model) as CandidateRow | undefined;
  }

  findById(id: string): CandidateRow | undefined {
    return this.db.prepare('SELECT * FROM recon_candidate WHERE id = ?').get(id) as
      | CandidateRow
      | undefined;
  }

  private touch(row: CandidateRow, item: ReconItem): void {
    this.db
      .prepare('UPDATE recon_candidate SET evidence = ?, updated_at = ? WHERE id = ?')
      .run(
        JSON.stringify({ ...(item.evidence ?? {}), rescanned_at: this.now() }),
        this.now(),
        row.id,
      );
  }

  /** expired/retired/过冷 rejected → needs_approval（复活重提案，发事件）。 */
  private revive(row: CandidateRow, item: ReconItem): void {
    this.db
      .prepare(
        `UPDATE recon_candidate SET state='needs_approval', found_at=?, updated_at=?,
           decided_by=NULL, decided_at=NULL, reject_reason=NULL, evidence=? WHERE id=?`,
      )
      .run(
        this.now(),
        this.now(),
        JSON.stringify({ ...(item.evidence ?? {}), revived_at: this.now() }),
        row.id,
      );
  }

  private upsertProposal(p: {
    id: string;
    base_url: string;
    model: string;
    item: ReconItem;
    source: string;
  }): void {
    const now = this.now();
    const existing = this.findById(p.id);
    const evidence = JSON.stringify({
      ...(p.item.evidence ?? {}),
      source: p.source,
      scanned_at: now,
    });
    if (existing === undefined) {
      this.db
        .prepare(
          `INSERT INTO recon_candidate
             (id, source, base_url, model, api_key_note, rate_note, evidence, state, found_at, updated_at)
           VALUES (?,?,?,?,?,?,?, 'needs_approval', ?, ?)`,
        )
        .run(
          p.id,
          p.source,
          p.base_url,
          p.model,
          p.item.api_key_note ?? null,
          p.item.rate_note ?? null,
          evidence,
          now,
          now,
        );
      return;
    }
    this.db
      .prepare(
        `UPDATE recon_candidate SET state='needs_approval', found_at=?, updated_at=?, evidence=?,
           api_key_note=?, rate_note=? WHERE id=?`,
      )
      .run(
        now,
        now,
        evidence,
        p.item.api_key_note ?? existing.api_key_note,
        p.item.rate_note ?? existing.rate_note,
        p.id,
      );
  }

  // ── 审批回调（§4.6 流程 4/5；契约 J6）────────────────────────────

  /**
   * 批准：**事务内先 UPDATE state='live'**，提交后写 free-models.yml。
   * 文件写失败：state 留 `approved`，`reject_reason=null` 但记 updated_at 与内部错误，
   * 1min 心跳重试写文件、成功转 live（§4.6 第 4 步 + §4.7 对账第 2 步）。
   */
  approve(id: string, by = 'owner'): { ok: boolean; state: ReconState | null; fileError?: string } {
    const row = this.findById(id);
    if (row === undefined) return { ok: false, state: null };
    const now = this.now();
    const tx = this.db.prepare('BEGIN IMMEDIATE');
    try {
      tx.run();
      this.db
        .prepare(
          `UPDATE recon_candidate SET state='live', decided_by=?, decided_at=?, updated_at=?, reject_reason=NULL
           WHERE id=?`,
        )
        .run(by, now, now, id);
      this.db.prepare('COMMIT').run();
    } catch (cause) {
      this.db.prepare('ROLLBACK').run();
      return { ok: false, state: row.state, fileError: String(cause) };
    }
    // 提交后写文件（幂等：同 base_url+model 已存在则只 touch updated_at）
    const w = this.pool.addApprovedCandidate({
      id,
      base_url: row.base_url,
      model: row.model,
      api_key_env: row.api_key_note === null ? null : envNameOf(row.api_key_note),
    });
    if (!w.ok) {
      // 留 approved + 记内部错误，心跳重试
      this.db
        .prepare(
          `UPDATE recon_candidate SET state='approved', updated_at=?, reject_reason=NULL WHERE id=?`,
        )
        .run(this.now(), id);
      return { ok: true, state: 'approved', fileError: w.error };
    }
    return { ok: true, state: 'live' };
  }

  /** 拒绝：state='rejected' + reject_reason，30d 冷却生效（§4.6 流程 5）。 */
  reject(id: string, reason: string, by = 'owner'): boolean {
    const r = this.db
      .prepare(
        `UPDATE recon_candidate SET state='rejected', decided_by=?, decided_at=?, reject_reason=?, updated_at=?
         WHERE id=?`,
      )
      .run(by, this.now(), reason, this.now(), id);
    return Number(r.changes) > 0;
  }

  // ── 查询面 ───────────────────────────────────────────────────────

  /** needs_approval 候选（NoQualifiedPrimaryError 判据之一 + help"待批候选"段）。 */
  pendingCandidates(): Array<{ id: string; base_url: string; model: string }> {
    const rows = this.db
      .prepare(`SELECT id, base_url, model FROM recon_candidate WHERE state='needs_approval' ORDER BY found_at`)
      .all() as Array<{ id: string; base_url: string; model: string }>;
    return rows;
  }

  pendingCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM recon_candidate WHERE state='needs_approval'`)
      .get() as { n: number };
    return row.n;
  }

  /** 侦察源最近一次不可达原因（help 模板"侦察候选: 无（源不可达: …）"）。 */
  lastSourceError: string | null = null;

  // ── 启动对账（§4.7 第 2/3 步）────────────────────────────────────

  /**
   * 对账：
   * 1. `approved` 且 free-models.yml 无对应条目 → 重试写文件转 live；
   *    有条目但未 live → 直接转 live（补齐断掉的迁移）。
   * 2. free-models.yml ↔ state='live' 双向核对，文件被手工删的行置 retired。
   */
  reconcile(): { promoted: string[]; retired: string[]; stillPending: string[] } {
    const promoted: string[] = [];
    const retired: string[] = [];
    const stillPending: string[] = [];
    const filePairs = new Set(this.pool.filePairs().map((p) => `${p.base_url}|${p.model}`));

    const rows = this.db.prepare('SELECT * FROM recon_candidate').all() as unknown as CandidateRow[];
    for (const row of rows) {
      const inFile = filePairs.has(`${row.base_url}|${row.model}`);
      if (row.state === 'approved') {
        if (inFile) {
          this.db
            .prepare(`UPDATE recon_candidate SET state='live', updated_at=? WHERE id=?`)
            .run(this.now(), row.id);
          promoted.push(row.id);
        } else {
          const w = this.pool.addApprovedCandidate({
            id: row.id,
            base_url: row.base_url,
            model: row.model,
            api_key_env: row.api_key_note === null ? null : envNameOf(row.api_key_note),
          });
          if (w.ok) {
            this.db
              .prepare(`UPDATE recon_candidate SET state='live', updated_at=? WHERE id=?`)
              .run(this.now(), row.id);
            promoted.push(row.id);
          } else {
            stillPending.push(row.id);
          }
        }
        continue;
      }
      if (row.state === 'live' && !inFile) {
        // 主人从 free-models.yml 手工删除条目 → 回写 retired
        this.db
          .prepare(`UPDATE recon_candidate SET state='retired', updated_at=? WHERE id=?`)
          .run(this.now(), row.id);
        retired.push(row.id);
      }
    }
    return { promoted, retired, stillPending };
  }

  // ── janitor（§4.6 流程 5 后半 + §3.2 体积回收）───────────────────

  /**
   * 7 天无人理会（found_at 起算）→ expired；
   * expired/retired 行保留 90 天后物理删除（§3.2 体积回收）。
   */
  janitor(): { expired: number; deleted: number } {
    const now = this.now();
    const e = this.db
      .prepare(
        `UPDATE recon_candidate SET state='expired', updated_at=?
         WHERE state='needs_approval' AND found_at < ?`,
      )
      .run(now, now - this.cfg.candidate_ttl_ms);
    const d = this.db
      .prepare(
        `DELETE FROM recon_candidate WHERE state IN ('expired','retired') AND updated_at < ?`,
      )
      .run(now - 90 * 86_400_000);
    return { expired: Number(e.changes), deleted: Number(d.changes) };
  }
}

/** api_key_note 里可能写的是 env 名（如 'OPENROUTER_API_KEY'）或自然语言说明。 */
function envNameOf(note: string): string | null {
  const m = /^[A-Z][A-Z0-9_]{2,}$/.exec(note.trim());
  return m === null ? null : note.trim();
}
