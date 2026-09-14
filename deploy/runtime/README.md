# Codex Pilot 运行装配

本入口消费部署已批准的 Agent active 配置，遵循
[Runtime HLD §3.1](../../docs/architecture/HLD-agent-runtime-M1.md#31-标准-runtime)
与[工程 Spec §10.7](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#107-标准模板模型配置)。
它不读取 Platform DB、ModelCatalog、Connection credential 或部署解密 keyring。

## 固定镜像

`apps/agent-runtime-host/Dockerfile` 在构建时安装 Codex `0.153.0`，支持
`linux/amd64` 与 `linux/arm64`。固定资产、SHA-256 与 LICENSE/NOTICE 的来源记录在
[`codex-release.json`](../../packages/agent-runtime/src/codex-release.json)。安装程序验证压缩包、
解压后的可执行文件和法律文件，最终镜像保留 `/opt/codex/share/` 中的来源与法律信息。
正式入口在启动原生进程前复验文件，Bridge 再验证版本与协议 Schema。启动不下载依赖。

## 部署输入

以下 `AGENT_INFRA_*` 输入只能由受信部署装配。Owner 与 HTTP 请求不能选择 Driver、原生路径、
endpoint 或 credential。`AGENT_INFRA_RUNTIME_DRIVER=codex` 是固定模板绑定；`fake` 仅用于独立测试。

| 环境变量 | 内容 |
| --- | --- |
| `AGENT_INFRA_RUNTIME_AGENT_ID` | 当前 Agent ID；Grant 必须绑定该 Agent |
| `AGENT_INFRA_RUNTIME_DATA_DIR` | 当前 Agent PVC 的绝对挂载路径，镜像默认为 `/var/lib/agent-runtime` |
| `AGENT_INFRA_RUNTIME_MODEL_CONFIG` | 下述 schemaVersion 2 的 active 模型配置 JSON |
| `AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_*` | 每个 active 选项的运行凭证，由配置中的保留环境变量名精确引用 |
| `AGENT_INFRA_RUNTIME_SERVICE_TOKEN` | Worker 到 RuntimeHost 的服务认证凭证 |
| `AGENT_INFRA_RUNTIME_GRANT_KEY_ID` | 已批准的 Grant 签名公钥标识 |
| `AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY` | Ed25519 PEM 公钥 |
| `AGENT_INFRA_RUNTIME_GRANT_ISSUER` | 预期 Grant issuer |
| `PORT` | HTTP 监听端口，默认为 `3003` |

模型配置结构示例，不包含凭证：

```json
{
  "schemaVersion": 2,
  "configVersion": "active-revision-1",
  "defaultModelOptionId": "codex-default",
  "defaultReasoningLevel": "medium",
  "modelOptions": [
    {
      "modelOptionId": "codex-default",
      "endpoint": "https://approved-model.example/v1",
      "model": "gpt-5.2",
      "reasoningLevels": ["medium", "high"],
      "credentialEnvironmentVariable": "AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_CODEX_DEFAULT"
    }
  ]
}
```

模型选项、凭证传递、原生路由与失败处理遵循
[工程 Spec §10.8](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#108-codex-原生模型传输边界)。

`host.json` 与 `codex-driver.json` 位于该 Agent 数据目录；Driver 使用 #403 的
`codex-driver.json.native` 持久目录装配。关闭进程不删除这些业务数据，损坏或丢失状态仍按
[HLD §7.3](../../docs/architecture/HLD-agent-runtime-M1.md#73-重启恢复) 拒绝替代恢复。

## 镜像验证

```bash
pnpm docker:build
node deploy/release/runtime-probe.mjs agent-infra-agent-runtime-host:latest /tmp/codex-runtime-probe.json
```

probe 以镜像内容 ID 启动 non-root 容器，根文件系统只读且外部网络关闭，在容器内通过正式环境
入口、HTTP/SSE 和真实 pinned Codex 访问合成模型替身。验证默认与 Execution 模型选择、授权、
幂等、重启读取、401/403/503、redirect、错误 content type、流内失败、异常流、取消与递归落盘
脱敏。另一次运行覆盖可执行文件校验失败。probe 不保存模型请求正文、Native ID、原生协议帧
或凭证。

CI 保存 `codex-runtime-probe-<commit>` artifact，其中 `imageId` 保存 Docker 回读的镜像内容标识，
运行环境提供 OCI manifest/index Digest 时保存为 `imageDigest`；不将 Docker 镜像 ID 当作 OCI config Digest。
probe 只接受 clean checkout；存在未提交修改时直接失败，不写入可被误用的通过证据。成功证据中的
`sourceDirty` 固定为 `false`。
现有 `build-images.mjs` 在任何发布前执行同一 probe，并在 image manifest 旁保存
`.runtime-probe.json`，绑定该 clean commit、已核验镜像 Digest 与 Codex/config 版本。
扫描结果仍由 #405 的统一入口提供，使用同一 commit 与镜像内容标识关联。
该入口落地后 CI 的镜像构建步骤直接使用扫描器的 `build` 命令，并以本次生成的
`--scan-build .vulnerability-scan/build.json` 执行 probe，要求其 `source.commit`
匹配当前 commit，并直接运行 `agent-runtime-host` 记录的 `imageId`。对应
`imageId` 必须相同；缺失或不匹配的构建记录不能回退到 Compose Tag。

本验证不代表 #404 多人隔离验收、#194 完整 Pilot 或生产上线，也不执行镜像发布与共享环境部署。

## Claude Native 核心验收

Claude 静态绑定 `AGENT_INFRA_RUNTIME_DRIVER=claude`，只消费共享 Runtime 配置 V3 中
`anthropic-messages-v1` 的 active 选项。目录明确 `bearer` 或 `api-key`；模型值使用实际
模型名。Owner 的个人 Claude 配置不能作为部署默认值。配置、预检和投影规则见
[工程 Spec §10.7](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#107-标准模板模型配置)。

官方 SDK、原生 CLI 与各平台文件摘要固定于
[claude-release.json](../../packages/agent-runtime/src/claude-release.json)，镜像构建和 Driver
启动均检查实际安装内容。Query 的来源、采用方式与许可证见
[第三方声明](../../packages/agent-runtime/THIRD_PARTY_NOTICES.md)。
每个 Conversation/generation 使用独立 Query、工作区、配置与个人记忆。相邻 Turn 切换
模型选项时先排空旧 Query，再恢复原 native Session；中断的活跃 Turn 保持 `unknown`，
不能重投。补充指令、附件、结果文件及 Connection capability 保持关闭。

共享及专属测试使用真实固定版本 CLI 与合成模型服务；CI 在 non-root、只读根、无外网的
Linux 容器再次运行。Messages 预检必须验证完整流式工具调用；当前固定版本要求
`count_tokens` 成功，未证明原生 fallback 的端点缺失不能豁免。仅允许原生客户端的网关
若拒绝标准 Messages 预检，候选必须拒绝并保留旧 active 修订。

经授权的真实模型验收可从 `apps/agent-runtime-host` 目录运行：

```bash
node ../../deploy/runtime/messages-conformance.mjs \
  --settings /secure/test-settings.json --model claude-opus-5 \
  --output /secure/claude-conformance.json
```

配置文件按 Claude `settings.json` 的 `env` 结构提供 `ANTHROPIC_BASE_URL` 与
`ANTHROPIC_AUTH_TOKEN` 或 `ANTHROPIC_API_KEY`。探针不修改该文件，只使用合成 canary，
验证双用户并行读写、各自记忆和重启后的正负对照。真实负向向量明确记录为
`symlink-escape`：探针创建并核验指向另一用户现有 canary 的工作区别名，用 SDK 历史将
实际 Read 与结果逐项关联；口头拒绝不能通过，任意越界读取成功或 canary 泄漏均判失败。
直接绝对路径拒绝另由同版本原生 CLI 的确定性测试覆盖，不将别名测试报告为直接路径的
真实模型验收。默认要求干净源码；`--allow-dirty`
仅用于开发诊断，结果明确标记，不能用作交付验收。报告保留版本、源码及原生文件摘要、
配置版本、实际模型和布尔结果。原生记录和临时目录在结束时清理。

真实 Driver 本地通过不能代替当前源码对应镜像的验收。镜像验证仍须记录实际 image
Digest、source label、non-root/只读根/可写挂载，以及同一镜像运行探针的结果；不能仅靠
传入 `--image-digest`、`--source-commit` 声明完成验证。完整模板的文件和 Connection
验收仍由其独立任务负责。

## Generic ACP 与 OpenCode 核心验证

OpenCode 静态绑定 `AGENT_INFRA_RUNTIME_DRIVER=acp`，由同一个 Generic ACP Driver 消费
共享模型配置 V3 的 `anthropic-messages-v1` 选项。平台选项映射为原生
`anthropic/<model>`，reasoning 经 ACP 的 `effort` 配置精确设置并复验；每 Turn 的
Messages 传输只允许选中的模型、reasoning、endpoint 和 credential。Files、Connection
与补充指令 capability 保持不可用。

镜像安装 `/opt/opencode/bin/opencode`，版本、来源和每平台校验值只在
[opencode-release.json](../../packages/agent-runtime/src/opencode-release.json) 维护。
Host 启动校验 SDK 版本和可执行文件 SHA-256。部署者可用
`AGENT_INFRA_OPENCODE_EXECUTABLE` 指定同一校验值的本地二进制路径，不能借此运行其他版本。

Session 数据位于 Agent 数据目录的 `acp-driver`；每 Conversation 使用独立原生配置、
工作区和 `.memory/MEMORY.md`。只允许该工作区内经真实路径检查的 read/edit 工具；
终端、任意命令、外部目录、MCP 和项目配置加载保持关闭。未知 Turn 和真实 Session
恢复失败的边界统一见 [HLD 重启恢复](../../docs/architecture/HLD-agent-runtime-M1.md#73-重启恢复)。

有本地已校验二进制时，从仓库根目录运行：

```bash
OPENCODE_EXECUTABLE=/opt/opencode/bin/opencode pnpm exec vitest run \
  packages/agent-runtime/src/acp-runtime-driver.test.ts \
  packages/agent-runtime/src/acp-session.test.ts \
  packages/agent-runtime/src/opencode-native.test.ts \
  packages/agent-runtime/src/runtime-driver-conformance.test.ts
```

`opencode-native.test.ts` 使用真实原生进程和合成 Messages 服务，证明模型/工具/恢复
行为；它不替代真实模型、双用户与 Pod 的验收。共享 conformance 在显式提供
`OPENCODE_EXECUTABLE` 时加入 OpenCode；CI 在固定 Linux 镜像中执行该分支，并要求
non-root、只读根文件系统、禁网和独立可写临时目录。

真实模型与双用户探针复用上述 `messages-conformance.mjs`，增加 `--runtime opencode`
及 `--executable /opt/opencode/bin/opencode`。OpenCode 使用自身 `export` 命令读取测试
Session，将实际 read 调用、结果、记忆和恢复后的上下文逐项关联；仅保存布尔验收结果，
不输出原生历史或配置凭证。

OpenCode 真实模型验收须分别运行 `--negative-target workspace` 和
`--negative-target memory`，保存两份通过报告。每份都从独立测试状态完成双用户
正向读写、原 Session 重启恢复、上下文检查及指定目标的双向负向调用。分开运行可避免
前一次工具拒绝影响模型对另一测试目标的调用选择；缺少任一报告均不能声明隔离验收通过。

## Pi RPC 核心 Driver

Pi 静态绑定 `AGENT_INFRA_RUNTIME_DRIVER=pi`，消费与 Claude、Generic ACP 相同的
Messages V3 配置。版本、源码和 CLI bundle 校验值以
[pi-release.json](../../packages/agent-runtime/src/pi-release.json) 为准；采用方式与许可证见
[第三方来源](../../packages/agent-runtime/THIRD_PARTY_NOTICES.md)。镜像构建和 Driver 启动均
核对来源；不修改上游 Pi。

每个 Conversation/generation 使用独立的 `pi-driver` 持久目录、配置、workspace 和
确定的 `native/session.jsonl`。相同选择的连续 Turn 复用持续 RPC；选择改变或通道失效时
先退役原进程，再加载原 session file，并复验 provider/model/thinking。真实模型凭证
只留在 Host 的共享 Messages 传输中，原生进程只获得短期本地传输凭证。

`prompt` 与 `abort` ACK 不代表完成或停止。终态由 `agent_end`、`get_state`、
`get_messages` 核实，原生 session file 同步落盘后才发布。恢复时以提交前持久 checkpoint
核对历史前缀、唯一新 user 消息和明确终止原因；无法证明的执行保留 `unknown`，不重投。
已确认终态同时持久保存原生历史 checkpoint；重启前读取官方 session context，拒绝
完整行截断、上下文替换或缺失。已保存的事件游标稳定重放，损坏文件不被新 Session 替换。

原生工具仅开放 read/write/edit，复用官方工具的 filesystem operations，在路径解析及
文件名 fallback 之后由镜像内可信扩展校验实际访问目标；启动必须收到该策略的
就绪信号。显式关闭项目授权、扩展/技能/模板/上下文自动发现以及自动重试和压缩。
`.memory/MEMORY.md` 仅从当前 workspace 读取。supplement、文件传输、结果文件和
Connection capability 保持关闭；本项交付不代表完整模板整装通过。

共享真实模型探针使用 `messages-conformance.mjs --runtime pi`，无需 `--executable`。
协议回归为 `pi-runtime-driver.test.ts`；`pi-native.test.ts` 与共享
`opencode-native.test.ts` 使用真实 Pi CLI 和合成 Messages 服务，不能替代真实模型验收。
CI 在固定 Linux 镜像中运行同一 conformance，并沿用 non-root、只读根文件系统和明确
可写挂载；完整验收须绑定干净源码、镜像 Digest、实际模型及双用户/重启证据。
