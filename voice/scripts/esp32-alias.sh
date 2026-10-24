#!/bin/bash
# esp32-alias.sh — 给Mac加192.168.1.3 IP别名，让ESP32旧固件能连上Charlie服务
# 固件里OTA地址硬编码为192.168.1.3，Mac实际IP是192.168.1.12
# 用法: sudo bash scripts/esp32-alias.sh

set -e

# 自动检测WiFi接口
IFACE=$(route get default 2>/dev/null | grep interface | head -1 | awk '{print $2}')
if [ -z "$IFACE" ]; then
  IFACE="en1"
fi
echo "WiFi接口: $IFACE"

# 删除旧别名
sudo ifconfig $IFACE delete 192.168.1.3 2>/dev/null || true

# 添加IP别名
sudo ifconfig $IFACE alias 192.168.1.3 255.255.255.0

# 修复路由（让192.168.1.3指向本地loopback）
sudo route delete 192.168.1.3 2>/dev/null || true
sudo route add -host 192.168.1.3 -interface lo0

# 验证
sleep 1
if curl -s --connect-timeout 3 http://192.168.1.3:8000/health | grep -q "ok"; then
  echo "✅ 192.168.1.3:8000 可达，ESP32可以连接"
else
  echo "❌ 不可达，检查Charlie服务是否运行在8000端口"
  exit 1
fi
