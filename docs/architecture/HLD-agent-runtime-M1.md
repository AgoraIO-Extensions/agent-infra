# Agent Runtime M1 HLD

| 项目 | 内容 |
| --- | --- |
| 状态 | Draft for Review |
| 适用范围 | Agent Platform M1 Runtime 与 Adapter |
| 上位文档 | [企业级 Agent 平台 M1 产品需求](../prd/PRD-agent-platform-M1.md)、[M1 工程架构 Spec](SPEC-agent-infra-M1-engineering-architecture.md) |

## 1. 文档边界与依据

本文只细化 M1 Agent Runtime 的 Registry、Adapter、Manifest、Conversation、Session、Turn、事件和恢复契约。权威顺序如下：

1. 产品行为以 Agent Platform PRD 为准。
2. 部署单元、数据归属、身份和 Connection 边界以 M1 工程架构 Spec 为准。
3. Runtime 内部实现遵循本文。

相关 Issue 只记录决策来源和交付状态，不覆盖正式文档：

- [Issue #3 补充决策](https://github.com/AgoraIO-Extensions/agent-infra/issues/3#issuecomment-5279882787)与[标准模板 env/Secret 更新](https://github.com/AgoraIO-Extensions/agent-infra/issues/3#issuecomment-5354328551)：镜像、Digest、env/Secret、升级和回滚边界。
- [Issue #134](https://github.com/AgoraIO-Extensions/agent-infra/issues/134)：Runtime/Adapter 契约来源。
- [Issue #135](https://github.com/AgoraIO-Extensions/agent-infra/issues/135)：本文与上位文档的对齐任务。

## 2. 运行结构

```text
Web / 平台托管企微
        |
        v
Platform API --事务写入--> Platform DB <--认领 outbox-- Platform Worker
        |                                                   |
        +--读取已保存事件并 SSE 推送                         +--Runtime Adapter
                                                            |
                                                            +--内部 HTTP/SSE--> Agent Service --> Agent Pod

Agent Pod --Action + Execution Grant--> Platform Tool Gateway --> Connection API
```

- `platform-api` 解析入口身份并按命令路径原子保存：普通消息保存 Message、初始 Execution 和 Turn outbox；补充指令保存 Message 和绑定当前 Execution 的补充指令 outbox；重新生成复用已有 Message 并保存新的 Execution 和 Turn outbox；停止命令只保存绑定当前 Execution 的 stop outbox。它不直接调用 Agent Pod。
- `platform-worker` 运行 Runtime Adapter，认领 Execution，并通过 Agent Service 的内部 HTTP/SSE 调用 Pod。
- Adapter 将平台 Conversation/Execution 映射为 Runtime Session/Turn，将原生事件归一化后写回 Platform DB。
- `platform-api` 只把已经持久化的事件推送给浏览器或渠道。
- Agent Pod 保存 Runtime 自有工作区和 Session 数据，但不保存平台权威会话或授权。

## 3. Runtime Registry 与交互模式

### 3.1 标准 Runtime

M1 Registry 是平台维护的固定配置，不支持运行时插件发现。

| 标准模板 | Platform Adapter | 补充指令 | M1 平台能力 |
| --- | --- | --- | --- |
| Codex | Codex Native | Registry 显式声明并通过 Conformance | Web、企微、模型、附件/结果、Connection |
| Claude | Claude Native | Registry 显式声明并通过 Conformance | Web、企微、模型、附件/结果、Connection |
| OpenCode | Generic ACP | Registry 显式声明并通过 Conformance | Web、企微、模型、附件/结果、Connection |
| Pi | Pi RPC | Registry 显式声明并通过 Conformance | Web、企微、模型、附件/结果、Connection |

Registry 同时保存模板标识、当前镜像 Digest、Adapter 类型、Service/健康检查、capability 和 Owner 可配置的 env/Secret 键。每个模板必须显式保存布尔值 `supplementaryInstruction`；缺失时按 `false` 处理，只有对应 Adapter 通过持久幂等 Conformance 后才能设为 `true`，不能按协议名称推断。Owner 不选择或覆盖标准模板的 Adapter，也不能提交 Registry 未声明的 env/Secret。

### 3.2 自定义 Agent

| `interactionMode` | 入口与数据归属 | M1 接入规则 |
| --- | --- | --- |
| `self-managed` | 镜像负责交互应用、身份、协议、Session、事件和历史 | 不进入 Platform Conversation Contract；平台发布网络入口，Owner 选择由镜像服务端鉴权或使用平台 Auth Gateway |
| `platform-adapter` | 平台负责 Web/企微入口、身份、Conversation、Execution、事件和历史 | `protocol` 必须是 ACP，并通过 Generic ACP Conformance Suite |

`platform-adapter` Manifest 未声明 ACP 时创建失败或升级被拒绝；实际 ACP 兼容性在创建或升级的 Workload 启动后验证。M1 不为未知协议增加专用 Adapter。

`self-managed` 的应用接口由镜像负责，但 StatefulSet、Service、Ingress 和 NetworkPolicy 仍只由 `platform-worker` 调谐。自有身份入口不经过 Auth Gateway，也不获得可信平台身份或撤权上下文，账号生命周期由 Owner 的身份体系负责；平台身份入口必须经过 Auth Gateway。网络与鉴权细节见工程 Spec 14.3。

## 4. Runtime Manifest

自定义镜像通过 OCI Image Label 提供 Runtime Manifest。M1 只定义以下字段：

| 字段 | 规则 |
| --- | --- |
| `schemaVersion` | 必填；平台只接受明确支持的版本 |
| `interactionMode` | 必填；`self-managed` 或 `platform-adapter` |
| `protocol` | `platform-adapter` 必填且只能为 `acp`；`self-managed` 不读取该字段 |
| `service.port` | 必填；整数 `1..65535`，Agent Service 和健康检查使用的容器端口 |
| `health.path` | 必填；以 `/` 开头的本地 HTTP 路径，不允许外部 URL、查询参数、片段、控制字符或凭证 |
| `capabilities` | 声明模型选择、附件、结果文件、Connection 和布尔值 `supplementaryInstruction`；缺失的 capability 按不支持处理 |

Owner 不在产品页面填写协议、端口或探针。创建或升级时，平台按以下顺序验证：

1. 校验 Company Hub 访问权，并把 Tag 解析为不可变 Digest。
2. 读取并校验 Manifest Schema、交互模式，以及创建时与 Owner 申请选择、升级时与当前 Agent 的一致性。
3. 启动 Workload 并验证健康检查。
4. 对 `platform-adapter` 执行 Generic ACP 核心探测，再探测 Manifest 声明的可选 capability；平台展示能力取 Manifest 声明与实际探测结果的交集。

前两步在启动 Workload 前完成；失败时不启动 Workload。健康检查和 ACP 核心探测在启动后完成，不作为审批前门禁；访问路由只有在健康检查和所需核心探测通过后才接收用户流量。Manifest、健康检查或 ACP 核心探测失败时，创建状态为“创建失败”并返回可修复原因；可选 capability 探测失败只把对应能力记为不支持。启动 Workload 后创建失败时，`platform-worker` 必须先关闭访问路由，再幂等删除本次创建的 StatefulSet、Service、Ingress、NetworkPolicy、Kubernetes 配置与 Secret；首次创建且尚未进入“可用”的新 PVC 同时删除，重试时重新创建。Platform DB 中的申请、Agent 配置、失败原因和审计保留。Base Image 可以提供生成辅助，但继承关系不赋予 capability 或准入资格。

升级时新 Digest 先作为候选修订，并重新执行上述四步。候选 Manifest 的 `interactionMode` 必须与当前 Agent 一致，M1 不通过升级切换交互模式；Schema、Service 或健康检查字段无效，或模式不一致时不更新 Workload。有效的新 Service 和健康检查配置用于候选 Workload。候选 Workload 健康检查通过且 `platform-adapter` 再次通过 ACP 核心探测后才提升 Digest 并确认原渠道绑定；失败时恢复旧 Digest 和 Workload 配置，不修改渠道绑定和平台历史。只有旧修订也无法恢复时才进入 Agent 级“暂时不可用”。

## 5. Platform Conversation Contract

Platform Conversation Contract 只定义以下语义，不暴露具体 Runtime 协议：

- 为 Platform Conversation 创建或恢复原 Runtime Session。
- 为新消息或重新生成创建 Execution、提交一个 Turn，并接收已接受、繁忙或拒绝结果。
- 停止当前 Turn，以及在 capability 支持时提交补充指令。
- 查询 Session 和 Turn 状态。
- 订阅并归一化文本、状态、工具、文件、完成和错误事件。
- 探测模型、附件、结果文件、Connection 和补充指令 capability。

`packages/agent-runtime` 实现四个固定 Adapter。每个 Adapter 可以在 Pod 内使用 Runtime Host 或等价 Bridge 启动原生进程，但 Agent Service 对 `platform-worker` 始终提供内部 HTTP/SSE。

`platform-adapter` 自定义 Agent 的模型选择 capability 只表示 Generic ACP 可以读取 Runtime 当前提供的模型选项和默认项，并把使用者选择转交给 Runtime。选项内容、Base URL 和凭证属于自定义 Runtime；平台不把它们写入标准模板模型配置，也不从 Runtime 读取或保存凭证。提交 Turn 前，Adapter 必须确认所选模型仍在 Runtime 当前返回的选项中；能力缺失或选项已失效时不展示或拒绝该选择，不能回退到其他模型后静默执行。

标准模板的有效补充指令能力取 Registry 声明与 Adapter Conformance 结果；`platform-adapter` 自定义 Agent 取 Manifest 声明与实际探测结果的交集。缺失、声明为 `false`、探测失败或不能保证 `messageId` 持久去重时都按不支持处理，只影响补充指令分支并返回繁忙，不使 Agent 创建失败。

## 6. 数据归属与标识

| 数据 | 权威位置 | 约束 |
| --- | --- | --- |
| Conversation、Message | Platform DB | 浏览器和 Channel 只使用平台 ID |
| Execution、回答版本 | Platform DB | 消息提交或重新生成重试不能产生重复 Execution |
| 规范化事件与 SSE 游标 | Platform DB | 先持久化，再对外推送 |
| Runtime Session 映射 | Platform DB 的 Adapter 内部存储 | 原生 Session ID 不出 Adapter 边界 |
| Runtime 工作区和原生 Session 数据 | Agent PVC | Runtime 自己解释，平台不读取内容 |

一个 Platform Conversation 最多映射一个当前 Runtime Session。浏览器、Channel、自定义镜像和 Connection 请求都不能提交或覆盖原生 Session ID。

企微群聊的 Channel 会话键必须包含服务端解析的 `actorId`。不同发送者映射到不同 Platform Conversation 和 Runtime Session；群内公开展示不等于共享 Runtime 上下文。

## 7. Session、Turn 与恢复

### 7.1 Session 生命周期

1. 首个 Execution 由 Adapter 创建 Runtime Session，并持久化 Conversation 到原生 Session 的映射。
2. 后续 Execution 必须恢复同一个 Session，不能以新 Session 代替恢复。
3. Conversation 关闭或 Agent 停用时，Adapter 可以关闭原生 Session；M1 不向用户提供删除 Conversation。

### 7.2 并发

- 同一 Conversation 同时只允许一个活跃 Turn。
- 初始 Execution 与 Turn outbox 的事务提交后即视为活跃，包含 Turn 尚未投递、Runtime 是否接受暂时不确定和 Runtime 正在执行的阶段，直到 Execution 进入成功、失败或取消等终态。
- 活跃 Turn 存在时，只有与当前 Execution 相同 `actorId` 的新消息可以按 capability 作为补充指令处理；同一发送者不支持补充指令或不同 `actorId` 提交消息时，平台明确返回繁忙。任何新消息都不能启动第二个 Turn。
- 不同 Conversation 可以并行，Adapter 不使用 Agent 级全局串行锁代替会话锁。

### 7.3 重启恢复

- `platform-worker` 重启后从 Platform DB 恢复 Execution、outbox 和 Session 映射。
- Agent Pod 重启后复用原 PVC；Pod 就绪后，Adapter 必须使用已保存的原生 Session ID 恢复原 Session，并查询未完成 Turn 状态。
- 恢复成功后继续接收事件。恢复失败时保留原 Conversation 和 Session 映射，只将该 Platform Conversation 标记为“会话不可用”；该会话历史只读且不能继续发送消息，其他 Conversation 和 Agent 服务保持正常。
- 恢复失败时禁止静默创建新 Session。只有用户明确新建 Platform Conversation 时才能创建新的 Runtime Session。

## 8. 消息、事件与 SSE 可靠性

### 8.1 消息与命令幂等

- `platform-api` 在同一 Conversation 数据库锁内完成活跃 Execution 查询、普通消息/补充指令/重新生成/繁忙分支判定及对应写入，提交事务后才释放锁；stop 命令复用同一把锁。两个并发请求都不能基于“无活跃 Execution”的旧快照各自创建 Execution。
- `platform-api` 以 `(conversationId, actorId, Idempotency-Key)` 唯一约束消息提交；`actorId` 由服务端根据当前公司用户或可信 Channel 发送者映射生成，不能接受调用方提交的身份字段。
- 同一 `actorId` 下，同一 Key 和相同消息、附件、模型选择再次提交时，普通消息返回原 Message 与初始 Execution，补充指令返回原 Message 与原绑定的 Execution；同一 Key 对应不同内容时返回冲突。不同 `actorId` 的 Key 独立生效。
- 没有活跃 Turn 时，Message、初始 Execution 和 Turn outbox 在同一数据库事务中创建。
- 重新生成只允许在没有活跃 Turn 时发起。`platform-api` 校验 `sourceMessageId` 属于当前用户有权访问的 Conversation 且指向已有用户 Message，并在同一事务中创建引用该 Message 的新 Execution 和 Turn outbox，不创建新 Message；旧回答版本继续保留。Adapter 在当前 Runtime Session 中为新 Execution 提交 Turn。平台以 `(conversationId, actorId, regenerate, Idempotency-Key)` 唯一约束重新生成；相同 Key 和 `sourceMessageId` 返回原新建 Execution，同一 Key 指向其他 Message 时返回冲突。存在活跃 Turn 时返回繁忙且不创建记录。
- 活跃 Turn 存在、发送者 `actorId` 与当前 Execution 相同且 Adapter 支持补充指令时，只创建 Message 和绑定当前 Execution 的补充指令 outbox，不创建新的 Execution 或 Turn；`messageId` 是 Adapter 提交该补充指令的稳定幂等标识。
- Adapter 只有在原生协议提供持久幂等结果，或 Pod 内 Agent Service、Runtime Host 或 Bridge 能按 `messageId` 持久去重并恢复原提交结果时，才能声明补充指令 capability。Worker 或 Pod 重启后重复提交同一 `messageId` 必须返回原结果且不能再次追加；不能满足该约束的 Runtime 不开放补充指令。
- 补充指令 outbox 只有在绑定 Execution 的初始 Turn 已被 Runtime 明确接受后才能投递；初始 Turn 尚未投递或接受结果不确定时保持待处理。同一 Execution 的补充指令按 outbox 创建顺序串行投递，不能抢在初始 Turn 前调用 Runtime。若初始 Execution 在 Runtime 明确接受前进入失败或取消终态，`platform-worker` 必须在同一 Conversation 锁内将其全部待处理补充指令 outbox 置为失败终态，并将对应 Message 标记为“投递失败：原回复未开始”；不得继续重试、创建新 Execution 或改绑其他 Execution。
- `platform-worker` 认领补充指令 outbox 时，先从服务端权威数据重解析该 `actorId` 的当前公司账号、组织、Agent、Conversation、渠道绑定和 Agent 可用范围，再在 Conversation 锁内重验绑定 Execution。权限已失效时，平台在同一数据库事务中将 outbox 置为失败终态、将 Message 标记为“投递失败：权限已失效”，且不调用 Adapter；Execution 已终止时，同样将 outbox 置为失败终态并将 Message 标记为“投递失败：原回复已结束”。只有权限仍有效且 Execution 仍活跃时，平台才签发新的短期 Execution Grant 并按 `messageId` 提交。Adapter 必须拒绝已经终止的原生 Turn。失败后不能自动重试、创建 Execution/Turn 或改绑其他 Execution；同一 Idempotency-Key 重放仍返回该失败 Message 和原绑定 Execution，用户重新发送时使用新 Key 并重新执行准入分支。
- 同一发送者不支持补充指令或不同 `actorId` 提交消息时，平台返回繁忙且不创建 Message、Execution 或 outbox。普通消息、补充指令、重新生成和繁忙分支的判定与写入必须原子完成。
- 停止命令不创建 Message 或新 Execution。`platform-api` 在 Conversation 锁内校验发送者 `actorId` 与活跃 Execution 相同，并原子创建绑定该 Execution 的 stop outbox；每个 Execution 只有一个 stop outbox 和平台生成的稳定 `stopRequestId`，重复 HTTP 请求返回已有停止状态。没有活跃 Turn 时幂等返回“已结束”，其他发送者无权停止且不创建 outbox。`platform-worker` 认领时重验 Execution；初始 Turn 已被 Runtime 接受且仍活跃时才按 `stopRequestId` 调用 Adapter，已经终止则将 outbox 置为成功终态。Adapter 和 Agent Service 把同一 `stopRequestId` 的重复停止视为同一命令。
- 初始 Turn 调用 Runtime 前，`platform-worker` 必须在 Conversation 锁内重验同一 Execution 没有 stop outbox。若 stop 已存在且 Runtime 明确未接受初始 Turn，Worker 在同一事务中取消待投递的 Turn outbox、把 Execution 置为“已取消”、把 stop outbox 置为成功终态，并按前述规则结束全部待处理补充指令，不调用 Adapter，初始 Turn 后续不得再投递。初始 Turn 正在投递或接受结果不确定时，stop outbox 保持待处理；Worker 先按原 `executionId` 恢复查询，确认已接受后才调用 Adapter，确认未接受时执行前述本地取消。
- `executionId` 是 Adapter 提交 Turn 的稳定幂等标识。协议不能确认是否已接受 Turn 时，Adapter 将 Execution 标记为状态不确定并恢复查询，不能盲目重复提交。

### 8.2 事件去重

- 每个 Adapter 必须为原生事件提供跨重连稳定的 `adapterEventKey`。优先使用 Runtime 提供的持久事件 ID；若 Runtime 不提供稳定 ID，则 Pod 内的 Runtime Host 或 Bridge 必须在首次转发前持久化分配单调事件 ID，并支持按该 ID 恢复。禁止使用重连后可能重置或重新分块的流内序号派生。
- Platform DB 对 `(executionId, adapterEventKey)` 建立唯一约束；重复原生事件只返回已有平台事件。
- 平台为首次保存的事件分配稳定 `eventId`、Execution 内递增 `sequence` 和 Conversation 内严格递增 `conversationCursor`。
- 高频文本可以批量持久化，但不能先推送未保存内容，也不能因批量合并改变最终文本顺序。

### 8.3 SSE 补发

- 浏览器以 `Last-Event-ID` 重连。`platform-api` 先验证该事件属于当前用户有权访问的 Conversation，再按 `conversationCursor` 补发其后的已保存事件；未知、越界或属于其他 Conversation 的游标返回“重新加载时间线”信号。
- 实时补发受服务端配置的数量和时间窗口限制，避免单次重连无限读取。
- 游标超出补发窗口时，服务端返回明确的“重新加载时间线”信号；客户端先读取 Platform DB 中的持久化历史，再从新的游标继续 SSE。补发窗口不改变业务数据保留期限。

## 9. 身份、授权与 Connection

### 9.1 逐 Turn 与补充指令身份

`platform-api` 在消息或命令提交时校验入口身份，`platform-worker` 在提交每个 Turn 和每条补充指令前再次从服务端权威数据解析：

- 当前公司用户与组织状态。
- Agent、Conversation 和渠道绑定。
- Agent 可用范围，以及标准模板 Owner 当前允许的模型选项或自定义 Runtime 通过 ACP 返回的当前模型选项。
- 当前允许的 Connection Action 集合版本。

平台在每个 Turn 或补充指令实际投递前生成绑定用户、Agent、Conversation、Execution、Turn、渠道和 Action 集合版本的短期 Execution Grant。Agent Pod 只接收本次投递所需的签名上下文；固定 env、浏览器字段和 Runtime 返回值都不能替代当前身份。

补充指令在重验当前授权后签发新的 Grant，其用户、Agent、Conversation、Execution、渠道和 Action 范围取原 Execution 授权边界与当前授权的交集，不能扩大原范围；Platform Tool Gateway 仍按调用时的当前授权独立拒绝 Connection 请求。

### 9.2 两个独立拒绝门

| 拒绝门 | 当前调用时校验 |
| --- | --- |
| Platform | 公司账号、Agent 可用范围、渠道、模型、Owner 允许的 Action、Execution Grant |
| Connection | Connection 归属或共享范围、用户授权、Action、外部账号、凭证状态和 Provider 权限 |

任一系统拒绝都终止调用。Platform 通过不代表 Connection 必须执行；Connection 也不能根据 Agent 提交的用户、Connection 或外部账号字段绕过自身校验。

Agent 只向 Platform Tool Gateway 提交 Action 和参数。Platform 根据 Execution 解析当前授权并调用 Connection API；Connection 注入凭证、执行和脱敏。原始凭证不进入 Agent Pod、Adapter 或模型上下文。

### 9.3 自有交互的平台身份入口

Owner 为 `self-managed` Agent 选择平台身份入口时，Auth Gateway 在每次请求校验公司账号和 Agent 可用范围，移除调用方提供的身份 Header，并传递包含签发者、公司用户、受众、Agent ID、签发时间和过期时间的短期签名上下文。自定义 Agent 服务端必须校验签名、签发者、受众、有效期和 Agent 绑定；可信上下文缺失、签名无效、过期或绑定错误时均拒绝。调用方提供的身份 Header 不能改变 Gateway 签发的最终身份。该上下文只用于自有交互应用鉴权，不创建 Platform Conversation、Execution 或 Execution Grant。

## 10. Pod 安全与网络

- Agent 使用独立 ServiceAccount，默认没有 Kubernetes RBAC 权限；不能创建或修改 Service、Ingress 和 NetworkPolicy。
- NetworkPolicy 禁止 Agent Pod 访问 Platform DB、Connection DB、KMS/Secret Service 和 Kubernetes API。
- 标准模板和 `platform-adapter` Agent Pod 只能通过明确允许的内部入口使用 Platform Tool Gateway、LLM Gateway、对象存储临时 URL 和必要基础服务。
- `self-managed` Agent Pod 的其他出站访问遵循公司集群现有策略，但仍受上述敏感目标隔离约束；M1 不新增按 Agent 维护的 egress allowlist。
- Platform 和 Connection 的数据库账号、服务身份及 Secret 不挂载到 Agent Pod。
- Owner Secret 只以 Agent 专属 Kubernetes Secret 注入，不进入 Workload annotation、日志、错误或 API 回显。
- Runtime 事件在写入 Platform DB 前必须移除模型内部思考、原始凭证和未脱敏请求。

## 11. 验证

- 四个标准模板运行同一 Conformance Suite：Session 创建/恢复、Turn、流式事件、停止、状态、capability、平台 Web/企微和 Connection。
- Generic ACP 自定义样例镜像在不增加平台专用代码的前提下通过同一核心测试。
- 负向测试覆盖未知协议、无交互入口、创建或升级时 Owner 选择与 Manifest 交互模式不匹配、升级 Manifest 的无效 Schema/Service/健康检查、标准模板未声明的 env/Secret（包括代理、加载器和 Runtime 启动选项）、跨用户/Agent/Connection、企微群聊不同发送者映射到同一 Conversation/Session、不同发送者向活跃 Turn 追加指令或停止回复、两个请求同时进入空闲 Conversation、初始 Turn 未投递时提交补充指令、初始 Turn 接受前失败或取消后的补充指令收敛、补充指令投递前发送者失去权限、补充指令使用过期或扩大范围的 Grant、补充指令提交后目标 Turn 先结束、补充指令重试或 Worker/Pod 重启后重复追加、补充指令 capability 缺失或为 `false`、声明后探测失败、不具备持久去重却声明补充指令 capability、重新生成重复创建 Message 或 Execution、活跃 Turn 上重新生成、stop outbox 丢失或重复停止、繁忙拒绝后创建记录、重复消息、重复事件和同会话并发 Turn。可选补充指令探测失败时，Agent 仍创建成功且有效 capability 为 `false`；活跃 Turn 上返回繁忙，不创建 Message、Execution 或 outbox。
- `kind` 覆盖创建时健康检查或 ACP 探测失败后没有可路由入口、运行中 Workload 或遗留新 PVC，以及有效 Service/健康检查变化的候选 Workload、升级探测失败后恢复旧 Digest、渠道和平台历史、原 PVC 复用、Pod 重启恢复原 Session，并用两个 Conversation 验证恢复失败不新建 Session，且不影响另一会话。
- 入口测试覆盖 Agent ServiceAccount 无法修改 Service、Ingress 或 NetworkPolicy，Pod 与 Service 地址不直接作为用户入口，自有身份入口不获得平台身份上下文；平台身份入口强制 Auth Gateway 校验，调用方身份 Header 不能改变最终签名身份，缺失、签名无效或过期的上下文、错误签发者、错误受众和错误 Agent 绑定均被拒绝。
- SSE 覆盖持久化后推送、重复事件、窗口内补发和超出窗口后重载时间线。

## 12. 参考与非目标

M1 参考以下社区项目的 Runtime Registry、Protocol Adapter、Session 生命周期、事件归一化和 capability 分层：

- [Multica](https://github.com/multica-ai/multica)
- [Paseo](https://github.com/getpaseo/paseo)
- [Open Design](https://github.com/nexu-io/open-design)

这些项目只作为结构和生命周期参考。M1 不直接复制其代码、产品权限、存储模型或完整协议集合。

以下内容不进入 M1：

- 动态 Adapter 插件、未知协议自动发现和协议版本兼容矩阵。
- Hermes 或 Magic 的特殊 Runtime/渠道语义。
- 将 ACP、Pi RPC 或原生事件直接暴露给 Web 和企微。
- Redis、Kafka、NATS、Temporal 或其他消息中间件。
- Kubernetes CRD、Operator 框架和 PVC 自动快照。
- 自有交互入口的会话、事件和历史托管。
