"""voice/integration/dotd_bridge.py —— Charlie → dotd 的唯一接缝（2026-10-23）。

## 为什么需要它

Charlie 原来自己扮演"大脑"：`voice_agent.py` 里做意图识别、FastPath、LLM、MCP。
合并之后只能有一个大脑——**dotd**。Charlie 保留 ASR/TTS/ESP32/红外这些宿主能力，
把"需要规划、需要动文件/网页/邮件、需要审批"的意图交给 dotd。

这个模块就是那条边：只用标准库（urllib），不 import Charlie 的任何模块，
因此可以单独测试、单独跑，也可以被别的语音前端复用。

## 它做什么

    turn(text, thread_id) ->
      1. POST /api/messages        （dotd 建任务 + 落 thread）
      2. 轮询 GET /api/tasks/:id   （直到终态 / 需要主人 / 超时）
      3. 终态后读 GET /api/conversations?thread=…
         取最后一条 assistant 正文作为要播报的回复
      4. 可选 GET /api/tasks/:id/proof 拿 bundleHash

## 它不做什么

- 不自己调模型、不自己执行工具、不改 dotd 的库；
- 超时**不取消**任务（语音说"我先想想"之后，任务可以继续跑，主人在 Web 能看到）；
- 不回退成"假装成功"：拿不到回复就明确返回 `ok=false` + `reason`。

## 环境变量

    DOTD_BASE_URL   默认 http://127.0.0.1:7788
    DOTD_TOKEN      master token（必需；与 Web/CLI 同一个）
    DOTD_TIMEOUT    单轮等待秒数，默认 90

## 命令行

    python -m voice.integration.dotd_bridge "帮我把今天的报价单核对一下"
    python -m voice.integration.dotd_bridge --json "..."
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Optional

DEFAULT_BASE_URL = "http://127.0.0.1:7788"
DEFAULT_TIMEOUT_S = 90.0
POLL_INTERVAL_S = 0.35

TERMINAL = {"done", "failed", "cancelled"}
NEEDS_OWNER = {"awaiting_approval", "paused"}


class BridgeError(RuntimeError):
    """dotd 不可达或返回了无法解释的响应。"""


class DeviceQuotaError(BridgeError):
    """429 `device_quota`：今天的额度用完了。

    单列一个类型，是因为它**不能**按“大脑不在线”处理：设备是在线的、任务被
    明确拒绝，再说“网络不通”会误导人；也不该进离线补传队列（明天重试没意义）。
    """


class DeviceBusyError(BridgeError):
    """409 `device_busy`：同一设备上一个语音任务还没结束。"""


def _error_code(detail: str) -> str:
    """从 dotd 的错误响应体里取 `error`（不是 JSON 就返回空串）。"""
    try:
        body = json.loads(detail)
    except json.JSONDecodeError:
        return ""
    return str(body.get("error") or "") if isinstance(body, dict) else ""


def _error_message(detail: str) -> str:
    try:
        body = json.loads(detail)
    except json.JSONDecodeError:
        return ""
    return str(body.get("message") or "") if isinstance(body, dict) else ""


@dataclass
class TurnResult:
    ok: bool
    status: str
    task_id: Optional[str] = None
    thread_id: Optional[str] = None
    reply: Optional[str] = None
    needs_owner: bool = False
    reason: Optional[str] = None
    proof_hash: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "status": self.status,
            "taskId": self.task_id,
            "threadId": self.thread_id,
            "reply": self.reply,
            "needsOwner": self.needs_owner,
            "reason": self.reason,
            "proofHash": self.proof_hash,
        }


class DotdBridge:
    def __init__(
        self,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        timeout_s: Optional[float] = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get("DOTD_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.token = token or os.environ.get("DOTD_TOKEN") or ""
        if not self.token:
            raise BridgeError("DOTD_TOKEN 未设置：Charlie 需要与 Web/CLI 相同的 master token")
        self.timeout_s = float(
            timeout_s if timeout_s is not None else os.environ.get("DOTD_TIMEOUT", DEFAULT_TIMEOUT_S)
        )

    # ── HTTP ────────────────────────────────────────────────────────

    def _request(self, method: str, path: str, body: Optional[dict[str, Any]] = None) -> Any:
        data = None
        headers = {"authorization": f"Bearer {self.token}", "accept": "application/json"}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["content-type"] = "application/json; charset=utf-8"
        req = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=max(5.0, min(self.timeout_s, 60.0))) as res:
                raw = res.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:500]
            raise BridgeError(f"dotd HTTP {exc.code} {path}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise BridgeError(f"dotd 不可达（{self.base_url}）：{exc.reason}") from exc
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise BridgeError(f"dotd 返回的不是 JSON：{raw[:200]!r}") from exc

    # ── 单轮 ────────────────────────────────────────────────────────

    def submit(self, text: str, thread_id: Optional[str] = None) -> dict[str, Any]:
        body: dict[str, Any] = {"text": text}
        if thread_id:
            body["threadId"] = thread_id
        out = self._request("POST", "/api/messages", body)
        if not isinstance(out, dict) or not out.get("taskId"):
            raise BridgeError(f"POST /api/messages 没返回 taskId：{out!r}")
        return out

    def task(self, task_id: str) -> dict[str, Any]:
        out = self._request("GET", f"/api/tasks/{urllib.parse.quote(task_id)}")
        return out if isinstance(out, dict) else {}

    def wait(self, task_id: str, timeout_s: Optional[float] = None) -> tuple[str, dict[str, Any]]:
        deadline = time.monotonic() + (timeout_s if timeout_s is not None else self.timeout_s)
        last: dict[str, Any] = {}
        while True:
            last = self.task(task_id)
            status = str((last.get("task") or {}).get("status") or last.get("status") or "unknown")
            if status in TERMINAL or status in NEEDS_OWNER:
                return status, last
            if time.monotonic() >= deadline:
                return "timeout", last
            time.sleep(POLL_INTERVAL_S)

    def last_assistant(self, thread_id: str) -> Optional[str]:
        qs = urllib.parse.urlencode({"thread": thread_id, "limit": 30})
        out = self._request("GET", f"/api/conversations?{qs}")
        msgs = out.get("messages") if isinstance(out, dict) else None
        if not isinstance(msgs, list):
            return None
        for msg in reversed(msgs):
            if not isinstance(msg, dict):
                continue
            if msg.get("role") == "assistant" and msg.get("kind") == "text":
                content = msg.get("content")
                if isinstance(content, str) and content.strip():
                    return content.strip()
        return None

    def proof_hash(self, task_id: str) -> Optional[str]:
        try:
            out = self._request("GET", f"/api/tasks/{urllib.parse.quote(task_id)}/proof")
        except BridgeError:
            return None
        if isinstance(out, dict) and isinstance(out.get("bundleHash"), str):
            return out["bundleHash"]
        return None

    def turn(
        self,
        text: str,
        thread_id: Optional[str] = None,
        timeout_s: Optional[float] = None,
        include_proof: bool = True,
    ) -> TurnResult:
        try:
            submitted = self.submit(text, thread_id)
        except BridgeError as exc:
            return TurnResult(ok=False, status="unreachable", reason=str(exc))

        task_id = str(submitted["taskId"])
        thread = str(submitted.get("threadId") or thread_id or "")
        status, detail = self.wait(task_id, timeout_s)

        if status == "timeout":
            return TurnResult(
                ok=False,
                status="timeout",
                task_id=task_id,
                thread_id=thread or None,
                reason=f"任务 {task_id} 在 {int(self.timeout_s)}s 内没有到终态（任务没有取消）",
            )
        if status in NEEDS_OWNER:
            return TurnResult(
                ok=False,
                status=status,
                task_id=task_id,
                thread_id=thread or None,
                needs_owner=True,
                reason="这一步需要主人确认，语音端不代替你点批准",
            )

        reply = self.last_assistant(thread) if thread else None
        if reply is None:
            summary = detail.get("summary") if isinstance(detail, dict) else None
            state_line = summary.get("stateLine") if isinstance(summary, dict) else None
            return TurnResult(
                ok=False,
                status=status,
                task_id=task_id,
                thread_id=thread or None,
                reason=str(state_line or "任务结束了，但会话里没有可播报的 assistant 正文"),
            )

        return TurnResult(
            ok=status == "done",
            status=status,
            task_id=task_id,
            thread_id=thread or None,
            reply=reply,
            reason=None if status == "done" else f"任务终态是 {status}",
            proof_hash=self.proof_hash(task_id) if include_proof else None,
        )


class DeviceBridge:
    """设备身份版桥（阶段 2，2026-10-23）。

    和 `DotdBridge` 的区别只有一条：**只走 `/api/device/*`**，用设备令牌而不是 master。
    好处是任务天然归属到某台设备（voice thread 的 external_ref=deviceId），凭证能回答
    「哪个设备、哪次会话」；代价是设备读不到 `/api/conversations`，所以正文由
    `GET /api/device/tasks/:id` 的 `reply` 字段带回。

    环境变量：
        DOTD_BASE_URL          默认 http://127.0.0.1:7788
        DOTD_DEVICE_TOKEN      设备令牌（`dt_...`，创建时只显示一次）
        DOTD_DEVICE_ID         可选；只用于日志/事件关联
    """

    def __init__(
        self,
        base_url: Optional[str] = None,
        token: Optional[str] = None,
        timeout_s: Optional[float] = None,
    ) -> None:
        self.base_url = (base_url or os.environ.get("DOTD_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
        self.token = token or os.environ.get("DOTD_DEVICE_TOKEN") or ""
        if not self.token:
            raise BridgeError("DOTD_DEVICE_TOKEN 未设置：请先创建设备（POST /api/devices）")
        self.device_id = os.environ.get("DOTD_DEVICE_ID") or ""
        self.timeout_s = float(
            timeout_s if timeout_s is not None else os.environ.get("DOTD_TIMEOUT", DEFAULT_TIMEOUT_S)
        )

    def _request(self, method: str, path: str, body: Optional[dict[str, Any]] = None) -> Any:
        data = None
        headers = {"authorization": f"Bearer {self.token}", "accept": "application/json"}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["content-type"] = "application/json; charset=utf-8"
        req = urllib.request.Request(self.base_url + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=max(5.0, min(self.timeout_s, 60.0))) as res:
                raw = res.read()
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:500]
            code = _error_code(detail)
            if exc.code == 429 and code == "device_quota":
                raise DeviceQuotaError(_error_message(detail) or "今天这台设备的额度用完了；明天再来") from exc
            if exc.code == 409 and code == "device_busy":
                raise DeviceBusyError(_error_message(detail) or "上一句话还在处理") from exc
            raise BridgeError(f"dotd HTTP {exc.code} {path}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise BridgeError(f"dotd 不可达（{self.base_url}）：{exc.reason}") from exc
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise BridgeError(f"dotd 返回的不是 JSON：{raw[:200]!r}") from exc

    def submit(self, text: str, thread_id: Optional[str] = None) -> dict[str, Any]:
        body: dict[str, Any] = {"text": text}
        if thread_id:
            body["threadId"] = thread_id
        out = self._request("POST", "/api/device/turn", body)
        if not isinstance(out, dict) or not out.get("taskId"):
            raise BridgeError(f"POST /api/device/turn 没返回 taskId：{out!r}")
        return out

    def task(self, task_id: str) -> dict[str, Any]:
        out = self._request("GET", f"/api/device/tasks/{urllib.parse.quote(task_id)}")
        return out if isinstance(out, dict) else {}

    def wait(self, task_id: str, timeout_s: Optional[float] = None) -> tuple[str, dict[str, Any]]:
        deadline = time.monotonic() + (timeout_s if timeout_s is not None else self.timeout_s)
        last: dict[str, Any] = {}
        while True:
            last = self.task(task_id)
            status = str((last.get("task") or {}).get("status") or "unknown")
            if status in TERMINAL or status in NEEDS_OWNER:
                return status, last
            if time.monotonic() >= deadline:
                return "timeout", last
            time.sleep(POLL_INTERVAL_S)

    def record_event(self, kind: str, detail: Optional[str] = None) -> bool:
        """反射层记账。返回 False = 没记上（离线/鉴权失败），调用方负责补传。"""
        body: dict[str, Any] = {"kind": kind}
        if detail:
            body["detail"] = detail
        try:
            self._request("POST", "/api/device/events", body)
            return True
        except BridgeError:
            return False

    def turn(
        self,
        text: str,
        thread_id: Optional[str] = None,
        timeout_s: Optional[float] = None,
    ) -> TurnResult:
        try:
            submitted = self.submit(text, thread_id)
        except DeviceQuotaError as exc:
            # 额度用尽是**明确拒绝**，不是离线：不能借“大脑不在线”搪塞，
            # 也不进离线补传（明天再试没有意义）。
            return TurnResult(ok=False, status="quota", reason=str(exc))
        except DeviceBusyError as exc:
            return TurnResult(ok=False, status="busy", reason=str(exc))
        except BridgeError as exc:
            return TurnResult(ok=False, status="unreachable", reason=str(exc))

        task_id = str(submitted["taskId"])
        thread = str(submitted.get("threadId") or thread_id or "")
        status, detail = self.wait(task_id, timeout_s)

        if status == "timeout":
            return TurnResult(
                ok=False,
                status="timeout",
                task_id=task_id,
                thread_id=thread or None,
                reason=f"任务 {task_id} 在 {int(self.timeout_s)}s 内没有到终态（任务没有取消）",
            )
        if status in NEEDS_OWNER:
            return TurnResult(
                ok=False,
                status=status,
                task_id=task_id,
                thread_id=thread or None,
                needs_owner=True,
                reason="这一步需要主人确认，语音端不代替你点批准",
            )

        reply = detail.get("reply")
        if not isinstance(reply, str) or not reply.strip():
            summary = detail.get("summary") if isinstance(detail, dict) else None
            state_line = summary.get("stateLine") if isinstance(summary, dict) else None
            return TurnResult(
                ok=False,
                status=status,
                task_id=task_id,
                thread_id=thread or None,
                reason=str(state_line or "任务结束了，但设备面没有可播报的 assistant 正文"),
            )

        return TurnResult(
            ok=status == "done",
            status=status,
            task_id=task_id,
            thread_id=thread or None,
            reply=reply.strip(),
            reason=None if status == "done" else f"任务终态是 {status}",
        )


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Charlie → dotd 单轮桥")
    parser.add_argument("text", nargs="?", help="要说的话")
    parser.add_argument("--text", dest="text_opt", help="要说的话（与位置参数二选一）")
    parser.add_argument("--thread", help="复用已有会话 id")
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    parser.add_argument("--timeout", type=float, help="等待秒数")
    args = parser.parse_args(argv)

    text = args.text or args.text_opt
    if not text:
        parser.error('需要一句话：python -m voice.integration.dotd_bridge "..."')

    try:
        bridge = DotdBridge(timeout_s=args.timeout)
        result = bridge.turn(text, thread_id=args.thread, timeout_s=args.timeout)
    except BridgeError as exc:
        print(json.dumps({"ok": False, "status": "config", "reason": str(exc)}, ensure_ascii=False))
        return 2

    if args.json:
        print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
    else:
        if result.reply:
            print(result.reply)
        else:
            print(f"[{result.status}] {result.reason or '没有回复'}", file=sys.stderr)
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
