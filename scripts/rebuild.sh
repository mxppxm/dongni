#!/bin/bash
# 自我修复后重新编译、重启、体检（内核文件，自我修复不能改）。
# 编译失败或重启后体检不过，就退回修改前的版本再编译重启，保证服务一定能起来。
# 用法：scripts/rebuild.sh <修改前的 commit>
cd "$(dirname "$0")/.." || exit 1
GOOD="$1"
LOG=logs/self-repair.log
STATUS=data/rebuild-result.json
SVC="gui/$(id -u)/com.mico.dongni"
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

healthy() {
  for _ in $(seq 1 30); do
    sleep 2
    home=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3939/)
    health=$(curl -s --max-time 60 http://127.0.0.1:3939/api/health)
    if [ "$home" = "200" ] && echo "$health" | grep -q '"ok":true'; then
      log "体检通过：$health"
      return 0
    fi
  done
  log "体检没过：home=$home health=$health"
  return 1
}

rollback() {
  log "退回 $GOOD（原因：$1）"
  git reset --hard "$GOOD" >> "$LOG" 2>&1
  pnpm build >> "$LOG" 2>&1
  echo "{\"ok\":false,\"reason\":\"$1\"}" > "$STATUS"
  launchctl kickstart -k "$SVC" >> "$LOG" 2>&1
}

log "==== rebuild (good=$GOOD)"
sleep 1
if ! pnpm build >> "$LOG" 2>&1; then
  rollback build
  exit 0
fi
rm -f "$STATUS"
launchctl kickstart -k "$SVC" >> "$LOG" 2>&1
if healthy; then
  # 新进程已经起来了，通过这个请求让它在对话里报告结果
  echo '{"ok":true}' > "$STATUS"
  curl -s --max-time 10 -X POST http://127.0.0.1:3939/api/health >/dev/null
else
  rollback health
fi
