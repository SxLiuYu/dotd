"""voice/integration/test_memory_push.py —— 阶段 5 的 Python 侧单测（2026-10-24）。

覆盖两件事：

1. 记忆源：dotd 是唯一事实源
   - 从 /api/device/memory 读回消息与偏好；
   - 反射轮次补写（dotd 已处理的轮次不重复写）；
   - dotd 离线时退回本地缓存，而不是「没有记忆」。

2. 主动推送：dotd 决定该不该说
   - 豁免类型（提醒/唤醒/健康）不打扰 dotd；
   - 允许/拒绝按 dotd 的答复走；
   - dotd 不可达时 fail-closed（可配置 open）；
   - 上游 add_notification / 个性化推荐的发送口被真正替换。

不 import 真 Charlie、不占端口、不依赖网络。
"""

import threading
import unittest
from types import SimpleNamespace

from voice.integration.dotd_bridge import BridgeError
from voice.integration.dotd_memory import DotdMemory, install_memory_bridge
from voice.integration.push_gate import PushGate, install_push_gate


class FakeBridge:
    """按 path 返回预设数据；online=False 时所有请求抛 BridgeError。"""

    def __init__(self, memory=None, decide=None, online=True):
        self.memory = memory or {"threadId": "thr_1", "messages": [], "prefs": []}
        self.decide = decide or {"allow": True}
        self.online = online
        self.calls = []

    def _request(self, method, path, body=None):
        self.calls.append((method, path, body))
        if not self.online:
            raise BridgeError("dotd 不可达（测试）")
        if path.startswith("/api/device/memory"):
            return self.memory
        if path == "/api/device/prefs" and method == "PUT":
            self.memory.setdefault("prefs", []).append({"key": body["key"], "value": body["value"]})
            return {"ok": True}
        if path.startswith("/api/device/prefs/") and method == "DELETE":
            key = path.rsplit("/", 1)[-1]
            self.memory["prefs"] = [p for p in self.memory.get("prefs", []) if p.get("key") != key]
            return {"ok": True}
        if path == "/api/device/memory/turn":
            return {"ok": True, "written": True}
        if path == "/api/device/proactive/decide":
            return self.decide
        raise BridgeError(f"unexpected path {method} {path}")


def make_history_module():
    history = []
    mod = SimpleNamespace(
        _sessions={"default": history},
        _history=history,
        _history_lock=threading.Lock(),
        loads=[],
        appends=[],
    )

    def original_load():
        mod.loads.append("local")

    def original_append(hist, user_text, reply):
        mod.appends.append((user_text, reply))
        hist.extend([{"role": "user", "content": user_text}, {"role": "assistant", "content": reply}])

    mod._load_history = original_load
    mod._append_history = original_append
    return mod


def make_prefs_module(initial=None):
    data = dict(initial or {})

    def get_preference(key):
        return data.get(key, "")

    def list_preferences():
        return dict(data)

    def set_preference(key, value):
        data[key] = value
        return f"已记住：{key}={value}"

    def del_preference(key):
        data.pop(key, None)
        return f"已忘记：{key}"

    return SimpleNamespace(
        _data=data,
        get_preference=get_preference,
        list_preferences=list_preferences,
        set_preference=set_preference,
        del_preference=del_preference,
    )


class MemoryBridgeTest(unittest.TestCase):
    def test_history_is_read_from_dotd(self):
        bridge = FakeBridge(
            memory={
                "threadId": "thr_1",
                "messages": [
                    {"role": "user", "content": "我对花生过敏", "createdAt": 1_700_000_000_000},
                    {"role": "assistant", "content": "记住了", "createdAt": 1_700_000_001_000},
                ],
                "prefs": [{"key": "wake_word", "value": "小豆"}],
            }
        )
        memory = DotdMemory(bridge)
        history = make_history_module()
        prefs = make_prefs_module({"wake_word": "旧值", "persona": "jarvis"})

        install_memory_bridge(memory, history_mod=history, prefs_mod=prefs)
        self.assertEqual(len(history._history), 2)
        self.assertEqual(history._history[0]["content"], "我对花生过敏")
        self.assertEqual(prefs.get_preference("wake_word"), "小豆", "dotd 的值优先")
        self.assertEqual(prefs.get_preference("persona"), "jarvis", "dotd 没有的键退回本地")
        self.assertEqual(prefs.list_preferences()["wake_word"], "小豆")

    def test_local_turn_is_mirrored_but_dotd_turn_is_not(self):
        bridge = FakeBridge()
        memory = DotdMemory(bridge)
        history = make_history_module()
        prefs = make_prefs_module()
        install_memory_bridge(memory, history_mod=history, prefs_mod=prefs)
        bridge.calls.clear()

        # 反射轮次：本地 append 之后补写 dotd。
        history._append_history(history._history, "晚安", "晚安，空调已关")
        mirrored = [c for c in bridge.calls if c[1] == "/api/device/memory/turn"]
        self.assertEqual(len(mirrored), 1)
        self.assertEqual(mirrored[0][2]["userText"], "晚安")

        bridge.calls.clear()
        # 皮层轮次：dotd 已经记过，标记后不再补写。
        memory.note_dotd_turn("帮我订明天的会议室")
        history._append_history(history._history, "帮我订明天的会议室", "订好了")
        mirrored = [c for c in bridge.calls if c[1] == "/api/device/memory/turn"]
        self.assertEqual(mirrored, [], "dotd 已处理的轮次不该写两遍")

    def test_offline_falls_back_to_local_cache(self):
        bridge = FakeBridge(online=False)
        memory = DotdMemory(bridge)
        history = make_history_module()
        prefs = make_prefs_module({"persona": "jarvis"})

        # 先塞一条本地历史，模拟上次运行留下的缓存。
        history._history.append({"role": "user", "content": "本地缓存里的话"})
        install_memory_bridge(memory, history_mod=history, prefs_mod=prefs)
        history._load_history()

        self.assertGreaterEqual(len(history.loads), 1, "dotd 不可达时应回落到本地缓存")
        self.assertTrue(all(x == "local" for x in history.loads))
        self.assertEqual(history._history[0]["content"], "本地缓存里的话")
        self.assertEqual(prefs.get_preference("persona"), "jarvis")
        self.assertIn("dotd", memory.last_sync_error or "")

    def test_pref_write_goes_to_dotd_and_local_cache(self):
        bridge = FakeBridge()
        memory = DotdMemory(bridge)
        history = make_history_module()
        prefs = make_prefs_module()
        install_memory_bridge(memory, history_mod=history, prefs_mod=prefs)
        bridge.calls.clear()

        out = prefs.set_preference("tts_voice", "zh_female_qingxin")
        self.assertIn("已记住", out)
        self.assertEqual(prefs._data["tts_voice"], "zh_female_qingxin", "本地缓存照写")
        puts = [c for c in bridge.calls if c[0] == "PUT" and c[1] == "/api/device/prefs"]
        self.assertEqual(len(puts), 1)
        self.assertEqual(puts[0][2], {"key": "tts_voice", "value": "zh_female_qingxin"})


class PushGateTest(unittest.TestCase):
    def test_allow_and_deny_follow_dotd(self):
        bridge = FakeBridge(decide={"allow": True})
        gate = PushGate(bridge=bridge)
        self.assertEqual(gate.decide("weather", "要下雨"), (True, None))

        bridge.decide = {"allow": False, "reason": "quiet_hours"}
        self.assertEqual(gate.decide("weather", "要下雨"), (False, "quiet_hours"))

    def test_exempt_kinds_never_ask_dotd(self):
        bridge = FakeBridge()
        gate = PushGate(bridge=bridge)
        for kind in ("reminder", "wake", "health"):
            self.assertEqual(gate.decide(kind, "x"), (True, None))
        self.assertEqual(bridge.calls, [], "提醒/唤醒/健康不该占用 dotd 的决策")

    def test_unreachable_fail_closed_by_default_and_open_when_configured(self):
        closed = PushGate(bridge=FakeBridge(online=False))
        self.assertEqual(closed.decide("weather", "要下雨"), (False, "unreachable_fail_closed"))

        opened = PushGate(bridge=FakeBridge(online=False), fail="open")
        self.assertEqual(opened.decide("weather", "要下雨"), (True, "unreachable_fail_open"))

    def test_install_replaces_upstream_send_points(self):
        sent = []
        notifications = SimpleNamespace(
            add_notification=lambda text, ntype="reminder": sent.append((text, ntype))
        )
        schedulers = SimpleNamespace(add_notification=notifications.add_notification)
        voice_server = SimpleNamespace(_add_notification=notifications.add_notification)
        personalized = SimpleNamespace(push_personalized_digest=lambda: sent.append(("热点", "digest")))

        bridge = FakeBridge(decide={"allow": False, "reason": "throttled"})
        gate = PushGate(bridge=bridge)
        install_push_gate(
            gate,
            notifications_mod=notifications,
            scheduler_modules=(schedulers,),
            personalized_push_mod=personalized,
            voice_server_mod=voice_server,
        )

        notifications.add_notification("要下雨", "weather")  # 被拒
        schedulers.add_notification("要下雨", "weather")     # 同一拒绝路径
        notifications.add_notification("吃药", "reminder")   # 豁免
        personalized.push_personalized_digest()              # 被拒
        self.assertEqual(sent, [("吃药", "reminder")])

        # 幂等：再装一次不会套两层。
        install_push_gate(gate, notifications_mod=notifications)
        notifications.add_notification("吃药", "reminder")
        self.assertEqual(sent.count(("吃药", "reminder")), 2)


if __name__ == "__main__":
    unittest.main()
