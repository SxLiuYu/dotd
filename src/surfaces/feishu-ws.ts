/**
 * src/surfaces/feishu-ws.ts —— 飞书事件订阅**长连接**入站（官方 WSClient）。
 *
 * 为什么是长连接（2026-10-16 主人拍板）：daemon 在 NAT 后（WSL，只听 127.0.0.1），
 * 没有公网回调地址；飞书开放平台支持由应用侧主动建立出站 WebSocket，事件从这条
 * 连接推下来——无需公网 IP、无需 VPS 反代、无需 verification token
 *（鉴权由 app_id/app_secret 握手完成，classifyFeishuInbound 的
 * trustedTransport 旗标对应此语义）。
 *
 * 与 HTTP webhook（feishu-inbound.ts + /hooks/feishu）的关系：
 * - 二者共享同一条任务链（handleFeishuCallback），去重、主人闸门、fail-closed
 *   语义完全一致；owner_chat_id 支持逗号分隔多会话。
 * - WS 的 payload 是**扁平**的（event_id/message/sender 在顶层），HTTP 的是
 *   v2.0 信封（header/event 分层）——本模块把扁平帧重组回信封再进 classify，
 *   判别逻辑零复制。
 *
 * 属主切分：SF 面。模块只 import SDK 与 feishu-inbound 纯函数，不碰 CP 内部。
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import { DEFAULT_DOT_ID } from '../shared/ids.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { ControlPlane, MemoryPort } from '../shared/contracts.ts';
import { handleFeishuCallback } from './feishu-inbound.ts';
import { toCardCallbackResponse } from './feishu-card.ts';
import type { FeishuConfig } from './types.ts';

export interface FeishuWsDeps {
  cp: ControlPlane;
  mem: MemoryPort;
  db: DatabaseSync;
  bus: { publish(topic: string, payload: Record<string, unknown>, opts?: { dotId?: string }): void };
  cfg: FeishuConfig;
  dotId?: string;
  /** daemon 日志通道（[dotd] 前缀已在外面拼好）。 */
  log(msg: string): void;
  /**
   * 审批卡片的**回调决策**（2026-10-21 补，主人报「点同意没反应」）。
   *
   * 不注入 = 点击到达后直接 `{ignored:true, reason:'approval_not_wired'}` 丢弃，
   * 审批停在 pending、任务卡在 awaiting_approval —— 这正是此前的现场。
   */
  approval?: {
    decide(
      approvalId: number,
      verdict: 'approve' | 'approve_remember' | 'reject',
      operatorId: string,
    ): Promise<{ ok: boolean; status?: string; reason?: string }>;
    /** 落定后改卡片（去掉按钮）。失败不影响裁决本身。
     *  2026-10-27：返回值带结果卡 —— feishu-ws 要把它放进回调响应（见 route()）。 */
    resolveCard?(cardMessageId: string, approvalId: number): Promise<{ card?: unknown } | void>;
    /** 查审批当前状态对应的卡片（重复/迟到点击的回包用，见 feishu-inbound.ts）。 */
    cardFor?(approvalId: number): unknown | null;
  };
  /** 图片下载器（2026-10-18 多模态）；不注入 = 图片按纯文本处理。 */
  media?: {
    downloadImage(
      imageKey: string,
    ): Promise<{ ok: true; media: { path: string; sizeBytes: number; contentType: string } } | { ok: false; error: string }>;
  };
}

/**
 * SDK 长连接 handler 收到的是扁平 event payload；重组回事件订阅 v2.0 信封，
 * 让 handleFeishuCallback（HTTP 路径同款判别）原样复用。
 * 非消息事件的扁平形状字段位置与消息事件相同顶层化，统一按 header.event_id
 * + 顶层其余字段归入 event 处理。
 */
export function wsFrameToEnvelope(eventId: string | undefined, eventType: string, frame: Record<string, unknown>): Record<string, unknown> {
  const { event_id: _e, token: _t, create_time: _c, event_type: _ty, tenant_key: _k, ts: _ts, uuid: _u, type: _tp, app_id: _a, ...rest } = frame;
  return {
    schema: '2.0',
    header: {
      event_id: eventId ?? '',
      event_type: eventType,
      ...(typeof frame['token'] === 'string' ? { token: frame['token'] as string } : {}),
      ...(typeof frame['app_id'] === 'string' ? { app_id: frame['app_id'] as string } : {}),
      ...(typeof frame['tenant_key'] === 'string' ? { tenant_key: frame['tenant_key'] as string } : {}),
    },
    event: rest,
  };
}

/**
 * 启动飞书长连接事件订阅。返回停止函数（幂等）。
 * 前提：cfg.appId/appSecret 均已配置（调用方负责守卫）；
 * owner_chat_id 未配置时连接照建、消息照收，但一律 403 拒（fail-closed，
 * 与 HTTP 路径同语义——宁可不跑也不误跑）。
 */
export function startFeishuWs(deps: FeishuWsDeps): () => void {
  const dotId = deps.dotId ?? DEFAULT_DOT_ID;
  const dispatcher = new Lark.EventDispatcher({});

  // 返回值 = 卡片回调的落定状态（2026-10-27）：card.action.trigger 必须把结果卡
  // 原样返回，SDK 才会把它写进回包（handleEventData：result 非空才带 data）。
  // 其余事件返回 undefined，与旧行为一致。
  const route = (eventType: string) => async (frame: Record<string, unknown>): Promise<unknown> => {
    // 无条件先记一行"事件到了"。
    //
    // 为什么必须有这条：改之前只有两种结果会落日志（被拒 / 建了任务）。于是
    // "消息根本没到长连接"、"到了但被静默忽略（sender 不是 owner / bot 回声过滤）"
    // 这两种最常见的情况**一行日志都不留**，只能去翻数据库猜。
    // 2026-10-18 排查"飞书发消息没回复"时就卡在这里：堆栈上完全看不出事件有没有进来。
    try {
      const ev = (frame['event'] ?? {}) as Record<string, unknown>;
      const msg = (ev['message'] ?? {}) as Record<string, unknown>;
      const sender = (ev['sender'] ?? {}) as Record<string, unknown>;
      const senderId = (sender['sender_id'] ?? {}) as Record<string, unknown>;
      deps.log(
        `飞书长连接收到事件 ${eventType}：chat=${String(msg['chat_id'] ?? '-')} ` +
          `sender=${String(sender['sender_type'] ?? '-')}:${String(senderId['open_id'] ?? senderId['union_id'] ?? '-')} ` +
          `type=${String(msg['message_type'] ?? '-')} len=${String(msg['content'] ?? '').length}`,
      );
    } catch {
      deps.log(`飞书长连接收到事件 ${eventType}（载荷结构异常，无法摘要）`);
    }

    // 卡片回调单独转储原始载荷（2026-10-21）。
    // 为什么需要：主人报「点了没反应」，日志只有 `chat=- sender=-:- type=- len=0`，
    // 消息事件的摘要字段在卡片回调里全是空的 —— 看不出到底解析到哪一步失败。
    // 只转储这一类事件，且截断，避免刷日志。
    if (eventType === 'card.action.trigger') {
      try {
        deps.log(`飞书卡片回调原始载荷：${JSON.stringify(frame).slice(0, 1200)}`);
      } catch {
        deps.log('飞书卡片回调原始载荷：无法序列化');
      }
    }
    const envelope = wsFrameToEnvelope(typeof frame['event_id'] === 'string' ? frame['event_id'] : undefined, eventType, frame);
    try {
      const out = await handleFeishuCallback(envelope, {
        cp: deps.cp,
        mem: deps.mem,
        db: deps.db,
        bus: deps.bus,
        cfg: deps.cfg,
        dotId,
        trustedTransport: true,
        ...(deps.media === undefined ? {} : { media: deps.media }),
        // 2026-10-21：审批回调的决策能力。
        // 漏这一行的后果实测过：daemon 明明传了 approval，
        // 但这里手工挑字段时没带上，于是点击仍然返回
        // `{"ignored":true,"reason":"approval_not_wired"}` ——
        // 日志里看得一清二楚，只是此前这行结果日志根本不存在。
        ...(deps.approval === undefined ? {} : { approval: deps.approval }),
      });
      // 2026-10-21：任何结果都要落一行。
      // 现场：主人点「同意」没反应，日志里只有"事件到了"和"原始载荷"，
      // 之后再无输出 —— 因为这里只记 error/taskId，`ignored`/`decided` 静默丢弃。
      // 排查时看不出逻辑走到哪一步，只能反复猜。
      deps.log(`飞书长连接事件结果 ${eventType}：${JSON.stringify(out.body).slice(0, 400)}`);
      if ('error' in out.body) {
        deps.log(`飞书长连接事件被拒（${out.body.error}）：${out.body.message}`);
      } else if ('taskId' in out.body) {
        deps.log(`飞书长连接：消息已建任务 ${out.body.taskId}`);
      }
      // 2026-10-27：卡片按钮回调的**响应体必须带结果卡**。
      //
      // 现场与实测：主人点「同意」，daemon 照常 decide + PATCH 改卡（日志
      // 「已改 2/2 张卡片」），客户端先显示出「已同意」；但 SDK 的回包协议是
      // 「handler 的返回值 = 这张卡的落定状态」（lib/index.js handleEventData：
      // result 非空才写进 respPayload.data）。此前 route() 返回 void，
      // 回包里没有卡 —— 飞书便把卡片按**点击时**的版本落定，把 PATCH 冲掉。
      //
      // 2026-10-27 二次修（主人复现「还是刷新回去了」）：光带卡还不够，
      // 形状要对。飞书 **v2** 回调要求的响应体是
      //   { card: { type: 'raw', data: <卡片JSON> } }
      // 上一版把卡片 JSON 裸着放顶层，飞书解析不到卡片，同样回退成点击时的版本。
      // 这里统一过 toCardCallbackResponse()，别在调用点各自拼。
      const card = (out.body as { card?: unknown } | undefined)?.card;
      if (eventType === 'card.action.trigger' && card !== undefined && card !== null) {
        return toCardCallbackResponse(card as Record<string, unknown>);
      }
      return undefined;
    } catch (cause) {
      // 处理器抛错会被 SDK 记为失败；吞掉并落日志，避免连接级惩罚。
      deps.log(`飞书长连接事件处理异常：${String(cause)}`);
    }
  };

  dispatcher.register({
    'im.message.receive_v1': route('im.message.receive_v1'),
    'im.message.message_read_v1': route('im.message.message_read_v1'),
    'im.message.recalled_v1': route('im.message.recalled_v1'),
    'im.chat.member.bot.added_v1': route('im.chat.member.bot.added_v1'),
    'im.chat.member.user.added_v1': route('im.chat.member.user.added_v1'),
    // T3（2026-10-21 修）：审批卡片的按钮回调。
    //
    // 漏了这一行的现场：卡片发得出去（fs-outbound 记"已发卡片"），
    // 但主人点「同意/拒绝」后飞书 SDK 打
    //   [warn]: no card.action.trigger handle
    // 事件直接丢弃 —— 审批永远停在 pending，任务卡在 awaiting_approval。
    // 卡片这半条链路是通的，另外半条（回调）从来没接上。
    'card.action.trigger': route('card.action.trigger'),
  } as Record<string, (data: never) => Promise<void>>);

  const client = new Lark.WSClient({
    appId: deps.cfg.appId,
    appSecret: deps.cfg.appSecret,
    loggerLevel: Lark.LoggerLevel.error,
    onReady: () => deps.log('飞书长连接已建立（事件订阅就绪）'),
    onError: (err: Error) => deps.log(`飞书长连接错误：${err.message}`),
    onReconnecting: () => deps.log('飞书长连接断开，重连中…'),
    onReconnected: () => deps.log('飞书长连接已恢复'),
  });

  void client.start({ eventDispatcher: dispatcher }).catch((cause: unknown) => {
    deps.log(`飞书长连接启动失败：${String(cause)}`);
  });

  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    try {
      client.close();
    } catch {
      // 已关
    }
  };
}
