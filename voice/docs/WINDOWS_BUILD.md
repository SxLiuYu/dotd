# Charlie 语音助手 — Windows 打包指南

> 本文件是给 AI 的代码生成/执行任务描述。目标：在 Windows 机器上构建出可分发的 charlie.exe。

## 前置条件（先检查再开始）

```powershell
python --version          # 需要 Python 3.12+
ffmpeg -version           # 必须有，音频转码核心
where pyinstaller         # 没有就 pip install pyinstaller
```

---

## 第一步：克隆代码

```powershell
git clone <repo地址> charlie
cd charlie\charlie
```

代码结构：
```
charlie/charlie/          ← 这是工作目录
├── voice_server.py       # FastAPI 主服务
├── voice_agent.py        # 大脑引擎
├── charlie_main.py       # PyInstaller 入口（已含首次启动引导）
├── charlie.spec          # PyInstaller 配置（已完善，含 18 个 MCP 源码）
├── build.sh              # build 脚本（内含 pytest 验证）
├── requirements-core.txt # 核心依赖
├── app/                  # env_catalog.py / preflight.py / mcp_gate.py 等
├── web/                  # voice.html / setup.html / welcome.html / esp32_setup.html
├── scripts/              # gen-cert.sh, download-models.sh, check-leaks.sh
├── tests/                # pytest 测试套件（20+ 文件）
└── dist/charlie/         # 构建产物
```

---

## 第二步：创建虚拟环境 + 安装依赖

```powershell
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements-core.txt --quiet
pip install pyinstaller --quiet
```

---

## 第三步：跑测试（确保当前代码正确）

```powershell
python -m pytest `
  tests/test_demo_rule_mode.py `
  tests/test_lan_info.py `
  tests/test_preflight.py `
  tests/test_mcp_gate.py `
  tests/test_cert.py `
  tests/test_model_download.py `
  tests/test_setup_api.py `
  tests/test_welcome.py `
  tests/test_esp32_wizard.py `
  tests/test_question_paths.py `
  tests/test_security_fixes.py `
  tests/test_charlie_main.py `
  -q
```

预期输出：`passed`（用例数随版本变化，以实际输出为准）

---

## 第四步：打包（2-5 分钟）

```powershell
pyinstaller charlie.spec --noconfirm
```

成功后输出：
```
dist\charlie\charlie.exe      ← 这是最终产物（~320MB）
dist\charlie\_internal\       ← 所有资源
```

dist 内含：
- `charlie.exe` — ARM64/AMD64 可执行（Windows x64）
- `_internal\magic-*.py` — 16 个 MCP 源码
- `_internal\baize_skills_mcp.py` / `mcp_ir_control.py`
- `_internal\web\` — 9 个 HTML 页
- `_internal\scripts\` — 3 个脚本
- `_internal\bin\ffmpeg.exe` — ffmpeg binary（自动从 PATH 找到打包）
- `.env.example` — 空白配置模板

---

## 第五步：验证打包产物

```powershell
# 启动服务（占 8002 端口避免冲突）
$env:ASSISTANT_KID_HTTP_PORT = "8002"
Start-Process .\dist\charlie\charlie.exe

# 等 20 秒后测试 API
# 另开 PowerShell：
curl localhost:8002/api/chat -H 'Content-Type: application/json' -d '{"message":"几点了"}'
curl localhost:8002/api/chat -H 'Content-Type: application/json' -d '{"message":"晚安"}'
curl localhost:8002/api/lan-info
curl localhost:8002/welcome -I
```

预期结果：
```
{"reply":"现在XX点XX分。"}
{"reply":"晚安场景已执行..."}
{"http_url":"http://...:8002",...}
HTTP/1.1 200 OK
```

---

## 第六步：分发

```powershell
# 压缩分发包
Compress-Archive -Path dist\charlie -DestinationPath charlie-windows.zip -Force
```

用户拿到 `charlie-windows.zip` 后：
1. 解压到任意目录
2. 双击 `charlie.exe` → 浏览器自动打开 `/welcome` 引导页
3. 选模式（Demo规则/Ollama/填key）→ 完成

---

## 常见问题

**Q: `ModuleNotFoundError: No module named 'xxx'`？**
A: 在 `charlie.spec` 的 `hidden_imports` 列表里加 `'xxx'`，重跑 `pyinstaller charlie.spec`

**Q: ffmpeg 没被打包？**
A: 确认系统 PATH 里有 ffmpeg，spec 会自动找到。手动指定：在 spec 的 `binaries` 加 `('C:/ffmpeg/bin/ffmpeg.exe', 'bin')`

**Q: 打包完运行闪退？**
A: 检查 `_internal/.env` 是否存在（首次启动 charlie_main.py 会自动创建），日志在 `_internal/logs/`

**Q: Ollama Demo 模式不可用？**
A: 引导页选 Ollama 时需先装 Ollama：`winget install Ollama.Ollama` + `ollama pull qwen3.5:2b`
