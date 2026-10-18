#!/usr/bin/env bash
# 完整闭环：图片落到 home 卷 → 真实任务 → 模型能否据此识别内容
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

CID=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
echo "container=$CID"

echo "=== 1. 造一张橙色图，直接写进容器 home（模拟下载结果）==="
node -e '
const zlib=require("node:zlib");const w=40,h=40;
const raw=Buffer.alloc(h*(1+w*3));
for(let y=0;y<h;y++){const o=y*(1+w*3);raw[o]=0;
  for(let x=0;x<w;x++){const p=o+1+x*3;raw[p]=255;raw[p+1]=140;raw[p+2]=0;}}
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const ty=Buffer.from(t,"ascii");
  const tb=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;tb[n]=c>>>0;}
  let crc=0xffffffff;for(const b of Buffer.concat([ty,d]))crc=tb[(crc^b)&0xff]^(crc>>>8);
  const cb=Buffer.alloc(4);cb.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([l,ty,d,cb]);}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);
require("node:fs").writeFileSync("/tmp/orange.png",png);console.log("  橙色 PNG:",png.length,"字节");'

timeout 60 docker exec "$CID" sh -c 'mkdir -p /dot/home/media'
timeout 60 docker cp /tmp/orange.png "$CID:/dot/home/media/vision-test.png"
timeout 60 docker exec "$CID" sh -c 'ls -la /dot/home/media/vision-test.png'

echo
echo "=== 2. 提交一个"看图"任务（模拟主人发图后的问题）==="
BODY=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' \
  "主人发来一张图片，已保存到 home 内的 media/vision-test.png（纯色方块）。请告诉我这张图是什么颜色。")
TID=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$BODY" "$BASE/api/messages" \
  | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
echo "  task=$TID"

for i in $(seq 1 120); do
  sleep 2
  ST=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$TID")
  case "$ST" in done|failed|cancelled|paused) break ;; esac
done
echo "  状态=$ST（$((i*2))s）"

echo
echo "=== 3. 工具调用 ==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
for (const r of db.prepare("SELECT seq,tool_name,status,substr(args_json,1,70) a,substr(result_json,1,110) res FROM steps WHERE task_id=? AND kind=? ORDER BY seq").all(process.argv[1],"tool")) {
  console.log("  " + r.tool_name + " " + r.status);
  console.log("     args: " + String(r.a||"").replace(/\s+/g," "));
  console.log("     res : " + String(r.res||"").replace(/\s+/g," "));
}
db.close();' "$TID" 2>&1 | head -12

echo
echo "=== 4. 回答（关键：它说对了橙色吗）==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1],"assistant","text");
console.log(m ? String(m.content).replace(/\s+/g," ").slice(0,300) : "(无)");
db.close();' "$TID" 2>&1
