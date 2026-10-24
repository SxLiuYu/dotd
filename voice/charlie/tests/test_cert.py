"""
T5 — HTTPS 证书自动生成测试

Seam: app.cert.ensure_cert 公共接口
"""
import os
from unittest.mock import patch, MagicMock

from app import cert


class TestEnsureCert:
    def test_returns_true_when_cert_exists(self, tmp_path):
        """证书已存在时返回 True，不调 gen-cert.sh"""
        c = tmp_path / "cert.pem"
        k = tmp_path / "key.pem"
        c.write_text("FAKE CERT")
        k.write_text("FAKE KEY")
        with patch("subprocess.run") as mock_run:
            result = cert.ensure_cert(str(c), str(k))
        assert result is True
        mock_run.assert_not_called()

    def test_generates_when_missing(self, tmp_path):
        """证书缺失时调用 gen-cert.sh 生成"""
        c = tmp_path / "cert.pem"
        k = tmp_path / "key.pem"
        script = tmp_path / "gen-cert.sh"
        script.write_text("# fake script")

        def fake_run(args, **kwargs):
            # 模拟脚本生成证书文件
            c.write_text("GENERATED CERT")
            k.write_text("GENERATED KEY")
            return MagicMock(returncode=0, stdout="", stderr="")

        with patch("subprocess.run", side_effect=fake_run):
            result = cert.ensure_cert(str(c), str(k), str(script))
        assert result is True
        assert c.exists()
        assert k.exists()

    def test_returns_false_when_script_missing(self, tmp_path):
        """cryptography 不可用且无 script 时返回 False"""
        c = tmp_path / "cert.pem"
        k = tmp_path / "key.pem"
        with patch.object(cert, "_HAS_CRYPTO", False):
            result = cert.ensure_cert(str(c), str(k), "/nonexistent/gen-cert.sh")
        assert result is False

    def test_returns_false_when_generation_fails(self, tmp_path):
        """cryptography 生成失败时返回 False"""
        c = tmp_path / "cert.pem"
        k = tmp_path / "key.pem"
        with patch.object(cert, "_generate_with_cryptography", return_value=False):
            result = cert.ensure_cert(str(c), str(k))
        assert result is False
