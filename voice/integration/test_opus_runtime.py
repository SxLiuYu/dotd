"""opus_runtime 的回归测试：库发现优先级 + "只拦 opus" 的窄补丁。

为什么值得单测：这段代码解决的是"import 阶段直接崩进程"，崩的时候没有栈能指到
根因。补丁要是放宽成拦所有名字，会把 PortAudio/sounddevice 带崩（实测
`symbol 'Pa_Initialize' not found in ... opus.dll`）——所以必须锁住"别动别的名字"。
"""

from __future__ import annotations

import ctypes.util
import os
import sys
import types
import unittest
from unittest import mock

from voice.integration import opus_runtime


class OpusRuntimeTest(unittest.TestCase):
    def setUp(self):
        self._orig_find = ctypes.util.find_library
        self._orig_patched = opus_runtime._PATCHED

    def tearDown(self):
        ctypes.util.find_library = self._orig_find
        opus_runtime._PATCHED = self._orig_patched

    def test_env_path_wins_when_file_exists(self):
        with mock.patch.dict(os.environ, {"OPUS_LIB": __file__}):
            self.assertEqual(opus_runtime.find_opus_library(), __file__)

    def test_env_path_ignored_when_missing(self):
        with mock.patch.dict(os.environ, {"OPUS_LIB": "/no/such/libopus.so"}), mock.patch.object(
            opus_runtime, "_from_pyav", return_value=None
        ), mock.patch.object(opus_runtime, "_from_system", return_value=None):
            self.assertIsNone(opus_runtime.find_opus_library())

    def test_patch_only_intercepts_opus_names(self):
        with mock.patch.dict(os.environ, {"OPUS_LIB": __file__}):
            opus_runtime.ensure_opus_library()
        self.assertEqual(ctypes.util.find_library("opus"), __file__)
        # 非 opus 名字必须原封不动地透传给系统实现
        with mock.patch.object(opus_runtime, "_ORIGINAL_FIND_LIBRARY", return_value="/sys/libfoo.so") as orig:
            self.assertEqual(ctypes.util.find_library("portaudio"), "/sys/libfoo.so")
            orig.assert_called_once_with("portaudio")

    def test_required_missing_raises_with_guidance(self):
        with mock.patch.dict(os.environ, {"OPUS_LIB": ""}), mock.patch.object(
            opus_runtime, "_from_pyav", return_value=None
        ), mock.patch.object(opus_runtime, "_from_system", return_value=None):
            with self.assertRaises(RuntimeError) as ctx:
                opus_runtime.ensure_opus_library(required=True)
        self.assertIn("OPUS_LIB", str(ctx.exception))

    def test_optional_missing_returns_none(self):
        with mock.patch.dict(os.environ, {"OPUS_LIB": ""}), mock.patch.object(
            opus_runtime, "_from_pyav", return_value=None
        ), mock.patch.object(opus_runtime, "_from_system", return_value=None):
            self.assertIsNone(opus_runtime.ensure_opus_library())

    def test_pyav_lookup_finds_bundled_dll_on_windows(self):
        fake_av = types.ModuleType("av")
        fake_av.__file__ = os.path.join(os.path.dirname(__file__), "av", "__init__.py")
        with mock.patch.dict(os.environ, {"OPUS_LIB": ""}), mock.patch.object(
            sys, "platform", "win32"
        ), mock.patch.dict(sys.modules, {"av": fake_av}), mock.patch.object(
            opus_runtime.glob, "glob", return_value=[r"C:\x\av.libs\libopus-1.dll"]
        ) as g:
            self.assertEqual(opus_runtime._from_pyav(), r"C:\x\av.libs\libopus-1.dll")
        # 搜的是 av.libs 下的 libopus-*.dll，不是整盘
        self.assertTrue(any("av.libs" in call.args[0] for call in g.call_args_list))


if __name__ == "__main__":
    unittest.main()
