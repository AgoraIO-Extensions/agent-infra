# agent-infra M1 工程架构 Spec

| 项目 | 内容 |
| --- | --- |
| 状态 | Draft for Review |
| 版本 | v0.1 |
| 日期 | 2026-07-30 |
| 适用范围 | Agent 平台 M1、Connection M1 |
| 关联 PRD | [企业级 Agent 平台 M1 产品需求](../prd/PRD-agent-platform-M1.md)、[Connection M1 产品需求](../prd/PRD-connection-M1.md) |

## 1. 文档目的

本文定义 agent-infra M1 的工程实现基线，供前端、后端、运维和安全相关成员评审。它回答以下问题：

1. M1 由哪些部署单元和工程模块组成。
2. Web、平台后端、Agent 运行时和 Connection 如何分工。
3. 用户身份、Agent 权限、Connection 授权和外部凭证如何传递与隔离。
4. 长任务、流式回复、Pod 生命周期和失败恢复如何落地。
5. 前后端分别交付什么，以及如何进行测试和上线验收。

本文不改变 PRD 的产品范围。Roadmap 中的 Eval、Skill Hub、平台级 Sandbox、多 Agent 协作、知识能力、Agent 删除、API/Webhook/定时任务和主动通知不进入 M1 实现。

## 2. 架构结论

M1 采用全 TypeScript 单仓库，使用 Better-T-Stack 初始化基础工程。Better-T-Stack 只负责生成工程骨架，不作为运行时依赖，也不决定领域模块的接口。

### 2.1 技术栈

| 层次 | 选型 | M1 用法 |
| --- | --- | --- |
| 语言 | TypeScript 7 | Web、平台后端、调谐进程、Connection 统一使用 |
| Web | React 19 + TanStack Router + Vite | 登录后的内部 SPA，不使用 SSR |
| Web 数据 | TanStack Query | 管理服务端状态、缓存和请求失效 |
| UI | Tailwind CSS + shadcn/ui | 构建平台工作台、表单、对话和管理页面 |
| HTTP | Hono + Node.js 24 LTS | 平台和 Connection 的 HTTP 接入层 |
| 契约 | Zod + OpenAPI 3.1 | 请求校验、接口文档和 TypeScript 客户端生成 |
| 流式协议 | Server-Sent Events | 对话增量、处理状态和执行详情推送 |
| 数据库 | PostgreSQL + Drizzle | 权威业务数据、事务、迁移和 outbox |
| 文件 | 公司现有 S3 兼容对象存储 | 附件、结果文件和大体积中间结果 |
| Kubernetes | `@kubernetes/client-node` | Agent Workload、Service 和访问入口调谐 |
| 工程 | pnpm workspace + Turborepo | 多应用构建、测试和缓存 |
| 质量 | Biome、Vitest、Playwright | 静态检查、模块测试和端到端测试 |
| 可观测性 | OpenTelemetry + Pino | Trace、Metric 和结构化日志 |
| 部署 | Docker + Helm + Kubernetes | 所有平台部署单元进入公司集群 |

具体依赖版本在初始化时写入 lockfile。Node.js 使用公司支持的 LTS 版本；Kubernetes JavaScript Client 与目标集群版本配套，不使用浮动 `latest`。

### 2.2 Better-T-Stack 初始化基线

初始化参数固定为：

```text
frontend: tanstack-router
backend: hono
runtime: node
database: postgres
orm: drizzle
auth: none
api: none
package-manager: pnpm
addons: turborepo, biome
web-deploy: docker
server-deploy: docker
```

选择 `auth=none` 是因为公司账户和组织体系是唯一身份来源。选择 `api=none` 是为了避免同时维护 tRPC/oRPC 与 OpenAPI 两套契约；M1 的浏览器接口、内部接口和 Agent Runtime Contract 统一以 HTTP/OpenAPI 为主，SSE 事件单独定义 Schema。

脚手架版本固定为 `create-better-t-stack@3.38.0`。生成后代码归本项目维护，不通过重复运行脚手架升级项目。

## 3. 架构原则

1. **产品状态与集群状态分离。** PostgreSQL 保存 Agent 期望状态，Kubernetes 保存实际运行状态，调谐进程负责持续收敛。
2. **平台与 Connection 各自保持权威数据。** Agent、权限和用户授权属于平台；Provider、外部账号、凭证和 Action 调用属于 Connection。
3. **凭证不进入 Agent。** Agent 只能提交 Action 和参数，不能读取外部 Access Token、Refresh Token 或 API Key。
4. **先持久化再异步处理。** 消息、审批、生命周期命令和 Action 调用先获得稳定 ID 与状态，再触发后续处理。
5. **接口也是测试面。** Hono、Drizzle、Kubernetes Client 和 OpenConnector 都位于 Adapter 层，领域模块不依赖这些实现。
6. **M1 不预建扩展基础设施。** PostgreSQL 足以支持当前事务、outbox、任务认领和事件回放；不预先引入 Redis、Kafka、NATS 或 Temporal。
7. **用户隔离由服务端决定。** 浏览器、Agent 和模型传入的用户 ID、Connection ID 或组织信息不能成为授权依据。

## 4. 系统结构

```mermaid
flowchart LR
    U[公司员工] --> W[Web SPA]
    QW[企微] --> PA[Platform API]
    W --> PA
    W --> CA[Connection API]

    PA --> PD[(Platform DB)]
    PA --> OS[(Object Storage)]
    PA --> IDP[公司身份与组织体系]
    PA --> PW[Platform Worker]

    PW --> K8S[Kubernetes]
    K8S --> AP[Agent Pod]
    PA --> AP

    AP --> PA
    PA --> CA
    CA --> CD[(Connection DB)]
    CA --> KMS[KMS / Secret Service]
    CA --> EXT[外部 Provider]

    AP --> LLM[LLM Gateway]
    PW --> HUB[Company Hub]
```

### 4.1 部署单元

| 部署单元 | 职责 | 是否保存权威状态 |
| --- | --- | --- |
| `web` | Agent 列表、配置、审批、对话和 Connection 页面 | 否 |
| `platform-api` | 身份入口、Agent 管理、权限、对话、SSE、企微回调、Agent Tool Gateway | 否 |
| `platform-worker` | Agent Workload 调谐、模板升级、消息投递、outbox 处理 | 否 |
| `connection-api` | Provider/Action、OAuth、凭证、Connection 授权校验、Action 执行和调用审计 | 否 |
| `agent pod` | Hermes、Codex、组合模板或完全自定义 Agent 的实际运行环境 | 仅保存 Agent 自有运行数据 |
| `platform database` | Agent、Owner、范围、审批、配置、会话、执行事件、授权关系和平台审计 | 是 |
| `connection database` | Provider、Action、外部账号、加密凭证、OAuth 状态和调用审计 | 是 |

`platform-api` 与 `platform-worker` 使用同一平台领域模块，但以不同进程部署。Connection 使用独立数据库和数据库账号；两个数据库可以位于同一 PostgreSQL 集群，但不能跨库直接读写。

### 4.2 不拆分的部署单元

M1 不单独部署审批、企微、审计、附件或模型配置微服务。这些能力作为平台领域模块存在，由 `platform-api` 或 `platform-worker` 调用。只有独立的安全职责、扩容方式或故障范围出现后，才新增部署单元。

## 5. 单仓库结构

```text
agent-infra/
  apps/
    web/                     React SPA
    platform-api/            Hono HTTP、SSE、企微和 Tool Gateway
    platform-worker/         调谐、投递和 outbox
    connection-api/          Connection HTTP 与 Action 执行
  packages/
    platform-core/           Agent 平台领域规则与用例
    connection-core/         Connection 领域规则与用例
    contracts/               OpenAPI、Zod Schema、SSE 事件 Schema
    platform-store/          Platform DB 的 Drizzle Adapter
    connection-store/        Connection DB 的 Drizzle Adapter
    identity/                公司账户与组织体系 Adapter
    agent-runtime/           Hermes、Codex、自定义 Agent Runtime Adapter
    kubernetes-runtime/      Kubernetes 调谐 Adapter
    observability/           Trace、Metric、日志和关联 ID
    test-support/            Fake Adapter、fixture 和契约测试工具
  migrations/
    platform/
    connection/
  deploy/
    helm/
    environments/
  tests/
    contract/
    integration/
    e2e/
    load/
  docs/
    prd/
      PRD-agent-platform-M1.md
      PRD-connection-M1.md
    architecture/
      SPEC-agent-infra-M1-engineering-architecture.md
  AGENTS.md
  README.md
```

`apps/*` 只负责进程启动、依赖装配和协议接入。领域规则不能直接写在 Hono 路由、React 页面或 Drizzle 查询中。`packages` 不设置无边界的 `shared-utils`；只有被多个明确调用方复用且接口稳定的能力才进入公共 package。

## 6. 工程模块

### 6.1 平台模块

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| Agent Lifecycle | 申请、审批、撤回、停止、重启、停用、期望版本和状态迁移 | 直接操作 Kubernetes |
| Agent Access | Owner、共同 Owner、员工与组织范围、账号禁用后的权限判断 | 保存公司用户目录 |
| Agent Configuration | 模板、自定义镜像、模型清单、渠道和 Action 选择 | 模型路由和 Provider 凭证 |
| Conversation | 会话、消息、回答版本、附件引用、执行事件和历史查询 | Agent 内部思考原文 |
| Agent Dispatch | 持久化消息投递、幂等、繁忙反馈、取消和补充指令 | Agent 自身的任务调度算法 |
| Channel | Web、企微机器人和企微应用的身份映射及会话映射 | Hermes 内部群聊语义 |
| Platform Audit | 管理操作、使用记录和跨系统关联 ID | Connection 的调用细节 |

### 6.2 Connection 模块

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| Provider Catalog | Provider、Action、版本、参数和外部权限说明 | Agent 是否选择该 Action |
| Connection Account | 个人/共享 Connection、外部账号识别、OAuth 和凭证刷新 | Agent 可用范围 |
| Agent Grant | 校验 Agent、Connection 和已确认 Action 的交集 | 允许 Agent 自行选择用户或账号 |
| Action Execution | 注入凭证、调用 Provider、脱敏结果、幂等与错误映射 | 向 Agent 返回原始凭证 |
| Connection Audit | 连接、授权、Action 调用和结果审计 | 保存平台会话正文 |

### 6.3 Adapter 接口

以下位置必须形成明确接口，并至少提供生产 Adapter 和测试 Fake：

- 公司身份与组织目录。
- Company Hub 镜像解析。
- Kubernetes Agent Runtime。
- 对象存储。
- KMS/Secret Service。
- Hermes、Codex 和自定义 Agent Runtime。
- 企微机器人与企微应用。
- OpenConnector Provider/Action 执行。

领域模块只接收业务 ID、命令和结果，不接收 Hono Context、数据库连接、Kubernetes 对象或 Provider Token。

## 7. Web 架构

### 7.1 页面模块

Web 按产品入口划分路由：

- `/agents`：Agent 列表与详情。
- `/chat/:agentId/:conversationId?`：对话与历史。
- `/my-agents`：申请和 Owner 管理。
- `/my-agents/:agentId/settings`：范围、模型、渠道和 Action 配置。
- `/connections`：个人 Connection。
- `/connections/grants`：Agent 授权。
- `/connections/calls`：个人调用记录。
- `/admin/approvals`：系统管理员审批。
- `/admin/connections`：Provider、Action 和共享 Connection。
- `/admin/audit`：平台与 Connection 审计入口。

Connection 在产品上是独立系统，但 M1 复用同一 Web Shell 和公司登录态。页面分别调用 `platform-api` 和 `connection-api`，不能通过前端把两个系统的数据拼成新的授权结论。

个人 Connection、OAuth 和调用记录写入 `connection-api`；Agent 授权、Action 确认和撤销写入 `platform-api`。即使这些操作位于同一个 Connection 页面模块，前端也必须按权威系统调用对应接口。

### 7.2 状态管理

- TanStack Query 管理列表、详情、配置和审批等服务端状态。
- 路由参数和 URL Search Params 保存可分享的页面筛选状态，但 M1 不提供会话分享。
- 对话时间线使用独立 reducer 合并持久化消息、SSE 增量和重连补发事件。
- 表单使用 Schema 校验；服务端重复执行同一校验，不能信任浏览器结果。
- 不预装全局状态库。只有出现跨路由、非服务端且难以由 React Context 管理的状态后再引入。

### 7.3 前端安全职责

前端只负责隐藏无权限入口和展示明确错误，不负责最终授权。普通用户不能获得模型 API Key、Connection 原始凭证、内部 Kubernetes 状态或其他用户的资源标识。

## 8. HTTP 与事件契约

### 8.1 浏览器接口

- 管理和查询使用 `/api/v1/*` HTTP/JSON。
- 创建、更新和命令类请求支持 `Idempotency-Key`。
- OpenAPI 3.1 是浏览器接口的规范来源。
- TypeScript 客户端由 OpenAPI 生成，禁止手写重复的请求/响应类型。
- 文件使用预签名上传/下载；业务接口只传文件引用和元数据。

### 8.2 SSE

对话回复和状态流使用 `text/event-stream`：

- 每个事件包含稳定 `eventId`、`executionId`、递增 `sequence`、`type`、`occurredAt` 和类型化 payload。
- 浏览器通过 `Last-Event-ID` 或显式游标重连。
- 服务端先保存事件，再向在线连接推送；断线后按持久化序列补发。
- 心跳只用于保持连接，不进入业务时间线。
- 同一事件可能被重复投递，前端按 `eventId` 去重。

M1 不使用 WebSocket。用户发送消息、停止回复和补充指令都通过普通 HTTP 命令完成；只有出现必须由同一连接双向交换低延迟事件的需求后才重新评估。

### 8.3 内部接口

平台到 Connection、平台到 Agent Runtime 均使用版本化 HTTP 契约。内部接口通过服务身份和 mTLS 或公司现有等价机制认证，不因位于集群内而跳过鉴权。

M1 不引入 tRPC/oRPC/ConnectRPC。这样可以让自定义 Agent、未来其他语言客户端和测试工具共同使用同一份契约。

## 9. 身份与权限

### 9.1 Web 登录

- `platform-api` 接入公司 OIDC 或现有身份网关。
- `connection-api` 验证同一公司会话或由身份网关签发的等价服务端身份，不能接受前端自行传入用户 ID。
- Web 使用 HttpOnly、Secure、SameSite Cookie，不在 Local Storage 保存公司 Access Token。
- 服务端根据公司稳定用户 ID 解析当前账号和组织关系。
- 账号禁用与组织成员变化在每次敏感操作前重新校验，短期缓存不能成为权限来源。

### 9.2 权限顺序

每次 Agent 使用按以下顺序判断：

1. 公司账号仍然有效。
2. 用户属于 Agent 当前可用范围，或是当前有效 Owner。
3. 当前渠道已绑定并支持目标操作。
4. 模型选项属于 Owner 当前允许清单。
5. 若调用 Connection，Action 属于 Owner 当前选择范围。
6. 用户对目标 Connection 的授权仍有效，且已确认该 Action。

任何一步失败都停止后续处理，并返回可理解的产品错误。错误不能暴露其他用户、Agent 或 Connection 是否存在。

### 9.3 服务端授权上下文

平台为每次 Agent 执行生成短期、不可篡改的 Execution Grant，绑定：

- 当前执行。
- 当前 Agent。
- 当前公司用户。
- 当前渠道。
- 当前允许的 Action 集合版本。

Agent 调用 Tool Gateway 时只提交 Action 和参数。平台根据执行记录解析 Connection，随后由平台服务端调用 Connection。Agent 不能提交或覆盖用户 ID、组织 ID、Connection ID 或外部账号。

## 10. Agent Workload 与调谐

### 10.1 Workload 形态

- 一个 Agent 对应一个副本为 0 或 1 的 StatefulSet。
- 运行时为“可用”时副本为 1；已停止或已停用时副本为 0。
- 每个 Agent 使用独立 Service、ServiceAccount 和持久卷。
- ServiceAccount 默认没有 Kubernetes API 权限。
- 平台配置、对话和 Connection 授权不保存在 Pod 本地。
- Agent 自有记忆或工作区通过独立持久卷保存，并由模板或自定义 Agent 负责用户隔离。

Owner 不能修改 CPU、内存、副本数和存储规格。资源规格由平台按 Agent 类型选择预设 Profile，并在审批页展示。

### 10.2 期望状态

Platform DB 保存：

- 管理状态与期望运行状态。
- 模板或自定义镜像的不可变 Digest。
- 配置修订号。
- 资源 Profile。
- 渠道和 Runtime 能力声明。

`platform-worker` 通过幂等调谐完成：

1. 读取待处理修订号。
2. 从 Company Hub 校验 Digest 和访问权限。
3. 生成或更新 StatefulSet、Service、PVC 和访问入口。
4. 根据探针和 Workload 状态计算产品服务可用性。
5. 写回已应用修订号、可用性和脱敏失败原因。

HTTP 请求只提交期望状态，不等待 Kubernetes 操作完成。

Platform DB 中的 outbox 和工作项只是保证状态变更可恢复的内部实现，不向用户提供统一任务队列、优先级或排队管理能力。

### 10.3 并发与 Leader

- 多个 `platform-worker` 实例可以同时运行。
- 同一 Agent 的调谐通过 PostgreSQL 行锁或 advisory lock 串行化。
- 每次 apply 携带配置修订号，旧任务不能覆盖新状态。
- Kubernetes 资源使用稳定 label 和 annotation 关联 Agent ID 与修订号。
- M1 不创建 CRD；Platform DB 是产品期望状态的唯一来源。

### 10.4 模板与自定义镜像升级

- 标准模板目录保存当前镜像 Digest。模板更新后，所有关联 Agent 进入新修订并自动调谐。
- 自定义 Agent 创建时把 Tag 解析为 Digest；只有 Owner 主动选择新镜像时更新 Digest。
- 升级前后复用同一 PVC、平台配置、渠道绑定和会话数据。
- Pod 不能提供服务时，产品显示“更新中”或“暂时不可用”，不能接受后静默丢弃消息。

### 10.5 自定义 Agent Runtime Manifest

完全自定义镜像若声明平台对话页、自带 WebUI 或企微渠道，平台必须知道其通信协议和监听端口。M1 采用 OCI Image Label 形式的 Runtime Manifest，至少包含：

- Contract 版本。
- 支持渠道。
- 容器监听端口。
- 健康检查路径。
- 是否支持附件、结果文件和 Connection。

标准 Base Image 提供默认 Label，但自定义镜像不必继承 Base Image，也可以自行写入等价 Label。Owner 不在产品页面填写命令、端口或环境变量。平台只校验 Manifest 与 Owner 声明一致，不检查源码实现；真实能力由契约测试和运行探针验证。

Runtime Manifest 是 PRD 中“实现对应消息接口”的工程表达，不增加源码审查或镜像审批。镜像仍以 Company Hub 的存在性和访问权作为准入条件；Manifest 缺失或不匹配时，Agent 进入创建失败并展示可修复原因。

### 10.6 标准模板模型配置

- `platform-api` 校验 Owner 选择的 LLM Gateway Base URL、模型和推理强度，并通过 KMS 加密 API Key。
- `platform-worker` 把标准模板当前需要的密钥作为 Agent 专属 Kubernetes Secret 挂载到 Pod，不写入 Workload annotation、日志或模型上下文。
- Owner 替换密钥或模型配置后产生新配置修订，由调谐器安全更新 Agent。
- 自定义 Agent 的模型配置仍完全属于镜像内部，平台不注入上述配置。

## 11. Agent Runtime Contract

### 11.1 适用范围

- 三个标准模板必须实现完整 Contract。
- 自定义 Agent 只有声明平台对话页或企微消息渠道时才必须实现对应 Contract。
- 仅提供自带 WebUI 的自定义 Agent 不需要实现平台对话协议，但仍需满足身份入口和健康检查契约。

### 11.2 核心能力

Contract 定义以下行为，不规定 Agent 内部框架：

- 创建一次执行并返回已接受或繁忙。
- 按顺序输出文本、工具调用、文件、状态和最终结果事件。
- 停止当前回复。
- 向当前回复补充用户指令。
- 查询执行状态，用于平台恢复连接和排查。
- 声明附件、结果文件、模型和 Connection 能力。

平台内部可以使用 `execution` 作为技术实体，但 Web 产品不向用户展示 Run、Pod 或进程等技术术语。

### 11.3 模板 Adapter

- Hermes Adapter 保持 Hermes 的单聊、群聊和线程语义，并映射到统一事件。
- Codex Adapter 负责编程任务、附件、结果文件和执行摘要。
- Hermes + Codex Adapter 对外仍表现为一个 Agent 和一套模型选择。
- 自定义 Adapter 只实现公共 Contract，不针对每个自定义镜像增加平台代码。

## 12. 对话与长任务

### 12.1 数据流

```mermaid
sequenceDiagram
    participant U as User
    participant W as Web
    participant P as Platform API
    participant D as Platform DB
    participant R as Agent Pod

    U->>W: 发送消息
    W->>P: POST message + Idempotency-Key
    P->>D: 保存消息与待投递执行
    P-->>W: 已提交
    P->>R: 投递执行
    R-->>P: 事件流
    P->>D: 按序保存事件
    P-->>W: SSE 事件
    U->>W: 离开页面
    R-->>P: 继续处理
    P->>D: 保存最终结果
    U->>W: 返回会话
    W->>P: 按游标读取
    P-->>W: 补发事件与最终结果
```

### 12.2 可靠性规则

- 消息写入数据库成功后才向用户显示“已提交”。
- 投递失败不会删除消息；状态变为繁忙、投递失败或暂时不可用，并提供重试。
- 同一消息只产生一个初始执行；重试使用同一幂等键或明确创建新执行。
- 重新生成创建新的回答版本，旧回答继续保留。
- 停止是尽力而为；已经提交给外部 Provider 的操作不自动撤回。
- 平台不自动重试可能产生副作用的 Connection 写操作，除非 Provider 支持明确的幂等键。

### 12.3 事件保存

平台保存用户可见消息、最终回答、状态变化、模型调用摘要和 Connection 调用引用。高频文本增量可以合并批量写入，但重连后必须恢复已有输出。模型内部思考原文、Provider 原始凭证和未脱敏请求不能进入事件表。

## 13. Connection 架构

### 13.1 OpenConnector 使用方式

M1 基于 OpenConnector 的 TypeScript/Hono 实现构建 `connection-api`：

- 固定使用经评审的上游版本或 Commit，不跟随浮动分支。
- 复用 Provider、Action、OAuth、凭证刷新和 Action 执行语义。
- 增加公司用户、共享范围、Agent 授权和多用户资源隔离。
- 上游 Runtime HTTP 接口不直接暴露给 Agent 或浏览器。
- 对上游的修改集中在 OpenConnector Adapter，不让其存储模型渗透到平台领域模块。

OpenConnector 采用内部 Fork 维护，并发布为固定版本的私有 package。`connection-api` 以精确版本依赖该 package，把 Provider、OAuth 和 Action 执行装配到同一个进程，不额外暴露或部署上游 Runtime Server。Fork 保留上游远端用于审查更新，升级必须经过隔离和契约测试。

### 13.2 授权模型

Platform DB 是 `用户 -> Agent -> Connection -> 已确认 Action 集合` 的权威来源。Connection DB 是外部账号归属、凭证和 Action 执行的权威来源。

一次 Action 调用的有效能力为以下集合的交集：

```text
系统已发布 Action
∩ Owner 当前选择的 Action
∩ 用户最近确认的 Action
∩ 当前 Connection 外部权限
```

Owner 新增 Action 后，旧授权不包含新增项；移除或停用立即生效。

### 13.3 调用链路

```mermaid
sequenceDiagram
    participant A as Agent Runtime
    participant P as Platform Tool Gateway
    participant C as Connection API
    participant X as Provider

    A->>P: actionId + args + execution token
    P->>P: 解析当前用户、Agent 和授权
    P->>C: 服务身份 + Execution Grant + actionId + args
    C->>C: 校验 scope、Connection、Action 和凭证状态
    C->>X: 注入凭证并执行
    X-->>C: 结果或错误
    C->>C: 脱敏并记录调用
    C-->>P: 脱敏结果 + callId
    P-->>A: 工具结果
```

### 13.4 凭证

- 外部凭证使用公司 KMS 或 Secret Service 做 envelope encryption。
- 数据库只保存密文、Key 版本和必要元数据。
- 只有 `connection-api` 运行身份可以解密。
- OAuth state 为一次性、短期有效，并绑定发起用户、Connection scope 和受控回跳地址。
- 日志、Trace、错误和审计都经过统一脱敏。

## 14. 使用渠道

### 14.1 Web

Web 统一经过 `platform-api`，使用公司登录态、Agent 可用范围和个人会话。平台对话页与 Agent 自带 WebUI 是两个入口，历史不互相合并。

### 14.2 企微

企微 Adapter 位于平台侧：

1. 验证企微回调签名并解析绑定的 Agent。
2. 把企微发送者映射为公司稳定用户 ID。
3. 校验 Agent 可用范围和渠道绑定。
4. 按单聊、群聊、线程规则生成会话键。
5. 把消息交给对应 Agent Runtime Adapter。
6. 使用触发消息发送者的 Connection 授权。

Hermes 的群聊和线程规则保留在 Hermes Adapter 内。Codex 不绑定企微渠道。Web 与企微会话不合并。

### 14.3 自定义 WebUI

- 自定义 WebUI 的 Cluster Service 不直接暴露到公司网络。
- 外部访问统一经过身份感知的 Ingress/Auth Gateway。
- Gateway 每次请求校验公司账号和 Agent 可用范围，并向 WebUI 传递短期签名用户上下文。
- WebUI 不能信任来自浏览器的用户 ID Header。
- 权限撤销后，新请求立即失败；长连接按短期凭证到期或服务端主动关闭。

## 15. 数据与一致性

### 15.1 Platform DB 主要实体

- Agent 申请、Agent、Owner、可用范围。
- 模板版本、自定义镜像 Digest、Runtime Manifest、资源 Profile。
- 模型选项、渠道绑定、Owner Action 选择。
- 会话、消息、回答版本、执行和执行事件。
- 附件与结果文件元数据。
- 用户对 Agent/Connection 的授权及 Action 确认快照。
- Agent 期望状态、已应用修订和平台审计。
- Outbox 和可重试工作项。

### 15.2 Connection DB 主要实体

- Provider、Action 和发布版本。
- 个人/共享 Connection、外部账号安全标识和 scope。
- 加密凭证、OAuth state 和刷新状态。
- Action 调用、脱敏结果摘要和 Connection 审计。

### 15.3 跨系统一致性

- 两个系统不使用分布式事务。
- 跨系统操作使用稳定 ID、幂等键、状态机和关联 ID。
- Connection 或 Action 停用由 Connection 立即拒绝新调用；平台目录通过版本或事件最终同步展示状态。
- 平台授权撤销后，Platform Tool Gateway 立即停止签发新 Execution Grant。
- 已开始的外部操作保留 Provider 返回的实际结果，不伪造回滚。

### 15.4 文件

- 数据库只保存对象引用、所有者、会话、类型、大小、Hash 和生命周期状态。
- 上传和下载 URL 短期有效并绑定当前用户。
- Agent 获取文件时使用执行期临时访问，不获得对象存储长期凭证。
- 文件类型与大小在 Web、平台和 Agent Runtime 三处按同一能力声明校验。

## 16. 错误、幂等与恢复

### 16.1 错误模型

所有接口返回稳定错误码、用户可读消息、`traceId` 和可重试标记。内部异常、SQL、Pod 名称、Token 和凭证不能进入普通用户错误。

产品状态映射：

| 工程状态 | 产品表现 |
| --- | --- |
| Workload 未就绪 | 启动中 |
| 正在应用新修订 | 更新中 |
| 探针失败或 Adapter 不可达 | 暂时不可用 |
| Agent 明确拒绝新任务 | 繁忙，可重试 |
| Provider 限流或短暂故障 | 明确提示稍后重试 |
| Connection 失效 | 说明原因并提供重连入口 |

### 16.2 幂等

- Agent 申请、审批、停止、重启、配置保存和消息提交接受幂等键。
- Worker 通过业务 ID 与修订号判断是否已经执行。
- OAuth callback 的 state 只能消费一次。
- Action 写操作只有在 Provider 提供幂等机制时才自动重试。

### 16.3 进程重启

`platform-api`、`platform-worker` 或 `connection-api` 重启后，未完成工作从 PostgreSQL 状态继续。内存队列、SSE 连接和本地文件都不是权威状态。

## 17. 安全基线

- 所有入口使用公司身份和 TLS。
- 平台、Connection 和 Agent 使用不同运行身份与数据库账号。
- Agent Pod 不能访问 Platform DB、Connection DB、KMS 或 Kubernetes API。
- Agent Pod 只能通过 Platform Tool Gateway 使用 Connection。
- 自定义镜像必须来自 Company Hub，并使用不可变 Digest。
- 容器以非 root 用户运行，根文件系统默认只读；需要写入的数据挂载到明确卷。
- 模型 API Key 和企微凭证加密保存、不回显，只能替换。
- 审计和日志不记录聊天正文、模型思考原文和原始凭证。
- 所有跨用户资源访问测试按“资源不存在”返回，避免枚举。
- 会话和附件查询始终以当前使用者为主体；Agent Owner 身份本身不授予查看其他使用者内容的权限。

网络策略、KMS 选型和公司身份网关的具体产品由部署环境决定，但上述访问结果是 M1 的硬性要求。

## 18. 可观测性

### 18.1 关联 ID

一次用户请求至少关联：

- `traceId`
- `requestId`
- `agentId`
- `conversationId`
- 内部 `executionId`
- Connection `callId`（如有）

日志不记录原始消息内容，只记录必要的类型、状态、耗时、大小和脱敏错误。

### 18.2 工程指标

- HTTP 请求量、错误率和延迟。
- SSE 在线连接、重连和积压事件。
- 消息提交、投递、繁忙、失败和完成数量。
- Agent 启动、更新、不可用和调谐失败数量。
- Connection 调用状态、Provider 限流和凭证刷新失败。
- PostgreSQL 连接池、慢查询、outbox 积压和对象存储失败。

这些是系统运行指标，不是 Roadmap 中的 Agent Eval 与效果指标。

## 19. 测试策略

### 19.1 模块测试

- 领域模块使用 Fake Adapter 验证状态机、权限交集、授权扩展和幂等。
- React 使用 Vitest 与 Testing Library 验证关键交互和错误状态。
- 不以大量 Hono 路由快照代替领域测试。

### 19.2 契约测试

- OpenAPI Schema 变更必须通过兼容性检查。
- Hermes、Codex、组合模板和自定义样例镜像运行同一 Agent Runtime Conformance Suite。
- OpenConnector Adapter 运行 Provider/Action、OAuth、凭证隐藏和跨 scope 拒绝测试。
- SSE 验证事件顺序、重复投递、断线重连和游标补发。

### 19.3 集成测试

- PostgreSQL 与对象存储使用容器化真实依赖。
- Kubernetes 使用 `kind` 验证 StatefulSet 创建、缩容、升级、失败和恢复。
- 公司身份、Hub、LLM Gateway 和企微提供可控 Fake Server。
- 至少一个真实 Provider 在受控测试账号完成 Connection 端到端调用。

### 19.4 端到端测试

Playwright 覆盖：

- 申请、撤回、审批、创建、停止、重启和停用。
- Owner、范围、组织变化和账号禁用。
- 三个模板的对话、模型切换、附件和长任务恢复。
- 自定义 WebUI 直接访问不能绕过权限。
- Connection 连接、Action 扩权确认、调用、换账号和撤销。
- 企微身份映射、群聊隔离和按发送者使用 Connection。

### 19.5 负载与故障测试

M1 不承诺固定并发数，但发布前必须提供可重复的负载脚本，逐步增加：并发 Web 用户、同一 Agent 消息、SSE 连接和 Connection 调用。验收要求是消息有明确状态、不静默丢失、用户数据不串线，并获得当前环境的容量基线。

## 20. 前后端职责

| 领域 | 前端交付 | 后端交付 |
| --- | --- | --- |
| 身份与权限 | 登录态、无权限页面、Owner/范围配置 | 公司身份 Adapter、组织解析、RBAC 和每次操作校验 |
| Agent 生命周期 | 申请、审批、状态和操作入口 | 状态机、资源 Profile、outbox 和 Kubernetes 调谐 |
| Agent 使用 | 对话时间线、SSE、停止、重生成、模型选择 | 会话存储、投递、Runtime Adapter、事件保存和恢复 |
| 附件 | 上传、预览、限制和下载 | 预签名地址、对象权限、元数据和 Agent 临时访问 |
| Connection | 连接、授权、扩权确认和调用记录 | OAuth、凭证、scope、授权校验、Action 执行和审计 |
| 企微渠道 | Owner 绑定配置和状态 | 回调校验、身份映射、会话键和 Hermes Adapter |
| 自定义 WebUI | 入口、不可用与无权限状态 | Auth Gateway、Runtime Manifest、Service 和访问调谐 |
| 管理与审计 | 审批、Provider/Action、共享 Connection 和审计页面 | 管理接口、审计事件、脱敏与跨系统关联 |

前后端共同维护 `packages/contracts`，但后端是权限和数据结果的权威方。

## 21. CI/CD 与环境

### 21.1 Pull Request 检查

- `pnpm install --frozen-lockfile`
- Biome format/lint
- TypeScript typecheck
- Vitest 模块与集成测试
- OpenAPI 生成结果无漂移
- Drizzle migration 校验
- Docker image build
- 依赖漏洞和镜像扫描

### 21.2 发布

- 每个部署单元生成独立镜像并推送 Company Hub。
- 镜像按 Commit SHA 和不可变 Digest 部署。
- Helm 管理平台部署单元，Agent Workload 由 `platform-worker` 调谐。
- 数据库迁移使用独立 Job，先执行向后兼容迁移，再发布应用。
- 环境配置只保存非敏感值；Secret 由公司 Secret Service 注入。

### 21.3 本地开发

- Docker Compose 提供 PostgreSQL、对象存储和 Fake 外部依赖。
- Web、API 和 Worker 由 Turborepo 启动。
- Kubernetes 调谐通过 `kind` 环境验证，不要求日常页面开发连接共享集群。

## 22. 实施顺序

本节只定义依赖顺序，不替代后续实施计划。

1. **工程底座：** monorepo、契约、身份 Fake、数据库迁移、可观测性和 CI。
2. **Agent 生命周期：** 申请审批、权限、Hub Digest、Worker 调谐和状态展示。
3. **Web 对话：** Conversation、SSE、Hermes/Codex Runtime Adapter、附件和长任务恢复。
4. **Connection 闭环：** OpenConnector Adapter、一个真实 Provider、授权与 Action 调用。
5. **渠道与自定义 Agent：** 企微、Runtime Manifest、自定义 WebUI Auth Gateway。
6. **上线加固：** 审计、故障注入、隔离测试、负载基线和运维手册。

## 23. 关键风险与处理

| 风险 | 处理方式 |
| --- | --- |
| TypeScript 缺少 `controller-runtime` 同等级框架 | 控制器保持单一职责，以 Platform DB 修订号和 Kubernetes 幂等 apply 为核心；使用 `kind` 做完整生命周期测试 |
| OpenConnector 尚未原生满足公司多用户隔离 | 上游接口不直接暴露；内部 Fork 补 scope 与 Connection ID 强制校验；增加跨用户攻击测试 |
| 长任务跨进程和断线后状态丢失 | 所有业务事件先持久化；SSE 只负责传输，使用事件游标恢复 |
| 自定义镜像无法自动识别端口和能力 | 使用 OCI Runtime Manifest；Owner 不填写技术参数；创建与运行时验证 Manifest |
| 平台与 Connection 无分布式事务 | 使用稳定 ID、幂等键、状态机和审计关联；停用与撤销在权威系统即时拒绝 |
| 全 TypeScript 单仓库形成耦合 | 平台与 Connection 使用独立 core、store、数据库和部署单元；共享仅限契约与基础设施模块 |

## 24. 架构验收

工程架构完成 M1 的最低标准：

1. 两份 PRD 的上线验收场景均有对应模块、接口和自动化测试入口。
2. 浏览器、Agent 和模型都不能伪造用户、Connection 或组织身份完成越权。
3. Agent 停止、重启、升级和平台进程重启后，配置、历史、附件引用和授权关系不丢失。
4. Web 断线或离开页面不影响已提交长任务，返回后可以按游标恢复状态。
5. 自定义 Agent 的直接 WebUI 地址不能绕过公司身份与 Agent 范围校验。
6. 至少一个真实 Provider 完成 OAuth/鉴权、授权、Action、审计和撤销闭环。
7. 负载与故障测试中，所有消息都有可解释状态，不出现静默丢失和跨用户数据混用。

## 25. 评审结论记录

团队评审应围绕以下已选方案提出异议或确认，不在同一轮扩展 Roadmap 范围：

- 全 TypeScript 是否满足平台与运维团队的长期维护能力。
- TypeScript Kubernetes 调谐器的测试与值班责任是否可接受。
- OpenConnector 内部 Fork 的维护归属和上游同步方式。
- OCI Runtime Manifest 是否能进入 Company Hub 的镜像发布规范。
- 公司身份、KMS、对象存储、LLM Gateway 和企微现有接口是否满足本文所需契约。

评审通过后，任何改变部署单元、权威数据归属、身份传递、Connection 授权或 Agent Runtime Contract 的修改都应新增 ADR，不通过零散代码变更隐式改变架构。
