# Spec: Charlie 开箱即用产品化（v1.0 桌面包）

> 状态: ready-for-agent | 来源: grilling session 共识 | 日期: 2026-08-12

## Problem Statement

Charlie 语音助手目前是作者个人的本地工具：配置散落 30+ 文件、IP/端口/主机名硬编码、依赖未声明（sherpa_onnx 缺失）、模型需手动下载、ESP32 烧录要手动加 IP 别名、安全泄露（RTK.md 含飞书 APP_ID/WiFi 密码）。一个新用户拿到代码，即使只跑核心对话，也要改源码兜底 IP、手动装 Ollama、查文档拼凑配置。无法作为"产品"分发。

## Solution

把 Charlie 改造为**开箱即用的桌面包产品**（PyInstaller），双击 exe → 网页引导 → 3 分钟内完成一次 Demo 规则对话（报时间 + 场景触发）。核心机制是 **Demo 规则模式**：无 LLM/无 key 时，用已有的快路径（时间直答/视觉截屏/场景Protocol/智能命令）完成简单对话，零配置可用。用户可按需升级到 Ollama 离线模式或填 key 完整模式。ESP32 开发板作为标配配件，通过网页烧录向导配置。

## User Stories

1. 作为普通用户，我想双击桌面包 exe 就能启动 Charlie，这样我不需要装 Python/venv/依赖
2. 作为普通用户，我想首次启动有网页引导，这样我不需要读文档就知道怎么配
3. 作为普通用户，我想不填任何 key 也能和 Charlie 对话（报时间），这样我能 3 分钟内体验产品
4. 作为普通用户，我想在引导页选择"完整模式"并填写 key，这样我能解锁天气/翻译/记忆等完整能力
5. 作为普通用户，我想在引导页选择"Ollama 离线模式"，这样我能在无网络时也有 LLM 对话
6. 作为普通用户，我想 setup 页面按分组展示每个 key 的状态（已配置/缺失/Demo可用），这样我知道还差什么
7. 作为普通用户，我想 setup 页面给每个 key 的获取链接，这样我不需要自己搜申请地址
8. 作为普通用户，我想桌面包自动生成 HTTPS 自签证书，这样我手机同 WiFi 能访问
9. 作为普通用户，我想首次启动检测到缺 ffmpeg/Ollama 时给出安装指引，这样我不需要自己排错依赖
10. 作为普通用户，我想 SenseVoice 模型缺失时能一键下载，这样我能用本地 ASR 加速
11. 作为 ESP32 用户，我想网页烧录向导检测板子并引导我输 WiFi，这样我不需要手动改固件
12. 作为 ESP32 用户，我想烧录向导自动 patch 固件 NVS 里的 WiFi/服务器地址，这样我不需要重新编译固件
13. 作为 ESP32 用户，我想烧录向导测试连通性（OTA 端点），这样我确认开发板能连上 Charlie
14. 作为开发者，我想 clone 仓库后改 .env 就能跑核心对话（不需改源码），这样我能快速本地开发
15. 作为开发者，我想 env_catalog 作为配置的单一来源，这样我加新 key 时只改一处
16. 作为开发者，我想 MCP 按核心/可选分层，这样 Demo 模式不启 MCP 减少坏体验
17. 作为开发者，我想现有 51 个测试不破坏，这样改造有回归保障
18. 作为开发者，我想新功能有测试覆盖（Demo规则/welcome/烧录向导），这样 implement 阶段有 TDD 反馈
19. 作为维护者，我想 RTK.md 的敏感信息清理掉，这样开源发布不泄露作者凭证
20. 作为维护者，我想 .gitignore 补漏（数据文件），这样不会误提交用户运行时数据
21. 作为用户，我想 Demo 规则模式说"晚安"触发 goodnight 场景，这样我能验收场景能力
22. 作为用户，我想 Demo 规则模式说"几点了"Charlie 报时间，这样我能验收直答能力
23. 作为用户，我想 Demo 规则模式快路径都不命中时提示"配置 key 解锁完整能力"，这样我知道为什么功能受限
24. 作为用户，我想填了 key 后重启就进入完整模式（启 MCP），这样升级路径清晰
25. 作为用户，我想桌面包体积在 200MB 左右（不含模型），这样下载不慢
26. 作为用户，我想产品叫 Charlie 且 MIT 开源，这样我能自由使用和修改

## Implementation Decisions

### Demo 规则模式（核心）
- **机制**：LLM 不可用（ARK_KEY 空 + Ollama 离线）时，brain() 不调 LLM，走快路径回退
- **快路径复用**：扩展现有 `_direct_*` 系列（时间直答/视觉截屏/场景Protocol/智能命令），加"Demo 回退"——快路径不命中时返回固定提示串
- **MCP**：Demo 模式不启 MCP（`MCP_PROFILE` 检测 + Demo 模式强制 none）
- **system_msg**：Demo 模式加横幅提示"能力有限，配置 key 解锁完整能力"

### 配置注册表（保留并扩展）
- **env_catalog**：60 变量单一来源，分组（core/llm_fallback/asr_local/feishu/tuya/esp32/ecommerce/push/system/tuning）
- **.env.example**：全覆盖 60 变量（保留）
- **setup 路由**：白名单从 env_catalog 派生，分组卡片展示，宽松校验（必需缺失允许 Demo 模式保存）

### 桌面包打包（PyInstaller）
- **打包范围**：核心 Python + web 资源 + ffmpeg binary（~100-200MB）
- **按需下载**：SenseVoice 模型（237MB，首次启动引导，提供下载脚本）
- **引导安装**：Ollama / ncm / ego-browser（用户选相应功能时引导，非强制）
- **首次启动**：检测 .env → 缺失则生成证书 + 开浏览器到 /welcome → 三步引导 → 主界面
- **证书自动化**：HTTPS 证书缺失时 openssl 自动生成自签（CN 用 socket.gethostname()）

### /welcome 三步引导
- **第一步（选模式）**：Demo规则 / Ollama离线 / 填key完整
- **第二步（分支）**：
  - Demo规则 → 直接完成
  - Ollama → 引导装 Ollama + pull qwen3.5:2b
  - 填key → 跳 /setup 填表
- **第三步（完成）**：跳主界面 voice.html，显示欢迎提示

### ESP32 烧录向导
- **形态**：网页向导（/esp32-setup 路由 + HTML），后端调 esptool.py
- **NVS patch**：读固件 bin → 定位 NVS 分区 → 改 WiFi SSID/密码 + 服务器地址字段 → 写回 → 烧录
- **约束**：不重新编译固件（符合 RTK.md "不要再重新编译烧录"），仅 patch 同一份 bin
- **平台**：v1.0 macOS only；v1.2 加 Linux/Windows
- **连通性测试**：烧录后 curl OTA 端点验证

### 消除硬编码
- OTA 兜底 IP `192.168.1.12` → `_get_lan_ip() or "127.0.0.1"`
- OTA WS 端口 `:8000` → 动态用 `http_port()`
- ESP32_IP 默认 `192.168.1.7` → 默认空串
- charlie_main 端口 `8000` → `http_port()`
- https_server 主机名 `sxliuyudeMac-mini.local` → `socket.gethostname()`
- voice.html LAN IP `192.168.1.3:8443` → 运行时 `/api/lan-info` 注入

### 依赖清理
- 删 `dotenv==0.9.9`（与 python-dotenv 重复）
- 删 `httpcore2`/`httpx2`（多版本并存，确认无显式 import）
- 补 `sherpa_onnx`（SenseVoice ASR 必需）
- pytest 移到 requirements-dev.txt
- 拆 requirements-core.txt / requirements-optional.txt / requirements-dev.txt
- 新增 preflight 模块检测外部二进制（ffmpeg/ollama/ncm/ego-browser/esptool）

### MCP 分层
- CORE_MCP（8个）：时间/天气/记忆/提醒/系统/翻译/计算/搜索/备忘录
- OPTIONAL_MCP（11个）：飞书/抖音/淘宝/Tuya/做菜/衣橱/进化/场景/浏览器等
- MCP_PROFILE：core（默认）/ all / custom
- key 缺失自动跳过（mcp_gate 模块）

### 安全清理
- RTK.md：删飞书 APP_ID/open_id/WiFi 密码/PID，或整个文件加 .gitignore + git rm --cached
- .gitignore 补漏：episodic_memories.json / decision_*.json / pushed_hot_topics.json / protocols.json / data/ / workspace/
- 工作区 .env 不动（含作者真实密钥），但加 check-leaks.sh 发布前扫描

### 品牌与许可
- MIT 开源，保留作者署名
- 产品名 Charlie

## Testing Decisions

### 测试接缝（seams）
1. **主 seam：HTTP API 层**（FastAPI TestClient）——端到端测 /api/voice、/api/chat、/setup、/welcome、/esp32-setup 的外部行为。复用现有 tests/test_voice_server.py 的 seam。
2. **Demo 规则模式 unit seam**——voice_agent 快路径命中逻辑（mock LLM 不可用，验证"几点了"→返回时间、"晚安"→触发 goodnight）。在现有 tests/test_voice_agent.py 内加。
3. **NVS patch unit seam**——固件 bin patch 纯函数（读 bin → 改 WiFi/服务器字段 → 写 bin），纯函数不通过 HTTP。

### 好测试的标准
- 只测外部行为，不测实现细节
- Demo 规则模式：测"输入 X → 返回 Y"，不测内部路由函数名
- NVS patch：测"输入 bin + 新 WiFi → 输出 bin 含新 WiFi"，不测中间步骤
- HTTP seam：测"POST /api/voice with mock ASR → 响应含预期文本"，不测中间件顺序

### 现有测试处理
- 现有 51 个测试（43 question_paths + 8 xiaozhi_ws）不破坏
- 现有失败测试（基线待确认）：如基线就失败，标记 skip 或在 implement 阶段修；如改造引入回归，必须修

## Out of Scope

- **Docker 形态**（v1.1）：Dockerfile 改造、docker-compose profiles、Ollama sidecar 容器——v1.0 不做
- **云端 SaaS / 多租户**：不做，Charlie 是单机产品
- **ESP32 固件重新编译**：不重新编译（RTK.md 约束），仅 patch NVS
- **作者共享云端 LLM key**：不做（单点风险）
- **Linux/Windows 桌面包**（v1.2）：v1.0 macOS only
- **自动更新机制**：v1.0 不做桌面包自动更新
- **多用户家庭隔离**：保留现有 CHARLIE_USER_ID 机制，不做新增能

## Further Notes

### 领域词汇（建议后续建 CONTEXT.md）
- **Demo 规则模式**：无 LLM/无 key 时的快路径回退模式，零配置可用
- **快路径**：绕过 LLM 直接返回的规则路径（时间直答/视觉截屏/场景Protocol/智能命令）
- **烧录向导**：网页引导用户配置 ESP32 固件 NVS 并烧录的工具
- **MCP 分层**：核心 MCP（8个，默认）/ 可选 MCP（11个，按 key 启用）
- **env_catalog**：60 环境变量的单一注册表，驱动 setup/校验/.env 模板

### grilling 决策记录
- Q2 桌面包优先（推翻 Docker 优先推荐）——用户面向更广用户
- Q8 Demo 规则模式（resolve 3min 验收 vs Ollama 安装矛盾）——无 LLM 快路径完成验收

### 现有代码保留边界
- 保留：app/env_catalog.py（60 变量注册表）+ .env.example（全覆盖）
- 重写：setup 路由 / Demo 模式 _build_brain 分支 / system_msg 横幅（按本 spec 重写）
- 扩展：_direct_* 快路径 + Demo 回退

### 实施顺序建议（to-tickets 阶段细化）
1. Demo 规则模式（核心创新，解锁 3min 验收）
2. 消除硬编码 + 依赖清理（地基）
3. /welcome 引导 + setup 改造（UX）
4. 桌面包打包 + 首次启动（PyInstaller）
5. ESP32 烧录向导（NVS patch + 网页）
6. 安全清理 + 文档（发布前）
