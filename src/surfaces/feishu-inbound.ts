/**
 * src/surfaces/feishu-inbound.ts —— 飞书事件订阅入站（开放平台"事件与订阅"回调）。
 *
 * 属主切分（与 §5.2 /hooks/:source 的通用 HMAC 路径不同源、不同信任模型）：
 * - 飞书**不用**我们的 X-Dotd-* HMAC 签名；它用请求体里的 `token` 字段做校验
 *   （Verification Token），可选再叠 Encrypt Key（AES-256-CBC，体为 {encrypt}）。
 *   因此本模块在 /hooks/feishu 上短路通用 HMAC 分支——这不是放松鉴权：
 *   verification token 与出站 app_secret 同属 ~/.dotd/tokens.env，密钥同源。
 * - url_verification 握手：token 匹配 → 回 {challenge}（200），不落事件。
 * - 事件去重：`header.event_id` → `fs:<event_id>`（types.feishuDedupKey），
 *   交 CP ingestEvent 的 dedup_key UNIQUE 兜重投（§4 表 webhook 行同构）。
 * - 消息事件 `im.message.receive_v1`：text 且会话 == owner_chat_id →
 *   按 POST /api/messages 契约走 openThread('feishu')+appendMessage+cp.submit
 *   priority=1（主人聊天 = interactive，与 web 面同权）；
 *   chat_id 不匹配 → 拒（allowlist：非主人不驱动任务，契约 S 面同 Telegram
 *   allowlist 语义）。owner_chat_id 未配置时**全部拒**（fail-closed，宁可不跑）。
 * - 其余事件类型（已读/撤回/成员变更…）：只落事件流不建任务（202 ack，
 *   否则飞书按失败重投风暴）。
 *
 * 安全边界：本模块**不发起任何出站请求**；入站数据只进本地 CP/MEM。
 */

import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { ControlPlane, MemoryPort, RawInbound } from '../shared/contracts.ts';
import { DEFAULT_DOT_ID } from '../shared/ids.ts';
import { feishuDedupKey } from './types.ts';
import type { FeishuConfig } from './types.ts';

// ── 纯函数：解析 + 判别（可单测，不碰 IO）────────────────────────────

/** 飞书事件体（v2.0 schema）的宽松形状。 */
export interface FeishuEventV2 {
  schema?: string;
  header?: {
    event_id?: string;
    event_type?: string;
    create_time?: string;
    token?: string;
    app_id?: string;
    tenant_key?: string;
  };
  event?: Record<string, unknown>;
}

export type FeishuInboundDecision =
  /** url_verification 握手：回 200 {challenge}。 */
  | { kind: 'challenge'; challenge: string }
  /** 消息事件且主人会话：开任务（priority 1）。 */
  | {
      kind: 'message';
      dedupKey: string;
      eventId: string;
      chatId: string;
      text: string;
      raw: RawInbound;
    }
  /** 其余合法事件：落事件流 ack（202），不建任务。 */
  | { kind: 'event'; dedupKey: string; eventId: string; raw: RawInbound }
  /** 聊天域事件但不建任务（机器人自身消息回环/非文本/空文本）：直接 ack，
   *  **不进** CP 事件管线——§6 匹配器会照 payload 建 tk_ev_* 重复任务
   *  （WSL 冒烟实测）。 */
  | { kind: 'ignore'; reason: 'bot_echo' | 'non_text'; detail: string; eventId: string }
  /** 拒绝：reason 进 surf_ingress_rejects。 */
  | { kind: 'reject'; reason: 'auth' | 'allowlist' | 'parse'; detail: string };

/**
 * 鉴权 + 路由判别。verificationToken 为空（配置缺失）时**任何请求都拒**
 * （fail-closed：无 token 可比对 = 无法验证来源）。
 *
 * trustedTransport=true 时长连接（WSClient）路径：事件经 app_id/app_secret
 * 建立的出站 WebSocket 送达，来源由凭据证明（body 里根本没有可比对的 token
 * 字段），故跳过 verification token 校验——不是放松鉴权，是换了更强的传输层
 * 鉴权（HTTP webhook 路径不传此旗标，fail-closed 语义原样保留）。
 * ownerChatId 支持逗号分隔多会话（主人可有一个或多个群/单聊）。
 */
export function classifyFeishuInbound(
  body: unknown,
  cfg: { verificationToken?: string; ownerChatId?: string; dotId?: string; trustedTransport?: boolean },
): FeishuInboundDecision {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'reject', reason: 'parse', detail: '飞书回调 body 不是 JSON object' };
  }
  const obj = body as Record<string, unknown>;

  // verification token：url_verification 在顶层，事件订阅在 header.token
  const token =
    typeof obj['token'] === 'string'
      ? (obj['token'] as string)
      : typeof (obj as FeishuEventV2).header?.token === 'string'
        ? ((obj as FeishuEventV2).header as { token: string }).token
        : '';
  const expected = cfg.verificationToken ?? '';
  if (!cfg.trustedTransport && (expected.length === 0 || !safeEqual(token, expected))) {
    return { kind: 'reject', reason: 'auth', detail: 'verification token 缺失或不匹配' };
  }

  // ① url_verification 握手
  if (obj['type'] === 'url_verification') {
    const challenge = typeof obj['challenge'] === 'string' ? (obj['challenge'] as string) : '';
    if (challenge.length === 0) {
      return { kind: 'reject', reason: 'parse', detail: 'url_verification 无 challenge 字段' };
    }
    return { kind: 'challenge', challenge };
  }

  // ② 事件订阅 v2.0
  const ev = obj as FeishuEventV2;
  const eventId = ev.header?.event_id ?? '';
  const eventType = ev.header?.event_type ?? '';
  if (eventId.length === 0) {
    return { kind: 'reject', reason: 'parse', detail: 'header.event_id 缺失（无法去重）' };
  }
  const dedupKey = feishuDedupKey(eventId);
  const dotId = cfg.dotId ?? DEFAULT_DOT_ID;
  const actor = `feishu:${eventType || 'event'}`;

  if (eventType === 'im.message.receive_v1') {
    const msg = (ev.event ?? {}) as Record<string, unknown>;
    const message = (msg['message'] ?? {}) as Record<string, unknown>;
    const chatId = typeof message['chat_id'] === 'string' ? (message['chat_id'] as string) : '';
    // 机器人自己的消息（出站回复会回流）：直接忽略，防回环，不进任何管线。
    const sender = (msg['sender'] ?? {}) as Record<string, unknown>;
    const senderType = typeof sender['sender_type'] === 'string' ? (sender['sender_type'] as string) : '';
    // 只处理文本消息；富文本/卡片取 text 字段失败则按非文本忽略
    let text = '';
    try {
      const parsed = JSON.parse(String(message['content'] ?? '{}')) as Record<string, unknown>;
      if (typeof parsed['text'] === 'string') text = (parsed['text'] as string).trim();
    } catch {
      text = '';
    }
    const msgType = typeof message['message_type'] === 'string' ? (message['message_type'] as string) : '';
    if (senderType === 'app' || senderType === 'bot') {
      return { kind: 'ignore', reason: 'bot_echo', detail: '机器人自身消息（防回环）', eventId };
    }
    // 主人会话闸门：owner_chat_id 未配置 → 全部拒（fail-closed）；
    // 配置值允许逗号分隔多会话（'oc_a,oc_b'）。
    if (cfg.ownerChatId === undefined || cfg.ownerChatId.length === 0) {
      return { kind: 'reject', reason: 'allowlist', detail: `surfaces.feishu.owner_chat_id 未配置，拒一切入站消息（来源会话 ${chatId}）` };
    }
    const ownerSet = new Set(cfg.ownerChatId.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
    if (!ownerSet.has(chatId)) {
      return { kind: 'reject', reason: 'allowlist', detail: `chat_id ${chatId} 非主人会话` };
    }
    if (text.length === 0 || (msgType.length > 0 && msgType !== 'text')) {
      // 空文本/非文本消息：ack 不建任务、不进事件管线（防 §6 匹配器误建任务）
      return { kind: 'ignore', reason: 'non_text', detail: msgType.length > 0 ? `消息类型 ${msgType} 非文本` : '文本为空', eventId };
    }
    const raw: RawInbound = {
      source: 'http',
      dotId,
      text,
      payload: obj,
      dedupKey,
      actor: `feishu:${chatId}`,
    };
    return { kind: 'message', dedupKey, eventId, chatId, text, raw };
  }

  // ③ 其余事件类型：ack + 落事件流，不建任务
  return {
    kind: 'event',
    dedupKey,
    eventId,
    raw: { source: 'http', dotId, payload: obj, dedupKey, actor },
  };
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

// ── Encrypt Key 解密（可选；URL 配了 Encrypt Key 时体为 {encrypt: base64}）──

/**
 * 飞书 AES 方案（官方文档）：key = sha256(encryptKey)；IV = key 前 16 字节；
 * AES-256-CBC + PKCS7（Node 默认填充即飞书所用）。
 * 输入 base64 密文，输出解密后的 JSON 文本。
 */
export function decryptFeishuEncrypt(encryptB64: string, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey).digest();
  const iv = key.subarray(0, 16);
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(Buffer.from(encryptB64, 'base64')), decipher.final()]).toString('utf8');
}

// ── 接线：/hooks/feishu 的处理器依赖 ──────────────────────────────────

export interface FeishuInboundDeps {
  cp: ControlPlane;
  mem: MemoryPort;
  db: DatabaseSync;
  bus: { publish(topic: string, payload: Record<string, unknown>, opts?: { dotId?: string }): void };
  cfg: FeishuConfig;
  dotId?: string;
  /** 长连接（WSClient）路径置 true：来源由 app 凭据证明，跳过 token 校验。 */
  trustedTransport?: boolean;
}

/**
 * SF 私有幂等表（surf_inbound_seen，迁移 070）的占位声明：true = 本次新 claim，
 * false = 重投。聊天消息的任务属主在 SF（契约 S-1），**不走** cp.ingestEvent——
 * 事件管线（CP §6 规则/LLM 匹配）会对聊天 payload 再匹配建第二个任务
 * （WSL 实测 ev-smoke-7 → tk_ev_2 重复）。claim-before-act = at-most-once：
 * 宁可丢一次重投，也不重复执行有副作用的任务。
 */
export function claimFeishuMessage(db: DatabaseSync, dedupKey: string, actor: string, nowMs: number): boolean {
  const info = db
    .prepare('INSERT OR IGNORE INTO surf_inbound_seen (dedup_key, source, actor, ts) VALUES (?, ?, ?, ?)')
    .run(dedupKey, 'feishu', actor, nowMs);
  return info.changes === 1;
}

export type FeishuInboundResult =
  | { httpStatus: 200; body: { challenge: string } }
  | { httpStatus: 200; body: { dup: true } }
  | { httpStatus: 200; body: { eventId: number; dup: true } }
  | { httpStatus: 200; body: { ignored: true; eventId: string } }
  | { httpStatus: 202; body: { taskId: string; threadId: string } }
  | { httpStatus: 202; body: { eventId: number; dup: false; ack: true } }
  | { httpStatus: 400 | 401 | 403; body: { error: 'parse' | 'auth' | 'allowlist'; message: string } };

/**
 * 处理一次已解析的飞书回调 body（调用方负责读取 body、判断 {encrypt} 并先解密）。
 * 返回 http.ts 直接可写的响应。消息事件路径与 POST /api/messages 同契约
 * （openThread('feishu') → appendMessage → cp.submit priority 1）。
 */
export async function handleFeishuCallback(
  body: unknown,
  deps: FeishuInboundDeps,
): Promise<FeishuInboundResult> {
  const decision = classifyFeishuInbound(body, {
    verificationToken: deps.cfg.verificationToken,
    ownerChatId: deps.cfg.ownerChatId,
    ...(deps.dotId !== undefined ? { dotId: deps.dotId } : {}),
    ...(deps.trustedTransport !== undefined ? { trustedTransport: deps.trustedTransport } : {}),
  });
  switch (decision.kind) {
    case 'challenge':
      return { httpStatus: 200, body: { challenge: decision.challenge } };
    case 'reject':
      return {
        httpStatus: decision.reason === 'auth' ? 401 : decision.reason === 'allowlist' ? 403 : 400,
        body: { error: decision.reason, message: decision.detail },
      };
    case 'message': {
      // 去重先行（SF 私有表，理由见 claimFeishuMessage）：重投不再建任务。
      if (!claimFeishuMessage(deps.db, decision.dedupKey, decision.raw.actor, Date.now())) {
        return { httpStatus: 200, body: { dup: true } };
      }
      // 与 /api/messages 相同的任务链（契约 S-1），channel 换 'feishu'
      const threadId = await deps.mem.openThread(decision.raw.dotId, 'feishu', {
        externalRef: `feishu:${decision.chatId}`,
      });
      await deps.mem.appendMessage(threadId, { role: 'user', kind: 'text', content: decision.text });
      const task = deps.cp.submit({
        title: decision.text.slice(0, 60),
        goal: decision.text,
        priority: 1,
        dotId: decision.raw.dotId,
        threadId,
      });
      deps.bus.publish('chat.final', {
        kind: 'chat.final',
        threadId,
        taskId: task.id,
        text: decision.text,
        source: 'feishu',
      }, { dotId: decision.raw.dotId });
      return { httpStatus: 202, body: { taskId: task.id, threadId } };
    }
    case 'ignore':
      // ack 但不落任何管线（回环/非文本）；不落 surf_inbound_seen，
      // 因为本来就无副作用可重复。
      return { httpStatus: 200, body: { ignored: true, eventId: decision.eventId } };
    case 'event': {
      // 机器事件（已读/撤回/成员变更…）归 CP 事件管线：202 ack，dup 回旧 id。
      const res = deps.cp.ingestEvent({
        source: 'http',
        dotId: decision.raw.dotId,
        actor: decision.raw.actor,
        payload: decision.raw.payload,
        dedupKey: decision.dedupKey,
      });
      deps.bus.publish('event.received', {
        kind: 'event.received',
        eventId: res.eventId,
        source: 'http',
        dotId: decision.raw.dotId,
        dup: res.dup,
      });
      return res.dup
        ? { httpStatus: 200, body: { eventId: res.eventId, dup: true } }
        : { httpStatus: 202, body: { eventId: res.eventId, dup: false, ack: true } };
    }
  }
}

/** body 若是 {encrypt: base64}，解密并返回内层 JSON；否则原样返回。 */
export function maybeDecryptFeishuBody(parsed: unknown, cfg: FeishuConfig): { ok: true; body: unknown } | { ok: false; detail: string } {
  const obj = parsed as Record<string, unknown> | null;
  if (obj === null || typeof obj !== 'object' || typeof obj['encrypt'] !== 'string') return { ok: true, body: parsed };
  if (cfg.encryptKey === undefined || cfg.encryptKey.length === 0) {
    return { ok: false, detail: '收到加密回调但未配置 encrypt_key（飞书侧应关闭加密或本侧补密钥）' };
  }
  try {
    const plain = decryptFeishuEncrypt(obj['encrypt'] as string, cfg.encryptKey);
    return { ok: true, body: JSON.parse(plain) };
  } catch (cause) {
    return { ok: false, detail: `encrypt 解密失败：${String(cause)}` };
  }
}
