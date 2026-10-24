# 05 — HTTPS 证书自动化

**What to build:** 删除 cert/ 目录后启动 https_server，自动用 openssl 生成自签证书（CN 用 socket.gethostname()），手机同 WiFi 首次访问信任证书即可。用户无需手动 openssl 生成。

**Blocked by:** None — 可立即开始

**Status:** ready-for-agent

- [x] 新建 scripts/gen-cert.sh：openssl req -x509 -newkey rsa:2048 -days 3650 -nodes，CN 用 hostname
- [x] https_server 启动时检测 cert/ 缺失，自动调用 gen-cert.sh 生成
- [x] 证书生成后打印"手机同 WiFi 访问 https://<lan-ip>:8443，首次需信任证书"
- [x] 删 cert/ 启动 https_server，cert.pem/key.pem 自动生成
- [x] 证书权限 0600（key.pem）
