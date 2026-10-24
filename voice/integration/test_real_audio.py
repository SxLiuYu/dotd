"""voice/integration/test_real_audio.py —— 真音频验收（默认跳过，需显式开启）。

为什么单独一个文件：
    常规测试用合成 PCM / 假解码器，证明的是**管线接线**；这里用真实 TTS 语音、
    真实 Opus 编解码和真实 ASR 模型，证明的是**能听懂**。两者不能互相冒充。

开启方式：

    # 只测 TTS/Opus/ASR 软件链（任意平台，需 edge-tts + PyAV）
    DOTD_REAL_AUDIO=1 \
    SENSE_VOICE_MODEL=/path/to/sense-voice \
    python -m unittest voice.integration.test_real_audio -v

    # 再加"扬声器 → 空气 → 麦克风"声学闭环（Windows + sounddevice）
    DOTD_REAL_MIC=1 ...

    # libopus：一般不用管。OPUS_LIB 显式指定优先，其次找 PyAV 自带的
    # av.libs/libopus-*.dll，再退回系统查找（见 opus_runtime.py）。

没有 SenseVoice 时可用 DOTD_WHISPER_MODEL=small 走 faster-whisper；两者都没有
就 skip，不假装通过（tiny 的中文准确率不够做"听得懂"的断言）。

不做的事：
    - 不模拟 ESP32 固件（那是设备侧，不在本机）；
    - 不声称覆盖真人/远场/噪声场景（这里用的是合成语音）。
"""

from __future__ import annotations

import asyncio
import io
import os
import sys
import tempfile
import time
import unittest
import wave
from pathlib import Path

CHARLIE = Path(__file__).resolve().parents[1] / "charlie"
sys.path.insert(0, str(CHARLIE))

GATE = os.getenv("DOTD_REAL_AUDIO") == "1"
REFERENCE = "今天下午有雨，记得带伞"
TMP = Path(tempfile.mkdtemp(prefix="dotd-real-audio-"))


def _patch_opus_lib() -> None:
    """让 opuslib 找到 libopus（Windows 常常只有 PyAV 自带的那份）。

    实现已收敛到 voice/integration/opus_runtime.py：OPUS_LIB 显式指定优先，
    否则在 site-packages 里找 PyAV 的 av.libs/libopus-*.dll，再退回
    ctypes.util.find_library。
    """
    from voice.integration.opus_runtime import ensure_opus_library

    ensure_opus_library()


def _sapi_wav(text: str, path: Path) -> bool:
    """Windows 自带中文语音；不是 Windows 或没有中文音色就返回 False。"""
    if sys.platform != "win32":
        return False
    import subprocess

    ps = (
        "Add-Type -AssemblyName System.Speech; "
        "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        "try { $s.SelectVoice('Microsoft Huihui Desktop') } catch {}; "
        f"$s.SetOutputToWaveFile('{path}'); $s.Speak('{text}'); $s.Dispose()"
    )
    r = subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True)
    return r.returncode == 0 and path.is_file() and path.stat().st_size > 1000


def _edge_mp3(text: str) -> bytes | None:
    try:
        import edge_tts
    except ImportError:
        return None

    async def run() -> bytes:
        chunks = []
        async for ch in edge_tts.Communicate(text, "zh-CN-XiaoxiaoNeural").stream():
            if ch["type"] == "audio":
                chunks.append(ch["data"])
        return b"".join(chunks)

    try:
        data = asyncio.run(asyncio.wait_for(run(), timeout=20))
    except Exception:
        return None
    return data if len(data) > 100 else None


def _to_16k_wav(src: Path, dst: Path) -> bool:
    try:
        import av
    except ImportError:
        return False
    try:
        with av.open(str(src)) as ic, av.open(str(dst), "w", format="wav") as oc:
            ist = ic.streams.audio[0]
            ost = oc.add_stream("pcm_s16le", rate=16000, layout="mono")
            res = av.AudioResampler(format="s16", layout="mono", rate=16000)
            for fr in ic.decode(ist):
                for f in res.resample(fr):
                    f.pts = None
                    for p in ost.encode(f):
                        oc.mux(p)
            for f in res.resample(None):
                f.pts = None
                for p in ost.encode(f):
                    oc.mux(p)
    except Exception:
        return False
    return dst.is_file() and dst.stat().st_size > 1000


def _asr_engine():
    """优先 Charlie 的 SenseVoice；没有模型时回退 faster-whisper（尺寸可指定）。

    没有 SenseVoice、也没指定 DOTD_WHISPER_MODEL 时返回 (None, None)：faster-whisper
    的 tiny 模型中文准确率不足以做"听得懂"的验收断言（实测把
    「今天下午有雨，记得带伞」听成「今天下午由於記得帶閃」）。用弱模型跑出
    的错字不是产品缺陷，不能让验收变成误报。
    """
    import functools

    import agent.asr_tts as at

    model_dir = os.getenv("SENSE_VOICE_MODEL", "").strip()
    if model_dir and (Path(model_dir) / "model.int8.onnx").is_file():
        at.ASR_PRIORITY = ["sensevoice"]
        at.ASR_RACE = "0"
        # partial 不是 descriptor，挂到类上不会被当成方法绑定 self。
        return ("sensevoice", functools.partial(at.asr, fmt="wav"))

    size = os.getenv("DOTD_WHISPER_MODEL", "").strip()
    if not size:
        return (None, None)
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return (None, None)

    model = WhisperModel(size, device="cpu", compute_type="int8")

    def run(wav_bytes: bytes) -> str:
        segs, _ = model.transcribe(io.BytesIO(wav_bytes), language="zh", beam_size=1)
        return "".join(s.text for s in segs).strip()

    return (f"faster-whisper:{size}", functools.partial(run))


@unittest.skipUnless(GATE, "真音频验收默认关闭；设 DOTD_REAL_AUDIO=1 开启")
class RealAudioTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        _patch_opus_lib()
        try:
            from app import xiaozhi_codec as codec
        except Exception as exc:  # pragma: no cover - 环境缺失
            raise unittest.SkipTest(f"Charlie codec 不可用：{exc}")
        if codec.opuslib is None:
            raise unittest.SkipTest("opuslib / libopus 不可用")

        wav = TMP / "speech.wav"
        if _sapi_wav(REFERENCE, wav):
            if not _to_16k_wav(wav, TMP / "speech16k.wav"):
                raise unittest.SkipTest("PyAV 不可用，无法重采样到 16k")
            cls.wav16 = TMP / "speech16k.wav"
        else:
            mp3 = _edge_mp3(REFERENCE)
            if mp3 is None:
                raise unittest.SkipTest("没有可用的真实 TTS（SAPI / edge-tts）")
            mp3_path = TMP / "speech.mp3"
            mp3_path.write_bytes(mp3)
            if not _to_16k_wav(mp3_path, wav):
                raise unittest.SkipTest("PyAV 不可用，无法把 MP3 转成 16k WAV")
            cls.wav16 = wav

        cls.codec = codec
        cls.wav16 = TMP / "speech16k.wav"
        cls.engine_name, cls.asr = _asr_engine()
        if cls.asr is None:
            raise unittest.SkipTest(
                "没有可用的中文 ASR：设 SENSE_VOICE_MODEL 指向 SenseVoice 模型目录，"
                "或设 DOTD_WHISPER_MODEL=small（tiny 的中文准确率不够做验收断言）"
            )

    def test_real_speech_survives_opus_and_is_transcribed(self):
        pcm = wave.open(str(self.wav16)).readframes(10**9)
        enc = self.codec.opuslib.Encoder(16000, 1, self.codec.opuslib.APPLICATION_VOIP)
        packets = [enc.encode(pcm[o : o + 1920], 960) for o in range(0, len(pcm) - 1919, 1920)]
        self.assertGreater(len(packets), 10)

        decoded = self.codec.opus_decode_to_wav(packets, 16000)
        with wave.open(io.BytesIO(decoded)) as w:
            self.assertAlmostEqual(w.getnframes() / w.getframerate(), len(pcm) / 32000, delta=0.1)

        t0 = time.perf_counter()
        text = self.asr(decoded)
        ms = (time.perf_counter() - t0) * 1000
        print(f"\n[real-audio] {self.engine_name}: {text!r} in {ms:.0f} ms")
        # 允许标点差异，不允许语义漂移。
        compact = text.replace("，", "").replace(",", "").replace("。", "").replace(" ", "")
        self.assertIn("今天下午有雨", compact, f"ASR 结果不匹配：{text!r}")

    @unittest.skipUnless(
        os.getenv("DOTD_REAL_MIC") == "1" and sys.platform == "win32",
        "声学闭环需要 DOTD_REAL_MIC=1 + Windows 麦克风/扬声器",
    )
    def test_speaker_to_microphone_to_asr(self):
        try:
            import numpy as np
            import sounddevice as sd
        except ImportError:
            self.skipTest("sounddevice 不可用")

        sr = 48000
        src = TMP / "play48k.wav"
        if not _resample(self.wav16, src, sr):
            self.skipTest("无法生成 48k 播放样本")

        import numpy as np

        from scipy.io import wavfile

        _, play = wavfile.read(str(src))
        play = play.astype(np.float64)
        play = play / max(1e-9, np.abs(play).max()) * 20000
        buf = np.zeros(int(6.0 * sr), dtype=np.int16)
        buf[int(0.5 * sr) : int(0.5 * sr) + len(play)] = play.astype(np.int16)
        in_dev, out_dev = sd.default.device
        rec = sd.rec(int(6.0 * sr), samplerate=sr, channels=1, dtype="int16", device=in_dev)
        sd.play(buf, samplerate=sr, device=out_dev)
        sd.wait()

        mic = TMP / "mic48k.wav"
        wavfile.write(str(mic), sr, rec)
        rec16 = TMP / "mic16k.wav"
        self.assertTrue(_to_16k_wav(mic, rec16))
        pcm = wave.open(str(rec16)).readframes(10**9)
        samples = np.frombuffer(pcm, dtype=np.int16)
        self.assertGreater(int(np.abs(samples).max()), 1000, "麦克风没有收到声音")
        text = self.asr(pcm)
        print(f"\n[real-audio/mic] {self.engine_name}: {text!r}")
        compact = text.replace("，", "").replace(",", "").replace("。", "").replace(" ", "")
        self.assertIn("今天下午有雨", compact, f"声学闭环 ASR 不匹配：{text!r}")


def _resample(src: Path, dst: Path, rate: int) -> bool:
    try:
        import av
    except ImportError:
        return False
    try:
        with av.open(str(src)) as ic, av.open(str(dst), "w", format="wav") as oc:
            ist = ic.streams.audio[0]
            ost = oc.add_stream("pcm_s16le", rate=rate, layout="mono")
            res = av.AudioResampler(format="s16", layout="mono", rate=rate)
            for fr in ic.decode(ist):
                for f in res.resample(fr):
                    f.pts = None
                    for p in ost.encode(f):
                        oc.mux(p)
            for f in res.resample(None):
                f.pts = None
                for p in ost.encode(f):
                    oc.mux(p)
    except Exception:
        return False
    return dst.is_file() and dst.stat().st_size > 1000


if __name__ == "__main__":
    unittest.main()
