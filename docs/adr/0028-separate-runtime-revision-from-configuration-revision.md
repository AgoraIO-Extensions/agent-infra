# ADR-0028：区分 Runtime 修订与配置修订

## 状态

草案，待 [#3097](https://github.com/AgoraIO-Extensions/agent-infra/issues/3097) 评审后采纳；实现归属 [#3078](https://github.com/AgoraIO-Extensions/agent-infra/issues/3078)。采纳后修订 [ADR 0023](0023-upgrade-idle-session-sandboxes.md) 的 policy 过期判定。

## 背景

Agent 配置每保存一次（只改可用范围除外）都会产生新的配置修订。配置修订号同时承担四类职责：

- 配置写入的乐观锁、历史与审计。
- Workload 调谐输入：Core 发现 Workload 来源修订与当前配置修订不同，就回到 preflight 并推进 Workload revision。
- Kubernetes 资源与 Secret 物化的修订标识：`config-revision` 注解、资源指纹、Secret 名称中的 `r{N}`、模型投影与 Skill 绑定中的修订号。
- 就绪比较：Session Sandbox policy、Dispatch 容量和任务运行授权都要求 Workload 来源修订、Execution 的模型配置修订等于当前配置修订。

企微智能机器人和自建应用绑定按[工程 Spec §14.2.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1421-配置与凭证)复用 Agent 配置的版本、绑定与审计权威，所以只改 `channels` 也会推进配置修订。

代码中 `channels`、`channelRevision` 不会进入 env、Runtime Manifest、模型投影、Secret 或 Sandbox payload，只有 Channel 层、配置展示和配置准入会读取。但修订号变化本身就会触发三件事：滚动 Agent StatefulSet、升级全部空闲 Sandbox、新 Sandbox 等到 Workload 重新验证后才能准备。[#2983](https://github.com/AgoraIO-Extensions/agent-infra/issues/2983) 在固定环境实测，从绑定到 `service_ready` 约 9 分钟，这期间到达的首条企微消息过期。

[平台 PRD §8](../prd/PRD-agent-platform-M1.md#8-标准模板的模型配置) 规定配置保存后对新任务生效，底层是否更新运行实例由平台处理。PRD 只在模板/镜像升级时描述“更新中”，没有要求渠道变更进入更新中。

## 决策

1. **Runtime 修订。** 每个配置修订行同时记录一个 Runtime 修订，取值为最近一次改变 Runtime 输入的配置修订号。
   - 本次修订改变了 Runtime 输入时，Runtime 修订等于本修订号；否则继承上一修订的值。
   - Runtime 修订不是新计数器，取值仍在配置修订号的范围内。因此下列各处的格式和外键都不改变，统一表示“Runtime 输入的来源修订”：
     - Secret record 对配置修订的外键；
     - Secret 名称中的 `r{N}`；
     - Kubernetes `config-revision` 注解；
     - 模型投影与 Skill 绑定中的修订号。
   - 当前 Runtime 修订从 Agent 当前配置修订行派生，不另存第二个指针。

2. **字段分类。**
   - Runtime 输入：`source`、`modelConfiguration`、`environment`、`secrets`、Skill 绑定、Owner（Secret 激活绑定 Owner）、默认 Relay Key（含无 Key 配置迁移）。
   - 非 Runtime 输入：`channels`、`channelRevision`。
   - 可用范围维持现状，不产生配置修订。
   - Core 用固定集合实现分类，新增字段默认属于 Runtime 输入。要把某个字段改为非 Runtime 输入，须先证明 Worker、RuntimeHost 与 Session Sandbox 都不消费它，并同步更新本 ADR 与工程 Spec。

3. **按版本域分别比较。**
   - 以下比较改用 Runtime 修订：
     - Workload 调谐：输入选择、新意图判定与写回 CAS。candidate/verified 内嵌的配置文档取 Runtime 修订对应的那一份。
     - Secret 物化与激活。
     - Session Sandbox：policy 是否过期、Sandbox 认领，以及 ADR 0023 的升级意图。
     - 投递：Dispatch 容量、任务运行授权、Execution 的模型配置固定。
     - 对外呈现：Workload 是否在调谐中、Runtime 能力投影。
   - 以下比较保留配置修订：
     - 配置写入：乐观锁、企微配置会话，以及审计与历史。
     - 渠道：授权与连接一律读当前配置修订行的 `channels`/`channelRevision`。
     - 配置展示，以及文件限制等直接读取当前配置的路径。
   - 任何代码都不得从 Workload 状态读取渠道等非 Runtime 字段。

4. **只改非 Runtime 字段。**
   - 照常写入新的配置修订、幂等结果和 `agent.configuration.revised` 审计，`changedFields` 如实记录。
   - 不写 `agent.configuration.revised.v1` Workload outbox，不改变 Workload 状态、管理服务可用性或 Session Sandbox policy。
   - 正在进行的 Workload 步骤不因此作废，已受理的 Execution 继续按原 Runtime 修订投递。
   - 新渠道配置由 Channel 层按新的配置修订立即生效。

5. **迁移与兼容。**
   - 回填时，既有修订行的 Runtime 修订等于自身修订号。
   - 缺省值也按“本修订改变了 Runtime 输入”解释：未更新的写入路径保守地退回当前行为，即多重建一次，不会漏掉 Runtime 变化。
   - Workload 状态的 `sourceConfigurationRevision`、Workload deployment 的 `configRevision`（及对应 `config-revision` 注解）和 Sandbox `resource_policy.configurationRevision` 保留字段名，含义改为 Runtime 修订。回填后数值不变，已有 Workload、Sandbox 与 Execution 不需要迁移或重新调谐。
   - Secret record/reference 的 `configRevision` 含义不变，仍是引入该 Secret 引用的来源修订（[工程 Spec §10.6](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#106-环境变量与-secret)）。Secret 属于 Runtime 输入，该修订必然推进 Runtime 修订，所以它与 Runtime 修订同属一个版本域，但可以早于 Workload 当前的 Runtime 修订；Secret 激活与复用比较 Workload 的 Runtime 修订，不把二者当作同一个值。

## 实现前的验证契约

实现 PR 至少用真实 PostgreSQL 覆盖：

- 只改 `channels`：配置修订 +1、Runtime 修订不变、没有 Workload outbox；Workload 状态和服务可用性不变；不产生 Sandbox 升级意图；新会话的 Sandbox 可以立即认领；已受理 Execution 照常投递。
- 每个 Runtime 输入字段仍会推进 Runtime 修订并触发调谐。
- Runtime 变更调谐途中再改 `channels`：候选不被取代，写回不作废。
- 渠道变更之后再改 Runtime 输入：Workload 取新 Runtime 修订的配置；Execution 的模型配置固定值与 Workload 来源修订一致。
- 回填前后，已有 Workload、Sandbox policy 与 Execution 的就绪判定一致。
- 配置 CAS 与企微授权仍使用配置修订：渠道变更后，基于旧配置修订的配置会话或写入被拒绝。

固定本地 E2E 需验证：绑定机器人后立即发送单聊，Agent 不进入 `service_updating`，回复在企微时限内送达。

## 风险与边界

- 分类错误的代价不对称：把 Runtime 输入误判为非 Runtime 输入，运行实例就会继续使用旧配置。所以新字段默认归入 Runtime 输入，测试须逐项覆盖每个 Runtime 输入字段。
- Workload 内嵌的配置文档可能在非 Runtime 字段上落后于当前配置，这是有意的：Workload 只代表 Runtime 输入。
- 新旧版本混合部署时，旧写入路径仍把每次修订都当作 Runtime 变化，最多多重建一次，不影响正确性。
- 不在本决策内：Pod 重建后到 `service_ready` 的耗时（#3078 另行调查）；更新期间企微的即时回应（#3077）；Owner 与默认 Relay Key 能否改为非 Runtime 输入。

## 备选方案

- **把渠道移出 Agent 配置修订，另建渠道版本与审计：** 这会改变 Spec §14.2.1 的版本与审计权威，以及企微配置会话的 CAS，属于数据归属迁移。眼下的问题只是不应让渠道修订驱动 Runtime，所以拒绝。
- **独立的 Runtime 计数器（1、2、3…）：** Secret record 外键、Secret 名称、Kubernetes 注解和全部持久 JSON 都要换版本域并迁移，所以拒绝，改用取值仍为配置修订号的 Runtime 修订。
- **渠道变更时就地改写 Workload 与 Sandbox 的修订号：** 仍要改 Kubernetes 注解，会改变资源指纹并触发 apply，还要逐个重写 Sandbox policy，相当于另一套提升流程，而且最终仍要区分 Runtime 输入，所以拒绝。
