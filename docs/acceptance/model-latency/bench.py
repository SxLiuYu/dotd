#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""网关模型延迟基准（dotd 选型用）。只读真网关，不改任何状态。

四种形状，对应 daemon 实际会打的四类请求：

    ttft    单轮带 tools + tool_choice:auto，量首 token 与总耗时
    loop    两轮真实主循环：工具调用 → 喂回结果收尾
    multi   多轮：工具结果里明说"还有别的文件没看"，逼模型继续调，量总墙钟与轮数
    light   light 轨形状：无工具单轮短答（事件匹配）

用法：

    export HY3_API_KEY=...            # 或 source ~/.dotd/tokens.env
    python docs/acceptance/model-latency/bench.py ttft --runs 3 \
        --models deepseek-v4.1-flash DeepSeek-Flash Qwen3.8-Flash

每条样本一行 JSON 追加到同目录的 <形状>-runs.jsonl（长跑中断也不丢数据），
最后打印排序表。模型名必须与网关目录一致（先 `GET /v1/models` 拉一遍）。

注意：工具名必须用线上格式（下划线），不要用契约的点分名——网关对
`fs.read` 会 400 "tool name is invalid or duplicated"（deepseek-v4.1-flash
实测）。daemon 侧由 transport 消毒，手写脚本得自己来。
"""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = os.getenv("DOTD_BENCH_BASE_URL", "http://172.17.48.1:13065/v1")
KEY = os.environ.get("HY3_API_KEY", "")
HERE = Path(__file__).resolve().parent

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "fs_read",
            "description": "读取 home 下的一个文件",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "task_list",
            "description": "列出当前未完成的待办",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
]
TOOL_NAMES = {t["function"]["name"] for t in TOOLS}

FILE_TEXT = "probe 文件内容：明天九点开会。"
TODOS = "1. 交周报（未完成）2. 回邮件（未完成）"

SYS = "你是主人电脑上的助理。必须调用工具，不要凭空回答。回答用中文，一两句话。"
ASK = "帮我看看 notes/probe.md 里写了什么，然后告诉我今天还有哪些待办没做完。"

SOCK = 45.0


def post(model: str, messages: list, *, tools: bool = True, max_tokens: int = 128) -> dict:
    body = {"model": model, "messages": messages, "temperature": 0, "max_tokens": max_tokens}
    if tools:
        body["tools"] = TOOLS
        body["tool_choice"] = "auto"
    req = urllib.request.Request(
        f"{BASE}/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"},
    )
    with urllib.request.urlopen(req, timeout=SOCK) as r:
        return json.loads(r.read().decode())


def _err(e: BaseException) -> str:
    if isinstance(e, urllib.error.HTTPError):
        return f"HTTP {e.code}: {e.read().decode(errors='replace')[:180]}"
    return f"{type(e).__name__}: {str(e)[:120]}"


def run_ttft(model: str) -> dict:
    """单轮：量第一个 token 和第一个"能看的" token。

    本网关的推理模型会先流 `reasoning_content`（思维链），再流 `content`/
    `tool_calls`。对用户可见的等待是**第一个 content/tool 增量**，不是思维链
    首字；两者都要记，否则会把"思考慢"误读成"没响应"。

    max_tokens 不能太抠：48 时推理模型把预算全烧在思维链上，永远走不到回答
    （实测 finish_reason=length 且 content 为空），会被误判成模型不可用。
    """
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": "你要查时间必须调工具，不要编造。"},
            {"role": "user", "content": "查一下现在几点，只回答时间。"},
        ],
        "tools": TOOLS,
        "tool_choice": "auto",
        "temperature": 0,
        "max_tokens": 512,
        "stream": True,
    }
    req = urllib.request.Request(
        f"{BASE}/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"},
    )
    t0 = time.time()
    ttft_any = None
    ttft_answer = None
    saw_tool = False
    finish = None
    try:
        with urllib.request.urlopen(req, timeout=SOCK) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                for ch in chunk.get("choices", []):
                    d = ch.get("delta") or {}
                    if ch.get("finish_reason"):
                        finish = ch["finish_reason"]
                    got_any = bool(d.get("content") or d.get("tool_calls") or d.get("reasoning_content"))
                    if got_any and ttft_any is None:
                        ttft_any = int((time.time() - t0) * 1000)
                    if d.get("tool_calls"):
                        saw_tool = True
                    if (d.get("content") or d.get("tool_calls")) and ttft_answer is None:
                        ttft_answer = int((time.time() - t0) * 1000)
        total = int((time.time() - t0) * 1000)
        return {
            "model": model,
            "ok": ttft_answer is not None,
            "ttft": ttft_answer,
            "ttft_any": ttft_any,
            "total": total,
            "tool": saw_tool,
            "finish": finish,
        }
    except BaseException as e:  # noqa: BLE001 - 基准脚本，任何异常都记成样本
        return {"model": model, "ok": False, "ttft": None,
                "total": int((time.time() - t0) * 1000), "err": _err(e)}


def _tool_call_ok(calls: list) -> bool:
    if not calls:
        return False
    for c in calls:
        if c["function"]["name"] not in TOOL_NAMES:
            return False
        try:
            json.loads(c["function"]["arguments"] or "{}")
        except json.JSONDecodeError:
            return False
    return True


def run_loop(model: str) -> dict:
    """两轮：工具调用 + 喂回结果收尾。判分看是否真的用了工具结果。"""
    t0 = time.time()
    msgs = [{"role": "system", "content": SYS}, {"role": "user", "content": ASK}]
    try:
        m1 = post(model, msgs)
        t1 = time.time()
        msg = m1["choices"][0]["message"]
        calls = msg.get("tool_calls") or []
        if not _tool_call_ok(calls):
            return {"model": model, "ok": False, "t1_ms": int((t1 - t0) * 1000),
                    "total": int((t1 - t0) * 1000), "err": f"tool_calls 不可用：{calls}"}
        msgs.append(msg)
        for c in calls:
            msgs.append({
                "role": "tool",
                "tool_call_id": c["id"],
                "content": FILE_TEXT if c["function"]["name"] == "fs_read" else TODOS,
            })
        m2 = post(model, msgs)
        t2 = time.time()
        final = (m2["choices"][0]["message"].get("content") or "").strip()
        return {
            "model": model,
            "ok": len(final) > 0,
            "t1_ms": int((t1 - t0) * 1000),
            "t2_ms": int((t2 - t1) * 1000),
            "total": int((t2 - t0) * 1000),
            "grounded": ("九点" in final) or ("周报" in final),
            "final": final[:80],
        }
    except BaseException as e:  # noqa: BLE001
        return {"model": model, "ok": False, "total": int((time.time() - t0) * 1000), "err": _err(e)}


MULTI_SYS = (
    "你是助理。必须用工具取信息，不要编造。"
    "工具结果里如果提到还有别的文件没看，必须继续读那个文件。"
    "全部读完后再用中文一两句话总结。"
)
MULTI_ASK = "把 notes 下相关的文件都看一遍，再列出未完成的待办，最后总结。"
MULTI_RESULTS = [
    "a.md：明天九点开会。",
    "b.md：周五交周报。还有 c.md 没看。",
    "待办：1. 交周报 2. 回邮件",
]


def run_multi(model: str, max_rounds: int = 5) -> dict:
    msgs = [{"role": "system", "content": MULTI_SYS}, {"role": "user", "content": MULTI_ASK}]
    t0 = time.time()
    rounds = 0
    final = ""
    try:
        for i in range(max_rounds):
            ch = post(model, msgs, max_tokens=160)["choices"][0]
            msg = ch["message"]
            calls = msg.get("tool_calls") or []
            rounds += 1
            if not calls:
                final = (msg.get("content") or "").strip()
                break
            msgs.append(msg)
            for c in calls:
                out = MULTI_RESULTS[2] if c["function"]["name"] == "task_list" else (
                    MULTI_RESULTS[min(i, len(MULTI_RESULTS) - 1)]
                )
                msgs.append({"role": "tool", "tool_call_id": c["id"], "content": out})
        total = int((time.time() - t0) * 1000)
        return {"model": model, "rounds": rounds, "total": total,
                "ok": bool(final) and (("周报" in final) or ("九点" in final)),
                "final": final[:70]}
    except BaseException as e:  # noqa: BLE001
        return {"model": model, "rounds": rounds, "ok": False,
                "total": int((time.time() - t0) * 1000), "err": _err(e)}


LIGHT_SYS = "你只回答一个词。"
LIGHT_ASK = (
    "把这封邮件归类为 urgent / normal / spam 之一，只输出分类词。\n"
    "邮件：明天九点前把漏洞排查表交回来，逾期通报。"
)
LIGHT_OPTS = ("urgent", "normal", "spam")


def run_light(model: str) -> dict:
    t0 = time.time()
    try:
        d = post(
            model,
            [{"role": "system", "content": LIGHT_SYS}, {"role": "user", "content": LIGHT_ASK}],
            tools=False,
            max_tokens=8,
        )
        ms = int((time.time() - t0) * 1000)
        txt = (d["choices"][0]["message"].get("content") or "").strip().lower()
        return {"model": model, "ms": ms, "ok": any(o in txt for o in LIGHT_OPTS), "txt": txt[:20]}
    except BaseException as e:  # noqa: BLE001
        return {"model": model, "ms": int((time.time() - t0) * 1000), "ok": False, "err": _err(e)}


SHAPES = {
    "ttft": (run_ttft, "ttft"),
    "loop": (run_loop, "total"),
    "multi": (run_multi, "total"),
    "light": (run_light, "ms"),
}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("shape", choices=sorted(SHAPES))
    ap.add_argument("--models", nargs="+", required=True)
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    if not KEY:
        print("缺 HY3_API_KEY：先 source ~/.dotd/tokens.env", file=sys.stderr)
        return 2

    fn, field = SHAPES[args.shape]
    out = Path(args.out) if args.out else HERE / f"{args.shape}-runs.jsonl"
    rows = []
    for model in args.models:
        samples = []
        for _ in range(args.runs):
            s = fn(model)
            samples.append(s)
            line = json.dumps(s, ensure_ascii=False)
            print(line, flush=True)
            with out.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
        good = [s for s in samples if s.get("ok")]
        if not good:
            rows.append({"model": model, "ok": 0, "runs": args.runs,
                         "err": samples[-1].get("err", "no ok sample") if samples else "none"})
            continue
        vals = sorted(s[field] for s in good if s.get(field) is not None)
        rows.append({
            "model": model,
            "ok": len(good),
            "runs": args.runs,
            "p50": int(statistics.median(vals)) if vals else None,
            "min": vals[0] if vals else None,
            "max": vals[-1] if vals else None,
            "extra": {k: [s.get(k) for s in good] for k in ("tool", "rounds", "grounded") if k in good[0]},
        })

    print(f"\n== {args.shape} 排序（{field}, 通过样本） ==", flush=True)
    rows.sort(key=lambda r: (r["ok"] == 0, r.get("p50") or 10**9))
    for r in rows:
        if r["ok"] == 0:
            print(f"{r['model']:<26} 全失败  {str(r.get('err'))[:80]}", flush=True)
        else:
            print(f"{r['model']:<26} p50={r['p50']:>6}ms  min={r['min']:>6}  max={r['max']:>6}  "
                  f"ok={r['ok']}/{r['runs']}  {r.get('extra') or ''}", flush=True)
    print(f"\n原始样本：{out}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
