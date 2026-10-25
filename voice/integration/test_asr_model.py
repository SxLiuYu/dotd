"""asr_model / asr_watch 的回归测试：模型必须能下到，且"后到也能听"。

守四件事：
  1. 多源顺序：自定义镜像 → GitHub → hf-mirror；GitHub 挂了要自动换下一个；
  2. 落盘是原子的：失败/中断不许留下半截 `model.int8.onnx`（那比没有更糟 ——
     ASR 会拿它去初始化，报"加载失败"而不是"不存在"）；
  3. 就绪判定要看文件大小：一个 0 字节的 model.int8.onnx 不算就绪；
  4. asr_watch：模型后到时设 SENSE_VOICE_MODEL + 清上游单例缓存（不改上游逻辑）。
"""

from __future__ import annotations

import io
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from voice.integration import asr_model, asr_watch


def _fake_payload(model_bytes: int = 2 * 1024 * 1024) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:bz2") as tf:
        for name, data in (
            ("pkg/model.int8.onnx", b"\0" * model_bytes),
            ("pkg/tokens.txt", b"a 1\nb 2\n"),
            ("pkg/README.md", b"ignore me\n"),
        ):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


class AsrModelTest(unittest.TestCase):
    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="asr-model-"))

    def test_ready_requires_both_files_and_real_size(self) -> None:
        self.assertFalse(asr_model.ready(self.dir))
        (self.dir / asr_model.TOKENS_FILE).write_text("x")
        (self.dir / asr_model.MODEL_FILE).write_bytes(b"")
        self.assertFalse(asr_model.ready(self.dir), "0 字节不算就绪")
        (self.dir / asr_model.MODEL_FILE).write_bytes(b"\0" * asr_model.MIN_MODEL_BYTES)
        self.assertTrue(asr_model.ready(self.dir))

    def test_sources_order_custom_first(self) -> None:
        with mock.patch.dict(os.environ, {"SENSE_VOICE_MIRROR": "http://mirror.local/models"}):
            labels = [s[0] for s in asr_model.sources()]
        self.assertEqual(labels[0], "自定义镜像")
        self.assertIn("hf-mirror", labels)
        self.assertIn("GitHub release", labels)

    def test_tarball_fallback_to_mirror_when_github_times_out(self) -> None:
        """GitHub 超时 → 必须换 hf-mirror，而不是整体失败。"""
        payload = _fake_payload()

        def fake_download(url, dest, **_kw):
            if "github.com" in url:
                raise OSError("timed out")
            data = payload if url.endswith(".tar.bz2") else (
                b"\0" * asr_model.MIN_MODEL_BYTES if url.endswith(".onnx") else b"a 1\n"
            )
            Path(dest).parent.mkdir(parents=True, exist_ok=True)
            Path(dest).write_bytes(data)

        with mock.patch.object(asr_model, "_download", side_effect=fake_download):
            ok = asr_model.ensure(self.dir)
        self.assertTrue(ok, "GitHub 挂了仍应由镜像成功")
        self.assertTrue(asr_model.ready(self.dir))

    def test_tarball_extracts_only_needed_files_flat(self) -> None:
        with mock.patch.object(asr_model, "_download") as dl, \
             mock.patch.object(asr_model, "MIN_MODEL_BYTES", 1024):
            def write_archive(url, dest, **_kw):
                Path(dest).write_bytes(_fake_payload(model_bytes=4096))
            dl.side_effect = write_archive
            ok = asr_model._from_tarball(self.dir)
        self.assertTrue(ok)
        names = sorted(p.name for p in self.dir.iterdir())
        self.assertEqual(names, [asr_model.MODEL_FILE, asr_model.TOKENS_FILE], "只取两个必需文件，且平铺")

    def test_failed_download_leaves_no_partial_model(self) -> None:
        """半截文件比没有更糟：ASR 会去初始化它然后报"加载失败"。"""
        # 直接测 _download 自己的清理：urlopen 抛异常时 .part 必须被删掉。
        with mock.patch.object(asr_model.urllib.request, "urlopen", side_effect=OSError("reset")):
            with self.assertRaises(OSError):
                asr_model._download("http://x/model.int8.onnx", self.dir / asr_model.MODEL_FILE)
        self.assertEqual(list(self.dir.glob("*")), [], "不该留下任何残片")

    def test_partial_file_is_replaced_atomically(self) -> None:
        """成功时先用 .part 再 os.replace —— 中途断电不会留下可被误用的半截模型。"""
        payload = b"\0" * 4096
        fake_resp = mock.MagicMock()
        fake_resp.__enter__.return_value = io.BytesIO(payload)
        fake_resp.__exit__.return_value = False
        target = self.dir / asr_model.MODEL_FILE
        with mock.patch.object(asr_model.urllib.request, "urlopen", return_value=fake_resp):
            asr_model._download("http://x/model.int8.onnx", target)
        self.assertEqual(target.read_bytes(), payload)
        self.assertEqual(list(self.dir.glob("*.part")), [], "落盘后不应残留 .part")


class AsrWatchTest(unittest.TestCase):
    def setUp(self) -> None:
        self.home = Path(tempfile.mkdtemp(prefix="asr-watch-"))
        asr_watch._reset_for_tests()

    def tearDown(self) -> None:
        asr_watch._reset_for_tests()
        os.environ.pop("SENSE_VOICE_MODEL", None)

    def _make_model(self, home: Path) -> Path:
        d = home / "voice" / "models" / "sense-voice"
        d.mkdir(parents=True, exist_ok=True)
        (d / "model.int8.onnx").write_bytes(b"stub")
        return d

    def test_resolve_prefers_data_volume(self) -> None:
        d = self._make_model(self.home)
        self.assertEqual(asr_watch.resolve(self.home), d)

    def test_resolve_none_when_missing(self) -> None:
        self.assertIsNone(asr_watch.resolve(self.home))

    def test_adopt_sets_env_and_clears_upstream_cache(self) -> None:
        d = self._make_model(self.home)
        fake = mock.Mock()
        fake._sense_voice_recognizer = object()
        with mock.patch.dict("sys.modules", {"agent.asr_tts": fake}), \
             mock.patch.dict("sys.modules", {"agent": mock.Mock(asr_tts=fake)}):
            asr_watch.adopt(self.home, d)
        self.assertEqual(os.environ["SENSE_VOICE_MODEL"], str(d))
        self.assertIsNone(fake._sense_voice_recognizer, "必须清掉单例，否则还是旧路径")

    def test_watch_returns_none_and_adopts_when_already_present(self) -> None:
        d = self._make_model(self.home)
        self.assertIsNone(asr_watch.watch_async(self.home))
        self.assertEqual(os.environ["SENSE_VOICE_MODEL"], str(d))

    def test_watch_picks_up_late_model_without_restart(self) -> None:
        """模型在启动后出现 —— 线程要自己接手，不用重启（2026-10-25 实测的坑）。"""
        d = self._make_model(self.home)
        calls = {"n": 0}

        def fake_resolve(_home):
            # 第一次（启动时）没有；轮询的那一次有了。
            calls["n"] += 1
            return None if calls["n"] == 1 else d

        class _Immediate:
            def __init__(self, target, name=None, daemon=None):
                self.target = target

            def start(self):
                self.target()

        fake = mock.Mock()
        fake._sense_voice_recognizer = object()
        with mock.patch.object(asr_watch, "resolve", side_effect=fake_resolve), \
             mock.patch.object(asr_watch.threading, "Event", _Event), \
             mock.patch.dict("sys.modules", {"agent": mock.Mock(asr_tts=fake)}):
            asr_watch.watch_async(
                self.home, minutes=1, poll_seconds=600, thread_factory=_Immediate
            )
        self.assertEqual(calls["n"], 2, "启动看一次 + 轮询看一次")
        self.assertEqual(os.environ["SENSE_VOICE_MODEL"], str(d))
        self.assertIsNone(fake._sense_voice_recognizer)

    def test_minutes_zero_does_not_start_thread(self) -> None:
        self.assertIsNone(asr_watch.watch_async(self.home, minutes=0))


class _Event:
    """poll 永远 False，用于跑有限的循环轮数。"""

    def wait(self, _timeout: float = 0) -> bool:
        return False


if __name__ == "__main__":
    unittest.main()
