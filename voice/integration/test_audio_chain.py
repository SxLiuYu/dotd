"""voice/integration/test_audio_chain.py —— 无硬件条件下的音频链路自测（阶段 5，2026-10-24）。

## 它验证什么（以及不验证什么）

真的 ESP32 不在本机，ASR/TTS 模型与麦克风也不在。这里用**合成音频**跑通软件侧的
整条链路，证明「帧从 WebSocket 进来、VAD 端点、ASR 接缝、大脑接缝、TTS 帧发回去」
这条管线是通的：

    hello 握手 → listen/start → 20 帧 16kHz PCM(60ms)
      → VAD 判定为语音 → listen/stop
      → ASR 接缝拿到 WAV → 返回文本
      → 大脑接缝拿到文本 → 返回一句
      → TTS 接缝产出音频帧 → WS 回发

**不验证**：真实麦克风信噪比、ASR 识别准确率、TTS 音质、Opus 编解码真实现
（本机没有 opuslib / ffmpeg，`opuslib` 与编解码函数在测试里被替换）。
这些仍然需要真机验收，不能拿本测试冒充。

不联网、不占端口、不依赖硬件。
"""

from __future__ import annotations

import math
import struct
import sys
import types
import unittest
from pathlib import Path

CHARLIE = Path(__file__).resolve().parents[1] / "charlie"
sys.path.insert(0, str(CHARLIE))

# ── 假 Charlie 模块：必须在 import app.xiaozhi_ws 之前注入 ─────────────

_fake_voice_agent = types.ModuleType("voice_agent")
_fake_voice_agent.asr_race = lambda wav, fmt: ("你好小豆", "fake-asr")
_fake_voice_agent.is_low_intent_asr = lambda text: False
_fake_voice_agent.is_garbled_asr = lambda text: False
_fake_voice_agent.brain_status = lambda: {"provider": "fake"}
_fake_voice_agent.__dict__["brain"] = lambda text, session_id="default": "好的"


def _brain_stream_sentences(text, session_id="default", interrupted_reply="", cancel_event=None):
    reply = "好的，收到"
    yield reply, reply


_fake_voice_agent.brain_stream_sentences = _brain_stream_sentences
sys.modules["voice_agent"] = _fake_voice_agent

_fake_intent = types.ModuleType("agent.intent")
_fake_intent.LOW_INTENT_ASR_REPLY = "嗯"
_fake_intent.strip_wake_word = lambda text: text
sys.modules["agent.intent"] = _fake_intent

import app.xiaozhi_codec as codec  # noqa: E402
import app.xiaozhi_ws as xw  # noqa: E402

SAMPLE_RATE = 16000
FRAME_SAMPLES = 960  # 60ms


def loud_pcm(samples: int = FRAME_SAMPLES, freq: float = 440.0, amp: int = 8000) -> bytes:
    return b"".join(
        struct.pack("<h", int(amp * math.sin(2 * math.pi * freq * i / SAMPLE_RATE)))
        for i in range(samples)
    )


class FakeDecoder:
    """替身 Opus 解码器：每帧返回一帧响亮的 PCM。"""

    def __init__(self, *args, **kwargs):
        pass

    def decode(self, pkt, samples, *args, **kwargs):
        return loud_pcm(samples)


class _FakeOpusLib:
    Decoder = FakeDecoder


# 编解码替身：本机没有 opuslib / ffmpeg，这里只验证「管线是否把帧传到了接缝」。
xw.opuslib = _FakeOpusLib()
xw.opus_decode_to_wav = lambda frames, rate=SAMPLE_RATE: codec.pcm_to_wav(
    loud_pcm(SAMPLE_RATE // 2), rate
)
xw.mp3_to_opus_packets = lambda mp3, *a, **k: [b"OPUS-FRAME"]
xw._synth_mp3 = lambda sentence, **kwargs: b"FAKE-MP3" * 40  # >100 字节


class AudioChainTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from fastapi import FastAPI

        cls.app = FastAPI()
        xw.register_xiaozhi_routes(cls.app)

    def test_synthetic_utterance_reaches_asr_brain_and_tts(self):
        from fastapi.testclient import TestClient

        with TestClient(self.app) as client:
            with client.websocket_connect("/ws/xiaozhi") as ws:
                ws.send_json({"type": "hello", "device_id": "test-device"})
                hello = ws.receive_json()
                self.assertEqual(hello["type"], "hello")
                self.assertEqual(hello["audio_params"]["format"], "opus")
                self.assertEqual(hello["audio_params"]["sample_rate"], 24000)

                ws.send_json({"type": "listen", "state": "start"})
                # 3 帧建立 speech-active，再给足 12 帧 MIN_SPEECH_FRAMES。
                for _ in range(20):
                    ws.send_bytes(b"opus-packet")
                ws.send_json({"type": "listen", "state": "stop"})

                texts = []
                audio_frames = 0
                tts_started = False
                for _ in range(40):
                    msg = ws.receive()
                    if msg.get("type") == "websocket.close":
                        break
                    if msg.get("bytes") is not None:
                        audio_frames += 1
                        continue
                    if "text" not in msg:
                        continue
                    import json

                    data = json.loads(msg["text"])
                    texts.append(data)
                    if data.get("type") == "tts" and data.get("state") == "start":
                        tts_started = True
                    if tts_started and data.get("type") == "tts" and data.get("state") == "stop":
                        break

                stt = [d for d in texts if d.get("type") == "stt"]
                self.assertTrue(stt, f"没有收到 ASR 文本帧：{texts}")
                self.assertEqual(stt[0]["text"], "你好小豆")
                self.assertTrue(
                    any(d.get("type") in ("llm", "tts") for d in texts),
                    f"大脑/TTS 没有接上：{texts}",
                )
                self.assertTrue(tts_started, f"TTS 没有开始：{texts}")
                self.assertGreater(audio_frames, 0, "没有收到任何下行音频帧")

    def test_silent_utterance_is_ignored(self):
        """端点判定：不足 MIN_SPEECH_FRAMES 的静音不应触发 ASR/TTS。"""
        from fastapi.testclient import TestClient

        # 让解码器返回静音；其余接缝保持不变。
        class SilentDecoder(FakeDecoder):
            def decode(self, pkt, samples, *args, **kwargs):
                return b"\x00\x00" * samples

        original = xw.opuslib
        xw.opuslib = types.SimpleNamespace(Decoder=SilentDecoder)
        try:
            with TestClient(self.app) as client:
                with client.websocket_connect("/ws/xiaozhi") as ws:
                    ws.send_json({"type": "hello", "device_id": "test-device"})
                    ws.receive_json()
                    ws.send_json({"type": "listen", "state": "start"})
                    for _ in range(6):
                        ws.send_bytes(b"opus-packet")
                    ws.send_json({"type": "listen", "state": "stop"})
                    ws.send_json({"type": "ping"})
                    # 静音被忽略时，唯一会来的消息是 pong。
                    msg = ws.receive()
                    import json

                    data = json.loads(msg["text"])
                    self.assertEqual(data.get("type"), "pong", f"静音不该产生回复：{data}")
        finally:
            xw.opuslib = original


if __name__ == "__main__":
    unittest.main()
