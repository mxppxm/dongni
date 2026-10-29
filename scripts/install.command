#!/bin/bash
# 敏 · 一键安装（macOS）。双击运行；被系统拦下时：右键 → 打开。
# 会把她装到 ~/dongni，自带 Node，不用你另外装任何东西；装完开机自启，浏览器打开就能聊。
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)/app"
DEST="${DONGNI_HOME:-$HOME/dongni}"
PORT="${DONGNI_PORT:-3939}"
CALL_PORT=$((PORT + 1))
LABEL="${DONGNI_LABEL:-com.mico.dongni}"
step() { printf "\n\033[1;35m▶ %s\033[0m\n" "$*"; }
[ "$(uname)" = "Darwin" ] || { echo "只支持 macOS"; exit 1; }
[ -d "$SRC" ] || { echo "找不到 app 目录，请在解压后的文件夹里运行"; exit 1; }

step "1/6 复制文件到 $DEST"
KEEP=""
[ -f "$DEST/data/dongni.db" ] && KEEP=1
mkdir -p "$DEST"
rsync -a --exclude data --exclude node_modules --exclude .next --exclude runtime "$SRC/" "$DEST/"
if [ -z "$KEEP" ]; then rsync -a "$SRC/data/" "$DEST/data/"; else echo "  这里已经装过，聊天记录和记忆保留不动"; fi
mkdir -p "$DEST/logs"

step "2/6 准备 Node.js（自带一份，不影响系统）"
NODE_DIR="$DEST/runtime/node"
if [ ! -x "$NODE_DIR/bin/node" ]; then
  ARCH="$(uname -m)"; [ "$ARCH" = "arm64" ] && NA=arm64 || NA=x64
  TAR="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk -v a="darwin-$NA.tar.gz" '$2 ~ a {print $2; exit}')"
  [ -n "$TAR" ] || { echo "下载 Node 失败，请检查网络后重试"; exit 1; }
  mkdir -p "$NODE_DIR"
  curl -fSL --progress-bar "https://nodejs.org/dist/latest-v22.x/$TAR" | tar -xz -C "$NODE_DIR" --strip-components 1
fi
export PATH="$NODE_DIR/bin:$PATH"
echo "  Node $(node -v)"

step "3/6 安装依赖（第一次要几分钟）"
cd "$DEST"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 npm_config_yes=true
npx --yes pnpm@9.15.4 install --frozen-lockfile

step "4/6 编译"
npx --yes pnpm@9.15.4 build

step "5/6 设置开机自启"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"
chmod 600 "$DEST/config/"*.json "$DEST/vendor/gptimg/.env" 2>/dev/null || true
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_DIR/bin/node</string>
    <string>$DEST/node_modules/next/dist/bin/next</string>
    <string>start</string><string>-p</string><string>$PORT</string><string>-H</string><string>127.0.0.1</string>
  </array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>PATH</key><string>$NODE_DIR/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>DONGNI_VOICE_CONFIG</key><string>$DEST/config/voice.json</string>
    <key>DONGNI_CALL_PORT</key><string>$CALL_PORT</string>
    <key>GPTIMG_MODEL</key><string>gpt-image-2.5</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DEST/logs/dongni.log</string>
  <key>StandardErrorPath</key><string>$DEST/logs/dongni.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

step "6/6 启动"
for _ in $(seq 1 90); do curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 1; done
if curl -fs -o /dev/null "http://127.0.0.1:$PORT/"; then
  printf "\n\033[1;32m✓ 装好了：http://localhost:%s\033[0m\n" "$PORT"
  [ -n "${DONGNI_NO_OPEN:-}" ] || open "http://localhost:$PORT"
else
  echo "没起来，看看日志：$DEST/logs/dongni.log"; exit 1
fi
