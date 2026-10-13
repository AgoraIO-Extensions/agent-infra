# ADR-0025：RuntimeHost 的 ACP 受保护 MCP transport bridge

状态：Draft for Review（#851）

本 ADR 是架构修订候选，不改变当前 Runtime 行为；只有本 ADR 与工程 Spec 的修订经过评审合入后，才可实施后续代码。

## 背景

当前固定的 OpenCode/Generic ACP 版本不能让 RuntimeHost 直接把 Connection
凭据交给 native 进程。工程 Spec §13.5.4 当前要求原生 Connection MCP 配置保持为空，
并禁止 Runtime 创建 MCP server；这份 ADR 明确提出需要评审的边界变化。ACP 的 `mcpServers` 请求可以携带 HTTP headers，但这些
headers 会进入 native ACP stdin；把 Connection OAuth access token 或获准 PAT
放进该字段会越过 RuntimeHost 的受保护凭据边界。Pi 0.86 也没有 MCP session
transport，因此继续保持 `connection: false`。

与此同时，RuntimeHost 已有 `StandardMcpClient`。它在受保护的 Host/Driver
范围内读取安装材料、固定 Connection endpoint、校验当前原执行并负责 MCP
操作的 intent、开始、结果确认和 unknown 屏障。缺少 native transport 适配时，
这段能力无法被 Generic ACP Driver 使用。

## 决策（待评审）

为支持具备已验证 ACP MCP transport 的固定 native 版本，增加一个
**RuntimeHost-owned transport bridge**，其职责仅是把 Host 内部的
`StandardMcpClient` 暴露给同一 Runtime Session 的 native MCP client：

1. Host 为一个原始 Execution 打开一个 `StandardMcpClient`，Connection token、
   SecretRef、Connection headers 和远端 MCP client 对象始终留在 Host 内存与
   Host 的受保护材料边界。
2. Host bridge 只绑定 `127.0.0.1`，使用每次 Session/Execution 生成的短期随机
   bearer。ACP `mcpServers` 只接收 bridge URL 和这个本地 bearer；native 进程
   不接收 Connection token、SecretRef、OAuth/PAT headers、普通 token helper 或
   可重开的秘密文件。
3. Bridge 只发布当前受信 MCP discovery 中的工具名和输入 schema。每个
   `tools/call` 都通过 `StandardMcpClient` 的既有校验和 operation 接口，绑定
   当前 Agent、Conversation、Execution、generation、安装修订和 deadline；
   不从 native 请求读取主体或 Agent 字段。
4. Bridge 不重试工具调用，不改变 Connection endpoint，不保存 Connection
   结果或授权状态。请求身份、参数摘要、实际开始、结果/unknown 和 ACK 仍由
   Host 原有 journal/fact seam 保存；响应丢失或确认失败时封闭当前 native
   Session，WRITE 不重放。
5. Session、Execution、撤权、过期、进程退出和 Host close 都关闭 bridge、
   `StandardMcpClient` 和 loopback bearer。任何保护检查失败都让 Connection
   capability 保持不可用，同时保留控制和只读恢复边界。

这个 bridge 是 RuntimeHost 内部的 transport adapter。Platform API、Worker
和 Connection API 不经过它代理调用，也不取得 Connection token、目录、Grant
或 Provider credential；Connection 仍是外部身份、授权、调用和结果的权威。

## 规范映射

本提案同时受以下现行边界约束：

- [工程 Spec §13.5.3](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1353-secretref权威与交付边界)
  负责 SecretRef、主体/Agent/ConsumerInstance 选择和不向 native 交付原始凭据；
- [工程 Spec §13.5.4](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1354-runtime-driver-直接消费标准-mcp)
  负责 Runtime Driver 的 MCP 执行、原生配置为空和真实 Linux 保护；
- [Runtime HLD §11.2](../architecture/HLD-agent-runtime-M1.md#112-codex-与-connection-接缝验收)
  负责固定产物、秘密/FD/子进程保护、结果保存和 unknown WRITE；
- [Connection HLD §5.2](../architecture/HLD-connection-M1.md#52-consumer-与-instance)、
  [§7](../architecture/HLD-connection-M1.md#7-mcpapi-调用流程)、
  [§8](../architecture/HLD-connection-M1.md#8-幂等与线性化) 和
  [§13](../architecture/HLD-connection-M1.md#13-pilot-验收与成功声明)
  负责 ConsumerInstance、逐次认证、幂等、撤销和真实调用证据。

本 ADR 只是候选 transport adapter；它不能覆盖这些文档。若 bridge 需要改变
§13.5.4 的“原生 Connection MCP 配置保持为空”或其他边界，必须先修订工程
Spec 并通过同一套评审，随后才能实施。

## 现有 seam 与拟定调用序列

实现必须复用已有符号，不新建第二套 Connection journal 或授权权威：

- Host 以 `StandardMcpClient.open()` 创建当前原执行的标准客户端；
  `StandardMcpClient.assertCurrent()` 在每次发送前重新读取受保护安装与当前授权。
- Generic ACP 在 `openAcpSession()` 的 session 生命周期中挂接 bridge；
  `AcpLaunch.mcpServers` 只传 loopback URL 和短期 bridge bearer。
- 每次 native `tools/call` 先由 bridge 校验固定工具名、参数 schema 和当前
  native session，再调用 `StandardMcpClient.call(alias, arguments, operation, signal)`。
  `operation` 必须实现现有 `StandardMcpOperation` 的
  `assertCurrent → prepare → started → confirm/block` 顺序。
- `prepare` 持久化 RPC identity 与参数摘要，`started` 只在最后一次授权/保护
  复核后记录；一次 HTTP dispatch 最多对应一个实际发送。响应丢失、发送次数异常
  或 `confirm` 失败调用 `block()`，将结果保持 `unknown` 并封闭 native Session，
  不把普通工具错误交给模型继续推理。
- Driver 使用现有 `SessionRuntimeDriver` 的
  `recordOperationFact()`/`RuntimeOperationFactV2` seam 记录同一
  operation/attempt 的开始、终态或 unknown；Connection 关联引用仍只能来自
  同次认证响应，缺失时保持 unverified。

上面的顺序是实现前必须锁定的 contract；当前固定 OpenCode/Pi 版本没有足够
transport/dispatch 证据，因此本 ADR 不提供实现或 capability enable。

## 与当前工程 Spec 的关系

当前 [工程 Spec §13.5.4](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1354-runtime-driver-直接消费标准-mcp)
仍然优先采用 Driver 内直接消费标准 MCP，并要求原生 Connection MCP 配置保持为空。
在本 ADR 被接受、固定 native artifact 通过门禁、且 §13.5.4 完成相应修订以前，
这些现行要求继续有效，`connection: false` 不变；本 ADR 不能单独授权创建 MCP server、
修改 Host 装配或启用 OpenCode/Pi。

## 能力门禁

- 只有固定 native artifact 的 provenance 明确证明其 ACP `mcpServers` HTTP
  transport 会话级注册、不会把 headers 写入 native home/log/journal，并且
  具备 bounded initialization、tool discovery 和 session close 语义时，才可
  开启该 bridge。当前仓库固定证据是 OpenCode `1.18.30`、ACP SDK `1.4.0`
  （见 `packages/agent-runtime/src/opencode-release.json`、
  `packages/agent-runtime/src/protected-mcp-compatibility.test.ts`）；这些测试只
  锁定版本/provenance，不证明受保护 headers 或 dispatch admission，故当前仍关闭。
  未来升级到其他版本必须重新提交 artifact source、lock、transport 和泄漏负测证据。
- Generic ACP 的 artifact 不满足时保持 `connection: false`，不能用
  `OPENCODE_CONFIG_CONTENT`、普通 env/argv、stdio、代理签名或自定义 tool
  replacement 绕过。
- Pi 仍保持 `connection: false`，直到固定上游提供受保护的 session MCP
  transport 或另一个经过评审的等价 seam；Pi extension 不自动成为凭据 bridge。

## 实施边界

只有上述 Spec 修订合入后，后续实现 PR 才能只修改 Platform/Runtime consumer 侧：

- `StandardMcpClient` 的 bridge-facing tool projection 与 Host-owned loopback
  server；
- Generic ACP 的 per-execution reference、operation/fact 回调和 lifecycle；
- Host 装配、capability gate、固定 artifact/provenance 测试与负向 token
  泄漏测试。

不得修改 Connection 原生实现、部署、Provider、Grant、Consumer 注册或其
tickets；不得把 bridge 当作 Connection 服务端或 Platform API 的第二权威。

## 未决评审问题

- 固定 OpenCode artifact 的 MCP registration 是否在 session close 时完全回收，
  以及 headers 是否可能落入 native 日志、数据库或 diagnostic dump；
- ACP tool-call 生命周期能否在 native dispatch 前给 Host 足够的 admission
  屏障，确保 unknown WRITE 不会继续推理；
- Linux 最终镜像的 loopback、native child、Host material 和 ptrace/FD 边界
  是否可由真实 artifact 验证，而不是由 controlled fixture 推断。

在上述问题被评审和真实固定 artifact 证据覆盖前，本 ADR 不改变当前
`connection: false` 行为。
