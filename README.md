# 懂你

只有一个对话框的私人 AI 伙伴。你随便说，它在后台把你说的话整理成记忆，越聊越懂你。

打开：http://localhost:3939（开机自启，launchd：`com.mico.dongni`）

## 怎么用
- 打开页面直接打字，Enter 发送，Shift+Enter 换行；页面任何地方按键都会进输入框。
- 右上角 ✦：记忆星图。相关记忆之间有连线，鼠标移上去能看到连着什么、为什么连；点开可以改、可以删。星图右上角的人像按钮是「我眼中的你」（画像），也能直接改。
- 想让它忘掉什么，直接在对话里说「这个别记了」。

## 原理
- 每句话先写进本机 SQLite（`data/dongni.db`），再调模型；回复边生成边写库，关掉页面也会写完。没送达的消息存在浏览器里，下次打开自动补发；输入框草稿也会保存。
- 每轮聊完，后台把新对话整理成记忆（新增 / 修改旧记忆 / 删除），并和相关的旧记忆连线；每 12 句左右重写一次画像。
- 回复时带上：画像 + 相关记忆 + 最近 40 条消息 + 当前时间。
- 模型直接读 pi 的配置（`~/.pi/agent/models.json` 和 `settings.json` 的默认模型），回复时关闭思考以保证速度。
- 每天自动整库备份到 `data/backups/`，保留 30 份。删除记忆是软删除，库里留底。

## 维护
```bash
pnpm build && launchctl kickstart -k gui/$(id -u)/com.mico.dongni   # 改代码后重新上线
launchctl bootout gui/$(id -u)/com.mico.dongni                        # 停掉
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mico.dongni.plist  # 再开
tail -f logs/dongni.log                                               # 日志
```
