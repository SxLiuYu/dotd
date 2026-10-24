# 真音频验收报告（2026-10-24）

这篇报告回答一个问题：**除了合成 PCM，这台机器还能不能测真声音？**

结论：能。用系统自带中文 TTS / Edge TTS 生成真实语音，经**真实扬声器 → 空气 →
Realtek 麦克风**采集，再走**真实 Opus 编解码**和 Charlie 默认的**本地 SenseVoice
ASR**，端到端识别结果与原文一致。ESP32 硬件和真人/远场语音仍然没有，但"音频链路
只能靠假数据"这个说法不成立。

## 环境

| 项 | 值 |
|---|---|
| OS | Windows（Git Bash / PowerShell） |
| CPU | Intel Xeon E5-2686 v4 @ 2.30GHz ×2 |
| RAM | 63.9 GB |
| Python | 3.11.9 |
| 输入设备 | 麦克风 (3- Realtek High Definition Audio)，Active |
| 输出设备 | 扬声器 (3- Realtek High Definition Audio)，Active |
| 语音 TTS（系统） | Microsoft Huihui Desktop (zh-CN) |
| 语音 TTS（云端） | Edge TTS `zh-CN-XiaoxiaoNeural` / `zh-CN-YunxiNeural` |
| 本地 ASR | sherpa-onnx + SenseVoice `model.int8.onnx`（239 MB） |
| Opus | PyAV 自带 `libopus-0-*.dll`，由 `opuslib` 加载 |
| ffmpeg | `imageio-ffmpeg` 自带 7.1 静态二进制 |

## 结论

| 检查 | 方法 | 结果 |
|---|---|---|
| 真实 TTS（系统） | SAPI 中文音色合成 3.44 s WAV | ✅ 151,674 B @ 22050 Hz |
| 真实 TTS（Edge） | `zh-CN-XiaoxiaoNeural` 流式合成 | ✅ 18,864 B MP3；TTFB **1.105 s**；全量 **3.238 s** |
| 真实 Opus 上行 | 16 kHz / 60 ms 编码 → Charlie `opus_decode_to_wav` | ✅ 57 包 / 3.42 s；解码时长一致 |
| 真实 Opus 下行 | Edge MP3 → ffmpeg → Opus（24 kHz） | ✅ 52 包 / 446 ms；解码 RMS 2954 |
| Opus 后 ASR | 解码语音 → SenseVoice | ✅ **识别与原文完全一致** |
| 真实 ASR（本地） | Charlie `asr()` + SenseVoice | ✅ 首次 3.05 s（含加载），热启动 **302–337 ms** |
| 真实 ASR（Whisper） | faster-whisper large-v3（对照） | ✅ 原文一致，但 CPU **16–17 s** |
| 真实麦克风采集 | sounddevice 录 Realtek 麦克风 | ✅ 房间底噪 RMS ≈ 3.7；播放语音时 RMS 1408–2065、峰值 21k–31k |
| **声学闭环** | Edge/SAPI → 扬声器 → 空气 → 麦克风 → Opus → SenseVoice | ✅ **识别原文一致** |
| Charlie ASR 接缝 | 注册真实 provider 后调 `asr()` | ✅ 原文一致 |
| Charlie TTS 接缝 | `tts()` 走 edge provider | ✅ 18,864 B / 2.76–3.24 s |

## 关键证据

### 1. Opus 编解码后仍能被正确识别

```
输入原文：今天下午有雨，记得带伞
干净 16k：今天下午有雨，记得带伞。   (SenseVoice 302 ms)
Opus 解码：今天下午有雨，记得带伞。   (SenseVoice 334 ms)
```

Opus 是有损压缩，波形相关系数不适合直接当判据（编码器有算法延迟/DTX）；这里用
**下游 ASR 是否仍能还原同一句话**作判据，比 SNR 更贴近产品语义。

### 2. 声学闭环（不是电气回环，不是合成 PCM）

```
Edge TTS → Realtek 扬声器（音量 100%，解除静音）→ 空气 → Realtek 麦克风
→ 48k 录音 → 16k 重采样 → Opus 66 包 → SenseVoice
识别：'今天下午有雨，记得带伞。'
```

麦克风录音 RMS 2065.7、峰值 31580；不是"静音文件被 ASR 幻觉成一句话"。

### 3. SenseVoice 的真实延迟

上游注释写的是 ~26 ms。这台 Xeon E5 上实测：

- 首次调用 **3050.8 ms**（含 ONNX 模型加载）；
- 热启动 **302.0 / 302.6 / 334 / 337 ms**（4 s 左右音频）。

**26 ms 在本机不成立**，不能把上游注释当验收数字。334 ms 仍远小于云端往返，
但 CPU 与模型量化版本会显著影响结果。

### 4. Whisper 对照

| 模型 | 结果 | 耗时（3.4 s 音频） |
|---|---|---|
| tiny | `今天下午由於記得帶閃` ❌ | 含加载 23.3 s |
| large-v3 | `今天下午有雨,记得带伞。` ✅ | 含加载 49.1 s；热启动 16–17 s |

tiny 的错误恰好说明"随便找个模型测一下"会得出错误结论：模型选择本身就是变量。

## 重复跑

真音频验收默认关闭（需要模型/音频设备/网络，不适合当 CI 门禁）：

```bash
pip install -r voice/requirements-real-audio.txt

# 软件链：真实 TTS → Opus → SenseVoice
DOTD_REAL_AUDIO=1 \
OPUS_LIB='C:\path\to\opus.dll' \
SENSE_VOICE_MODEL='C:\path\to\sense-voice' \
python -m unittest voice.integration.test_real_audio -v

# 再加声学闭环（Windows + 麦克风/扬声器）
DOTD_REAL_AUDIO=1 DOTD_REAL_MIC=1 ...同上...
```

测试文件：`voice/integration/test_real_audio.py`
（没有依赖或没有模型时 `skip`，不会假装通过。）

## 仍然没有覆盖

1. **ESP32 固件/硬件**：本机没有设备。WS 协议与 Opus 帧已在进程内验证，但设备的
   麦克风、AEC、Wi-Fi 抖动、喇叭音量没有实测。
2. **真人语音 / 远场 / 噪声**：闭环用的是 TTS 语音。TTS 没有口音、停顿、背景噪声，
   不能替代真人 ASR 准确率。
3. **云 ASR/TTS 厂商**（百度 / StepFun / Finna / Audio8）：本机没有对应 key 或
   本地服务（Audio8 `127.0.0.1:8024` 未启动），未测。
4. **端到端 2.5 s 目标**：本次只测音频段。音频段热路径约
   `SenseVoice 0.3 s + Edge TTS TTFB 1.1 s + Opus 0.1–0.4 s`。
   当时 LLM TTFT P50 是 **4.8 s**，瓶颈在模型网关、不在音频。
   **2026-10-24 已把 primary/light 换成 `deepseek-v4.1-flash`**，同日真 daemon
   端到端首条 P50 降到 **2.02 s**（见 `docs/acceptance/model-latency/REPORT.md`）。
