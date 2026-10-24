"""voice/integration/push_gate.py —— 主动推送的「单一决策者」（阶段 5，2026-10-24）。

## 解决什么

合并前 Charlie 有 `magic-decisions.py`（状态感知 + 防骚扰），dotd 有
`src/surfaces/proactive.ts`（三道闸）。两边都开 = 主人被两边同时打扰，
而且两边对「安静时段」的定义还不一样。

现在只留一个决策者：

    Charlie 的规则引擎照常算出「想说什么」 → 问 dotd「该不该说」→ 允许才发。

dotd 侧复用同一套闸（总开关 / 安静时段 / 节流），再补每日总量与同文去重，
并把每次决策写 `device_push_log`。Charlie 只负责「怎么说」（TTS/飞书/ESP32）。

## 哪些不经过闸

- `reminder`：主人显式定的提醒，不该被防骚扰拦掉；
- `wake` / `health`：对话转录与系统自监控，不是主动打扰。

其余（weather/sleep/away/home/morning/evening/decision/suggestion/preference/
auto_trigger/个性化推荐）一律先问 dotd。

## 失败语义

- dotd 不可达：默认 **fail-closed**（不说话）。理由：主人已经选择「dotd 决定」，
  离线时两条规则都失效，此时宁可安静，也不要退回两套推送同时开口。
  需要旧行为可设 `CHARLIE_PUSH_GATE_FAIL=open`。
- 拒绝只影响「发不发」，不影响规则引擎记账（它照常更新自己的 cooldown，
  避免恢复在线后一次补发一片）。

## 环境变量

    CHARLIE_PUSH_DECIDER=dotd|local   默认 dotd（local = 完全不接管，回到上游行为）
    CHARLIE_PUSH_GATE_FAIL=closed|open 默认 closed
    DOTD_BASE_URL / DOTD_DEVICE_TOKEN   与 dotd_bridge 同一套
"""

from __future__ import annotations

import logging
import os
from typing import Any, Callable, Optional

from voice.integration.dotd_bridge import BridgeError, DeviceBridge

log = logging.getLogger("charlie.push")

EXEMPT_KINDS = frozenset({"reminder", "wake", "health"})
DECIDER_DEFAULT = "dotd"
FAIL_DEFAULT = "closed"


class PushGate:
    """把「该不该说」交给 dotd 的唯一入口。"""

    def __init__(
        self,
        bridge: Optional[DeviceBridge] = None,
        mode: Optional[str] = None,
        fail: Optional[str] = None,
        logger: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.bridge = bridge
        self.mode = (mode or os.environ.get("CHARLIE_PUSH_DECIDER") or DECIDER_DEFAULT).strip().lower()
        self.fail = (fail or os.environ.get("CHARLIE_PUSH_GATE_FAIL") or FAIL_DEFAULT).strip().lower()
        self.logger = logger or (lambda msg: log.info(msg))
        self.last_error: Optional[str] = None
        self.decisions: list[dict[str, Any]] = []

    @property
    def enabled(self) -> bool:
        return self.mode == "dotd" and self.bridge is not None

    def applies_to(self, kind: str) -> bool:
        return self.enabled and kind not in EXEMPT_KINDS

    def decide(self, kind: str, text: str) -> tuple[bool, Optional[str]]:
        """返回 (allow, reason)。dotd 不可达时按 fail 策略决定。"""
        if not self.enabled:
            return True, None
        if kind in EXEMPT_KINDS:
            return True, None
        if self.bridge is None:
            return True, None
        try:
            out = self.bridge._request(
                "POST", "/api/device/proactive/decide", {"kind": kind, "text": text}
            )
        except BridgeError as exc:
            self.last_error = str(exc)
            allow = self.fail == "open"
            reason = "unreachable_fail_open" if allow else "unreachable_fail_closed"
            self.logger(f"[push-gate] dotd 不可达（{exc}）→ {'放行' if allow else '保持安静'}")
            self._remember(kind, allow, reason)
            return allow, reason
        if not isinstance(out, dict):
            self.last_error = f"unexpected response: {out!r}"
            allow = self.fail == "open"
            self._remember(kind, allow, "bad_response")
            return allow, "bad_response"
        allow = out.get("allow") is True
        reason = out.get("reason") if isinstance(out.get("reason"), str) else None
        self._remember(kind, allow, reason)
        if not allow:
            self.logger(f"[push-gate] 不说（{reason or 'denied'}）：{text[:40]}")
        return allow, reason

    def _remember(self, kind: str, allow: bool, reason: Optional[str]) -> None:
        self.decisions.append({"kind": kind, "allow": allow, "reason": reason})
        if len(self.decisions) > 200:
            del self.decisions[:100]


def _decide_or_allow(gate: PushGate, kind: str, text: str) -> bool:
    # 决策本身抛异常不能把整条推送线程弄死：按 fail 策略兜底。
    try:
        allow, _ = gate.decide(kind, text)
        return allow
    except Exception as exc:
        log.warning("[push-gate] 决策异常（%s），按 %s 处理", exc, gate.fail)
        return gate.fail == "open"


def install_push_gate(
    gate: PushGate,
    *,
    notifications_mod: Any = None,
    scheduler_modules: tuple[Any, ...] = (),
    personalized_push_mod: Any = None,
    voice_server_mod: Any = None,
) -> PushGate:
    """接管主动推送的发送口。可重复调用（幂等）。"""
    if notifications_mod is None:
        import app.notifications as notifications_mod  # type: ignore

    if not getattr(notifications_mod, "_dotd_push_gate_installed", False):
        orig_add = notifications_mod.add_notification

        def add_notification(text: str, ntype: str = "reminder", *args: Any, **kwargs: Any) -> Any:
            if not gate.applies_to(ntype):
                return orig_add(text, ntype, *args, **kwargs)
            if not _decide_or_allow(gate, ntype, text):
                return None
            return orig_add(text, ntype, *args, **kwargs)

        notifications_mod.add_notification = add_notification
        notifications_mod._dotd_push_gate_installed = True
    else:
        add_notification = notifications_mod.add_notification

    # 上游有若干模块在 import 时就把函数抓成了自己的名字（schedulers / voice_server）。
    for mod in scheduler_modules:
        if getattr(mod, "add_notification", None) is not None and not getattr(
            mod, "_dotd_push_gate_installed", False
        ):
            mod.add_notification = add_notification
            mod._dotd_push_gate_installed = True

    if voice_server_mod is not None:
        for name in ("add_notification", "_add_notification"):
            if getattr(voice_server_mod, name, None) is not None:
                setattr(voice_server_mod, name, add_notification)
        voice_server_mod._dotd_push_gate_installed = True

    if personalized_push_mod is not None and not getattr(
        personalized_push_mod, "_dotd_push_gate_installed", False
    ):
        orig_digest = getattr(personalized_push_mod, "push_personalized_digest", None)
        if callable(orig_digest):
            def push_personalized_digest(*args: Any, **kwargs: Any) -> Any:
                if not _decide_or_allow(gate, "personalized", "今日热点精选"):
                    return None
                return orig_digest(*args, **kwargs)

            personalized_push_mod.push_personalized_digest = push_personalized_digest
        personalized_push_mod._dotd_push_gate_installed = True

    return gate


def install(
    bridge: Optional[DeviceBridge] = None,
    logger: Optional[Callable[[str], None]] = None,
) -> Optional[PushGate]:
    """按环境变量装配；未启用/没有设备令牌时返回 None。"""
    mode = (os.environ.get("CHARLIE_PUSH_DECIDER") or DECIDER_DEFAULT).strip().lower()
    if mode in ("local", "off", "0", "false", "no"):
        return None
    if bridge is None:
        try:
            bridge = DeviceBridge()
        except BridgeError as exc:
            if logger:
                logger(f"[push-gate] 未接管：{exc}")
            return None
    gate = PushGate(bridge=bridge, mode="dotd", logger=logger)
    try:
        import app.notifications as notifications_mod  # type: ignore
        import app.schedulers as schedulers_mod  # type: ignore
        import personalized_push  # type: ignore
        import voice_server  # type: ignore
    except Exception as exc:  # Charlie 未在 sys.path 下：调用方可用显式装配
        if logger:
            logger(f"[push-gate] Charlie 模块不可用，跳过自动接管：{exc}")
        return gate
    install_push_gate(
        gate,
        notifications_mod=notifications_mod,
        scheduler_modules=(schedulers_mod,),
        personalized_push_mod=personalized_push,
        voice_server_mod=voice_server,
    )
    return gate
