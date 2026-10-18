#!/usr/bin/env bash
# 完整验证：飞书图片上传 → 用 daemon 的下载实现取回 → 检查文件
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a

TOK=$(curl -s -m 20 -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"$FEISHU_APP_ID\",\"app_secret\":\"$FEISHU_APP_SECRET\"}" \
  | sed -n 's/.*"tenant_access_token":"\([^"]*\)".*/\1/p')
echo "token=${#TOK} 字符"

# 生成蓝色 PNG
node -e '
const zlib=require("node:zlib");const w=48,h=48;
const raw=Buffer.alloc(h*(1+w*3));
for(let y=0;y<h;y++){const o=y*(1+w*3);raw[o]=0;
  for(let x=0;x<w;x++){const p=o+1+x*3;raw[p]=0;raw[p+1]=0;raw[p+2]=255;}}
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const ty=Buffer.from(t,"ascii");
  const tb=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;tb[n]=c>>>0;}
  let crc=0xffffffff;for(const b of Buffer.concat([ty,d]))crc=tb[(crc^b)&0xff]^(crc>>>8);
  const cb=Buffer.alloc(4);cb.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([l,ty,d,cb]);}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);
require("node:fs").writeFileSync("/tmp/blue.png",png);'

UP=$(curl -s -m 30 -X POST "https://open.feishu.cn/open-apis/im/v1/images" \
  -H "Authorization: Bearer $TOK" -F "image_type=message" -F "image=@/tmp/blue.png;type=image/png")
IMGKEY=$(printf '%s' "$UP" | sed -n 's/.*"image_key":"\([^"]*\)".*/\1/p')
echo "image_key=$IMGKEY"

rm -rf /tmp/dlhome
TOKEN="$TOK" IMGKEY="$IMGKEY" node --import tsx -e '
const { downloadFeishuImage } = await import("./src/surfaces/feishu-media.ts");
const r = await downloadFeishuImage(process.env.IMGKEY, {
  tenantToken: async () => process.env.TOKEN ?? null,
  homeRoot: "/tmp/dlhome",
});
console.log("下载结果:", JSON.stringify(r).slice(0, 200));
if (r.ok) {
  const fs = require("node:fs");
  const p = "/tmp/dlhome/" + r.media.path;
  console.log("文件存在:", fs.existsSync(p));
  console.log("文件大小:", fs.statSync(p).size, "字节（原始 122）");
  const buf = fs.readFileSync(p);
  console.log("是 PNG:", buf[0] === 0x89 && buf[1] === 0x50);
}
' 2>&1 | head -10
