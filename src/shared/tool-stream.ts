/**
 * src/shared/tool-stream.ts —— 流式工具调用**增量聚合器**（跨模块共享，唯一实现）。
 *
 * 归属：`src/shared/`（契约层）。为什么要放这里而不是各模块各写一份：
 * transport 要把 SSE 分片聚合成 chunk、ModelRouter 要把 chunk 聚合成"回合结束时的
 * 完整 toolCalls"、Runner 要把它们交回 `stepTool`——三处若各写一份拼接逻辑，
 * 迟早对不齐（重复执行/丢调用是这里最容易出的事故）。聚合规则只此一份。
 *
 * 容错策略（各 provider 的流式格式并不统一，聚合器必须容错而不丢调用）：
 * 1. **index 缺失**（部分网关首个分片不带 index）：沿用"当前打开的那个调用"；
 *    若还没有任何调用，则开一个新的。
 * 2. **index 跳号/乱序**：按 index 建槽，不要求连续、不要求递增；到达顺序只影响
 *    同槽内的拼接顺序，不同槽互不干扰。
 * 3. **一次下发整段**（非真流式网关把完整 arguments 塞进一块）：只有一个分片时
 *    拼接结果就是原文，行为与增量一致。
 * 4. **name 重复/被拆开**：name 只在首次出现时确定，之后到达的 name 片段**追加**——
 *    某些网关会把长函数名拆块下发；若后续块与已确定的前缀重复（幂等重发），忽略。
 * 5. **id 缺失**：收口时补一个稳定占位（`call_${index}`），保证 journal/exec 的
 *    call_id 关联不因上游缺字段而崩——但**不伪造已存在的 id**。
 */

import type { StreamToolCallDelta } from './contracts.ts';

/** 聚合中的一个工具调用（收口后的成品形状，与 `ChatResponse.toolCalls` 同形）。 */
export interface AggregatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface Slot {
  index: number;
  id: string | null;
  name: string;
  args: string;
}

/**
 * 增量 → 成品。非线程安全、无 IO，一个回合一个实例。
 *
 * 用法：
 * ```ts
 * const acc = new StreamToolCallAccumulator();
 * for await (const c of stream) if (c.toolCalls !== undefined) acc.push(c.toolCalls);
 * const calls = acc.settle(); // 回合结束
 * ```
 */
export class StreamToolCallAccumulator {
  private readonly slots = new Map<number, Slot>();
  /** index 缺失时"当前打开的调用"（容错策略 1）。 */
  private current: number | null = null;
  /** 下一次 index 缺失且无当前调用时，分配的新槽号。 */
  private nextIndex = 0;
  /** 上次到达的原始 index（用于识别"同值重复重发"）。 */
  private lastRawIndex: number | null = null;

  /** 吃一块增量（可同时处理同一 chunk 里的多条）。 */
  push(deltas: readonly StreamToolCallDelta[]): void {
    for (const d of deltas) {
      // 空增量（没有任何内容）不开槽：否则"上游发了一条空 tool_calls 占位"会被误当成
      // "这一轮要调工具"，让空壳判据与防假完成兜底全部失效。
      const hasContent =
        (d.id !== undefined && d.id.length > 0) ||
        (d.name !== undefined && d.name.length > 0) ||
        (d.argumentsDelta !== undefined && d.argumentsDelta.length > 0);
      if (!hasContent) continue;
      const idx = this.resolveIndex(d);
      const slot = this.slotAt(idx);
      if (d.id !== undefined && d.id.length > 0 && slot.id === null) slot.id = d.id;
      if (d.name !== undefined && d.name.length > 0) appendName(slot, d.name);
      if (d.argumentsDelta !== undefined && d.argumentsDelta.length > 0) slot.args += d.argumentsDelta;
    }
  }

  /** 当前是否已收集到任何调用（供"空壳判据"判断这一轮是不是工具轮）。 */
  get size(): number {
    return this.slots.size;
  }

  /**
   * 收口：按 index 升序返回成品调用。
   *
   * 名字为空的调用**丢弃**（上游给了参数却没有函数名，派发出去只会得到
   * "未登记工具"的 deny，白白烧一轮）；参数为空的调用保留（无参工具是合法的，
   * 参数串空等价 `{}`）。
   */
  settle(): AggregatedToolCall[] {
    const out: AggregatedToolCall[] = [];
    for (const idx of [...this.slots.keys()].sort((a, b) => a - b)) {
      const s = this.slots.get(idx)!;
      const name = s.name.trim();
      if (name.length === 0) continue;
      out.push({
        id: s.id ?? `call_${idx}`,
        name,
        arguments: normalizeArgs(s.args),
      });
    }
    return out;
  }

  private resolveIndex(d: StreamToolCallDelta): number {
    const raw = d['index'];
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
      // 容错策略 6：同一 index 的**连续重发**不一定是同一个调用——有的网关每个分片
      // 都重发 index=0 来开"下一个"调用。判据：该槽已收成完整调用（已有 name 与参数），
      // 又来了一块带 id 或 name 的**新调用开头** → 顺延到下一个空闲槽，不覆盖旧调用。
      const existing = this.slots.get(raw);
      const slotClosed = existing !== undefined && existing.name.length > 0 && existing.args.length > 0;
      const isNewCallStart = d.id !== undefined || d.name !== undefined;
      if (isNewCallStart && slotClosed && this.lastRawIndex === raw) {
        let candidate = raw + 1;
        while (this.slots.has(candidate)) candidate += 1;
        this.lastRawIndex = raw;
        this.current = candidate;
        return candidate;
      }
      this.lastRawIndex = raw;
      this.current = raw;
      return raw;
    }
    // 容错策略 1：index 缺失 → 沿用当前打开的调用；没有则新开一个。
    if (this.current !== null) return this.current;
    const fresh = this.nextIndex;
    this.nextIndex += 1;
    this.current = fresh;
    return fresh;
  }

  private slotAt(idx: number): Slot {
    let s = this.slots.get(idx);
    if (s === undefined) {
      s = { index: idx, id: null, name: '', args: '' };
      this.slots.set(idx, s);
      if (idx >= this.nextIndex) this.nextIndex = idx + 1;
    }
    return s;
  }
}

/** name 拼接：首次确定后只追加"非重复"的尾部（容错策略 4）。 */
function appendName(slot: Slot, piece: string): void {
  if (slot.name.length === 0) {
    slot.name = piece;
    return;
  }
  // 幂等重发：整段与已得前缀相同 → 忽略（真流式只有首块带 name 时也会走到这里）
  if (slot.name === piece || slot.name.startsWith(piece)) return;
  if (piece.startsWith(slot.name)) {
    slot.name = piece;
    return;
  }
  slot.name += piece;
}

/**
 * 参数串归一：空 → `{}`；合法 JSON → 原样（保留上游字节，不做重排）；
 * 非法 JSON → 原样保留（**不猜、不修**）——`stepTool` 会把它当 `__raw` 记账，
 * 由治理/模型看到"参数不可解析"，比在这里静默塞一个 `{}` 更容易排查。
 */
function normalizeArgs(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '{}';
  return raw;
}
