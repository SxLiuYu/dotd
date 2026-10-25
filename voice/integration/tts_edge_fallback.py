"""voice/integration/tts_edge_fallback.py —— 给设备播报链补一个免费兜底（Edge TTS）。

## 问题（2026-10-25 现场）

TTS 有**两条互不相干的链**，都写在 vendored 上游代码里：

| 谁用 | 函数 | 降级顺序 |
|---|---|---|
| `asr_tts.tts_to_mp3`（通用入口 / 启动预热 `[tts-warm]`） | `asr_tts.tts` | 按 `TTS_PRIORITY` |
| ESP32 设备播报（`xiaozhi_ws`） | `xiaozhi_ws._synth_mp3` | baidu → finna → stepfun → macOS `say` |

`TTS_PRIORITY` 里加 `edge` 之后，`[tts-warm]` 立刻 3/3；但设备侧日志还在刷

    [xiaozhi] baidu TTS fail: 400 ...
    [xiaozhi] stepfun TTS fail: StepFun Key 未配置
    [xiaozhi] offline say TTS fail: [Errno 2] No such file or directory: 'say'
    [xiaozhi] prewarm '嗯嗯，我在。' fail: no TTS available

因为 `_synth_mp3` **硬编码**了自己的四条链路，既不看 `TTS_PRIORITY`，也不含 `edge`。
在没配百度/StepFun/Finna key 的机器上，设备一句都说不出话 —— 而 `[tts-warm] 3/3`
让人以为"TTS 好了"。这就是两道门各查各的、结论互相矛盾的典型。

## 做法

按 `voice/VENDOR.md` 的边界：不改 `voice/charlie/`，在集成层包一层。
`install()` 把 `xiaozhi_ws._synth_mp3` 换成包装器：

1. 先走上游原函数（保住它的缓存、取消、限流冷却等既有行为）；
2. 只有它抛出 `RuntimeError("no TTS available")`（四条链全灭）时，才用 Edge 合成；
3. 合成结果按上游同样的键写进共享 TTS 缓存，下一句直接命中；
4. Edge 也失败 → 原样抛出上游那个异常，行为与打补丁前一致。

`install()` 幂等。`CHARLIE_EDGE_FALLBACK=0` 可关。
"""

from __future__ import annotations

import logging
import os
from typing import Any, Callable

log = logging.getLogger("magic")

GATE_ENV = "CHARLIE_EDGE_FALLBACK"
_OFF = ("0", "false", "off", "no")
_NO_TTS = "no TTS available"


def fallback_enabled(env: dict[str, str] | None = None) -> bool:
    src = os.environ if env is None else env
    return src.get(GATE_ENV, "1").strip().lower() not in _OFF


def _synthesize_edge(sentence: str) -> bytes:
    """用上游注册表里的 `edge` provider 合成，并按上游的键写共享缓存。"""
    from agent.asr_tts import (  # type: ignore[import-not-found]
        TTS_MODEL,
        _tts_cache_get,
        _tts_cache_put,
        _tts_edge,
        get_effective_tts_config,
    )

    voice, speed = get_effective_tts_config()
    cached = _tts_cache_get(sentence, voice, TTS_MODEL, speed=speed)
    if cached:
        return cached
    audio = _tts_edge(sentence)
    if not audio or len(audio) < 100:
        raise RuntimeError("Edge TTS 返回空音频")
    _tts_cache_put(sentence, audio, voice, TTS_MODEL, speed=speed)
    return audio


def wrap(original: Callable[..., bytes]) -> Callable[..., bytes]:
    """把 `_synth_mp3` 包成"上游全灭 → Edge"的版本。"""

    def synth(sentence: str, **kwargs: Any) -> bytes:
        try:
            return original(sentence, **kwargs)
        except RuntimeError as exc:
            if _NO_TTS not in str(exc):
                raise
            cancel = kwargs.get("cancel_evt")
            if cancel is not None and cancel.is_set():
                return b""
            if not fallback_enabled():
                raise
            try:
                audio = _synthesize_edge(sentence)
            except Exception as edge_exc:
                log.warning("[tts-edge] Edge 兜底也失败: %s", edge_exc)
                raise exc from edge_exc
            log.info("[tts-edge] 设备播报用 Edge 兜底合成 %r（%d B）", sentence[:20], len(audio))
            return audio

    synth.__name__ = getattr(original, "__name__", "synth")
    synth.__doc__ = getattr(original, "__doc__", None)
    return synth


def install(module: Any | None = None) -> bool:
    """给 `app.xiaozhi_ws._synth_mp3` 打补丁；返回是否（本次或之前）装上了。

    `module` 仅测试用：传替身，免得为了单测去 import 整个 Charlie。
    """
    if module is None:
        try:
            from app import xiaozhi_ws as module  # type: ignore[no-redef]
        except Exception as exc:  # pragma: no cover - 部署环境缺 Charlie
            log.debug("[tts-edge] 跳过（import app.xiaozhi_ws 失败）：%s", exc)
            return False

    if getattr(module, "_dotd_edge_fallback", False):
        return True

    original = getattr(module, "_synth_mp3", None)
    if not callable(original):
        log.debug("[tts-edge] 跳过（xiaozhi_ws 没有 _synth_mp3）")
        return False

    module._dotd_edge_fallback = True  # type: ignore[attr-defined]
    module._dotd_original_synth_mp3 = original  # type: ignore[attr-defined]
    module._synth_mp3 = wrap(original)  # type: ignore[attr-defined]
    log.debug("[tts-edge] 已接管 xiaozhi_ws._synth_mp3（上游全灭时走 Edge）")
    return True
