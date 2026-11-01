# 懂你

只有一个对话框的私人 AI 伙伴，她叫「敏」。你随便说，她在后台把你说的话整理成记忆，越聊越懂你。能打字、发语音，也能直接打电话；会画画、拍自己的日常照片、写日记、到点提醒你，还会自己改自己的代码。

全部跑在你自己的 Mac 上：聊天记录、记忆、照片都存在本机 SQLite 里，不上传任何地方（模型和语音接口除外）。

## 她能做什么

- **一个对话框**：Enter 发送，Shift+Enter 换行；页面任何地方按键都会进输入框。断网、关页面都不丢消息，下次打开自动补发。
- **越聊越懂你**：每轮聊完，后台把对话整理成记忆（新增 / 修改 / 删除），相关的记忆连成一张「记忆星图」；隔一阵重写一次「我眼中的你」。想让她忘掉什么，直接说「这个别记了」。
- **打电话**：豆包端到端实时语音当耳朵和嘴，脑子还是她自己的（同一个模型、同一份记忆、同样能动手干活）。能边听边说、能打断；通话时可以最小化成右下角的小条，照样看聊天。
- **声纹，只认你**：不用设置，电话里你说的前十来秒话会自动录成你的声纹，之后别人说话不会打断她、她也不接话。全在本机算（sherpa-onnx + 3D-Speaker CAM++）。
- **一条路**：打字、语音消息、电话里说的话是同一场对话，回复排一条队；通话时打的字也会在电话里念出来。连着说的几句会合在一起回一次，不会分开回好几段。
- **动手干活**：查你的 Mac（只读，密钥类文件一律不读）、写文件到 `~/Downloads/敏`、画图、设提醒、润色文字……左边的任务栏把她干的每件事都列出来，画好的图点开就能看。
- **她自己的小日子**：几套固定的衣服跟着天气换，每天拍一张照片进相册，写一篇日记；该说话时会主动找你。
- **自己改自己**：你让她改功能、修毛病，她会叫编码助手（[pi](https://github.com/badlogic/pi-mono)）改自己的代码，过了类型检查才提交并重启；改坏了自动退回。

## 跑起来

需要 macOS、Node.js 22、pnpm。

```bash
git clone https://github.com/mxppxm/dongni.git
cd dongni
pnpm install
```

**1. 配大模型（必需）。** 任何 OpenAI 兼容接口都行，写到 `config/llm.json`（这个目录不进仓库）：

```json
{ "baseUrl": "https://你的接口地址/v1", "apiKey": "sk-...", "model": "模型名" }
```

装了 pi 的话可以不写这个文件，会直接读 `~/.pi/agent/models.json` 和 `settings.json` 里的默认模型。

**2. 启动。**

```bash
pnpm build
pnpm start          # 打开 http://localhost:3939，电话服务在 3940（网页端口 + 1）
```

想开机自启，可以自己写一个 launchd 配置跑 `pnpm start`（工作目录设成项目目录）。

### 可选能力

| 能力 | 怎么开 | 没开会怎样 |
|---|---|---|
| 语音消息、念出来、打电话 | 豆包（火山引擎）语音的 key 写到 `~/.config/dongni/voice.json`，见下 | 录音照样能发，她会开口问你要 key；「念出来」退回 edge-tts |
| 画图、拍照、新表情 | 准备一个 gpt-image 生图脚本放到 `vendor/gptimg/scripts/gptimg.mjs`（`.env` 里写 `GPTIMG_API_KEY`） | 她会照实告诉你画不了、为什么 |
| 声纹 | 不用配，第一次用自动下载模型（28MB）到 `data/models/` | — |
| 自己改自己 | 本机装好 pi | 她会说这件事做不了 |

`~/.config/dongni/voice.json`（权限建议 600）：

```json
{ "appId": "旧版控制台的 APP ID", "accessToken": "旧版控制台的 Access Token",
  "apiKey": "新版控制台的 API Key", "speaker": "音色 ID（可省）" }
```

旧版控制台给 `appId` + `accessToken`、新版控制台给 `apiKey`，两种都认。打电话需要 `apiKey`。

## 原理

- 每句话先写进本机 SQLite（`data/dongni.db`），再调模型；回复边生成边写库，关掉页面也会写完。
- 回复时带上：人设 + 画像 + 相关记忆 + 最近 40 条消息 + 当前时间和她今天的状态。
- 所有入口（打字、语音消息、电话）共用一条回复队列；生成的每个字都广播出去，对话框显示，电话在听就念。中枢在 `lib/presence.ts`。
- 电话：页面 ⇄ 本机电话中转（藏 key、声纹把关、分句送去念）⇄ 豆包实时语音。豆包只当耳朵和嘴，它自己生成的回复不播。
- 后台定时：整理记忆、主动找你、提醒、相册和日记、每天整库备份到 `data/backups/`（留 30 份）。删除记忆是软删除，库里留底。

## 常用环境变量

| 变量 | 作用 |
|---|---|
| `DONGNI_DATA_DIR` | 数据目录，默认 `./data` |
| `DONGNI_CALL_PORT` | 电话中转端口，默认 3940（页面按「网页端口 + 1」去连） |
| `DONGNI_MODEL` / `DONGNI_CHAT_MODEL` | 换模型 / 只换聊天用的模型 |
| `DONGNI_HUMANIZE_MODEL` | 去 AI 味改写用的模型，默认 `deepseek-flash`；名字不被接口认会自动换主线模型，并在日志里说一声 |
| `DONGNI_VOICEPRINT_MIN` | 声纹及格线，默认 0.55；日志里有每句的分数 |
| `GPTIMG_MODEL` | 生图模型 |

## 维护（用 launchd 常驻时）

```bash
pnpm build && launchctl kickstart -k gui/$(id -u)/com.mico.dongni   # 改代码后重新上线
launchctl bootout gui/$(id -u)/com.mico.dongni                        # 停掉
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mico.dongni.plist  # 再开
tail -f logs/dongni.log                                               # 日志
```

`com.mico.dongni` 换成你自己 launchd 配置里的 Label。

## 隐私

`data/`、`config/`、`logs/` 都不进仓库。你的聊天记录、记忆、照片、声纹只在你自己的电脑上；发出去的只有调模型和语音接口时必要的内容。

## License

[MIT](LICENSE)
