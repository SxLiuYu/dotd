#!/usr/bin/env bash
# 决定性验证：图片是否真的以 image_url 发给模型（而不是只给路径让它自己解析）
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

echo "=== 1. 重启 daemon 加载多模态改造 ==="
# 走 lib/daemon-restart.sh（原来 DOTD_MAX_RUNNING=1 那句在锁被占时是静默 no-op）。
. "$(dirname "${BASH_SOURCE[0]}")/lib/daemon-restart.sh"
daemon_restart DOTD_MAX_RUNNING=1 || { echo "  ❌ 重启/环境验证失败"; exit 1; }

CID=$(timeout 40 docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
echo "  container=$CID"

echo
echo "=== 2. 放一张紫色图到 home/media ==="
node -e '
const zlib=require("node:zlib");const w=48,h=48;
const raw=Buffer.alloc(h*(1+w*3));
for(let y=0;y<h;y++){const o=y*(1+w*3);raw[o]=0;
  for(let x=0;x<w;x++){const p=o+1+x*3;raw[p]=128;raw[p+1]=0;raw[p+2]=200;}}
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const ty=Buffer.from(t,"ascii");
  const tb=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;tb[n]=c>>>0;}
  let crc=0xffffffff;for(const b of Buffer.concat([ty,d]))crc=tb[(crc^b)&0xff]^(crc>>>8);
  const cb=Buffer.alloc(4);cb.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([l,ty,d,cb]);}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);
require("node:fs").writeFileSync("/tmp/purple2.png",png);console.log("  紫色 PNG:",png.length,"字节");'
timeout 60 docker exec "$CID" sh -c 'mkdir -p /dot/home/media'
timeout 60 docker cp /tmp/purple2.png "$CID:/dot/home/media/vision2.png"

echo
echo "=== 3. 提交看图任务 ==="
BODY=$(node -e 'process.stdout.write(JSON.stringify({text:process.argv[1]}))' \
  "主人发来一张图片 media/vision2.png。请直接告诉我这张图是什么颜色。**不要运行任何命令、不要读取文件**，只根据你看到的内容回答。")
TID=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "$BODY" "$BASE/api/messages" \
  | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
echo "  task=$TID"

for i in $(seq 1 150); do
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
echo "=== 4. 是否加载了图片（关键日志）==="
grep -E '已加载任务图片' /tmp/dotd-wsl.log | tail -3 || echo "  (没有加载日志)"

echo
echo "=== 5. 工具调用（看它是否还在自己解析像素）==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const rows = db.prepare("SELECT tool_name,status,substr(args_json,1,60) a FROM steps WHERE task_id=? AND kind=? ORDER BY seq").all(process.argv[1],"tool");
console.log("  工具调用数:", rows.length);
for (const r of rows) console.log("   " + r.tool_name + " " + r.status + "  " + String(r.a||"").replace(/\s+/g," "));
db.close();' "$TID" 2>&1 | head -8

echo
echo "=== 6. 回答（紫色 = 128,0,200）==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1],"assistant","text");
console.log(m ? String(m.content).replace(/\s+/g," ").slice(0,400) : "(无)");
db.close();' "$TID" 2>&1
