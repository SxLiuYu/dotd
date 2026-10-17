#!/bin/bash
# Fleet prep: copy dotd into WSL (native fs, not /mnt/c), install deps, verify node:sqlite.
# 2026-10-16 增补：exec-image/（Dockerfile）与 package-lock.json（可复现安装）。
set -u
SRC="/mnt/c/Users/1/Documents/研究/toagi/dotd"
DST="$HOME/dotd"
echo "== node:sqlite check =="
node -e "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(':memory:'); db.exec('CREATE TABLE t(x)'); console.log('SQLITE_OK')" 2>&1 | tail -1

echo "== copying repo (excluding node_modules) =="
mkdir -p "$DST"
for item in src db tests config scripts agent-runtime exec-image package.json package-lock.json tsconfig.json web-ui; do
  [ -e "$SRC/$item" ] || continue
  if [ -d "$SRC/$item" ]; then
    rsync -a --exclude node_modules --delete "$SRC/$item/" "$DST/$item/"
  else
    cp -f "$SRC/$item" "$DST/"
  fi
done
ls "$DST" | tr '\n' ' '; echo

echo "== npm install (this needs registry access) =="
cd "$DST" && npm install --no-audit --no-fund 2>&1 | tail -3

echo "== tar-stream present (dockerode transitive)? =="
node -e "console.log('TARSTREAM_' + require('tar-stream/package.json').version)" 2>&1 | tail -1

echo "== tsx smoke =="
node --import tsx -e "console.log('TSX_OK')" 2>&1 | tail -1
