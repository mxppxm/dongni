#!/bin/bash
# 自我修复后重新编译并重启。编译失败就退回修改前的版本再编译，保证服务一定能起来。
# 用法：scripts/rebuild.sh <修改前的 commit>
cd "$(dirname "$0")/.." || exit 1
GOOD="$1"
LOG=logs/self-repair.log
STATUS=data/rebuild-result.json
echo "==== $(date '+%F %T') rebuild (good=$GOOD)" >> "$LOG"
sleep 1
if pnpm build >> "$LOG" 2>&1; then
  echo '{"ok":true}' > "$STATUS"
else
  echo "build 失败，退回 $GOOD" >> "$LOG"
  git reset --hard "$GOOD" >> "$LOG" 2>&1
  pnpm build >> "$LOG" 2>&1
  echo '{"ok":false}' > "$STATUS"
fi
launchctl kickstart -k "gui/$(id -u)/com.mico.dongni" >> "$LOG" 2>&1
