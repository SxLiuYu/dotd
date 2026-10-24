## Charlie 语音助手 v3.1.0

首个开箱即用版本：双击 exe 即可在原生桌面窗口运行，免费 GLM 大脑 + 百度语音，无需安装 Python。

### 📦 下载

| 文件 | 说明 |
|------|------|
| **Charlie-Portable.zip** | Windows 便携版。解压后双击 `charlie.exe` 即可运行，数据/配置都在文件夹内，可拷到 U 盘。已内置 ESP32 固件与 esptool。 |
| **charlie-esp32-flash-16MB.bin** | ESP32 开发板 16MB 全量固件镜像（xiaozhi v2.1.0，LC-S3 1.54寸 TFT）。**已擦除 NVS，不含任何 WiFi/服务器信息。** |

### 🚀 Windows 快速开始
1. 解压 `Charlie-Portable.zip`
2. 双击 `charlie.exe`，首次启动自动打开欢迎向导
3. 申请免费智谱 GLM Key（https://open.bigmodel.cn 注册即送，glm-4.7-flash 永久免费）填入
4. 保存即生效（无需重启），回到主界面即可文字/语音对话

### ⌚ ESP32 手表配置（约 3 分钟）
固件内置 **AP 热点配网门户**，无需在烧录时写死 WiFi，换网络也只需重新配网。

**方式一：应用内向导（推荐）**
1. USB 数据线连接 ESP32 与电脑
2. Charlie 主页打开「ESP32 配置向导」（或访问 `/esp32-setup`）
3. 点「检测串口」→「开始烧录」，内置干净固件自动写入（约 30-60 秒）
4. 烧录完成后保持设备通电，用手机连接名为 `lc-s3-wifi-1.54tft-XXXX` 的 WiFi 热点
5. 手机浏览器访问 `http://192.168.4.1`，选 WiFi 并输入密码
6. 点「高级设置 / Advanced」，在 **OTA URL** 填入向导显示的地址（形如 `http://电脑IP:8000/xiaozhi/ota`），保存
7. 设备自动重启，屏幕显示时间即成功

**方式二：命令行烧录**
```bash
pip install esptool
python -m esptool --chip esp32s3 -p COM3 -b 115200 \
  --before=default_reset --after=hard_reset \
  write_flash --flash_mode dio --flash_freq 80m --flash_size 16MB \
  0x0 charlie-esp32-flash-16MB.bin
```
烧录后同样按上述第 4-7 步用手机配网。

> 电脑与 ESP32 需连同一路由器。长按开发板复位键可重新进入热点配网模式。

### ✨ 本次更新
- **ESP32 全新配网流程**：烧录干净固件 + 手机 AP 热点配网，支持任意长度 WiFi 密码，换网零成本
- 应用内烧录向导内置 esptool，免装 Python 环境，进程内调用（兼容打包环境）
- 配置热重载：向导保存 Key 后立即生效，无需重启
- 保存时实时验证 GLM/百度 Key 有效性
- 修复流式对话"大脑启动失败"
- 修复启动时显示"⏰ undefined"
- 修复"语音服务繁忙"误导提示（未配置时准确引导）
- 移除天气回复中的 Open-Meteo 归属文本
- 跨平台原生窗口（pywebview / WebView2）

### ⚠️ 说明
- 语音播报需配置百度智能云 ASR/TTS（有免费额度），不配置也可用文字对话
- Windows 10/11 需 WebView2（多数系统已自带）
- 配套硬件：ESP32-S3 + 1.54 寸 TFT（立创·实战派 / lc-s3-wifi-1.54tft）
