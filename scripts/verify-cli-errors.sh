#!/usr/bin/env bash
# 验证 CLI 错误信息是否可读
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a

echo "======== 1. 不存在的备份（应给出具体原因）========"
node --import tsx src/surfaces/cli.ts memory restore "nonexistent__x.md" 2>&1 | head -3
echo "  退出码: ${PIPESTATUS[0]:-?}"

echo
echo "======== 2. 非法归档名（目录穿越）========"
node --import tsx src/surfaces/cli.ts memory restore "../../etc/passwd" 2>&1 | head -3

echo
echo "======== 3. 正常回滚（确认功能没坏）========"
NAME=$(node --import tsx src/surfaces/cli.ts memory archive --path MEMORY.md --limit 5 --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const it=(j||[]).slice().sort((a,b)=>a.archivedAt<b.archivedAt?-1:1)[0];console.log(it?it.name:"")}catch(e){console.log("")}});')
echo "  选中: $NAME"
node --import tsx src/surfaces/cli.ts memory restore "$NAME" 2>&1 | head -3
