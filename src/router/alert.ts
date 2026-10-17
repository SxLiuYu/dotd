/**
 * src/router/alert.ts —— 求救与恢复通报（账本先行协议）。
 *
 * 依据（逐字可溯，行号指 docs/design/modules/model-router.md §4.5）：
 * - 签名：`signature = sha256(newMode + '|' + sorted('endpointId:track:kind' of failing) + '|' + tier)`。
 *   签名只由"故障集合"决定：同一天内挂了又好又挂，只要故障指纹相同就是同一事件，24h 一条。
 * - **投递协议（账本先行）**：`alert_dispatch` 是去重的唯一账本，因此**任何投递动作之前**
 *   必须先在同一事务里 `INSERT … delivered_via='pending', channels_tried='[]'`；
 *   投递结果回写（UPDATE delivered_via/channels_tried/delivered_at）。
 *   由于账本先行，**同签名 24h 内绝不会二次进入投递路径**（CONTEXT:28 硬保证）；
 *   崩溃恰好在"已投未回写"窗口时会留下 pending 行并造成最坏一次重复投——这是
 *   "绝不漏发"优于"绝不重发"的有意取舍。
 * - 同签名节流：route() 内的 enqueueHelpSoon() 不直接投递，置 helpDirty 位，由
 *   `breaker.probe_timer`（1min 心跳）统一结算。
 * - 恢复通报与多行收敛：mode 变好时逐行核对 failing_json，全恢复行 resolve、部分恢复保持
 *   open、多命中**合并为一条**恢复通报列出全部关联签名（杜绝"只解最老一行"漂移）。
 * - 通道可用性（§4.5）：一律问 SF 的 `NotificationChannels.available`——
 *   feishu = App ID/Secret 齐备且 5min 内成功发过/拿过 token；telegram 未装配 gateway
 *   恒不可用；email 阶段一恒不可用（§5.7/§10 分期表）。不可用即 unconfigured，
 *   继续往下走，最后一级 OUTBOX.md 永不失败。
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { NotificationChannels, RouterMode, TaskImpact, TaskImpactProvider } from '../shared/contracts.ts';
import type { AlertChannelName, AlertsConfig } from './types.ts';
import { OutboxWriter } from './outbox.ts';

/** pending 超过 2min 视为"投递意图存在但未确认"（§4.5 崩溃对账）。 */
export const PENDING_REDELIVER_MS = 120_000;
/** 崩溃补投再失败 → lost（不再自动重试，CLI `dotd models resend-help` 可人工触发）。 */
export type DeliveryChannel = AlertChannelName;

export interface FailingEndpoint {
  endpoint_id: string;
  track: 'primary' | 'light';
  kind: string;
  consec: number;
}

/** 签名字符串（§4.5 逐字）。 */
export function makeSignature(mode: RouterMode, failing: FailingEndpoint[], tier: number): string {
  const fps = failing
    .map((f) => `${f.endpoint_id}:${f.track}:${f.kind}`)
    .sort()
    .join(',');
  return createHash('sha256').update(`${mode}|${fps}|${tier}`).digest('hex').slice(0, 6);
}

export interface AlertDeps {
  db: DatabaseSync;
  cfg: AlertsConfig;
  channels: NotificationChannels | null;
  outbox: OutboxWriter;
  taskImpact: TaskImpactProvider | null;
  now?: () => number;
}

interface AlertRow {
  id: number;
  signature: string;
  kind: 'help' | 'recovery' | 'recon_proposal';
  mode: string;
  failing_json: string;
  served_by: string | null;
  task_impact: string | null;
  channels_tried: string;
  delivered_via: string;
  sent_at: number;
  delivered_at: number | null;
  resolved_at: number | null;
}

/** 投递结果（一个通道一次尝试）。 */
interface ChannelAttempt {
  channel: string;
  result: string;
}

/**
 * 求救/恢复通报器。
 *
 * 账本先行 + 24h 去重的唯一实现在这里；渲染模板见 `renderHelp` / `renderRecovery`。
 */
export class AlertManager {
  private readonly db: DatabaseSync;
  private readonly cfg: AlertsConfig;
  private readonly channels: NotificationChannels | null;
  private readonly outbox: OutboxWriter;
  private readonly taskImpact: TaskImpactProvider | null;
  private readonly now: () => number;
  /** route() 内置位，1min 心跳结算（§4.5 同签名节流）。 */
  helpDirty = false;
  /** 最近一次投递（snapshot.lastAlert 用）。 */
  private lastAlert: { signature: string; sentAt: number; channel: string } | null = null;

  constructor(deps: AlertDeps) {
    this.db = deps.db;
    this.cfg = deps.cfg;
    this.channels = deps.channels;
    this.outbox = deps.outbox;
    this.taskImpact = deps.taskImpact;
    this.now = deps.now ?? Date.now;
    this.refreshLastAlert();
  }

  private refreshLastAlert(): void {
    const row = this.db
      .prepare(
        `SELECT signature, sent_at, delivered_via FROM alert_dispatch
         WHERE delivered_via NOT IN ('pending','lost') ORDER BY sent_at DESC LIMIT 1`,
      )
      .get() as { signature: string; sent_at: number; delivered_via: string } | undefined;
    this.lastAlert =
      row === undefined
        ? null
        : { signature: row.signature, sentAt: row.sent_at, channel: row.delivered_via };
  }

  // ── 查询 ─────────────────────────────────────────────────────────

  /** 未收敛的 help 行数（snapshot.openAlerts = resolved_at IS NULL 的 help 行数）。 */
  openAlerts(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM alert_dispatch WHERE kind='help' AND resolved_at IS NULL`)
      .get() as { n: number };
    return row.n;
  }

  lastAlertInfo(): { signature: string; sentAt: number; channel: string } | null {
    return this.lastAlert;
  }

  /** 契约 T3：MEM 轮转 OUTBOX 经此判定（不开 SELECT 例外，保持"他模块走 snapshot 类 API"）。 */
  outboxUnresolvedSignatures(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT signature FROM alert_dispatch
         WHERE kind='help' AND resolved_at IS NULL AND delivered_via != 'lost'`,
      )
      .all() as Array<{ signature: string }>;
    return rows.map((r) => r.signature);
  }

  private getOpenAlert(sig: string): AlertRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM alert_dispatch WHERE signature = ? AND resolved_at IS NULL
         ORDER BY id DESC LIMIT 1`,
      )
      .get(sig) as AlertRow | undefined;
  }

  private countOpenHelp(): number {
    return this.openAlerts();
  }

  /** AllEndpointsDownError 的 helpAlreadyOpen 判据（§4.2 buildExhaustedError）。 */
  helpOpen(): boolean {
    return this.countOpenHelp() > 0;
  }

  // ── maybeSendHelp（§4.5 逐字）────────────────────────────────────

  /**
   * 求救判定。
   *
   * 顺序（逐字对应 §4.5 伪码）：
   *   1. 同签名已开放且未 lost：24h 内 → 静默（去重）；超 24h → escalateReminder（带 #N）。
   *   2. **先落账**（INSERT pending，channels_tried='[]'）。
   *   3. 按 channel_order 逐个投递，单通道 10s 超时即换下一通道。
   *   4. 全不可用 → appendOutbox（永不失败）+ 回写 delivered_via='outbox'。
   */
  async maybeSendHelp(input: {
    mode: RouterMode;
    failing: FailingEndpoint[];
    tier: number;
    servedBy: string | null;
    taskImpactOverride?: TaskImpact;
  }): Promise<{ sent: boolean; channel: string | null; escalated: boolean }> {
    const sig = makeSignature(input.mode, input.failing, input.tier);
    const open = this.getOpenAlert(sig);
    if (open !== undefined && open.delivered_via !== 'lost') {
      const age = this.now() - open.sent_at;
      if (age < this.cfg.dedup_window_ms) {
        return { sent: false, channel: null, escalated: false }; // 去重：静默
      }
      // 同签名仍开放且超 24h → 再发一条（带 #N 标记）
      const n = this.reminderCount(sig);
      await this.deliver({ ...input, signature: sig, tag: `#${n + 1}` });
      return { sent: true, channel: this.lastAlert?.channel ?? null, escalated: true };
    }
    await this.deliver({ ...input, signature: sig });
    return { sent: true, channel: this.lastAlert?.channel ?? null, escalated: false };
  }

  private reminderCount(sig: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM alert_dispatch WHERE signature = ? AND kind='help'`)
      .get(sig) as { n: number };
    return row.n;
  }

  /** 实际投递路径（账本先行：先 INSERT pending 再投递再回写）。 */
  private async deliver(input: {
    mode: RouterMode;
    failing: FailingEndpoint[];
    tier: number;
    servedBy: string | null;
    signature: string;
    taskImpactOverride?: TaskImpact;
    tag?: string;
  }): Promise<void> {
    const impact = input.taskImpactOverride ?? this.taskImpact?.() ?? null;
    const text = this.renderHelp({
      signature: input.signature,
      mode: input.mode,
      failing: input.failing,
      servedBy: input.servedBy,
      impact,
      tag: input.tag,
    });
    // ① 先落账（同事务 INSERT pending）
    const now = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO alert_dispatch
           (signature, kind, mode, failing_json, served_by, task_impact, channels_tried,
            delivered_via, sent_at)
         VALUES (?, 'help', ?, ?, ?, ?, '[]', 'pending', ?)`,
      )
      .run(
        input.signature,
        input.mode,
        JSON.stringify(input.failing),
        input.servedBy,
        impact === null ? null : JSON.stringify(impact),
        now,
      );
    const rowId = Number(info.lastInsertRowid);

    // ② 按 channel_order 投递（单通道 10s 超时即换下一通道）
    const attempts: ChannelAttempt[] = [];
    let delivered: DeliveryChannel | null = null;
    for (const ch of this.cfg.channel_order) {
      if (ch === 'outbox') continue; // outbox 是最后一级，循环外处理
      if (!this.channelAvailable(ch)) {
        attempts.push({ channel: ch, result: 'unconfigured' });
        continue;
      }
      const r = await this.withTimeout(
        this.channels!.deliver(ch, text),
        this.cfg.channel_timeout_ms,
      );
      attempts.push({ channel: ch, result: r.ok ? 'delivered' : (r.error ?? 'failed') });
      if (r.ok) {
        delivered = ch;
        break;
      }
    }

    // ③ 最后一级：OUTBOX.md（路由自己实现文件追加，永不失败）
    let outboxErr: string | null = null;
    if (delivered === null) {
      const appended = this.outbox.appendHelp(text, input.signature);
      outboxErr = appended.ok ? null : (appended.error ?? 'append failed');
      if (appended.ok) delivered = 'outbox';
    }

    // ④ 回写账本
    this.db
      .prepare(
        `UPDATE alert_dispatch SET channels_tried = ?, delivered_via = ?, delivered_at = ? WHERE id = ?`,
      )
      .run(
        JSON.stringify(attempts),
        delivered === null ? 'lost' : delivered,
        delivered === null ? null : this.now(),
        rowId,
      );
    if (delivered === null) {
      // 连 OUTBOX 都写不进去（磁盘满/EACCES）：标记 lost，等人看 CLI
      attempts.push({ channel: 'outbox', result: outboxErr ?? 'failed' });
    }
    if (delivered !== null) {
      this.lastAlert = { signature: input.signature, sentAt: now, channel: delivered };
    }
  }

  private channelAvailable(ch: Exclude<DeliveryChannel, 'outbox'>): boolean {
    if (this.channels === null) return false; // 阶段一：通知通道模块未接线
    // telegram/feishu 的可用性由 SF 自己判（5min 内成功发过/拿过 token）；
    // email 恒 false（§5.7/§10 分期表），SF 侧已按此实现。
    return this.channels.available(ch);
  }

  private async withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error('channel timeout')), ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  // ── 恢复通报与多行收敛（§4.5 末）─────────────────────────────────

  /**
   * mode 变好时收敛：把 `kind='help' AND resolved_at IS NULL AND signature != 当前签名` 的行
   * 逐条核对 failing_json 中端点是否全部非 open：
   * - 全部恢复 → 合并为一条恢复通报（列全部关联签名）+ 逐行回写 resolved_at；
   * - 仍有 open → 保持 open（催救仍有效，24h 后可 escalate）。
   *
   * @param isOpenNow 判定端点×角色当前是否 open（由 ModelRouter 用 breaker 视图提供）
   */
  async sendRecovery(input: {
    mode: RouterMode;
    currentSignature: string;
    isOpenNow: (f: FailingEndpoint) => boolean;
    servedBy: string | null;
    impact?: TaskImpact;
    /** 历时（毫秒），用于模板"历时 3h12m"。 */
    sinceMs?: number | null;
  }): Promise<{ resolved: string[]; keptOpen: string[] }> {
    const rows = this.db
      .prepare(
        `SELECT * FROM alert_dispatch WHERE kind='help' AND resolved_at IS NULL AND signature != ?
         ORDER BY id`,
      )
      .all(input.currentSignature) as unknown as AlertRow[];
    const recovered: string[] = [];
    const kept: string[] = [];
    const resolvedRows: AlertRow[] = [];
    for (const row of rows) {
      const failing = this.parseFailing(row.failing_json);
      if (failing.every((f) => !input.isOpenNow(f))) {
        resolvedRows.push(row);
        recovered.push(row.signature);
      } else {
        kept.push(row.signature);
      }
    }
    if (resolvedRows.length === 0) return { resolved: recovered, keptOpen: kept };

    const text = this.renderRecovery({
      signatures: recovered,
      mode: input.mode,
      recovered,
      sinceMs: input.sinceMs ?? null,
      impact: input.impact ?? this.taskImpact?.() ?? null,
    });
    // 账本先行（help 同协议）：先 INSERT pending 再投递
    const now = this.now();
    const info = this.db
      .prepare(
        `INSERT INTO alert_dispatch
           (signature, kind, mode, failing_json, served_by, task_impact, channels_tried,
            delivered_via, sent_at)
         VALUES (?, 'recovery', ?, '[]', ?, ?, '[]', 'pending', ?)`,
      )
      .run(
        recovered.join(','),
        input.mode,
        input.servedBy,
        input.impact === undefined ? null : JSON.stringify(input.impact),
        now,
      );
    const rowId = Number(info.lastInsertRowid);
    let channel: DeliveryChannel = 'outbox';
    const attempts: ChannelAttempt[] = [];
    for (const ch of this.cfg.channel_order) {
      if (ch === 'outbox') continue;
      if (!this.channelAvailable(ch)) {
        attempts.push({ channel: ch, result: 'unconfigured' });
        continue;
      }
      const r = await this.withTimeout(this.channels!.deliver(ch, text), this.cfg.channel_timeout_ms);
      attempts.push({ channel: ch, result: r.ok ? 'delivered' : (r.error ?? 'failed') });
      if (r.ok) {
        channel = ch;
        break;
      }
    }
    if (channel === 'outbox') {
      this.outbox.appendRecovery(text, recovered.join(','));
      attempts.push({ channel: 'outbox', result: 'delivered' });
    }
    this.db
      .prepare(
        `UPDATE alert_dispatch SET channels_tried=?, delivered_via=?, delivered_at=? WHERE id=?`,
      )
      .run(JSON.stringify(attempts), channel, this.now(), rowId);
    // 逐行回写 resolved_at（多命中全部收敛）
    for (const row of resolvedRows) {
      this.db
        .prepare(`UPDATE alert_dispatch SET resolved_at = ? WHERE id = ?`)
        .run(this.now(), row.id);
    }
    this.lastAlert = { signature: recovered.join(','), sentAt: now, channel };
    return { resolved: recovered, keptOpen: kept };
  }

  // ── 崩溃对账（§4.7 启动对账第 1 步）──────────────────────────────

  /**
   * `pending` 超 2min 的行补投一次；再失败标 lost（不再自动重试）。
   * 补投内容取库中 failing_json/mode 重建（账本已含全部渲染所需字段）。
   */
  async reconcilePending(): Promise<{ retried: number; lost: number }> {
    const cutoff = this.now() - PENDING_REDELIVER_MS;
    const rows = this.db
      .prepare(`SELECT * FROM alert_dispatch WHERE delivered_via='pending' AND sent_at < ?`)
      .all(cutoff) as unknown as AlertRow[];
    let retried = 0;
    let lost = 0;
    for (const row of rows) {
      const failing = this.parseFailing(row.failing_json);
      const text = this.renderHelp({
        signature: row.signature,
        mode: row.mode as RouterMode,
        failing,
        servedBy: row.served_by,
        impact: row.task_impact === null ? null : (JSON.parse(row.task_impact) as TaskImpact),
        tag: '#2', // 崩溃补投可能重复，带签名标注重发（§4.5 取舍）
      });
      const ok = this.outbox.appendHelp(text, row.signature).ok;
      if (ok) {
        this.db
          .prepare(
            `UPDATE alert_dispatch SET delivered_via='outbox', delivered_at=?, channels_tried=? WHERE id=?`,
          )
          .run(this.now(), JSON.stringify([{ channel: 'outbox', result: 'redelivered' }]), row.id);
        retried += 1;
      } else {
        this.db
          .prepare(
            `UPDATE alert_dispatch SET delivered_via='lost', channels_tried=? WHERE id=?`,
          )
          .run(JSON.stringify([{ channel: 'outbox', result: 'failed' }]), row.id);
        lost += 1;
      }
    }
    return { retried, lost };
  }

  /** CLI `dotd models resend-help`：人工重投 lost 行。 */
  async resendLost(): Promise<number> {
    const rows = this.db
      .prepare(`SELECT * FROM alert_dispatch WHERE delivered_via='lost'`)
      .all() as unknown as AlertRow[];
    let n = 0;
    for (const row of rows) {
      const text = this.renderHelp({
        signature: row.signature,
        mode: row.mode as RouterMode,
        failing: this.parseFailing(row.failing_json),
        servedBy: row.served_by,
        impact: row.task_impact === null ? null : (JSON.parse(row.task_impact) as TaskImpact),
        tag: `#${this.reminderCount(row.signature) + 1}`,
      });
      if (this.outbox.appendHelp(text, row.signature).ok) {
        this.db
          .prepare(
            `UPDATE alert_dispatch SET delivered_via='outbox', delivered_at=?, resolved_at=NULL WHERE id=?`,
          )
          .run(this.now(), row.id);
        n += 1;
      }
    }
    return n;
  }

  // ── 模板（§4.5 逐字）─────────────────────────────────────────────

  private taskImpactText(impact: TaskImpact | null): string {
    if (impact === null) return 'primary 任务挂起 未知（队列未上报）/ 运行中 未知';
    return `primary 任务挂起 ${impact.queued_primary} 个 / 运行中 ${impact.running} 个`;
  }

  renderHelp(input: {
    signature: string;
    mode: RouterMode;
    failing: FailingEndpoint[];
    servedBy: string | null;
    impact: TaskImpact | null;
    tag?: string;
  }): string {
    const at = new Date(this.now()).toISOString().replace('T', ' ').slice(0, 19);
    const failText =
      input.failing.length === 0
        ? '（无具体失败端点）'
        : input.failing
            .map((f) => `${f.endpoint_id}/${f.track} ${f.kind}×${f.consec}`)
            .join(', ');
    const served = input.servedBy === null ? '无' : input.servedBy;
    const tag = input.tag ?? '';
    return [
      `🛟 dotd 求救 [${input.signature}${tag}]`,
      `模式: ${input.mode}｜时间: ${at}`,
      `故障: ${failText}`,
      `当前承载: ${served}；${this.taskImpactText(input.impact)}`,
      `应急收缩: ${input.mode === 'NORMAL' || input.mode === 'LOCAL_FALLBACK' ? '未生效' : '已生效（浏览器登录态操作全部转审批）'}`,
      `本签名 24h 内不再重复打扰；恢复时另行通知。`,
    ].join('\n');
  }

  renderRecovery(input: {
    signatures: string[];
    mode: RouterMode;
    recovered: string[];
    sinceMs: number | null;
    impact: TaskImpact | null;
  }): string {
    const dur =
      input.sinceMs === null
        ? '未知'
        : `${Math.floor(input.sinceMs / 3_600_000)}h${Math.floor((input.sinceMs % 3_600_000) / 60_000)}m`;
    return [
      `✅ dotd 恢复 [关联 ${input.signatures.join(', ')}]`,
      `模式: → ${input.mode}｜历时 ${dur}`,
      `恢复: ${input.recovered.join(', ')}`,
      `影响: ${input.impact === null ? '未知（队列未上报）' : `挂起的 ${input.impact.queued_primary} 个 primary 任务已自动续跑`}`,
    ].join('\n');
  }

  private parseFailing(json: string): FailingEndpoint[] {
    try {
      const v = JSON.parse(json) as unknown;
      return Array.isArray(v) ? (v as FailingEndpoint[]) : [];
    } catch {
      return [];
    }
  }
}
