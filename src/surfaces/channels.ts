/**
 * src/surfaces/channels.ts —— 出站通知通道适配器（`NotificationChannels`，供 MR 注入）。
 *
 * 依据（surfaces.md §5.7 + 契约 T4 + T3）：
 * - 属主划分：求救的签名、去重、`alert_dispatch` 账本、OUTBOX 兜底追加**全在 MR**；
 *   本模块**永不写 OUTBOX**、不做 24h 去重（避免双账本）。
 * - 通道优先级/超时/重试语义归 MR（MR:724）：10s 超时由 MR 计时，本模块 `deliver`
 *   内部对 Telegram 发送做 **3 次快重试（2s 间隔）** 后如实返回 `{ok:false}`。
 * - `available(channel)`（MR §4.5 可用性判定）：
 *   - telegram = bot token 已配 **且**最近 5min getMe 成功；
 *   - email = **恒 false**（§5.7/§10 分期表：email 求救适配器 ❌，与 MR:616
 *     "阶段一求救实际全走 OUTBOX"一致；即使配了 SMTP_URL 也不放宽——
 *     否则 MR 会把求救路由进 deliver 必然失败的通道，绕开 OUTBOX 兜底）。
 * - 阶段一分期（§2.2/§10）：**Telegram 全量在阶段二**。本文件把 TG 客户端收成一个
 *   `TelegramGateway` 接线位（接口定型、实现留空），其余通道（cli/file/http 出站）
 *   阶段一即可用——`dotd sos-test`（§5.5 指令表）与本地文件留痕都靠它们。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DeliverResult, FeishuConfig, OutboundChannelName } from './types.ts';
import type { NotificationChannels } from '../shared/contracts.ts';

// ── Telegram 接线位（阶段二实现）──────────────────────────────────────

/**
 * TG Bot API 的最小接线面（§5.5 出站长轮询 `getUpdates timeout=25`、退避 1→60s、
 * `edit_throttle_ms` 节流、卡片 edit 都在这里落地）。
 * 阶段一只定型不实现：`available('telegram')` 在未装配 gateway 时恒 false。
 */
export interface TelegramGateway {
  /** MR §4.5 可用性判定的一部分：bot token 已配且最近 5min getMe 成功。 */
  lastGetMeOkAt(): number | null;
  /** §5.7：deliver 内部对 TG 发送 3 次快重试（2s 间隔）后如实返回。 */
  sendMessage(chatId: number, text: string): Promise<{ ok: boolean; error?: string }>;
  /** §5.5 指令通道：TG 聊天消息入站（阶段二）。 */
  startPolling(): Promise<void>;
  stopPolling(): void;
  /**
   * §5.5：解析当前该往哪个 chat 发（主人自己的 chat，或 allowlist 首项）。
   * 可选：真实 gateway 装配后提供；NULL 占位不提供 → 装配层须另给 defaultChatId，
   * 两者都缺 → deliverTelegram 如实报错（绝不静默投 chat_id=0）。
   */
  resolveChatId?(): number | undefined;
}

/** 未装配 TG 时的占位（阶段一默认）：available 恒 false，deliver 如实报未装配。 */
export const NULL_TELEGRAM_GATEWAY: TelegramGateway = {
  lastGetMeOkAt: () => null,
  async sendMessage(): Promise<DeliverResult> {
    return { ok: false, error: 'telegram 通道未装配（阶段二实现，surfaces.md §5.5）' };
  },
  async startPolling(): Promise<void> {
    // 阶段一不轮询
  },
  stopPolling(): void {
    // 无状态
  },
};

// ── 文件通道（阶段一可用的本地留痕）───────────────────────────────────

/** 文件通道：把通知追加到一个本地文件（MR 的 OUTBOX 归 MR 写，本通道是 SF 自己的留痕）。 */
export class FileChannel {
  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  deliver(text: string): DeliverResult {
    try {
      appendFileSync(this.filePath, `[${new Date().toISOString()}] ${text}\n`, 'utf8');
      return { ok: true };
    } catch (cause) {
      return { ok: false, error: String(cause) };
    }
  }
}

// ── HTTP 出站通道（阶段一：供 CLI/dev 自检 / 未来 email 桥接） ────────

/**
 * HTTP 出站通道：把通知 POST 到一个本地 HTTP 端点（§5.7 的通用出站底座；
 * 阶段二 email 的 SMTP 适配器也以此为对照形态实现）。
 */
export class HttpChannel {
  constructor(private readonly endpoint: string) {}

  async deliver(text: string, opts: { timeoutMs?: number } = {}): Promise<DeliverResult> {
    const timeoutMs = opts.timeoutMs ?? 10_000; // MR 计 10s 超时（§5.7），这里只做软超时
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: text,
        signal: ac.signal,
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return { ok: true };
    } catch (cause) {
      return { ok: false, error: String(cause) };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── CLI 通道（`dotd sos-test` 与本地终端提示） ────────────────────────

/**
 * CLI 出站通道：把通知写到 stderr（CLI 进程的可见面）。
 * daemon 内不用它（daemon 无终端）；它服务 `dotd sos-test`（§5.5 指令表）与
 * 交互式 CLI 的同步提示。
 */
export class CliChannel {
  deliver(text: string): DeliverResult {
    process.stderr.write(`[dotd] ${text}\n`);
    return { ok: true };
  }
}

// ── NotificationChannels 适配器（MR 注入面） ─────────────────────────

export interface NotificationChannelsDeps {
  /** TG 网关（阶段一传 NULL_TELEGRAM_GATEWAY）。 */
  telegram: TelegramGateway;
  /** 飞书网关（未配 App ID/Secret 时缺省即 NULL_FEISHU_GATEWAY）。 */
  feishu?: FeishuGateway;
  /** 本地留痕文件路径（阶段一默认 `~/.dotd/notifications.log`）。 */
  filePath: string;
  /**
   * §5.5：TG 出站目标 chat（主人自己的 chat，或 allowlist 首项）。
   * 阶段二由真实 gateway 的 `resolveChatId()` 覆盖；两者都缺 → deliver 如实报错。
   */
  defaultChatId?: number;
  /** 飞书出站目标 chat_id（oc_ / open_id）。缺省 → deliver('feishu') 如实报未配置。 */
  feishuChatId?: string;
  now?(): number;
}

/** MR §4.5：telegram 可用性 = bot token 已配且最近 5min getMe 成功。 */
const GET_ME_FRESH_MS = 5 * 60 * 1000;

/** §5.7：TG 发送 3 次快重试、2s 间隔。 */
const TG_FAST_RETRIES = 3;
const TG_RETRY_DELAY_MS = 2_000;

/**
 * 实现 contracts.ts:NotificationChannels（SF §5.7 原文接口），由 daemon 装配层注入
 * `ModelRouter.load({channels})`（MR:678）。
 */
export class SurfacesNotificationChannels implements NotificationChannels {
  private readonly file: FileChannel;
  private readonly now: () => number;

  constructor(private readonly deps: NotificationChannelsDeps) {
    this.file = new FileChannel(deps.filePath);
    this.now = deps.now ?? (() => Date.now());
  }

  available(channel: 'telegram' | 'feishu' | 'email'): boolean {
    if (channel === 'telegram') {
      const at = this.deps.telegram.lastGetMeOkAt();
      return at !== null && this.now() - at <= GET_ME_FRESH_MS;
    }
    if (channel === 'feishu') {
      // App ID/Secret 都配了，且 5min 内成功发过（或成功拿过 token）
      const gw = this.deps.feishu ?? NULL_FEISHU_GATEWAY;
      const at = gw.lastOkAt();
      return at !== null && this.now() - at <= GET_ME_FRESH_MS;
    }
    // §5.7/§10 分期表：email 求救适配器 ❌（available=false）。
    // 阶段一**恒 false**（即使配了 SMTP_URL）——deliver('email') 如实返回未实现，
    // 若这里返回 true，MR 会把求救路由进必然失败的通道、绕开 OUTBOX 兜底。
    // SMTP_URL 只作为阶段二适配器的参数预留，不参与可用性判定。
    return false;
  }

  async deliver(channel: 'telegram' | 'feishu' | 'email', text: string): Promise<DeliverResult> {
    // 每个通道都留一份本地文件痕迹（SF 自己的审计，不写 MR 的 OUTBOX）
    this.file.deliver(`[${channel}] ${text}`);

    if (channel === 'telegram') {
      // §5.7：3 次快重试（2s 间隔）后如实返回 {ok:false}
      let last: DeliverResult = { ok: false, error: '未尝试' };
      for (let i = 0; i < TG_FAST_RETRIES; i++) {
        last = await this.deliverTelegram(text);
        if (last.ok) return last;
        if (i < TG_FAST_RETRIES - 1) await sleep(TG_RETRY_DELAY_MS);
      }
      return last;
    }

    if (channel === 'feishu') {
      // §5.7 同款：3 次快重试（2s 间隔）
      let last: DeliverResult = { ok: false, error: '未尝试' };
      for (let i = 0; i < TG_FAST_RETRIES; i++) {
        last = await this.deliverFeishu(text);
        if (last.ok) return last;
        if (i < TG_FAST_RETRIES - 1) await sleep(TG_RETRY_DELAY_MS);
      }
      return last;
    }

    // email：阶段一未实现 SMTP 适配器（§5.7/§10：阶段二认领实现）
    return { ok: false, error: 'email 通道阶段一未实现（available=false，求救全走 MR OUTBOX）' };
  }

  private async deliverFeishu(text: string): Promise<DeliverResult> {
    const gw = this.deps.feishu ?? NULL_FEISHU_GATEWAY;
    // 与 TG 同款铁律：拿不到目标 chat 就如实报错，绝不静默投假地址。
    const chatId = this.deps.feishuChatId;
    if (chatId === undefined || chatId.length === 0) {
      return { ok: false, error: '飞书 chat id 未配置（config.yml surfaces.feishu.owner_chat_id）' };
    }
    return gw.sendText(chatId, text);
  }

  private async deliverTelegram(text: string): Promise<DeliverResult> {
    // §5.5：卡片/提醒必须发给**具体 chat**。chatId 由装配层注入（allowlist 首项 /
    // 主人自己的 chat），拿不到就如实报错——绝不能静默投给 chat_id=0（假成功）。
    const chatId = this.deps.telegram.resolveChatId?.() ?? this.deps.defaultChatId;
    if (chatId === undefined) {
      return { ok: false, error: 'TG chat id 未配置（装配层需注入 defaultChatId 或 resolveChatId）' };
    }
    return this.deps.telegram.sendMessage(chatId, text);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 飞书通道（2026-10-16 主人指定：飞书机器人取代 Telegram） ──────────

/** 飞书自建应用网关（App ID + App Secret → tenant_access_token → im/v1/messages）。 */
export class FeishuGateway {
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private lastOkAtMs: number | null = null;

  constructor(private readonly deps: FeishuConfig) {}

  /** MR §4.5 同款判定：5min 内成功发过 → 可用。 */
  lastOkAt(): number | null {
    return this.lastOkAtMs;
  }

  /** 自建应用鉴权：tenant_access_token（有效期 2h，提前 5min 刷新）。 */
  private async accessToken(): Promise<string> {
    if (this.token !== null && Date.now() < this.tokenExpiresAt - 5 * 60 * 1000) return this.token;
    const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.deps.appId, app_secret: this.deps.appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (json.code !== 0 || json.tenant_access_token === undefined) {
      throw new Error(`tenant_access_token 失败：code=${json.code} msg=${json.msg ?? '?'}`);
    }
    this.token = json.tenant_access_token;
    this.tokenExpiresAt = Date.now() + (json.expire ?? 7200) * 1000;
    // 可用性判据（MR §4.5 同款）也要在拿到 token 时置位：token 能换到就说明 App
    // ID/Secret 有效、到飞书的路通。只在 sendText 成功时置位会留一个冷启动窟窿——
    // daemon 刚起来还没发过任何消息，available('feishu') 恒 false，而第一封求救往往
    // 正是重启后两轨齐挂那一刻，于是白白绕过飞书落进 OUTBOX.md。
    this.lastOkAtMs = Date.now();
    return this.token;
  }

  /**
   * 启动期预热：拉一次 token 把 available('feishu') 置真。不抛——失败只意味着可用性
   * 仍是 false，求救照旧走 OUTBOX 兜底，不因预热失败影响启动。入站长连接走另一套
   * SDK，不经过这里，所以预热是它唯一的置位机会。
   */
  async warm(): Promise<boolean> {
    try {
      await this.accessToken();
      return true;
    } catch {
      return false;
    }
  }

  /** 发送文本消息（§5.7 同款 3 次快重试由调用方编排，这里只发一次）。 */
  async sendText(chatId: string, text: string): Promise<DeliverResult> {
    try {
      const token = await this.accessToken();
      const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
        method: 'POST',
        headers: {
          'content-type': 'application/json; charset=utf-8',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const json = (await res.json()) as { code?: number; msg?: string };
      if (json.code !== 0) return { ok: false, error: `飞书 code=${json.code} msg=${json.msg ?? '?'}` };
      this.lastOkAtMs = Date.now();
      return { ok: true };
    } catch (cause) {
      return { ok: false, error: String(cause) };
    }
  }

  /**
   * §5.5 指令通道：飞书事件订阅是**推送**（webhook POST 到我们的 URL），不像 TG 长轮询。
   * 所以入站由 http.ts 的 `/api/hooks/feishu` 端点接收，本类只负责出站。
   */
}

/** 未装配飞书时的占位：available 恒 false。 */
export const NULL_FEISHU_GATEWAY: FeishuGateway = new FeishuGateway({
  appId: '',
  appSecret: '',
  editThrottleMs: 1200,
});

/** 通道名集合（CLI `sos-test` 的自检清单用）。 */
export const OUTBOUND_CHANNELS: readonly OutboundChannelName[] = ['cli', 'file', 'http', 'telegram', 'feishu', 'email'];
