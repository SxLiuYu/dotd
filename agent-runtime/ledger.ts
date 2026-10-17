/**
 * agent-runtime/ledger.ts —— 幂等 ledger（EX §5.4「协议核心」的容器内实现）。
 *
 * 设计原文（docs/design/modules/execution.md §5.4，含评审修订 1/9）：
 *
 *   agent-runtime 在 **state 卷**维护 append-only JSONL：
 *   `/opt/agent-state/ledger.jsonl`（独立 named volume，属主 uid 1000 / 0700，
 *   与 home 卷分离，shell uid 1001 跨权限读写不到——EX §7.1）。
 *
 *   handleCall(call):
 *     rec = ledger.get(call.call_id)
 *     if rec 存在:
 *        if rec.state == 'done'  → 直接重放 rec.result
 *        if rec.state == 'doing' → 返回 status='running' + 现有 job_id
 *        if rec.state == 'aborted'(启动时清理所得) → error{code:'interrupted', retryable:true}
 *     ledger.append({call_id, state:'doing', started_at, tool, args_hash: sha256(args)})
 *     dispatch → 完成时 append {call_id, state:'done', result_json}
 *
 *   修订 1：中断只对"未完成"的调用成立，绝不覆盖已完成。
 *     容器进程重启时扫描 ledger：`doing` → `aborted`；`done` 原样保留。
 *     home/state 卷跨 recreate 持久，故 recreate 后 daemon 用旧 call_id 查
 *     `GET /calls/{call_id}`，done 项重放 result → journal 确认 → 不重派 → 不二次执行。
 *   修订 9：ledger 压缩只动"已被控制面确认"的 done 项；
 *     `result_json` → `result_hash` + `compacted:true`；重放 compacted 项返回
 *     `error{code:'result_compacted', retryable:false, hash}`。
 *     未确认的 done 项**永不压缩**——先确认、后瘦身，保证重放窗口。
 *
 * 实现取舍（不引入第三方日志库，与骨架"能用内置不用第三方"一致）：
 * - 单进程 append-only：`appendFileSync` 追加写，启动时一次性 `readFileSync` 载入。
 *   ledger 行数有硬顶（state 卷 64MB / EX §8），全量载入可接受。
 * - 内存索引 Map<call_id, LedgerRecord>；`result_json` 只在 done 项入内存，
 *   压缩时不重新写盘（压缩 = 重写整个文件：读入 → 改写 → 原子 rename）。
 * - `args_hash` 撞车（同 call_id 不同 args）→ 抛 `call_id_reuse_mismatch`，
 *   这是对"call_id 全局唯一"这一不变量（契约 J1）的最后防线。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { ToolName } from './protocol.ts';

/**
 * ledger 记录状态（EX §5.4 三态 + 压缩态）。
 * **与宿主 src/exec/protocol.ts 的 LedgerState 逐字同词表**：宿主侧
 * `ledgerReplay()` 按 `state==='compacted'` 分流 result_compacted，
 * 容器内 ledger 文件跨 recreate 持久，宿主 reconcile 会读同一份 JSONL。
 */
export type LedgerState = 'doing' | 'done' | 'aborted' | 'compacted';

export interface LedgerRecord {
  call_id: string;
  state: LedgerState;
  started_at: string;
  finished_at?: string;
  tool: ToolName;
  args_hash: string;
  /** done 项的工具自定义结果（EX §5.3 ToolResult.result）。 */
  result_json?: unknown;
  /** EX §5.4-4：压缩后 result_json → result_hash。 */
  result_hash?: string;
  /**
   * 兼容标记（EX §5.4-4 原文「标记 compacted:true」）。state 已改为 'compacted'，
   * 此字段仅用于读取旧版 ledger 行（迁移窗口），新写行不再设置。
   */
  compacted?: boolean;
  /** async 调用的 job_id（doing/done 都可能带，供 /jobs/{id} 与 reconcile 续轮询）。 */
  job_id?: string;
  /** 宿主确认位：true = 控制面已确认（EX §5.4-4「已被控制面确认的 done 项」才可压缩）。 */
  confirmed?: boolean;
  /**
   * error 路径收回 doing 行的原因（`dropDoing` 写入，诊断用）。
   * 与"重启扫描把 doing 标 aborted"（无此字段）区分：后者报 interrupted，
   * 前者只是把未完成的行收掉，调用方已拿到自己的 error。
   */
  error_reason?: string;
}

/** 取回某 call_id 的判定结果（供 handleCall 分流）。 */
export type LedgerLookup =
  | { kind: 'missing' }
  | { kind: 'done'; record: LedgerRecord }
  | { kind: 'doing'; record: LedgerRecord }
  | { kind: 'aborted'; record: LedgerRecord }
  | { kind: 'compacted'; record: LedgerRecord };

export interface LedgerOptions {
  /** state 卷上的 JSONL 路径（默认 `/opt/agent-state/ledger.jsonl`，EX §5.4）。 */
  filePath?: string;
  /** 超过此行数才允许压缩（EX §5.4-4：「超 5000 行时」）。 */
  compactThreshold?: number;
}

export const DEFAULT_LEDGER_PATH = '/opt/agent-state/ledger.jsonl';
export const DEFAULT_COMPACT_THRESHOLD = 5000;

/** ledger 专属错误（机读 code 跨层判定）。 */
export class LedgerError extends Error {
  readonly code: string;
  constructor(message: string, code = 'ledger_error') {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

export class Ledger {
  private readonly filePath: string;
  private readonly compactThreshold: number;
  /** call_id → 记录（同 call_id 后写覆盖先写，append-only 语义由写入顺序保证）。 */
  private readonly records = new Map<string, LedgerRecord>();
  /** 追加顺序（call_id 首次出现的次序），压缩时保持稳定输出。 */
  private readonly order: string[] = [];

  constructor(opts: LedgerOptions = {}) {
    this.filePath = opts.filePath ?? DEFAULT_LEDGER_PATH;
    this.compactThreshold = opts.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD;
    mkdirSync(dirname(this.filePath), { recursive: true });
    if (existsSync(this.filePath)) this.load();
  }

  /** 文件路径（诊断/测试断言用）。 */
  get path(): string {
    return this.filePath;
  }

  /** 载入 + 中断清理（EX §5.4-1：进程重启只把 doing 标 aborted，done 原样保留）。 */
  private load(): void {
    const raw = readFileSync(this.filePath, 'utf8');
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (t.length === 0) continue;
      let rec: LedgerRecord;
      try {
        rec = JSON.parse(t) as LedgerRecord;
      } catch {
        // 半行（崩溃在 append 中途）：跳过而非拒启动——ledger 是尽力而为的
        // 加速结构，真正的真相在控制面 exec_calls 与 journal。
        continue;
      }
      this.ingest(rec);
    }
    this.recoverInterrupted();
  }

  /** 把一行记录并入内存索引（公开供 load/compact 复用）。 */
  private ingest(rec: LedgerRecord): void {
    if (typeof rec.call_id !== 'string' || rec.call_id.length === 0) return;
    if (!this.records.has(rec.call_id)) this.order.push(rec.call_id);
    this.records.set(rec.call_id, rec);
  }

  /**
   * 启动扫描：`doing` → `aborted`（EX §5.4-1 逐字）。
   * done / aborted 项**绝不被改写**（修订 1 的核心铁律）。
   *
   * 实现要点：aborted 以**追加一行**的方式落盘（append-only 不变），
   * 内存索引指向最后一行。绝不 rewrite 整个文件——那会动到 done 行。
   * 返回被改写条数（0 = 无需落盘）。
   */
  recoverInterrupted(): number {
    let n = 0;
    for (const [id, rec] of this.records) {
      if (rec.state === 'doing') {
        this.records.set(id, { ...rec, state: 'aborted' });
        appendFileSync(this.filePath, `${JSON.stringify(this.records.get(id)!)}\n`, 'utf8');
        n++;
      }
    }
    return n;
  }

  // ── 查询 ──────────────────────────────────────────────────────────

  get(callId: string): LedgerRecord | undefined {
    return this.records.get(callId);
  }

  /** EX §5.4 handleCall 的分流判据。 */
  lookup(callId: string): LedgerLookup {
    const rec = this.records.get(callId);
    if (rec === undefined) return { kind: 'missing' };
    if (rec.state === 'done') return { kind: 'done', record: rec };
    if (rec.state === 'doing') return { kind: 'doing', record: rec };
    if (rec.state === 'compacted') return { kind: 'compacted', record: rec };
    return { kind: 'aborted', record: rec };
  }

  /** 行数（= 记录数；压缩判据用）。 */
  size(): number {
    return this.records.size;
  }

  /** 全部 done 且未压缩的记录（诊断/测试用）。 */
  doneRecords(): LedgerRecord[] {
    return this.order
      .map((id) => this.records.get(id))
      .filter((r): r is LedgerRecord => r !== undefined && r.state === 'done');
  }

  // ── 写入 ──────────────────────────────────────────────────────────

  /**
   * 追加一行（append-only）。EX §5.4：`ledger.append({call_id,state:'doing',...})`。
   * 调用方负责把完整记录构造好；本方法只保证"写盘 + 入索引"的原子语义
   * （进程内同步，无并发写者：agent-runtime 单进程）。
   */
  append(rec: LedgerRecord): void {
    const prev = this.records.get(rec.call_id);
    if (prev !== undefined && prev.args_hash !== rec.args_hash) {
      // 契约 J1：call_id 全局唯一。同 id 不同 args = 调用方违规，绝不静默覆盖。
      throw new LedgerError(
        `call_id ${rec.call_id} 的 args_hash 不一致（${prev.args_hash} → ${rec.args_hash}）`,
        'call_id_reuse_mismatch',
      );
    }
    this.ingest(rec);
    appendFileSync(this.filePath, `${JSON.stringify(rec)}\n`, 'utf8');
  }

  /** 标 doing（EX §5.4 的第一行记账）。 */
  start(callId: string, tool: ToolName, argsHash: string, at: string, jobId?: string): LedgerRecord {
    const rec: LedgerRecord = {
      call_id: callId,
      state: 'doing',
      started_at: at,
      tool,
      args_hash: argsHash,
      ...(jobId !== undefined ? { job_id: jobId } : {}),
    };
    this.append(rec);
    return rec;
  }

  /** 标 done 并落 result_json（EX §5.4 的第二行记账）。 */
  finish(callId: string, resultJson: unknown, at: string, jobId?: string): LedgerRecord {
    const prev = this.records.get(callId);
    if (prev === undefined) {
      throw new LedgerError(`call_id ${callId} 未 start 就 finish`, 'ledger_not_started');
    }
    const rec: LedgerRecord = {
      ...prev,
      state: 'done',
      finished_at: at,
      ...(resultJson !== undefined ? { result_json: resultJson } : {}),
      ...(jobId !== undefined ? { job_id: jobId } : {}),
    };
    this.append(rec);
    // EX §8：state 卷 64MB 上限靠压缩达成；§5.4-4 的判据是"超 5000 行"。
    // 只在写路径上探测（不引入定时器），超阈值即压缩已确认项——这是
    // compact() 的**生产触发点**（原先全仓无调用方，卷会无界增长）。
    this.maybeCompact();
    return rec;
  }

  /** 标 aborted（取消/超时路径；与启动清理同一语义）。 */
  abort(callId: string, at: string): LedgerRecord | undefined {
    const prev = this.records.get(callId);
    if (prev === undefined) return undefined;
    const rec: LedgerRecord = { ...prev, state: 'aborted', finished_at: at };
    this.append(rec);
    return rec;
  }

  /**
   * 收回 doing 行（**error 路径专用**，EX §5.4 + 契约 J1）。
   *
   * 为什么需要它：dispatch 先 `start()` 追加 doing 行再执行工具；若工具返回
   * error，那句"error 项不进 ledger"的注释就和已落盘的 doing 行矛盾——
   * 同 call_id 二次派发会恒返回 running，宿主想按注释重派反被 ledger 挡死。
   *
   * 实现：append-only 不变（**追加**一行 `state:'aborted'`，finished_at 标注
   * 失败原因），内存索引同步；随后由 compact 的"未确认 done 项不压缩"之外的
   * 清理逻辑回收。语义上等同"没有未完成的 doing 行"，而**不写**任何 done
   * 行——失败不是副作用，宿主可自行重派（换不换 call_id 由 journal 定）。
   *
   * 注意：绝不能用它掩盖真的崩溃。doing→aborted 的重启扫描（§5.4-1）报的是
   * `interrupted`（retryable:true）；error 后的收回报的是调用方自己的 error。
   * 二者靠 `reason` 字段区分，调用方只认自己拿到的那一次响应。
   */
  dropDoing(callId: string, reason = 'tool_error'): LedgerRecord | undefined {
    const prev = this.records.get(callId);
    if (prev === undefined || prev.state !== 'doing') return undefined;
    const rec: LedgerRecord = {
      ...prev,
      state: 'aborted',
      finished_at: new Date().toISOString(),
      error_reason: reason,
    };
    this.append(rec);
    return rec;
  }

  /** 宿主确认位（EX §5.4-4：压缩的**唯一**准入条件）。 */
  markConfirmed(callId: string): LedgerRecord | undefined {
    const prev = this.records.get(callId);
    if (prev === undefined) return undefined;
    const rec: LedgerRecord = { ...prev, confirmed: true };
    this.append(rec);
    return rec;
  }

  // ── 压缩（EX §5.4-4 逐字）─────────────────────────────────────────

  /**
   * 超阈值时压缩「已被控制面确认的 done 项」（EX §5.4-4 逐字）：
   *   result_json → result_hash（sha256 hex），state 'done' → 'compacted'
   * 未确认的 done 项**永不压缩**（先确认、后瘦身）。
   *
   * state 用 'compacted' 而不是只在 done 上打标记：宿主 `ledgerReplay()`
   * （src/exec/protocol.ts）按 state 分流，ledger 文件跨 recreate 被宿主读。
   * 同时写 `compacted:true` 兼容标记（读旧版 ledger 的 stub 与文档原文）。
   *
   * 返回被压缩的 call_id 列表；未超阈值返回 []。
   */
  compact(): string[] {
    if (this.records.size < this.compactThreshold) return [];
    const compacted: string[] = [];
    for (const [id, rec] of this.records) {
      if (rec.state !== 'done') continue;
      if (rec.compacted === true) continue; // 已压缩（旧格式行）
      if (rec.confirmed !== true) continue; // 未确认 → 永不压缩
      if (rec.result_json === undefined) continue; // 无结果可瘦身
      const result_hash = createHash('sha256')
        .update(JSON.stringify(rec.result_json), 'utf8')
        .digest('hex');
      const next: LedgerRecord = { ...rec };
      delete next.result_json;
      next.state = 'compacted';
      next.result_hash = result_hash;
      next.compacted = true; // 兼容标记（双写）
      this.records.set(id, next);
      compacted.push(id);
    }
    if (compacted.length > 0) this.rewriteAll();
    return compacted;
  }

  /**
   * 写路径上的压缩探测（EX §8 的 64MB 上限靠它兜）。
   * 与 compact() 的唯一区别：吞掉"整文件重写"可能抛的 IO 错——
   * 压缩是优化，绝不能因为它让一次工具调用失败。
   */
  private maybeCompact(): void {
    try {
      this.compact();
    } catch {
      // 压缩失败（磁盘满/权限）：本次跳过，下次写路径再试。
      // ledger 是尽力而为的加速结构，真相在控制面 exec_calls 与 journal。
    }
  }

  /** 整文件重写（压缩专用；原子 rename 防半文件）。 */
  private rewriteAll(): void {
    const lines: string[] = [];
    for (const id of this.order) {
      const rec = this.records.get(id);
      if (rec !== undefined) lines.push(JSON.stringify(rec));
    }
    const tmp = `${this.filePath}.compact.tmp`;
    writeFileSync(tmp, lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
    renameSync(tmp, this.filePath);
  }
}
