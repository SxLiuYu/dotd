"""log_triage 的回归测试：只降"架构内预期失败"，别误伤真故障。

守四件事：
  1. 已知的"必然失败"（未配 LLM / 百度预热 / 空白端点拼 URL / Silero 缺失 /
     demo 三连 / preflight 可选项）→ 降到 INFO，once 类只留一条；
  2. 同样文字的真故障（含"预热失败"但原因不是缺 key）→ **原样 WARNING**；
  3. 因为 logger 是 Charlie 全站共用的 `magic`（107 个模块），判定必须严格按
     消息内容 —— 别的模块的 WARNING 一条都不能吞；
  4. 明确"不许降噪"的几类必须保持 WARNING：缺必需密钥点名、SenseVoice 模型
     缺失（=设备听不见）、ffmpeg 缺失（=音频转码必需）。
"""

from __future__ import annotations

import logging
import unittest

from voice.integration import log_triage


class LogTriageTest(unittest.TestCase):
    def setUp(self) -> None:
        # 每个用例用独立 logger，避免全局注册表互相影响。
        self.name = f"magic-test-{id(self)}"
        self.logger = logging.getLogger(self.name)
        self.logger.handlers = []
        self.logger.propagate = False
        self.logger.setLevel(logging.DEBUG)
        self.records: list[logging.LogRecord] = []

        class _Cap(logging.Handler):
            def emit(inner, record):  # noqa: N805
                self.records.append(record)

        self.logger.addHandler(_Cap())
        # install() 有全局幂等标记；每例重置它，才能给不同 logger 装。
        log_triage._installed = False
        log_triage.install(self.name)

    def _levels(self) -> list[str]:
        return [r.levelname for r in self.records]

    def test_downgrades_missing_llm_and_only_once(self):
        msg = "[warmup] brain(none) 预热失败: 未配置 LLM。请至少配置一个 LLM Provider 的 API Key。"
        for _ in range(3):
            self.logger.warning(msg)
        self.assertEqual(self._levels(), ["INFO"], "只应留一条，且降到 INFO")
        self.assertIn("大脑是 dotd", self.records[0].getMessage())

    def test_real_failure_stays_warning(self):
        self.logger.warning("[warmup] brain(none) 预热失败: No module named 'soundfile'")
        self.assertEqual(self._levels(), ["WARNING"], "别的失败原因不能被降噪")

    def test_baidu_warmup_downgraded_and_only_once(self):
        # 没配 BAIDU_* 时上游仍会换 token，必然 400，两条（ASR/TTS）各一次。
        for _ in range(2):
            self.logger.warning("[warmup] 百度token预热失败(不影响使用): 400 Client Error")
            self.logger.warning("[warmup] 百度TTS预热失败(不影响使用): 400 Client Error")
        self.assertEqual(self._levels(), ["INFO"], "百度预热只解释一次")
        self.assertIn("走 Edge", self.records[0].getMessage())

    def test_runtime_baidu_failure_stays_warning(self):
        # 真在用百度合成时失败 —— 没有 "不影响使用"，必须保留 WARNING。
        self.logger.warning("[tts] baidu 失败(不影响使用): 401 unauthorized")
        self.assertEqual(self._levels(), ["WARNING"])

    def test_two_categories_do_not_consume_each_other(self):
        # 两类共用"只降一次"标记会互相吞：先到的把后到的吃掉。
        self.logger.warning("[warmup] 百度TTS预热失败(不影响使用): 400")
        self.logger.warning("[warmup] brain(none) 预热失败: 未配置 LLM。")
        self.assertEqual(self._levels(), ["INFO", "INFO"], "两类各留一条")
        self.assertIn("走 Edge", self.records[0].getMessage())
        self.assertIn("大脑是 dotd", self.records[1].getMessage())

    def test_intent_empty_endpoint_downgraded(self):
        msg = (
            "[intent] 本地分类失败,默认none: text='你好' err=Invalid URL '/chat/completions': "
            "No scheme supplied. Perhaps you meant https:///chat/completions?"
        )
        self.logger.warning(msg)
        self.logger.warning(msg)
        self.assertEqual(self._levels(), ["INFO"], "空白端点拼 URL 只解释一次")
        self.assertIn("dotd 决定", self.records[0].getMessage())

    def test_silero_missing_downgraded(self):
        self.logger.warning(
            "[xiaozhi] Silero VAD load fail, fallback to RMS endpointing: "
            "No module named 'silero_vad'"
        )
        self.assertEqual(self._levels(), ["INFO"])
        self.assertIn("RMS", self.records[0].getMessage())

    def test_demo_banner_dropped(self):
        self.logger.warning("=== Demo 模式已启用 ===")
        self.logger.warning("推荐: 打开 http://localhost:8000/welcome 引导页")
        self.assertEqual(self._levels(), [], "两行纯噪音直接丢")

    def test_demo_note_rewritten(self):
        self.logger.warning("未配置 ARK_KEY / GLM_KEY，大脑将使用 Ollama 本地模型。")
        self.assertEqual(self._levels(), ["INFO"])
        self.assertIn("不是 Ollama", self.records[0].getMessage())

    def test_preflight_optional_downgraded_but_kept(self):
        self.logger.warning("[preflight] ❌ ncm 未安装 — 网易云音乐 CLI (音乐播放（可选）)")
        self.assertEqual(self._levels(), ["INFO"], "可选依赖不该报红")
        self.assertIn("ncm", self.records[0].getMessage(), "原文保留，便于按名字排查")

    def test_preflight_required_stays_warning(self):
        self.logger.warning("[preflight] ❌ ffmpeg 未安装 — apt install ffmpeg (音频转码（ASR/TTS 必需）)")
        self.assertEqual(self._levels(), ["WARNING"], "必需项不能降噪")

    def test_local_wake_missing_dep_downgraded(self):
        # 2026-10-25 部署后实测的两条：openwakeword 不在任何 requirements 里，
        # 服务器也没有麦克风。第一层是细节，直接丢；第二层换成一句人话。
        self.logger.warning("[wake] openwakeword 未安装，运行 pip install openwakeword")
        self.logger.warning("[wake] 无可用唤醒词模型 (openWakeWord/sherpa)，本地唤醒词不可用")
        self.assertEqual(self._levels(), ["INFO"], "第一条直接丢，只留一条解释")
        self.assertIn("ESP32", self.records[0].getMessage())
        self.assertIn("正常", self.records[0].getMessage())

    def test_local_wake_explained_even_if_dep_warning_absent(self):
        # 装上了 openwakeword 但模型加载失败时只会出现第二条 —— 不能被第一条的
        # once 标记挡住（两条故意用了不同的 kind）。
        self.logger.warning("[wake] openwakeword 未安装，运行 pip install openwakeword")
        self.logger.warning("[wake] 无可用唤醒词模型 (openWakeWord/sherpa)，本地唤醒词不可用")
        self.logger.warning("[wake] 无可用唤醒词模型 (openWakeWord/sherpa)，本地唤醒词不可用")
        self.assertEqual(self._levels(), ["INFO"], "只解释一次，不重复刷屏")

    def test_wake_runtime_failure_stays_warning(self):
        # 真在用唤醒词时的问题（麦克风打不开、回调炸了）必须保留。
        self.logger.warning("[wake] 音频播放失败: PortAudioError: Device unavailable")
        self.logger.warning("[wake] 回调失败: boom")
        self.assertEqual(self._levels(), ["WARNING", "WARNING"])

    def test_missing_env_keys_and_sensevoice_stay_warning(self):
        # 这两条是"真该有人去处理"的信息：缺哪个 key 点名了、模型缺失会让设备听不见。
        self.logger.warning(
            "[env] 缺少4个必需密钥: ['BAIDU_APP_ID', 'BAIDU_API_KEY', 'BAIDU_SECRET_KEY', 'AMAP_KEY']"
        )
        self.logger.warning("[asr] SenseVoice 模型不存在: /x/model.int8.onnx, 跳过本地ASR")
        self.assertEqual(self._levels(), ["WARNING", "WARNING"])

    def test_unrelated_warning_not_swallowed(self):
        self.logger.warning("[feishu-ws] 启动失败: No module named 'lark_oapi'")
        self.logger.warning("[tts] baidu 失败: 400")
        self.assertEqual(self._levels(), ["WARNING", "WARNING"])

    def test_install_is_idempotent(self):
        self.assertTrue(log_triage.install(self.name))
        before = len(self.logger.filters)
        self.assertTrue(log_triage.install(self.name))
        self.assertEqual(len(self.logger.filters), before, "重复 install 不能套娃")

    def test_install_covers_device_logger_too(self):
        # xiaozhi_ws 用 getLogger(__name__)，不在 `magic` 名下。只装 magic 会让
        # Silero VAD 那条继续报红（2026-10-25 首次部署后实测）。
        magic = f"magic-cover-{id(self)}"
        device = f"app.xiaozhi_ws-cover-{id(self)}"
        log_triage._installed = False
        log_triage.install((magic, device))
        for name in (magic, device):
            lg = logging.getLogger(name)
            self.assertTrue(
                any(isinstance(f, log_triage._Downgrade) for f in lg.filters),
                f"{name} 上没装降噪 filter",
            )
            lg.handlers = []
            lg.propagate = False
            lg.setLevel(logging.DEBUG)


if __name__ == "__main__":
    unittest.main()
