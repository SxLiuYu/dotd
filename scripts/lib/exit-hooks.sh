#!/usr/bin/env bash
# scripts/lib/exit-hooks.sh —— 多个库都要"退出时复原"，但 bash 的 EXIT trap 只有一个。
#
# 为什么需要（2026-10-26）：
#
# `model-switch.sh` 用 `trap models_restore EXIT INT TERM` 复原被改写的配置；
# `daemon-restart.sh` 也要在退出时把实验改过的运行期旋钮（`DOTD_MAX_RUNNING` 等）
# 重启回原值。两个库都直接 `trap … EXIT` 的话，**后 source 的那个会静默顶掉前者** ——
# 于是模型配置留在被改状态，或者额度留在 1，而脚本一切照常退出、什么都不说。
#
# 这正是那条主线：一份信息只能有一处权威。这里把"退出时做什么"收成一张钩子表，
# 谁都能往里加，谁都不会顶掉别人。
#
# 用法：
#   . scripts/lib/exit-hooks.sh
#   dotd_on_exit models_restore
#   dotd_on_exit daemon_restore_knobs
#
# 语义：
#   · EXIT 时按**注册顺序**执行；INT/TERM 时执行完再以 130/143 退出。
#   · 某个钩子失败不阻断后面的（复原动作要尽量都跑到）。
#   · 同一函数重复注册只跑一次（幂等）。

if [ "${_DOTD_EXIT_HOOKS_READY:-0}" != "1" ]; then
  _DOTD_EXIT_HOOKS_READY=1
  _DOTD_EXIT_HOOKS=()

  dotd_on_exit() {  # $1=函数名
    local h
    for h in ${_DOTD_EXIT_HOOKS[@]+"${_DOTD_EXIT_HOOKS[@]}"}; do
      [ "$h" = "$1" ] && return 0
    done
    _DOTD_EXIT_HOOKS+=("$1")
    trap '_dotd_run_exit_hooks' EXIT
    trap '_dotd_on_signal 130' INT
    trap '_dotd_on_signal 143' TERM
  }

  _dotd_run_exit_hooks() {
    local h
    # 先清空再执行：钩子里若又触发退出，不会重入。
    local hooks=(${_DOTD_EXIT_HOOKS[@]+"${_DOTD_EXIT_HOOKS[@]}"})
    _DOTD_EXIT_HOOKS=()
    for h in ${hooks[@]+"${hooks[@]}"}; do
      command -v "$h" >/dev/null 2>&1 && { "$h" || true; }
    done
    trap - EXIT INT TERM
  }

  _dotd_on_signal() {
    _dotd_run_exit_hooks
    exit "${1:-1}"
  }
fi
