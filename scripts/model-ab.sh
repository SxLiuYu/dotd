#!/usr/bin/env bash
# 决定性实验：同一任务，不同模型，看工具复用行为
#
# 2026-10-26（同类缺陷第九 / 十一例）：原来用 python 正则直接改写**仓库副本**
# `/root/dotd/config/models.yml`，再由 `pkill + wsl-daemon.sh` 重启；两处都不成立：
#   · daemon 读的是运行期那份（托管部署里 ~/.dotd/models.yml），改仓库副本靠启动时
#     `cp config/*.yml` 才"碰巧生效"；
#   · 锁被 one_system 持着时，那句 nohup 是静默 no-op —— 换的模型从未被加载。
#     "三个模型差不多"很可能就是同一个模型跑了三遍。
# 现在：切模型走 lib/model-switch.sh（改两处 + 读回 + EXIT trap 恢复），
#       重启走 lib/daemon-restart.sh（停 supervisor + 读回运行期环境）。
set -uo pipefail
cd /root/dotd || exit 1
set -a; . ./_tokens_src.env; set +a
BASE=http://127.0.0.1:7788
HDR=(-H "Authorization: Bearer $DOTD_MASTER_TOKEN" -H "Content-Type: application/json")

. "$(dirname "${BASH_SOURCE[0]}")/lib/model-switch.sh"
. "$(dirname "${BASH_SOURCE[0]}")/lib/daemon-restart.sh"
models_begin || exit 1

GOAL="统计一下这句话：Hello 世界，this is a test 测试。中文字和英文单词各有多少？"

test_model() {
  local model="$1"
  echo "════════ 模型: $model ════════"

  # 改配置：种子 + 运行期，两处都改
  models_set_primary "$model"
  models_verify_primary "$model" || { echo "  ❌ 模型没切过去，跳过"; return 1; }
  echo "  配置已切到 $model（已读回验证）"

  # 重启：daemon 只在启动时读 models.yml。运行期文件已在上面读回验证过，
  # 这里要保证的只是"读的是新进程"（daemon_restart 会比对 pid 并等端口通）。
  daemon_restart || { echo "  ❌ 重启失败，跳过"; return 1; }
  sleep 3

  # 发任务
  local tid st
  tid=$(curl -s -m 20 "${HDR[@]}" -X POST --data-binary "{\"text\":$(python3 -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$GOAL")}" "$BASE/api/messages" | sed -n 's/.*"taskId":"\([^"]*\)".*/\1/p')
  for i in $(seq 1 240); do
    sleep 0.5
    st=$(node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const r = db.prepare("SELECT status FROM tasks WHERE id=?").get(process.argv[1]);
process.stdout.write(r ? r.status : ""); db.close();' "$tid")
    case "$st" in done|failed|cancelled|paused|awaiting_approval) break ;; esac
  done

  echo "  状态: $st"
  node --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.dotd/dotd.db", { readOnly: true });
const ts = db.prepare("SELECT tool_name, status FROM steps WHERE task_id=? AND kind=?").all(process.argv[1], "tool");
console.log("  工具: " + (ts.map(r => r.tool_name + ":" + r.status).join(" → ") || "(无)"));
const usedInvoke = ts.some(r => r.tool_name === "tool.invoke");
console.log("  " + (usedInvoke ? "✅ 复用了自造工具" : "❌ 没用自造工具"));
db.close();' "$tid"
  echo ""
}

for m in deepseek-v4.1-flash glm-5.3-flash agnes-3.0-flash; do
  test_model "$m" || FAILED=$((FAILED + 1))
done

# 恢复**原来那份**（不是硬编码回 deepseek-v4.1-flash —— 那会悄悄改掉主人的配置）。
# 如果这个脚本原本就是从别的 primary 开始的，硬编码"恢复"等于又改了一次配置。
echo "=== 恢复原配置 ==="
models_restore
daemon_restart || echo "  ⚠️ 恢复后重启失败，需要手动检查"

[ "${FAILED:-0}" -eq 0 ] || { echo "有 $FAILED 个模型没跑成"; exit 1; }
