#!/usr/bin/env bash
# scripts/lib/model-switch.sh —— 「换 primary 模型」要改**daemon 真读的那份**，并验它生效。
#
# 为什么需要（2026-10-26，同类缺陷第九例）：
#
# `ab-models.sh` / `ab-rounds.sh` / `ab-switch.sh` / `selftest-model-down.sh` 都是
# `cd "$HOME/dotd"` 然后改 **`config/models.yml`**。而托管部署里 daemon 读的是
# **`~/.dotd/models.yml`**（`DOTD_CONFIG_DIR`，见 docs §18.13）。
#
# 它之所以"看起来能工作"，全靠 `wsl-daemon.sh` §3.5 在每次启动时
# `cp -f config/*.yml "$HOME/.dotd/"` —— 也就是说这条链是**间接**的：
#
#   改仓库副本 → 用 wsl-daemon.sh 重启 → 拷贝 → daemon 才看到
#
# 三点后果：
#   1. 换模型后若用别的方式重启（one_system / charlie:start），改动**完全没生效**，
#      脚本却照样跑完、照样打印"步数=…"——两次 A/B 测的是同一个模型，
#      结论是"两个模型差不多"。这是最坏的一种：数据看着像真的。
#   2. 中途失败（Ctrl-C / 断言退出 / daemon 起不来）时文件留在被改状态，
#      下一次实验的基线是错的，而日志里没有任何记号。
#   3. 谁把 /root/dotd 换成 /mnt/d/dotd（git 工作区），一次实验就把模型名提交了。
#
# 本库做三件事，缺一不可：
#   · 同时改**种子**（仓库副本，下次启动不会被抹掉）与**运行期**（daemon 立刻读的那份）；
#   · 改完**回头读运行期文件**验一遍，没生效就大声失败（而不是继续测）；
#   · `trap` 在退出时恢复两处，即使被 Ctrl-C 也恢复。
#
# 用法：
#   . scripts/lib/model-switch.sh
#   models_begin                    # 备份两处并挂 trap
#   models_set_primary deepseek-v4.1-flash
#   models_set_base_url http://127.0.0.1:59999/v1
#   models_verify_primary deepseek-v4.1-flash || exit 1
#   ... 跑实验 ...
#   models_restore                  # 也可不调用，EXIT trap 会兜底

_MODELS_SEED=""
_MODELS_RUNTIME=""
_MODELS_BAK_SEED=""
_MODELS_BAK_RUNTIME=""
_MODELS_TRAP_ARMED=0

# 种子 = 本脚本所在的仓库副本；运行期 = daemon 真读的那份（判据与
# scripts/lib/env.mjs::resolveConfigDir 一致：DOTD_CONFIG_DIR → DOTD_CONFIG 目录 →
# <home>/.dotd 有 models.yml → 仓库 config）。
models_resolve() {
  local repo_root
  repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  _MODELS_SEED="$repo_root/config/models.yml"

  if [ -n "${DOTD_CONFIG_DIR:-}" ]; then
    _MODELS_RUNTIME="$DOTD_CONFIG_DIR/models.yml"
  elif [ -n "${DOTD_CONFIG:-}" ]; then
    _MODELS_RUNTIME="$(dirname "$DOTD_CONFIG")/models.yml"
  else
    local home_dir="${DOTD_HOME:-$HOME/.dotd}"
    if [ -f "$home_dir/models.yml" ]; then
      _MODELS_RUNTIME="$home_dir/models.yml"
    else
      _MODELS_RUNTIME="$_MODELS_SEED"
    fi
  fi
}

models_begin() {
  models_resolve
  if [ ! -f "$_MODELS_RUNTIME" ]; then
    echo "[models] ✗ 运行期配置不存在：$_MODELS_RUNTIME" >&2
    echo "[models]   daemon 读的就是这份；先跑一次一键启动（或 init-config）再来。" >&2
    return 1
  fi
  _MODELS_BAK_SEED="$(mktemp /tmp/models.seed.XXXXXX)"
  cp "$_MODELS_SEED" "$_MODELS_BAK_SEED"
  if [ "$_MODELS_RUNTIME" != "$_MODELS_SEED" ]; then
    _MODELS_BAK_RUNTIME="$(mktemp /tmp/models.runtime.XXXXXX)"
    cp "$_MODELS_RUNTIME" "$_MODELS_BAK_RUNTIME"
  fi
  _MODELS_TRAP_ARMED=1
  trap models_restore EXIT INT TERM
  echo "[models] 种子=$_MODELS_SEED"
  echo "[models] 运行期=$_MODELS_RUNTIME（daemon 实际读这份）"
}

models_restore() {
  [ "$_MODELS_TRAP_ARMED" = "1" ] || return 0
  _MODELS_TRAP_ARMED=0
  [ -n "$_MODELS_BAK_SEED" ] && [ -f "$_MODELS_BAK_SEED" ] && cp "$_MODELS_BAK_SEED" "$_MODELS_SEED"
  [ -n "$_MODELS_BAK_RUNTIME" ] && [ -f "$_MODELS_BAK_RUNTIME" ] && cp "$_MODELS_BAK_RUNTIME" "$_MODELS_RUNTIME"
  rm -f "$_MODELS_BAK_SEED" "$_MODELS_BAK_RUNTIME"
  echo "[models] 已恢复：$_MODELS_SEED${_MODELS_BAK_RUNTIME:+ 与 $_MODELS_RUNTIME}"
}

# 把 primary 换成 $1（只改第一个 primary 行，与原来的 sed 同语义）。
models_set_primary() {
  local model="$1" f
  models_resolve
  for f in "$_MODELS_SEED" "$_MODELS_RUNTIME"; do
    [ -f "$f" ] || continue
    sed -i "s/^\(\s*\)primary: .*/\1primary: $model/" "$f"
  done
}

# 把第一个 base_url 换成 $1（用于"制造全挂"这类实验）。
models_set_base_url() {
  local url="$1" f
  models_resolve
  for f in "$_MODELS_SEED" "$_MODELS_RUNTIME"; do
    [ -f "$f" ] || continue
    sed -i "0,/^\(\s*\)base_url: .*/s//\1base_url: $url/" "$f"
  done
}

# 验**运行期**那份里 primary 真是 $1。不一致 → 非零返回（调用方应当中止）。
#
# 这一步是重点：之前所有脚本都"改完就假定生效"。读回来才算数。
models_verify_primary() {
  local want="$1" got
  models_resolve
  got="$(sed -n 's/^[[:space:]]*primary: \(.*\)$/\1/p' "$_MODELS_RUNTIME" | head -1)"
  if [ "$got" != "$want" ]; then
    echo "[models] ✗ 换模型没有生效：运行期 $_MODELS_RUNTIME 里 primary=$got（期望 $want）" >&2
    echo "[models]   常见原因：改的是仓库副本，而 daemon 读的是 ~/.dotd（见本文件头部注释）。" >&2
    return 1
  fi
  echo "[models] ✓ 运行期 primary=$got（已验证）"
}

# 同上，验第一个 base_url。用于"把端点指到死端口制造全挂"这类实验：
# 如果那条 sed 没落到运行期，实验就变成"什么都没改，然后测出一切正常"。
models_verify_base_url() {
  local want="$1" got
  models_resolve
  got="$(sed -n 's/^[[:space:]]*base_url: \(.*\)$/\1/p' "$_MODELS_RUNTIME" | head -1)"
  if [ "$got" != "$want" ]; then
    echo "[models] ✗ 端点地址没有生效：运行期 $_MODELS_RUNTIME 里 base_url=$got（期望 $want）" >&2
    echo "[models]   这条实验要验的是「端点挂掉时 daemon 怎么反应」；没改到运行期就等于什么都没验。" >&2
    return 1
  fi
  echo "[models] ✓ 运行期 base_url=$got（已验证）"
}
