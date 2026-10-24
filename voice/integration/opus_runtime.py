"""voice/integration/opus_runtime.py —— 让 opuslib 在没装系统 libopus 的机器上也能用。

为什么需要（2026-10-24 实测踩到）：

    `pip install opuslib` 装的是 ctypes 绑定，**不含** libopus 本体。找不到时
    opuslib 在 import 阶段抛的是 `Exception("Could not find Opus library")`，
    不是 ImportError —— 于是上游 `except ImportError` 兜不住，整个语音进程
    在 import 时直接死掉。Windows 上尤其容易：系统没有 libopus，但 PyAV
    （真音频链路必装）自带一份 `av.libs/libopus-*.dll`。

做法（只在 import opuslib **之前**调用一次）：

    1. `OPUS_LIB=/path/to/libopus.(so|dylib|dll)` 显式指定，优先级最高；
    2. Windows：在 site-packages 里找 PyAV 自带的 `av.libs/libopus-*.dll`；
    3. 兜底交给 `ctypes.util.find_library("opus")`（Linux 的 libopus.so.0、
       macOS 的 brew 安装都能命中）。

    找到后把 `ctypes.util.find_library` 包一层：**只拦 "opus" 开头的名字**，
    其余原样透传。全量替换会毒到 PortAudio/sounddevice（实测报
    `symbol 'Pa_Initialize' not found in ... opus.dll`），所以这里必须窄。

不做什么：不下载、不编译、不往仓库里塞二进制。找不到就抛带安装指引的错误，
让调用方在启动阶段就看到明确原因，而不是在 import 深处炸栈。
"""

from __future__ import annotations

import ctypes.util
import glob
import os
import sys
from pathlib import Path

_ORIGINAL_FIND_LIBRARY = ctypes.util.find_library
_PATCHED = False


def _from_env() -> str | None:
    p = os.getenv("OPUS_LIB", "").strip()
    return p if p and Path(p).is_file() else None


def _from_pyav() -> str | None:
    """PyAV 的 wheel 把 libopus 放在 av.libs/（Windows / manylinux）。"""
    if sys.platform != "win32":
        return None
    try:
        import av  # noqa: F401  只是用它的安装位置
    except Exception:
        return None
    site = Path(av.__file__).resolve().parent
    patterns = [
        site.parent / "av.libs" / "libopus-*.dll",
        site / "av.libs" / "libopus-*.dll",
        site / "libopus*.dll",
        site.parent / "av.libs" / "*opus*.dll",
    ]
    for pat in patterns:
        hits = sorted(glob.glob(str(pat)))
        if hits:
            return hits[0]
    return None


def _from_system() -> str | None:
    name = _ORIGINAL_FIND_LIBRARY("opus")
    return name or None


def find_opus_library() -> str | None:
    """按优先级找 libopus 路径；找不到返回 None。"""
    for probe in (_from_env, _from_pyav, _from_system):
        hit = probe()
        if hit:
            return hit
    return None


def ensure_opus_library(required: bool = False) -> str | None:
    """让 opuslib 能 import。返回命中的路径。

    required=True 时找不到直接抛 RuntimeError（带安装指引）；
    否则只告警一次，让调用方自己的降级逻辑（"Opus 不可用"）生效。
    """
    global _PATCHED
    path = find_opus_library()
    if path is None:
        if required:
            raise RuntimeError(
                "找不到 libopus：装 PyAV（`pip install av`，Windows 自带一份），"
                "或设 OPUS_LIB 指向 libopus 的动态库。"
            )
        print(
            "[opus_runtime] 找不到 libopus；Opus 编解码将不可用。"
            "装 PyAV 或设 OPUS_LIB 可解决。",
            file=sys.stderr,
        )
        return None

    if not _PATCHED:
        def _find(name: str) -> str | None:
            if str(name).lower().startswith("opus"):
                return path
            return _ORIGINAL_FIND_LIBRARY(name)

        ctypes.util.find_library = _find  # type: ignore[assignment]
        _PATCHED = True

    # Windows 上先显式加载一次：opuslib 走 find_library + CDLL，提前加载能让
    # 失败发生在启动阶段而不是第一次解码时。
    if sys.platform == "win32":
        try:
            ctypes.CDLL(str(path))
        except OSError:
            pass
    return path
