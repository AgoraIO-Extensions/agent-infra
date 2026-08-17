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

- [Issue #3 补充决策](https://github.com/AgoraIO-Extensions/agent-infra/issues/3#issuecomment-5279882787)：镜像、Digest、env/Secret、升级和回滚边界。
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

- `platform-api` 解析入口身份，在同一事务中保存 Message、Execution 和 outbox；它不直接调用 Agent Pod。
- `platform-worker` 运行 Runtime Adapter，认领 Execution，并通过 Agent Service 的内部 HTTP/SSE 调用 Pod。
- Adapter 将平台 Conversation/Execution 映射为 Runtime Session/Turn，将原生事件归一化后写回 Platform DB。
- `platform-api` 只把已经持久化的事件推送给浏览器或渠道。
- Agent Pod 保存 Runtime 自有工作区和 Session 数据，但不保存平台权威会话或授权。

## 3. Runtime Registry 与交互模式

### 3.1 标准 Runtime

M1 Registry 是平台维护的固定配置，不支持运行时插件发现。

| 标准模板 | Platform Adapter | M1 平台能力 |
| --- | --- | --- |
| Codex | Codex Native | Web、企微、模型、附件/结果、Connection |
| Claude | Claude Native | Web、企微、模型、附件/结果、Connection |
| OpenCode | Generic ACP | Web、企微、模型、附件/结果、Connection |
| Pi | Pi RPC | Web、企微、模型、附件/结果、Connection |

Registry 同时保存模板标识、当前镜像 Digest、Adapter 类型、Service/健康检查和 capability。Owner 不选择或覆盖标准模板的 Adapter。

### 3.2 自定义 Agent

| `interactionMode` | 入口与数据归属 | M1 接入规则 |
| --- | --- | --- |
| `self-managed` | 镜像负责交互入口、身份、协议、Session、事件和历史 | 不进入 Platform Conversation Contract；平台只负责部署和可选 Auth Gateway |
| `platform-adapter` | 平台负责 Web/企微入口、身份、Conversation、Execution、事件和历史 | `protocol` 必须是 ACP，并通过 Generic ACP Conformance Suite |

没有可用的自有交互入口、又不能通过 Generic ACP 验证的镜像，在创建或审批阶段拒绝。M1 不为未知协议增加专用 Adapter。

## 4. Runtime Manifest

自定义镜像通过 OCI Image Label 提供 Runtime Manifest。M1 只定义以下字段：

| 字段 | 规则 |
| --- | --- |
| `schemaVersion` | 必填；平台只接受明确支持的版本 |
| `interactionMode` | 必填；`self-managed` 或 `platform-adapter` |
| `protocol` | `platform-adapter` 必填且只能为 `acp`；`self-managed` 不读取该字段 |
| `service.port` | 必填；Agent Service 和健康检查使用的容器端口 |
| `health.path` | 必填；不含凭证的 HTTP 健康检查路径 |
| `capabilities` | 声明模型选择、附件、结果文件和 Connection 能力 |

Owner 不在产品页面填写协议、端口或探针。平台按以下顺序验证：

1. 校验 Company Hub 访问权，并把 Tag 解析为不可变 Digest。
2. 读取并校验 Manifest Schema 和交互模式。
3. 启动 Workload 并验证健康检查。
4. 对 `platform-adapter` 执行 Generic ACP 核心探测；平台展示能力取 Manifest 声明与实际探测结果的交集。

Manifest 缺失、不支持或探测失败时，创建状态为“创建失败”并返回可修复原因。Base Image 可以提供生成辅助，但继承关系不赋予 capability 或准入资格。

## 5. Platform Conversation Contract

Platform Conversation Contract 只定义以下语义，不暴露具体 Runtime 协议：

- 为 Platform Conversation 创建或恢复原 Runtime Session。
- 为 Execution 提交一个 Turn，并接收已接受、繁忙或拒绝结果。
- 停止当前 Turn，以及在 capability 支持时提交补充指令。
- 查询 Session 和 Turn 状态。
- 订阅并归一化文本、状态、工具、文件、完成和错误事件。
- 探测模型、附件、结果文件和 Connection capability。

`packages/agent-runtime` 实现四个固定 Adapter。每个 Adapter 可以在 Pod 内使用 Runtime Host 或等价 Bridge 启动原生进程，但 Agent Service 对 `platform-worker` 始终提供内部 HTTP/SSE。

## 6. 数据归属与标识

| 数据 | 权威位置 | 约束 |
| --- | --- | --- |
| Conversation、Message | Platform DB | 浏览器和 Channel 只使用平台 ID |
| Execution、回答版本 | Platform DB | 一个消息重试不能产生重复初始 Execution |
| 规范化事件与 SSE 游标 | Platform DB | 先持久化，再对外推送 |
| Runtime Session 映射 | Platform DB 的 Adapter 内部存储 | 原生 Session ID 不出 Adapter 边界 |
| Runtime 工作区和原生 Session 数据 | Agent PVC | Runtime 自己解释，平台不读取内容 |

一个 Platform Conversation 最多映射一个当前 Runtime Session。浏览器、Channel、自定义镜像和 Connection 请求都不能提交或覆盖原生 Session ID。

## 7. Session、Turn 与恢复

### 7.1 Session 生命周期

1. 首个 Execution 由 Adapter 创建 Runtime Session，并持久化 Conversation 到原生 Session 的映射。
2. 后续 Execution 必须恢复同一个 Session，不能以新 Session 代替恢复。
3. Conversation 关闭或 Agent 停用时，Adapter 可以关闭原生 Session；M1 不向用户提供删除 Conversation。

### 7.2 并发

- 同一 Conversation 同时只允许一个活跃 Turn。
- 活跃 Turn 存在时，新消息按 capability 作为补充指令处理，或明确返回繁忙；不能启动第二个 Turn。
- 不同 Conversation 可以并行，Adapter 不使用 Agent 级全局串行锁代替会话锁。

### 7.3 重启恢复

- `platform-worker` 重启后从 Platform DB 恢复 Execution、outbox 和 Session 映射。
- Agent Pod 重启后复用原 PVC；Pod 就绪后，Adapter 必须使用已保存的原生 Session ID 恢复原 Session，并查询未完成 Turn 状态。
- 恢复成功后继续接收事件。恢复失败时保留原 Conversation 和 Session 映射，将服务标记为“暂时不可用”，并向用户给出可重试或联系 Owner 的说明。
- 恢复失败时禁止静默创建新 Session。只有用户明确新建 Platform Conversation 时才能创建新的 Runtime Session。

## 8. 消息、事件与 SSE 可靠性

### 8.1 消息幂等

- `platform-api` 以 `(conversationId, Idempotency-Key)` 唯一约束消息提交。
- 同一 Key 和相同消息、附件、模型选择再次提交时返回原 Message 与 Execution；同一 Key 对应不同内容时返回冲突。
- Message、初始 Execution 和 outbox 在同一数据库事务中创建。
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

### 9.1 逐 Turn 身份

`platform-api` 在消息提交时校验入口身份，`platform-worker` 在提交每个 Turn 前再次从服务端权威数据解析：

- 当前公司用户与组织状态。
- Agent、Conversation 和渠道绑定。
- Agent 可用范围与当前模型选项。
- 当前允许的 Connection Action 集合版本。

平台生成绑定用户、Agent、Conversation、Execution、Turn、渠道和 Action 集合版本的短期 Execution Grant。Agent Pod 只接收本次 Turn 所需的签名上下文；固定 env、浏览器字段和 Runtime 返回值都不能替代当前身份。

### 9.2 两个独立拒绝门

| 拒绝门 | 当前调用时校验 |
| --- | --- |
| Platform | 公司账号、Agent 可用范围、渠道、模型、Owner 允许的 Action、Execution Grant |
| Connection | Connection 归属或共享范围、用户授权、Action、外部账号、凭证状态和 Provider 权限 |

任一系统拒绝都终止调用。Platform 通过不代表 Connection 必须执行；Connection 也不能根据 Agent 提交的用户、Connection 或外部账号字段绕过自身校验。

Agent 只向 Platform Tool Gateway 提交 Action 和参数。Platform 根据 Execution 解析当前授权并调用 Connection API；Connection 注入凭证、执行和脱敏。原始凭证不进入 Agent Pod、Adapter 或模型上下文。

## 10. Pod 安全与网络

- Agent 使用独立 ServiceAccount，默认没有 Kubernetes RBAC 权限。
- NetworkPolicy 禁止 Agent Pod 访问 Platform DB、Connection DB、KMS/Secret Service 和 Kubernetes API。
- Agent Pod 只能通过明确允许的内部入口使用 Platform Tool Gateway、LLM Gateway、对象存储临时 URL 和必要基础服务。
- Platform 和 Connection 的数据库账号、服务身份及 Secret 不挂载到 Agent Pod。
- Owner Secret 只以 Agent 专属 Kubernetes Secret 注入，不进入 Workload annotation、日志、错误或 API 回显。
- Runtime 事件在写入 Platform DB 前必须移除模型内部思考、原始凭证和未脱敏请求。

## 11. 验证

- 四个标准模板运行同一 Conformance Suite：Session 创建/恢复、Turn、流式事件、停止、状态、capability、平台 Web/企微和 Connection。
- Generic ACP 自定义样例镜像在不增加平台专用代码的前提下通过同一核心测试。
- 负向测试覆盖未知协议、无交互入口、Manifest 不匹配、跨用户/Agent/Connection、重复消息、重复事件和同会话并发 Turn。
- `kind` 覆盖 Pod 重启恢复原 Session、恢复失败不新建 Session、旧 Digest 回滚、原 PVC 复用和 Adapter 不可达。
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
