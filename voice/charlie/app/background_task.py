"""后台任务管理 — 收编 esp32_flash/model_download/proactive 三联重复

BackgroundTask 类封装：启动守卫 + 状态字典 + 轮询 status 接口。
三个调用点变成一行。
"""
import threading
import logging

log = logging.getLogger("magic")


class BackgroundTask:
    """后台任务：线程安全的状态管理 + 轮询接口

    用法:
        flash = BackgroundTask("esp32_flash")
        # 启动:
        flash.start(my_func, arg1, arg2)
        # 查询:
        flash.status()  → {active, done, error, progress}
    """

    def __init__(self, name: str):
        self.name = name
        self._lock = threading.Lock()
        self._state = {"active": False, "done": False, "error": None, "progress": "", "result": None}

    def start(self, target, *args, **kwargs) -> bool:
        """启动后台线程。如果已有任务在跑返回 False。"""
        with self._lock:
            if self._state["active"]:
                return False
            self._state.update({"active": True, "done": False, "error": None, "progress": "启动中", "result": None})
        t = threading.Thread(target=self._run, args=(target, args, kwargs), daemon=True)
        t.start()
        return True

    def _run(self, target, args, kwargs):
        try:
            result = target(*args, **kwargs)
            with self._lock:
                self._state["result"] = result
                self._state["done"] = True
        except Exception as e:
            with self._lock:
                self._state["error"] = str(e)
                log.error(f"[bg:{self.name}] 失败: {e}")
        finally:
            with self._lock:
                self._state["active"] = False

    def update_progress(self, msg: str):
        """更新进度（线程安全）"""
        with self._lock:
            self._state["progress"] = msg

    def set_result(self, key: str, value):
        """设置额外结果字段"""
        with self._lock:
            self._state[key] = value

    def status(self) -> dict:
        """返回当前状态快照"""
        with self._lock:
            return dict(self._state)

    def is_active(self) -> bool:
        with self._lock:
            return self._state["active"]
