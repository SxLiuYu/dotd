"""
T11 — ESP32 烧录向导 API 测试

Seam: HTTP API (GET /esp32-setup, GET /api/esp32/detect-port, POST /api/esp32/flash, GET /api/esp32/flash-status)
"""
import os
from unittest.mock import patch, MagicMock

import pytest
from fastapi.testclient import TestClient

import voice_server


@pytest.fixture(scope="module")
def client():
    os.environ["SKIP_BACKGROUND"] = "1"
    os.environ.setdefault("GLM_KEY", "test")
    os.environ.setdefault("TTS_KEY", "test")
    os.environ.setdefault("ASR_KEY", "test")
    os.environ.setdefault("AMAP_KEY", "test")
    yield TestClient(voice_server.app)


class TestEsp32Wizard:
    def test_setup_page_returns_html(self, client):
        """GET /esp32-setup 返回 HTML"""
        r = client.get("/esp32-setup")
        assert r.status_code == 200
        assert "text/html" in r.headers.get("content-type", "")

    def test_detect_port_returns_structure(self, client):
        """GET /api/esp32/detect-port 返回 {ports: list}"""
        r = client.get("/api/esp32/detect-port")
        assert r.status_code == 200
        data = r.json()
        assert "ports" in data
        assert isinstance(data["ports"], list)

    def test_flash_status_returns_structure(self, client):
        """GET /api/esp32/flash-status 返回 {done, error, progress}"""
        r = client.get("/api/esp32/flash-status")
        assert r.status_code == 200
        data = r.json()
        assert "done" in data
        assert "error" in data

    def test_flash_starts_with_valid_input(self, client):
        """POST /api/esp32/flash 仅需 port 即可启动（WiFi 改由 AP 热点门户配置）"""
        with patch.object(voice_server._esp32_flash, "start", return_value=True) as mock_start:
            r = client.post("/api/esp32/flash", json={
                "port": "/dev/cu.usbmodem101",
            })
        assert r.status_code == 200
        assert r.json()["started"] is True
        mock_start.assert_called_once()

    def test_flash_rejects_missing_port(self, client):
        """POST /api/esp32/flash 缺少 port 返回 422"""
        r = client.post("/api/esp32/flash", json={"ssid": "MyWiFi"})
        assert r.status_code == 422

    def test_flash_ignores_wifi_fields(self, client):
        """POST /api/esp32/flash 不再接收 ssid/password/server_ip（AP 配网），但 port 足够即可启动"""
        with patch.object(voice_server._esp32_flash, "start", return_value=True):
            r = client.post("/api/esp32/flash", json={"port": "COM3"})
        assert r.status_code == 200
        assert r.json()["started"] is True

    def test_config_info_returns_provisioning_info(self, client):
        """GET /api/esp32/config-info 返回 OTA 地址/热点名等配网信息"""
        r = client.get("/api/esp32/config-info")
        assert r.status_code == 200
        data = r.json()
        for key in ("ota_url", "ws_url", "ap_prefix", "portal_url", "http_port"):
            assert key in data, f"缺少字段 {key}"
        assert data["portal_url"] == "http://192.168.4.1"
        assert "/xiaozhi/ota" in data["ota_url"]
