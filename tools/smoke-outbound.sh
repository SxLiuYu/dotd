#!/bin/bash
# 出站单独冒烟：FeishuGateway.sendText → 主人会话
set -a
source /root/.dotd/tokens.env
set +a
cd /root/dotd
node --import tsx -e '
import { FeishuGateway } from "./src/surfaces/channels.ts";
const gw = new FeishuGateway({
  appId: process.env.FEISHU_APP_ID ?? "",
  appSecret: process.env.FEISHU_APP_SECRET ?? "",
  editThrottleMs: 1200,
});
const chat = (process.env.FEISHU_OWNER_CHAT_ID ?? "").split(",")[0].trim();
const res = await gw.sendText(chat, "【dotd】出站回路部署自检：如果你在本会话看到这条消息，说明机器人答复通道可用。（这是部署自检消息，非任务回复）");
console.log("sendText:", JSON.stringify(res));
'
