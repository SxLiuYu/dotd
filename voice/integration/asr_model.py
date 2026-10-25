"""voice/integration/asr_model.py —— SenseVoice 权重的多源下载（2026-10-25）。

## 为什么不能直接用上游脚本

`voice/charlie/scripts/download-models.{py,sh}` 只有一个来源：
`github.com/k2-fsa/sherpa-onnx/releases/...`。2026-10-25 在国内网络实测：

    curl -r 0-1048576 <github release>   → 20s 超时，0 字节
    https://hf-mirror.com/.../model.int8.onnx → 206，1.2 MB/s
    https://huggingface.co/...           → 超时

也就是说"自动下载"在原产地网络里是**必然失败**的，而失败只写进一个后台日志，
用户看到的现象就是"容器起来了但听不见"。上游文件按 `voice/VENDOR.md` 不改，
所以多源逻辑放这里，entrypoint 调本模块。

## 顺序

1. GitHub release 的 tar.bz2（上游原路径，海外机器最快，还带 tokens.txt）；
2. hf-mirror 的两个文件（国内可达）；
3. `SENSE_VOICE_MIRROR` 指定的目录（自建镜像/内网文件服务），文件名为
   `model.int8.onnx` 与 `tokens.txt`。

任一来源成功即返回。落盘走 `.part` 临时文件 + `os.replace`，中断不会留下半截
`model.int8.onnx`（那比没有更糟：ASR 会拿它去初始化然后报"加载失败"）。

## 用法

    python -m voice.integration.asr_model <model_dir>   # 装到指定目录
    python -m voice.integration.asr_model --check <dir>  # 只检查是否就绪

退出码：0 = 就绪；1 = 所有来源都失败。
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

MODEL_FILE = "model.int8.onnx"
TOKENS_FILE = "tokens.txt"

GITHUB_TARBALL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
    "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2"
)
HF_MIRROR_BASE = (
    "https://hf-mirror.com/csukuangfj/"
    "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09/resolve/main"
)

# 完整模型 237MB；给足余量但仍能识别"下了一半就被掐断"。
MIN_MODEL_BYTES = 100 * 1024 * 1024


def ready(model_dir: Path) -> bool:
    """两个必需文件都在（且模型不是半截文件）才算就绪。"""
    model = Path(model_dir) / MODEL_FILE
    tokens = Path(model_dir) / TOKENS_FILE
    if not (model.is_file() and tokens.is_file()):
        return False
    return model.stat().st_size >= MIN_MODEL_BYTES


def _download(url: str, dest: Path, *, timeout: float = 60.0) -> None:
    """下载到 `dest.part` 再原子改名；失败不留残片。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "dotd-asr/1.0"})
        with urllib.request.urlopen(req, timeout=timeout) as resp, part.open("wb") as fh:
            shutil.copyfileobj(resp, fh, 1024 * 256)
        if part.stat().st_size == 0:
            raise OSError("下载到 0 字节")
        os.replace(part, dest)
    finally:
        if part.exists():
            part.unlink(missing_ok=True)


def _from_tarball(model_dir: Path) -> bool:
    tmp = Path(tempfile.mkdtemp(prefix="sensevoice-"))
    try:
        archive = tmp / "model.tar.bz2"
        _download(GITHUB_TARBALL, archive)
        with tarfile.open(archive, "r:bz2") as tf:
            for member in tf.getmembers():
                # release 带一层子目录；平铺，和上游脚本一致。
                name = os.path.basename(member.name)
                if name not in (MODEL_FILE, TOKENS_FILE):
                    continue
                member.name = name
                try:
                    tf.extract(member, model_dir, filter="data")
                except TypeError:  # Python < 3.11.4 没有 filter 参数
                    tf.extract(member, model_dir)
        return ready(model_dir)
    except Exception as exc:  # 网络/解包都可能失败，交给下一个来源
        print(f"[asr-model] GitHub 打包下载失败：{exc}", file=sys.stderr)
        return False
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _from_mirror(base: str, model_dir: Path) -> bool:
    base = base.rstrip("/")
    try:
        for name in (MODEL_FILE, TOKENS_FILE):
            _download(f"{base}/{name}", model_dir / name)
        return ready(model_dir)
    except Exception as exc:
        print(f"[asr-model] 镜像 {base} 下载失败：{exc}", file=sys.stderr)
        return False


def sources() -> list[tuple[str, str]]:
    """按顺序返回 (描述, 位置)。`SENSE_VOICE_MIRROR` 排最前（自建/内网优先）。"""
    out: list[tuple[str, str]] = []
    custom = (os.environ.get("SENSE_VOICE_MIRROR") or "").strip()
    if custom:
        out.append(("自定义镜像", custom))
    out.append(("GitHub release", GITHUB_TARBALL))
    out.append(("hf-mirror", HF_MIRROR_BASE))
    return out


def ensure(
    model_dir: Path,
    *,
    retries: int = 2,
    backoff: float = 5.0,
    log=print,
) -> bool:
    """把模型装到 `model_dir`；就绪返回 True。"""
    model_dir = Path(model_dir)
    if ready(model_dir):
        log(f"[asr-model] 已就绪：{model_dir}")
        return True

    for attempt in range(1, retries + 1):
        for label, location in sources():
            log(f"[asr-model] 尝试 {label}（第 {attempt}/{retries} 轮）…")
            if label == "GitHub release":
                ok = _from_tarball(model_dir)
            else:
                ok = _from_mirror(location, model_dir)
            if ok:
                size_mb = (model_dir / MODEL_FILE).stat().st_size / 1_048_576
                log(f"[asr-model] ✅ 就绪（{label}，{size_mb:.0f}MB）：{model_dir}")
                return True
        if attempt < retries:
            time.sleep(backoff)
    log(
        "[asr-model] ❌ 所有来源都失败。手动下载 model.int8.onnx / tokens.txt 放到 "
        f"{model_dir}，或设 SENSE_VOICE_MIRROR 指向内网文件服务。",
        file=sys.stderr,
    )
    return False


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="下载 SenseVoice 本地 ASR 模型（237MB）")
    parser.add_argument("model_dir", nargs="?", default="models/sense-voice")
    parser.add_argument(
        "--check",
        action="store_true",
        help="只检查是否就绪（不下载）",
    )
    parser.add_argument("--retries", type=int, default=2)
    args = parser.parse_args(argv)

    target = Path(args.model_dir)
    if args.check:
        ok = ready(target)
        print(("就绪" if ok else "缺失") + f"：{target}")
        return 0 if ok else 1
    return 0 if ensure(target, retries=args.retries) else 1


if __name__ == "__main__":
    raise SystemExit(main())
