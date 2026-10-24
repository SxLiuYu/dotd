# 06 — SenseVoice 模型下载脚本

**What to build:** 跑 scripts/download-models.sh 从 GitHub release 下载 237MB SenseVoice 模型到 models/sense-voice/；setup 页面加"下载本地 ASR 模型"按钮触发下载。用户无需手动找 release 链接解压。

**Blocked by:** None — 可立即开始

**Status:** ready-for-agent

- [x] 新建 scripts/download-models.sh：检测 models/sense-voice/model.int8.onnx 不存在则 curl 下载 + tar 解压
- [x] 下载源: https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09.tar.bz2
- [x] setup 页面加 POST /api/setup/download-model 触发下载（后台线程）
- [x] 下载进度通过 /api/setup/download-status 查询
- [x] 脚本跑完 models/sense-voice/model.int8.onnx + tokens.txt 存在
