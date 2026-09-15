# Codex Pilot 运行装配

本入口消费部署已批准的 Agent active 配置，遵循
[Runtime HLD §3.1](../../docs/architecture/HLD-agent-runtime-M1.md#31-标准-runtime)
与[工程 Spec §10.7](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#107-标准模板模型配置)。
它不读取 Platform DB、ModelCatalog、Connection Provider Credential 或部署解密 keyring。

## 固定镜像

`apps/agent-runtime-host/Dockerfile` 在构建时安装
[`codex-release.json`](../../packages/agent-runtime/src/codex-release.json) 固定的 Codex 产物。
上游 `0.153.0` 表示协议兼容来源；派生产物另用 `distribution.buildId` 标识，绑定源码
tree、构建输入与各 target 的归档、manifest 和四个 binary 摘要。只有声明中具备派生产物的
target 可以安装；本地 ARM 首通不代表其他 target 已交付。

构建输入目录包含完整 `codex-candidate.tar.gz`，通过只读 named build context 交给安装器：

```bash
AGENT_INFRA_CODEX_BUILD_CONTEXT=/path/to/verified-candidate pnpm docker:build
```

CI 从同一 release 条目的 `transport` 读取固定 GitHub Actions run、attempt、artifact
与源码 head，通过标准 artifact 下载入口获取完整归档，再由安装器核对固定摘要。
当前 CI 原生检查在 Linux ARM64 runner 执行；发布脚本选择 ARM 时需显式设置
`PLATFORM=linux/arm64`。这不代表 amd64 派生产物已交付。

Actions 候选只在其保留期内可重新下载。已取得的完整归档可以保存在本地，后续构建仍
逐次验证摘要；归档过期且本地没有副本时构建会失败。候选缓存不替代长期发行来源，
没有匹配的派生产物时不会安装旧官方包。

该变量只选择归档位置，校验值由源码中的 release 声明固定。安装器验证整个归档、原始
candidate manifest、完整文件集合、模式、ELF 架构、来源及法律文件，再整体安装到
`/opt/codex`。最终 binary 为 `0555`，其他文件为 `0444`；源码依赖 SBOM、构建环境、
原 manifest、LICENSE/NOTICE 与 release 声明保留在 `/opt/codex/share/`。

正式入口在启动原生进程前复验安装文件与来源，Bridge 再验证版本、app-server Schema
与原生屏障 probe。启动不下载依赖。源码 SBOM 的覆盖范围仍以 candidate 声明为准，
不作为全部静态链接依赖的完整清单。

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
| `AGENT_INFRA_RUNTIME_CONNECTION_PROFILE` | 可选的独立 Connection 固定目标；只含下述非敏感字段 |
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

### 独立 Connection 客户端输入

客户端授权、原主体映射、私有交付与核实规则见
[Runtime HLD §9.1](../../docs/architecture/HLD-agent-runtime-M1.md#91-codex-独立-connection-consumer-profile)。
配置目标不代表独立授权已经完成；只有经过当前镜像的原生隔离验证并取得有效客户端输入后，才可执行真实调用。

`AGENT_INFRA_RUNTIME_CONNECTION_PROFILE` 只接受以下 JSON，resource 固定为 HTTPS `/mcp`，不能含凭证、query 或 fragment：

```json
{
  "profileRef": "connection-primary",
  "serviceRef": "connection-primary",
  "issuer": "https://connection.example.test",
  "resource": "https://connection.example.test/mcp"
}
```

独立授权交付方将短期客户端输入放入 Host 数据目录下的 `independent-client-input/`。
该目录必须由 Host 进程用户拥有、权限 `0700`、路径无 symlink，并位于原生 Conversation 的文件 allowlist 之外。
文件名为 `sha256(UTF-8(JSON.stringify([principal.kind, principal.id, agentId, profileRef]))) + ".json"`，
使用当前已受理原执行的主体与 Agent 选择，不能按 Owner、责任人或 workload 选择。

文件顶层只有 `principal`、`agentId` 和 `client`；`client` 只有 `service`、`connectionIdentity`、
`credential`，内部字段由版本化私有 callback schema 校验。主体映射必须来自同一次独立授权交付。
文件必须由 Host 进程用户拥有，权限为 `0400` 或 `0600`，最大 32 KiB；轮换使用同目录原子替换。
原始 Provider 凭证、refresh token、任意 headers 和 Connection 管理浏览器会话均不属于该输入。
启动或配置读取不加载这些文件；真实 bootstrap 在读取前后分别重验原任务授权。
缺失、过期、绑定错误或不安全的文件权限均拒绝调用。不要将文件内容写入日志、Issue 或普通配置示例。

RuntimeHost 使用 `pnpm --filter @agent-infra/agent-runtime-host start` 启动；镜像使用同一 shell launcher。
launcher 在 Node 启动前拒绝 `NODE_OPTIONS`、`NODE_DEBUG`、`NODE_DEBUG_NATIVE` 和 `NODE_V8_COVERAGE`，
设置不可提升的零 core dump 限制，并通过 `--disable-sigusr1` 关闭信号启用 inspector 的入口。
程序化装配及每次凭据读取同样检查当前进程保护。实际原生内存读取、跨主体及后代进程隔离仍须由当前二进制验证。

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
