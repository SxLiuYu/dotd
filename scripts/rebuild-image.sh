#!/usr/bin/env bash
# scripts/rebuild-image.sh —— 重建 exec 镜像并让容器换到新基座。
#
# ⚠ 2026-10-22 重写（F3）。老版本第 6 行是：
#     docker rmi -f dotd/exec:1.49.1-0.1.0
# 那是**唯一可回滚的那份镜像**，脚本一上来就把它删了。也就是说：一旦新镜像构建失败
# 或者构建出来更糟，没有任何东西可以退回去，只能干看着。"重建"脚本的第一步是销毁退路，
# 顺序反了。现在改成【先给旧镜像打一个 rollback tag，构建成功后再删】，失败就原地退回。
#
# tag 不写死：从 src/exec/types.ts 的 execConfigFromEnv() 现算（唯一真相）（写死 1.49.1-0.1.0 是
# F2 那一类问题——名字与真相脱钩，换基座后脚本删的是一个根本不存在的 tag，静默 no-op）。
#
# 用法：
#   bash scripts/rebuild-image.sh            # 只构建，不动线上容器
#   bash scripts/rebuild-image.sh --swap     # 构建成功后，删容器让 daemon 用新镜像重建
set -uo pipefail
cd /root/dotd || exit 1

SWAP=0
[ "${1:-}" = "--swap" ] && SWAP=1

# ---------- 0. 现算 tag（唯一真相 = config/exec.yml） ----------
# 路径必须是 ./src/... 而不是 ../src/...：node --eval 把相对说明符按 <cwd>/[eval1]
# 解析，`../src` 会算成上一级目录（/root/src），实测直接 ERR_MODULE_NOT_FOUND。
# 曾经写错，靠下面"读不到就中止"的守卫兜住了（脚本整段 no-op），没造成损失。
read -r BASE RUNTIME < <(node --import tsx -e '
  import { execConfigFromEnv } from "./src/exec/types.ts";
  const c = execConfigFromEnv();
  process.stdout.write(`${c.baseImageTag} ${c.runtimeVer}`);
' 2>/dev/null || true)
if [ -z "${BASE:-}" ] || [ -z "${RUNTIME:-}" ]; then
  echo "!! 读不到 baseImageTag/runtimeVer（config/exec.yml？），中止：宁可什么都不做，"
  echo "   也不能凭猜的 tag 去删镜像。"
  exit 1
fi
TAG="dotd/exec:${BASE}-${RUNTIME}"
ROLLBACK=""  # 第 1 步按"线上镜像 id"现算，见下（不能提前定名，名字要指向真正被备份的那份）
echo "目标 tag : $TAG"
echo "回滚 tag : $ROLLBACK"

# ---------- 1. 备份：给"线上这个容器此刻真正在跑的镜像"打 rollback tag（绝不 rmi） ----------
# 为什么不按 $TAG 备份：现网 (2026-10-22) 容器用的是 digest fb98ec90ef9e，而 tag
# dotd/exec:1.49.1-0.1.0 指向的是另一个 image 15fbed5219f3 —— 同一个 tag 在
# image_builds 里有 15 行 ready，容器是用其中较早的一行建的。按 tag 备份会备到
# 一份"线上根本没在跑"的镜像，真要回滚时退不回去。所以按容器实况的 image id 备份。
CID0=$(docker ps -aq --filter name=dotd-dot-dot1 | head -1)
OLD_ID=""
if [ -n "$CID0" ]; then
  OLD_ID=$(docker inspect "$CID0" --format '{{.Image}}' 2>/dev/null | sed 's/^sha256://' | cut -c1-12)
fi
if [ -z "$OLD_ID" ]; then
  OLD_ID=$(docker images -q "$TAG" | head -1)   # 没有容器（首次换基座）→ 退回按 tag 找
fi
if [ -n "$OLD_ID" ]; then
  ROLLBACK="dotd/exec:rollback-${OLD_ID}"       # 用被备份镜像的 id 命名，名字自带指向
  docker tag "$OLD_ID" "$ROLLBACK" && echo "已备份  : live image ${OLD_ID} -> $ROLLBACK"
else
  echo "备份    : 既无运行中的容器也无 $TAG 镜像，无需备份"
fi

# ---------- 2. 构建 ----------
echo "=== 构建（约 2-3 分钟）==="
if ! node --import tsx scripts/wsl-build-image.mts --force; then
  echo "!! 构建失败。$TAG 未被改动；如已被半成品覆盖，可退回："
  echo "   docker tag $ROLLBACK $TAG"
  exit 1
fi
NEW_ID=$(docker images -q "$TAG" | head -1)
echo "新镜像 id: ${NEW_ID:0:12}  大小: $(docker images --format '{{.Size}}' "$TAG" | head -1)"

# ---------- 3. 换容器（只在 --swap 时做）----------
if [ "$SWAP" = "1" ]; then
  echo "=== --swap：删容器 + 重启 daemon，让它用新镜像重建 ==="
  # 2026-10-25：以前这里只删容器，期望"daemon 的 reconcile 接手"——但 reconcile
  # 只在 boot 里跑，没有周期性重跑。daemon 明明活着的时候，删掉容器后它会一直
  # 显示一个 lost 的账，直到下次重启。也就是说 --swap 对"正在跑的 daemon"是空操作。
  # （同一轮还发现 ensureImage 拿账上旧 digest 秒回，重建本身也不生效，两处一起修。）
  CID=$(docker ps -aq --filter name=dotd-dot-dot1 | head -1)
  if [ -n "$CID" ]; then
    docker rm -f "$CID" >/dev/null 2>&1 && echo "  已删旧容器 $CID"
  else
    echo "  无旧容器"
  fi
  # daemon 在跑就先优雅停掉：boot 才会重新 ensureImage + reconcile。
  # 托管模式（2026-10-25 起）：TERM supervisor 才能带走 dotd 子进程，
  # 只杀 node 会被 supervisor **用旧环境**自动重启，换镜像就成了空话（第十一例）。
  # 统一走 lib/daemon-restart.sh：停 supervisor → 等 flock 释放 → 起新实例；
  # 而且不顺带截断 /tmp/dotd-wsl.log（原来那句 `> /tmp/dotd-wsl.log` 会把
  # daemon 正在写的活日志清零，出事后现场就没了）。
  . "$(dirname "${BASH_SOURCE[0]}")/lib/daemon-restart.sh"
  DAEMON_RESTART_LOCK_WAIT=30
  # 新镜像首次起容器要拉/建，比平常慢得多：原来这里等 60×5s，保持同样的耐心。
  DAEMON_RESTART_TIMEOUT=300
  echo "  拉起 daemon…"
  daemon_restart || { echo "  !! daemon 没起来：镜像已换但没生效"; exit 1; }
fi

# ---------- 4. 验证 + 才清理回滚 ----------
echo ""
echo "=== 结果 ==="
docker images --format '{{.Repository}}:{{.Tag}}  {{.ID}}  {{.Size}}  {{.CreatedSince}}' | grep dotd/exec | head -5
curl -s -m 3 -o /dev/null -w '  daemon HTTP %{http_code}\n' http://127.0.0.1:7788/api/health
CID2=$(docker ps --filter name=dotd-dot-dot1 --format '{{.ID}}' | head -1)
echo "  容器: ${CID2:-无}"
if [ -n "$CID2" ]; then
  echo "  容器内 node: $(docker exec "$CID2" node -v 2>/dev/null || echo '取不到')"
  echo "  /ms-playwright: $(docker exec "$CID2" sh -c 'du -sh /ms-playwright 2>/dev/null || echo 不存在' 2>/dev/null)"
fi
if [ -n "$ROLLBACK" ]; then
  echo "回滚副本 $ROLLBACK **保留着**，确认新镜像没问题后再手动删："
  echo "  docker rmi $ROLLBACK"
  echo "（要立刻退回：docker tag $ROLLBACK ${TAG:-dotd/exec:*} 然后删掉新容器让 daemon 重建）"
else
  echo "无回滚副本（第 1 步没找到可备份的镜像），出问题只能重新构建。"
fi
