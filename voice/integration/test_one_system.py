"""voice/integration/test_one_system.py —— 阶段 1 托管逻辑的单测（2026-10-23）。

用假 kernel（一个临时 Python HTTP 脚本）验证：
- 启动探活；
- 进程退出后自动重启（restarts 增加）；
- apiVersion 不匹配 → incompatible，且不冒充健康；
- env 文件解析（BOM / export / 引号）与退避序列。

不依赖真 dotd、不占 7788。
"""

import json
import os
import socket
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path
from unittest import mock

from voice.integration.one_system import (
    KernelSupervisor,
    _check,
    apply_env,
    backoff_for,
    load_env_file,
    resolve_paths,
)

FAKE_KERNEL = textwrap.dedent(
    """
    import json, os, sys, threading, time
    from http.server import BaseHTTPRequestHandler, HTTPServer

    port = int(sys.argv[1])
    version = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    die_after = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    count = 0

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass
        def do_GET(self):
            global count
            count += 1
            body = json.dumps({"ok": True, "service": "dotd", "apiVersion": version}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            if die_after and count >= die_after:
                threading.Timer(0.2, lambda: os._exit(0)).start()

    HTTPServer(("127.0.0.1", port), H).serve_forever()
    """
)


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class OneSystemTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _script(self) -> Path:
        p = self.root / "fake_kernel.py"
        p.write_text(FAKE_KERNEL, encoding="utf-8")
        return p

    def _paths(self):
        (self.root / "config.yml").write_text("surfaces:\n  http:\n    port: 7790\n", encoding="utf-8")
        return resolve_paths({"CHARLIE_HOME": str(self.root)})

    def test_backoff_sequence(self) -> None:
        self.assertEqual([backoff_for(i) for i in range(6)], [1, 2, 5, 10, 30, 30])
        self.assertEqual(backoff_for(-3), 1)

    def test_env_file_bom_export_quotes(self) -> None:
        p = self.root / "tokens.env"
        p.write_text('\ufeffexport A="one"\nB=two\nC=\'three\'\n# skip\n', encoding="utf-8")
        self.assertEqual(load_env_file(p), {"A": "one", "B": "two", "C": "three"})

    def test_restart_after_exit(self) -> None:
        port = free_port()
        script = self._script()
        sup = KernelSupervisor(
            self._paths(),
            port,
            "test-token",
            log=lambda _s: None,
            command=[sys.executable, str(script), str(port), "1", "1"],
        )
        sup.start()
        try:
            self.assertTrue(sup.wait_ready(10), "假 kernel 应能就绪")
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and sup.snapshot().restarts < 1:
                time.sleep(0.2)
            snap = sup.snapshot()
            self.assertGreaterEqual(snap.restarts, 1, f"应至少重启一次：{snap}")
        finally:
            sup.stop()

    def test_version_mismatch_is_not_healthy(self) -> None:
        port = free_port()
        script = self._script()
        sup = KernelSupervisor(
            self._paths(),
            port,
            "test-token",
            log=lambda _s: None,
            command=[sys.executable, str(script), str(port), "99", "0"],
        )
        sup.start()
        try:
            self.assertFalse(sup.wait_ready(10), "版本不匹配不能返回 ready")
            health = sup.aggregate_health()
            self.assertEqual(health["kernel"], "incompatible")
            self.assertFalse(health["ok"])
            self.assertIn("apiVersion", str(health["kernelDetail"].get("lastError")))
        finally:
            sup.stop()

    def test_apply_env_puts_edge_first_in_tts_chain(self) -> None:
        """默认 TTS 链路必须包含 edge：免费、免 key，是"开箱能出声"的唯一保证。

        上游默认链路 audio8/baidu/stepfun/finna 四个都要额外前提，新机器上全灭，
        结果是启动预热 0/3、每句话都要先空转 8s 再熔断 120s。
        """
        paths = self._paths()
        env: dict[str, str] = {}
        apply_env(paths, env)
        chain = env["TTS_PRIORITY"].split(",")
        self.assertEqual(chain[0], "edge", f"edge 应排第一：{chain}")
        self.assertIn("audio8", chain, "原来的本地音色克隆不能被删掉")

    def test_apply_env_respects_explicit_tts_priority(self) -> None:
        """显式配置优先：setdefault 不能覆盖主人自己写的 TTS_PRIORITY。"""
        paths = self._paths()
        env = {"TTS_PRIORITY": "audio8"}
        apply_env(paths, env)
        self.assertEqual(env["TTS_PRIORITY"], "audio8")

    def test_apply_env_points_at_data_volume_model_when_present(self) -> None:
        """数据卷里有 SenseVoice 模型时必须指过去（Docker 的模型不在源码目录）。"""
        paths = self._paths()
        model_dir = paths.home / "voice" / "models" / "sense-voice"
        model_dir.mkdir(parents=True, exist_ok=True)
        (model_dir / "model.int8.onnx").write_bytes(b"stub")

        env: dict[str, str] = {}
        apply_env(paths, env)
        self.assertEqual(env["SENSE_VOICE_MODEL"], str(model_dir))

    def test_apply_env_leaves_default_model_path_when_volume_empty(self) -> None:
        """卷里没有模型时不要动 —— 宿主机部署的模型在源码目录，覆盖就找不到。"""
        paths = self._paths()
        env: dict[str, str] = {}
        apply_env(paths, env)
        self.assertNotIn("SENSE_VOICE_MODEL", env)

    def test_apply_env_respects_explicit_sense_voice_model(self) -> None:
        """主人显式设了模型路径，不许被卷里的默认位置顶掉。"""
        paths = self._paths()
        model_dir = paths.home / "voice" / "models" / "sense-voice"
        model_dir.mkdir(parents=True, exist_ok=True)
        (model_dir / "model.int8.onnx").write_bytes(b"stub")

        env = {"SENSE_VOICE_MODEL": "/custom/place"}
        apply_env(paths, env)
        self.assertEqual(env["SENSE_VOICE_MODEL"], "/custom/place")


class CheckSeesTokensEnvTest(unittest.TestCase):
    """`--check` 必须看到**启动时会生效**的环境，不是裸 shell 的（2026-10-26）。

    现场（live）：

        $ python -m voice.integration.one_system --check
        "asr": {"mode": "none"}          ← 报"设备会听不见"
        $ npm run charlie:start          ← 同一个 home、同一个进程环境
        [asr] SenseVoice 模型已就位，后续识别走本地

    差别只在于：`main()` 里 `apply_env(paths)` 在 `--check` **返回之后**才调，
    所以 `--check` 看到的是裸 shell 的 os.environ —— tokens.env 里的云端 key
    与 CHARLIE_HTTPS_PORT 全都看不见。检查器又看错了地方。
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "config.yml").write_text(
            "surfaces:\n  http:\n    port: 7790\n", encoding="utf-8"
        )
        self.paths = resolve_paths({"CHARLIE_HOME": str(self.root)})
        # 断掉「仓库自带模型目录」这个候选：本机装了 237MB 权重时 asr 会报 local，
        # 这几条要验的是 tokens.env 里的云端 key 看不看得见，不能被机器状态左右。
        from voice.integration import asr_watch

        patcher = mock.patch.object(
            asr_watch,
            "candidates",
            side_effect=lambda home: [Path(home) / "voice" / "models" / "sense-voice"],
        )
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _set_env(self, **kw: str) -> "dict[str, str]":
        """临时改 os.environ（--check 读的就是它）。"""
        saved = {k: os.environ.get(k) for k in kw}
        os.environ.update(kw)
        self.addCleanup(
            lambda: [
                os.environ.pop(k, None) if v is None else os.environ.__setitem__(k, v)
                for k, v in saved.items()
            ]
        )
        return kw

    def test_tokens_env_cloud_asr_key_is_visible(self) -> None:
        """tokens.env 里配了百度三件套 → 报 cloud，而不是"设备听不见"。"""
        (self.root / "tokens.env").write_text(
            "export BAIDU_APP_ID=a\n"
            "export BAIDU_API_KEY=b\n"
            "export BAIDU_SECRET_KEY=c\n",
            encoding="utf-8",
        )
        self._set_env(SENSE_VOICE_DISABLED="0")
        info = _check(self.paths, "tok", 7790)
        self.assertEqual(info["asr"]["mode"], "cloud", f"应看到 tokens.env 里的 key：{info['asr']}")
        self.assertIn("baidu", info["asr"]["cloud"])

    def test_tokens_env_https_port_is_visible(self) -> None:
        """tokens.env 里写 CHARLIE_HTTPS_PORT=9443 → 体检报 9443，不是默认 8443。"""
        (self.root / "tokens.env").write_text("CHARLIE_HTTPS_PORT=9443\n", encoding="utf-8")
        self._set_env(CHARLIE_HTTPS="1")
        info = _check(self.paths, "tok", 7790)
        self.assertTrue(info["httpsEnabled"])
        self.assertEqual(info["httpsPort"], 9443, "env 文件里的端口要生效（与启动时一致）")

    def test_explicit_shell_env_still_wins(self) -> None:
        """显式导出的值优先于文件（与 apply_env 的 setdefault 语义一致）。"""
        (self.root / "tokens.env").write_text("CHARLIE_HTTPS_PORT=9443\n", encoding="utf-8")
        self._set_env(CHARLIE_HTTPS="1", CHARLIE_HTTPS_PORT="10443")
        info = _check(self.paths, "tok", 7790)
        self.assertEqual(info["httpsPort"], 10443)


if __name__ == "__main__":
    unittest.main()
