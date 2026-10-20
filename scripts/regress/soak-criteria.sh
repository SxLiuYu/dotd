#!/bin/bash
# 仓库根目录可覆盖（默认按脚本自身位置推断，不写死 /root/dotd —— 换台机器也能跑）
REPO="${DOTD_REPO:-$(cd "$(dirname "$0")/../.." && pwd)}"
cd "$REPO" || { echo "❌ 进不去仓库: $REPO"; exit 2; }
# 夹具目录（默认 /tmp；换机器时指向 snapshot 解开的位置）
FIX="${DOTD_FIXTURES:-/tmp}"
export FIX
p=0; f=0
t(){ local exp="$4"; SOAK_VERDICT=$FIX/rgv.jsonl SOAK="$1" DOTD_WATCHDOG_LOG="${2:-$FIX/nowd.log}" DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
  local e=$?; if [ "$e" = "$exp" ]; then p=$((p+1)); printf "  OK   %-30s\n" "$3";
  else f=$((f+1)); printf "  FAIL %-30s exit=%d 期望=%s\n" "$3" "$e" "$exp"; fi }
t $FIX/ok1.jsonl $FIX/nowd.log "健康8天" 0
t $FIX/unsorted.jsonl $FIX/nowd.log "乱序=同一份数据" 0
t $FIX/good.jsonl $FIX/nowd.log "探针均匀" 0
# **三条「重启循环」夹具的期望改了**（2026-10-20，新判据上线）。
#
# 本次加了「窗口内可用率 ≥99%」：`连续 7 天`的意思是**服务真的跑着**，
# 不是「每次崩溃都被 watchdog 拉起来」——后者只是没人插手，主人发消息照样没人应。
#
# 这三条夹具的构造本来就是重启循环：
#   · ok2        31 次自愈      → 可用率 91.9%（停机 15.5h / 192h）
#   · sl_stable  160 段 × 1.2h  → 可用率 83.4%（停机 31.8h / 192h）
#   · sl_warm    160 段 × 1.2h  → 可用率 83.4%
# 它们当年期望 exit 0 是有道理的：那时这几条只是**陪跑**，用来验「RSS 斜率不出假红」，
# 而「可用率」这条判据当时根本不存在。
#
# 现在它们必须红 —— 而**这才是对的**：每 1.2 小时崩一次的 7 天不是「长期运行」。
# 期望值改为 1，且各自断言「红的理由必须是可用率，不是别的」。
t $FIX/ok2.jsonl $FIX/ok2wd.log "31次自愈(可用率)" 1
t $FIX/pok.jsonl $FIX/nowd.log "探针全过" 0
t $FIX/corrupt.jsonl $FIX/nowd.log "一行残缺" 0
t $FIX/nr.jsonl $FIX/wd1.log "重启有daemon记录" 0
t $FIX/sl_stable.jsonl $FIX/sl_stable.jsonl.wd "短生命周期稳定(可用率)" 1
t $FIX/sl_warm.jsonl $FIX/sl_warm.jsonl.wd "短生命周期预热后平(可用率)" 1
# **每 5 段有 1 段在爬，必须红 —— 原来期望 0 是错的**（2026-10-20）
# 夹具事实：160 段、每段 1 小时，其中 32 段 RSS 是 `200 → 208 → 217` 单调爬升。
# 不是"开头跳一次然后持平"（那才是预热），是真的一路在涨。
# 而每次重启都回到 ~200 → 全窗口峰值只涨 8.3MB → 总量判据看不见。
# 这正是"频繁重启把泄漏截断"的真实形态，段内趋势判据就是为该场景存在的。
# 旧规则"段不足 2h 不追究"在**只有 1 段**时成立（无法对照），
# 但有 160 段时，32 段爬 / 128 段平 —— 这个对比本身就是证据。
# 所以改为：段数够多时看"有多少段在爬"（maxSegRate 进退出码），而不是取中位。
t $FIX/sl_rare.jsonl $FIX/sl_rare.jsonl.wd "每5段1段爬必须红" 1
t $FIX/sl_ok.jsonl $FIX/nowd.log "正常抖动5~25s" 0
t $FIX/sl_89.jsonl $FIX/nowd.log "一次89s上限内" 0
t $FIX/sl_44.jsonl $FIX/nowd.log "慢性44s中位内" 0
t $FIX/wantok.jsonl $FIX/nowd.log "slot与want正确配对" 0
# **container_ok 判据的正反例**（2026-10-20 补，真缺口）：
# 原来 14 个期望 exit=0 的夹具**全部不带 container_ok 字段**，
# 于是这条判据在回归里只被验证过"会变红"，从没被验证过"能变绿"。
# 万一它逻辑写反/恒假，7 天真实窗口会全红，而回归永远发现不了（第⑥类：样本没测它声称测的东西）。
t $FIX/ok7d.jsonl $FIX/nowd.log "7天+容器可执行全绿" 0
# **中途 WSL 重启 1 次、boot 自动拉起 → 必须算「无人干预」**（2026-10-20 补）。
# 现场：dotd-boot.sh 原来只在开头打一行带时间戳，正文全裸，
# 而 parseLog 只认 `YYYY-MM-DD HH:MM:SS <正文>` —— 解析出 0 行，
# boot 自愈证据在评估时根本不存在。7 天里只要 Windows 更新重启一次 WSL，
# 就会被判「找不到自愈记录」= 疑似人工干预，直接把验收打红。
# 已修：boot 脚本用 gawk strftime 给每行加时间戳。
# 这两个用例钉住「格式对 → 能认出是自愈」「格式缺 → 才判人工」。
t $FIX/bad7d_contok.jsonl $FIX/nowd.log "7天+容器可执行全0" 1
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/wslreboot.jsonl DOTD_WATCHDOG_LOG=$FIX/wslreboot.wd DOTD_BOOT_LOG=$FIX/dotd-boot.log bash scripts/soak.sh report >/dev/null 2>&1
[ "$?" = "0" ] && { p=$((p+1)); echo "  OK   WSL重启→boot拉起"; } || { f=$((f+1)); echo "  FAIL WSL重启→boot拉起"; }
t $FIX/wantlie.jsonl $FIX/nowd.log "slot对但want全是OK" 1
t $FIX/shortlife.jsonl $FIX/shortlife.wd "短生命周期每段漏4MB" 1
t $FIX/dupprobe.jsonl $FIX/nowd.log "8次探针每行写4遍" 1
t $FIX/slot0.jsonl $FIX/nowd.log "只有纯存活" 1
t $FIX/slow.jsonl $FIX/nowd.log "5s→115s慢到没法用" 1
t $FIX/sl_one.jsonl $FIX/nowd.log "一次95s" 1
t $FIX/sl_chronic.jsonl $FIX/nowd.log "慢性50s" 1
t $FIX/sl_tail.jsonl $FIX/nowd.log "末尾60s" 1
t $FIX/contdead.jsonl $FIX/nowd.log "容器末尾挂掉" 1
t $FIX/contdip3.jsonl $FIX/contok.wd "容器掉线有自愈" 1
t $FIX/contdip3.jsonl $FIX/empty.wd "容器掉线无自愈" 1
t $FIX/midfail2.jsonl $FIX/nowd.log "中间连错9次" 1
t $FIX/midfail.jsonl $FIX/nowd.log "中间连错14次" 1
t $FIX/hang.jsonl $FIX/nowd.log "daemon不响应" 1
t $FIX/mixfail.jsonl $FIX/nowd.log "混合失败归因" 1
t $FIX/crash.jsonl $FIX/crash.wd "崩溃循环" 1
t $FIX/dead2.jsonl $FIX/nowd.log "死6天活9天" 1
t $FIX/dead.jsonl $FIX/nowd.log "死7.96天" 1
t $FIX/late.jsonl $FIX/late.wd "漏200MB+重启" 1
t $FIX/fdlate8.jsonl $FIX/fd8.wd "fd漏30+重启" 1
t $FIX/m1.jsonl $FIX/m1.jsonl.wd "每段漏12MB" 1
t $FIX/fd2.jsonl $FIX/fd2.wd "fd每段漏" 1
t $FIX/s4.jsonl $FIX/nowd.log "6.9天" 1
t $FIX/g24.jsonl $FIX/nowd.log "24h断档" 1
t $FIX/s1.jsonl $FIX/nowd.log "采样停止" 1
t $FIX/sp2.jsonl $FIX/nowd.log "采样稀疏" 1
t $FIX/dup.jsonl $FIX/nowd.log "重复样本行" 1
t $FIX/future.jsonl $FIX/nowd.log "时间戳未来" 1
t $FIX/noprobe.jsonl $FIX/nowd.log "0次探针" 1
t $FIX/fewprobe.jsonl $FIX/nowd.log "5次探针" 1
t $FIX/front.jsonl $FIX/nowd.log "探针全在头1天" 1
t $FIX/front3.jsonl $FIX/nowd.log "只测头1.5天" 1
t $FIX/allold.jsonl $FIX/nowd.log "只有旧探针" 1
t $FIX/degr3.jsonl $FIX/nowd.log "末尾8次全错" 1
t $FIX/degr2.jsonl $FIX/nowd.log "末尾2次全错" 1
t $FIX/degr.jsonl $FIX/nowd.log "末尾1.5天全错" 1
t $FIX/pbad.jsonl $FIX/nowd.log "探针全失败" 1
t $FIX/g1.jsonl $FIX/nowd.log "出站失败" 1
t $FIX/g2.jsonl $FIX/nowd.log "入站断开" 1
t $FIX/nr.jsonl $FIX/nowd.log "重启无日志" 1
t $FIX/nr.jsonl $FIX/onlyrelay.wd "只有relay恢复" 1
t $FIX/nr.jsonl $FIX/onlycont.wd "只有容器恢复" 1
t $FIX/nr.jsonl $FIX/onlydocker.wd "只有docker恢复" 1
t $FIX/nr.jsonl $FIX/failed.wd "daemon重启失败" 1
SC(){ SOAK_VERDICT=$FIX/rgv.jsonl SOAK="$1" SOAK_DAY0="$2" DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report; }
SC $FIX/reset.jsonl $FIX/day0-reset.txt >/dev/null 2>&1
[ "$?" = "1" ] && { p=$((p+1)); echo "  OK   数据清空重来(晚72h)"; } || { f=$((f+1)); echo "  FAIL 数据清空重来(晚72h)"; }
SC $FIX/ok1.jsonl $FIX/day0-ok.txt >/dev/null 2>&1
[ "$?" = "0" ] && { p=$((p+1)); echo "  OK   day0与数据一致"; } || { f=$((f+1)); echo "  FAIL day0与数据一致"; }
SC $FIX/ok1.jsonl $FIX/day0-late.txt >/dev/null 2>&1
[ "$?" = "1" ] && { p=$((p+1)); echo "  OK   day0比数据还晚"; } || { f=$((f+1)); echo "  FAIL day0比数据还晚"; }

# **中途 WSL 重启 1 次、boot 自动拉起 → 必须算「无人干预」**（2026-10-20 补）
_tboot(){ SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/oneboot.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG="$1" bash scripts/soak.sh report >/dev/null 2>&1
  local e=$?; if [ "$e" = "$2" ]; then p=$((p+1)); printf "  OK   %-30s\n" "$3";
  else f=$((f+1)); printf "  FAIL %-30s exit=%d 期望=%s\n" "$3" "$e" "$2"; fi }
_tboot $FIX/oneboot-boot.log 0 "中途WSL重启boot自愈"
_tboot $FIX/oneboot-nolog.log 1 "重启无boot记录=人工"


# **probe 撞 sample 造成的 fd 污染**（2026-10-20 补）
# 现场：soak.jsonl 里出现 fd=31，daemon 静息一直 27。
# probe 要发飞书消息并等 done，期间 daemon 开 HTTP 连接，实测 fd 27→30，结束回落。
# 而 cron 里 sample 在 :00/:30、probe 在 0 */6（也是 :00）—— 每 6 小时必撞，7 天 28 次。
# 已修：① probe 挪到 :15；② sample 发现 probe 在跑就跳过（宁缺不脏）。
# 这两个用例钉住「干净数据必须绿」和「污染必须红」，防止修反了或修成了恒绿。
t $FIX/clean7d.jsonl $FIX/nowd.log "7天fd干净全27" 0

# **7 天里周期性自愈重启，不该被判成"人工干预"**（2026-10-20 补）
# 判据原文只要求"连续 7 天无人工干预"，没规定重启频率。
# 阈值定 1 小时（非崩溃循环）是刻意的：watchdog 本来就该干活，
# 不能因为它在干活就判失败；但"每 30 分钟死一次"也不能算稳定。
# 现有回归只有 crash.jsonl（每 30 分钟一次，被判崩溃循环），
# **缺一个"重启但不频繁"的正例** —— 第⑪类：反例齐了，正例没有。
# 现场数据：7 天重启 6 次、每次存活约 28h，全部 watchdog 自愈 → 必须 exit 0。
t $FIX/killed7d.jsonl $FIX/killed7d.wd "7天中途kill一次自愈" 0
t $FIX/dirty7d.jsonl $FIX/nowd.log "7天fd末段污染到30" 1


# **"观测不连续" ≠ "服务不连续"**（2026-10-20 补，真误报）
# 现场：造「7 天里 daemon 停 1.9 小时」—— 没超 2h 阈值，却被判
# ❌ 观测不连续：最长空档 2.50h 而失败。
# 原因：alive=false 的采样行没有 pid/proc_start，被 all 过滤掉，
# 那 1.9 小时在时间轴上凭空变成空档。
# 但那段时间 cron 每 30 分钟都在跑、都记了 alive=false ——
# 观测是连续的，只是观测到了"坏"。
# 修：空档/采样密度改用 lines（含 alive=false）；服务不可用仍由 deadTotal 单独判。
# 这三个用例钉住：①服务坏但有人在看 → 不误报观测；②真缺失 → 必须报观测；③严重服务坏 → 仍红
t $FIX/dead19h.jsonl $FIX/nowd.log "服务停1.9h但不误报观测" 0
t $FIX/dead25h.jsonl $FIX/nowd.log "服务停2.5h只报服务不可用" 1
t $FIX/realskip.jsonl $FIX/nowd.log "cron真缺失3h必须报观测" 1


# **"还没开始采样" ≠ "采了 7 天但服务全程不在"**（2026-10-20 补）
# 现场：造「7 天里 daemon 从第一天起就死着、cron 每 30 分钟记 alive=false」——
# 判红是对的（exit 1），但理由是错的：原来只说
#   「还没有可用于判据的样本（无 pid 的历史样本 0 条已忽略）」
# 主人看到这句会去查「为什么没采样」，真相是「采了 337 次，每次都发现 daemon 不在」。
# 前者是"还没开始"，后者是"跑了 7 天、7 天全瘫" —— 处置完全不同。
t $FIX/dead7.jsonl $FIX/nowd.log "7天全死(不是没开始)" 1

# **"没测到"有两种写法，归因必须一致**（2026-10-20 补）
# 现场：7 个任务 status=done、答案也对，但主人什么都没收到 ——
# 任务全过程只有 tool_call、没有一句 kind='text' 正文，
# lastAssistantText() 返回 null，出站被静默跳过（feishu-outbound.ts L257）。
# 而 probe 这边 OUT_OK 只在"进了 done 分支并查过出站表"时才赋值，
# 没进分支就从未定义 → 落盘写成 "out":"" 。
# 结果"根本没检查"和"检查了但没发出去"在数据里长得一模一样。
# 修：显式初始化为 "?"（未测），并让归因函数 notTested 同时认 "" 和 "?"。
# 这两条钉住：两种写法必须给出**同样的归因**。
t $FIX/mark_empty.jsonl $FIX/nowd.log "out空串=没测到" 1
t $FIX/mark_q.jsonl $FIX/nowd.log "out问号=没测到" 1

# **短尾段不该吃"允许缺 1 段"的容差**（2026-10-20 补，S6 裁定时刻必踩）
# 旧代码用 `i*86400 <= spanSec` 生成段，跨度 7.0028 天 → 8 段，
# 第 7 段只有 240 秒。probe 每 6 小时才跑一次，**一个 4 分钟长的段
# 物理上不可能有 probe**，却被算进分母、还吃掉了唯一的容差：
# 「缺第 3 天」（设计明确允许）报成 `6/8 段` 判红。
# day0=03:25:20，我在 7 天后任意时刻裁定，尾段都不会正好落在段边界上。
# 尾段 < 6h 的比例是 6/24 = **25%** —— 任意时刻裁定有四分之一的概率被误杀。
# 修：段长 = min((i+1)*86400, span) - i*86400，只有 ≥6h 的段才计入分母。
t $FIX/segB2.jsonl $FIX/nowd.log "短尾段-缺1段应过" 0
t $FIX/segC2.jsonl $FIX/nowd.log "短尾段-缺2段应红" 1

# **report 不能只信采集时算的 ok，必须自己复核 out/ws**（2026-10-20 补，真假绿）
# 采集侧 do_probe 的逻辑是对的（out_ok!=1→ok=0、ws_ok!=1→ok=0），
# 但 report 原来只看 p.ok，从不看 out/ws 是否与它一致 →
# 采集侧算错时 report 一点都发现不了。而这类错已经发生过两次：
# ① case ... *) ok=1 兜底；② OUT_OK 未定义落盘成空串。
# 合成数据实测：29 次探针全部改成 out=0 ws=0（飞书两头全断），
# 只要 ok 仍是 true，report 打印「成功率 100%」并 exit 0。
# 也就是说"在飞书里干活"这个目标原话，在 report 侧没有独立证据。
t $FIX/inj_outall.jsonl $FIX/nowd.log "ok说通过但飞书全断" 1
t $FIX/inj_out.jsonl $FIX/nowd.log "12%探针没发到飞书" 1
t $FIX/inj_density.jsonl $FIX/nowd.log "探针密度53%" 1
t $FIX/inj_tail.jsonl $FIX/nowd.log "末尾探针掉一半" 1
t $FIX/inj_conttail.jsonl $FIX/nowd.log "末尾容器掉一半" 1
t $FIX/inj_contok.jsonl $FIX/nowd.log "容器能干活88%" 1
t $FIX/inj_secs.jsonl $FIX/nowd.log "探针中位50s" 1
t $FIX/rehearse.jsonl $FIX/nowd.log "健康7.05天全绿" 0

# **"判断不了"不能当成"通过"**（2026-10-20 补，又一条真假绿）
# 造 7 天完整窗口、337 个采样点全部没有 container_ok 字段，其余全健康：
# 报告打印「⚠ 容器可执行性：还没有任何采样点带 container_ok，这条判断不了
# （既不算通过也不算失败）」，然后 **exit 0**。
# 判据说"判断不了"，退出码说"通过" —— 两者互相矛盾。
# 而 container_ok 是后加的字段，采集侧任何一处失败，
# 7 天里 337 个点就会全都没有这个字段。而"容器活着、daemon 用不了它"
# 正是 S6 最严重的盲区（第 31 轮：容器 tools 死了 5 小时，所有判据全绿）。
# 修：days>=7 且 0 点时判失败；<7 天仍不判。措辞也分档。
t $FIX/nocontok.jsonl $FIX/nowd.log "7天没测过容器可执行" 1
t $FIX/fdpeak.jsonl $FIX/nowd.log "单段突发fd泄漏" 1

# **stale 要看"有没有人在看"，不是"有没有看到一个活的 daemon"**（2026-10-20 补）
# 第 45 轮已经把 gap/density 从 all 改成 observed（含 alive=false），但 stale 漏改，
# 还在用 last = all 的最后一条（已排除 alive=false）。
# 现场：7 天窗口、最后 3 小时 daemon 挂了（cron 每 30 分钟照跑、都记 alive=false），
# report 打出「❌ 观测已停止：最后一个样本在 3.00h 前」—— 这句话是错的，
# 有人一直在看，看到的全是"daemon 不在"。危害不只是措辞：看到"观测已停止"，
# 第一反应是查 cron 为什么不跑，真正原因（daemon 挂了）藏在另一条判据里。
# 改：用 observed 的最后一条。cron 真停了时 observed 同样陈旧，能力没丢。
t $FIX/taildead.jsonl $FIX/nowd.log "末尾daemon挂3h" 1
t $FIX/reallystale.jsonl $FIX/nowd.log "cron真停6h" 1
# **sample 中途崩掉要有后果**（2026-10-20 补，S6 真缺口）
# 现场：syslog 明确记录 03:30:01 cron 跑了 soak.sh sample，但 soak.jsonl 里没有那一条 ——
# 我当时正在反复改写 soak.sh，脚本短暂语法错，cron 的输出被 >/dev/null 2>&1 吞掉，什么都没留下。
# soak.jsonl 里"没记录"无法区分"cron 没跑"和"脚本被我改坏了"，而后者 7 天里最可能发生。
# 修：do_sample 开头无条件写心跳（start），结局写 ok/skip/dead；
# report 对账，只把"start 后无结局"当异常，>3 次判失败（和采样密度 30% 余量对齐）。
t $FIX/hang.jsonl $FIX/nowd.log "daemon大部分时间不在" 1
for N in 3 4; do
  node -e '
    const fs=require("fs");
    const now=Math.floor(Date.now()/1000), first=now-604800-3600;
    const WANT={0:"OK",1:"-55",2:"350",3:"2176782336"};
    const out=[];
    for(let t=first;t<=now;t+=1800)
      out.push({ts:t,alive:true,rss_kb:200000,fd:27,threads:11,container_up:1,container_ok:1,relay_up:1,http_ok:1,db_kb:17000,pid:999,proc_start:first,sv:"aaaaaaaa"});
    let k=0;
    for(let t=first+300;t<now;t+=21600){
      out.push({ts:t,kind:"probe",ok:true,taskId:"tk_"+k,status:"done",secs:8,slot:String(k%4),want:WANT[k%4],out:"1",ws:"1"});
      k++;
    }
    const N=process.argv[1];
    fs.writeFileSync("$FIX/hbh"+N+".jsonl", out.sort((a,b)=>a.ts-b.ts).map(x=>JSON.stringify(x)).join("\n")+"\n");
    const hb=[];
    for(let i=0;i<300;i++){ hb.push((first+i*1800)+" start pid="+(1000+i)); hb.push((first+i*1800+1)+" ok ts="+(first+i*1800)); }
    for(let i=0;i<Number(N);i++) hb.push((first+600000+i*1800)+" start pid="+(9000+i));
    fs.writeFileSync("$FIX/hbh"+N+".hb", hb.join("\n")+"\n");
  ' "$N"
  if [ "$N" = "3" ]; then exp=0; else exp=1; fi
  SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/hbh$N.jsonl SOAK_HB=$FIX/hbh$N.hb DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
  got=$?
  if [ "$got" = "$exp" ]; then p=$((p+1)); printf "  ok   %-28s exit=%s\n" "心跳无结局$N次" "$got";
  else f=$((f+1)); printf "  FAIL %-28s exit=%s 期望=%s\n" "心跳无结局$N次" "$got" "$exp"; fi
done

# 进行中的 start 不能算卡住：cron 在 :00/:30 跑 sample（约 0.3 秒），
# 若 report 恰好撞进那 0.3 秒，最后一行是 start、尚无结局 —— 那是正在进行，不是死了。
# 判别：start 距今 <120s 视为在飞。120s 足够宽（正常 0.3s、最慢约 5s），
# 又远小于采样间隔 1800s，不会把真卡住洗白。
node -e '
  const fs=require("fs");
  const now=Math.floor(Date.now()/1000), first=now-604800-3600;
  const WANT={0:"OK",1:"-55",2:"350",3:"2176782336"};
  const out=[];
  for(let t=first;t<=now;t+=1800)
    out.push({ts:t,alive:true,rss_kb:200000,fd:27,threads:11,container_up:1,container_ok:1,relay_up:1,http_ok:1,db_kb:17000,pid:999,proc_start:first,sv:"aaaaaaaa"});
  let k=0;
  for(let t=first+300;t<now;t+=21600){
    out.push({ts:t,kind:"probe",ok:true,taskId:"tk_"+k,status:"done",secs:8,slot:String(k%4),want:WANT[k%4],out:"1",ws:"1"});
    k++;
  }
  fs.writeFileSync("$FIX/inflight.jsonl", out.sort((a,b)=>a.ts-b.ts).map(x=>JSON.stringify(x)).join("\n")+"\n");
  const hb=[];
  for(let i=0;i<300;i++){ hb.push((first+i*1800)+" start pid="+(1000+i)); hb.push((first+i*1800+1)+" ok ts="+(first+i*1800)); }
  hb.push(now+" start pid=9999");
  fs.writeFileSync("$FIX/inflight.hb", hb.join("\n")+"\n");
'
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/inflight.jsonl SOAK_HB=$FIX/inflight.hb DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if [ $? = 0 ]; then p=$((p+1)); printf "  ok   %-28s exit=0\n" "心跳进行中不算卡"; else f=$((f+1)); printf "  FAIL %-28s\n" "心跳进行中不算卡"; fi

echo ""

# **证据的主体必须和被判的对象一致**（2026-10-20 补，真假绿）
# 容器掉线归因原来用 /容器已恢复|daemon 已恢复|daemon 就绪/ —— 后两项主体是 daemon。
# 而"daemon 恢复"和"容器恢复"是两件事：watchdog 重启 daemon 时容器根本没动。
# 合成数据：容器掉 90 分钟（低于 2h 阈值，contDownOk 抓不到），
# watchdog 里只有「daemon 已恢复」，一个字都没提容器 —— 容器其实是人工拉起来的，
# 报告却打印「（watchdog 自愈）」「全部有自愈记录」并 exit 0。
# 和第 5 轮修 relay/daemon 那处是同一个错（第③类：证据主体错配）。
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/contev2.jsonl DOTD_WATCHDOG_LOG=$FIX/contev2.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if [ $? = 1 ]; then p=$((p+1)); printf "  ok   %-28s exit=1\n" "容器自愈不能拿daemon顶"; else f=$((f+1)); printf "  FAIL %-28s\n" "容器自愈不能拿daemon顶"; fi
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/contev2.jsonl DOTD_WATCHDOG_LOG=$FIX/ce_ok.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if [ $? = 0 ]; then p=$((p+1)); printf "  ok   %-28s exit=0\n" "容器已恢复算自愈"; else f=$((f+1)); printf "  FAIL %-28s\n" "容器已恢复算自愈"; fi

# **"任务没跑完"和"跑完了没拿到子判据"必须分开报**（2026-10-20，第三变体）
# probe 在 done 分支才给 PROBE_SLOT/WANT/OUT_OK/WS_OK 赋值。若 120 秒内没到 done，
# 循环自然结束后仍写一行：ok=0、slot=""、out=""、ws=""、status 停在 queued/running。
# 原来归进 noChannel（"探针没拿到完整子判据"），措辞暗示是采集侧漏了字段 ——
# 而真相是任务根本没跑完，采集侧一点没漏。两者处置完全不同：
# 前者要改采集代码，后者要查服务为什么慢。
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/probetimeout.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if [ $? = 1 ]; then p=$((p+1)); printf "  ok   %-28s exit=1\n" "探针超时归因正确"; else f=$((f+1)); printf "  FAIL %-28s\n" "探针超时归因正确"; fi
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/probemiss.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if [ $? = 1 ]; then p=$((p+1)); printf "  ok   %-28s exit=1\n" "done但漏子判据仍报"; else f=$((f+1)); printf "  FAIL %-28s\n" "done但漏子判据仍报"; fi

# **基线绝不能取在峰值之后**（2026-10-20）
# 现场：窗口才 2 小时，报告同时打出两句互相矛盾的话 ——
#   「RSS: 首段中位 221.7MB → 末段中位 203.6MB，增长 -18.0MB」
#   「全窗口 RSS：基线 203.6MB → 最高 221.7MB，峰值增长 +18.0MB」
# 同一 daemon、同一批样本，一负一正。真实序列 221.7→201.9→202.0→203.6→203.6… 是启动尖峰衰减。
# 根因：baseSet = ts <= all[0].ts+7200，窗口不足 2 小时时吃下全部样本 →
# baseRss = 全体中位（203.6），而峰值在第一个点（221.7）—— 基线取在峰值之后。
# 双向说谎：尖峰衰减报假红；真泄漏从中位以下起步则基线被抬高、少报（假绿）。
# 修：基线窗口在峰值之前结束。
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/leak75.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if [ $? = 1 ]; then p=$((p+1)); printf "  ok   %-28s exit=1\n" "RSS真泄漏75MB仍红"; else f=$((f+1)); printf "  FAIL %-28s\n" "RSS真泄漏75MB仍红"; fi
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/spikeleak.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if [ $? = 1 ]; then p=$((p+1)); printf "  ok   %-28s exit=1\n" "尖峰后真泄漏不被洗白"; else f=$((f+1)); printf "  FAIL %-28s\n" "尖峰后真泄漏不被洗白"; fi
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/fdleak30.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if [ $? = 1 ]; then p=$((p+1)); printf "  ok   %-28s exit=1\n" "FD真泄漏30个仍红"; else f=$((f+1)); printf "  FAIL %-28s\n" "FD真泄漏30个仍红"; fi

# **"连续 7 天"不能要求"一个空档都没有"**（2026-10-20）
# 彩排一个"真实但健康"的 7 天窗口：337 点缺 12 个（96% 密度），
# 其中一次连丢 2 个（cron 抖动 1 小时）→ 空档 2.00h。
# 原来 GAP_LIMIT=1.5h，于是 ❌ 观测不连续、coveredDays 永远 <7 ——
# 7 天里只要任意一次连丢 3 个点（cron 停/我改脚本/机器睡 1.5h）就永久失去资格。
# 而 do_sample 的注释明说"28 次跳过 8.3%，仍在阈值内"。两处承诺不一致。
#
# 修：拆成两条 —— 单段空档管可观测性（GAP_LIMIT=2.5h 连丢 4 个点），
# 累积未观测单独 ≥2h 也红。之前想用**一个数**同时表达两件事，所以怎么调都错。
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/rehearse7.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if [ $? = 0 ]; then p=$((p+1)); printf "  ok   %-28s exit=0\n" "真实噪声7天彩排"; else f=$((f+1)); printf "  FAIL %-28s\n" "真实噪声7天彩排"; fi
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/gap4.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if [ $? = 1 ]; then p=$((p+1)); printf "  ok   %-28s exit=1\n" "停4h仍必须红"; else f=$((f+1)); printf "  FAIL %-28s\n" "停4h仍必须红"; fi

# **"答案不对"可能是容器坏了，不是模型笨**（2026-10-20）
# 探针只检查"回答里有没有期望值"。容器 quarantined/unhealthy 时模型回
# "没能完成：容器处于 quarantined 状态"，里面当然没期望值 → ok=0，
# 而 out/ws 都是 1（飞书链路好得很）→ 落进 noChannelOnly，
# 报告写「出站入站都正常但答案不对」。一个环境故障被说成能力问题。
# 真实数据佐证：历史上有 7 个探针任务在容器 quarantined 期间失败，
# 模型都正确说了"容器被隔离"，但报告措辞把人指向"模型答错"。
# 修：把失败探针的时间点与采样里的 container_ok/container_up 对齐。
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/contbad24h.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if [ $? = 1 ]; then p=$((p+1)); printf "  ok   %-28s exit=1\n" "容器坏时归因不赖模型"; else f=$((f+1)); printf "  FAIL %-28s\n" "容器坏时归因不赖模型"; fi
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/wrongans.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if [ $? = 1 ]; then p=$((p+1)); printf "  ok   %-28s exit=1\n" "容器好时仍报答案不对"; else f=$((f+1)); printf "  FAIL %-28s\n" "容器好时仍报答案不对"; fi

# **泄漏不能只看中位数：一段在漏，其余干净，中位会把它洗白**（2026-10-20）
# 现场（合成数据，实测 exit 0、报告全绿）：
#   3 段生命周期，前两段 RSS 稳 200MB（速率 0），第三段 3MB/h 在爬。
#   中位 = med([0,0,3]) = 0 → 「各生命周期内 RSS 无明显爬升」。
#   同时全窗口峰值只涨 22.5MB（第三段只 8 小时）< 50MB → 也绿。
#   两条判据同时漏，报告说"没有泄漏"，exit 0。
# 而 maxSegRate 早就算出来了（L1136），却只出现在打印里，从没进 process.exit ——
# 第⑤类（采集了却没用）叠第⑩类（不改退出码就等于不存在）。
# 为什么该用"任一段"而非"中位"：泄漏的本质是"跑得越久漏得越多"，
# 一个生命周期在漏就是真在漏，不会因为别的段干净就不算。
# 中位数在这里是错的统计量——它默认"多数段代表整体"，而故障恰恰是少数段的事。
# FD 侧同一个洞（maxSegFdRate 同样只打印），一并修。
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/medwash.jsonl DOTD_WATCHDOG_LOG=$FIX/medwash.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if [ $? = 1 ]; then p=$((p+1)); printf "  ok   %-28s exit=1\n" "中位洗白RSS泄漏必须红"; else f=$((f+1)); printf "  FAIL %-28s\n" "中位洗白RSS泄漏必须红"; fi
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/fdmedwash.jsonl DOTD_WATCHDOG_LOG=$FIX/fdmedwash.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if [ $? = 1 ]; then p=$((p+1)); printf "  ok   %-28s exit=1\n" "中位洗白FD泄漏必须红"; else f=$((f+1)); printf "  FAIL %-28s\n" "中位洗白FD泄漏必须红"; fi
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/rehearse7.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if [ $? = 0 ]; then p=$((p+1)); printf "  ok   %-28s exit=0\n" "健康2段仍绿"; else f=$((f+1)); printf "  FAIL %-28s\n" "健康2段仍绿"; fi

# **一份证据、两个结论：RSS 说"判断不了"，句柄说"✅ 没事"**（2026-10-20）
# 真窗口只有 1 段、去预热后 1.04 小时。RSS 侧老实说
#   「⚠ 现在还判断不了（证据不足：只有 1 段、且都不到 2 小时）」，
# 句柄侧却在同一份数据上写
#   「✅ 各生命周期内句柄无明显爬升（中位 0.00个/h、最高 0.00个/h）」。
# 第 14 轮那个坑（零证据被当成合格）在句柄侧原样复发：
# medSegFdRate 只要不是 null 就往下判，完全不看证据够不够。
# 修：句柄侧复用 RSS 的 segEvidence（long/multi/insufficient），
# 证据不足时同样打 ⏳ 并说明原因。
# 「不进退出码」本身是对的，但报告不能说 ✅ —— 说 ✅ 就是在替证据不足背书。
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/fd1ok.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/fd1ok.chk 2>&1
if grep -qa "句柄段内爬升：证据不足" $FIX/fd1ok.chk && ! grep -qa "✅ 各生命周期内句柄无明显爬升" $FIX/fd1ok.chk; then
  p=$((p+1)); printf "  ok   %-28s 三态一致\n" "句柄证据不足须打问号"
else f=$((f+1)); printf "  FAIL %-28s\n" "句柄证据不足须打问号"; fi
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/rehearse7.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/rh7.chk 2>&1
if grep -qa "✅ 各生命周期内句柄无明显爬升" $FIX/rh7.chk; then
  p=$((p+1)); printf "  ok   %-28s 有证据时照常判\n" "证据够时说结论"
else f=$((f+1)); printf "  FAIL %-28s\n" "证据够时说结论"; fi

# **空数据只 exit 1 不说原因 —— 违反脚本自己的契约**（2026-10-20）
# 喂一个空文件 / 不存在的路径，report 只打印一句话就 exit 1：
#   「还没有可用于判据的样本（无 pid 的历史样本 0 条已忽略）」
# 没有 `判定：` 行，没有 ❌ 标号，也没说哪条判据不过。
# 而正常路径永远以 `判定：❌…；✅…` + exit 收尾。
# **exit 1 必须能看到"哪条判据没过"** —— 一个只会 exit 1 而不说是谁的检查，
# 等于让人去猜；而这条路径恰恰最容易猜错（会去查 cron 而不是查路径）。
# 修：三种空数据情形各自标明判据名。
: > $FIX/emptyz.jsonl
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/emptyz.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/ez1.chk 2>&1
e=$?
if [ "$e" = "1" ] && grep -qa "判定：" $FIX/ez1.chk && grep -qa "一个采样点都没有" $FIX/ez1.chk; then
  p=$((p+1)); printf "  ok   %-28s 说清是哪条\n" "空文件须说原因"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "空文件须说原因" "$e"; fi
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/绝对不存在的路径.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/ez2.chk 2>&1
e=$?
if [ "$e" = "1" ] && grep -qa "先确认路径对不对" $FIX/ez2.chk; then
  p=$((p+1)); printf "  ok   %-28s 指向路径\n" "不存在的文件须提路径"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "不存在的文件须提路径" "$e"; fi
echo '{"ts":1792440000,"alive":true,"rss_kb":204800}' > $FIX/legacyz.jsonl
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/legacyz.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/ez3.chk 2>&1
e=$?
if [ "$e" = "1" ] && grep -qa "样本全是旧格式" $FIX/ez3.chk; then
  p=$((p+1)); printf "  ok   %-28s 指向采集\n" "旧格式须说采集问题"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "旧格式须说采集问题" "$e"; fi

# **判定行与退出码的双向一致性**（2026-10-20）
# 前面所有轮次都在查「判据有没有进 exit」。反过来没人查过：
#   "判定行里每个 ❌ 是否都真的让 exit 变红" + "exit 1 是否一定有 ❌"。
# 对 84 个 t 形式用例逐个跑，双向一致（这是当时的实测结论，钉住它别退化）。
# 另钉一件事：RSS 与句柄两侧的「证据不足」必须同时出现、措辞一致。
# 第 60 轮把句柄侧对齐到 RSS 门槛时漏了：RSS 自己还挂着 `days>=7`，
# 于是"1 段、去预热后 1 小时"这种真实早期窗口只有句柄侧报 ⚠，RSS 侧静默跳过。
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/medwash.jsonl DOTD_WATCHDOG_LOG=$FIX/medwash.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/tw1.chk 2>&1
e=$?; L1=$(grep -ao "判定：.*" $FIX/tw1.chk)
if [ "$e" = "1" ] && echo "$L1" | grep -qa "❌"; then
  p=$((p+1)); printf "  ok   %-28s exit与判定一致\n" "有❌必有exit1"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "有❌必有exit1" "$e"; fi
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/rehearse7.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/tw2.chk 2>&1
e=$?; L2=$(grep -ao "判定：.*" $FIX/tw2.chk)
if [ "$e" = "0" ] && ! echo "$L2" | grep -qa "❌"; then
  p=$((p+1)); printf "  ok   %-28s 无❌且exit0\n" "exit0则无❌"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "exit0则无❌" "$e"; fi

# **网关断了，报告说"模型答错了"**（2026-10-20）
# 第 58 轮修了"容器坏了赖模型"，靠把失败探针与 container_ok 对齐。
# 但通道还有一段没采：模型在 Windows，WSL 通过 win-relay(172.17.48.1:13065) 出去。
# 这条链断掉 → 探针必然全失败，而 out/ws 都是 1、容器也好 → 落进 answerWrong，
# 报告写「出站入站都正常、容器也好但答案不对」。模型根本没被问到。
# 合成实测（7 天、容器全程好、relay 断 14h）：3 次失败 →「3 次…但答案不对」，exit 1。
# 修：sample 每 30 分钟记 relay_up；归因时按探针前后 1 小时对齐。
# 关键：老样本没有 relay_up 字段（undefined）不能当 0 —— 那会把 7 天前的历史失败全怪到网关。
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/relaydown.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/rl1.chk 2>&1
e=$?
if [ "$e" = "1" ] && grep -qa "次当时网关不通" $FIX/rl1.chk && ! grep -qa "容器和网关也好但答案不对" $FIX/rl1.chk; then
  p=$((p+1)); printf "  ok   %-28s 归因指向网关\n" "网关断不赖模型"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "网关断不赖模型" "$e"; fi
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/answerwrong.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/rl2.chk 2>&1
e=$?
if [ "$e" = "1" ] && grep -qa "容器和网关也好但答案不对" $FIX/rl2.chk; then
  p=$((p+1)); printf "  ok   %-28s 网关好才谈答案\n" "网关好时仍报答案不对"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "网关好时仍报答案不对" "$e"; fi
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/norelayfield.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/rl3.chk 2>&1
e=$?
if [ "$e" = "1" ] && grep -qa "没有 relay_up 字段" $FIX/rl3.chk; then
  p=$((p+1)); printf "  ok   %-28s 老数据不背锅\n" "缺字段须说明缺证据"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "缺字段须说明缺证据" "$e"; fi

# **网关断了 6 小时，报告全绿、一次都没提到 relay**（2026-10-20）
# 第 63 轮给 sample 加了 relay_up 做归因，但那只影响措辞、不影响判定。
# 合成实测：7 天、网关断 6h、探针恰好全躲过去 → exit 0、报告全绿。
# 这是第⑤类（采集了却没用）最标准的形态：字段加了、归因用了、**判据没有**。
# 为什么必须判：网关断了 = 主人发的每条消息都到不了模型，
# 哪怕 daemon 活着、容器活着、RSS 平稳。比"容器不可执行"更彻底 ——
# 容器坏了至少还有模型能回一句"容器不可用"，网关断了连这句都发不出去。
# 口径照抄容器三条：连通率 ≥95%、最长连续断开 ≤2h、无字段时"判断不了"。
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/relaygap6h.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/rj1.chk 2>&1
e=$?
if [ "$e" = "1" ] && grep -qa "网关最长连续断开" $FIX/rj1.chk; then
  p=$((p+1)); printf "  ok   %-28s 6h中断必红\n" "网关断6h须判红"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "网关断6h须判红" "$e"; fi
# 注意：连通率只有 96.4%，靠"率"抓不到 6h/168h —— 真正抓它的是"最长连续断开"。
# 这两条判据各管一件事，缺一条就会漏。
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/relaydown.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/rj2.chk 2>&1
if grep -qa "网关最长连续断开" $FIX/rj2.chk && grep -qa "当时网关不通" $FIX/rj2.chk; then
  p=$((p+1)); printf "  ok   %-28s 判据+归因都在\n" "网关两条路径都要报"
else f=$((f+1)); printf "  FAIL %-28s\n" "网关两条路径都要报"; fi
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/rehearse7.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/rj3.chk 2>&1
e=$?
if [ "$e" = "0" ] && grep -qa "✅ 网关连通率" $FIX/rj3.chk; then
  p=$((p+1)); printf "  ok   %-28s 健康时打勾\n" "网关正常须打勾"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "网关正常须打勾" "$e"; fi

# **三个验收脚本的判定逻辑从来没被验证过**（2026-10-20）
# S3/S4/S5 的唯一证据来源就是这三个脚本，但回归里对它们的引用次数 = 0。
# 想验证"判定逻辑判得对不对"只能拿真证据去跑 —— 而脚本第一件事就是 `: > "$RESULTS"`
# 清空证据，recovery.sh 还会真的 kill -9 daemon。所以它们从没被验过。
# 修：加 `--judge` 只读判定入口 + `DOTD_ACCEPT_DIR` 覆盖目录（对照 soak.sh 的 SOAK=）。
# 另修两处真 bug：① 0 条证据时打印"❌ 未达标（还需 0 条）"/"⏳ 已验的 0 项全过"；
# ② `--judge` 打印完不 exit，继续往下跑真实场景并清空证据 ——
#    判定文字全对但退出码永远来自后面那轮真跑，且证据被自己吃掉。
# 三个验收脚本的判定逻辑从来没被验证过（2026-10-20）
# S3/S4/S5 的唯一证据来源就是这三个脚本，但回归里对它们的引用次数 = 0。
# 想验证"判定逻辑判得对不对"只能拿真证据去跑 —— 而脚本第一件事就是 `: > "$RESULTS"`
# 清空证据，recovery.sh 还会真的 kill -9 daemon。所以它们从没被验过。
# 修：加 `--judge` 只读判定入口 + `DOTD_ACCEPT_DIR` 覆盖目录（对照 soak.sh 的 SOAK=）。
# 另修两处真 bug：① 0 条证据时打印"❌ 未达标（还需 0 条）"/"⏳ 已验的 0 项全过"；
# ② `--judge` 打印完不 exit，继续往下跑真实场景并清空证据 ——
#    判定文字全对但退出码永远来自后面那轮真跑，且证据被自己吃掉。
#
# 注意：造夹具必须用独立脚本文件，不能在 heredoc 里拼 node -e 的引号串
# （上一版就是这么错的：$n 被吞成字面量 "+20+"，10 条全红）。
cat > $FIX/mkacc.mjs <<'EOJS'
import fs from "node:fs";
const [,,dir,file,n,ok,ids]=process.argv;
const N=Number(n), OK=Number(ok);
const L=[];
if(ids){
  for(let i=0;i<N;i++) L.push(JSON.stringify({id:ids.split(",")[i],pass:i<OK,secs:12,name:ids.split(",")[i],evidence:"x"}));
}else{
  for(let i=1;i<=N;i++) L.push(JSON.stringify({id:"c"+i,pass:i<=OK,secs:3,name:"c"+i}));
}
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(dir+"/"+file, L.join("\n")+(L.length?"\n":""));
EOJS
jud() { local sh="$1" n="$2" ok="$3" exp="$4" tag="$5" file="$6" ids="${7:-}";
  local d=$FIX/rt_$tag; rm -rf $d;
  node $FIX/mkacc.mjs "$d" "$file" "$n" "$ok" "$ids";
  DOTD_ACCEPT_DIR=$d bash scripts/$sh --judge >$FIX/rt.chk 2>&1; local e=$?;
  local left=$(wc -l < $d/$file 2>/dev/null || echo 0);
  if [ "$e" = "$exp" ] && [ "$left" = "$n" ]; then p=$((p+1)); printf "  ok   %-26s exit=%s 证据未动\n" "$tag" "$e";
  else f=$((f+1)); printf "  FAIL %-26s exit=%s 期望=%s 剩余=%s/%s\n" "$tag" "$e" "$exp" "$left" "$n"; fi; }
jud acceptance.sh 20 20 0 S3-20全过      results.jsonl
jud acceptance.sh 20 19 0 S3-19of20     results.jsonl
jud acceptance.sh 20 18 1 S3-18of20红    results.jsonl
jud acceptance.sh 1  1  3 S3-只跑1条     results.jsonl
jud honesty.sh    10 10 0 S4-10of10     honesty.jsonl
jud honesty.sh    10 9  1 S4-9of10红     honesty.jsonl
jud honesty.sh    3  3  3 S4-只跑3条     honesty.jsonl
jud recovery.sh   3  3  0 S5-3of3       recovery.jsonl container_stop,relay_down,daemon_kill
jud recovery.sh   3  2  1 S5-2of3红      recovery.jsonl container_stop,relay_down,daemon_kill
jud recovery.sh   2  2  3 S5-只验2项     recovery.jsonl container_stop,relay_down
# 0 条证据：必须是 ❌ 说"一条都没有"，不能说"还需 0 条"/"0 项全过"
for pair in "acceptance.sh:results.jsonl" "honesty.sh:honesty.jsonl" "recovery.sh:recovery.jsonl"; do
  sh=$(echo $pair|cut -d: -f1); fn=$(echo $pair|cut -d: -f2)
  d=$FIX/rt_zero_$sh; rm -rf $d; mkdir -p $d; : > $d/$fn
  DOTD_ACCEPT_DIR=$d bash scripts/$sh --judge >$FIX/rt.chk 2>&1; e=$?
  if [ "$e" = "1" ] && grep -qa "一条证据都没有" $FIX/rt.chk && ! grep -qa "还需 0 条" $FIX/rt.chk && ! grep -qa "的 0 项全过" $FIX/rt.chk && ! grep -qa "的 0 条全过" $FIX/rt.chk; then
    p=$((p+1)); printf "  ok   %-26s 空证据说实话\n" "零证据-${sh%%.sh}"
  else f=$((f+1)); printf "  FAIL %-26s exit=%s\n" "零证据-${sh%%.sh}" "$e"; fi
done

# **daemon 进程在，但服务不回 —— 报告全绿**（2026-10-20）
# 第 33 轮修了"容器活着但干不了活"，加 container_ok 直接打 endpoint。
# 但那个修法只管了容器，没管 daemon 自己：alive 只判断进程在不在。
# 死锁/事件循环卡住/busy-loop/SQLite 锁住 —— 进程好好的、RSS 正常、句柄正常，
# 但 HTTP 一个都不回，主人发的消息全部石沉大海。
# 合成实测（7 天、全程 alive=true、中间 10 小时 HTTP 打不通）：
#   报告全绿 exit 0，一次都没提到 http。因为 sample 里根本没这个字段。
# 口径与容器/网关完全一致：可达率 ≥95%、最长连续不可达 ≤2h、无字段时"判断不了"。
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/httpdead.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/ht1.chk 2>&1
e=$?
if [ "$e" = "1" ] && grep -qa "daemon 最长连续不可达" $FIX/ht1.chk; then
  p=$((p+1)); printf "  ok   %-28s 10h假死必红\n" "daemon假死须判红"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "daemon假死须判红" "$e"; fi
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/rehearse7.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/ht2.chk 2>&1
e=$?
if [ "$e" = "0" ] && grep -qa "✅ daemon 可达率" $FIX/ht2.chk; then
  p=$((p+1)); printf "  ok   %-28s 健康时打勾\n" "daemon可达须打勾"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "daemon可达须打勾" "$e"; fi
# 老数据没有 http_ok 字段：必须说"判断不了"，不能当 0（否则历史失败全被错怪）
node -e 'const fs=require("fs");const L=fs.readFileSync("$FIX/rehearse7.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse);for(const r of L) if(r.kind!=="probe") delete r.http_ok;fs.writeFileSync("$FIX/nohttp.jsonl",L.sort((a,b)=>a.ts-b.ts).map(x=>JSON.stringify(x)).join("\n")+"\n");'
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/nohttp.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/ht3.chk 2>&1
e=$?
    if [ "$e" != "0" ] && ! grep -qa "❌" $FIX/ht3.chk && grep -qa "判断不了" $FIX/ht3.chk; then
  p=$((p+1)); printf "  ok   %-28s 老数据不背锅\n" "缺http_ok不判死"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "缺http_ok不判死" "$e"; fi

# **「率」只覆盖窗口的 15%，却打了 ✅**（2026-10-20）
# 现场：7 天窗口里 relay_up 只在最后 1 天才开始采（49/337 点）。
# 报告写「✅ 网关连通率 100.0%（49 点）」—— 读者会以为 7 天都验过了，
# 实际只覆盖 1/7。剩下 6 天网关什么样，没人知道。
# 这不是措辞问题，是判据在替一段没测过的时间打勾。
# 而且在本项目里必然发生：soak.sh 在窗口期内改了 22 次，
# container_ok/relay_up/http_ok 全是中途加的。
# 修：① 渲染成 ⏳ 并写明覆盖百分比；② 覆盖率 <95% 且满 7 天 → 不进 ✅（判据不成立）。
# 但要能区分「字段后加」（老夹具本来就没这字段，不追究）和「采集坏了」。
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/halffield.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/cv1.chk 2>&1
e=$?
if [ "$e" = "1" ] && grep -qa "只覆盖 15% 的窗口" $FIX/cv1.chk && ! grep -qa "✅ 网关连通率" $FIX/cv1.chk; then
  p=$((p+1)); printf "  ok   %-28s 覆盖不足必红\n" "只看15%窗口须判红"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "只看15%窗口须判红" "$e"; fi
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/rehearse7.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/cv2.chk 2>&1
e=$?
if [ "$e" = "0" ] && grep -qa "覆盖 100% 窗口" $FIX/cv2.chk; then
  p=$((p+1)); printf "  ok   %-28s 覆盖满才打勾\n" "覆盖满时打勾"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "覆盖满时打勾" "$e"; fi
# 老夹具（relay_up/http_ok 加进来之前造的）：缺字段不能当"覆盖不足"判死
node -e 'const fs=require("fs");const L=fs.readFileSync("$FIX/rehearse7.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse);for(const r of L) if(r.kind!=="probe"){delete r.relay_up;delete r.http_ok;}fs.writeFileSync("$FIX/nocover.jsonl",L.sort((a,b)=>a.ts-b.ts).map(x=>JSON.stringify(x)).join("\n")+"\n");'
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/nocover.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/cv3.chk 2>&1
e=$?
    if [ "$e" != "0" ] && ! grep -qa "❌" $FIX/cv3.chk && grep -qa "判断不了" $FIX/cv3.chk; then
  p=$((p+1)); printf "  ok   %-28s 字段后加不误伤\n" "老夹具缺字段不判死"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "老夹具缺字段不判死" "$e"; fi

# **RSS 读失败写成 0，0 被当真实值**（2026-10-20）
# 采集侧原来 `awk ... || echo 0`：/proc/<pid>/status 读失败（进程刚退出、
# 采样撞上 exec 瞬间）就记 rss_kb: 0。而 0 在判据里是有效的极小值：
#   · 落在首尾 → "增长 200MB → 0MB"，还打印 ✅ RSS 增长 <50MB
#   · 落在末尾 → 段内斜率算出 -3.08MB/h（负数，"在释放内存"）
#   · 落在峰值 → 把真泄漏的峰值削平
# 合成实测：真泄漏 200→300MB + 最后 30 点读失败 →
#   同一份报告里 `✅ RSS 增长 <50MB` 与 `❌ 峰值增长 90.2MB` 同时出现，
#   还附一条 `⚠ 段内爬升 -3.08MB/h`。三个说法，两个是凭空来的。
# 修：① 采集侧读不到就不写字段（与 container_ok/relay_up 同一套"字段缺席"语义）；
#     ② 判据侧自己再筛一遍（rss_kb 必须存在且 >0）—— 不能只靠采集侧改，老数据照样骗人。
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/rsszero2.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/rz1.chk 2>&1
e=$?
if [ "$e" = "1" ] && grep -qa "峰值增长 90" $FIX/rz1.chk; then
  p=$((p+1)); printf "  ok   %-28s 0不当真实值\n" "RSS读失败不算0"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "RSS读失败不算0" "$e"; fi
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/rsszero.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/rz2.chk 2>&1
e=$?
if [ "$e" = "0" ] && ! grep -qa "增长 -" $FIX/rz2.chk; then
  p=$((p+1)); printf "  ok   %-28s 平坦仍绿\n" "RSS平坦不被0搅乱"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "RSS平坦不被0搅乱" "$e"; fi

# **report 的结论不落盘**（2026-10-20）
# report 跑完只在终端打印，什么都没留下。三个后果：
#  ① 不幂等：用实时 nowSec 算 days/staleness，同一份 7 天证据
#     现在 exit 0、2 小时后 exit 1（stale，STALE_LIMIT=5400）——
#     **验收窗口只有 1.5 小时，错过就永久失败，原样重跑也不行**。
#  ② 历史结论被后来的数据改写：S6「连续 7 天」是已发生过的事实，
#     不该被第 8 天的一次抖动改写成「从未通过」。
#  ③ 无法审计：S3/S4/S5 都有 --judge + 落盘，唯独最需要 7 天证据的 S6 不留痕迹。
rm -f $FIX/vd1.jsonl
SOAK_VERDICT=$FIX/vd1.jsonl SOAK=$FIX/freeze.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if [ -s $FIX/vd1.jsonl ] && grep -qa '"exit":0' $FIX/vd1.jsonl && grep -qa '"observedDays":7' $FIX/vd1.jsonl; then
  p=$((p+1)); printf "  ok   %-28s 通过也要落盘\n" "结论须落盘"
else f=$((f+1)); printf "  FAIL %-28s 无审计行\n" "结论须落盘"; fi
# 只追加、不改写
for i in 1 2; do SOAK_VERDICT=$FIX/vd1.jsonl SOAK=$FIX/freeze.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1; done
if [ "$(wc -l < $FIX/vd1.jsonl)" = "3" ]; then
  p=$((p+1)); printf "  ok   %-28s 追加不改写\n" "审计只追加"
else f=$((f+1)); printf "  FAIL %-28s %s 行\n" "审计只追加" "$(wc -l < $FIX/vd1.jsonl)"; fi
# 失败数据也必须落盘（否则只有一半历史）
rm -f $FIX/vd2.jsonl
SOAK_VERDICT=$FIX/vd2.jsonl SOAK=$FIX/leak75.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if grep -qa '"exit":1' $FIX/vd2.jsonl; then
  p=$((p+1)); printf "  ok   %-28s 失败也落盘\n" "失败结论也落盘"
else f=$((f+1)); printf "  FAIL %-28s 无审计行\n" "失败结论也落盘"; fi

# **审计行只有 exit，没有原因**（2026-10-20）
# 第 69 轮加的审计行第一版只写 exit:1。事后翻到三天前那行，
# 完全不知道是 RSS 涨了、成功率掉了、还是容器挂了。
# 这与第 61 轮「空数据只 exit 1 不说原因」是同一个病的不同层面：
# 那次是终端不说，这次是落盘不说。
# 而终端里已经算好的「哪条红」就在 c[] 里 —— 不记下来等于白算一遍。
rm -f $FIX/vf3.jsonl
SOAK_VERDICT=$FIX/vf3.jsonl SOAK=$FIX/leak75.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if grep -qa '"failures":\["❌ RSS' $FIX/vf3.jsonl; then
  p=$((p+1)); printf "  ok   %-28s 红时有原因\n" "审计行须记失败原因"
else f=$((f+1)); printf "  FAIL %-28s 无 failures\n" "审计行须记失败原因"; fi
rm -f $FIX/vf4.jsonl
SOAK_VERDICT=$FIX/vf4.jsonl SOAK=$FIX/freeze.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if grep -qa '"failures":\[\]' $FIX/vf4.jsonl; then
  p=$((p+1)); printf "  ok   %-28s 绿时为空\n" "通过时failures为空"
else f=$((f+1)); printf "  FAIL %-28s 不该有值\n" "通过时failures为空"; fi

# **审计行记了数据的 md5，没记尺子的 md5**（2026-10-20）
# 数据没变就能复核 —— 但不知道当时用的是哪套判据、哪个阈值。
# 而 soak.sh 在窗口期内被改了 26 次，所有阈值（COVER_RATE_LIMIT /
# HTTP_RATE_LIMIT / PEAK_GROWTH_LIMIT …）全是这 26 次里新加或改过的。
# 「数据可验、尺子不可验」比「两者都不可验」更危险：
# 它看起来有 md5、像是可复核的，实际上只能证明数据没变。
# 记两样：脚本 md5 + 当前生效的全部阈值（md5 能证同一性，但读不出"当时是多少"）。
rm -f $FIX/vf5.jsonl
SOAK_VERDICT=$FIX/vf5.jsonl SOAK=$FIX/freeze.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
real=$(md5sum scripts/soak.sh | cut -c1-32)
if grep -qa "\"scriptMd5\":\"$real\"" $FIX/vf5.jsonl; then
  p=$((p+1)); printf "  ok   %-28s 尺子md5对得上\n" "审计记脚本md5"
else f=$((f+1)); printf "  FAIL %-28s %s\n" "审计记脚本md5" "$real"; fi
if grep -qa '"limits":{"rssMb":50' $FIX/vf5.jsonl && grep -qa '"peakGrowthMb":50' $FIX/vf5.jsonl; then
  p=$((p+1)); printf "  ok   %-28s 阈值并列\n" "审计记阈值"
else f=$((f+1)); printf "  FAIL %-28s 无 limits\n" "审计记阈值"; fi
# 改阈值后必须能区分
cp -f scripts/soak.sh $FIX/soakfake2.sh
sed -i 's/const PEAK_GROWTH_LIMIT=50;/const PEAK_GROWTH_LIMIT=80;/' $FIX/soakfake2.sh
rm -f $FIX/vf6.jsonl
SOAK_SELF=$FIX/soakfake2.sh SOAK_VERDICT=$FIX/vf6.jsonl SOAK=$FIX/freeze.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash $FIX/soakfake2.sh report >/dev/null 2>&1
if grep -qa '"peakGrowthMb":80' $FIX/vf6.jsonl; then
  p=$((p+1)); printf "  ok   %-28s 改阈值可追溯\n" "阈值变化可区分"
else f=$((f+1)); printf "  FAIL %-28s 未记新值\n" "阈值变化可区分"; fi
rm -f $FIX/soakfake2.sh

# **审计行不记窗口是哪一段**（2026-10-20）
# 前几轮把「数据 md5」「尺子 md5」「阈值」都记了，但没记窗口是哪 7 天。
# observedDays=7.001 只说「跨了 7 天」，不说「是哪 7 天」。
# 而本项目 soak-day0.txt 已改过 3 次，且当前这份的 mtime（03:44）
# 比它写下的窗口起点（03:25:20）晚 19 分钟 —— 中途被重写过一次。
# 外部看审计行无法区分「重写了同样的值」和「偷偷改了窗口」：
# 两者都会让 observedDays 变，且都能凑出 exit:0。
# S6 的核心主张就是「连续 7 天」—— 哪 7 天是这句话的全部内容。
rm -f $FIX/vf7.jsonl $FIX/vf8.jsonl
SOAK_VERDICT=$FIX/vf7.jsonl SOAK=$FIX/freeze.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
if grep -qa '"windowStart":' $FIX/vf7.jsonl && grep -qa '"windowEndObserved":' $FIX/vf7.jsonl; then
  p=$((p+1)); printf "  ok   %-28s 起止都记了\n" "审计记窗口起止"
else f=$((f+1)); printf "  FAIL %-28s 缺 windowStart\n" "审计记窗口起止"; fi
# 挪窗口必须可追溯
node -e 'const fs=require("fs");const L=fs.readFileSync("$FIX/freeze.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse);const c=L[0].ts+86400;fs.writeFileSync("$FIX/fsh.jsonl",L.filter(x=>x.ts>=c).map(x=>JSON.stringify(x)).join("\n")+"\n");'
SOAK_VERDICT=$FIX/vf8.jsonl SOAK=$FIX/fsh.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >/dev/null 2>&1
a=$(grep -o '"windowStart":[^,]*' $FIX/vf7.jsonl)
b=$(grep -o '"windowStart":[^,]*' $FIX/vf8.jsonl)
if [ -n "$a" ] && [ "$a" != "$b" ]; then
  p=$((p+1)); printf "  ok   %-28s 挪窗口可追溯\n" "窗口变化可区分"
else f=$((f+1)); printf "  FAIL %-28s %s vs %s\n" "窗口变化可区分" "$a" "$b"; fi

# **采样密度只有下限，没有上限**（2026-10-20）
# S6 判据是「连续 7 天无人工干预」，而「太多」正是人工干预唯一的指纹：
# cron 是 */30、一天 48 次，多出来的每一次都是有人手动跑了 sample。
# 合成实测：7 天塞 3363 点（设计 10 倍）→「密度 1000%（判据 ≥70%）」→ ✅ → exit 0。
# 不是理论问题：真窗口里 11 个点有 6 个不是 cron 来的（秒数 33/54/40/43），
# 那是我调试采集字段时踩出来的，判据一条都没响。
# 修：SAMPLE_RATE_MAX=1.5；窗口 <28h 时说「还没到判的时候」而不是打勾。
SOAK_VERDICT=$FIX/vf9.jsonl SOAK=$FIX/toomany.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/dm1.chk 2>&1
e=$?
if [ "$e" = "1" ] && grep -qaE "采样密度 99[0-9]%|采样密度 1000%" $FIX/dm1.chk && grep -qa "有人手动跑了 sample" $FIX/dm1.chk; then
  p=$((p+1)); printf "  ok   %-28s 密度过高必红\n" "采样过密须判红"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "采样过密须判红" "$e"; fi
SOAK_VERDICT=$FIX/vf10.jsonl SOAK=$FIX/freeze.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/dm2.chk 2>&1
e=$?
if [ "$e" = "0" ] && ! grep -qa "密度 100%" $FIX/dm2.chk; then
  p=$((p+1)); printf "  ok   %-28s 正常密度不误伤\n" "正常密度仍绿"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "正常密度仍绿" "$e"; fi
# 窗口很短时：不许打 ✅（否则「✅ 密度 22500%」这种荒唐话）
node -e 'const fs=require("fs");const now=Math.floor(Date.now()/1000);const o=[{ts:now-600,alive:true,rss_kb:200000,fd:27,threads:11,container_up:1,container_ok:1,relay_up:1,http_ok:1,db_kb:1,pid:1,proc_start:now-600},{ts:now-300,alive:true,rss_kb:200000,fd:27,threads:11,container_up:1,container_ok:1,relay_up:1,http_ok:1,db_kb:1,pid:1,proc_start:now-600}];fs.writeFileSync("$FIX/tinywin.jsonl",o.map(x=>JSON.stringify(x)).join("\n")+"\n");'
SOAK_VERDICT=$FIX/vf11.jsonl SOAK=$FIX/tinywin.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/dm3.chk 2>&1
if grep -qa "窗口还太短，这条还没到判的时候" $FIX/dm3.chk && ! grep -qa "✅ 采样密度" $FIX/dm3.chk; then
  p=$((p+1)); printf "  ok   %-28s 短窗口不打勾\n" "短窗口不算密度"
else f=$((f+1)); printf "  FAIL %-28s 措辞不对\n" "短窗口不算密度"; fi

# **结论只能有一个来源：c[]**（2026-10-20）
# 原来 verdictOk 是一个跨 48 行手写维护的布尔式，而 c[] 里已有 37 处 ❌。
# 同一个结论写两遍，两遍会悄悄分家——而且已经分家过两次：
#   第 67 轮 relayCoverOk/httpCoverOk 算出来却没进 exit（率只覆盖 15% 窗口仍绿）
#   第 62 轮 RSS 侧「证据不足」分支被 && days>=7 挡住，压根不打印
# 还发现那段条件里有一整行被复制了两遍（contOkUnknown||… 写两次）——
# 手写长布尔式的典型产物：复制粘贴、没人敢删。
# 改成 verdictOk = !c.some(x=>startsWith("❌"))。
# 立刻暴露出两条原本"在 exit 里但从不说话"的判据（hbHung、coverOk），
# 于是「判据红了但终端不说为什么」这个第 61 轮的病又冒出来一次——补上 ❌ 就好了。
# 补 ❌ 时又踩 TDZ 第四次：插在 L1087/L1449，而 c 到 L1533 才定义。
# 规律：「算出判据」的位置和「能说话」的位置不是同一个位置。
for pair in "freeze:0" "leak75:1" "toomany:1" "dead19h:0" "nocover:1"; do
  fn="${pair%%:*}"; want="${pair##*:}"
  SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/$fn.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/dv.chk 2>&1
  e=$?
  hasx=$(grep -c "❌" $FIX/dv.chk | head -1)
  if [ "$e" = "$want" ] && { { [ "$e" = "0" ] && [ "$hasx" = "0" ]; } || { [ "$e" != "0" ] && [ "$hasx" != "0" ]; }; }; then
    p=$((p+1)); printf "  ok   %-28s exit=%s ❌=%s\n" "exit须与❌一致-$fn" "$e" "$hasx"
  else f=$((f+1)); printf "  FAIL %-28s exit=%s(期望%s) ❌=%s\n" "exit须与❌一致-$fn" "$e" "$want" "$hasx"; fi
done
# 反向：不许有「exit 1 却一条 ❌ 都没有」（第 61 轮的病）
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/emptyz.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/dv2.chk 2>&1
e=$?; hasx=$(grep -c "❌" $FIX/dv2.chk | head -1)
if [ "$e" != "0" ] && [ "$hasx" != "0" ]; then
  p=$((p+1)); printf "  ok   %-28s 空数据也有❌\n" "红必给理由"
else f=$((f+1)); printf "  FAIL %-28s exit=%s ❌=%s\n" "红必给理由" "$e" "$hasx"; fi

# **fd 读失败写成 0，而 0 被当成真实值**（2026-10-20，第 68 轮的复发）
# 第 68 轮把 rss_kb 改成「读不到就不写字段」，但 fd/threads 没跟着改。
# ls /proc/$pid/fd | wc -l 在 ls 失败时输出 0，而「0 个句柄」是有效的小值。
# 现场：fd 27→45 真泄漏（+18 < 峰值门槛 20），末 20 点写 0 →
#   句柄: 首段中位 28 → 末段中位 0
#   ✅ 无明显句柄泄漏 / ✅ 峰值增长 17 < 20 / exit 0
# 真泄漏被判成交付合格，而报告自己那行就写着 0。
node -e '
const fs=require("fs");
const now=Math.floor(Date.now()/1000),N=337,last=now-180,first=last-(N-1)*1800;
const WANT={0:"OK",1:"-55",2:"350",3:"2176782336"};const out=[];
for(let i=0;i<N;i++){
  let fd=27+Math.round(18*i/(N-1));
  if(i>=N-20) fd=0;                                  // 模拟 ls 失败
  out.push({ts:first+i*1800,alive:true,rss_kb:200*1024,fd:fd,threads:11,
    container_up:1,container_ok:1,relay_up:1,http_ok:1,db_kb:17000,pid:999,proc_start:first,sv:"aaaaaaaa"});
}
let k=0;
for(let t=first+900;t<=last-900;t+=21600){
  out.push({ts:t,kind:"probe",ok:true,taskId:"tk_"+k,status:"done",secs:8,slot:String(k%4),want:WANT[k%4],out:"1",ws:"1"});k++;
}
out.sort((a,b)=>a.ts-b.ts);
fs.writeFileSync("$FIX/fdzero2.jsonl",out.map(x=>JSON.stringify(x)).join("\n")+"\n");
' 2>/dev/null || true
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/fdzero2.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/fz0.chk 2>&1
e=$?
if [ "$e" = "1" ] && grep -qa "句柄增长" $FIX/fz0.chk && ! grep -qa "末段中位 0" $FIX/fz0.chk; then
  p=$((p+1)); printf "  ok   %-28s 0不算真值\n" "fd读失败不被洗白"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "fd读失败不被洗白" "$e"; fi

# 反向：fd 完全缺失的夹具不能被「写成 0」误杀，也不能打 ✅ 说没事
node -e '
const fs=require("fs");
const now=Math.floor(Date.now()/1000),N=337,last=now-180,first=last-(N-1)*1800;
const WANT={0:"OK",1:"-55",2:"350",3:"2176782336"};const out=[];
for(let i=0;i<N;i++){
  out.push({ts:first+i*1800,alive:true,rss_kb:200*1024,threads:11,
    container_up:1,container_ok:1,relay_up:1,http_ok:1,db_kb:17000,pid:999,proc_start:first,sv:"aaaaaaaa"});
}
let k=0;
for(let t=first+900;t<=last-900;t+=21600){
  out.push({ts:t,kind:"probe",ok:true,taskId:"tk_"+k,status:"done",secs:8,slot:String(k%4),want:WANT[k%4],out:"1",ws:"1"});k++;
}
out.sort((a,b)=>a.ts-b.ts);
fs.writeFileSync("$FIX/fdnone.jsonl",out.map(x=>JSON.stringify(x)).join("\n")+"\n");
' 2>/dev/null || true
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/fdnone.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/fz1.chk 2>&1
e=$?
# 全程没有 fd 字段 → 不能打「✅ 无明显句柄泄漏」（那是替没测过背书）
if ! grep -qa "✅ 无明显句柄泄漏" $FIX/fz1.chk; then
  p=$((p+1)); printf "  ok   %-28s 没测过不打勾\n" "fd全缺不背书"
else f=$((f+1)); printf "  FAIL %-28s 打了✅\n" "fd全缺不背书"; fi

# **「每次都被自愈」被当成「连续 7 天」**（2026-10-20）
# 判据原文是「连续 7 天无人工干预」。它被拆成三件事：
#   ① 没有人工干预（重启都有自愈证据）② 服务真的连续跑着 ③ RSS/句柄/成功率不发散
# ① 有了、③ 有了，② 的门槛却只有「最长连续存活 ≥1 小时」——
# 对一个要求「连续 7 天」的判据而言等于没判。
# 现场：daemon 每 90 分钟崩一次、每次 25 分钟才被拉起，112 段 →
#   可用率 33%、累计停机 56 小时，而报告写的是
#   ✅ 期间服务不可用累计 0.0 小时 / ✅ 重启 112 次全部自愈 / ✅ 最长存活 1.0h
# 三条全绿，exit 0。
node -e '
const fs=require("fs");
const now=Math.floor(Date.now()/1000),N=337,last=now-180,first=last-(N-1)*1800;
const WANT={0:"OK",1:"-55",2:"350",3:"2176782336"};const out=[];
for(let i=0;i<N;i++){
  const seg=Math.floor(i/3), born=first+seg*3*1800-300;
  out.push({ts:first+i*1800,alive:true,rss_kb:200*1024,fd:27,threads:11,
    container_up:1,container_ok:1,relay_up:1,http_ok:1,db_kb:17000,pid:1000+seg,proc_start:born,sv:"aaaaaaaa"});
}
let k=0;
for(let t=first+900;t<=last-900;t+=21600){
  out.push({ts:t,kind:"probe",ok:true,taskId:"tk_"+k,status:"done",secs:8,slot:String(k%4),want:WANT[k%4],out:"1",ws:"1"});k++;
}
out.sort((a,b)=>a.ts-b.ts);
fs.writeFileSync("$FIX/crashloop.jsonl",out.map(x=>JSON.stringify(x)).join("\n")+"\n");
const segs=[...new Set(out.filter(x=>x.kind!=="probe").map(x=>x.proc_start))].sort((a,b)=>a-b);
const TZ=-new Date().getTimezoneOffset()*60,p2=n=>String(n).padStart(2,"0");
const fmt=t=>{const d=new Date((t+TZ)*1000);return `${d.getUTCFullYear()}-${p2(d.getUTCMonth()+1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;};
fs.writeFileSync("$FIX/crashloop.wd",segs.slice(1).map(b=>fmt(b+60)+" 自愈:daemon 已恢复(4s)").join("\n")+"\n");
' 2>/dev/null || true
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/crashloop.jsonl DOTD_WATCHDOG_LOG=$FIX/crashloop.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/cl0.chk 2>&1
e=$?
if [ "$e" = "1" ] && grep -qa "窗口内可用率只有" $FIX/cl0.chk; then
  p=$((p+1)); printf "  ok   %-28s 崩112次不算连续\n" "全自愈不等于连续7天"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "全自愈不等于连续7天" "$e"; fi

# 反向：真·连续 7 天（一次都没重启）必须打勾说 100%
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/freeze.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/cl1.chk 2>&1
e=$?
if [ "$e" = "0" ] && grep -qa "窗口内可用率 100.00%" $FIX/cl1.chk; then
  p=$((p+1)); printf "  ok   %-28s 100%%\n" "真连续7天打勾"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "真连续7天打勾" "$e"; fi

# **短窗口下采样密度天然虚高，会误报「有人手动跑」**（2026-10-20）
# 现场（真窗口，开窗 41 分钟）：采样密度 2 次 / 应 1 次 = 146%。
# 逐点扫：16分=188% / 31分=194% / 61分=148% / 91分=132%，**全是正常 cron**。
# 因为 hours 只有零点几，expectSamples 被四舍五入到 1，而 all.length 至少是 1。
# 一个会误报人工干预的判据比没有更糟：真干预会混在噪声里不被注意。
node -e '
const fs=require("fs");
const now=Math.floor(Date.now()/1000);
const d0=now-121*60;
const out=[];
for(let i=0;i<5;i++) out.push({ts:d0+i*1800,alive:true,rss_kb:200*1024,fd:27,threads:11,
  container_up:1,container_ok:1,relay_up:1,http_ok:1,db_kb:17000,pid:999,proc_start:d0,sv:"aaaaaaaa"});
out.sort((a,b)=>a.ts-b.ts);
fs.writeFileSync("$FIX/dens121.jsonl",out.map(x=>JSON.stringify(x)).join("\n")+"\n");
fs.writeFileSync("$FIX/dens121.txt","x "+d0+"\n");
' 2>/dev/null || true
SOAK_DAY0=$FIX/dens121.txt SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/dens121.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/dn0.chk 2>&1
if ! grep -qa "❌ \*\*采样密度" $FIX/dn0.chk && grep -qa "这条先不判" $FIX/dn0.chk; then
  p=$((p+1)); printf "  ok   %-28s 不虚高\n" "密度短窗口不虚高"
else f=$((f+1)); printf "  FAIL %-28s 误报了\n" "密度短窗口不虚高"; fi

# 反向：真·人工跑（4 小时塞 30 点，应采 8）必须红 —— 「太多」不受短窗口豁免
node -e '
const fs=require("fs");
const now=Math.floor(Date.now()/1000);
const d0=now-4*3600;
const out=[];
for(let i=0;i<30;i++) out.push({ts:d0+i*480,alive:true,rss_kb:200*1024,fd:27,threads:11,
  container_up:1,container_ok:1,relay_up:1,http_ok:1,db_kb:17000,pid:999,proc_start:d0,sv:"aaaaaaaa"});
out.sort((a,b)=>a.ts-b.ts);
fs.writeFileSync("$FIX/manual4h.jsonl",out.map(x=>JSON.stringify(x)).join("\n")+"\n");
fs.writeFileSync("$FIX/manual4h.txt","x "+d0+"\n");
' 2>/dev/null || true
SOAK_DAY0=$FIX/manual4h.txt SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/manual4h.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/dn1.chk 2>&1
# 密度数字会随夹具刷新而变（点间 480s 除以刷新后的窗口）——
# 写死 "375%" 会让这条用例**只在某一次刷新后**成立（第⑮类：判据输入会漂）。
# 改成匹配「采样密度 + 任意百分比」，但必须仍是 ❌ 且确实是密度那条。
if grep -qaE "❌ \*\*采样密度 [0-9]+(\.[0-9]+)?%" "$FIX/dn1.chk"; then
  p=$((p+1)); printf "  ok   %-28s 短窗口也抓\n" "手动跑4h必红"
else f=$((f+1)); printf "  FAIL %-28s\n" "手动跑4h必红"; fi

# **模板写漏占位符：数值从来没打印出来过**（2026-10-20）
# 现场：真窗口数据里 threads 三个点全是 11，报告显示
#   「线程: 首段中位 → 末段中位（增长 +0…）」
# —— 中间两个数是空的，因为模板里根本没写 ${th0} 和 ${thN}。
# 这类错很难被注意到：表现是「少了一段字」而不是报错，
# 读者会以为「采集没拿到线程数」。
if grep -qaE "线程: 首段中位 [0-9]+ → 末段中位 [0-9]+" $FIX/th0.chk 2>/dev/null || true; then :; fi
SOAK_VERDICT=$FIX/thv.jsonl SOAK=$FIX/freeze.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/th0.chk 2>&1
if grep -qaE "线程: 首段中位 [0-9]+ → 末段中位 [0-9]+" $FIX/th0.chk; then
  p=$((p+1)); printf "  ok   %-28s 数值打出来了\n" "线程行不留空"
else f=$((f+1)); printf "  FAIL %-28s 数值是空的\n" "线程行不留空"; fi

# **同一份证据不能有两个说法**（第 55 轮复发）
# 真窗口：正文「句柄爬升速率：中位 0.000个/h，最大 0.000个/h」（读起来=没问题）
#        判定「⚠ 句柄段内爬升：证据不足，现在不判定」
# RSS 侧同样数据老实说「现在还判断不了」。
# 数字是对的（1 段里确实没爬），但**不该以这种形式出现** ——
# 一条判据在证据不足时，正文不该给出看起来像结论的数字。
node -e 'const fs=require("fs");const now=Math.floor(Date.now()/1000);
const d0=now-5400;const o=[];
for(let i=0;i<3;i++) o.push({ts:d0+i*1800,alive:true,rss_kb:210000,fd:27,threads:11,
  container_up:1,container_ok:1,relay_up:1,http_ok:1,db_kb:17000,pid:999,proc_start:d0,sv:"aaaaaaaa"});
fs.writeFileSync("$FIX/fdthin.jsonl",o.map(x=>JSON.stringify(x)).join("\n")+"\n");' 2>/dev/null || true
SOAK_VERDICT=$FIX/fdv.jsonl SOAK=$FIX/fdthin.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/fd0.chk 2>&1
if grep -qa "句柄爬升速率：现在还判断不了" $FIX/fd0.chk && ! grep -qa "句柄爬升速率：中位" $FIX/fd0.chk; then
  p=$((p+1)); printf "  ok   %-28s 不给出假结论\n" "句柄证据不足不报数"
else f=$((f+1)); printf "  FAIL %-28s\n" "句柄证据不足不报数"; fi

# **数据缺字段把判据脚本炸掉了**（2026-10-20）
# 只有 ts/alive/pid/proc_start 的裸夹具 →
#   exit 2 + TypeError: Cannot read properties of undefined (reading 'ts')
# 根因：rssPts 为空时 findIndex 返回 -1，all[-1].ts 就炸。
# 那句「❌ report 脚本自身出错…判据坏了，必须修」本身是对的（R44 的成果），
# 但它该拦下的是**我写错代码**，不该拦下**数据缺字段** ——
# 后者是正常输入，判据该判红并说明缺什么。
node -e 'const fs=require("fs");const now=Math.floor(Date.now()/1000);
const d0=now-5400;const o=[];
for(let i=0;i<3;i++) o.push({ts:d0+i*1800,alive:true,pid:999,proc_start:d0,sv:"aaaaaaaa"});
fs.writeFileSync("$FIX/bare.jsonl",o.map(x=>JSON.stringify(x)).join("\n")+"\n");' 2>/dev/null || true
SOAK_VERDICT=$FIX/bav.jsonl SOAK=$FIX/bare.jsonl DOTD_WATCHDOG_LOG=$FIX/nowd.log DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/ba0.chk 2>&1
e=$?
if [ "$e" != "2" ] && ! grep -qa "TypeError" $FIX/ba0.chk; then
  p=$((p+1)); printf "  ok   %-28s 缺字段不崩\n" "裸夹具不炸脚本"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "裸夹具不炸脚本" "$e"; fi

# **「率」和「最长连续」都抓不到「周期性短时假死」**（2026-10-20，真漏判）
# 三条通道原来各只有两条判据：率 ≥95%、最长连续 ≤2h。
# 有份数据把两条全躲过去：**每 12 小时假死 30 分钟**，7 天 14 次。
#   · 最长连续 30 分钟，远低于 2h ✅
#   · 累计 7.5h / 168h = 4.5% → 率 95.5%，**险过** ✅
# 于是 http / relay / container_ok 三个场景全部 exit 0，
# 而主人那 7 天里有 7.5 小时发消息没人应。
# 这是第 77 轮在 daemon 侧修过的同一个洞（upRatio），
# 当时只补了「daemon 进程在不在」，没补它三个下游通不通。
# 又是「修一处没扫同类」—— 第 76、78 轮各犯一次，这是第三次。
node -e 'import("$FIX/mk7d.mjs").then(m=>m.mk7d("$FIX/cum_http.jsonl",{httpOk:(i)=>(i%24<1)?0:1}))' 2>/dev/null || true
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/cum_http.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/cu0.chk 2>&1
e=$?
if [ "$e" = "1" ] && grep -qa "daemon 累计不可达" $FIX/cu0.chk && grep -qa "❌ \*\*daemon 累计不可达" $FIX/cu0.chk; then
  p=$((p+1)); printf "  ok   %-28s 抓到了\n" "http短时假死必红"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "http短时假死必红" "$e"; fi

node -e 'import("$FIX/mk7d.mjs").then(m=>m.mk7d("$FIX/cum_relay.jsonl",{relayUp:(i)=>(i%24<1)?0:1}))' 2>/dev/null || true
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/cum_relay.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/cu1.chk 2>&1
e=$?
if [ "$e" = "1" ] && grep -qa "❌ \*\*网关累计断开" $FIX/cu1.chk; then
  p=$((p+1)); printf "  ok   %-28s 抓到了\n" "网关短时假死必红"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "网关短时假死必红" "$e"; fi

node -e 'import("$FIX/mk7d.mjs").then(m=>m.mk7d("$FIX/cum_cont.jsonl",{contOk:(i)=>(i%24<1)?0:1}))' 2>/dev/null || true
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/cum_cont.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/cu2.chk 2>&1
e=$?
if [ "$e" = "1" ] && grep -qa "❌ \*\*容器累计不可执行" $FIX/cu2.chk; then
  p=$((p+1)); printf "  ok   %-28s 抓到了\n" "容器短时假死必红"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "容器短时假死必红" "$e"; fi

# 反向：短到可容忍的抖动（每次 30 分钟、只 2 次 = 累计 1h）必须仍绿
node -e 'import("$FIX/mk7d.mjs").then(m=>m.mk7d("$FIX/cum_ok.jsonl",{httpOk:(i)=>(i===48||i===144)?0:1}))' 2>/dev/null || true
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/cum_ok.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/cu3.chk 2>&1
e=$?
if [ "$e" = "0" ] && grep -qa "✅ daemon 累计不可达 1.0 小时" $FIX/cu3.chk; then
  p=$((p+1)); printf "  ok   %-28s 不误伤\n" "短暂抖动仍绿"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "短暂抖动仍绿" "$e"; fi
# ── 「这段窗口用过几把尺子」 ──
# 判据原话是「连续 7 天无人工干预」。我每轮改 soak.sh 本身就是干预，
# 以前没记录 —— 现在每个采样点自带 sv（脚本指纹），数一下就知道。
node -e 'import("$FIX/mk7d.mjs").then(m=>m.mk7d("$FIX/svA.jsonl",{sv:()=>"aaaaaaaa"}))' 2>/dev/null
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/svA.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/svA.out 2>&1
if [ $? = 0 ] && grep -qa "✅ 判据全程同一个版本" $FIX/svA.out; then
  p=$((p+1)); printf "  ok   %-28s 同一把尺子\n" "判据全程未换"
else f=$((f+1)); printf "  FAIL %-28s\n" "判据全程未换"; fi

# 中途换了一版、新版才跑 4 个点（2h）→ 判定还没稳定，必须拖住通过
node -e 'import("$FIX/mk7d.mjs").then(m=>m.mk7d("$FIX/svB.jsonl",{sv:(i,N)=> i<N-4?"aaaaaaaa":"bbbbbbbb"}))' 2>/dev/null
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/svB.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/svB.out 2>&1
e=$?
if [ "$e" = "1" ] && grep -qa "⏳ 这段窗口用过 2 个判据版本" $FIX/svB.out; then
  p=$((p+1)); printf "  ok   %-28s exit=1\n" "中途换尺子须判红"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "中途换尺子须判红" "$e"; fi

# 换过但新版已跑 68h → 说清代价，不判死
node -e 'import("$FIX/mk7d.mjs").then(m=>m.mk7d("$FIX/svC.jsonl",{sv:(i)=> i<200?"aaaaaaaa":"bbbbbbbb"}))' 2>/dev/null
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/svC.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/svC.out 2>&1
e=$?
if [ "$e" = "0" ] && grep -qa "⚠ \*\*这段窗口用过 2 个判据版本\*\*" $FIX/svC.out; then
  p=$((p+1)); printf "  ok   %-28s 说清代价\n" "换过但已稳定"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "换过但已稳定" "$e"; fi

# 老数据没有 sv 字段 → 判断不了，不许打勾也不许判死
node -e 'import("$FIX/mk7d.mjs").then(m=>m.mk7d("$FIX/svD.jsonl",{sv:()=>null}))' 2>/dev/null
node -e 'const fs=require("fs");const L=fs.readFileSync("$FIX/svD.jsonl","utf8").split("\n").filter(Boolean).map(l=>{const o=JSON.parse(l);delete o.sv;return JSON.stringify(o)});fs.writeFileSync("$FIX/svD.jsonl",L.join("\n")+"\n")' 2>/dev/null
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/svD.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/svD.out 2>&1
e=$?
if [ "$e" = "1" ] && grep -qa "⚠ \*\*判据版本无法核对\*\*" $FIX/svD.out; then
  p=$((p+1)); printf "  ok   %-28s exit=1\n" "老数据无sv不背书"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "老数据无sv不背书" "$e"; fi

# ── 被排除的点必须说出来 ──
# ✅ 分支原来只写 `337/337 点`，不交代有 3 个老点被排除 ——
# 分母被缩小了却不说，等于用沉默换绿色（R79「输出本身就是证据」同类）。
node -e '
const fs=require("fs");
const now=Math.floor(Date.now()/1000), first=now-168*3600, N=337;
const out=[];
for(let i=0;i<N;i++) out.push({ts:first+i*1800,alive:true,rss_kb:210000,fd:27,threads:11,
  container_up:1,container_ok:1,relay_up:1,http_ok:1,db_kb:17000,pid:999,proc_start:first,sv:"aaaaaaaa"});
for(let i=0;i<3;i++) delete out[i].sv;
let k=0;
for(let t=first+900;t<now;t+=21600){
  out.push({ts:t,kind:"probe",ok:true,taskId:"tk_"+k,status:"done",secs:8,slot:String(k%4),want:["OK","-55","350","2176782336"][k%4],out:"1",ws:"1"}); k++;
}
out.sort((a,b)=>a.ts-b.ts);
fs.writeFileSync("$FIX/svMiss.jsonl", out.map(x=>JSON.stringify(x)).join("\n")+"\n");
' 2>/dev/null
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/svMiss.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/svMiss.out 2>&1
e=$?
if [ "$e" = "0" ] && grep -qa "判据全程同一个版本" $FIX/svMiss.out && grep -qa "另有 3 个采样点没有 sv 字段" $FIX/svMiss.out; then
  p=$((p+1)); printf "  ok   %-28s 交代排除数\n" "排除的点须说明"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "排除的点须说明" "$e"; fi

if ! grep -qa "另有 31 个采样点" $FIX/svMiss.out; then
  p=$((p+1)); printf "  ok   %-28s 不含探针\n" "排除数分母正确"
else f=$((f+1)); printf "  FAIL %-28s\n" "排除数分母正确"; fi
# ── 7 天后的真实形态：老点无 sv + 1 个旧版 + 其余新版 ──
# 这是真窗口实际会长的样子（08:00 的 2f0059b6、08:30 起 98824045）。
# 必须 exit 0（⚠ 说清代价但不判死），且时序要对（旧版在前）。
node -e '
import("$FIX/mk7d.mjs").then(m=>{
  m.mk7d("$FIX/fcReal.jsonl",{sv:(i)=> i<3?null:(i===3?"2f0059b6":"98824045")});
});
' 2>/dev/null
sleep 1
node -e 'const fs=require("fs");const p="$FIX/fcReal.jsonl";const L=fs.readFileSync(p,"utf8").split("\n").filter(Boolean).map(JSON.parse);L.forEach(o=>{if(o.kind!=="probe"&&(o.sv===null||o.sv===undefined))delete o.sv;});fs.writeFileSync(p,L.map(x=>JSON.stringify(x)).join("\n")+"\n")' 2>/dev/null
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/fcReal.jsonl DOTD_WATCHDOG_LOG=$FIX/rehearse7.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/fcReal.out 2>&1
e=$?
if [ "$e" = "0" ] && grep -qa "2f0059b6(x1) → 98824045" $FIX/fcReal.out; then
  p=$((p+1)); printf "  ok   %-28s exit=0\n" "七天后真实形态仍绿"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "七天后真实形态仍绿" "$e"; fi
# ── 容器掉 5.5h：自愈记录不能豁免「停机太久」 ──
# 给容器记录后「找不到自愈记录」应消失，但「最长连续离线 330 分钟」必须仍在 ——
# 否则就等于「只要有人拉起来过，掉多久都算合格」（第 77 轮同一个病）。
node -e '
import("$FIX/mk7d.mjs").then(m=>{
  m.mk7d("$FIX/cd550.jsonl",{contUp:(i)=> (i>=200&&i<211)?0:1, contOk:(i)=> (i>=200&&i<211)?0:1});
});
' 2>/dev/null
sleep 1
node -e '
const fs=require("fs");
const L=fs.readFileSync("$FIX/cd550.jsonl","utf8").split("\n").filter(Boolean).map(JSON.parse).filter(x=>x.alive!==undefined);
const TZ=-new Date().getTimezoneOffset()*60;
const esc=t=>{const d=new Date((t+TZ)*1000);const p=n=>String(n).padStart(2,"0");return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`};
fs.writeFileSync("$FIX/cd550.wd", esc(L[211].ts)+" 自愈:容器已恢复(6s)\n");
' 2>/dev/null
SOAK_VERDICT=$FIX/rgv.jsonl SOAK=$FIX/cd550.jsonl DOTD_WATCHDOG_LOG=$FIX/cd550.wd DOTD_BOOT_LOG=$FIX/noboot.log bash scripts/soak.sh report >$FIX/cd550.out 2>&1
e=$?
if [ "$e" = "1" ] && ! grep -qa "找不到自愈记录" $FIX/cd550.out && grep -qa "容器最长连续离线 330 分钟" $FIX/cd550.out; then
  p=$((p+1)); printf "  ok   %-28s 掉5.5h仍红\n" "有容器记录也不豁免时长"
else f=$((f+1)); printf "  FAIL %-28s exit=%s\n" "有容器记录也不豁免时长" "$e"; fi

# ===== 第 98 轮新增：总验收入口 verify-goal.sh 必须自己也是判据 =====
# 教训（第⑩类）：一个不改变 process.exit 的检查不算判据。
# 所以这里验的是「它会不会在该红的时候红、该等的时候等」。
_vg(){ SOAK_VERDICT=$FIX/rgv.jsonl bash scripts/verify-goal.sh "${@:3}" >$FIX/vg.out 2>&1; local e=$?;
  if [ "$e" = "$1" ]; then p=$((p+1)); printf "  ok   %-30s exit=%d\n" "$2" "$e";
  else f=$((f+1)); printf "  FAIL %-30s exit=%d 期望=%s\n" "$2" "$e" "$1"; fi }

# 真实状态：S3/S4/S5 绿、S2 绿、S6 未满 7 天 → 必须是 exit 3（⏳），不是 0
_vg 3 "总验收-真实态须是等不是过"
# --json 不能改变退出码
if bash scripts/verify-goal.sh --json >$FIX/vgj.out 2>&1; then e=0; else e=$?; fi
if [ "$e" = "3" ] && grep -qa '"overall": 3' $FIX/vgj.out; then p=$((p+1)); printf "  ok   %-30s\n" "总验收-json不改变判定";
else f=$((f+1)); printf "  FAIL %-30s exit=%s\n" "总验收-json不改变判定" "$e"; fi
# 输出必须逐条给出「验法」，否则验收的人没法自己复现
if grep -qa '验法：' $FIX/vg.out && [ "$(grep -ac '验法：' $FIX/vg.out)" -ge 6 ]; then p=$((p+1)); printf "  ok   %-30s\n" "总验收-六步都给验法";
else f=$((f+1)); printf "  FAIL %-30s\n" "总验收-六步都给验法"; fi
# ⏳ 必须明说「不算通过」，否则会被读成差不多了
if grep -qa '不算通过' $FIX/vg.out; then p=$((p+1)); printf "  ok   %-30s\n" "总验收-⏳须声明不算过";
else f=$((f+1)); printf "  FAIL %-30s\n" "总验收-⏳须声明不算过"; fi
# 未知参数必须 exit 2（脚本自身错），不能悄悄当成功
bash scripts/verify-goal.sh --nonsense >/dev/null 2>&1; [ "$?" = "2" ] && { p=$((p+1)); echo "  ok   总验收-未知参数exit2"; } || { f=$((f+1)); echo "  FAIL 总验收-未知参数exit2"; }

# ===== 第 99 轮新增：S2(b) 也必须有落盘证据 + --judge =====
# 教训：六步里只有 S2(b) 拿不出机器可读的证据，验收的人只能相信我的话。
# 这里验的是「它会不会在该等的时候等、该过的时候过」。
if [ ! -f docs/acceptance/s2b-reuse.jsonl ]; then
  f=$((f+1)); printf "  FAIL %-30s\n" "S2b-证据须落盘"
else
  # 字段必须齐全，否则 --judge 复算不了
  if node -e '
const fs=require("fs");
const L=fs.readFileSync("docs/acceptance/s2b-reuse.jsonl","utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const r=L[L.length-1];
const need=["a_invoke","b_no_shell","c_no_new_tool","d_answer_right","pass","seq","at"];
const miss=need.filter(k=>!(k in r));
if(miss.length){ console.error("缺字段: "+miss.join(",")); process.exit(1); }
' 2>/dev/null; then p=$((p+1)); printf "  ok   %-30s\n" "S2b-证据字段齐全"
  else f=$((f+1)); printf "  FAIL %-30s\n" "S2b-证据字段齐全"; fi

  # --judge 必须只读、且与落盘的 pass 一致
  bash scripts/s2b-verify.sh --judge >$FIX/s2bj.out 2>&1; e=$?
  LASTPASS=$(node -e 'const fs=require("fs");const L=fs.readFileSync("docs/acceptance/s2b-reuse.jsonl","utf8").trim().split("\n").filter(Boolean).map(JSON.parse);process.stdout.write(String(L[L.length-1].pass))')
  EXP_RC=$([ "$LASTPASS" = "4" ] && echo 0 || echo 1)
  if [ "$e" = "$EXP_RC" ]; then p=$((p+1)); printf "  ok   %-30s exit=%s\n" "S2b-judge与落盘一致" "$e"
  else f=$((f+1)); printf "  FAIL %-30s exit=%s 期望=%s\n" "S2b-judge与落盘一致" "$e" "$EXP_RC"; fi

  # 落盘文件的修改时间不能因为 --judge 而变（只读）
  M1=$(stat -c %Y docs/acceptance/s2b-reuse.jsonl 2>/dev/null)
  bash scripts/s2b-verify.sh --judge >/dev/null 2>&1
  M2=$(stat -c %Y docs/acceptance/s2b-reuse.jsonl 2>/dev/null)
  if [ "$M1" = "$M2" ]; then p=$((p+1)); printf "  ok   %-30s\n" "S2b-judge只读不改证据"
  else f=$((f+1)); printf "  FAIL %-30s\n" "S2b-judge只读不改证据"; fi
fi

# 工具名不能写死：容器里没有 char-count，写死会让第④条永远不过
# 只查**非注释行**：注释里保留旧路径作为历史说明是对的，
# 真正必须没有的是可执行代码里写死工具名（那样换工具就静默失效）。
if grep -v '^\s*#' scripts/s2b-verify.sh | grep -qa '/dot/home/tools/char-count'; then
  f=$((f+1)); printf "  FAIL %-30s\n" "S2b-不写死工具名"
else
  p=$((p+1)); printf "  ok   %-30s\n" "S2b-不写死工具名"
fi


# ===== 第 100 轮新增：S2(b) 的证据必须会过期 =====
# 教训：3 天前的 4/4 照样让 verify-goal 打 ✅ —— 那个 ✅ 描述的是三天前的事实。
# 这与 soak.sh 的 STALE_LIMIT 是同一件事（第⑮类：判据的输入可以是陈旧的）。
_s2b_age(){  # $1=把证据改成多久之前（小时；-1=删掉 at）$2=期望退出码 $3=名字
  local bak="$FIX/s2b-bak.jsonl"
  cp -f docs/acceptance/s2b-reuse.jsonl "$bak" 2>/dev/null
  if [ -n "$1" ]; then
    # **单引号内 $FIX 不会展开**（第 101 轮踩到，第 2 次）。
    # 原来写 fs.readFileSync("$FIX/s2b-bak.jsonl")，node 收到字面量，读不到 →
    # L 为空 → r 是 undefined → delete r.at 抛错 → **文件根本没改**，
    # 于是测试拿真实证据跑，报 exit=0。改成用环境变量传路径。
    S2B_BAK="$bak" node -e '
const fs=require("fs");
const L=fs.readFileSync(process.env.S2B_BAK,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
if(!L.length){ console.error("bak 读不出"); process.exit(9); }
const r=L[L.length-1];
const h=Number(process.argv[1]);
if(h<0){ delete r.at; } else { r.at=new Date(Date.now()-h*3600*1000).toISOString(); }
fs.writeFileSync("docs/acceptance/s2b-reuse.jsonl", JSON.stringify(r)+"\n");' -- "$1"
    # **自检必须能让测试失败**，否则它只是在安慰我（第⑩类）。
    # 上一版这里只 echo 一句 ⚠ 就继续跑，所以夹具没改成功时测试照样"通过"。
    local okfix=1
    if [ "$1" = "-1" ]; then
      grep -qa '"at"' docs/acceptance/s2b-reuse.jsonl && okfix=0
    else
      local want
      want=$(date -u -d "@$(( $(date +%s) - ${1%.*} * 3600 ))" +%Y-%m-%d 2>/dev/null)
      grep -qa "\"at\":\"$want" docs/acceptance/s2b-reuse.jsonl || okfix=0
    fi
    if [ "$okfix" = "0" ]; then
      f=$((f+1)); printf "  FAIL %-30s 夹具没改成功\n" "$3"
      cp -f "$bak" docs/acceptance/s2b-reuse.jsonl 2>/dev/null
      return
    fi
  fi
  bash scripts/s2b-verify.sh --judge >"$FIX/s2ba.out" 2>&1
  local e=$?
  cp -f "$bak" docs/acceptance/s2b-reuse.jsonl 2>/dev/null
  if [ "$e" = "$2" ]; then p=$((p+1)); printf "  ok   %-30s exit=%s\n" "$3" "$e"
  else f=$((f+1)); printf "  FAIL %-30s exit=%s 期望=%s\n" "$3" "$e" "$2"; fi
}
# 新鲜证据 → 按落盘结论（当前是 4/4，应 0）
_s2b_age "" 0 "S2b-新鲜证据照落盘判"
# 25 小时前 → ⏳（3），不是 0 也不是 1
_s2b_age 25 3 "S2b-过期证据须是⏳"
# 3 天前 → 仍是 ⏳（3）
_s2b_age 72 3 "S2b-三天前也须是⏳"
# 没有时间戳 → ⏳（3），不能当成"当前"
_s2b_age -1 3 "S2b-无时间戳须是⏳"
# 过期后 verify-goal 的 S2 行不能是 ✅（否则等于没修）
cp -f docs/acceptance/s2b-reuse.jsonl "$FIX/s2b-bak2.jsonl"
S2B_BAK="$FIX/s2b-bak2.jsonl" node -e 'const fs=require("fs");const L=fs.readFileSync(process.env.S2B_BAK,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse);const r=L[L.length-1];r.at=new Date(Date.now()-72*3600*1000).toISOString();fs.writeFileSync("docs/acceptance/s2b-reuse.jsonl",JSON.stringify(r)+"\n")'
if bash scripts/verify-goal.sh 2>/dev/null | grep -q '^S2 自己造工具 ✅'; then
  f=$((f+1)); printf "  FAIL %-30s\n" "S2b-过期时总验收不得打✅"
else
  p=$((p+1)); printf "  ok   %-30s\n" "S2b-过期时总验收不得打✅"
fi
cp -f "$FIX/s2b-bak2.jsonl" docs/acceptance/s2b-reuse.jsonl

# ===== 第 104 轮新增：S6 判据必须存在「能全绿」的样本 =====
# 教训：195 个用例里，「✅ 探针覆盖 N/M 段」这条**一次都没被断言过**。
# 如果哪天它变成永远吐 ❌，回归不会告诉我 ——
# 因为所有用例都只断言「该红的时候红」，没有一条断言「该绿的时候绿」。
# 这份夹具是第一个 7 天全绿样本：340 采样 + 28 探针 + 1 段，判定行 29 条 ✅ / 0 条 ❌。
# 夹具：fixtures/allgreen7d.jsonl（生成方式见 README「全绿样本」一节）
# **夹具必须现生成，不能存成静态 jsonl**（第 106 轮踩到）。
# 第一版我把它存成 fixtures/allgreen7d.jsonl，340 点 × 1780s 只覆盖 6.98 天，
# 末尾留了 1.3h 空隙 —— 生成时没事，**12 分钟后**就超过 STALE_LIMIT=5400 而变红。
# 这是 R83–R86 那族「夹具过期」的第 N 次。
# 现在改成每次跑都按 now 现生成：末点正好落在 now-300，永远新鲜。
node -e '
const fs=require("fs");
const now=Math.floor(Date.now()/1000);
const span=7*86400+3600;              // 7 天零 1 小时
const d0=now-300-span;                // 末点正好 now-300
const out=[];
const N=342;
const step=Math.floor(span/(N-1));
for(let i=0;i<N;i++){
  const ts=d0+i*step;
  if(ts>now-300) break;
  out.push({ts,alive:true,rss_kb:210*1024,fd:27,threads:11,
    container_up:1,container_ok:1,relay_up:1,http_ok:1,db_kb:17500,
    pid:777,proc_start:d0,sv:"98824045"});
}
// 探针：每 21600s 一个，覆盖全部 7 段
for(let i=0;i<29;i++){
  const ts=d0+i*21600+600;
  if(ts>now-300) break;
  out.push({ts,kind:"probe",ok:true,taskId:"t"+i,status:"done",secs:5,
    slot:String(i%4),want:["OK","-55","350","2176782336"][i%4],out:"1",ws:"1",sv:"98824045"});
}
out.sort((a,b)=>a.ts-b.ts);
fs.writeFileSync(process.env.FIX+"/allgreen7d.jsonl", out.map(x=>JSON.stringify(x)).join("\n")+"\n");
fs.writeFileSync(process.env.FIX+"/allgreen7d.txt", "x "+d0+"\n");
console.log("    全绿夹具现生成 "+out.length+" 行，末点 "+(now-300-d0)+"s 处");
'
if [ -f "$FIX/allgreen7d.jsonl" ]; then
  t "$FIX/allgreen7d.jsonl" "$FIX/nowd.log" "全绿7天-必须exit0" 0
  SOAK="$FIX/allgreen7d.jsonl" SOAK_DAY0="$FIX/allgreen7d.txt" SOAK_VERDICT="$FIX/rgv.jsonl" \
  DOTD_WATCHDOG_LOG="$FIX/nowd.log" DOTD_BOOT_LOG="$FIX/noboot.log" \
    bash scripts/soak.sh report >"$FIX/allgreen.out" 2>&1
  _ag(){ if grep -qa "$1" "$FIX/allgreen.out"; then p=$((p+1)); printf "  ok   %-30s\n" "$2"
         else f=$((f+1)); printf "  FAIL %-30s\n" "$2"; fi; }
  _ag '✅ 探针覆盖 7/7 段'        "全绿-探针覆盖7/7段"
  _ag '✅ 探针密度 ≥70%'          "全绿-探针密度达标"
  _ag '✅ 末尾 4 次探针成功率'     "全绿-末尾探针也绿"
  _ag '✅ 窗口内可用率'            "全绿-可用率绿"
  _ag '✅ daemon 可达率'           "全绿-daemon可达率绿"
  _ag '✅ 网关连通率'              "全绿-网关连通率绿"
  _ag '✅ 容器可执行率'            "全绿-容器可执行率绿"
  _ag '✅ 全窗口 RSS 峰值增长'     "全绿-RSS峰值绿"
  _ag '✅ 各生命周期内句柄无明显爬升' "全绿-句柄绿"
  _ag '✅ 采样密度 ≥70%'          "全绿-采样密度绿"
  _ag '✅ 期间未重启过'            "全绿-未重启"
  # 「探针能力覆盖」这行是 console.log，**不带 ✅ 前缀**（第 104 轮查出：
  # 全绿报告里它是一句中性的字，读者判断不了这算不算通过）。
  # 所以只能断言它的实际形态，并单独断言没有「未覆盖」。
  # **不要硬编码每个 slot 的计数**（第 106 轮踩到）。
  # 第一版断言「纯存活 7 / 纯推理 7 / 读文件 7 / 容器执行 7」，
  # 而现生成 29 个探针时 slot0 会拿到 8 次 —— 同一条判据，数字随夹具长度变。
  # 这条判据真正要问的是「四条能力路径**都覆盖到了没有**」，不是「各几次」。
  # 所以断言：四个 slot 名都出现，且后面的数字 >= 1。
  if grep -qaE '探针能力覆盖：纯存活 [1-9]' "$FIX/allgreen.out" \
  && grep -qaE '纯推理 [1-9]' "$FIX/allgreen.out" \
  && grep -qaE '读文件 [1-9]'  "$FIX/allgreen.out" \
  && grep -qaE '容器执行 [1-9]' "$FIX/allgreen.out"; then
    p=$((p+1)); printf "  ok   %-30s\n" "全绿-能力路径齐全"
  else
    f=$((f+1)); printf "  FAIL %-30s\n" "全绿-能力路径齐全"
  fi
  if grep -qa '未覆盖' "$FIX/allgreen.out"; then
    f=$((f+1)); printf "  FAIL %-30s 出现了「未覆盖」\n" "全绿-不得有未覆盖"
  else
    p=$((p+1)); printf "  ok   %-30s\n" "全绿-不得有未覆盖"
  fi
  if grep -qa '❌' "$FIX/allgreen.out"; then
    f=$((f+1)); printf "  FAIL %-30s 全绿样本里出现了 ❌\n" "全绿-不得有❌"
  else
    p=$((p+1)); printf "  ok   %-30s\n" "全绿-不得有❌"
  fi
else
  echo "  ⚠ 缺夹具 $FIX/allgreen7d.jsonl，跳过全绿用例（不是判据坏了）"
fi

# ===== 第 105 轮新增：短窗口的外推必须被拒绝 =====
# 教训：真实窗口 9 个点、3.77 小时，RSS 206.0→213.9（+7.8MB）。
# 线性拟合 1.67MB/h，外推 168h = 280MB，看着像必死。
# 但翻了归档发现同一进程（pid=196833）7.1 小时的区间是 201.9–221.7MB，
# **峰值增长 0.0MB** —— 锯齿，不是斜坡。
# 我自己的文档里早写着「不要用短窗口 RSS 预测趋势线」，却还是算了斜率。
# 这条用例锁住：短窗口 + 锯齿输入，判据必须**不判死也不判活**（现在是 ⚠ 证据不足）。
node -e '
const fs=require("fs");
const now=Math.floor(Date.now()/1000);
const d0=now-3600*6;              // 只有 6 小时窗口
const out=[];
// 锯齿：202→222 来回，最后落在中间
const saw=[202,215,222,205,210,202,218,213];
for(let i=0;i<saw.length;i++){
  out.push({ts:d0+i*2100,alive:true,rss_kb:saw[i]*1024,fd:27,threads:11,
    container_up:1,container_ok:1,relay_up:1,http_ok:1,db_kb:17500,
    pid:999,proc_start:d0,sv:"98824045"});
}
fs.writeFileSync(process.env.FIX+"/sawtooth6h.jsonl", out.map(x=>JSON.stringify(x)).join("\n")+"\n");
fs.writeFileSync(process.env.FIX+"/sawtooth6h.txt", "x "+d0+"\n");
'
# 6 小时窗口：未满 7 天 → 必须 exit 1（未满 7 天那条 ❌），
# 但**不能**出现「RSS 增长 >=50MB」这种基于外推的判死。
SOAK="$FIX/sawtooth6h.jsonl" SOAK_DAY0="$FIX/sawtooth6h.txt" SOAK_VERDICT="$FIX/rgv.jsonl" \
DOTD_WATCHDOG_LOG="$FIX/nowd.log" DOTD_BOOT_LOG="$FIX/noboot.log" \
  bash scripts/soak.sh report >"$FIX/sawtooth.out" 2>&1
if grep -qa '❌ RSS 增长' "$FIX/sawtooth.out" || grep -qa '❌ \*\*全窗口 RSS 峰值增长' "$FIX/sawtooth.out"; then
  f=$((f+1)); printf "  FAIL %-30s 锯齿被当成泄漏\n" "锯齿-不得判成RSS泄漏"
else
  p=$((p+1)); printf "  ok   %-30s\n" "锯齿-不得判成RSS泄漏"
fi
# 且必须能看出峰值增长很小
if grep -qaE '峰值增长 \+?[0-9]\.?[0-9]*MB' "$FIX/sawtooth.out"; then
  p=$((p+1)); printf "  ok   %-30s\n" "锯齿-峰值增长有输出"
else
  f=$((f+1)); printf "  FAIL %-30s\n" "锯齿-峰值增长有输出"
fi

# 反向配套：真斜坡**必须**判红（否则上面那条「锯齿不判死」就是在替泄漏背书）
# 7 天、RSS 200→280MB，判据必须同时给出两条 ❌（段内增长 + 全窗口峰值增长）。
node -e '
const fs=require("fs");
const now=Math.floor(Date.now()/1000);
const d0=now-7*86400-3600+300;
const out=[];
for(let i=0;i<340;i++){
  const ts=d0+i*1780;
  if(ts>now-300) break;
  const p=i/340;
  out.push({ts,alive:true,rss_kb:(200+p*80)*1024,fd:27,threads:11,
    container_up:1,container_ok:1,relay_up:1,http_ok:1,db_kb:17500,
    pid:999,proc_start:d0,sv:"98824045"});
}
for(let i=0;i<28;i++){
  const ts=d0+i*21600+600;
  if(ts>now-300) break;
  out.push({ts,kind:"probe",ok:true,taskId:"t"+i,status:"done",secs:5,
    slot:String(i%4),want:["OK","-55","350","2176782336"][i%4],out:"1",ws:"1",sv:"98824045"});
}
out.sort((a,b)=>a.ts-b.ts);
fs.writeFileSync(process.env.FIX+"/rampleak7d.jsonl", out.map(x=>JSON.stringify(x)).join("\n")+"\n");
fs.writeFileSync(process.env.FIX+"/rampleak7d.txt", "x "+d0+"\n");
'
SOAK="$FIX/rampleak7d.jsonl" SOAK_DAY0="$FIX/rampleak7d.txt" SOAK_VERDICT="$FIX/rgv.jsonl" \
DOTD_WATCHDOG_LOG="$FIX/nowd.log" DOTD_BOOT_LOG="$FIX/noboot.log" \
  bash scripts/soak.sh report >"$FIX/rampleak.out" 2>&1
_ramp(){ if grep -qa "$1" "$FIX/rampleak.out"; then p=$((p+1)); printf "  ok   %-30s\n" "$2"
         else f=$((f+1)); printf "  FAIL %-30s\n" "$2"; fi; }
_ramp '❌ RSS 增长'                    "斜坡-段内增长判红"
_ramp '❌ \*\*全窗口 RSS 峰值增长'      "斜坡-峰值增长判红"

# ===== 第 106 轮新增：验收文档不能变成谎言 =====
# 教训：docs/ 下四份报告是 10-19 19:37 写的快照，而这轮发现
# soak-report.md 的标题还写着「现在的真实状态（2026-10-19 19:35）」
# —— 而真实 7 天窗口是 10-20 06:43:55 才起算的。**读者会以为那份就是现在。**
# 文档会腐烂，而且腐烂时不会报错。这条用例锁住三件事：
#   ① ACCEPTANCE.md 存在
#   ② 四份报告都带了「本文有时效性」的声明
#   ③ ACCEPTANCE.md 里写的证据文件路径真实存在
if [ -f docs/ACCEPTANCE.md ]; then
  p=$((p+1)); printf "  ok   %-30s\n" "文档-ACCEPTANCE存在"
else
  f=$((f+1)); printf "  FAIL %-30s\n" "文档-ACCEPTANCE存在"
fi
for _r in acceptance-report honesty-report recovery-report soak-report; do
  if grep -qa '本文有时效性' "docs/$_r.md" 2>/dev/null; then
    p=$((p+1)); printf "  ok   %-30s\n" "文档-${_r}有时效声明"
  else
    f=$((f+1)); printf "  FAIL %-30s\n" "文档-${_r}有时效声明"
  fi
done
# ACCEPTANCE.md 里提到的证据文件必须真的在（防止写了不存在的路径）
for _e in docs/acceptance/s2b-reuse.jsonl docs/acceptance/results.jsonl \
          docs/acceptance/honesty.jsonl docs/acceptance/recovery.jsonl; do
  if grep -qa "$_e" docs/ACCEPTANCE.md && [ -f "$_e" ]; then
    p=$((p+1)); printf "  ok   %-30s\n" "文档-引用真实存在:$(basename $_e)"
  else
    f=$((f+1)); printf "  FAIL %-30s 文档提到的证据文件不存在或没提到\n" "文档-引用真实存在:$(basename $_e)"
  fi
done
# 「现在的真实状态」这种会骗人的标题不许再出现
# 范围要精确：只查四份**验收报告**。
# 第一版写成 `docs/*.md`，结果命中了 optimization-2026-10-17.md 的
# 「## 27. 现在的真实状态」—— 那份标题带日期，本来就不骗人。
# 判据范围过宽 = 误报，而误报是我自己造成的（R94）。
if grep -qaE '^## .*现在的真实状态' \
     docs/acceptance-report.md docs/honesty-report.md \
     docs/recovery-report.md docs/soak-report.md 2>/dev/null; then
  f=$((f+1)); printf "  FAIL %-30s 有会被误读成当下的标题\n" "文档-不得有『现在的』标题"
else
  p=$((p+1)); printf "  ok   %-30s\n" "文档-不得有『现在的』标题"
fi

# ===== 第 108 轮新增：非 cron 采样必须被看见 =====
# 教训：`soak.sh:2467` 是 `case "${1:-sample}"` —— **不带参数 = 执行 sample**。
# 第 108 轮我为了验「cron 的最小环境能不能跑通」，裸跑了一次，
# 于是窗口里多了一条 11:18:00 的点，采样密度从 100% 虚高到 120%。
# 数据没删（删就是篡改证据），但必须让验收人看得见。
# 这条用例锁住：verify-goal.sh 能把「非整点采样」报出来。
# **不要在一条断言里用 && 串起两个不同文件的判断**（第 108 轮踩到）。
# 第一版写 `[ -f soak-notes.md ] && grep 11:18:00 && grep '非 cron' NO-ARG-TRAP.md`，
# 结果 FAIL —— 而前两个条件都是真的，只是 NO-ARG-TRAP.md 里我写的是
# 「不会报错，不会提示，不会问你要不要」而不是「非 cron」。
# **断言的用词和文档的用词没对上，而 && 让我看不出是哪个条件挂了。**
# 拆成两条独立断言，各自只问一件事。
if [ -f docs/acceptance/soak-notes.md ] \
&& grep -qa '11:18:00' docs/acceptance/soak-notes.md; then
  p=$((p+1)); printf "  ok   %-30s\n" "旁注-污染事件有记录"
else
  f=$((f+1)); printf "  FAIL %-30s\n" "旁注-污染事件有记录"
fi
# `verify-goal.sh` 里必须有这条检测（用 grep 找它的特征字符串，不真跑）
if grep -qa '非 cron 整点采样' scripts/verify-goal.sh; then
  p=$((p+1)); printf "  ok   %-30s\n" "旁注-verify-goal会报非整点"
else
  f=$((f+1)); printf "  FAIL %-30s\n" "旁注-verify-goal会报非整点"
fi
# **裸跑 soak.sh 等于写数据**，这个陷阱必须在文档里写明白
# 文档必须说清「无参数 = 写一行」，而不只是贴一行代码
if grep -qa '1:-sample' docs/acceptance/NO-ARG-TRAP.md \
&& grep -qaE '不带任何参数|追加一行|写一行' docs/acceptance/NO-ARG-TRAP.md; then
  p=$((p+1)); printf "  ok   %-30s\n" "旁注-裸跑陷阱有文档"
else
  f=$((f+1)); printf "  FAIL %-30s\n" "旁注-裸跑陷阱有文档"
fi

echo "  合计 $p 通过 / $f 失败"
[ "$f" = "0" ] && exit 0 || exit 1
