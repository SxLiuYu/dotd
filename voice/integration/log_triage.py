"""voice/integration/log_triage.py —— 把"架构上本来就该失败"的日志降噪。

## 为什么需要

合并后大脑是 **dotd**（Charlie → `voice/integration/dotd_bridge.py` → dotd）。
Charlie 自己的 `_get_brain()`（qwen_agent + 一堆云端 LLM key）只是 dotd 不在线时的
降级路径。所以部署机上没有 `AGNES_KEY` / `STEPFUN_KEY` / `GLM_KEY` / `ARK_KEY`
是**预期状态**，不是故障。

但上游在 import 期就会打好几类"必然失败"的 WARNING：

    [WARNING] [warmup] brain(none) 预热失败: 未配置 LLM。请至少配置一个 LLM Provider
                的 API Key。…（一屏配置指引）
    [WARNING] [warmup] 百度token预热失败(不影响使用): 400 Client Error
    [WARNING] [env] === Demo 模式已启用 ===
    [WARNING] 未配置 ARK_KEY / GLM_KEY，大脑将使用 Ollama 本地模型。
    [WARNING] [intent] 本地分类失败,默认none: err=Invalid URL '/chat/completions'
    [WARNING] [xiaozhi] Silero VAD load fail, fallback to RMS endpointing
    [WARNING] [wake] openwakeword 未安装，运行 pip install openwakeword
    [WARNING] [wake] 无可用唤醒词模型 (openWakeWord/sherpa)，本地唤醒词不可用
    [WARNING] [preflight] ❌ ncm 未安装 …（可选）

结果是每次重启都有一屏红字，指向**合并架构里不需要你来配**的东西。真出问题时
（dotd 也挂了、确实要靠 Charlie 本地大脑兜底）反而会被这屏噪音淹没。

## 做法

不改上游文件（`voice/VENDOR.md`），在日志层装一个 Filter：把**已知的、架构内
预期失败**的记录降到 INFO（并在第一次出现时换成一句人话），之后不再重复。
其他一切照旧 —— 匹配不到的记录一个字节都不动。

**注意 logger 名**：上游 `voice_agent.py` / `voice_server.py` / `agent.llm` /
`agent.asr_tts` / `app.preflight` 用的都是 `logging.getLogger("magic")`，
和 Charlie 其余 100 多个模块**共用同一个 logger**。所以判定绝不能只看 logger 名，
必须同时匹配消息里的固定文字，否则会把别处的真 WARNING 一起吞掉。

## 明确保留（不许降噪）

- `[env] 缺少N个必需密钥: [...]` —— 它点名了真缺什么（如 `AMAP_KEY` 缺了天气就用不了），
  是有效信息，不是架构噪音；
- `[asr] SenseVoice 模型不存在` —— 模型该下载（`scripts/download-models.sh`），
  降噪只会让"设备听不见"更难发现；
- 运行期的 `[tts] baidu 失败` / `[asr] baidu 失败` —— 真在调百度时的问题；
- `[warmup] … 预热失败` 但原因**不是**缺 key（如 `No module named 'soundfile'`）。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

_installed = False

# 默认要装 filter 的 logger。`magic` 覆盖 Charlie 绝大部分模块；`app.xiaozhi_ws`
# 是个例外（`getLogger(__name__)`），设备侧的 Silero VAD 告警就在它那儿。
_DEFAULT_LOGGERS: tuple[str, ...] = ("magic", "app.xiaozhi_ws")


@dataclass(frozen=True)
class _Rule:
    """一条降噪规则：消息里同时含全部 markers 才命中。"""

    kind: str            # 去重键；同类只解释一次
    markers: tuple[str, ...]
    text: str | None     # 命中后替换成这句；None = 直接丢弃
    keep_text: bool = False   # True：保留原文（只降级），用于"每条都有用"的批量告警
    once: bool = False        # True：同类只留第一条


_RULES: tuple[_Rule, ...] = (
    # 1. Charlie 本地大脑没配 LLM —— 合并架构下大脑是 dotd，这是预期状态。
    _Rule(
        "local_brain",
        ("预热失败", "未配置 LLM"),
        "[local-brain] Charlie 本地大脑未配置（合并架构下很正常：大脑是 dotd）。"
        "只有 dotd 离线时才需要它，届时配 AGNES_KEY/STEPFUN_KEY/GLM_KEY 任一即可。",
        once=True,
    ),
    # 2. 百度预热。没配 BAIDU_* 时上游仍会去换 token，拿到 400 后打 WARNING。
    #    只认 `[warmup] 百度*预热失败`（含"不影响使用"），不认运行期的
    #    `[tts] baidu 失败` —— 后者是真在用百度合成时的问题，必须保留。
    _Rule(
        "baidu_warmup",
        ("[warmup] 百度", "不影响使用"),
        "[local-brain] 百度 ASR/TTS 未配置，跳过预热（不影响使用；TTS 走 Edge）。",
        once=True,
    ),
    # 3. 本地意图分类。没配任何 LLM 时 `active_chat_endpoint()` 返回空串，
    #    上游却直接拿它拼 URL → requests 抛 InvalidURL。空白 base 拼 URL 是上游
    #    的实现瑕疵（该在拿不到 base 时直接按 none 处理）；在合并架构里意图由
    #    dotd 决定，这里只解释一次。
    _Rule(
        "intent_no_llm",
        ("[intent] 本地分类失败", "Invalid URL"),
        "[local-brain] Charlie 侧没有 LLM，跳过 LLM 意图分类（合并架构下意图由 dotd 决定；"
        "关键词命中仍然有效）。",
        once=True,
    ),
    # 4. Silero VAD 是**故意不装**的：它拉 multi-GB torch。上游的设计降级是
    #    RMS 端点检测（20 帧≈1.2s vs Silero 6 帧≈0.36s），能正常用。
    _Rule(
        "silero_vad",
        ("Silero VAD load fail", "silero_vad"),
        "[xiaozhi] 未装 Silero VAD，用 RMS 端点检测（故意的：silero-vad 要拉 torch）。"
        "代价是尾静音判定 1.2s 而非 0.36s。",
        once=True,
    ),
    # 5. Demo 模式三连。第一行和第三行在合并架构下没有信息量，中间那行还会说
    #    "大脑将使用 Ollama 本地模型" —— 事实上合并后大脑是 dotd，这句是错的。
    _Rule("demo_banner", ("=== Demo 模式已启用 ===",), None),
    _Rule(
        "demo_note",
        ("未配置 ARK_KEY / GLM_KEY",),
        "[local-brain] 未配置 Charlie 自己的 LLM key（合并架构下正常：大脑是 dotd，"
        "不是 Ollama）。",
        once=True,
    ),
    _Rule("demo_hint", ("推荐: 打开", "/welcome"), None),
    # 6. preflight 的可选项（ollama/ncm/ego-browser/esptool）：缺了就是缺了，
    #    但它们是**可选**功能，不该和 ffmpeg 这种必需项一样报红。保留原文降为 INFO。
    _Rule("preflight_optional", ("[preflight] ❌", "（可选"), None, keep_text=True),
    # 7. 本地唤醒词（桌面麦克风）。`start_wake_listener()` 里无条件起线程，20s 后
    #    `_listen_loop` 先打"openwakeword 未安装"，紧接着因为没有模型再打一条
    #    "无可用唤醒词模型"。openwakeword 不在任何 requirements 里，也**不该**装到
    #    服务器上：ESP32 的唤醒词跑在固件里，服务器没有麦克风。
    #    两条说的是同一件事 —— 前一条是细节（直接丢），后一条换成一句人话。
    #    故意不共用 once 标记：万一哪天 openwakeword 装上了却加载失败，只会出现
    #    后一条；共用会让它的解释被前面那条的 kind 提前吃掉。
    _Rule("local_wake_dep", ("[wake] openwakeword 未安装",), None),
    _Rule(
        "local_wake",
        ("[wake] 无可用唤醒词模型",),
        "[wake] 本地唤醒词不可用（正常）：这是桌面麦克风的功能，openwakeword 不在依赖里；"
        "ESP32 的唤醒在设备固件里做，服务器没有麦克风也不需要。要开桌面唤醒再 "
        "pip install openwakeword，或配 KWS_MODEL 用 sherpa KeywordSpotter。",
        once=True,
    ),
    # 8. 同一个 silero-vad 在 local_wake 里还有一份加载器（`_load_silero_vad`），
    #    用的是"能量阈值"降级。现在没有唤醒词模型所以走不到；一旦装了
    #    openwakeword 就会冒出来，和上一条同源，一并解释掉。
    _Rule(
        "silero_vad_wake",
        ("[wake] Silero VAD 加载失败",),
        "[wake] 未装 Silero VAD，唤醒词监听里的断句用能量阈值（同上，故意的）。",
        once=True,
    ),
)


class _Downgrade(logging.Filter):
    """命中规则的记录降到 INFO；once 类只留一条。"""

    def __init__(self) -> None:
        super().__init__()
        self._seen: set[str] = set()

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: A003 - logging API
        try:
            msg = record.getMessage()
        except Exception:
            return True
        for rule in _RULES:
            if not all(m in msg for m in rule.markers):
                continue
            if rule.once:
                if rule.kind in self._seen:
                    # 已经解释过一次，别再重复（既不刷 INFO 也不刷 WARNING）。
                    return False
                self._seen.add(rule.kind)
            if rule.text is None and not rule.keep_text:
                return False
            record.levelno = logging.INFO
            record.levelname = "INFO"
            if not rule.keep_text:
                record.msg = rule.text
                record.args = ()
            return True
        return True


def install(logger_name: str | tuple[str, ...] = _DEFAULT_LOGGERS) -> bool:
    """给 Charlie 的日志装降噪 filter；幂等。

    默认装两个：`magic`（voice_agent / voice_server / agent.llm / agent.asr_tts /
    app.preflight 共用）和 `app.xiaozhi_ws`（该模块用的是 `getLogger(__name__)`，
    Silero VAD 那条 WARNING 就是从这里出来的）。漏装后者会让"故意不装的
    silero-vad"继续每次重启报一条红字。
    """
    global _installed
    if _installed:
        return True
    names = (logger_name,) if isinstance(logger_name, str) else logger_name
    for name in names:
        logging.getLogger(name).addFilter(_Downgrade())
    _installed = True
    return True
