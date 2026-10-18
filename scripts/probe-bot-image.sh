#!/usr/bin/env bash
# 验证：bot 自己发的图片消息会不会触发 im.message.receive_v1
# 如果会 → 我可以自己端到端测多模态；如果不会 → 只能靠真人
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a
CHAT="${FEISHU_OWNER_CHAT_ID%%,*}"

TOK=$(curl -s -m 20 -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"$FEISHU_APP_ID\",\"app_secret\":\"$FEISHU_APP_SECRET\"}" \
  | sed -n 's/.*"tenant_access_token":"\([^"]*\)".*/\1/p')
echo "token=${#TOK}"

# 生成一张绿色 PNG
node -e '
const zlib=require("node:zlib");const w=40,h=40;
const raw=Buffer.alloc(h*(1+w*3));
for(let y=0;y<h;y++){const o=y*(1+w*3);raw[o]=0;
  for(let x=0;x<w;x++){const p=o+1+x*3;raw[p]=0;raw[p+1]=200;raw[p+2]=0;}}
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const ty=Buffer.from(t,"ascii");
  const tb=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;tb[n]=c>>>0;}
  let crc=0xffffffff;for(const b of Buffer.concat([ty,d]))crc=tb[(crc^b)&0xff]^(crc>>>8);
  const cb=Buffer.alloc(4);cb.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([l,ty,d,cb]);}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);
require("node:fs").writeFileSync("/tmp/green.png",png);console.log("绿色 PNG:",png.length,"字节");'

IMGKEY=$(curl -s -m 30 -X POST "https://open.feishu.cn/open-apis/im/v1/images" \
  -H "Authorization: Bearer $TOK" -F "image_type=message" -F "image=@/tmp/green.png;type=image/png" \
  | sed -n 's/.*"image_key":"\([^"]*\)".*/\1/p')
echo "image_key=$IMGKEY"

echo "=== 记录发送前的时间戳 ==="
BEFORE=$(($(date +%s) * 1000))
echo "  before=$BEFORE"

echo "=== bot 发送图片消息到群 ==="
BODY=$(node -e 'process.stdout.write(JSON.stringify({receive_id:process.argv[1],msg_type:"image",content:JSON.stringify({image_key:process.argv[2]})}))' "$CHAT" "$IMGKEY")
RC=$(curl -s -m 20 -X POST "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id" \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' --data-binary "$BODY")
echo "  发送结果: $(printf '%s' "$RC" | head -c 150)"

echo
echo "=== 等 25 秒，看 daemon 有没有收到事件 ==="
sleep 25
NEW=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT COUNT(*) c FROM tasks WHERE created_at > ?").get(Number(process.argv[1]));
process.stdout.write(String(r.c)); db.close();' "$BEFORE")
echo "  发送后新建的任务数: $NEW"

echo
echo "=== daemon 日志里的入站事件 ==="
grep -E '收到事件|建任务|被拒|non_text' /tmp/dotd-wsl.log | tail -5 || echo "  （无）"
