# Charlie 语音助手 — 便携版使用说明

## 快速开始
1. 解压 `Charlie-Portable.zip` 到任意目录（如 `D:\Charlie`）。
2. 双击 **`charlie.exe`** 启动。
3. 首次启动会自动打开欢迎向导：注册一个**免费**的智谱 GLM Key 填进去即可对话。
   - Key 申请地址：https://open.bigmodel.cn/apikey/platform （注册即送，glm-4.7-flash 永久免费）
   - 填完点保存，**无需重启**，立即生效。
4. 回到主界面即可语音 / 文字对话。

## 目录结构
```
charlie/
├── charlie.exe        ← 双击启动（原生桌面窗口，不弹黑框）
├── _internal/         ← 运行所需文件（勿删）
├── data/              ← 首次运行自动生成：对话历史、提醒、缓存
├── logs/              ← 首次运行自动生成：运行日志（排查问题用）
└── .env               ← 首次运行自动生成：你填的 API Key 配置
```

## 便携特性
- 整个文件夹可随意移动、拷贝到 U 盘，配置和数据都在文件夹内，不写注册表、不写系统目录。
- 迁移到另一台电脑：直接复制整个 `charlie/` 文件夹即可（含已配置的 `.env` 和 `data/`）。

## 语音功能（可选）
语音对话需要百度智能云 ASR/TTS（有免费额度）：
- 申请：https://console.bce.baidu.com/ai/#/ai/speech/overview/index
- 在向导或「高级配置」页填入 `BAIDU_APP_ID` / `BAIDU_API_KEY` / `BAIDU_SECRET_KEY`。
- 不配置也能用文字对话。

## ESP32 手表（可选）
Charlie 配套 ESP32-S3 开发板（1.54 寸 TFT，xiaozhi 固件），可作为随身语音终端。

**首次配置（约 3 分钟）：**
1. 用 USB 数据线把开发板连到电脑。
2. 在 Charlie 里打开「ESP32 配置向导」（主页链接或访问 `/esp32-setup`）。
3. 点「检测串口」→「开始烧录」。内置的干净固件（已擦除 WiFi 信息，不含任何个人凭证）会自动写入开发板，约 30-60 秒。
4. 烧录完成后，**保持设备通电**，用手机连名为 `lc-s3-wifi-1.54tft-XXXX` 的 WiFi 热点（无密码）。
5. 手机浏览器访问 `http://192.168.4.1`，在页面选你家 WiFi 并输入密码。
6. 点「高级设置 / Advanced」，在 **OTA URL** 栏填入向导第二步显示的地址
   （形如 `http://你电脑的IP:8000/xiaozhi/ota`），保存。
7. 设备自动重启，连上 WiFi 后接入 Charlie，屏幕显示时间即成功。

> 电脑和 ESP32 必须连在**同一路由器**下。OTA 地址告诉设备去哪里获取 Charlie 的实时连接信息，换 WiFi 或电脑 IP 变了只需重新配网（长按开发板复位键重新进入热点模式）。

## 常见问题
- **提示"还没配置 AI 大脑"**：按提示打开 `/welcome` 填一个免费 GLM Key。
- **窗口打不开**：Windows 10/11 需安装 WebView2（多数系统已自带；若缺失会提示下载）。
- **查问题**：看 `logs/app.log`。
