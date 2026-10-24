# ESP32 开发板终端配置指南

Charlie 支持 ESP32 LC-S3 1.54 寸 TFT WiFi 开发板（xiaozhi v2.1.0 协议），流式语音对话。

## 硬件

- 板子：lc-s3-wifi-1.54tft（LC-S3 1.54 寸 TFT WiFi）
- 固件：xiaozhi v2.1.0，16MB 全量 flash
- 屏幕：ST7789 240x240 SPI
- 音频：上行 16kHz Opus → ASR；下行 TTS → 24kHz Opus
- VAD：Silero 神经网络（0.48s 尾静音）

## 配网原理

固件内置 `esp-wifi-connect` **AP 热点配网门户**。分发的固件已擦除 NVS（不含任何 WiFi/服务器信息），
因此**不需要在烧录时写入 WiFi**：

1. 烧录干净固件后，设备开机发现没有 WiFi，自动进入热点配网模式
2. 用手机连接设备热点，在网页里填写家用 WiFi 和 Charlie 的 OTA 地址
3. 设备重启，自动连 WiFi，并从 OTA 地址获取 WebSocket 连接信息后接入 Charlie

这种方式没有旧版二进制 patch 的长度限制，换 WiFi/换电脑 IP 只需重新配网（长按复位键重新进入热点模式）。

## 方式一：应用内向导（推荐）

1. 开发板用 USB 数据线连电脑（注意是数据线，不是充电线）
2. 启动 Charlie，打开「ESP32 配置向导」（主页链接，或访问 `http://localhost:8000/esp32-setup`）
3. 点「检测串口」→ 选择开发板串口（Windows 为 `COMx`，macOS 为 `/dev/cu.usbmodem*`）
4. 点「开始烧录」。向导内置 esptool，把干净固件（`charlie-esp32-flash-16MB.bin`，已擦除 NVS）写入设备，约 30-60 秒
5. 烧录完成后，按向导第二步的提示用手机配网（见下方「手机配网步骤」）

## 方式二：命令行烧录

向导失败时可手动烧录（干净固件从 GitHub Release 下载 `charlie-esp32-flash-16MB.bin`）：

```bash
pip install esptool
# Windows:
python -m esptool --chip esp32s3 -p COM3 -b 115200 \
  --before=default_reset --after=hard_reset write_flash \
  --flash_mode dio --flash_freq 80m --flash_size 16MB \
  0x0 charlie-esp32-flash-16MB.bin
# macOS/Linux: 把 -p COM3 换成 /dev/cu.usbmodem*
```

> Windows 检测不到串口需安装 CP210x 或 CH340 驱动。烧录命令写的是**整包干净固件**，不需要也不应该再做 NVS patch。

## 手机配网步骤

1. 烧录完成后保持设备通电，手机打开 WiFi 设置
2. 连接名为 `lc-s3-wifi-1.54tft-XXXX` 的热点（无密码，`XXXX` 是设备 MAC 后四位）
3. 连上后手机通常自动弹出配置页；若未弹出，打开浏览器访问 **`http://192.168.4.1`**
4. 在页面选择你家 WiFi 并输入密码
5. 点「高级设置 / Advanced」，在 **OTA URL** 栏填入 Charlie 的 OTA 地址：
   - 应用向导第二步会自动显示该地址（形如 `http://电脑IP:8000/xiaozhi/ota`），可一键复制
   - 命令行烧录时，地址为 `http://<运行Charlie的电脑局域网IP>:<端口>/xiaozhi/ota`
6. 保存后设备自动重启，连上 WiFi 并接入 Charlie，屏幕显示时间即成功

## 注意事项

- **电脑和 ESP32 必须连同一路由器**（同一局域网）。
- Charlie 窗口需保持开启，ESP32 才能连接（关窗即停服务）。
- 建议在路由器里给电脑绑定固定 IP，否则 IP 变化后设备会连不上；连不上时长按开发板复位键重新配网。
- 首次启动 Windows 防火墙会提示，务必勾选「专用网络」并允许，否则 ESP32 无法访问 Charlie 的端口。
- OTA 端口默认 8000，如在 `.env` 改了 `ASSISTANT_KID_HTTP_PORT`，OTA 地址端口要相应改变。

## 性能

- 说完→首句：~1.16s
- 端到端：~2.23s（优化前 3.1s）
- ASR：SenseVoice 本地 26ms（需模型文件）/ 百度 327ms 降级
- TTS：百度 119ms / Finna 降级
