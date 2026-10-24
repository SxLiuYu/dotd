"""voice/integration/dotd_memory.py —— 记忆源的唯一事实端（阶段 5，2026-10-24）。

## 解决什么

合并前两边各记各的：

    Charlie: conversation_history.json / preferences.json
    dotd:    SQLite(mem_messages) + MEMORY.md + IDENTITY.md + notes/

结果是「语音里说过的，Web 里不记得」。这个模块把 dotd 变成**唯一事实源**：

- 读：Charlie 启动/刷新时，从 `GET /api/device/memory` 拉回 voice thread 的消息与
  偏好；本地 JSON 只当缓存（离线时仍能给出上次的样子）。
- 写：dotd 自己跑完的轮次本来就在 dotd；反射/本地场景这类没经过 dotd 的轮次，
  由这里补写 `POST /api/device/memory/turn`（带 dedupeKey，重试不会写两遍）。
- 偏好：`GET/PUT/DELETE /api/device/prefs`。Charlie 的 preferences.json 继续写，
  但只作为缓存——管理面 `/api/memory/prefs` 读的是同一张 dotd 表。

## 为什么用 monkey-patch

`voice/charlie/` 是 vendored 上游代码（见 `voice/VENDOR.md`）。这里只在运行时
替换 `agent.history` / `agent.preferences` 的模块函数，以及 `voice_agent` /
`agent.llm` 里 import 时抓走的那些直接引用。上游文件一个字节都不改。

## 失败语义

- dotd 不可达：读走本地缓存（**明确是缓存**，不是「没有记忆」）；写尽力而为，
  失败只记日志，不让一次网络抖动把本地对话打断。
- 偏好写 dotd 失败：本地照写，返回给用户的话仍是「已记住」——但日志会标出
  `dotd` 未同步，管理面下一次刷新能看出差异。这是「缓存降级」，不是伪装成功。

## 环境变量

    DOTD_BASE_URL / DOTD_DEVICE_TOKEN   与 dotd_bridge 同一套
    CHARLIE_MEMORY_SYNC=on|off           默认 on（有设备令牌时）
    CHARLIE_MEMORY_TIMEOUT               默认 5s（记忆同步不该拖慢说话）
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Callable, Optional

from voice.integration.dotd_bridge import BridgeError, DeviceBridge

log = logging.getLogger("charlie.memory")

DEFAULT_TIMEOUT_S = 5.0
PREF_CACHE_TTL_S = 5.0


class DotdMemory:
    """设备面记忆客户端：消息走读、反射轮次补写、偏好读写。"""

    def __init__(
        self,
        bridge: DeviceBridge,
        cache_dir: Optional[Path] = None,
        timeout_s: Optional[float] = None,
    ) -> None:
        self.bridge = bridge
        self.cache_dir = Path(cache_dir) if cache_dir is not None else None
        self.timeout_s = float(
            timeout_s if timeout_s is not None else os.environ.get("CHARLIE_MEMORY_TIMEOUT", DEFAULT_TIMEOUT_S)
        )
        self._pref_cache: Optional[dict[str, str]] = None
        self._pref_cache_at = 0.0
        self._pref_lock = threading.Lock()
        # dotd 自己处理过的轮次：Charlie 的本地 append 不该再镜像一遍。
        self._dotd_turns: deque[str] = deque(maxlen=16)
        self._turn_lock = threading.Lock()
        self.last_sync_error: Optional[str] = None

    # ── HTTP ─────────────────────────────────────────────────────

    def _request(self, method: str, path: str, body: Optional[dict[str, Any]] = None) -> Any:
        # DeviceBridge._request 已经处理 429/409/URLError 的错误分层；
        # 记忆同步不需要额度/繁忙两种特殊语义，统一按 BridgeError 处理。
        return self.bridge._request(method, path, body)

    # ── 读 ───────────────────────────────────────────────────────

    def snapshot(self, limit: int = 60) -> dict[str, Any]:
        out = self._request("GET", f"/api/device/memory?limit={int(limit)}")
        if not isinstance(out, dict):
            raise BridgeError(f"GET /api/device/memory 返回的不是对象：{out!r}")
        return out

    def history(self, limit: int = 60) -> list[dict[str, Any]]:
        """dotd 里的 voice thread 消息，转换成 Charlie 的 history 形状。"""
        snap = self.snapshot(limit)
        rows = snap.get("messages") or []
        out: list[dict[str, Any]] = []
        if not isinstance(rows, list):
            return out
        for m in rows:
            if not isinstance(m, dict):
                continue
            role = str(m.get("role") or "")
            content = m.get("content")
            if role not in ("user", "assistant", "system") or not isinstance(content, str):
                continue
            created = m.get("createdAt")
            ts = float(created) / 1000.0 if isinstance(created, (int, float)) else time.time()
            out.append({"role": role, "content": content, "ts": ts})
        return out

    def prefs(self, force: bool = False) -> dict[str, str]:
        now = time.time()
        with self._pref_lock:
            if not force and self._pref_cache is not None and now - self._pref_cache_at < PREF_CACHE_TTL_S:
                return dict(self._pref_cache)
        snap = self.snapshot(limit=1)
        rows = snap.get("prefs") or []
        prefs: dict[str, str] = {}
        if isinstance(rows, list):
            for p in rows:
                if isinstance(p, dict) and isinstance(p.get("key"), str):
                    value = p.get("value")
                    if isinstance(value, str):
                        prefs[p["key"]] = value
        with self._pref_lock:
            self._pref_cache = prefs
            self._pref_cache_at = time.time()
        return dict(prefs)

    # ── 写 ───────────────────────────────────────────────────────

    def set_pref(self, key: str, value: str) -> bool:
        try:
            self._request("PUT", "/api/device/prefs", {"key": key, "value": value})
        except BridgeError as exc:
            self.last_sync_error = f"set_pref {key}: {exc}"
            log.warning("[memory] 偏好未同步到 dotd：%s", exc)
            return False
        with self._pref_lock:
            if self._pref_cache is not None:
                self._pref_cache[key] = value
                self._pref_cache_at = time.time()
        return True

    def delete_pref(self, key: str) -> bool:
        try:
            self._request("DELETE", f"/api/device/prefs/{key}")
        except BridgeError as exc:
            self.last_sync_error = f"delete_pref {key}: {exc}"
            log.warning("[memory] 偏好删除未同步到 dotd：%s", exc)
            return False
        with self._pref_lock:
            if self._pref_cache is not None:
                self._pref_cache.pop(key, None)
                self._pref_cache_at = time.time()
        return True

    def note_dotd_turn(self, user_text: str) -> None:
        """cortex_router 成功把这句话交给 dotd 后调用：本地不再镜像同一轮。"""
        text = (user_text or "").strip()
        if not text:
            return
        with self._turn_lock:
            self._dotd_turns.append(text)

    def _claim_dotd_turn(self, user_text: str) -> bool:
        text = (user_text or "").strip()
        if not text:
            return False
        with self._turn_lock:
            try:
                self._dotd_turns.remove(text)
                return True
            except ValueError:
                return False

    def mirror_turn(self, user_text: str, reply: str, dedupe_key: Optional[str] = None) -> bool:
        """把本地反射/场景轮次补写进 dotd。返回 False = 没写（离线/重复）。"""
        if self._claim_dotd_turn(user_text):
            return False  # dotd 已经记过这一轮，别写第二遍
        body: dict[str, Any] = {"userText": user_text, "reply": reply}
        body["dedupeKey"] = dedupe_key or _turn_key(user_text, reply)
        try:
            out = self._request("POST", "/api/device/memory/turn", body)
        except BridgeError as exc:
            self.last_sync_error = f"mirror_turn: {exc}"
            log.debug("[memory] 轮次未补写到 dotd：%s", exc)
            return False
        return not (isinstance(out, dict) and out.get("duplicate") is True)

    # ── 本地缓存文件（给离线读） ─────────────────────────────────

    def write_cache(self, messages: list[dict[str, Any]], prefs: Optional[dict[str, str]] = None) -> None:
        if self.cache_dir is None:
            return
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            payload = {
                "cache_of": "dotd",
                "synced_at": time.time(),
                "messages": messages,
                "prefs": prefs or {},
            }
            path = self.cache_dir / "memory-cache.json"
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, path)
        except OSError as exc:
            log.debug("[memory] 本地缓存写入失败：%s", exc)

    def read_cache(self) -> dict[str, Any]:
        if self.cache_dir is None:
            return {}
        try:
            raw = (self.cache_dir / "memory-cache.json").read_text(encoding="utf-8")
            data = json.loads(raw)
            return data if isinstance(data, dict) else {}
        except (OSError, json.JSONDecodeError):
            return {}


def _turn_key(user_text: str, reply: str) -> str:
    digest = hashlib.sha256(f"{user_text}\0{reply}".encode("utf-8")).hexdigest()
    return f"{digest[:24]}:{int(time.time() // 60)}"


# ── 与 Charlie 模块的接缝 ──────────────────────────────────────────


def _apply_history(history_mod: Any, memory: DotdMemory, logger: Optional[Callable[[str], None]]) -> None:
    """让 Charlie 的 history 以 dotd 为准；本地文件降级为缓存。"""
    if getattr(history_mod, "_dotd_memory_installed", False):
        return
    orig_load = getattr(history_mod, "_load_history", None)
    orig_append = getattr(history_mod, "_append_history", None)

    if callable(orig_load):
        def load_history() -> None:
            try:
                messages = memory.history()
            except BridgeError as exc:
                memory.last_sync_error = f"history: {exc}"
                if callable(orig_load):
                    orig_load()
                return
            if not messages:
                # dotd 侧还没有这条会话：可能首启，也可能是离线。本地缓存仍可读。
                if callable(orig_load):
                    orig_load()
                return
            sessions = getattr(history_mod, "_sessions", None)
            history = getattr(history_mod, "_history", None)
            lock = getattr(history_mod, "_history_lock", None)
            if sessions is None or history is None:
                return
            ctx = lock if lock is not None else _nullcontext()
            with ctx:
                current = sessions.get("default")
                if current is None:
                    current = history
                    sessions["default"] = current
                current.clear()
                current.extend(messages)
                if current is not history:
                    history.clear()
                    history.extend(messages)
            if logger:
                logger(f"[memory] 从 dotd 拉回 {len(messages)} 条历史（dotd 是唯一事实源）")

        history_mod._load_history = load_history

    if callable(orig_append):
        def append_history(hist: list, user_text: str, assistant_reply: str) -> None:
            orig_append(hist, user_text, assistant_reply)  # 本地缓存照写
            try:
                memory.mirror_turn(user_text, assistant_reply)
            except Exception as exc:  # 记账失败不能打断对话
                log.debug("[memory] mirror_turn 异常：%s", exc)

        history_mod._append_history = append_history

    history_mod._dotd_memory_installed = True


def _apply_prefs(prefs_mod: Any, memory: DotdMemory) -> None:
    if getattr(prefs_mod, "_dotd_memory_installed", False):
        return
    orig_get = getattr(prefs_mod, "get_preference", None)
    orig_list = getattr(prefs_mod, "list_preferences", None)
    orig_set = getattr(prefs_mod, "set_preference", None)
    orig_del = getattr(prefs_mod, "del_preference", None)

    if callable(orig_get):
        def get_preference(key: str) -> str:
            try:
                remote = memory.prefs()
            except BridgeError:
                return orig_get(key)
            if key in remote:
                return remote[key]
            return orig_get(key)

        prefs_mod.get_preference = get_preference

    if callable(orig_list):
        def list_preferences() -> dict:
            local = orig_list()
            try:
                remote = memory.prefs()
            except BridgeError:
                return local
            merged = dict(local)
            merged.update(remote)
            return merged

        prefs_mod.list_preferences = list_preferences

    if callable(orig_set):
        def set_preference(key: str, value: str) -> str:
            result = orig_set(key, value)  # 本地永远是缓存：先保证离线可用
            memory.set_pref(key, value)
            return result

        prefs_mod.set_preference = set_preference

    if callable(orig_del):
        def del_preference(key: str) -> str:
            result = orig_del(key)
            memory.delete_pref(key)
            return result

        prefs_mod.del_preference = del_preference

    prefs_mod._dotd_memory_installed = True


class _nullcontext:
    def __enter__(self) -> None:
        return None

    def __exit__(self, *exc: object) -> bool:
        return False


def install_memory_bridge(
    memory: DotdMemory,
    *,
    history_mod: Any = None,
    prefs_mod: Any = None,
    extra_modules: tuple[Any, ...] = (),
    logger: Optional[Callable[[str], None]] = None,
) -> DotdMemory:
    """把 dotd 记忆接到 Charlie 的模块上。

    `extra_modules` 用来补 `voice_agent` / `agent.llm` 里
    `from agent.history import ...` 抓走的直接引用——那是另一份函数对象。
    """
    if history_mod is None:
        import agent.history as history_mod  # type: ignore
    if prefs_mod is None:
        import agent.preferences as prefs_mod  # type: ignore

    _apply_history(history_mod, memory, logger)
    _apply_prefs(prefs_mod, memory)

    for mod in extra_modules:
        for name in ("_load_history", "_append_history"):
            if hasattr(mod, name):
                setattr(mod, name, getattr(history_mod, name))
        for name in ("get_preference", "list_preferences", "set_preference", "del_preference"):
            if hasattr(mod, name):
                setattr(mod, name, getattr(prefs_mod, name))

    # 启动时立刻把 dotd 的记忆装进内存（离线则回落本地缓存），再写一份本地快照。
    try:
        if hasattr(history_mod, "_load_history"):
            history_mod._load_history()
        messages = memory.history()
        memory.write_cache(messages, memory.prefs(force=True))
    except BridgeError as exc:
        memory.last_sync_error = f"install: {exc}"
        if logger:
            logger(f"[memory] dotd 暂不可用，先用本地缓存：{exc}")
    return memory


def memory_from_env(
    bridge: Optional[DeviceBridge] = None,
    cache_dir: Optional[Path] = None,
) -> Optional[DotdMemory]:
    """按环境变量建一个 DotdMemory；没有设备令牌/被显式关闭时返回 None。"""
    if (os.environ.get("CHARLIE_MEMORY_SYNC") or "on").strip().lower() in ("0", "off", "false", "no"):
        return None
    if bridge is None:
        try:
            bridge = DeviceBridge()
        except BridgeError:
            return None
    if cache_dir is None:
        data_dir = os.environ.get("ASSISTANT_KID_DATA_DIR") or os.environ.get("CHARLIE_HOME")
        cache_dir = Path(data_dir) / "voice" if data_dir else None
    return DotdMemory(bridge, cache_dir=cache_dir)
