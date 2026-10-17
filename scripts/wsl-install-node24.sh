#!/bin/bash
# Install Node 24 in WSL (dotd fleet prerequisite). Idempotent: skips if already >=22.
set -u
CUR=$(node --version 2>/dev/null || echo none)
MAJOR=$(echo "$CUR" | sed 's/v\([0-9]*\).*/\1/')
if [ -n "$MAJOR" ] && [ "$MAJOR" -ge 24 ] 2>/dev/null; then
  echo "ALREADY_OK $CUR"
  exit 0
fi
echo "installing Node 24 (current: $CUR)"
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup || { echo "NODESOURCE_FETCH_FAIL"; exit 1; }
bash /tmp/nodesource_setup || { echo "NODESOURCE_SETUP_FAIL"; exit 1; }
DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs || { echo "APT_FAIL"; exit 1; }
node --version
npm --version
