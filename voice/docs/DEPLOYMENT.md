# 部署指南

## 方式一：Windows 便携版（主打，面向终端用户）

1. 到 [Release](https://github.com/SxLiuYu/charlie-voice-assistant/releases/latest) 下载 `Charlie-Portable.zip`
2. 解压到任意目录
3. 双击 `charlie.exe` → 弹出原生窗口并自动打开欢迎引导页
4. 向导里填入智谱 GLM Key（免费）和百度语音 Key（可选），保存即时生效
5. 语音对话

> 系统需装 WebView2 Runtime（Win11 自带；Win10 一般已随系统更新）。
> 数据/日志写入 `%APPDATA%\charlie` 与 `%LOCALAPPDATA%\charlie\logs`，不污染解压目录。

构建步骤见 `docs/WINDOWS_BUILD.md`。

## 方式二：Python 开发/自托管

```bash
git clone <repo>
cd charlie/charlie
python3 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate

# 核心依赖（装完即可跑对话）
pip install -r requirements-core.txt

# 可选依赖（本地 ASR/ESP32/音频处理）
pip install -r requirements-optional.txt

# 外部二进制
# macOS:  brew install ffmpeg
# Linux:  apt install ffmpeg
# Windows: winget install ffmpeg
# 可选 ESP32 烧录: pip install esptool

# 配置
cp .env.example .env
# 编辑 .env 填入 GLM_API_KEY/百度/高德 key
# 或启动后访问 http://localhost:8000/setup 网页填写

# 启动
python voice_server.py
# HTTPS（手机访问）：python https_server.py
```

## 方式三：Docker

```bash
cp .env.example .env  # 填 key
docker compose up -d --build
# Ollama sidecar：docker compose --profile ollama up -d
```

## 发布前检查

```bash
bash charlie/scripts/check-leaks.sh  # 扫描敏感信息
```

## HTTPS 证书

首次启动 `https_server.py` 时自动生成自签证书（`cert/cert.pem` + `cert/key.pem`，10 年有效，CN=hostname）。

手动生成：`bash scripts/gen-cert.sh`

手机同 WiFi 访问 `https://<电脑-IP>:8443`，首次需信任证书。

## SenseVoice 本地 ASR 模型（可选，26ms ASR）

```bash
bash charlie/scripts/download-models.sh  # 下载 237MB 模型到 models/sense-voice/
# 或网页：http://localhost:8000/setup → 点「下载本地 ASR 模型」
```

模型缺失时自动降级百度 ASR（327ms）。

## ESP32 开发板

见 `docs/ESP32.md`。烧录使用设备自带的 AP 热点配网，写入的是干净固件，不再 patch NVS。

## Troubleshooting

### 启动报"缺少必需密钥"

启动时打印每个 key 的配置状态。缺失只 warning 不阻塞（Demo 规则模式可兜底）。访问 `http://localhost:8000/setup` 填写。

### 麦克风不可用（HTTP 连接）

浏览器要求 HTTPS 才能用麦克风。运行 `python https_server.py`，手机/电脑用 `https://<IP>:8443` 访问。

### ffmpeg 未找到

`winget install ffmpeg`（Windows）/ `brew install ffmpeg`（macOS）/ `apt install ffmpeg`（Linux）。启动时 preflight 会检测并提示。

### Ollama Demo 模式不可用

```bash
ollama serve &
ollama pull qwen3.5:2b
```

### ESP32 烧录失败

应用内向导会在进程内调用 esptool。失败时可手动运行（先 `pip install esptool`）：
```bash
python -m esptool --chip esp32s3 -p <串口> -b 115200 write_flash --flash_mode dio --flash_freq 80m --flash_size 16MB 0x0 firmware/charlie-esp32-flash-16MB.bin
```
随后用手机连接设备热点完成 WiFi/OTA 配网，见 `docs/ESP32.md`。

## 依赖文件说明

| 文件 | 用途 |
|---|---|
| `requirements.txt` | 全量依赖（core + optional + dev，向后兼容）|
| `requirements-core.txt` | 核心对话必需（装完即可跑）|
| `requirements-optional.txt` | 本地 ASR/ESP32/音频处理（缺失会降级）|
| `requirements-dev.txt` | 测试开发（pytest）|
