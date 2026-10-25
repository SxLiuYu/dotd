"""voice/integration/one_system.py —— 一套系统的产品壳（2026-10-23）。

## 目标

用户**只启动 Charlie**。dotd 是 Charlie 托管的子进程，不再是第二个需要单独启动、
单独配置、单独看日志的产品。

本模块做六件事（对应 docs/voice-merge-plan.md 阶段 1）：

1. **进程托管**：启动/退出/崩溃退避重启 dotd；
2. **一个健康检查**：`/health` 聚合 voice + kernel + 版本；
3. **一个配置根**：`~/.charlie`（有旧 `~/.dotd/config.yml` 时自动沿用）；
4. **一个数据根**：Charlie 写 `<home>/voice/`，dotd 写 `<home>/`；
5. **一个日志流**：dotd 的 stdout/stderr 带 `[dotd]` 前缀；
6. **一个 Web 入口**：8000 端口托管 dotd 控制台（`/console`）并反代 `/console/api/*`；
   另加启动时的 **API 版本握手**。

## 不改上游文件

`voice/charlie/` 是 vendored 上游代码，本模块不修改它；只在运行时给 FastAPI app
挂 middleware / route / static mount。

## 命令行

    python -m voice.integration.one_system --check          # 只体检，不起服务
    python -m voice.integration.one_system                  # 启动 Charlie + dotd
    python -m voice.integration.one_system --no-kernel      # 只起 Charlie（调试用）
    python -m voice.integration.one_system --proxy-only --port 8001 --dotd-port 7788
                                                           # 只起代理（测试用）
"""

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

# 与 dotd /api/health 的 apiVersion 对齐。不兼容就拒绝启动，别让两个版本互相猜。
KERNEL_API_VERSION = 1

REPO_ROOT = Path(__file__).resolve().parents[2]
VOICE_DIR = REPO_ROOT / "voice"
CHARLIE_DIR = VOICE_DIR / "charlie"
DOTD_DIST = REPO_ROOT / "web-ui" / "dist"

RESTART_BACKOFF_S = (1, 2, 5, 10, 30)
HEALTH_POLL_S = 2.0
READY_TIMEOUT_S = 30.0
STOP_TIMEOUT_S = 10.0


# ─────────────────────────────────────────────────────────────────────
# 路径 / 配置
# ─────────────────────────────────────────────────────────────────────


@dataclass
class Paths:
    home: Path
    config_dir: Path
    config_file: Path
    voice_data: Path

    def as_dict(self) -> dict[str, str]:
        return {
            "home": str(self.home),
            "configDir": str(self.config_dir),
            "configFile": str(self.config_file),
            "voiceData": str(self.voice_data),
        }


def resolve_paths(env: Optional[dict[str, str]] = None) -> Paths:
    """一个配置/数据根。

    优先级：CHARLIE_HOME > DOTD_HOME > 已有 ~/.charlie/config.yml > 已有 ~/.dotd/config.yml
    > 默认 ~/.charlie。旧用户不会被强制搬家。
    """
    e = env if env is not None else os.environ
    home_env = (e.get("CHARLIE_HOME") or e.get("DOTD_HOME") or "").strip()
    if home_env:
        home = Path(home_env).expanduser().resolve()
    else:
        charlie_home = (Path.home() / ".charlie").resolve()
        dotd_home = (Path.home() / ".dotd").resolve()
        if (charlie_home / "config.yml").is_file():
            home = charlie_home
        elif (dotd_home / "config.yml").is_file():
            home = dotd_home
        else:
            home = charlie_home
    config_file = Path(e.get("DOTD_CONFIG") or (home / "config.yml")).expanduser().resolve()
    config_dir = Path(e.get("DOTD_CONFIG_DIR") or config_file.parent).expanduser().resolve()
    voice_data = Path(e.get("CHARLIE_DATA_DIR") or (home / "voice")).expanduser().resolve()
    return Paths(home=home, config_dir=config_dir, config_file=config_file, voice_data=voice_data)


def load_env_file(path: Path) -> dict[str, str]:
    """读 tokens.env 这类 KEY=VALUE 文件；不覆盖已有环境变量。"""
    out: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return out
    for raw in text.splitlines():
        line = raw.strip().lstrip("\ufeff")
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in out:
            out[key] = value
    return out


def _expand_env(value: str, env: dict[str, str]) -> str:
    return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", lambda m: env.get(m.group(1), ""), value)


def resolve_master_token(paths: Paths, env: Optional[dict[str, str]] = None) -> Optional[str]:
    e = dict(env if env is not None else os.environ)
    # tokens.env 是 init-config 的标准产物
    for candidate in (paths.home / "tokens.env", paths.config_dir / "tokens.env"):
        for k, v in load_env_file(candidate).items():
            e.setdefault(k, v)
    token = (e.get("DOTD_MASTER_TOKEN") or "").strip()
    if token:
        return token
    # 旧版 init-config 产物：home/master_token 单文件
    for candidate in (paths.home / "master_token", paths.config_dir / "master_token"):
        try:
            literal = candidate.read_text(encoding="utf-8").strip().lstrip("\ufeff")
        except OSError:
            continue
        if literal:
            return literal
    # config.yml 里可能是字面量，也可能是 ${DOTD_MASTER_TOKEN}
    try:
        text = paths.config_file.read_text(encoding="utf-8")
    except OSError:
        return None
    m = re.search(r"(?m)^\s*master_token\s*:\s*(.+?)\s*$", text)
    if m is None:
        return None
    raw = m.group(1).strip().strip('"').strip("'")
    return _expand_env(raw, e).strip() or None


def resolve_http_port(paths: Paths, env: Optional[dict[str, str]] = None) -> int:
    e = env if env is not None else os.environ
    raw = (e.get("DOTD_HTTP_PORT") or "").strip()
    if raw.isdigit():
        return int(raw)
    try:
        text = paths.config_file.read_text(encoding="utf-8")
    except OSError:
        return 7788
    try:
        import yaml  # type: ignore

        data = yaml.safe_load(text)
        if isinstance(data, dict):
            surfaces = data.get("surfaces")
            http = surfaces.get("http") if isinstance(surfaces, dict) else None
            if isinstance(http, dict) and isinstance(http.get("port"), int):
                return int(http["port"])
            if isinstance(http, dict) and str(http.get("port", "")).isdigit():
                return int(http["port"])
    except Exception:
        pass
    # 无 PyYAML 时的窄回退：只找 surfaces.http 段。
    # 注意 `[^\n]*\n` 而不是 `\s*`：后者会把下一行的缩进一起吃掉，
    # 导致 `^\s+http` 永远匹配不上（CI 没装 PyYAML 时暴露）。
    m = re.search(r"(?ms)^surfaces\s*:[^\n]*\n(.*?)(?=^\S|\Z)", text)
    if m is not None:
        hm = re.search(r"(?ms)^\s*http\s*:[^\n]*\n(.*?)(?=^\s{0,2}\w+\s*:|\Z)", m.group(1))
        if hm is not None:
            pm = re.search(r"(?m)^\s+port\s*:\s*(\d+)", hm.group(1))
            if pm is not None:
                return int(pm.group(1))
    return 7788


def apply_env(paths: Paths, env: Optional[dict[str, str]] = None) -> None:
    """把一套系统的根写进进程环境；在 import Charlie 之前调用。"""
    target = os.environ if env is None else env
    for key, value in load_env_file(paths.home / "tokens.env").items():
        target.setdefault(key, value)
    target.setdefault("DOTD_HOME", str(paths.home))
    target.setdefault("DOTD_CONFIG_DIR", str(paths.config_dir))
    target.setdefault("DOTD_CONFIG", str(paths.config_file))
    target.setdefault("ASSISTANT_KID_DATA_DIR", str(paths.voice_data))
    target.setdefault("CHARLIE_HOME", str(paths.home))
    # TTS 供应商顺序（2026-10-25）。
    #
    # 上游默认是 "audio8,baidu,stepfun,finna"，四个**全都**需要额外前提：
    #   - audio8：本地 8024 的 ONNX 服务（要单独起，还要先注册声音）
    #   - baidu：BAIDU_APP_ID/KEY/SECRET
    #   - stepfun：STEPFUN_KEY
    #   - finna：FINNA_API_KEY
    # 新机器上四个全灭 → 每句都先把四个试一遍（audio8 三次重连约 4s）再抛
    # TTSUnavailableError，然后 120s 全局熔断。启动时的 `[tts-warm]` 就是这么
    # 0/3 的。而上游注册表里其实有 **edge**（微软免费接口，无需任何 key，
    # 首包约 0.5s），只是没排进默认链路 —— 这是"能出声却不出声"的根因。
    #
    # 所以把 edge 排第一做兜底：开箱即有声。想要 audio8 的音色克隆或付费音色
    # 的主人，显式设 TTS_PRIORITY 覆盖即可（setdefault 完全尊重已有值）。
    target.setdefault("TTS_PRIORITY", "edge,audio8,baidu,stepfun,finna")


# ─────────────────────────────────────────────────────────────────────
# dotd 子进程
# ─────────────────────────────────────────────────────────────────────


def backoff_for(attempt: int) -> int:
    """第 n 次重启前等几秒；attempt 从 0 开始。"""
    if attempt < 0:
        attempt = 0
    return RESTART_BACKOFF_S[min(attempt, len(RESTART_BACKOFF_S) - 1)]


# ─────────────────────────────────────────────────────────────────────
# 阶段 2：本机在 dotd 里的设备身份
# ─────────────────────────────────────────────────────────────────────


def device_env_path(paths: Paths) -> Path:
    return paths.voice_data / "device.env"


def provision_device(
    paths: Paths,
    master_token: str,
    dotd_port: int,
    name: Optional[str] = None,
    env: Optional[dict[str, str]] = None,
) -> Optional[dict[str, str]]:
    """确保这台机器在 dotd 的 devices 表里有一个身份。

    顺序：显式环境变量 → `voice/device.env` → 现场创建一个（写回 device.env）。
    返回要注入进程环境的三项；dotd 不可达/鉴权失败时返回 None（调用方退回 master，
    并在下一次启动时重试创建）。
    """
    e = env if env is not None else os.environ
    base = f"http://127.0.0.1:{dotd_port}"
    token = (e.get("DOTD_DEVICE_TOKEN") or "").strip()
    device_id = (e.get("DOTD_DEVICE_ID") or "").strip()
    if token:
        out = {"DOTD_BASE_URL": base, "DOTD_DEVICE_TOKEN": token}
        if device_id:
            out["DOTD_DEVICE_ID"] = device_id
        return out

    path = device_env_path(paths)
    stored = load_env_file(path)
    if (stored.get("DOTD_DEVICE_TOKEN") or "").strip():
        out = {
            "DOTD_BASE_URL": base,
            "DOTD_DEVICE_TOKEN": stored["DOTD_DEVICE_TOKEN"].strip(),
        }
        if (stored.get("DOTD_DEVICE_ID") or "").strip():
            out["DOTD_DEVICE_ID"] = stored["DOTD_DEVICE_ID"].strip()
        return out

    label = name or _hostname()
    body = json.dumps({"name": label[:64]}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{base}/api/devices",
        data=body,
        method="POST",
        headers={
            "authorization": f"Bearer {master_token}",
            "content-type": "application/json; charset=utf-8",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=5.0) as res:
            payload = json.loads(res.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, OSError):
        return None
    dev_token = payload.get("token") if isinstance(payload, dict) else None
    device_id = payload.get("id") if isinstance(payload, dict) else None
    if not isinstance(dev_token, str) or not isinstance(device_id, str):
        return None

    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(
                "# 由 Charlie 首次启动自动创建；删掉这一行会在下次启动时重新注册一台设备。\n"
                f"DOTD_DEVICE_ID={device_id}\n"
                f"DOTD_DEVICE_TOKEN={dev_token}\n"
            )
    except OSError:
        # 写不下来也要能用：至少本轮跑得起来，下次再建一台。
        pass
    return {"DOTD_BASE_URL": base, "DOTD_DEVICE_ID": device_id, "DOTD_DEVICE_TOKEN": dev_token}


def _hostname() -> str:
    try:
        import socket

        return socket.gethostname() or "charlie-host"
    except Exception:
        return "charlie-host"


def dotd_command(repo_root: Path = REPO_ROOT) -> list[str]:
    node = shutil.which("node") or "node"
    dist = repo_root / "dist" / "daemon.js"
    if dist.is_file():
        return [node, str(dist)]
    return [node, "--import", "tsx", str(repo_root / "src" / "daemon.ts")]


@dataclass
class KernelSnapshot:
    state: str = "stopped"  # stopped|starting|running|offline|incompatible|disabled
    pid: Optional[int] = None
    restarts: int = 0
    last_health: Optional[dict[str, Any]] = None
    last_error: Optional[str] = None
    api_version: Optional[int] = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "pid": self.pid,
            "restarts": self.restarts,
            "apiVersion": self.api_version,
            "lastError": self.last_error,
            "health": self.last_health,
        }


class KernelSupervisor:
    """托管 dotd：启动、探活、崩溃退避重启、退出清理。"""

    def __init__(
        self,
        paths: Paths,
        port: int,
        token: str,
        *,
        log: Callable[[str], None] = lambda s: print(s, flush=True),
        command: Optional[list[str]] = None,
        external: bool = False,
    ) -> None:
        self.paths = paths
        self.port = port
        self.token = token
        self.log = log
        self.command = command or dotd_command()
        self.external = external
        self._proc: Optional[subprocess.Popen[str]] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._snapshot = KernelSnapshot()
        self._lock = threading.Lock()

    # ── 公开状态 ───────────────────────────────────────────────────

    def snapshot(self) -> KernelSnapshot:
        with self._lock:
            return KernelSnapshot(**self._snapshot.__dict__)

    def aggregate_health(self) -> dict[str, Any]:
        snap = self.snapshot()
        kernel_ok = snap.state == "running" and snap.api_version == KERNEL_API_VERSION
        if snap.state == "disabled":
            status = "disabled"
        elif kernel_ok:
            status = "ok"
        elif snap.state == "incompatible":
            status = "incompatible"
        else:
            status = "offline"
        return {
            "ok": status in ("ok", "disabled"),
            "service": "charlie",
            "product": "charlie+dotd",
            "voice": "ok",
            "kernel": status,
            "kernelDetail": snap.as_dict(),
            "apiVersion": KERNEL_API_VERSION,
            "at": int(time.time() * 1000),
        }

    # ── 生命周期 ───────────────────────────────────────────────────

    def start(self) -> None:
        if self.external:
            # 复用已在跑的 dotd：只探活/校验版本，不托管进程
            self._snapshot.state = "starting"
            self._poll_once()
            if self._snapshot.state == "running":
                self.log("[one-system] 复用已运行的 dotd")
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run_loop, name="dotd-supervisor", daemon=True)
        self._thread.start()

    def wait_ready(self, timeout_s: float = READY_TIMEOUT_S) -> bool:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            snap = self.snapshot()
            if snap.state in ("running", "incompatible"):
                return snap.state == "running"
            if snap.state == "disabled":
                return True
            time.sleep(0.2)
        return False

    def stop(self) -> None:
        self._stop.set()
        proc = self._proc
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
                proc.wait(timeout=STOP_TIMEOUT_S)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
        with self._lock:
            self._snapshot.state = "stopped"
            self._snapshot.pid = None

    # ── 内部 ───────────────────────────────────────────────────────

    def _run_loop(self) -> None:
        attempt = 0
        healthy_since: Optional[float] = None
        while not self._stop.is_set():
            if self._proc is None or self._proc.poll() is not None:
                if self._proc is not None:
                    code = self._proc.poll()
                    with self._lock:
                        self._snapshot.state = "offline"
                        self._snapshot.pid = None
                        self._snapshot.last_error = f"dotd 退出 code={code}"
                    self.log(f"[one-system] dotd 退出 code={code}，{backoff_for(attempt)}s 后重启")
                    if self._stop.wait(backoff_for(attempt)):
                        break
                    attempt += 1
                    with self._lock:
                        self._snapshot.restarts += 1
                if not self._spawn():
                    if self._stop.wait(backoff_for(attempt)):
                        break
                    attempt += 1
                    continue
                with self._lock:
                    self._snapshot.state = "starting"
                    restarted = self._snapshot.restarts
                if restarted > 0:
                    # 阶段 1 验收要求日志里能一眼看到"拉起来了"（不是只有"退出了"）。
                    self.log(f"[one-system] dotd restarted（累计 {restarted} 次）")
            self._poll_once()
            if self._snapshot.state == "running":
                if healthy_since is None:
                    healthy_since = time.monotonic()
                    attempt = 0
                elif time.monotonic() - healthy_since > 60:
                    attempt = 0
            else:
                healthy_since = None
            self._stop.wait(HEALTH_POLL_S)

    def _spawn(self) -> bool:
        env = dict(os.environ)
        env["DOTD_HOME"] = str(self.paths.home)
        env["DOTD_CONFIG_DIR"] = str(self.paths.config_dir)
        env["DOTD_CONFIG"] = str(self.paths.config_file)
        env["DOTD_MASTER_TOKEN"] = self.token
        try:
            self._proc = subprocess.Popen(
                self.command,
                cwd=str(REPO_ROOT),
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
        except OSError as exc:
            with self._lock:
                self._snapshot.last_error = f"启动 dotd 失败：{exc}"
            self.log(f"[one-system] 启动 dotd 失败：{exc}")
            return False
        with self._lock:
            self._snapshot.pid = self._proc.pid
        self.log(f"[one-system] dotd 已启动 pid={self._proc.pid} cmd={' '.join(self.command)}")
        if self._proc.stdout is not None:
            threading.Thread(target=self._pump_logs, args=(self._proc.stdout,), daemon=True).start()
        return True

    def _pump_logs(self, stream: Any) -> None:
        try:
            for line in stream:
                self.log(f"[dotd] {line.rstrip()}")
        finally:
            try:
                stream.close()
            except Exception:
                pass

    def _poll_once(self) -> None:
        try:
            req = urllib.request.Request(
                f"http://127.0.0.1:{self.port}/api/health",
                headers={"authorization": f"Bearer {self.token}", "accept": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=3.0) as res:
                body = json.loads(res.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError, OSError) as exc:
            with self._lock:
                if self._snapshot.state != "incompatible":
                    self._snapshot.state = "offline"
                self._snapshot.last_error = f"探活失败：{exc}"
            return
        version = body.get("apiVersion") if isinstance(body, dict) else None
        with self._lock:
            self._snapshot.last_health = body if isinstance(body, dict) else None
            self._snapshot.api_version = version if isinstance(version, int) else None
            self._snapshot.last_error = None
            if isinstance(version, int) and version != KERNEL_API_VERSION:
                self._snapshot.state = "incompatible"
                self._snapshot.last_error = (
                    f"dotd apiVersion={version}，Charlie 需要 {KERNEL_API_VERSION}；"
                    f"升级内核：git pull && npm ci（或回退 Charlie 到匹配版本）"
                )
            else:
                self._snapshot.state = "running"


# ─────────────────────────────────────────────────────────────────────
# FastAPI 壳：/health 聚合 + /console 控制台 + /console/api 反代
# ─────────────────────────────────────────────────────────────────────


def install_one_system(
    app: Any,
    supervisor: KernelSupervisor,
    token: str,
    dotd_port: int,
    *,
    install_cortex: bool = True,
) -> None:
    """把一套系统的三件事挂到现有 Charlie FastAPI app 上。"""
    from fastapi import Request
    from fastapi.responses import JSONResponse, StreamingResponse
    from starlette.background import BackgroundTask

    @app.middleware("http")
    async def _one_system_health(request: Request, call_next):  # type: ignore[no-untyped-def]
        if request.url.path in ("/health", "/healthz"):
            payload = supervisor.aggregate_health()
            return JSONResponse(payload, status_code=200 if payload["ok"] else 503)
        return await call_next(request)

    if DOTD_DIST.is_dir():
        from starlette.staticfiles import StaticFiles

    # 阶段 2：反射留在 Charlie，其余交给 dotd。只在真正跑 Charlie 时装
    # （代理壳/单测不 import upstream，装不上会静默跳过）。
    if install_cortex:
        try:
            from voice.integration.cortex_router import install as install_cortex_router

            install_cortex_router(logger=lambda msg: print(msg, file=sys.stderr))
        except Exception as exc:  # 包括 ImportError：Charlie 没在 sys.path 上
            print(f"[cortex] 未接管：{exc}", file=sys.stderr)

    import httpx

    async def _proxy(request: Request, path: str):  # type: ignore[no-untyped-def]
        headers = {
            k: v
            for k, v in request.headers.items()
            if k.lower() in ("accept", "content-type", "last-event-id", "x-dotd-nonce", "x-dotd-timestamp", "x-dotd-signature")
        }
        headers["authorization"] = f"Bearer {token}"
        params = [(k, v) for k, v in request.query_params.multi_items() if k != "token"]
        body = await request.body()
        client = httpx.AsyncClient(timeout=None)
        try:
            upstream = client.build_request(
                request.method,
                f"http://127.0.0.1:{dotd_port}/api/{path}",
                headers=headers,
                params=params,
                content=body,
            )
            resp = await client.send(upstream, stream=True)
        except Exception as exc:
            await client.aclose()
            return JSONResponse(
                {"error": "kernel_unreachable", "message": f"dotd 不可达：{exc}"},
                status_code=502,
            )

        out_headers = {
            k: v
            for k, v in resp.headers.items()
            if k.lower() in ("content-type", "cache-control", "last-event-id", "x-accel-buffering")
        }

        async def _close() -> None:
            await resp.aclose()
            await client.aclose()

        return StreamingResponse(
            resp.aiter_raw(),
            status_code=resp.status_code,
            headers=out_headers,
            background=BackgroundTask(_close),
        )

    app.add_api_route(
        "/console/api/{path:path}",
        _proxy,
        methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        include_in_schema=False,
    )

    # 静态挂载必须在 API 路由之后：Starlette 按注册顺序匹配，
    # 先挂 StaticFiles 会把 /console/api/* 一并吃掉（实测 404）。
    if DOTD_DIST.is_dir():
        from starlette.staticfiles import StaticFiles

        app.mount("/console", StaticFiles(directory=str(DOTD_DIST), html=True), name="dotd-console")


def create_proxy_app(token: str, dotd_port: int, supervisor: Optional[KernelSupervisor] = None):
    """测试/独立代理用的最小 app（不 import Charlie）。"""
    from fastapi import FastAPI

    class _StubSupervisor:
        def aggregate_health(self) -> dict[str, Any]:
            return {
                "ok": True,
                "service": "charlie",
                "product": "charlie+dotd",
                "voice": "ok",
                "kernel": "proxy-only",
                "apiVersion": KERNEL_API_VERSION,
            }

    app = FastAPI(title="one-system-proxy")
    # 代理壳不跑 Charlie，也不能 import upstream：显式关掉皮层接管。
    install_one_system(
        app, supervisor or _StubSupervisor(), token, dotd_port, install_cortex=False
    )  # type: ignore[arg-type]
    return app


# ─────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────


def _check(paths: Paths, token: Optional[str], port: int) -> dict[str, Any]:
    node = shutil.which("node")
    console = (DOTD_DIST / "index.html").is_file()
    return {
        "ok": paths.config_file.is_file() and token is not None and node is not None,
        "home": str(paths.home),
        "config": str(paths.config_file),
        "configExists": paths.config_file.is_file(),
        "token": "set" if token else "missing",
        "voiceData": str(paths.voice_data),
        "dotdPort": port,
        "node": node or "missing",
        "consoleBuilt": console,
        "dotdCommand": dotd_command(),
        "apiVersion": KERNEL_API_VERSION,
    }


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Charlie 一套系统启动器")
    parser.add_argument("--check", action="store_true", help="只体检，不起服务")
    parser.add_argument("--no-kernel", action="store_true", help="不托管 dotd（调试 Charlie）")
    parser.add_argument("--external-kernel", action="store_true", help="复用已运行的 dotd")
    parser.add_argument("--proxy-only", action="store_true", help="只起 /health + /console 代理（测试）")
    parser.add_argument("--port", type=int, help="Charlie/代理监听端口")
    parser.add_argument("--dotd-port", type=int, help="dotd 端口（默认读 config 或 7788）")
    parser.add_argument("--token", help="master token（默认读环境/tokens.env/config）")
    args = parser.parse_args(argv)

    paths = resolve_paths()
    token = args.token or resolve_master_token(paths)
    dotd_port = args.dotd_port or resolve_http_port(paths)

    if args.check:
        info = _check(paths, token, dotd_port)
        print(json.dumps(info, ensure_ascii=False, indent=2))
        return 0 if info["ok"] else 1

    if token is None:
        print(
            "缺少 dotd master token：设置 DOTD_MASTER_TOKEN，或把 tokens.env / config.yml 放到 "
            f"{paths.home}（当前配置 {paths.config_file}）",
            file=sys.stderr,
        )
        return 2

    apply_env(paths)

    import uvicorn

    if args.proxy_only:
        port = args.port or 8001
        app = create_proxy_app(token, dotd_port)
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
        return 0

    sup = KernelSupervisor(
        paths,
        dotd_port,
        token,
        external=args.external_kernel,
    )
    if not args.no_kernel:
        sup.start()
        ready = sup.wait_ready()
        if not ready:
            snap = sup.snapshot()
            print(
                f"dotd 未能就绪（state={snap.state}）：{snap.last_error or '未知原因'}；"
                "Charlie 仍会启动，但任务会明确报『大脑离线』",
                file=sys.stderr,
            )
        elif sup.snapshot().state == "incompatible":
            print(sup.snapshot().last_error or "dotd 版本不兼容", file=sys.stderr)
            sup.stop()
            return 3

    # 阶段 2：给本机一个设备身份（这样语音任务在凭证里能回答「哪台设备」）。
    # dotd 没就绪也继续：下面用 master 建桥，桥会明确回「大脑不在线」，而不是让 Charlie
    # 自己的 LLM 悄悄接管。
    device_env = provision_device(paths, token, dotd_port)
    if device_env is not None:
        os.environ.update(device_env)
    else:
        os.environ.setdefault("DOTD_BASE_URL", f"http://127.0.0.1:{dotd_port}")
        os.environ.setdefault("DOTD_TOKEN", token)

    # 现在才 import Charlie：它依赖 cwd/sys.path 和上面的环境变量
    sys.path.insert(0, str(CHARLIE_DIR))
    os.chdir(CHARLIE_DIR)

    # 必须在 import Charlie 之前：opuslib 找不到 libopus 时抛的是 Exception
    # （不是 ImportError），上游的 except ImportError 兜不住，进程会在 import
    # 阶段直接死掉。这里先把 PyAV 自带的 libopus 接上（见 opus_runtime 注释）。
    from voice.integration.opus_runtime import ensure_opus_library

    ensure_opus_library()

    # 飞书事件订阅归 dotd（`src/surfaces/feishu-ws.ts` 用同一个应用建长连接）。
    # Charlie 自带一份 `feishu_ws.start()`，一份应用两条长连接会让同一条消息事件
    # 被处理两次；且上游 `_started` 在线程死后不复位，watchdog 每 60s 空喊"重启"。
    # 这里在 import Charlie 之前打补丁：默认关，`CHARLIE_FEISHU_WS=1` 才开。
    try:
        from voice.integration import feishu_gate

        feishu_gate.install()
    except Exception as exc:  # 闸门是安全项，装不上要说出来
        print(f"[one-system] 飞书闸门未装上：{exc}", file=sys.stderr)

    # 设备播报链的免费兜底（2026-10-25）：`app.xiaozhi_ws._synth_mp3` 自带一套
    # baidu → finna → stepfun → macOS `say`，既不看 TTS_PRIORITY 也不含 edge。
    # 没配 key 的机器上设备一句都说不出话，而 [tts-warm] 却是 3/3 —— 两道门
    # 各查各的。这里给它补上"上游全灭 → Edge"，不改上游文件。
    #
    # 必须在 `import voice_server` **之前**装：voice_server 在 import 期就调
    # `register_xiaozhi_routes(app)`，那里会立刻起 `_prewarm_hints` 线程去合成
    # 第一条话术。补丁晚一步，那条就必然落到"没 key 的四连败"上
    # （实测首句仍报 `no TTS available`，后面三句才走 Edge）。
    try:
        from voice.integration import tts_edge_fallback

        tts_edge_fallback.install()
    except Exception as exc:
        print(f"[one-system] Edge 兜底未装上：{exc}", file=sys.stderr)

    import voice_server  # noqa: E402

    # 固定话术的 TTS 预热（2026-10-24）：让「嗯嗯，我在。」这类每次重复的短句
    # 在启动阶段就进缓存，避免第一句话多等 1.1 s 的 Edge TTS 首包。
    # 守护线程，失败只记日志；DOTD_TTS_WARM=0 可关。
    try:
        from voice.integration.tts_warm import warm_async

        warm_async()
    except Exception as exc:  # 预热是增强项，绝不能影响启动
        print(f"[one-system] TTS 预热未启动：{exc}", file=sys.stderr)

    install_one_system(voice_server.app, sup, token, dotd_port)

    port = args.port or voice_server.http_port()
    try:
        uvicorn.run(voice_server.app, host="0.0.0.0", port=port)
    finally:
        sup.stop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
