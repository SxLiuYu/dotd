#!/usr/bin/env bash
# 下载 SenseVoice 本地 ASR 模型（237MB，用于 26ms 本地 ASR）
# 用法: bash download-models.sh [model_dir]
set -euo pipefail

MODEL_DIR="${1:-models/sense-voice}"
MODEL_FILE="$MODEL_DIR/model.int8.onnx"
TOKENS_FILE="$MODEL_DIR/tokens.txt"
URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2"

if [ -f "$MODEL_FILE" ] && [ -f "$TOKENS_FILE" ]; then
  echo "模型已存在: $MODEL_FILE"
  exit 0
fi

mkdir -p "$MODEL_DIR"
echo "下载 SenseVoice 模型 (237MB) from $URL ..."
TMP=$(mktemp -d)
trap "rm -rf $TMP" EXIT

curl -L --progress-bar -o "$TMP/model.tar.bz2" "$URL"

echo "解压..."
# release 包含一个子目录，--strip-components=1 平铺到 MODEL_DIR
tar -xjf "$TMP/model.tar.bz2" -C "$MODEL_DIR" --strip-components=1 2>/dev/null || \
  tar -xjf "$TMP/model.tar.bz2" -C "$MODEL_DIR" 2>/dev/null || \
  (echo "解压失败" >&2; exit 1)

if [ -f "$MODEL_FILE" ]; then
  echo "✅ 下载完成: $MODEL_FILE ($(du -h "$MODEL_FILE" | cut -f1))"
  echo "   SenseVoice 本地 ASR 已就绪（26ms vs 百度 327ms）"
else
  echo "❌ 错误: 下载完成但模型文件未找到: $MODEL_FILE" >&2
  exit 1
fi
