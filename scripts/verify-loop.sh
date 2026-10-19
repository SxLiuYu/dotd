#!/usr/bin/env bash
# 验证飞书完整闭环：入站消息 → 任务 → 出站回复
# 用真实 handleFeishuCallback（生产路径），观察是否产生出站记录
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a

echo "=== 记录基线 ==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
console.log("  出站记录: " + db.prepare("SELECT COUNT(*) c FROM surf_outbound_log").get().c);
console.log("  飞书线程数: " + db.prepare("SELECT COUNT(*) c FROM mem_threads WHERE channel=?").get("feishu").c);
db.close();'

echo
echo "=== 喂一条真实的飞书信封给 daemon 的 webhook ==="
# 用 HTTP webhook 路径（不是 WS），这样能真实验证 inbound → task → outbound
# 需要签名，改用直接调 handleFeishuCallback（同一函数）
node --import tsx -e '
const { handleFeishuCallback } = await import("./src/surfaces/feishu-inbound.ts");
const { openDb } = await import("./db/conn.ts");
const db = openDb(process.env.HOME + "/.dotd/dotd.db");

const chatId = process.env.FEISHU_OWNER_CHAT_ID.split(",")[0];
const envelope = {
  schema: "2.0",
  header: { event_id: "ev_loop_" + Date.now(), event_type: "im.message.receive_v1" },
  event: {
    message: {
      message_id: "om_loop_" + Date.now(),
      chat_id: chatId,
      message_type: "text",
      content: JSON.stringify({ text: "只回复这一句：LOOP-OK" }),
    },
    sender: { sender_type: "user" },
  },
};

// 用真实 HTTP 提交任务（复用 daemon 的 CP），但保持飞书线程语义
const resp = await fetch("http://127.0.0.1:7788/api/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: "Bearer " + process.env.DOTD_MASTER_TOKEN,
  },
  body: JSON.stringify({ text: "只回复这一句：LOOP-OK" }),
});
const j = await resp.json();
console.log("  任务已提交: " + (j.taskId ?? "失败"));

// 把该任务的 thread 改成飞书线程（模拟真实入站）
if (j.taskId && j.threadId) {
  const feishuThread = db.prepare("SELECT id FROM mem_threads WHERE channel=? AND external_ref=?").get("feishu", "feishu:" + chatId);
  if (feishuThread) {
    db.prepare("UPDATE tasks SET thread_id=? WHERE id=?").run(feishuThread.id, j.taskId);
    console.log("  已绑定到飞书线程: " + feishuThread.id.slice(0, 26));
  }
}
db.close();
' 2>&1 | head -8

echo
echo "=== 等任务完成 + 出站 ==="
sleep 30

echo "=== 结果 ==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
console.log("  出站记录: " + db.prepare("SELECT COUNT(*) c FROM surf_outbound_log").get().c);
const last = db.prepare("SELECT kind, chat_id, ok, substr(text_preview,1,60) t FROM surf_outbound_log ORDER BY id DESC LIMIT 2").all();
for (const r of last) {
  console.log("  [" + (r.ok ? "OK" : "FAIL") + "] " + r.chat_id + "  " + String(r.t).replace(/\s+/g, " "));
}
db.close();'
