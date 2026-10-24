"""ntfy.sh 备用通知通道

用户可自托管 ntfy 服务器，或直接用 https://ntfy.sh
发送方式: POST https://ntfy.sh/{topic} — body 为通知文本
认证(可选): Basic Auth via NTFY_AUTH 环境变量

例:
    ntfy topic: charlie-alerts
    curl -d "你好" https://ntfy.sh/charlie-alerts
"""
import os
import logging
import threading
import requests

log = logging.getLogger("magic")

NTFY_TOPIC = os.getenv("NTFY_TOPIC", "").strip()
NTFY_URL = os.getenv("NTFY_URL", "https://ntfy.sh").rstrip("/")
NTFY_AUTH = os.getenv("NTFY_AUTH", "").strip()  # "user:pass" 格式


def push_ntfy(text: str) -> bool:
    """发送通知到 ntfy topic（同步）"""
    if not NTFY_TOPIC:
        return False
    url = f"{NTFY_URL}/{NTFY_TOPIC}"
    headers = {"Content-Type": "text/plain; charset=utf-8"}
    auth = NTFY_AUTH.split(":", 1) if NTFY_AUTH else None
    try:
        r = requests.post(url, data=text.encode("utf-8"), headers=headers,
                          auth=tuple(auth) if auth else None, timeout=10)
        r.raise_for_status()
        log.info(f"[ntfy] 推送成功: {text[:40]}")
        return True
    except Exception as e:
        log.warning(f"[ntfy] 推送失败: {e}")
        return False


def push_ntfy_async(text: str):
    """异步发送（线程，不阻塞主流程）"""
    if not NTFY_TOPIC:
        return
    threading.Thread(target=push_ntfy, args=(text,), daemon=True).start()
