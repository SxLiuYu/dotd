"""voice/integration/test_cortex_router.py —— 反射/皮层分流器单测（2026-10-23）。

用假 Charlie 模块（FAST_PATHS / _brain_llm 的宿主）和假桥，验证阶段 2 的四条边界：

1. 反射命中 → 不问 dotd，但记账；
2. 皮层命中 → 播 dotd 的回复；
3. dotd 不可达 → 只执行本地场景，并明确说「大脑不在线」；
4. 离线记账 → 下次成功前补传（spool 清空）。

不 import 真 Charlie、不占端口、不依赖网络。
"""

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from voice.integration.cortex_router import (
    OFFLINE_REPLY,
    OFFLINE_SCENE_SUFFIX,
    NEEDS_OWNER_REPLY,
    CortexConfig,
    CortexRouter,
    ReflexSpool,
)
from voice.integration.dotd_bridge import BridgeError, DeviceQuotaError, TurnResult


class FakePath:
    def __init__(self, name, reply=None, raises=None):
        self.name = name
        self._reply = reply
        self._raises = raises

    def run(self, text, session_id="default"):
        if self._raises:
            raise self._raises
        return self._reply


class FakeVoiceAgent(SimpleNamespace):
    pass


def make_modules(fast_paths=None, scene=None):
    va = FakeVoiceAgent(
        FAST_PATHS=fast_paths or [],
        is_garbled_asr=lambda text: False,
        LOW_INTENT_ASR_REPLY="没听清",
    )
    return {"voice_agent": va, "llm": SimpleNamespace(), "scene": scene}


class FakeBridge:
    """可控的桥：turn() 返回预设结果，record_event() 可开关。"""

    def __init__(self, result=None, online=True):
        self.result = result or TurnResult(ok=True, status="done", reply="dotd 的答复")
        self.online = online
        self.events = []
        self.calls = 0

    def turn(self, text, thread_id=None, timeout_s=None):
        self.calls += 1
        if not self.online:
            return TurnResult(ok=False, status="unreachable", reason="connection refused")
        return self.result

    def record_event(self, kind, detail=None):
        if not self.online:
            return False
        self.events.append((kind, detail))
        return True


def make_router(tmp: Path, bridge, modules, mode="on"):
    return CortexRouter(
        bridge=bridge,
        config=CortexConfig(mode=mode, timeout_s=1, spool_path=tmp / "spool.jsonl"),
        modules=modules,
    )


class ReflexTests(unittest.TestCase):
    def test_fast_path_hit_does_not_call_dotd(self):
        with tempfile.TemporaryDirectory() as td:
            bridge = FakeBridge()
            mods = make_modules(fast_paths=[FakePath("role_switch", reply="已切换到贾维斯")])
            r = make_router(Path(td), bridge, mods)

            out = r.reply("切换到贾维斯")

            self.assertEqual(out.text, "已切换到贾维斯")
            self.assertEqual(out.source, "reflex")
            self.assertEqual(bridge.calls, 0, "反射命中不能问 dotd")
            self.assertEqual(bridge.events, [("fast_path.role_switch", "切换到贾维斯")])

    def test_fast_path_exception_falls_through_to_cortex(self):
        with tempfile.TemporaryDirectory() as td:
            bridge = FakeBridge()
            mods = make_modules(fast_paths=[FakePath("broken", raises=RuntimeError("boom"))])
            r = make_router(Path(td), bridge, mods)

            out = r.reply("随便说点什么")

            self.assertEqual(out.source, "cortex")
            self.assertEqual(bridge.calls, 1)

    def test_scene_hit_is_reflex_and_accounted(self):
        with tempfile.TemporaryDirectory() as td:
            bridge = FakeBridge()
            mods = make_modules(scene=lambda text: "晚安，灯已关" if "晚安" in text else None)
            r = make_router(Path(td), bridge, mods)

            out = r.reply("晚安")

            self.assertEqual(out.text, "晚安，灯已关")
            self.assertEqual(out.detail, "scene")
            self.assertEqual(bridge.calls, 0)
            self.assertEqual(bridge.events, [("scene", "晚安")])


class CortexTests(unittest.TestCase):
    def test_cortex_returns_dotd_reply(self):
        with tempfile.TemporaryDirectory() as td:
            bridge = FakeBridge(TurnResult(ok=True, status="done", reply="报价单核完了", task_id="tk_1"))
            r = make_router(Path(td), bridge, make_modules())

            out = r.reply("帮我把今天的报价单核对一下")

            self.assertEqual(out.text, "报价单核完了")
            self.assertEqual(out.source, "cortex")
            self.assertEqual(out.task_id, "tk_1")
            self.assertEqual(bridge.calls, 1)

    def test_needs_owner_is_explicit(self):
        with tempfile.TemporaryDirectory() as td:
            bridge = FakeBridge(
                TurnResult(ok=False, status="awaiting_approval", needs_owner=True, task_id="tk_2")
            )
            r = make_router(Path(td), bridge, make_modules())

            out = r.reply("把邮件发出去")

            self.assertEqual(out.source, "needs-owner")
            self.assertEqual(out.text, NEEDS_OWNER_REPLY)
            self.assertIn("确认", out.text)


class OfflineTests(unittest.TestCase):
    def test_offline_without_scene_says_so(self):
        with tempfile.TemporaryDirectory() as td:
            bridge = FakeBridge(online=False)
            r = make_router(Path(td), bridge, make_modules())

            out = r.reply("帮我写一份周报")

            self.assertEqual(out.source, "offline")
            self.assertEqual(out.text, OFFLINE_REPLY)
            self.assertIn("大脑不在线", out.text)

    def test_scene_runs_locally_even_when_dotd_offline(self):
        with tempfile.TemporaryDirectory() as td:
            bridge = FakeBridge(online=False)
            mods = make_modules(scene=lambda text: "已关灯" if "晚安" in text else None)
            r = make_router(Path(td), bridge, mods)

            # 场景是反射：压根不该走到 dotd，也不需要「大脑不在线」的提示。
            out = r.reply("晚安")
            self.assertEqual(out.source, "reflex")
            self.assertEqual(out.text, "已关灯")
            self.assertEqual(bridge.calls, 0)

    def test_offline_scene_suffix_when_cortex_is_entered_directly(self):
        with tempfile.TemporaryDirectory() as td:
            bridge = FakeBridge(online=False)
            mods = make_modules(scene=lambda text: "已关灯" if "晚安" in text else None)
            r = make_router(Path(td), bridge, mods)

            # 直接进皮层（例如调用方已经自己跑过反射）时，本地场景必须标明「未审计」。
            out = r.ask("晚安")
            self.assertEqual(out.source, "offline-scene")
            self.assertEqual(out.text, "已关灯" + OFFLINE_SCENE_SUFFIX)
            self.assertIn("大脑不在线", out.text)

    def test_offline_events_are_spooled_then_flushed(self):
        with tempfile.TemporaryDirectory() as td:
            spool = ReflexSpool(Path(td) / "spool.jsonl")
            bridge = FakeBridge(online=False)
            r = CortexRouter(
                bridge=bridge,
                config=CortexConfig(mode="on", spool_path=spool.path),
                modules=make_modules(),
            )

            r.reply("帮我订明天去上海的票")
            self.assertEqual(spool.pending(), 1, "离线时必须先记下来")

            bridge.online = True
            r.reply("今天几号")
            self.assertEqual(spool.pending(), 0, "恢复后应补传并清空")
            self.assertIn(("offline", "帮我订明天去上海的票"), bridge.events)

    def test_spool_keeps_failed_records(self):
        with tempfile.TemporaryDirectory() as td:
            spool = ReflexSpool(Path(td) / "spool.jsonl")
            spool.add("scene", "晚安")
            bridge = FakeBridge(online=False)
            sent = spool.flush(bridge)
            self.assertEqual(sent, 0)
            self.assertEqual(spool.pending(), 1)


class InstallTests(unittest.TestCase):
    """install() 在假模块上跑：只替换入口，重复调用只装一次。"""

    def setUp(self):
        import sys
        import types

        self.sys = sys
        self.saved = {k: sys.modules.get(k) for k in ("voice_agent", "agent", "agent.llm")}

        va = types.ModuleType("voice_agent")
        va.FAST_PATHS = []
        va.is_garbled_asr = lambda text: False
        va.LOW_INTENT_ASR_REPLY = "没听清"
        va.brain = lambda text, session_id="default": "upstream 大脑"
        va._brain_llm = lambda text, session_id="default": "upstream llm"

        def upstream_stream(text, session_id="default", interrupted_reply="", channel="voice", cancel_event=None):
            yield ("upstream 流", "upstream 流")

        va.brain_stream_sentences = upstream_stream

        agent_pkg = types.ModuleType("agent")
        llm = types.ModuleType("agent.llm")
        llm._clean_for_tts = lambda text: text.strip()
        llm.brain_stream_sentences = upstream_stream
        llm._brain_llm = va._brain_llm
        agent_pkg.llm = llm

        sys.modules["voice_agent"] = va
        sys.modules["agent"] = agent_pkg
        sys.modules["agent.llm"] = llm
        self.va = va

    def tearDown(self):
        for key, mod in self.saved.items():
            if mod is None:
                self.sys.modules.pop(key, None)
            else:
                self.sys.modules[key] = mod

    def test_install_patches_brain_and_stream_once(self):
        from voice.integration.cortex_router import install

        bridge = FakeBridge(TurnResult(ok=True, status="done", reply="dotd 的答复"))
        with tempfile.TemporaryDirectory() as td:
            cfg = CortexConfig(mode="on", spool_path=Path(td) / "s.jsonl")
            first = install(bridge=bridge, config=cfg)
            second = install(bridge=bridge, config=cfg)

        self.assertIsNotNone(first)
        self.assertIs(first, second, "重复安装必须返回同一个 router，不能叠加包装")
        self.assertEqual(self.va.brain("讲个笑话"), "dotd 的答复")
        self.assertEqual(list(self.va.brain_stream_sentences("讲个笑话")), [("dotd 的答复", "dotd 的答复")])

    def test_stream_defers_interrupted_and_feishu_to_upstream(self):
        from voice.integration.cortex_router import install

        bridge = FakeBridge()
        with tempfile.TemporaryDirectory() as td:
            install(
                bridge=bridge,
                config=CortexConfig(mode="on", spool_path=Path(td) / "s.jsonl"),
            )
            out = list(self.va.brain_stream_sentences("继续", interrupted_reply="上一句"))
            feishu = list(self.va.brain_stream_sentences("在吗", channel="feishu_text"))

        self.assertEqual(out, [("upstream 流", "upstream 流")])
        self.assertEqual(feishu, [("upstream 流", "upstream 流")])
        self.assertEqual(bridge.calls, 0, "这两条路径不能接管")


class ConfigTests(unittest.TestCase):
    def test_mode_off_never_calls_bridge(self):
        with tempfile.TemporaryDirectory() as td:
            bridge = FakeBridge()
            r = CortexRouter(
                bridge=bridge,
                config=CortexConfig(mode="off", spool_path=Path(td) / "s.jsonl"),
                modules=make_modules(),
            )
            out = r.reply("讲个笑话")
            self.assertEqual(out.source, "offline")
            self.assertEqual(bridge.calls, 0)

    def test_bad_mode_falls_back_to_auto(self):
        cfg = CortexConfig.from_env({"CHARLIE_CORTEX": "banana"})
        self.assertEqual(cfg.mode, "auto")


class QuotaTests(unittest.TestCase):
    """阶段 3 验收：「配额耗尽时明确回复今天额度用完了，不静默降级」。"""

    def _router(self, td, bridge):
        return make_router(Path(td), bridge, make_modules())

    def test_quota_turn_result_is_spoken_not_offline(self):
        with tempfile.TemporaryDirectory() as td:
            bridge = FakeBridge(
                TurnResult(ok=False, status="quota", reason="今天这台设备的任务额度用完了（200/200）；明天再来")
            )
            out = self._router(td, bridge).reply("帮我订明天的高铁")
            self.assertEqual(out.source, "quota")
            self.assertIn("额度", out.text)
            self.assertIn("明天", out.text)
            self.assertNotIn("大脑不在线", out.text)

    def test_quota_exception_from_bridge_is_spoken(self):
        class QuotaBridge(FakeBridge):
            def turn(self, text, thread_id=None, timeout_s=None):
                self.calls += 1
                raise DeviceQuotaError("今天这台设备的字数额度用完了（100/100）；明天再来")

        with tempfile.TemporaryDirectory() as td:
            out = self._router(td, QuotaBridge()).reply("念一段长文")
            self.assertEqual(out.source, "quota")
            self.assertIn("额度", out.text)
            self.assertNotIn("大脑不在线", out.text)

    def test_busy_says_so_instead_of_offline(self):
        with tempfile.TemporaryDirectory() as td:
            bridge = FakeBridge(TurnResult(ok=False, status="busy", reason="device_busy"))
            out = self._router(td, bridge).reply("再说一句")
            self.assertEqual(out.source, "busy")
            self.assertIn("还在处理", out.text)


if __name__ == "__main__":
    unittest.main()
