#!/usr/bin/env bash
# scripts/lib/config-dir.sh —— 「daemon 到底读哪份配置」的**唯一**判据（bash 侧）。
#
# 为什么单独成库（2026-10-26）：
#
# 仓库里 copy 了 N 份「去哪找配置」的推断，最先出问题的是 scripts/lib/model-switch.sh
# （改了仓库副本、daemon 读的是 ~/.dotd，见它的头部）。同一类错误还在别处：
# `scripts/verify-goal.sh` 数 `config/tools.yml` 的白名单条数，而 daemon 读
# `<configDir>/tools.yml`。今天两边内容一样，所以"看起来对"—— 这正是同类缺陷的
# 潜伏形态：判据有两份，靠人工保证它们一致。
#
# 这里严格对齐 `src/surfaces/config.ts` 与 `scripts/lib/env.mjs::resolveConfigDir`：
#   1. `DOTD_CONFIG_DIR`
#   2. `dirname(DOTD_CONFIG)`
#   3. `<DOTD_HOME 或 ~/.dotd>`（其中有 models.yml 时）
#   4. 仓库 `config/`
#
# 用法：
#   . scripts/lib/config-dir.sh
#   dir="$(dotd_config_dir)"          # → 目录
#   f="$(dotd_config_file tools.yml)" # → 文件路径（不做存在性检查）

# 仓库根：按库文件位置推（不依赖 cwd，也不依赖谁 source 它）。
dotd_repo_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

dotd_config_dir() {
  if [ -n "${DOTD_CONFIG_DIR:-}" ]; then
    _dotd_expand_tilde "$DOTD_CONFIG_DIR"; return 0
  fi
  if [ -n "${DOTD_CONFIG:-}" ]; then
    dirname "$(_dotd_expand_tilde "$DOTD_CONFIG")"; return 0
  fi
  local home_dir
  home_dir="$(_dotd_expand_tilde "${DOTD_HOME:-$HOME/.dotd}")"
  if [ -f "$home_dir/models.yml" ]; then
    printf '%s' "$home_dir"
    return 0
  fi
  printf '%s/config' "$(dotd_repo_root)"
}

# `~` / `~/x` 展开（与 scripts/lib/env.mjs::expandHomePath 同语义）。
_dotd_expand_tilde() {
  local p="$1"
  case "$p" in
    '~') printf '%s' "$HOME" ;;
    '~/'*) printf '%s/%s' "$HOME" "${p#\~/}" ;;
    *) printf '%s' "$p" ;;
  esac
}

dotd_config_file() {
  printf '%s/%s' "$(dotd_config_dir)" "$1"
}
