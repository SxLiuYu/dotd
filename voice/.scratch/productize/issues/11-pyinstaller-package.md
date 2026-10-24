# 11 — 桌面包 PyInstaller 打包 + 首次启动

**What to build:** 跑 build.sh 生成 dist/charlie/ 桌面包（~200MB，含核心 Python + web 资源 + ffmpeg binary，不含模型/Ollama）；双击 charlie 启动 → 检测 .env → 缺失则生成证书 + 开浏览器到 /welcome → 引导走通 → 主界面。3 分钟内能完成一次 Demo 规则对话。

**Blocked by:** 02, 03, 05, 06, 09 — 地基（硬编码+依赖+证书）+ 引导页 + 模型下载就绪

**Status:** ready-for-agent

- [x] charlie.spec 完善：打包 voice_server/voice_agent/app/web/magic-*.py + ffmpeg binary
- [x] build.sh：打包前跑 pytest 验证；cp .env.example 为 .env（空白模板）；打 scripts/gen-cert.sh
- [x] charlie_main.py frozen 模式：调 preflight.check_binary + 缺 .env 开浏览器到 /welcome
- [x] 缺 cert/ 时 frozen 模式自动调 gen-cert.sh
- [x] dist/charlie/ 生成，双击 charlie 启动
- [x] 双击 → 浏览器自动开到 /welcome（缺 .env 时）
- [x] 选 Demo规则 → 完成 → 主界面 → 说"几点了" → Charlie 报时间（3 分钟内）
- [x] 桌面包体积 ~200MB（不含模型）
