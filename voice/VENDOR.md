# voice/ 的来源与边界

这个目录是 **Charlie 语音助手** 的上游源码，作为 dotd 的「语音/硬件前端」vendored 进来。

| 项 | 值 |
|---|---|
| 上游 | https://github.com/SxLiuYu/charlie-voice-assistant |
| 引入提交 | `710d2c4bd2d4d015b0e7ee5af4038e89e4d25827`（2026-09-22） |
| 引入日期 | 2026-10-23 |
| 上游声明 | README 写 MIT；仓库里**没有 LICENSE 文件**（`api.github.com` 的 license 字段为 null） |
| 本地改动 | 只新增 `voice/integration/`（dotd 桥），不改上游文件 |

## 边界

1. **上游代码原样保留**：升级时整目录替换，不在这里打补丁。需要改行为，先提到
   `voice/integration/` 或回上游提 PR。
2. **不把 Charlie 的大脑搬进来**：`voice_agent.py` 的意图识别/LLM 循环仍在上游文件里，
   但合并后的产品路径是 **Charlie → `voice/integration/dotd_bridge.py` → dotd**。
   本地快路径（场景词、提醒）可以保留，但必须向 dotd 记账。
3. **不做 Python→TypeScript 重写**：语音、红外、ESP32、ASR/TTS 的生态在 Python；
   dotd 的内核在 TypeScript。两个运行时、一个产品，靠 HTTP + MCP 接，不靠合语言。

## 许可证（2026-10-24 已处理）

上游 README 声称 MIT，但仓库当时**没有 LICENSE 文件**。开源发布前已处理：

- 本仓库维护者即上游作者（GitHub `SxLiuYu`，上游提交者 `yujinze`）；
- 在 `voice/` 补入 MIT `LICENSE`，并在 `voice/NOTICE` 记录归属与双许可口径；
- 第三方来源统一登记在仓库根目录 `THIRD_PARTY.md`。

若未来从**其他**第三方 fork 引入代码，必须逐个补来源、提交号与许可，不得默认沿用本目录的 MIT。
