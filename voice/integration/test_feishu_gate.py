"""feishu_gate 的回归测试：闸门默认关 + `_started` 能复位 + 幂等。

守三件事：
  1. 默认不启动 Charlie 自己的长连接（dotd 独占事件订阅，否则同一条消息两次处理）；
  2. 线程已死时 `start()` 必须真的重试，而不是被上游的 `_started` 永久挡住
     （现场：`No module named 'lark_oapi'` 之后"尝试重启"空喊 163 次）；
  3. 补丁幂等：重复 install 不会套娃。

用替身模块，不 import lark_oapi、不联网。
"""

from __future__ import annotations

import os
import threading
import types
import unittest
from unittest import mock

from voice.integration import feishu_gate


class _FakeThread:
    def __init__(self, alive: bool) -> None:
        self._alive = alive

    def is_alive(self) -> bool:
        return self._alive


def _fake_module(*, thread_alive: bool | None = None) -> types.SimpleNamespace:
    """造一个和上游 feishu_ws 同名同形状的替身。"""
    calls: list[int] = []
    mod = types.SimpleNamespace(
        _started=False,
        _ws_thread=None,
        calls=calls,
    )

    def start() -> None:
        calls.append(1)
        if getattr(mod, "_raise", False):
            raise RuntimeError("lark_oapi 炸了")
        mod._ws_thread = _FakeThread(thread_alive if thread_alive is not None else True)
        mod._started = True

    mod.start = start
    return mod


class FeishuGateTest(unittest.TestCase):
    def test_default_is_off(self):
        self.assertFalse(feishu_gate.gate_enabled({}))
        self.assertFalse(feishu_gate.gate_enabled({"CHARLIE_FEISHU_WS": "0"}))
        self.assertFalse(feishu_gate.gate_enabled({"CHARLIE_FEISHU_WS": "no"}))

    def test_on_values(self):
        for v in ("1", "true", "on", "YES", " 1 "):
            self.assertTrue(feishu_gate.gate_enabled({"CHARLIE_FEISHU_WS": v}), v)

    def test_gate_blocks_start_when_off(self):
        mod = _fake_module()
        self.assertTrue(feishu_gate.install(mod))
        with mock.patch.dict(os.environ, {}, clear=True):
            mod.start()
            mod.start()  # 重复调用不能起第二条连接，也不能报错
        self.assertEqual(mod.calls, [], "默认关时上游 start 一次都不该被调到")
        self.assertFalse(mod._started)
        self.assertFalse(mod.is_alive if hasattr(mod, "is_alive") else False)

    def test_gate_opens_with_env(self):
        mod = _fake_module()
        feishu_gate.install(mod)
        with mock.patch.dict(os.environ, {"CHARLIE_FEISHU_WS": "1"}, clear=True):
            mod.start()
        self.assertEqual(len(mod.calls), 1)
        self.assertTrue(mod._started)

    def test_sticky_started_is_reset_when_thread_dead(self):
        """核心回归：线程死了之后，下一次 start 必须真的再调一次上游。"""
        mod = _fake_module(thread_alive=True)
        feishu_gate.install(mod)
        with mock.patch.dict(os.environ, {"CHARLIE_FEISHU_WS": "1"}, clear=True):
            mod.start()
            self.assertEqual(len(mod.calls), 1)
            # 模拟线程退出（上游不会复位 _started）
            mod._ws_thread = _FakeThread(False)
            mod.start()
        self.assertEqual(len(mod.calls), 2, "线程死了却没能重试 —— 就是现场那个 bug")

    def test_started_left_false_when_thread_died_immediately(self):
        """线程一起就死（缺 lark_oapi 的形态）：_started 必须还回去，交给下一轮重试。"""
        mod = _fake_module(thread_alive=False)
        feishu_gate.install(mod)
        with mock.patch.dict(os.environ, {"CHARLIE_FEISHU_WS": "1"}, clear=True):
            mod.start()
        self.assertFalse(mod._started, "线程已死还留 _started=True，就是永久卡死")

    def test_install_is_idempotent(self):
        mod = _fake_module()
        self.assertTrue(feishu_gate.install(mod))
        patched = mod.start
        self.assertTrue(feishu_gate.install(mod))
        self.assertIs(mod.start, patched, "重复 install 不能套娃")

    def test_install_without_module_is_safe(self):
        """模块缺 start 时返回 False，不抛。"""
        self.assertFalse(feishu_gate.install(types.SimpleNamespace()))


if __name__ == "__main__":
    unittest.main()
