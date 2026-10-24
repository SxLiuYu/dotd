# 单一记忆源 / 单一推送决策：真进程端到端（2026-10-24）

单测之外，再跑一次真进程：真 dotd、真 HTTP、真 SQLite，Python 用**真 `DeviceBridge`**
（不是替身）。目的：证明 Charlie 侧的 `DotdMemory` / `PushGate` 与 dotd 的接口真的对得上。

## 步骤

```bash
# 临时 home + 7799，不碰主人在跑的 7788
DOTD_HOME=.tmp-e2e node scripts/init-config.mjs
sed -i 's/port: 7788/port: 7799/' .tmp-e2e/config.yml

DOTD_HOME=$PWD/.tmp-e2e DOTD_CONFIG=$PWD/.tmp-e2e/config.yml \
DOTD_DB_PATH=$PWD/.tmp-e2e/dotd.db DOTD_FLEET=stub DOTD_GUARD_BASE_MB=1024 \
HY3_API_KEY=... node --import tsx src/daemon.ts

# 用 master 建设备
curl -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"E2E"}' http://127.0.0.1:7799/api/devices

# Python 侧（真 DeviceBridge）
DOTD_BASE_URL=http://127.0.0.1:7799 DOTD_DEVICE_TOKEN=... python - <<'PY'
from voice.integration.dotd_bridge import DeviceBridge
from voice.integration.dotd_memory import DotdMemory
from voice.integration.push_gate import PushGate
b = DeviceBridge(); m = DotdMemory(b); g = PushGate(bridge=b)
m.mirror_turn("晚安", "晚安，空调已关", dedupe_key="e2e-1")
m.mirror_turn("晚安", "晚安，空调已关", dedupe_key="e2e-1")   # 幂等
m.set_pref("wake_word", "小豆")
g.decide("weather", "今天下午有雨，记得带伞")                 # allow
g.decide("weather", "今天下午有雨，记得带伞")                 # duplicate
g.decide("weather", "晚上降温到 12 度")                       # throttled
g.decide("home", "你到家了，灯已打开")                        # allow（不同 kind）
PY
```

## 结果（原始 JSON：`live.json`）

| 断言 | 结果 |
|---|---|
| 反射轮次补写 | `mirror1=true` |
| 同一 `dedupeKey` 重试 | `mirror_dup=false`（没写第二遍） |
| 偏好写入 | `set_pref=true` |
| 从 dotd 读会话 | `[["user","晚安"],["assistant","晚安，空调已关"]]` |
| 从 dotd 读偏好 | `{"wake_word":"小豆"}` |
| 管理面读同一份偏好 | `GET /api/memory/prefs?device=` → `wake_word=小豆` |
| 推送：首次允许 | `allow=true` |
| 推送：同文第二次 | `allow=false reason=duplicate` |
| 推送：同类换一句 | `allow=false reason=throttled` |
| 推送：另一类 | `allow=true`（一条规则不饿死另一条） |
| 决策留痕 | `device_push_log` 4 条（允许/拒绝都在） |

## 说明

- 这轮用 `DOTD_GUARD_BASE_MB=1024` 绕过本机内存水位误判（见
  `../voice-real-latency/REPORT.md` 的「实测中发现的一个真问题」），与记忆/推送功能无关。
- 临时 home、临时设备、临时库都在跑完后删除；没有动主人正在用的 `~/.dotd` 与 7788。
