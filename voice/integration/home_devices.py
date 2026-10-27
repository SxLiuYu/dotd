"""voice/integration/home_devices.py —— 家居控制的事实源（2026-10-26）。

## 它解决什么

合并后家居控制是断的，而且是三层同时断：

1. `voice/charlie/agent/device_control.py` 的 `direct_ac_control()`（涂鸦 2B 红外，
   原文注释写 ~0.2s）**没有任何调用点**，只有测试在 patch 它 —— 合并后所有语音都走
   `cortex_router`，这条快路径再没被执行过。
2. `agent/llm.py:160` 把「灯/风扇」路由到 `ac-control` 这个名字，但 `app/mcp_registry`
   与 `agent/inproc_tools._SERVER_FILE_MAP` 里**都没有** `ac-control` —— 说「开灯」
   必然加载失败。
3. `agent/mqtt_device_control.py` 写好了 `list_devices/control_device/device_status`，
   却没写 `__mcp_meta__`、不在 `_SERVER_FILE_MAP` 里 —— 等于没挂上去。

这个模块是**第四个入口，也是唯一有意的入口**：一张设备清单 + 四种适配器，
被 `cortex_router` 当作反射调用（不经过模型），也被 `magic-home.py` 暴露给 dotd 的
模型调用。两条路走同一套代码，不会各自漂移。

## 分层

    「开客厅灯」
        |
        +-- HomeController.handle(text)       ← 语音反射，毫秒级
        |      ├─ 解析（设备名/房间/动作/参数）
        |      ├─ 拒绝分支（否定句、疑问句、认不出设备）→ 返回 None，交给 dotd
        |      └─ adapter.execute()
        |
        +-- magic-home.py 的 MCP 工具          ← dotd 模型调用同一套
               home_control(device, action, params)
               home_list() / home_status(device)

## 适配器

| adapter      | 下发方式                                        | 凭证 |
|--------------|------------------------------------------------|------|
| `tuya_ir`    | 涂鸦 2B 红外云 `/air-conditioners/{id}/command` | TUYA_CLIENT_ID + TUYA_ACCESS_KEY |
| `tuya_cloud` | 涂鸦 2C 终端用户 `issue_properties`（灯/插座/DLPS）| TUYA_API_KEY |
| `mqtt`       | 发布到 `topic_cmnd`（Tasmota/Sonoff/Shelly/HA）  | MQTT_BROKER（可选认证）|
| `esp32`      | `POST http://{esp32_ip}/api/ir/send`            | 无（局域网）|

## 失败语义

- **认不出就不动**：设备名/动作任一没把握 → 返回 None（反射层）或 `ok=False`（工具层），
  由 dotd 的模型带着上下文再判断。绝不猜一个设备去开关。
- **不说假话**：适配器返回失败就如实说「指令没发出去」，不播「已打开」。
- 凭证缺失不算错误配置崩溃：`available()` 明确说缺哪个环境变量。

## 不做什么

- 不做设备发现（发现得到 ID，发现不到「主人怎么称呼它」）；
- 不做状态轮询（避免云 API 配额被我们自己刷光）；
- 不碰门锁/摄像头这类安全设备 —— 清单里写了也拒绝，见 `_BLOCKED_KINDS`。

## 环境变量

    HOME_DEVICES_FILE   设备清单路径，默认 <CHARLIE_DATA_DIR>/home-devices.yml
                        （其次 <ASSISTANT_KID_DATA_DIR>/home-devices.yml、~/.charlie/）
    TUYA_API_KEY / TUYA_CLIENT_ID / TUYA_ACCESS_KEY / TUYA_BASE_URL
    TUYA_IR_DEVICE_ID / TUYA_AC_DEVICE_ID   没有清单时的空调兜底
    MQTT_BROKER / MQTT_PORT / MQTT_USER / MQTT_PASSWORD
    HOME_AC_DRY_RUN=1   空调只解析不发码（联调用）
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

log = logging.getLogger("charlie.home")

# 安全设备：清单里写了也拒绝（语音误触代价太大）
_BLOCKED_KINDS = frozenset({"lock", "doorlock", "camera", "alarm"})

# kind → 默认能力
_KIND_CAPS: dict[str, tuple[str, ...]] = {
    "ac": ("power", "mode", "temp", "fan"),
    "light": ("power", "brightness"),
    "switch": ("power",),
    "tv": ("power",),
    "esp32": ("notify", "tts"),
    "generic": ("power",),
}

# kind → 主人可能用的品类称呼。清单里的名字常常带房间（「客厅空调」），
# 而语音里往往只说品类（「关空调」）。同品类多台时会落到歧义判定，不猜。
_KIND_NOUNS: dict[str, tuple[str, ...]] = {
    "ac": ("空调", "冷气"),
    "light": ("灯",),
    "switch": ("插座", "开关"),
    "tv": ("电视",),
}

# 动作词表（子串匹配，按"最具体在前"排）
_ACTION_OFF = ("关闭", "关掉", "关上", "关一下", "熄灯", "熄了", "关")
_ACTION_ON = ("打开", "开启", "启动", "开一下", "亮起来", "点亮", "亮", "开")
_NEGATION = ("不要", "不用", "不想", "无需", "不必", "别开", "别关", "别再", "别动")
_QUESTION = ("是不是", "了吗", "了没", "有没有", "刚才", "为什么", "怎么")

# 空调参数
_AC_MODES = {
    "制冷": 0, "冷风": 0, "降温": 0, "凉": 0,
    "制热": 1, "暖风": 1, "加热": 1, "升温": 1,
    "自动": 2, "全自动": 2,
    "送风": 3, "自然风": 3,
    "除湿": 4, "抽湿": 4,
}
_AC_FANS = {"高风": 3, "最大风": 3, "中风": 2, "中等风": 2, "低风": 1, "小风": 1, "微风": 1}

# 亮度
_BRIGHT_PCT = re.compile(r"(?:亮度|调到|开到)\s*(\d{1,3})\s*%?")
_TEMP = re.compile(r"(\d{1,2})\s*(?:度|℃|°C|摄氏度)")


# ── 数据形状 ─────────────────────────────────────────────────────────


@dataclass
class Device:
    """清单里的一台设备。`extra` 保留 dp / topic 这类适配器专属字段。"""

    id: str
    name: str
    adapter: str
    kind: str = "generic"
    aliases: tuple[str, ...] = ()
    room: str = ""
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def caps(self) -> tuple[str, ...]:
        return _KIND_CAPS.get(self.kind, _KIND_CAPS["generic"])

    @property
    def terms(self) -> tuple[str, ...]:
        """用于语音匹配的所有称呼（长词优先，避免「灯」抢在「客厅灯」前面）。

        除了名字 / 别名 / 房间，还带上**品类词**（空调、灯、插座、电视）。
        2026-10-26 现场：清单里叫「客厅空调」，主人说「关空调」就匹配不到，
        反射层只好把整句话交给模型 —— 而这条路径存在的意义就是不走模型。
        品类词比名字短，长词优先保证「客厅空调」仍然优先命中；
        多台同品类时长度相同，落到 `match_device` 的歧义判定，不猜。
        """
        out = {self.name, *self.aliases, *_KIND_NOUNS.get(self.kind, ())}
        if self.room:
            out.add(self.room)
            out.add(self.room + self.name)
        return tuple(sorted((t for t in out if t), key=len, reverse=True))

    def to_public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "room": self.room,
            "kind": self.kind,
            "adapter": self.adapter,
            "capabilities": list(self.caps),
        }


@dataclass
class HomeResult:
    ok: bool
    message: str
    device: Optional[str] = None
    action: Optional[str] = None
    detail: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "message": self.message,
            "device": self.device,
            "action": self.action,
            "detail": self.detail,
        }


@dataclass
class Command:
    device: Device
    action: str
    params: dict[str, Any] = field(default_factory=dict)

    def describe(self) -> str:
        bits = [self.device.name, self.action]
        if self.params:
            bits.append(json.dumps(self.params, ensure_ascii=False))
        return " ".join(bits)


# ── 清单加载 ─────────────────────────────────────────────────────────


def default_manifest_path(env: Optional[dict[str, str]] = None) -> str:
    """清单路径。顺序即优先级。

    `ASSISTANT_KID_DATA_DIR` 是 Charlie 上游的规范变量，`one_system.apply_env`
    实际设的是它（没有设 `CHARLIE_DATA_DIR`）—— 不认这个变量的话，真机上清单
    永远找不到，人会以为"我明明写了文件"。`CHARLIE_DATA_DIR` 保留兼容。
    """
    e = env if env is not None else os.environ
    explicit = (e.get("HOME_DEVICES_FILE") or "").strip()
    if explicit:
        return os.path.expanduser(explicit)
    for key in ("CHARLIE_DATA_DIR", "ASSISTANT_KID_DATA_DIR"):
        data_dir = (e.get(key) or "").strip()
        if data_dir:
            return os.path.join(os.path.expanduser(data_dir), "home-devices.yml")
    return os.path.join(os.path.expanduser("~"), ".charlie", "home-devices.yml")


def _load_yaml(path: str) -> Any:
    try:
        import yaml  # type: ignore
    except Exception:
        log.warning("[home] 没有 PyYAML，清单读不了：%s", path)
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return yaml.safe_load(fh)
    except FileNotFoundError:
        return None
    except Exception as exc:
        log.warning("[home] 清单解析失败 %s：%s", path, exc)
        return None


def _parse_device(raw: dict[str, Any]) -> Optional[Device]:
    name = str(raw.get("name") or "").strip()
    dev_id = str(raw.get("id") or "").strip() or name
    adapter = str(raw.get("adapter") or "").strip().lower()
    if not name or not adapter:
        log.warning("[home] 跳过缺 name/adapter 的条目：%r", raw)
        return None
    kind = str(raw.get("kind") or "generic").strip().lower()
    if kind in _BLOCKED_KINDS:
        log.warning("[home] 拒绝登记安全设备（kind=%s, id=%s）：不提供语音控制", kind, dev_id)
        return None
    aliases_raw = raw.get("aliases") or []
    if isinstance(aliases_raw, str):
        aliases = tuple(a.strip() for a in aliases_raw.split(",") if a.strip())
    else:
        aliases = tuple(str(a).strip() for a in aliases_raw if str(a).strip())
    reserved = {"id", "name", "adapter", "kind", "aliases", "room"}
    extra = {k: v for k, v in raw.items() if k not in reserved}
    return Device(
        id=dev_id,
        name=name,
        adapter=adapter,
        kind=kind,
        aliases=aliases,
        room=str(raw.get("room") or "").strip(),
        extra=extra,
    )


def load_devices(
    path: Optional[str] = None,
    env: Optional[dict[str, str]] = None,
) -> list[Device]:
    """读清单。没有文件时退回到「只有一台红外空调」的兜底配置。

    兜底不是凑数：主人原先用的就是这一个设备，`TUYA_IR_DEVICE_ID` +
    `TUYA_AC_DEVICE_ID` 两个变量就能恢复「关空调」这个最常用的动作。
    """
    e = env if env is not None else os.environ
    p = path or default_manifest_path(e)
    raw = _load_yaml(p)
    out: list[Device] = []
    if isinstance(raw, dict):
        for item in raw.get("devices") or []:
            if isinstance(item, dict):
                d = _parse_device(item)
                if d is not None:
                    out.append(d)
    if out:
        return out

    ir_id = (e.get("TUYA_IR_DEVICE_ID") or "").strip()
    ac_id = (e.get("TUYA_AC_DEVICE_ID") or "").strip()
    if ir_id and ac_id:
        out.append(
            Device(
                id="ac-default",
                name="空调",
                adapter="tuya_ir",
                kind="ac",
                aliases=("冷气", "暖气"),
                extra={"infrared_id": ir_id, "remote_id": ac_id},
            )
        )
        log.info("[home] 没有清单，按 TUYA_IR_DEVICE_ID/TUYA_AC_DEVICE_ID 注册了 1 台空调")
    return out


# ── 适配器 ───────────────────────────────────────────────────────────


class Adapter:
    """适配器基类。`execute` 只做一件事：把命令发出去，如实回报。"""

    name = "base"

    def available(self) -> tuple[bool, str]:
        return True, ""

    def execute(self, cmd: Command) -> HomeResult:  # pragma: no cover - 抽象
        raise NotImplementedError


def _charlie_root() -> str:
    """voice/charlie 的绝对路径（tuya_api 在那个目录下，不是包）。"""
    here = os.path.dirname(os.path.abspath(__file__))  # voice/integration
    return os.path.join(os.path.dirname(here), "charlie")


def _import_tuya_module():
    """`import tuya_api` 需要 voice/charlie 在 sys.path 上（上游就是这么用的）。"""
    import sys

    root = _charlie_root()
    if root not in sys.path:
        sys.path.insert(0, root)
    import tuya_api  # type: ignore  # noqa: WPS433

    return tuya_api


class TuyaIrAdapter(Adapter):
    """涂鸦 2B 红外。2C 影子 API 发不了红外码，空调必须走这条。"""

    name = "tuya_ir"

    def available(self) -> tuple[bool, str]:
        missing = [
            k for k in ("TUYA_CLIENT_ID", "TUYA_ACCESS_KEY") if not os.environ.get(k)
        ]
        if missing:
            return False, "缺 " + " / ".join(missing)
        return True, ""

    def _api(self):
        mod = _import_tuya_module()
        return mod.TuyaCloudAPI()

    def execute(self, cmd: Command) -> HomeResult:
        if cmd.device.kind != "ac":
            return HomeResult(False, f"{cmd.device.name} 不是空调，红外空调适配器不处理", cmd.device.id, cmd.action)
        ir = str(cmd.device.extra.get("infrared_id") or os.environ.get("TUYA_IR_DEVICE_ID") or "")
        remote = str(cmd.device.extra.get("remote_id") or os.environ.get("TUYA_AC_DEVICE_ID") or "")
        if not ir or not remote:
            return HomeResult(False, "红外空调缺 infrared_id / remote_id", cmd.device.id, cmd.action)

        if os.environ.get("HOME_AC_DRY_RUN") == "1":
            return HomeResult(True, f"（联调模式）{cmd.device.name}：{cmd.describe()}", cmd.device.id, cmd.action)

        ok, msg = self.available()
        if not ok:
            return HomeResult(False, f"空调控制不可用：{msg}", cmd.device.id, cmd.action)

        power = 1 if cmd.action == "on" else 0
        mode = cmd.params.get("mode")
        temp = cmd.params.get("temp")
        wind = cmd.params.get("fan")
        try:
            api = self._api()
            sent = api.ac_scenes_command(ir, remote, power=power, mode=mode, temp=temp, wind=wind)
        except Exception as exc:  # 网络/签名/凭证，一律如实报
            log.warning("[home] 红外下发失败：%s", exc)
            return HomeResult(False, f"空调指令没发出去：{exc}", cmd.device.id, cmd.action)

        if not sent:
            return HomeResult(False, "空调指令可能没生效，请稍后再说一次", cmd.device.id, cmd.action)
        return HomeResult(True, _ac_reply(cmd), cmd.device.id, cmd.action)


def _ac_reply(cmd: Command) -> str:
    if cmd.action == "off":
        return f"{cmd.device.name}已关闭。"
    bits = [f"{cmd.device.name}已打开"]
    mode_name = {0: "制冷", 1: "制热", 2: "自动", 3: "送风", 4: "除湿"}
    if cmd.params.get("mode") is not None:
        bits.append(mode_name.get(int(cmd.params["mode"]), str(cmd.params["mode"])))
    if cmd.params.get("temp") is not None:
        bits.append(f"{cmd.params['temp']}度")
    fan_name = {1: "低风", 2: "中风", 3: "高风"}
    if cmd.params.get("fan") is not None:
        bits.append(fan_name.get(int(cmd.params["fan"]), str(cmd.params["fan"])))
    return "，".join(bits) + "。"


class TuyaCloudAdapter(Adapter):
    """涂鸦 2C 终端用户 API。灯/插座/开关走这条（`issue_properties`）。

    DP 码因厂商而异，所以清单里可以覆盖。默认值取涂鸦照明最常见的三个：
    `switch_led` / `bright_value` / `temp_value`。
    """

    name = "tuya_cloud"

    def available(self) -> tuple[bool, str]:
        if not os.environ.get("TUYA_API_KEY"):
            return False, "缺 TUYA_API_KEY"
        return True, ""

    def _api(self):
        mod = _import_tuya_module()
        return mod.TuyaAPI()

    def execute(self, cmd: Command) -> HomeResult:
        device_id = str(cmd.device.extra.get("device_id") or "")
        if not device_id:
            return HomeResult(False, f"{cmd.device.name} 缺 device_id", cmd.device.id, cmd.action)
        ok, msg = self.available()
        if not ok:
            return HomeResult(False, f"云开关不可用：{msg}", cmd.device.id, cmd.action)

        dp = cmd.device.extra.get("dp") or {}
        dp_switch = str(dp.get("switch") or "switch_led")
        dp_bright = str(dp.get("brightness") or "bright_value")

        props: dict[str, Any] = {}
        if cmd.action in ("on", "off"):
            props[dp_switch] = cmd.action == "on"
        elif cmd.action == "set_brightness":
            pct = int(cmd.params.get("brightness", 100))
            props[dp_switch] = True
            props[dp_bright] = max(10, min(1000, int(pct * 10)))
        elif cmd.action == "toggle":
            props[dp_switch] = bool(cmd.params.get("on", True))
        else:
            return HomeResult(False, f"云开关不支持动作 {cmd.action}", cmd.device.id, cmd.action)

        try:
            api = self._api()
            api.issue_properties(device_id, props)
        except Exception as exc:
            log.warning("[home] 云开关下发失败：%s", exc)
            return HomeResult(False, f"{cmd.device.name} 指令没发出去：{exc}", cmd.device.id, cmd.action)

        if cmd.action == "set_brightness":
            return HomeResult(True, f"{cmd.device.name}亮度已调到 {cmd.params.get('brightness')}%。", cmd.device.id, cmd.action)
        return HomeResult(True, f"{cmd.device.name}已{'打开' if cmd.action == 'on' else '关闭'}。", cmd.device.id, cmd.action)


def _mqtt_client():
    """优先用 paho；没有就借 Charlie 已经在跑的 mqtt_server 连接（同一 broker）。"""
    broker = os.environ.get("MQTT_BROKER", "").strip()
    try:
        import paho.mqtt.client as mqtt  # type: ignore

        if not broker:
            return None, "缺 MQTT_BROKER"
        client = mqtt.Client(client_id=f"charlie-home-{os.getpid()}")
        user = os.environ.get("MQTT_USER", "").strip()
        if user:
            client.username_pw_set(user, os.environ.get("MQTT_PASSWORD", ""))
        client.connect(broker, int(os.environ.get("MQTT_PORT", "1883") or 1883), 30)
        client.loop_start()
        return client, ""
    except ImportError:
        pass
    except Exception as exc:
        return None, f"MQTT 连接失败：{exc}"

    # 兜底：Charlie 的 mqtt_server（只在配了 MQTT_BROKER 时才连过）
    try:
        import sys

        root = _charlie_root()
        if root not in sys.path:
            sys.path.insert(0, root)
        from app.mqtt_server import get_server  # type: ignore

        server = get_server()
        client = getattr(server, "_client", None)
        if client is not None:
            return client, ""
        return None, "MQTT 未连接（paho 未安装，Charlie 的 broker 也没连上）"
    except Exception as exc:
        return None, f"MQTT 不可用：{exc}"


class MqttAdapter(Adapter):
    """Tasmota / Sonoff / Shelly / HA 这类本地 MQTT 设备。

    发布形状按 Tasmota 习惯：`cmnd` 主题收 `ON` / `OFF` / `RESULT`。
    topic 前缀在清单里写成完整的 cmnd 主题，避免猜各家的命名规则。
    """

    name = "mqtt"

    TOPIC_ALIASES = ("topic_cmnd", "topic", "topic_prefix")

    def _topic(self, dev: Device) -> str:
        for key in self.TOPIC_ALIASES:
            v = str(dev.extra.get(key) or "").strip()
            if v:
                return v
        return ""

    def execute(self, cmd: Command) -> HomeResult:
        topic = self._topic(cmd.device)
        if not topic:
            return HomeResult(False, f"{cmd.device.name} 缺 topic_cmnd", cmd.device.id, cmd.action)
        client, why = _mqtt_client()
        if client is None:
            return HomeResult(False, f"MQTT 不可用：{why}", cmd.device.id, cmd.action)

        if cmd.action == "on":
            payload = "ON"
        elif cmd.action == "off":
            payload = "OFF"
        elif cmd.action == "set_brightness":
            payload = str(max(0, min(100, int(cmd.params.get("brightness", 100)))))
        elif cmd.action in ("notify", "tts"):
            payload = json.dumps({"type": cmd.action, "text": cmd.params.get("text", "")}, ensure_ascii=False)
        else:
            payload = json.dumps({cmd.action: cmd.params}, ensure_ascii=False)

        try:
            client.publish(topic, payload, qos=1)
        except Exception as exc:
            return HomeResult(False, f"{cmd.device.name} 发布失败：{exc}", cmd.device.id, cmd.action)
        return HomeResult(True, f"{cmd.device.name}已{'打开' if payload == 'ON' else '关闭' if payload == 'OFF' else '下发指令'}。", cmd.device.id, cmd.action)


class Esp32Adapter(Adapter):
    """ESP32 红外网关 / 语音节点。

    红外沿用上游 `magic-scenes._tv_control` 的既有协议：`POST /api/ir/send`
    `{"device": "...", "action": "..."}`。文本推送走 Charlie 的 MQTT（若已连）。
    """

    name = "esp32"

    def execute(self, cmd: Command) -> HomeResult:
        ip = str(cmd.device.extra.get("esp32_ip") or os.environ.get("ESP32_IP") or "").strip()
        target = str(cmd.device.extra.get("ir_device") or cmd.device.kind or "tv")
        if not ip:
            return HomeResult(False, f"{cmd.device.name} 缺 esp32_ip（也没设 ESP32_IP）", cmd.device.id, cmd.action)
        if cmd.action in ("notify", "tts"):
            client, why = _mqtt_client()
            if client is None:
                return HomeResult(False, f"文本推送需要 MQTT：{why}", cmd.device.id, cmd.action)
            topic = f"charlie/esp32/{cmd.device.extra.get('device_id') or cmd.device.id}/down"
            try:
                client.publish(
                    topic,
                    json.dumps({"type": cmd.action, "text": cmd.params.get("text", "")}, ensure_ascii=False),
                    qos=1,
                )
            except Exception as exc:
                return HomeResult(False, f"ESP32 推送失败：{exc}", cmd.device.id, cmd.action)
            return HomeResult(True, f"已推送到{cmd.device.name}。", cmd.device.id, cmd.action)

        try:
            import requests  # type: ignore

            resp = requests.post(
                f"http://{ip}/api/ir/send",
                json={"device": target, "action": cmd.action},
                timeout=3,
            )
            if resp.status_code >= 400:
                return HomeResult(False, f"{cmd.device.name} 返回 HTTP {resp.status_code}", cmd.device.id, cmd.action)
        except Exception as exc:
            return HomeResult(False, f"{cmd.device.name} 不可达：{exc}", cmd.device.id, cmd.action)
        return HomeResult(True, f"{cmd.device.name}已{'打开' if cmd.action == 'on' else '关闭' if cmd.action == 'off' else '下发指令'}。", cmd.device.id, cmd.action)


_ADAPTERS: dict[str, Callable[[], Adapter]] = {
    "tuya_ir": TuyaIrAdapter,
    "tuya_cloud": TuyaCloudAdapter,
    "mqtt": MqttAdapter,
    "esp32": Esp32Adapter,
}


# ── 语句解析 ─────────────────────────────────────────────────────────


def _has(text: str, words: tuple[str, ...]) -> bool:
    return any(w in text for w in words)


def parse_action(text: str, device: Device) -> Optional[tuple[str, dict[str, Any]]]:
    """把一句话解析成 (action, params)。认不出返回 None（交给 dotd）。

    否定句 / 疑问句在这里**也**挡一次。`handle()` 已经挡过，但 `parse_action` 是
    公开函数，工具层和测试都可能直接调；只在 `handle()` 挡，等于"换个入口就能
    把「不要开灯」执行成开灯"——这类不对称正是本项目反复出过的缺陷。
    """
    if _has(text, _NEGATION) or _has(text, _QUESTION):
        return None
    if device.kind == "ac":
        if _has(text, _ACTION_OFF):
            # 关机时不要带 mode/temp —— 部分空调会把参数当成"开机到 26 度"
            return "off", {}
        temp = _TEMP.search(text)
        mode = next((v for k, v in _AC_MODES.items() if k in text), None)
        fan = next((v for k, v in _AC_FANS.items() if k in text), None)
        turning_on = _has(text, _ACTION_ON)
        if not turning_on and temp is None and mode is None and fan is None:
            return None
        params: dict[str, Any] = {}
        if mode is not None:
            params["mode"] = mode
        if temp is not None:
            t = int(temp.group(1))
            if not 16 <= t <= 30:
                return None  # 越界就当没听懂，不要发一个 45 度
            params["temp"] = t
        if fan is not None:
            params["fan"] = fan
        return "on", params

    if device.kind in ("light", "switch", "tv", "generic"):
        if _has(text, _ACTION_OFF):
            return "off", {}
        m = _BRIGHT_PCT.search(text)
        if m is not None and "brightness" in device.caps:
            pct = max(1, min(100, int(m.group(1))))
            return "set_brightness", {"brightness": pct}
        if _has(text, _ACTION_ON):
            return "on", {}
        return None

    if device.kind == "esp32":
        if _has(text, ("说话", "播报", "念一下", "通知")):
            return "tts", {}
        return None

    return None


def match_device(text: str, devices: list[Device]) -> Optional[Device]:
    """按称呼匹配设备。长词优先；同名不同房间时要求房间也出现。

    返回 None 表示"没把握"——不猜。
    """
    hits: list[tuple[int, Device]] = []
    for dev in devices:
        for term in dev.terms:
            if term and term in text:
                hits.append((len(term), dev))
                break
    if not hits:
        return None
    hits.sort(key=lambda x: x[0], reverse=True)
    top_len = hits[0][0]
    top = [d for ln, d in hits if ln == top_len]
    if len(top) == 1:
        return top[0]
    # 同长度多个：用房间消歧
    for dev in top:
        if dev.room and dev.room in text:
            return dev
    return None


# ── 控制器 ───────────────────────────────────────────────────────────


class HomeController:
    """家居控制的唯一入口。语音反射与 MCP 工具都用它。"""

    def __init__(
        self,
        devices: Optional[list[Device]] = None,
        adapters: Optional[dict[str, Adapter]] = None,
        logger: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.devices = devices if devices is not None else load_devices()
        self._adapters = adapters or {}
        self._log = logger or (lambda msg: log.info(msg))
        self.history: list[dict[str, Any]] = []

    # -- 查询 --------------------------------------------------------

    def list_devices(self) -> list[dict[str, Any]]:
        return [d.to_public() for d in self.devices]

    def find(self, name: str) -> Optional[Device]:
        """按 id / 名称 / 别名找；精确找不到再退回 `match_device`。

        2026-10-26 现场：清单里叫「客厅空调」，模型调
        `home_control(device="空调")` 得到"没有叫空调的设备"，而语音说
        「关空调」却能命中 —— 两个入口对同一句话给出不同答案，正是
        "单一事实源"要消掉的东西。精确匹配优先，模糊匹配只在唯一时生效。
        """
        low = (name or "").strip().lower()
        for d in self.devices:
            if d.id.lower() == low or d.name == name:
                return d
            if any(a == name for a in d.aliases):
                return d
        return match_device((name or "").strip(), self.devices)

    def adapter_for(self, dev: Device) -> Optional[Adapter]:
        cached = self._adapters.get(dev.adapter)
        if cached is not None:
            return cached
        factory = _ADAPTERS.get(dev.adapter)
        if factory is None:
            return None
        inst = factory()
        self._adapters[dev.adapter] = inst
        return inst

    # -- 执行 --------------------------------------------------------

    def execute(self, cmd: Command) -> HomeResult:
        adapter = self.adapter_for(cmd.device)
        if adapter is None:
            return HomeResult(False, f"未知适配器 {cmd.device.adapter}", cmd.device.id, cmd.action)
        started = time.time()
        result = adapter.execute(cmd)
        self.history.append(
            {
                "at": int(started),
                "device": cmd.device.id,
                "action": cmd.action,
                "params": cmd.params,
                "ok": result.ok,
                "durationMs": int((time.time() - started) * 1000),
            }
        )
        if len(self.history) > 200:
            del self.history[:100]
        self._log(f"[home] {cmd.device.name}.{cmd.action} → {'ok' if result.ok else 'fail'}：{result.message}")
        return result

    def handle(self, text: str) -> Optional[str]:
        """语音反射入口：能确定就执行并回一句，没把握返回 None。

        None 的含义是「交给 dotd 的模型」，不是「做不了」。
        """
        t = (text or "").strip()
        if not t or not self.devices:
            return None
        # 否定句 / 疑问句一律不碰实物（历史事故：ASR 把「你是不是把客厅空调关了」
        # 当成关机指令，空调真的被关了）。上游 device_control 有同样的守卫，
        # 这里独立再写一遍，因为反射层不经过上游。
        if _has(t, _NEGATION) or _has(t, _QUESTION):
            return None

        dev = match_device(t, self.devices)
        if dev is None:
            return None
        parsed = parse_action(t, dev)
        if parsed is None:
            return None
        action, params = parsed
        return self.execute(Command(dev, action, params)).message

    def control(
        self,
        device: str,
        action: str,
        params: Optional[dict[str, Any]] = None,
    ) -> HomeResult:
        """结构化入口（MCP 工具用）。device 可以是 id 或 name。"""
        dev = self.find(device)
        if dev is None:
            names = "、".join(d.name for d in self.devices) or "（清单为空）"
            return HomeResult(False, f"没有叫「{device}」的设备。现有：{names}")
        act = (action or "").strip().lower()
        if act in ("turn_on", "on", "open"):
            act = "on"
        elif act in ("turn_off", "off", "close"):
            act = "off"
        if act == "set_brightness":
            p = dict(params or {})
            if "brightness" not in p and "percent" in p:
                p["brightness"] = p.pop("percent")
            if "brightness" not in p:
                return HomeResult(False, "set_brightness 需要 brightness(1-100)", dev.id, act)
            return self.execute(Command(dev, act, p))
        if act in ("on", "off"):
            return self.execute(Command(dev, act, {}))
        if act == "notify" or act == "tts":
            p = dict(params or {})
            if not p.get("text"):
                return HomeResult(False, f"{act} 需要 text", dev.id, act)
            return self.execute(Command(dev, act, p))
        return HomeResult(False, f"不支持动作 {action}", dev.id, act)
