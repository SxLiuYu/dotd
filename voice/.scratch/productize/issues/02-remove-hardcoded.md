# 02 — 消除硬编码 + LAN info API

**What to build:** 改端口启动后 OTA 返回正确端口；voice.html 运行时拉取 LAN IP 不再硬编码；ESP32_IP 默认空时 ESP32 功能优雅降级而非默认到作者家 IP。一个新用户改 .env 设端口就能跑，不需改源码。

**Blocked by:** None — 可立即开始

**Status:** ready-for-agent

- [x] voice_server OTA 兜底 IP `192.168.1.12` → `_get_lan_ip() or "127.0.0.1"`
- [x] voice_server OTA WS 端口 `:8000` → 动态用 `http_port()`
- [x] charlie_main 端口 `8000` → `http_port()`
- [x] https_server 主机名 `sxliuyudeMac-mini.local` → `socket.gethostname()`
- [x] mcp_common ESP32_IP 默认 `192.168.1.7` → 默认空串，空时 ESP32 工具返回"未配置"
- [x] 新增 `/api/lan-info` 路由返回 `{https_url, http_url, lan_ip}`
- [x] voice.html 删除硬编码 `192.168.1.3:8443`，运行时拉 `/api/lan-info`
- [x] 改 ASSISTANT_KID_HTTP_PORT=9000 启动，OTA 返回的 WS URL 含 9000
