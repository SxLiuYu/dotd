"""MQTT 客户端统一入口 — 委托给 mqtt_server.MqttXiaozhiServer

历史上这里是独立的 wake 信令客户端，但固件不支持 wake topic 订阅。
现在统一由 mqtt_server 管理连接，所有推送走 down topic。
"""
import logging

log = logging.getLogger("magic")


def publish_wake(device_id: str = "", reason: str = "reminder") -> bool:
    """发 MQTT 消息通知 ESP32（兼容旧调用）

    MqttProtocol 固件会订阅 down topic 并处理 tts/notify 消息。
    当前固件不支持 wake 类型，改为发一条 notification。
    """
    try:
        from app.mqtt_server import get_server
        server = get_server()
        if server is None:
            return False
        # 用 notification 代替 wake（固件 on_incoming_json 支持）
        server.push_notification(f"Charlie: {reason}")
        return True
    except Exception as e:
        log.debug(f"[mqtt] publish_wake 失败: {e}")
        return False


def is_available() -> bool:
    """MQTT 是否可用"""
    try:
        from app.mqtt_server import get_server
        return get_server() is not None
    except Exception:
        return False
