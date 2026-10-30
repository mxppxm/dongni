#!/bin/bash
# 把当前代码同步到 GitHub 开源仓库。
# 只推代码快照、接在开源仓库自己的历史后面，不带本机的提交历史（本机的「自我修复」提交里有聊天细节）。
# 用法：scripts/publish.sh ["这次更新的说明"]   不写说明就用本机最新一条提交的标题
set -euo pipefail
cd "$(dirname "$0")/.."
REMOTE="${DONGNI_PUBLIC_REMOTE:-github}"
NAME="${DONGNI_PUBLIC_NAME:-mxppxm}"
EMAIL="${DONGNI_PUBLIC_EMAIL:-42698364+mxppxm@users.noreply.github.com}"
MSG="${1:-$(git log -1 --format=%s)}"

[ -z "$(git status --porcelain)" ] || { echo "还有没提交的改动，先在本机提交再同步"; exit 1; }
TREE="$(git rev-parse 'HEAD^{tree}')"
PARENT=""
if git fetch -q "$REMOTE" main 2>/dev/null; then PARENT="$(git rev-parse "$REMOTE/main")"; fi
if [ -n "$PARENT" ] && [ "$(git rev-parse "$PARENT^{tree}")" = "$TREE" ]; then echo "开源仓库已经是最新的"; exit 0; fi

COMMIT="$(GIT_AUTHOR_NAME="$NAME" GIT_AUTHOR_EMAIL="$EMAIL" GIT_COMMITTER_NAME="$NAME" GIT_COMMITTER_EMAIL="$EMAIL" \
  git commit-tree "$TREE" ${PARENT:+-p "$PARENT"} -m "$MSG")"
git push -q "$REMOTE" "$COMMIT:refs/heads/main"
echo "已同步：$(git remote get-url "$REMOTE") @ ${COMMIT:0:7}"
