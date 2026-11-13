# 在懂你中使用 Superagent

这个目录保存了本机实际使用的 dsh-superagent 源码快照，包含本地收件箱 Source、管理脚本和测试。来源提交为 `2ba696609d75ec47277d73948b879f85bfb9e014`。原项目采用 MIT 许可，版权和许可见 [LICENSE](LICENSE)，原项目介绍见 [README.md](README.md)。

这里只收录源码，不包含 Git 历史、依赖、编译产物、运行记录和个人配置。DeepSeek Harness 本体需要单独安装。以下命令面向 macOS 的新安装；已有 SA 安装请保留现有 profile，并参考原项目[升级说明](docs/006-deployment.md#upgrade)。本文尚未经过全新机器的完整运行验收。

## 1. 准备依赖和 GitHub 账户

需要 Node.js 22.19+ 或 24+、git 2.32+、Python 3.8+、tmux 和 GitHub CLI 2.48+。懂你使用 pnpm 9.15.4；SA 的 `package.json` 指定 pnpm 11.7.0，下面通过 `npx` 单独使用该版本，不改变全局 pnpm。

已安装 Homebrew 的机器可以安装缺少的工具：

```sh
brew install gh tmux
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
```

Harness 版本沿用原项目部署说明中的固定版本，依赖约束见 [package.json](package.json)。

**当前 SA 的启动检查始终要求 GitHub 仓库和账户，即使只使用本地收件箱也不能省略。** 准备一个 SA 账户有写权限的 GitHub 仓库，例如自己的懂你 fork；只读克隆 `mxppxm/dongni` 不代表获得该仓库的写权限。

建议为 SA 使用独立 GitHub 账户和 CLI 配置。建立包装脚本并在本机终端登录：

```sh
mkdir -p "$HOME/.local/bin"
cat > "$HOME/.local/bin/gh-agent" <<'EOF'
#!/bin/sh
GH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"
EOF
chmod +x "$HOME/.local/bin/gh-agent"
"$HOME/.local/bin/gh-agent" auth login
"$HOME/.local/bin/gh-agent" api user --jq .login
```

登录账户需要对目标仓库有写权限。后面在 SA 面板填写包装脚本的绝对路径，例如 `/Users/你的用户名/.local/bin/gh-agent`。不要在文档、提交或聊天中填写 GitHub token。

## 2. 构建 SA 并创建 Harness profile

从懂你根目录执行：

```sh
cd vendor/dsh-superagent
npx --yes pnpm@11.7.0 install --frozen-lockfile
npx --yes pnpm@11.7.0 build
```

接下来仅供**尚未创建 `superagent` profile 的新安装**执行，工作目录仍是 `vendor/dsh-superagent`：

```sh
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"
```

已有 profile 时不要执行 `--from-default-profile`，它会替换已有 profile 并删除其中的 `cordis.patch.yml`。懂你根目录安装依赖不会替 SA 安装依赖，二者也不共用构建产物。

## 3. 配置面板和本地收件箱

编辑 `~/.dsh/profiles/superagent/cordis.patch.yml`。新 profile 可用下面的完整配置，替换 `stateDir` 为本机绝对路径；YAML 中不要写 `~` 或 `$HOME`：

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3082
- id: dsh-superagent
  config:
    stateDir: /Users/你的用户名/.dsh/state/superagent
- id: dsh-superagent-local
  disabled: false
```

已有 profile 时合并这些条目，不要覆盖其他配置。以上路径假定使用默认 `~/.dsh`；懂你的适配器也按该位置读取会话和环境文件，这份说明不覆盖自定义 `DSH_HOME` 的安装。

## 4. 配置 Harness 的模型并启动 SA

懂你的模型从 `config/llm.json` 读取，Harness 使用自己的模型供应商和默认模型配置，两者不会自动同步。在 Harness 的模型设置中配置自己的接口地址、凭据、模型，并确认 `superagent` profile 使用该模型。SA 面板中的 Eval 和 Execution 如果单独指定模型，也要选择已配置的模型。

如果供应商通过环境变量读取密钥，在本机终端加载所需变量后再启动 SA。密钥可以保存在权限为 600 的本地文件中，勿放入仓库。当前懂你自动启动 SA 时会移除 `DEEPSEEK_API_KEY`；下面采用手动启动 SA，并在懂你中设置 `DONGNI_DSH_AUTOSTART=off`，避免依赖这段针对原作者环境的逻辑。

从 `vendor/dsh-superagent` 目录启动：

```sh
python3 scripts/dsh-superagent start --profile superagent --url http://127.0.0.1:3082
```

管理脚本通过 tmux 启动服务。已有 tmux 服务会继承它自身的环境；若 Harness 报缺少环境变量，需要把所需变量同步到该 tmux 服务的环境，再重新启动 SA。仅在新终端中 `export` 不一定生效；也可按供应商的配置方式将凭据保存在 Harness 本机设置中。

第一次启动可能报告配置未完成（退出码 3）。打开 `http://127.0.0.1:3082` 的 Superagent 面板，继续下一步。

## 5. 在 SA 面板完成 Sources、Policy 和 Execution

- **Sources → GitHub**：填写第 1 步准备的 `owner/repository` 和 `gh-agent` 绝对路径。启动检查会核验登录身份、仓库可访问性和写权限。即使主要使用本地任务，这些字段仍然必填。
- **Sources → Local inbox**：启用本地 Source。默认收件箱为 `~/.dsh/state/superagent/inbox`；若修改目录，懂你进程的 `DONGNI_DSH_INBOX` 必须设为同一个绝对路径。
- **Policy → Local inbox**：将 `owner` 加入允许列表。懂你投递的任务固定使用该身份；漏配会导致任务被拒绝。
- **Execution**：设置工作目录根路径，例如 `/Users/你的用户名/.dsh/state/superagent/work`，并填写下面的 prepare 命令。

下面的 prepare 命令供**只执行本地任务**的安装使用。SA 每张工单有一个工作目录；这里将它链接到懂你为任务指定的实际目录，包括自改时已创建的隔离代码副本，避免修改落在另一份副本里：

```sh
if [ -z "$DSH_SUPERAGENT_LOCAL_CWD" ]; then
  echo '此 prepare 配置只支持懂你的本地收件箱任务' >&2
  exit 1
fi
case "$DSH_SUPERAGENT_LOCAL_CWD" in
  /*) ;;
  *) echo '任务工作目录必须是绝对路径' >&2; exit 1 ;;
esac
test -d "$DSH_SUPERAGENT_LOCAL_CWD" || exit 1
ln -s "$DSH_SUPERAGENT_LOCAL_CWD" "$DSH_SUPERAGENT_DIR"
```

不要对懂你已经准备好的目录再次 `git clone` 或另建 worktree。若还需要让 SA 处理 GitHub 或飞书来源的任务，需要为这些来源另加 prepare 分支，参考[原项目部署说明](docs/006-deployment.md)；上面的配置会直接拒绝非本地任务。

在面板的团队提示词中填写自己的提交身份和交付要求。模型、GitHub、执行器配置全部补齐后，按面板提示重新检查配置。状态命令如下：

```sh
python3 scripts/dsh-superagent status --profile superagent --url http://127.0.0.1:3082
```

退出码 0 表示服务正常；1 表示运行异常，2 表示某个部件出错，3 表示仍有配置待补齐。面板本地 Source 应显示 ready。完整的状态码和排障说明见[部署文档](docs/006-deployment.md)。

## 6. 让懂你连接 SA

回到懂你根目录，在启动懂你的同一个终端中执行：

```sh
export DONGNI_DSH_SCRIPT="$PWD/vendor/dsh-superagent/scripts/dsh-superagent"
export DONGNI_DSH_URL="http://127.0.0.1:3082"
export DONGNI_DSH_INBOX="$HOME/.dsh/state/superagent/inbox"
export DONGNI_DSH_AUTOSTART=off
pnpm build
pnpm start
```

保持 SA 服务运行；这里关闭的是懂你自动拉起 SA 的行为，不是关闭 SA 后端。不要同时设置 `DONGNI_DSH=off`，否则懂你将不使用 SA。

使用 launchd 时，把同样的变量写入懂你 plist 的 `EnvironmentVariables`，脚本和收件箱使用实际绝对路径。终端 `export` 不会传给 launchd。重启 SA 时也需要重新提供它自己的模型环境变量。

已有的 `~/src/dsh-superagent-prototype` 安装可以继续使用，无需迁移，也不必重复创建 profile。

## 自改前置条件

普通派活接通 SA 后即可使用。自改后的自动编译、重启另外依赖懂你的 launchd 配置：当前 `scripts/rebuild.sh` 固定使用以下名称和端口：

- 服务 Label：`com.mico.dongni`
- plist 路径：`~/Library/LaunchAgents/com.mico.dongni.plist`
- 网页及健康检查端口：`3939`

plist 的工作目录设为懂你根目录，启动命令使用本机 pnpm 的绝对路径运行 `start`；配置可找到 Node、pnpm 等命令的 `PATH`，并填入上一节的环境变量。Label 和文件名需与上面一致。如果使用其他名称，需要同时调整重启脚本；仅在终端执行 `pnpm start` 无法完成当前自改流程的自动重启。

自改需要本地 Git 仓库和可用的提交身份；懂你会创建隔离代码副本、检查改动并提交回本地仓库。自改不是向 GitHub 主分支发布的流程。

## 维护

SA 使用 `npx --yes pnpm@11.7.0 check` 运行它自己的类型检查、测试和构建；懂你根目录的 TypeScript 检查排除此目录。升级时替换源码并重建插件，按原项目部署说明操作，保留本机 profile、收件箱和模型配置。

不要将 `.artifacts/`、`.env`、`node_modules/`、`lib/` 或 `~/.dsh/` 中的个人数据提交到仓库。
