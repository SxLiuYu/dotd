"""https_sidecar 的回归测试：8443 到底有没有真的起来。

守四件事：
  1. 默认启用，`CHARLIE_HTTPS=0` 才关（不能被静默关掉）；
  2. 证书落在**数据目录**（`<home>/voice/cert`），不落仓库 —— 仓库目录会被
     `wsl-deploy.sh` 的 `rsync --delete` 清掉；
  3. `start()` 真的在监听，并且是 TLS（能完成握手），不是只写了个状态；
  4. `lifespan="off"`：第二个 server 不重跑后台调度 / 预热 / 飞书长连接。
"""

from __future__ import annotations

import os
import socket
import ssl
import sys
import tempfile
import time
import unittest
from pathlib import Path

CHARLIE_DIR = Path(__file__).resolve().parents[1] / "charlie"
if str(CHARLIE_DIR) not in sys.path:
    sys.path.insert(0, str(CHARLIE_DIR))

from voice.integration import https_sidecar  # noqa: E402


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# 最小 ASGI app：任何请求都回 200 + "ok"
async def _app(scope, receive, send):  # type: ignore[no-untyped-def]
    if scope["type"] != "http":
        return
    await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"text/plain")]})
    await send({"type": "http.response.body", "body": b"ok"})


class HttpsSidecarTest(unittest.TestCase):
    def setUp(self) -> None:
        self._env = dict(os.environ)
        self.home = Path(tempfile.mkdtemp(prefix="charlie-https-"))

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env)

    def test_enabled_by_default_off_only_when_asked(self):
        self.assertTrue(https_sidecar.enabled({}))
        for off in ("0", "false", "off", "no"):
            self.assertFalse(https_sidecar.enabled({"CHARLIE_HTTPS": off}), off)

    def test_port_parsing_and_fallback(self):
        self.assertEqual(https_sidecar.https_port({}), 8443)
        self.assertEqual(https_sidecar.https_port({"ASSISTANT_KID_HTTPS_PORT": "9443"}), 9443)
        # 垃圾值要回落，不能带着 0 去 bind
        self.assertEqual(https_sidecar.https_port({"ASSISTANT_KID_HTTPS_PORT": "abc"}), 8443)
        self.assertEqual(https_sidecar.https_port({"ASSISTANT_KID_HTTPS_PORT": "70000"}), 8443)

    def test_port_honours_docker_env_name(self):
        """`CHARLIE_HTTPS_PORT` 是 docker/*.env.example 里写给主人填的名字。

        代码以前只读上游的 ASSISTANT_KID_HTTPS_PORT —— 主人照着 example 改成
        9443，compose 映射改了、进程还在听 8443，表现为"TCP 通但没人应答"。
        """
        self.assertEqual(https_sidecar.https_port({"CHARLIE_HTTPS_PORT": "9443"}), 9443)
        # 两个都写时以 docker 那个为准（它是主人能看见的那个）
        self.assertEqual(
            https_sidecar.https_port(
                {"CHARLIE_HTTPS_PORT": "9443", "ASSISTANT_KID_HTTPS_PORT": "9444"}
            ),
            9443,
        )
        # 一个坏一个好 → 用好的那个，不要因为一个笔误整个回落默认值
        self.assertEqual(
            https_sidecar.https_port(
                {"CHARLIE_HTTPS_PORT": "abc", "ASSISTANT_KID_HTTPS_PORT": "9444"}
            ),
            9444,
        )

    def test_cert_lives_in_data_dir_not_repo(self):
        d = https_sidecar.cert_dir(self.home)
        self.assertEqual(d, self.home / "voice" / "cert")
        self.assertNotIn("voice/charlie", str(d).replace("\\", "/"))

    def test_ensure_certificate_creates_files(self):
        d = https_sidecar.cert_dir(self.home)
        paths = https_sidecar.ensure_certificate(d)
        self.assertIsNotNone(paths, "证书生成失败（缺 cryptography？）")
        cert, key = paths
        self.assertTrue(Path(cert).is_file())
        self.assertTrue(Path(key).is_file())
        # key 必须只有属主可读（POSIX）。Windows 上 os.chmod 只翻只读位，
        # 真正的权限是 NTFS ACL，这里不做断言（否则测的是平台而不是代码）。
        if os.name == "posix":
            self.assertEqual(Path(key).stat().st_mode & 0o077, 0)

    def test_disabled_returns_none_and_marks_state(self):
        self.assertIsNone(https_sidecar.start(_app, self.home, env={"CHARLIE_HTTPS": "0"}))
        self.assertEqual(https_sidecar.snapshot()["state"], "disabled")

    def test_serves_tls(self):
        port = free_port()
        env = {"ASSISTANT_KID_HTTPS_PORT": str(port)}
        th = https_sidecar.start(_app, self.home, env=env)
        self.assertIsNotNone(th, "未启动（证书或 uvicorn 不可用）")
        try:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            deadline = time.time() + 20
            last: Exception | None = None
            while time.time() < deadline:
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=1) as raw:
                        with ctx.wrap_socket(raw) as tls:
                            # 握手成功 = 证书与服务端 TLS 都正常
                            self.assertTrue(tls.cipher())
                            return
                except Exception as exc:  # 还没起来
                    last = exc
                    time.sleep(0.2)
            self.fail(f"8443 一直没起来：{last}")
        finally:
            snap = https_sidecar.snapshot()
            self.assertEqual(snap["port"], port)
            self.assertIn(snap["state"], ("running", "stopped", "failed"))

    def test_lifespan_is_off(self):
        # 第二个 server 若跑 lifespan，会重复启动调度器/预热/飞书长连接。
        # 直接读源码断言（配置里必须是 lifespan="off"）。
        src = Path(https_sidecar.__file__).read_text(encoding="utf-8")
        self.assertIn('lifespan="off"', src)


if __name__ == "__main__":
    unittest.main()
