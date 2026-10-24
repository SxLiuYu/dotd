"""
T9 — charlie_main 首次启动检测测试

Seam: charlie_main._ensure_first_run 公共接口
契约：返回首启目标路径（首次="/welcome"，已配置="/"），不再开浏览器（窗口化后由 pywebview 加载该路径）。
"""
import os
from unittest.mock import patch

import charlie_main


class TestEnsureFirstRun:
    def test_creates_env_from_example_when_missing(self, tmp_path):
        """缺 .env 时从 .env.example 复制，并返回 /welcome"""
        example = tmp_path / ".env.example"
        example.write_text("ARK_KEY=\nBAIDU_API_KEY=\n")
        assert not (tmp_path / ".env").exists()
        result = charlie_main._ensure_first_run(str(tmp_path))
        assert result == "/welcome"
        assert (tmp_path / ".env").exists()
        assert (tmp_path / ".env").read_text() == "ARK_KEY=\nBAIDU_API_KEY=\n"

    def test_creates_empty_env_when_no_example(self, tmp_path):
        """无 .env.example 时创建空白 .env，返回 /welcome"""
        result = charlie_main._ensure_first_run(str(tmp_path))
        assert result == "/welcome"
        assert (tmp_path / ".env").exists()

    def test_skips_when_env_exists(self, tmp_path):
        """已存在 .env 时返回 /，不复制"""
        (tmp_path / ".env").write_text("ARK_KEY=test")
        result = charlie_main._ensure_first_run(str(tmp_path))
        assert result == "/"

    def test_returns_welcome_path_on_first_run(self, tmp_path):
        """首次启动返回 /welcome 路径串"""
        result = charlie_main._ensure_first_run(str(tmp_path))
        assert "/welcome" in result
