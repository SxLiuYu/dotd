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

  const route = (eventType: string) => async (frame: Record<string, unknown>): Promise<void> => {
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
      });
      if ('error' in out.body) {
        deps.log(`飞书长连接事件被拒（${out.body.error}）：${out.body.message}`);
      } else if ('taskId' in out.body) {
        deps.log(`飞书长连接：消息已建任务 ${out.body.taskId}`);
      }
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
