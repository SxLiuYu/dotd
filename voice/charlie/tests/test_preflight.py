"""
T3 — preflight 外部二进制检测测试

Seam: app.preflight 公共接口（check_binary / run_preflight）
"""
from app import preflight


class TestPreflight:
    def test_check_binary_returns_true_for_existing(self):
        """已安装的二进制返回 True（python3 必定存在）"""
        assert preflight.check_binary("python3") is True

    def test_check_binary_returns_false_for_missing(self):
        """不存在的二进制返回 False"""
        assert preflight.check_binary("nonexistent-xyz-12345") is False

    def test_run_preflight_returns_all_binaries(self):
        """run_preflight 返回所有检测项含状态和安装指引"""
        result = preflight.run_preflight()
        assert "ffmpeg" in result
        assert "ollama" in result
        assert "ncm" in result
        assert "ego-browser" in result
        assert "esptool" in result
        for name, info in result.items():
            assert "installed" in info
            assert "install_guide" in info
            assert "purpose" in info
            assert isinstance(info["installed"], bool)

    def test_run_preflight_detects_ffmpeg_correctly(self):
        """ffmpeg 检测结果与 check_binary 一致"""
        result = preflight.run_preflight()
        assert result["ffmpeg"]["installed"] == preflight.check_binary("ffmpeg")
