# 在懂你中使用 Superagent

这个目录保存了本机实际使用的 dsh-superagent 源码快照，包含本地收件箱 Source、管理脚本和测试。来源提交为 `2ba696609d75ec47277d73948b879f85bfb9e014`。原项目采用 MIT 许可，版权和许可见 [LICENSE](LICENSE)，原项目介绍见 [README.md](README.md)。

这里只收录来源仓库已跟踪的文件，不包含它的 Git 历史、依赖、编译产物、运行记录或个人配置。DeepSeek Harness 本体不在此目录内，需要单独安装；依赖版本以 [package.json](package.json) 和锁文件为准。

## 新机器安装

1. 按 [部署说明](docs/006-deployment.md) 的 Prerequisites 和 Install 安装 DeepSeek Harness、tmux 等依赖。源码已经在此目录，不必再次克隆 SA。进入本目录，使用 `package.json` 中 `packageManager` 指定版本的 pnpm 安装依赖并构建：

   ```sh
   cd /你的路径/dongni/vendor/dsh-superagent
   pnpm install --frozen-lockfile
   pnpm build
   ```

2. 按部署说明创建独立的 `superagent` profile，并把插件链接指向本目录。已有 profile 时走文档的升级流程，勿重新运行 `--from-default-profile`，它会覆盖已有配置。

3. 按 [配置示例](examples/profile.cordis.patch.yml) 设置面板 `127.0.0.1:3082` 和绝对路径的 `stateDir`。在 profile 的 `cordis.patch.yml` 额外启用本地收件箱：

   ```yaml
   - id: dsh-superagent-local
     disabled: false
   ```

   通过面板 Policy 将本地 Source 的 `owner` 加入允许列表。懂你投递任务时使用这个身份；收件箱目录必须与懂你的 `DONGNI_DSH_INBOX` 一致，默认是 `~/.dsh/state/superagent/inbox`。执行器的 prepare 命令必须处理本地任务的 `DSH_SUPERAGENT_LOCAL_CWD`，在指定目录工作；详见部署说明的 Local inbox 一节。GitHub、飞书入口独立配置，懂你通过本地收件箱派活。

4. 在 DeepSeek Harness 中配置自己的模型供应商和默认模型。懂你的 `config/llm.json` 不会自动同步到 Harness。密钥只放本机，不提交到这个目录。当前懂你的自动启动逻辑会移除 `DEEPSEEK_API_KEY`；如使用 DeepSeek 供应商，可自行在终端加载凭据并手动启动 SA，同时设 `DONGNI_DSH_AUTOSTART=off`，不要依赖懂你自动传递该变量。

5. 从本目录手动启动并检查，配置不足时按面板提示补齐：

   ```sh
   python3 scripts/dsh-superagent start --profile superagent --url http://127.0.0.1:3082
   python3 scripts/dsh-superagent status --profile superagent --url http://127.0.0.1:3082
   ```

6. 启动懂你的进程时设置脚本绝对路径，例如从懂你根目录运行：

   ```sh
   export DONGNI_DSH_SCRIPT="$PWD/vendor/dsh-superagent/scripts/dsh-superagent"
   pnpm start
   ```

   使用 launchd 时，把同一个绝对路径加进该服务的环境变量；终端里的 `export` 不会传给 launchd。已有的 `~/src/dsh-superagent-prototype` 安装可以继续使用，无需迁移。

## 验证与维护

`status` 应退出为 0，且面板的本地 Source 显示 ready。再从懂你发起一件小的派活任务，确认接单、回复和任务完成状态；启用自改前另行验证代码副本和重启流程。

本目录独立安装、构建和检查，使用 `pnpm check` 运行 SA 的类型检查、测试和构建。懂你根目录的 TypeScript 检查排除此目录，两边的依赖和编译配置各自维护。

升级时替换源码并重建插件，按部署说明操作；保留本机 profile、收件箱和模型配置。不要将 `.artifacts/`、`.env`、`node_modules/`、`lib/` 或 `~/.dsh/` 中的个人数据提交到仓库。
