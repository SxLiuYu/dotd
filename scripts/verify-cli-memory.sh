#!/usr/bin/env bash
# 真实环境验证 CLI：dotd memory archive / restore
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a

echo "======== dotd memory archive ========"
node --import tsx src/surfaces/cli.ts memory archive --limit 5 2>&1 | head -14

echo
echo "======== dotd memory archive --path MEMORY.md ========"
node --import tsx src/surfaces/cli.ts memory archive --path MEMORY.md --limit 3 2>&1 | head -10

echo
echo "======== dotd memory archive --json ========"
node --import tsx src/surfaces/cli.ts memory archive --path MEMORY.md --limit 1 --json 2>&1 | head -10

echo
echo "======== 取一份备份做 restore ========"
NAME=$(node --import tsx src/surfaces/cli.ts memory archive --path MEMORY.md --limit 5 --json 2>/dev/null | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{ const j=JSON.parse(s); const items=j||[]; 
    const oldest = items.slice().sort((a,b)=> a.archivedAt < b.archivedAt ? -1 : 1)[0];
    console.log(oldest ? oldest.name : ""); }catch(e){ console.log("") }
});')
echo "选中: ${NAME:-（无）}"

if [ -n "$NAME" ]; then
  echo
  echo "======== dotd memory restore $NAME ========"
  node --import tsx src/surfaces/cli.ts memory restore "$NAME" 2>&1 | head -5
  echo "退出码: $?"
fi

echo
echo "======== 错误场景（不存在的备份）========"
node --import tsx src/surfaces/cli.ts memory restore "nonexistent__x.md" 2>&1 | head -3
echo "退出码: $?"
