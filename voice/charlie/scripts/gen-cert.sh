#!/usr/bin/env bash
# 生成 HTTPS 自签证书（手机同 WiFi 访问用）
# 用法: bash gen-cert.sh [cert_dir] [CN]
set -euo pipefail

CERT_DIR="${1:-cert}"
CN="${2:-$(hostname)}"
CERT="$CERT_DIR/cert.pem"
KEY="$CERT_DIR/key.pem"

mkdir -p "$CERT_DIR"
openssl req -x509 -newkey rsa:2048 -days 3650 -nodes \
  -keyout "$KEY" -out "$CERT" \
  -subj "/CN=$CN" 2>/dev/null
chmod 600 "$KEY"
echo "证书已生成: $CERT / $KEY (CN=$CN, 10年有效)"
echo "手机同 WiFi 访问需首次信任证书"
