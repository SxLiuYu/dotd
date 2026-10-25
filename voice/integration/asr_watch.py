"""voice/integration/asr_watch.py —— 模型后到也能听（2026-10-25）。

## 为什么需要

Docker 首次启动时 SenseVoice 权重（237MB）是**后台**下载的（不能阻塞启动，
healthcheck 等不了）。但上游 `agent/asr_tts.py::_load_sense_voice` 只在**第一次
调用时**读 `SENSE_VOICE_MODEL`，而这个变量由 `one_system.apply_env()` 在**进程启动
时**决定成败：

    if not (target.get("SENSE_VOICE_MODEL") or "").strip():
        candidate = paths.home / "voice" / "models" / "sense-voice"
        if (candidate / "model.int8.onnx").is_file():   # ← 启动那一刻还不存在
            target["SENSE_VOICE_MODEL"] = str(candidate)

于是下载完成之前启动的容器，`SENSE_VOICE_MODEL` 是空的，上游回落到**镜像内**的
`/app/voice/charlie/models/sense-voice`（那里永远没有模型）。实测：下载完成后
`asr_race()` 仍返回 `('', 'legacy')`，必须重启容器才行 —— 而普通用户不会知道
该重启。

## 做法

一个低成本的 daemon 线程：每 15s 看一次模型在不在；出现的那一刻

1. 设 `os.environ["SENSE_VOICE_MODEL"]`；
2. 清掉上游的单例缓存 `agent.asr_tts._sense_voice_recognizer`（只清缓存，不改
   上游逻辑 —— 上游本来就"缓存为空就重试加载"，只是路径不对）；
3. 记一条 INFO，让日志能对上"从什么时候开始能听"。

看到就停，不再轮询。`ASR_WATCH_MINUTES` 控制最长看多久（默认 60 分钟，模型
237MB 在 1MB/s 下约 4 分钟，60 足够）。

## 位置

两个候选，先数据卷再源码目录：

    <home>/voice/models/sense-voice        # Docker 数据卷 / 宿主机自定义
    voice/charlie/models/sense-voice       # 宿主机默认（上游 PROJECT_DIR）

数据卷优先，这样容器重建后自动用卷里那份，不会因为镜像里残留旧模型而用错版本。
"""

from __future__ import annotations

import logging
import os
import threading
from pathlib import Path
from typing import Optional

log = logging.getLogger("magic")

POLL_SECONDS = 15.0
DEFAULT_MINUTES = 60

_started = False
_lock = threading.Lock()


def candidates(home: Path) -> list[Path]:
    """候选模型目录，按优先级。"""
    home = Path(home)
    repo_dir = Path(__file__).resolve().parent.parent / "charlie" / "models" / "sense-voice"
    return [home / "voice" / "models" / "sense-voice", repo_dir]


def resolve(home: Path) -> Optional[Path]:
    """返回第一个真的有 `model.int8.onnx` 的目录；都没有则 None。"""
    for directory in candidates(home):
        if (directory / "model.int8.onnx").is_file():
            return directory
    return None


def _reset_recognizer() -> None:
    """清上游单例缓存，让下一次 ASR 按新路径重新加载。"""
    try:
        from agent import asr_tts  # 上游模块（vendored，只改它的缓存字段）

        asr_tts._sense_voice_recognizer = None
    except Exception:  # 还没 import 过 Charlie 也没关系
        pass


def adopt(home: Path, found: Path) -> None:
    """把找到的模型告诉进程 + 清缓存。幂等。"""
    os.environ["SENSE_VOICE_MODEL"] = str(found)
    _reset_recognizer()
    log.info("[asr] SenseVoice 模型已就位，后续识别走本地：%s", found)


# 云端 ASR 需要哪些环境变量（与上游 `_ASR_PROVIDERS` 的判定一致）。
_BAIDU_KEYS = ("BAIDU_APP_ID", "BAIDU_API_KEY", "BAIDU_SECRET_KEY")


def cloud_providers(env: Optional[dict[str, str]] = None) -> list[str]:
    """已配置的云端 ASR 供应商名字。"""
    src = os.environ if env is None else env
    ok = []
    if all((src.get(k) or "").strip() for k in _BAIDU_KEYS):
        ok.append("baidu")
    if (src.get("STEPFUN_KEY") or "").strip():
        ok.append("stepfun")
    return ok


def state(home: Path, env: Optional[dict[str, str]] = None) -> dict:
    """"能不能听"的可观测状态（放进 /health）。

    2026-10-25 的教训：`/health` 里 `voice: "ok"` 是硬编码的，ASR 整条链全灭时
    它照样是 ok —— 于是所有自动检查（healthcheck、onboard、CI）都放行，设备却是聋的。
    这里只做**便宜**的判定（看文件、看环境变量），不加载模型。
    """
    src = os.environ if env is None else env
    local = resolve(home)
    cloud = cloud_providers(src)
    if (src.get("SENSE_VOICE_DISABLED") or "").strip() == "1":
        mode = "disabled"
    elif local is not None:
        mode = "local"
    elif cloud:
        mode = "cloud"
    else:
        mode = "none"
    return {
        "mode": mode,
        "model": str(local) if local is not None else None,
        "cloud": cloud,
        # 有本地模型或至少一个云端 key 才谈得上"能听"。
        "ok": mode in ("local", "cloud"),
    }


def watch_async(
    home: Path,
    *,
    minutes: int = DEFAULT_MINUTES,
    poll_seconds: float = POLL_SECONDS,
    thread_factory=None,
) -> Optional[threading.Thread]:
    """后台等模型出现；已经有了就立刻 adopt 并返回 None。"""
    global _started
    with _lock:
        if _started:
            return None
        _started = True

    found = resolve(home)
    if found is not None:
        adopt(home, found)
        return None

    if minutes <= 0:
        return None

    deadline_s = minutes * 60.0

    def _loop() -> None:
        waited = 0.0
        while waited < deadline_s:
            threading.Event().wait(poll_seconds)
            waited += poll_seconds
            found = resolve(home)
            if found is not None:
                adopt(home, found)
                return
        log.info(
            "[asr] 等了 %d 分钟仍没等到 SenseVoice 模型；下载完成后再重启一次即可加载。"
            "（模型位置：%s）",
            minutes,
            " 或 ".join(str(c) for c in candidates(home)),
        )

    make = thread_factory or threading.Thread
    th = make(target=_loop, name="asr-model-watch", daemon=True)
    th.start()
    return th


def _reset_for_tests() -> None:
    global _started
    with _lock:
        _started = False
