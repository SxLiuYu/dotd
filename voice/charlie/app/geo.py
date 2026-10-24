"""IP 地理定位 — ip-api.com 免费API（无需 Key）

http://ip-api.com/json/{ip}
中国可直连，15k/hour 限流，返回国家/城市/经纬度。
"""
import logging, requests

log = logging.getLogger("magic")


def locate(ip: str = "") -> dict:
    """IP 定位。ip 留空查当前出口 IP。

    返回 {"ip", "country", "country_code", "region", "city", "lat", "lon", "timezone"}
    """
    try:
        url = f"http://ip-api.com/json/{ip}" if ip else "http://ip-api.com/json/"
        r = requests.get(url, params={"lang": "zh-CN"}, timeout=10)
        data = r.json()
        if data.get("status") == "success":
            return {
                "ip": data.get("query", ""),
                "country": data.get("country", ""),
                "country_code": data.get("countryCode", ""),
                "region": data.get("regionName", ""),
                "city": data.get("city", ""),
                "lat": data.get("lat", 0),
                "lon": data.get("lon", 0),
                "timezone": data.get("timezone", ""),
                "isp": data.get("isp", ""),
            }
    except Exception as e:
        log.debug(f"[geo] IP定位失败: {e}")
    return {}


def locate_text(ip: str = "") -> str:
    """格式化输出定位信息"""
    info = locate(ip)
    if not info:
        return "IP定位失败"
    parts = [f"IP: {info['ip']}"]
    if info.get("city"):
        parts.append(f"位置: {info['country']} {info['region']} {info['city']}")
    elif info.get("country"):
        parts.append(f"位置: {info['country']}")
    if info.get("lat"):
        parts.append(f"经纬度: {info['lat']}, {info['lon']}")
    if info.get("isp"):
        parts.append(f"ISP: {info['isp']}")
    return "，".join(parts)
