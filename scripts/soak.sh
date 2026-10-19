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
SOAK="${SOAK:-$OUTDIR/soak.jsonl}"
export SOAK

PID_DAEMON() { pgrep -f 'src/daemon.ts' | head -1; }

do_sample() {
  local pid rss_kb fd n_threads cont db_kb ts
  ts=$(date +%s)
  # **同一秒不要重复落盘**（2026-10-19 补）：date +%s 只有秒精度，
  # 手工连跑两次 sample、或 cron 与手工调用撞上，会写出两行完全相同的记录。
  # 真实发生在我自己测试时（连跑两次 sample，两行 ts 都是 1792417117），
  # 虽然 report 现在会按 ts 去重，但**别让脏数据进文件**更干净。
  if [ -n "${SOAK:-}" ] && [ -s "$SOAK" ]; then
    local last_ts
    last_ts=$(tail -1 "$SOAK" 2>/dev/null | grep -o '"ts":[0-9]*' | head -1 | cut -d: -f2)
    if [ "$last_ts" = "$ts" ]; then
      echo "sample: 同一秒已有记录（ts=$ts），跳过避免重复"
      return 0
    fi
  fi
  pid=$(PID_DAEMON)
  if [ -z "$pid" ]; then
    node -e 'const fs=require("fs");fs.appendFileSync(process.env.SOAK, JSON.stringify({ts:Number(process.argv[1]),alive:false})+"\n")' "$ts"
    echo "daemon 不在跑（已记录 alive=false）"
    return 0
  fi
  rss_kb=$(awk '/^VmRSS:/{print $2}' "/proc/$pid/status" 2>/dev/null || echo 0)
  n_threads=$(ls "/proc/$pid/task" 2>/dev/null | wc -l)
  fd=$(ls "/proc/$pid/fd" 2>/dev/null | wc -l)
  cont=$(docker ps --filter name=dotd-dot-dot1 --format '{{.Status}}' 2>/dev/null | grep -c Up || true)
  db_kb=$(stat -c '%s' "$HOME/.dotd/dotd.db" 2>/dev/null | awk '{print int($1/1024)}')
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
const o={ts:Number(process.argv[1]),alive:true,rss_kb:Number(process.argv[2]),
  fd:Number(process.argv[3]),threads:Number(process.argv[4]),
  container_up:Number(process.argv[5]),db_kb:Number(process.argv[6]),
  pid:Number(process.argv[7]),proc_start:Number(process.argv[8])};
fs.appendFileSync(process.env.SOAK, JSON.stringify(o)+"\n");' \
    "$ts" "$rss_kb" "$fd" "$n_threads" "$cont" "${db_kb:-0}" "$pid" "${proc_start:-0}"
  echo "sample: rss=${rss_kb}KB fd=$fd threads=$n_threads container_up=$cont db=${db_kb}KB pid=$pid"
}

do_probe() {
  local tid st t0 ok=0 ts
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
  node -e '
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
const probes=lines.filter(x=>x.kind==="probe");
// 修复前采的样本没有 pid/proc_start 字段（那时还没记录身份），
// 它们无法参与"生命周期"判断，单独算一类，不混进来算增长。
// **重复行可以伪造采样密度**（2026-10-19 补，真缺口）：
// 同一时间戳写 3 遍 → 369 次 / 应 346 次 = 107% → 判"密度达标"，
// 而实际只有 123 个真实时刻（每 85 分钟一次，仅 36%）。
// 按 ts 去重，重复行只算一次；重复的条数单独报出来。
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
const raw=deduped;
const legacy=raw.filter(s=>s.proc_start===undefined||s.pid===undefined);
const all=raw.filter(s=>s.proc_start!==undefined&&s.pid!==undefined);
if(!all.length){
  console.log("还没有可用于判据的样本（无 pid 的历史样本 "+legacy.length+" 条已忽略）");
  process.exit(1);
}

// **只跟同一个 daemon 生命周期比较**（见 sample 里的注释：跨重启会算出负数增长）
const cur=all[all.length-1];
const sameLifetime=all.filter(s=>s.proc_start===cur.proc_start && s.pid===cur.pid);
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
const probeRate=expectProbes>0? probes.length/expectProbes : null;
const PROBE_RATE_LIMIT=0.7;
const probeDensityOk=!(days>=7 && (probeRate===null || probeRate<PROBE_RATE_LIMIT));
const spanDays=(last.ts-first.ts)/86400;   // 仅用于显示"首尾样本实际跨度"

// **连续性**（2026-10-19 补）：只看"首尾跨了 7 天"是不够的 ——
// 采样器如果在中间死了 3 天，首尾照样跨 7 天，报告会给出一个虚假的"连续 7 天"。
// 真实的 7×24 里，cron 每 30 分钟一个点，正常间隔 1800s；
// 窗口内若出现远超此值的空档，说明那段没在观测，必须扣掉。
const sorted=all.slice().sort((a,b)=>a.ts-b.ts);
const GAP_LIMIT=5400;                  // 90 分钟：容忍 cron 抖动/一次漏跑
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
const sampleRate=expectSamples>0? all.length/expectSamples : null;
// 判据：实际密度 ≥ 设计值的 70%。留 30% 余量给 cron 抖动、
// 单次脚本失败、机器短暂繁忙 —— 但不可能容忍一半样本缺失。
const SAMPLE_RATE_LIMIT=0.7;
// **"连续"不能只靠加起来够 7 天**（2026-10-19 修，措辞在撒谎）：
// 原来只把断档扣掉，于是"8 天跨度里有 24 小时没观测"仍会打印
// "✅ 已满 7 天且**观测连续**" —— 累计是够 7 天了，但"连续"这个词是假的：
// 那 24 小时里发生了什么我们完全不知道，也无法排除人工干预。
// S6 的字面判据是"连续 7 天"，所以只要出现一处超过容忍值的断档，
// 就不能声称连续 —— 必须重来。短抖动（cron 漏跑一次，<90 分钟）仍可容忍。
const hasGap = deadTotal > 0;
const maxGapHours = maxGap/3600;

// **"现在还在采样吗"**（2026-10-19 修，真缺陷）：
// 上面的 coveredDays 只量"样本首尾之间的跨度扣断档"，完全不看**末尾之后**。
// 于是采样器跑满 7 天后彻底死掉，隔 23 天再来看，报告照样打印
// "✅ 已满 7 天且观测连续"、exit 0 —— 而此刻根本没有任何东西在观测。
// 这正是"报告在撒谎"里最危险的一种：数据本身都是真的，结论却已经过期。
// 判据：最后一个样本距现在不得超过 3 个采样周期（cron 30 分钟 → 90 分钟），
// 超过就说明观测早已停止，无论历史跨度多长都不能算通过。
const STALE_LIMIT=5400;
const staleness=nowSec-last.ts;
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
const rss0=med(headS.map(s=>s.rss_kb))/1024, rssN=med(tailS.map(s=>s.rss_kb))/1024;
const growth=rssN-rss0;
const fd0=med(headS.map(s=>s.fd)), fdN=med(tailS.map(s=>s.fd));
const fdGrowth=fdN-fd0;
const thGrowth=med(tailS.map(s=>s.threads))-med(headS.map(s=>s.threads));
const maxRss=Math.max(...S.map(s=>s.rss_kb))/1024;
const maxFd=Math.max(...S.map(s=>s.fd));
const passRate=probes.length? probes.filter(p=>p.ok).length/probes.length : null;

// **容器可用性**（2026-10-19 补）：`container_up` 一直在采，却从来没被任何判据用过 ——
// 也就是说容器可以停一整天，而 S6 照样"通过"。probe 每 6 小时才跑一次，
// 中间最多 6 小时是盲区，靠 probe 兜不住，必须用每个 sample 点的 container_up 判断。
// 判据取"容器在线的采样点占比"，容忍 <5% 的短暂抖动（重建/重启几秒属正常）。
const contRate=all.length? all.filter(s=>Number(s.container_up)===1).length/all.length : null;
const contDown=all.filter(s=>Number(s.container_up)!==1);

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
//
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
// watchdog 的"已恢复"、boot 的"daemon 就绪"都算自动恢复。
const healed=wdLines.filter(w=>w.text.includes("已恢复")||w.text.includes("daemon 就绪"));
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
for(const L of LIFE){
  // **必须用 all，不能用 S**（2026-10-19 修，真缺陷）：
  // S 是"当前生命周期"的子集，拿它按 L.key 过滤，除当前这一段外**全部为空** ——
  // 于是 96 次重启的合成数据只算出 1 段，中位数实际只取了一个样本。
  // 判据碰巧还抓到了这个例子（因为那 1 段正好在爬），但换成
  // "只有早期几段在爬、当前段平稳"就会漏掉，等于判据又变成看运气。
  const seg=all.filter(s=>String(s.proc_start)+":"+String(s.pid)===L.key);
  if(seg.length<4) continue;                     // 太短算不准
  const n2=Math.max(1,Math.round(seg.length*0.1));
  const r0=med(seg.slice(0,n2).map(s=>s.rss_kb))/1024;
  const r1=med(seg.slice(seg.length-n2).map(s=>s.rss_kb))/1024;
  const f0=med(seg.slice(0,n2).map(s=>s.fd));
  const f1=med(seg.slice(seg.length-n2).map(s=>s.fd));
  const h=(seg[seg.length-1].ts-seg[0].ts)/3600;
  if(h>=0.5){ segRates.push((r1-r0)/h); segFdRates.push((f1-f0)/h); }
}
const medSegRate=segRates.length? med(segRates) : null;
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

// **两条判据都拦不住"慢慢漏、末尾重启一次"**（2026-10-19 补，真缺口）：
//   · "当前生命周期首末差"：末尾重启后末段是新进程，差值只有 +1.8MB
//   · "每段爬升速率中位"：1.15MB/h 恰好低于 2MB/h 阈值
// 合成数据实测：daemon 从 200MB 爬到 400MB（**漏 200MB**），最后 2 小时重启一次
// → 报告全绿、exit 0。
// 根子在于"2MB/h × 168h = 336MB"与判据"增幅 <50MB"自相矛盾 ——
// 速率阈值放得太宽，把总量漏掉了。
// 补一条直读判据原文的量：**全窗口峰值增长** = 全窗口最高点 − 窗口开始时的基线。
// 不管中间重启几次，内存最高到过多少是真实的。
// 基线取"最前 10% 样本的中位数"而不是单点，避开启动瞬间的抖动与预热。
const peakRss=Math.max(...all.map(s=>s.rss_kb))/1024;
// 基线要贴近**窗口开始**，不能取"前 10%"（7 天里那是 0.8 天）。
// 用前 10% 的中位数会在持续增长时把基线抬高，判据实际要漏到 ~52.6MB 才报，
// 与判据原文的 50MB 不符（实测 +49/50/51 都通过、+60 才失败）。
// 改为取"最前 2 小时内"的样本中位（30 分钟一次即 4 个），仍能抗噪，
// 但偏差只有 2h/168h ≈ 1.2%，不会被增长拉高。
const BASE_WINDOW_SEC=7200;
const baseSet=all.filter(s=>s.ts<=all[0].ts+BASE_WINDOW_SEC);
const baseN=Math.max(1,Math.min(baseSet.length, all.length));
const baseRss=med(all.slice(0,baseN).map(s=>s.rss_kb))/1024;
const peakGrowth=peakRss-baseRss;
const PEAK_GROWTH_LIMIT=50;      // 就是判据原文的 50MB

console.log("== S6 长期运行现状 ==");
if(badLines>0) console.log(`⚠ 文件里有 ${badLines} 行残缺 JSON（写入被打断），已跳过，其余样本正常计入`);
if(dupSamples>0) console.log(`⚠ 文件里有 ${dupSamples} 行重复样本（同一时刻同一进程），已按 ts 去重，不计入密度`);
console.log(`采样点 ${all.length} 个，已观测 ${hours.toFixed(2)} 小时（${days.toFixed(2)} 天 / 需 7 天；首尾样本跨 ${spanDays.toFixed(2)} 天）`);
console.log(`观测连续性：最长空档 ${(maxGap/3600).toFixed(2)}h，扣除断档后有效覆盖 ${coveredDays.toFixed(2)} 天`);
if(days>=7) console.log(`探针密度：${probes.length} 次 / 应 ${Math.round(expectProbes)} 次 = ${probeRate===null?"0":(probeRate*100).toFixed(0)}%（设计 ${PROBE_PER_DAY} 次/天，判据 ≥${(PROBE_RATE_LIMIT*100).toFixed(0)}%）`);
if(sampleRate!==null) console.log(`采样密度：${all.length} 次 / 应 ${Math.round(expectSamples)} 次 = ${(sampleRate*100).toFixed(0)}%（设计 ${SAMPLE_PER_HOUR} 次/h，判据 ≥${(SAMPLE_RATE_LIMIT*100).toFixed(0)}%）`);
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
console.log(`句柄: 首段中位 ${fd0} → 末段中位 ${fdN}（增长 ${fdGrowth>=0?"+":""}${fdGrowth}），单点峰值 ${maxFd}`);
console.log(`全窗口 RSS：基线 ${baseRss.toFixed(1)}MB（最前 ${baseN} 个样本中位）→ 最高 ${peakRss.toFixed(1)}MB，`+
            `峰值增长 ${peakGrowth>=0?"+":""}${peakGrowth.toFixed(1)}MB（判据 < +${PEAK_GROWTH_LIMIT}MB，与重启无关）`);
if(segRates.length) console.log(`各生命周期内 RSS 爬升速率：中位 ${medSegRate===null?"n/a":medSegRate.toFixed(2)+"MB/h"}，最大 ${maxSegRate.toFixed(2)}MB/h（${segRates.length} 段够长可算；最大值仅参考，新生进程预热会偏高）`);
if(segFdRates.length) console.log(`各生命周期内句柄爬升速率：中位 ${medSegFdRate===null?"n/a":medSegFdRate.toFixed(3)+"个/h"}，最大 ${maxSegFdRate.toFixed(3)}个/h`);
// 线程数不参与 S6 判定（S6 的四条判据是：连续 7 天无人工干预 / RSS 增幅 / 成功率 / 句柄）。
// 但原来这行只打印一个"+15"却不给结论，读起来像"检查过了、没问题"——
// 实测线程从 11 涨到 31 时它照打不误、exit 仍为 0。明确标成参照值，不制造错觉。
console.log(`线程: 首段中位 → 末段中位（增长 ${thGrowth>=0?"+":""}${thGrowth}，**仅供参考，不参与 S6 判定**）`);
console.log(`（首/末段各取 ${tailN} 个样本的中位数，避免单点噪声误判）`);
console.log(`探针 ${probes.length} 次，成功率 ${passRate===null?"n/a":(passRate*100).toFixed(0)+"%"}`);
console.log(`容器在线率 ${contRate===null?"n/a":(contRate*100).toFixed(1)+"%"}` +
            (contDown.length? `（${contDown.length} 个采样点容器不在线）` : ""));

const c=[];
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
if(unattended.length){
  c.push(`❌ 有 ${unattended.length} 次重启**找不到自愈记录**（${unattended.map(r=>new Date(r.born*1000).toISOString().slice(11,19)).join(", ")}）`+
         ` —— "无人工干预"不成立`);
} else if(restartRows.length){
  c.push(`✅ 期间重启 ${restartRows.length} 次，**全部是 watchdog 自愈**（无人干预，符合判据）`);
}
if(days>=7){
  c.push(probeDensityOk
    ? `✅ 探针密度 ≥${(PROBE_RATE_LIMIT*100).toFixed(0)}%（${probes.length} 次 / 应 ${Math.round(expectProbes)} 次）`
    : `❌ **探针密度只有 ${probeRate===null?"0":(probeRate*100).toFixed(0)}%**（${probes.length} 次 / 应 ${Math.round(expectProbes)} 次）：`+
      `"成功率不掉"需要真的测过，不能靠"一次都没测"来满足`);
}
if(passRate!==null){
  if(passRate>=0.95) c.push("✅ 成功率 ≥95%");
  else {
    // 失败要能归因：答错 vs 飞书没发出去
    const bad=probes.filter(p=>!p.ok);
    const noOut=bad.filter(p=>p.out!==undefined && String(p.out)!=="1").length;
    const noWs=bad.filter(p=>p.ws!==undefined && String(p.ws)!=="1").length;
    const other=bad.length-noOut-noWs;
    c.push(`❌ 成功率 ${(passRate*100).toFixed(0)}%（${bad.length} 次失败：`+
           `${noOut} 次飞书未送达 / ${noWs} 次飞书入站长连接不在 / ${other} 次未答对或未完成）`);
  }
}
if(contRate!==null) c.push(contRate>=0.95? "✅ 容器在线率 ≥95%" : `❌ 容器在线率 ${(contRate*100).toFixed(1)}%（容器长时间不在线）`);
c.push(peakGrowth<PEAK_GROWTH_LIMIT
  ? `✅ 全窗口 RSS 峰值增长 ${peakGrowth.toFixed(1)}MB < ${PEAK_GROWTH_LIMIT}MB`
  : `❌ **全窗口 RSS 峰值增长 ${peakGrowth.toFixed(1)}MB ≥${PEAK_GROWTH_LIMIT}MB**：`+
    `基线 ${baseRss.toFixed(1)}MB → 最高 ${peakRss.toFixed(1)}MB（与期间重启几次无关）`);
if(medSegRate!==null){
  c.push(medSegRate<SEG_RATE_LIMIT
    ? `✅ 各生命周期内 RSS 无明显爬升（中位 ${medSegRate.toFixed(2)}MB/h）`
    : `❌ **每个生命周期内 RSS 都在爬升**（中位 ${medSegRate.toFixed(2)}MB/h ≥${SEG_RATE_LIMIT}）：`+
      `重启只是把泄漏截断，不是没漏`);
}
if(sampleRate!==null){
  c.push(sampleRate>=SAMPLE_RATE_LIMIT
    ? `✅ 采样密度 ≥${(SAMPLE_RATE_LIMIT*100).toFixed(0)}%（${(sampleRate*100).toFixed(0)}%）`
    : `❌ **采样密度只有 ${(sampleRate*100).toFixed(0)}%**（${all.length} 次 / 应 ${Math.round(expectSamples)} 次）：`+
      `空档虽都在容忍内，但大部分时间没在观测`);
}
if(medSegFdRate!==null){
  c.push(medSegFdRate<SEG_FD_RATE_LIMIT
    ? `✅ 各生命周期内句柄无明显爬升（中位 ${medSegFdRate.toFixed(2)}个/h）`
    : `❌ **每个生命周期内句柄都在爬升**（中位 ${medSegFdRate.toFixed(2)}个/h ≥${SEG_FD_RATE_LIMIT}）：`+
      `重启只是把泄漏截断，不是没漏`);
}
console.log("\n判定：" + c.join("；"));
// **成功率必须参与退出码**（2026-10-19 修，真缺陷）：
// 原来这一行只算了 days/coveredDays/growth/fdGrowth/unattended/contRate，
// 唯独漏了 passRate —— 于是"判定"那行明明打印 `❌ 成功率 50%`，
// 退出码却还是 0，脚本层面会当成通过。合成数据实测：28 次探针全后半失败、
// 总成功率 50%，exit 仍是 0。这等于 S6 最容易退化的那条判据没有约束力。
// 语义取"不掉"：有探针时必须 ≥95%；没探针（探针还没跑过）不据此判失败。
const passOk = (passRate===null || passRate>=0.95) && probeDensityOk;
process.exit(!stale && !hasGap && days>=7 && coveredDays>=7 && growth<50 && fdGrowth<=2
  && unattended.length===0 && (contRate===null||contRate>=0.95)
  && passOk && (medSegRate===null||medSegRate<SEG_RATE_LIMIT)
  && (medSegFdRate===null||medSegFdRate<SEG_FD_RATE_LIMIT)
  && (sampleRate===null||sampleRate>=SAMPLE_RATE_LIMIT)
  && peakGrowth<PEAK_GROWTH_LIMIT && !hasFuture ? 0 : 1);'
}
case "${1:-sample}" in
  sample) do_sample ;;
  probe)  do_probe ;;
  report) do_report ;;
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