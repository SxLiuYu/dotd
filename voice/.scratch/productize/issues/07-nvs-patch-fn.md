# 07 — ESP32 NVS patch 纯函数

**What to build:** 提供 patch_nvs(bin_bytes, ssid, password, server_ip, ws_port) 纯函数，读取固件 bin，定位 NVS 分区，改写 WiFi SSID/密码 + 服务器地址字段，返回新 bin bytes。不重新编译固件，仅 patch 同一份 bin。

**Blocked by:** None — 可立即开始

**Status:** ready-for-agent

- [x] 新建 firmware/patch_nvs.py：读 bin → 定位 NVS 分区偏移 → 解析 NVS 条目 → 改 WiFi/服务器字段 → 写回
- [x] NVS 分区偏移从 esptool image_info 或固定偏移（16MB flash 默认 0x9000）获取
- [x] 函数签名: patch_nvs(bin_bytes: bytes, ssid: str, password: str, server_ip: str, ws_port: int) -> bytes
- [x] 输入测试 bin + 新 WiFi "MyWiFi"/密码"mypassword"，输出 bin 解析含新值
- [x] 原始字段值（旧 SSID/密码/服务器地址占位符）被正确覆盖
- [x] 不重新编译固件（仅二进制 patch）
