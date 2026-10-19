#!/usr/bin/env bash
# 真实验证：飞书文件消息能下载并交给模型处理
#
# 手法：上传一个真实 PDF 到飞书 → 拿到 file_key + message_id →
# 构造事件信封喂给 handleFeishuCallback（生产路径）→ 检查文件是否落到 home 且内容正确。
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a

CHAT="${FEISHU_OWNER_CHAT_ID%%,*}"
TOK=$(curl -s -m 20 -X POST "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"$FEISHU_APP_ID\",\"app_secret\":\"$FEISHU_APP_SECRET\"}" \
  | sed -n 's/.*"tenant_access_token":"\([^"]*\)".*/\1/p')
echo "token=${#TOK}"

echo
echo "=== 1. 造一个 PDF ==="
python3 - <<'PY'
text = "Feishu File Test: Total 98765 CNY"
stream = f"BT /F1 14 Tf 30 700 Td ({text}) Tj ET".encode()
pdf = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
       b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
       b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n"
       b"4 0 obj<</Length " + str(len(stream)).encode() + b">>stream\n" + stream + b"\nendstream endobj\n"
       b"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n"
       b"trailer<</Root 1 0 R/Size 6>>\n%%EOF")
open("/tmp/feishu-test.pdf","wb").write(pdf)
print(f"  PDF: {len(pdf)} 字节")
PY

echo
echo "=== 2. 上传到飞书拿 file_key ==="
UP=$(curl -s -m 30 -X POST "https://open.feishu.cn/open-apis/im/v1/files" \
  -H "Authorization: Bearer $TOK" \
  -F "file_type=pdf" -F "file_name=feishu-test.pdf" \
  -F "file=@/tmp/feishu-test.pdf;type=application/pdf")
FKEY=$(printf '%s' "$UP" | sed -n 's/.*"file_key":"\([^"]*\)".*/\1/p')
echo "  file_key=${FKEY:-失败}"
[ -z "$FKEY" ] && { echo "  上传响应: $(printf '%s' "$UP" | head -c 250)"; exit 2; }

echo
echo "=== 3. 发一条文件消息（拿到 message_id）==="
BODY=$(node -e 'process.stdout.write(JSON.stringify({receive_id:process.argv[1],msg_type:"file",content:JSON.stringify({file_key:process.argv[2]})}))' "$CHAT" "$FKEY")
MSG=$(curl -s -m 20 -X POST "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id" \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' --data-binary "$BODY")
MID=$(printf '%s' "$MSG" | sed -n 's/.*"message_id":"\([^"]*\)".*/\1/p')
echo "  message_id=${MID:-失败}"

echo
echo "=== 4. 用生产路径处理这个文件消息 ==="
FKEY="$FKEY" MID="$MID" node --import tsx -e '
const { handleFeishuCallback } = await import("./src/surfaces/feishu-inbound.ts");
const { openDb } = await import("./db/conn.ts");

const db = openDb(process.env.HOME + "/.dotd/dotd.db");
const threads = new Map();
let n = 0;
const mem = {
  async openThread() { return "thr_file_test"; },
  async appendMessage(t, m) { threads.set(t, [...(threads.get(t) ?? []), m]); return { id: "m" + ++n, seq: n }; },
};
const submitted = [];
const cp = { submit(o) { submitted.push(o); return { id: "tk_file_test", status: "queued" }; } };

// 与 daemon 的 makeFeishuMedia 同形的 downloadFile
const cfg = { appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET };
const media = {
  async downloadImage() { return { ok: false, error: "not used" }; },
  async downloadFile(fileKey, fileName, messageId) {
    const tok = (await (await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    })).json()).tenant_access_token;
    const url = `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=file`;
    const r = await fetch(url, { headers: { authorization: "Bearer " + tok } });
    if (!r.ok) return { ok: false, error: "HTTP " + r.status };
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 10) return { ok: false, error: "空文件" };
    return { ok: true, media: { path: "media/" + fileName, sizeBytes: buf.length, contentType: "application/pdf", fileName } };
  },
};

const envelope = {
  schema: "2.0",
  header: { event_id: "ev_file_" + Date.now(), event_type: "im.message.receive_v1" },
  event: {
    message: {
      message_id: process.env.MID,
      chat_id: process.env.FEISHU_OWNER_CHAT_ID.split(",")[0],
      message_type: "file",
      content: JSON.stringify({ file_key: process.env.FKEY, file_name: "季度报告.pdf" }),
    },
    sender: { sender_type: "user" },
  },
};

const out = await handleFeishuCallback(envelope, {
  cp, mem, db, bus: { publish() {} },
  cfg: { ownerChatId: process.env.FEISHU_OWNER_CHAT_ID, appId: cfg.appId, appSecret: cfg.appSecret },
  dotId: "dot1", trustedTransport: true, media,
});
console.log("  httpStatus:", out.httpStatus);
console.log("  提交任务数:", submitted.length);
if (submitted[0]) {
  console.log("  任务目标:");
  console.log(submitted[0].goal.split("\n").map(l => "    " + l).join("\n"));
}
db.close();
' 2>&1 | head -20
