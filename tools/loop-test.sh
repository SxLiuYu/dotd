#!/bin/bash
# 出站闭环自测：向主人 feishu 线程直接插入一条 user 消息 + queued 任务，
# 守护进程 runner 会领任务 → hy3 → done → 总线 task.state → 出站订阅发回飞书。
cd /root/dotd
node --import tsx -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/root/.dotd/dotd.db");
const threadId = "thr_01M53AVKVA6SNDQAM9930ZY0BW"; // feishu:oc_fe2a…（主人会话）
const now = Date.now();
const seq = (db.prepare("SELECT MAX(seq) s FROM mem_messages WHERE thread_id=?").get(threadId).s ?? 0) + 1;
const text = "请用一句话回复：dotd 出站回路闭环测试成功";
db.prepare("INSERT INTO mem_messages (id,thread_id,seq,role,kind,content,token_est,created_at) VALUES (?,?,?,?,?,?,?,?)")
  .run("msg_loop_" + seq, threadId, seq, "user", "text", text, Math.ceil(text.length / 3.5), now);
const taskId = "tk_looptest_" + now.toString(36);
db.prepare("INSERT INTO tasks (id,dot_id,title,goal,status,priority,attempt,max_attempts,run_epoch,budget_tokens,usage_tokens,budget_exhausted,created_at,updated_at,thread_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(taskId, "dot1", text.slice(0, 60), text, "queued", 1, 0, 3, 0, 200000, 0, 0, now, now, threadId);
console.log("submitted", taskId, "seq", seq);
// 轮询最多 150s 等终态
for (let i = 0; i < 50; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const t = db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId);
  if (t && (t.status === "done" || t.status === "failed" || t.status === "cancelled")) { console.log("final status:", t.status); break; }
  if (i === 49) console.log("TIMEOUT, still:", t?.status);
}
'
echo "== daemon.log 出站相关行 =="
grep -n "飞书出站\|领任务\|tk_looptest" /root/.dotd/daemon.log | tail -8
