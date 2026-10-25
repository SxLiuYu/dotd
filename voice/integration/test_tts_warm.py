"""tts_warm 的回归测试：只验"编排"，不联网、不合成。

守三件事：
  1. 逐条调用 TTS 并如实记录成功/失败（失败不能把启动带崩）；
  2. `DOTD_TTS_WARM=0` 时不开线程（可回退）；
  3. 话术表可用 `DOTD_TTS_WARM_PHRASES="a|b"` 覆盖。

真的合成/缓存命中属于真音频验收（voice/integration/test_real_audio.py 的
DOTD_REAL_AUDIO 门），这里用替身，保证 CI 无外网也能跑。
"""

from __future__ import annotations

import os
import sys
import types
import unittest
from unittest import mock

from voice.integration import tts_warm


class TtsWarmTest(unittest.TestCase):
    def _install_fake_tts(self, *, fail: bool = False):
        mod = types.ModuleType("agent.asr_tts")
        calls: list[str] = []

        def tts_to_mp3(text: str) -> bytes:
            calls.append(text)
            if fail and text == "炸":
                raise RuntimeError("TTS 挂了")
            return b"x" * 200

        mod.tts_to_mp3 = tts_to_mp3  # type: ignore[attr-defined]
        self.addCleanup(lambda: sys.modules.pop("agent.asr_tts", None))
        sys.modules["agent.asr_tts"] = mod
        return calls

    def test_warm_once_synthesises_each_phrase(self):
        calls = self._install_fake_tts()
        out = tts_warm.warm_once(["我在。", "好的"])
        self.assertEqual(calls, ["我在。", "好的"])
        self.assertTrue(all(r["ok"] for r in out))
        self.assertEqual(len(out), 2)

    def test_failure_is_reported_not_raised(self):
        self._install_fake_tts(fail=True)
        out = tts_warm.warm_once(["好的", "炸"])
        self.assertTrue(out[0]["ok"])
        self.assertFalse(out[1]["ok"])
        self.assertIn("TTS 挂了", out[1]["err"])

    def test_env_off_disables_thread(self):
        self._install_fake_tts()
        with mock.patch.dict(os.environ, {"DOTD_TTS_WARM": "0"}):
            self.assertIsNone(tts_warm.warm_async())

    def test_env_phrases_override(self):
        with mock.patch.dict(os.environ, {"DOTD_TTS_WARM_PHRASES": "甲|乙 "}):
            self.assertEqual(tts_warm.phrases_from_env(), ("甲", "乙"))

    def test_thread_runs_and_exits(self):
        self._install_fake_tts()
        with mock.patch.dict(os.environ, {"DOTD_TTS_WARM": "1", "DOTD_TTS_WARM_PHRASES": "甲"}):
            t = tts_warm.warm_async()
            self.assertIsNotNone(t)
            t.join(timeout=5)
            self.assertFalse(t.is_alive())


if __name__ == "__main__":
    unittest.main()
