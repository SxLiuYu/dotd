"""#6 BackgroundTask 测试"""
import time
from app.background_task import BackgroundTask


class TestBackgroundTask:
    def test_start_returns_true(self):
        bt = BackgroundTask("test")
        assert bt.start(lambda: None) is True

    def test_start_returns_false_when_active(self):
        bt = BackgroundTask("test")
        bt.start(lambda: time.sleep(2))
        assert bt.start(lambda: None) is False
        bt.status()  # wait

    def test_status_returns_structure(self):
        bt = BackgroundTask("test")
        s = bt.status()
        assert "active" in s and "done" in s and "error" in s and "progress" in s

    def test_done_after_completion(self):
        bt = BackgroundTask("test")
        bt.start(lambda: "result")
        time.sleep(0.5)
        s = bt.status()
        assert s["done"] is True
        assert s["active"] is False

    def test_error_captured(self):
        def fail():
            raise ValueError("boom")
        bt = BackgroundTask("test")
        bt.start(fail)
        time.sleep(0.5)
        s = bt.status()
        assert s["error"] is not None
        assert "boom" in s["error"]

    def test_update_progress(self):
        bt = BackgroundTask("test")
        bt.update_progress("step 1")
        assert bt.status()["progress"] == "step 1"

    def test_result_stored(self):
        bt = BackgroundTask("test")
        bt.start(lambda: "my_result")
        time.sleep(0.5)
        assert bt.status()["result"] == "my_result"
