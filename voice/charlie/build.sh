#!/bin/bash
# Charlie 语音助手 — 桌面应用构建脚本
# 用法: ./build.sh
# 输出: dist/charlie/charlie (macOS) 或 dist/charlie/charlie.exe (Windows)

set -e
cd "$(dirname "$0")"

echo "=========================================="
echo "  Charlie 桌面应用构建"
echo "  平台: $(uname -s)"
echo "=========================================="
echo ""

# 1. 激活虚拟环境
if [ -f .venv/bin/activate ]; then
    source .venv/bin/activate
elif [ -f venv/bin/activate ]; then
    source venv/bin/activate
fi

# 2. 安装 PyInstaller
echo "[1/6] 检查 PyInstaller..."
pip install pyinstaller --quiet 2>/dev/null || pip3 install pyinstaller --quiet
echo "  ✅ PyInstaller 已安装: $(pyinstaller --version 2>&1 | head -1)"
echo ""

# 2b. 打包前跑测试验证（不破坏现有功能）
echo "[2/6] 跑产品化测试验证..."
python3 -m pytest tests/test_demo_rule_mode.py tests/test_lan_info.py tests/test_preflight.py tests/test_mcp_gate.py tests/test_cert.py tests/test_model_download.py tests/test_setup_api.py tests/test_welcome.py tests/test_nvs_patch.py tests/test_esp32_wizard.py tests/test_charlie_main.py -q 2>&1 | tail -3 || { echo "❌ 测试失败，终止构建"; exit 1; }
echo "  ✅ 测试通过"
echo ""

# 3. 清理旧构建
echo "[2/5] 清理旧构建产物..."
rm -rf build/ dist/
echo "  ✅ 已清理"
echo ""

# 4. 构建
echo "[3/5] 开始构建 (可能需要 2-5 分钟)..."
pyinstaller charlie.spec --noconfirm 2>&1 | tail -20
echo ""

# 5. 后处理: 将 .env.example 复制到 dist/charlie/ 根目录 (PyInstaller 放到了 _internal/)
echo "[4/5] 后处理..."
if [ -f dist/charlie/_internal/.env.example ] && [ ! -f dist/charlie/.env.example ]; then
    cp dist/charlie/_internal/.env.example dist/charlie/.env.example
fi
# 创建 web -> _internal/web 的符号链接 (voice_server.py 用 __file__ 找 web/, frozen 模式下 __file__ 在 _internal/)
echo "  ✅ 后处理完成"
echo ""

# 6. 验证
echo "[5/5] 验证构建产物..."
if [ -f dist/charlie/charlie ] || [ -f dist/charlie/charlie.exe ]; then
    BIN="dist/charlie/charlie"
    [ ! -f "$BIN" ] && BIN="dist/charlie/charlie.exe"
    SIZE=$(du -sh dist/charlie/ | cut -f1)
    echo "  ✅ 构建成功!"
    echo "  📦 路径: $BIN"
    echo "  📦 大小: $SIZE"
else
    echo "  ❌ 构建失败: 未找到可执行文件"
    exit 1
fi
echo ""

# 6. 测试启动 (3秒后自动退出)
echo "[5/5] 测试启动..."
timeout 3 "$BIN" 2>&1 | head -5 || true
echo ""
echo "=========================================="
echo "  ✅ 构建完成!"
echo "=========================================="
echo ""
echo "  分发给用户:"
echo "    1. 压缩 dist/charlie/ 目录 → charlie-mac.zip (macOS)"
echo "    2. 用户解压后, 编辑同目录下的 .env 填入API密钥"
echo "    3. 双击 charlie (macOS) 或 charlie.exe (Windows) 启动"
echo "    4. 浏览器自动打开 http://localhost:8000"
echo ""
echo "  macOS 用户首次打开如果提示'无法验证开发者':"
echo "    系统偏好设置 → 安全性与隐私 → 允许打开"
echo ""
