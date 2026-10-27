"""magic-home: 家居控制（空调/灯/插座/红外家电）的 MCP 外壳。

工具本体在 `voice/integration/home_devices.py` —— 那是家居控制的事实源，
`cortex_router` 的毫秒级反射和这里的模型工具走同一份 `HomeController`：
一张设备清单、四种适配器（涂鸦 2B 红外 / 涂鸦 2C 云 / MQTT / ESP32）。

为什么要有这一层：`agent/llm.py` 把「空调/灯/风扇」路由到 `ac-control`，
但合并后 `ac-control` 既没有文件也没有工具映射，说「开灯」必然加载失败
（见 voice/CHANGELOG.md）。这个文件补上真正的工具面，`ac-control` 保留为
别名（`agent/inproc_tools._SERVER_FILE_MAP`）。

返回一律是**能直接念给主人听的中文**，并且如实：适配器没发出去就说没发出去，
不播「已打开」。
"""
# --- MCP 元数据（供 mcp_registry 自动发现，用 ast.parse 读取，不执行文件）---
__mcp_meta__ = {
    "name": "magic-home",
    "tier": "core",
    "required_env": [],
    "label": "家居控制(空调/灯/插座/MQTT)"
}

import json
import logging
import os
import sys
import threading

from mcp.server.fastmcp import FastMCP

log = logging.getLogger("magic")
mcp = FastMCP("magic-home")

_CHARLIE_DIR = os.path.dirname(os.path.abspath(__file__))          # voice/charlie
_REPO_ROOT = os.path.dirname(os.path.dirname(_CHARLIE_DIR))        # 仓库根（voice 的父目录）

_ctrl = None
_ctrl_lock = threading.Lock()


def _home():
    """拿到 voice.integration.home_devices 模块。

    进程以 charlie/ 为 cwd 启动时，`voice` 这个命名空间包不一定在 sys.path 上，
    所以先试一次，失败再把仓库根补进去重试 —— 不改变"两个入口同一个模块对象"
    这一前提（绝不按文件路径另加载一份，否则反射层和工具层会各持一份 history）。
    """
    try:
        from voice.integration import home_devices
        return home_devices
    except ImportError:
        pass
    for cand in (_REPO_ROOT, _CHARLIE_DIR):
        if cand not in sys.path:
            sys.path.insert(0, cand)
    from voice.integration import home_devices
    return home_devices


def _controller():
    global _ctrl
    with _ctrl_lock:
        if _ctrl is None:
            _ctrl = _home().HomeController()
        return _ctrl


@mcp.tool()
def home_list() -> str:
    """列出家里登记的所有可控设备（名称/id/类型/能力）。

    用户问"家里有哪些设备/能控制什么"时调用；也用于确认某台设备到底登记了没有。
    """
    home = _home()
    ctrl = _controller()
    if not ctrl.devices:
        path = home.default_manifest_path()
        return (f"还没有登记设备。设备清单写在 {path}，"
                f"或者设 TUYA_IR_DEVICE_ID + TUYA_AC_DEVICE_ID 让空调自动登记。")
    lines = [f"登记了 {len(ctrl.devices)} 台设备："]
    for d in ctrl.devices:
        caps = "、".join(d.caps)
        room = f"，{d.room}" if d.room else ""
        lines.append(f"- {d.name}（id={d.id}，{d.kind}{room}）可：{caps}")
    return "\n".join(lines)


@mcp.tool()
def home_control(device: str, action: str, params: str = "") -> str:
    """控制一台家居设备。这是真正下发指令的入口，调用后如实转述返回结果。

    参数:
    - device: 设备名或 id（先调 home_list 确认，如"客厅灯"）
    - action: on / off / set_brightness / notify / tts
    - params: 可选 JSON 字符串。set_brightness 传 {"brightness": 1-100}；
      notify/tts 传 {"text": "要说的话"}；（空调模式/温度/风速由语音反射层
      直接解析，走这里时可用 {"mode": 0-4, "temp": 16-30, "fan": 1-3}）

    例: home_control("空调", "on", '{"mode": 0, "temp": 26}')
        home_control("客厅灯", "set_brightness", '{"brightness": 30}')
    """
    home = _home()
    ctrl = _controller()
    raw = (params or "").strip()
    parsed = {}
    if raw:
        try:
            parsed = json.loads(raw)
        except Exception:
            return f"params 需要是 JSON 对象，收到：{raw[:120]}"
        if not isinstance(parsed, dict):
            return f"params 需要是 JSON 对象，收到：{raw[:120]}"
    result = ctrl.control(device, action, parsed)
    return result.message


@mcp.tool()
def home_status(device: str = "") -> str:
    """查询最近的设备操作记录（本机内存，最近 200 条）。

    参数:
    - device: 可选，设备名或 id；留空看全部

    注意：这是"我们发过什么"，不是云端的实时状态 —— 不做状态轮询，
    避免把涂鸦云配额刷光。用户问"灯现在是开着的吗"时，如果刚操作过就答
    "刚打开"，否则建议直接说"开灯/关灯"来确保状态。
    """
    ctrl = _controller()
    dev = ctrl.find(device) if (device or "").strip() else None
    if (device or "").strip() and dev is None:
        return f"没有叫「{device}」的设备，先调 home_list 看清单。"
    rows = ctrl.history
    if dev is not None:
        rows = [h for h in rows if h.get("device") == dev.id]
    if not rows:
        return "还没有操作记录。"
    lines = []
    for h in rows[-10:]:
        lines.append(f"- {h['device']} {h['action']} "
                     f"{'成功' if h['ok'] else '失败'}（{h['durationMs']}ms）")
    return "最近的操作：\n" + "\n".join(lines)


@mcp.tool()
def home_reload() -> str:
    """重新读取设备清单（改完 home-devices.yml 后调用，不用重启服务）。"""
    global _ctrl
    with _ctrl_lock:
        _ctrl = None
    ctrl = _controller()
    if not ctrl.devices:
        return "清单里没有可用设备。"
    return f"已重新读取清单，{len(ctrl.devices)} 台设备：{'、'.join(d.name for d in ctrl.devices)}"


if __name__ == "__main__":
    mcp.run()
