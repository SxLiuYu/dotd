"""voice/integration/feishu_gate.py —— Charlie 的飞书长连接：默认关 + 修"起不来就永不再试"。

## 为什么默认关

合并后 **dotd 才是飞书事件订阅的唯一消费者**（`src/surfaces/feishu-ws.ts`，用同一个
`FEISHU_APP_ID` 建长连接、按 owner 过滤、建任务、回卡片）。Charlie 也有一份自己的
`feishu_ws.start()`（`voice/charlie/feishu_ws.py`）—— 一份应用两条长连接，飞书会把
同一条消息事件推给**两条**，结果是同一句话被处理两次：dotd 建了任务，Charlie 又拿
自己的 LLM 回一遍（它还不知道自己已经不该是大脑了）。

所以这里把 Charlie 那条**默认关掉**，需要时用 `CHARLIE_FEISHU_WS=1` 显式打开
（例如单独调试 Charlie 的飞书通道）。

## 为什么还要修 `_started`

上游 `start()` 的门是 `if _started: return`，而 `_started = True` 在线程体**外**、
`thread.start()` 之后立刻置位，之后**任何路径都不复位**：

- 线程体里 `import lark_oapi` 失败 → 线程立刻退出，`_started` 仍是 True；
- `app/schedulers.py` 的 watchdog 每 60s 判 `not is_running()` → 调 `start()` →
  被 `_started` 挡住，直接 return。

现场（2026-10-25 部署日志）：`[feishu-ws] 启动失败: No module named 'lark_oapi'`
之后，"飞书 WS 线程已退出，尝试重启" 打了 **163 次**，一次都没真正重启过 ——
日志看着像在自愈，实际是每 60s 说一遍"我在试"。这就是"看起来有兜底、实际没有"
的典型形态。

修法（不改上游文件，按 `voice/VENDOR.md` 的边界在集成层做）：

- 包一层 `start()`：线程不活着时先把 `_started` 复位，再交给上游原函数；
- 上游原函数首次调用会正常置位、正常起线程；
- 线程真活着时第二次调用仍然被上游挡住（幂等，不会起两条连接）。

`install()` 是幂等的：重复调用只打一次补丁。
"""

from __future__ import annotations

import logging
import os
from typing import Any

log = logging.getLogger("magic")

# 打开 Charlie 自建长连接的环境变量。默认关（dotd 独占）。
GATE_ENV = "CHARLIE_FEISHU_WS"
_ON = ("1", "true", "on", "yes")


def gate_enabled(env: dict[str, str] | None = None) -> bool:
    """是否允许 Charlie 自己建飞书长连接。默认 False。"""
    src = os.environ if env is None else env
    return src.get(GATE_ENV, "").strip().lower() in _ON


def install(module: Any | None = None) -> bool:
    """给 `feishu_ws.start` 打补丁；返回是否（本次或之前）装上了。

    `module` 仅测试用：传一个替身模块，免得为了单测去 import lark_oapi。
    """
    if module is None:
        try:
            import feishu_ws as module  # type: ignore[no-redef]
        except Exception as exc:  # pragma: no cover - 部署环境缺 Charlie
            log.debug("[feishu-gate] 跳过（import feishu_ws 失败）：%s", exc)
            return False

    if getattr(module, "_dotd_gated", False):
        return True

    original = getattr(module, "start", None)
    if not callable(original):
        log.debug("[feishu-gate] 跳过（feishu_ws 没有 start）")
        return False

    def start_gated() -> None:
        if not gate_enabled():
            # 只在第一次说；watchdog 每 60s 调一次，不能刷屏。
            if not getattr(module, "_dotd_gate_noted", False):
                module._dotd_gate_noted = True  # type: ignore[attr-defined]
                log.info(
                    "[feishu-gate] Charlie 自建飞书长连接已关闭（dotd 独占事件订阅）；"
                    "需要打开请设 %s=1",
                    GATE_ENV,
                )
            return

        # 上游的 `_started` 只在真起过线程时置位，且永不复位：线程死了之后
        # 所有重试都被它挡在门口。这里在交给上游之前先按"线程实际是否活着"校准。
        thread = getattr(module, "_ws_thread", None)
        running = thread is not None and getattr(thread, "is_alive", lambda: False)()
        if getattr(module, "_started", False) and not running:
            module._started = False  # type: ignore[attr-defined]
            log.info("[feishu-gate] 线程已退出，复位 _started 后重试")

        original()

        # 上游 start() 是"起线程就返回"，线程体里的失败（缺 lark_oapi、鉴权失败）
        # 发生在之后。若立刻就发现线程不在，至少把 _started 还回去，让下一轮
        # watchdog 真正重试，而不是永久卡住。
        thread = getattr(module, "_ws_thread", None)
        alive = thread is not None and getattr(thread, "is_alive", lambda: False)()
        if getattr(module, "_started", False) and not alive:
            module._started = False  # type: ignore[attr-defined]

    module._dotd_gated = True  # type: ignore[attr-defined]
    module._dotd_original_start = original  # type: ignore[attr-defined]
    module.start = start_gated  # type: ignore[attr-defined]
    log.debug("[feishu-gate] 已接管 feishu_ws.start（默认关）")
    return True
