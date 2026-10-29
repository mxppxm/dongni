#!/bin/bash
# 停掉敏、取消开机自启。她的文件（含聊天记录）还留在 ~/dongni，想彻底删就手动删这个文件夹。
LABEL="${DONGNI_LABEL:-com.mico.dongni}"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "已停止。她的文件还在 ${DONGNI_HOME:-$HOME/dongni}"
