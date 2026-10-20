#!/usr/bin/env bash
# scripts/regress/card-criteria.sh —— T3 飞书审批卡片的硬判据
#
# 用法：bash scripts/regress/card-criteria.sh
#   exit 0 = 全部通过    exit 1 = 有判据失败    exit 2 = 脚本崩了
#
# 判据分三层：
#   A. 卡片能造出来（结构对、信息全）—— tests/approval-card.test.ts
#   B. 回调能解析且鉴权生效            —— 同上
#   C. 装配层真的接上了                —— 查代码 + 隔离实例启动日志

set -uo pipefail
REPO="${DOTD_REPO:-/root/dotd}"
cd "$REPO" || { echo "  找不到 $REPO"; exit 2; }

P=0
F=0
t() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '  \033[32mPASS\033[0m %s\n' "$name"
    P=$((P+1))
  else
    printf '  \033[31mFAIL\033[0m %s\n' "$name"
    F=$((F+1))
  fi
}

echo ""
echo "════ T3 飞书审批卡片验收 ════"
echo ""

# ── A/B. 单元判据（48 条在测试文件里）────────────────────────
t "卡片模块存在"                      test -f src/surfaces/feishu-card.ts
t "审批接线模块存在"                  test -f src/surfaces/feishu-approval.ts
t "测试文件存在"                      test -f tests/approval-card.test.ts

CARD=$(node --import tsx tests/approval-card.test.ts 2>&1 | grep -oE '合计 [0-9]+ 通过 / [0-9]+ 失败' | tail -1)
t "卡片单元判据 48 条全过"            test "$CARD" = "合计 48 通过 / 0 失败"

# ── C. 装配层接线 ─────────────────────────────────────────────
t "channels 有 sendCard"              grep -q 'async sendCard' src/surfaces/channels.ts
t "channels 有 updateCard"            grep -q 'async updateCard' src/surfaces/channels.ts
t "卡片用 interactive 类型"           grep -q "msg_type: 'interactive'" src/surfaces/channels.ts
t "daemon 把卡片能力注入 outbound"    grep -q 'approvalCardSender' src/daemon.ts
t "daemon 传给 startFeishuOutbound"   grep -q 'approvalCards: approvalCardSender' src/daemon.ts
t "outbound 有卡片接口"               grep -q 'approvalCards?:' src/surfaces/feishu-outbound.ts
t "卡片发送落库（可事后查）"          grep -q "kind: 'approval_card'" src/surfaces/feishu-outbound.ts
t "入站识别 card.action.trigger"      grep -q "card.action.trigger" src/surfaces/feishu-inbound.ts
t "卡片回调不过事件流（走 card_action）" grep -q "kind: 'card_action'" src/surfaces/feishu-inbound.ts

# 关键安全判据：卡片回调必须也过主人闸门
t "卡片回调过主人闸门"                grep -q '拒卡片回调' src/surfaces/feishu-inbound.ts
# 关键安全判据：超时必须按拒绝
t "卡片写明超时按拒绝"                grep -q '按拒绝处理' src/surfaces/feishu-card.ts
# 关键：落定后必须改卡片（否则重复点）
t "落定后改卡片去按钮"                grep -q 'buildResolvedCard' src/surfaces/feishu-approval.ts

# **防重复推送**（实测踩过：两个订阅者会让同一条审批推两次）
SUBS=$(grep -rn 'bus\.on.*approval:created' src/ --include=*.ts | grep -v test | wc -l | tr -d ' ')
t "approval:created 只有 1 个订阅者"   test "$SUBS" = "1"
t "卡片走 claimAndSend 去重"          grep -q 'cardView !== undefined && cards !== undefined' src/surfaces/feishu-outbound.ts
t "卡片失败退回纯文本"                grep -q '改发纯文本' src/surfaces/feishu-outbound.ts

# ── D. 类型检查 ───────────────────────────────────────────────
TSC=$(npx tsc --noEmit 2>&1 | grep -v 'exec-state' | grep -c 'error TS')
t "tsc 无新增错误"                    test "$TSC" = "0"

# ── E. 卡片真的能走通 HTTP 层（用假飞书服务器验，不碰真凭据）────
#
# 为什么不用真实例：依赖 9 个环境变量 + 等 26 秒，太脆（写这条时踩了两次）。
# 改成一个自包含的验证：本文件后面接一段 tsx 脚本，
# 起一个假的飞书 HTTP 服务，让 FeishuGateway 真的发一次卡片，
# 断言"发出去的 JSON 里 msg_type 是 interactive、按钮 value 带 approvalId"。
cat > .vg-card-http.ts <<'NODE'
import { createServer } from 'node:http';
import { FeishuGateway } from './src/surfaces/channels.ts';
import { buildApprovalCard } from './src/surfaces/feishu-card.ts';
import type { ApprovalView } from './src/shared/contracts.ts';

const view: ApprovalView = {
  id: 99,
  seq: 1,
  kind: 'tool_call',
  tier: 'dangerous',
  status: 'pending',
  summary: 'mail.send：给 a@b.com 发信',
  fullParams: { tool: 'mail.send', to: ['a@b.com'], subject: '测试' },
  reason: '对外发送',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  taskRef: { taskId: 'tk_1', journalStepId: 'st_1' },
};

let captured: { msgType?: string; content?: string } = {};
const srv = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    // token 端点
    if (req.url?.includes('tenant_access_token')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 0, tenant_access_token: 'fake', expire: 7200 }));
      return;
    }
    // 发消息端点
    try {
      const j = JSON.parse(body) as { msg_type?: string; content?: string };
      captured = { msgType: j.msg_type, content: j.content };
    } catch {
      captured = {};
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { message_id: 'om_test_1' } }));
  });
});

await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
const port = (srv.address() as { port: number }).port;

const gw = new FeishuGateway({
  appId: 'x',
  appSecret: 'y',
  encryptKey: '',
  verificationToken: '',
  ownerChatId: 'oc_1',
  apiBase: `http://127.0.0.1:${port}`,
  editThrottleMs: 0,
});

const r = await gw.sendCard('oc_1', buildApprovalCard(view));
let ok = 0;
let bad = 0;
const chk = (c: boolean) => (c ? ok++ : bad++);

chk(r.ok);
chk(captured.msgType === 'interactive');
// 注意：按钮 value 是**字符串化的 JSON**，嵌在卡片 JSON 里时引号被转义成 \"。
// 直接找 '"approvalId":99' 是找不到的 —— 这是写这条断言的第一个坑。
chk(typeof captured.content === 'string' && captured.content.includes('approvalId'));
chk(typeof captured.content === 'string' && captured.content.includes('approve'));
chk(typeof captured.content === 'string' && captured.content.includes('reject'));
chk(typeof captured.content === 'string' && captured.content.includes('99'));
chk(typeof captured.content === 'string' && captured.content.includes('同意'));
chk(typeof captured.content === 'string' && captured.content.includes('拒绝'));
chk(r.messageId === 'om_test_1');

srv.close();
console.log(bad === 0 ? 'OK' : 'BAD ' + bad);
process.exit(bad === 0 ? 0 : 1);
NODE
HTTP_CARD=$(node --import tsx .vg-card-http.ts 2>&1 | tail -1)
rm -f .vg-card-http.ts
t "卡片真的发到 HTTP 层（interactive + 按钮 value）" test "$HTTP_CARD" = "OK"

echo ""
echo "  合计 $P 通过 / $F 失败"
[ "$F" = "0" ] && exit 0 || exit 1