# 家居控制：一句话开关空调、灯、插座

> 2026-10-26 · 合并后家居控制是断的，这份文档写清楚**怎么重新接上**、每一层负责什么。

## 一句话结论

说「开客厅灯」「空调制冷 26 度」这类话，**不经过模型**：`cortex_router` 的家居反射
解析后直接下发，毫秒级。需要"一句话控制多台设备"或需要先查清单时，才交给 dotd 的
模型走 `magic-home` 的 MCP 工具。两条路共用同一份代码
（`voice/integration/home_devices.py`）和同一份设备清单，不会各自漂移。

## 0. 先看现在为什么不动

合并后家居控制同时断了三处（这是 2026-10-26 的现场，不是历史）：

| 断点 | 症状 |
|------|------|
| `agent/device_control.py` 的 `direct_ac_control()` 没有调用点 | 空调快路径是死代码，只有测试在 patch 它 |
| `agent/llm.py` 把「开灯/关灯」路由到 `ac-control`，但这个名字没有文件、没有工具映射 | 说「开灯」时工具域加载失败 |
| `agent/mqtt_device_control.py` 有函数但没有 `__mcp_meta__`、不在 `_SERVER_FILE_MAP` | MQTT 设备等于没挂上去 |
| 设备清单不存在 + 涂鸦/MQTT 环境变量全空 | 就算前三处都通，也不知道该控制谁 |

所以需要三样东西：**一份设备清单**、**四个适配器**（已有）、**两个入口**（语音反射 +
MCP 工具，已有）。

## 1. 写设备清单

清单路径按顺序取：

1. `HOME_DEVICES_FILE`（显式指定，最省事）
2. `<CHARLIE_DATA_DIR>/home-devices.yml`
3. `<ASSISTANT_KID_DATA_DIR>/home-devices.yml`（`one_system` 实际设的是这个）
4. `~/.charlie/home-devices.yml`

模板在 `config/home-devices.yml`，字段和示例都在里面。最小可用版本：

```yaml
devices:
  - id: ac-living
    name: 空调
    aliases: [客厅空调, 冷气]
    room: 客厅
    kind: ac
    adapter: tuya_ir
    infrared_id: "红外网关设备 ID"
    remote_id: "空调遥控器 ID"

  - id: light-living
    name: 客厅灯
    aliases: [大灯, 顶灯]
    room: 客厅
    kind: light
    adapter: tuya_cloud
    device_id: "涂鸦设备 ID"
    dp:
      switch: switch_led
      brightness: bright_value
```

**没有清单也能跑**：设了 `TUYA_IR_DEVICE_ID` + `TUYA_AC_DEVICE_ID` 就会自动注册一台
名叫「空调」的红外空调。这是主人原先就在用的那台。

安全设备（`kind` 为 `lock` / `doorlock` / `camera` / `alarm`）**写了也拒绝登记**，
日志里会说清楚。语音误触的代价太大，不值得为了"全都支持"开这个口子。

## 2. 选通道

| `adapter` | 适合 | 需要的凭证 | 下发方式 |
|-----------|------|-----------|---------|
| `tuya_ir` | 红外空调（2B 云） | `TUYA_CLIENT_ID` + `TUYA_ACCESS_KEY` | `ac_scenes_command()` |
| `tuya_cloud` | 涂鸦灯 / 插座 / 开关（2C 终端用户） | `TUYA_API_KEY`（`sk-` 开头） | `issue_properties()` |
| `mqtt` | Tasmota / Sonoff / Shelly / Home Assistant | `MQTT_BROKER`（可选 `MQTT_USER` / `MQTT_PASSWORD`） | 发布 `ON` / `OFF` 到 `topic_cmnd` |
| `esp32` | ESP32 红外网关 / 语音节点 | 局域网可达；文本推送另需 MQTT | `POST http://{ip}/api/ir/send` |

**空调必须走 `tuya_ir`**：2C 的影子 API 发不了红外码，用 `tuya_cloud` 控制空调只会
"报告成功但机器不动"。

`tuya_cloud` 的 DP 码因厂商而异，所以清单里可以覆盖。默认取涂鸦照明最常见的三个：

- `switch_led`：开关（布尔）
- `bright_value`：亮度（10–1000，代码里按百分比换算）
- `temp_value`：色温（当前不用，留位）

不确定 DP 码时，用涂鸦 App 的"设备调试"或 2C 的 `get_device_model` 查。

MQTT 的 topic 写**完整的 cmnd 主题**，不要写前缀：

```yaml
topic_cmnd: cmnd/livingroom-light/POWER
```

Tasmota 默认前缀就是 `cmnd/<topic>/POWER`，Sonoff/Shelly 各有自己的命名，写全最省事。

## 3. 环境变量

放在 `~/.dotd/tokens.env` 或 `<数据目录>/voice/.env`，或直接 export：

```bash
# 红外空调（2B）
TUYA_CLIENT_ID=...
TUYA_ACCESS_KEY=...
# 没有清单时的空调兜底
TUYA_IR_DEVICE_ID=...
TUYA_AC_DEVICE_ID=...

# 涂鸦灯/插座（2C）
TUYA_API_KEY=sk-...

# MQTT 设备
MQTT_BROKER=192.168.1.10
MQTT_PORT=1883
MQTT_USER=
MQTT_PASSWORD=

# 可选
HOME_DEVICES_FILE=/absolute/path/home-devices.yml
HOME_AC_DRY_RUN=1        # 只解析不发红外码，联调用
```

这些变量都在 `voice/charlie/app/env_catalog.py` 的 `tuya` 分组里登记了，setup 页面能
看到并校验占位符（`你的...` 视为未配置）。

## 4. 两条入口

### 4.1 语音反射（默认，极快）

`cortex_router.reflex()` 的调用顺序，家居插在 `smart_command` 之后、
`decision_feedback` 之前：

```
smart_command → home → decision_feedback → FAST_PATHS → cache → camera → scene → garbled
```

轮到 `home` 时，`HomeController.handle(text)`：

1. 否定句（「不要开灯」）、疑问句（「你是不是把灯关了」）→ 返回 `None`，交给下游；
2. 按称呼匹配设备（长词优先，如「客厅灯」先于「灯」）；
3. 解析动作与参数（空调模式/温度/风速、灯的开关与亮度）；
4. 认不出任何一项 → 返回 `None`（**绝不猜一台设备去开关**）；
5. 能确定 → 执行，返回一句能直接念的话。

反射命中要记账（`POST /api/device/events`，kind=`home`）。家居是真的动了实物，
不记账事后查不出「三点钟谁把空调关了」。

清单文件改了会按 mtime 自动重载，不必重启语音进程。

### 4.2 MCP 工具（`magic-home`，给 dotd 的模型用）

| 工具 | 用途 |
|------|------|
| `home_list()` | 列出登记的设备和能力 |
| `home_control(device, action, params)` | 下发指令。`action` 取 `on` / `off` / `set_brightness` / `notify` / `tts`；`params` 是 JSON 字符串 |
| `home_status(device?)` | 最近 200 条操作记录（不是云端实时状态） |
| `home_reload()` | 重读清单 |

启用方式：把 `config/mcp-servers.voice.yml` 里的 `charlie-home` 一段并进
`config/mcp-servers.yml`，或用 `DOTD_MCP_CONFIG=config/mcp-servers.voice.yml` 启动
daemon。

`ac-control` 是历史域名，现在也指向 `magic-home.py`（`agent/inproc_tools._SERVER_FILE_MAP`
里两个名字同一个文件），所以模型侧无论按旧名还是新名路由都到得了同一批工具。

> ⚠️ `mcp.call` 在 dotd 里是 `dangerous` 档。`DOTD_APPROVALS=on` 时每次都要主人审批；
> 产品默认 `DOTD_APPROVALS=off`（主人 2026-10-26 的要求），这一档直通，但**照样写
> decisions + audit**，reason 带 `approvals=off`，事后能筛出"这次没经过人"。

## 5. 验收

不带真设备（推荐先用这个）：

```bash
HOME_DEVICES_FILE=config/home-devices.yml HOME_AC_DRY_RUN=1 \
  node scripts/py.mjs -m unittest voice.integration.test_home_devices -v
```

带真设备前先干跑，确认解析对不对：

```python
python -c "
from voice.integration.home_devices import HomeController
c = HomeController()
print(c.handle('打开客厅灯'))
print(c.handle('空调制冷26度'))
print(c.handle('不要开灯'))     # 应该是 None
"
```

`None` 是正确结果，意思是"没把握，交给模型"，不是失败。

### 怎么认设备名

匹配按"最长称呼优先"：清单里叫「客厅空调」，说「关客厅空调」最长词命中；
只说「关空调」也能命中，因为 `kind` 自带品类词（`ac`→空调、`light`→灯、
`switch`→插座/开关、`tv`→电视）。同一品类有两台时，品类词就**不再猜**——
「关空调」会返回 `None` 交给模型，得说「关卧室空调」或者给设备写 `aliases`。

否定句和疑问句在 `handle()` 和 `parse_action()` 两处都挡。「不要开灯」
「空调开了吗」一律不碰实物。这条守卫来自真实事故：ASR 曾把「你是不是把
客厅空调关了」当成关机指令，空调真的被关掉。

## 6. 已知边界

- **不做设备发现**：发现得到设备 ID，发现不到"主人怎么称呼它"。称呼必须写在清单里。
- **不做状态轮询**：避免把涂鸦云配额刷光。所以 `home_status` 答的是"我们发过什么"，
  不是"现在是什么状态"。问「灯现在开着吗」时，如实说"刚打开过"，别编。
- **不做多设备复合句**：「开灯并关空调」会被降级给模型（反射层返回 `None`），
  由 `home_control` 分开调两次。
- **失败不美化**：适配器没发出去就说"指令没发出去"，不播"已打开"。
