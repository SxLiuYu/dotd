# 09 — /welcome 引导页（三步分支）

**What to build:** 桌面包首次启动（缺 .env）访问 / 自动重定向到 /welcome；三步引导：第一步选模式（Demo规则/Ollama离线/填key完整）；第二步按选择分支（Demo→直接完成；Ollama→引导装 Ollama + pull qwen3.5:2b；填key→跳 /setup 填表）；第三步完成跳主界面 voice.html。

**Blocked by:** 04 — setup 路由（引导页第二步填key分支跳 /setup）

**Status:** ready-for-agent

- [x] 新建 web/welcome.html：三步引导，拉 /api/setup 判断当前状态
- [x] 新增 GET /welcome 路由返回 welcome.html
- [x] 新增 GET /api/welcome/status 返回 {has_env, demo_mode, ollama_online, missing_required}
- [x] 缺 .env 时访问 / 返回重定向到 /welcome（非 setup 已配置时正常返回主界面）
- [x] 选 Demo规则 → POST /api/setup with demo_accept=true → 完成 → 跳 /
- [x] 选 Ollama → 显示安装指引（ollama serve & ollama pull qwen3.5:2b）+ 检测按钮
- [x] 选填key → 跳 /setup，填完回 /welcome 完成
- [x] 完成后跳 voice.html 主界面
