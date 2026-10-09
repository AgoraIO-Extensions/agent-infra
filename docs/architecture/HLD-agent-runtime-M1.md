# Agent Runtime M1 HLD

| 项目 | 内容 |
| --- | --- |
| 状态 | Draft for Review |
| 适用范围 | Agent Platform M1 Runtime 与 Adapter |
| 上位文档 | [企业级 Agent 平台 M1 产品需求](../prd/PRD-agent-platform-M1.md)、[M1 工程架构 Spec](SPEC-agent-infra-M1-engineering-architecture.md) |

## 1. 文档边界与依据

本文细化 M1 Agent Runtime 的 Registry、Adapter、Manifest、Conversation、Session、Turn、事件和恢复契约，以及任务 API、真实执行观测、必要审计和 Eval 复用在这些边界上的约束。权威顺序如下：

1. 产品行为以 Agent Platform PRD 为准。
2. 部署单元、数据归属、身份和 Connection 边界以 M1 工程架构 Spec 为准。
3. Runtime 内部实现遵循本文；Session、Turn、事件、幂等、恢复的完整契约和 Runtime Contract/Conformance 详细验证矩阵只在本文维护。

相关 Issue 只记录决策来源和交付状态，不覆盖正式文档：

- [Issue #3 补充决策](https://github.com/AgoraIO-Extensions/agent-infra/issues/3#issuecomment-5279882787)与[标准模板 env/Secret 更新](https://github.com/AgoraIO-Extensions/agent-infra/issues/3#issuecomment-5354328551)：镜像、Digest、env/Secret、升级和回滚边界。
- [Issue #134](https://github.com/AgoraIO-Extensions/agent-infra/issues/134)：Runtime/Adapter 契约来源。
- [Issue #135](https://github.com/AgoraIO-Extensions/agent-infra/issues/135)：本文与上位文档的对齐任务。

## 2. 运行结构

```text
Web / 用户与应用 API / 企微回调
        |
        v
Platform API --事务写入--> Platform DB <--认领 outbox-- Platform Worker
        |                                                   |
        +--读取已保存事件并 SSE 推送                         +--RuntimeHost Client
                                                            |
                                                            +--内部 HTTP/SSE--> Agent Service
                                                                                  |
                                                                                  v
                                                                      Sandbox Pod / RuntimeHost
                                                                                  |
                                                                      Runtime Driver --> Runtime

企微智能机器人 <--长连接--> Platform Worker --同一 Core 事务--> Platform DB

Agent / Client --Connection 独立身份--> Connection MCP/API --> External Provider
```

- `platform-api` 解析 HTTP/Web/回调入口的可信用户/应用身份；企微长连接由 `platform-worker` 解析可信发送者并调用同一 Core 准入事务，传输边界见[工程 Spec §14.2](SPEC-agent-infra-M1-engineering-architecture.md#142-企微)。API 任务按 8.4 持久受理，以下 Web/托管渠道命令按各自路径原子保存：普通消息保存 Message、初始 Execution 和 Turn outbox；补充指令保存 Message 和绑定当前 Execution 的补充指令 outbox；重新生成复用已有 Message 并保存新的 Execution 和 Turn outbox；停止命令只保存绑定请求目标 Execution 的 stop outbox。两类入口都不能绕过 outbox 直接调用 Agent Pod。
- `platform-worker` 只投递 Platform Dispatch 按 7.2/8.4 准入的 Execution，并通过 worker 侧 RuntimeHost Client Adapter 调用 Agent Service 的内部 HTTP/SSE Interface；worker 不启动 Runtime 子进程，也不加载 Native/ACP Driver。
- 所属 Sandbox Pod 内的 RuntimeHost 运行固定 Runtime Driver，将平台 Conversation/Execution 映射为 Runtime Session/Turn，并把原生事件归一化后返回；`platform-worker` 只把已经通过 fence 校验的规范化事件写回 Platform DB。
- `platform-api` 向浏览器/API 订阅者推送事件，`platform-worker` 通过企微 Adapter 回复渠道消息；两者只输出已经持久化且通过当前接收主体授权与访问范围校验的结果。浏览器/API 事件遵循与历史读取相同的授权；初始补发和后续每次推送都不能只依赖 SSE 建连时的授权快照。当前主体权限、API 凭证、Agent 可用范围、渠道绑定或 Conversation 访问范围失效后，服务端停止该主体的输出并关闭或暂停其专属订阅；单个发送者撤权不关闭其他主体共用的机器人长连接。机器人绑定整体失效时才停止对应渠道连接；继续输出前必须重新鉴权。
- Sandbox Pod 保存本 Session 的 Runtime 自有工作区和数据，但不保存平台权威会话或授权。

## 3. Runtime Registry 与交互模式

### 3.1 标准 Runtime

M1 Driver Registry 是平台维护的固定配置，不支持运行时 Driver 插件发现。Skill Provider Registry 是独立的受控来源目录，按工程 Spec §11.6 固定顺序聚合 Provider；Provider 不能由 Skill、Owner、浏览器或 Runtime 动态注册。

| 标准模板 | Platform Adapter | `driver` | 补充指令 | M1 平台能力 |
| --- | --- | --- | --- | --- |
| Codex | Codex Native | `codex` | Registry 显式声明并通过 Conformance | Web/API、企微、模型、附件/结果、Connection、Browser Capability、真实模型/工具观测与 Eval 复用 |
| Claude | Claude Native | `claude` | Registry 显式声明并通过 Conformance | Web/API、企微、模型、附件/结果、Connection、Browser Capability、真实模型/工具观测与 Eval 复用 |
| OpenCode | Generic ACP | `acp` | Registry 显式声明并通过 Conformance | Web/API、企微、模型、附件/结果、Connection、Browser Capability、真实模型/工具观测与 Eval 复用 |
| Pi | Pi RPC | `pi` | Registry 显式声明并通过 Conformance | Web/API、企微、模型、附件/结果、Connection、Browser Capability、真实模型/工具观测与 Eval 复用 |

Registry 同时保存模板标识、当前镜像 Digest、Adapter 类型、Service/健康检查、capability 和 Owner 可配置的 env/Secret 键。每个模板的 `supplementaryInstruction` 只作为 capability 集合中的一个布尔键维护，不存在独立的第二声明源；缺失时按 `false` 处理，只有对应 Adapter 通过持久幂等 Conformance 后才能设为 `true`，不能按协议名称推断。Owner 不选择或覆盖标准模板的 Adapter，也不能提交 Registry 未声明的 env/Secret。

标准模板的部署维护绑定为 `(templateId, imageDigest, driver, protocol)`。`driver` 必填，
只接受上表的 `codex | claude | acp | pi`，不接受测试 Driver `fake`。该绑定由平台维护的
Registry 和经准入的模板发布产生；Worker 按持久 candidate 的标准来源，以模板标识与
已准入的不可变镜像 Digest 唯一匹配，并同时校验 Driver 与模型协议/profile 一致。
缺失、未知、重复或歧义、模板/镜像不匹配及 Driver/profile 不符均拒绝，不按模型协议、
模板名称、镜像内安装包或原生响应推断 Driver。

Worker 将同一候选绑定的 `driver` 交给原标准 Pod renderer，生成平台保留环境变量
`AGENT_INFRA_RUNTIME_DRIVER`，与原镜像 Digest 和版本化模型配置共同交付。Owner 的请求、
env/Secret、模型配置或 Skill 不能提供或覆盖 selector；Host 保留缺失/无效 selector 的拒绝，
不设置默认 Driver。自定义/self-managed 和未配置部署遵循原边界，不从空绑定选择标准 Driver。

同一已接纳模板标识和 Digest 的 Driver 不得静默变化。Driver 变更须经过已有模板/镜像发布、
配置修订和升级/恢复约束，不得热切 active/unknown Session；升级、回滚与会话控制仍遵循
[工程 Spec §10.4](SPEC-agent-infra-M1-engineering-architecture.md#104-模板与自定义镜像升级)
和本文的恢复契约。

标准 Runtime 的 active 配置只包含获准 Relay endpoint、模型、reasoning 和 Driver 能力，不含个人或 Agent 默认 Relay Key。Worker 按 Execution 从其已固化的 Key 版本解密，经受认证的私有接口交付本次 Key；Host/Driver 仅在该执行内存中使用，不能跨用户或执行复用。模板只有真实镜像、Driver 和模型链路各自验证后才标记就绪；未就绪时目录显示原因并拒绝申请。权威配置与迁移边界见工程 Spec 10.7；RuntimeHost 不读取 ModelCatalog、SecretRef、Platform DB 或部署解密 keyring。

标准模板的模型协议与原生 Driver 协议是不同边界。Codex Native 当前消费 Responses，Claude
Native 与 OpenCode 的 Generic ACP 模板消费 Messages；支持某种原生协议不能证明模型端点可用。Host 只消费 Worker 已验证的
版本化配置并校验它与部署固定 Driver 绑定一致；profile 的来源、认证、版本兼容和候选回滚
统一遵循工程 Spec 的[标准模板模型配置](SPEC-agent-infra-M1-engineering-architecture.md#107-标准模板模型配置)。

### 3.2 自定义 Agent

| `interactionMode` | 入口与数据归属 | M1 接入规则 |
| --- | --- | --- |
| `self-managed` | 镜像负责交互应用、协议、Session、事件和历史 | 不进入 Platform Conversation Contract；Owner 必须在自有身份入口和平台身份入口中选择一种，并只发布对应路由。自有身份入口由镜像服务端鉴权；平台身份入口必须经过 Auth Gateway，详见工程 Spec 14.3 |
| `platform-adapter` | 平台负责 Web/API/企微入口、身份、Conversation、Execution、事件和历史 | `protocol` 必须是 ACP，并通过 Generic ACP Conformance Suite |

`platform-adapter` Manifest 未声明 ACP 时创建失败或升级被拒绝；实际 ACP 兼容性在创建或升级的 Workload 启动后验证。M1 不为未知协议增加专用 Adapter。

四个标准模板的任务与真实模型/工具采集按第 11 节分别验收，不从原生协议名推断能力。自定义 Agent 的任务 API、观测和 Eval 复用以实际接入验证为准；Agent 管理 API 可用不代表 `self-managed` 已兼容平台任务协议，其自有会话不纳入本 Contract。

`self-managed` 的应用接口由镜像负责，但 StatefulSet、Service、Ingress 和 NetworkPolicy 仍只由 `platform-worker` 调谐。自有身份入口不经过 Auth Gateway，也不获得可信平台身份或撤权上下文，账号生命周期由 Owner 的身份体系负责；平台身份入口必须经过 Auth Gateway。网络与鉴权细节见工程 Spec 14.3。

## 4. Runtime Manifest

自定义镜像通过固定 OCI Image Label `io.agora.agent.runtime.manifest` 提供 JSON Runtime Manifest。ImageRegistryAdapter 只为已准入的不可变 Digest 返回 OCI config 和该 Label；具体 Registry、credential、签名与扫描政策不进入 Runtime 契约。平台必须在解析前拒绝超过 64 KiB 的 UTF-8 Label，并使用最大嵌套深度为 8、能够检测重复键的 JSON Object 解析器读取；根对象或任意嵌套对象存在重复键时，在 Schema 校验前拒绝。M1 只接受整数 `schemaVersion: 1`，根对象以及 `service`、`health`、`capabilities` 对象中的未知字段均拒绝。实现阶段必须在 `packages/contracts` 维护与本节一致的版本化 JSON Schema，并以该 Schema 作为创建、升级和契约测试的机器校验入口。

| 字段 | 规则 |
| --- | --- |
| `schemaVersion` | 必填；M1 只接受整数 `1` |
| `interactionMode` | 必填；`self-managed` 或 `platform-adapter` |
| `protocol` | `platform-adapter` 必填且只能为 `acp`；`self-managed` 必须省略，出现时拒绝 |
| `service.port` | 必填；整数 `1..65535`，Agent Service 和健康检查使用的容器端口 |
| `health.path` | 必填；必须是以单个 `/` 开头的 origin-form 本地 HTTP 路径，其余字符只允许 ASCII 字母、数字、`/`、`.`、`_`、`~` 或 `-`；拒绝 `//`、`.` 或 `..` 路径段、反斜杠、`%` 编码、外部 URL、查询参数、片段、控制字符或凭证。平台使用校验后的原始路径和固定 Agent Service origin 构造探针请求，不再解码或规范化，且禁止跟随 HTTP 重定向 |
| `capabilities` | 可选 Object；允许既有布尔能力 `modelSelection`、`attachments`、`resultFiles`、`connection` 和 `supplementaryInstruction`，以及版本化 `browser` 声明；缺失布尔键按 `false`。Browser 声明只描述候选能力和限制，必须与真实 Browser Runtime probe 取交集；仅 `platform-adapter` 读取，`self-managed` 的声明忽略 |

Owner 不在产品页面填写协议、端口或探针。创建或升级时，Runtime 按以下顺序验证：

1. 读取并校验 Manifest Schema、字段约束和交互模式，以及创建时与 Owner 申请选择、升级时与当前 Agent 的一致性。
2. 候选 Runtime 健康后，对 `platform-adapter` 执行 Generic ACP 核心探测。
3. 核心探测通过后，再探测 Manifest 声明的可选 capability；平台展示能力取 Manifest 声明与实际探测结果的交集。

第一步失败时不请求部署候选 Runtime；核心探测失败时整个 Runtime 验证失败，可选 capability 探测失败时只把对应能力记为不支持。Base Image 可以提供生成辅助，但继承关系不赋予 capability 或准入资格。

候选修订、Workload、健康检查、路由切换、失败清理、PVC 和回滚机制只在工程 Spec 的[模板与自定义镜像升级](SPEC-agent-infra-M1-engineering-architecture.md#104-模板与自定义镜像升级)与[自定义 Agent Runtime Manifest](SPEC-agent-infra-M1-engineering-architecture.md#105-自定义-agent-runtime-manifest)中维护。

候选 Runtime 的只读就绪与能力探测遵循工程 Spec 的
[服务端授权上下文](SPEC-agent-infra-M1-engineering-architecture.md#93-服务端授权上下文)，
使用独立 Workload Readiness Grant。Host 必须在调用 Driver 的无副作用 capability 读取前
校验本机 Workload 绑定；此路径不使用业务 Session，也不开放任务提交或事件查询。

### 4.1 内部 Runtime Service 映射

本节细化[工程 Spec §8.3](SPEC-agent-infra-M1-engineering-architecture.md#83-内部接口)。Worker 到 RuntimeHost 使用集群内明文 HTTP（[ADR-0020](../adr/0020-use-in-cluster-plaintext-runtime-transport.md)），沿已有 Workload 拓扑，不增加或合并 Service、监听端口或 Manifest 字段。执行授权仍由 service token、signed readiness 与业务/控制 Grant 承担，NetworkPolicy ingress 只放行 Worker。

**Agent 级 candidate/verified Workload。** 令 `N = agent-` 加可信 `agentId` 的 SHA-256 十六进制前 32 位（`workloadResourceNameV1`，见[现有命名函数](../../apps/platform-worker/src/kubernetes-runtime-comparison.ts)），`NS = workloadInput.policy.namespace`。`P` 取对应 candidate/verified deployment 的 `service.port`；readiness 取该候选 Manifest 的同一端口。

| 路径 | origin | 不变门禁 |
| --- | --- | --- |
| business | `http://N.NS.svc:P` | 只在 ready 时消费 candidate，仍校验实际 ownership、Workload readiness 和新 Turn 容量 |
| verified control | `http://N-probe.NS.svc:P` | 取原 verified deployment，`observeVerifiedControl` 成功后才返回路由，保留独立控制 Grant |
| candidate health / signed readiness | `http://N-probe.NS.svc:P` | 分别验证原 `health.path` 和 `/internal/runtime/v1/readiness`，不授予业务准入 |

准确消费者为 `createProductionConversationRuntimeResolverV2`（[conversation resolver](../../apps/platform-worker/src/conversation-deployment.ts)）、`createWorkloadRuntimeProbeV1`（[readiness 装配](../../apps/platform-worker/src/workload-deployment.ts)）及 `createKubernetesRuntimeAdapterV1`（[Kubernetes Adapter](../../apps/platform-worker/src/kubernetes-runtime-adapter.ts)）。Adapter 已创建 `N` 和 `N-probe` 两个 ClusterIP Service，共用 Workload 的 `service.port`；候选阶段 `N` selector 为 `closed`，`N-probe` 选中候选 Pod。`closeAgentAtFence`（[cleanup](../../apps/platform-worker/src/kubernetes-runtime-cleanup.ts)）关闭主路由时保留合规的内部 probe 路由；probe 漂移可被移除，不能保证任意故障下 control 都可达。verified 观测失败必须继续 unavailable/unknown，不能把候选误当旧执行目标。

**kubelet 探针与 Worker 验证分离。** Adapter 的 `readinessProbe.httpGet` 使用 HTTP；`hasDriftedPodSpec`（[Pod drift 校验](../../apps/platform-worker/src/kubernetes-runtime-pod-validation.ts)）按 HTTP 比较 scheme、原 path/port 与禁止覆盖项。该探针只判断容器可用性，不携带 service token 或 Grant；promotion 和 Runtime 调用仍须经过 Worker 的精确 origin 与 signed readiness。

**业务 Session Sandbox。** Agent 级上述现状不能证明平台会话已按独立 Sandbox 路由。Session 的分配、Service、原 PVC、resourceFence 与真实 UID/version 继续以 [Spec §10.1.1](SPEC-agent-infra-M1-engineering-architecture.md#1011-session-owned-sandbox-权威与资源绑定) 为准；六类必需资源（#1466 增加该 Sandbox 专属 Secret）及可选 StatefulSet 的澄清归 #1322。Worker 只消费该分配已有 Service 的实际 DNS/端口 `http://<sandbox Service>.NS.svc:P` 与原 Session/Sandbox/代次绑定，不套用 Agent 级 `N`/`N-probe`，不新增 Sandbox probe Service，不让两个 Session 共享后端。缺少有效分配时拒绝该路由，不能回退到 Agent 级 Service。

### 4.2 Browser Capability

Browser Capability 使用 `packages/contracts/src/runtime/browser-capability.ts` 的版本化契约，分为 Manifest declaration、Runtime probe projection 和后续 Platform/API projection。当前交付的 OpenAPI 是内部 Runtime probe；Platform/API consumer 仍须在现有认证上下文中解析 Agent、Conversation、Session generation、fence 和 Grant 后再暴露 projection。可用投影必须同时包含 Chromium/Playwright provenance、操作类别、域和资源 policy，以及不可伪造的 conformance receipt；不可用投影必须返回脱敏状态、稳定错误码和 retryable 属性。

Manifest declaration 不能证明浏览器已装配或可用。Worker/Host 只有在当前 Session-owned Sandbox 内的固定 Browser Runtime 完成 probe 后，才能把声明与实际结果取交集并向 Platform 返回 `available`。该契约不创建 Browser 专用调度器、不改变 Conversation/Execution/Sandbox 权威，也不把 BrowserContext、Cookie、Storage 或原生页面标识暴露给 Platform API。

## 5. Platform Conversation Contract

Web、任务 API、托管渠道和 Eval 执行复用同一 Platform Conversation Contract；Runtime 不另建身份、任务队列或 Eval 状态权威。Contract 定义以下语义，不暴露具体 Runtime 协议：

- 为 Platform Conversation 创建或恢复原 Runtime Session。
- 将 Platform 已持久化的消息/任务 Execution 提交为一个带已固化有效模型选择的 Turn，并接收 accepted/busy/rejected/unknown；平台受理和 Runtime 接受是不同阶段，Host 不创建平台 Execution。
- 停止当前 Turn，以及在 capability 支持时提交补充指令。
- 查询 Session 和 Turn 状态。
- 订阅并归一化文本、状态、文件、完成和错误事件；实际模型/工具事实按 8.5 生产，不把自由文本摘要当作可信操作结果。
- 探测模型、附件、结果文件、Connection 和补充指令 capability；Browser Capability 的内部 probe 另由 §4.2 的版本化契约定义，尚不等同于 Platform/API Agent projection。

`packages/agent-runtime` 实现 RuntimeHost 深 Module 和四个固定 Runtime Driver；`apps/agent-runtime-host` 只负责 Agent Pod 内的进程入口、依赖装配和 HTTP/SSE 接入。worker 侧 RuntimeHost Client Adapter 只依赖版本化 Host Contract，不依赖该 package 或任何 Native/ACP library。Agent Service 对 `platform-worker` 始终提供同一内部 HTTP/SSE Interface。

标准模板新 Execution 使用 `RuntimeHostV4` submit：保留 `RuntimeInputV1` 和 `RuntimeSelectionV1` 的 `modelOptionId`/`reasoningLevel`，继承 V3 的 Session 恢复与 Grant 屏障，另由 Worker 在受认证、具传输保密的私有字段交付本次 Relay Key。持久 Execution、outbox、业务 Grant 和 Host 请求摘要只绑定 Key 用途、引用与版本，不保存原值或摘要。Host 在 Driver 副作用前校验选择、Grant、Execution、版本和 operation/fence；重投必须使用相同选择与 Key 版本，否则冲突。RuntimeHost/Driver 不查询 Platform DB、当前默认项或个人设置。旧 submit V1–V3 仅处理已受理执行及历史恢复，不能以静态 Pod Key 接纳新业务执行；版本退役遵守独立兼容门禁。原模型选择语义见 [ADR: 将 Execution 有效模型选择绑定到 Runtime submit](../adr/0004-bind-execution-model-selection-to-runtime-submit.md)。

固定 Driver 只使用 Agent Pod 已装配并通过候选配置验证的 active Runtime 配置，把 `modelOptionId` 映射为原生模型，并校验 `reasoningLevel` 属于该选项允许集合。Driver 必须在启动下一次原生执行的协议点显式应用两者；映射缺失、reasoning 不支持或原生协议不能保证应用时，返回稳定且脱敏的 `RUNTIME_MODEL_SELECTION_UNSUPPORTED` rejected 结果，不能静默使用进程默认值、其他模型或其他 reasoning。该失败不产生原生 Turn 副作用，也不暴露 endpoint、credential、原生协议帧或供应商错误正文。

OpenCode/Generic ACP 与 Pi 的原生会话若在启动时固定模型认证，相邻 Execution 即使选择同一模型也必须检查 Key 版本。不能在已验证传输边界内为本次执行换 Key 时，先退役并排空旧原生 handle，再用原 Session 与本次 Key 重建；不能证明排空或保留原 Session 时拒绝，不将旧 handle 的 K1 用于新执行 K2 或另一用户。Codex/Claude 的本地传输也按原 Turn/Query 及 Key 版本验证，不能仅凭模型选项相同复用父进程中的旧 Key。

Codex 的模型切换前置压缩继续使用上述有效选择，具体要求见 [8.5.2](#852-codex-模型切换前置压缩)。
提交前的选择校验拒绝与原生 Turn 接受后的压缩失败分别记录：后者按真实 Turn 的失败或
unknown 收敛，不能回填为未创建 Turn 的 rejected，也不能因零模型请求就推断 Turn 未发生。

Claude Native 使用固定版本的官方 Claude Agent SDK。每个 Conversation/generation 的 Query、
工作区和原生持久目录保持独立；SDK 的用户配置、权限默认值及产品 Session 管理不能覆盖本仓
身份和隔离要求。每次 submit 显式应用有效选项的模型和 reasoning，并绑定其 endpoint 与
本次 Execution Key 版本；只调用 `setModel()` 不构成 endpoint/Key 已切换的证明。需要重建 Query 时，
在无活跃 Turn 的边界退役并排空旧 Query/进程，再携带新模型配置恢复原 native Session，保持原生
Session ID、Host 映射和平台 Conversation 连续；退役失败时拒绝新 Turn。旧 Query 的迟到退出
与事件不能改变新 Query 的状态。模型配置或 Key 版本变化时按原执行持久绑定拒绝不匹配的恢复，不能用新
配置或新 Key 重放尚未确定结果的旧操作。

Claude 的真实凭证和供应商错误正文在原生持久化前处理，具体准入、传输与退役规则见
[工程 Spec §10.10](SPEC-agent-infra-M1-engineering-architecture.md#1010-claude-原生模型传输边界)。

Claude 的持久请求、accepted/unknown、状态和恢复继续遵循 §§7–8；SDK 恢复原 Session 不等于
证明某次提交未执行，缺少可靠原生证据时不得盲目重投。可选补充指令只在所选 SDK 的队列取消
与本仓持久去重均通过 Conformance 后启用，不能依赖未验证的可选方法。核心 Driver 验收包含
真实文本、模型切换、停止、原 Session 恢复和双用户隔离；文件及 Connection 的完整模板验收
仍须分别完成，核心 Driver 通过不能提前开放尚未验收的产品能力。

`platform-adapter` 自定义 Agent 的模型选择 capability 只表示 Generic ACP 可以读取 Runtime 当前提供的模型选项和默认项，并把使用者选择转交给 Runtime。选项内容、Base URL 和凭证属于自定义 Runtime；Owner 通过平台配置的相关 env/Secret 遵循工程 Spec 10.6 的通用规则，Adapter 不从 Runtime 的模型选项读取或保存凭证，也不把它们复制到标准模板模型配置。提交 Turn 前，Adapter 必须确认所选模型仍在 Runtime 当前返回的选项中；能力缺失或选项已失效时不展示或拒绝该选择，不能回退到其他模型后静默执行。

标准模板的有效补充指令能力取 Registry 声明与 Adapter Conformance 结果；`platform-adapter` 自定义 Agent 取 Manifest 声明与实际探测结果的交集。缺失、声明为 `false`、探测失败或不能保证 `messageId` 持久去重时都按不支持处理，只影响补充指令分支并返回繁忙，不使 Agent 创建失败。

### 5.1 命令与 Skill 目录及调用

本节细化 [工程 Spec §11.4](SPEC-agent-infra-M1-engineering-architecture.md#114-原生命令与已安装-skill-边界) 与 [工程 Spec §11.6](SPEC-agent-infra-M1-engineering-architecture.md#116-skill-hub-版本绑定与-worker-装配)。Skill Hub 的不可变 Skill Version、Agent Version 绑定和 Worker Applied 是目录与调用的前置事实；#992 的 Web 会话 command/skill 消费这些同一修订，不建立第二套目录或绑定。固定 Driver 的能力目录是受控装配与原生实际发现的交集，不动态发现 Driver。平台控制保持既有入口，命令目录不能注册第二个停止、补充指令或重新生成实现。

| 契约 | 最小语义 |
| --- | --- |
| 发现 | 按当前主体、Agent、Conversation、Runtime/配置修订及受控 Skill 包摘要绑定目录修订；返回不透明能力 ID、类别、说明、显示来源/版本、参数描述、只读/产生 Turn/改变状态类别和可用性。原生路径及会话 ID 只留 Host。读取失败不返回伪造空目录 |
| 参数 | 固定命令使用逐项类型、必填与长度约束；仅有原生 argument hint 的 Skill 使用有界文本参数并标明其不是类型 Schema。参数不作为 shell/argv、路径或身份字段拼接，不允许选择运行目录或任意原生方法 |
| 选择与提交 | 调用方只提交能力 ID、目录修订、参数和幂等键；业务作用域由当前认证及目标资源服务端解析。服务端重验来源、版本、当前权限与能力可用性，Driver 再按固定绑定核验。未知、失效、越界、参数错误、繁忙和协议不支持分别返回稳定脱敏原因，不回退普通文本 |
| 目录变化 | 原生变化通知只使缓存失效，重新读取后生成新修订；无通知的模板在提交前重新核对。过期选择要求重新确认，不追随同名新包。已受理调用保留原版本，版本不可用时失败或待核实，不改用新版本重放 |
| 结果 | 只读命令返回获准字段及读取时间；其他调用沿同一 Execution/规范化事件报告受理、运行和终态。命令/Skill 标识与版本关联到原执行；内部路径、供应商错误、Skill 全文和普通参数不进入审计或遥测 |

目录不可枚举其他主体的 Session、路径或内容；使用权、读取权与执行权分别检查。受控来源记录由部署可信配置产生，不接受模型、Skill frontmatter 或浏览器自报。Skill 参数、说明和内容都不是授权；嵌套资源、脚本、符号链接及原生自动发现须受既有文件与装配边界约束。只读发现不执行 Skill 脚本、模型请求或业务工具。

原生元数据读取的用途、当前政策、证明和期限以
[工程 Spec §9.3.1](SPEC-agent-infra-M1-engineering-architecture.md#931-原生元数据读取授权)
为唯一授权合同。API 先按受认证主体/channel 定位 Conversation，再限定其中的原 Execution；
代次取该 Execution 的持久记录。当前 Conversation 的 Host ref、当前 Agent 配置及模型
修订不能证明旧执行的 Host/native 配置。Worker/Host 只从唯一原持久绑定解析
`originalHostScopeRef` 及实际 native ref/thread/config；缺少或矛盾时返回 unavailable，
不建立新会话或换绑。公开 selector 不允许请求者指定这些字段。

### 5.2 调用生命周期与兼容

只读 metadata 的内部 HTTP 例外及原请求/实例边界遵循 [工程 Spec §4.1](SPEC-agent-infra-M1-engineering-architecture.md#41-部署单元)。

- 只读能力沿原 Session 的受限查询返回投影，不创建 Session/Turn、不恢复业务、不改变平台任务状态。未装载、不可用或无法核实分别返回，不能把 `notLoaded` 当作原任务已停止；当前读取权限失效时不返回结果。

metadata-only concrete context 保留原同步护栏，新增显式异步当前确认：

```ts
type CodexNativeCommandReadContext = Pick<
  RuntimeOriginalEvidenceReadContext,
  "signal" | "expiresAt" | "assertCurrent"
> & {
  readonly nativeSessionRef: string;
  revalidate(): Promise<RuntimeOriginalEvidenceBinding>;
};
```

该签名仅用于具体原生 metadata 读取；`RuntimeOriginalEvidenceReadContext` 的同步
`assertCurrent` 与 recovery 的 commit 保持原义，不用恢复 factory 构造读取权。
Host factory 先消费当前获准结论和真实原绑定，异步 revalidate 沿可信内部链重验并更新
本次 request 的局部确认状态；拒绝或不可确认则永久失效并 abort。同步 assertCurrent 只核
这个局部状态及本机原绑定/配置/进程，不隐藏远程 Promise，不把旧 allowed 当当前授权。

Driver 在开始 native metadata 请求前、每个相关 await 后及最终返回前显式等待 revalidate，
随后核返回的原主体/范围等于最初绑定，并再次检查 signal、固定期限、原配置、进程和
Skill epoch。范围不会因当前权限扩大而换成另一原执行。原同步 RPC/config callback 继续
执行本地护栏；新进程的 initialize、config/read、模型 profile 核验、固定 extraRoots/set 及
thread/read、skills/list 等等待边界同样受当前读取确认约束，不能只在公开方法尾部补一次。
等待当前确认也受同一 signal/deadline 约束，不续期、不序列化函数，不返回结果后补验。

原生请求失败、撤权/账号或所用凭证失效、期限/abort、等待期间原范围/config/process/epoch
变化、当前确认依赖失败、返回前拒绝及迟到响应均须有真实入口负向测试。API 结果交付与
请求关联失效统一遵循 [Spec §9.3.1](SPEC-agent-infra-M1-engineering-architecture.md#931-原生元数据读取授权)，
不另设恢复路径。受控、原 native 与浏览器证据按 [§5.4](#54-独立验收与实施交接) 分别验收。

- 产生 Turn 的 Skill/命令复用现有 Message/Execution/outbox；不产生回答但改变原生状态的命令也绑定一个持久 Execution 与命令输入，复用同一调度及事件链，不伪造用户聊天消息或模型回答。活跃、等待或 unknown 占用下返回 busy，不插队、不转成补充指令。
- 受理时冻结能力/目录/包修订、参数摘要、原主体/Agent/Conversation、模型选择及 Key 引用版本；幂等键沿既有作用域使用。同键同输入回读原结果，同键不同内容冲突；业务原文按普通消息权限保存，审计只保留必要元数据。
- 调用前按 §§7–9 校验当前业务授权、原执行范围、Session/generation/fence 和操作绑定。目录修订不替代 Grant，Skill 不增加工具权限；当前权限扩大不能扩大旧执行，权限缺失或依赖不可确认时拒绝新副作用。
- RPC ACK 只证明该接口接收；按原生终态及已持久事实判定完成。Skill 加载证据绑定所选包及真实加载机制，工具效果另按 §8.5 核对。参数合法但原生拒绝、模型/工具失败、无加载证据及结果不确定分别保留，不能以文本中的“完成”补证。
- 停止、撤权、响应丢失、Worker/Host 重启和 SSE 重连只沿 §§7–8 的原执行、原操作、journal、游标与 ACK 恢复；不因重新获取目录而重发。停止 ACK 不释放未核实占用，外部效果不自动撤销。缺少原生幂等/状态证据时保持 unknown，不能用新 Session、Turn、Key 或同名 Skill 重试掩盖不确定性。
- 旧版本不理解新增输入时显式拒绝；升级只在原生占用排空且兼容验证通过后生效。历史结果仍按原主体读取，原执行恢复继续使用已冻结版本及既有控制授权；本节不更改原控制绑定恢复契约。

### 5.3 固定官方能力矩阵

以下是公开接口/固定源码核查基线，**不是运行验收通过表**。每行均须由实施票补齐实际部署版本、装配摘要及正负向运行证据，才可在目录启用。版本升级重新核查，不能以最新网页替代固定版本源码；官方接口存在也不证明本仓现有 Driver 已适配。

| Runtime 与固定版本 | 公开发现及真实调用路径 | 当前接入差额与验收边界 |
| --- | --- | --- |
| Codex `0.153.0`，官方 commit `41e22fee981a63b3698df7ed36bad393cda24715` | [app-server](https://github.com/openai/codex/blob/41e22fee981a63b3698df7ed36bad393cda24715/codex-rs/app-server/README.md)：`skills/extraRoots/set`、`skills/list`、`skills/changed`；`turn/start` 的结构化 `skill` 输入；`thread/read` 只读查询；`thread/compact/start` 原生压缩 | 优先路径见下文。没有把 CLI 斜杠清单当作通用命令 API。压缩参数只有 threadId，须证明原 Session 模型/Key 与本次冻结选择一致及现有屏障有效；否则拒绝压缩，交公共执行 owner 保留具体缺口 |
| Claude 官方 `@anthropic-ai/claude-agent-sdk@0.3.246` | [固定发行类型](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.246/sdk.d.ts) 的 `supportedCommands()`/`SlashCommand`；[官方 SDK 说明](https://code.claude.com/docs/en/agent-sdk/skills) 的命令提示及 `.claude/skills/<name>/SKILL.md` 原生加载 | 当前 Driver `settingSources: []` 且 `disable-slash-commands`。后续仅开放受控来源及实际列表中的入口，逐项验证 `/compact`/Skill 与终态，不直接移除禁用项继承个人配置；`argumentHint` 不是参数 Schema，文档新行为须对照固定 SDK |
| OpenCode 官方 `1.18.30`，commit `3104c1428ec91f809e5ab86631300de41eb6952e`；ACP SDK `1.4.0` | [固定 ACP service](https://github.com/anomalyco/opencode/blob/3104c1428ec91f809e5ab86631300de41eb6952e/packages/opencode/src/acp/service.ts) 的 `available_commands_update` 合并命令/Skill；`session/prompt` 解析已知名称后调用原生 `session.command`，`compact` 使用原生 summarize | 原生目录含 Skill，但 ACP 展示未必携带完整来源/版本，须由受控装配核对。未知名称必须在平台拒绝；命令、Skill 真实 I/O 仍受 [Spec §10.13](SPEC-agent-infra-M1-engineering-architecture.md#1013-opencode-原生工具回执与来源) 约束，目录通知不证明工具事实/执行屏障通过 |
| Pi 官方 `@earendil-works/pi-coding-agent@0.86.0`，commit `ecac0a9c4edad3dac5d9f8b40e0c7db7a56471fc` | [固定 RPC 文档](https://github.com/earendil-works/pi/blob/ecac0a9c4edad3dac5d9f8b40e0c7db7a56471fc/packages/coding-agent/docs/rpc.md)：`get_commands` 返回来源；`prompt` 展开 `/skill:name`；`compact` 是独立 RPC。TUI-only 命令不在此目录 | 当前装配 `enableSkillCommands: false`、`--no-skills`、`--no-prompt-templates`。后续验证受控 Skill 根及实际展开；不开放任意 extension/包安装，不以 RPC response 或低层 `agent_end` 代替完整终态 |

Codex 的首个只读原生命令定义为“查看原生会话状态”：目录显式绑定 `thread/read`，不假称 CLI `/status`。Driver 只用当前 Conversation 已持久绑定的 threadId，禁用历史正文投影，只返回映射后的状态及读取时间；原生未装载不触发 resume。它证明真实原生查询闭环，不代替产生 Turn 的命令验收。原生 `/compact` 作为独立有状态命令交付，返回空 ACK 后必须跟踪原 `contextCompaction` item 与 Turn 终态；不伪造普通 prompt 代跑，不绕过 §8.5.2 的当前模型和事实约束。

Codex 的 workspace-summary 仍是当前固定安装 Skill 的兼容验收包，但不再是 Skill Hub 的权威模型。Skill Hub 的运行时投影遵循工程 Spec §11.6：Platform DB 保存 Skill Version 与 Agent Version 绑定，Platform Worker 消费不可变包对象版本、manifest、digest/signature 和只读策略，异步 materialize 到 Agent project 的 `.agents/skills/<name>` 并维护 `.agents/SKILLS.md`，再随受控 workspace 挂载到 Sandbox。`.magic/skills` 不属于本平台规范路径。

每个 Conversation 独立 Runtime 进程只接收当前 Agent Version 已批准且同步成功的 Skill 根；调用前以 Runtime 实际返回的目录修订、enabled 状态、来源/版本、包摘要和加载证据作为准入。Host 将能力 ID 解析为受控相对路径，向固定 Driver 传递已冻结版本与有界任务文本；路径不由 Web 提供，Runtime 不能静默下载、改写或替换 Skill。初始 Prompt 只包含有界 metadata，read_skills 按需读取正文和配套资源。受控工作区样本、真实包摘要、只读挂载、跨 Conversation 文件隔离、实际 Skill 加载和工具结果必须分别验证；上游接口存在不能证明本仓已完成装配或权限门禁。

本节源码与官方 SDK 声明属于静态证据；上游测试属于上游证据。运行证据须另列原生版本及发行摘要、受控 Skill 摘要、实际发现/调用、加载及工具事实、平台持久结果与浏览器回读。没有这些证据不得写“支持已验收”；本节不授权新增隔离探针或修改上游实现。

### 5.4 独立验收与实施交接

| 场景 | 通过条件 |
| --- | --- |
| 发现与 UI | 固定四模板逐项核对目录、说明、来源/版本、搜索/键盘/输入法/参数/清除与移动布局；目录读取失败区别空目录。真实浏览器使用唯一会话输入框及时间线 |
| Codex 正向 | 真实 `thread/read` 状态命令、原生压缩及一个确定版本 Skill 各有真实调用与结果；Skill 必含实际工具操作及加载证据。压缩模型/Key/屏障缺口单列未完成，不以只读命令通过抹去 |
| 参数与变化 | 未知命令、缺参、旧目录、禁用/删除/同名替换包、协议不支持均明确拒绝且零新副作用；普通消息回归，不能静默降级 |
| 授权与来源 | 两个独立主体、跨 Agent/Conversation/能力 ID 替换、撤权、依赖不可确认、Owner 越权、来源越界均拒绝；个人 HOME 不参与装配，目录/错误/遥测不泄露内容或凭据 |
| 串行与恢复 | 活跃/等待/unknown 时不发新 Turn；同键重投/异参冲突、受理响应丢失、原生 ACK 后失败、停止竞态、重启和 SSE 重连保持原操作及结果；不重复模型/工具副作用，不提前释放占用 |
| 其余模板 | Claude/OpenCode/Pi 各按上表真实 SDK/ACP/RPC 路径核对发现、调用、加载/工具及终态；缺口绑定版本、原因、原 owner 与实施 AC，不能以四行 unsupported 结案 |
| Skill Hub 挂载 | 真实控制面完成发布/审核/安装/Agent Version 绑定后，Worker Applied 与 Runtime 目录修订、按需读取和真实工具结果均绑定同一 Skill Version；同步、撤销、升级、回滚、重启和重复提交均保留可回读状态 |

[#992](https://github.com/AgoraIO-Extensions/agent-infra/issues/992) 以 [#991](https://github.com/AgoraIO-Extensions/agent-infra/issues/991) 契约评审合入为 native blocker；仅文档完成不签收功能或原票 AC。实施前逐 hunk 交接：Web owner 在 [#192](https://github.com/AgoraIO-Extensions/agent-infra/issues/192) 唯一输入框/时间线消费生成 Client，遵循 [#400](https://github.com/AgoraIO-Extensions/agent-infra/issues/400) 固定 `agent-infra/index.html`、`screens/chat.html` IA，旧 Pilot 及按当前实现生成的变体不作依据；[#482](https://github.com/AgoraIO-Extensions/agent-infra/issues/482) 拥有任务 API/Store；[#508](https://github.com/AgoraIO-Extensions/agent-infra/issues/508) 拥有公共执行/Host/控制恢复；Runtime 原 owner 拥有各 Driver；正式装配归 [#504](https://github.com/AgoraIO-Extensions/agent-infra/issues/504)。本新增能力不反向阻塞这些票，不接管其未完成验收，也不重定义 OpenCode 工具来源或原控制恢复条款。

## 6. 数据归属与标识

| 数据 | 权威位置 | 约束 |
| --- | --- | --- |
| Session 到 Sandbox 的分配 | Platform DB | 归属与生命周期按工程 Spec §10.1.1；不是 Host 或原生返回值 |
| Conversation、Message | Platform DB | Web/API/Channel 只使用平台 ID，绑定服务端解析的提交主体与类型 |
| Execution、回答版本、API 等待顺序/期限及调度状态 | Platform DB | API task 对应一个 Execution，等待不占原生 Turn，重试不重复创建或改绑 |
| 规范化事件与 SSE 游标、平台执行审计 | Platform DB | 事件与必要审计可靠保存后确认/推送，受控正文不进入审计或遥测 |
| 模型/工具原操作与未确认事实 | 执行侧持久记录 | RuntimeHost/Driver 在现有 PVC 持久层记录意图与结果，按原操作向平台确认；不成为第二套平台任务或审计查询权威 |
| Eval 数据集、实验、评分与反馈 | Platform DB/受控对象存储 | 用途授权、版本和内容读取由 Platform 负责，Runtime 只处理获准任务 |
| RuntimeHost Session 引用 | Platform DB 的 Client Adapter 内部存储 | 保存不透明、不可猜测且不能作为授权依据的 Host Session Ref 和单调递增的 `sessionGeneration`，调用方不能解释或覆盖该引用 |
| Host Session 到原生 Session 的映射 | Sandbox PVC 上的 RuntimeHost 状态 | 保存 Host Session Ref 与 `agentId`、`conversationId`、Sandbox、`sessionGeneration` 及原生 Session ID 的绑定；只有对应 Driver 解释原生 Session ID |
| Runtime 工作区和原生 Session 数据 | 所属 Sandbox PVC | Runtime 自己解释，平台不读取内容 |
| Skill、Skill Version、发布/审核/安装/绑定/同步状态 | Platform DB | 版本与关系是唯一业务权威；Agent Version 固定具体 Skill Version，不静默升级 |
| Skill ZIP、manifest、digest/signature | 版本化 S3 兼容对象存储 | 对象不可变；Worker 只消费不可变对象版本和受控摘要 |
| Agent project 的 Skill materialization | 所属 Sandbox PVC 的 .agents/skills | 由 Worker/RuntimeHost 受控同步和只读挂载，Runtime 按需读取，平台不以工作区文件反推业务授权 |

Session/Sandbox 的标识、分配、资源和授权权威统一遵循
[工程 Spec §10.1.1](SPEC-agent-infra-M1-engineering-architecture.md#1011-session-owned-sandbox-权威与资源绑定)。
Platform Session 使用 Conversation 的稳定 ID；Host Session Ref 与 Native Session ID 仍是内部映射，
不能替代 Sandbox 分配。每次提交、补充、查询、停止、事件回读和恢复均核对原 Sandbox/Session/代次；
Driver 只能使用该 Sandbox 的进程、HOME/cwd、工作区和受保护客户端，不能按 Agent 选择共享实例。
Runtime 事件与 Platform 写入绑定同一归属，原 fence、持久事务及 ACK 不因增加 Sandbox 而旁路。

一个 Platform Conversation 最多映射一个当前 RuntimeHost Session Ref。创建 Conversation 时，Platform DB 原子初始化 `sessionGeneration = 1` 和“Host Session 未创建”状态；RuntimeHost 创建或恢复 Session 时在所属 Sandbox PVC 中维护该引用及其绑定，worker 只持久化和回传不透明引用。每次调用必须先验证服务身份，以及按工程 Spec §9.3 区分业务执行或平台控制用途的当前 Grant；Host 再校验引用保存的 `agentId`、`conversationId` 和 `sessionGeneration` 与 Grant 及请求完全一致，并校验 Execution 相关请求中的 `executionId` 与 Grant 和持久化请求记录一致。Host Session Ref 泄露、错配或跨 Conversation 重放都不能获得访问权。首个及后续 outbox 在创建时保存当前代次。Web/API、Channel、自定义镜像和 Connection 请求都不能提交或覆盖 Host Session Ref、原生 Session ID 或代次。

API 默认新建提交主体在目标 Agent 下的 Conversation；显式续接须匹配同主体、同 Agent 及渠道边界。主体类型与稳定 ID 由服务端解析，应用不映射成其自然人责任人。任务输入、已有输出、结果、附件及审计查询使用各自的当前权限，Owner/责任人角色不授予其他主体的任务访问或取消权。

企微群聊的 Channel 会话键必须包含服务端解析的 `actorId`，且调用方不能提交或覆盖 `actorId`。不同发送者映射到不同 Platform Conversation 和 Runtime Session；消息、历史、SSE、附件和结果文件的读取都必须在服务端校验当前 `actorId` 与目标 Conversation 的绑定关系。群内公开展示只允许当前群和 Agent 授权范围内显式标记为群内公开的事件，不得暴露其他发送者的 Conversation 或 Runtime 上下文。

## 7. Session、Turn 与恢复

### 7.1 Session 生命周期

1. 首个实际投递的 Execution 由 RuntimeHost Driver 创建 Runtime Session；尚在平台等待的任务不提前创建原生 Session。RuntimeHost 在所属 Sandbox PVC 中持久化 Host Session Ref 到原生 Session 的映射，worker 侧 Client Adapter 只保存 Conversation 到不透明 Host Session Ref 的映射。
2. 后续 Execution 必须恢复同一个 Session，不能以新 Session 代替恢复。
3. Conversation 关闭或 Agent 停用时，按工程 Spec §10.1.1 拒绝新业务并停止/核实原执行；确认无剩余副作用后关闭原生 Session 和回收对应计算资源，保留原持久映射与历史。M1 不向用户提供删除 Conversation。

### 7.2 并发

- 同一 Conversation 同时只允许一个活跃 Turn。
- Web 初始 Execution 与 Turn outbox 原子提交即占用本 Conversation 的执行位置；API 等待 Execution 只有在 Dispatch 原子准入后才占用。该位置覆盖尚未投递、接受结果不确定、运行中和取消待确认；确认无剩余 Runtime 副作用且终态持久化后才能释放。待核实不能被当作可释放终态。
- Web/托管渠道在活跃 Turn 存在时，只有与当前 Execution 相同 `actorId` 的新消息可以按 capability 作为补充指令处理；同一发送者不支持补充指令或不同 `actorId` 提交消息时，平台明确返回繁忙。任何新消息都不能启动第二个 Turn。API 同会话后续任务按 8.4 有界等待，不自动转换为补充指令；已合法绑定当前 Turn 的 Web 补充指令仍可处理。
- 不同 Conversation 在各自独立 Sandbox 内、按 Agent 已验证容量并行，Dispatch 在 Platform DB 以原子条件预留和释放容量，不把未经验证的并发下推给 Driver。Adapter 不以 Agent 全局锁替代会话隔离；不新增资源池、优先级、定时任务或第二套排队权威。

### 7.3 重启恢复

- Generic ACP 使用未修改的原生 Runtime。原 Session 映射、已确认请求结果和首次转发前持久化的事件日志按 §§8.1–8.2 恢复；原生 `session/prompt` 的最终响应先持久化，才能发布对应终态。原生进程退出或最终响应丢失且没有可靠结果证据时，原 Turn 保持 `unknown`，不把进程退出、`cancel` 通知发送成功或 `loadSession` 成功推断为原任务完成、失败或取消。后续查询和同请求重放不重发 prompt，未知 Turn 仍占用该 Conversation 的活跃位置；只有取得可靠终态证据才能接受下一 Turn。用户可以明确新建 Conversation，平台不自动替换 Session。单次结果未知不等于 Session 无法恢复，不因此执行代次隔离；只有实际 Session 或持久状态恢复失败才进入本节的隔离流程。该边界不要求维护原生源码 fork 或增加专用协议扩展；Conformance 必须同时证明已确认终态、事件和游标可恢复，以及不确定窗口不会被伪造为确定结果。
- `platform-worker` 重启后从 Platform DB 恢复 Execution、outbox 和不透明 Host Session Ref；未开始的 API 任务保留原顺序与等待期限，按当前授权继续调度。运行中任务沿原 Execution/Session 查询，不能因进程重启生成新任务。
- 标准模板运行中 Execution 的 Key 用途、引用与版本从原受理记录恢复；Worker 在当前业务 Grant 与原执行一致时重交同一版本，Host 只恢复该执行的内存传输能力。Key 替换不改变旧执行；旧密文已被错误回收、Key 用途不符或原授权不能确认时拒绝模型转发，不用 Pod 静态 Key、当前个人 Key 或 Agent 默认 Key 补位。历史事件与无正文控制查询仍按原执行权限读取。
- Worker 的 Runtime 调用、Adapter 恢复查询、规范化事件和 Execution 状态写入必须携带 outbox 保存的 `sessionGeneration` 与当前 Execution `deliveryFence`；补充指令和 stop 调用还分别携带自身的 `messageId` fence 或 `stopRequestId` fence。Platform DB 对规范化事件按 8.2 的重复事件优先规则处理，仅允许当前 Conversation 代次和相应 fence 产生新事件或状态写；Agent Service、Runtime Host 或 Bridge 在所属 Sandbox PVC 中按 Session 和投递标识持久化已见的最高 token，并拒绝更低 token 的迟到调用。
- Sandbox Pod 重启后仅复用该 Sandbox 的原 PVC；Pod 就绪后，RuntimeHost 必须使用已保存的 Host-to-native Session 映射恢复原 Session，并查询未完成 Turn 状态。
- 恢复成功后继续接收事件。恢复失败时，`platform-worker` 必须先在 Conversation 锁内保持当前 `sessionGeneration`，将 Conversation 标记为“代次隔离中”，暂停新命令和业务 outbox，并持久化携带目标代次的内部 generation tombstone；当前代次在隔离期间已被 Agent Service 接受的调用、事件和状态仍按原规则保存，不能形成不可见执行。Agent Service 必须幂等持久化并激活目标代次的 cancellation barrier，拒绝新的旧代次调用，并等待或取消已接受的旧代次调用，直到它们不能再产生 Runtime 副作用、事件或状态后才确认 tombstone。只有收到该确认后，Worker 才能再次取得 Conversation 锁，原子提升 `sessionGeneration`、将 Conversation 标记为“会话不可用”，并把活跃 Execution、该 Conversation 尚未开始的 API 任务和业务 outbox 置为带可审计原因的失败终态；Platform DB 从该事务提交起拒绝旧代次的事件和状态写。任一步失败或 Worker 重启都从持久化状态重试；Agent Service 未确认时保持“代次隔离中”，不能恢复业务投递或创建新 Session。当前 Host Session Ref、Host-to-native 映射和平台历史保留只读，其他 Conversation 和 Agent 服务保持正常。
- 恢复失败时禁止静默创建新 Session。只有用户明确新建 Platform Conversation 时才能分配另一 Sandbox 并创建新的 Runtime Session；这不解除旧 Sandbox 的 unknown、隔离或保留证据义务。
- Host V3 仅在原执行的 Session 恢复被原生 Runtime 明确拒绝时报告 `RUNTIME_SESSION_RECOVERY_FAILED`。状态查询返回严格的 `recovery_failed` 分支，携带经原主体、请求摘要和执行绑定验证的原 Host Session Ref 与 Execution ID；首次受理回执丢失时，Worker 也能原子保存这一映射与隔离意图，再沿原 tombstone 完成控制流程。其他操作返回 HTTP 503、`retryable=false`，缺少映射时先查询原执行；响应不包含原生诊断正文。传输断开、超时、原 Turn 结果 `unknown` 和 Host 暂时不可用不构成这一证明，保持原执行与占用并继续查询；不能按通用 503 或错误文本触发隔离。

- `generation-cancel` 的持久 `accepted` 终态回执确认目标代次的 cancellation barrier 已完成；它是控制操作结果，不是原 Turn 的原生终态。Host 以该回执确认 tombstone，不以原 Turn 的 `unknown` 或不可查询状态覆盖控制回执。Driver 必须先独立持久化屏障，再确认所有旧代次执行源已退出且在途事件与状态写已排空；即使 Session 或 Turn 持久状态无法恢复，也不能跳过这些条件。无法证明停止副作用时不确认。原 Turn 的未知结果和已保存历史保持原状，不生成合成终态事件。
- Codex 的原生历史恢复被明确拒绝时，仍可按已持久化的原 thread、Turn、子执行源和后台调用标识尝试现有控制；控制失败或没有源退出证据时保持隔离中。原生终态及模型排空证据到达后，Driver 必须持久更新原 generation 控制回执，不能只更新 Host 状态。该回执完整确认后，事件恢复只回放原 durable journal，并在已保存事件排空后结束流，不重新读取损坏的原生历史；保留原游标校验与事件字节，不把流结束转换为原 Turn 的合成终态。

## 8. 消息、事件与 SSE 可靠性

### 8.1 消息与命令幂等

本节 `message`/`regenerate`/补充指令分支服务于 Web 和托管渠道；任务 API 的受理分支见 8.4。Runtime 请求持久化、租约/fence、取消屏障和接受结果恢复由所有入口共同遵守。

- `platform-api` 先按服务端命令入口确定不依赖 Conversation 状态的 `commandType`，再在同一 Conversation 数据库锁内优先执行幂等查询；仅未命中时才查询活跃 Execution，完成普通消息/补充指令/重新生成/繁忙分支判定及对应写入，提交事务后才释放锁。stop 命令复用同一把锁。两个并发请求都不能基于“无活跃 Execution”的旧快照各自创建 Execution。
- 所有会调用 Runtime 的 outbox 使用 Platform DB 中的 durable lease，至少保存 `leaseOwner`、`leaseExpiresAt` 和操作作用域内单调递增的 `deliveryFence`。初始 Turn 使用 `executionId` 作用域的 Execution fence，stop 使用 `stopRequestId` 作用域的独立 fence，每条补充指令使用 `messageId` 作用域的独立 fence。Worker 通过条件更新认领或续租；首次认领和租约到期后的重新认领只提升对应作用域的 fence。stop 认领不得提升 Execution fence；已被 Runtime 接受的 Turn 在停止确认前继续以当前 Execution fence 写入事件和真实终态。只有 Turn lease 接管或本地取消屏障可以提升 Execution fence；租约过期后旧 Worker 的 Runtime 调用、事件和状态写入必须被 Agent Service 与 Platform DB 拒绝，不能仅凭进程内“正在处理”状态判断所有权。
- RuntimeHost 在调用 Driver 前，必须以 Host Session Ref 和 operation scope 为键，通过 PVC 上 durable store 的原子事务或 compare-and-set，在同一次 durable commit 中比较并提升当前最高 fence、插入或读取请求记录；同一 Session 的 Driver 命令分派通过串行执行器保持提交顺序。只有赢得原子更新且请求记录已持久化的调用才能进入 Driver，低 fence 或并发重复调用必须在任何 Driver 副作用前拒绝或返回已有结果。记录至少包含 Host Session Ref、`agentId`、`conversationId`、`sessionGeneration`、`executionId`、请求作用域的 `deliveryFence`、请求内容摘要，以及由初始 Turn 的 `executionId`、补充指令的 `messageId` 或停止命令的 `stopRequestId` 形成的稳定 `operationId`；初始 Turn 的请求摘要还必须包含完整 `RuntimeSelectionV1`。调用方 `Idempotency-Key` 不跨入 Host Contract。同一 `operationId` 和相同输入及选择的重试返回已保存状态或结果，任一输入或选择字段不同都返回冲突。
- `durable commit` 必须由底层 store 完成数据和所需元数据的崩溃一致性确认，例如 fsync 或等价机制；内存状态或尚未确认稳定落盘的普通文件写入不满足该语义。请求记录提交后才能调用 Driver。RuntimeHost 只有在原生 Session/Turn 标识、恢复游标和 `accepted` 状态已持久化，或 Driver/Bridge 能按同一 `operationId` 持久查询原接受结果时，才能返回 `accepted`；`busy` 和 `rejected` 也必须持久化并在重试时返回原结果。RuntimeHost 启动时必须扫描非终态或状态不完整的记录，按 `operationId` 查询并收敛；进程在 Driver 调用前后崩溃或响应丢失而无法确认接受状态时保持 `unknown`，不能盲目再次产生 Runtime 副作用。损坏或无法恢复的记录使对应 Session fail closed，不能静默丢弃或创建新 Session。不能提供该恢复能力的 Driver 不通过 M1 Conformance。
- 新消息和重新生成请求必须携带非空 `Idempotency-Key`，值只允许 `1..128` 个 ASCII 字母、数字、`.`、`_`、`~` 或 `-`，并作为区分大小写的不透明字符串处理。浏览器为一次逻辑提交生成 Key 并在传输重试时复用；Channel 层从可信渠道消息 ID 派生符合该格式的稳定 Key。`platform-api` 在任何写入前拒绝缺失或格式无效的 Key；新消息入口使用 `commandType = message`，重新生成入口使用 `commandType = regenerate`，并以非空字段建立 `(conversationId, actorId, commandType, Idempotency-Key)` 唯一约束。补充指令不是调用方选择的独立命令类型，而是 `message` 请求在锁内根据当前活跃 Execution 得出的处理结果。`actorId` 和 `commandType` 均由服务端生成，不能接受调用方提交或覆盖。
- 幂等重放必须在查询活跃 Execution 和判定处理分支前，使用上述完整元组查找已保存结果。同一 `actorId` 和 `commandType` 下，同一 Key 和相同请求内容再次提交时，`message` 返回首次提交保存的 Message，以及原初始 Execution 或原补充指令绑定的 Execution；`regenerate` 返回原新建 Execution。重放不能根据已经变化的活跃状态重新判定分支。同一 Key 对应不同内容时返回冲突；不同 `actorId` 或 `commandType` 的 Key 独立生效。
- 没有活跃 Turn 且无更早受理的等待任务时，Web/渠道的 Message、初始 Execution 和 Turn outbox 在同一数据库事务中创建；存在等待任务则返回繁忙，不越过已受理顺序。
- 重新生成只允许在没有活跃 Turn 且无更早等待任务时发起。`platform-api` 校验 `sourceMessageId` 属于当前用户有权访问的 Conversation 且指向已有用户 Message，并在同一事务中创建引用该 Message 的新 Execution 和 Turn outbox，不创建新 Message；旧回答版本继续保留。Adapter 在当前 Runtime Session 中为新 Execution 提交 Turn。重新生成使用 `commandType = regenerate` 的上述唯一约束；相同 Key 和 `sourceMessageId` 返回原新建 Execution，同一 Key 指向其他 Message 时返回冲突。存在活跃 Turn 时返回繁忙且不创建记录。
- 活跃 Turn 存在、发送者 `actorId` 与当前 Execution 相同且 Adapter 支持补充指令时，只创建 Message 和绑定当前 Execution 的补充指令 outbox，不创建新的 Execution 或 Turn；`messageId` 是 Adapter 提交该补充指令的稳定幂等标识。
- Adapter 只有在原生协议提供持久幂等结果，或 Pod 内 Agent Service、Runtime Host 或 Bridge 能按 `messageId` 持久去重并恢复原提交结果时，才能声明补充指令 capability。Worker 或 Pod 重启后重复提交同一 `messageId` 必须返回原结果且不能再次追加；不能满足该约束的 Runtime 不开放补充指令。
- 补充指令 outbox 只有在绑定 Execution 的初始 Turn 已被 Runtime 明确接受后才能投递；初始 Turn 尚未投递或接受结果不确定时保持待处理。同一 Execution 的补充指令按 outbox 创建顺序串行投递，不能抢在初始 Turn 前调用 Runtime。若初始 Execution 在 Runtime 明确接受前进入失败或取消终态，`platform-worker` 必须在同一 Conversation 锁内将其全部待处理补充指令 outbox 置为失败终态，并将对应 Message 标记为“投递失败：原回复未开始”；不得继续重试、创建新 Execution 或改绑其他 Execution。
- `platform-worker` 认领补充指令 outbox 时，先按工程 Spec 的[权限顺序](SPEC-agent-infra-M1-engineering-architecture.md#92-权限顺序)重新解析该 `actorId` 的当前授权，再在 Conversation 锁内重验绑定 Execution。权限已失效时，平台在同一数据库事务中将 outbox 置为失败终态、将 Message 标记为“投递失败：权限已失效”，且不调用 Adapter；Execution 已终止时，同样将 outbox 置为失败终态并将 Message 标记为“投递失败：原回复已结束”。只有权限仍有效且 Execution 仍活跃时，平台才签发符合工程 Spec 的新短期 Execution Grant 并按 `messageId` 提交。Adapter 必须拒绝已经终止的原生 Turn。失败后不能自动重试、创建 Execution/Turn 或改绑其他 Execution；同一 Idempotency-Key 重放仍返回该失败 Message 和原绑定 Execution，用户重新发送时使用新 Key 并重新执行准入分支。
- 同一发送者不支持补充指令或不同 `actorId` 提交消息时，平台返回繁忙且不创建 Message、Execution 或 outbox。普通消息、补充指令、重新生成和繁忙分支的判定与写入必须原子完成。
- 使用者停止命令必须携带 `targetExecutionId`，且不创建 Message 或新 Execution。`platform-api` 在 Conversation 锁内校验目标 Execution 属于该 Conversation、发送者 `actorId` 与目标 Execution 相同，并原子创建绑定目标 Execution、来源为使用者的 stop outbox；每个 Execution 只有一个有效 stop outbox 和平台生成的稳定 `stopRequestId`，相同 `targetExecutionId` 的重复 HTTP 请求返回已有停止状态。目标 Execution 已经终止时幂等返回“已结束”；即使另一个 Execution 已经活跃，也不能把旧请求改绑到它。其他发送者无权停止且不创建 outbox。
- `platform-worker` 认领使用者来源的 stop outbox 时，先按工程 Spec 的[权限顺序](SPEC-agent-infra-M1-engineering-architecture.md#92-权限顺序)重新解析该 `actorId` 的当前授权，再在 Conversation 锁内重验目标 Execution。授权仍有效时，只有目标 Execution 属于该 Conversation、发送者 `actorId` 与目标 Execution 相同，且初始 Turn 已被 Runtime 接受并仍活跃，才携带当前 Execution fence 和独立 `stopRequestId` fence 调用 Adapter；该调用及 stop outbox 回写校验两个 fence，但不改变 Execution fence。目标已经终止时将 outbox 置为成功终态。身份或权限依赖暂时不可用时保持待处理并重试，不能调用 Adapter 或把未知状态写成失败终态。
- 用户或应用主体被服务端确认禁用时，平台必须独立于使用者请求，为该主体的全部活跃 Execution 幂等创建平台来源的 stop outbox；若仅有某个 Agent 的可用范围或某个渠道的权限被撤销，则只为服务端保存的 Agent 或渠道授权上下文受该撤权事实影响的活跃 Execution 创建 outbox。已有使用者来源 outbox 时复用其 `executionId` 和 `stopRequestId` 并把停止依据提升为平台确认的撤权事实。使用者命令本身不再提供调用权限，Worker 只根据平台来源、服务端撤权记录和目标 Execution 当前状态执行控制操作，不重新要求已撤权主体具备权限；平台按工程 Spec §9.3 签发绑定原目标及 stop 操作的控制用途 Grant，Host 校验其用途、绑定、有效期和 fence，仅执行获准的停止、状态核实、屏障及原执行未确认事件向平台持久化处理器的续传与确认，不允许恢复业务调用或向用户返回正文。尚未准入的 API 等待任务在同一授权边界内直接取消，不再投递；API 凭证单独失效不触发本规则。初始 Turn 尚未被 Runtime 接受时按下一条规则本地取消；已接受且仍活跃时调用 Adapter，Adapter 或恢复查询确认停止后才把 Execution 置为“已取消：权限已失效”；Runtime 已经终止时保留其实际终态并完成 outbox。已经提交给外部 Provider 的操作不自动撤回。Adapter 和 Agent Service 把同一 `stopRequestId` 的重复停止视为同一命令。
- 初始 Turn 调用 Runtime 前，`platform-worker` 必须在 Conversation 锁内重验同一 Execution 没有 stop outbox，并在同一事务中取得 Turn durable lease、提升 Execution fence，再把 Turn outbox 从待投递原子迁移为“投递中、接受结果不确定”；事务提交并释放锁后才能携带当前 Execution fence 调用 Adapter。若迁移前已有 stop 且 Runtime 明确未接受初始 Turn，Worker 在同一事务中取消待投递的 Turn outbox、把 Execution 置为“已取消”、把 stop outbox 置为成功终态，并按前述规则结束全部待处理补充指令，不调用 Adapter，初始 Turn 后续不得再投递。同一事务还写入一条平台来源、空 Runtime cursor 的 `execution.status: cancelled` 事件，使会话时间线收敛；该事件只表示平台确认的本地取消，不代表 Runtime 终态，平台不为已被 Runtime 接受的 Turn 合成终态事件。Turn outbox 已进入“投递中、接受结果不确定”时，stop outbox 保持待处理且不提升 Execution fence；当前 Turn Worker 先按原 `executionId` 和 Execution fence 恢复查询。Turn 租约过期或释放后，接管 Worker 必须提升 Execution fence 并以新 fence 恢复事件管道；只有 Runtime 明确未接受且 Agent Service 已持久化新 fence 的 cancellation barrier、阻止旧 Worker 迟到提交时才能本地取消，无法确认时继续保持接受结果不确定。
- `executionId` 是 Adapter 提交 Turn 的稳定幂等标识。协议不能确认是否已接受 Turn 时，Adapter 将 Execution 标记为状态不确定并恢复查询，不能盲目重复提交。

Codex 配置变化后的原执行核实与控制遵循工程 Spec 的
[10.8](SPEC-agent-infra-M1-engineering-architecture.md#108-codex-原生模型传输边界)。Host 已保存
unknown 受理回执时，后续查询须按原 operationId 再次只读查询 Driver；缺失或仍未知时
继续 unknown，不调用 execute 补造受理。旧 accepted/running 回执不代表当前仍活跃。
Worker 先沿原执行核实状态；确认原 Turn 已接受且当前仍 running 后，才按既有投递事务
恢复 processing 并派发原 stop。受理未明时保持 stop 待处理；取得可靠终态后沿原事务
保存实际结果并收敛 stop，不重建 Session/Turn，也不以停止 ACK 释放占用。原 journal
已持久化的事件可沿原游标先行恢复，不以新的业务模型准入或当前配置匹配为前置；事件、
必要审计、游标及 ACK 继续遵循 8.2 和工程 Spec 9.3。

历史主体迁移保留原 Session、操作标识、输入与模型选择、请求摘要和已保存结果。平台按
可信原 producer 证据持久化迁移来源及必要审计；已提交的系统迁移审计是工程 Spec 9.3
允许的独立恢复控制来源。Host 只消费绑定当前部署和完整旧 submit 集合的签名映射，任一
execution/turn/digest 不匹配时整次拒绝。映射由部署提供受保护的只读文件及独立信任根，
不能通过业务 HTTP、环境变量中的主体正文或可写数据目录注入。仅证明主体而未证明原
业务范围时，只能凭独立控制 Grant 做无正文恢复和受限控制，不重发 unknown Turn。
同一迁移证明重放绑定相同内容，不能更新原主体；迁移完成后不把一次性映射改签成新归属。

### 8.2 事件去重

- 每个 Adapter 必须为原生事件提供跨重连稳定的 `adapterEventKey` 和可持久化的 Runtime 事件恢复游标。优先使用 Runtime 提供的持久事件 ID；若 Runtime 不提供稳定 ID 和重放，则 Pod 内的 Runtime Host 或 Bridge 必须在首次转发前持久化事件日志并分配单调事件 ID，保留未确认事件并支持按该 ID 重放。禁止使用重连后可能重置或重新分块的流内序号派生。
- Platform DB 对 Runtime 来源事件的 `(executionId, adapterEventKey)` 建立唯一约束，并在处理事件时先查找该键。已保存的重复事件直接返回原 `eventId`、`sequence` 和 `conversationCursor`，不再次写入或推进游标；只有新事件才校验当前 `sessionGeneration` 和 `deliveryFence`，旧 token 产生的新事件或状态写必须拒绝。新事件首次插入成功时，平台通过 Conversation 锁或等价的数据库原子序列机制，在同一事务中保存事件、推进该 Execution 的已确认 Runtime 事件游标，并分配稳定 `eventId`、Execution 内递增 `sequence` 和 Conversation 内严格递增 `conversationCursor`；事务失败或 token 过期不产生可见事件、游标推进或平台确认。
- Runtime 来源与 Platform 来源事件共享 Execution `sequence` 和 Conversation `conversationCursor`，数据库保存不可由 Runtime 命令选择的来源判别。Runtime 来源必须保存非空 Runtime cursor，且 Runtime 事件 Interface 不接受 Platform 来源类型。平台任务的受理、等待、取消请求/确认、失败和待核实等状态事件，以及 `model.selection.fell_back`，只由 Core 的对应事务写入并保存空 Runtime cursor；Platform 操作的每次持久状态转换生成稳定事件引用，重试复用原引用，不同事件类型或不同状态转换不能共用去重键，也不能伪造 Runtime cursor。标准模板所选模型或推理强度失效时，消息准入事务将 notice 和对应审计绑定到本次消息的 Execution：初始消息与重新生成绑定事务内新建 Execution，补充指令绑定已锁定的活跃 Execution；payload 只保存实际采用的 `modelOptionId`、`reasoningLevel` 和固定 `selection_unavailable` 原因。该事务同时分配并推进下一 Execution `sequence` 和 Conversation `conversationCursor`，但不改变最后确认的 Runtime cursor；幂等重放返回原消息结果且不重复事件，后续或并发 Runtime 事件从已推进的平台计数器继续分配。事件、审计、消息、Execution、outbox、幂等记录或任一计数器写入失败时全部回滚。
- Turn 的事件 outbox 只有在 Runtime 终态事件已持久化后才能完成。状态查询返回的终态只证明 Runtime 已结束，不代替事件流排空；Host 按页回放事件时，Worker 在读到终态事件前持续续读，不能因 Platform DB 已记录终态而提前结束。
- Runtime 在事件读完前结束时，Host 不再续期原业务授权。Worker 以状态核实取得终态证明并在同一租约内持久化后，于同一次认领中改用控制用途 Grant 续读至终态事件，outbox 不重新排队（工程 Spec 9.3）；续期被拒但无法证明终态时，沿原恢复路径重新认领。
- Worker 只能在上述事务提交后向 Runtime Host、Bridge 或原生 Runtime 确认已处理游标。Runtime 事件连接中断、Worker/Pod 重启或事件事务失败时，Adapter 从 Platform DB 最后已确认游标重放；事务已提交但 Runtime 确认前崩溃会产生可去重的重放，不能丢失事件。浏览器 SSE 连接状态不得推进该 Runtime 游标。确认是累计的：确认某个已提交游标即确认其前的全部事件，Worker 可以按批只确认最后已提交游标；Runtime 等待确认才继续的事实（如标准工具调用事实）和终态事件提交后立即确认，未确认事件数保持在 Host 上限以内。
- 跨 Execution 或迟到的首次事件按实际持久化顺序追加。重复事件返回已有平台事件及原 `sequence` 和 `conversationCursor`，不能重新分配游标。
- 高频文本可以在同一事务中批量持久化，但不能合并原生事件边界。批次内每个原生事件保留稳定 `adapterEventKey`，按原始顺序独立生成平台事件及游标；事务提交前不能推送内容，重试同一批次必须返回已保存事件及原游标，不能重复追加文本或改变最终文本顺序。
- Runtime 的 `execution.detail` 只作为 Agent 提供的过程摘要，浏览器标明其来源。自由文本或摘要中自报的 `callId` 不能建立可信外部调用绑定，也不能据此补齐模型、Provider、账号或结果。实际模型/工具事实走 8.5 的结构化事件；平台对 Connection 只保存按第 9 节核实的关联引用，不建立 Connection 状态或审计投影。

### 8.3 SSE 补发

- SSE 的 `id` 字段和 Web/API 重连时的 `Last-Event-ID` 都使用稳定 `eventId`。`platform-api` 必须先校验当前用户/应用主体、API 凭证及目标 Conversation/Execution 权限，再在获准范围内查询该 `eventId` 对应的 `conversationCursor`，再按游标补发其后的已保存事件；显式游标请求直接使用 `conversationCursor`，并执行相同的对象权限校验。任务订阅携带 `Last-Event-ID` 或显式 `conversationCursor` 时，必须先确认其定位的持久事件属于目标 Execution，再计算补发起点；即使同属已获授权的 Conversation，也不能用其他 Execution 的事件或游标推进任务订阅。任务订阅只返回目标 Execution 的事件；不可见目标按资源不存在拒绝，不因游标泄露其他任务。目标已获授权但游标属于其他 Execution、未知、越界或超出补发窗口时统一返回“重新加载时间线”信号。
- 实时补发受服务端配置的数量和时间窗口限制，时间窗口按平台持久化事件的时间计算，不信任 Runtime 提供的事件发生时间，避免单次重连无限读取。
- 游标超出补发窗口时，服务端返回明确的“重新加载时间线”信号；客户端先读取 Platform DB 中的持久化历史，再从新的游标继续 SSE。补发窗口不改变业务数据保留期限。

### 8.4 API 任务受理、等待与取消

产品行为引用 [任务 API PRD](../prd/PRD-agent-platform-M1.md#104-agent-api-与后台任务)，平台用例与事务归属引用 [工程 Spec §12.4](SPEC-agent-infra-M1-engineering-architecture.md#124-api-受理调度与恢复)。API task 是原 Execution，不能另建与其竞争的 task/session 状态机。

| 阶段 | Platform Dispatch / Store | RuntimeHost / Driver |
| --- | --- | --- |
| 受理等待 | 保存原主体、Agent/Conversation、输入引用、有效模型选择、幂等绑定、顺序/等待期限、Execution、工作项与必要审计 | 尚未调用，无原生 Turn |
| 准入投递 | 重验当前授权、能力、平台运行状态及对应 Workload 就绪事实，原子占用 Conversation 与 Agent 容量，按 8.1 取得租约并持久化投递状态 | 按原 executionId/operationId、输入/选择和 fence 持久接受、拒绝或报告 unknown |
| 已运行/取消中 | 保存实际事件、取消请求及 stop 工作项；停止未确认不释放 Conversation | 原 Session 执行；stop 与查询沿原操作，不回滚既有外部效果 |
| 待核实/恢复 | 占住受影响 Conversation，保存原引用和可解释状态 | 查询原接受/运行结果；不能盲目重建 Session 或重发副作用 |
| 已确认终结 | 保存真实终态及必要审计后释放占用，再准入下一个任务 | 已确认无仍可产生副作用的旧 Turn；损坏或不可恢复按 7.3 隔离 |

- API 幂等由可信主体类型/ID、操作与 `Idempotency-Key` 组成唯一绑定；请求摘要覆盖目标 Agent、显式会话选择及任务输入。默认新会话不能进入幂等键的先决条件：先在主体/操作作用域查原请求，再决定是否创建 Conversation。当前权限不足先拒绝；同键同请求返回原 Agent/Conversation/Execution，同键不同请求拒绝，不重复消耗容量或改绑。
- 首次受理与 Web/渠道命令共用同一 Conversation 数据库锁或等价条件更新边界，在同一用例事务内检查 Agent 状态、Conversation 占用及等待容量，再按所有入口共享的已提交顺序分配等待位置和平台规定的等待期限，保存表中受理记录。并发新请求必须在该边界内基于最新状态准入、等待或返回繁忙；API 与 Web 不能同时基于空闲快照占位，Web 新 Turn 不能越过已受理任务。启动/更新中允许等待；停止、停用或故障未恢复时拒绝，任务提交不能隐式启动或恢复 Agent。容量满时事务不创建新任务；受理响应只能在业务记录、工作项与必要审计均已提交后返回。
- Worker 只选择同 Conversation 最早且仍有资格的等待任务，跳过已终结任务；当前执行占用、取消未确认或恢复待核实时不准入下一任务。等待期限只终结尚未进入可能产生副作用的投递阶段；已处于接受结果不确定的任务须先完成 8.1 的查询/屏障，不能用等待到期伪造未执行失败。期限与队列顺序不因重启重置，调用方不配置逐任务执行时限。
- Dispatch 准入和实际发送前均须检查 Agent 当前运行状态及与当前配置/Workload 版本匹配的就绪事实，只有可运行且容量可用才发送；启动/更新中保留原等待顺序和期限。生命周期状态变更与容量/Conversation 准入共用 Agent 修订和条件更新边界；已占位但确认未发送的任务在启动/更新中退回原等待位置，停止/停用/故障则以原因明确失败。可能已发送或已活跃的任务保持原 Execution/Session 与占用：停止/停用沿既有 stop 和屏障收敛，故障或更新切换沿 7.3 查询/恢复，不能因 Workload 暂时不就绪直接重投、释放会话或伪造终态。
- 准入与取消、超时、撤权在同一锁定/条件更新边界互斥。取消先完成且确认没有在途投递时，直接终结等待任务；投递先发生则沿原 stopRequestId/fence 查询并停止。API 断线或单个凭证失效不取消已受理任务；系统取消按第 9 节执行。Runtime 已自然完成时保留实际终态，不能以迟到取消覆盖成功或失败。
- 首次运行取消在原 stopRequestId 的事务中保存平台规定的停止确认期限，重复取消与 Worker 重启不重置期限。期限到达仍未确认停止时，持久标记非终态的“待核实：停止确认超时”，保留原请求、Session、fence 和占用；Worker 沿原操作查询并恢复停止，确认无剩余副作用后才终结。自动恢复无法收敛时暴露受控运维处置原因与原执行引用，按 7.3 的隔离/恢复流程处理；人工操作也不能跳过屏障确认、直接释放占用或新建 Session。该期限约束停止确认，不限制原任务的正常执行时长。
- Host 接受结果 unknown 必须恢复查询；已持久 busy/rejected 是该原操作的明确结果，平台将已受理任务收敛为明确失败，不能换 executionId 重投。模型选择沿原受理绑定传递；当前 active 配置不再支持该选择时明确失败，不重新选择默认模型掩盖差异。
- API、Web 和渠道共用 Conversation 的准入与恢复规则；API 等待不会关闭当前 Turn 的合法补充指令能力。会话恢复最终失败时按 7.3 先确认代次屏障，再终结受影响任务；其他 Conversation 可在经验证容量内继续运行。

### 8.5 实际模型/工具事实与必要审计

四个标准 Driver 在实际模型传输、原生工具开始/结束或受控工具执行边界采集事实；Runtime 文本、整体 Turn 耗时和模型声称执行过的动作均不是采集证据。跨进程事实由 `packages/contracts` 的版本化 Zod Schema 发布，Worker 显式映射领域结果；不从日志反解析，也不直接传原生协议帧。

每项实际操作具有绑定 Execution 的稳定操作引用，真实的新尝试另有稳定尝试引用；开始、结束、失败或未知事实各有跨重连稳定的 `adapterEventKey`。事实携带操作类别、父操作关联（适用时）、实际时间/已确认耗时、状态及受限失败原因；模型附实际有效模型/配置引用和可采集用量，工具附实际工具标识及受控结果引用。不能确认的字段明确缺失或不适用，不填零或猜测；Connection 关联须满足第 9 节。

- Host/Driver 在现有执行侧持久层保存实际外部操作意图，完成崩溃一致性确认后才能开始该操作。普通 Turn 的 accepted 记录不能替代每次实际模型/工具外部操作意图。结果/未知事实沿原操作保存，保持原 Session 与恢复引用；原生层隐藏的尝试无法可靠观察或控制时明确记录能力缺口，不能宣称已通过该项 conformance。
- 尚未开始时意图保存失败则阻止操作并返回受限故障；操作已经可能发生但响应或结果保存失败时，只能保留未知并核实原操作，不伪造未执行、不自动重发副作用。Connection 自己保存 Provider 调用意图/效果，Runtime 仅保存自身工具操作，不替 Connection 决定外部结果。
- Runtime 事实复用 8.2 的日志、游标、fence 和重放确认。Worker 在同一用例事务内保存事件及必要平台审计，成功后才确认 Runtime 游标；失败时保留未确认事实并重试保存，不重新执行原操作。平台审计为查询权威，执行侧未确认记录仅用于可靠交付与恢复，不能提前回收。
- 平台 API/Dispatch 自产的受理、等待、投递和结果阶段与 Runtime 事实使用同一 Execution 关联。真实操作及其新尝试按稳定引用分别计数，重连/恢复不重复统计；Connection 记录在独立入口按真实调用核对。
- OpenTelemetry/Pino 导出故障只标记采集/导出异常，不改写任务业务结果；持久意图或必要审计失败按上述可靠性规则处理，两者不能混同。普通任务与 Eval 正文、附件、思考、证明和凭证不进入事实元数据、日志/指标/Trace 或审计；合法任务输入/输出通过受控业务数据路径保存与查询。

#### 8.5.1 Codex 原生执行屏障

Codex 官方 release 的来源、协议/schema、sandbox、能力声明和安装校验以工程 Spec 的
[10.11](SPEC-agent-infra-M1-engineering-architecture.md#1011-codex-上游原生补丁与执行屏障)为准。
普通官方路径不假设存在私有 callback 或 barrier；没有可验证的每次尝试接缝时，不宣称该路径
通过原生屏障 conformance，也不以日志、普通 approval 或缓存补足隐藏尝试。无论路径如何，
每次实际外部动作仍须先保存 intent、重验当前授权并可靠保存结果或 unknown；官方路径无法
可靠控制该边界的操作必须拒绝或标记未支持，不能进入正式 conformance。

Driver 直接执行的标准 MCP 使用工程 Spec
[§13.5.4](SPEC-agent-infra-M1-engineering-architecture.md#1354-runtime-driver-直接消费标准-mcp)
的官方工具请求/结果接缝，在原持久意图、当前授权与结果确认后交付原生响应。
它只覆盖受保护 Driver 内的实际 MCP 操作，不替代其他原生工具或私有 lane 的屏障。

以下屏障契约只适用于明确启用私有 FD callback、Connection bootstrap/recovery 或等价 native
lane 的发布 target。部署 provenance 必须声明 lane、协议/schema 与工具覆盖，且在任何业务
副作用前验证不可由模型/Owner 关闭的 native barrier；缺失、错配、断连、过期或配置被关闭
时 fail closed。该 lane 复用每个 Conversation 代次的原 native 进程、hook 关联及实际工具
执行路径，在执行边界增加强制、可等待且失败关闭的回调。现有 session/turn/tool-use 关联可
直接复用，每个真实新尝试补充稳定 attempt identity；不另建公开 RPC、capability 协商或业务
调度循环。Driver 向 native 继承专用私有文件描述符，native 接管后立即设置 close-on-exec；
通道随原进程生命周期关闭。工具子进程不能继承或重开控制端，模型/Owner 不能改写部署配置
或构造许可；不能用同 UID 可读取的环境变量 Token 或普通 socket 路径替代该隔离。普通用户
hook 与强制回调分别处理，原 app-server stdio 继续承担既有业务协议。

- Driver 把已验证的 thread/Turn/callId/attempt identity 映射到原 Execution 的稳定
  operationRef/attemptRef；每次真实重试单独建 attempt，重复协议请求复用原映射与决定。
  Driver 在同一既有持久层提交 intent 后，释放持久队列再等待当前 Host 业务授权；通过后
  返回仅对该 attempt、代次/fence 与有界期限有效的一次性 permit。Native 在真实 dispatch 前
  校验 permit 与本地取消状态；permit 缺失、过期、拒绝、协议异常或断连不产生该动作。
- 覆盖实际 shell/process spawn、apply_patch（含 shell interception）、非空 stdin/interrupt、
  后台进程真实完成、MCP/受控客户端 dispatch 与其内部新尝试。普通 approval、许可缓存和
  PreToolUse 成功均不跳过屏障；空 poll 属于查询，首次后台 yield 不是原 exec 的完成。
  工具 catalog 或执行路径变更须更新覆盖清单；无法控制隐藏尝试就不得宣称本项通过。
- 实际 spawn/write/客户端调用开始后记录 started；前置验证失败不记录虚构开始或耗时。
  Native 的有限结果或 unknown 由 Driver 确认可靠保存后，才交付原推理循环或进入下一 attempt。
  参数、stdin、正文、credential 和原生帧不进入事实；受控业务输出仍走原生合法存储路径。
- Permit 与结果确认采用可取消的异步请求，不能阻塞 stop/status 消费。停止、撤权或代次隔离
  封闭新准入并处理所有在途请求/后台进程；未确认停止不释放会话。终态事件发布前，各已发生
  attempt 的结果或 unknown 必须已进入同一 journal。
  Codex 的推理 Turn 完成允许后台终端继续运行；Driver 在既有 journal 记录该原生终态，
  直到原后台 attempt 的实际结果持久化前，保留 Execution 与 Conversation 占用，不提前发布
  平台完成。停止复用原生后台终端查询与逐进程终止接口，按原 callId 绑定选择执行源；
  控制请求的 ACK 不作为进程退出证明，仍等待原 attempt 的真实结果，未知时继续保留占用。
- 任一侧在 intent、dispatch 或结果确认附近崩溃，恢复只核实原 attempt；未决记录封闭原 Turn
  的新动作，不自动重发。已保存真实结果而原生输出交付不明时保留真实结果并标明交付未确认，
  不改写为未执行。公共事实/必要审计/游标确认继续遵循 8.2/8.5，不建立第二事实或授权数据源。

原生子 Agent 沿用原 Codex 多 Agent 能力、Submission 队列与任务生命周期，归属发起它的
同一平台 Execution；不新建平台 Conversation、Session、任务循环或身份服务：

- 父工具实际 attempt 的可信引用通过 Core 内部交接进入原提交队列。真实 child thread 与
  submission ID 在入队前以来源预留记录持久保存，覆盖父工具先返回、child 尚未开始的
  占用窗口；该记录不声称 child Turn 已发生。已入队后调用方丢失 waiter 不撤回原提交。
- Started 使用实际 thread/Turn，在原任务异步入口、所有可产生动作的生命周期回调及
  推理之前，通过同一私有 FD 将来源预留绑定到原 Execution。队列消费栈及 active Turn
  锁不能等待该交换。Steered 沿既有 Turn，在真实输入追加前核对已确认且不可变的来源
  归属、本地取消和期限；离锁核验后重新取锁必须仍是原 thread/Turn，不能误投下一 Turn。
- Driver 从同 Conversation 内已保存的父 attempt、permit 和实际 started 回执验证子来源，
  递归归到原 Execution。父/root header、普通 spawn 返回值及共享 session 标识只能辅助
  核对，不能创建关联。父工具完成或原 permit 后续到期不抹除已发生的来源；子来源每次
  模型或工具动作仍检查原 Execution 当前授权。模型入口按工程 Spec 10.8 的进程 token
  与已持久来源查询，不凭首个 HTTP 请求建立子 Turn 准入。
- 原 Execution 的完成条件同时包含根推理结束、全部来源预留已核实、child 推理与收尾
  已确认结束，以及原模型/工具/后台结果已可靠保存。停止先封闭所有来源新准入，再按
  已存 thread/Turn 和原 callId 定向控制；父推理完成不阻止同 Execution 已确认且仍活跃
  的 child 继续工作。未知、RPC ACK 或一次空列表不释放占用。
- 取消确认必须等待原任务实际 join、abort hooks 和可产生动作的收尾结束。正常完成已
  移出活动任务但仍执行 hooks 的窗口继续占用；interrupt 找不到活动任务不代表收尾结束。
  FD 交换开始 I/O 后取消，必须先关闭原通道再释放交换锁，不能复用半帧或迟到回执。
  来源绑定或结果确认失败时沿原引用核实，不能重发 spawn、send_input 或新 Turn 补证据。

这里的 attempt 是一次原生工具执行或受控客户端实际 dispatch；该采集不声称覆盖任意 shell
内部的每个 syscall、子进程或网络请求。Connection 的 Provider 尝试与真实外部效果仍由其
独立服务负责；Runtime 不能从工具成功推断 Connection 成功。

#### 8.5.2 Codex 模型切换前置压缩

模型选择、原生补丁范围及产品保证以工程 Spec
[10.8](SPEC-agent-infra-M1-engineering-architecture.md#108-codex-原生模型传输边界)为准。
Driver 仍只准入本次 Execution 冻结的 B；压缩与后续普通采样都是 B 的真实模型请求，复用
8.5 的模型 operation/attempt、用量和持久确认，不新增授权用途或第二套事实来源。

- 固定原生的 `CompHashChanged / PreTurn` 与 `ModelDownshift / PreTurn` 实际压缩调用点显式使用
  当前 B 的 TurnContext/StepContext，包含原有效模型 profile 与已验证 reasoning；保留
  原 comp_hash、基于 A/B 原上下文的前后窗口比较、触发时机和实际压缩路径；不能用 B
  覆盖供触发判断的 A 上下文。原生旧模型 metadata 只参与原历史与触发判断，不读取或恢复
  A 的凭据，不要求已删除的 A 选项仍获准。
- 保持原 Session/thread/Turn、历史和恢复引用。前置压缩仍在本次新用户消息及上下文更新
  入历史前执行，成功后按原生顺序安装压缩历史并用 B 处理新消息；已有产品消息不被重写。
  原生历史标准化、窗口限制、overflow 处理与摘要安装算法保留；历史及传输层的禁止事项遵循
  [工程 Spec 10.8](SPEC-agent-infra-M1-engineering-architecture.md#108-codex-原生模型传输边界)。
- 每次真正转发前按 8.5 保存意图并重验当前授权；原生内部 retry 也受相同屏障约束。
  结果或 unknown 沿原 operation/attempt 保存。任一已发请求结果未知时封闭原 Turn 新动作，
  只核实原请求；不得借新 attempt、permit、operation、进程重启或恢复重放压缩或开始回答。
  已保存模型结果但原生历史安装或输出交付无法确认时，保留真实结果并标明未确认状态，
  不改写成未执行，不重新调用模型补证据；停止及占用收敛继续遵循 7–8.5。
- B 被撤销、选择不匹配或持久意图失败时，按既有模型边界拒绝尚未转发的请求；provider
  拒绝、不完整响应及恢复失败沿原生与 Driver 已确认的事实返回脱敏失败或 unknown。
  原生既有 overflow/retry 不构成跳过意图、unknown 或取消屏障的许可；明确失败与允许的
  后续真实尝试仍按现有契约判定，不因本策略增加重试或永久失败政策。
- local 压缩不会按 comp_hash 自动证明或转换跨模型的 reasoning/加密历史兼容性。
  remote compaction 的上游 B fallback 不证明 local provider 兼容，也不授予其重试策略。
  完整验证矩阵以[第 11 节](#11-验证)为准；任一路径仍发 A 时继续拒绝并登记未完成差额，
  部分案例通过不能签收完整模型切换修复，不以此限制 PRD 支持范围。

#### 8.5.3 OpenCode 原生工具回执

OpenCode 的来源、维护和启用前置以
[工程 Spec 10.13](SPEC-agent-infra-M1-engineering-architecture.md#1013-opencode-原生工具回执与来源)为准。
Generic ACP 保留权限、进度与未知结果的协议语义；可信开始与结果只由经过验证的实际执行端提供。
公开 Plugin 接缝的可用性须在固定源码和 artifact 中核对，不假定 before hook 位于工具内部
权限检查之后，也不假定成功后的 after hook 覆盖抛错、取消或内部新尝试。

官方公开扩展的替代边界由固定工具扩展请求现有 Driver 信任域中的执行叶子完成实际 I/O。
扩展请求与模型/ACP 进度不能写入可信回执；只有执行叶子沿原 journal 记录实际开始和结果。
模型可用的每项工具须先验证与原承诺行为等价，原 built-in 及其他可绕过该叶子的入口须实际
阻断。固定扩展、工具和配置受版本/hash 与只读装配控制，不加载 Owner 或工作区可写的替代
实现；提示词、默认配置或一条自有工具成功不能证明完整覆盖或隔离。

公开入口须把每个真实执行请求无歧义地绑定到 Driver 已冻结的原 Session/Execution、代次
和 fence，并持久保存 request 与 operation/attempt 的映射。固定 V1 ToolContext 未公开
callID，不能依赖未声明字段、当前 Execution、参数相等、队列次序或模型自报 ID 补足绑定。
before hook 提供 callID 本身不证明其与实际请求的关联；同参数并发、跨 Execution、旧请求
重放及原 Session 重启均须实证。不能建立可信映射时拒绝执行，不补造原生调用事实。

- 原生接缝将可信 session/Turn/callId 和每次内部尝试绑定到原 Execution、代次/fence
  与稳定 operationRef/attemptRef。重复控制请求复用已保存决定，真实新尝试独立标识；
  模型参数、ACP 任意进度帧与另一 Execution 的相同 tool ID 不能建立该绑定。
- 每次实际文件操作、process/client dispatch 前，Driver 沿现有 journal 确认 intent，
  释放持久队列后等待当前 Host 授权。实际执行端校验该 attempt 的许可、代次和本地取消状态；
  拒绝、过期、错配、断连或持久确认失败不开始动作。工具内部权限与普通 hook 保留原职责，
  许可缓存不跳过每次屏障；最终操作内容变化须重新核对，不能使用变更前的许可。
- Permit 是准入确认。started 只来自实际 I/O 或 dispatch 已开始的回执；前置验证、
  权限等待和拒绝均不记录虚构开始或耗时。结果、抛错、取消和可能发生后的 unknown 沿原
  attempt 保存并确认，确认完成前不向原生推理循环交付该结果或开始后续动作。
- 控制通道复用现有 Driver/Native 生命周期，ACP stdio 继续承担业务协议，不增加公开 RPC、
  capability 协商或调度循环。接管的控制端必须隔离于工具子进程并在 spawn 前封闭继承，
  模型/Owner 不能关闭、改写或伪造许可；同 UID 可读取的 env Token 或普通 socket 路径
  不能作为隔离证明。确认等待可取消且不占用状态/stop 消费所需的持久锁。
- stop、撤权和 generation barrier 封闭新准入并排空在途控制请求及实际执行源；未确认
  停止不释放占用。任何一侧在许可、实际开始或结果确认附近崩溃，只核实原 attempt，
  保留已保存结果和未确认交付；未知不自动重发，也不借新 attempt 或 Session 补证。
- 工具覆盖清单绑定真实 artifact 及扩展：原 built-in 与替代叶子分别记录，read/write/edit
  及其内部动作逐项验证，声明的
  其他 built-in、委托调用、后台动作和内部 retry 都独立覆盖。能力缺口保持未通过，
  不从另一工具的结果推定；正文、文件内容、参数、凭证和原生错误留在受控业务路径，
  不进入操作事实或遥测。公共事实、必要审计和游标继续使用 8.2/8.5 的唯一事务边界。

### 8.6 Eval 复用

Eval 在 Platform 管理数据集/标准版本、实验、规则/人工/模型评分、复核与反馈；Runtime 不保存另一份实验状态，也不负责汇总质量分。每个样本复用原发起主体获准的任务用例，默认使用独立 Conversation；模型调用和独立模型评分使用 Agent 默认 Relay Key，展示费用归属，Key 不可用时对应执行或评分失败而不重跑已完成样本。正常执行/查询/取消和实际模型/工具采集均遵守本 HLD。

Platform 在受理、实际投递及数据读取前校验当前 Agent 使用权和独立 Eval 用途授权；Worker 不能用服务身份或 Owner/应用责任人角色扩大权限。Runtime 只消费已获准的任务输入和模型选择，受信执行事实回传实际模型/配置、时间及可获得的用量，由 Platform 关联实际模板/镜像及数据集/评分器版本。评分重试不重跑业务任务；标准模板历史版本对比不赋予 Owner 锁定生产旧版本的能力。

测试集与输出属于受控 Eval 数据，线上正文不自动进入数据集。工具使用受控测试账号/环境/响应，不能自动重放线上写操作，Connection 授权仍独立生效。自定义 Agent 只按已验证任务和采集能力参与；`self-managed` 的声明或管理 API 不能开启平台 Eval。详细质量、评分、数据生命周期与反馈规则引用 [工程 Spec Eval](SPEC-agent-infra-M1-engineering-architecture.md#184-eval-数据与执行)。

## 9. Runtime 身份上下文

身份解析、Execution Grant、Connection 独立直连和自有交互入口的 Auth Gateway 以工程 Spec 的[服务端授权上下文](SPEC-agent-infra-M1-engineering-architecture.md#93-服务端授权上下文)、[Connection 架构](SPEC-agent-infra-M1-engineering-architecture.md#13-connection-架构)和[自有交互入口](SPEC-agent-infra-M1-engineering-architecture.md#143-自有交互入口)为唯一权威。Runtime 和 Adapter 只消费这些边界：

- 每个 Turn 和每条补充指令只接受投递前按当前权限签发的短期 Execution Grant，绑定用户/应用类型及稳定主体、Agent、Conversation、Execution、渠道、命令与附件范围；标准模板业务 Grant 还按[平台 PRD 第 8 节](../prd/PRD-agent-platform-M1.md#8-标准模板的模型配置)绑定本次 Key 用途、引用和版本而不含原值。固定 env、API/浏览器身份字段和 Runtime 返回值不能替代当前身份或扩大原受理范围；应用任务不能映射为自然人责任人的任务。
- API 凭证只在平台入口校验，不送入 Runtime。单个凭证过期/撤销时平台关闭该凭证的访问与订阅，已受理任务继续；同主体另一有效凭证可以按当前权限查询/取消，其他主体不能接管。任务详情、SSE、附件及自身审计匹配提交主体，Owner/责任人无额外内容访问权。
- 主体禁用或 Agent 使用权撤销时，平台取消等待任务并为活跃执行持久发出系统 stop；RuntimeHost 执行已确认撤权控制后阻止该执行的后续受控命令和模型/工具操作，直到按 8.1/7.3 确认停止或隔离。控制操作独立于调用方权限，已发生效果保留；短期 Grant 不能被用于绕过已接收的停止/屏障。
- Agent/客户端使用原执行用户或应用在 Connection 独立取得的客户端访问凭据直连 MCP/API；后台执行同样遵守，Pod/workload、Runtime Execution Grant 和平台服务身份均不用于替代 Connection 授权。凭据缺失/失效时拒绝调用，不能回退到 Owner 或应用责任人的身份。平台不代理、签发 assertion、校验 Owner Action policy 或复制 Connection 目录/状态/审计，外部账号原始凭证始终留在 Connection。
- 关联遵循工程 Spec §13.2：受信工具采集在调用前绑定原 Execution/操作/尝试，只从同一次经认证的 Connection 请求/响应取得 Connection 服务端生成的原调用引用，并在 Connection 自身授权下核实主体、操作及原记录与本次请求一致。采集证据随 8.5 的事实可靠保存，平台只接收关联引用和核实状态，不接收 Connection 客户端凭据或调用记录副本。Runtime 摘要、自报 callId、模型转交的真实引用、签名或任意相同字符串都不能独立建立绑定；同主体/Agent 的其他 Execution 调用也不得被重绑。响应丢失时仅沿原操作查询核实，不重发工具操作；缺失/未知如实展示。两侧分别在受控 API/页面查询，关联不授予权限；Connection 的引用返回/核实接口及 OAuth/LDAP/Grant 协议由其 HLD 维护。
- `self-managed` 使用平台身份入口时，自定义 Agent 服务端只信任 Auth Gateway 传递的短期签名上下文并负责校验；浏览器身份字段不能改变最终身份。该上下文不创建 Platform Conversation、Execution 或 Execution Grant。

### 9.1 Codex 独立 Connection consumer profile

固定官方 Runtime 的标准 MCP 客户端优先消费 Connection 签发的 OAuth token 或获准 PAT。
主体/Agent 独立 token、binding、SecretRef 与保管边界以
[工程 Spec §13.5.3](SPEC-agent-infra-M1-engineering-architecture.md#1353-secretref权威与交付边界)
为唯一权威。配置和 token 可用不证明真实工具事实或完整 Connection conformance；各模板的
固定版本、实际客户端与凭据保护须分别验证，不能从 Codex 安装说明外推其他 Driver。

客户端使用完整获准 profile 的 HTTPS origin/resource 与当前 token。RuntimeHost 已验证的
原 Execution principal、Agent、Conversation 和 generation 只用于选择受保护客户端绑定；
Connection 仍在每次请求及 Dispatch 边界独立鉴权。Owner、应用责任人、控制命令或 workload
身份不能替换原主体。token 不进入普通配置、env、argv、模型、工具子进程、持久 journal
或日志；缺失/失效时拒绝，不使用其他主体或共享部署 token fallback。相同用户的不同 Agent
使用独立 token，Session 恢复不能借另一主体、Agent 或 Sandbox 的客户端状态。

标准客户端需实证 token 只被获准 HTTP/MCP 消费边界读取，工具子进程和其他主体/Agent
不能读取文件、内存或继承凭据。仅有普通配置 Header、环境变量名或文件权限声明不能证明
隔离；当前官方版本不具备所需保护时，该能力保持未通过，不通过新增代理或 token 暴露绕过。

Runtime 可按工程 Spec
[§13.5.4](SPEC-agent-infra-M1-engineering-architecture.md#1354-runtime-driver-直接消费标准-mcp)
选择 Driver 作为直接标准 MCP 客户端：token 保留在 Host/Driver 受保护边界，原生只通过
固定官方工具请求/结果接缝交互。此客户端不提供 MCP 转发服务，不取得 Provider 凭据，
原主体/Agent/Session 选择与秘密保护、结果等待和失败关闭完整遵循该节；不能用工具定义
或 response 可用声明整个原生 barrier 已通过。取舍见
[ADR 0019](../adr/0019-run-standard-mcp-in-protected-runtime-driver.md)。
安装来源、分离 material、不可变修订和原子交付仅遵循工程 Spec
[§13.5.5](SPEC-agent-infra-M1-engineering-architecture.md#1355-受保护安装交付)。
Runtime 内接收不替代合法领取；配置缺失与已配置但不可用分别处理，原控制和已有工具
快照保持。供应未知时不选择普通 Secret/env、原生 helper 或 Worker 解密作为替代。
标准 OAuth 的合法领取、回跳转交、原主体确认、发布与不确定性只遵循工程 Spec
[§13.5.6](SPEC-agent-infra-M1-engineering-architecture.md#1356-标准-oauth-安装供应)。
API/Worker/Web 不取得 Token；OAuth 事务来源不代替原主体/实例映射与 Connection 当前授权，
供应合同不足时不启用，PAT 路线不被 OAuth 回跳或兑换要求覆盖。

平台自有的安装确认、非敏感命令交付和 callback 定位沿同一 §13.5.6 实施：Worker 使用
当前原 claim，不为登录创建或延长 Turn；Host 的 `createRuntimeOAuthApp` 为
`createProtectedRuntimeOAuthClient.callback` 使用独立 callback-only 认证，业务/安装
凭据不跨路由复用。回跳成功仍须原主体独立确认及来源核实，不开放 MCP 或改变既有
Thread 快照；转交 unknown 不重发 code。此合同先沿
[#1589](https://github.com/AgoraIO-Extensions/agent-infra/issues/1589) 评审，未实现时保持不可用。

sender constraint 仅在获准 profile 明确要求时按 Connection HLD §3/§5.2 验证，缺少必需证明
仍 fail closed；普通 token profile 不以 DPoP、私有 callback 或 FD3 为通用接入前置。

可信采集在实际请求前沿原 journal 固定 Execution、operation/attempt 与请求身份/摘要，
从固定 origin 的同次认证 MCP 响应读取真实调用引用；在 Connection 自身授权下核对原调用
主体、Action、参数与本次实际请求。已有标准 MCP 结果可以成为采集来源，但模型转交的
structuredContent、任意 callId、相同参数、时间或其他执行的真实引用不能证明绑定。
具体结果/查询格式消费服务发布的版本化合同，不假设存在特定 identity、calls 路由、签名
receipt 或私有 nonce 字段；缺失或无法核实保持 unverified/unknown，不降低产品关联义务。

原业务进程退出后，只从受保护 journal 中已有的原请求/响应事实恢复核实，使用原主体与
Agent 当前有效 token 只读查询原记录；不新建业务 Session/Turn、不重发 MCP 工具或 Provider
操作，也不建立第二调度循环。原 operation/attempt、终态、计数、outbox/游标/事务 ACK 与
第 7.3 节代次屏障继续有效，不能用当前身份或另一真实调用补造丢失证据。

若另行批准并启用私有 native callback/FD3 bootstrap/recovery，则只在该 lane 按 8.5.1
验证 provenance、版本化输入、不可关闭的 native barrier、slot 绑定及持久结果确认。
FD3 在任何子进程前关闭继承；token 只进入获准原 native HTTP 客户端内存，交付前验证
native 与 Node Bridge 的同 UID 文件/内存读取隔离。Linux syscall 过滤与 Darwin Seatbelt
均须通过最终产物的真实负向测试。私有 rmcp leaf 的 nonce/receipt 和只读恢复格式仅用于
其获准合同，不能反向作为所有标准客户端或 Connection 系统的接口要求。

Runtime callback/client 准备层只校验受信投影和原执行绑定，不签发 Connection token、
不注册 ConsumerInstance、不替服务端验证当前 Grant；内部 slot/clientId 也不构成授权。
执行期文件访问由可信 Worker 经 Platform 文件服务签发独立对象级授权，RuntimeHost 消费 `FileAccessGrantV1` 并通过平台认证数据面传输；旧 Execution Grant 仅保留输入附件读取范围。结果必须在对象确认和文件记录提交后才能引用。签发、audience、当前授权、代次、重放及撤权以 [工程 Spec 文件条款](SPEC-agent-infra-M1-engineering-architecture.md#154-文件) 为唯一权威；Driver 不持有对象存储凭证。

## 10. Runtime 安全约束

Agent Pod 的 ServiceAccount、网络隔离、出站范围、Secret 注入和运行时权限以工程 Spec 的[安全基线](SPEC-agent-infra-M1-engineering-architecture.md#17-安全基线)为唯一权威。Runtime 和 Adapter 不能要求超出该基线的数据库、部署解密私钥、Kubernetes 或原始凭证权限作为运行前提。

只读根文件系统下的可写临时卷与生产、探针装配一致性遵循工程 Spec 的 [Adapter 部署与 Registry 边界](SPEC-agent-infra-M1-engineering-architecture.md#112-adapter-部署与-registry-边界)。临时卷可写不替代原生 readiness 和 Conversation 隔离验证。

Runtime 事件遵循工程 Spec 的[事件保存](SPEC-agent-infra-M1-engineering-architecture.md#123-事件保存)与脱敏边界。

历史迁移的部署入口使用独立的[一次性迁移 Job](../../deploy/helm/runtime-legacy-migration/README.md)，
由既有 CLI 消费原 PVC 及独立只读信任文件。部署方先完成正常停机和 PVC 清退；提交模式还须
维持全部 Platform API/Worker 入口的隔离维护窗口。该 Job 不属于主应用升级 hook，不改变
第 8.1 节的历史证明与授权约束，也不向长期 Workload 增加未消费的信任配置。

### 10.1 Codex Linux sandbox 启动准入

Codex Native Bridge 在 Linux 由部署可信 `setpriv` 的 Landlock 边界承担全部文件约束，并把固定 Codex 版本的后端选择保持在 legacy Landlock（`features.use_legacy_landlock=true`），避免残留代码路径落到需要 namespace 权限的后端。原生自身的文件 sandbox 在 Linux 关闭，理由与代价见工程 Spec 的 [Codex 原生 Conversation 隔离边界](SPEC-agent-infra-M1-engineering-architecture.md#109-codex-原生-conversation-隔离边界)。部署支持范围以工程 Spec 的 [Adapter 部署与 Registry 边界](SPEC-agent-infra-M1-engineering-architecture.md#112-adapter-部署与-registry-边界)为准。

每次启动 `app-server` 前，Bridge 必须以相同运行身份和容器安全约束，在不含模型凭证的独立探针子进程中，通过部署提供的可信 `setpriv` 实际创建并应用处理 `fs:ioctl-dev` 的 Landlock 规则集，然后执行固定无副作用命令。该权限自 ABI V5 引入；安装过程必须直接要求该权限，不得屏蔽内核不支持的权限位。部署必须从受维护发行版安装 `setpriv`，通过固定可信 PATH 提供它，并以镜像权限及只读根文件系统保证运行用户不能替换它；其版本和包来源随最终镜像记录并纳入扫描。可信 PATH 属于部署装配，不能由用户请求或 Grant 覆写。

只有探针正常退出且退出码为 0，才允许启动 `app-server` 并向原生子进程注入受限模型传输凭证。工具缺失、无法安装或应用规则集、异常退出、非零退出和超时均拒绝启动，返回稳定且脱敏的错误；不回退到部分权限或 unrestricted 模式。该准入不新增 RuntimeHost 对外配置或改变 Agent Runtime Contract。

### 10.2 Codex 原生 Conversation 隔离

Codex Driver 在所属 Sandbox 内按可信 Agent/Conversation/generation 派生的存储键，为每个 Conversation 代次运行独立的原生进程与持久目录。文件边界在 Linux 由部署可信 `setpriv` 的 Landlock allowlist 单独施加、在 Darwin 由固定 Codex 版本自身的权限 profile 施加，无法施加边界的平台拒绝启动。启动准入按进程执行，因此 Driver 打开时不再预启动原生进程。约束与验收要求以工程 Spec 的 [Codex 原生 Conversation 隔离边界](SPEC-agent-infra-M1-engineering-architecture.md#109-codex-原生-conversation-隔离边界)为唯一权威。

## 11. 验证

### 11.1 通用 Runtime 与 Driver 验证

Session-owned Sandbox 的 P0 验收须从 Web、企微和 API 三入口分别为同一 Agent 建立两个
独立 Session，回读不同实际 Pod/Runtime、Service、身份、持久工作区、网络策略及授权/fence。
至少使用 Codex 与另一个真实支持的 Runtime，其余 Runtime 逐项记录支持与缺口。本人文件读写
和任务结果必须成功；跨 Session 文件列举/读取/修改、环境、进程、记忆、模型上下文、凭证和
Connection 结果均须拒绝且不泄漏存在性。同主体不同 Session 也适用，渠道不合并。
覆盖并发、幂等、撤权、旧代次 late call、停止/unknown、SSE 与 Pod/Worker/Host/Runtime 重启恢复，
绑定准确源码、镜像 Digest、配置和 CNI；目录名、thread ID、fixture 或健康检查不构成运行证明。
文档合并仅冻结契约，不表示上述隔离或完整 Pilot 已验收；唯一交接见
[Sandbox ADR](../adr/0017-session-owned-sandbox-isolation.md)。

- 四个标准模板运行同一 Conformance Suite：Session 创建/恢复、带 Execution 级有效模型选择的 Turn、流式事件与按已确认游标重放、停止、状态和 capability。
- 四模板分别以真实镜像、Driver 与 Relay 模型链路验证可申请状态；未就绪项显示受限原因并拒绝申请。合成目录、`/v1/models` 可见、Fake Driver 或单个模板通过不证明其他模板就绪。
- 标准模板 Key 契约覆盖同 Agent 的 Alice/Bob 使用不同个人 Key、Web/企微与全部 API/Eval 费用归属、缺失/失效/额度不足不回退、Owner 清单与个人 Key 实际权限不一致的调用失败、Key K1→K2 替换后的新旧执行分离、Relay 撤销 K1、Worker/Pod 重启后同版本恢复，以及跨主体、Agent、Execution、渠道/用途和 Grant/fence 的负向替换。OpenCode/Pi 还须以同一模型的相邻执行验证旧 native handle 退役、新 Key 实际生效和原 Session 连续；旧 handle 排空失败必须拒绝。证实 Key 原值不进入 Pod env/Kubernetes Secret、持久状态、日志、事件、错误或普通查询。
- API 与 Store/Worker 组合验证用户/应用任务的受理、默认新会话幂等、显式续接、同会话排队、不同会话容量、启动/更新等待、满容量受理前拒绝、等待到期及重启后原顺序/期限恢复；Web 仍可合法补充指令且新 Turn 不插队，停止/停用/故障不能由提交任务绕过。
- 取消故障注入覆盖等待与认领并发、API/Web 同时受理、Agent 启动/更新/停止/停用/故障与准入/实际发送竞态、投递前后崩溃、旧 Worker 迟到提交、unknown、停止未确认与自然完成竞态、停止确认超时及重启/重复取消不延长期限、代次隔离和等待任务收敛；必须证明旧 Turn 无剩余副作用才启动下一任务，不能用超时/换 executionId/新 Session 掩盖不确定结果。
- API 授权负向验证主体类型/ID、Agent/Conversation/Execution 替换、应用冒用责任人权限、Owner/责任人读取/订阅/取消他人任务。凭证失效关闭旧流但任务继续，同主体新凭证可访问；主体撤权取消等待/活跃任务并阻止后续受控操作，两种失效不得混同。
- 四模板逐一用真实模型与受控工具操作验证开始/终态/耗时/实际选择/可得用量及原执行关联；摘要、自报 callId、缺失字段、零耗时推断不能冒充事实。Connection 直连与两侧独立鉴权按上位 Spec 验证，覆盖同主体/Agent 的跨 Execution 真实引用调换、伪造响应及丢响应后的只读核实；原生核心 conformance 通过不替代整装验收。
- 意图提交前后、外部响应前后、事件/必要审计提交前后和游标确认前后注入故障；验证未开始操作被阻止、未知不盲重放、事件/审计不丢失、不重复计数，正文/凭证不进入元数据。单独关闭/故障化遥测 exporter 不得改变业务结果，必要审计失败不能返回虚假成功。
- Eval 以获授权固定集执行回答及受控工具样本，基线/候选保留实际执行引用与版本，取消/恢复复用任务路径；数据撤权阻止后续投递/读取，评分器故障不重放业务任务。自定义未验证能力和 self-managed 声明不能开放任务/观测/Eval。
- Codex Linux 启动准入覆盖可信工具缺失、权限能力不足、安装失败、异常退出和超时，验证拒绝发生在 `app-server` 启动及向子进程注入模型凭证之前。正式镜像在工程 Spec 规定的容器安全约束下，通过真实 Host/Driver/Bridge 验证工具执行的退出码、stdout 与受限写入结果，并以预先存在的兄弟 Conversation 目录验证读取、列举与写入被拒绝而本人 workspace 写入成功；该兼容性检查不替代多用户隔离验收。
- Codex 多用户隔离验收使用真实 pinned Codex 与正式 Host/Driver/Bridge，为同一 Agent 的两个用户建立各自 Conversation，验证本人文件与运行上下文访问成功，而跨 Conversation 的读取、列举、搜索、修改、历史扫描与模型输入/结果均被该平台的文件边界拒绝；覆盖并发、进程重启与原 Session 恢复。工具普遍不可用或平台能力关闭都不构成通过。
- 启用私有 native lane 的 Codex target 在真实最终镜像上验证：每个实际 spawn/write/dispatch 前能读回 intent，内部 retry 各有 attempt；intent/授权/协议失败时实际动作数为零，结果持久化失败不交付虚假完成。验证 provenance、协议/schema、私有 callback 和不可关闭的 barrier，覆盖 hook crash/timeout、approval cache、非空 stdin、后台退出、MCP 内部重试与 catalog 覆盖缺失，保留全部原 built-ins 的正向行为。普通官方 target 只按其已声明能力验收，不宣称私有 barrier conformance。
- 启用私有 native lane 的 Codex 屏障故障注入覆盖双方在 permit 与结果确认前后重启、跨会话/重复/迟到 response、等待期间撤权/stop/fence、ACK 丢失和并发状态查询。证明原 Session/Turn/attempt 不重建、不重执行；旧终态仍可读，不兼容 active/unknown 及回滚目标拒绝准入，原 PVC 与核实证据保留。
- Codex 模型切换压缩使用生产 Driver、真实 pinned native 和受控 provider，分别触发
  CompHashChanged 与 ModelDownshift，核对 A 正常请求 → B 实际压缩 → B 回答、精确
  B endpoint/原 Execution Key 版本/reasoning、意图/attempt/用量和同一 Session。覆盖 A 从当前清单删除、
  等窗口与异窗口、B 窗口缩小、既有 context-overflow 行为及原 Session 重启恢复；
  未解决的触发路径继续拒绝 A，明确记录整体模型切换尚未完成，不能只凭首个案例签收。
- 压缩输入覆盖已有文本、工具调用/输出、reasoning/加密项及允许存在的旧 compaction；
  核对新消息未提前进入压缩输入、原生摘要安装和后续 B 消费。合成 provider 仅证明请求
  形状与控制流；真实配置还须证明 B 能接收 A 的实际历史，不能把伪造密文响应当作兼容证明。
  不人为删改历史、密文、comp_hash 或改用同 hash 组合绕过失败，真实 provider 不兼容时
  如实记录未完成义务，不以永久 unsupported 清单替代 PRD 的会话内模型切换要求。
- 模型压缩故障覆盖意图失败、选择/主体/Conversation/Turn 不匹配、撤权/stop/fence、
  provider 拒绝、响应丢失、持久结果或原生历史安装未确认及重启恢复。逐次核对真实请求
  与持久事实，证明未知不重放、不转为 A 或提前回答、不伪造未创建 Turn、不提前释放占用；
  既有普通当前模型压缩、取消和已保存历史读取仍按原契约通过。
- Generic ACP 自定义样例镜像在不增加平台专用代码的前提下通过同一核心测试。
- OpenCode 工具接缝使用真实固定 Native 与受控 read/write/edit，逐项核对许可前零动作、实际
  开始和结果/失败/取消；覆盖内部新尝试、重用 tool ID、跨主体/Execution、回执丢失与结果
  保存失败、原 Session 重启和控制端隔离。验证源码/target/artifact 与覆盖清单、旧终态
  读取和 active/unknown 兼容；合成敏感哨兵不进入事实、错误或遥测。Fixture 只证明其受控
  路径，四模板真实模型/Connection、V4 Key 和 Worker 事务验收继续逐项完成。
- 官方扩展替代边界另外验证同参数并发请求的原 Execution/attempt 绑定、旧 slot/请求重放、
  伪造回执、可写配置替换及原工具绕过。intent 保存或授权失败时真实 I/O 为零；实际 I/O
  完成但 terminal ACK 扣留时，后续模型请求为零，释放 ACK 后才能继续；结果已保存后断连
  重启只读取原 attempt，实际 I/O 计数不增加。停止须排空实际执行源，控制 ACK 不证明退出。
  该纵向验证从 read 开始不缩小 write/edit、委托、后台或其他已承诺工具的完整矩阵。
- 负向测试覆盖未知协议、无交互入口、Manifest Label 缺失或超过 64 KiB、JSON 嵌套超过 8 层、未知或重复字段、非 `1` 的 Schema 版本、`self-managed` 声明 `protocol`、非法 capability 结构、Registry 从 capability 外重复声明 `supplementaryInstruction`、创建或升级时 Owner 选择与 Manifest 交互模式不匹配、升级 Manifest 的无效 Service/健康检查、`health.path` 使用 `//`、`.` 或 `..` 路径段、反斜杠、`%` 编码、非允许字符、外部 URL、查询参数、片段、控制字符或凭证，以及健康探针返回 HTTP 重定向、调用方伪造或覆盖 `actorId`、使用另一发送者的 Conversation 查询消息、历史、SSE、附件或结果文件、群内公开事件暴露其他发送者的 Conversation 或 Runtime 上下文、不同发送者向活跃 Turn 追加指令或停止回复、缺失或非法 `Idempotency-Key`、同一 Key 跨命令类型复用时误命中其他操作、普通消息响应丢失后因活跃状态变化把重试误判为补充指令或繁忙、两个请求同时进入空闲 Conversation、初始 Turn 未投递时提交补充指令、初始 Turn 接受前失败或取消后的补充指令收敛、补充指令投递前发送者失去权限、补充指令使用过期或扩大范围的 Grant、补充指令提交后目标 Turn 先结束、补充指令重试或 Worker/Pod 重启后重复追加、补充指令 capability 缺失或为 `false`、声明后探测失败、不具备持久去重却声明补充指令 capability、重新生成重复创建 Message 或 Execution、活跃 Turn 上重新生成、旧 stop 请求改绑后续 Execution、使用者停止投递前失去权限后转换为平台撤权停止、没有使用者停止请求时平台主动中止撤权用户的活跃 Execution、身份依赖暂时不可用时不误判撤权或调用 Adapter、检查 stop 后到调用 Runtime 前的并发停止、Turn lease 到期后旧 Worker 迟到提交或回写、接管 Worker 未完成高 fence 取消标记、Turn outbox 原子迁移后 Worker 崩溃、stop outbox 丢失或重复停止、stop 认领后已接受 Turn 的在途事件或真实终态被拒绝、Session 恢复失败后旧代次调用、事件或终态迟到、generation tombstone 重试、繁忙拒绝后创建记录、重复消息、旧 fence 重放已保存事件时重复写入、旧 fence 产生未保存的新事件、双 Worker 并发保存同一 Conversation 事件、Runtime 事件已转发但事务未提交时断线、事务提交后上游确认前崩溃、Worker/Pod 重启后按已确认游标重放、跨 Execution 迟到事件和同会话并发 Turn。可选补充指令探测失败时，Agent 仍创建成功且有效 capability 为 `false`；活跃 Turn 上返回繁忙，不创建 Message、Execution 或 outbox。
- generation fencing 故障注入覆盖隔离意图提交后 tombstone 尚未激活、Agent Service 激活后 Platform DB 尚未提升代次、两个阶段之间 Worker 重启、tombstone 重复投递和 Agent Service 暂时不可用；任何路径都不能接受新命令、丢弃已接受旧调用的可见结果、在 barrier 确认后产生旧代次副作用，或在确认前提升平台代次。
- RuntimeHost Conformance 故障注入覆盖 Host Session Ref 泄露、跨 Conversation 重放或与 Grant 绑定不一致，Grant 签名、签发方、audience、有效期、附件引用或操作范围不匹配，缺失或非法模型选择、同一 Execution 选择重放与冲突、相邻 Execution 选择隔离、Driver 不支持的模型或 reasoning，两个 Worker 对同一 Session 和 operation scope 并发提交相同或不同 fence，以及请求记录提交前、提交后但 Driver 调用前、Driver 接受后但 Host 持久化或响应前崩溃。测试必须模拟 durable store 确认前掉电和不完整记录；恢复查询、重复请求和 fence 接管都不能创建第二个 Turn、重复补充指令或重复停止。无法确认时保持 `unknown`，损坏记录使对应 Session fail closed，不能把引用、请求字段、模型 endpoint/credential、原生协议帧或日志文本当作授权或恢复依据。
- 控制用途 Grant 覆盖主体已撤权仍能停止并核实原执行，Worker 接管后按原 Execution/代次/fence/游标归档未确认事件且用户访问仍被拒绝；伪造撤权、过期或跨主体/Execution/代次的控制 Grant，以及用其提交/补充 Turn、调用模型/工具、读取附件或通过用户路径回放正文均须拒绝。平台状态事件验证同一转换重试不重复写入，而同一任务的受理、等待、取消和终态均能各自持久保存。
- `kind` 覆盖 Pod 重启恢复原 Session；用两个 Conversation 验证恢复失败不新建 Session，且不影响另一会话。
- SSE 覆盖持久化后推送、批量事务重试、重复事件、`Last-Event-ID` 到 `conversationCursor` 的会话内映射、显式游标、窗口内补发、建连后账号权限、Agent 可用范围、渠道绑定或 Conversation 访问范围变化时停止推送并在恢复前重新鉴权，以及未知、属于其他 Conversation 或超出窗口的事件和游标重载时间线。任务订阅还须验证：同一 Conversation 中目标 Execution 的事件可连续补发，误用另一已获授权 Execution 的 `Last-Event-ID` 或显式游标时返回重载信号，不能静默跳过目标任务事件。

### 11.2 Codex 与 Connection 接缝验收

- 官方 Codex release 与启用私有 native lane 的 target 分别记录 provenance、协议/schema、sandbox、能力覆盖和准入结果；官方路径不把不存在的 vendor barrier 当作验收前置，私有 lane 缺少 barrier 或验证不可回读时 fail closed。
- 标准 MCP/OAuth/PAT 路径按 [§9.1](#91-codex-独立-connection-consumer-profile) 与 [Connection HLD §5.2](HLD-connection-M1.md#52-consumer-与-instance)、[§7](HLD-connection-M1.md#7-mcpapi-调用流程)、[§8](HLD-connection-M1.md#8-幂等与线性化) 和 [§13](HLD-connection-M1.md#13-pilot-验收与成功声明) 验证 token 当前主体/实例、user/application + Agent 选择、工具子进程不可读取、独立撤销、跨实例隔离、幂等和未知不重放；缺 token 不回退 Owner 或共享凭据。profile 明确要求 sender constraint 时另验持有证明，准备层或 token 签发通过不替代真实运行。
- 可信关联另验同次实际请求/响应、服务端原调用、跨 Execution/attempt 替换、丢响应与只读核实；缺失保持未核实，标准 token 接入不能代签关联。
- Driver 直接标准 MCP 路径另验固定官方 dynamicTools/server request 的真实等待、受保护 Host 的文件/内存/FD 与诊断拒绝、原安装选择、每次真实发送、结果保存及 ACK；结果保存失败、unknown WRITE 已保存但未核实或 stdio 断连，均不得释放原执行继续推理。覆盖同 UID 工具、旧修订、跨主体/Agent/Sandbox、未知 WRITE、崩溃、撤销与原操作只读恢复，fixture 与真实 Connection/Provider 证据分别记录；通过不外推 native MCP 或其他原生工具。
- 明确启用的私有 FD callback、bootstrap 或 recovery 在 intent/permit/结果确认失败、断连、过期、跨代次或主体绑定不一致时，不得产生 Provider/工具副作用。该 lane 未通过不按普通 token 绕过；标准 MCP 路径按自己的获准合同验证，不要求具备未启用的私有接缝。

## 12. RuntimeHost 未来抽取与维护标准

RuntimeHost 在 M1 中是 Agent Infra 的内部深 Module，同时作为未来可能抽取的开源库候选维护。这个方向用于约束当前依赖、Interface 和验证质量，不构成 M1 必须建立独立仓库、发布公共 package、接受外部贡献或提供公共兼容承诺的验收项。是否抽取必须由后续独立 Issue 和 ADR 决定。

### 12.1 Module、Interface 与依赖方向

- `apps/agent-runtime-host` 保持薄入口，只处理进程启动、依赖装配、配置读取和 HTTP/SSE 协议接入；Runtime 生命周期、Session mapping、Driver 选择、事件归一化、fence、恢复和错误语义属于 `packages/agent-runtime`。
- worker-facing HTTP/SSE 是外部 Seam。其业务 Interface 包含平台 ID、命令、经过当前 Execution Grant 授权且按 Runtime 输入 Schema 校验的用户内容或短期附件引用、Execution 已固化的版本化有效模型选择和 Key 版本引用、fence、capability、状态和规范化事件。模型选择与用户消息输入分离，不包含 endpoint 或默认解析信息；标准模板 Key 原值仅经独立受认证且具传输保密的执行私有字段交付，不进入业务 Schema、Grant、持久请求摘要或响应。Host 不通过引用回读 Platform DB 或 Connection DB；Grant 的权威结构和校验规则见工程 Spec 的[服务端授权上下文](SPEC-agent-infra-M1-engineering-architecture.md#93-服务端授权上下文)，Host 必须在读取附件或产生 Runtime 副作用前验证其签名、签发方、audience、有效期，以及 Agent、Conversation、Execution、附件引用和操作绑定，不能信任单独提交的身份或对象 ID。Native Session ID、stdio、ACP method、vendor 配置对象和原生事件不能跨出 RuntimeHost。
- Runtime Driver 是内部 Seam。Codex Native、Claude Native、Generic ACP 和 Pi RPC Driver 满足同一个小型 Interface；Driver 只能由已部署且校验通过的标准模板 Registry 或自定义 Agent Manifest 固定绑定，不能由请求方选择或覆盖。上游差异只能留在对应 Adapter 内，不能通过条件分支扩散到 Host Client 或产品调用方。
- `packages/agent-runtime` 只能依赖 Node.js/TypeScript 标准能力、经过批准且版本固定的 runtime/protocol library，以及 `packages/contracts` 中的 Host/Driver 契约。它不能依赖 `platform-core`、`platform-store`、`identity`、Connection Module、`kubernetes-runtime`、Web/Channel 或应用入口。
- Platform 主体/Agent 授权在 RuntimeHost 外解析；Host 只消费当前 Runtime Grant 和已裁剪 capability。Connection 独立校验自己的客户端身份与授权，Host 不代替 Connection 作结论，也不能读取 IdentityAdapter、Platform DB、Connection DB、部署解密 keyring 或 Kubernetes API。

### 12.2 独立维护质量

- RuntimeHost Interface 与 Driver Interface 使用版本化 Schema，并为 accepted/busy/rejected/unknown、取消、权限、终态、恢复失败和不支持 capability 定义稳定且可测试的错误语义；请求持久化、fence 和 crash-window 恢复遵循 8.1 的统一契约。M1 内部版本可以演进，但变更必须更新消费者、Schema 和 conformance，不能依赖调用方解析日志文本。
- Conformance 通过同一 Interface 运行 Fake Driver 和每个真实 Driver；fixture 必须脱敏、自包含、可离线重放，不依赖 Platform DB、部署 IdentityAdapter、真实企业凭证或个人工作目录。
- 每个 Driver 记录精确的上游 package/CLI 版本、生成 Schema 的来源 commit、已验证 capability 和兼容矩阵。标准镜像使用 frozen lockfile 和不可变 Digest，不在启动时解析 `latest` 或下载依赖。
- 第三方依赖必须保留 license、NOTICE、生成物 provenance 和 SBOM 所需信息。RuntimeHost 源码、测试、日志、错误和 fixture 不得包含 Token、API Key、第三方 Secret、普通用户会话正文或本机绝对路径。
- Module 文档应让不熟悉 Agent Infra 产品层的维护者只通过 Host/Driver Interface、生命周期和 conformance 理解 Runtime 行为；平台专有授权、outbox 和产品状态只作为外部调用约束引用，不复制进 Runtime core。

### 12.3 M1 非目标

- M1 不创建独立开源仓库，不发布公共 npm package，不选择开源 license，也不承诺公共 SemVer 或跨仓支持周期。
- M1 不为未来开源增加本机 Desktop daemon、通用远程 daemon、ContainerLauncher、调度器、warm pool、动态 Driver/plugin registry 或任意 persistence/transport 抽象。
- M1 不因为潜在抽取而改变 PRD、四个标准模板、Platform/Connection 授权、Kubernetes 部署、平台历史权威或现有验收范围。
- 只有出现 Agent Infra 以外的真实 consumer、内部 Interface 经多个上游升级保持稳定，并完成独立安全、维护和供应链评审后，后续决策才能批准抽取。

## 13. 上游复用与非目标

M1 参考以下社区项目的 Runtime Registry、Protocol Adapter、Session 生命周期、事件归一化和 capability 分层：

- [Multica](https://github.com/multica-ai/multica)
- [Paseo](https://github.com/getpaseo/paseo)
- [Open Design](https://github.com/nexu-io/open-design)

Codex 官方 release 与私有 native lane 遵循工程 Spec [10.11](SPEC-agent-infra-M1-engineering-architecture.md#1011-codex-上游原生补丁与执行屏障)；本节的叶子模块复用许可不授权维护第三方原生源码补丁或 vendor builder。

优先使用官方 SDK、协议客户端和成熟上游已实现的生命周期与事件处理。允许按所选版本的
许可证直接引入或移植当前交付所需的叶子模块与回归场景；上游没有独立可安装库，不构成
重新实现协议的理由。不得一并引入本仓未要求的产品功能、权限默认值、身份或存储权威，
不复制完整 daemon、产品 Session 或无实际消费者的通用框架。

每次采用前核验具体版本和文件的许可；实现说明记录 source SHA、文件/函数、采用方式、
必要差异与对应回归，保留适用的版权、LICENSE、NOTICE 和修改标识。复用代码进入对应 Driver
或已有模块，原生类型不越过内部 Seam；不依赖个人 HOME 或继承上游自动授权行为。依赖、
镜像、脱敏、恢复与真实隔离仍按本仓契约验收，上游功能声明或上游测试不能代替本仓证据。

Claude 的首个复用基线为 Paseo
`d1b705a0cd91617a5707fae25d80cb0be3057950` 的
[claudeQuery](https://github.com/getpaseo/paseo/blob/d1b705a0cd91617a5707fae25d80cb0be3057950/packages/server/src/server/agent/providers/claude/query.ts)
与
[ClaudeAgentSession](https://github.com/getpaseo/paseo/blob/d1b705a0cd91617a5707fae25d80cb0be3057950/packages/server/src/server/agent/providers/claude/agent.ts)：
采用其 SDK 启动、create/resume、Query 退役和迟到退出处理，映射到既有 RuntimeDriver。
共享配置由首个非 Responses 消费方扩展，后续 Driver 复用同一候选验证与投影链路；各自的
原生模型表示、配置切换和恢复语义留在各自 Driver，不能通过平台 ID 的宽泛放行替代映射。

以下内容不进入 M1：

- 动态 Adapter 插件、未知协议自动发现和协议版本兼容矩阵。
- 未经 Browser Capability 契约纳入的其他特殊 Runtime/渠道语义。
- 将 ACP、Pi RPC 或原生事件直接暴露给 Web 和企微。
- Redis、Kafka、NATS、Temporal 或其他消息中间件。
- Kubernetes CRD、Operator 框架和 PVC 自动快照。
- 自有交互入口的会话、事件和历史托管。
