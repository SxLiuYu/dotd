#!/bin/bash
# 查 exec_dots 结构与当前行、最近 shell.run 失败详情
node --import tsx -e '
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("/root/.dotd/dotd.db");
const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get("exec_dots");
console.log(ddl.sql);
console.log(db.prepare("SELECT * FROM exec_dots").all());
const last = db.prepare("SELECT seq, status, substr(result_json, 1, 600) r FROM steps WHERE tool_name = ? ORDER BY seq DESC LIMIT 1").all("shell.run");
console.log("last shell.run step:", last);
'
