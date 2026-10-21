# dotd 执行容器镜像（设计 §9.5 草案落地；单镜像全局唯一，身份差异全在卷里）
#
# 构建上下文由宿主 daemon 内存 tar 流提供（本文件 + agent-runtime/，不落盘）：
# 上下文根 = dotd 仓库根，tar 条目为 Dockerfile（源 exec-image/）与 agent-runtime/**。
#
# ── 基座：node:24-slim（2026-10-21 从 playwright 基座换下来）────────────────
# 原基座是 mcr.microsoft.com/playwright:v1.49.1-noble——3.47GB，其中 2.16GB 是
# chromium/firefox/webkit/ffmpeg。容器内 playwright 实现删掉之后（browser.* 全部
# 移到宿主 agent-browser），这些浏览器一个都用不上，纯占磁盘和拉取时间。
# 实测：3.55GB → 约 300MB。
#
# 换基座要保住的三件事（都实测过，不是照抄旧注释）：
#   1. Node 版本：agent-runtime 的 engines 要求 >=24，node:24-slim 是 v24.22.0 ✓
#   2. shell.run 日常要用的命令：slim 只有 node/bash/sh，git / python3 / pdftotext
#      全缺 —— 显式补上（原来是 playwright 基座顺带给的，属于"白捡"，换基座就没了）
#   3. uid 1000/1001：playwright 基座自带 ubuntu(1000)/pwuser(1001) 需要 userdel
#      腾位；node:24-slim 自带的是 node(1000)，同样要腾，但只有一个
#
# Xvfb 不再需要：它只服务于 headed chromium，浏览器已经不在容器里了。
FROM node:24-slim

# poppler-utils：pdftotext / pdfinfo —— **PDF 是最常见的文档格式**，没有它就读不了
#   PDF（2026-10-19 实测：PyPDF2/pypdf 也都没有）。约 10MB，比装 python 库轻得多，
#   且 pdftotext 的文本质量更好。
# git / python3：shell.run 的日常工具（拉仓库、跑脚本）。原来由 playwright 基座提供。
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends bash poppler-utils git python3 \
    && rm -rf /var/lib/apt/lists/*

# agent-runtime 源码由宿主 daemon 打包进构建上下文（§3.2）
COPY agent-runtime/ /opt/agent-runtime/
# tsc 属 devDependency：两阶段处理，先带 dev 编译再 prune。
# --ignore-scripts：postinstall 在构建容器里只会拖慢构建（原来是为了防 playwright
# 下浏览器）；依赖已无 postinstall，保留这个标志是习惯也是保险。
RUN cd /opt/agent-runtime \
    && npm ci --include=dev --ignore-scripts \
    && ./node_modules/.bin/tsc -p . \
    && npm prune --omit=dev

# 非 root 运行 + 显式预建挂载点并 chown——否则 Docker 以 root 建卷挂载点，
# 容器内 USER dot(1000) 无法写 home/profiles/state（笔记/ledger/token 全失败）
# shell 子进程专用 uid 1001（§9.6 秘密隔离；依赖 CapAdd SETUID，开放问题 Q7）
#
# 基座差异（2026-10-21）：node:24-slim 自带 node:x:1000:1000，只删这一个就能腾出
# 契约要求的 uid 1000；不再需要处理 ubuntu/pwuser。
# gid 1000 组随 userdel 保留（userdel 不删仍被文件引用的组）。
RUN userdel -r node 2>/dev/null || true \
    && useradd -m -u 1000 dot \
    && useradd -M -u 1001 shell \
    && mkdir -p /dot/home /dot/profiles /opt/agent-state /run/dotd \
    && chown -R dot:dot /dot && chown dot:dot /opt/agent-state /run/dotd && chmod 700 /opt/agent-state \
    && chown -R dot:dot /opt/agent-runtime
USER dot
ENV HOME=/dot/home
# **注释必须单独成行**（2026-10-19 实测）：JSON 数组形式的指令后面跟 # 注释时
# docker 会把注释按空格拆开**当成数组元素** —— 这里原本是
#   VOLUME ["/dot/home", "/dot/profiles"]     # state 卷与 token bind 在容器创建参数里挂
# 结果镜像声明了 8 个卷：2 个正确的 + "#"、"/dot/profiles]"、"[/dot/home,"、"bind"、
# "state"、"token"、"卷与"、"在容器创建参数里挂" 这 6 个垃圾路径。
# 后果：每次创建容器都白建 8 个匿名卷（实测累积到 168 个），且容器里多出
# /dot/profiles]、/dot/home, 这类畸形目录。
VOLUME ["/dot/home", "/dot/profiles"]
EXPOSE 9223
ENTRYPOINT ["node", "/opt/agent-runtime/dist/server.js"]
