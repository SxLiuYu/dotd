# 设备操作日志审计 — 2026-08-12

## 背景

用户反馈：08-11 晚 22:24 关机后，空调在 08-12 早 06:36 再次处于开启状态。需要追溯谁在半夜开了空调。

## 时间线还原

```
20:46:12  ASR: "天气怎样" → 查询天气
20:47:37  ASR: "关闭客厅空调" → [ac] 直连关机 ✅
20:47:45  ASR: "打开客厅空调" → [ac] 直连开机成功, 26度
20:48:09  ASR: "我老婆不理我了怎么办呀" → 闲聊
22:24:27  ASR: "关闭客厅的空调" → [ac] 直连关机 ✅
22:47:44  [decision] 执行Protocol: goodnight → 空调已off (播报,无新操作)
... 8小时空白期 ...
06:00:04  [suggest] 用户状态变化: home_sleeping → home_resting (纯状态变更,无设备操作)
06:36:31  ASR: "关闭客厅空调" → [ac] 直连关机 (空调已是开状态)
```

## 结论：Charlie 未触发空调开机

| 检查项 | 结果 |
|--------|------|
| ESP32 22:47~06:36 WebSocket 连接 | ❌ 无任何连接记录 |
| Tuya AC API 调用 | ❌ 零条记录 |
| `[ac]` 操作日志 | ❌ 零条记录 |
| `home_resting` 状态分支 | ❌ 代码中无任何设备操作 |
| `good_morning` 协议 | ❌ 需要 home_awake + 7~9点, 不满足 |
| 外部 cron/launchctl | ❌ 无 Tuya/AC 相关任务 |
| 运行中的 Python 进程 | ❌ 仅 voice_server.py 单实例 |

**空调在半夜自动开启，但不是 Charlie 操作的。** 最可能来源是 Tuya 涂鸦 APP 云端的独立自动化规则（不受 Charlie 控制）。

---

## 日志完善性评估 (2026-08-12)

### 现有覆盖 ✅

| 项目 | 覆盖度 | 说明 |
|------|--------|------|
| AC 操作结果 | 中 | `[ac] 直连开机成功/关机` 有记录，但缺参数和状态快照 |
| ASR 原文 | 高 | `ASR=... | text=...` 每条对话都有 |
| 状态变化 | 高 | `[suggest] 用户状态变化: X→Y` 完整 |
| 决策执行 | 中 | `执行Protocol` 有结果，但缺触发条件 |
| Tuya HTTP 200 | 高 | 大量轮询记录 |
| 设备操作结果 | 低 | goodnight 走 magic-scenes 的 `_ac_control()` 完全无日志 |
| 操作前状态 | 无 | 开/关空调前不查询当前状态 |
| IR 指令参数 | 无 | power/mode/temp/wind 不记录 |

### 发现的问题 🔴

1. **`magic-scenes.py` 的 `_ac_control()` 完全没有日志** — goodnight 协议的设备操作因此不可追溯
2. **设备操作前无状态快照** — 无法判断操作是否多余或错误
3. **决策日志缺少触发条件** — 不知道是哪个规则哪个状态触发的
4. **IR 命令参数未记录** — 无法回溯实际发送了什么
5. **日志轮转 (maxBytes=5MB, backupCount=3)** — 约3天前的数据可能丢失
6. **`charlie_xiaozhi.log` 从 08-09 停止更新** — 新的 xiaozhi 对话只在 app.log 中

### 已实施的修复

#### 修复 1: `magic-scenes.py` — 补充完整设备操作日志

```python
# 新增 import
import logging
log = logging.getLogger("magic")

def _ac_control(action):
    # 新增: 未配置时警告
    log.warning("[ac] 红外网关/空调设备ID未配置")
    # 新增: 发指令前记录参数
    log.info(f"[ac] scenes命令: power={power} mode={mode} temp={temp} wind={wind}")
    api.ac_scenes_command(...)
    # 新增: 成功后确认
    log.info(f"[ac] scenes指令发送成功: {action}")
    # 新增: 失败时记录异常
    log.warning(f"[ac] scenes控制失败(action={action!r}): {e}")

def _tv_control(action):
    # 新增: 发指令前/响应后记录
    log.info(f"[tv] 发送红外指令: action={action!r}")
    log.info(f"[tv] 指令响应: status={resp.status_code}")
```

#### 修复 2: `voice_agent.py` — AC 操作前查询并记录状态快照

```python
# 关机/开机前新增:
log.info(f"[ac] 查询当前状态: infrared={infrared_id[:8]}... remote={remote_id[:8]}...")
cur = api.ac_status(infrared_id, remote_id)
log.info(f"[ac] 操作前状态: power={cur.get('power')} mode={cur.get('mode')} temp={cur.get('temp')}°C wind={cur.get('wind')}")
# 开机时新增:
log.info(f"[ac] 发送指令: power=1 mode={mode} temp={eff_temp} wind={fan} (ASR={t[:30]})")
```

#### 修复 3: `magic-decisions.py` — 决策执行记录触发条件

```python
# 修改前:
# log.info(f"[decision] 执行Protocol: {action['name']} -> {result[:50]}")
# 修改后:
log.info(f"[decision] 执行Protocol: {action['name']} (触发规则={rule['id']}, state={cond.get('states')}, hours={cond.get('hours')}) -> {result[:80]}")
```

### 修复后日志效果

```
# 下次操作空调时，日志链为:
[ac] 查询当前状态: infrared=xxxx... remote=xxxx...
[ac] 操作前状态: power=1 mode=0 temp=24°C wind=2
[ac] 发送指令: power=0 mode=None temp=26 wind=1 (ASR=关闭客厅空调)
[ac] 直连关机: ASR=关闭客厅空调 → power=0

# goodnight 协议:
[ac] scenes命令: power=0 mode=None temp=26 wind=1 (action='off')
[ac] scenes指令发送成功: off
[decision] 执行Protocol: goodnight (触发规则=late_night_sleep, state=['home_resting', 'home_sleeping'], hours=(22,6)) -> ...

# TV 控制:
[tv] 发送红外指令: action='power_off' target=http://192.168.1.7/api/ir/send
[tv] 指令响应: status=200
```

---

## 后续建议

1. **增加设备状态持久化**: 每次成功操作后缓存 AC 状态到文件，下次操作前读取对比
2. **Tuya API 失败日志增强**: 当前只记录 Exception 字符串，应记录 HTTP 状态码和响应体
3. **日志轮转策略**: 考虑按日期轮转 (TimedRotatingFileHandler) 而非按大小，避免跨天数据被截断
4. **独立设备审计日志**: 建议新建 `logs/device_audit.log`，专门记录所有设备操作的前后状态和参数，便于排查
