#!/usr/bin/env bash
# 验证记忆备份 API：列出 + 恢复
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

CID=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
echo "container=$CID"

echo "=== 1. 列出归档 ==="
curl -s -m 20 "${HDR[@]}" "$BASE/api/memory/archive?limit=10" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{
    const j=JSON.parse(s);
    console.log("  共 " + (j.items||[]).length + " 条");
    for (const it of (j.items||[]).slice(0,6)) {
      console.log("   " + it.archivedAt + "  " + it.originalPath + "  (" + it.sizeBytes + "B)  " + it.name.slice(-30));
    }
  }catch(e){ console.log("  解析失败: " + s.slice(0,200)) }
});'

echo
echo "=== 2. 当前 MEMORY.md 内容基线 ==="
BEFORE_SIZE=$(timeout 60 docker exec "$CID" sh -c 'wc -c < /dot/home/MEMORY.md' 2>&1)
BEFORE_MARK=$(timeout 60 docker exec "$CID" sh -c 'grep -c "归档测试标记" /dot/home/MEMORY.md 2>/dev/null || echo 0' 2>&1)
echo "  大小=$BEFORE_SIZE  含'归档测试标记'=$BEFORE_MARK"

echo
echo "=== 3. 找一个 MEMORY.md 的旧归档并恢复 ==="
OLDEST=$(curl -s -m 20 "${HDR[@]}" "$BASE/api/memory/archive?path=MEMORY.md&limit=50" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{ const j=JSON.parse(s); const items=j.items||[]; 
    // 最早的一份（archivedAt 升序第一个）
    const oldest = items.slice().sort((a,b)=> a.archivedAt < b.archivedAt ? -1 : 1)[0];
    console.log(oldest ? oldest.name : ""); }catch(e){ console.log("") }
});')
echo "  选中归档: ${OLDEST:-（无）}"

if [ -n "$OLDEST" ]; then
  echo "  恢复中..."
  curl -s -m 30 "${HDR[@]}" -X POST -d "{\"archive\":\"$OLDEST\"}" "$BASE/api/memory/restore" | head -c 250
  echo
  echo
  echo "=== 4. 恢复后 ==="
  AFTER_SIZE=$(timeout 60 docker exec "$CID" sh -c 'wc -c < /dot/home/MEMORY.md' 2>&1)
  AFTER_MARK=$(timeout 60 docker exec "$CID" sh -c 'grep -c "归档测试标记" /dot/home/MEMORY.md 2>/dev/null || echo 0' 2>&1)
  echo "  大小=$AFTER_SIZE  含'归档测试标记'=$AFTER_MARK"
  echo "  （若恢复了更早的版本，标记应该消失）"
  echo
  echo "=== 5. 恢复本身也归档了吗 ==="
  curl -s -m 20 "${HDR[@]}" "$BASE/api/memory/archive?path=MEMORY.md&limit=3" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{ const j=JSON.parse(s); console.log("  MEMORY.md 现有归档 " + (j.items||[]).length + " 份，最新: " + ((j.items||[])[0]||{}).archivedAt); }catch(e){}
});'
fi
