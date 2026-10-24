"""voice/integration/cortex_router.py —— Charlie 的「反射 + 皮层」分流器（2026-10-23）。

## 它解决什么

合并方案（docs/voice-merge-plan.md §0）定的是 **B′：Charlie 是产品壳，dotd 是内核**。
Charlie 原来从 ASR 到回答都由自己的 LLM 完成，合并后只有 dotd 能当主脑；但「开灯/晚安/
切换角色」这类反射必须留在本地，否则断网和延迟都会退步。

这个模块是两者之间**唯一的分流点**：

    一句话
      ├─ 反射（FastPath / 场景协议 / 已有缓存 / 低意图）→ 本地立即答，不碰网络
      └─ 皮层（其余一切）→ dotd；dotd 不在线就明说，并只执行本地场景

## 为什么用 monkey-patch 而不是改上游

`voice/charlie/` 是 vendored 上游代码（见 `voice/VENDOR.md`），改它会让后续同步变成
合并地狱。这里只在**运行时**替换两个缝：

1. `voice_agent._brain_llm` / `agent.llm._brain_llm` —— 上游 `brain()` 里所有反射都跑完、
   准备调模型的那一行。这是非流式路径的精确边界。
2. `agent.llm.brain_stream_sentences` —— 流式路径（ESP32 WS / `/api/conversation` /
   飞书文本）。包装器先跑同一套反射，再问 dotd；`channel='feishu_text'` 与「被打断后
   继续」仍交还上游，避免把两套会话语义搅在一起。

## 记账

反射执行完 → `POST /api/device/events`（kind=`fast_path.<name>` / `scene.<key>`）。
dotd 不在线时写本地 spool（JSONL），下次成功调用前补传。这样「晚安」在断网时也能执行，
恢复后 feed 里仍能看到这一条。

## 环境变量

    CHARLIE_CORTEX=auto|on|off     默认 auto（有 dotd token 就接管）
    DOTD_BASE_URL                  默认 http://127.0.0.1:7788
    DOTD_DEVICE_TOKEN              有则走设备面（任务归属到设备，推荐）
    DOTD_TOKEN                     没有设备令牌时的 master 兜底
    CHARLIE_CORTEX_TIMEOUT         单轮等待秒数，默认 90
    CHARLIE_REFLEX_SPOOL           离线记账文件，默认 <CHARLIE_DATA_DIR>/reflex-spool.jsonl

## 明确不做

- 不把反射结果伪装成模型回答（记账里 source 写清楚）；
- dotd 不在线时不执行任何需要联网/写操作的意图；
- 不改主人在 Web 上的审批权：语音端只会说「需要你确认」。
"""

from __future__ import annotations

import json
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from voice.integration.dotd_bridge import (
    BridgeError,
    DeviceBridge,
    DeviceBusyError,
    DeviceQuotaError,
    DotdBridge,
    TurnResult,
)

OFFLINE_REPLY = "大脑不在线，这句话我处理不了；刚才没有执行任何在线操作。"
OFFLINE_SCENE_SUFFIX = "（大脑不在线，只执行了本地场景）"
NEEDS_OWNER_REPLY = "这一步需要你在手机或网页上确认，我不能替你点同意。"
QUOTA_REPLY = "今天这台设备的额度已经用完了，明天再来。"
BUSY_REPLY = "上一句话我还在处理，说完这句再接。"

DEFAULT_SPOOL = "reflex-spool.jsonl"


# ── 配置 ────────────────────────────────────────────────────────────


@dataclass
class CortexConfig:
    mode: str = "auto"
    timeout_s: float = 90.0
    spool_path: Optional[Path] = None

    @classmethod
    def from_env(cls, env: Optional[dict[str, str]] = None) -> "CortexConfig":
        e = env if env is not None else os.environ
        mode = (e.get("CHARLIE_CORTEX") or "auto").strip().lower()
        if mode not in ("auto", "on", "off"):
            mode = "auto"
        try:
            timeout_s = float(e.get("CHARLIE_CORTEX_TIMEOUT") or 90)
        except ValueError:
            timeout_s = 90.0
        spool = (e.get("CHARLIE_REFLEX_SPOOL") or "").strip()
        spool_path = Path(spool).expanduser() if spool else None
        return cls(mode=mode, timeout_s=timeout_s, spool_path=spool_path)


# ── 离线记账 ────────────────────────────────────────────────────────


class ReflexSpool:
    """dotd 不在线时的本地记账队列（一行一个 JSON 对象）。

    只追加；补传成功后整文件重写。写入失败不影响反射执行——记账不能反过来
    拖垮「开灯」。
    """

    def __init__(self, path: Optional[Path]) -> None:
        self.path = path
        self._lock = threading.Lock()

    def add(self, kind: str, detail: Optional[str]) -> bool:
        if self.path is None:
            return False
        rec = {"kind": kind, "detail": detail, "at": int(time.time())}
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self._lock, self.path.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            return True
        except OSError:
            return False

    def _read(self) -> list[dict[str, Any]]:
        if self.path is None or not self.path.is_file():
            return []
        out: list[dict[str, Any]] = []
        try:
            for line in self.path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(rec, dict) and isinstance(rec.get("kind"), str):
                    out.append(rec)
        except OSError:
            return []
        return out

    def pending(self) -> int:
        return len(self._read())

    def flush(self, bridge: Any) -> int:
        """把 spool 里的记录补传给 dotd，返回成功条数。失败的下次再来。"""
        recs = self._read()
        if not recs or self.path is None:
            return 0
        failed: list[dict[str, Any]] = []
        sent = 0
        for rec in recs:
            ok = False
            try:
                ok = bool(bridge.record_event(str(rec["kind"]), rec.get("detail")))
            except Exception:
                ok = False
            if ok:
                sent += 1
            else:
                failed.append(rec)
        try:
            with self._lock:
                if failed:
                    tmp = self.path.with_suffix(".tmp")
                    tmp.write_text(
                        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in failed),
                        encoding="utf-8",
                    )
                    tmp.replace(self.path)
                else:
                    self.path.unlink(missing_ok=True)
        except OSError:
            pass
        return sent


# ── 结果 ────────────────────────────────────────────────────────────


@dataclass
class CortexReply:
    text: str
    source: str  # 'reflex' | 'cortex' | 'offline-scene' | 'offline' | 'needs-owner'
    task_id: Optional[str] = None
    thread_id: Optional[str] = None
    detail: Optional[str] = None


# ── 主体 ────────────────────────────────────────────────────────────


class CortexRouter:
    """反射优先、皮层兜底。所有 Charlie 模块的引用都是**懒加载**，便于单测注入。"""

    def __init__(
        self,
        bridge: Any = None,
        config: Optional[CortexConfig] = None,
        spool: Optional[ReflexSpool] = None,
        modules: Optional[dict[str, Any]] = None,
        logger: Optional[Callable[[str], None]] = None,
        memory: Any = None,
    ) -> None:
        self.config = config or CortexConfig.from_env()
        self.bridge = bridge
        self.spool = spool or ReflexSpool(self.config.spool_path)
        self._modules = modules
        self._log = logger or (lambda msg: None)
        self._threads: dict[str, str] = {}
        # 阶段 5：dotd 是唯一记忆源。记忆桥负责「dotd 已记过的轮次不再镜像」。
        self.memory = memory

    # -- Charlie 模块（懒加载 / 可注入） ------------------------------

    def _mods(self) -> dict[str, Any]:
        if self._modules is not None:
            return self._modules
        import agent.llm as agent_llm  # noqa: WPS433 —— 必须在 Charlie 的 sys.path 下
        import voice_agent

        self._modules = {"voice_agent": voice_agent, "llm": agent_llm}
        return self._modules

    # -- 反射 --------------------------------------------------------

    def reflex(self, text: str, session_id: str = "default") -> Optional[CortexReply]:
        """与上游 `brain_stream_sentences()` 前半段保持同一顺序。

        上游新增反射项时这里要跟着加（`test_cortex_router` 会比对 FAST_PATHS 是否被
        完整走过一遍）。
        """
        va = self._mods().get("voice_agent")

        smart = getattr(va, "_handle_smart_command", None)
        if callable(smart):
            reply = smart(text)
            if reply:
                return CortexReply(reply, "reflex", detail="smart_command")

        feedback = getattr(va, "_decision_feedback_handler", None)
        if callable(feedback):
            reply = feedback(text, session_id)
            if reply:
                return CortexReply(reply, "reflex", detail="decision_feedback")

        for path in getattr(va, "FAST_PATHS", []) or []:
            try:
                reply = path.run(text, session_id)
            except Exception as exc:
                self._log(f"[cortex] fast_path {getattr(path, 'name', '?')} 失败：{exc}")
                reply = None
            if reply is not None:
                return CortexReply(reply, "reflex", detail=f"fast_path.{getattr(path, 'name', '?')}")

        cache_get = getattr(va, "_cache_get", None)
        if callable(cache_get):
            cached = cache_get(text, session_id)
            if isinstance(cached, str) and cached.strip():
                return CortexReply(cached, "reflex", detail="cache")

        # 摄像头源名兜底（上游 `brain()` 在缓存之后、LLM 之前）：
        # 「帮我看看院子」这类必须在本地抓帧，不能丢给 dotd 猜。
        camera = self._camera(text, session_id)
        if camera is not None:
            return CortexReply(camera, "reflex", detail="camera")

        scene = self._scene(text)
        if scene is not None:
            return CortexReply(scene, "reflex", detail="scene")

        garbled = getattr(va, "is_garbled_asr", None)
        low = getattr(va, "LOW_INTENT_ASR_REPLY", None)
        if callable(garbled) and isinstance(low, str) and garbled(text):
            return CortexReply(low, "reflex", detail="garbled")

        return None

    def _camera(self, text: str, session_id: str) -> Optional[str]:
        injected = (self._modules or {}).get("camera")
        if callable(injected):
            try:
                reply = injected(text, session_id)
            except Exception as exc:
                self._log(f"[cortex] 摄像头兜底失败：{exc}")
                return None
            return reply if isinstance(reply, str) and reply.strip() else None
        try:
            from agent.vision import try_camera_by_source_name

            reply = try_camera_by_source_name(text, session_id)
            return reply if isinstance(reply, str) and reply.strip() else None
        except Exception as exc:
            self._log(f"[cortex] 摄像头源名匹配跳过：{exc}")
            return None

    def _scene(self, text: str) -> Optional[str]:
        # 单测/别的前端可以注入场景执行器，避免 import 整个 Charlie。
        injected = (self._modules or {}).get("scene")
        if callable(injected):
            try:
                reply = injected(text)
            except Exception as exc:
                self._log(f"[cortex] 场景执行失败：{exc}")
                return None
            return reply if isinstance(reply, str) and reply.strip() else None
        try:
            from app import load_magic_module

            mod = load_magic_module("magic_scenes")
            if not mod:
                return None
            key = mod.match_protocol(text)
            if not key:
                return None
            reply = mod.execute_protocol(key)
            return reply if isinstance(reply, str) and reply.strip() else None
        except Exception as exc:
            self._log(f"[cortex] 场景匹配跳过：{exc}")
            return None

    # -- 皮层 --------------------------------------------------------

    def ask(self, text: str, session_id: str = "default") -> CortexReply:
        if self.config.mode == "off" or self.bridge is None:
            return self._offline(text, "皮层接管已关闭")

        # 先把离线记账补传：任务能到，说明网络回来了。
        try:
            self.spool.flush(self.bridge)
        except Exception as exc:
            self._log(f"[cortex] 补传记账失败：{exc}")

        thread_id = self._threads.get(session_id)
        try:
            result: TurnResult = self.bridge.turn(text, thread_id=thread_id, timeout_s=self.config.timeout_s)
        except DeviceQuotaError as exc:
            return self._quota(str(exc))
        except DeviceBusyError as exc:
            return self._busy(str(exc))
        except BridgeError as exc:
            return self._offline(text, str(exc))
        except Exception as exc:
            return self._offline(text, f"{type(exc).__name__}: {exc}")

        if result.thread_id:
            self._threads[session_id] = result.thread_id

        if result.status == "quota":
            return self._quota(result.reason or "")
        if result.status == "busy":
            return self._busy(result.reason or "")
        if result.status == "unreachable":
            return self._offline(text, result.reason or "dotd 不可达")
        if result.needs_owner:
            return CortexReply(
                NEEDS_OWNER_REPLY,
                "needs-owner",
                task_id=result.task_id,
                thread_id=result.thread_id,
                detail=result.reason,
            )
        if result.ok and result.reply:
            if self.memory is not None:
                try:
                    # 这一轮已经在 dotd 落了（user 由 /api/device/turn 写，
                    # assistant 由 Runner 写）；Charlie 本地 append 时不要再镜像一遍。
                    self.memory.note_dotd_turn(text)
                except Exception as exc:  # 记忆桥故障不影响回答
                    self._log(f"[memory] note_dotd_turn 失败：{exc}")
            return CortexReply(result.reply, "cortex", task_id=result.task_id, thread_id=result.thread_id)
        return CortexReply(
            result.reply or f"任务没有成功：{result.reason or result.status}",
            "offline" if result.status in ("unreachable", "config") else "cortex",
            task_id=result.task_id,
            thread_id=result.thread_id,
            detail=result.reason,
        )

    def _quota(self, reason: str) -> CortexReply:
        """额度用尽：照 dotd 的原话播出来（含「今天」「额度」），不吞、不改写成离线。"""
        text = reason.strip() or QUOTA_REPLY
        return CortexReply(text, "quota", detail=reason)

    def _busy(self, reason: str) -> CortexReply:
        return CortexReply(BUSY_REPLY, "busy", detail=reason)

    def _offline(self, text: str, reason: str) -> CortexReply:
        """dotd 不在线：只做本地场景，并且**必须说出来**。"""
        scene = self._scene(text)
        if scene is not None:
            self.account("scene.offline", text)
            return CortexReply(scene + OFFLINE_SCENE_SUFFIX, "offline-scene", detail=reason)
        self.account("offline", text)
        return CortexReply(OFFLINE_REPLY, "offline", detail=reason)

    # -- 记账 --------------------------------------------------------

    def account(self, kind: str, detail: Optional[str] = None) -> bool:
        clipped = (detail or "")[:200] or None
        rec = self.bridge if getattr(self.bridge, "record_event", None) is not None else None
        if rec is not None:
            try:
                if rec.record_event(kind, clipped):
                    return True
            except Exception:
                pass
        return self.spool.add(kind, clipped)

    # -- 单入口 ------------------------------------------------------

    def reply(self, text: str, session_id: str = "default") -> CortexReply:
        """反射 → 皮层。Charlie 的所有入口最终都收敛到这一步。"""
        reflex = self.reflex(text, session_id)
        if reflex is not None:
            # 反射不经过 dotd，但也不能是"没发生过"：场景/工具类反射要留痕。
            if reflex.detail in ("scene", "camera") or (
                reflex.detail or ""
            ).startswith("fast_path."):
                self.account(reflex.detail or "reflex", text)
            return reflex
        return self.ask(text, session_id)


# ── 安装到 Charlie（运行时） ────────────────────────────────────────


def build_bridge(env: Optional[dict[str, str]] = None) -> Any:
    """设备令牌优先；没有就退到 master（任务不带设备归属，日志里会说清楚）。"""
    e = env if env is not None else os.environ
    base = e.get("DOTD_BASE_URL") or None
    timeout = None
    raw_timeout = e.get("CHARLIE_CORTEX_TIMEOUT")
    if raw_timeout:
        try:
            timeout = float(raw_timeout)
        except ValueError:
            timeout = None
    if (e.get("DOTD_DEVICE_TOKEN") or "").strip():
        return DeviceBridge(base_url=base, timeout_s=timeout)
    if (e.get("DOTD_TOKEN") or "").strip():
        return DotdBridge(base_url=base, timeout_s=timeout)
    return None


def install(
    bridge: Any = None,
    config: Optional[CortexConfig] = None,
    logger: Optional[Callable[[str], None]] = None,
) -> Optional[CortexRouter]:
    """把分流器装到已 import 的 Charlie 模块上。返回 router；未启用返回 None。"""
    cfg = config or CortexConfig.from_env()
    if cfg.mode == "off":
        return None
    if bridge is None:
        try:
            bridge = build_bridge()
        except BridgeError as exc:
            if logger:
                logger(f"[cortex] 未接管：{exc}")
            return None
    if bridge is None:
        if logger:
            logger("[cortex] 未接管：没有 DOTD_DEVICE_TOKEN / DOTD_TOKEN")
        return None

    import agent.llm as agent_llm
    import voice_agent

    # 阶段 5：记忆源与主动推送都归 dotd。
    # 只用设备桥装配记忆桥（master 令牌没有 /api/device/memory 的归属语义）。
    memory = None
    try:
        from voice.integration.dotd_memory import install_memory_bridge, memory_from_env

        memory = memory_from_env(bridge if isinstance(bridge, DeviceBridge) else None)
        if memory is not None:
            install_memory_bridge(
                memory,
                extra_modules=(voice_agent, agent_llm),
                logger=logger,
            )
    except Exception as exc:
        if logger:
            logger(f"[memory] 未接管记忆源：{type(exc).__name__}: {exc}")

    try:
        from voice.integration.push_gate import install as install_push_gate

        install_push_gate(bridge=bridge if isinstance(bridge, DeviceBridge) else None, logger=logger)
    except Exception as exc:
        if logger:
            logger(f"[push-gate] 未接管主动推送：{type(exc).__name__}: {exc}")

    router = CortexRouter(bridge=bridge, config=cfg, logger=logger, memory=memory)

    if getattr(voice_agent, "_dotd_cortex_installed", False):
        existing = getattr(voice_agent, "_dotd_cortex_router", None)
        if isinstance(existing, CortexRouter) and existing.memory is None:
            existing.memory = memory
        return existing if isinstance(existing, CortexRouter) else router

    # 1. 非流式入口：替换 `brain` 本身，让反射只跑一遍（不会因为先跑上游反射、
    #    再跑我们的反射而重复执行副作用）。
    def brain(text: str, session_id: str = "default") -> str:
        return router.reply(text, session_id).text

    voice_agent.brain = brain
    if hasattr(agent_llm, "brain"):
        agent_llm.brain = brain

    # 兜底：极少数内部调用点仍会直接调 `_brain_llm`（上游 llm.py 的降级分支）。
    # 到这一层时反射已经跑过，不能再跑一遍。
    def brain_llm(text: str, session_id: str = "default") -> str:
        return router.ask(text, session_id).text

    voice_agent._brain_llm = brain_llm
    agent_llm._brain_llm = brain_llm

    # 2. 流式：反射自己跑，皮层整段回答作为一句话送出（dotd 的回复本来就是终稿）。
    original_stream = voice_agent.brain_stream_sentences

    def brain_stream_sentences(
        text: str,
        session_id: str = "default",
        interrupted_reply: str = "",
        channel: str = "voice",
        cancel_event: Any = None,
    ):
        # 被打断续说、飞书文本：交还上游，避免两套会话语义打架。
        if interrupted_reply.strip() or channel != "voice":
            yield from original_stream(
                text,
                session_id=session_id,
                interrupted_reply=interrupted_reply,
                channel=channel,
                cancel_event=cancel_event,
            )
            return
        result = router.reply(text, session_id)
        clean = getattr(agent_llm, "_clean_for_tts", None)
        sentence = clean(result.text) if callable(clean) else result.text
        yield (sentence, result.text)

    voice_agent.brain_stream_sentences = brain_stream_sentences
    if hasattr(agent_llm, "brain_stream_sentences"):
        agent_llm.brain_stream_sentences = brain_stream_sentences

    voice_agent._dotd_cortex_installed = True
    voice_agent._dotd_cortex_router = router
    if logger:
        kind = "设备面" if isinstance(bridge, DeviceBridge) else "master 兜底"
        logger(f"[cortex] 已接管（{kind}）：反射本地，其余交给 dotd")
    return router
