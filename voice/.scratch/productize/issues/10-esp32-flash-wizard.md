# 10 — ESP32 烧录向导网页

**What to build:** 访问 /esp32-setup 网页向导：检测串口板子 → 用户输 WiFi SSID/密码/服务器IP → 调 patch_nvs 改固件 NVS → 调 esptool 烧录 → curl OTA 端点测连通。用户全程浏览器操作，不需手动 esptool 命令。

**Blocked by:** 07 — NVS patch 纯函数

**Status:** ready-for-agent

- [x] 新增 GET /esp32-setup 路由返回 web/esp32_setup.html
- [x] 新增 GET /api/esp32/detect-port 检测 /dev/cu.usbmodem* 串口设备
- [x] 新增 POST /api/esp32/flash 接收 {port, ssid, password, server_ip} → 调 patch_nvs + esptool
- [x] 新增 GET /api/esp32/flash-status 查询烧录进度（后台线程）
- [x] 烧录后自动 curl OTA 端点测连通，返回结果
- [x] v1.0 macOS only（检测 /dev/cu.usbmodem*），无板子时提示插入
- [x] 需要 sudo 时提示用户手动跑命令（网页不直接 sudo）
- [x] mock esptool 验证 patch_nvs 被正确调用
