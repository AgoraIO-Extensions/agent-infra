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
3. Runtime 内部实现遵循本文；Session、Turn、事件、幂等、恢复的完整契约和 Runtime Contract/Conformance 详细验证矩阵只在本文维护。

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
        +--读取已保存事件并 SSE 推送                         +--RuntimeHost Client
                                                            |
                                                            +--内部 HTTP/SSE--> Agent Service
                                                                                  |
                                                                                  v
                                                                      Agent Pod / RuntimeHost
                                                                                  |
                                                                      Runtime Driver --> Runtime

Agent Pod --Action + Execution Grant--> Platform Tool Gateway --> Connection API
```

- `platform-api` 解析入口身份并按命令路径原子保存：普通消息保存 Message、初始 Execution 和 Turn outbox；补充指令保存 Message 和绑定当前 Execution 的补充指令 outbox；重新生成复用已有 Message 并保存新的 Execution 和 Turn outbox；停止命令只保存绑定请求目标 Execution 的 stop outbox。它不直接调用 Agent Pod。
- `platform-worker` 认领 Execution，并通过 worker 侧 RuntimeHost Client Adapter 调用 Agent Service 的内部 HTTP/SSE Interface；worker 不启动 Runtime 子进程，也不加载 Native/ACP Driver。
- Agent Pod 内的 RuntimeHost 运行固定 Runtime Driver，将平台 Conversation/Execution 映射为 Runtime Session/Turn，并把原生事件归一化后返回；`platform-worker` 只把已经通过 fence 校验的规范化事件写回 Platform DB。
- `platform-api` 只把已经持久化且通过与历史读取相同的当前连接主体授权校验的事件推送给浏览器或渠道；初始补发和后续每次推送都不能只依赖 SSE 建连时的授权快照。账号权限、Agent 可用范围、渠道绑定或 Conversation 访问范围变化后，服务端必须关闭或暂停对应连接；继续推送前必须重新鉴权。
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

Registry 同时保存模板标识、当前镜像 Digest、Adapter 类型、Service/健康检查、capability 和 Owner 可配置的 env/Secret 键。每个模板的 `supplementaryInstruction` 只作为 capability 集合中的一个布尔键维护，不存在独立的第二声明源；缺失时按 `false` 处理，只有对应 Adapter 通过持久幂等 Conformance 后才能设为 `true`，不能按协议名称推断。Owner 不选择或覆盖标准模板的 Adapter，也不能提交 Registry 未声明的 env/Secret。

### 3.2 自定义 Agent

| `interactionMode` | 入口与数据归属 | M1 接入规则 |
| --- | --- | --- |
| `self-managed` | 镜像负责交互应用、协议、Session、事件和历史 | 不进入 Platform Conversation Contract；Owner 必须在自有身份入口和平台身份入口中选择一种，并只发布对应路由。自有身份入口由镜像服务端鉴权；平台身份入口必须经过 Auth Gateway，详见工程 Spec 14.3 |
| `platform-adapter` | 平台负责 Web/企微入口、身份、Conversation、Execution、事件和历史 | `protocol` 必须是 ACP，并通过 Generic ACP Conformance Suite |

`platform-adapter` Manifest 未声明 ACP 时创建失败或升级被拒绝；实际 ACP 兼容性在创建或升级的 Workload 启动后验证。M1 不为未知协议增加专用 Adapter。

`self-managed` 的应用接口由镜像负责，但 StatefulSet、Service、Ingress 和 NetworkPolicy 仍只由 `platform-worker` 调谐。自有身份入口不经过 Auth Gateway，也不获得可信平台身份或撤权上下文，账号生命周期由 Owner 的身份体系负责；平台身份入口必须经过 Auth Gateway。网络与鉴权细节见工程 Spec 14.3。

## 4. Runtime Manifest

自定义镜像通过固定 OCI Image Label `io.agora.agent.runtime.manifest` 提供 JSON Runtime Manifest。平台必须在解析前拒绝超过 64 KiB 的 UTF-8 Label，并使用最大嵌套深度为 8、能够检测重复键的 JSON Object 解析器读取；根对象或任意嵌套对象存在重复键时，在 Schema 校验前拒绝。M1 只接受整数 `schemaVersion: 1`，根对象以及 `service`、`health`、`capabilities` 对象中的未知字段均拒绝。实现阶段必须在 `packages/contracts` 维护与本节一致的版本化 JSON Schema，并以该 Schema 作为创建、升级和契约测试的机器校验入口。

| 字段 | 规则 |
| --- | --- |
| `schemaVersion` | 必填；M1 只接受整数 `1` |
| `interactionMode` | 必填；`self-managed` 或 `platform-adapter` |
| `protocol` | `platform-adapter` 必填且只能为 `acp`；`self-managed` 必须省略，出现时拒绝 |
| `service.port` | 必填；整数 `1..65535`，Agent Service 和健康检查使用的容器端口 |
| `health.path` | 必填；必须是以单个 `/` 开头的 origin-form 本地 HTTP 路径，其余字符只允许 ASCII 字母、数字、`/`、`.`、`_`、`~` 或 `-`；拒绝 `//`、`.` 或 `..` 路径段、反斜杠、`%` 编码、外部 URL、查询参数、片段、控制字符或凭证。平台使用校验后的原始路径和固定 Agent Service origin 构造探针请求，不再解码或规范化，且禁止跟随 HTTP 重定向 |
| `capabilities` | 可选 Object；只允许布尔值 `modelSelection`、`attachments`、`resultFiles`、`connection` 和 `supplementaryInstruction`，缺失键按 `false`；仅 `platform-adapter` 读取，`self-managed` 的声明忽略，不能据此开放 Platform Conversation、Connection 或 Tool Gateway 能力 |

Owner 不在产品页面填写协议、端口或探针。创建或升级时，Runtime 按以下顺序验证：

1. 读取并校验 Manifest Schema、字段约束和交互模式，以及创建时与 Owner 申请选择、升级时与当前 Agent 的一致性。
2. 候选 Runtime 健康后，对 `platform-adapter` 执行 Generic ACP 核心探测。
3. 核心探测通过后，再探测 Manifest 声明的可选 capability；平台展示能力取 Manifest 声明与实际探测结果的交集。

第一步失败时不请求部署候选 Runtime；核心探测失败时整个 Runtime 验证失败，可选 capability 探测失败时只把对应能力记为不支持。Base Image 可以提供生成辅助，但继承关系不赋予 capability 或准入资格。

候选修订、Workload、健康检查、路由切换、失败清理、PVC 和回滚机制只在工程 Spec 的[模板与自定义镜像升级](SPEC-agent-infra-M1-engineering-architecture.md#104-模板与自定义镜像升级)与[自定义 Agent Runtime Manifest](SPEC-agent-infra-M1-engineering-architecture.md#105-自定义-agent-runtime-manifest)中维护。

## 5. Platform Conversation Contract

Platform Conversation Contract 只定义以下语义，不暴露具体 Runtime 协议：

- 为 Platform Conversation 创建或恢复原 Runtime Session。
- 为新消息或重新生成创建 Execution、提交一个 Turn，并接收已接受、繁忙或拒绝结果。
- 停止当前 Turn，以及在 capability 支持时提交补充指令。
- 查询 Session 和 Turn 状态。
- 订阅并归一化文本、状态、工具、文件、完成和错误事件。
- 探测模型、附件、结果文件、Connection 和补充指令 capability。

`packages/agent-runtime` 实现 RuntimeHost 深 Module 和四个固定 Runtime Driver；`apps/agent-runtime-host` 只负责 Agent Pod 内的进程入口、依赖装配和 HTTP/SSE 接入。worker 侧 RuntimeHost Client Adapter 只依赖版本化 Host Contract，不依赖该 package 或任何 Native/ACP library。Agent Service 对 `platform-worker` 始终提供同一内部 HTTP/SSE Interface。

`platform-adapter` 自定义 Agent 的模型选择 capability 只表示 Generic ACP 可以读取 Runtime 当前提供的模型选项和默认项，并把使用者选择转交给 Runtime。选项内容、Base URL 和凭证属于自定义 Runtime；Owner 通过平台配置的相关 env/Secret 遵循工程 Spec 10.6 的通用规则，Adapter 不从 Runtime 的模型选项读取或保存凭证，也不把它们复制到标准模板模型配置。提交 Turn 前，Adapter 必须确认所选模型仍在 Runtime 当前返回的选项中；能力缺失或选项已失效时不展示或拒绝该选择，不能回退到其他模型后静默执行。

标准模板的有效补充指令能力取 Registry 声明与 Adapter Conformance 结果；`platform-adapter` 自定义 Agent 取 Manifest 声明与实际探测结果的交集。缺失、声明为 `false`、探测失败或不能保证 `messageId` 持久去重时都按不支持处理，只影响补充指令分支并返回繁忙，不使 Agent 创建失败。

## 6. 数据归属与标识

| 数据 | 权威位置 | 约束 |
| --- | --- | --- |
| Conversation、Message | Platform DB | 浏览器和 Channel 只使用平台 ID |
| Execution、回答版本 | Platform DB | 消息提交或重新生成重试不能产生重复 Execution |
| 规范化事件与 SSE 游标 | Platform DB | 先持久化，再对外推送 |
| RuntimeHost Session 引用 | Platform DB 的 Client Adapter 内部存储 | 保存不透明 Host Session Ref 和单调递增的 `sessionGeneration`，调用方不能解释或覆盖该引用 |
| Host Session 到原生 Session 的映射 | Agent PVC 上的 RuntimeHost 状态 | 只有对应 Driver 解释原生 Session ID；该 ID 不跨出 RuntimeHost |
| Runtime 工作区和原生 Session 数据 | Agent PVC | Runtime 自己解释，平台不读取内容 |

一个 Platform Conversation 最多映射一个当前 RuntimeHost Session Ref。创建 Conversation 时，Platform DB 原子初始化 `sessionGeneration = 1` 和“Host Session 未创建”状态；RuntimeHost 创建或恢复 Session 时在 PVC 中维护该引用到原生 Session 的映射，worker 只持久化和回传不透明引用。首个及后续 outbox 在创建时保存当前代次。浏览器、Channel、自定义镜像和 Connection 请求都不能提交或覆盖 Host Session Ref、原生 Session ID 或代次。

企微群聊的 Channel 会话键必须包含服务端解析的 `actorId`，且调用方不能提交或覆盖 `actorId`。不同发送者映射到不同 Platform Conversation 和 Runtime Session；消息、历史、SSE、附件和结果文件的读取都必须在服务端校验当前 `actorId` 与目标 Conversation 的绑定关系。群内公开展示只允许当前群和 Agent 授权范围内显式标记为群内公开的事件，不得暴露其他发送者的 Conversation 或 Runtime 上下文。

## 7. Session、Turn 与恢复

### 7.1 Session 生命周期

1. 首个 Execution 由 RuntimeHost Driver 创建 Runtime Session；RuntimeHost 在 PVC 中持久化 Host Session Ref 到原生 Session 的映射，worker 侧 Client Adapter 只保存 Conversation 到不透明 Host Session Ref 的映射。
2. 后续 Execution 必须恢复同一个 Session，不能以新 Session 代替恢复。
3. Conversation 关闭或 Agent 停用时，Adapter 可以关闭原生 Session；M1 不向用户提供删除 Conversation。

### 7.2 并发

- 同一 Conversation 同时只允许一个活跃 Turn。
- 初始 Execution 与 Turn outbox 的事务提交后即视为活跃，包含 Turn 尚未投递、Runtime 是否接受暂时不确定和 Runtime 正在执行的阶段，直到 Execution 进入成功、失败或取消等终态。
- 活跃 Turn 存在时，只有与当前 Execution 相同 `actorId` 的新消息可以按 capability 作为补充指令处理；同一发送者不支持补充指令或不同 `actorId` 提交消息时，平台明确返回繁忙。任何新消息都不能启动第二个 Turn。
- 不同 Conversation 可以并行，Adapter 不使用 Agent 级全局串行锁代替会话锁。

### 7.3 重启恢复

- `platform-worker` 重启后从 Platform DB 恢复 Execution、outbox 和不透明 Host Session Ref。
- Worker 的 Runtime 调用、Adapter 恢复查询、规范化事件和 Execution 状态写入必须携带 outbox 保存的 `sessionGeneration` 与当前 Execution `deliveryFence`；补充指令和 stop 调用还分别携带自身的 `messageId` fence 或 `stopRequestId` fence。Platform DB 对规范化事件按 8.2 的重复事件优先规则处理，仅允许当前 Conversation 代次和相应 fence 产生新事件或状态写；Agent Service、Runtime Host 或 Bridge 在 PVC 中按 Session 和投递标识持久化已见的最高 token，并拒绝更低 token 的迟到调用。
- Agent Pod 重启后复用原 PVC；Pod 就绪后，RuntimeHost 必须使用已保存的 Host-to-native Session 映射恢复原 Session，并查询未完成 Turn 状态。
- 恢复成功后继续接收事件。恢复失败时，`platform-worker` 必须先在 Conversation 锁内保持当前 `sessionGeneration`，将 Conversation 标记为“代次隔离中”，暂停新命令和业务 outbox，并持久化携带目标代次的内部 generation tombstone；当前代次在隔离期间已被 Agent Service 接受的调用、事件和状态仍按原规则保存，不能形成不可见执行。Agent Service 必须幂等持久化并激活目标代次的 cancellation barrier，拒绝新的旧代次调用，并等待或取消已接受的旧代次调用，直到它们不能再产生 Runtime 副作用、事件或状态后才确认 tombstone。只有收到该确认后，Worker 才能再次取得 Conversation 锁，原子提升 `sessionGeneration`、将 Conversation 标记为“会话不可用”，并把活跃 Execution 和业务 outbox 置为带可审计原因的失败终态；Platform DB 从该事务提交起拒绝旧代次的事件和状态写。任一步失败或 Worker 重启都从持久化状态重试；Agent Service 未确认时保持“代次隔离中”，不能恢复业务投递或创建新 Session。当前 Host Session Ref、Host-to-native 映射和平台历史保留只读，其他 Conversation 和 Agent 服务保持正常。
- 恢复失败时禁止静默创建新 Session。只有用户明确新建 Platform Conversation 时才能创建新的 Runtime Session。

## 8. 消息、事件与 SSE 可靠性

### 8.1 消息与命令幂等

- `platform-api` 先按服务端命令入口确定不依赖 Conversation 状态的 `commandType`，再在同一 Conversation 数据库锁内优先执行幂等查询；仅未命中时才查询活跃 Execution，完成普通消息/补充指令/重新生成/繁忙分支判定及对应写入，提交事务后才释放锁。stop 命令复用同一把锁。两个并发请求都不能基于“无活跃 Execution”的旧快照各自创建 Execution。
- 所有会调用 Runtime 的 outbox 使用 Platform DB 中的 durable lease，至少保存 `leaseOwner`、`leaseExpiresAt` 和操作作用域内单调递增的 `deliveryFence`。初始 Turn 使用 `executionId` 作用域的 Execution fence，stop 使用 `stopRequestId` 作用域的独立 fence，每条补充指令使用 `messageId` 作用域的独立 fence。Worker 通过条件更新认领或续租；首次认领和租约到期后的重新认领只提升对应作用域的 fence。stop 认领不得提升 Execution fence；已被 Runtime 接受的 Turn 在停止确认前继续以当前 Execution fence 写入事件和真实终态。只有 Turn lease 接管或本地取消屏障可以提升 Execution fence；租约过期后旧 Worker 的 Runtime 调用、事件和状态写入必须被 Agent Service 与 Platform DB 拒绝，不能仅凭进程内“正在处理”状态判断所有权。
- 新消息和重新生成请求必须携带非空 `Idempotency-Key`，值只允许 `1..128` 个 ASCII 字母、数字、`.`、`_`、`~` 或 `-`，并作为区分大小写的不透明字符串处理。浏览器为一次逻辑提交生成 Key 并在传输重试时复用；Channel 层从可信渠道消息 ID 派生符合该格式的稳定 Key。`platform-api` 在任何写入前拒绝缺失或格式无效的 Key；新消息入口使用 `commandType = message`，重新生成入口使用 `commandType = regenerate`，并以非空字段建立 `(conversationId, actorId, commandType, Idempotency-Key)` 唯一约束。补充指令不是调用方选择的独立命令类型，而是 `message` 请求在锁内根据当前活跃 Execution 得出的处理结果。`actorId` 和 `commandType` 均由服务端生成，不能接受调用方提交或覆盖。
- 幂等重放必须在查询活跃 Execution 和判定处理分支前，使用上述完整元组查找已保存结果。同一 `actorId` 和 `commandType` 下，同一 Key 和相同请求内容再次提交时，`message` 返回首次提交保存的 Message，以及原初始 Execution 或原补充指令绑定的 Execution；`regenerate` 返回原新建 Execution。重放不能根据已经变化的活跃状态重新判定分支。同一 Key 对应不同内容时返回冲突；不同 `actorId` 或 `commandType` 的 Key 独立生效。
- 没有活跃 Turn 时，Message、初始 Execution 和 Turn outbox 在同一数据库事务中创建。
- 重新生成只允许在没有活跃 Turn 时发起。`platform-api` 校验 `sourceMessageId` 属于当前用户有权访问的 Conversation 且指向已有用户 Message，并在同一事务中创建引用该 Message 的新 Execution 和 Turn outbox，不创建新 Message；旧回答版本继续保留。Adapter 在当前 Runtime Session 中为新 Execution 提交 Turn。重新生成使用 `commandType = regenerate` 的上述唯一约束；相同 Key 和 `sourceMessageId` 返回原新建 Execution，同一 Key 指向其他 Message 时返回冲突。存在活跃 Turn 时返回繁忙且不创建记录。
- 活跃 Turn 存在、发送者 `actorId` 与当前 Execution 相同且 Adapter 支持补充指令时，只创建 Message 和绑定当前 Execution 的补充指令 outbox，不创建新的 Execution 或 Turn；`messageId` 是 Adapter 提交该补充指令的稳定幂等标识。
- Adapter 只有在原生协议提供持久幂等结果，或 Pod 内 Agent Service、Runtime Host 或 Bridge 能按 `messageId` 持久去重并恢复原提交结果时，才能声明补充指令 capability。Worker 或 Pod 重启后重复提交同一 `messageId` 必须返回原结果且不能再次追加；不能满足该约束的 Runtime 不开放补充指令。
- 补充指令 outbox 只有在绑定 Execution 的初始 Turn 已被 Runtime 明确接受后才能投递；初始 Turn 尚未投递或接受结果不确定时保持待处理。同一 Execution 的补充指令按 outbox 创建顺序串行投递，不能抢在初始 Turn 前调用 Runtime。若初始 Execution 在 Runtime 明确接受前进入失败或取消终态，`platform-worker` 必须在同一 Conversation 锁内将其全部待处理补充指令 outbox 置为失败终态，并将对应 Message 标记为“投递失败：原回复未开始”；不得继续重试、创建新 Execution 或改绑其他 Execution。
- `platform-worker` 认领补充指令 outbox 时，先按工程 Spec 的[权限顺序](SPEC-agent-infra-M1-engineering-architecture.md#92-权限顺序)重新解析该 `actorId` 的当前授权，再在 Conversation 锁内重验绑定 Execution。权限已失效时，平台在同一数据库事务中将 outbox 置为失败终态、将 Message 标记为“投递失败：权限已失效”，且不调用 Adapter；Execution 已终止时，同样将 outbox 置为失败终态并将 Message 标记为“投递失败：原回复已结束”。只有权限仍有效且 Execution 仍活跃时，平台才签发符合工程 Spec 的新短期 Execution Grant 并按 `messageId` 提交。Adapter 必须拒绝已经终止的原生 Turn。失败后不能自动重试、创建 Execution/Turn 或改绑其他 Execution；同一 Idempotency-Key 重放仍返回该失败 Message 和原绑定 Execution，用户重新发送时使用新 Key 并重新执行准入分支。
- 同一发送者不支持补充指令或不同 `actorId` 提交消息时，平台返回繁忙且不创建 Message、Execution 或 outbox。普通消息、补充指令、重新生成和繁忙分支的判定与写入必须原子完成。
- 使用者停止命令必须携带 `targetExecutionId`，且不创建 Message 或新 Execution。`platform-api` 在 Conversation 锁内校验目标 Execution 属于该 Conversation、发送者 `actorId` 与目标 Execution 相同，并原子创建绑定目标 Execution、来源为使用者的 stop outbox；每个 Execution 只有一个有效 stop outbox 和平台生成的稳定 `stopRequestId`，相同 `targetExecutionId` 的重复 HTTP 请求返回已有停止状态。目标 Execution 已经终止时幂等返回“已结束”；即使另一个 Execution 已经活跃，也不能把旧请求改绑到它。其他发送者无权停止且不创建 outbox。
- `platform-worker` 认领使用者来源的 stop outbox 时，先按工程 Spec 的[权限顺序](SPEC-agent-infra-M1-engineering-architecture.md#92-权限顺序)重新解析该 `actorId` 的当前授权，再在 Conversation 锁内重验目标 Execution。授权仍有效时，只有目标 Execution 属于该 Conversation、发送者 `actorId` 与目标 Execution 相同，且初始 Turn 已被 Runtime 接受并仍活跃，才携带当前 Execution fence 和独立 `stopRequestId` fence 调用 Adapter；该调用及 stop outbox 回写校验两个 fence，但不改变 Execution fence。目标已经终止时将 outbox 置为成功终态。身份或权限依赖暂时不可用时保持待处理并重试，不能调用 Adapter 或把未知状态写成失败终态。
- 公司账号被服务端确认禁用时，平台必须独立于使用者请求，为该 `actorId` 的全部活跃 Execution 幂等创建平台来源的 stop outbox；若仅有某个 Agent 的可用范围或某个渠道的权限被撤销，则只为服务端保存的 Agent 或渠道授权上下文受该撤权事实影响的活跃 Execution 创建 outbox。已有使用者来源 outbox 时复用其 `executionId` 和 `stopRequestId` 并把停止依据提升为平台确认的撤权事实。使用者命令本身不再提供调用权限，Worker 只根据平台来源、服务端撤权记录和目标 Execution 当前状态执行控制操作，不重新要求已撤权用户具备权限。初始 Turn 尚未被 Runtime 接受时按下一条规则本地取消；已接受且仍活跃时调用 Adapter，Adapter 或恢复查询确认停止后才把 Execution 置为“已取消：权限已失效”；Runtime 已经终止时保留其实际终态并完成 outbox。已经提交给外部 Provider 的操作不自动撤回。Adapter 和 Agent Service 把同一 `stopRequestId` 的重复停止视为同一命令。
- 初始 Turn 调用 Runtime 前，`platform-worker` 必须在 Conversation 锁内重验同一 Execution 没有 stop outbox，并在同一事务中取得 Turn durable lease、提升 Execution fence，再把 Turn outbox 从待投递原子迁移为“投递中、接受结果不确定”；事务提交并释放锁后才能携带当前 Execution fence 调用 Adapter。若迁移前已有 stop 且 Runtime 明确未接受初始 Turn，Worker 在同一事务中取消待投递的 Turn outbox、把 Execution 置为“已取消”、把 stop outbox 置为成功终态，并按前述规则结束全部待处理补充指令，不调用 Adapter，初始 Turn 后续不得再投递。Turn outbox 已进入“投递中、接受结果不确定”时，stop outbox 保持待处理且不提升 Execution fence；当前 Turn Worker 先按原 `executionId` 和 Execution fence 恢复查询。Turn 租约过期或释放后，接管 Worker 必须提升 Execution fence 并以新 fence 恢复事件管道；只有 Runtime 明确未接受且 Agent Service 已持久化新 fence 的 cancellation barrier、阻止旧 Worker 迟到提交时才能本地取消，无法确认时继续保持接受结果不确定。
- `executionId` 是 Adapter 提交 Turn 的稳定幂等标识。协议不能确认是否已接受 Turn 时，Adapter 将 Execution 标记为状态不确定并恢复查询，不能盲目重复提交。

### 8.2 事件去重

- 每个 Adapter 必须为原生事件提供跨重连稳定的 `adapterEventKey` 和可持久化的 Runtime 事件恢复游标。优先使用 Runtime 提供的持久事件 ID；若 Runtime 不提供稳定 ID 和重放，则 Pod 内的 Runtime Host 或 Bridge 必须在首次转发前持久化事件日志并分配单调事件 ID，保留未确认事件并支持按该 ID 重放。禁止使用重连后可能重置或重新分块的流内序号派生。
- Platform DB 对 `(executionId, adapterEventKey)` 建立唯一约束，并在处理事件时先查找该键。已保存的重复事件直接返回原 `eventId`、`sequence` 和 `conversationCursor`，不再次写入或推进游标；只有新事件才校验当前 `sessionGeneration` 和 `deliveryFence`，旧 token 产生的新事件或状态写必须拒绝。新事件首次插入成功时，平台通过 Conversation 锁或等价的数据库原子序列机制，在同一事务中保存事件、推进该 Execution 的已确认 Runtime 事件游标，并分配稳定 `eventId`、Execution 内递增 `sequence` 和 Conversation 内严格递增 `conversationCursor`；事务失败或 token 过期不产生可见事件、游标推进或平台确认。
- Worker 只能在上述事务提交后向 Runtime Host、Bridge 或原生 Runtime 确认已处理游标。Runtime 事件连接中断、Worker/Pod 重启或事件事务失败时，Adapter 从 Platform DB 最后已确认游标重放；事务已提交但 Runtime 确认前崩溃会产生可去重的重放，不能丢失事件。浏览器 SSE 连接状态不得推进该 Runtime 游标。
- 跨 Execution 或迟到的首次事件按实际持久化顺序追加。重复事件返回已有平台事件及原 `sequence` 和 `conversationCursor`，不能重新分配游标。
- 高频文本可以在同一事务中批量持久化，但不能合并原生事件边界。批次内每个原生事件保留稳定 `adapterEventKey`，按原始顺序独立生成平台事件及游标；事务提交前不能推送内容，重试同一批次必须返回已保存事件及原游标，不能重复追加文本或改变最终文本顺序。

### 8.3 SSE 补发

- SSE 的 `id` 字段和浏览器重连时的 `Last-Event-ID` 都使用稳定 `eventId`。`platform-api` 必须先在当前用户有权访问的 Conversation 内查询该 `eventId` 对应的 `conversationCursor`，再按游标补发其后的已保存事件；显式游标请求直接使用 `conversationCursor`，并执行相同的 Conversation 权限校验。未知、超出补发窗口或属于其他 Conversation 的 `eventId` 或游标统一返回“重新加载时间线”信号。
- 实时补发受服务端配置的数量和时间窗口限制，避免单次重连无限读取。
- 游标超出补发窗口时，服务端返回明确的“重新加载时间线”信号；客户端先读取 Platform DB 中的持久化历史，再从新的游标继续 SSE。补发窗口不改变业务数据保留期限。

## 9. Runtime 身份上下文

身份解析、Execution Grant、Connection 双重授权和自有交互入口的 Auth Gateway 以工程 Spec 的[服务端授权上下文](SPEC-agent-infra-M1-engineering-architecture.md#93-服务端授权上下文)、[Connection 架构](SPEC-agent-infra-M1-engineering-architecture.md#13-connection-架构)和[自有交互入口](SPEC-agent-infra-M1-engineering-architecture.md#143-自有交互入口)为唯一权威。Runtime 和 Adapter 只消费这些边界：

- 每个 Turn 和每条补充指令只接受本次投递新签发的短期 Execution Grant。固定 env、浏览器字段和 Runtime 返回值都不能替代当前身份或扩大 Grant 范围。
- Runtime 只向 Platform Tool Gateway 提交 Action 和参数，不接收 Connection 原始凭证；Platform 或 Connection 任一方拒绝都终止调用。
- `self-managed` 使用平台身份入口时，自定义 Agent 服务端只信任 Auth Gateway 传递的短期签名上下文并负责校验；浏览器身份字段不能改变最终身份。该上下文不创建 Platform Conversation、Execution 或 Execution Grant。

## 10. Runtime 安全约束

Agent Pod 的 ServiceAccount、网络隔离、出站范围、Secret 注入和运行时权限以工程 Spec 的[安全基线](SPEC-agent-infra-M1-engineering-architecture.md#17-安全基线)为唯一权威。Runtime 和 Adapter 不能要求超出该基线的数据库、KMS、Kubernetes 或原始凭证权限作为运行前提。

Runtime 事件遵循工程 Spec 的[事件保存](SPEC-agent-infra-M1-engineering-architecture.md#123-事件保存)与脱敏边界。

## 11. 验证

- 四个标准模板运行同一 Conformance Suite：Session 创建/恢复、Turn、流式事件与按已确认游标重放、停止、状态和 capability。
- Generic ACP 自定义样例镜像在不增加平台专用代码的前提下通过同一核心测试。
- 负向测试覆盖未知协议、无交互入口、Manifest Label 缺失或超过 64 KiB、JSON 嵌套超过 8 层、未知或重复字段、非 `1` 的 Schema 版本、`self-managed` 声明 `protocol`、非法 capability 结构、Registry 从 capability 外重复声明 `supplementaryInstruction`、创建或升级时 Owner 选择与 Manifest 交互模式不匹配、升级 Manifest 的无效 Service/健康检查、`health.path` 使用 `//`、`.` 或 `..` 路径段、反斜杠、`%` 编码、非允许字符、外部 URL、查询参数、片段、控制字符或凭证，以及健康探针返回 HTTP 重定向、调用方伪造或覆盖 `actorId`、使用另一发送者的 Conversation 查询消息、历史、SSE、附件或结果文件、群内公开事件暴露其他发送者的 Conversation 或 Runtime 上下文、不同发送者向活跃 Turn 追加指令或停止回复、缺失或非法 `Idempotency-Key`、同一 Key 跨命令类型复用时误命中其他操作、普通消息响应丢失后因活跃状态变化把重试误判为补充指令或繁忙、两个请求同时进入空闲 Conversation、初始 Turn 未投递时提交补充指令、初始 Turn 接受前失败或取消后的补充指令收敛、补充指令投递前发送者失去权限、补充指令使用过期或扩大范围的 Grant、补充指令提交后目标 Turn 先结束、补充指令重试或 Worker/Pod 重启后重复追加、补充指令 capability 缺失或为 `false`、声明后探测失败、不具备持久去重却声明补充指令 capability、重新生成重复创建 Message 或 Execution、活跃 Turn 上重新生成、旧 stop 请求改绑后续 Execution、使用者停止投递前失去权限后转换为平台撤权停止、没有使用者停止请求时平台主动中止撤权用户的活跃 Execution、身份依赖暂时不可用时不误判撤权或调用 Adapter、检查 stop 后到调用 Runtime 前的并发停止、Turn lease 到期后旧 Worker 迟到提交或回写、接管 Worker 未完成高 fence 取消标记、Turn outbox 原子迁移后 Worker 崩溃、stop outbox 丢失或重复停止、stop 认领后已接受 Turn 的在途事件或真实终态被拒绝、Session 恢复失败后旧代次调用、事件或终态迟到、generation tombstone 重试、繁忙拒绝后创建记录、重复消息、旧 fence 重放已保存事件时重复写入、旧 fence 产生未保存的新事件、双 Worker 并发保存同一 Conversation 事件、Runtime 事件已转发但事务未提交时断线、事务提交后上游确认前崩溃、Worker/Pod 重启后按已确认游标重放、跨 Execution 迟到事件和同会话并发 Turn。可选补充指令探测失败时，Agent 仍创建成功且有效 capability 为 `false`；活跃 Turn 上返回繁忙，不创建 Message、Execution 或 outbox。
- generation fencing 故障注入覆盖隔离意图提交后 tombstone 尚未激活、Agent Service 激活后 Platform DB 尚未提升代次、两个阶段之间 Worker 重启、tombstone 重复投递和 Agent Service 暂时不可用；任何路径都不能接受新命令、丢弃已接受旧调用的可见结果、在 barrier 确认后产生旧代次副作用，或在确认前提升平台代次。
- `kind` 覆盖 Pod 重启恢复原 Session；用两个 Conversation 验证恢复失败不新建 Session，且不影响另一会话。
- SSE 覆盖持久化后推送、批量事务重试、重复事件、`Last-Event-ID` 到 `conversationCursor` 的会话内映射、显式游标、窗口内补发、建连后账号权限、Agent 可用范围、渠道绑定或 Conversation 访问范围变化时停止推送并在恢复前重新鉴权，以及未知、属于其他 Conversation 或超出窗口的事件和游标重载时间线。

## 12. RuntimeHost 未来抽取与维护标准

RuntimeHost 在 M1 中是 Agent Infra 的内部深 Module，同时作为未来可能抽取的开源库候选维护。这个方向用于约束当前依赖、Interface 和验证质量，不构成 M1 必须建立独立仓库、发布公共 package、接受外部贡献或提供公共兼容承诺的验收项。是否抽取必须由后续独立 Issue 和 ADR 决定。

### 12.1 Module、Interface 与依赖方向

- `apps/agent-runtime-host` 保持薄入口，只处理进程启动、依赖装配、配置读取和 HTTP/SSE 协议接入；Runtime 生命周期、Session mapping、Driver 选择、事件归一化、fence、恢复和错误语义属于 `packages/agent-runtime`。
- worker-facing HTTP/SSE 是外部 Seam。其 Interface 只包含平台 ID、命令、经过当前 Execution Grant 授权且按 Runtime 输入 Schema 校验的用户内容或短期附件引用、fence、capability、状态和规范化事件。Host 不通过引用回读 Platform DB 或 Connection DB；附件引用只允许访问当前 Agent、Conversation 和 Execution 绑定的对象，过期、越界或绑定不匹配时拒绝。Native Session ID、stdio、ACP method、vendor 配置对象和原生事件不能跨出 RuntimeHost。
- Runtime Driver 是内部 Seam。Codex Native、Claude Native、Generic ACP 和 Pi RPC Driver 满足同一个小型 Interface；Driver 只能由已部署且校验通过的标准模板 Registry 或自定义 Agent Manifest 固定绑定，不能由请求方选择或覆盖。上游差异只能留在对应 Adapter 内，不能通过条件分支扩散到 Host Client 或产品调用方。
- `packages/agent-runtime` 只能依赖 Node.js/TypeScript 标准能力、经过批准且版本固定的 runtime/protocol library，以及 `packages/contracts` 中的 Host/Driver 契约。它不能依赖 `platform-core`、`platform-store`、`identity`、Connection Module、`kubernetes-runtime`、Web/Channel 或应用入口。
- 平台身份和 Connection 授权在 RuntimeHost 外解析；Host 只消费当前调用附带的版本化短期 Grant 和已裁剪 capability，不能读取企业目录、Platform DB、Connection DB、KMS 或 Kubernetes API。

### 12.2 独立维护质量

- RuntimeHost Interface 与 Driver Interface 使用版本化 Schema，并为 accepted/busy/rejected/unknown、取消、权限、终态、恢复失败和不支持 capability 定义稳定且可测试的错误语义。M1 内部版本可以演进，但变更必须更新消费者、Schema 和 conformance，不能依赖调用方解析日志文本。
- Conformance 通过同一 Interface 运行 Fake Driver 和每个真实 Driver；fixture 必须脱敏、自包含、可离线重放，不依赖 Platform DB、公司身份服务、真实企业凭证或个人工作目录。
- 每个 Driver 记录精确的上游 package/CLI 版本、生成 Schema 的来源 commit、已验证 capability 和兼容矩阵。标准镜像使用 frozen lockfile 和不可变 Digest，不在启动时解析 `latest` 或下载依赖。
- 第三方依赖必须保留 license、NOTICE、生成物 provenance 和 SBOM 所需信息。RuntimeHost 源码、测试、日志、错误和 fixture 不得包含 Token、API Key、OAuth Secret、普通用户会话正文或本机绝对路径。
- Module 文档应让不熟悉 Agent Infra 产品层的维护者只通过 Host/Driver Interface、生命周期和 conformance 理解 Runtime 行为；平台专有授权、outbox 和产品状态只作为外部调用约束引用，不复制进 Runtime core。

### 12.3 M1 非目标

- M1 不创建独立开源仓库，不发布公共 npm package，不选择开源 license，也不承诺公共 SemVer 或跨仓支持周期。
- M1 不为未来开源增加本机 Desktop daemon、通用远程 daemon、ContainerLauncher、调度器、warm pool、动态 Driver/plugin registry 或任意 persistence/transport 抽象。
- M1 不因为潜在抽取而改变 PRD、四个标准模板、Platform/Connection 授权、Kubernetes 部署、平台历史权威或现有验收范围。
- 只有出现 Agent Infra 以外的真实 consumer、内部 Interface 经多个上游升级保持稳定，并完成独立安全、维护和供应链评审后，后续决策才能批准抽取。

## 13. 参考与非目标

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
