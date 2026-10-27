"""voice/integration/test_home_devices.py —— 家居设备层单测（2026-10-26）。

覆盖的是「合并后家居控制断链」这个缺陷的四个面：

1. **清单**：读得进来、坏条目跳过、门锁/摄像头这类安全设备拒绝登记、
   没有清单时按 TUYA_IR_DEVICE_ID + TUYA_AC_DEVICE_ID 兜出一台空调；
2. **解析**：空调模式/温度/风速、灯的开光与亮度、越界温度当没听懂；
3. **不误动**：否定句（「不要开灯」）、疑问句（「你是不是把灯关了」）、
   认不出设备、同名多房间无法消歧 —— 一律返回 None 交给 dotd 的模型，
   绝不猜一台设备去开关；
4. **执行**：适配器成功/失败都如实回报，history 记账，`control()` 的
   结构化入口（MCP 工具走这条）与语音入口共用同一份设备清单。

不碰网络、不碰真设备：所有适配器都是桩。
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from voice.integration import home_devices as hd  # noqa: E402

try:  # 清单是 YAML；没装 PyYAML 的机器上跳过「读清单」那几条
    import yaml  # noqa: F401

    HAS_YAML = True
except Exception:  # pragma: no cover
    HAS_YAML = False


DEVICES = [
    hd.Device(id="l1", name="客厅灯", adapter="tuya_cloud", kind="light",
              aliases=("大灯",), room="客厅"),
    hd.Device(id="l2", name="卧室灯", adapter="tuya_cloud", kind="light",
              aliases=("床头灯",), room="卧室"),
    hd.Device(id="ac1", name="空调", adapter="tuya_ir", kind="ac",
              aliases=("冷气", "暖气")),
    hd.Device(id="p1", name="书房插座", adapter="mqtt", kind="switch",
              aliases=("插座",), room="书房"),
]


class StubAdapter(hd.Adapter):
    """记录收到什么，按需成功/失败。"""

    name = "stub"

    def __init__(self, ok=True, message="ok"):
        self.ok = ok
        self.message = message
        self.calls = []

    def execute(self, cmd):
        self.calls.append(cmd)
        return hd.HomeResult(self.ok, self.message, cmd.device.id, cmd.action)


def _ctrl(devices=None, adapter=None):
    stub = adapter or StubAdapter()
    return hd.HomeController(devices=list(DEVICES if devices is None else devices),
                             adapters={"tuya_cloud": stub, "tuya_ir": stub, "mqtt": stub},
                             logger=lambda _m: None), stub


# ── 清单 ─────────────────────────────────────────────────────────────


class TestManifest(unittest.TestCase):
    def test_default_path_precedence(self):
        self.assertEqual(
            hd.default_manifest_path({"HOME_DEVICES_FILE": "/tmp/x.yml", "CHARLIE_DATA_DIR": "/data"}),
            os.path.expanduser("/tmp/x.yml"),
        )
        self.assertEqual(
            hd.default_manifest_path({"CHARLIE_DATA_DIR": "/data"}),
            os.path.join(os.path.expanduser("/data"), "home-devices.yml"),
        )
        self.assertTrue(hd.default_manifest_path({}).endswith(os.path.join(".charlie", "home-devices.yml")))

    def test_default_path_honours_assistant_kid_data_dir(self):
        """`one_system.apply_env` 设的是 ASSISTANT_KID_DATA_DIR，不是 CHARLIE_DATA_DIR。

        不认这个变量的话，真机上清单永远找不到，人只会看见"我明明写了文件"。
        """
        self.assertEqual(
            hd.default_manifest_path({"ASSISTANT_KID_DATA_DIR": "/data/voice"}),
            os.path.join(os.path.expanduser("/data/voice"), "home-devices.yml"),
        )
        # 两个都在时，CHARLIE_DATA_DIR 优先（显式大于派生）
        self.assertEqual(
            hd.default_manifest_path({"CHARLIE_DATA_DIR": "/a", "ASSISTANT_KID_DATA_DIR": "/b"}),
            os.path.join(os.path.expanduser("/a"), "home-devices.yml"),
        )

    @unittest.skipUnless(HAS_YAML, "没有 PyYAML")
    def test_load_from_yaml_and_reject_blocked_kind(self):
        text = """
devices:
  - id: l1
    name: 客厅灯
    aliases: [大灯, 顶灯]
    room: 客厅
    kind: light
    adapter: tuya_cloud
    device_id: dev-1
    dp: {switch: switch_led, brightness: bright_value}
  - id: lock1
    name: 门锁
    kind: lock
    adapter: tuya_cloud
    device_id: dev-lock
  - id: bad
    name: 没有适配器
"""
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "home-devices.yml")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(text)
            devs = hd.load_devices(path, env={})
        self.assertEqual([d.id for d in devs], ["l1"])
        self.assertEqual(devs[0].extra["dp"]["switch"], "switch_led")
        self.assertIn("brightness", devs[0].caps)

    @unittest.skipUnless(HAS_YAML, "没有 PyYAML")
    def test_missing_file_falls_back_to_tuya_env(self):
        env = {"TUYA_IR_DEVICE_ID": "ir-x", "TUYA_AC_DEVICE_ID": "ac-y"}
        devs = hd.load_devices(os.path.join(tempfile.gettempdir(), "definitely-not-here.yml"), env=env)
        self.assertEqual(len(devs), 1)
        self.assertEqual(devs[0].name, "空调")
        self.assertEqual(devs[0].adapter, "tuya_ir")
        self.assertEqual(devs[0].extra["infrared_id"], "ir-x")

    def test_no_file_no_env_is_empty_not_crash(self):
        devs = hd.load_devices(os.path.join(tempfile.gettempdir(), "definitely-not-here.yml"), env={})
        self.assertEqual(devs, [])


# ── 解析 ─────────────────────────────────────────────────────────────


class TestParseAction(unittest.TestCase):
    def setUp(self):
        self.ac = DEVICES[2]
        self.light = DEVICES[0]

    def test_ac_off_has_no_params(self):
        # 关机不带 mode/temp —— 否则部分空调会理解成「开机到 26 度」
        self.assertEqual(hd.parse_action("关空调", self.ac), ("off", {}))

    def test_ac_cool_26(self):
        self.assertEqual(hd.parse_action("空调制冷26度", self.ac), ("on", {"mode": 0, "temp": 26}))

    def test_ac_heat_with_fan(self):
        self.assertEqual(hd.parse_action("开制热 22 度 高风", self.ac),
                         ("on", {"mode": 1, "temp": 22, "fan": 3}))

    def test_ac_out_of_range_temp_is_not_understood(self):
        self.assertIsNone(hd.parse_action("空调调到 45 度", self.ac))

    def test_ac_without_action_or_param_is_not_understood(self):
        self.assertIsNone(hd.parse_action("空调怎么样", self.ac))

    def test_light_on_off(self):
        self.assertEqual(hd.parse_action("打开客厅灯", self.light), ("on", {}))
        self.assertEqual(hd.parse_action("关客厅灯", self.light), ("off", {}))

    def test_light_brightness(self):
        self.assertEqual(hd.parse_action("客厅灯调到 40%", self.light), ("set_brightness", {"brightness": 40}))

    def test_brightness_not_offered_when_kind_lacks_it(self):
        switch = hd.Device(id="p1", name="插座", adapter="mqtt", kind="switch")
        self.assertIsNone(hd.parse_action("插座调到 40%", switch))

    def test_negation_and_question_guarded_here_too(self):
        """守卫必须写在 parse_action 里，不能只在 handle() 里。

        只在 handle() 挡 = 「换个入口就能把『不要开灯』执行成开灯」，
        这正是本项目反复出过的缺陷类型（历史事故：ASR 把「你是不是把客厅
        空调关了」当关机指令，空调真的被关了）。
        """
        for text in ("不要开灯", "别开客厅灯", "不用关灯"):
            self.assertIsNone(hd.parse_action(text, self.light), text)
        for text in ("你是不是把灯关了", "灯开了吗", "刚才开灯了吗"):
            self.assertIsNone(hd.parse_action(text, self.light), text)


class TestMatchDevice(unittest.TestCase):
    def test_longest_term_wins(self):
        self.assertEqual(hd.match_device("开客厅灯", DEVICES).id, "l1")

    def test_bare_light_is_ambiguous(self):
        # 「开灯」没说哪个房间：两台灯都一样长，不能猜
        self.assertIsNone(hd.match_device("开灯", DEVICES))

    def test_room_disambiguates(self):
        same = [
            hd.Device(id="a", name="灯", adapter="mqtt", kind="light", room="客厅"),
            hd.Device(id="b", name="灯", adapter="mqtt", kind="light", room="卧室"),
        ]
        self.assertEqual(hd.match_device("开卧室的灯", same).id, "b")

    def test_unknown_device_returns_none(self):
        self.assertIsNone(hd.match_device("开空气净化器", DEVICES))

    def test_bare_kind_noun_matches_when_only_one_of_that_kind(self):
        """清单里叫「客厅空调」，主人只说「关空调」也要命中。

        2026-10-26 现场：只有品类词才能落地这条，否则整句甩给模型，
        而反射路径存在的意义就是不走模型。
        """
        only_ac = [
            hd.Device(id="ac1", name="客厅空调", adapter="tuya_ir", kind="ac", room="客厅"),
            hd.Device(id="l1", name="客厅灯", adapter="mqtt", kind="light", room="客厅"),
        ]
        self.assertEqual(hd.match_device("关空调", only_ac).id, "ac1")
        self.assertEqual(hd.match_device("开灯", only_ac).id, "l1")

    def test_bare_kind_noun_stays_ambiguous_with_two_of_that_kind(self):
        """两台空调时「关空调」仍然不猜 —— 品类词不能变成瞎猜的借口。"""
        two_ac = [
            hd.Device(id="ac1", name="客厅空调", adapter="tuya_ir", kind="ac", room="客厅"),
            hd.Device(id="ac2", name="卧室空调", adapter="tuya_ir", kind="ac", room="卧室"),
        ]
        self.assertIsNone(hd.match_device("关空调", two_ac))
        self.assertEqual(hd.match_device("关卧室空调", two_ac).id, "ac2")


# ── 执行 ─────────────────────────────────────────────────────────────


class TestController(unittest.TestCase):
    def test_handle_executes_and_reports(self):
        ctrl, stub = _ctrl()
        msg = ctrl.handle("打开客厅灯")
        self.assertEqual(msg, "ok")
        self.assertEqual(len(stub.calls), 1)
        self.assertEqual(stub.calls[0].device.id, "l1")
        self.assertEqual(stub.calls[0].action, "on")

    def test_handle_returns_none_when_not_sure(self):
        ctrl, stub = _ctrl()
        for text in ("不要开灯", "开灯", "今天天气怎么样"):
            self.assertIsNone(ctrl.handle(text), text)
        self.assertEqual(stub.calls, [])

    def test_handle_passes_failure_message_through(self):
        """失败必须如实说，不能播「已打开」。"""
        ctrl, _ = _ctrl(adapter=StubAdapter(ok=False, message="客厅灯 指令没发出去：超时"))
        self.assertIn("没发出去", ctrl.handle("打开客厅灯") or "")

    def test_handle_without_devices_returns_none(self):
        ctrl = hd.HomeController(devices=[], adapters={}, logger=lambda _m: None)
        self.assertIsNone(ctrl.handle("开客厅灯"))

    def test_handle_with_divergent_adapter_is_reported(self):
        """清单写了不存在的适配器：报「未知适配器」，不要静默成功。"""
        dev = hd.Device(id="x", name="神秘设备", adapter="nope", kind="light")
        ctrl = hd.HomeController(devices=[dev], adapters={}, logger=lambda _m: None)
        self.assertIn("未知适配器", ctrl.handle("打开神秘设备") or "")

    def test_control_accepts_aliases_of_action_names(self):
        ctrl, stub = _ctrl()
        for action in ("turn_on", "on", "open"):
            self.assertTrue(ctrl.control("客厅灯", action).ok, action)
            self.assertEqual(stub.calls[-1].action, "on")
        for action in ("turn_off", "off", "close"):
            self.assertTrue(ctrl.control("客厅灯", action).ok, action)
            self.assertEqual(stub.calls[-1].action, "off")
        self.assertEqual(len(stub.calls), 6)

    def test_control_brightness_requires_value(self):
        ctrl, _ = _ctrl()
        self.assertFalse(ctrl.control("客厅灯", "set_brightness", {}).ok)
        self.assertTrue(ctrl.control("客厅灯", "set_brightness", {"brightness": 30}).ok)
        # 工具层更自然的写法 percent 也认
        self.assertTrue(ctrl.control("客厅灯", "set_brightness", {"percent": 30}).ok)

    def test_control_unknown_device_names_candidates(self):
        ctrl, _ = _ctrl()
        r = ctrl.control("厨房灯", "on")
        self.assertFalse(r.ok)
        self.assertIn("客厅灯", r.message)

    def test_control_rejects_unknown_action(self):
        ctrl, _ = _ctrl()
        self.assertFalse(ctrl.control("客厅灯", "跳舞").ok)

    def test_control_by_id_and_by_name(self):
        ctrl, _ = _ctrl()
        self.assertTrue(ctrl.control("l1", "on").ok)
        self.assertTrue(ctrl.control("客厅灯", "on").ok)
        self.assertTrue(ctrl.control("大灯", "on").ok)  # alias

    def test_control_and_voice_agree_on_the_same_name(self):
        """两个入口对同一句称呼必须给同一个答案。

        2026-10-26 现场：清单里叫「客厅空调」，语音说「关空调」命中，
        而模型调 `home_control(device="空调")` 回"没有叫空调的设备"。
        同一句人话，两个入口两种结果 —— 这正是要消掉的漂移。
        """
        only_ac = [hd.Device(id="ac1", name="客厅空调", adapter="tuya_ir", kind="ac")]
        ctrl = hd.HomeController(
            devices=only_ac, adapters={"tuya_ir": StubAdapter()}, logger=lambda _m: None
        )
        self.assertIsNotNone(ctrl.handle("关空调"), "语音入口应命中")
        r = ctrl.control("空调", "off")
        self.assertTrue(r.ok, r.message)
        self.assertEqual(r.device, "ac1")

    def test_control_still_refuses_ambiguous_kind_noun(self):
        """品类词有歧义时工具入口也不能猜（和 match_device 同一把尺子）。"""
        two_ac = [
            hd.Device(id="ac1", name="客厅空调", adapter="tuya_ir", kind="ac"),
            hd.Device(id="ac2", name="卧室空调", adapter="tuya_ir", kind="ac"),
        ]
        ctrl = hd.HomeController(
            devices=two_ac, adapters={"tuya_ir": StubAdapter()}, logger=lambda _m: None
        )
        self.assertFalse(ctrl.control("空调", "off").ok)
        self.assertTrue(ctrl.control("卧室空调", "off").ok)

    def test_history_is_capped(self):
        ctrl, _ = _ctrl()
        for _ in range(260):
            ctrl.control("客厅灯", "on")
        self.assertLessEqual(len(ctrl.history), 200)
        self.assertTrue(all("durationMs" in h for h in ctrl.history))

    def test_public_shape(self):
        pub = DEVICES[0].to_public()
        self.assertEqual(pub["id"], "l1")
        self.assertEqual(pub["capabilities"], ["power", "brightness"])


class TestAdapters(unittest.TestCase):
    def test_ac_dry_run_does_not_hit_network(self):
        dev = hd.Device(id="ac", name="空调", adapter="tuya_ir", kind="ac",
                        extra={"infrared_id": "i", "remote_id": "r"})
        old = os.environ.get("HOME_AC_DRY_RUN")
        os.environ["HOME_AC_DRY_RUN"] = "1"
        try:
            r = hd.TuyaIrAdapter().execute(hd.Command(dev, "on", {"mode": 0, "temp": 26}))
        finally:
            if old is None:
                os.environ.pop("HOME_AC_DRY_RUN", None)
            else:
                os.environ["HOME_AC_DRY_RUN"] = old
        self.assertTrue(r.ok)
        self.assertIn("联调模式", r.message)

    def test_ac_adapter_rejects_non_ac_device(self):
        dev = hd.Device(id="l", name="灯", adapter="tuya_ir", kind="light")
        r = hd.TuyaIrAdapter().execute(hd.Command(dev, "on"))
        self.assertFalse(r.ok)
        self.assertIn("不是空调", r.message)

    def test_ac_adapter_reports_missing_ids(self):
        dev = hd.Device(id="ac", name="空调", adapter="tuya_ir", kind="ac")
        old = {k: os.environ.pop(k) for k in ("TUYA_IR_DEVICE_ID", "TUYA_AC_DEVICE_ID") if k in os.environ}
        try:
            r = hd.TuyaIrAdapter().execute(hd.Command(dev, "on"))
        finally:
            os.environ.update(old)
        self.assertFalse(r.ok)
        self.assertIn("infrared_id", r.message)

    def test_cloud_adapter_reports_missing_device_id(self):
        dev = hd.Device(id="l", name="客厅灯", adapter="tuya_cloud", kind="light")
        r = hd.TuyaCloudAdapter().execute(hd.Command(dev, "on"))
        self.assertFalse(r.ok)
        self.assertIn("device_id", r.message)

    def test_mqtt_adapter_reports_missing_topic(self):
        dev = hd.Device(id="p", name="插座", adapter="mqtt", kind="switch")
        r = hd.MqttAdapter().execute(hd.Command(dev, "on"))
        self.assertFalse(r.ok)
        self.assertIn("topic_cmnd", r.message)

    def test_esp32_adapter_reports_missing_ip(self):
        dev = hd.Device(id="tv", name="电视", adapter="esp32", kind="tv")
        old = os.environ.pop("ESP32_IP", None)
        try:
            r = hd.Esp32Adapter().execute(hd.Command(dev, "on"))
        finally:
            if old is not None:
                os.environ["ESP32_IP"] = old
        self.assertFalse(r.ok)
        self.assertIn("esp32_ip", r.message)


if __name__ == "__main__":
    unittest.main()
