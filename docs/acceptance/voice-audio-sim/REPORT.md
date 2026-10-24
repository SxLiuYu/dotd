# 音频链路自测（无硬件，2026-10-24）

## 结论

**软件管线的每一段都通；真实音频质量仍未验证。**

| 环节 | 验证方式 | 结果 |
|---|---|---|
| WebSocket 握手（hello / audio_params） | FastAPI TestClient 真 WS | ✅ opus / 24000Hz / 60ms |
| 上行 60ms 帧接收 | 合成 16kHz PCM，20 帧 | ✅ |
| VAD / 端点判定 | RMS 降级路径（本机无 silero） | ✅ 语音帧进入 utterance，静音不足 12 帧被忽略 |
| ASR 接缝 | 替身返回「你好小豆」 | ✅ `stt` 帧带回了文本 |
| 大脑接缝 | 替身 `brain_stream_sentences` | ✅ 收到 `llm` / TTS 流 |
| TTS 下行 | 替身 mp3 + opus 打包 | ✅ 收到 `tts start` 与下行音频帧 |
| 静音不回复 | 6 帧静音 + ping | ✅ 只收到 `pong`，没有 TTS |

命令：

```bash
python -m unittest voice.integration.test_audio_chain -v
# 或 npm run voice:test（含 tests/voice-audio-chain.test.ts）
```

证据：`tests/voice-audio-chain.test.ts` 会把上面两条用例接进 `npm test`。

## 没有验证的（不能冒充）

1. **真麦克风 / 真喇叭**：本机没有 ESP32、没有音频设备。
2. **真 ASR 准确率**：`asr_race` 在测试里是替身；本机没有 SenseVoice/Baidu key。
3. **真 TTS 音质**：`_synth_mp3` 是替身；ffmpeg 未安装。
4. **真 Opus 编解码**：`opuslib` 未安装，解码器与 `mp3_to_opus_packets` 都是替身。
5. 唤醒词（本地 KWS）与回声消除：属于固件侧，软件测不到。

## 真机验收清单（留给有硬件时）

- [ ] ESP32 连上 `/ws/xiaozhi`，说「你好小豆」→ 听到 wake beep；
- [ ] 说一句「开灯」→ 反射命中，不经过 dotd，< 1.2s 完成；
- [ ] 说一句需要规划的话 → 设备拿到 dotd 的回复并播放；
- [ ] 拔网线 → 说「晚安」仍能执行本地场景，并明确说「大脑不在线」；
- [ ] 恢复网络 → 离线补传出现在 `dotd feed` 的 `voice_events` 里。
