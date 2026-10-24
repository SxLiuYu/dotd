# 03 — 依赖清理 + preflight 检测

**What to build:** 新环境 `pip install -r requirements-core.txt` 能装齐核心依赖并跑起对话；启动时 preflight 模块检测外部二进制（ffmpeg/ollama/ncm/ego-browser/esptool）缺失并打印安装指引，不阻塞启动。

**Blocked by:** None — 可立即开始

**Status:** ready-for-agent

- [x] requirements.txt 删 `dotenv==0.9.9`（与 python-dotenv 重复）
- [x] requirements.txt 删 `httpcore2`/`httpx2`（确认无显式 import 后）
- [x] requirements.txt 补 `sherpa_onnx`（SenseVoice ASR 必需）
- [x] 拆 `requirements-core.txt`（核心对话）/ `requirements-optional.txt`（sherpa_onnx/silero-vad/vosk/opuslib）/ `requirements-dev.txt`（pytest）
- [x] 新建 app/preflight.py：check_binary(name) 检测 PATH，缺失打印 brew/apt/下载指引
- [x] 启动时调用 preflight，结果写 logs/preflight.log
- [x] pip install -r requirements-core.txt 成功，voice_server 能启动
