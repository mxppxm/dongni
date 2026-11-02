#!/bin/bash
# 自我修复后重新编译、重启、体检（内核文件，自我修复不能改）。
# 编译失败或重启后体检不过，就退回修改前的版本再编译重启，保证服务一定能起来。
# 用法：scripts/rebuild.sh <修改前的 commit> [这次修复的 commit]
cd "$(dirname "$0")/.." || exit 1
GOOD="$1"
FIX="${2:-}"
LOG=logs/self-repair.log
STATUS=data/rebuild-result.json
SVC="gui/$(id -u)/com.mico.dongni"
PLIST="$HOME/Library/LaunchAgents/com.mico.dongni.plist"
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

pid_of_listener() { lsof -nP -iTCP:3939 -sTCP:LISTEN -t 2>/dev/null | head -1; }

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

# 真正把进程换成新的：认的是「3939 上的 pid 变了」，不是「谁能回 200」。
# 否则老进程还活着，体检照样通过，会假装重启成功。
restart() {
  old=$(pid_of_listener)
  log "重启：当前监听进程 ${old:-无}"
  if ! launchctl print "$SVC" >> "$LOG" 2>&1; then
    log "launchd 里没有这个服务（可能是手动起的），重新登记：$PLIST"
    if [ -n "$old" ]; then kill "$old" >> "$LOG" 2>&1; sleep 3; fi
    launchctl bootstrap "gui/$(id -u)" "$PLIST" >> "$LOG" 2>&1
  fi
  launchctl kickstart -k "$SVC" >> "$LOG" 2>&1
  for _ in $(seq 1 25); do
    sleep 1
    now=$(pid_of_listener)
    if [ -n "$now" ] && [ "$now" != "$old" ]; then
      log "新进程 $now（旧 ${old:-无}）"
      return 0
    fi
  done
  log "重启没生效：旧 ${old:-无}，现在 $(pid_of_listener)"
  return 1
}

rollback() {
  log "退回 $GOOD（原因：$1）"
  # 只撤这次修复自己的提交；别人没提交的改动先 stash 留底，别人后来的提交不动
  if [ -n "$(git status --porcelain)" ]; then
    git stash push --include-untracked -m "重启退回前留底" >> "$LOG" 2>&1
  fi
  if [ -n "$FIX" ] && [ "$(git rev-parse HEAD)" != "$FIX" ]; then
    git revert --no-edit "$FIX" >> "$LOG" 2>&1 || { git revert --abort >> "$LOG" 2>&1; log "撤销 $FIX 冲突了，需要人工看一眼"; }
  else
    git reset --hard "$GOOD" >> "$LOG" 2>&1
  fi
  pnpm build >> "$LOG" 2>&1
  echo "{\"ok\":false,\"reason\":\"$1\"}" > "$STATUS"
  restart || log "退回后重启也没换成功，需要人工看一眼"
}

log "==== rebuild (good=$GOOD)"
sleep 1
if ! pnpm build >> "$LOG" 2>&1; then
  rollback build
  exit 0
fi
rm -f "$STATUS"
if ! restart; then
  rollback restart
  exit 0
fi
if healthy; then
  # 新进程已经起来了，通过这个请求让它在对话里报告结果
  echo '{"ok":true}' > "$STATUS"
  curl -s --max-time 10 -X POST http://127.0.0.1:3939/api/health >/dev/null
else
  rollback health
fi
