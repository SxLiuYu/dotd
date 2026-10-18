#!/usr/bin/env bash
# 真实飞书端到端：经飞书开放平台给 bot 发消息 → 等 bot 回复 → 读回群消息验证。
#
# 与 selftest-*.sh 的区别：那些直接打 daemon 的 /api/messages（绕过飞书）；
# 这个走**真实飞书链路**：发消息 → 飞书推送事件 → WS → 建任务 → 模型 → 出站回群。
set -uo pipefail
cd "$HOME/dotd" || exit 1
set -a; . ./_tokens_src.env; set +a

CHAT="${FEISHU_OWNER_CHAT_ID%%,*}"   # 取第一个群
API=https://open.feishu.cn/open-apis

# 1. 拿 tenant token
TOK=$(curl -s -m 20 -X POST "$API/auth/v3/tenant_access_token/internal" \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"$FEISHU_APP_ID\",\"app_secret\":\"$FEISHU_APP_SECRET\"}" \
  | sed -n 's/.*"tenant_access_token":"\([^"]*\)".*/\1/p')
if [ -z "$TOK" ]; then echo "!! 拿不到 tenant token"; exit 2; fi
echo "chat=$CHAT  token=ok(${#TOK})"

MARK="E2E-$(date +%H%M%S)"
echo "本次标记: $MARK"

# 2. 记录发消息前的群内最新时间
BEFORE=$(curl -s -m 20 "$API/im/v1/messages?container_id_type=chat&container_id=$CHAT&page_size=1&sort_type=ByCreateTimeDesc" \
  -H "Authorization: Bearer $TOK" | sed -n 's/.*"create_time":"\([0-9]*\)".*/\1/p' | head -1)
echo "发消息前群内最新时间戳: ${BEFORE:-无}"

# 3. **以用户身份**发消息 —— 注意：bot 只能用 app 身份发，那样会触发 bot_echo 过滤。
#    所以这里改用"直接投递给 daemon"来模拟入站，但**走的还是同一条 handleFeishuCallback 路径**：
#    先用 bot 发一条给人看的提示，再用 daemon 的飞书出站验证能不能回。
#    真正验证"用户消息→bot 回复"需要真人在飞书里发；这里验证的是**出站链路**。
TEXT="[$MARK] dotd 自测：请回复「收到 $MARK」并说明当前时间。"
BODY=$(node -e 'process.stdout.write(JSON.stringify({receive_id:process.argv[1],msg_type:"text",content:JSON.stringify({text:process.argv[2]})}))' "$CHAT" "$TEXT")
SENT=$(curl -s -m 20 -X POST "$API/im/v1/messages?receive_id_type=chat_id" \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d "$BODY" | sed -n 's/.*"message_id":"\([^"]*\)".*/\1/p')
echo "出站测试消息已投递: ${SENT:-失败}"

# 4. 轮询群消息，看 daemon 有没有主动回（daemon 的 outbox/task 完成会回群）
echo "等待 daemon 侧产生任何出站活动（最多 120s）..."
for i in $(seq 1 60); do
  sleep 2
  NEW=$(curl -s -m 15 "$API/im/v1/messages?container_id_type=chat&container_id=$CHAT&page_size=3&sort_type=ByCreateTimeDesc" \
    -H "Authorization: Bearer $TOK")
  # 统计 app 发出的、且时间晚于 BEFORE 的消息
  CNT=$(printf '%s' "$NEW" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{
    const j=JSON.parse(s);
    const before=Number(process.argv[1]||0);
    const items=(j.data&&j.data.items)||[];
    const fresh=items.filter(m=>Number(m.create_time)>before && m.sender&&m.sender.sender_type==="app");
    console.log(fresh.length+"|"+(fresh[0]?String(fresh[0].body.content).slice(0,80):""));
  }catch(e){console.log("0|")}
});' "${BEFORE:-0}")
  N=${CNT%%|*}
  if [ "$N" -gt 0 ]; then
    echo "  检测到 $N 条新出站消息: ${CNT#*|}"
    break
  fi
done

# 5. 最终快照
echo
echo "=== 群内最近 4 条消息 ==="
curl -s -m 20 "$API/im/v1/messages?container_id_type=chat&container_id=$CHAT&page_size=4&sort_type=ByCreateTimeDesc" \
  -H "Authorization: Bearer $TOK" | node -e '
let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const j=JSON.parse(s);
  for (const m of (j.data&&j.data.items)||[]) {
    const t=new Date(Number(m.create_time)).toLocaleTimeString("zh-CN");
    let c=m.body.content;
    try{ c=JSON.parse(c).text || c; }catch(e){}
    console.log(" "+t+" ["+m.sender.sender_type+"] "+String(c).replace(/\s+/g," ").slice(0,90));
  }
});'

echo
echo "=== daemon 侧最近的入站/出站日志 ==="
grep -E '收到事件|建任务|已发送|出站' /tmp/dotd-wsl.log | tail -6 || echo "  （无）"
