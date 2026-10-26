#!/usr/bin/env bash
# scripts/lib/daemon-restart.sh —— 「重启 daemon」必须是**真的重启**，且新进程拿到了你要的环境。
#
# 为什么需要（2026-10-26，同类缺陷第十一例）：
#
# 自 2026-10-25 起 dotd 由 `voice/integration/one_system.py` 托管，启动路径变成
#
#     人的 shell → bash scripts/wsl-daemon.sh → python -m voice.integration.one_system
#                                              └→ node src/daemon.ts（子进程，崩溃自动重启）
#
# 而仓库里十来个实验脚本还停在「单进程」时代，写的都是：
#
#     pkill -9 -f 'src/daemon.ts'
#     sleep 3
#     DOTD_MAX_RUNNING=2 nohup setsid bash scripts/wsl-daemon.sh >/dev/null 2>&1 &
#
# 三个后果，一个比一个隐蔽：
#
#   ① 杀的是**子进程**，supervisor 两秒后按退避把它重启 —— 新子进程继承的是
#      **supervisor 的环境**，不是你这行 `DOTD_MAX_RUNNING=2`。所以「以并发 2 重启」
#      是假的：真正的额度仍是启动 supervisor 时那个 3。脚本接下来照样跑、照样打印
#      「观察到最大并发 running = N」，只是 N 跟你要的 2 没有关系（而且没有断言）。
#   ② `wsl-daemon.sh` 里的 flock 单实例闸门（2026-10-26 加）看到锁还被持着，直接
#      `已有实例持锁 → exit 0`。也就是说第三行**一次都没启动过任何东西**，
#      而它是以 `&` 起的、输出进 /dev/null —— 失败不可见。实测：
#         $ DOTD_MAX_RUNNING=2 bash scripts/wsl-daemon.sh
#         [wsl-daemon] 已有实例持锁（/tmp/dotd-one-system.lock），本次不启动
#         $ echo $?
#         0
#   ③ `pkill -f 'src/daemon.ts'` 这个模式会匹配到**执行脚本的 shell 自己**
#      （命令行里带这串字），本项目已经因此杀掉过一次工具 shell。
#
# 所以判据写在这里：要重启，就重启**持有子进程的那个 supervisor**；要环境变量生效，
# 就把变量交给**新 supervisor**，然后回头去 `/proc/<新 pid>/environ` 读一遍，
# 读不到就大声失败 —— 不许"起了就算"。
#
# 用法：
#   . scripts/lib/daemon-restart.sh
#   daemon_restart                        # 重启，不带额外环境
#   daemon_restart DOTD_MAX_RUNNING=2     # 重启 + 验运行期确实是 2
#   daemon_restart DOTD_NET_TOOLS=all DOTD_MAX_RUNNING=1
#
# 环境变量：
#   DAEMON_RESTART_PORT     起来后探这个端口（默认 7788；0 = 不探）
#   DAEMON_RESTART_TIMEOUT  等就绪的秒数（默认 90）
#   DAEMON_RESTART_DRY_RUN  =1 只打印将要做的事、不杀不起（测试用）
#   DAEMON_RESTART_LOCK     单实例锁路径（默认 /tmp/dotd-one-system.lock，与 wsl-daemon.sh 一致）
#   DAEMON_RESTART_RESTORE  退出时把实验改过的旋钮还原（默认 1；测试里设 0）
#   DAEMON_RESTART_START    启动命令（默认 nohup setsid bash scripts/wsl-daemon.sh；
#                           Git Bash 上没有 setsid 时自动退化成 nohup bash scripts/wsl-daemon.sh）
#   DAEMON_RESTART_PROBE_CMD  就绪探针（默认探 DAEMON_RESTART_PORT 的 TCP；设了就用 sh -c 跑它）
#   DOTD_PROC_ROOT          进程表根（默认 /proc；测试注入假目录）
#
# 为什么要有 DAEMON_RESTART_RESTORE（2026-10-26，同一条线的第十二例）：
# 这些实验脚本都以 `daemon_restart DOTD_MAX_RUNNING=1` 这类方式改**运行期**旋钮，
# 跑完却谁也不改回来。实测：live daemon 本来是 3，跑一次 verify-vision-final.sh
# 之后它就永久变成 1（串行），而脚本最后一行是"✅ 全部通过"——
# 主人只看到"验证通过了"，看不到"你的系统从此串行执行"。
# 与 model-switch 的 EXIT trap 同一条判据：**实验改动必须自己收尾**。

. "$(dirname "${BASH_SOURCE[0]}")/exit-hooks.sh"

DAEMON_RESTART_PORT="${DAEMON_RESTART_PORT:-7788}"
DAEMON_RESTART_TIMEOUT="${DAEMON_RESTART_TIMEOUT:-90}"
DAEMON_RESTART_DRY_RUN="${DAEMON_RESTART_DRY_RUN:-0}"
DAEMON_RESTART_LOCK="${DAEMON_RESTART_LOCK:-/tmp/dotd-one-system.lock}"
DAEMON_RESTART_LOCK_WAIT="${DAEMON_RESTART_LOCK_WAIT:-30}"
DAEMON_RESTART_RESTORE="${DAEMON_RESTART_RESTORE:-1}"
# setsid 只在 Linux 上有（Git Bash 没有），缺了就别写进命令行 —— 否则整行直接
# command not found，而它又是 `&` + 重定向，失败完全看不见（正是本库要消灭的形状）。
if [ -z "${DAEMON_RESTART_START+x}" ]; then
  if command -v setsid >/dev/null 2>&1; then
    DAEMON_RESTART_START="nohup setsid bash scripts/wsl-daemon.sh"
  else
    DAEMON_RESTART_START="nohup bash scripts/wsl-daemon.sh"
  fi
fi
DAEMON_RESTART_PROBE_CMD="${DAEMON_RESTART_PROBE_CMD:-}"

daemon_proc_root() { printf '%s' "${DOTD_PROC_ROOT:-/proc}"; }

# 一个进程的 argv，一行一个参数（/proc/<pid>/cmdline 是 NUL 分隔）。
#
# `2>/dev/null` 必须写在 `<` **前面**：重定向按从左到右生效，`< missing 2>/dev/null`
# 会在 2 还没被重定向时就把 "No such file" 打到 stderr 上。进程在扫描途中退出
# （很常见：supervisor 重启子进程那两秒）就会刷一屏假错误。
_dr_args() {
  tr '\0' '\n' 2>/dev/null < "$(daemon_proc_root)/$1/cmdline" || true
}

# 与 scripts/lib/live-daemon.mjs 的 DAEMON_ARG **逐字同判据**：
# 有一个参数以 `src/daemon.ts`（正/反斜杠）或 `dist/daemon.js` 结尾。
# 两种形态都要认：one_system.dotd_command() 在有构建产物时优先起 dist/daemon.js，
# 只认 src 的话重启会「看不见 daemon」→ 起了第二个实例。
# 刻意不用 `pkill -f 'src/daemon.ts'`：那会匹配到本脚本的调用者 shell 自己。
_dr_arg_is_daemon() {
  [[ "$1" =~ (^|[\\/])(src[\\/]daemon\.ts|dist[\\/]daemon\.js)$ ]]
}

# supervisor 的识别：参数里有一个恰好是 `voice.integration.one_system`
# （`python -m voice.integration.one_system --port 8000` 的第二个参数）。
_dr_arg_is_supervisor() {
  [ "$1" = "voice.integration.one_system" ]
}

# 打印所有 pid（升序），$2 是判定函数名。
#
# 刻意**不**检查进程是否还活着：Linux 的 /proc 里只有活进程，死条目不存在。
# 加了 kill -0 反而会让"假 proc 根"的测试（目录里只有 cmdline 文件）全部扫不到 ——
# 那就是又一个"检查器找错地方"。要判断新旧，比 pid 是否变化即可。
_dr_scan() {
  local judge="$1" d pid a
  {
    for d in "$(daemon_proc_root)"/*; do
      pid="${d##*/}"
      [[ "$pid" =~ ^[0-9]+$ ]] || continue
      [ "$pid" = "$$" ] && continue
      [ "$pid" = "${BASHPID:-$$}" ] && continue
      while IFS= read -r a; do
        if "$judge" "$a"; then printf '%s\n' "$pid"; break; fi
      done < <(_dr_args "$pid")
    done
  } | sort -n
}

daemon_pids() { _dr_scan _dr_arg_is_daemon; }
daemon_supervisor_pids() { _dr_scan _dr_arg_is_supervisor; }

# 读一个进程的某个环境变量（没有 → 空串，且返回 1，便于 `if` 判断）。
daemon_env_get() {
  local pid="$1" key="$2" kv
  while IFS= read -r kv; do
    if [ "${kv%%=*}" = "$key" ]; then printf '%s' "${kv#*=}"; return 0; fi
  done < <(tr '\0' '\n' 2>/dev/null < "$(daemon_proc_root)/$pid/environ" || true)
  return 1
}

_dr_port_ok() {
  if [ -n "$DAEMON_RESTART_PROBE_CMD" ]; then
    sh -c "$DAEMON_RESTART_PROBE_CMD" 2>/dev/null
    return $?
  fi
  [ "$DAEMON_RESTART_PORT" = "0" ] && return 0
  timeout 3 bash -c "exec 3<>/dev/tcp/127.0.0.1/$DAEMON_RESTART_PORT" 2>/dev/null
}

# 等 flock 真的空出来（supervisor 退出后锁才释放）。
#
# 锁是否空闲单独成函数：没有 flock 的宿主（Git Bash）直接视为空闲；测试也可以整体
# 替换它来模拟"锁还被持着"，不必真的去抢一把锁。
daemon_lock_free() {
  command -v flock >/dev/null 2>&1 || return 0
  ( flock -n 9 ) 9>"$DAEMON_RESTART_LOCK" 2>/dev/null
}

_dr_wait_lock_free() {
  local max="${1:-30}" i
  for ((i = 0; i < max; i++)); do
    daemon_lock_free && return 0
    sleep 1
  done
  return 1
}

# 发信号 / 判断存活单独成对，是为了让测试能整体替掉它们去驱动「假 proc 根」，
# 而不用把 pid 真的 kill 掉（假 pid 可能撞上宿主机上的真进程）。
daemon_kill() { kill -"$2" "$1" 2>/dev/null; }
daemon_alive() { kill -0 "$1" 2>/dev/null; }

_dr_kill_and_wait() {  # $1=pid $2=信号名 $3=最多等几秒
  local pid="$1" sig="$2" max="${3:-20}" i
  [ "$DAEMON_RESTART_DRY_RUN" = "1" ] && { echo "[restart] (dry-run) kill -$sig $pid"; return 0; }
  daemon_kill "$pid" "$sig" || return 0
  for ((i = 0; i < max; i++)); do
    daemon_alive "$pid" || return 0
    sleep 1
  done
  echo "[restart] pid $pid 在 ${max}s 内没退，SIGKILL" >&2
  daemon_kill "$pid" KILL || true
  sleep 1
  return 0
}

# 读回验证：$1=pid，其余是 KEY=VAL。全部一致才返回 0。
#
# 单独成一个函数是为了能被测试直接调用（不用真重启就能验"读回"这条路）。
daemon_verify_env() {
  local pid="$1" kv key want got bad=0
  shift
  for kv in "$@"; do
    key="${kv%%=*}"
    want="${kv#*=}"
    got="$(daemon_env_get "$pid" "$key" || true)"
    if [ "$got" != "$want" ]; then
      echo "[restart] ✗ $key 没生效：运行期=$got（期望 $want）" >&2
      echo "[restart]   常见原因：只杀了 node 子进程，supervisor 用旧环境把它拉回来了。" >&2
      bad=1
    else
      echo "[restart] ✓ $key=$got（从 $(daemon_proc_root)/$pid/environ 读回）"
    fi
  done
  [ "$bad" -eq 0 ]
}

# 重启 daemon（并验证给定的 KEY=VAL 真的落到了运行中进程的环境里）。
#
# 返回非零 = 重启没发生 / 环境没生效 —— 调用方应当 abort，而不是接着跑实验。
daemon_restart() {
  local envs=("$@") repo_root old_daemon sup_pids p

  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  old_daemon="$(daemon_pids | head -1)"
  sup_pids="$(daemon_supervisor_pids | tr '\n' ' ')"

  echo "[restart] 当前 daemon pid=${old_daemon:-（无）} supervisor=${sup_pids:-（无 —— 不是托管模式）}"
  if [ "${#envs[@]}" -gt 0 ]; then
    echo "[restart] 需要生效的环境：${envs[*]}"
    _dr_remember_original "$old_daemon" "${envs[@]}"
  fi

  # ① 停：有 supervisor 就停 supervisor（它退出时会带走子进程），否则停 node 子进程。
  #    只杀子进程是最坏的做法：supervisor 会用**旧环境**把它拉回来，看起来"重启了"。
  if [ -n "${sup_pids// /}" ]; then
    for p in $sup_pids; do
      _dr_kill_and_wait "$p" TERM 25
    done
  elif [ -n "$old_daemon" ]; then
    _dr_kill_and_wait "$old_daemon" TERM 15
  fi

  # ② 等锁空出来：否则下面那行 wsl-daemon.sh 会打印「已有实例持锁」并 exit 0，
  #    一个进程都没起，而 `&` + /dev/null 让它彻底静默。
  if [ "$DAEMON_RESTART_DRY_RUN" != "1" ] && ! _dr_wait_lock_free "$DAEMON_RESTART_LOCK_WAIT"; then
    echo "[restart] ✗ 单实例锁 ${DAEMON_RESTART_LOCK_WAIT}s 内没释放（$DAEMON_RESTART_LOCK），拒绝在旧实例还活着时起新的" >&2
    return 1
  fi

  # ③ 起：环境变量交给**新 supervisor**（子进程继承它的 env），不是交给 pkill。
  if [ "$DAEMON_RESTART_DRY_RUN" = "1" ]; then
    echo "[restart] (dry-run) cd $repo_root && env ${envs[*]:-} $DAEMON_RESTART_START"
    return 0
  fi
  (
    cd "$repo_root" || exit 1
    if [ "${#envs[@]}" -gt 0 ]; then
      env "${envs[@]}" sh -c "$DAEMON_RESTART_START" >/dev/null 2>&1 < /dev/null &
    else
      sh -c "$DAEMON_RESTART_START" >/dev/null 2>&1 < /dev/null &
    fi
  )

  # ④ 等就绪：新 daemon 存在、pid 变了、端口通。
  local i new_pid=""
  for ((i = 0; i < DAEMON_RESTART_TIMEOUT; i++)); do
    sleep 1
    new_pid="$(daemon_pids | head -1)"
    if [ -n "$new_pid" ] && [ "$new_pid" != "$old_daemon" ] && _dr_port_ok; then break; fi
    new_pid=""
  done
  if [ -z "$new_pid" ]; then
    echo "[restart] ✗ ${DAEMON_RESTART_TIMEOUT}s 内没等到新的 daemon（旧 pid=${old_daemon:-无}）" >&2
    echo "[restart]   看 /tmp/dotd-wsl.log 末尾：" >&2
    tail -n 8 /tmp/dotd-wsl.log 2>/dev/null | sed 's/^/      /' >&2 || true
    return 1
  fi
  echo "[restart] ✓ 新 daemon pid=$new_pid（端口 $DAEMON_RESTART_PORT 已通）"

  # ⑤ 验：环境变量必须出现在**运行中进程**的 environ 里。
  #    这是本库存在的理由 —— 上面那些脚本全都"设了就算生效"，而 supervisor 继承的是
  #    启动它那一刻的环境。读回来才算数。
  if [ "${#envs[@]}" -gt 0 ]; then
    daemon_verify_env "$new_pid" "${envs[@]}" || return 1
  fi
  return 0
}

# ── 退出时还原实验改过的旋钮 ─────────────────────────────────────────────
#
# `_DR_KNOB_KEYS`     本轮被改过的键（按出现顺序去重）
# `_DR_KNOB_ORIG`     pid 未变时，从**旧进程**的 environ 读到的原值
#
# 为什么需要：这些脚本用 `daemon_restart DOTD_MAX_RUNNING=1` 改运行期旋钮，
# 跑完谁都不改回来。实测 live 上本来是 3，跑一次 verify-vision-final.sh 之后
# 就永久串行了，而脚本最后一行是"✅ 全部通过"—— 主人只看到通过，
# 看不到"你的系统从此一次只跑一个任务"（第十二例）。
_DR_KNOB_KEYS=""
_DR_KNOB_ORIG=""

_dr_remember_original() {  # $1=旧 daemon pid，其余是 KEY=VAL
  local pid="$1" kv key val got
  # RESTORE=0 = 本轮不记账。`daemon_restore_knobs` 自己那次重启就靠它。
  # 说明（实测，别凭直觉）：在 `daemon_restore_knobs` 里，即使没有这道闸门，
  # 记录也会被"先清空、失败再写回 saved"覆盖掉，所以**这一层看不出差别**；
  # 这道闸门防的是别的调用路径 —— 例如脚本中途手工调 `daemon_restore_knobs`
  # 失败之后继续 `daemon_restart`，那时"原值"会是没还原成功的那个值。
  [ "$DAEMON_RESTART_RESTORE" = "1" ] || return 0
  shift
  for kv in "$@"; do
    key="${kv%%=*}"
    val="${kv#*=}"
    case " $_DR_KNOB_KEYS " in *" $key "*) continue ;; esac
    _DR_KNOB_KEYS="$_DR_KNOB_KEYS $key"
    # 旧进程不存在（首次启动）→ 记成"原本没有"，还原时就是 unset。
    got=""
    if [ -n "$pid" ]; then got="$(daemon_env_get "$pid" "$key" || true)"; fi
    _DR_KNOB_ORIG="$_DR_KNOB_ORIG $key=$got"
  done
  # 注册一次即可；重复注册幂等（见 exit-hooks.sh）。
  dotd_on_exit daemon_restore_knobs
}

# 把本轮改过的键重启回原值并复核。由 EXIT 钩子调用，也可手工调。
daemon_restore_knobs() {
  [ "$DAEMON_RESTART_RESTORE" = "1" ] || return 0
  [ -n "${_DR_KNOB_KEYS// /}" ] || return 0
  local key got orig keys=() pairs=()
  for key in $_DR_KNOB_KEYS; do
    # 原值从 **_DR_KNOB_ORIG** 里取（KV 串，空格分隔；值为空时是 `KEY=`）
    orig=""
    for kv in $_DR_KNOB_ORIG; do
      [ "${kv%%=*}" = "$key" ] && { orig="${kv#*=}"; break; }
    done
    if [ -z "$orig" ]; then
      echo "[restart] 还原 $key（原本没有值 → 从新进程里去掉）"
      continue   # unset 在纯 shell 里做不到：只能说明，不能假装做到了
    fi
    pairs+=("$key=$orig")
    keys+=("$key")
  done
  [ "${#pairs[@]}" -gt 0 ] || { _DR_KNOB_KEYS=""; _DR_KNOB_ORIG=""; return 0; }

  echo "[restart] 退出前还原运行期旋钮：${pairs[*]}"
  # 清掉记录，避免这次重启又把"当前值"记成原值（否则还原会自我覆盖）。
  local saved_keys="$_DR_KNOB_KEYS" saved_orig="$_DR_KNOB_ORIG"
  _DR_KNOB_KEYS=""; _DR_KNOB_ORIG=""
  # 关掉还原，否则这次重启会把"还原目标"当成新的"原值"再记一遍。
  # 两种写法在这里**等价**（bash 的前缀赋值在整个动态作用域内都生效，实测过：
  # `f(){ h; }; V=0 f` 里 `h` 读到 0）。用前缀写法是为了短，且不留下
  # "忘了还回去"的可能 —— 这个库本身就在治"没有复原"的毛病。
  DAEMON_RESTART_RESTORE=0 daemon_restart "${pairs[@]}"
  local rc=$?
  _DR_KNOB_KEYS="$saved_keys"; _DR_KNOB_ORIG="$saved_orig"
  if [ "$rc" -ne 0 ]; then
    echo "[restart] ✗ 还原失败 —— 运行期仍是被实验改过的值，请手动重启 daemon" >&2
  else
    _DR_KNOB_KEYS=""; _DR_KNOB_ORIG=""
  fi
  return "$rc"
}
