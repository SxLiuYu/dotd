#!/usr/bin/env bash
# S6 长期运行（7 天）验收工具。
#
# 判据（原文）：连续 7 天不干预；RSS 增长 < 50MB；成功率保持；无句柄泄漏。
#
# 为什么这么设计：7 天没法"跑一下就算完"。只能**真的跑 7 天**，
# 期间每 30 分钟采一次样、每 6 小时跑一次真实业务探针。所以这里提供：
#   sample  —— 采一个数据点（RSS / fd / 线程数 / 容器状态），追加到 soak.jsonl
#   probe   —— 跑一条真实业务任务（不是端口探测），记录成功/失败
#   report  —— 读 soak.jsonl，算已运行时长、RSS 增长、fd 增长、成功率，给结论
#
# 采样本身**绝不重启任何东西**：一旦它去"修理"，测的就不是长期稳定性了。
#
# 装进 cron（见 install_cron 输出）：
#   */30 * * * *  soak.sh sample
#   0 */6 * * *   soak.sh probe
set -uo pipefail
cd /root/dotd || exit 1
OUTDIR=/root/dotd/docs/acceptance
mkdir -p "$OUTDIR"
# 允许用 SOAK=... 覆盖，便于用合成数据验证 report 的判断逻辑是否真的判得对
# （不然只能等 7 天才能知道"它会判错吗"，那太晚了）。
# **记录 SOAK 是不是用户覆盖的**（2026-10-19）：下面 day0 核对只在"真跑"时生效。
if [ -n "${SOAK:-}" ]; then export SOAK_OVERRIDDEN=1; fi
SOAK="${SOAK:-$OUTDIR/soak.jsonl}"
export SOAK
# **窗口起点必须是可核对的独立事实**（2026-10-19 补，真缺口）：
# `docs/acceptance/soak-day0.txt` 从第 1 轮就存在，但**没有任何代码读它** ——
# 它只是我手写的一个备注。报告的"已观测 N 天"完全由 JSONL 首尾样本算出。
# 于是：**把 soak.jsonl 清空重来，窗口就静默重置了，没人知道**。
# 合成场景：跑了 3 天 → 清空 → 又跑 8 天。报告会说"8 天、密度 100%、成功率 100%、
# 全部 ✅"，而真实经过的时间是 11 天，其中有一次重置动作被抹掉了。
# 判据是"**连续** 7 天无人工干预"，"连续"必须能对抗"清空重来"。
# 所以把 day0 抬成判据的一部分：
#   ① 数据里最早的样本不能**晚于** day0 + 容忍（说明数据被重置过）
#   ② day0 本身不能被改动（它写在文件里，改动会留下痕迹 —— 但我们能核对的是
#      "当前数据是否覆盖得住 day0"，这已经能挡住清空重来）
# 只在跑真实窗口时生效（合成数据测试用 SOAK= 覆盖，没有 day0 文件，跳过）。
DAY0_FILE="${SOAK_DAY0:-$OUTDIR/soak-day0.txt}"
export DAY0_FILE

PID_DAEMON() { pgrep -f 'src/daemon.ts' | head -1; }

do_sample() {
  local pid rss_kb fd n_threads cont db_kb ts
  # **每次 sample 运行都要留痕，不管结局是什么**（2026-10-20 补，S6 真缺口）。
  #
  # 现场：syslog 明确记录 03:30:01 cron 跑了 `soak.sh sample`，
  # 但 soak.jsonl 里没有那一条。查下去是我当时正在反复改写 soak.sh，
  # 脚本短暂处于语法错误状态，cron 的输出被 `>/dev/null 2>&1` 吞掉 ——
  # **什么都没留下**。
  #
  # soak.jsonl 现在只有"有记录"和"没记录"两种状态，没记录时无法区分：
  #   ① cron 没跑（机器挂了 / cron 服务停了）
  #   ② 脚本语法错了（我改坏的）
  #   ③ probe 正在跑（主动跳过）
  #   ④ 同一秒重跑（主动跳过）
  # 而 ② 恰恰是 7 天窗口里最可能发生的一种 —— 是我自己的操作造成的。
  # 采样密度判据（≥70%）能兜住"丢太多"，但兜不住"为什么丢"，
  # 而"为什么"决定了这次算不算人工干预。
  #
  # 所以**无条件先登记一行心跳**，再去做事。文件很小（每次一行约 60 字节，
  # 7 天 336 行 ≈ 20KB），report 时能对出"cron 跑了但没采到"的具体原因。
  local HB="${SOAK_HB:-$(dirname "$SOAK")/soak-heartbeat.log}"
  local _hbts; _hbts=$(date +%s)
  printf '%s start pid=%s\n' "$_hbts" "$$" >>"$HB" 2>/dev/null || true
  # **probe 正在跑的时候不要采样**（2026-10-20 修，真缺陷）。
  # 现场：soak.jsonl 里出现 fd=31，而 daemon 静息一直是 27。
  # 查下去是我手工跑 probe 时，cron 的 sample 恰好也在跑 ——
  # probe 要发飞书消息、等任务 done，期间 daemon 会开 HTTP 连接，
  # 实测 fd 27 → 30，结束后回落到 27。**sample 采到的是 probe 的瞬时负载，不是泄漏。**
  # 更糟的是 cron 本身就会撞：`*/30` 的 sample 在 :00/:30，
  # `0 */6` 的 probe 也在 :00 —— **每 6 小时必然撞一次**，7 天 28 次。
  # 已经做了两件事：
  #   ① cron 把 probe 挪到 :15（避开 :00/:30）；
  #   ② 这里再加一道保险：真撞上了就**跳过这次采样**（宁缺不脏）。
  #      缺口由采样密度判据兜底（≥70%，跳过 28 次 / 336 次 = 8.3%，仍在阈值内）。
  if pgrep -f "soak\.sh probe" >/dev/null 2>&1; then
    printf '%s skip probe-running\n' "$(date +%s)" >>"$HB" 2>/dev/null || true
    echo "sample: skip（probe 正在跑，采到的 fd/RSS 会是它的瞬时负载）"
    return 0
  fi
  ts=$(date +%s)
  # **同一秒不要重复落盘**（2026-10-19 补）：date +%s 只有秒精度，
  # 手工连跑两次 sample、或 cron 与手工调用撞上，会写出两行完全相同的记录。
  # 真实发生在我自己测试时（连跑两次 sample，两行 ts 都是 1792417117），
  # 虽然 report 现在会按 ts 去重，但**别让脏数据进文件**更干净。
  if [ -n "${SOAK:-}" ] && [ -s "$SOAK" ]; then
    local last_ts
    last_ts=$(tail -1 "$SOAK" 2>/dev/null | grep -o '"ts":[0-9]*' | head -1 | cut -d: -f2)
    if [ "$last_ts" = "$ts" ]; then
      printf '%s skip same-second\n' "$(date +%s)" >>"$HB" 2>/dev/null || true
      echo "sample: 同一秒已有记录（ts=$ts），跳过避免重复"
      return 0
    fi
  fi
  pid=$(PID_DAEMON)
  if [ -z "$pid" ]; then
    node -e 'const fs=require("fs");fs.appendFileSync(process.env.SOAK, JSON.stringify({ts:Number(process.argv[1]),alive:false})+"\n")' "$ts"
    printf '%s dead daemon\n' "$(date +%s)" >>"$HB" 2>/dev/null || true
    echo "daemon 不在跑（已记录 alive=false）"
    return 0
  fi
  # **读不到 RSS 时不写 0**（2026-10-20 修，真缺陷）。
  #
  # 原来 `|| echo 0`：/proc/<pid>/status 读失败（进程刚退出、权限变化、
  # 采样撞上 exec 的瞬间）就记 `rss_kb: 0`。而 0 在判据里是**一个有效的极小值**：
  #   · 落在首尾 → 算出"RSS 增长 200MB → 0MB"，还打印 `✅ RSS 增长 <50MB`
  #   · 落在末尾 → 段内斜率算出 **-3.08MB/h**（负数，"在释放内存"）
  #   · 落在峰值 → 把真泄漏的峰值削平
  # 合成数据实测：真泄漏 200→300MB、最后 30 点读失败 →
  #   `✅ RSS 增长 <50MB` 与 `❌ 峰值增长 90.2MB` **同时出现**，
  #   还附一条 `⚠ 段内爬升 -3.08MB/h`。同一份数据三个说法，两个是凭空来的。
  #
  # 正确做法：读不到就**不写这个字段**（与 `container_ok`/`relay_up` 的"字段缺席"同一套语义），
  # 判据侧只统计真正有值的点。这与第 66/67 轮那两条判据是同一个规矩：
  # **"没测到"不等于"测到 0"**。
  rss_kb=$(awk '/^VmRSS:/{print $2}' "/proc/$pid/status" 2>/dev/null | head -1)
  # **fd / threads 读不到时也不能写 0**（2026-10-20 修，与 rss_kb 同一个病根）。
  #
  # 上面 RSS 那次（第 68 轮）的注释说得很清楚了，但**只修了 RSS 一个字段**。
  # 而 `ls /proc/$pid/fd 2>/dev/null | wc -l` 在 `ls` 失败时输出 **0** ——
  # 「0 个句柄」是一个**有效的小值**，判据会当成真实数据。
  #
  # 合成实测：fd 27→45 真泄漏（+18，峰值增长 18 < 门槛 20），
  # 末尾 20 点因为 ls 失败写 0 → 报告打印
  #   `✅ 无明显句柄泄漏` / `✅ 全窗口句柄峰值增长 17 < 20` / `exit 0`，
  # 而 `句柄: 首段中位 28 → 末段中位 0` 这行**自己就写着 0**，没人看。
  # 真泄漏被判成交付合格。
  #
  # 修法与 RSS 完全一致：**读不到就不写这个字段**，判据侧只统计有值的点。
  n_threads=$(ls "/proc/$pid/task" 2>/dev/null | wc -l)
  [ "$n_threads" = "0" ] && n_threads=""     # 0 个线程不可能是活的 node
  fd=$(ls "/proc/$pid/fd" 2>/dev/null | wc -l)
  [ "$fd" = "0" ] && fd=""                  # 0 个句柄不可能是活的 node
  cont=$(docker ps --filter name=dotd-dot-dot1 --format '{{.Status}}' 2>/dev/null | grep -c Up || true)
  db_kb=$(stat -c '%s' "$HOME/.dotd/dotd.db" 2>/dev/null | awk '{print int($1/1024)}')
  # **容器"能干活"和"在跑"是两回事**（2026-10-20 修，S6 判据内的致命盲区）。
  #
  # 现场（第 33 轮）：容器 `Up 6 hours`、daemon 活着、RSS/句柄全正常，
  # 但**所有容器工具返回 container_not_ready**，持续了整整 5 小时。
  # 主人发来的每条命令都失败、模型连试 3 次后把 DSML 标签原样吐出去。
  # 而当时报告是**全绿**的 —— 因为 `container_up` 只看 `docker ps` 的 `Up`，
  # 看不出"daemon 以为它不可用"（记录里是 unhealthy，工具门控直接拒绝派发）。
  #
  # 判据"成功率不掉"本来能抓到，但它的采样密度是**每 6 小时 4 颗探针**，
  # 而这次故障只持续 5 小时 —— **恰好能躲在两次探针之间**。
  # 判据没错，是采样频率低于故障存活时间。所以在这里补一个**每 30 分钟**的
  # 低成本能力探针：直接拿**库里那个 endpoint**（daemon 实际会用的那个）打 /healthz。
  # 11 毫秒、不过模型、不进任务队列，纯粹回答"daemon 现在能不能用容器"。
  #
  # 为什么用库里的 endpoint 而不是 `docker inspect` 的真实 IP：
  # 故障的本质就是**这两者不一致**（库里 172.18.0.3，实况 172.21.0.2）。
  # 拿真实 IP 去打永远 200，等于什么都没测。必须用 daemon 会用的那个。
  cont_ok=0
  if [ -f "$HOME/.dotd/exec-tokens/dot1.token" ]; then
    ep=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT endpoint FROM containers WHERE dot_id=? ORDER BY id DESC LIMIT 1").get("dot1");
process.stdout.write(r && r.endpoint ? r.endpoint : ""); db.close();' 2>/dev/null)
    if [ -n "$ep" ]; then
      code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' \
        -H "Authorization: Bearer $(cat "$HOME/.dotd/exec-tokens/dot1.token")" "$ep/healthz" 2>/dev/null)
      [ "$code" = "200" ] && cont_ok=1
    fi
  fi
  # **网关（relay）通不通也必须采样**（2026-10-20 修，归因缺一环）。
  #
  # 第 58 轮修了"容器坏了赖模型"，靠的是把失败探针的时刻与 container_ok 对齐。
  # 但**通道还有一段没采**：模型服务在 Windows 上，WSL 里通过 win-relay
  # （172.17.48.1:13065）出去。这条链断了，探针必然全失败 ——
  # 而 sample 里既没有 relay 字段，contBadAt 自然无法归因，
  # 报告就会写「出站入站都正常、容器也好但**答案不对**」。
  # 模型根本没被问到，却被判成答错。
  #
  # 合成数据实测（7 天窗口、容器全程好、relay 断 14 小时）：
  #   3 次探针失败 → 报告「3 次出站入站都正常、容器也好但答案不对」，exit 1。
  # 归因完全错误，方向指向模型，真相在网关。
  #
  # 这里只做一个 TCP 连通性探测（3 秒超时，不过模型、不进队列）：
  relay_ok=0
  if timeout 3 bash -c 'exec 3<>/dev/tcp/172.17.48.1/13065' 2>/dev/null; then
    relay_ok=1
  fi
  # **daemon"进程在"和"服务能用"是两件事**（2026-10-20 补，第 33 轮的同一个病根）。
  #
  # 第 33 轮发现：容器 `Up 6 hours`、daemon 活着、RSS/句柄全正常，
  # 但所有容器工具持续 5 小时返回 container_not_ready，而报告全绿。
  # 修法是加 `container_ok`（直接打 daemon 会用的那个 endpoint）。
  #
  # 但那个修法**只管了容器，没管 daemon 自己**：
  # `alive` 只判断 `PID_DAEMON` 能不能找到进程 —— 死锁、事件循环卡住、
  # busy-loop、SQLite 锁住，这些情况下进程好好的、RSS 正常、句柄正常，
  # **但 HTTP 一个都不回**。主人发的消息全部石沉大海。
  #
  # 合成数据实测（7 天、进程全程 alive=true、中间 10 小时 HTTP 打不通）：
  #   报告全绿 exit 0，**一次都没提到 http**。
  # 因为 sample 里根本没有这个字段 —— 又是第⑤类的反面（没采集所以无法判定）。
  #
  # 这里打 `/api/health`（3 秒超时，不过模型、不进队列）。
  # 用 127.0.0.1 而不是 0.0.0.0：要测的就是"本机能不能用"，
  # 绑到哪个网卡是 daemon 自己的事，不该由采样器猜。
  http_ok=0
  http_code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${DOTD_HTTP_PORT:-7788}/api/health" 2>/dev/null)
  [ "$http_code" = "200" ] && http_ok=1
  # **记录 daemon 身份**（进程启动时刻 + pid）。没有这个，RSS 判据是假的：
  # 2026-10-19 实测就踩到了 —— 采样 3 个点算出"RSS 增长 -32.1MB"，看着很好，
  # 其实是中途 daemon 被重启过，拿"新进程的小内存"减"旧进程的大内存"，
  # 毫无意义。只有同一个 daemon 生命周期内的首尾差才是"增长"。
  # **进程启动时刻不能用 `stat -c %Y /proc/$pid`**（2026-10-19 修，真缺陷）：
  # 那是 /proc/<pid> **目录的 mtime**，进程一新增 fd/线程就会变。
  # 现场：报出"生命周期数 2"但两段的 pid 都是 1303 —— 同一个进程被算成两次重启，
  # 于是凭空冒出一条"无自愈记录，疑似人工干预"，把报告搞成假警报。
  # 正确做法：/proc/stat 的 btime（开机时刻）+ /proc/<pid>/stat 第 22 字段（启动后 tick 数）。
  proc_start=$(awk -v pid="$pid" '
    BEGIN{ while((getline l < "/proc/stat")>0) if(l ~ /^btime/){ split(l,a," "); bt=a[2]; break } close("/proc/stat") }
    { n=split($0,f," "); print bt + int(f[22]/100) }' "/proc/$pid/stat" 2>/dev/null | head -1)
  proc_start=${proc_start:-0}
  node -e '
const fs=require("fs");
const o={ts:Number(process.argv[1]),alive:true,
  ...(process.argv[2]!==""?{rss_kb:Number(process.argv[2])}:{}),
  // 与 rss_kb 同一套：空串 → **不写这个字段**，而不是写成 0。
  ...(process.argv[3]!==""?{fd:Number(process.argv[3])}:{}),
  ...(process.argv[4]!==""?{threads:Number(process.argv[4])}:{}),
  container_up:Number(process.argv[5]),db_kb:Number(process.argv[6]),
  pid:Number(process.argv[7]),proc_start:Number(process.argv[8]),
  container_ok:Number(process.argv[9]),
  relay_up:Number(process.argv[10]),
  http_ok:Number(process.argv[11])};
fs.appendFileSync(process.env.SOAK, JSON.stringify(o)+"\n");' \
    "$ts" "$rss_kb" "$fd" "$n_threads" "$cont" "${db_kb:-0}" "$pid" "${proc_start:-0}" "${cont_ok:-0}" "${relay_ok:-0}" "${http_ok:-0}"
  printf '%s ok ts=%s\n' "$(date +%s)" "$ts" >>"$HB" 2>/dev/null || true
  echo "sample: rss=${rss_kb}KB fd=$fd threads=$n_threads container_up=$cont container_ok=$cont_ok db=${db_kb}KB pid=$pid"
}

do_probe() {
  local tid st t0 ok=0 ts
  # **"没测到" 和 "测到失败" 不能都写成空串**（2026-10-20 修）。
  #
  # 现场：7 个任务 status=done、答案也对，但主人什么都没收到 ——
  # 因为任务全过程只有 tool_call、没有一句 kind='text' 的正文，
  # lastAssistantText() 返回 null，出站被静默跳过（feishu-outbound.ts L257）。
  # 而 probe 这边：OUT_OK 只在"进了 done 分支并查过出站表"时才赋值，
  # 没进分支就从未定义 → 落盘时写成空字符串 `"out":""`。
  # 结果：**"根本没检查" 和 "检查了但没发出去" 在数据里长得一模一样**，
  # 事后分不清是该查"模型没给正文"还是"飞书没发出去"。
  # 所以先把两个子判据显式初始化为 "?"（未测），测到了再写 0/1。
  local OUT_OK="?" WS_OK="?"
  ts=$(date +%s)
  set -a; . ./_tokens_src.env 2>/dev/null; set +a
  local base=http://127.0.0.1:7788
  # daemon 的 stdout 日志：用来判断飞书长连接状态（见下面入站判据）
  local DOTD_LOG="${DOTD_DAEMON_LOG:-/tmp/dotd-wsl.log}"
  local hdr=(-H "Authorization: Bearer ${DOTD_MASTER_TOKEN:-}" -H "Content-Type: application/json")
  t0=$(date +%s)
  # **探测必须真的测能力**（2026-10-19 改）：原来只发"回复 OK 两个字母就行"，
  # 那只能证明进程还活着，证明不了"成功率不掉"——而后者才是 S6 的判据。
  # 现在按小时轮换四种真实任务，覆盖 模型 / 容器 / 工具 / 文件 四条路径；
  # 轮换用确定性取模，所以长期跑下来每类都会被平均覆盖到，且可复现。
  # **轮换不能用 date +%H % 4**（2026-10-19 修）：probe 的 cron 是 `0 */6 * * *`，
  # 只会在 00/06/12/18 点触发，而这些小时的 %H%4 只会是 0 和 2 ——
  # slot 1（纯推理）和 slot 3（容器执行）**永远轮不到**，等于一半能力没被测。
  # 改成"用已有记录数做轮换指针"，每跑一次就推进一格，与触发时刻无关。
  local prev_n slot
  # 注意：`grep -c` 在"文件存在但无匹配"时会**同时**返回退出码 1 并打印 0，
  # 于是 `$(grep -c ... || echo 0)` 会拼出 "0\n0"，随后 `$(( ... ))` 直接语法错误。
  # 这是真会发生的：换新 soak.jsonl / 只有 sample 没有 probe 时就是空匹配。
  prev_n=$(grep -c '"kind":"probe"' "$SOAK" 2>/dev/null | head -1)
  prev_n=${prev_n:-0}
  slot=$(( prev_n % 4 ))
  local prompt
  case "$slot" in
    0) prompt="回复 OK 两个字母就行" ;;                                        # 纯存活
    1) prompt="350 减 405 等于多少？只回数字" ;;                                # 纯推理
    2) prompt="读一下 /dot/home/q3-sales.txt，只回文件里的总目标数字" ;;          # 文件+工具
    3) prompt="用 shell 算一下 6 的 12 次方，只回数字" ;;                       # 容器执行
  esac
  local want
  case "$slot" in
    0) want="OK" ;; 1) want="-55" ;; 2) want="350" ;; 3) want="2176782336" ;;
  esac
  local answer
  answer=$(printf '%s' "$prompt" | sed 's/\\/\\\\/g')
  tid=$(curl -s -m 20 "${hdr[@]}" -X POST --data-binary "{\"text\":$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$prompt")}" "$base/api/messages" \
        | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
  if [ -n "$tid" ]; then
    local deadline=$(( $(date +%s) + 120 ))
    while [ $(date +%s) -lt $deadline ]; do
      st=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$tid")
      if [ "$st" = "done" ]; then
        # done 只说明任务收口了，不说明答对了 —— S6 的"成功率不掉"要的是"还干得对"。
        local ans
        ans=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const m = db.prepare("SELECT content FROM mem_messages WHERE task_id=? AND role=? AND kind=? ORDER BY seq DESC LIMIT 1").get(process.argv[1],"assistant","text");
process.stdout.write(m ? String(m.content) : ""); db.close();' "$tid")
        # 统一判据：回答里必须出现期望值。**不要写成 case + 通配 default**：
        # 我第一版就是 `*) ok=1 ;;`，结果把 want 故意改成 -999999 时 ok 仍然是 1 ——
        # 也就是说任何"没预料到的期望值"都会自动算过。那等于这条判据永远为真，
        # 正是这一路反复要防的"判据自己会说谎"。
        if [ -n "$want" ] && printf '%s' "$ans" | grep -qF -- "$want"; then
          ok=1
        else
          ok=0
        fi
        # **还要确认它真的发到飞书了**（2026-10-19 补）：
        # 这个项目的目标原话是"在**飞书**里替你实际干活的助手"，但原来 probe
        # 只核对库里的回答内容 —— 也就是说飞书 token 过期/权限被收回时，
        # 任务照样 done、答案照样对，而用户**一个字都收不到**，probe 依然报 ok=1。
        # 出站写入发生在任务 done 之后约 0.6s，所以要等一小会儿再看，别立刻判失败。
        local out_ok=0 tries=0
        while [ $tries -lt 10 ]; do
          out_ok=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT ok FROM surf_outbound_log WHERE dedup_key=? ORDER BY id DESC LIMIT 1").get(process.argv[1]);
process.stdout.write(r ? String(r.ok) : ""); db.close();' "$tid")
          [ "$out_ok" = "1" ] && break
          tries=$((tries+1)); sleep 1
        done
        [ "$out_ok" = "1" ] || ok=0
        OUT_OK=$out_ok
        # **还要确认飞书那条入站长连接还活着**（2026-10-19 补，真缺口）：
        # probe 走的是 HTTP API，**完全绕开飞书入站**。所以长连接断了、重连也失败时，
        # 用户在飞书里发消息根本没人接，而 probe 照样 ok=1、报告全绿。
        # 这条路径是"在飞书里干活"的另一半（出站已验证，入站一直没验）。
        # 判据：日志里最近一次长连接状态必须是"已建立/已恢复"，
        # 不能停在"断开，重连中"或"错误"上。
        # 注意别误杀：daemon 重启时日志会被轮转（mv 成 .prev），新日志里
        # 长连接状态要过几秒才出现。若 probe 恰好落在重启后那一瞬，
        # 会看到"还没有状态"而误判入站已坏 —— 那是**自愈刚完成**，不是故障。
        # 所以判 0 之前先等一等（最多 3×2s），仍没有才认定断开。
        local ws_state ws_ok=0 i
        for i in 1 2 3; do
          ws_state=$(grep -oE '飞书长连接(已建立（事件订阅就绪）|已恢复|断开，重连中…|错误：[^ ]*)' "$DOTD_LOG" 2>/dev/null | tail -1)
          case "$ws_state" in
            *已建立*|*已恢复*) ws_ok=1; break ;;
            *断开*|*错误*) : ;;    # 明确的坏状态，也再等一轮看会不会恢复
            *) : ;;                 # 还没有状态（刚启动），等
          esac
          [ "$i" -lt 3 ] && sleep 2
        done
        WS_OK=$ws_ok
        [ "$WS_OK" = "1" ] || ok=0
        # 记下这轮到底考了什么，报告里能看出覆盖
        PROBE_SLOT=$slot; PROBE_WANT=$want
        break
      fi
      case "$st" in failed|cancelled|paused) break ;; esac
      sleep 3
    done
  fi
  node -e '
const fs=require("fs");
const o={ts:Number(process.argv[1]),kind:"probe",ok:process.argv[2]==="1",
  taskId:process.argv[3]||"",status:process.argv[4]||"",secs:Number(process.argv[5]),
  slot:process.argv[6],want:process.argv[7],
  // **把两个子判据分别记下来**（2026-10-19 补）：ok 是"答对 且 发到飞书"的合成结果，
  // 只存 ok 的话，7 天里某次失败事后完全分不清是"模型答错了"还是"飞书没发出去"，
  // 而这两种的处置完全不同。7 天要跑 168 小时，出问题必须能事后归因。
  out:process.argv[8]||"",ws:process.argv[9]||""};
fs.appendFileSync(process.env.SOAK, JSON.stringify(o)+"\n");' \
    "$ts" "$ok" "$tid" "${st:-}" "$(( $(date +%s) - t0 ))" "${PROBE_SLOT:-}" "${PROBE_WANT:-}" "${OUT_OK:-}" "${WS_OK:-}"
  echo "probe: slot=${PROBE_SLOT:-?} want=${PROBE_WANT:-?} ok=$ok status=${st:-none} 飞书出站=${OUT_OK:-?} 飞书入站=${WS_OK:-?} secs=$(( $(date +%s) - t0 ))"
}

do_report() {
  # **JS 落到临时文件再跑，不用 `node -e`**（2026-10-20，真缺陷）。
  #
  # 现场：加了 92 行注释 → `scripts/soak.sh: line 358: /usr/bin/node: Argument list too long`。
  # 删掉注释就恢复 —— 说明它**一直贴在悬崖边**，只是这次被推了下去。
  #
  # 根因不是注释长，是 `node -e '<1744 行 JS>'` 这个形状本身：
  # Linux 对**单个参数**有 `MAX_ARG_STRLEN = PAGE_SIZE*32 = 131072` 字节的上限，
  # 而这段 JS 已经是 **132979 字节**（中文注释 3 字节/字，涨得比看起来快）。
  # 注意 `getconf ARG_MAX` 报的是 2MB —— 那是**所有参数总长**，很容易被它误导，
  # 于是错误信息「Argument list too long」看起来完全对不上数。
  #
  # 这也解释了为什么这个脚本每加一条判据就更容易崩：它的**判据全在一个参数里**。
  # 落盘成文件之后，脚本长度和参数量解耦，再加多少注释都不会撞这条线。
  _SOAK_JS=$(mktemp)
  trap 'rm -f "$_SOAK_JS"' EXIT
  cat >"$_SOAK_JS" <<'__SOAK_REPORT_JS__'
const fs=require("fs");
// **一行坏 JSON 不能毁掉 7 天的数据**（2026-10-19 修，真缺陷）：
// 原来整个文件一次性 map(JSON.parse)，只要有一行残缺（进程被 kill、
// 断电、磁盘写一半）就抛错，被外层 catch 吞掉 → lines 为空 →
// 报告打印"还没有可用于判据的样本"，看上去像"你还没开始"，实际 384 条好样本
// 就躺在文件里。7 天要追加 336 次，中途被打断是现实概率事件。
// 改为逐行解析：坏行跳过并**数出来**，报告里明说跳了几条 —— 不静默。
let lines=[], badLines=0;
try{
  for(const ln of fs.readFileSync(process.env.SOAK,"utf8").split("\n")){
    if(!ln.trim()) continue;
    try{ lines.push(JSON.parse(ln)); }catch{ badLines++; }
  }
}catch{}
// **探针也必须去重**（2026-10-19 补）：第 12 轮我给**样本**做了去重
// （同一 (ts,proc_start,pid) 只算一次），但 `probes` 一直是 `lines.filter` 直取，
// **一行都没去掉**。同一个坑换了个地方。
// 合成数据实测：真实只跑了 8 次探针（8 天应 32 次 = 25%），
// 但每行被写进文件 4 遍（重复写入 / 复制粘贴 / 重跑补写）→ 文件里 32 行 →
// 报告打印"探针密度 32/32 = 100%（判据 ≥70%）"、成功率 100%。
// 密度判据被自己的重复行骗过去了。
// 去重键取 (ts, taskId)：同一次探针被重复写入时这两者都相同；
// 而两次真的探针不可能落在同一秒且拿到同一个 taskId。
const seenProbeKey=new Set();
let dupProbes=0;
const probesRaw=lines.filter(x=>x.kind==="probe");
const probes=[];
for(const x of probesRaw){
  const k=String(x.ts)+"|"+String(x.taskId||"");
  if(seenProbeKey.has(k)){ dupProbes++; continue; }
  seenProbeKey.add(k); probes.push(x);
}
// **"已验飞书"的探针单列**（2026-10-19 补，真缺口）：
// 早期版本的探针只发 HTTP、查 daemon 有没有回话，**根本没验飞书送达**，
// 记录里没有 out/ws 字段，但 ok=true。
// 这些旧记录混进来会把"成功率"和"密度"同时抬高：
// 合成数据实测 28 条真探针 + 100 条旧探针（没验过飞书）
// → 打印"成功率 100%"、exit 0；更糟的是"只有旧探针"时
// passRate=null 又被当成通过 —— 同一个"零证据也算通过"的坑换了个地方。
// 判据要的是"在飞书里真的能干活的成功率"，所以只用验过出站+入站的探针。
const probesVerified = probes.filter(p=>p.out!==undefined && p.ws!==undefined);
const probesLegacy = probes.length - probesVerified.length;
// **report 不能只信采集时算的 `ok`，必须自己复核一遍**（2026-10-20 补，真假绿）。
// 采集侧（do_probe）的逻辑是对的：`out_ok!=1 → ok=0`、`ws_ok!=1 → ok=0`。
// 但 report 这边**只看 `p.ok`，从不看 `out`/`ws` 是否与它一致** ——
// 于是采集侧任何一处算错，report 一点都发现不了。而这已经发生过两次：
// ① 早期 `case ... *) ok=1` 兜底，把 want 改成 -999999 也判过；
// ② `OUT_OK` 未定义时落盘成空串，"没测到"和"测到失败"长得一样。
// 合成数据实测：把 29 次探针**全部改成 out=0 ws=0**（飞书出站入站全断），
// 只要 `ok` 仍是 true，report 就打印 `成功率 100%` 并 **exit 0**。
// 也就是说 "在飞书里干活" 这个目标原话，在 report 侧**没有独立证据**。
// 修法：独立重算。`out`/`ws` 里只要有一个明确是 "0"，这条就该算失败 ——
// **不管 `ok` 写的是什么**。两者不一致时单独报出来（那是采集端的 bug）。
// 定义必须放在 probesVerified 之后、tailPassRate 之前（后者也要用）。
const outWsSaysFail=(p)=>String(p.out)==="0" || String(p.ws)==="0";
const okSaysFail=(p)=>p.ok!==true;
const probeFailed=(p)=>okSaysFail(p) || outWsSaysFail(p);
const probeContradictions=probesVerified.filter(p=>p.ok===true && outWsSaysFail(p));

// 末尾成功率：**"不掉"不等于"总平均够"**，总平均会掩盖下降趋势。
// 合成数据实测：160 次探针里最后 8 次全失败（最后一天成功率 0%），
// 总数恰好 95% 压线 → exit 0，服务其实最后一天已经全坏了。
// 定义必须放在这里（密度/覆盖判据在更早位置要用），
// 放到 passOk 旁边会 TDZ —— 我踩了一次，靠上一轮加的 exit 2 立刻发现。
// 末尾取最后 4 个（cron 每 6 小时一次 → 约覆盖最后 1 天）。
// 这里写 4 而不引用 PROBE_PER_DAY：那个常量定义在后面，会 TDZ。
const TAIL_PROBES=4;
const tailProbes=probesVerified.slice().sort((a,b)=>a.ts-b.ts).slice(-TAIL_PROBES);
const tailPassRate=tailProbes.length? tailProbes.filter(p=>!probeFailed(p)).length/tailProbes.length : null;

// **探针必须覆盖四条能力路径**（2026-10-19 补，真缺口，也是最根本的一次）：
// 探针按 slot 轮换四种任务：
//   0 纯存活（"回复 OK"）  1 纯推理（350-405）  2 读文件  3 容器执行（6^12）
// 轮换指针是 `prev_n % 4`，理论上会轮遍。但**判据从来没检查过实际覆盖**：
// 合成数据实测 32 次探针**全部 slot=0**（只证明进程还活着），
// 容器执行/文件读取/纯推理三条路径 7 天零覆盖，报告全绿、exit 0。
// 这是最根本的一种"没测就当合格"：
//   只证明"进程没死"，却当成"活儿还能干"。
// 为什么现实中真会发生：轮换指针是"已有 probe 记录数 % 4"，
// 只要有人认为往文件里补几条 probe 记录、或者 probe 中途失败没写记录，
// 指针就会错位并**卡在同一个 slot 上**，而报告不会有任何提示。
// 判据：7 天窗口内，每条路径至少被成功测到 1 次。
// 不全覆盖不等于系统坏了，但等于"这条路径 7 天没有被验证过"——
// 那就不能声称"成功率不掉"，因为分母里根本没有它。
const SLOT_NAMES=["纯存活","纯推理","读文件","容器执行"];
// **slot 和 want 必须自洽**（2026-10-19 补，真缺陷）：
// 上面的 slotSeen 只统计 `p.slot` 这个**标签**，而 `probe()` 里
// slot → prompt → want 的对应关系是写死在 case 里的（L119-128）。
// 也就是说：`slot` 是记录里可以随便填的字段，`want` 也是 —— 两者
// 从来没有被互相核对过。**报告相信的是标签，不是标签对应的证据。**
// 合成数据实测：32 次探针，slot 轮转 0/1/2/3 各 8 次，但 want **全部是 "OK"**
// （实际每次都只是"回复 OK"，只证明了进程还活着）→
// 报告打印"探针能力覆盖：纯存活 8 / 纯推理 8 / 读文件 8 / 容器执行 8"，
// **exit 0**。与 slot 和 want 正确配对的健康数据**输出完全一样**。
// 这是第 26 轮的伪装版：那轮是"32 次全是 slot 0"，被 slotSeen 抓住了；
// 这轮把标签改对、实际没测，slotSeen 就彻底失效 —— 判据只信任标签本身。
// 修法：把 case 里的对照表搬进报告，逐条核对 want 是不是这个 slot 该有的答案。
// 不一致说明记录不可信（要么 poke 改过文件，要么 probe 写错了字段），
// 而不能当成"这条路径被测过了"。
const SLOT_WANT={ "0":"OK", "1":"-55", "2":"350", "3":"2176782336" };
const slotSeen={};
let wantMismatch=[];
for(const p of probesVerified){
  const s=String(p.slot), w=String(p.want==null?"":p.want);
  if(SLOT_WANT[s]!==undefined && w && w!==SLOT_WANT[s]){ wantMismatch.push(p); continue; }
  if(p.ok) slotSeen[s]=(slotSeen[s]||0)+1;
}
const slotMissing=[0,1,2,3].filter(s=>!slotSeen[String(s)]);
// slotOk 定义在 failRunOk 旁边（那里 days 已算出来），否则 TDZ。

// **连续失败时长**（2026-10-19 补，第三次平均值的病根，也是最深的一次）：
// 总成功率是"整体还行吗"，末尾成功率是"现在还好吗"，
// 但**两者都挡不住"中间坏了一大段"**。
// 合成数据实测：200 次探针里第 120-128 连续 9 次全错
// （**连续 7.7 小时完全不能用**），末尾 4 次全对、总成功率 95.5% 压线 → exit 0。
// 判据是"成功率不掉"——7 天里整整 7.7 小时全错，这就是"掉"。
// 阈值 90 分钟：cron 每 6 小时一次，连续 2 次失败之间最多隔 6 小时，
// 所以"连续 2 次失败"最多代表 12 小时不确定；这里按**失败探针的时间跨度**算，
// 取 90 分钟不放宽（单次失败跨度 0，两次相邻失败跨度 6 小时 → 会被拦）。
// 换句话说：**不允许连续 2 次探针失败**。
let maxFailRun=0, curRun=0, runStart=null, maxFailSpanSec=0;
const sortedProbes=probesVerified.slice().sort((a,b)=>a.ts-b.ts);
for(const p of sortedProbes){
  if(p.ok){ curRun=0; runStart=null; }
  else {
    curRun++;
    if(runStart===null) runStart=p.ts;
    if(curRun>maxFailRun) maxFailRun=curRun;
    maxFailSpanSec=Math.max(maxFailSpanSec, p.ts-runStart);
  }
}
const FAIL_RUN_LIMIT=1;   // 连续失败次数上限：1 次可以（偶发），2 次就说明真的坏了
// 修复前采的样本没有 pid/proc_start 字段（那时还没记录身份），
// 它们无法参与"生命周期"判断，单独算一类，不混进来算增长。
// **重复行可以伪造采样密度**（2026-10-19 补，真缺口）：
// 同一时间戳写 3 遍 → 369 次 / 应 346 次 = 107% → 判"密度达标"，
// 而实际只有 123 个真实时刻（每 85 分钟一次，仅 36%）。
// 按 ts 去重，重复行只算一次；重复的条数单独报出来。
// **daemon 不在跑的采样点必须被说出来**（2026-10-19 补，真缺口）：
// 这些记录 {alive:false} 原来被直接丢弃，于是报告里
// "daemon 停了 6 天、之后正常跑了 9 天" 和 "我只采样了 9 天"
// **长得一模一样** —— 前者是严重故障，后者只是还没开始。
// 采样脚本每 30 分钟记一次，daemon 不在跑时写 alive=false，
// 这就是"那段时间服务不可用"的直接证据，不能说丢就丢。
const deadSamples = lines.filter(x=>x.kind!=="probe" && x.alive===false);
const deadSampleCount = deadSamples.length;
const deadSampleHours = deadSampleCount * 0.5;   // cron 每 30 分钟一次
const dedupKey=(x)=>`${x.ts}|${x.proc_start}|${x.pid}`;
const seenSampleKey=new Set();
let dupSamples=0;
const deduped=[];
for(const x of lines){
  if(x.kind==="probe"||!x.alive) continue;
  const k=dedupKey(x);
  if(seenSampleKey.has(k)){ dupSamples++; continue; }
  seenSampleKey.add(k); deduped.push(x);
}
// **必须按时间排序**（2026-10-19 修，真缺陷）：
// 下面 `const cur=all[all.length-1]` / `const first=all[0]` 都假设了"文件按时间有序"，
// 但这个假设**从来没被保证过**：cron 与手工调用撞车、时钟被 NTP 回拨、
// 或者写入被打断后补写，都会让文件乱序。实测：
// 同一份 8 天数据，只把**最后一条挪到文件开头**，报告就从
//   "已观测 8.00 天（首尾样本跨 8.00 天）" 变成 "已观测 0.00 天（首尾样本跨 **-0.04** 天）"，
// exit 从 0 变成 1 —— 内容一模一样，只是顺序不同，结论完全相反。
// 而"首尾样本跨 -0.04 天"这种负数本来就不该被打印出来。
// 排序放在去重之前更稳：去重用的是 (ts,proc_start,pid)，与顺序无关。
const raw=deduped.slice().sort((a,b)=>a.ts-b.ts);
const legacy=raw.filter(s=>s.proc_start===undefined||s.pid===undefined);
const all=raw.filter(s=>s.proc_start!==undefined&&s.pid!==undefined);
if(!all.length){
  // **"没开始采样" 和 "采了 N 天但服务全程不在" 是两件完全不同的事**（2026-10-20 修）。
  //
  // 现场：造「7 天里 daemon 从第一天起就死着、cron 每 30 分钟记 alive=false」的数据 ——
  // 判红是对的（exit 1），但**理由是错的**：
  //   原来只说「还没有可用于判据的样本（无 pid 的历史样本 0 条已忽略）」
  // 主人看到这句会去查「为什么没采样」，而真相是「采了 336 次，每次都发现 daemon 不在」。
  // 前者是"还没开始"，后者是"跑了 7 天、7 天全瘫" —— 处置完全不同。
  // 所以这里必须把 alive=false 的条数说出来。
  // **这条路径也要走"判定："格式**（2026-10-20 修，自相矛盾）。
  //
  // 现场：喂一个空文件 / 不存在的路径，report 只打印一句话就 exit 1：
  //   「还没有可用于判据的样本（无 pid 的历史样本 0 条已忽略）」
  // **没有 `判定：` 行，没有 ❌ 标号，也没有说哪条判据不过。**
  // 而正常路径永远以 `判定：❌…；✅…` + exit 收尾。
  //
  // 这违反了本脚本自己定下的契约：**exit 1 必须能看到"哪条判据没过"**。
  // 一个只会 exit 1 而不说是谁的检查，等于让人去猜 ——
  // 而这条路径恰恰是最容易搞错的一种（"数据文件是不是写错路径了"），
  // 猜错方向就会去查 cron 而不是查路径。
  //
  // 修：三种空数据情形各自标明判据名。
  const c0=[];
  if(deadSamples.length){
    c0.push(`❌ **没有任何"服务在跑"的样本**，但有 ${deadSamples.length} 个采样点记录到 daemon 不在`+
      `（约 ${(deadSamples.length*0.5).toFixed(1)} 小时）：这不是"还没开始采样"，是**这段时间服务全程不可用** —— 查容器/daemon，不要查 cron`);
  }else if(legacy.length){
    c0.push(`❌ **样本全是旧格式**：${legacy.length} 条都缺 \`pid\`/\`proc_start\`，无法判断是不是同一个进程`+
      ` —— 通常意味着采集脚本没升级，不是服务故障`);
  }else{
    c0.push(`❌ **一个采样点都没有**：${process.env.SOAK||"(未设置 SOAK)"} 里没有任何记录`+
      ` —— 先确认路径对不对（\`SOAK\` 环境变量），再确认 cron 有没有在跑`);
  }
  console.log("\n判定：" + c0.join("；"));
  process.exit(1);
}

// **只跟同一个 daemon 生命周期比较**（见 sample 里的注释：跨重启会算出负数增长）
const cur=all[all.length-1];
const sameLifetime=all.filter(s=>s.proc_start===cur.proc_start && s.pid===cur.pid);
// **只用真正采到 RSS 的点**（2026-10-20 修）：0 和 undefined 都算"没测到"。
// **这个定义必须放在所有 RSS 计算之前** —— 前两版插在语义相邻处，
// 造成本轮第三次 TDZ（`Cannot access 'rssOk' before initialization`）。
// 三次都是同一个原因：1900 行单文件、变量散落，靠人工找位置。
const rssOk=(s)=>typeof s.rss_kb==="number" && s.rss_kb>0;
// **`fd` 和 `threads` 也要同一套过滤**（2026-10-20 补，第 68 轮的复发）。
//
// 第 68 轮把 `rss_kb` 的读取改成「读不到就不写字段」，判据侧用 `rssOk` 筛；
// 但 **`fd`/`threads` 没跟着改** —— `ls ... | wc -l` 失败时写的是 0，
// 而 0 在判据里是**有效的小值**：
//   · 落在末段 → 句柄增长算成 -27（"在释放"）→ `✅ 无明显句柄泄漏`
//   · 落在峰值 → 把真泄漏的峰值削平
// 合成实测：fd 27→45 真泄漏（+18 < 峰值门槛 20），末 20 点写 0 → **exit 0**，
// 而报告里那行 `句柄: 首段中位 28 → 末段中位 0` 自己就写着 0。
//
// `typeof===number` 挡不住采集侧写的 0，所以这里额外要求 >0：
// 一个活着的 node 进程不可能只有 0 个句柄、0 个线程。
const fdOk=(s)=>typeof s.fd==="number" && s.fd>0;
const thOk=(s)=>typeof s.threads==="number" && s.threads>0;
const rssPts=all.filter(rssOk);
const rssSkipped=all.length-rssPts.length;
const S=sameLifetime.length?sameLifetime:all;

const first=all[0], last=all[all.length-1];
// **观测时长的终点取"现在"，不取最后一个样本**（2026-10-19 修，真误差）：
// cron 每 30 分钟一个点，所以任意时刻最后一个样本平均都在 15 分钟前。
// 用 (last-first) 当观测时长，就永远差这半格 —— 恰好满 7 天时算出 6.98 天，
// 判据 days>=7 不成立，**真跑满 7 天也会被判失败**。
// 实际连续观测的时长是"从首个样本到现在"，末尾那半格由下面的 STALE_LIMIT 兜住
// （超过 90 分钟没有新样本才算没在看）。
const nowSec=Math.floor(Date.now()/1000);
const hours=(nowSec-first.ts)/3600, days=hours/24;
// **窗口起点核对**（2026-10-19 补）：见脚本顶部 DAY0_FILE 的说明。
// day0 是独立写入的事实，数据最早样本不能晚于它太多。
// 晚于 day0 + 1 小时 → 说明数据被清空重来过，"连续 N 天"不成立。
// 容差 1 小时：day0 是手工 `date +%s` 记的，而第一次 cron sample 可能
// 最多晚 30 分钟（cron 每 30 分钟一次），留 2 倍余量。
// **只在"真跑"时生效**（2026-10-19 修，第一版把 11 个健康用例全误杀了）：
// 第一版无条件读 DAY0_FILE，而合成数据的默认 DAY0_FILE 仍指向真实的
// docs/acceptance/soak-day0.txt —— 两者相差 8 天，于是"数据晚于 day0 72 小时"
// 把**每一个健康用例都判成失败**。
// 这正是"判据本身会说谎"的第二个方向：不该拦的拦了。
// 区分方式：只有在**用默认 SOAK 路径**（也就是真跑）时才核对 day0。
// 用 SOAK= 覆盖 = 合成数据 = 测判据逻辑，不该被真实 day0 约束。
// 显式传 SOAK_DAY0= 时也生效（用于验证 day0 判据本身）。
// 显式传 SOAK_DAY0= 时也要生效 —— 那是"专门验证 day0 判据本身"的场景。
const isRealRun = !process.env.SOAK_OVERRIDDEN || !!process.env.SOAK_DAY0;
let day0Ts=null, dataReset=false, day0Early=false, day0Compat=null;
if(isRealRun){
  try{
    const txt=fs.readFileSync(process.env.DAY0_FILE,"utf8").trim();
    const m=txt.match(/\s(\d{9,})$/);
    day0Ts = m ? Number(m[1]) : Math.floor(new Date(txt.split(/\s+/).slice(0,2).join(" ")).getTime()/1000);
    if(Number.isFinite(day0Ts) && day0Ts>0){
      dataReset = first.ts > day0Ts + 3600;
      day0Early = first.ts < day0Ts - 60;
      day0Compat=true;
    }
  }catch{}
}

// **时间戳在未来 = 数据坏了，不能当成负数天数照算**（2026-10-19 补，真缺口）：
// 时钟回拨、NTP 跳变、或有人手改了文件，都会让 ts 跑到 now 之后。
// 原来直接算 now-first 得到"已观测 -1.00 小时 / -0.04 天"，
// 然后照样拿去比 7 天 —— 负数当然不达标，看似"判对了"，
// 但真正该说的"数据有问题"一个字没提，读的人只会以为"还没跑够"。
const futureSamples=all.filter(s=>s.ts>nowSec+300);   // 容忍 5 分钟时钟漂移
const hasFuture=futureSamples.length>0;
const maxFutureMin=futureSamples.length
  ? Math.max(...futureSamples.map(s=>Math.round((s.ts-nowSec)/60))) : 0;

// **"成功率不掉"不能靠"一次都没测"来满足**（2026-10-19 补，真缺口）：
// passRate 在没有任何 probe 时是 null，而 passOk 把 null 当成通过 ——
// 于是 probe 的 cron 整个挂掉、7 天一次能力验证都没做，判定里
// 连"成功率"那行都不会出现，其余判据全绿，exit 0。
// 合成数据实测：8 天采样正常但 0 条 probe 记录 → exit 0。
// 判据：探针密度也要达标（probe cron 是 `0 */6 * * *`，即 4 次/天，取 ≥70%）。
// 只在满 7 天后才判 —— 窗口刚开始时没探针是正常的，不该提前报错。
const PROBE_PER_DAY=4;
const expectProbes=days*PROBE_PER_DAY;
const probeRate=expectProbes>0? probesVerified.length/expectProbes : null;
const PROBE_RATE_LIMIT=0.7;
const probeDensityOk=!(days>=7 && (probeRate===null || probeRate<PROBE_RATE_LIMIT));

// **密度够 ≠ 覆盖够**（2026-10-19 补，真缺口）：
// 判据要的是"成功率**不掉**"，那是整个 7 天里都要有证据的事。
// 但如果 28 个探针全挤在**头 56 分钟**内跑完、之后 8 天一个没测，
// 总数照样够（密度 174%）、成功率照样 100% → exit 0。
// 实际上后 8 天"掉没掉"完全没测过。
// 补一条：**每个自然日都要有探针**。7 天窗口就查 7 个自然日，
// 允许最多 1 天缺席（真机偶发 cron 抖动），但不能整段没测。
// 按**窗口起点算起**的每 24 小时切一段（不是 UTC 自然日）。
// 踩过坑：第一版用 UTC 自然日，窗口跨 9 个自然日，
// 于是"探针全在头 56 分钟"也报"覆盖 9/9 天" —— 判据自己说谎。
// 以 first.ts 为第 0 段的起点，第 i 段 = [first+i*86400, first+(i+1)*86400)。
const probeSegOf=(ts)=>Math.floor((ts-first.ts)/86400);
const probeSegs=new Set(probesVerified.map(p=>probeSegOf(p.ts)));
const allSegList=[];
// **零长度的尾段不能算进分母**（2026-10-20 修，真误判）。
// 现场：造「first = now-7*86400」的数据（跨度恰好 7.0000 天），
// `i*86400 <= nowSec-first.ts` 在 i=7 时 `604800 <= 604800` 成立 →
// 生成 i=0..7 共 **8 段**，可第 7 段是 `[7.0d, 8.0d)`，**长度为零、根本不存在**。
// 于是报告说「探针覆盖 7/8 段（允许缺 1 段）」—— 靠余量刚好蒙过去。
// 再让它更明显一点：造「第 3 天整天没有 probe」（判据设计上明确允许缺 1 段）→
// 报 `❌ 探针只覆盖了 6/8 段` 直接判红。**一个本来合规的窗口被判失败。**
// 正确做法：只统计**真正开始过的段**，即半开区间 [i*86400, (i+1)*86400) 与 [0, span] 有交集。
// 也就是 `i*86400 < span`（严格小于），i=7 时 604800 < 604800 不成立 → 7 段，正确。
const spanSec=nowSec-first.ts;
const PROBE_EVERY_SEC=21600;   // 探针每 6 小时一次（PROBE_PER_DAY=4）
// **太短的段不能计入分母**（2026-10-20 修，这是 S6 裁定时刻必定会踩的坑）。
// 现场：造「跨度 7.0028 天、第 3 天整天没 probe」的数据 ——
// 按设计「允许缺 1 段」应该过，实际报 `6/8 段` 判红。
// 多出来的那一段是**尾段只有 240 秒**：probe 每 6 小时才跑一次，
// 一个 4 分钟长的段**物理上不可能有 probe**，却被算进分母、还吃掉了唯一的容差。
// 这不是夹具的问题，是**真窗口一定会遇到的**：
// day0 是 03:25:20，我在 7 天之后的任意时刻跑 report，跨度都不会正好落在段边界上。
// 例如在 7.1 天时，尾段只有 2.4 小时 —— 不可能有 probe，
// 于是「允许缺 1 段」的容差被一个**根本没有机会被覆盖的段**吃掉，
// 一个真实达标的 7 天窗口会被判成失败。**判据自己会说谎，方向是误杀。**
// 判据该问的是「该有 probe 的段，是不是都有 probe」。
// 所以：只有长度 ≥ 一个 probe 周期（6h）的段才算「该有 probe」。
// 段 i 的实际长度 = min((i+1)*86400, span) - i*86400。
const segLenOf=(i)=>Math.min((i+1)*86400, spanSec)-i*86400;
const allSegsRaw=[];
for(let i=0; i*86400 < spanSec; i++) allSegsRaw.push(i);
for(const i of allSegsRaw) if(segLenOf(i) >= PROBE_EVERY_SEC) allSegList.push(i);
const tooShortProbeSegs=allSegsRaw.filter(i=>!allSegList.includes(i));
const coveredProbeDays=allSegList.filter(i=>probeSegs.has(i)).length;
const PROBE_DAY_MISS_ALLOWED=1;
const probeCoverageOk=!(days>=7 && coveredProbeDays < allSegList.length-PROBE_DAY_MISS_ALLOWED);

// 末尾成功率判据（这里 days 已算好）
// 少于 4 个探针算不准，不判定（交给密度/覆盖判据拦）
const tailOk = !(days>=7 && tailProbes.length>=4 && tailPassRate<0.75);
// 连续失败判定（这里 days 已算好）
const failRunOk = !(days>=7 && maxFailRun>FAIL_RUN_LIMIT);
// slotOk 必须放在这里：它要用 days，而 days 在下面才算出来。
// 放到 slotSeen 旁边会 TDZ —— 这次被 exit 2 立刻抓到（`Cannot access 'days'`）。
const slotOk=!(days>=7 && probesVerified.length>0 && slotMissing.length>0);

// **daemon 不在跑的时长要进入判定**（2026-10-19 补，真缺口）：
// 上一版只把 alive=false 打印出来当提醒，不参与判定 ——
// 于是"前 6 天 daemon 全死、后 9 天正常"这种，
// 打印完"⚠ 144 小时服务不可用"照样 exit 0。
// 判据是"连续 7 天"，那 7 天里服务得真的在跑。
// 阈值 2 小时：cron 每 30 分钟采一次，容忍几次瞬时抖动（重启窗口、采样竞态），
// 但"累计停了 2 小时以上"就不是抖动，是真的没在服务。
const DEAD_HOURS_LIMIT=2;
const deadOk = deadSampleHours <= DEAD_HOURS_LIMIT;
const spanDays=(last.ts-first.ts)/86400;   // 仅用于显示"首尾样本实际跨度"

// **连续性**（2026-10-19 补）：只看"首尾跨了 7 天"是不够的 ——
// 采样器如果在中间死了 3 天，首尾照样跨 7 天，报告会给出一个虚假的"连续 7 天"。
// 真实的 7×24 里，cron 每 30 分钟一个点，正常间隔 1800s；
// 窗口内若出现远超此值的空档，说明那段没在观测，必须扣掉。
// **算空档要用「所有采样点」，含 alive=false 的**（2026-10-20 修，真误报）。
// 现场：造「7 天里 daemon 停 1.9 小时」的数据 —— 没超 2h 阈值，
// 却被判 `❌ 观测不连续：最长空档 2.50h` 而失败。
// 原因：alive=false 的采样行没有 pid/proc_start，被 `all` 过滤掉了，
// 于是那 1.9 小时在时间轴上**凭空变成一个空档**。
// 但那段时间 cron 每 30 分钟都在正常跑、都记了 alive=false ——
// **观测是连续的，只是观测到了"坏"**。
// "观测不连续" 和 "服务不连续" 是两件事，判据不能混为一谈：
// 前者说明 cron 没在跑（没人看），后者说明 daemon 挂了（看到了坏）。
// 后者已由 deadTotal / DEAD_HOURS_LIMIT 单独判，这里只管前者。
// 所以空档和采样密度都改用 `observed`（含 alive=false）。
const observed=lines.filter(x=>x.kind!=="probe").slice().sort((a,b)=>a.ts-b.ts);
const sorted=observed;
const GAP_LIMIT=9000;                  // 2.5h：连丢 4 个 30分钟点仍算连续，第 5 个开始红
let maxGap=0, deadTotal=0;
for(let i=1;i<sorted.length;i++){
  const g=sorted[i].ts-sorted[i-1].ts;
  if(g>maxGap) maxGap=g;
  if(g>GAP_LIMIT) deadTotal+=g-GAP_LIMIT;   // 超出容忍的部分算"没在看"
}
const coveredDays=Math.max(0,(hours*3600-deadTotal))/86400;

// **空档判据只管"单个空档"，管不了"整体稀疏"**（2026-10-19 补，真缺口）：
// GAP_LIMIT 只看连续两个样本之间是否超过 90 分钟。
// 如果 cron 变成每 85 分钟才跑一次（或者大部分跑失败了、偶尔成功一次），
// 每个空档都在容忍内 → 报告打印"✅ 观测连续"，exit 0。
// 合成数据实测：7.2 天只采了 129 次（设计应为 345 次，仅 37%），
// 而报告说"已满 7 天且观测连续" —— 一半以上的时间根本没在看，
// 期间发生过的内存峰值、容器宕机、句柄飙升全都没有样本。
// 所以还要看**实际采样密度**：SAMPLE_PER_HOUR 是 cron 的设计值（每 30 分钟一次）。
// **必须用 all**：hours 是整个观测窗口（涵盖所有生命周期），
// 而 S 只是"当前生命周期"的样本。拿 S.length 去比 hours 密度，
// 会把"重启过几次"误判成"采样稀疏" —— 重启不是没在看。
const SAMPLE_PER_HOUR=2;                 // */30 * * * *
const expectSamples=hours*SAMPLE_PER_HOUR;
// **窗口太短时这个分母小到没有意义**（2026-10-20 修，真缺陷）。
//
// `hours` 是从首个采样点算起的真实跨度。窗口刚开始时 `hours` 只有零点几，
// 于是 `expectSamples` 是 0.5、1.0 这种数，而 `all.length` 是**整数**（至少 1）。
// 现场（真窗口，开窗 41 分钟）：`采样密度：2 次 / 应 1 次 = **146%**`。
// 逐点扫一遍：
//   窗口 16 分 → 1 次 / 应 1 次 = 188%
//   窗口 31 分 → 2 次 / 应 1 次 = 194%
//   窗口 61 分 → 3 次 / 应 2 次 = 148%
//   窗口 91 分 → 4 次 / 应 3 次 = 132%
// 全部超过 `SAMPLE_RATE_MAX=1.5` 的门槛附近，而**这些点全是正常的 cron**。
// 也就是说：窗口前 1~2 小时，这条判据会**随机地**把正常 cron 判成「有人手动跑」。
// 而 `SAMPLE_RATE_MAX` 恰恰是为「人工干预」立的 —— 一个会误报人工干预的判据，
// 比没有更糟：它会让真的人工干预混在噪声里不被注意。
//
// 根子是**用比率来判「太多」**。比率的分母小时，单个点的舍入就能把结果推过阈值。
// 修法分两层：
//   · 窗口不足 4 小时（应采 <8 次）时，这条**不判**，明确说「还没到判的时候」；
//   · 之后按比率判，但因为分母够大，舍入误差 ≤12.5%，阈值 1.5 有足够余量。
const sampleRate=expectSamples>0? all.length/expectSamples : null;
// 判据：实际密度 ≥ 设计值的 70%。留 30% 余量给 cron 抖动、
// 单次脚本失败、机器短暂繁忙 —— 但不可能容忍一半样本缺失。
const SAMPLE_RATE_LIMIT=0.7;
// **采样密度不能只有下限**（2026-10-20 补，真缺陷）。
// 上面那条只说「别太少」。但 S6 的字面判据是「**无人工干预**」——
// 而「太多」正是人工干预唯一的指纹：cron 是 `*/30`，一天 48 次，
// 多出来的每一次都是**有人手动跑了 `sample`**。
// 合成实测：7 天塞 3363 个点（设计的 10 倍）→
//   `采样密度：3363 次 / 应 336 次 = 1000%（判据 ≥70%）` → `✅` → **exit 0**。
// 也就是「每分钟都有人在手动采样」被判成了「密度达标」。
// 这不是理论问题：**真窗口里已经发生了** —— 11 个采样点里 6 个不是 cron 来的
// （19:58:33 / 20:58:54 / 20:59:40 / 21:03:43，秒数都不是 :00/:01），
// 那是我自己调试时踩出来的。判据一条都没响。
// 上限取 150%：正常 cron 偶尔补采、重跑同一次，不至于超过 1.5 倍；
// 超过就是「有人在跑它」。
const SAMPLE_RATE_MAX=1.5;
// **"连续"不能只靠加起来够 7 天**（2026-10-19 修，措辞在撒谎）：
// 原来只把断档扣掉，于是"8 天跨度里有 24 小时没观测"仍会打印
// "✅ 已满 7 天且**观测连续**" —— 累计是够 7 天了，但"连续"这个词是假的：
// 那 24 小时里发生了什么我们完全不知道，也无法排除人工干预。
// S6 的字面判据是"连续 7 天"，所以只要出现一处超过容忍值的断档，
// 就不能声称连续 —— 必须重来。短抖动（cron 漏跑一次，<90 分钟）仍可容忍。
// **"连续 7 天"不能要求"一个空档都没有"**（2026-10-20 修，会让真窗口永远过不了）。
// 现场：彩排一个"真实但健康"的 7 天窗口 —— 337 点里只缺 12 个（96% 密度），
// 其中一次连丢 2 个点（cron 抖动 1 小时）。结果：
//   ❌ **观测不连续**：最长空档 2.00h（容忍 1.5h），累计未观测 0.50h
// 而 process.exit 里要的是 `coveredDays>=7`，coveredDays = (hours*3600-deadTotal)/86400。
// 也就是说 **deadTotal 必须严格为 0**。定量算一下连丢几个点才触发：
//   连丢 1 个 → 空档 1.00h → 计入 0     （安全）
//   连丢 2 个 → 空档 1.50h → 计入 0     （安全）
//   连丢 3 个 → 空档 2.00h → 计入 0.50h （**永久失去资格**）
// 7 天里 336 次 cron，只要**任意一次**连丢 3 个点（cron 停 1.5h、
// 我改脚本 1.5h、机器休眠 1.5h），coveredDays 就永远差那一截。
// 而 do_sample 的注释明说"跳过 28 次 / 336 次 = 8.3%，仍在阈值内" ——
// **两处承诺的不是一回事**：采样密度判据（≥70%）容忍 30%，
// 空档判据实际只容忍"每次最多连丢 2 个"。这是"阈值必须与可观测性匹配"（第⑧类）。
// 修法：给 coveredDays 一条**与采样密度同源**的容忍 ——
// 允许有效覆盖缺 3%（7 天 = 5.04 小时），报出来但不算失败。
// 3% 的依据：7 天里允许累计 5 小时没在看，已经足够宽松地覆盖
// "cron 偶尔抽风 + 我改脚本"这类；再大就说不过去（那是真的没在跑）。
// **两条判据分工：单段长度管"可观测性"，累积量管"覆盖度"**（2026-10-20）。
// 第一版把容忍写成累积 5 小时 —— 实测「停 6 小时」仍 exit 0
// （deadTotal 只算超出 GAP_LIMIT 的部分：6h-1.5h=4.5h < 5h）。太软。
// 第二版写累积 2 小时 —— 回归立刻抓到反例：`realskip` 单段空档 3.5h，
// deadTotal 恰好 2.00h，卡在边界上被判绿。而"整整 3.5 小时没人看着"
// 显然不能算"连续 7 天在看着"。
// 根子在于一直想用**一个数**同时表达两件事。拆开就清楚了：
//   · **单段空档**（maxGap）量的是"我最长有多久没看" —— 这是可观测性，
//     阈值应与"故障能活多久"匹配。cron 30 分钟一次，容忍 1.5h = 连丢 2 个点，
//     这是原有的 GAP_LIMIT，不动。
//   · **累积未观测**（deadTotal）量的是"总共漏了多少" —— 这是覆盖度。
//     它天然是"单段超限部分"的累加，所以只要单段判住了，累积就不会大。
//     给它一条独立的、更宽松的线只是为了防止"几十段小超限"累积起来。
// 现在：`hasGap` 由**单段**决定（maxGap > GAP_LIMIT 即红），
// 累积量单独一条 ≥2h 也红。于是：
//   rehearse7  缺 12 个散布、最长单段 2.00h  → 2.00h ≤ 1.5h？否 → 需确认
//   realskip   单段 3.50h                     → 红（对）
//   gap4       单段 4.00h                     → 红
const COVER_DEAD_H=2;
const coveredDaysOk=coveredDays >= 7 - COVER_DEAD_H/24;
const hasGap = maxGap > GAP_LIMIT || deadTotal/3600 >= COVER_DEAD_H;
const maxGapHours = maxGap/3600;

// **"现在还在采样吗"**（2026-10-19 修，真缺陷）：
// 上面的 coveredDays 只量"样本首尾之间的跨度扣断档"，完全不看**末尾之后**。
// 于是采样器跑满 7 天后彻底死掉，隔 23 天再来看，报告照样打印
// "✅ 已满 7 天且观测连续"、exit 0 —— 而此刻根本没有任何东西在观测。
// 这正是"报告在撒谎"里最危险的一种：数据本身都是真的，结论却已经过期。
// 判据：最后一个样本距现在不得超过 3 个采样周期（cron 30 分钟 → 90 分钟），
// 超过就说明观测早已停止，无论历史跨度多长都不能算通过。
// **stale 要看"有没有人在看"，不是"有没有看到一个活的 daemon"**（2026-10-20 修）。
// 第 45 轮已经把 gap 和采样密度从 `all` 改成 `observed`（含 alive=false），
// 但 **stale 漏改，还在用 `last`（= all 的最后一条，已排除 alive=false）**。
// 现场：造「7 天窗口、最后 3 小时 daemon 挂了」的数据（cron 每 30 分钟照跑、
// 每次都记 alive=false），report 打出：
//   ❌ **观测已停止**：最后一个样本在 3.00h 前（超过 1.5h 即视为没在看）
// 这句话是**错的** —— 有人一直在看，看到的全是"daemon 不在"。
// 观测是连续的，只是观测到了坏。这正是第 45 轮区分过的那件事，我又混了一次。
// 危害不只是措辞：看到"观测已停止"，第一反应是查 cron 为什么不跑，
// 而真正的原因（daemon 挂了）藏在另一条判据里，排查方向被带偏。
// 改法：用 observed（含 alive=false）的最后一条。cron 真停了时
// observed 的最后一条同样会陈旧，所以"报就停"这个能力一点没丢。
const STALE_LIMIT=5400;
const lastObserved=observed.length? observed[observed.length-1] : last;
const staleness=nowSec-lastObserved.ts;
const stale=staleness>STALE_LIMIT;
// **用中位数比，不用单点比**（2026-10-19 修）。
// 踩到的现场：报告显示"句柄增长 +3 → ❌"，但那 37 是压测高峰的瞬时值；
// 密集采样 120 秒实测 fd 一直是 34、RSS 一直 222MB。
// 单点首尾差对噪声极敏感：只要高峰恰好落在最后一个采样点，就会误判成泄漏；
// 反过来高峰落在开头，则会把泄漏掩盖掉。7 天尺度上单点噪声更多，必须用稳健统计。
// 做法：取前 10% 样本的中位数当基线、后 10% 的中位数当终值（至少各 1 个点）。
const med=(arr)=>{const a=arr.slice().sort((x,y)=>x-y);const n=a.length;
  return n%2? a[(n-1)/2] : (a[n/2-1]+a[n/2])/2;};
const tailN=Math.max(1, Math.round(S.length*0.1));
const headS=S.slice(0, tailN), tailS=S.slice(S.length-tailN);
const rss0=med(headS.filter(rssOk).map(s=>s.rss_kb))/1024, rssN=med(tailS.filter(rssOk).map(s=>s.rss_kb))/1024;
const growth=rssN-rss0;
const fd0=med(headS.filter(fdOk).map(s=>s.fd)), fdN=med(tailS.filter(fdOk).map(s=>s.fd));
const fdGrowth=fdN-fd0;
const thGrowth=med(tailS.filter(thOk).map(s=>s.threads))-med(headS.filter(thOk).map(s=>s.threads));
const maxRss=S.filter(rssOk).length? Math.max(...S.filter(rssOk).map(s=>s.rss_kb))/1024 : 0;
// **fd 峰值必须看全窗口**（2026-10-19 修）：原来 `maxFd` 只从当前生命周期 `S` 取，
// 重启后就只剩新进程的低值 —— 实测 fd 从 34 爬到 64、末尾重启一次，
// 打印"单点峰值 34"（真实峰值 64），数字本身就是错的。
const maxFd=all.filter(fdOk).length? Math.max(...all.filter(fdOk).map(s=>s.fd)) : 0;
const maxFdCur=S.filter(fdOk).length? Math.max(...S.filter(fdOk).map(s=>s.fd)) : 0;
const passRate=probesVerified.length? probesVerified.filter(p=>!probeFailed(p)).length/probesVerified.length : null;

// **耗时必须有判据**（2026-10-19 补，真缺口）：
// `secs` 从第 1 轮就写进每一条 probe 记录了，但**从来没有判据用它**——
// 采集了却没人看，等于没采。合成数据实测：32 次探针全部成功，
// 耗时从 5 秒一路爬到 115 秒（探针超时是 120 秒），
// 报告全绿、exit 0。可真实情况是"用户每次要等两分钟，基本没法用"。
// "成功率不掉"最容易被**性能衰减**骗过去：活儿还是干对了，只是慢到没法用。
// 这和前几轮的"平均值盖住末尾/盖住中间"是**同一个病的第四张脸**：
// 只问"对不对"，不问"多久"。
// 阈值怎么定：
//   · 单次上限 90 秒（探针死线 120 秒，留 30 秒余量；超过 90 秒说明接近超时边缘，
//     真实用户早就走了）
//   · 末尾 4 次耗时中位 ≤ 45 秒（不只看"有没有极慢的一次"，
//     而是看"现在是不是整体变慢了"——和 tailOk 同口径，防止"最后几天系统性地慢下来"）
//   · 全程耗时中位 ≤ 45 秒（防止"一直很慢但从没超过 90 秒"这种慢性退化）
const probeSecs=probesVerified.map(p=>Number(p.secs)||0).filter(s=>s>0);
const medSecs=probeSecs.length? (()=>{const a=probeSecs.slice().sort((x,y)=>x-y);const n=a.length;
  return n%2? a[(n-1)/2] : (a[n/2-1]+a[n/2])/2;})() : null;
const maxSecs=probeSecs.length? Math.max(...probeSecs) : null;
const tailSecs=probesVerified.slice().sort((a,b)=>a.ts-b.ts).slice(-TAIL_PROBES)
  .map(p=>Number(p.secs)||0).filter(s=>s>0);
const tailMedSecs=tailSecs.length? (()=>{const a=tailSecs.slice().sort((x,y)=>x-y);const n=a.length;
  return n%2? a[(n-1)/2] : (a[n/2-1]+a[n/2])/2;})() : null;
const SLOW_MAX=90, SLOW_MED=45;
const secsOk=!(days>=7 && probeSecs.length>0 &&
  (maxSecs>SLOW_MAX || (medSecs!==null&&medSecs>SLOW_MED) || (tailMedSecs!==null&&tailMedSecs>SLOW_MED)));

// **容器可用性**（2026-10-19 补）：`container_up` 一直在采，却从来没被任何判据用过 ——
// 也就是说容器可以停一整天，而 S6 照样"通过"。probe 每 6 小时才跑一次，
// 中间最多 6 小时是盲区，靠 probe 兜不住，必须用每个 sample 点的 container_up 判断。
// 判据取"容器在线的采样点占比"，容忍 <5% 的短暂抖动（重建/重启几秒属正常）。
// **分母必须排除「压根没这个字段」的点**（2026-10-20 补，真假红）。
// 原来分母是 `all.length` —— 于是**没有 `container_up` 字段的老数据**
// 会被当成 `Number(undefined)!==1`，也就是「容器离线」。
// 现场：造一份 7 天 365 点的老格式数据（没有 container_up/container_ok/
// relay_up/http_ok），本来只想验 `relay_up` 那条判据，结果报出来的是：
//   `❌ 容器在线率 0.0%（容器长时间不在线）`
//   `❌ 容器最长连续离线 10110 分钟（>2h）`
//   `❌ 有 1 次容器掉线找不到自愈记录：10-12T22:55（10080分钟）`
// 三条都是**凭空造出来的**：那 7 天的容器好得很，只是当时的采集代码
// 还没开始写这个字段。这是第⑥类（采样不测它声称的东西）的反向：
// **把「没测」算成「测到了坏结果」**。
// 第 50 轮给 `contOkUnknown` 修过同一个病（`contUpCapable`），
// 但只修了「一个点都没有」的情形；**部分点没有字段**仍会被算成离线。
// 所以这里按「有这个字段的点」做分母，`contDown` 同理。
const contPts=all.filter(s=>s.container_up!==undefined);
const contRate=contPts.length? contPts.filter(s=>Number(s.container_up)===1).length/contPts.length : null;
const contDown=contPts.filter(s=>Number(s.container_up)!==1);
// **容器在线率也不能只看全窗口平均**（2026-10-19 补，与末尾成功率/不可用时长同一个病根）：
// 合成数据实测：最后 6 小时容器全挂（10 个采样点 container_up=0），
// 全窗口平均仍有 97.4% ≥95% → exit 0。
// 交付出去的成品此刻是坏的，判据还在说"容器在线率 ≥95%"。
// 补两条：
//   ① 末尾窗口在线率（最后 12 个采样点 = 6 小时；
//      cron 每 30 分钟一个，12 个 = 6 小时，正好兜住"最近坏掉"）
//   ② 连续离线时长（最长的连续 container_up!=1 段）
const CONT_TAIL_N=12;
// 这里和三处 `container_up` 判据全部改用 `contPts`（只有这个字段的点）——
// 老数据没有这个字段，用 `all` 会把它们算成「离线」。见 `contRate` 处的说明。
const contTail=contPts.slice(-CONT_TAIL_N);
const contTailRate=contTail.length? contTail.filter(s=>Number(s.container_up)===1).length/contTail.length : null;
const contTailOk=!(days>=7 && contTailRate!==null && contTailRate<0.75);
// 最长连续离线时长（按采样点间隔 30 分钟估）
let maxContDownSec=0, curDownStart=null;
for(const s of contPts){   // 同上：没有 container_up 的点不算离线

  if(Number(s.container_up)!==1){ if(curDownStart===null) curDownStart=s.ts; maxContDownSec=Math.max(maxContDownSec, s.ts-curDownStart+1800); }
  else curDownStart=null;
}
const CONT_DOWN_LIMIT_SEC=2*3600;   // 和"服务不可用≤2h"同一个口径

const contDownOk=maxContDownSec<=CONT_DOWN_LIMIT_SEC;

// ── **容器"能干活"率**（2026-10-20 补，S6 判据内最严重的一次盲区）───────────
// 第 33 轮现场：容器 `Up 6 hours`、daemon 活着、RSS/句柄/存活全正常，
// 但**所有容器工具持续 5 小时返回 container_not_ready**。主人发来的每条命令
// 都在失败，模型连试 3 次后把 DSML 标签原样吐给主人。而报告**全绿**。
// 为什么 `container_up` 没抓到：它读的是 `docker ps` 的 `Up`，回答的是
// "进程在不在"，而不是"daemon 能不能用"。故障时容器进程好好的，
// 坏的是 `containers.endpoint` 与实况不一致 → 探活失败 → 判 unhealthy →
// 工具门控直接拒绝派发。**容器活着，但干不了活。**
// 为什么 probe 没抓到：probe 每 6 小时 4 颗，而故障持续 5 小时，
// **恰好躲在两次探针之间**。判据没错，是采样频率低于故障存活时间。
// 所以补 `container_ok`（每 30 分钟一个点，直接拿库里 endpoint 打 /healthz，
// 11 毫秒、不过模型）。判据口径与 container_up 对齐：全程占比 ≥95%，
// 且末尾 12 点（6 小时）在线率 ≥75%，且最长连续"不可干活"≤2h。
// 分母必须是**采过这个字段的点**，不能是 all.length（2026-10-20 自己抓到）：
// 现场 report 打出"容器可执行率 66.7%（2 点）"——实际 3 个采样点、2 个带字段。
// 第 1 个点是加字段之前采的，它没有 container_ok，**不是失败，是"当时还没这个指标"**。
// 拿 all.length 当分母 = 把"指标不存在"算成"指标坏了"，这是第⑥类 bug
// （样本没测它声称要测的东西）。虽然 7 天后 334/336 会自愈到 99.4%，
// 但那是靠样本多冲淡的，不是判据说对了话。
const contOkPts=all.filter(s=>s.container_ok!==undefined);
const contOkRate=contOkPts.length? contOkPts.filter(s=>Number(s.container_ok)===1).length/contOkPts.length : null;
const contOkDown=all.filter(s=>Number(s.container_ok)!==1);
const contOkTailPts=contTail.filter(s=>s.container_ok!==undefined);
const contOkTailRate=contOkTailPts.length? contOkTailPts.filter(s=>Number(s.container_ok)===1).length/contOkTailPts.length : null;
const contOkTailOk=!(days>=7 && contOkTailRate!==null && contOkTailRate<0.75);
let maxContOkDownSec=0, curOkDownStart=null;
for(const s of all){
  // 只在采了这个字段的点上判定（老样本没这个字段，不能当成"坏"）
  if(s.container_ok===undefined) continue;
  if(Number(s.container_ok)!==1){
    if(curOkDownStart===null) curOkDownStart=s.ts;
    maxContOkDownSec=Math.max(maxContOkDownSec, s.ts-curOkDownStart+1800);
  } else curOkDownStart=null;
}
const CONT_OK_RATE_LIMIT=0.95;
const contOkRateOk=!(days>=7 && contOkRate!==null && contOkRate<CONT_OK_RATE_LIMIT);
const contOkRatePending=!(days>=7);   // 没满 7 天：既不能打 ✅ 也不能打 ❌
const contOkDownOk=maxContOkDownSec<=CONT_DOWN_LIMIT_SEC;
const contOkSamples=contOkPts.length;
// 没有数据时**既不能说好也不能说坏**，要显式说"判断不了"
const contOkUnknown=contOkSamples===0;

// ── **网关（relay）也得有判据，不能只拿它做归因**（2026-10-20 补，第⑤类完整复发）
// 第 63 轮给 sample 加了 relay_up（每 30 分钟一个 TCP 探测），用来把
// "网关断了"从"答案不对"里摘出来。但那只影响**措辞**，不影响**判定**：
// 合成数据实测 —— 7 天窗口、网关断 6 小时、探针恰好全躲过去 →
// 报告全绿、exit 0、**一次都没提到 relay**。
// 这就是第⑤类（采集了却没用）最标准的形态：字段加了、归因用了、**判据没有**。
// 等于"我知道它坏过，但我不打算因为这件事判红"。
// 为什么必须判：网关断了 = **主人发的每条消息都到不了模型**，
// 哪怕 daemon 活着、容器活着、RSS 平稳。这比"容器不可执行"更彻底 ——
// 容器坏了至少还有模型能回一句"容器不可用"，网关断了连这句都发不出去。
// 口径**照抄容器那三条**（同 2 小时容忍，理由一样：重启/网络抖动会短暂断一下，
// 不该判红；但连续 2 小时以上就是故障）：连通率 ≥95%、最长连续断开 ≤2h、
// 没有 relay_up 字段时"判断不了"（不打勾也不判死）。
const relayPts=all.filter(s=>s.relay_up!==undefined);
const relayRate=relayPts.length? relayPts.filter(s=>Number(s.relay_up)===1).length/relayPts.length : null;
let maxRelayDownSec=0, curRelayDownStart=null;
for(const s of all){
  if(s.relay_up===undefined) continue;
  if(Number(s.relay_up)!==1){
    if(curRelayDownStart===null) curRelayDownStart=s.ts;
    maxRelayDownSec=Math.max(maxRelayDownSec, s.ts-curRelayDownStart+1800);
  } else curRelayDownStart=null;
}
// ── **「率」必须说明它覆盖了窗口的多大一块**（2026-10-20 补，第⑥类：样本没测它声称要测的东西）
// 现场：7 天窗口里 `relay_up` 只在最后 1 天才开始采（49/337 点）。
// 报告写 `✅ 网关连通率 100.0%（49 点）`—— 读者会以为**7 天都验过了**，
// 实际只覆盖 1/7。剩下 6 天网关什么样，没人知道。
// 这不是措辞问题，是**判据在替一段没测过的时间打勾**。
// 而且它在本项目里**必然发生**：67 轮里 soak.sh 改了 74 次，
// `container_ok`/`relay_up`/`http_ok` 全是中途加的 ——
// 于是每一个新判据刚上线时，都只能覆盖窗口的一小段。
// 规则：**「率」类判据只有在覆盖 ≥95% 的窗口时才能打 ✅**；
// 覆盖不够时打 ⏳ 并写明覆盖了多少 —— 既不算通过也不算失败。
// 与 `contOkRateOk` 的 `days>=7` 前缀同一个思路，但门槛换成「这个字段自己覆盖了多少」。
const COVER_RATE_LIMIT=0.95;
// 某个字段的覆盖率 = 带该字段的采样点数 / 全部采样点数
const fieldCover=(pts,allN)=> allN? pts.length/allN : 0;
const RELAY_RATE_LIMIT=0.95;
// 与容器同口径：没满 7 天不算"率"（样本太少），但**最长连续断开任何时候都算**
const relayRateOk=!(days>=7 && relayRate!==null && relayRate<RELAY_RATE_LIMIT);
const relayDownOk=maxRelayDownSec<=CONT_DOWN_LIMIT_SEC;
const relaySamples=relayPts.length;
const relayUnknown=relaySamples===0;

// ── **daemon 服务本身也得有判据**（2026-10-20 补，第 33 轮的同一个病根）
// 第 33 轮修了"容器活着但干不了活"，加 `container_ok` 直接打 endpoint。
// 但那个修法**只管了容器，没管 daemon 自己**：`alive` 只判断进程在不在。
// 死锁、事件循环卡住、busy-loop、SQLite 锁住 —— 进程好好的、RSS 正常、句柄正常，
// **但 HTTP 一个都不回**，主人发的消息全部石沉大海。
// 合成数据实测（7 天、进程全程 alive=true、中间 10 小时 HTTP 打不通）：
//   报告全绿 exit 0、一次都没提到 http。因为 sample 里根本没这个字段。
// 口径与容器/网关完全一致（同一个 2 小时容忍）：
//   可达率 ≥95%、最长连续不可达 ≤2h、无字段时"判断不了"。
const httpPts=all.filter(s=>s.http_ok!==undefined);
const httpRate=httpPts.length? httpPts.filter(s=>Number(s.http_ok)===1).length/httpPts.length : null;
let maxHttpDownSec=0, curHttpDownStart=null;
for(const s of all){
  if(s.http_ok===undefined) continue;
  if(Number(s.http_ok)!==1){
    if(curHttpDownStart===null) curHttpDownStart=s.ts;
    maxHttpDownSec=Math.max(maxHttpDownSec, s.ts-curHttpDownStart+1800);
  } else curHttpDownStart=null;
}
const HTTP_RATE_LIMIT=0.95;
const httpRateOk=!(days>=7 && httpRate!==null && httpRate<HTTP_RATE_LIMIT);
const httpDownOk=maxHttpDownSec<=CONT_DOWN_LIMIT_SEC;
const httpSamples=httpPts.length;
const httpUnknown=httpSamples===0;

// **覆盖率不足 = 这条判据没有证据，不能打勾**（2026-10-20 补，照 container_ok 的先例）。
// 上面把「只覆盖 15%」渲染成 ⏳ 而不是 ✅，但那只改了措辞 ——
// `relayRateOk`/`httpRateOk` 仍是 `true`，`process.exit` 照样可能给 0。
// 这就是第⑩类（判据必须改退出码才算数）+ 第⑥类（样本没测它声称要测的东西）。
// 三档语义（与 L1885 的 container_ok 完全同一套）：
//   days<7              → ⏳ 还没到裁定时刻（上面 `days>=7` 前缀已拦住）
//   days>=7 且覆盖率<95% → **覆盖率不足 = 失败**：整整 7 天里这一项只看了零星几天，
//                          不能算「这 7 天一直好」
//   days>=7 且覆盖率够    → 按 rate/down 两条判
// **但要能区分「字段后加」和「采集坏了」**（照 L1897-1902 的做法）：
// 老夹具（字段加进来之前造的）本来就没有这个字段，判死就是第⑥类的反向版本。
// 所以只在「这段时间确实有能力采这个字段」时才追究覆盖率 ——
// 判据是：同一处采集逻辑写的相邻字段在不在（relay: container_up；http: alive/container_up）。

// **覆盖率的计算必须放在所有 *_Pts 之后**（TDZ）：
// 第一版把它插在 `RELAY_RATE_LIMIT` 旁边，而 `httpPts` 定义在后面 ——
// `ReferenceError: Cannot access 'httpPts' before initialization`，
// 被 `exit 2`（判据坏了，不是数据不达标）立刻抓到。
const relayCover=fieldCover(relayPts, all.length);
const httpCover=fieldCover(httpPts, all.length);
const contOkCover=fieldCover(contOkPts, all.length);

// **覆盖率判定放在所有 *_Cover 之后**（TDZ 又是同一个坑，第二次）：
// 第一版插在 `httpUnknown` 后面，而 `relayCover` 定义在后面 ——
// `ReferenceError: Cannot access 'relayCover' before initialization`。
// `exit 2` 两次都立刻抓到了；但更该记的是**为什么反复犯**：
// 这个文件是 1900 行的单文件 node -e，变量散布在不同语义段里，
// 「常量定义在哪」完全靠人工核对。这也是它需要 136 条回归兜着的原因。
const relayCoverOk=!(days>=7 && !relayUnknown && relayCover<COVER_RATE_LIMIT);
const httpCoverOk=!(days>=7 && !httpUnknown && httpCover<COVER_RATE_LIMIT);
// 这 7 天里**有没有能力采** container_ok：看有没有 container_up。
// 两者在同一处采集逻辑里相邻写入，有 up 就说明那次采集跑了。
// 全窗口连 up 都没有 → 老数据，指标压根不存在，不追究。
const contUpCapable=all.some(s=>s.container_up!==undefined);
// **「判断不了」要能拖住通过**（2026-10-20 补，第三种状态）。
// 第 74 轮把退出码改成只看 ❌ 之后，所有 ⚠ 分支都变成了「沉默地放行」。
// 但 `⚠ 判断不了` 的语义是「这项没验过」，不是「这项通过了」——
// 一份 7 天数据里网关和 daemon 可达性一次没测，不能算交付合格。
// 也不能判 ❌（没有证据说它坏），所以单列一个 unknown 标记，
// 由退出码要求「没有 ❌ **且** 没有未知项」。
const unknownOk = !(relayUnknown || httpUnknown || contOkUnknown);
// **`relay_up`/`http_ok` 也必须有同样的「有没有能力采」判断**（2026-10-20 补，真假绿）。
// 上面 `contUpCapable` 是第 50 轮修出来的正确做法：区分
//   ① 老数据压根没这个字段 → 不追究
//   ② 满 7 天、有采集能力、却一个点都没采到 → **是 bug，必须红**
// 但 `relay_up`/`http_ok` 这两条**只做了 ①，忘了 ②**：
// 它们的 `Unknown` 分支打印 `⚠ ……这条判断不了（既不算通过也不算失败）`，
// 而第 74 轮把退出码改成「只看 c[] 里有没有 ❌」之后，
// **⚠ 不是 ❌ → 直接算通过**。
// 合成实测：7 天、336 点、只有 container_ok，完全没有 relay_up / http_ok →
//   `⚠ 网关连通性：没有 relay_up 字段，这条判断不了`
//   `⚠ daemon 可达性：没有 http_ok 字段，这条判断不了`
//   判定：✅ 已满 7 天且观测连续 …… **exit 0**。
// 也就是「网关和 daemon 通不通，7 天一次都没测」被判成交付合格。
// 这和第 67 轮写在注释里的那句「`⚠ 判断不了` 不能映射到 exit 0」是同一条原则 ——
// 当时只落在**措辞**上，退出码没跟上；第 74 轮换了退出码来源之后，措辞就成了最后一道墙。
// 怎么判断「有能力采」：这两个字段和 `container_ok` 写在**同一处采集逻辑**里，
// 同一行 `o` 对象。所以只要那批点里有 `container_up`（或 `container_ok`），
// 就说明当时的采集代码在跑，`relay_up`/`http_ok` 缺了就是漏采，不是老数据。

// 生命周期 = 一个 daemon 进程从生到死。>1 说明期间重启过 ——
// "连续 7 天不干预"必须把这件事显式说出来，否则报告在撒谎。
const lifeMap=new Map();
for(const s of all){
  const k=String(s.proc_start)+":"+String(s.pid);
  if(!lifeMap.has(k)) lifeMap.set(k,{key:k,pid:s.pid,first:s.ts,last:s.ts,samples:0});
  const L=lifeMap.get(k); L.last=s.ts; L.samples++;
}
const lifetimes=lifeMap.size;
const LIFE=[...lifeMap.values()].sort((a,b)=>a.first-b.first);

// **重启归因**（2026-10-19 补）：S6 的字面要求是"无**人工**干预"，
// 而"重启过几次"本身不区分"自愈救回来的"和"人去手动拉起来的"。
// 这两者性质完全不同：自愈恰恰是长期运行该有的能力，
// 而人工重启会让"连续 7 天"作废。所以每次重启都要去找证据：
// 新生命周期开始前 15 分钟内若有恢复记录 → 判为自愈；找不到 → 如实标成
// "无自愈记录"，不替它圆场。
// **证据有两个来源，缺一不可**（2026-10-19 修，真缺陷）：
// 原来只读 watchdog 日志。但机器/WSL 重启后是 `dotd-boot.sh` 把 daemon 拉起来的，
// 那条路径完全不经过 watchdog —— 于是"断电后自动恢复"会被判成
// "无自愈记录（疑似人工干预）"，把整个 7 天窗口无理由作废。
// 而这是真实会发生的场景：Windows 侧有 WSL-KeepAlive 定时任务每 2 分钟拉活。
// 现在把 boot 日志也算作恢复证据，并在输出里标明是哪一条路径救的。
const WD=process.env.DOTD_WATCHDOG_LOG||"/var/log/dotd-watchdog.log";
const BOOTLOG=process.env.DOTD_BOOT_LOG||"/var/log/dotd-boot.log";
function parseLog(path, label){
  let out=[];
  try{
    out=fs.readFileSync(path,"utf8").split("\n").filter(Boolean)
      .map(l=>{
        const m=l.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s+(.*)$/);
        if(!m) return null;
        return { ts: Math.floor(new Date(`${m[1]}T${m[2]}`).getTime()/1000), text: m[3], src: label };
      }).filter(Boolean);
  }catch{}
  return out;
}
const wdLines=parseLog(WD,"watchdog").concat(parseLog(BOOTLOG,"boot"));

// **容器掉线也要能归因**（2026-10-19 补，和 daemon 归因对齐）：
// daemon 重启我做了归因（找不到自愈记录 = 疑似人工干预），
// 但容器掉线只判了"离线多久"，**没判是谁弄好的**。
// 于是"watchdog 自愈（docker start）"和"我手动 docker start"长得一模一样。
// 判据是"**无人工干预**"，容器这一半不能免检。
// 归因口径：掉线结束前后 ±15 分钟内，watchdog/boot 日志里要有
// "容器已恢复" / "daemon 已恢复" / "daemon 就绪"（容器恢复常伴随 daemon 就绪）。
// **位置要求**：必须在 wdLines 之后算，否则 TDZ（我踩了一次，exit 2 立刻报出来）。

const contDownSpans=[];
{
  let start=null;
  for(const s of contPts){
    if(Number(s.container_up)!==1){ if(start===null) start=s.ts; }
    else if(start!==null){ contDownSpans.push({start,end:s.ts}); start=null; }
  }
  if(start!==null) contDownSpans.push({start,end:all[all.length-1].ts});
}
// 归因窗口必须**覆盖整段掉线区间**，而不只是结束点：
// 自愈可能在掉线中的任何时刻发生（watchdog 每 2 分钟跑一次，容器一挂就被拉起来，
// 下一个采样点看到的就是"已经回来了"）。我第一版只查 sp.end ±15 分钟，
// 而自愈记录写在 sp.start 附近 → 全判成"无自愈记录"，把正常自愈误杀成"人工干预"。
// 现在：窗口 = 掉线开始前 15 分钟 到 掉线结束后 15 分钟。
// **证据的主体必须和被判的对象一致**（2026-10-20 修，真假绿）。
// 原来这里传的正则是 `/容器已恢复|daemon\s*已恢复|daemon\s*就绪/` ——
// 后两项的主体是 **daemon**，不是容器。而"daemon 恢复"和"容器恢复"是两件事：
// watchdog 重启 daemon 时容器根本没动，日志里照样有「daemon 已恢复」。
// 合成数据实测：7 天窗口里容器掉 **90 分钟**（低于 2h 阈值，contDownOk 抓不到），
// watchdog 日志里**只有「daemon 已恢复」，一个字都没提容器** ——
// 也就是说容器其实是**人工拉起来**的。报告却打印
//   「容器掉线 ... 持续 90 分钟（watchdog 自愈）」
//   「容器掉线 1 次，全部有自愈记录（watchdog 自己拉回来的）」
// 并 **exit 0**。**"无人工干预"被一个不相干子系统的恢复日志顶替了。**
// 这个错和第 5 轮修 relay/daemon 那处是**同一个**（第③类：证据主体错配）：
// 当时的注释写着"不是所有'已恢复'都算 daemon 自愈"，
// 但同一个错误在容器这条路径上一直留着 —— 修一个地方不等于修一类问题。
// 现在容器只认容器自己的证据。允许「daemon 就绪」是**唯一**的例外，
// 且必须有理由：容器重建后 daemon 起不来会写"就绪"，
// 那条日志确实间接证明容器可用了 —— 但只在 `docker start/run` 场景成立，
// 所以放宽到"同一时间窗内有 daemon 就绪"，并把它在输出里标出来。
const healInSpan=(sp, re)=>
  wdLines.some(w=>w.ts>=sp.start-900 && w.ts<=sp.end+900 && re.test(w.text) && !/失败/.test(w.text));
// 容器自愈的**专属**证据：
//   · watchdog: "容器已恢复"
//   · boot:     "docker 就绪" / "容器就绪"
//   · daemon:   "daemon 就绪" —— 容器重建后 daemon 能起来，间接证明容器可用
const healedContainer=(txt)=>
  !/失败/.test(txt) && (/容器已恢复/.test(txt) || /docker\s*就绪/.test(txt) ||
                        /容器就绪/.test(txt) || /daemon\s*就绪/.test(txt));
const contRows=contDownSpans
  .filter(sp=>(sp.end-sp.start)>=1800)      // 至少一个采样周期才算一次"掉线"
  .map(sp=>({...sp, secs:sp.end-sp.start,
             healed: healInSpan(sp, /./) && wdLines.some(w=>w.ts>=sp.start-900 && w.ts<=sp.end+900 && healedContainer(w.text))}));
const contUnattended=contRows.filter(r=>!r.healed);
// watchdog 的"已恢复"、boot 的"daemon 就绪"都算自动恢复。
// **不是所有"已恢复"都算 daemon 自愈**（2026-10-19 修，真缺口）：
// watchdog 会写七种带"已恢复"的行：daemon / relay / 容器 / docker，
// 另外还有"daemon 重启失败""relay 重启失败"这些**失败**行也含同样的字。
// 原来只要行里出现"已恢复"就认作 daemon 自愈 —— 实测：
// 只写一行"relay 已恢复"（daemon 根本没人管），也判"全部是 watchdog 自愈"
// 并 exit 0。"无人工干预"被一个不相干子系统的恢复日志顶替了。
// 必须**逐项匹配 daemon 自己**：
//   · watchdog: "daemon 已恢复"
//   · boot:     "daemon 就绪"
// 且要排除含"失败"的行。
const healedDaemon=(txt)=>
  /daemon\s*已恢复/.test(txt) ||
  (/daemon\s*就绪/.test(txt) && !/失败/.test(txt));
const healed=wdLines.filter(w=>healedDaemon(w.text));
const restartRows=[];
for(let i=1;i<LIFE.length;i++){
  const prev=LIFE[i-1], cur2=LIFE[i];
  // 新进程的 proc_start 是它真正起来的时刻，比首个采样点更准
  const bornAt=cur2.key.split(":")[0];
  const born=Number(bornAt)||cur2.first;
  const near=healed.filter(w=>w.ts>=born-900 && w.ts<=born+300);
  restartRows.push({
    pid:cur2.pid, born,
    healed: near.length>0,
    evidence: near.map(w=>`[${w.src}] ${w.text}`).join(" / "),
    downtimeSec: Math.max(0, born-prev.last),
  });
}
const unattended=restartRows.filter(r=>!r.healed);
// **重启之间的空窗也要计进「服务不可用」**（2026-10-20 补，真缺陷）。
//
// `downtimeSec` 每一行都算出来了，报告里也逐条打印「空窗 1500s」，
// 但**从来没被任何判据用过** —— 这是第⑤类（采集了但不用）。
//
// 合成实测：daemon 每 90 分钟崩一次、每次 25 分钟才被拉起，112 段 →
//   可用率约 8%、累计停机约 **46 小时**，而报告写的是
//   `✅ 期间服务不可用累计 0.0 小时（≤2h）`
//   `✅ 期间重启 112 次，全部是 watchdog 自愈（无人干预）`
//   `✅ 最长连续存活 1.0 小时（≥1h，非崩溃循环）`  → **exit 0**
// 三条全绿，而主人那 7 天里八成时间发消息没人应。
//
// 为什么逐条看都不红：
//   · `deadSampleHours` 只数 `alive:false` 的点 —— 而崩溃时 cron 采样点
//     落在「已经重启完」的位置上，一条 alive:false 都没有；
//   · 「最长连续存活 ≥1h」的门槛对一个要求「**连续 7 天**」的判据形同虚设；
//   · 「全部自愈」只说没人插手，不说服务在不在。
// 三者都不看「**这段时间里服务到底有多少时间是活的**」——而这才是「连续 7 天」的意思。
// **累计停机不能把每段都加一遍**（2026-10-20 修，第一版就是这么错的）。
//
// 第一版 `restartRows.reduce((s,r)=>s+r.downtimeSec,0)`，实测把 154h 的停机算成 **238h**
// —— 比窗口总长 168h 还多，于是可用率打出来 `0.00%`。
//
// 原因：`DowntimeSec = born - prev.last`，而 `born` 是 `proc_start`（进程真正起来的时刻），
// `prev.last` 是**上一段的最后一个采样点**。采样是每 30 分钟一次，
// 所以 `prev.last` 通常**早于**真实停机起点很久，这一段空窗被算进去了；
// 同时下一段的 `born` 又比它的第一个采样点早 —— 两头外扩，逐段相加就重叠了。
//
// 正确口径：**窗口跨度 - 各段「首采样点到末采样点」的时长之和**。
// 这样每段时间只算一次，且不会超出窗口（`Math.max(0, ...)` 兜底）。
const lifeSpans = LIFE.map(g=>({first:g.first, last:g.last}));
const aliveSec = lifeSpans.reduce((s,g)=>s+Math.max(0, g.last-g.first), 0);
const totalDowntimeSec = Math.max(0, (all[all.length-1].ts - all[0].ts) - aliveSec);
const totalDowntimeHours = totalDowntimeSec/3600;
// 活着的总时长 = 采样跨度 - 停机时长（跨度用首末采样点算）
const spanHours = (all[all.length-1].ts - all[0].ts)/3600;
const upRatio = spanHours>0 ? Math.max(0, (spanHours-totalDowntimeHours)/spanHours) : null;
const UPTIME_LIMIT = 0.99;   // 「连续 7 天」= 至少有 99% 的时间在跑（允许 ~1.7 小时）
const uptimeOk = !(days>=7 && upRatio!==null && upRatio < UPTIME_LIMIT);

// **"全部自愈"不等于"长期稳定运行"**（2026-10-19 补，真缺口）：
// 判据原文是"连续 7 天无人工干预"。原来只检查"每次重启有没有自愈日志"，
// 却没限制**重启频率** —— 于是"每 30 分钟崩一次、每次都被 watchdog 拉起"
// 这种明显不可用的服务，也能满足"无人工干预"。
// 合成数据实测：8 天崩 383 次、每次 20 秒被拉起 → 报告全绿、exit 0。
// 补一条：**不能是崩溃循环**（最长连续存活 ≥1 小时）。
// 阈值为什么只定 1 小时，而不是 24 小时：
//   · 判据原文只有四条（无人工干预 / RSS / 成功率 / 句柄），
//     **没有规定重启频率**。把它设成 24h 等于偷偷加要求 ——
//     我先写成 24h，"每 6 小时自愈一次但完全平稳"的正常场景就被误杀了
//     （watchdog 本来就该这么干活，不能因为它在干活就判失败）。
//   · 但"每 30 分钟死一次、20 秒被拉起"也判过，同样不能接受：
//     那不是"长期运行"，是崩溃循环。
//   · 1 小时只用来区分这两者，是很弱的底线：任何死得比每小时还勤的服务，
//     都不能叫"在跑"。实测分离度：健康场景 5.5h+，崩溃循环 0.5h。
// 重启**次数**和**平均间隔**一律打印出来，让人自己判断，
// 但只有"崩溃循环"这一档才拦（详细权衡见 docs/backlog.md）。
const lifeSpanSec=(L)=>Math.max(0, L.last-L.first);
const longestLifeSec=LIFE.length? Math.max(...LIFE.map(lifeSpanSec)) : 0;
const longestLifeHours=longestLifeSec/3600;
const MIN_LONGEST_LIFE_HOURS=1;
const avgRestartMin = restartRows.length ? (hours*60/restartRows.length) : null;
const isCrashLoop = LIFE.length>1 && longestLifeHours < MIN_LONGEST_LIFE_HOURS;

// **重启会把 RSS 增长"洗白"，必须单独看**（2026-10-19 修，真缺陷）：
// RSS 判据只比较"当前生命周期"的首末中位数（因为跨重启相减毫无意义）。
// 但如果内存以每小时 12MB 的速度漏、而 watchdog 每 2 小时自愈重启一次，
// 每个生命周期最多只涨 24MB —— 判据看到 +18MB，判定 ✅，exit 0。
// 合成数据实测：8 天里 96 次重启、若从不重启会漏 2GB，报告却全绿。
// 也就是说"重启"可以无限次地把泄漏截断，让这条判据彻底失效。
// 修法：不看"生命周期内涨了多少"，而看**每个生命周期内是不是都在涨**——
// 健康的进程重启后应该稳定，不该每段都单调爬升。
// 用"段内增长率"的**中位数**（MB/小时）判断：稳定进程应接近 0。
const segRates=[], segFdRates=[];
// **短窗口的斜率不可信，必须记账**（2026-10-19 补）：
// 丢掉预热后，1.2 小时的段只剩 ~0.6 小时可比，2 个采样点算出的斜率
// 噪声极大（一次 5MB 抖动 = 8MB/h）。但"段太短"不能当成"没问题"——
// 那正是这一轮前面刚修掉的坑。
// 同时也不能把短段的斜率跟长段的斜率一视同仁：真跑的第一天只有 1.5 小时，
// 报出 9.82MB/h，而 7 天窗口的中位数才有统计意义。
// 折中：**短段计入中位数（不然短生命周期不受检）**，
// 但单独统计"有多少段的观测窗口短于 2 小时"，在报告里说明这个中位数的置信度。
// 判据本身不因短段放宽 —— 否则又回到"短段免检"。
let shortSegs=0, longSegs=0; const segHours=[];
for(const L of LIFE){
  // **必须用 all，不能用 S**（2026-10-19 修，真缺陷）：
  // S 是"当前生命周期"的子集，拿它按 L.key 过滤，除当前这一段外**全部为空** ——
  // 于是 96 次重启的合成数据只算出 1 段，中位数实际只取了一个样本。
  // 判据碰巧还抓到了这个例子（因为那 1 段正好在爬），但换成
  // "只有早期几段在爬、当前段平稳"就会漏掉，等于判据又变成看运气。
  const seg=all.filter(s=>String(s.proc_start)+":"+String(s.pid)===L.key);
  // **`seg.length<4` 会把「短生命周期」整段跳过**（2026-10-19 修，真缺陷）：
  // 采样每 30 分钟一次，4 个样本 = 2 小时。于是任何**短于 2 小时**的生命周期
  // 都算不出速率，全被 `continue` 掉。
  // 合成数据实测：8 天里重启 **159 次**（每段 1.2 小时，每段 RSS 涨 4MB，
  // 累计泄漏 **636MB**），每段只采到 1~2 个样本 → segRates 为空 →
  // medSegRate=null → `(medSegRate===null||...)` **当成通过** → exit 0，
  // 报告打印"✅ RSS 增长 <50MB"。
  // 这是第 14 轮那个坑的第三次复发：**零证据被当成合格**。
  // 而且它和"崩溃循环"判据配合起来正好漏掉一类系统：
  //   最长存活 1.2h ≥ MIN_LONGEST_LIFE_HOURS(1h) → 不算崩溃循环；
  //   每段太短算不出速率 → 不算泄漏。
  // 两条判据之间的缝，正好能塞进"每 1.2 小时崩一次、每次崩前漏 4MB"。
  // 修法：2 个样本就能算斜率（首末差 ÷ 时长），把门槛降到 2。
  // 噪声问题靠"取所有段的中位数"吸收，不靠丢掉段。
  if(seg.length<3) continue;                     // 3 个点才够"丢掉预热段"
  // **必须丢掉每段开头的预热期**（2026-10-19 修，第一版 `seg.length<2` 误杀了正常进程）：
  // 新起的 node 进程前 20% 时间里 RSS 会先涨一段（V8/JIT 预热、懒加载、连接池），
  // 然后平稳。若拿"首末差 ÷ 时长"算斜率，这段预热会被算成 6MB/h 的"泄漏"——
  // 合成数据实测：每段先涨 6MB 后平（完全正常），判据报
  // "各生命周期内 RSS 爬升速率：中位 6.00MB/h" → exit 1，**把健康进程判成泄漏**。
  // 这正是"判据会说谎"的第二个方向：不该拦的拦了。
  // 原门槛 `seg.length<4` 之所以能挡住它，纯属巧合：短段被整段跳过，
  // 所以预热从没被算进去过 —— 但代价是短生命周期完全不受检（见上一条注释）。
  // 正确做法：**保留短段，但只看段的后半部分**，让预热自然被排除。
  // 段长 1.2h、采样 30 分钟 → 3 个点，取后 2 个 → 1 小时窗口，
  // 足以算出斜率，又不受预热影响。
  const warm=Math.floor(seg.length/2);           // 丢掉前一半（预热 + 建池）
  const body=seg.slice(warm);
  if(body.length<2) continue;
  const n2=Math.max(1,Math.round(body.length*0.34));
  const r0=med(body.slice(0,n2).filter(rssOk).map(s=>s.rss_kb))/1024;
  const r1=med(body.slice(body.length-n2).filter(rssOk).map(s=>s.rss_kb))/1024;
  const f0=med(body.slice(0,n2).filter(fdOk).map(s=>s.fd));
  const f1=med(body.slice(body.length-n2).filter(fdOk).map(s=>s.fd));
  const h=(body[body.length-1].ts-body[0].ts)/3600;
  if(h>=0.25){
    segRates.push((r1-r0)/h); segFdRates.push((f1-f0)/h);
    if(h<2) shortSegs++; else longSegs++;
    segHours.push(h);
  }
}
// **中位爬升率需要"足够的证据"才有意义**（2026-10-19 修，第二次误杀）：
// 判据的目的是抓"每段都在爬、靠重启把泄漏截断"——这**本质上需要多段**才能成立。
// 真跑第一天只有 1 段、观测 1.09 小时，去掉预热后剩下的是
// "GC 回落到谷底后重新爬升"那一段，斜率天然为正（实测 9.82MB/h）。
// 拿它判 "❌ 每段都在爬" 是在把正常预热曲线当泄漏 —— 第二次误杀。
// 但**不能因此让短段免检**（那就退回本轮前面刚修的坑）。
// 分三种情况，按证据强度：
//   ① 有 ≥1 段观测 ≥2h        → 用这些段的中位数（长段才有统计意义）
//   ② 没有长段，但有 ≥3 段     → 用全部短段的中位数
//      （重复"重启+爬升"本身就是证据，不需要每段够长）
//   ③ 既没长段、段数又 <3      → **证据不足**，不判死也不打 ✅，
//      明确打印"现在还判断不了"。
//      （全窗口峰值增长那条判据仍然有效，它不依赖分段，能兜住总量）
const longRates = segHours.map((h,i)=>h>=2? segRates[i] : null).filter(v=>v!==null);
const medLongRate = longRates.length? med(longRates) : null;
const segEvidence = longRates.length>0 ? "long" : (segRates.length>=3 ? "multi" : "insufficient");
const medSegRate = segEvidence==="long" ? medLongRate
                 : segEvidence==="multi" ? med(segRates)
                 : null;
const medSegRateRaw = segRates.length? med(segRates) : null;   // 仅用于打印
// **句柄也有同一个洞**（2026-10-19 修）：fd 判据同样只看"当前生命周期"的首末差，
// 于是每段只涨 2 个、每 2 小时重启一次、8 天重启 96 次 —— 首末差仍是 +2，
// 判 ✅，exit 0。合成数据实测：96 段每段都漏 2 个句柄，报告全绿。
// 与 RSS 用同一套逻辑：看**每段是不是都在涨**，中位速率 ≥0.5 个/小时即判失败。
// 0.5/h × 168h = 84 个句柄，远超 +2 的容忍度；而稳定进程的速率应接近 0。
const medSegFdRate=segFdRates.length? med(segFdRates) : null;
const maxSegFdRate=segFdRates.length? Math.max(...segFdRates) : null;
const SEG_FD_RATE_LIMIT=0.5;
// 为什么用中位数而不是最大值：**新起的 node 进程本来就会先爬后平**
// （V8/JIT 预热、懒加载、连接池建满），这是正常现象不是泄漏。
// 用"最大值"会把每次重启后的预热判成泄漏 —— 而重启恰恰是我们要允许的自愈行为。
// 中位数才能区分"每段都在爬（真泄漏）"和"第一段爬完就平（预热）"。
// 最大值仅作参考打印，不参与判定。
const maxSegRate=segRates.length? Math.max(...segRates) : null;
// 判据：生命周期内中位增长率 < 2MB/h。7 天 = 168h，2MB/h 就是 ~336MB，
// 远超 50MB —— 所以这个阈值不宽松，是专门用来抓"靠重启洗白"的泄漏。
const SEG_RATE_LIMIT=2;
const peakRss=rssPts.length? Math.max(...rssPts.map(s=>s.rss_kb))/1024 : 0;
// 基线要贴近**窗口开始**，不能取"前 10%"（7 天里那是 0.8 天）。
// 用前 10% 的中位数会在持续增长时把基线抬高，判据实际要漏到 ~52.6MB 才报，
// 与判据原文的 50MB 不符（实测 +49/50/51 都通过、+60 才失败）。
// 改为取"最前 2 小时内"的样本中位（30 分钟一次即 4 个），仍能抗噪，
// 但偏差只有 2h/168h ≈ 1.2%，不会被增长拉高。
const BASE_WINDOW_SEC=7200;
// **基线绝不能取在峰值之后**（2026-10-20 修，真假绿+假红）。
// 现场：窗口才 2 小时，报告同时打出两句互相矛盾的话 ——
//   「RSS: 首段中位 221.7MB → 末段中位 203.6MB，增长 -18.0MB」
//   「全窗口 RSS：基线 203.6MB → 最高 221.7MB，峰值增长 +18.0MB」
// 同一个 daemon、同一批样本，一负一正。真实序列是
//   221.7 → 201.9 → 202.0 → 203.6 → 203.6 → 203.6 → 203.6（MB）
// 也就是**启动尖峰衰减后稳住**。而所谓 "+18.0MB 峰值增长" 其实是把衰减当成了增长。
// 根因：baseSet = `ts <= all[0].ts + 7200`，窗口不足 2 小时时它**吃下全部样本**，
// 于是 baseRss = 全体中位（203.6），而峰值出现在**第一个点**（221.7）——
// 基线取在了峰值之后。判据实际上在说"最高点比中位数高多少"，
// 这与"随时间增长了多少"完全是两回事。
// 更糟的是它会**双向说谎**：
//   · 启动尖峰衰减 → 报"增长 +18MB"（假红，吓人但不会误放）
//   · 真泄漏但从中位数以下起步 → 基线被抬高，**少报**（假绿，危险）
// 修法：基线窗口**必须在峰值之前结束**。取"最前 2 小时"与"峰值出现时刻"的较小者，
// 且至少要覆盖前 1/4 的时间，否则样本太少不抗噪（那就退回单点）。
// 若峰值就在第一个点（启动尖峰），基线窗口退化为前 1 个点 —— 那不是缺陷，
// 因为"从第一个点涨到峰值"确实是 0 增长，而真正的增长要看后面的走势。
// 这一步之后 peakGrowth 在"启动即峰值"时会是 0。这不是漏洞：
// 那种情况下的缓慢爬升由 segRate（每段爬升速率）去抓，两条判据分工明确 ——
// 这条管"整体峰值涨了多少"，那条管"是不是一直在爬"。
// `peakIdx` 保持**索引**语义（下面 L1368 用它取 all[peakIdx].ts）—— 改成对象会炸：
// `TypeError: Cannot read properties of undefined (reading 'ts')`。
// 另给一个 `peakPt` 表达"峰值那个点"，两者都从筛过的 rssPts 算。
// **一个样本都没有 rss_kb 时 `findIndex` 返回 -1**（2026-10-20 修，会炸）。
//
// `rssPts` 是筛过 `rssOk` 的点。如果整份数据里 `rss_kb` 一个都没有
// （老格式、或采集侧一直在失败），`rssPts` 是空数组，
// `rssPts.reduce(..., rssPts[0])` 得到 `undefined`，`findIndex` 返回 **-1**，
// 然后 `all[-1].ts` → `TypeError: Cannot read properties of undefined (reading 'ts')`。
//
// 实测：造一份只有 ts/alive/pid/proc_start 的裸夹具 →
//   `exit 2` + `❌ report 脚本自身出错（上面是堆栈）—— 这不是"数据不达标"，是判据坏了，必须修`
// 那句护栏本身是对的（R44 的成果），但它拦下的应该是**我写错代码**，
// 不该拦下**数据缺字段** —— 后者是正常输入，判据该判红并说明缺什么。
//
// 这与第 76 轮「修了 RSS 没修 fd」是同一类：`rssOk` 筛出来了，
// 但**没筛的那一半代码还在裸用下标**。
const peakPt=rssPts.length? rssPts.reduce((m,x)=>(x.rss_kb>m.rss_kb?x:m), rssPts[0]) : null;
const peakIdx=peakPt? all.indexOf(peakPt) : -1;
const baseEndTs=(peakIdx>=0? Math.min(all[0].ts+BASE_WINDOW_SEC, all[peakIdx].ts) : all[0].ts+BASE_WINDOW_SEC);
const baseSet=all.filter(s=>s.ts<=baseEndTs);
const baseN=Math.max(1, baseSet.length);
const baseRss=peakIdx>=0? med(rssPts.filter(s=>s.ts<=all[peakIdx].ts).slice(0,baseN).map(s=>s.rss_kb))/1024 : 0;
const peakGrowth=peakRss-baseRss;
const PEAK_GROWTH_LIMIT=50;      // 就是判据原文的 50MB

console.log("== S6 长期运行现状 ==");
if(deadSampleCount>0)
  console.log(`⚠ 有 ${deadSampleCount} 个采样点记录到 **daemon 不在跑**（alive=false），`+
              `约 ${deadSampleHours.toFixed(1)} 小时服务不可用；这些点不计入观测覆盖`);
if(badLines>0) console.log(`⚠ 文件里有 ${badLines} 行残缺 JSON（写入被打断），已跳过，其余样本正常计入`);
// **心跳对账：把"没记录"归因出来**（2026-10-20 补，S6 真缺口）。
// 现场：syslog 明确记录 03:30:01 cron 跑了 soak.sh sample，
// 但 soak.jsonl 里没有那一条 —— 我当时正在反复改写 soak.sh。
// 这种缺口在 soak.jsonl 里和"cron 没跑"长得一模一样，
// 而两者的含义完全不同：后者是环境故障，前者**是我自己的操作**。
// 心跳文件每行一次 sample 运行及其结局，所以能对出：
//   start 但无后续        → 脚本中途崩了（语法错、被 kill）
//   skip probe-running    → 故意跳过，正常
//   skip same-second      → 故意跳过，正常
//   dead daemon           → 已记 alive=false，正常
//   ok                    → 正常落盘
// 只报**异常**的那类（start 无后续），正常的跳过不吵。
const HB=process.env.SOAK_HB||((process.env.SOAK||"").replace(/[^/]*$/,"")+"soak-heartbeat.log");
let hbLines=[];
try{ hbLines=fs.readFileSync(HB,"utf8").split("\n").filter(Boolean); }catch{}
const hbOutcome=new Map();   // start 行 -> 结局（null = 还没结局）
const hbKeys=[];            // 保持顺序
for(const l of hbLines){
  const m=l.match(/^(\d+) (start|ok|skip|dead)\b\s*(.*)$/);
  if(!m) continue;
  const ts=Number(m[1]), kind=m[2], rest=m[3]||"";
  if(kind==="start"){ const k=ts+":"+(rest.match(/pid=(\d+)/)||[])[1]; hbOutcome.set(k,null); hbKeys.push(k); }
  else { for(const k of hbKeys) if(hbOutcome.get(k)===null){ hbOutcome.set(k, kind+(rest?" "+rest:"")); break; } }
}
const hbStarts=hbOutcome.size;
const hbVals=[...hbOutcome.values()];
// **还在飞的不算卡住**（2026-10-20 补）：cron 在 :00/:30 跑 sample，耗时约 0.3 秒。
// 若 report 恰好在这 0.3 秒内执行，最后一行就是 start、还没有结局 ——
// 那是**正在进行**，不是"死了"。判别方法：start 的时间戳距今 < 120 秒就当它还在跑。
// 120 秒的选择：sample 正常 0.3 秒、最慢（容器探活超时）约 5 秒，
// 120 秒足够宽，又远小于两次采样的间隔（1800 秒），不会把真卡住洗白。
const hbNow=Math.floor(Date.now()/1000);
const hbHung=hbKeys.filter(k=>hbOutcome.get(k)===null && hbNow-Number(k.split(":")[0])>=120).length;
// **"start 后无结局"必须能推出 ❌**（2026-10-20 补）。
// 它本来只在心跳那一行的括号里露个数字，退出码里有 `hbHung<=3` 却**没有任何 ❌ 输出**。
// 这正是第 61 轮那个病的镜像：判据红了，但终端不说为什么红 ——
// 于是「把退出码改成只看 c[]」时它立刻从红变绿，暴露出它本来就缺这一行。
const hbInFlight=hbKeys.filter(k=>hbOutcome.get(k)===null && hbNow-Number(k.split(":")[0])<120).length;
const hbSkip=hbVals.filter(v=>v&&v.startsWith("skip")).length;
const hbDead=hbVals.filter(v=>v&&v.startsWith("dead")).length;
const hbOk=hbVals.filter(v=>v&&v.startsWith("ok")).length;
if(hbStarts>0){
  console.log(`心跳：${hbStarts} 次 sample 运行 —— ok ${hbOk} / skip ${hbSkip} / dead ${hbDead}`+
    (hbHung?` / **start 后无结局 ${hbHung}**`:``)+
    (hbInFlight?` / 进行中 ${hbInFlight}`:``));
}
if(dupSamples>0) console.log(`⚠ 文件里有 ${dupSamples} 行重复样本（同一时刻同一进程），已按 ts 去重，不计入密度`);
if(dupProbes>0) console.log(`⚠ 文件里有 ${dupProbes} 行重复探针（同一时刻同一 taskId），已去重，**不计入密度和成功率**`);
// **负跨度是结构性错误，必须报出来**（2026-10-19 补）。
// 排序修好之后理论上不会再出现，但万一将来又有别的地方引入乱序，
// 打印一个负数当"跨度"就是在骗人 —— 宁可明确报警。
const negativeSpan = spanDays < 0;
if(negativeSpan)
  console.log(`❌ **首尾样本跨度为负（${spanDays.toFixed(2)} 天）**：样本没有按时间排列，`+
              `各项判据都不可信 —— 这是报告逻辑的错，不是数据的问题`);
console.log(`采样点 ${all.length} 个，已观测 ${hours.toFixed(2)} 小时（${days.toFixed(2)} 天 / 需 7 天；首尾样本跨 ${spanDays.toFixed(2)} 天）`);
console.log(`观测连续性：最长空档 ${(maxGap/3600).toFixed(2)}h，扣除断档后有效覆盖 ${coveredDays.toFixed(2)} 天`);
if(days>=7) console.log(`探针密度：${probesVerified.length} 次（已验飞书） / 应 ${Math.round(expectProbes)} 次 = ${probeRate===null?"0":(probeRate*100).toFixed(0)}%（设计 ${PROBE_PER_DAY} 次/天，判据 ≥${(PROBE_RATE_LIMIT*100).toFixed(0)}%）`);
// **短窗口别把比率当真**（2026-10-20，见上面 expectSamples 处）。
// 这里原来无条件打印 `2 次 / 应 1 次 = 145%`：一个没有状态标记的数字，
// 读者会以为「密度 145%，超额完成」，实际上只是分母被四舍五入到了 1。
// 窗口不足 4 小时（应采 <8 次）时改说人话。
if(sampleRate!==null && expectSamples<8) {
  console.log(`采样密度：${all.length} 次 / 应 ${expectSamples.toFixed(1)} 次（设计 ${SAMPLE_PER_HOUR} 次/h）`+
    ` —— **窗口还太短，这条先不判**（应采不足 8 次时，单个点的舍入就能让比率失真）`);
} else if(sampleRate!==null) console.log(`采样密度：${all.length} 次 / 应 ${Math.round(expectSamples)} 次 = ${(sampleRate*100).toFixed(0)}%（设计 ${SAMPLE_PER_HOUR} 次/h，判据 ≥${(SAMPLE_RATE_LIMIT*100).toFixed(0)}%）`);
if(legacy.length) console.log(`（另有 ${legacy.length} 条修复前的历史样本无 daemon 身份，不计入判据）`);
console.log(`daemon 生命周期数：${lifetimes}（>1 说明期间重启过）`);
if(lifetimes>1){
  for(const L of LIFE){
    console.log(`  · pid=${L.pid} ${new Date(L.first*1000).toISOString().replace("T"," ").slice(0,19)} → `+
                `${new Date(L.last*1000).toISOString().replace("T"," ").slice(0,19)}  `+
                `(${((L.last-L.first)/3600).toFixed(2)}h, ${L.samples} 点)`);
  }
  if(restartRows.length){
    console.log("  重启归因（对照 watchdog 日志）：");
    for(const r of restartRows){
      const when=new Date(r.born*1000).toISOString().replace("T"," ").slice(0,19);
      if(r.healed) console.log(`    ✔ ${when} pid=${r.pid} 自动恢复（空窗 ${r.downtimeSec}s）← ${r.evidence}`);
      else console.log(`    ✖ ${when} pid=${r.pid} **无自愈记录**（空窗 ${r.downtimeSec}s）—— 疑似人工干预`);
    }
  }
}
console.log(`当前生命周期内采样 ${S.length} 个点，pid=${cur.pid}`);
console.log(`RSS: 首段中位 ${rss0.toFixed(1)}MB → 末段中位 ${rssN.toFixed(1)}MB，增长 ${growth>=0?"+":""}${growth.toFixed(1)}MB（判据 < +50MB）`);
console.log(`RSS 峰值 ${maxRss.toFixed(1)}MB（仅当前生命周期，单点峰值不参与判据）`);
// fd 全窗口峰值增长：与 RSS 的"全窗口峰值"同理 —— 重启会把 fd 泄漏洗白
// 与 RSS 的"全窗口峰值"同理，基线也**不能取在峰值之后**（2026-10-20 同一处修复）。
// fd 的真实序列是稳稳的 27，偶尔被瞬间负载顶到 30+；若基线窗口吃下全部样本，
// 基线就会落在峰值附近，把"瞬时尖峰"报成"泄漏"，或反过来把真泄漏洗白。
const fdPeakIdx=all.reduce((m,s,k)=>fdOk(s)&&(!fdOk(all[m])||s.fd>all[m].fd)?k:m, 0);
const fdBaseEndTs=Math.min(all[0].ts+BASE_WINDOW_SEC, all[fdPeakIdx].ts);
const fdBaseN=Math.max(1, all.filter(s=>s.ts<=fdBaseEndTs).length);
const fdBase=med(all.slice(0,fdBaseN).filter(fdOk).map(s=>s.fd));
const fdPeakGrowth=maxFd-fdBase;
// 阈值不能照抄 RSS 的 50（2026-10-19）：50MB 内存对 daemon 未必严重，
// 但 50 个文件句柄是**大量**泄漏 —— 进程默认上限通常 1024 左右，
// 漏到几百就必然 EMFILE 崩掉。实测 fd 34→64（+30）时用 50 判据
// 仍然 exit 0，等于没修。
// 取 20：daemon 正常 fd 约 27，20 个的增量已是 74% 增长，明显异常。
// 参考点：健康 8 天实测峰值增长 0；每段漏 2 个（95 次重启）实测也靠这条不再漏网。
const FD_PEAK_LIMIT=20;
console.log(`句柄: 当前生命周期 首段中位 ${fd0} → 末段中位 ${fdN}（增长 ${fdGrowth>=0?"+":""}${fdGrowth}）`);
console.log(`全窗口句柄：基线 ${fdBase}（最前 ${fdBaseN} 个样本中位）→ 最高 ${maxFd}，峰值增长 ${fdPeakGrowth>=0?"+":""}${fdPeakGrowth}（判据 < +${FD_PEAK_LIMIT}，与重启无关）`);
console.log(`全窗口 RSS：基线 ${baseRss.toFixed(1)}MB（最前 ${baseN} 个样本中位）→ 最高 ${peakRss.toFixed(1)}MB，`+
            `峰值增长 ${peakGrowth>=0?"+":""}${peakGrowth.toFixed(1)}MB（判据 < +${PEAK_GROWTH_LIMIT}MB，与重启无关）`);
if(segRates.length){
  const ev = segEvidence==="long" ? `按 ${longRates.length} 段 ≥2h 的中位数`
           : segEvidence==="multi" ? `${segRates.length} 段都不足 2h，但段数够多，按全部段的中位数`
           : `**证据不足**：只有 ${segRates.length} 段、去掉每段预热后都不到 2 小时`;
  console.log(`各生命周期内 RSS 爬升速率：${medSegRate===null?"现在还判断不了":medSegRate.toFixed(2)+"MB/h"}（${ev}；`+
              `全部 ${segRates.length} 段中位 ${medSegRateRaw===null?"n/a":medSegRateRaw.toFixed(2)}MB/h，最大 ${segRates.length?maxSegRate.toFixed(2):"n/a"}MB/h —— 最大值仅参考，预热会偏高）`);
}
// **同一份证据不能有两个说法**（2026-10-20 修，第 55 轮的复发）。
//
// 真窗口实测，同一份数据（1 段、去预热后 1.04 小时）：
//   正文：`各生命周期内句柄爬升速率：中位 0.000个/h，最大 0.000个/h`
//   判定：`⚠ 句柄段内爬升：证据不足，现在不判定（只有 1 段…）`
// RSS 侧那行在同样的数据上老实说「现在还判断不了（证据不足…）」，
// 而句柄侧正文打出一个 `0.000个/h` —— 一个**没有状态标记的数字**，
// 读者会读成「爬升速率 0，没问题」，而判定行说的是「我没法判」。
//
// 这比打错更难发现：数字是对的（1 段里确实没爬），但**它不该以这种形式出现**。
// 一条判据在证据不足时，正文就不该给出一个看起来像结论的数字。
// 复用 RSS 侧的 `segEvidence`，口径完全一致。
if(segFdRates.length){
  if(segEvidence==="insufficient"){
    console.log(`各生命周期内句柄爬升速率：现在还判断不了（**证据不足**：只有 ${LIFE.length} 段、`+
      `去掉每段预热后都不到 2 小时；实测中位 ${medSegFdRate===null?"n/a":medSegFdRate.toFixed(3)+"个/h"}=参考值）`);
  }else{
    console.log(`各生命周期内句柄爬升速率：中位 ${medSegFdRate===null?"n/a":medSegFdRate.toFixed(3)+"个/h"}，最大 ${maxSegFdRate===null?"n/a":maxSegFdRate.toFixed(3)+"个/h"}`+
      `（${segEvidence==="long"?longRates.length+" 段 ≥2h 的中位":segRates.length+" 段都不足 2h，按全部段中位"}）`);
  }
}
// 线程数不参与 S6 判定（S6 的四条判据是：连续 7 天无人工干预 / RSS 增幅 / 成功率 / 句柄）。
// 但原来这行只打印一个"+15"却不给结论，读起来像"检查过了、没问题"——
// 实测线程从 11 涨到 31 时它照打不误、exit 仍为 0。明确标成参照值，不制造错觉。
// **模板写漏了两个占位符**（2026-10-20 修）。
//
// 这行一直是 `线程: 首段中位 → 末段中位（增长 +0…）` ——
// 中间那两个数**从来没打印出来过**，因为模板里根本没写 `${th0}` 和 `${thN}`。
// 真窗口实测：数据里 `threads` 三个点全是 11，报告却显示空白，
// 读者会以为「采集没拿到线程数」。
//
// 这类错很难被注意到，因为它的表现是「少了一段字」，而不是报错。
// 回归里也没有任何断言检查这两个数出现过 —— 一条判据如果连自己的输出都不完整，
// 它后面无论说什么都不可复查。
const th0=med(headS.filter(thOk).map(s=>s.threads));
const thN=med(tailS.filter(thOk).map(s=>s.threads));
console.log(`线程: 首段中位 ${th0===null||th0===undefined?"n/a":th0} → 末段中位 ${thN===null||thN===undefined?"n/a":thN}`+
  `（增长 ${thGrowth>=0?"+":""}${thGrowth}，**仅供参考，不参与 S6 判定**）`);
console.log(`（首/末段各取 ${tailN} 个样本的中位数，避免单点噪声误判）`);
if(probesLegacy>0)
  console.log(`⚠ ${probesLegacy} 条旧格式探针没验过飞书送达（无 out/ws 字段），不计入成功率`);
console.log(`探针 ${probesVerified.length} 次（已验飞书），成功率 ${passRate===null?"n/a":(passRate*100).toFixed(0)+"%"}`);
console.log(`容器在线率 ${contRate===null?"n/a":(contRate*100).toFixed(1)+"%"}` +
            (contDown.length? `（${contDown.length} 个采样点容器不在线）` : ""));

const c=[];

// **能推 ❌ 的判据必须写在 `c[]` 之后**（2026-10-20，TDZ 第四次）。
// 这一轮把「退出码只看 c[]」定下来之后，我给两条原本沉默的判据
// （`relayCoverOk`/`httpCoverOk`、`hbHung`）补上了 ❌ 输出，
// 但插在了**它们算出来的地方**（L1087 / L1449），而 `c` 到 L1533 才定义 ——
// `ReferenceError: Cannot access 'c' before initialization`，`exit 2`。
// 这是这份单文件脚本里**第四次**踩 TDZ（第 47/67/68 轮各一次）。
// 规律很清楚：**「算出判据」的位置和「能说话」的位置不是同一个位置**。
// 判据要在早期算（后面的判据依赖它），但只有 `c[]` 之后的代码才能 push。
// 所以凡是「补一句 ❌」，都必须往 `c=[]` 后面搬，不能就地写。
// **覆盖不足也必须能推出 ❌**（2026-10-20 补，同上）。
// 这两个变量第 67 轮就加进了退出条件，但**从来没打印过任何东西** ——
// 失败时是一句沉默的 `exit 1`。把退出码改成只看 c[] 之后，
// `只看15%窗口须判红` 这个夹具立刻从红变绿，才把它揪出来。
// 措辞要和已有的 ⏳ 对齐：`⏳` 是「还没到判的时候」，`❌` 是「满了 7 天却只覆盖这么多」。
if(!relayCoverOk) c.push(`❌ **网关连通性只覆盖 ${(relayCover*100).toFixed(0)}% 的窗口**`+
  `（满 7 天了，判据 ≥${(COVER_RATE_LIMIT*100).toFixed(0)}%）：剩下的时间网关什么样没人看过`);
if(!httpCoverOk) c.push(`❌ **daemon 可达性只覆盖 ${(httpCover*100).toFixed(0)}% 的窗口**`+
  `（满 7 天了，判据 ≥${(COVER_RATE_LIMIT*100).toFixed(0)}%）：剩下的时间服务通不通没人看过`);

const hbHungOk = hbHung<=3;
if(!hbHungOk) c.push(`❌ **${hbHung} 次 sample 在 start 之后没有结局**（判据 ≤3）：`+
  `脚本中途死了（语法错 / 被 kill / 磁盘满），那几次采样直接丢了。`+
  `soak.jsonl 上只显示"稀疏"，看起来像 cron 抖动，实际是采集器在崩。`);
if(hasFuture){
  // 排在最前面：数据本身有问题，后面所有推算都不可信
  c.push(`❌ **样本时间戳在未来**：${futureSamples.length} 个点最多超前 ${maxFutureMin} 分钟`+
         `（时钟跳变或文件被改过）—— 先查清时间，再看别的判据`);
}
if(stale){
  // 观测已经停了，历史跨度再长也没意义 —— 这条要排在最前面说，
  // 否则读者会先看到"✅ 已满 7 天"而下结论。
  c.push(`❌ **观测已停止**：最后一个样本在 ${(staleness/3600).toFixed(2)}h 前`+
         `（超过 ${(STALE_LIMIT/3600).toFixed(1)}h 即视为没在看）`);
} else if(hasGap){
  // 只要有超容忍断档，无论累计观测多久都不能说"连续" —— 那段是盲区。
  c.push(`❌ **观测不连续**：最长空档 ${maxGapHours.toFixed(2)}h（容忍 ${(GAP_LIMIT/3600).toFixed(1)}h），`+
         `累计未观测 ${(deadTotal/3600).toFixed(2)}h；`+
         `已观测 ${coveredDays.toFixed(2)} 天 / 需连续 7 天`);
} else if(days>=7){
  c.push("✅ 已满 7 天且观测连续（无超容忍断档）");
} else {
  c.push(`❌ 未满 7 天（还差 ${(7-days).toFixed(2)} 天）`);
}
c.push(growth<50? "✅ RSS 增长 <50MB" : `❌ RSS 增长 ${growth.toFixed(1)}MB ≥50MB`);
c.push(fdGrowth<=2? "✅ 无明显句柄泄漏" : `❌ 句柄增长 ${fdGrowth}`);
c.push(fdPeakGrowth<FD_PEAK_LIMIT
  ? `✅ 全窗口句柄峰值增长 ${fdPeakGrowth} < ${FD_PEAK_LIMIT}`
  : `❌ **全窗口句柄峰值增长 ${fdPeakGrowth} ≥${FD_PEAK_LIMIT}**：`+
    `基线 ${fdBase} → 最高 ${maxFd}（重启把 fd 收回去，不能因此说没漏）`);
if(unattended.length){
  c.push(`❌ 有 ${unattended.length} 次重启**找不到自愈记录**（${unattended.map(r=>new Date(r.born*1000).toISOString().slice(11,19)).join(", ")}）`+
         ` —— "无人工干预"不成立`);
}
// 先限制"稳定性"（不能是崩溃循环），再说"重启都是自愈的"。
// 顺序很重要：只夸"全部自愈"而不限制频率，就是在给崩溃洗白。
if(isCrashLoop){
  c.push(`❌ **崩溃循环**：最长连续存活只有 ${longestLifeHours.toFixed(2)} 小时`+
         `（<${MIN_LONGEST_LIFE_HOURS}h），期间重启 ${restartRows.length} 次、平均每 ${avgRestartMin.toFixed(0)} 分钟一次。`+
         `"每次都被自愈"不等于"长期运行"`);
} else {
  // 只有一个生命周期 = 还没重启过，本来就谈不上"崩溃循环"。
  // 但这时存活时长可能远短于 1 小时（窗口刚开始），
  // 写"≥1h"就是假话 —— 实测窗口跑到 0.8h 时打印过
  // "最长连续存活 0.8 小时（≥1h，非崩溃循环）"，自相矛盾。
  if(LIFE.length<=1 && restartRows.length===0){
    if(longestLifeSec>0)
      c.push(`✅ 期间未重启过，当前进程已连续运行 ${longestLifeHours.toFixed(1)} 小时（崩溃循环判据要重启过才有意义）`);
  } else if(longestLifeSec>0 && longestLifeHours>=MIN_LONGEST_LIFE_HOURS){
    c.push(`✅ 最长连续存活 ${longestLifeHours.toFixed(1)} 小时（≥${MIN_LONGEST_LIFE_HOURS}h，非崩溃循环）`);
  }
  if(restartRows.length){
    c.push(`✅ 期间重启 ${restartRows.length} 次，全部是 watchdog 自愈（无人干预）；平均每 ${avgRestartMin.toFixed(0)} 分钟一次`);
  }
}
if(days>=7){
  c.push(probeDensityOk
    ? `✅ 探针密度 ≥${(PROBE_RATE_LIMIT*100).toFixed(0)}%（已验飞书 ${probesVerified.length} 次 / 应 ${Math.round(expectProbes)} 次）`
    : `❌ **探针密度只有 ${probeRate===null?"0":(probeRate*100).toFixed(0)}%**（已验飞书 ${probesVerified.length} 次 / 应 ${Math.round(expectProbes)} 次）：`+
      `"成功率不掉"需要真的测过，不能靠"一次都没测"来满足`);
}
if(days>=7){
  // **说清分母是怎么来的**（2026-10-20）：短尾段已被排除，
  // 不交代一句，读者看到 "6/7 段" 会自己去数 7 天应该有 7 还是 8 段。
  const segNote = tooShortProbeSegs.length
    ? `（另有 ${tooShortProbeSegs.length} 个尾段不足 ${PROBE_EVERY_SEC/3600}h 未计入：`+
      `探针每 ${PROBE_EVERY_SEC/3600}h 一次，这么短的段不可能被覆盖）`
    : "";
  c.push(probeCoverageOk
    ? `✅ 探针覆盖 ${coveredProbeDays}/${allSegList.length} 段（按窗口起点每 24h 一段，允许缺 ${PROBE_DAY_MISS_ALLOWED} 段）`+segNote
    : `❌ **探针只覆盖了 ${coveredProbeDays}/${allSegList.length} 段**：`+
      `"成功率不掉"要在整个窗口都有证据，不能只在开头测一批就算完`+segNote);
}
// **可用率必须单独成一条**（2026-10-20）。
// `deadOk` 数的是「采样时 daemon 不在」的点数，它抓不到「崩了又被拉起」——
// 那段时间根本没有采样点落在里面，只在 `restartRows[].downtimeSec` 里。
if(days>=7 && upRatio!==null){
  c.push(uptimeOk
    ? `✅ 窗口内可用率 ${(upRatio*100).toFixed(2)}%（停机 ${totalDowntimeHours.toFixed(1)}h / ${spanHours.toFixed(0)}h，判据 ≥${(UPTIME_LIMIT*100).toFixed(0)}%）`
    : `❌ **窗口内可用率只有 ${(upRatio*100).toFixed(2)}%**（停机 ${totalDowntimeHours.toFixed(1)}h / ${spanHours.toFixed(0)}h，判据 ≥${(UPTIME_LIMIT*100).toFixed(0)}%）：`+
      `「每次都被自愈」不等于「连续 7 天」—— 主人那 ${(100-upRatio*100).toFixed(1)}% 的时间里发消息没人应`);
}
c.push(deadOk
  ? `✅ 期间服务不可用累计 ${deadSampleHours.toFixed(1)} 小时（≤${DEAD_HOURS_LIMIT}h）`
  : `❌ **期间服务不可用累计 ${deadSampleHours.toFixed(1)} 小时**（>${DEAD_HOURS_LIMIT}h）：`+
    `${deadSampleCount} 个采样点记录到 daemon 不在跑 —— "连续 7 天"那 7 天里服务得真的在跑`);
if(days>=7){
  c.push(failRunOk
    ? `✅ 最长连续失败 ${maxFailRun} 次（判据 ≤${FAIL_RUN_LIMIT} 次）`
    : `❌ **连续 ${maxFailRun} 次探针失败**（判据 ≤${FAIL_RUN_LIMIT} 次），时间跨度 ${(maxFailSpanSec/3600).toFixed(1)} 小时：`+
      `总成功率 ${passRate!==null?(passRate*100).toFixed(0)+"%":"n/a"}、末尾成功率 ${tailPassRate!==null?(tailPassRate*100).toFixed(0)+"%":"n/a"} 都没盖住这段 —— `+
      `"成功率不掉"不等于"平均够高"`);
}
if(days>=7 && tailProbes.length>=4){
  c.push(tailOk
    ? `✅ 末尾 ${tailProbes.length} 次探针成功率 ${(tailPassRate*100).toFixed(0)}%（判据 ≥75%，防止"最后几天坏掉但被总平均盖住"）`
    : `❌ **末尾 ${tailProbes.length} 次探针成功率只有 ${(tailPassRate*100).toFixed(0)}%**（判据 ≥75%）：`+
      `总平均 ${(passRate*100).toFixed(0)}% 掩盖了下降趋势 —— 判据要的是"不掉"，不是"平均还行"`);
}
if(probeSecs.length)
  console.log(`探针耗时：中位 ${medSecs.toFixed(0)}s，最慢 ${maxSecs}s，末尾 4 次中位 `+
              `${tailMedSecs===null?"—":tailMedSecs.toFixed(0)+"s"}（判据：单次 ≤${SLOW_MAX}s、中位 ≤${SLOW_MED}s）`);
// **采集端算错了要说出来**（2026-10-20）：ok=true 但 out/ws 明确是 0，
// 说明 `ok` 这个字段本身不可信 —— 那是采集侧的 bug，不是数据形状问题。
// 不单独报，事后只能看到"成功率掉了"，查不出是产品坏了还是探针写错了。
if(probeContradictions.length)
  console.log(`⚠ **${probeContradictions.length} 条探针 ok=true 但 out/ws=0**（按失败计）：`+
    `采集侧算错了，见 do_probe 的 out_ok/ws_ok 赋值`);
if(passRate!==null){
  if(passRate>=0.95) c.push("✅ 成功率 ≥95%");
  else {
    // 失败要能归因：答错 vs 飞书没发出去
    // **原来的减法归因是错的**（2026-10-19 修）：
    //   other = bad.length - noOut - noWs
    // 一次探针可以**同时**失败于多个子判据（任务没完成 → out 空、ws 空、答案也不对），
    // 于是 noOut 和 noWs 会各自重复计入，other 变成负数。
    // 实测输出过"4 次失败：4 次飞书未送达 / 4 次飞书入站长连接不在 / **-4** 次未答对或未完成"。
    // 一个负数出现，说明这套归因在骗人 —— 宁可分成互斥桶，也不要靠减法。
    // 第二个错：bad 取的是 probes（含未验证的旧格式探针），
    // 而 passRate 的分母是 probesVerified —— 两个口径混用，归因数加起来对不上。
    const bad=probesVerified.filter(p=>probeFailed(p));
    const noOut=bad.filter(p=>p.out!==undefined && String(p.out)==="0").length;
    const noWs=bad.filter(p=>p.ws!==undefined && String(p.ws)==="0").length;
    // 既没送达也没入站：归为"飞书这条链路整个没通"，单列一桶
    const bothDown=bad.filter(p=>String(p.out)==="0" && String(p.ws)==="0").length;
    // **"未测到" 现在有两种写法**（2026-10-20）：老数据是空串 `""`，
    // 新数据是 `"?"`（明确表示"任务没走到出站检查"）。两者都算"没测到"。
    // 原来只判 `!p.out`，而 `"?"` 是真值 → 加上 ? 之后这条归因会**静默归零**，
    // 报告会变成"0 次没拿到完整子判据"，把真问题洗白。
    const notTested=(v)=>v===undefined || v===null || v==="" || v==="?";
    const noChannelOnly=bad.filter(p=>!notTested(p.out) && String(p.out)!=="0" &&
                                       !notTested(p.ws) && String(p.ws)!=="0").length;
    // **"任务没跑完" 和 "跑完了但没拿到子判据" 是两件事**（2026-10-20 修，第三变体）。
    //
    // probe 在 done 分支里才给 PROBE_SLOT/PROBE_WANT/OUT_OK/WS_OK 赋值。
    // 若 120 秒内没到 done（模型卡住、容器慢、排队），循环自然结束后
    // 仍会写一行 probe —— 此时 ok=0、slot=""、out=""、ws=""、status 停在 queued/running。
    // 原来这种被归进 noChannel（"探针没拿到完整子判据"），措辞暗示**是采集侧漏了字段**。
    // 而真相是**任务根本没跑完** —— 采集侧一点没漏，它老实记录了"没测到"。
    // 两者处置完全不同：前者要改采集代码，后者要查服务为什么慢。
    // 这是第 46 轮那条教训（"没开始采样"和"采了 7 天服务全瘫"同一句话）的第三个变体。
    const noChannel=bad.filter(p=>notTested(p.out) || notTested(p.ws)).length;
    // 未结束的 status：任务还在队列里或正在跑，从没走到出站检查
    const UNFINISHED=new Set(["queued","running",""]);
    const unfinished=bad.filter(p=>UNFINISHED.has(String(p.status))).length;
    const testedButNoChannel=noChannel-unfinished;
    // **"答案不对"可能是容器坏了，不是模型笨**（2026-10-20 修，真假红）。
    //
    // 探针只检查"回答里有没有期望值"。容器 quarantined/unhealthy 时，
    // 模型会回"没能完成：容器处于 quarantined 状态"，里面当然没有期望值 → ok=0，
    // 而 out/ws 都是 1（飞书链路好得很）→ 正好落进 noChannelOnly 这一桶，
    // 报告写「出站入站都正常但答案不对」。
    //
    // 真实数据佐证：历史上有 7 个探针任务在容器 quarantined 期间失败，
    // 模型都正确说了"容器被隔离"，但报告的措辞把人指向"模型答错"。
    // 一个环境故障被说成能力问题，排查方向就整个错了。
    //
    // 修：把失败探针的**时间点**与采样里的 container_ok/container_up 对齐。
    // 探针每 6 小时一次、采样每 30 分钟一次，取探针时刻**前后 1 小时**内的采样点，
    // 只要有任意一个记录到容器不可用，就把这条归到"容器不可用"桶。
    // 这是"证据主体与被判对象一致"（第③类）在归因上的应用：
    // 说"答案不对"之前，必须先确认"当时环境是好的"。
    const contBadAt=(p)=>{
      const near=all.filter(s=>Math.abs(s.ts-p.ts)<=3600);
      return near.some(s=>String(s.container_ok)==="0" || String(s.container_up)==="0");
    };
    // **"答案不对"的第三种误判：网关断了，模型根本没被问到**（2026-10-20 修）。
    //
    // 第 58 轮只对齐了容器，因为当时只有一个环境字段可对齐。
    // 但通道还有一段：模型在 Windows 上，WSL 通过 win-relay(172.17.48.1:13065) 出去。
    // 这条链断掉 → 探针必然全失败，而 out/ws 都是 1、容器也好 → 落进 answerWrong，
    // 报告写「出站入站都正常、容器也好但答案不对」。
    // 合成数据实测：7 天窗口 relay 断 14 小时 → 「3 次…但答案不对」，exit 1。归因整个错。
    //
    // 现在 sample 每 30 分钟记 relay_up，这里一样按"探针时刻前后 1 小时"对齐。
    // **注意：老样本没有 relay_up 字段**（undefined），不能当成 0 处理 ——
    // 那会把 7 天前的历史失败全部错怪到网关上。只有明确记到 0 才算网关背锅。
    const relayBadAt=(p)=>{
      const near=all.filter(s=>Math.abs(s.ts-p.ts)<=3600 && s.relay_up!==undefined);
      return near.some(s=>String(s.relay_up)==="0");
    };
    const contBad=bad.filter(p=>contBadAt(p)).length;
    const relayBad=bad.filter(p=>relayBadAt(p) && !contBadAt(p)).length;
    const answerWrong=noChannelOnly-contBad-relayBad;
    // 采样里有没有 relay_up 字段？没有就说明这段时间没人看网关，
    // 那"答案不对"这个结论就缺一环证据，得在报告里说明。
    const relaySeen=all.some(s=>s.relay_up!==undefined);
    c.push(`❌ 成功率 ${(passRate*100).toFixed(0)}%（${bad.length} 次失败，可重叠计数：`+
           `${noOut} 次飞书出站未送达 / ${noWs} 次飞书入站长连接不在 / `+
           (unfinished? `**${unfinished} 次探针任务 120 秒内没跑完**（status 停在 queued/running）/ `:"")+
           (testedButNoChannel>0? `${testedButNoChannel} 次跑完了却没拿到完整子判据 / `:"")+
           (contBad? `**${contBad} 次当时容器不可用**（答案拿不到，不是模型笨）/ `:"")+
           (relayBad? `**${relayBad} 次当时网关不通**（请求根本没到模型，不是模型答错）/ `:"")+
           (answerWrong>0? `${answerWrong} 次出站入站都正常、容器`+
             `${relaySeen?"和网关":""}也好但答案不对`+
             `${relaySeen?"":"（注意：这段时间采样里**没有 relay_up 字段**，网关状况其实没人看，这一条结论缺一环证据）"}`:"")+
           (bothDown? `；其中 ${bothDown} 次两条链路同时不通` : ""));
  }
}
{
  const dist=[0,1,2,3].map(s=>`${SLOT_NAMES[s]} ${slotSeen[String(s)]||0}`).join(" / ");
  if(probesVerified.length) console.log(`探针能力覆盖：${dist}`+(slotMissing.length?`　**未覆盖：${slotMissing.map(s=>SLOT_NAMES[s]).join("、")}**`:""));
if(wantMismatch.length)
  console.log(`⚠ **${wantMismatch.length} 条探针的 want 与 slot 对不上**（这条不计入能力覆盖）：`+
              wantMismatch.slice(0,4).map(p=>`slot=${p.slot} 该是 "${SLOT_WANT[String(p.slot)]}" 实际 "${p.want}"`).join("；")+
              (wantMismatch.length>4?" …":""));
}
if(day0Compat)
  console.log(`窗口起点核对：day0=${new Date(day0Ts*1000).toISOString().slice(0,16).replace("T"," ")}，`+
              `最早样本=${new Date(first.ts*1000).toISOString().slice(0,16).replace("T"," ")}`+
              (dataReset? `　❌ **晚了 ${((first.ts-day0Ts)/3600).toFixed(1)} 小时**`:dataReset===false?"　✅ 覆盖得住 day0":"")); 
if(dataReset)
  c.push(`❌ **数据最早样本比 day0 晚了 ${((first.ts-day0Ts)/3600).toFixed(1)} 小时**：`+
         `说明中间**清空或重建过数据文件**，"连续 N 天"的前提被破坏了 —— `+
         `报告里的天数只能证明"这份数据跨了 N 天"，不能证明"这件事连续跑了 N 天"`);
if(day0Early)
  c.push(`❌ **数据比 day0 还早 ${((day0Ts-first.ts)/60).toFixed(0)} 分钟**：day0 记错了，`+
         `"连续 7 天"的起点不可信`);
if(wantMismatch.length)
  c.push(`❌ **${wantMismatch.length} 条探针的 want 与 slot 对不上**：`+
         `记录说测的是"${SLOT_NAMES[Number(wantMismatch[0].slot)]||"?"}"，`+
         `但期望答案写的是 "${wantMismatch[0].want}"（这个 slot 该是 "${SLOT_WANT[String(wantMismatch[0].slot)]||"?"}"）—— `+
         `说明这条记录不可信，**不能算作"这条路径被测过了"**。`+
         `能力覆盖相信的是标签，而标签可以被填成任何值`);
if(!slotOk)
  c.push(`❌ **探针有 ${slotMissing.length} 条能力路径 7 天没测过**：`+
         `${slotMissing.map(s=>SLOT_NAMES[s]).join("、")} —— `+
         `只证明了"进程还活着"，没证明"这些活儿还干得动"。`+
         `成功率的分母里根本没有这几条路径`);
if(!secsOk)
  c.push(`❌ **探针太慢**：最慢 ${maxSecs}s（上限 ${SLOW_MAX}s）、全程中位 ${medSecs===null?"—":medSecs.toFixed(0)+"s"}、`+
         `末尾中位 ${tailMedSecs===null?"—":tailMedSecs.toFixed(0)+"s"}（上限 ${SLOW_MED}s） —— `+
         `活儿还是干对了，但**慢到没法用**。"成功率不掉"不等于"还能用"`);
if(contRate!==null) c.push(contRate>=0.95? "✅ 容器在线率 ≥95%" : `❌ 容器在线率 ${(contRate*100).toFixed(1)}%（容器长时间不在线）`);
if(days>=7 && contTailRate!==null){
  c.push(contTailOk
    ? `✅ 末尾 ${contTail.length} 个采样点容器在线率 ${(contTailRate*100).toFixed(0)}%（判据 ≥75%，看"最近 6 小时"）`
    : `❌ **末尾 ${contTail.length} 个采样点容器在线率只有 ${(contTailRate*100).toFixed(0)}%**（判据 ≥75%）：`+
      `全窗口平均 ${(contRate*100).toFixed(1)}% 掩盖了最近坏掉 —— 交付出去的成品此刻不能用`);
}
if(contRows.length)
  c.push(contUnattended.length===0
    ? `✅ 容器掉线 ${contRows.length} 次，全部有自愈记录（watchdog 自己拉回来的）`
    : `❌ **有 ${contUnattended.length} 次容器掉线找不到自愈记录**：`+
      contUnattended.map(r=>`${new Date(r.start*1000).toISOString().slice(5,16)}（${(r.secs/60).toFixed(0)}分钟）`).join("、")+
      ` —— 容器不是你手动拉回来的才算"无人工干预"`);
if(contRows.length)
  for(const r of contRows)
    console.log(`    ${r.healed?"✔":"✘"} 容器掉线 ${new Date(r.start*1000).toISOString().slice(5,16)} `+
                `持续 ${(r.secs/60).toFixed(0)} 分钟 ${r.healed?"（watchdog 自愈）":"（**无自愈记录**）"}`);
c.push(contDownOk
  ? `✅ 容器最长连续离线 ${(maxContDownSec/60).toFixed(0)} 分钟（≤${CONT_DOWN_LIMIT_SEC/3600}h，与"服务不可用"同口径）`
  : `❌ **容器最长连续离线 ${(maxContDownSec/60).toFixed(0)} 分钟**（>${CONT_DOWN_LIMIT_SEC/3600}h）`);

  // 容器"能干活"（容器进程活着 ≠ daemon 能用它）—— 2026-10-20 补，S6 最严重的一次盲区
  if(contOkUnknown){
        c.push(days>=7 && contUpCapable
      ? "❌ **整整 7 天、每次采集都有 container_up，却没有任何一个点带上 container_ok**："
        +"采集侧把这一项漏了。容器进程活着、daemon 能不能用它，这一项**一次都没测过**"
      : days>=7
        ? "⚠ **容器可执行性：整个窗口的采样都没有 container_ok**（连 container_up 也没有，"
          +"说明是加字段之前的老数据）—— 这条判断不了，但也不该拿来判失败"
        : "⚠ **容器可执行性：还没有任何采样点带 container_ok，这条暂时判断不了**（窗口未满 7 天）");
  }else{
    if(contOkRatePending){
      c.push(`⏳ 容器可执行率 ${(contOkRate*100).toFixed(1)}%（${contOkSamples} 点，实测值照列）：**窗口未满 7 天，这条还没到判的时候**`);
    }else{
      c.push(contOkRateOk
        ? `✅ 容器可执行率 ${(contOkRate*100).toFixed(1)}%（${contOkSamples} 点，判据 ≥${(CONT_OK_RATE_LIMIT*100).toFixed(0)}%；直接拿库里 endpoint 打 /healthz）`
        : `❌ **容器可执行率只有 ${(contOkRate*100).toFixed(1)}%**（${contOkSamples} 点）：容器进程活着，但 daemon 用不了它 —— 主人发的命令全在失败`);
    }
    c.push(contOkRatePending
      ? `⏳ 末尾 6 小时容器可执行率 ${contOkTailRate===null?"—":(contOkTailRate*100).toFixed(0)+"%"}（实测值照列）：窗口未满 7 天，还没到判的时候`
      : (contOkTailOk
        ? `✅ 末尾 6 小时容器可执行率 ${contOkTailRate===null?"—":(contOkTailRate*100).toFixed(0)+"%"}（≥75%）`
        : `❌ **末尾 6 小时容器可执行率只有 ${(contOkTailRate*100).toFixed(0)}%**：交付出去此刻就是坏的`));
    c.push(contOkDownOk
      ? `✅ 容器最长连续不可执行 ${(maxContOkDownSec/60).toFixed(0)} 分钟（≤${CONT_DOWN_LIMIT_SEC/3600}h）`
      : `❌ **容器最长连续不可执行 ${(maxContOkDownSec/60).toFixed(0)} 分钟**（>${CONT_DOWN_LIMIT_SEC/3600}h）`);
  }

// 网关三条（与容器同口径）。**没有字段时说"判断不了"，不打勾也不判死。**
if(relayUnknown){
  // 满 7 天 + 采集能力在 + 一个点都没有 = **漏采，是 bug，必须红**。
  // 只有「老数据（连 container_up 都没有）」才允许 ⚠ 放行。
  // **第三种状态：`⚠ 判断不了` 不能算通过**（2026-10-20）。
  //
  // 这条原来是纯 ⚠，第 74 轮把退出码改成「只看 c[] 有没有 ❌」之后，
  // ⚠ 不产生 ❌ → **网关 7 天一次没测，也判 exit 0**。合成实测确认过。
  //
  // 我先改成「有能力采却没采 = ❌」，但那个推理**没有证据**：
  // 有 container_up 不等于 relay_up 那一版采集代码在跑（两者相差 32 轮）。
  // 用了 ❌ 就是**给一个我没验过的结论定罪** —— 和第⑨类「标签会撒谎」正相反，
  // 这是**给证据不足的东西盖章**。
  //
  // 正确：**保持 ⚠，但让它拖住「通过」**。单独用一个 `unknownOk` 汇总，
  // 在退出码那里要求「没有任何 ❌ **且** 没有未知项」。
  c.push(`⚠ **网关连通性：这段时间的采样里没有 \`relay_up\` 字段，这条判断不了**`+
    `（既不算通过也不算失败 —— 但**也不能算交付合格**，见判定行末尾）`);
}else{
  c.push(!relayRateOk
    ? `❌ **网关连通率 ${(relayRate*100).toFixed(1)}%**（${relaySamples} 点，<95%）：主人发的消息有一段到不了模型`
    : (days>=7
        ? (relayCover>=COVER_RATE_LIMIT
            ? `✅ 网关连通率 ${(relayRate*100).toFixed(1)}%（${relaySamples} 点，覆盖 ${(relayCover*100).toFixed(0)}% 窗口）`
            : `⏳ 网关连通率 ${(relayRate*100).toFixed(1)}%（${relaySamples} 点，**只覆盖 ${(relayCover*100).toFixed(0)}% 的窗口**）：`+
              `剩下的时间网关什么样没人看过 —— 这条还不能打勾`)
        : `⏳ 网关连通率 ${(relayRate*100).toFixed(1)}%（${relaySamples} 点）：窗口未满 7 天，这条还没到判的时候`));
  c.push(relayDownOk
    ? `✅ 网关最长连续断开 ${(maxRelayDownSec/60).toFixed(0)} 分钟（≤${CONT_DOWN_LIMIT_SEC/3600}h）`
    : `❌ **网关最长连续断开 ${(maxRelayDownSec/60).toFixed(0)} 分钟**（>${CONT_DOWN_LIMIT_SEC/3600}h）：这段时间主人发什么都不通`);
}

// daemon 可达性三条（与容器/网关同口径）。**没有字段时说"判断不了"，不打勾也不判死。**
if(httpUnknown){
  c.push(`⚠ **daemon 可达性：这段时间的采样里没有 \`http_ok\` 字段，这条判断不了**`+
    `（既不算通过也不算失败 —— 但**也不能算交付合格**，见判定行末尾）`);
}else{
  c.push(!httpRateOk
    ? `❌ **daemon 可达率 ${(httpRate*100).toFixed(1)}%**（${httpSamples} 点，<95%）：进程在，但请求进不去`
    : (days>=7
        ? (httpCover>=COVER_RATE_LIMIT
            ? `✅ daemon 可达率 ${(httpRate*100).toFixed(1)}%（${httpSamples} 点，覆盖 ${(httpCover*100).toFixed(0)}% 窗口）`
            : `⏳ daemon 可达率 ${(httpRate*100).toFixed(1)}%（${httpSamples} 点，**只覆盖 ${(httpCover*100).toFixed(0)}% 的窗口**）：`+
              `剩下的时间 daemon 能不能用没人看过 —— 这条还不能打勾`)
        : `⏳ daemon 可达率 ${(httpRate*100).toFixed(1)}%（${httpSamples} 点）：窗口未满 7 天，这条还没到判的时候`));
  c.push(httpDownOk
    ? `✅ daemon 最长连续不可达 ${(maxHttpDownSec/60).toFixed(0)} 分钟（≤${CONT_DOWN_LIMIT_SEC/3600}h）`
    : `❌ **daemon 最长连续不可达 ${(maxHttpDownSec/60).toFixed(0)} 分钟**（>${CONT_DOWN_LIMIT_SEC/3600}h）：`+
      `这段时间进程在但服务不回，主人发什么都不通`);
}
c.push(peakGrowth<PEAK_GROWTH_LIMIT
  ? `✅ 全窗口 RSS 峰值增长 ${peakGrowth.toFixed(1)}MB < ${PEAK_GROWTH_LIMIT}MB`
  : `❌ **全窗口 RSS 峰值增长 ${peakGrowth.toFixed(1)}MB ≥${PEAK_GROWTH_LIMIT}MB**：`+
    `基线 ${baseRss.toFixed(1)}MB → 最高 ${peakRss.toFixed(1)}MB（与期间重启几次无关）`);
// **"证据不足"要一有就报，不该等到满 7 天才报**（2026-10-20 修，与句柄侧统一）。
// 原来这里带 `days>=7` 限定：于是"1 段、去预热后 1 小时"这种**真实存在**的早期窗口
// 会被静默跳过 —— 报告里 RSS 那条 ⚠ 根本不出现，只剩句柄那条。
// 而"证据不足"本身和满没满 7 天毫无关系：它就是"我现在没证据",
// 越早说越有用（能早点发现采样点太少 / 重启太频繁）。
// 第 60 轮把句柄侧对齐到 RSS 的三态门槛时，没发现 RSS 自己还挂了个 `days>=7`——
// 结果两边又在"什么时候该报"上分了岔。
if(medSegRate===null && segRates.length>0)
  c.push(`⚠ **RSS 段内爬升：证据不足，现在不判定**（只有 ${segRates.length} 段、去掉每段预热后都不到 2 小时）：`+
         `不判死也不打勾 —— 全窗口峰值增长那条判据仍然有效，能兜住总量`);
// **单段时不能用这条判据拦人**（2026-10-20 修，真缺陷）：
// 这条判据的**目的**是抓"靠重启把泄漏洗白"——`medSegRate` 算的是**各生命周期**
// 爬升率的中位数，它只有在**有多个生命周期**（即真的重启过）时才有意义。
// 但在"pid 全程没变、整个窗口就 1 段"时：
//   · 报告会打印"**每个**生命周期内 RSS 都在爬升"——可只有 1 个，谈不上"每个"，
//     这句话本身就是错的；
//   · 更要命的是**单段斜率分不清"预热/分配器扩容"和"泄漏"**。
//     本轮实测：daemon 的 RSS 是**阶梯式**涨（涨一级 → 持平 80~100 秒 → 再涨一级），
//     独立复现实验（1 次/秒 db.prepare()，280 秒）也是同样形状、总共只涨 2.2MB。
//     一个 1.1 小时的窗口恰好覆盖"涨一级"，斜率就是正的且很大 → 判 ❌。
//     这正是第 29 轮踩过两次的同一个坑（预热被当泄漏）。
// 而"没有重启"的时候，根本不存在"重启洗白"这回事，
// 总量由**全窗口峰值增长**那条判据（直读判据原文的 50MB、与重启无关）负责兜。
// 所以：只有真的有多段（≥2）时才让这条参与拦截。
// **泄漏不能只看中位数：一段在漏，其余干净，中位就会把它洗白**（2026-10-20 修）。
// 现场（合成数据，实测 `exit 0`、报告全绿）：
//   3 段生命周期，前两段 RSS 稳稳 200MB（速率 0），第三段 3MB/h 在爬。
//   中位 = med([0, 0, 3]) = **0** → 「各生命周期内 RSS 无明显爬升」。
//   同时全窗口峰值只涨了 22.5MB（因为第三段只有 8 小时）< 50MB → 也绿。
//   两条判据同时漏，报告说"没有泄漏"，`exit 0`。
// 而 `maxSegRate` **早就算出来了**（L1136），却只出现在打印语句里，
// 从没进过 `process.exit` —— 又是第⑤类（采集了却没用）叠第⑩类（不改退出码就等于不存在）。
// 为什么该用"任一段"而不是"中位"：
// 泄漏的本质是"跑得越久、漏得越多"，**一个生命周期在漏就是真在漏**，
// 不会因为别的生命周期是干净的就不算。中位数在这里是错的统计量 ——
// 它默认"多数段的行为代表整体"，而故障恰恰是少数段的事。
// （对照：`peakGrowth` 管总量、`segRate` 管趋势，两者都不该被"多数正常"稀释。）
// 保留中位值一起打印，因为"多数段正常、只有一段漏"和"段段都在漏"
// 是两种不同的病，看一眼中位能立刻区分。
const segCanFail = segRates.length >= 2;
const segTooMany = segRates.filter(r=>r>=SEG_RATE_LIMIT).length;
if(medSegRate!==null && segCanFail){
  c.push(segTooMany===0
    ? `✅ 各生命周期内 RSS 无明显爬升（中位 ${medSegRate.toFixed(2)}MB/h、最高 ${(maxSegRate===null?0:maxSegRate).toFixed(2)}MB/h，${segRates.length} 段）`
    : `❌ **${segTooMany}/${segRates.length} 段在爬升**（最高 ${(maxSegRate===null?0:maxSegRate).toFixed(2)}MB/h ≥${SEG_RATE_LIMIT}，中位 ${medSegRate.toFixed(2)}MB/h）：`+
      `重启只是把泄漏截断，不是没漏`);
}
if(medSegRate!==null && !segCanFail){
  c.push(`⚠ **RSS 段内爬升：只有 ${segRates.length} 段（全程没重启），这条不参与判定**`+
         `（实测 ${medSegRate.toFixed(2)}MB/h=参考值）：单段斜率分不清"预热/分配器扩容"和"泄漏"——`+
         `RSS 阶梯式涨（涨一级→持平→再涨）时短窗口斜率天然为正。总量看上面的"全窗口峰值增长"`);
}
if(sampleRate!==null){
  // 先判"太多"，再判"太少" —— 太多是更强的信号（一定是人）。
  // **窗口太短时这条没有意义**（2026-10-20 当场自纠）：
  // 刚开新窗口就采一个点，`expectSamples = hours*2 ≈ 0.03`，
  // 密度算成 **180000%**，新判据立刻喊「有人手动跑了 sample」——
  // 它说的其实是「这是这个窗口的第一个点」。
  // 与 `days>=7` 前缀同一个道理：判据要有「还没到判的时候」这个状态。
  // 4 小时给 ≤30% 的统计抖动留余量（cron 抖动 + 首点）。
  // **窗口太短时连"✅"都不能打**（2026-10-20 当场自纠第二遍）：
  // 刚开窗口采一个点 → 密度 22500%，渲染成 `✅ 采样密度 ≥70%（22500%）`。
  // 退出码是对的（有前缀挡住），但**措辞在撒谎**：那个 ✅ 什么也没证明。
  // 这正是「判据的话和它的意思要一致」——一个荒唐的数字前面不该有勾。
  // **「太少」可以等，「太多」不能等**（2026-10-20 修，第一版把真人工干预放过去了）。
  //
  // 短窗口的 ⏳ 门槛（`days<7/6`，约 28 小时）是为「太少」立的：
  // 窗口刚开，还没攒够点，这时候算比率没有意义。
  // 但「太多」不同 —— **它是人工干预唯一的指纹**，而且窗口越短越刺眼：
  // 合成实测：4 小时窗口塞 30 个点（应采 8，比率 375%），
  // 那是**明明白白有人在手动跑**，却被 ⏳ 挡掉、`exit 0`。
  // 判据要的是「无人工干预」，人工干预发生在第一小时也算。
  //
  // 所以：**「太多」不受窗口长度豁免**，只要分母过半（≥8 次应采）就开始判；
  // 分母不足 8 次时，比率本身的舍入误差就能到 12% 以上，那时不论多少都不判
  // —— 这条与摘要行的口径保持一致。
  if(sampleRate>SAMPLE_RATE_MAX && expectSamples>=4){
    c.push(`❌ **采样密度 ${(sampleRate*100).toFixed(0)}%**（${all.length} 次 / 应 ${Math.round(expectSamples)} 次）：`+
      `设计是每 30 分钟一次，多出来的每一次都是**有人手动跑了 sample** —— `+
      `而判据要的是「无人工干预」。这条比「太少」更硬：少了可能是机器抖动，多了只能是人。`);
  }else if(days<7/6){
    c.push(`⏳ 采样密度 ${(sampleRate*100).toFixed(0)}%（${all.length} 次 / 应 ${expectSamples.toFixed(1)} 次）：`+
      `窗口还太短，这条还没到判的时候`);
  }else c.push(sampleRate>=SAMPLE_RATE_LIMIT
    ? `✅ 采样密度 ≥${(SAMPLE_RATE_LIMIT*100).toFixed(0)}%（${(sampleRate*100).toFixed(0)}%）`
    : `❌ **采样密度只有 ${(sampleRate*100).toFixed(0)}%**（${all.length} 次 / 应 ${Math.round(expectSamples)} 次）：`+
      `空档虽都在容忍内，但大部分时间没在观测`);
}
// 句柄侧与 RSS 同一个洞（2026-10-20 一并修）：`maxSegFdRate` 早就算出来了，
// 却只出现在打印里，从没进过 `process.exit`。3 段里只有 1 段漏句柄时，
// 中位会被另外两段拉回 0，报告说"无明显爬升"。理由与 RSS 完全一致 ——
// 泄漏是"跑得越久漏得越多"，一个生命周期在漏就是真在漏。
const fdSegTooMany = segFdRates.filter(r=>r>=SEG_FD_RATE_LIMIT).length;
// **句柄侧必须和 RSS 侧用同一套证据门槛**（2026-10-20 修，又一处"同生不同命"）。
// 现场：真窗口只有 1 段、去预热后 1.04 小时。RSS 侧老实说
//   「⚠ 现在还判断不了（证据不足：只有 1 段、且都不到 2 小时）」，
// 句柄侧却在同一份数据上写
//   「✅ 各生命周期内句柄无明显爬升（中位 0.00个/h、最高 0.00个/h）」。
// 一份证据、两个结论 —— 而且恰好是"一个说判断不了、一个说没事"。
// 第 14 轮那个坑（零证据被当成合格）在句柄侧原样复发：
// `medSegFdRate` 只要不是 null 就往下判，完全不看证据够不够。
// 修：让句柄侧复用 RSS 的 `segEvidence`（long / multi / insufficient）。
// 证据不足时同样打印 ⏳ 并说明原因，不进退出码。
// 注意"不进退出码"本身是对的（`medSegFdRate===null||fdSegTooMany===0`），
// 但**报告不能说 ✅** —— 说 ✅ 就是在替证据不足背书。
if(segEvidence==="insufficient"){
  c.push(`⚠ **句柄段内爬升：证据不足，现在不判定**（只有 ${segFdRates.length} 段、去掉每段预热后都不到 2 小时；`+
         `实测中位 ${(medSegFdRate===null?0:medSegFdRate).toFixed(2)}个/h=参考值）`);
}else if(medSegFdRate!==null){
  c.push(fdSegTooMany===0
    ? `✅ 各生命周期内句柄无明显爬升（中位 ${medSegFdRate.toFixed(2)}个/h、最高 ${(maxSegFdRate===null?0:maxSegFdRate).toFixed(2)}个/h）`
    : `❌ **${fdSegTooMany}/${segFdRates.length} 段在漏句柄**（最高 ${(maxSegFdRate===null?0:maxSegFdRate).toFixed(2)}个/h ≥${SEG_FD_RATE_LIMIT}，中位 ${medSegFdRate.toFixed(2)}个/h）：`+
      `重启只是把泄漏截断，不是没漏`);
}
// **「判断不了」要出现在判定行里**（2026-10-20）。
// 不然读者只看最后一行，会以为全绿 —— 而这一轮之前它确实是 exit 0。
const unknownBit = unknownOk ? "" : "；⚠ **有判据判断不了，不算交付合格**";
console.log("\n判定：" + c.join("；") + unknownBit);
// **成功率必须参与退出码**（2026-10-19 修，真缺陷）：
// 原来这一行只算了 days/coveredDays/growth/fdGrowth/unattended/contRate，
// 唯独漏了 passRate —— 于是"判定"那行明明打印 `❌ 成功率 50%`，
// 退出码却还是 0，脚本层面会当成通过。合成数据实测：28 次探针全后半失败、
// 总成功率 50%，exit 仍是 0。这等于 S6 最容易退化的那条判据没有约束力。
// 语义取"不掉"：有探针时必须 ≥95%；没探针（探针还没跑过）不据此判失败。
// **"不掉"不等于"总平均够"**（2026-10-19 补，真缺口）：
// 判据原话是"成功率**不掉**"。总平均会掩盖下降趋势 ——
// 合成数据实测：160 次探针里最后 8 次全失败（**最后一天成功率 0%**），
// 总数 95% 恰好压线 → exit 0。服务其实最后一天已经全坏了。
const passOk = (passRate===null || passRate>=0.95) && probeDensityOk && probeCoverageOk && tailOk && deadOk && failRunOk && secsOk && slotOk && wantMismatch.length===0 && !dataReset && !day0Early;
// **结论只能有一个来源：c[]**（2026-10-20 补，结构性修复）。
// 原来 `verdictOk` 是一个**跨 48 行手写维护的布尔式**，
// 而 `c[]` 里已经有 37 处 `❌`。同一个结论写了两遍，两遍会悄悄分家——
// 而且**已经分家过两次**：
//   · 第 67 轮：`relayCoverOk`/`httpCoverOk` 算出来了却没进 exit（率只覆盖 15% 窗口仍绿）；
//   · 第 62 轮：RSS 侧「证据不足」分支被 `&& days>=7` 挡住，压根不打印。
// 还发现第 1979/1980 行是**同一段条件复制了两遍**（`contOkUnknown||…` 写两次）——
// 手写长布尔式的典型产物：复制粘贴、没人敢删。
// 正确做法：**退出码 = c[] 里有没有 ❌**。这样「加判据忘了加退出码」
// 在结构上不可能发生 —— 加了 ❌ 就自动是红的，不用记得改第二个地方。
// 风险是反向的：某处条件在 exit 里、却不产生 ❌ → 会从红变绿。
// 这靠回归兜（154 个夹具，含 8 个必须红的）。
// **结论只能有一个来源：`c[]`**（2026-10-20 结构性修复，见下）。
//
// 原来这是一个跨 48 行手写维护的布尔式，而 `c[]` 里已经有 37 处 ❌ ——
// 同一个结论写两遍，两遍会悄悄分家，而且**已经分家过两次**：
//   · 第 67 轮：`relayCoverOk`/`httpCoverOk` 算出来了却没进 exit（率只覆盖 15% 窗口仍绿）；
//   · 第 62 轮：RSS 侧「证据不足」分支被 `&& days>=7` 挡住，压根不打印。
// 还发现那段条件里有一整行**被复制了两遍**（`contOkUnknown||…` 写两次）——
// 手写长布尔式的典型产物：复制粘贴、没人敢删。
//
// 改成「退出码 = c[] 里有没有 ❌」之后，加判据忘了加退出码**在结构上不可能**。
// 代价是反向风险：原本在 exit 里、却不产生 ❌ 的条件会从红变绿。
// 这靠回归兜（160 条，含 8 条必须红）—— 并且当场就揪出两条：
// `hbHung`（心跳无结局）和 `relayCoverOk`/`httpCoverOk` 原本**从不说话**，已补 ❌。
//
// **但还有一类不能变成 ❌：`⚠ 判断不了`。**
// 它既不是通过也不是失败（没有任何证据说它坏），但也**不是交付合格**。
// 所以退出码要三项都满足：没有 ❌、没有未知项、且满 7 天。
const verdictOk = !c.some(x=>String(x).startsWith("❌")) && unknownOk;

// ── **结论必须落盘**（2026-10-20 补，真缺陷）
// 现场：`report` 跑完只在终端打印一段话，**什么都没留下**。
// `docs/acceptance/` 里只有 S3/S4/S5 的证据，没有一条 S6 的结论。
// 三个后果，一个比一个严重：
// ① **`report` 不是幂等的**：它用实时 `nowSec` 算 `days`/`staleness`，
//    同一份 7 天证据现在跑 `exit 0`，2 小时后跑 `exit 1`（`stale`，STALE_LIMIT=5400）。
//    也就是说**验收窗口只有 1.5 小时**，错过就永久失败，原样重跑也不行。
//    合成实测：冻住一份完整 7 天证据（336 点、末点距今 30 分钟）→ `exit 0`；
//    再等 2 小时同样命令 → `exit 1`。**证据没变，结论变了。**
// ② **历史结论会被后来的数据改写**。S6 是「连续 7 天」——
//    这是**一件已经发生过的事**。第 7 天满足过就该记下来，
//    不该被第 8 天的一次抖动改写成「从未通过」。
// ③ **无法审计**：事后没人知道「哪天几点、覆盖多少、什么数字、判了什么」。
//    这正是 S3/S4/S5 都做了、而 S6 没做的事：三个验收脚本都有 `--judge` + 落盘，
//    唯独最需要 7 天证据的这一个不留痕迹。
// 落盘：时刻 / exit / 数据文件与 md5 / 窗口覆盖 / 每条关键判据的实测值。
// **只追加、不改写** —— 之后再怎么跑都不会动已经写下的行。
// 路径可用 `SOAK_VERDICT` 覆盖（回归测试用，防污染真证据）。
try{
  const fsv=require("node:fs");
  // **`SOAK` 是 bash 变量，node 里读不到** —— 必须走 `process.env`。
  // 这是第 61 轮踩过的同一个坑（那次是 `ReferenceError: SOAK is not defined`），
  // 当时把它当成了「判据崩溃」，这次又被尾部检查抓了一次。
  // 说明这类错误在这份脚本里**有复发倾向**：bash 变量名和 process.env 只差一个前缀，
  // 肉眼几乎看不出。尾部那条「脚本自身出错」的检查是唯一能兜住它的东西。
  const soakPath=process.env.SOAK;
  const vp=process.env.SOAK_VERDICT || String(soakPath).replace(/[^/]+$/,"")+"soak-verdict.jsonl";
  // **必须记下判定脚本自己的 md5**（2026-10-20 补，真缺陷）。
  //
  // 审计行本来就记了**数据**的 md5 —— 数据没变就能复核。
  // 但它没记**尺子**的 md5。而这份脚本在窗口期内被改了 **26 次**，
  // 所有阈值（COVER_RATE_LIMIT / HTTP_RATE_LIMIT / PEAK_GROWTH_LIMIT / …）
  // **全是这 26 次里新加的或改过的**。
  //
  // 后果：三天前那行 `exit:0`，今天拿到原样的数据也无法复核 ——
  // 不知道当时用的是哪套判据、哪个阈值。
  // 「数据可验、尺子不可验」比「两者都不可验」更危险：
  // 它看起来有 md5、像是可复核的，实际上只能证明数据没变。
  //
  // 记两样：脚本 md5 + 当前生效的全部阈值。
  // 阈值直接写进 JSON 而不是只记 md5 —— md5 能证同一性，但读不出"当时是多少"。
  const selfPath=process.argv[1]||"";
  let scriptMd5="?";
  let md5="?";
  try{ md5=require("node:child_process").execSync(`md5sum ${JSON.stringify(soakPath)} 2>/dev/null | cut -c1-32`,{encoding:"utf8"}).trim()||"?"; }catch(e){}
  // **exit 必须有原因**（2026-10-20 补）。
  //
  // 第一版审计行只写了 `exit:1`，没有别的。事后翻到三天前那行，
  // **完全不知道是 RSS 涨了、成功率掉了、还是容器挂了**。
  // 这与第 61 轮那条「空数据只 exit 1 不说原因」是同一个病的不同层面：
  // 那次是**终端**不说，这次是**落盘**不说。
  // 而且终端里已经算好的「哪条红」就在 `c[]` 里 —— 不记下来等于白算一遍。
  //
  // 口径：只收 `c[]` 里以 ❌ 开头的那几条（去掉 markdown 加粗的星号），
  // 每条截到 80 字，最多 12 条 —— 审计行要能被人一眼读完，
  // 而不是变成一段不可读的长 JSON。
  const failures=c
    .filter(x=>x.startsWith("❌"))
    .map(x=>x.replace(/\*\*/g,"").slice(0,80))
    .slice(0,12);
  try{ scriptMd5=require("node:child_process")
    .execSync(`md5sum ${JSON.stringify(process.env.SOAK_SELF||"/root/dotd/scripts/soak.sh")} 2>/dev/null | cut -c1-32`,{encoding:"utf8"}).trim()||"?"; }catch(e){}
  const limits={rssMb:50,peakGrowthMb:PEAK_GROWTH_LIMIT,fdPeak:FD_PEAK_LIMIT,fdSegRate:SEG_FD_RATE_LIMIT,
    segRate:SEG_RATE_LIMIT,contOkRate:CONT_OK_RATE_LIMIT,contDownSec:CONT_DOWN_LIMIT_SEC,
    relayRate:RELAY_RATE_LIMIT,httpRate:HTTP_RATE_LIMIT,coverRate:COVER_RATE_LIMIT,
    probeRate:PROBE_RATE_LIMIT,sampleRate:SAMPLE_RATE_LIMIT,sampleRateMax:SAMPLE_RATE_MAX,deadHours:DEAD_HOURS_LIMIT,staleSec:STALE_LIMIT};
  // **窗口起止必须落盘**（2026-10-20 补，真缺陷）。
  //
  // 前几轮把「数据 md5」「尺子 md5」「阈值」都记了，但**没记窗口是哪一段**。
  // `observedDays:7.001` 只说「跨了 7 天」，不说「是哪 7 天」。
  //
  // 这不是吹毛求疵：本项目 `soak-day0.txt` 已经改过 3 次
  // （`soak-day0.old5h-*`、`soak-day0.pre-s5kill-*`、当前这份），
  // 而且**当前这份的 mtime（03:44）比它写下的窗口起点（03:25:20）晚 19 分钟** ——
  // 因为中途被重写过一次（只是写了同样的值）。
  // 外部看审计行**无法区分「重写了同样的值」和「偷偷改了窗口」**：
  // 两者都会让 `observedDays` 变，且都能凑出 `exit:0`。
  //
  // S6 的核心主张就是「连续 7 天」——**哪 7 天是这句话的全部内容**。
  // 记三项：窗口起 / 窗口止 / 观测到的最后一点。
  const winFirst=first.ts, winLast=last.ts;
  const row={at:new Date().toISOString(),exit:verdictOk?0:1,failures,scriptMd5,limits,
    windowStart:new Date(winFirst*1000).toISOString(),windowEndObserved:new Date(winLast*1000).toISOString(),
    windowStartUnix:winFirst,windowEndUnix:winLast,
    soak:soakPath,md5,
    records:all.length,observedDays:Number(coveredDays.toFixed(3)),spanDays:Number(days.toFixed(3)),
    rssGrowthMb:Number(growth.toFixed(1)),fdGrowth,maxFdPeak:maxFd,
    passRate:passRate===null?null:Number((passRate*100).toFixed(1)),probes:probesVerified.length,
    contRate:contRate===null?null:Number((contRate*100).toFixed(1)),
    relayRate:relayRate===null?null:Number((relayRate*100).toFixed(1)),relayCover:Number((relayCover*100).toFixed(1)),
    httpRate:httpRate===null?null:Number((httpRate*100).toFixed(1)),httpCover:Number((httpCover*100).toFixed(1)),
    restarts:unattended.length,stale:Boolean(stale),hasGap:Boolean(hasGap)};
  fsv.appendFileSync(vp, JSON.stringify(row)+"\n");
}catch(e){ console.log(`  (审计行写入失败：${e.message})`); }

process.exit(verdictOk ? 0 : 1);

// ── **结论必须落盘**（2026-10-20 补，真缺陷）
// 现场：`report` 跑完只在终端打印一段话，**什么都没留下**。
// `docs/acceptance/` 里只有 S3/S4/S5 的证据，没有一条 S6 的结论。
// 这有三个后果，一个比一个严重：
// ① **`report` 不是幂等的**：它用实时 `nowSec` 算 `days`/`staleness`。
//    同一份 7 天证据，现在跑 `exit 0`，2 小时后跑 `exit 1`（`stale`，STALE_LIMIT=5400）。
//    也就是说**验收窗口只有 1.5 小时**，错过就永久失败，原样重跑也不行。
//    合成实测：冻住一份完整 7 天证据（336 点、末点距今 30 分钟）→ `exit 0`；
//    再等 2 小时同样命令 → `exit 1`。**证据没变，结论变了。**
// ② **历史结论会被后来的数据改写**。S6 判据是「连续 7 天」，
//    这是**一个已经发生过的事实**。第 7 天满足过就该记下来，
//    不该被第 8 天的一次抖动覆盖成「从未通过」。
// ③ **无法审计**：事后谁也不知道「哪天几点、什么覆盖、什么数字、判了什么」。
//    这正是 S3/S4/S5 都做了而 S6 没做的事 —— 三个验收脚本都有 `--judge` + 落盘，
//    唯独最需要 7 天证据的这一个不留痕迹。
// 落盘内容：时刻 / exit / 数据文件与 md5 / 窗口覆盖 / 每条关键判据的实测值。
// **只追加，不改写** —— 后面再怎么跑都不会动已经写下的行。

// 审计行：一行一个 JSON，只追加。
// 路径可用 `SOAK_VERDICT` 覆盖（回归测试用，防止污染真证据）。
try{
  const vp=process.env.SOAK_VERDICT || (SOAK.replace(/[^/]+$/,"")+"soak-verdict.jsonl");
  let md5="?";
  try{ md5=require("node:child_process").execSync(`md5sum ${JSON.stringify(SOAK)} 2>/dev/null | cut -c1-32`,{encoding:"utf8"}).trim()||"?"; }catch(e){}
  const row={at:new Date().toISOString(),exit:verdictOk?0:1,soak:SOAK,md5,
    samples:all.length,observedDays:Number(coveredDays.toFixed(3)),spanDays:Number(days.toFixed(3)),
    rssGrowthMb:Number(growth.toFixed(1)),fdGrowth,maxFdPeak:maxFd,
    passRate:passRate===null?null:Number((passRate*100).toFixed(1)),
    probeSamples:probesVerified.length,
    contRate:contRate===null?null:Number((contRate*100).toFixed(1)),
    relayRate:relayRate===null?null:Number((relayRate*100).toFixed(1)),relayCover:Number((relayCover*100).toFixed(1)),
    httpRate:httpRate===null?null:Number((httpRate*100).toFixed(1)),httpCover:Number((httpCover*100).toFixed(1)),
    restarts:unattended.length,stale:Boolean(stale),hasGap:Boolean(hasGap)};
  require("node:fs").appendFileSync(vp, JSON.stringify(row)+"\n");
}catch(e){ console.log(`  (审计行写入失败：${e.message})`); }

process.exit(verdictOk ? 0 : 1);
__SOAK_REPORT_JS__
  node "$_SOAK_JS" "$0"
}
case "${1:-sample}" in
  sample) do_sample ;;
  probe)  do_probe ;;
  report)
    # **脚本崩了必须返回非 0**（2026-10-19 补，真坑）：
    # do_report 里是 `node -e '...'`，一旦脚本有 ReferenceError/TypeError，
    # node 退出码是 1 —— 但如果外面套了 `| tail` / `| grep`，管道的退出码
    # 就变成最后那个命令的（几乎总是 0），于是**判据崩了却报"通过"**。
    # 我自己就踩过：改完变量名漏改一处 → node 崩在 allDayList is not defined，
    # 而 `| tail` 把 exit 吞成 0。
    # 这里把"输出"和"退出码"解耦：崩了先明确打印错误、再以非 0 退出。
    REPORT_OUT=$(mktemp); trap 'rm -f "$REPORT_OUT"' EXIT
    do_report > "$REPORT_OUT" 2>&1
    REPORT_RC=$?
    cat "$REPORT_OUT"
    if [ "$REPORT_RC" -ne 0 ]; then
            # **只认 node 堆栈的形状**（2026-10-20，护栏自己误报）。
      # 原来是在报告输出里搜 `ReferenceError|TypeError|…` 这几个词。
      # 但这一轮我在源码注释里写了「第 61 轮踩过的同一个坑（那次是 ReferenceError）」——
      # 而**源码注释会被 dump 进报告**（堆栈里带代码上下文行），
      # 于是护栏读到自己的注释，判定「脚本崩溃」，`exit 2`。
      # 判据搜关键词、而关键词可能出现在**非错误的地方**（注释/文案/数据），
      # 这是第⑨类「标签会撒谎」的反向：**检索会误中自己**。
      # 收紧成 node 堆栈的真实形状：错误类型必须在行首、栈帧必须缩进四格。
if grep -qE '^(ReferenceError|TypeError|SyntaxError|RangeError|Error): |^    at ' "$REPORT_OUT"; then
        echo ""
        echo "❌ report 脚本自身出错（上面是堆栈）—— 这不是\"数据不达标\"，是判据坏了，必须修"
        exit 2
      fi
      exit "$REPORT_RC"
    fi
    # 兜底：即使退出码是 0，输出里有堆栈也说明坏了
    if grep -qE '^(ReferenceError|TypeError|SyntaxError|RangeError|Error): |^    at ' "$REPORT_OUT"; then
      echo ""
      echo "❌ report 脚本自身出错（退出码却是 0）—— 判据坏了，必须修"
      exit 2
    fi
    exit 0
    ;;
  install_cron)
    LINE1='*/30 * * * * /root/dotd/scripts/soak.sh sample >/dev/null 2>&1'
    LINE2='0 */6 * * * /root/dotd/scripts/soak.sh probe >/dev/null 2>&1'
    CUR=$(crontab -l 2>/dev/null || true)
    printf '%s\n' "$CUR" | grep -qF 'soak.sh sample' || CUR=$(printf '%s\n%s' "$CUR" "$LINE1")
    printf '%s\n' "$CUR" | grep -qF 'soak.sh probe'  || CUR=$(printf '%s\n%s' "$CUR" "$LINE2")
    printf '%s\n' "$CUR" | sed '/^$/d' | crontab -
    echo "已装 cron："; crontab -l | grep soak
    ;;
  *) echo "用法: $0 {sample|probe|report|install_cron}"; exit 1 ;;
esac
