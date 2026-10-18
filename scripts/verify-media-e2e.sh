#!/usr/bin/env bash
# 端到端验证多模态：用真实 image_key 构造飞书事件载荷，走 daemon 的完整入站链路
#
# 这不是绕过：handleFeishuCallback 是 WS 和 HTTP 两条路径的**共用入口**，
# WS 只是把扁平帧重组成信封。所以构造一个信封喂进去，执行的就是生产路径。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a

TOK=$(curl -s -m 20 -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"$FEISHU_APP_ID\",\"app_secret\":\"$FEISHU_APP_SECRET\"}" \
  | sed -n 's/.*"tenant_access_token":"\([^"]*\)".*/\1/p')

# 生成紫色 PNG
node -e '
const zlib=require("node:zlib");const w=40,h=40;
const raw=Buffer.alloc(h*(1+w*3));
for(let y=0;y<h;y++){const o=y*(1+w*3);raw[o]=0;
  for(let x=0;x<w;x++){const p=o+1+x*3;raw[p]=160;raw[p+1]=32;raw[p+2]=240;}}
function chunk(t,d){const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const ty=Buffer.from(t,"ascii");
  const tb=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;tb[n]=c>>>0;}
  let crc=0xffffffff;for(const b of Buffer.concat([ty,d]))crc=tb[(crc^b)&0xff]^(crc>>>8);
  const cb=Buffer.alloc(4);cb.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([l,ty,d,cb]);}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk("IHDR",ihdr),chunk("IDAT",zlib.deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);
require("node:fs").writeFileSync("/tmp/purple.png",png);' 

IMGKEY=$(curl -s -m 30 -X POST "https://open.feishu.cn/open-apis/im/v1/images" \
  -H "Authorization: Bearer $TOK" -F "image_type=message" -F "image=@/tmp/purple.png;type=image/png" \
  | sed -n 's/.*"image_key":"\([^"]*\)".*/\1/p')
echo "image_key=$IMGKEY"

echo
echo "=== 构造飞书事件信封，喂给 handleFeishuCallback（生产路径）==="
IMGKEY="$IMGKEY" TOK="$TOK" node --import tsx -e '
const { handleFeishuCallback } = await import("./src/surfaces/feishu-inbound.ts");
const { openDb } = await import("./db/conn.ts");

const db = openDb(process.env.HOME + "/.dotd/dotd.db");
// 极简 deps：只要 openThread/appendMessage 能跑，用于观察决策与目标文本
const threads = new Map();
let seqN = 0;
const mem = {
  async openThread(dotId, channel, opts) {
    const id = "thr_test_media";
    threads.set(id, []);
    return id;
  },
  async appendMessage(threadId, msg) {
    const arr = threads.get(threadId) ?? [];
    arr.push(msg);
    threads.set(threadId, arr);
    return { id: "m" + ++seqN, seq: seqN };
  },
};
const submitted = [];
const cp = { submit(o) { submitted.push(o); return { id: "tk_test_media", status: "queued" }; } };
const bus = { publish() {} };

const envelope = {
  schema: "2.0",
  header: { event_id: "ev_media_test_" + Date.now(), event_type: "im.message.receive_v1" },
  event: {
    message: {
      message_id: "om_media_test",
      chat_id: process.env.FEISHU_OWNER_CHAT_ID.split(",")[0],
      message_type: "image",
      content: JSON.stringify({ image_key: process.env.IMGKEY }),
    },
    sender: { sender_type: "user" },
  },
};

const out = await handleFeishuCallback(envelope, {
  cp, mem, db, bus,
  cfg: { ownerChatId: process.env.FEISHU_OWNER_CHAT_ID, appId: "", appSecret: "" },
  dotId: "dot1",
  trustedTransport: true,
  media: {
    async downloadImage(imageKey) {
      // 与 daemon 的 makeFeishuMedia 同形：取 token -> 下载 -> 交给容器 fs.write
      const tokRes = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
        method: "POST", headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: process.env.FEISHU_APP_ID, app_secret: process.env.FEISHU_APP_SECRET }),
      });
      const tj = await tokRes.json();
      if (tj.code !== 0) return { ok: false, error: "token 失败" };
      const r = await fetch("https://open.feishu.cn/open-apis/im/v1/images/" + encodeURIComponent(imageKey),
        { headers: { authorization: "Bearer " + tj.tenant_access_token } });
      if (!r.ok) return { ok: false, error: "HTTP " + r.status };
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 100) return { ok: false, error: "空图片" };
      const rel = "media/" + imageKey.replace(/[^A-Za-z0-9_-]/g, "_") + ".png";
      return { ok: true, media: { path: rel, sizeBytes: buf.length, contentType: "image/png" } };
    },
  },
});
console.log("httpStatus:", out.httpStatus);
console.log("body:", JSON.stringify(out.body).slice(0, 150));
console.log();
console.log("提交的任务数:", submitted.length);
if (submitted[0]) {
  console.log("任务标题:", submitted[0].title);
  console.log("任务目标:");
  console.log(submitted[0].goal.split("\n").map(l => "  " + l).join("\n"));
}
db.close();
' 2>&1 | head -25
