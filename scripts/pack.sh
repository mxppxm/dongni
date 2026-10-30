#!/bin/bash
# 把敏整个打包成一个能在别的 Mac 上一键安装的 zip（含聊天记录、记忆、照片、所有 key）。
# 用法：scripts/pack.sh [输出目录]
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-$HOME/mycode/dongni-dist}"
STAMP="$(date +%Y%m%d-%H%M)"
DIR="$OUT/敏-$STAMP"
APP="$DIR/app"
rm -rf "$DIR"; mkdir -p "$APP"

# 代码：已提交的文件
git ls-files -z | rsync -a --from0 --files-from=- ./ "$APP/"

# 数据：数据库做一份一致的快照，照片/衣橱/样子/提醒原样带上（音频缓存会自己重新生成，不带）
mkdir -p "$APP/data"
sqlite3 data/dongni.db ".backup '$APP/data/dongni.db'"
for d in images wardrobe moods; do [ -d "data/$d" ] && rsync -a "data/$d" "$APP/data/"; done
[ -f data/reminders.json ] && cp data/reminders.json "$APP/data/"
[ -f data/voiceprint.json ] && cp data/voiceprint.json "$APP/data/"

# 大模型线路：从 pi 的配置里导出（新电脑不用装 pi）
mkdir -p "$APP/config"
python3 - "$APP/config/llm.json" <<'PY'
import json,os,sys
d=os.path.expanduser('~/.pi/agent')
m=json.load(open(f'{d}/models.json'));s=json.load(open(f'{d}/settings.json'))
p=m['providers'][s['defaultProvider']]
json.dump({'baseUrl':p['baseUrl'],'apiKey':p['apiKey'],'model':s['defaultModel']},open(sys.argv[1],'w'),indent=2)
PY
# 声音（豆包）
cp "$HOME/.config/dongni/voice.json" "$APP/config/voice.json"
# 生图脚本和它的 key
mkdir -p "$APP/vendor/gptimg"
rsync -a ~/.agents/skills/gptimg/ "$APP/vendor/gptimg/"
chmod 600 "$APP/config/"*.json "$APP/vendor/gptimg/.env"

cp scripts/install.command "$DIR/安装.command"
cp scripts/uninstall.command "$DIR/卸载.command"
chmod +x "$DIR/"*.command
cat > "$DIR/使用说明.txt" <<'TXT'
敏 · 换电脑直接用

1. 解压这个 zip。
2. 双击「安装.command」。
   如果提示「无法打开，因为来自身份不明的开发者」：右键点它 → 打开 → 打开。
   或者打开「终端」，把「安装.command」拖进去，回车。
3. 等它跑完（第一次要下载 Node 和依赖，几分钟），浏览器会自动打开 http://localhost:3939

装好以后：
- 开机自动启动，随时打开 http://localhost:3939 就能找她。
- 聊天记录、记忆、相册、衣橱、她的样子都带过来了。
- 声音（豆包）、画图、大模型的 key 都已经配好，不用再填。
- 打电话、语音、画图、查电脑都能用。第一次打电话浏览器会问麦克风权限，点允许。
- 查电脑时 macOS 可能弹窗问能不能访问「下载」「桌面」等文件夹，点允许。

她装在 ~/dongni。想停掉：双击「卸载.command」（文件留着，想彻底删就删 ~/dongni）。
注意：这个包里有所有 key，别发给别人。
TXT
( cd "$OUT" && ditto -c -k --keepParent "敏-$STAMP" "敏-$STAMP.zip" )
echo "$OUT/敏-$STAMP.zip"
