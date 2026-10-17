#!/bin/bash
# 用 node 直接读 tokens.env 并发请求，绕开 shell 变量作用域问题
node --input-type=module -e '
import { readFileSync } from "node:fs";
const env = {};
for (const line of readFileSync("/root/.dotd/tokens.env", "utf8").split("\n")) {
  const m = /^export ([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const ro = env["DOTD_RO_TOKEN"] ?? "";
const master = env["DOTD_MASTER_TOKEN"] ?? "";
console.log("RO len:", ro.length, "MASTER len:", master.length);
async function get(path, tok) {
  const res = await fetch("http://127.0.0.1:7789" + path, { headers: { authorization: "Bearer " + tok } });
  console.log(path, "->", res.status);
  const t = await res.text();
  console.log(t.slice(0, 900));
}
await get("/api/guard", ro);
await get("/api/breaker", ro);
await get("/api/queue", master);
'
