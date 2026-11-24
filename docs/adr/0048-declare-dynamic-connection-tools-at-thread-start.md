# ADR-0048：动态手工安装的 Connection 工具在会话开始时声明

## 状态

提案，归属 [#4199](https://github.com/AgoraIO-Extensions/agent-infra/issues/4199)，同属
[#4157](https://github.com/AgoraIO-Extensions/agent-infra/issues/4157) AC-4（Owner 手工关联后
Agent 能实际使用 Connection）。须经非实现方独立评审后合入。可见起点的用户行为以
[Platform PRD §9.1](../prd/PRD-agent-platform-M1.md#91-owner-按需关联与用户-oauth) 为准；工程规则
只在[工程 Spec §13.5.6“动态安装的 reader 与可见起点”](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1356-标准-oauth-安装供应)
维护。本 ADR 只记录取舍，不单独覆盖 PRD、工程 Spec 或 HLD。

## 问题

在本决策之前，下面三条工程边界合在一起，使动态手工安装在任何会话里都用不上：

- 安装只能在原用户已有且仍有效的 processing Execution 中发起，此时该会话的原生 Thread 已经开始。
- 固定官方 Codex 只在 `thread/start` 通过 `dynamicTools` 声明工具；开始时没有 Connection 工具的
  Thread 不能再加，M1 也不修改上游。工程 Spec 同样禁止热改已有 Thread 工具快照。
- 许可和 Host 私有副本绑定原会话的 Host/Pod、Sandbox、代次与 resourceFence；新会话是另一个
  Sandbox，用不到这次安装。

另外，Host 读取许可需要许可引用，但 #4314 的 Store 以随机值作为许可 id。Host 没有 Host→Worker
写入口，也收不到后续命令，因此无从得知该 id。

PRD 原先没有写授权后何时可用。用户于 2026-11-20T13:1xZ 授权按建议执行，经前台
sess_714f2fb5 于 2026-11-21T06:45Z 转达，选定下述选项 1；用户可以推翻。

## 决策

1. **会话开始时声明，授权后同一会话可用。** 部署批准了动态发布合同、且 Agent 已有已核实的 Owner
   手工关联时，新会话的 Thread 一开始就按合同中的完整工具定义声明 Connection 工具。授权前调用
   返回固定的“需要先在平台完成 Connection 授权”结果；许可写入后，同一会话的后续调用可用。
   工具集合在 Thread 开始时就已固定，只有可用性随许可变化，所以不构成热改。
2. **许可引用取 `exchange` 阶段的命令引用。** 每个安装至多一条许可，Host 已在本地 exchange 记录
   中持有该引用与 `commitDigest`。这样既不改回读合同，也不需要迁移。
3. **reader 接缝放在 Driver 既有的 per-Execution `resolveInput`。** 该接缝由 Host 实现：读材料
   前后各做一次许可读取，并核对本地已提交的 publication。`denied`、`unavailable` 和结果不明一律
   在任何 Connection 请求之前拒绝本次调用，不重试、不重放。

## 备选

- **只在授权之后新开的会话里可用。** 许可与副本绑定原会话的 Sandbox；要成立，就得按“用户 +
  Agent”跨会话交付秘密，这是架构变更，M1 成本高。不改架构则等于永远用不上。
- **授权后在同一会话重开原生 Thread。** 用户会失去这次会话之前的原生上下文（平台历史仍在），
  还需要新增“授权后重开 Thread”的规则，会话连续性受损。
- **许可 id 保持随机，或改为按 `authorizationId + commitDigest` 定位。** 前者 Host 无法得知；
  后者要改已合入的回读合同，并让许可引用依赖两个字段的组合。

## 后果

- 动态发布合同须额外给出每个工具在 Thread 开始时声明的完整定义（名称、说明、输入 schema），
  因为授权前没有 token，无法做 MCP 发现。安装可用后，发现结果须与声明完全一致，否则拒绝调用。
  这个部署输入的落地属于 C2。
- 授权前模型能看到 Connection 工具，调用会得到需要授权的提示；该提示不含凭据、安装或许可标识，
  也不会自动发起安装。
- 会话中的授权入口与同会话重试遵循 [Platform PRD §9.1](../prd/PRD-agent-platform-M1.md#91-owner-按需关联与用户-oauth)
  和[工程 Spec §13.5.6](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1356-标准-oauth-安装供应)。
  会话 Sandbox 空闲回收后重新准备或重建，以及许可到期或失效后，仍须重新授权。
- Store 写许可时以 `exchange` 的命令引用为 id。这是一处小的实现变更，与本 ADR 一并评审后另行实施。

## 其他三个 Driver 的会话开始声明（2026-11-23 增补，#4349）

上文以固定官方 Codex 的 `thread/start.dynamicTools` 为问题陈述。Claude、OpenCode、Pi 的声明点见工程
Spec §13.5.4，这里只说明同一取舍为何成立：

- 三者都在会话开始时由 Driver 向原生登记工具集合：Claude 是随 query 传入的 SDK 进程内 MCP server，
  OpenCode 是 ACP `mcpServers`，Pi 是扩展的 loopback 工具。登记时没有 token，也没有 MCP 发现，所以
  同样只能依据动态发布合同里的完整定义声明，之后不热改。
- 授权前的调用由 Host 的同一个 reader 接缝在任何 Connection 请求之前回答固定拒绝，授权后同一会话可用，
  与 Codex 一致。这一行为在 `dynamic-connection.test.ts` 中对 Claude SDK server 与 loopback bridge 各有用例。
- 与 Codex 的差别只在声明载体，不在 reader、许可回读、拒绝结果与撤销规则。Connection 启用前已经开始的会话须新开会话；
  重新授权及会话重建后的重新准备按 PRD §9.1 与工程 Spec §13.5.6 处理。
- Codex 的 `dynamicTools` 属固定版本的 experimental API，需要显式 opt-in；其余三者不使用它，各自的固定版本与
  保护见 ADR-0025 的 2026-11-23 增补与 Spec §13.5.4。安装投递期限与受信命令边界见
  [ADR-0054](0054-session-scoped-connection-authorization-after-execution.md)。
