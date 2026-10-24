#!/usr/bin/env python3
"""下载 SenseVoice 本地 ASR 模型（237MB）。

用法:
    python scripts/download-models.py              # 默认 models/sense-voice/
    python scripts/download-models.py ./my-models  # 自定义路径
"""
import os
import sys
import tarfile
import tempfile
import urllib.request
import logging

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("models")

URL = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2"


def main():
    model_dir = sys.argv[1] if len(sys.argv) > 1 else "models/sense-voice"
    model_file = os.path.join(model_dir, "model.int8.onnx")
    tokens_file = os.path.join(model_dir, "tokens.txt")

    if os.path.exists(model_file) and os.path.exists(tokens_file):
        log.info(f"模型已存在: {model_file}")
        return

    os.makedirs(model_dir, exist_ok=True)
    log.info(f"下载 SenseVoice 模型 (237MB) from {URL} ...")

    tmp = tempfile.mkdtemp()
    try:
        archive = os.path.join(tmp, "model.tar.bz2")
        urllib.request.urlretrieve(URL, archive)
        log.info("解压中...")
        with tarfile.open(archive, "r:bz2") as tf:
            # release 包含一个子目录，平铺到 model_dir
            for member in tf.getmembers():
                # 去掉顶层目录前缀，直接提取到 model_dir
                member.name = os.path.basename(member.name)
                tf.extract(member, model_dir)
        if os.path.exists(model_file):
            size_mb = os.path.getsize(model_file) / 1_048_576
            log.info(f"✅ 下载完成: {model_file} ({size_mb:.1f}MB)")
            log.info("   SenseVoice 本地 ASR 已就绪（26ms vs 百度 327ms）")
        else:
            log.error("❌ 错误: 下载完成但模型文件未找到")
            sys.exit(1)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
