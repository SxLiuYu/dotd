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
import { parseCardAction } from './feishu-card.ts';
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
      /** 图片消息才有：飞书 image_key（本体需另外下载，见 feishu-media.ts）。 */
      imageKey?: string;
      /** 文件消息才有：飞书 file_key、原始文件名、以及下载所必需的 message_id（2026-10-19）。 */
      fileKey?: string;
      fileName?: string;
      messageId?: string;
      raw: RawInbound;
    }
  /** 其余合法事件：落事件流 ack（202），不建任务。 */
  | { kind: 'event'; dedupKey: string; eventId: string; raw: RawInbound }
  /** 聊天域事件但不建任务（机器人自身消息回环/非文本/空文本）：直接 ack，
   *  **不进** CP 事件管线——§6 匹配器会照 payload 建 tk_ev_* 重复任务
   *  （WSL 冒烟实测）。 */
  | { kind: 'ignore'; reason: 'bot_echo' | 'non_text'; detail: string; eventId: string }
  /**
   * 卡片按钮回调（T3，2026-10-20）。
   * 和 message 分开是刻意的：审批回调**绝不能**走任务事件流（GOV §铁律：审批回复不进流）。
   * 走同一条路意味着"点同意"会变成一条聊天消息，然后被当成新任务 —— 荒谬且危险。
   */
  | {
      kind: 'card_action';
      dedupKey: string;
      eventId: string;
      approvalId: number;
      verdict: 'approve' | 'reject';
      /** 卡片的 message_id，落定后要拿它改卡片 */
      cardMessageId: string;
      chatId: string;
      operatorId: string;
    }
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

  // ── 卡片按钮回调（T3）──────────────────────────────────────────
  //
  // 飞书把按钮点击作为 `card.action.trigger` 事件推过来，payload 在 ev.event 里。
  // **必须在 3 秒内响应**，否则飞书重试 —— 我们在这里只做解析，真正的
  // decide() 由调用方异步做（handleFeishuCallback 的返回值就是响应内容）。
  if (eventType === 'card.action.trigger') {
    const raw = (ev.event ?? {}) as Record<string, unknown>;
    const operator = (raw['operator'] ?? {}) as Record<string, unknown>;
    const operatorId = typeof operator['open_id'] === 'string' ? (operator['open_id'] as string) : '';
    const context = (raw['context'] ?? {}) as Record<string, unknown>;
    const chatId = typeof context['open_chat_id'] === 'string' ? (context['open_chat_id'] as string) : '';
    const cardMessageId = typeof context['open_message_id'] === 'string' ? (context['open_message_id'] as string) : '';
    const action = (raw['action'] ?? {}) as Record<string, unknown>;

    const parsed = parseCardAction(action['value']);
    if (parsed === null) {
      return { kind: 'ignore', reason: 'non_text', detail: '卡片回调但不是审批按钮', eventId };
    }

    // 主人闸门同样要过。卡片能被别人转发出去，不能因为"点了按钮"就跳过校验。
    if (cfg.ownerChatId === undefined || cfg.ownerChatId.length === 0) {
      return { kind: 'reject', reason: 'allowlist', detail: 'owner_chat_id 未配置，拒卡片回调' };
    }
    const owners = new Set(cfg.ownerChatId.split(',').map((x) => x.trim()).filter((x) => x.length > 0));
    if (chatId !== '' && !owners.has(chatId)) {
      return { kind: 'reject', reason: 'allowlist', detail: `chat_id ${chatId} 非主人会话` };
    }

    return {
      kind: 'card_action',
      dedupKey,
      eventId,
      approvalId: parsed.approvalId,
      verdict: parsed.verdict,
      cardMessageId,
      chatId,
      operatorId,
    };
  }

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

    // **富文本消息（post）**（2026-10-19 实测补）：主人在飞书里发带格式的消息
    // （加粗、链接、分段、标题）走的是 post 类型，content 里**没有** text 字段，
    // 而是一个 {zh_cn: {title, content: [[{tag,text,href}...]]}} 结构。
    // 原来一律落进 ignore —— 主人发了一段排版好的话，bot 当没看见。
    // 这里把它拍平成纯文本（保留标题、段落分隔、链接 href）。
    if (msgType === 'post' && text.length === 0) {
      text = flattenPostContent(String(message['content'] ?? ''));
    }
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
    // 图片消息（2026-10-18 多模态）：content 里只有 image_key，本体要另外下载。
    // 文本为空但有 image_key → 仍然建任务，由 handleFeishuCallback 负责下载并合成描述。
    let imageKey: string | null = null;
    if (msgType === 'image') {
      try {
        const parsed = JSON.parse(String(message['content'] ?? '{}')) as { image_key?: unknown };
        if (typeof parsed.image_key === 'string' && parsed.image_key.length > 0) imageKey = parsed.image_key;
      } catch {
        imageKey = null;
      }
      if (imageKey !== null) {
        return {
          kind: 'message',
          dedupKey,
          eventId,
          chatId,
          text: text.length > 0 ? text : '（主人发来一张图片）',
          imageKey,
          raw: { source: 'http', dotId, text, payload: obj, dedupKey, actor: `feishu:${chatId}` },
        };
      }
    }
    // **文件消息**（2026-10-19）：主人发 PDF/Excel/Word 时 content 只含 file_key + file_name。
    // 原来一律 ignore —— 主人发了文件，bot 当没看见，这是对标 OpenAI bot 时的明显缺口。
    if (msgType === 'file') {
      try {
        const parsed = JSON.parse(String(message['content'] ?? '{}')) as {
          file_key?: unknown;
          file_name?: unknown;
        };
        if (typeof parsed.file_key === 'string' && parsed.file_key.length > 0) {
          const fileName = typeof parsed.file_name === 'string' && parsed.file_name.length > 0
            ? parsed.file_name
            : '未命名文件';
          return {
            kind: 'message',
            dedupKey,
            eventId,
            chatId,
            text: text.length > 0 ? text : `（主人发来一个文件：${fileName}）`,
            fileKey: parsed.file_key,
            fileName,
            messageId: typeof message['message_id'] === 'string' ? message['message_id'] : '',
            raw: { source: 'http', dotId, text, payload: obj, dedupKey, actor: `feishu:${chatId}` },
          };
        }
      } catch {
        // 落到下面的 ignore
      }
    }

    // **语音消息**（2026-10-19）：content = {file_key, duration(ms)}。
    //
    // 诚实的能力边界：当前**没有语音转写**能力（容器里无 ffmpeg/whisper，
    // 模型配置也没声明音频输入）。所以这里不假装能听懂，而是：
    //   ① 建一个任务（而不是静默 ignore），让主人**收到一条明确回复**；
    //   ② 回复里说清楚"收到了语音，但暂时转不了文字"，并给替代方案。
    //
    // 为什么值得做：主人发语音被**静默丢弃**是最差的体验 —— 说了半天没有任何反应，
    // 分不清是没收到、正在处理、还是坏了。明确说"收到了但做不了"至少是可预期的。
    if (msgType === 'audio') {
      let durationSec = 0;
      try {
        const parsed = JSON.parse(String(message['content'] ?? '{}')) as { duration?: unknown };
        if (typeof parsed.duration === 'number') durationSec = Math.round(parsed.duration / 1000);
      } catch {
        // 时长未知
      }
      const lenPart = durationSec > 0 ? `，约 ${durationSec} 秒` : '';
      return {
        kind: 'message',
        dedupKey,
        eventId,
        chatId,
        text:
          `（主人发来一条语音${lenPart}）` +
          '我收到了这条语音，但目前还不支持语音转文字，听不到里面的内容。' +
          '请把要点用文字发给我；长内容也可以先转成文字再发。',
        raw: { source: 'http', dotId, text, payload: obj, dedupKey, actor: `feishu:${chatId}` },
      };
    }

    // 只有「文本」与「已拍平的富文本」算可执行消息；其余类型（图片/文件在各自分支已返回）
    // 仍然 ack 不建任务，防 §6 匹配器误建。
    //
    // 2026-10-19：这里原来写的是 `msgType !== 'text'`，把 post 也排除了 ——
    // 于是上面刚拍平好的富文本又被这条判断丢掉（改完测试仍 ignore，查了半天）。
    const textLike = msgType === 'text' || msgType === 'post' || msgType.length === 0;
    if (text.length === 0 || !textLike) {
      // 空文本/非文本消息：ack 不建任务、不进事件管线（防 §6 匹配器误建任务）
      const why = msgType === 'image'
        ? '图片消息但取不到 image_key'
        : msgType === 'file'
          ? '文件消息但取不到 file_key'
          : msgType.length > 0 ? `消息类型 ${msgType} 非文本` : '文本为空';
      return { kind: 'ignore', reason: 'non_text', detail: why, eventId };
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

/**
 * 飞书富文本（post）content → 纯文本（2026-10-19）。
 *
 * 飞书的 post 消息结构：
 * ```json
 * { "zh_cn": { "title": "标题",
 *              "content": [[{"tag":"text","text":"段落一"}],
 *                          [{"tag":"a","text":"链接","href":"https://…"}]] } }
 * ```
 * `content` 是「段落数组」，每段是「行内元素数组」。行内 tag 有 text / a / at / img 等。
 *
 * 拍平规则（尽量不丢信息，也不引入噪音）：
 *  - 标题单独一行（如果非空）
 *  - 每段一行；行内元素按顺序拼接
 *  - `a` 元素拼成 `文字(url)`（保留可点击信息，否则链接就丢了）
 *  - `at` 拼成 `@名字`；`img` 拼成 `[图片]`（真实图片下载不在这个函数里）
 *  - 未知 tag 若有 text 就取 text，否则跳过
 *
 * 任何解析失败都返回空串（调用方按"文本为空"处理），绝不抛。
 */
export function flattenPostContent(contentJson: string): string {
  try {
    const root = JSON.parse(contentJson) as Record<string, unknown>;
    // 优先中文，退回第一个语言键（飞书可能返回 en_us 等）
    const payload =
      (root['zh_cn'] as Record<string, unknown> | undefined) ??
      (Object.values(root).find((v) => v !== null && typeof v === 'object') as
        | Record<string, unknown>
        | undefined);
    if (payload === undefined) return '';

    const lines: string[] = [];
    const title = typeof payload['title'] === 'string' ? payload['title'].trim() : '';
    if (title.length > 0) lines.push(title);

    const paragraphs = payload['content'];
    if (Array.isArray(paragraphs)) {
      for (const para of paragraphs) {
        if (!Array.isArray(para)) continue;
        const parts: string[] = [];
        for (const el of para) {
          if (el === null || typeof el !== 'object') continue;
          const node = el as Record<string, unknown>;
          const tag = typeof node['tag'] === 'string' ? (node['tag'] as string) : '';
          const body = typeof node['text'] === 'string' ? (node['text'] as string) : '';
          if (tag === 'a') {
            const href = typeof node['href'] === 'string' ? (node['href'] as string) : '';
            parts.push(href.length > 0 ? `${body}(${href})` : body);
          } else if (tag === 'at') {
            parts.push(body.length > 0 ? `@${body}` : '@某人');
          } else if (tag === 'img') {
            parts.push('[图片]');
          } else {
            parts.push(body);
          }
        }
        const line = parts.join('').trim();
        if (line.length > 0) lines.push(line);
      }
    }
    return lines.join('\n').trim();
  } catch {
    return '';
  }
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
  /**
   * 图片下载器（2026-10-18 多模态）。不注入 = 图片消息按纯文本处理（行为与改动前一致）。
   * 装配层传 feishu-media.ts 的实现。
   */
  /**
   * 审批回调的处理能力（T3，2026-10-20）。
   * 不注入 = 卡片按钮回调按 ignore 处理（保持旧行为，不影响未升级的装配）。
   * 为什么不直接 import decide()：那会让 feishu-inbound 反向依赖 governance，
   * 而现在它是纯解析层（可单独测）。注入保持了这条边界。
   */
  approval?: {
    decide(
      approvalId: number,
      verdict: 'approve' | 'reject',
      operatorId: string,
    ): Promise<{ ok: boolean; status?: string; reason?: string }>;
    /** 落定后改卡片（去掉按钮）。失败不影响裁决本身。 */
    resolveCard?(cardMessageId: string, approvalId: number): Promise<void>;
  };
  media?: {
    downloadImage(
      imageKey: string,
    ): Promise<{ ok: true; media: { path: string; sizeBytes: number; contentType: string } } | { ok: false; error: string }>;
    /** 文件消息下载（2026-10-19，PDF/Excel/Word 等）。不实现 = 文件消息按纯文本处理。 */
    downloadFile?(
      fileKey: string,
      fileName: string,
      messageId: string,
    ): Promise<
      { ok: true; media: { path: string; sizeBytes: number; contentType: string; fileName: string } } | { ok: false; error: string }
    >;
  };
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
  | { httpStatus: 200; body: { decided: true; approvalId: number; status: string } }
  | { httpStatus: 200; body: { ignored: true; reason: string } }
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
    case 'card_action': {
      // 去重：飞书会重投按钮点击（尤其网络慢时）。同一 event_id 只处理一次。
      if (!claimFeishuMessage(deps.db, decision.dedupKey, 'feishu:card', Date.now())) {
        return { httpStatus: 200, body: { ignored: true, reason: 'dup' } };
      }
      if (deps.approval === undefined) {
        // 装配层没接审批能力 —— 如实忽略，不假装点了。
        return { httpStatus: 200, body: { ignored: true, reason: 'approval_not_wired' } };
      }
      const r = await deps.approval.decide(decision.approvalId, decision.verdict, decision.operatorId);
      if (!r.ok) {
        return { httpStatus: 200, body: { ignored: true, reason: r.reason ?? 'decide_failed' } };
      }
      // 改卡片：把按钮换成结果。失败也不回滚裁决（裁决已经落库了）。
      if (deps.approval.resolveCard !== undefined && decision.cardMessageId !== '') {
        try {
          await deps.approval.resolveCard(decision.cardMessageId, decision.approvalId);
        } catch {
          /* 卡片改不动不影响结论 */
        }
      }
      return {
        httpStatus: 200,
        body: { decided: true, approvalId: decision.approvalId, status: r.status ?? 'unknown' },
      };
    }
    case 'message': {
      // 去重先行（SF 私有表，理由见 claimFeishuMessage）：重投不再建任务。
      if (!claimFeishuMessage(deps.db, decision.dedupKey, decision.raw.actor, Date.now())) {
        return { httpStatus: 200, body: { dup: true } };
      }
      // **图片消息**（2026-10-18 多模态）：先把图下载到 home 卷，再把路径写进任务目标。
      // 下载失败也要建任务——把失败原因如实告诉模型/主人，不能静默当没收到图。
      let goalText = decision.text;
      if (decision.imageKey !== undefined && deps.media !== undefined) {
        const dl = await deps.media.downloadImage(decision.imageKey);
        if (dl.ok) {
          goalText =
            `${decision.text}\n\n【附件】主人发来一张图片，已保存到 home 内的 \`${dl.media.path}\`` +
            `（${dl.media.sizeBytes} 字节，${dl.media.contentType}）。` +
            `可用 fs.stat / fs.read 确认它存在；如需识别图片内容，请据此文件作答。`;
        } else {
          goalText =
            `${decision.text}\n\n【附件获取失败】主人发来一张图片，但下载失败：${dl.error}。` +
            `请如实告诉主人"图没拿到"以及原因，不要凭空描述图片内容。`;
        }
      }
      // **文件消息**（2026-10-19）：先下载到 home，再把路径写进目标。
      // 与图片同理：下载失败也要建任务，并如实告知主人"文件没拿到"。
      if (decision.fileKey !== undefined && deps.media?.downloadFile !== undefined) {
        const dl = await deps.media.downloadFile(
          decision.fileKey,
          decision.fileName ?? '未命名文件',
          decision.messageId ?? '',
        );
        if (dl.ok) {
          goalText =
            `${decision.text}\n\n【附件】主人发来一个文件 \`${dl.media.fileName}\`，已保存到 home 内的 \`${dl.media.path}\`` +
            `（${dl.media.sizeBytes} 字节）。读它请用 shell.run（fs.read 只能读纯文本）：` +
            `PDF 用 pdftotext、Word/Excel 用 python3 解 zip+xml。`;
        } else {
          goalText =
            `${decision.text}\n\n【附件获取失败】主人发来的文件（${decision.fileName ?? '未命名'}）下载失败：${dl.error}。` +
            `请如实告诉主人"文件没拿到"及原因，不要凭空推测文件内容。`;
        }
      }
      // 与 /api/messages 相同的任务链（契约 S-1），channel 换 'feishu'
      const threadId = await deps.mem.openThread(decision.raw.dotId, 'feishu', {
        externalRef: `feishu:${decision.chatId}`,
      });
      await deps.mem.appendMessage(threadId, { role: 'user', kind: 'text', content: goalText });
      // 带上飞书消息 id（2026-10-22）：任务跑起来后要在**主人那条消息**上挂一个
      // "在做"表情（见 progress-reaction.ts）。飞书撤 reaction 需要 message_id，
      // 而它只在入站时出现一次 —— 不落到任务上就永远拿不回来。
      //
      // 走 payloadJson 而不是新增列：tasks.payload_json 本来就存在且飞书入站一直没用，
      // 省一次 schema 迁移（user_version 不必动）。
      const fuMsgId =
        typeof ((decision.raw.payload as Record<string, unknown> | null)?.['message'] as Record<string, unknown> | undefined)?.['message_id'] === 'string'
          ? (((decision.raw.payload as Record<string, unknown>)['message'] as Record<string, unknown>)['message_id'] as string)
          : '';
      const task = deps.cp.submit({
        title: decision.text.slice(0, 60),
        goal: goalText,
        priority: 1,
        dotId: decision.raw.dotId,
        threadId,
        ...(fuMsgId.length > 0 ? { payloadJson: JSON.stringify({ feishuMessageId: fuMsgId }) } : {}),
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
