"""tts_edge_fallback 的回归测试：上游四条链全灭时必须由 Edge 顶上。

守四件事：
  1. 上游成功时**原样返回**，不额外合成（不能为兜底拖慢正常路径）；
  2. 上游抛 `no TTS available` 时用 Edge 合成并返回音频（设备才有声音）；
  3. Edge 也失败时，抛出的是**上游那个异常**（行为与打补丁前一致，不掩盖根因）；
  4. 幂等 / 缺函数时不炸。

Edge 用替身，不联网、不 import Charlie。
"""

from __future__ import annotations

import os
import sys
import types
import unittest
from unittest import mock

from voice.integration import tts_edge_fallback


class TtsEdgeFallbackTest(unittest.TestCase):
    def _fake_xiaozhi(self, behaviour: str = "fail") -> types.SimpleNamespace:
        """behaviour: ok | fail | other"""
        calls: list[str] = []

        def _synth_mp3(sentence: str, **kwargs):
            calls.append(sentence)
            if behaviour == "ok":
                return b"upstream-mp3"
            if behaviour == "other":
                raise ValueError("别的问题")
            raise RuntimeError("no TTS available")

        mod = types.SimpleNamespace(_synth_mp3=_synth_mp3, calls=calls)
        return mod

    def _fake_asr_tts(self, *, edge_ok: bool = True) -> list[str]:
        edge_calls: list[str] = []
        mod = types.ModuleType("agent.asr_tts")

        def _tts_edge(text: str) -> bytes:
            edge_calls.append(text)
            if not edge_ok:
                raise RuntimeError("Edge TTS 合成超时(10s)")
            return b"e" * 500

        mod._tts_edge = _tts_edge  # type: ignore[attr-defined]
        mod.get_effective_tts_config = lambda: ("Ethan", 1.0)  # type: ignore[attr-defined]
        mod._tts_cache_get = lambda *a, **k: None  # type: ignore[attr-defined]
        mod._tts_cache_put = lambda *a, **k: None  # type: ignore[attr-defined]
        mod.TTS_MODEL = "m"  # type: ignore[attr-defined]
        self.addCleanup(lambda: sys.modules.pop("agent.asr_tts", None))
        sys.modules["agent.asr_tts"] = mod
        return edge_calls

    def test_upstream_success_passes_through(self):
        edge_calls = self._fake_asr_tts()
        mod = self._fake_xiaozhi("ok")
        self.assertTrue(tts_edge_fallback.install(mod))
        self.assertEqual(mod._synth_mp3("你好"), b"upstream-mp3")
        self.assertEqual(edge_calls, [], "上游成功时不该碰 Edge")

    def test_edge_takes_over_when_all_upstream_die(self):
        edge_calls = self._fake_asr_tts()
        mod = self._fake_xiaozhi("fail")
        tts_edge_fallback.install(mod)
        out = mod._synth_mp3("嗯嗯，我在。")
        self.assertEqual(out, b"e" * 500)
        self.assertEqual(edge_calls, ["嗯嗯，我在。"])

    def test_edge_failure_reraises_upstream_error(self):
        self._fake_asr_tts(edge_ok=False)
        mod = self._fake_xiaozhi("fail")
        tts_edge_fallback.install(mod)
        with self.assertRaises(RuntimeError) as ctx:
            mod._synth_mp3("嗯嗯，我在。")
        self.assertIn("no TTS available", str(ctx.exception), "不能把根因换成 Edge 的错误")

    def test_other_errors_are_not_swallowed(self):
        self._fake_asr_tts()
        mod = self._fake_xiaozhi("other")
        tts_edge_fallback.install(mod)
        with self.assertRaises(ValueError):
            mod._synth_mp3("嗯嗯，我在。")

    def test_cancel_before_edge(self):
        """取消信号已置位时不该再合成（设备已经不要这段音频了）。"""
        edge_calls = self._fake_asr_tts()
        mod = self._fake_xiaozhi("fail")
        tts_edge_fallback.install(mod)
        cancel = mock.Mock()
        cancel.is_set.return_value = True
        self.assertEqual(mod._synth_mp3("嗯嗯，我在。", cancel_evt=cancel), b"")
        self.assertEqual(edge_calls, [])

    def test_env_off_disables_fallback(self):
        self._fake_asr_tts()
        mod = self._fake_xiaozhi("fail")
        tts_edge_fallback.install(mod)
        with mock.patch.dict(os.environ, {"CHARLIE_EDGE_FALLBACK": "0"}, clear=True):
            with self.assertRaises(RuntimeError):
                mod._synth_mp3("嗯嗯，我在。")

    def test_install_is_idempotent(self):
        self._fake_asr_tts()
        mod = self._fake_xiaozhi("fail")
        self.assertTrue(tts_edge_fallback.install(mod))
        patched = mod._synth_mp3
        self.assertTrue(tts_edge_fallback.install(mod))
        self.assertIs(mod._synth_mp3, patched)

    def test_install_without_function_is_safe(self):
        self.assertFalse(tts_edge_fallback.install(types.SimpleNamespace()))


if __name__ == "__main__":
    unittest.main()
