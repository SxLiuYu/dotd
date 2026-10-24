#!/bin/bash
# Charlie 语音助手 — 一键启动脚本
# 用法: ./start.sh
#
# 首次运行会自动创建 .env 文件(如果不存在)

set -e
cd "$(dirname "$0")"

echo "=========================================="
echo "  Charlie 语音助手启动中..."
echo "=========================================="

# 检查 .env 文件
if [ ! -f .env ]; then
    echo ""
    echo "⚠️  未找到 .env 配置文件"
    echo "   正在从 .env.example 创建..."
    cp .env.example .env
    echo ""
    echo "❗ 请先编辑 .env 文件，填入你的 API 密钥："
    echo "   必需的密钥："
    echo "   - ARK_KEY        (火山引擎ARK，LLM大脑)"
    echo "   - BAIDU_APP_ID   (百度智能云，ASR+TTS)"
    echo "   - BAIDU_API_KEY"
    echo "   - BAIDU_SECRET_KEY"
    echo "   - AMAP_KEY       (高德地图，天气查询)"
    echo ""
    echo "   获取密钥的链接见 .env.example 中的注释"
    echo ""
    echo "   编辑完成后，重新运行 ./start.sh"
    exit 1
fi

# 检查 Docker
if command -v docker &>/dev/null; then
    echo "✅ 检测到 Docker"
    echo ""
    echo "正在启动 Charlie..."
    docker compose up -d --build
    echo ""
    echo "=========================================="
    echo "  ✅ Charlie 已启动!"
    echo "=========================================="
    echo ""
    echo "  📱 打开浏览器访问: http://localhost:8000"
    echo ""
    echo "  停止: docker compose down"
    echo "  查看日志: docker compose logs -f"
    echo ""
else
    echo "❌ 未检测到 Docker，请先安装 Docker Desktop:"
    echo "   macOS:   https://docs.docker.com/desktop/install/mac-install/"
    echo "   Windows: https://docs.docker.com/desktop/install/windows-install/"
    echo "   Linux:   https://docs.docker.com/engine/install/"
    exit 1
fi
