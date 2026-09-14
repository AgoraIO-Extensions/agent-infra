# 第三方来源

Claude Query 启动与退役逻辑采用 Paseo 的叶子实现：

- 仓库与固定版本：`getpaseo/paseo@d1b705a0cd91617a5707fae25d80cb0be3057950`。
- 来源：`packages/server/src/server/agent/providers/claude/query.ts` 的
  `applyRuntimeSettingsToClaudeOptions` 和 `claudeQuery`；`claude/agent.ts` 的 `ensureQuery`。
- 本仓落点：`src/claude-query.ts` 和 Claude Driver 的 Query 退役与原 Session 恢复。
- 改动：移除产品环境覆盖、用户 HOME、权限默认值和 stderr 日志；每 Query 绑定一个已验证
  模型选项，注入独立会话目录及短期传输能力，停止后确认进程退出。
- Copyright (c) 2025-present Mohamed Boudra，Apache-2.0。
  原始许可证完整保留于 [paseo-LICENSE](third-party/paseo-LICENSE)。

官方 Claude Agent SDK 固定为 `0.3.246`，随包原生 CLI 为 `2.1.246`；其 Anthropic 许可证
随依赖分发，与上述 Paseo 源码许可证分别保留。

Generic ACP 采用以下固定上游叶子实现与协议库：

- 官方 `@agentclientprotocol/sdk@1.4.0`，源码
  `agentclientprotocol/typescript-sdk@c88bb0da97fe1059d4e3032df2724bf39c96f3d2`：
  使用 `client`、`ndJsonStream` 和标准 ACP 请求；不复制 framing/correlation。Apache-2.0
  许可证随依赖分发。本仓在 SDK 输入前限制帧大小、投影通知并过滤未请求响应，防止 SDK
  错误诊断记录原生参数；没有修改 SDK 或上游 Runtime。
- Paseo 的上述固定版本，`packages/server/src/server/agent/providers/acp-agent.ts` 中的
  `initializeResumedSession`、`startTurn`、`handlePromptResponse` 与进程退出清理：
  `src/acp-session.ts` 采用 initialize/new/load/prompt/cancel 的生命周期顺序；替换产品自动
  授权、默认模型回退和内存 Turn 状态，沿用本仓持久请求和事件。未确认退出保持 unknown。
  许可证与版权见上方 Paseo 条目。
- `nexu-io/open-design@ad9078b87c2d08e537ca3e041c46c124e7380c9c` 的
  `apps/daemon/src/agent-protocol/acp/models.ts`：`findModelConfigOption`、
  `normalizeModelConfigOptions` 和 `currentModelFromSessionResult` 的解析方式用于
  `src/acp-session.ts` 的模型配置发现、选项展开及当前值读取。仅采用标准 configOptions
  路径，支持分组选项；移除默认模型回退和自动容错执行。Apache-2.0，许可证完整保留于
  [opendesign-LICENSE](third-party/opendesign-LICENSE)。

OpenCode 使用未修改的官方 `1.18.30` 二进制，源码对应
`anomalyco/opencode@3104c1428ec91f809e5ab86631300de41eb6952e`。Linux 镜像从官方固定
平台 npm 包提取二进制，同时校验包 integrity、归档和可执行文件 SHA-256；macOS 原生
验证使用同版本 release 二进制。来源和校验值在
[src/opencode-release.json](src/opencode-release.json) 中维护，MIT 许可证保留于
[opencode-LICENSE](third-party/opencode-LICENSE)。不维护 OpenCode fork 或协议扩展。


Pi RPC 使用未修改的官方 `@earendil-works/pi-coding-agent@0.85.1`，源码对应
`earendil-works/pi@d981de1229ef899957bbe968bc8dcda02a21f477`。包通过 lockfile integrity
固定；构建和启动时核对全部 CLI bundle 的 SHA-256，校验值统一保存在
[src/pi-release.json](src/pi-release.json)。MIT，Copyright (c) 2025 Mario Zechner；
完整许可证见 [pi-LICENSE](third-party/pi-LICENSE)。

- Paseo 上述固定版本的 `providers/pi/cli-runtime.ts` 中 `PiCliRuntimeSession`、
  `providers/pi/runtime.ts` 中 `buildPiLaunch` 和 `providers/jsonl-rpc-process.ts`：
  `src/pi-rpc.ts` 与 `src/pi-session.ts` 采用持续 JSONL RPC、请求关联、精确 session file
  恢复及进程清理方式；去除 stderr 原文、继承环境、自动确认和产品默认值。Apache-2.0，
  版权及许可证见上方 Paseo 条目。
- Open Design 上述固定版本的 `apps/daemon/src/agent-protocol/pi-rpc/events.ts` 中
  `mapPiRpcEvent`：采用文本 delta 与工具阶段的分派方式，输出本仓既有规范化 Schema；
  原生 ID、帧和工具正文留在 Driver 内。Apache-2.0，许可证见上方 Open Design 条目。
- 官方 `RpcClient` 隐式继承进程环境并收集 stderr，因此本仓只依赖未修改的官方 CLI，
  采用上述受限客户端叶子逻辑。持久操作、游标、屏障和进程所有权复用 ACP 已有实现；
  Pi 特有 ACK/终态核实、原生历史 checkpoint、可信工具策略留在 Pi 模块。

Pi 的路径解析、read 文件名 fallback、edit 和 write 队列不在本仓重写。可信扩展使用官方
`createReadToolDefinition`、`createWriteToolDefinition`、`createEditToolDefinition` 的
filesystem operations 接口，在 Pi 完成路径解析后校验实际访问目标；恢复时使用官方纯函数
`buildSessionContext` 核对已持久历史 checkpoint，在启动 CLI 前拒绝截断或替换的上下文。
