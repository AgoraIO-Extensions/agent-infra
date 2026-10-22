# ADR-0031：标准模板原生工具以 Session Sandbox 为隔离边界

## 状态

已采纳。随 [#3200](https://github.com/AgoraIO-Extensions/agent-infra/issues/3200) 的文档评审合入，决策来源见 [#3198](https://github.com/AgoraIO-Extensions/agent-infra/issues/3198)。实现分别归属 [#3201](https://github.com/AgoraIO-Extensions/agent-infra/issues/3201)（Codex）、[#3202](https://github.com/AgoraIO-Extensions/agent-infra/issues/3202)（Claude、OpenCode、Pi）和 [#3203](https://github.com/AgoraIO-Extensions/agent-infra/issues/3203)（通用出网）。

本 ADR 收窄 [ADR-0011](0011-require-codex-native-operation-barrier.md) 的适用范围：执行前屏障只适用于平台中介的跨 Sandbox 调用。它同时修订 [ADR-0017](0017-session-owned-sandbox-isolation.md) 中原生文件/进程防护的作用。工程边界只在[工程 Spec §10.14](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1014-标准模板-session-sandbox-原生工具)完整定义。

## 背景

[平台 PRD §13.3](../prd/PRD-agent-platform-M1.md#133-真实结果与可靠性) 要求外部操作开始前可靠记录调用意图，但没有定义外部操作。ADR-0011 和工程 Spec §10.11 把每次原生工具尝试都当作外部动作。官方 Codex 发行版没有可验证的每次尝试回调，按“缺少可靠执行前控制边界的操作不得准入”，实现收紧为只允许模型输出。其他模板也按同一思路收紧：

- Codex 的官方 lane 拒绝平台 client tool 以外的全部工具事件。只要模型发出 `exec_command`、`apply_patch` 等调用，这一轮就失败。
- Claude 只开放 `Read`、`Write`、`Edit`，其余工具返回 “Tool access is unavailable”。
- Pi 只开放 `read`、`write`、`edit`。
- OpenCode 默认拒绝 ACP 权限请求。

结果是四个标准模板都不能执行命令、列出或搜索目录。固定 E2E 中，模型回答“当前环境没有终端工具”，于是改为猜文件名反复调用读工具，又触发了 #3176 和 #3196。这与 PRD §11.3 “缺口须有明确原因及后续交付责任，不以全部隐藏作为四模板完成”冲突，也违背 Owner 的要求：平台不能削减标准 Agent 的原生能力。

上述收紧的前提已经改变。ADR-0017 之后，每个平台会话都有独立的 Session Sandbox，包括独立的 Pod、PVC、ServiceAccount 和默认拒绝的 NetworkPolicy。工程 Spec §10.9 也写明，Codex 进程/文件边界不再是 Agent 共享 Pod/PVC 的隔离依据。在 Sandbox 内执行命令或修改文件，只影响该会话自己的工作区。

## 决策

1. **边界。** 四个标准模板（Codex、Claude、OpenCode、Pi）在 Session Sandbox 内默认启用固定版本的原生工具。范围包括命令与脚本、文件读写与编辑、目录列举与搜索、原生 Skill，以及该版本自带的网络工具。Session Sandbox 是这些工具的隔离边界。自定义 Agent 不受本 ADR 约束。
2. **外部操作。** PRD §13.3 的外部操作只指跨出当前 Sandbox、由平台或 Connection 代为执行的调用：
   - **平台中介调用**：模型请求、Driver 执行的标准 MCP 与 Connection 调用、Driver 执行的受控工具、平台文件与接口操作、Browser 外部副作用。这类调用保留持久 intent、当前授权、结果或 unknown 的执行前屏障。
   - **原生直接出网**：由部署批准的出站策略在网络层预先授权，Runtime 只记录工具事实，不逐次拦截。

   Sandbox 内的本地命令与文件操作只记录真实工具事实，不逐次保存执行前意图，也不逐次重验 Host 授权。
3. **出网。** 原生工具能到达的目标由部署批准的出站策略决定。默认策略仍只允许集群 DNS、获准模型和 Connection；部署可以另行批准通用出网目标。Runtime、镜像、模型、Owner 和调用方都不能扩大目标。需要外部账号凭证的访问只走 Connection。
4. **凭证。** Relay Key、模型传输 token、Connection、MCP 与 Browser token，以及平台服务凭证，都不能被原生工具通过环境、文件、`/proc` 或继承的 FD 读取。某模板做不到时，只关闭受影响的工具并记录缺口，不能退回只允许模型输出。
5. **保持不变。**
   - 跨 Conversation 与跨 Session 隔离及其负向验收。
   - 模型错误脱敏（[ADR-0007](0007-sanitize-codex-model-errors-before-native-storage.md)）。
   - Connection 授权，以及 unknown 不重放、停止确认等规则。
   - ADR-0011 对私有 lane 的要求，但只用于平台中介调用。

## 影响

- ADR-0011 的“每次实际外部动作执行前屏障”只适用于平台中介调用。官方 Codex 路径的 Sandbox 内工具不再因缺少每次尝试接缝而被拒绝。官方路径仍不宣称私有 native barrier conformance。
- ADR-0017 中，原生文件/进程防护改为承担跨 Conversation 隔离与凭证保护，不再用来限制 Sandbox 内的工具种类。当前授权仍约束 Execution 准入和平台中介调用。
- Sandbox 内工具没有执行前意图记录。原生进程或 Driver 崩溃后，原 Turn 按现有规则收敛为真实终态或 unknown，平台不自动重放 Turn 或工具。用户可见的结果仍是“待核实”，与模型调用的未知结果一致。
- 停止以原生 Turn 的中断确认为准。Turn 结束后，残留的后台进程只能作用于本 Sandbox 和获准出网，不延长 Execution 占用，也不能取得平台中介调用的新准入。这些进程随 Session 关闭或空闲回收清理。
- 文档合入后，相关能力仍须由 #3201、#3202、#3203 实现并完成真实验收。在此之前，不能宣称任何模板已开放原生工具。

## 备选方案

- **保持只允许模型输出，由平台补齐列举、搜索、执行等 client tool。** 否决：等于重写原生工具，语义与上游不一致，仍然削减原生能力。
- **原生审批交给用户逐次确认。** 否决：Sandbox 内的操作不是外部操作。逐次确认增加使用负担，普通 approval 也无法证明覆盖全部尝试。
- **等待上游提供每次尝试的回调或私有 lane。** 否决：没有交付期限。Sandbox 已经提供隔离，私有 lane 只对平台中介调用有意义。
- **全面开放出网。** 否决：出网范围属于部署安全策略，不能由 Runtime 或模板自行决定。
