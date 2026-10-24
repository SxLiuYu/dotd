# 第三方来源与许可

本仓库包含两类代码：

| 目录 | 来源 | 许可 |
|---|---|---|
| `src/`、`scripts/`、`db/`、`web-ui/`、`config/`、`docs/` | 本项目原创 | Apache-2.0（`LICENSE`） |
| `voice/charlie/`、`voice/scripts/` | [charlie-voice-assistant](https://github.com/SxLiuYu/charlie-voice-assistant)（vendored，提交 `710d2c4`） | MIT（`voice/LICENSE`） |
| `voice/Baize/` | 同上（Charlie 上游随附的 Baize 模块；自带 `voice/Baize/LICENSE`） | Apache-2.0 |
| `voice/integration/` | 本项目原创（运行时接缝） | Apache-2.0 或 MIT，二选一 |

## 运行时依赖（主要）

| 依赖 | 用途 | 许可 |
|---|---|---|
| Node.js | 运行时 | MIT |
| TypeScript / tsx | 构建与测试 | Apache-2.0 / MIT |
| `node:sqlite` | 内嵌数据库 | Node.js 自带 |
| `commander`、`yaml`、`zod`、`cron-parser` | CLI / 配置 / 校验 / 调度 | MIT |
| `dockerode` | 容器控制 | Apache-2.0 |
| `@larksuiteoapi/node-sdk` | 飞书 | MIT |
| FastAPI / Uvicorn / Starlette | 语音服务 | MIT / BSD-3-Clause |
| `requests`、`httpx` | HTTP 客户端 | Apache-2.0 / BSD-3-Clause |
| MCP Python SDK | 工具接缝 | MIT |

音频可选依赖（本仓库不随附）：`opuslib`（BSD）、`silero-vad`（MIT）、`ffmpeg`（LGPL/GPL，
取决于构建选项）。分发二进制/镜像前请自行复核 ffmpeg 的构建许可。

## 新增第三方代码时

1. 在 `voice/NOTICE` 或本文件里补来源、提交号、许可；
2. 保留原版权声明与许可全文；
3. 不要在未确认许可的情况下把代码并入发布产物。
