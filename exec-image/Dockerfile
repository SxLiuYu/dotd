# dotd 执行容器镜像（设计 §9.5 草案落地；单镜像全局唯一，身份差异全在卷里）
#
# 构建上下文由宿主 daemon 内存 tar 流提供（本文件 + agent-runtime/，不落盘）：
# 上下文根 = dotd 仓库根，tar 条目为 Dockerfile（源 exec-image/）与 agent-runtime/**。
# 基座 tag 与宿主 cfg.pwVersion 双版本锁定：改动需与 agent-runtime 的 playwright 严格同版本。
ARG PW_VERSION=1.49.1
FROM mcr.microsoft.com/playwright:v${PW_VERSION}-noble

# headed 模式依赖：官方镜像不自带 Xvfb（agent-runtime 启动时自行 spawn :99，非 init 进程）
# poppler-utils：pdftotext / pdfinfo —— **PDF 是最常见的文档格式**，容器里原本只有 python，
#   没有它就读不了 PDF（2026-10-19 实测：PyPDF2/pypdf 也都没有）。装 poppler 比装 python 库
#   轻得多（约 10MB），且 pdftotext 的文本质量更好。
USER root
RUN apt-get update && apt-get install -y --no-install-recommends xvfb bash poppler-utils \
    && rm -rf /var/lib/apt/lists/*

# agent-runtime 源码由宿主 daemon 打包进构建上下文（§3.2）
COPY agent-runtime/ /opt/agent-runtime/
# tsc 属 devDependency：两阶段处理，先带 dev 编译再 prune。
# --ignore-scripts：postinstall（playwright 浏览器下载/自启）在构建容器里只会撞
# PLAYWRIGHT_BROWSERS_PATH 权限并拖慢构建；浏览器由基座镜像自带，无需再下。
RUN cd /opt/agent-runtime \
    && npm ci --include=dev --ignore-scripts \
    && ./node_modules/.bin/tsc -p . \
    && npm prune --omit=dev

# 非 root 运行 + 显式预建挂载点并 chown——否则 Docker 以 root 建卷挂载点，
# 容器内 USER dot(1000) 无法写 home/profiles/state（笔记/ledger/token 全失败）
# shell 子进程专用 uid 1001（§9.6 秘密隔离；依赖 CapAdd SETUID，开放问题 Q7）
# 基座镜像自带 ubuntu:x:1000:1000 和 pwuser:x:1001:1001（§7.1 实测）——
# 两个都删掉，腾出契约要求的 uid 1000/1001。
# gid 1000/1001 组随 userdel 保留（userdel 不删仍被文件引用的组）；/ms-playwright 是
# root:root 0777，dot 天然可读写执行，无需任何补充组成员身份。
RUN userdel -r ubuntu 2>/dev/null || true \
    && userdel -r pwuser 2>/dev/null || true \
    && useradd -m -u 1000 dot \
    && useradd -M -u 1001 shell \
    && mkdir -p /dot/home /dot/profiles /opt/agent-state /run/dotd \
    && chown -R dot:dot /dot && chown dot:dot /opt/agent-state /run/dotd && chmod 700 /opt/agent-state \
    && chown -R dot:dot /opt/agent-runtime
USER dot
# 不覆盖 PLAYWRIGHT_BROWSERS_PATH：基座已设 /ms-playwright 且浏览器就位（实测），
# 指去空目录会让 chromium 查找扑空。
ENV HOME=/dot/home DISPLAY=:99
VOLUME ["/dot/home", "/dot/profiles"]     # state 卷与 token bind 在容器创建参数里挂
EXPOSE 9223
ENTRYPOINT ["node", "/opt/agent-runtime/dist/server.js"]
