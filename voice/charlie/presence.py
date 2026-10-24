"""presence: 跨设备存在检测 — 网络层面检测手机等设备

检测方式:
1. ARP 表扫描 — 检查已知手机 MAC 地址是否在本地 ARP 表中
2. Ping 检测 — 检查已知手机 IP 是否可达
3. 综合判断 — 多信号融合，返回"在家"置信度

集成:
- 在 voice_agent.py 的 _infer_user_state() 中调用
- 作为位置数据的补充 (当 GPS 不可用时)
"""
import os
import subprocess
import time
import threading
import logging
import re

log = logging.getLogger("magic")

# 已知设备列表 (从 .env 或配置文件读取)
# 格式: {"name": "手机", "mac": "xx:xx:xx:xx:xx:xx", "ip": "192.168.1.x"}
_KNOWN_DEVICES = []

# 上次检测结果缓存
_cache = {"at_home": None, "devices": {}, "timestamp": 0}
_cache_lock = threading.Lock()
_CACHE_TTL = 30  # 缓存 30 秒


def _load_known_devices() -> list:
    """从 .env 加载已知设备列表"""
    from dotenv import load_dotenv
    load_dotenv()
    devices_str = os.environ.get("KNOWN_DEVICES", "")
    if not devices_str:
        return []
    devices = []
    for dev_str in devices_str.split(","):
        dev_str = dev_str.strip()
        if "=" in dev_str:
            parts = dict(p.split("=", 1) for p in dev_str.split(";") if "=" in p)
            devices.append({
                "name": parts.get("name", "unknown"),
                "mac": parts.get("mac", "").lower(),
                "ip": parts.get("ip", ""),
            })
    return devices


def _get_arp_table() -> dict:
    """获取系统 ARP 表，返回 {mac: ip}"""
    try:
        if os.name == 'nt':  # Windows
            result = subprocess.run(['arp', '-a'], capture_output=True, text=True, timeout=10)
            output = result.stdout
        else:  # macOS / Linux
            result = subprocess.run(['arp', '-a'], capture_output=True, text=True, timeout=10)
            output = result.stdout
        arp_map = {}
        # macOS: ? (192.168.1.1) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]
        # Linux: 192.168.1.1 ether aa:bb:cc:dd:ee:ff C wlan0
        for line in output.splitlines():
            match = re.search(r'([\da-f]{2}:[\da-f]{2}:[\da-f]{2}:[\da-f]{2}:[\da-f]{2}:[\da-f]{2})', line.lower())
            ip_match = re.search(r'(\d+\.\d+\.\d+\.\d+)', line)
            if match and ip_match:
                arp_map[match.group(1)] = ip_match.group(1)
        return arp_map
    except Exception as e:
        log.debug(f"[presence] ARP 表读取失败: {e}")
        return {}


def _ping_device(ip: str, timeout: int = 3) -> bool:
    """ping 检测 IP 是否可达（跨平台参数）"""
    try:
        if os.name == 'nt':  # Windows: -n 次数, -w 毫秒
            cmd = ['ping', '-n', '1', '-w', str(timeout * 1000), ip]
        else:                # Unix: -c 次数, -W 秒
            cmd = ['ping', '-c', '1', '-W', str(timeout), ip]
        result = subprocess.run(cmd, capture_output=True, timeout=timeout + 5)
        return result.returncode == 0
    except Exception:
        return False


def detect_devices() -> dict:
    """检测已知设备是否在家，返回结果缓存"""
    now = time.time()
    with _cache_lock:
        if _cache["at_home"] is not None and now - _cache["timestamp"] < _CACHE_TTL:
            return _cache

    global _KNOWN_DEVICES
    if not _KNOWN_DEVICES:
        _KNOWN_DEVICES = _load_known_devices()
        if not _KNOWN_DEVICES:
            _cache["at_home"] = None
            _cache["devices"] = {}
            _cache["timestamp"] = now
            return _cache

    arp_map = _get_arp_table()
    results = {}
    any_present = False

    for dev in _KNOWN_DEVICES:
        name = dev["name"]
        mac = dev["mac"]
        ip = dev["ip"]
        found = False

        # 方法 1: ARP 表检测
        if mac and mac in arp_map:
            found = True
            log.debug(f"[presence] {name} 在 ARP 表中: mac={mac} ip={arp_map[mac]}")

        # 方法 2: Ping 检测
        if ip and not found:
            if _ping_device(ip):
                found = True
                log.debug(f"[presence] {name} ping 通: ip={ip}")

        results[name] = {"present": found, "mac": mac, "ip": ip}
        if found:
            any_present = True

    at_home = any_present if _KNOWN_DEVICES else None

    with _cache_lock:
        _cache["at_home"] = at_home
        _cache["devices"] = results
        _cache["timestamp"] = now

    return _cache


def is_device_present(device_name: str) -> bool:
    """检查指定设备是否在家"""
    result = detect_devices()
    if device_name in result["devices"]:
        return result["devices"][device_name]["present"]
    return False


def get_presence_confidence() -> float:
    """返回存在检测置信度 (0-1)"""
    result = detect_devices()
    if result["at_home"] is None:
        return 0.0  # 无设备配置
    devices = result["devices"]
    if not devices:
        return 0.0
    present = sum(1 for d in devices.values() if d["present"])
    return present / len(devices)


def presence_status() -> dict:
    """返回存在检测状态 (供 API 使用)"""
    result = detect_devices()
    devices_str = os.environ.get("KNOWN_DEVICES", "")
    return {
        "at_home": result["at_home"],
        "confidence": get_presence_confidence(),
        "devices": result["devices"],
        "configured": bool(_KNOWN_DEVICES),
        "cache_age": time.time() - result["timestamp"],
    }
