# Charlie 语音助手

> 用 ESP32 开发板 + 语音 Agent，把现有家电改造成全屋智能家居。
> ASR → 大脑 LLM → TTS 完整语音闭环，支持空调红外控制、场景协议、飞书推送、MCP 技能扩展。零配置 Demo 模式开箱即用。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Python](https://img.shields.io/badge/Python-3.12+-blue.svg)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-green.svg)](https://fastapi.tiangolo.com/)
[![ESP32](https://img.shields.io/badge/ESP32-LC--S3-orange.svg)](#-esp32-开发板终端)
[![PyInstaller](https://img.shields.io/badge/Distribution-Windows%20%7C%20macOS%20%7C%20Linux-red.svg)](#-快速上手5-分钟)
[![Release](https://img.shields.io/github/v/release/SxLiuYu/charlie-voice-assistant)](https://github.com/SxLiuYu/charlie-voice-assistant/releases/latest)

---

## 🏠 这是什么？

Charlie 是一个**低成本全屋智能家居方案**：一块 ESP32 开发板（~30元）+ 一台运行 Charlie 的电脑，就能让你用语音控制现有的空调、电视、灯光，无需更换智能家电。

```
你说「晚安」
  → ESP32 开发板拾取语音
  → Charlie 大脑理解意图
  → 红外关空调 + 关电视 + 设明早闹钟 + 播天气
  → 语音回复 + 飞书通知
```

**核心思路**：不换家电，加一个"语音大脑"。ESP32 负责收音和显示，Charlie 跑在你的 Mac/PC/树莓派上，通过红外、涂鸦 IoT、MCP 工具控制现有设备。

---

## ✨ 特性一览

| 能力 | Demo 模式 | 完整模式 |
|------|:---------:|:--------:|
| 🎙️ 语音对话（ASR→大脑→TTS） | ✅ 降级 | ✅ 完整 |
| 🏠 空调红外控制（涂鸦 IoT） | ❌ | ✅ |
| 🌅 场景协议（早安/晚安/出门/回家） | ✅ | ✅ |
| ⏰ 提醒/闹钟/日程 | ✅ | ✅ |
| 🌤️ 天气查询 | ❌ | ✅ |
| 📺 视觉截屏分析 | ✅ | ✅ |
| 💬 LLM 对话（翻译/记忆/推荐） | ❌ | ✅ 智谱GLM免费 / 火山ARK |
| 📱 ESP32 开发板语音终端 | ❌ | ✅ |
| 📨 飞书消息推送 | ❌ | ✅ |
| 🔌 MCP 技能扩展（19个工具） | ❌ | ✅ |
| 🔒 HTTPS 手机访问 | ❌ | ✅ |

**三种大脑，按需选择**：

| 模式 | 成本 | 说明 |
|------|------|------|
| Demo 规则模式 | **免费** | 零配置，时间/场景/截屏可用，无需任何 Key |
| 智谱 GLM 免费 | **免费** | glm-4.7-flash 永久免费，注册即用 |
| 火山 ARK | 按量付费 | DeepSeek-v4-flash，速度更快、限流更宽松 |

---

## 🚀 快速上手（5 分钟）

### 方式一：Windows 便携版（推荐普通用户）

1. 到 [Release 页面](https://github.com/SxLiuYu/charlie-voice-assistant/releases/latest) 下载 **`Charlie-Portable.zip`**
2. 解压到任意目录，双击 **`charlie.exe`**（原生桌面窗口，不弹黑框，无需装 Python）
3. 首次启动自动打开欢迎向导：申请一个免费的智谱 GLM Key 填入即可对话（[注册即送，glm-4.7-flash 永久免费](https://open.bigmodel.cn)）
4. 保存即时生效，无需重启。语音对话可再填百度语音 Key（有免费额度），不填也能用文字

> Windows 10/11 需 WebView2（多数系统已自带）。解压后整个文件夹可拷到 U 盘，数据/配置都在文件夹内。

### 方式二：Python 开发（面向开发者）

```bash
git clone https://github.com/SxLiuYu/charlie-voice-assistant.git
cd charlie-voice-assistant/charlie

python3 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements-core.txt
# macOS: brew install ffmpeg   Linux: apt install ffmpeg   Windows: winget install ffmpeg

cp .env.example .env             # 可选，Demo 模式直接可用
python voice_server.py           # 浏览器打开 http://localhost:8000
```

### 方式三：Docker

```bash
cp .env.example .env  # 填 Key
docker compose up -d
```

---

## 📟 ESP32 开发板终端

Charlie 支持 ESP32 LC-S3 1.54 寸 TFT WiFi 开发板（xiaozhi 协议），做成独立的语音对话终端放在家里任意房间。

- **型号**：`lc-s3-wifi-1.54tft`（LC-S3 + 1.54寸圆形 TFT，~30元）
- **固件**：xiaozhi v2.1.0，16MB flash，ST7789 240×240（分发固件已擦除 NVS，不含任何 WiFi 信息）
- **烧录+配网**：应用向导一键烧录干净固件，之后**手机连设备热点**（`http://192.168.4.1`）填写 WiFi 和 Charlie 的 OTA 地址，无需编译、无字段长度限制
- **性能**：说完 → 首句约 1.16s（ASR+LLM+TTS 全链路）

详见 [docs/ESP32.md](docs/ESP32.md)。

---

## 🏠 智能家居控制

### 空调（涂鸦红外）

说「打开空调制冷26度」「关掉空调」，Charlie 通过涂鸦 IoT 红外网关控制现有空调，无需更换智能空调。

支持：开关 / 制冷 / 制热 / 送风 / 除湿 / 温度 16-30°C / 风速调节。

### 场景协议

一句话触发多设备联动：

| 你说 | Charlie 做什么 |
|------|---------------|
| 「晚安」 | 关空调 + 关电视 + 设起床提醒 + 播明天天气 |
| 「早安」 | 开空调 + 播天气 + 列今日待办 |
| 「我出门了」 | 关空调 + 关电视 + 播报天气 |
| 「我回来了」 | 播报天气 + 提醒待办 |

场景可通过对话学习和自定义，支持空调、电视、音量、提醒、TTS 等步骤组合。

### MCP 工具层

19 个 MCP 技能按需启用，按 Key 自动分层：

- **核心（8个）**：时间/天气/提醒/备忘/系统/场景/摘要/文件
- **可选（11个）**：飞书/抖音/淘宝/音乐/做菜/衣橱/浏览器/进化/搜索/空调/笔记

---

## 🔑 密钥获取

最小可用只需百度语音（ASR+TTS），其余按需：

| Key | 用途 | 费用 | 获取地址 |
|-----|------|------|---------|
| `BAIDU_APP_ID` + `API_KEY` + `SECRET_KEY` | 语音识别+合成 | 免费额度 | [百度智能云](https://console.bce.baidu.com/ai/#/ai/speech) |
| `GLM_KEY` | 大脑 LLM | **永久免费** | [智谱AI](https://open.bigmodel.cn/apikey/platform) |
| `AMAP_KEY` | 天气/地图 | 免费 | [高德开放平台](https://console.amap.com) |
| `ARK_KEY` | 大脑 LLM（更快） | 按量付费 | [火山引擎Ark](https://console.volcengine.com/ark) |
| `TUYA_CLIENT_ID` + `ACCESS_KEY` | 空调红外控制 | 免费 | [涂鸦IoT](https://iot.tuya.com) |
| `FEISHU_APP_ID` + `SECRET` | 飞书推送 | 免费 | [飞书开放平台](https://open.feishu.cn) |

> 启动后访问 `http://localhost:8000/welcome` 用引导页填写，或 `/setup` 高级配置。

---

## 🏗️ 架构概览

```
ESP32 开发板 (xiaozhi WS)  ←─WiFi─→  浏览器 (HTTPS/SSE)
              ↓                        ↓
        voice_server.py (FastAPI, port 8000/8443)
              │
              ├── ASR: 百度云端 / 本地 SenseVoice（26ms）
              ├── 大脑: 智谱GLM免费 / 火山ARK / Ollama本地
              ├── TTS: 百度 / Finna降级
              ├── MCP工具: 空调/场景/提醒/飞书/搜索...（19个）
              ├── 决策引擎: 状态感知+时间触发，自主推送
              └── ESP32: 干净固件 + AP热点配网 + OTA + WebSocket
```

**核心模块**：

| 模块 | 文件 | 职责 |
|------|------|------|
| 主服务 | `voice_server.py` | FastAPI HTTP/WS/SSE 路由 + 后台调度 |
| 大脑引擎 | `voice_agent.py` | 意图识别 → FastPath → LLM → MCP → TTS |
| LLM 配置 | `app/llm_config.py` | ARK / GLM / Ollama 三级降级 + 429轮换 |
| 环境注册表 | `app/env_catalog.py` | 60 环境变量单一来源 |
| MCP 分层 | `app/mcp_registry.py` | 按 Profile + Key 过滤启用工具 |
| 决策引擎 | `magic-decisions.py` | 状态感知自主推送，机器级锁防重 |
| 提醒持久化 | `app/reminders.py` | 文件锁 + 去重 + 投递重试 |
| 证书生成 | `app/cert.py` | HTTPS 自签证书自动化 |
| ESP32 烧录 | `voice_server.py` | 进程内 esptool 烧录干净固件 + AP 热点配网指引 |

---

## 📁 项目结构

```
charlie-voice-assistant/
├── charlie/                  # 核心源码
│   ├── voice_server.py       # FastAPI 主服务
│   ├── voice_agent.py        # 大脑引擎（意图+FastPath+LLM）
│   ├── charlie_main.py       # PyInstaller 打包入口
│   ├── app/                  # 工具模块
│   ├── agent/                # 意图/历史/偏好/语音
│   ├── web/                  # 前端页面
│   ├── scripts/              # 证书生成/模型下载
│   └── tests/                # pytest（60+ 用例）
├── firmware/                 # ESP32 固件 (16MB bin)
├── docs/                     # 文档
│   ├── ESP32.md              # ESP32 烧录指南
│   ├── DEPLOYMENT.md         # 部署指南
│   ├── DEMO_MODE.md          # Demo 模式说明
│   └── WINDOWS_BUILD.md      # Windows 打包
└── skills/                   # MCP 技能生态
```

---

## 🧪 测试

```bash
pip install -r requirements-dev.txt
python3 -m pytest tests/ -q
```

---

## 📋 配置

所有环境变量在 [`charlie/.env.example`](charlie/.env.example)，共 60 项，按分组注释。缺失 Key 只 warning 不阻塞，Demo 模式兜底运行。

| 分组 | 说明 |
|------|------|
| `core` | LLM / 语音 / 天气（最小可用集） |
| `llm_fallback` | 智谱 GLM 免费 / Ollama 本地降级 |
| `asr_local` | SenseVoice 本地 ASR 模型 |
| `feishu` | 飞书消息推送 |
| `tuya` | 涂鸦红外空调控制 |
| `esp32` | ESP32 开发板终端 |
| `push` | 个性化热点推送 |

---

## 🔒 安全

- API Key 存储在本地 `.env`，不上传云端
- 发布前扫描：`bash charlie/scripts/check-leaks.sh`
- ESP32 固件已移除 NVS 中硬编码的网络凭证
- HTTPS 自签证书自动生成

---

## 📄 许可证

MIT 开源，保留作者署名。详见 [LICENSE](charlie/LICENSE)。

---

**GitHub**: [SxLiuYu/charlie-voice-assistant](https://github.com/SxLiuYu/charlie-voice-assistant)
