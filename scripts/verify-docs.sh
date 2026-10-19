#!/usr/bin/env bash
# 端到端验证：模型能否自己读 PDF / Excel
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json; charset=utf-8")

CID=$(docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)

echo "=== 准备测试文档 ==="
docker exec "$CID" sh -c 'python3 - <<PY
# 一个内容清楚的 PDF
text = "Quarterly Report Q3 2026: Revenue 1,250,000 CNY, Growth 18 percent"
stream = f"BT /F1 14 Tf 30 700 Td ({text}) Tj ET".encode()
pdf = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length " + str(len(stream)).encode() + b">>stream\n" + stream + b"\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R/Size 6>>\n%%EOF"
open("/dot/home/report.pdf","wb").write(pdf)

# 一个表格清楚的 xlsx
import zipfile
files = {
    "[Content_Types].xml": "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"xml\" ContentType=\"application/xml\"/></Types>",
    "xl/workbook.xml": "<?xml version=\"1.0\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheets><sheet name=\"S1\" sheetId=\"1\"/></sheets></workbook>",
    "xl/worksheets/sheet1.xml": "<?xml version=\"1.0\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData><row r=\"1\"><c r=\"A1\" t=\"inlineStr\"><is><t>部门</t></is></c><c r=\"B1\" t=\"inlineStr\"><is><t>销售额</t></is></c></row><row r=\"2\"><c r=\"A2\" t=\"inlineStr\"><is><t>华东</t></is></c><c r=\"B2\"><v>880000</v></c></row><row r=\"3\"><c r=\"A3\" t=\"inlineStr\"><is><t>华南</t></is></c><c r=\"B3\"><v>370000</v></c></row></sheetData></worksheet>",
}
with zipfile.ZipFile("/dot/home/sales.xlsx","w") as z:
    for k,v in files.items(): z.writestr(k,v)
print("  已生成 report.pdf 与 sales.xlsx")
PY' 2>&1 | head -3

echo
echo "=== 提交任务：读 PDF 和 Excel ==="
BODY=$(node -e 'process.stdout.write(JSON.stringify({text: process.argv[1]}))' \
  "家目录里有两个文件：report.pdf 和 sales.xlsx。请读出它们的内容：report.pdf 里的营收数据，以及 sales.xlsx 里各部门的销售额和总和。")
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
echo "=== 工具调用 ==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const rows = db.prepare("SELECT tool_name,status FROM steps WHERE task_id=? AND kind=?").all(process.argv[1],"tool");
console.log("  " + rows.map(r=>r.tool_name+"="+r.status).join(", "));
db.close();' "$TID" 2>&1

echo
echo "=== 回答 ==="
node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1],"assistant","text");
console.log(m ? String(m.content).replace(/\s+/g," ").slice(0,400) : "(无)");
db.close();' "$TID" 2>&1
