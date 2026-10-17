#!/bin/bash
# 让当前 daemon 重跑一次 shell.run（queued 插入即被 runner 领走）
node --import tsx -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/root/.dotd/dotd.db");
const threadId = "thr_01M53AVKVA6SNDQAM9930ZY0BW";
const now = Date.now();
const seq = (db.prepare("SELECT MAX(seq) s FROM mem_messages WHERE thread_id=?").get(threadId).s ?? 0) + 1;
const text = "用 shell.run 执行 echo \"$HOME\"; uname -a，把 stdout 原样贴回来。";
db.prepare("INSERT INTO mem_messages (id,thread_id,seq,role,kind,content,token_est,created_at) VALUES (?,?,?,?,?,?,?,?)")
  .run("msg_sh_" + seq, threadId, seq, "user", "text", text, Math.ceil(text.length / 3.5), now);
const taskId = "tk_sh2_" + now.toString(36);
db.prepare("INSERT INTO tasks (id,dot_id,title,goal,status,priority,attempt,max_attempts,run_epoch,budget_tokens,usage_tokens,budget_exhausted,created_at,updated_at,thread_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run(taskId, "dot1", "shell.run 复测", text, "queued", 1, 0, 3, 0, 200000, 0, 0, now, now, threadId);
console.log("submitted", taskId);
for (let i = 0; i < 50; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const t = db.prepare("SELECT status FROM tasks WHERE id=?").get(taskId);
  if (t && ["done","failed","cancelled"].includes(t.status)) {
    const sh = db.prepare("SELECT seq, status FROM steps WHERE task_id=? AND tool_name=?", ).all(taskId, "shell.run");
    console.log("final:", t.status, "shell steps:", JSON.stringify(sh));
    const asst = db.prepare("SELECT content FROM mem_messages WHERE thread_id=? AND task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(threadId, taskId, "assistant", "text");
    console.log("assistant 结尾:", asst ? asst.content.slice(-200) : "(none)");
    break;
  }
}
'
echo "== exec_calls 新记录 =="
node --import tsx -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/root/.dotd/dotd.db");
console.log(db.prepare("SELECT call_id, tool, state, error_code, sent_at FROM exec_calls ORDER BY sent_at DESC LIMIT 3").all());
'
