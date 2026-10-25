"""voice/integration/tts_warm.py —— 启动时预热固定话术的 TTS 缓存。

为什么只做"固定话术"：
    `stream_voice_pipeline` 已经是**按句**合成（`agent/llm.py:1973`），
    长回答的首句一出现就开始 TTS，剩下的 1.1 s 是 Edge TTS 自己的建连+首包，
    代码层面没有可省的空间。真正能省的是**每次都说同一句**的那几条：
    低意图应答（「嗯嗯，我在。」）、"没听清，请再说一遍"之类的固定回复。
    它们第一次合成要 1.1 s，之后 `_tts_cache` 命中是 0 ms；预热就是把这一次
    挪到启动阶段。

不做什么：
    - 不改进程内缓存实现（那是上游文件）；只调用它的公开入口 `tts_to_mp3`，
      让正常缓存逻辑把结果存下来。
    - 不阻塞启动：预热跑在守护线程里，失败只记日志。

开关：`DOTD_TTS_WARM=0` 关闭；`DOTD_TTS_WARM_PHRASES="a|b"` 覆盖话术表。
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Iterable

log = logging.getLogger(__name__)

# 只放"一定会重复"的短句：长句、动态句预热没意义（每次文本都不同，缓存必然 miss）。
DEFAULT_PHRASES: tuple[str, ...] = (
    "嗯嗯，我在。",
    "我在，请说。",
    "没听清，请再说一遍。",
)


def phrases_from_env() -> tuple[str, ...]:
    raw = os.getenv("DOTD_TTS_WARM_PHRASES", "").strip()
    if not raw:
        return DEFAULT_PHRASES
    return tuple(p.strip() for p in raw.split("|") if p.strip())


def warm_once(phrases: Iterable[str] | None = None) -> list[dict]:
    """同步合成一遍（供测试与 `--check` 使用）。返回每条话术的结果。"""
    items = tuple(phrases) if phrases is not None else phrases_from_env()
    out: list[dict] = []
    try:
        from agent.asr_tts import tts_to_mp3
    except Exception as exc:  # pragma: no cover - 环境缺失
        log.warning("[tts-warm] 无法导入 TTS：%s", exc)
        return [{"phrase": p, "ok": False, "err": f"import: {exc}"} for p in items]

    for phrase in items:
        t0 = time.perf_counter()
        try:
            audio = tts_to_mp3(phrase)
            ms = round((time.perf_counter() - t0) * 1000)
            ok = bool(audio) and len(audio) > 100
            out.append({"phrase": phrase, "ok": ok, "ms": ms, "bytes": len(audio or b"")})
            if ok:
                log.info("[tts-warm] 预热 %r %d ms", phrase, ms)
            else:
                log.warning("[tts-warm] 预热 %r 返回空音频", phrase)
        except Exception as exc:
            ms = round((time.perf_counter() - t0) * 1000)
            out.append({"phrase": phrase, "ok": False, "ms": ms, "err": str(exc)[:120]})
            log.warning("[tts-warm] 预热 %r 失败（%d ms）：%s", phrase, ms, exc)
    return out


def warm_async(phrases: Iterable[str] | None = None) -> threading.Thread | None:
    """后台守护线程预热；`DOTD_TTS_WARM=0` 时直接返回 None。"""
    flag = os.getenv("DOTD_TTS_WARM", "1").strip().lower()
    if flag in ("0", "false", "off", "no"):
        return None

    def _run() -> None:
        started = time.perf_counter()
        results = warm_once(phrases)
        ok = sum(1 for r in results if r.get("ok"))
        log.info(
            "[tts-warm] 完成 %d/%d 条，用时 %.2fs",
            ok,
            len(results),
            time.perf_counter() - started,
        )

    t = threading.Thread(target=_run, name="tts-warm", daemon=True)
    t.start()
    return t
