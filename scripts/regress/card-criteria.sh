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
t "卡片单元判据全过"            bash -c '[[ "$1" =~ 0\ 失败$ ]]' _ "$CARD"

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

# ── F. 多主人会话投递（B1 / F5，2026-10-22）──────────────────
#
# 现场：FEISHU_OWNER_CHAT_ID 配了两个 oc_ 会话（长度 71），出站三处写死
# split(',')[0] → 第二个会话永远收不到审批卡片，任务卡在 awaiting_approval
# 直到过期。入站闸门本来就是多会话 Set，所以这是纯出站缺陷。
#
# 判据分两组：
#   F-1 语义（我写的 feishu-approval.ts / feishu-outbound.ts）—— 现在就该全绿；
#   F-2 接线（daemon.ts，lead 独占写权限）—— **落盘前必红**，红着就说明
#       「广播函数写对了但装配层还在传第一个」这个半改状态没被放行。
# 两组都只断言**不变量**（不许出现截断模式 / 必须真的遍历发送），
# 不断言任何部署配置值（不把具体 chat id、会话个数写死）。

# ===== F-1 广播语义 =====
t "切换点存在：配置串 → 会话列表"      grep -q 'export function parseOwnerChatIds' src/surfaces/feishu-approval.ts
t "去重保序入口存在"                  grep -q 'export function dedupeChatIds' src/surfaces/feishu-approval.ts
t "广播版推送函数存在"                grep -q 'export async function pushApprovalCards' src/surfaces/feishu-approval.ts
t "遍历版改卡片函数存在"              grep -q 'export async function resolveApprovalCards' src/surfaces/feishu-approval.ts
# 一个 approvalId 现在对应 N 张卡片：旧单值 get() 就是 F5 本身，必须彻底消失，
# 否则装配层「编译通过但只改第一张」，其余会话挂着可点按钮 → 迟到裁决噪音。
t "CardRegistry 不再有单值 get()"      bash -c '! grep -qE "^  get\(" src/surfaces/feishu-approval.ts'
t "CardRegistry 提供 getMany 遍历口"   grep -q 'getMany(approvalId: number): string\[\]' src/surfaces/feishu-approval.ts
t "改卡片逐条 catch（一条挂不搞崩整批）" bash -c "grep -A40 'export async function resolveApprovalCards' src/surfaces/feishu-approval.ts | grep -q catch"
t "卡片能力接口是复数 chatIds"        grep -q 'chatIds: string\[\];' src/surfaces/feishu-outbound.ts
t "发送回调按会话逐个发"              grep -q 'send(view: ApprovalView, chatId: string)' src/surfaces/feishu-outbound.ts
t "兜底会话字段是复数"                grep -q 'fallbackChatIds?: string\[\];' src/surfaces/feishu-outbound.ts
t "复数字段优先（单值只作迁移桥）"      bash -c "sed -n '/const fallbackIds: string\[\] =/,/:\s*\[\];/p' src/surfaces/feishu-outbound.ts | head -3 | grep -q fallbackChatIds"
# 唯一投递决策点：有来源会话 → 只回那一个；没有 → 广播。这两行是分野本体。
t "投递决策点：有来源会话只回它自己"  bash -c "grep -q 'if (chatId !== null \&\& chatId.length > 0) return \[chatId\];' src/surfaces/feishu-outbound.ts"
t "投递决策点：无来源会话走广播"      grep -q 'const chats = deliveryChats(threadChat);' src/surfaces/feishu-outbound.ts
# **反向不变量**（B1 唯一禁止项）：主人 A 群问的话不能回答到 B 群。
# 回复路径只能经 deliveryChats 的分支，绝不许直接引用兜底列表。
t "回复路径禁止直接引用兜底列表"      bash -c "! sed -n '/async function taskStateText/,/approvalText(view/p' src/surfaces/feishu-outbound.ts | grep -q fallbackIds"
t "审批文本兜底保持单会话（免重复打扰）" grep -q 'return { chatIds: \[chatId\], text: renderApprovalCard' src/surfaces/feishu-outbound.ts
t "隔离通知走广播"                    bash -c "sed -n '/governance:quarantine/,/async function taskStateText/p' src/surfaces/feishu-outbound.ts | grep -q 'deliveryChats(null)'"
# 「函数对但没人调用」是本项目踩过的坑，所以钉循环体本身，不钉函数存在。
t "卡片循环真的逐个调 send"            bash -c "grep -A3 'for (const chatId of targets)' src/surfaces/feishu-outbound.ts | grep -q 'cards.send(cardView, chatId)'"
t "文本循环真的逐个调 sendText"        bash -c "grep -A3 'for (const chatId of targets)' src/surfaces/feishu-outbound.ts | grep -q 'deps.gateway.sendText(chatId, out.text)'"
# 广播后必须能回答「第二个群到底收到没有」→ 每个会话各一行审计。
t "卡片审计逐会话留痕"                bash -c "grep -A5 \"kind: 'approval_card'\" src/surfaces/feishu-outbound.ts | grep -q 'chatId,'"
t "文本审计逐会话留痕"                bash -c "grep -A5 \"kind: 'task_reply'\" src/surfaces/feishu-outbound.ts | grep -q 'chatId,'"
# 幂等键是整条事件而非「事件×会话」：广播在同一次认领里发完，重投整条跳过，
# 不会出现「只补发第二个会话、第一个会话发两遍」的半截状态。
t "幂等键是事件级（不是事件×会话级）"  bash -c "grep -B8 'async function claimAndSend' src/surfaces/feishu-outbound.ts | grep -q '幂等键是\*\*整条事件'"

# ===== F-2 装配层接线（daemon.ts = lead 独占写权限；未落盘时预期为红）=====
t "接线：daemon 用 parseOwnerChatIds 而非 split[0]"  bash -c "grep -q parseOwnerChatIds src/daemon.ts"
# 缺陷签名精确到「把逗号串 split 之后取第一个」。注意**不能**写成「ownerChatId
# 所在的行不许出现 [0]」—— 求救出站那一行本该取 parseOwnerChatIds(...)[0]（单值
# 语义，见下下条），那样写会和它自相矛盾，lead 改完仍是红、变成追不上真相的判据。
t "接线：daemon 里 ownerChatId 不再手切第一个"        bash -c "! grep -nE 'ownerChatId.{0,12}split[(]' src/daemon.ts | grep -qF '[0]'"
# 只钉**我自己的接口字段名**（chatIds / fallbackChatIds / getMany / resolveApprovalCards /
# parseOwnerChatIds），不钉 daemon 里的变量叫什么 —— 否则 lead 换个局部变量名就红，
# 判据就成了绊脚石而不是防线。
t "接线：daemon 把整份会话列表交给卡片能力"          bash -c "grep -q 'chatIds:' src/daemon.ts"
t "接线：daemon 落定卡片走 getMany 遍历"              bash -c "grep -q 'cardRegistry.getMany(' src/daemon.ts"
t "接线：daemon 调复数版 resolveApprovalCards"        bash -c "grep -q 'resolveApprovalCards(' src/daemon.ts"
t "接线：daemon 兜底通知传 fallbackChatIds"          bash -c "grep -q 'fallbackChatIds:' src/daemon.ts"
# 求救通道（src/surfaces/channels.ts 的 `feishuChatId?: string`）是**单值语义**：
# deliverFeishu 把入参原样塞进飞书 API 的 chat_id。把整串 'oc_a,oc_b' 传下去会 400
# → 求救静默降级到 OUTBOX.md，比「只发第一个」更糟。所以钉「交给单值口的必须是单个
# chat（行尾取 [0]）」。将来若真要广播求救，得先改 channels.ts 的接口成 chatIds: string[]
# （见我报给 lead 的 backlog），那时这条判据**连同 channels.ts 一起**改，不许只改 daemon.ts。
t "接线：求救出站交给单值口的必须是单个 chat"      bash -c "grep -qE 'feishuChatId:.*\[0\],' src/daemon.ts"

# ===== F-3 多会话投递的单元判据（真投递事件，不看源码）=====
MO=$(node --import tsx --test tests/feishu-owner-chats.test.ts 2>&1 | grep -aoE 'fail [0-9]+' | tail -1)
t "多主人会话投递判据全过"        bash -c '[[ "$1" = "fail 0" ]]' _ "$MO"
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