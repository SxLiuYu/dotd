"""voice/integration/https_sidecar.py —— 8443 的 HTTPS 副本（2026-10-25）。

## 为什么需要

`docker/compose.voice.yml` 映射了 `8443:8443`，`docs/voice-quickstart.md` 写
"只暴露 8000/8443"，上游 README 也写"手机同 WiFi 访问 https://<IP>:8443"。
但**合并后没有任何东西会去监听 8443**：

- 上游是靠 `watchdog.sh` 再拉一个 `python https_server.py` 进程；
- 合并体只跑 `one_system`（一个进程），watchdog 不再使用；
- 所以那次 `ss -ltnp` 里只有 7788/8000，8443 是文档承诺、实现缺席。

而 8443 不是装饰：手机浏览器只有在 **HTTPS** 下才给麦克风权限
（`getUserMedia` 要求 secure context），所以手机端语音必须先连上 8443。

## 做法

在 one_system 的进程里再起一个 uvicorn，复用**同一个** FastAPI app，只换端口和
TLS 证书。不改上游文件。

上游 `https_server.py` 的做法是"第二个进程 + `SKIP_BACKGROUND=1` 环境变量"，
但那招在单进程里会连**主**进程一起关掉后台调度（环境变量是进程级的）。所以这里
用 uvicorn 的 `lifespan="off"`：第二个 server 干脆不跑 lifespan，就不会重复启动
调度器 / brain 预热 / 飞书长连接 —— 这些在 8000 那个 server 里已经跑过一次。

## 证书

自签证书放**数据目录**（`<home>/voice/cert/`），不放仓库：

- `voice/charlie/cert/` 会被 `wsl-deploy.sh` 的 `rsync --delete` 删掉
  （仓库里没有这个目录）—— 和 SenseVoice 模型被删是同一类 bug；
- Docker 里 `<home>` 是 `/data` 卷，容器重建后证书还在，手机不用重新信任。

首次启动用上游的 `app.cert.ensure_cert()`（纯 Python，cryptography 或 openssl 回退）。

## 环境变量

    CHARLIE_HTTPS=0|1            默认 1；0 关掉（纯 HTTP 部署 / 没装 cryptography 的机器）
    CHARLIE_HTTPS_PORT           默认 8443（docker/*.env.example 用的名字，优先）
    ASSISTANT_KID_HTTPS_PORT     同上（上游名，兼容保留）
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger("magic")

_state: dict[str, Any] = {"state": "stopped", "port": None, "error": None}
_lock = threading.Lock()


def enabled(env: Optional[dict[str, str]] = None) -> bool:
    src = os.environ if env is None else env
    return (src.get("CHARLIE_HTTPS", "1") or "").strip().lower() not in ("0", "false", "off", "no")


def https_port(env: Optional[dict[str, str]] = None) -> int:
    """HTTPS 端口。`CHARLIE_HTTPS_PORT` 优先（docker/*.env.example 里就是这个名字），
    再退到上游的 `ASSISTANT_KID_HTTPS_PORT`。

    两个名字都得认：上游 Charlie 用后者，而 `docker/voice.cloud.env.example` 写给
    主人填的是前者 —— 之前代码只读后者，主人把 8443 改成 9443 时 compose 映射和
    进程监听就各说各话（TCP 通、没人应答）。
    """
    src = os.environ if env is None else env
    for name in ("CHARLIE_HTTPS_PORT", "ASSISTANT_KID_HTTPS_PORT"):
        raw = (src.get(name) or "").strip()
        try:
            port = int(raw)
        except ValueError:
            continue
        if 1 <= port <= 65535:
            return port
    return 8443


def cert_dir(home: Path) -> Path:
    """证书目录：`<home>/voice/cert`（数据目录，随卷持久化）。"""
    return Path(home) / "voice" / "cert"


def snapshot() -> dict[str, Any]:
    with _lock:
        return dict(_state)


def ensure_certificate(directory: Path) -> Optional[tuple[str, str]]:
    """确保自签证书存在；返回 (cert, key) 路径，失败返回 None。"""
    directory = Path(directory)
    cert = directory / "cert.pem"
    key = directory / "key.pem"
    if cert.is_file() and key.is_file():
        return str(cert), str(key)
    try:
        from app.cert import ensure_cert  # 上游实现（vendored，只读调用）

        directory.mkdir(parents=True, exist_ok=True)
        if ensure_cert(str(cert), str(key)):
            return str(cert), str(key)
    except Exception as exc:
        log.warning("[https] 证书生成失败：%s", exc)
    return None


def start(
    app: Any,
    home: Path,
    *,
    env: Optional[dict[str, str]] = None,
    thread_factory: Optional[Any] = None,
) -> Optional[threading.Thread]:
    """在后台线程里起 HTTPS server。返回线程；未启用/证书不可用时返回 None。"""
    if not enabled(env):
        with _lock:
            _state.update(state="disabled", port=None, error=None)
        log.info("[https] CHARLIE_HTTPS=0，跳过 8443")
        return None

    paths = ensure_certificate(cert_dir(home))
    if paths is None:
        with _lock:
            _state.update(state="failed", port=https_port(env), error="证书不可用")
        return None
    cert_file, key_file = paths
    port = https_port(env)

    try:
        import uvicorn

        # lifespan="off"：绝不重跑调度器/预热/飞书。见模块头注。
        config = uvicorn.Config(
            app,
            host="0.0.0.0",
            port=port,
            ssl_certfile=cert_file,
            ssl_keyfile=key_file,
            lifespan="off",
            log_level="warning",
        )
    except Exception as exc:
        with _lock:
            _state.update(state="failed", port=port, error=f"配置失败：{exc}")
        log.warning("[https] 无法创建 HTTPS server：%s", exc)
        return None

    server = uvicorn.Server(config)

    def _serve() -> None:
        with _lock:
            _state.update(state="running", port=port, error=None)
        log.info("[https] 已在 https://0.0.0.0:%d 监听（自签证书：%s）", port, cert_file)
        try:
            server.run()
        except SystemExit:
            # uvicorn 端口占用时用 sys.exit；在子线程里只终止本线程。
            with _lock:
                _state.update(state="failed", error="端口被占用或启动失败")
            log.warning("[https] %d 启动失败（端口被占用？）", port)
        except Exception as exc:
            with _lock:
                _state.update(state="failed", error=str(exc))
            log.warning("[https] HTTPS server 退出：%s", exc)
        else:
            with _lock:
                _state.update(state="stopped")

    make = thread_factory or threading.Thread
    th = make(target=_serve, name="charlie-https", daemon=True)
    th.start()
    return th
