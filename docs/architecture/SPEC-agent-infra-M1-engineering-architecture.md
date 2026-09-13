# agent-infra M1 工程架构 Spec

| 项目 | 内容 |
| --- | --- |
| 状态 | Draft for Review |
| 版本 | v0.2 |
| 日期 | 2026-09-13 |
| 适用范围 | Agent 平台 M1、Connection M1 |
| 关联 PRD | [企业级 Agent 平台 M1 产品需求](../prd/PRD-agent-platform-M1.md)、[Connection M1 产品需求](../prd/PRD-connection-M1.md) |

## 1. 文档目的

本文定义 agent-infra M1 的工程实现基线，供前端、后端、运维和安全相关成员评审。它回答以下问题：

1. M1 由哪些部署单元和工程模块组成。
2. Web、平台后端、Agent 运行时和 Connection 如何分工。
3. 用户身份、Agent 权限、Connection 授权和外部凭证如何传递与隔离。
4. 长任务、流式回复、Pod 生命周期和失败恢复如何落地。
5. 前后端分别交付什么，以及如何进行测试和上线验收。

本文不改变 PRD 的产品范围。M1 包含用户与应用 API、后台任务调度、运行可观测、模型质量评估与效果分析（Eval）和持久审计。Skill Hub、平台级 Sandbox、多 Agent 协作、知识能力、Agent 删除、Webhook、定时任务和主动通知仍在 Roadmap。

## 2. 架构结论

M1 采用全 TypeScript 单仓库，使用 Better-T-Stack 初始化基础工程。Better-T-Stack 只负责生成工程骨架，不作为运行时依赖，也不决定领域模块的接口。

### 2.1 技术栈

| 层次 | 选型 | M1 用法 |
| --- | --- | --- |
| 语言 | TypeScript 6 | Web、平台后端、调谐进程、Connection 统一使用 |
| Web | React 19 + TanStack Router + Vite | 登录后的内部 SPA，不使用 SSR |
| Web 数据 | TanStack Query | 管理服务端状态、缓存和请求失效 |
| UI | Tailwind CSS + shadcn/ui | 构建平台工作台、表单、对话和管理页面 |
| HTTP | Hono + Node.js 24 LTS | 平台和 Connection 的 HTTP 接入层 |
| 契约 | Zod + OpenAPI 3.1 | 请求校验、接口文档和 TypeScript 客户端生成 |
| 流式协议 | Server-Sent Events | 对话增量、处理状态和执行详情推送 |
| 数据库 | PostgreSQL + Drizzle | 权威业务数据、事务、迁移和 outbox |
| 文件 | S3 兼容对象存储 Adapter | 附件、结果文件和大体积中间结果 |
| Kubernetes | `@kubernetes/client-node` | Agent Workload、Service 和访问入口调谐 |
| 工程 | pnpm workspace + Turborepo | 多应用构建、测试和缓存 |
| 质量 | Biome、Vitest、Playwright | 静态检查、模块测试和端到端测试 |
| 可观测性 | OpenTelemetry + Pino | Trace、Metric 和结构化日志 |
| 部署 | Docker + Helm + Kubernetes | Web/API 位置无关；Worker 与 Agent Workload 进入 Kubernetes Workload Plane |

初始化依赖以固定版本 Better-T-Stack 的生成结果为基线，并写入 lockfile。Node.js 使用公司支持的 LTS 版本；Kubernetes JavaScript Client 与目标集群版本配套，不使用浮动 `latest`。

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

选择 `auth=none` 是因为 Agent Platform 的认证实现由部署环境通过 IdentityAdapter 提供，平台主系统只消费可信 IdentityContext。独立 Connection 按其 HLD 提供公司 LDAP 登录，不复用 Platform 浏览器会话。选择 `api=none` 是为了避免同时维护 tRPC/oRPC 与 OpenAPI 两套契约；M1 的浏览器接口、内部接口和 Agent Runtime Contract 统一以 HTTP/OpenAPI 为主，SSE 事件单独定义 Schema。

脚手架版本固定为 `create-better-t-stack@3.38.1`。生成依赖作为项目初始化基线；生成后代码归本项目维护，不通过重复运行脚手架升级项目，也不在初始化过程中主动升级生成依赖。

## 3. 架构原则

1. **产品状态与集群状态分离。** PostgreSQL 保存 Agent 期望状态，Kubernetes 保存实际运行状态，调谐进程负责持续收敛。
2. **平台与 Connection 各自保持权威数据。** Agent、应用与 API 凭证、执行、会话、Eval 和平台审计属于平台；直连身份、Connection Grant、Provider、外部账号、凭证、外部调用和审计属于 Connection。
3. **外部凭证不进入 Agent。** Agent 或客户端使用 Connection 独立签发的访问凭据直连 MCP/API，不能读取外部账号的 Access Token、Refresh Token 或 API Key。
4. **先持久化再异步处理。** 消息、API 任务、审批和生命周期命令先在平台持久受理；外部调用由实际执行系统先可靠记录意图，再触发处理。
5. **接口也是测试面。** Hono、Drizzle、Kubernetes Client 和 OpenConnector 都位于 Adapter 层，领域模块不依赖这些实现。
6. **M1 不预建扩展基础设施。** PostgreSQL 足以支持当前事务、outbox、任务认领和事件回放；不预先引入 Redis、Kafka、NATS 或 Temporal。
7. **主体隔离由服务端决定。** 用户与应用均使用可信主体上下文；浏览器、Agent、模型和 API 调用方提交的身份、组织或关联字段不能成为授权依据。
8. **部署能力通过 Port 接入。** 身份、OCI Registry、模型端点、Kubernetes 和对象存储的具体产品属于部署环境，领域模块只依赖稳定 Adapter 契约。
9. **只冻结跨模块契约。** Wire Schema、数据权威、事务和安全不变量属于 Architecture Baseline；数据库表、UI 结构和 Adapter 内部算法可以在模块内演进。

## 4. 系统结构

```mermaid
flowchart LR
    U[公司员工] --> W[Platform Web SPA]
    U --> CW[Connection Web SPA]
    QW[企微] --> PA[Platform API]
    CLI[用户或应用客户端] --> PA
    CLI -->|独立身份 / MCP + API| CA
    W --> PA
    CW --> CA[Connection API]

    PA --> PD[(Platform DB)]
    PA --> OS[(Object Storage)]
    PA --> IDP[IdentityAdapter]
    PW[Platform Worker] --> PD

    PW --> K8S[Kubernetes]
    K8S --> AP[Agent Pod]
    PW -->|RuntimeHost Client / HTTP + SSE| AP

    AP -->|独立身份 / MCP + API| CA
    CA --> CD[(Connection DB)]
    CA --> LDAP[Company LDAP]
    PA -.->|写入版本化 Secret 密文| PD
    PW -.->|读取 active Secret 密文| PD
    PUB[Deployment Encryption Public Keys] --> PA
    PRIV[Deployment Decryption Keyring] --> PW
    CA --> EXT[外部 Provider]

    AP --> MODEL[Deployment-approved Model Endpoint]
    PW --> REG[OCI Registry]
```

### 4.1 部署单元

| 部署单元 | 职责 | 是否保存权威状态 |
| --- | --- | --- |
| `web` | Agent、凭证与应用管理、审批、对话、执行详情、Eval 和审计；可独立静态托管 | 否 |
| `connection-web` | 独立 Connection 中文 SPA、登录和 OAuth/Grant 管理入口 | 否 |
| `platform-api` | 可信用户/应用接入、Agent 与任务 API、权限、业务状态/outbox/审计事务、SSE、企微回调、Eval 管理和查询；部署位置无关 | 否 |
| `platform-worker` | Kubernetes Workload Plane 中的 Workload 调谐、模板升级、outbox 认领、有界任务投递、RuntimeHost Client 与 Eval 执行/评分工作项 | 否 |
| `connection-api` | 独立登录与客户端身份、MCP/API、Provider/Action、OAuth、Grant、凭证、外部执行、恢复和审计 | 否 |
| `agent pod` | 标准模板与 `platform-adapter` 的 RuntimeHost/Driver，或 `self-managed` Agent 的自有服务与实际运行环境 | 仅保存 Agent 自有运行数据 |
| `platform database` | Agent、Owner、范围、应用/API 凭证及授权、审批、配置、会话、执行、Eval、反馈和平台审计 | 是 |
| `connection database` | 独立身份与客户端授权、Grant、Provider/Action、外部账号、加密凭证、OAuth 状态、调用/效果和审计 | 是 |

`platform-api` 与 `platform-worker` 使用同一平台领域模块，但以不同进程部署，并通过 Platform DB 状态与 outbox 协作，不建立直接 RPC 依赖。Web 和 `platform-api` 的部署位置不受 Kubernetes Workload Plane 限制；只有 `platform-worker` 获得目标 Kubernetes namespace 的 API 权限。Connection 使用独立数据库和数据库账号；两个数据库可以位于同一 PostgreSQL 集群，但不能跨库直接读写。

Connection 的单一账号级权威和独立 Web 部署取舍分别见 [ADR: Connection 使用单一账号级权威](../adr/0005-use-one-account-backed-connection-authority.md)与 [ADR: 独立部署 Connection Web](../adr/0006-deploy-connection-web-independently.md)。

### 4.2 不拆分的部署单元

M1 不单独部署审批、企微、审计、附件、任务调度、Eval 或模型配置微服务。这些能力作为平台领域模块存在，由 `platform-api` 或 `platform-worker` 调用。只有独立的安全职责、扩容方式或故障范围出现后，才新增部署单元。

## 5. 单仓库结构

```text
agent-infra/
  apps/
    web/                     React SPA
    connection-web/          独立 Connection React SPA
    platform-api/            Hono HTTP API、SSE、企微和查询入口
    platform-worker/         调谐、outbox、RuntimeHost Client、投递和 Eval 工作项
    agent-runtime-host/      Agent Pod 内的薄 RuntimeHost 进程入口
    connection-api/          Connection 独立 Web、MCP/API 与外部操作执行
  packages/
    platform-core/           单一深 Platform 领域 Module、Use Case 与 Port
    connection-core/         Connection 领域规则与用例
    contracts/               Wire-only OpenAPI、内部 HTTP、SSE 与 RuntimeHost Schema
    platform-store/          用例级事务 Port 的 Drizzle/PostgreSQL Adapter
    connection-store/        Connection DB 的 Drizzle Adapter
    identity/                Platform IdentityAdapter、IdentityContext 与测试 Fake
    image-registry/          ImageRegistryAdapter、OCI Digest/Manifest 与测试 Fake
    secret-store/            版本化 AEAD 密文、DEK 封装与密钥轮换
    model-catalog/           ModelCatalogAdapter 与模型端点政策
    agent-runtime/           RuntimeHost 深 Module、固定 Driver 和 Conversation Contract
    kubernetes-runtime/      KubernetesRuntimeAdapter 与部署路由 Adapter
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
      HLD-agent-runtime-M1.md
  AGENTS.md
  README.md
```

`apps/*` 只负责进程启动、依赖装配和协议接入。领域规则不能直接写在 Hono 路由、React 页面或 Drizzle 查询中。`packages` 不设置无边界的 `shared-utils`；只有被多个明确调用方复用且接口稳定的能力才进入公共 package。

## 6. 工程模块

### 6.1 平台模块

| 模块 | 负责 | 不负责 |
| --- | --- | --- |
| Agent Lifecycle | Web 申请审批、API 直接创建、启动/停止/重启/停用、期望版本与状态迁移 | 直接操作 Kubernetes |
| Agent Access | Owner、员工/组织范围、应用与责任人、API 凭证范围/失效、显式授权及当前权限交集 | 公司用户目录、Connection 授权 |
| Agent Configuration | 模板、自定义镜像、交互模式、自有交互入口身份责任、env/Secret、模型、渠道和已验证的集成能力 | 模型路由和 Provider 凭证 |
| Conversation | 会话、消息、回答版本、附件引用、执行事件和历史查询 | Agent 内部思考原文 |
| Agent Dispatch | API 有界受理/等待与投递、幂等、取消/恢复、Web 繁忙与补充指令 | Runtime 内部执行算法、通用调度服务 |
| Channel | Web、API、企微的主体、会话与附件映射 | Runtime 原生 Session 和协议语义 |
| Platform Audit | 治理、API/执行/Eval 元数据、持久审计与受控查询 | 会话正文、Connection 状态或审计副本 |
| Evaluation | 评测用途授权、版本化数据集/标准、实验/逐例评分、对比、人工复核与主动反馈 | 第二套任务调度、自动导入线上正文 |

### 6.2 Connection 模块

Connection 在自己的 Core/Store/API/Web 中负责客户端身份、Provider/Action、外部账号与凭证、授权、执行、恢复和审计。Platform 只消费独立入口与真实调用的关联信息，不维护这些模块的目录、状态或授权投影。内部模块和 wire contract 由 [Connection M1 HLD](HLD-connection-M1.md) 维护，系统边界见第 13 节。

### 6.3 Adapter 接口

以下位置必须形成明确接口，并至少提供部署 Adapter 或项目实现，以及测试 Fake：

- IdentityAdapter 与可信 IdentityContext。
- ImageRegistryAdapter、OCI Digest 与 Runtime Manifest 准入。
- ModelCatalogAdapter 与获准模型端点政策。
- KubernetesRuntimeAdapter 与部署访问路由。
- 对象存储。
- 部署加密公钥与 Worker-only 解密 keyring；Secret 密文、DEK 封装、轮换和候选激活由项目实现。
- Codex Native、Claude Native、Generic ACP 和 Pi RPC Runtime。
- worker 侧 RuntimeHost Client 与 Agent Pod 内 RuntimeHost/Driver。
- 企微机器人与企微应用。
- OpenConnector Provider/Action 执行。

领域模块只接收业务 ID、命令和结果，不接收 Hono Context、数据库连接、Kubernetes 对象或 Provider Token。

`packages/platform-core` 是单一 Platform bounded context，对外只暴露版本化 Use Case、领域结果和窄 Port；Lifecycle、Access、Configuration、Conversation、Dispatch、Channel、Audit 和 Evaluation 只作为内部模块，不拆成 workspace package。Core 定义“业务状态 + outbox + 必要审计”的原子性，`platform-store` 以用例级事务实现；不创建通用 CRUD Repository，也不允许 Hono 路由或 Worker 编排领域 Drizzle 查询。

`packages/contracts` 只保存跨进程 wire DTO/Schema，不依赖 React、Hono、Drizzle、Kubernetes 或应用入口，也不复用数据库实体作为协议类型。Web、API、Worker、RuntimeHost 和 Connection Client 在边界显式映射协议 DTO 与领域对象。

### 6.4 Contract Schema authority

`packages/contracts` 中由 Agent Platform 主系统维护的 wire Schema 只手写 Zod 4，并从该 authoring source 单向生成两类提交到仓库的标准产物：浏览器、用户/应用 API 和内部 HTTP Contract 使用 OpenAPI 3.1，SSE payload、Runtime Manifest 等非 HTTP Contract 使用 JSON Schema 2020-12。生成后的 OpenAPI 是 HTTP 消费者评审和兼容检查的规范来源，其中浏览器 OpenAPI 也是 TypeScript Client 的生成输入；JSON Schema 是非 HTTP Contract 的机器校验入口。调用方不得直接编辑生成产物，也不能从 OpenAPI 或 JSON Schema 反向生成 Zod，项目不维护第三套通用 Schema IR。取舍见 [ADR: Wire Contract 使用 Zod authoring 与标准发布产物](../adr/0003-zod-authored-wire-contracts.md)。

M1 的 Schema family 由以下主责 artifact 维护；表中 Issue 是既有交付入口，新增 API、任务和 Eval 契约的实施归属须在交付计划中对齐，不隐式扩展原 Issue 范围：

| Schema family | 主责 artifact | Implementation Issue |
| --- | --- | --- |
| 公共 primitives、错误模型、生成与兼容工具 | Platform Core/API | [#179](https://github.com/AgoraIO-Extensions/agent-infra/issues/179) |
| Platform HTTP/OpenAPI、SSE 与生产 Web Client | Platform Core/API，Web/API 消费方评审 | [#180](https://github.com/AgoraIO-Extensions/agent-infra/issues/180) |
| RuntimeHost/Driver wire Schema | Codex Runtime，Worker 消费方评审 | [#181](https://github.com/AgoraIO-Extensions/agent-infra/issues/181) |
| Registry、Secret、Kubernetes Workload 与 Runtime Manifest Contract | Agent Workload，Core/Delivery 消费方评审 | [#182](https://github.com/AgoraIO-Extensions/agent-infra/issues/182)；OCI admission 由 [#188](https://github.com/AgoraIO-Extensions/agent-infra/issues/188) 实现 |

生成工具固定版本；产物使用稳定 key/property 顺序、LF 和一个末尾换行，不能包含时间戳、绝对路径或工具版本等易漂移字段。`packages/contracts` 必须在现有 `pnpm test` 路径中执行生成漂移、基于 pull-request merge-base 的 breaking-change 和 consumer contract 检查。test-only Client smoke 只验证 OpenAPI 到浏览器 TypeScript Client 的单向链路，不进入 package exports、`files` 或 `dist`；`packages/test-support` 只提供由正式 Schema 校验的静态 builder/fixture，生产代码不得依赖它。Connection 的 MCP/API、客户端身份、OAuth、Grant、凭证和 Action Schema 由 Connection 自己维护；Platform Schema 不定义 Connection 代调用协议或数据投影。

## 7. Web 架构

### 7.1 页面模块

Platform Web 按产品入口划分路由：

- `/agents`：Agent 列表与详情。
- `/chat/:agentId/:conversationId?`：对话与历史。
- `/my-agents`：申请和 Owner 管理。
- `/my-agents/:agentId/settings`：范围、模型、渠道和已验证的集成入口。
- `/admin/approvals`：系统管理员审批。
- `/admin/audit`：必须交付的平台审计筛选、分页与详情。

Web 同时提供个人 API 凭证、应用及其凭证/Agent 授权、任务执行详情、Eval 数据集/实验/对比和主动反馈入口；具体页面行为以 [平台 Web PRD](../prd/PRD-agent-platform-M1.md#111-页面) 为准。运维观测由部署的日志、指标和 Trace 后端承接。

Connection 使用独立 `connection-web` 和独立浏览器会话，包含登录、个人 Connection、Agent Grant、调用记录、待人工处理、Provider/Action、共享 Connection 和 Connection 审计页面。Platform Web 只跳转到 Connection 返回的受控 URL，不能承载或复制 Connection 管理页面。

个人 Connection、OAuth、Grant、Action 确认、撤销和调用记录全部由独立 Connection 入口管理。Platform Web 不复制其页面或数据，也不能把两侧关联信息拼成授权结论。

### 7.2 状态管理

- TanStack Query 管理列表、详情、配置和审批等服务端状态。
- 路由参数和 URL Search Params 保存可分享的页面筛选状态，但 M1 不提供会话分享。
- 对话时间线使用独立 reducer 合并持久化消息、SSE 增量和重连补发事件。
- 表单使用 Schema 校验；服务端重复执行同一校验，不能信任浏览器结果。
- 不预装全局状态库。只有出现跨路由、非服务端且难以由 React Context 管理的状态后再引入。
- Web 使用 OpenAPI 生成的 TypeScript Client，并通过同一 Contract Schema 校验的 Mock Server 和场景 fixture 独立开发。Mock 必须覆盖正常、无权限、启动中、繁忙、失败和 SSE 重连，不能维护另一套手写假接口。

### 7.3 前端安全职责

前端只负责隐藏无权限入口和展示明确错误，不负责最终授权。普通用户不能获得模型 API Key、Connection 原始凭证、内部 Kubernetes 状态或其他用户的资源标识。

## 8. HTTP 与事件契约

### 8.1 浏览器与用户/应用 API

- 管理和查询使用 `/api/v1/*` HTTP/JSON。
- 创建、更新和命令类请求支持 `Idempotency-Key`。
- 浏览器与用户/应用 API 遵循 [Contract Schema authority](#64-contract-schema-authority)；生成并提交的 OpenAPI 3.1 是消费者使用的规范来源。
- TypeScript 客户端由 OpenAPI 生成，禁止手写重复的请求/响应类型。
- 文件使用预签名上传/下载；业务接口只传文件引用和元数据。

API 契约覆盖 Agent 创建/启动/停止/重启、任务提交/查询/取消、结果订阅、凭证与应用授权、审计和 Eval。产品行为分别引用 PRD [API 身份](../prd/PRD-agent-platform-M1.md#73-api-身份凭证与授权)、[后台任务](../prd/PRD-agent-platform-M1.md#104-agent-api-与后台任务)、[审计](../prd/PRD-agent-platform-M1.md#13-平台操作审计)和 [Eval](../prd/PRD-agent-platform-M1.md#15-模型质量评估与效果分析)。路由只解析可信上下文、校验 Schema 并调用 Core；创建和任务受理返回稳定资源 ID 与持久状态，不能把 HTTP 成功等同于 Workload 就绪或任务完成。

### 8.2 SSE

对话回复和状态流使用 `text/event-stream`：

- 每个事件包含稳定 `eventId`、`executionId`、Execution 内递增 `sequence`、Conversation 内严格递增 `conversationCursor`、`type`、`occurredAt` 和类型化 payload。
- Runtime 来源事件与 Platform 来源事件写入同一持久化时间线并共享上述排序空间。Runtime 来源必须携带非空 Runtime cursor，且不能写入 Platform 保留事件类型；Platform 来源按 Schema 显式区分任务受理/等待/取消等状态事件和 `model.selection.fell_back`；其中模型回退事件绑定接收消息的 Execution、Runtime cursor 为空，payload 只包含实际采用的模型选项、推理强度和固定的受限原因。
- 标准模板当前选择失效时，`platform-api` 在接受消息的同一 Conversation 事务中写入一条 `model.selection.fell_back`：初始消息和重新生成绑定新建 Execution，补充指令绑定当前活跃 Execution。该事务同时分配下一 Execution `sequence` 和 Conversation `conversationCursor`、推进两个平台计数器并保存对应审计；幂等重放复用原分配，任何一步失败均整体回滚，且不推进 Execution 的 Runtime cursor。
- Web/API 调用方通过 `Last-Event-ID` 或显式游标重连；服务端验证游标属于当前主体有权访问的 Conversation/Execution，任务流不能带出同会话其他任务的数据。
- 服务端先保存事件，再向在线连接推送；断线后按持久化序列补发。
- 心跳只用于保持连接，不进入业务时间线。
- 同一事件可能被重复投递，消费者按 `eventId` 去重。订阅建立、续传和存续期间执行当前主体/凭证授权；失效后关闭流，审计订阅起止，不逐条审计输出。

M1 不使用 WebSocket。用户发送消息、停止回复和补充指令都通过普通 HTTP 命令完成；只有出现必须由同一连接双向交换低延迟事件的需求后才重新评估。

### 8.3 内部接口

`platform-worker` 到 Agent Pod 使用遵循 [Contract Schema authority](#64-contract-schema-authority) 的版本化 OpenAPI HTTP 契约；Runtime 增量事件使用由 JSON Schema 校验的内部 SSE。内部接口通过部署提供的服务身份和 mTLS 或等价机制认证，并验证执行授权，不因位于集群内而跳过鉴权。

Agent/客户端到 Connection 的 MCP/API 使用 Connection 的独立身份和契约，不经过 Platform API。平台不读取 Connection Catalog，不持有其目录读取或代调用 workload credential。

M1 不引入 tRPC/oRPC/ConnectRPC。

## 9. 身份与权限

### 9.1 IdentityAdapter

- 开源主系统不实现或限定 OAuth、OIDC、LDAP、登录页面、redirect 或目录产品。部署环境通过进程内可信 Adapter、经过认证的服务边界或版本化签名信封向 `platform-api` 提供当前 IdentityContext；跨进程传递时必须校验签发方、audience、签发/过期时间、唯一 context ID、keyVersion 和部署身份绑定，并在缺失、过期、重放或验证失败时 fail closed。
- IdentityContext 至少包含稳定且不透明的用户 ID、当前账号状态、组织成员关系、平台角色，以及足以判断上下文是否仍有效的版本或时效信息。
- 浏览器、Agent、模型和普通调用方不能提交、覆盖或伪造这些字段；`platform-api` 必须验证部署身份边界后才创建 HttpOnly、Secure、SameSite 会话，且不在 Local Storage 保存上游身份凭证。
- 平台不维护独立用户目录，只保存业务记录所需的稳定用户引用。具体认证、组织查询和账号生命周期实现属于部署 Adapter。
- 账号状态与组织关系在每次敏感操作前重新解析；短期缓存不能成为独立权限来源。IdentityAdapter 缺失、返回非法结果或暂时不可用时，敏感操作 fail closed，不能使用调用方字段或不受控旧缓存继续授权。
- IdentityAdapter 确认账号禁用时，平台为该用户全部仍活跃的 Execution 幂等创建平台来源的停止工作项；若平台确认用户失去某个 Agent 的可用范围或某个渠道的权限，则只处理服务端保存的 Agent 或渠道授权上下文受该撤权事实影响的活跃 Execution。该控制操作不借用已撤权用户的调用权限。具体投递和竞态规则见 [Agent Runtime M1 HLD](HLD-agent-runtime-M1.md#81-消息与命令幂等)。

Connection 不消费 Platform 浏览器会话或 Platform API 凭证；其 LDAP 登录、OAuth 客户端身份、授权及复核机制由 [Connection M1 HLD](HLD-connection-M1.md) 定义。

### 9.2 权限顺序

Web/企微依次校验可信用户当前状态、Agent 可用范围/有效 Owner、渠道权限和已验证 Runtime 能力。模型选择须属于标准模板 Owner 当前允许清单或 ACP Runtime 当前有效选项，API 也遵循该模型边界。Connection 的独立授权在其调用入口完成。

`platform-core` 的 Access 模块维护独立应用、注册责任人、API 凭证元数据与显式 Agent 授权；用户状态/组织关系仍来自 IdentityAdapter。API Adapter 验证凭证后生成可信用户或应用上下文，保留主体类型、稳定 ID、凭证引用、操作范围及有效期，不能由请求字段覆盖。凭证只保存不可逆校验材料和必要元数据，首次交付后不提供原值读取；个人凭证由本人管理，应用凭证由登记责任人管理。

创建用例将 Agent、创建主体、Owner、初始管理/使用授权、outbox 和必要审计原子保存。用户创建的 Owner 为本人，应用创建的 Owner 为登记的自然人责任人，创建主体仍为应用。API 不进入 Web 申请审批状态机，也不设预审批；镜像/配置与运行能力准入仍适用。管理与使用授权可分别撤销，应用不继承责任人的权限，Owner 不能绕过已撤销的 API 授权。

每次 API 操作在 Core 中检查：当前主体有效、当前对应业务授权、凭证操作范围与有效期、目标 Agent/渠道/Runtime 能力。任务查询、订阅、结果文件访问与调用方取消还须匹配持久保存的提交主体，并具有当前 Agent 使用权；Owner 或责任人角色不能替代这项匹配。相同主体的另一有效凭证可在其权限范围内操作原任务。

| 变化 | API/订阅 | 已受理任务 |
| --- | --- | --- |
| 单个凭证过期或撤销 | 拒绝该凭证并关闭其流 | 继续执行，不把凭证失效当作主体撤权 |
| 主体禁用或 Agent 使用权撤销 | 拒绝新工作和访问 | 取消未开始任务，向进行中任务投递系统取消，并阻止后续平台受控操作 |
| 身份或授权依赖无法确认 | 敏感操作 fail closed | 不凭旧缓存继续投递；保持可解释的等待/未知状态，按原执行恢复核实 |

撤权控制以服务端持久授权关系定位 Execution，由系统身份执行，不能借用已失效调用方凭证。取消请求与实际停止分开保存，不回滚已发生的外部效果；Connection 在自己的入口执行当前授权。

### 9.3 服务端授权上下文

Web 和企微仍按可信用户、当前 Agent 可用范围及渠道权限校验；API 按 9.2 校验。每次 Turn 或补充指令实际投递前，平台重验当前主体和 Agent 使用权，再生成短期、不可篡改且版本化的 Runtime Execution Grant。Grant 绑定签发方、RuntimeHost audience、签发/过期时间、唯一 `grantId`、Execution、Agent、提交主体及类型、渠道、Conversation/Turn、允许命令和附件操作。执行范围受原受理授权边界约束，不能因后台 Worker 的服务权限而扩张；受理时凭证的后续失效按 9.2 处理。

RuntimeHost 在读取附件或运行命令前校验签名、签发方、audience、有效期与全部对象绑定。服务身份、请求字段、Session Ref 或 Runtime 返回值不能单独作为授权依据。补充指令取原 Execution 边界与当前授权的交集；不匹配或过期时拒绝，日志和审计只保存 Grant 引用及受限原因，不保存原始证明。

Runtime Execution Grant 仅授权平台 Runtime 操作，不是 Connection 访问凭据。平台不为 Connection 签发 assertion、不传递 Owner Action policy，也不替 Connection 决定客户端可调用的外部账号。

## 10. Agent Workload 与调谐

### 10.1 Workload 形态

Web 与 `platform-api` 是位置无关的 Platform 服务；`platform-worker`、KubernetesRuntimeAdapter、Agent Workload 和部署访问路由组成 Kubernetes Workload Plane。只有 `platform-worker` 的部署身份可以访问 Kubernetes API，并且权限限制在目标 namespace 内。Web、`platform-api`、Connection 和 Agent Pod 都不能持有 Kubernetes API credential。取舍见 [ADR: Platform 服务与 Kubernetes Workload Plane 分离](../adr/0001-separate-platform-services-from-kubernetes-workload-plane.md)。

开源实现只使用受维护 Kubernetes 版本中的 GA capability baseline：`apps/v1` StatefulSet、core/v1 Service/ServiceAccount/PVC/Secret、`networking.k8s.io/v1` NetworkPolicy，以及 `networking.k8s.io/v1` Ingress 或部署 Adapter 提供的等价受控路由。每个 release 记录经过 `kind` 和真实部署验证的版本矩阵；不为 Kubernetes 1.16、`networking.k8s.io/v1beta1` Ingress 或超出支持 skew 的客户端维护兼容分支。

- 一个 Agent 对应一个副本为 0 或 1 的 StatefulSet。
- 运行时为“可用”时副本为 1；已停止或已停用时副本为 0。
- 每个 Agent 使用独立 Service、ServiceAccount 和持久卷。
- ServiceAccount 默认没有 Kubernetes API 权限。
- Agent Service 只提供集群内部地址，Pod 或 Service 地址不作为用户入口。StatefulSet、Service、部署访问路由和 NetworkPolicy 只由 `platform-worker` 通过 KubernetesRuntimeAdapter 调谐，Agent 与 Owner 都不能直接创建或修改这些资源。
- 平台配置、对话和 Connection 授权不保存在 Pod 本地。
- Agent 自有记忆或工作区通过独立持久卷保存，并由模板或自定义 Agent 负责用户隔离。

Owner 不能修改 CPU、内存、副本数和存储规格。资源规格由平台按 Agent 类型选择预设 Profile，Web 审批页展示该配置；API 创建复用相同规格选择，不增加审批。

### 10.2 期望状态

Platform DB 保存：

- 管理状态与期望运行状态。
- 模板或自定义镜像的不可变 Digest。
- 配置修订号。
- 资源 Profile。
- 交互模式、渠道和 Runtime 能力声明。
- 普通 env、版本化 Secret 密文状态和 active/pending 配置修订。

`platform-worker` 通过幂等调谐完成：

1. 读取待处理修订号。
2. 通过 ImageRegistryAdapter 解析并校验获准 OCI Digest、Runtime Manifest 和访问政策。
3. 生成或更新 StatefulSet、Service、PVC 和部署访问路由。
4. 根据探针和 Workload 状态计算产品服务可用性。
5. 写回已应用修订号、可用性和脱敏失败原因。

HTTP 请求只提交期望状态，不等待 Kubernetes 操作完成。

Kubernetes 调谐结果在已停止、期望副本为 0、实际 StatefulSet 不存在且路由已关闭时返回
`status: absent`，保留请求、Agent、配置修订、Workload 修订和 fence 的完整关联，固定
`replicas: 0`、`routeClosed: true`，不生成虚构的 Workload UID 或 generation。
运行中期望不能接受该结果；资源期望身份、归属、fence 或路由关闭校验失败仍返回失败，
不能以资源缺失掩盖拒绝或不完整操作。保留的持久卷不因该结果被删除。

Platform DB 的 outbox 保证状态变更和投递可恢复；API 任务在同一 Store 内另保存受理顺序、等待期限和调度状态，由 Dispatch 实施第 12.4 节的有界等待。M1 不提供通用队列管理、优先级、定时调度、资源池、自动休眠或调用方逐任务执行时限参数。

### 10.3 并发与 Leader

- 多个 `platform-worker` 实例可以同时运行。
- 同一 Agent 的调谐通过 PostgreSQL 行锁或 advisory lock 串行化。
- 每次 apply 携带配置修订号，旧任务不能覆盖新状态。
- Kubernetes 资源使用稳定 label 和 annotation 关联 Agent ID 与修订号。
- M1 不创建 CRD；Platform DB 是产品期望状态的唯一来源。

### 10.4 模板与自定义镜像升级

- 标准模板目录保存当前镜像 Digest。模板更新后，所有关联 Agent 进入新修订并自动调谐。
- 自定义 Agent 创建时把 Tag 解析为 Digest；只有 Owner 主动选择新镜像时更新 Digest。
- 同名 Tag 指向新 Digest 时可以通知 Owner，但不能改变已有自定义 Agent 的期望 Digest。
- 自定义 Agent 的新 Digest 先进入候选修订。平台重新读取并校验 Manifest；M1 不支持在升级中切换 `interactionMode`，Schema、Service 或健康检查字段无效，或模式与当前 Agent 不一致时不更新 Workload。有效的新 Service 和健康检查配置进入候选 Workload。
- Manifest 预检通过后，`platform-worker` 应用候选 Workload 并验证健康检查；`platform-adapter` 还必须重新执行 ACP 核心探测。候选 Workload 在验证完成前不加入用户路由或原渠道；无法与旧修订隔离运行时，先关闭用户路由再应用候选 Workload。
- 全部验证通过后，`platform-worker` 按候选修订号执行可重入提升。Platform DB 保存期望修订和切换进度，Workload、用户路由和渠道确认均绑定该修订号；这些跨 PostgreSQL 与 Kubernetes 的操作不要求分布式原子事务。每一步必须幂等，Worker 重启或部分切换后根据 Platform DB 和 Kubernetes 资源上的修订号继续收敛；用户路由配置始终只指向一个已验证修订，判定失败的候选修订不能继续接收流量。任一步失败时，把旧 Digest 和 Workload 配置写成新的期望修订并重新调谐，保持或恢复旧路由，保留原渠道绑定和平台历史。
- 标准模板升级失败时，平台把旧 Digest 和 Workload 配置写成新的期望修订，再由 `platform-worker` 通过 Kubernetes API 重新调谐；不能把 Kubernetes 当前状态当作回滚来源。
- 升级和回滚复用原 PVC，保留 Platform DB 中的配置、渠道和会话数据。M1 不自动创建 PVC 快照，也不承诺 Runtime 自有数据兼容旧版本。
- 升级期间产品显示“更新中”；旧修订也无法恢复时才显示 Agent 级“暂时不可用”。任何阶段都不能接受后静默丢弃消息。

调谐状态分别持久化管理 fence 与 Workload revision；新状态绑定管理 fence，本地漂移和重试只推进 Workload revision，所有 Kubernetes 操作使用所绑定的 fence。历史 V1 状态缺失 fence 时，Store 在既有 Agent 行锁事务内以 `max(management.fence, state.revision) + 1` 执行一次技术 epoch 接管，经安全整数校验及 application id、旧 fence、管理与 Workload 修订 CAS 后，原子更新管理 fence 和状态 fence，保留 Workload revision。该兼容接管不表示产品生命周期变化，不生成虚构的生命周期历史；事务失败可重试，出现更高 Kubernetes fence 时仍拒绝，不以 Kubernetes 反推产品期望。

### 10.5 自定义 Agent Runtime Manifest

Manifest 字段、交互模式、Runtime 探测顺序和 capability 派生规则只在 [Agent Runtime M1 HLD](HLD-agent-runtime-M1.md#4-runtime-manifest) 中维护。

审批通过后，只有 ImageRegistryAdapter 准入与 Manifest 预检通过才启动 Workload。`platform-worker` 创建 StatefulSet、Service、部署访问路由、NetworkPolicy、Kubernetes 配置、Secret 和新 PVC，验证健康检查，再请求 HLD 定义的 Runtime 探测；访问路由只有在健康检查和所需核心探测通过后才接收用户流量。任一步失败时产品状态为“创建失败”，并返回脱敏且可修复的原因。

启动 Workload 后创建失败时，`platform-worker` 必须先关闭访问路由，再幂等清理本次创建的 Kubernetes Workload、访问资源、配置、Secret 和尚未进入“可用”的新 PVC；Platform DB 中的申请、Agent 配置、失败原因和审计保留，重试时重新创建运行资源。升级的候选修订、路由切换和失败恢复见 10.4。

Workload preflight 区分永久配置或 admission 拒绝与可重试的基础设施异常。永久拒绝立即进入既有失败处理；临时 Registry、Kubernetes 或依赖异常使用持久化尝试次数，在 `maximumAttempts` 预算内保留 preflight 步骤重试。预算耗尽后复用既有清理或候选拒绝路径，更新失败时保留已验证版本；原始异常正文不进入持久状态。

### 10.6 环境变量与 Secret

Platform Secret 使用项目内置密文、部署加密公钥和 Worker-only 解密 keyring，取舍见 [ADR: Platform Secret 使用项目内置密文存储](../adr/0002-store-platform-secrets-as-application-ciphertext.md)。该模型不自动扩展到 Connection Provider 凭证。

- 固定 Runtime Registry 为每个标准模板声明 Owner 可配置的 env/Secret 键。`platform-api` 在保存前拒绝该模板未声明的键，`platform-worker` 只装配已声明的键。
- Registry 不得向 Owner 开放代理设置、进程加载器或 Runtime 启动选项等能够改变标准模板受信运行边界的键。
- 自定义镜像接受 Owner 配置的任意 env/Secret K/V，但不能使用平台保留前缀。
- `AGENT_INFRA_*` 由平台保留并按执行环境注入；标准模板或自定义镜像的 Owner 输入使用该前缀时均在保存前拒绝。
- 普通 env 保存于 Platform DB。Secret `algorithmVersion = aes-256-gcm:v1` 要求每次加密（包括轮换和失败重试）都由 CSPRNG 新生成 256-bit DEK 和 96-bit nonce，同一 DEK 只允许加密一条记录且不得复用 nonce；`platform-api` 计算不泄露 DEK 的 SHA-256 fingerprint，并通过 Platform DB 唯一约束检测冲突，冲突时丢弃结果并重新生成 DEK/nonce。AEAD 使用 128-bit authentication tag 和版本化 canonical AAD；AAD 按固定顺序对 Secret ID、Owner 类型/ID、Agent ID、Secret 名称、Secret 版本和 `algorithmVersion` 做无歧义的长度前缀 UTF-8 编码。`platform-api` 用 DEK 加密明文，再用部署 active 公钥按 `wrappingAlgorithmVersion = rsa-oaep-sha256:v1` 和至少 3072-bit RSA key 封装 DEK。Platform DB 保存 DEK fingerprint、nonce、ciphertext、authentication tag、wrapped DEK、`algorithmVersion`、`wrappingAlgorithmVersion`、`wrappingKeyVersion` 和生命周期状态；任何字段或 AAD 绑定不一致都必须认证失败。
- 部署只向 `platform-api` 注入版本化加密公钥，向 `platform-worker` 注入对应私钥 keyring；API 不持有可解密历史 Secret 的私钥。私钥不进入仓库、数据库、日志、错误、审计、模型上下文或 Agent Pod；缺少目标私钥、DEK 解封或 AEAD 认证失败、密文元数据非法时 fail closed。
- 新 Secret 先保存为 pending 版本并产生配置修订。`platform-worker` 解封 DEK、受控解密，并以包含 Agent、Secret 版本和配置修订标识的不可变名称创建 Agent 专属 Kubernetes Secret；禁止原地修改已被任一 Workload 引用的 Secret，再调谐只引用该版本化名称的候选 Workload。
- Secret record/reference 的 `configRevision` 表示该不可变 Secret 物化的来源配置修订，与后续 Workload 配置修订不同。后续配置保留完全相同的名称、Secret ID 和版本时，Core/Store 只能在 Agent 锁内从当前持久化配置派生已验证的 active 物化；Worker 沿用其原始 AAD、Kubernetes 名称和激活 fence，正常物化复用时不解密、复制、重新加密或重新激活；候选模型访问验证仅允许 10.7 的受控解密例外，物化丢失或 UID 变化时仅允许下述受控恢复。只有新引入或替换的引用才创建并激活新的 pending 版本。
- Platform DB 与 Kubernetes 不共享事务。Worker 只有在观测到目标 Workload 已使用对应版本化 Secret、通过健康检查，且观测到的 Agent ID、Secret 版本、配置修订、Workload UID/generation 与当前 fence 全部匹配后，才能在同一条件更新中将 pending 版本提升为 active；任一值变化都拒绝激活并重新调谐。Worker 重启时幂等恢复 pending、applying、observed 和 active 中间状态。失败或状态不确定时旧 Workload 与旧 active Secret 继续有效，确认新版本生效、没有 Workload 引用旧名称且满足回滚保留策略前不得回收旧版本。
- Secret 只能替换，Owner/API 只能读取“已设置”、版本和状态。添加新 active 公钥/私钥版本后，由 Worker 执行幂等、可恢复的历史 Secret 重新加密或 DEK 重新封装；数据库不再引用旧 `wrappingKeyVersion` 后，部署才能移除旧私钥。
- `platform-worker` 只把当前 Agent 运行所需的 active Secret 装配到其 Kubernetes Secret；值不进入 annotation、日志、错误或模型上下文，Agent Pod 不能访问解密私钥或其他 Agent Secret。
- Worker 解封、解密、重新加密/封装和 keyVersion 退役都记录不含值的审计事件，至少关联 Secret ID、Agent ID、`wrappingKeyVersion`、操作、结果和 `traceId`；主体绑定或附加认证数据不匹配时拒绝并审计，不能返回明文。

StatefulSet 的逐 Secret activation-fence 旁持久保存实际 Secret UID；创建或可信解密后精确值校验返回的 UID，在再次校验 live 对象身份后与 fence 通过 resourceVersion CAS 一起绑定，调谐保留两者。观察、active 复用和带 activation-fence 的回收必须匹配 live UID；删除使用 UID/resourceVersion 前置条件。历史缺失 UID 绑定时不授权元数据快速复用或删除，须先沿既有解密与精确值校验路径，再绑定同一实际 UID 与原 activation fence；不得仅凭名称或 annotation 回填身份。此内部 Kubernetes 绑定不改变公开 V1 Secret fence 或数据库记录。

已有 active 绑定对应的对象缺失或同名对象 UID 改变时，Worker 必须保持路由关闭，并从 Platform DB 的原始密文记录可信解密、审计，创建或精确校验同一完整 Secret reference 的 immutable Opaque 对象及全部数据。仅当 StatefulSet UID 与持久 activation fence 匹配、generation 未回退、逐 Secret activation fence 与原值精确相等且当前管理 fence 校验通过时，才可在再次回读确认已验证的 live Secret UID 后，通过 StatefulSet resourceVersion CAS 更新 UID 绑定。同名 live 对象的新 UID 证明旧 UID 已不再占据该名称；创建后崩溃的重试仍须重新完成可信值校验，不依赖进程内标记。此路径不修改原 Secret 版本、密文或 activation fence，不重新激活；普通绑定、观察、元数据复用与回收不得据此放宽 UID 校验，任一校验或 CAS 失败继续关闭路由并重试。

失败升级在切换到已验证配置前，先在关闭路由的 cleaning 步骤回收当前候选中尚未激活的 Secret；回收未完成则保留该步骤重试，避免回滚替换候选绑定和 UID/fence 见证后失去回收路径。该步骤不删除 Workload 或 PVC，仍保护 active、active-origin 与回滚保留项。 停止、重启或配置更新不能覆盖未完成的回收义务；清理期间继续按候选历史配置解析 Secret，使用最新管理 fence 保持路由关闭，完成后才切换至最新管理和配置期望。初次创建失败且无已验证配置时同样保留清理义务，沿既有路径完成候选 Secret、失败 Workload 与新 PVC 回收，并清除旧 Workload 身份后才接纳最新期望。

### 10.7 标准模板模型配置

- 部署通过 ModelCatalogAdapter 提供稳定 `endpointId`、获准的精确 Base URL/origin、protocol profile 和流式/tool/reasoning capability policy。目录不保存或下发 API Key，也不强制固定模型名单；Owner 不能提交或覆盖目录外的 Base URL。
- 每个标准模板 Agent 的 Owner 独立配置 `endpointId`、加密 credential reference、允许的模型 ID、默认模型和 reasoning 档位。普通使用者只选择 Owner 已允许且通过验证的模型/reasoning，看不到 Base URL 或 credential。
- 对应 Runtime Driver 在候选配置生效前验证 credential、模型存在性和目录要求的 capability，并把配置翻译为 Runtime 实际参数。失败时新配置不激活，旧配置继续有效。
- `platform-worker` 装配标准模板运行配置时，以当前 active 模型配置为最终值；同名 Owner env 或 Secret 不能覆盖 endpoint、credential、模型和 reasoning。
- Platform 在接受消息时把当次有效的 `modelOptionId` 和 `reasoningLevel` 固化到 Execution 及其 outbox；`platform-worker` 只把这组已固化选择放入版本化 RuntimeHost submit，不能在投递或重试时重新解析默认项。RuntimeHost/Driver 不读取 ModelCatalog 或 Platform 默认值；取舍见 [ADR: 将 Execution 有效模型选择绑定到 Runtime submit](../adr/0004-bind-execution-model-selection-to-runtime-submit.md)，精确映射、幂等和拒绝语义见 [Agent Runtime M1 HLD](HLD-agent-runtime-M1.md#5-platform-conversation-contract)。
- Platform 不代理模型流量，也不负责供应商路由、成本、预算、配额或故障切换。Agent Pod 只获得本 Agent 当前 active credential；endpoint、认证、模型、额度和 capability 错误映射为稳定、脱敏且可操作的产品错误。
- 自定义 Agent 的模型配置属于镜像内部；通过 ACP 探测到模型选择能力时，平台入口读取 Runtime 当前提供的选项和默认项并转发使用者选择，不配置或读取其 Base URL 与凭证。提交 Turn 前必须确认选项仍有效，不能在选项失效时静默改用其他模型。

部署 Workload options 通过 `packages/model-catalog` 的
`createDeploymentModelCatalogAdapterV1({ load })` 注入目录，通过
`createResponsesModelAccessValidatorV1()` 注入访问验证。目录快照必须带
`schemaVersion: 1`、精确 `revision` 和毫秒时间戳 `validUntil`；每个端点带
`endpointId`、精确 `baseUrl`/`origin`、`openai-responses-v1` profile、TLS 与禁止重定向策略、
streaming/tool/reasoning policy、可选 `allowedModels` 和可用状态。`allowedModels: null`
表示目录不额外限制模型名单，仍须验证 Owner 指定的模型。未知字段、缺失、移除、过期、
修订不匹配和不可用结果均返回 `MODEL_CONFIGURATION_UNAVAILABLE`，不回传原始异常。

Worker 在 preflight 对每个 option 独立可信解密并审计，通过有截止时间的合成 Responses
请求验证 credential、模型、每个 reasoning 档位、流式完成和 function call；探测不使用会话内容，
不执行工具，设置 `store: false`，整个投影最多 60 秒，每次响应最多 1 MiB。
部署应计入这些配置验证请求的额度。Runtime Driver 继续负责 pinned native profile 验证。
任何选项失败都不物化候选 Workload；临时解密 buffer 在验证后清零。
Workload 部署使用 Worker-only `createWorkloadSecretKeyringDecryptorV1`，允许解密 Store
已确认的 current/active-origin 记录；仍验证完整记录与加密 AAD，不改变 Secret 状态。
候选 preflight 的访问验证是 10.6 物化复用规则的受控解密例外：沿原 AAD 解密并记录既有
Secret ID、Agent ID、keyVersion、结果与 traceId 审计；不复制、重新加密或重新激活 active-origin。
已验证配置的正常调谐、漂移修复与回滚不重复访问验证；物化恢复仍遵循 10.6。
独立 Secret 激活入口继续使用拒绝 active 记录的 `createSecretKeyringDecryptorV1`。

通过验证的投影及 SHA-256 指纹与 candidate/verified 一起保存在 Worker 的持久调谐状态，
不进入公开 desired contract。Runtime V2 JSON 写入独立 immutable 配置 Secret，每个 option
通过显式 `secretKeyRef` 注入 `AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_*`，配置 JSON 同样通过
`secretKeyRef` 注入 `AGENT_INFRA_RUNTIME_MODEL_CONFIG`；模型 credential 不再通过 `envFrom`
导入。Owner 的普通模型环境变量不参与 Runtime V2 选择，平台保留键仍拒绝。
annotation 仅保存模型投影指纹；观察和路由提升从 Worker 持久投影校验配置 Secret、Pod
变量、引用和已有 Workload/Secret fence，不从 live annotation 恢复 endpoint。
候选在 apply、Secret 激活及路由开放前重新解析当前目录，要求 endpoint 与 policy 和持久投影
完全一致；目录过期、移除或变化时继续关闭路由并进入既有失败处理。已验证版本的恢复与
回滚使用 verified 投影，不依赖目录仍保留旧修订。
失败候选复用既有回滚流程及 verified 投影。回收仅针对持久候选确定的配置 Secret：先关闭
路由、排空 Pod，并从停止的 Workload 移除该配置引用；精确校验内容、Agent、配置修订和
fence 后通过 UID/resourceVersion 前置条件删除。初次失败在资源清理后同样回收配置 Secret。
清理未完成时保留 candidate 重试，不删除 verified 配置或其他 Agent 标记的 Secret；已验证
版本化配置仍按回滚保留策略保留。

### 10.8 Codex 原生模型传输边界

Codex Driver 在 Agent Pod 内管理一个仅绑定 loopback 的模型传输入口，将原生模型请求转发到
该 Agent 当前配置中所选模型选项的已批准 endpoint。每个选项的上游 credential 仅保留在父进程；
原生子进程只持有随机、
短期且绑定该 Driver 生命周期的 loopback token。该入口只接受固定的 Responses 路径，不接受
调用方选择上游、任意路径、跳转或代理配置；关闭 Driver 后撤销 token 并关闭入口。

部署配置以版本化、不可变的选项集合传入 RuntimeHost；每个 `modelOptionId` 独立绑定 endpoint、
真实 model、允许的 reasoning 与注入 credential，不因 model 名称相同而合并。Execution 已冻结
的 optionId/reasoning 决定该次原生 Turn；重试沿用原选择，未知选项、配置版本或路由标识拒绝。
Worker 负责目录解析和配置/SecretRef 投影，RuntimeHost 不读取目录、数据库或 Kubernetes。

模型 endpoint 必须使用 HTTPS；HTTP 仅允许原始 URL 显式使用 `127.0.0.1` 或 `[::1]`
的 loopback 地址，不接受主机名或其他 IP 别名。注入 credential 必须为 16–8192 个可打印
非空格 ASCII 字符；配置准入拒绝过短值，避免逐子串泄漏检测误拒正常 SSE 字段。
长度下限不替代既有凭证泄漏检测，也不作为凭证熵或供应商认证有效性的证明。

固定 Codex 版本的 `turn/start` 不能切换 provider，因此 Driver 使用每选项唯一的内部模型名
`namespace/model`，namespace 从选项身份确定性生成且仅含非空 ASCII 字母、数字、`_` 或 `-`；
整个别名恰好一个 `/`，model 保留不含 `/` 的真实模型名。固定版本按 model 后缀最长前缀匹配
能力元数据；Driver 准入只接受与 profile 完全相同或以 `-` 分隔后缀的模型名，并选择最长匹配
profile 校验 reasoning；此匹配不代表供应商支持该后缀。多斜线、非法 namespace 或不匹配
已验证 profile 的配置拒绝。父进程仅按完整
内部模型名查询当前批准集合，将请求的 model 改回真实 model，并使用该项固定 endpoint 与
credential；不根据模型正文、调用方 URL 或同名 model 猜测路由。该方式必须保留原模型在 pinned
Codex 中的能力元数据，不自行生成或放宽 capability profile；无已验证 profile 的选项不准入。
同一会话连续切换两个不同 endpoint/credential、且真实 model 同名的选项必须有原生测试；
任何上游失败都不得改用其他选项。

供应商 HTTP 失败与 HTTP-200 流内失败必须在进入原生进程前归一为固定脱敏错误；不能把原始
错误正文、headers、credential 或内部路径交给原生进程落盘。成功 SSE 按事件校验格式和大小，
保留正常模型与工具调用语义；非法、超限或不完整终态必须失败，不能当作成功。取消、下游
断开或 Driver 关闭必须中止上游请求并释放资源。此边界不增加模型选择、重试或故障切换政策。

原生 Turn 取消不能只等待 Codex 关闭 HTTP 连接。父进程以已验证的 pinned 请求
`x-codex-turn-metadata` 中 `thread_id` 与 `turn_id` 关联上游请求，并与 Driver 的原生
Thread/Turn 生命周期绑定；缺失、非法或冲突的关联拒绝，不能根据模型正文或上游地址猜测。
该关联只在 Driver 内使用，不替代 Grant/fence 授权，也不进入 RuntimeHost wire、日志或外部响应。
停止 Turn 或取消代次时，在返回取消确认前中止目标 Turn 的全部上游请求并完成资源清理，
拒绝该目标的迟到请求；其他 Thread/Turn 的请求和后续合法 Turn 保持可用。普通请求超时、
全 Agent 中止或生成合成 SSE 内容均不能替代精确取消；原有代次 barrier 保持不变。

Driver 在启动 RPC 前登记可信 Thread、唯一 pending 操作及其原始绝对准入期限。
尚未持久识别 Turn 的模型请求，仅可在该 Thread 已登记的唯一 pending 操作期限内等待；
等待绑定最初的 pending 操作，不因后续操作、通知或响应延长，也不赋予 Turn 关联或转发权限。
没有匹配 pending 操作、存在歧义，或该操作取消、失败、关闭、到期时，等待请求拒绝；
识别或确认其他 Turn 时，不匹配的等待请求同样拒绝。
启动通知仅在完成日志验证与持久识别后，才能把原生 Thread/Turn 关联到同 Thread 唯一的
pending 启动；识别只允许模型请求等待，不能转发。只有匹配 RPC 响应返回同一 running Turn，
且 operation/journal 持久化成功后才准入。沿用既有启动 RPC 预算，从 RPC 发起建立一次覆盖至
持久化完成的绝对准入期限，不因通知或响应重置。错 ID、歧义、终态、RPC 或持久化失败、取消、
关闭或期限到期均拒绝等待请求，并阻断该 Turn 的迟到准入；过期操作按现有 unavailable 或
acceptance-uncertain 路径收敛，不能在期限后恢复普通准入。其他 Thread 不受影响。
私有操作记录用 `admissionPending` 表示尚未完成准入持久确认；清除此标记时必须同时写入
`admissionRecoveryPending`，并等待该写入成功返回后，才能在原绝对期限内提交 transport 准入、
放行等待请求。任一标记存在时均禁止操作重放或恢复转发；确认失败、迟到确认或确认后崩溃
不能因此恢复准入。transport 成功准入后才持久清除恢复标记；该后写仅确认恢复资格，不是
首次转发的前置条件。后写失败时可能已有上游副作用，必须取消并排空，重新持久标记
恢复不确定性；若补写也失败，不得宣称恢复禁令已持久化。不自动创建或重试新 Turn。

模型传输入口保存待准入、运行中的正向授权，以及本次入口生命周期内显式撤销的 native Turn 标记。准入能力绑定提交 operation、精确 native Turn 与持久执行选择对应的 internalModel/reasoningLevel；Driver 在产生原生副作用前将模型与 reasoning 绑定写入私有持久操作记录；缺少模型或 reasoning 绑定的历史 running 记录保持不可用，不猜测模型或档位，历史终态仍可读取。请求只能使用该模型路由；transport 将上游请求的 reasoning.effort 固定为该操作已持久化的获准档位，保留合法 reasoning 其他字段，不采用原生请求的陈旧档位。显式取消或完成后，同一 native Turn 的新旧能力均不能恢复授权，撤销标记不经 TTL/LRU 驱逐；新入口使用新 Token。放弃或过期待准入能力只使该能力失效，不单独形成 Turn 撤销标记。恢复转发走独立路径，先确认持久准入已完成、配置版本匹配，且回读的原生状态与持久执行状态均为 running，再以持久选择绑定相同模型与档位；保持原始准入期限和取消排空要求。

每个提交操作在持久 prepare 阶段绑定非敏感模型配置版本，先于原生副作用；恢复 running 或准入不确定执行时，在首次 native RPC 和转发授权前验证该版本与当前配置一致。历史绑定缺失或版本不匹配只拒绝对应执行的恢复，不阻止 Host 启动，不回填未知来源。已持久终态和事件无需原生恢复时仍可读取；同一 Session 无旧 active 或不确定执行后，新授权 Turn 可使用当前配置。配置版本随端点、凭证值或引用轮换、模型选项集合、模型、推理等级或默认选择变化而更新；持久状态不保存端点、凭证或其摘要。

RuntimeHost wire contract、Execution 模型选择、Platform/Connection 权威边界和 #403 的原生
持久数据保持；多用户隔离仍由独立验收证明。正式镜像验收必须包含成功 Turn，以及 HTTP 与
流内失败、取消、异常流的合成负向场景，递归检查原生持久历史、日志与 HTTP/SSE 的脱敏结果。
取舍见 [ADR: Codex 模型错误在原生持久化前脱敏](../adr/0007-sanitize-codex-model-errors-before-native-storage.md)。

## 11. Agent Runtime 边界

### 11.1 Platform Conversation Contract

Web、任务 API、Eval 执行和平台托管渠道只面对统一 Platform Conversation Contract。该 Contract 定义创建或恢复 Runtime Session、为新消息或重新生成提交一个带 Execution 已固化有效模型选择的 Turn、停止 Turn、查询状态、接收规范化事件和读取 capability，不暴露 ACP、Pi RPC、stdio 或其他 Runtime 原生消息。

四个标准模板实现完整 Contract。使用平台交互入口的自定义 Agent 通过 Generic ACP Adapter 实现 Contract；使用自有交互入口的自定义 Agent 不进入该 Contract；管理 API 可用不能被解释为任务 API、观测或 Eval 可用。自定义 Agent 的这些能力以接入验证结果为准。

### 11.2 Adapter 部署与 Registry 边界

`platform-worker` 只运行 RuntimeHost Client Adapter，并通过 Agent Service 的内部 HTTP/SSE Interface 调用 Pod；RuntimeHost 和 Native/ACP Driver 在 Agent Pod 内运行。M1 使用固定 Registry，不动态发现或加载 Driver；标准模板绑定、自定义交互模式和 capability 派生规则只在 [Agent Runtime M1 HLD](HLD-agent-runtime-M1.md#3-runtime-registry-与交互模式) 中完整维护。RuntimeHost 的依赖方向和未来抽取维护标准见 [RuntimeHost 未来抽取与维护标准](HLD-agent-runtime-M1.md#12-runtimehost-未来抽取与维护标准)，工程 Spec 不重复定义。

Codex Linux 部署必须启用并完整支持 Landlock ABI V5 的文件系统权限，且允许运行用户在非 root、只读根文件系统、移除全部 capabilities 和 `no-new-privileges` 的约束下安装并应用规则集。原生执行前必须通过实际规则集安装完成能力准入；不能根据 `uname` 或内核版本推断支持，也不能接受部分权限降级。内部后端、可信部署工具与启动顺序见 [Codex Linux sandbox 启动准入](HLD-agent-runtime-M1.md#101-codex-linux-sandbox-启动准入)。

### 11.3 数据与生命周期边界

Platform DB 是 Conversation、Message、Execution 和规范化事件的权威来源，只保存 worker 侧 Client Adapter 使用的不透明 RuntimeHost Session Ref。RuntimeHost 在 Agent PVC 上保存该引用与 `agentId`、`conversationId`、`sessionGeneration` 及 Native Session ID 的绑定；Native Session ID 和原生事件细节不能跨出 RuntimeHost。Host Session Ref 和 Native Session ID 都不能成为浏览器、API、渠道或 Agent 请求中的身份与授权依据。API 与 Eval 复用这套权威关系，不新增 Session 或调度服务。

Session/Turn/Event 映射、并发、幂等、SSE 补发和 Pod 重启恢复的完整契约见 [Agent Runtime M1 HLD](HLD-agent-runtime-M1.md)，本文不重复定义协议字段。

## 12. 对话与长任务

### 12.1 数据流

```mermaid
sequenceDiagram
    participant U as User
    participant W as Web
    participant P as Platform API
    participant D as Platform DB
    participant A as Platform Worker / Adapter
    participant R as Agent Pod

    U->>W: 发送无活跃 Turn 的新消息
    W->>P: POST message + Idempotency-Key
    P->>D: 事务保存 Message、初始 Execution 与 Turn outbox
    P-->>W: 已提交
    A->>D: 认领 outbox 与 Execution
    A->>R: HTTP 提交 Turn
    R-->>A: SSE 原生事件
    A->>D: 保存规范化事件
    P->>D: 读取已保存事件
    P-->>W: SSE 事件
    U->>W: 离开页面
    R-->>A: 继续处理
    A->>D: 保存最终结果
    U->>W: 返回会话
    W->>P: Last-Event-ID
    P-->>W: 补发事件与最终结果
```

上图描述没有活跃 Turn 的普通消息路径。补充指令、重新生成、停止命令和繁忙拒绝按 12.2 的独立事务分支处理。

### 12.2 可靠性规则

- `platform-api` 在 Conversation 数据库锁内完成命令准入，并把平台业务记录与 outbox 原子写入 Platform DB；`platform-worker` 只认领已提交的 outbox，再通过 RuntimeHost Client 调用 Agent Pod 内的固定 Driver。
- 消息持久化成功后才向用户显示“已提交”。后续投递失败不能删除消息或静默丢弃，必须收敛为可解释状态。
- 同一 Conversation 同时只有一个活跃 Turn。普通消息、补充指令、重新生成和停止的重试不能产生重复 Execution、越过发送者边界，或改绑到后续 Execution。
- `platform-worker` 在实际投递前重新解析当前授权；Runtime 是否接受命令不确定时按持久化状态恢复查询，不能盲目重放可能产生副作用的请求。
- 用户可见结果以 [Agent Platform PRD 11.2](../prd/PRD-agent-platform-M1.md#112-对话能力) 为准；幂等键、事务分支、outbox 状态迁移、Runtime 接受竞态和失败收敛的完整工程契约见 [Agent Runtime M1 HLD](HLD-agent-runtime-M1.md#8-消息事件与-sse-可靠性)。
- 停止是尽力而为；已经提交给外部 Provider 的操作不自动撤回。
- Connection 的外部调用幂等、未知结果与恢复由 Connection 负责；平台不能通过重投整个任务来绕过原调用对账。

### 12.3 事件保存

平台保存用户可见消息、最终回答、状态变化、模型/工具调用事实和已验证的 Connection 关联引用。Runtime 原生事件由 RuntimeHost/Driver 归一化，再由 `platform-worker` 按 fence 去重并保存；保存成功后才由 `platform-api` 推送给浏览器。有限补发规则见 [Agent Runtime M1 HLD](HLD-agent-runtime-M1.md)。模型内部思考原文、Provider 原始凭证和未脱敏请求不能进入事件表。

### 12.4 API 受理、调度与恢复

API task 直接映射一个 Platform Execution，不另设与 Execution 竞争的任务状态权威。默认在当前主体与 Agent 下创建新 Conversation；显式续接只接受同主体、同 Agent 且可恢复的 Conversation。任务输入/结果属于受控业务存储，查询和 SSE 从持久状态读取。

- **受理事务：** Core 在 Agent 容量与 Conversation 锁定的用例级事务内检查当前资格和等待容量，保存幂等绑定、输入引用、Execution、受理顺序、等待期限、outbox 与必要审计。重复请求先查原绑定，不重复消耗容量；容量满或停止/停用/故障未恢复时拒绝且不创建新任务。启动/更新中允许有界等待，任务提交不隐式启动 Agent。
- **投递：** Worker 认领持久工作项；Dispatch 只允许同 Conversation 最早的可执行任务占用 Turn，并在 Agent 经验证的并发能力内调度不同 Conversation。认领租约、修订/fence 与事务条件防止双 Worker 重复投递。等待期限由平台配置，在重启后沿用；到期任务明确失败。RuntimeHost 管理原生 Turn，不再维护另一套用户排队状态。
- **入口差异：** 等待中的 Execution 还没有活跃 Runtime Turn。API 后续任务排队不改变 Web 的补充指令/繁忙语义；Web 与 API 均通过同一 Conversation 串行准入，后续新 Turn 不能越过已受理任务或改写其他主体上下文；对当前活跃 Turn 的合法补充指令仍按 Web 规则处理。
- **取消：** 未投递任务在与认领互斥的事务中终结，Worker 不能继续启动；投递或接受结果不确定时，先核实原操作。运行中持久保存取消请求与停止工作项，确认停止后才标记已取消。未确认或待核实状态占住该 Conversation，下一任务不能启动。
- **恢复：** API/Worker 重启重新认领未开始工作，沿原执行查询 Runtime 接受状态与 Session。已运行任务能恢复则沿原身份继续，确认不可恢复则明确失败；无法确认时标记待核实并阻止受影响 Conversation，不能新建 Session 或重放可能有副作用的任务。结果与审计恢复均按原操作引用去重。

RuntimeHost 命令、租约/fence、原生 Session 和事件字段继续由 [Runtime HLD](HLD-agent-runtime-M1.md) 细化；API 的持久等待属于 Platform Dispatch，不把排队义务下推到 Driver。

## 13. Connection 架构

### 13.1 独立直连与权威边界

按 [平台 Connection PRD](../prd/PRD-agent-platform-M1.md#9-connection-集成)，Agent 或客户端直接调用独立 Connection MCP/API。Connection 负责自己的用户/应用身份、客户端访问凭据、Grant、外部账号、Provider/Action、原始凭证、外部调用和审计。Platform 不代理调用、不签发 Connection 代调用证明、不维护其目录、授权或状态/审计投影；应用在 Connection 独立获权，不继承自然人责任人的权限。

Platform 仅记录自己的任务、模型和工具执行事实。Connection 访问凭据与 Platform API 凭证分别管理；外部账号原始凭证只由 Connection 的受控执行路径使用，不能进入 Agent、模型、浏览器或 Platform DB。平台 Runtime Execution Grant 不参与 Connection 的授权判定。

### 13.2 调用与审计关联

```mermaid
sequenceDiagram
    participant A as Agent / Client
    participant P as Platform execution records
    participant C as Connection MCP / API
    participant D as Connection DB
    participant X as External Provider

    A->>C: 独立客户端凭据 + 调用请求
    C->>C: 校验当前直连身份与授权
    C->>D: 可靠记录原调用和外部操作意图
    C->>X: 使用受控外部凭证执行
    X-->>C: 实际结果或未确认
    C->>D: 保存结果或原调用对账状态及审计
    C-->>A: 受控结果与真实调用关联信息
    A-->>P: 可信运行采集记录自身工具事实与关联引用
    Note over P,D: 两侧分别鉴权查询，不复制 Connection 状态或审计
```

关联至少能从平台实际执行定位实际工具调用，再核对 Connection 产生的原调用引用及两侧记录。平台关联写入须来源于绑定 Execution 的受信运行采集，Connection 侧须有真实调用记录支撑；普通调用方自行提交相同 `traceId`、字符串或 URL 不构成已验证绑定。独立客户端缺少可信平台执行来源时只保留可核实的 Connection 记录，不能伪造平台执行关联。

关联信息不是授权。调用方与两侧管理员分别在各自受控 API/页面查询；无权访问时不返回对方对象、状态或存在性。平台工具成功只表示自身已确认的执行事实，不能替代 Connection 对外部效果的结论。响应丢失、关联缺失或无法核实时如实标记，沿原调用补充核实，不把猜测写为成功。

### 13.3 外部执行与恢复

Connection 在实际外部操作开始前持久保存意图，并在执行前重验自己的当前身份、Grant 与凭证状态；拒绝不能因审计故障变为放行。业务幂等键绑定原调用主体、操作及请求，同键同请求复用原操作，冲突拒绝。可能已经提交且无可证明幂等保障的写操作只沿原调用对账，不自动重发。

取消或撤权不抹去既有外部效果。Connection 的执行尝试、结果不确定、后续对账、人工处理和凭证撤销均保留自身审计；平台不接管其状态机或建立分布式事务。

### 13.4 实现与详细设计归属

Connection 只复用固定且经 allowlist 审核的 OpenConnector Provider/OAuth/executor Kernel，保留来源、许可证、notice 和 digest；上游 Runtime Server、Credential Store 和 Web Console 不进入正式拓扑。首个受监督 GitHub Pilot 的范围以 PRD 为准，不把局部 Pilot 推广为完整 M1。

Connection 的 LDAP、OAuth 客户端、MCP/API、Grant、凭证保护、Provider Action、幂等/对账及 Pilot 验证矩阵由 [Connection M1 HLD](HLD-connection-M1.md) 细化。跨文档整合按第 25 节完成，不能以旧的代调用协议覆盖本节独立直连边界。

## 14. 使用渠道

### 14.1 Web

平台对话页统一经过 `platform-api`，使用公司登录态、Agent 可用范围和平台 Conversation。自定义 Agent 的自有交互入口不进入 Platform Conversation Contract，历史不互相合并。

### 14.2 企微

企微 Adapter 位于平台侧：

平台只为四个标准模板和通过 Generic ACP 验证的 `platform-adapter` 自定义 Agent 创建企微绑定；`self-managed` Agent 的绑定请求在保存前拒绝。

1. 验证企微回调签名并解析绑定的 Agent。
2. 把企微发送者映射为公司稳定用户 ID。
3. 校验 Agent 可用范围和渠道绑定。
4. 按单聊、群聊和线程规则生成稳定的 Platform Conversation 映射；群聊和线程的映射键必须包含服务端解析的发送者 ID。
5. 持久化消息和 outbox，由 `platform-worker` 通过 RuntimeHost Client 交给 Agent Pod 内的固定 Driver。
6. 需要外部操作时由 Agent/客户端直连 Connection；Connection 独立验证触发消息发送者已经授予的调用权限，不能使用其他群成员的授权。

群聊、线程和附件映射由 Channel 层负责；同一群或线程中的不同发送者必须映射到不同 Platform Conversation 和 RuntimeHost Session。RuntimeHost/Driver 不感知企微身份或自行改变会话键。四个标准模板和通过 ACP 验证的自定义 Agent 使用同一渠道链路。Web 与企微会话不合并。

### 14.3 自有交互入口

- 自有交互入口的流量、协议、Session 和历史由自定义 Agent 负责，不经过 Runtime Adapter。
- `platform-worker` 根据 Platform DB 中保存的 Owner 身份责任选择只发布对应的一条用户访问路由；Agent Service 与 Pod 地址始终只在集群内部使用，Agent ServiceAccount 和 Owner 无权创建或修改 Service、Ingress 或 NetworkPolicy。
- 选择自有身份入口时，平台发布 TLS 路由但不经过 Auth Gateway，也不注入可信 IdentityContext、Execution Grant 或平台撤权上下文；自定义 Agent 必须在服务端实施身份和权限，不能信任浏览器自行提交的用户 ID Header。账号生命周期、停用、撤权和会话终止由 Owner 的身份体系负责；需要部署身份状态或 Agent 可用范围变化立即生效时必须选择平台身份入口。
- 选择平台身份入口时，路由必须经过 Auth Gateway。Gateway 每次请求校验公司账号和 Agent 可用范围，移除或覆盖调用方提交的身份 Header，并传递绑定公司用户、受众、Agent 与有效期的短期签名上下文；自定义 Agent 服务端必须校验签名、签发者、受众、有效期和 Agent 绑定，不能信任浏览器字段。权限撤销后新请求立即失败，长连接按短期凭证到期或服务端主动关闭。

## 15. 数据与一致性

### 15.1 Platform DB 主要实体

- Agent 申请、Agent、创建主体、Owner、可用范围、独立应用/责任人和显式管理/使用授权。
- API 凭证的校验材料、范围、有效期和撤销状态，不保存可回读原值。
- 模板版本、自定义镜像 Digest、Runtime Manifest、env、版本化 Secret 密文状态和资源 Profile。
- 模型 endpoint、加密 credential reference、模型选项、渠道绑定和已验证的集成能力。
- 会话、消息、回答版本、执行和执行事件。
- worker 侧不透明 RuntimeHost Session Ref、`sessionGeneration` 和恢复状态。
- 附件与结果文件元数据。
- 平台实际模型/工具事实与经核实的 Connection 关联引用，不保存 Connection 目录、账号、Grant、状态或审计投影。
- Eval 用途授权、版本化数据集/标准、实验及逐例 Execution 引用、实际版本、评分/人工复核、主动反馈；正文和评分理由作为受控业务数据保存。
- Agent 期望状态、已应用修订和平台审计。
- Outbox 和可重试工作项。

### 15.2 Connection DB 主要实体

Connection DB 保存自己的用户/应用及客户端身份、授权、Provider/Action、个人/公司 Connection、外部账号与凭证、OAuth 状态、外部调用/效果、恢复记录和审计。具体实体与事务由 Connection HLD 定义，不保存 Platform policy revision/fence。

### 15.3 跨系统一致性

- 两个系统不使用分布式事务、不跨库读写或同步目录/审计投影。
- Platform 的主体/Agent 撤权在平台受控路径生效；Connection 的身份/Grant/凭证撤权在 Connection 的执行入口生效，权限不互相继承。
- 跨系统核对只使用第 13.2 节的真实调用关联，不能从另一侧的成功或可用状态推断本侧授权。
- 已开始的外部操作保留实际结果；缺失或未知沿原调用核实，不伪造回滚。

### 15.4 文件

- 数据库只保存对象引用、所有者、会话、类型、大小、Hash 和生命周期状态。
- 上传和下载 URL 短期有效并绑定当前主体与获授权对象；Eval 文件另外检查评测用途授权。
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
| 单个 Runtime Session 恢复失败 | 对应 Conversation 显示“会话不可用”，历史只读且禁止继续发送；其他 Conversation 不受影响 |
| API 等待容量已满 | 受理前拒绝，可稍后重试，不返回新任务标识 |
| 已受理任务等待到期 | 原执行明确失败，保留失败原因 |
| 取消已请求但停止未确认 | 取消处理中，同 Conversation 后续任务继续等待 |
| Runtime 接受或外部结果不确定 | 待核实，不能显示已取消或成功；相关 Conversation 禁止继续执行 |
| Agent 明确拒绝新任务 | 繁忙，可重试 |
| Provider 限流或短暂故障 | 明确提示稍后重试 |
| Connection 失效 | 说明原因并提供重连入口 |

### 16.2 幂等

- Agent API 创建、任务提交与 Web 申请、审批、生命周期及配置命令接受幂等键。绑定为可信主体 + 操作 + 键 + 规范化请求摘要；同请求返回原对象，不同请求拒绝。每次访问仍先校验当前权限，不能借重试读取越权对象。
- 请求尝试有各自 requestId；业务操作、outbox、Runtime 命令和审计引用稳定，不把网络重试计作新任务或新外部效果。
- Worker 通过业务 ID 与修订号判断是否已经执行。
- Runtime 投递和事件去重按 [Agent Runtime M1 HLD](HLD-agent-runtime-M1.md) 的稳定标识执行。
- OAuth callback 的 state 只能消费一次。
- Connection WRITE Action 必须使用稳定业务幂等键；Provider 未提供可证明的幂等机制时，可能已提交的操作只进入对账，不能自动重试。

### 16.3 进程重启

`platform-api`、`platform-worker` 或 `connection-api` 重启后，未完成工作从 PostgreSQL 状态继续。内存队列、SSE 连接和本地文件都不是权威状态。

## 17. 安全基线

- 所有用户访问路由使用 TLS；平台身份入口使用可信 IdentityContext 和 Agent 可用范围校验。
- 平台、Connection 和 Agent 使用不同运行身份与数据库账号。
- Agent Pod 不能访问 Platform DB、Connection DB、部署解密私钥或 Kubernetes API。
- Agent/客户端使用 Connection 自己的访问凭据直连其 MCP/API；Platform 不充当代理或授权签发方，原始外部凭证始终留在 Connection。
- 标准模板只使用 ModelCatalogAdapter 返回的获准模型端点；自定义 `platform-adapter` 的 Owner 模型端点和 `self-managed` 的其他出站访问遵循部署网络策略，M1 不新增按 Agent 维护的 egress allowlist。
- 自定义镜像必须通过 ImageRegistryAdapter 准入，并使用不可变 Digest。
- 容器以非 root 用户运行，根文件系统默认只读；需要写入的数据挂载到明确卷。
- 模型 API Key、Owner Secret 和企微凭证加密保存、不回显，只能替换。
- 审计和日志不记录聊天正文、模型思考原文和原始凭证。
- 所有跨主体（用户或应用）资源访问测试按“资源不存在”返回，避免枚举。
- 任务、会话、附件、执行详情和自身审计查询始终匹配提交主体；Owner/应用责任人不因此获得他人内容或使用记录。Eval 按独立用途和对象授权，不能成为会话访问旁路。

网络、IdentityAdapter、OCI Registry、模型目录、加密公钥/解密 keyring 注入和对象存储的具体产品或配置由部署环境决定，但上述访问结果是 M1 的硬性要求。

## 18. 运行观测、持久审计与 Eval

### 18.1 真实执行事实与关联

`packages/observability` 提供 OpenTelemetry、Pino、受限错误和关联上下文的公共实现；不承载领域授权、审计权威存储或 Eval 正文。Platform API 产生请求与受理事实，Dispatch/Worker 产生等待与投递事实，RuntimeHost/Driver 从实际模型和工具边界采集开始、终态、耗时及可获得的用量，Worker 校验、去重并保存规范化事实。结果保存与 SSE 投递分别观测。

一次任务用 `requestId`、`traceId`、`agentId`、`conversationId`、`executionId`、实际操作/尝试引用及适用的 Runtime fence/cursor 串起 API → 等待/投递 → Worker → Runtime → 模型/工具 → 结果。持久工作项保留关联上下文，异步 Trace 可用 span link 关联原请求；外部调用按第 13.2 节独立核对，不能采信任意传入 Trace 字段作为身份。

四个标准模板必须验证实际模型/工具调用采集，不能以整体 Turn 耗时代替模型耗时。自定义 Agent 只报告已验证能力；缺失、无法确认、不支持与失败是不同结果，不能填成成功、零耗时或零 Token。重连、重放与恢复按稳定事实标识去重，合法的新尝试独立记录。

调用方的执行详情从平台业务事件读取，按 PRD 展示受理、等待、执行、模型/工具和结果阶段；技术组件、主机与依赖定位属于运维后端。详情与结果内容使用原任务权限。日志、指标和 Trace 仅含必要元数据及脱敏错误，不含任务/Eval 正文、附件、思考、调用证明或凭证。

### 18.2 运行指标与故障

部署提供日志、指标、Trace 的采集/查询后端及告警出口；M1 不绑定具体观测厂商。覆盖：

- HTTP 请求量、授权拒绝、错误率与延迟，SSE 在线/重连/事件积压。
- 任务受理、等待时长/数量、投递、执行、取消、失败、待核实与完成；实际模型/工具耗时和错误。
- Agent 启动、更新、可用性、调谐与恢复失败。
- PostgreSQL 连接池/查询延迟、outbox 积压、对象存储和 Runtime 依赖故障。
- 两侧各自的审计写入/查询故障；Connection 在自己的后端观测外部调用、Provider 限流与凭证刷新。

服务不可用、持续积压和异常错误必须有告警与可复现验证，阈值随部署容量配置。高基数 request/execution/用户 ID 放入受控日志和 Trace，不作为指标 label。采集/导出失败有独立健康信号，不能修改任务业务结果；持久审计失败按 18.3 处理，不能套用遥测尽力而为的规则。

### 18.3 持久审计

Core 定义 [平台审计 PRD](../prd/PRD-agent-platform-M1.md#13-平台操作审计) 的事件和查询权限，Store 以用例级事务原子保存业务变更、outbox 与必要审计。API/Worker 只调用这些用例，不能另写无事务保障的成功日志充当审计。审计不随 Trace 采样丢失，不另建审计微服务。

每条记录保存可信主体类型/引用、原始发起人、实际后台执行组件、时间、动作、受控对象、授权与操作结果及请求/执行/操作关联；身份或对象无法确认时明确未知，只记录受限原因，不回显任意自报字段。覆盖治理、应用/凭证/授权、配置/生命周期、API 访问及拒绝、任务全过程、实际模型/工具操作和 Eval 管理/评分/复核。订阅按建立与结束记录；审计查询记录主体、受控筛选范围与结果，不把审计写入递归当作新查询。

API/Worker 的外部操作在调用前保存意图；RuntimeHost/Driver 的实际模型/工具操作须在执行侧可靠记录原操作意图及结果，再按稳定引用投递平台必要审计。只有已持久确认的意图才允许开始操作，记录失败时阻止尚未发生的操作并报告故障。响应或结果保存失败只能记录未确认并沿原操作核实，不能重发有副作用的请求制造结果；Connection 的外部意图/效果始终由 Connection 自己记录。

请求尝试与业务幂等操作、受理与完成、取消请求与停止确认、工具结果与外部效果分别表达。必要审计无法可靠保存时不返回虚假成功；已经发生的效果不能抹去，授权拒绝不能变成放行。审计 API/页面按时间、主体、Agent、动作、结果和执行引用筛选、分页并查看详情；查询故障明确报错，不返回伪空列表。

系统管理员仅按职责读取平台元数据，用户/应用只能查询自己的执行审计；Owner/责任人没有他人使用记录权限，Connection 管理权限不互相继承。审计不存正文、附件、思考、证明或凭证值；保留与受控清理服从部署数据政策，清理不伪造历史业务结果，访问和清理均受权限控制。

### 18.4 Eval 数据与执行

Evaluation 是 `platform-core` 内部模块，API 提供管理与查询，Store 保存权威业务数据，Worker 消费持久工作项。Web 提供数据集/实验/逐例对比/人工复核入口，对话或任务详情提供主动反馈；不新增 Eval 服务、通用评测框架或固定厂商依赖。产品闭环和评分维度以 [Eval PRD](../prd/PRD-agent-platform-M1.md#15-模型质量评估与效果分析) 为准。

- **版本与数据：** 数据集保存获授权样本的输入、必要上下文、任务类型及预期结果/判定标准；修改生成新版本。实验固定数据集/标准版本、基线/候选及评分器版本，每例引用实际 Execution、实际模型、模板/镜像、非敏感配置版本和工具环境。请求的版本与实际执行版本不能混同；条件变化或随机性影响须可见，不可比样本不能冒充同条件排名。
- **任务复用：** 每例通过现有 Dispatch/Conversation/Execution 执行，拥有独立任务引用，默认隔离样本上下文；使用原发起主体的当前 Agent 使用权和独立数据权限，不能借 Worker 身份、Owner 或责任人身份访问其他任务。取消、查询与恢复复用任务用例，Connection 调用仍需独立授权。四模板必须验证；模板版本对比由平台受控测试配置执行，不赋予 Owner 锁定生产旧模板的能力。
- **评分与复核：** Worker 执行版本化确定性规则或获授权模型评分工作项，人工评分/复核经同一 Core 保存独立结论；评分理由、来源、评分模型与 rubric 版本可追溯。模型评分复用获准模型目录与受控请求能力，不扩展 Runtime 传输协议或另建模型路由。任务业务失败、评分器故障、缺失和不适用独立保存，评分重试只重跑评分，不重放业务任务。
- **分析与反馈：** 汇总和逐例对比使用相同样本/标准，展示分母、已评分数、缺失/错误及可比覆盖；耗时和 Token 取实际采集值。历史结论保留，新样本/标准以新版本重跑。反馈仅由提交主体对自己的任务主动提交有用/无用和问题分类，绑定实际模型/配置/时间；单独统计数量、反馈率和分布，未反馈不作成功，反馈不混入离线通过率。
- **内容与授权：** 样本、输出、评分理由与实验明细走独立 Eval 用途授权和受控存储，不进入遥测/审计。线上正文禁止自动导入，实际材料须获明确 Eval 用途授权并脱敏；原任务访问权不替代该授权。获授权 Owner 可访问允许的评测数据与反馈汇总，不能因此读取其他主体原会话。评分端点与数据用途需获准，工具使用受控测试账号/环境/响应，不自动重放线上写操作。
- **生命周期：** API、Worker 执行/评分和内容读取都校验当前数据授权；保留、撤权和删除按部署政策执行，历史可回看不绕过当前授权。删除正文后仅保留政策允许的版本和结果元数据，不能继续展示被撤权或删除的样本。

## 19. 测试策略

### 19.1 模块测试

- `platform-core` 使用 Fake Port 验证状态机、权限交集、授权扩展、用例级事务和幂等，不依赖 Hono、Drizzle 或 Kubernetes。
- React 使用 Vitest 与 Testing Library 验证关键交互和错误状态。
- 不以大量 Hono 路由快照代替领域测试。

### 19.2 契约测试

- Contract 测试执行 [Contract Schema authority](#64-contract-schema-authority) 定义的单向生成、漂移、merge-base breaking-change、consumer contract 和发布边界；数据库/领域类型不能绕过映射直接成为 wire contract。
- IdentityAdapter、ImageRegistryAdapter、ModelCatalogAdapter、部署加密公钥/Worker-only 解密 keyring 和 KubernetesRuntimeAdapter 运行同一 Interface 的 Fake 与部署实现 conformance；缺失、非法或不可用结果都验证 fail closed。
- IdentityAdapter 负向测试覆盖签发方、audience、签发/过期时间、context ID、keyVersion、部署身份绑定和重放；调用方提交的身份字段、过期/重复信封或身份依赖不可用都不能形成授权。
- Platform Secret 负向测试覆盖 API 进程无解密私钥、非 CSPRNG/错误长度、重用 DEK/nonce、DEK fingerprint 冲突、失败重试复用加密材料、非 canonical AAD、跨 Agent/Secret ID 调换 ciphertext 或 wrapped DEK、错误 `wrappingAlgorithmVersion`/`wrappingKeyVersion`、AEAD 认证失败、原地更新被引用的 Kubernetes Secret、候选 Workload 引用错误版本化名称、Worker 在创建 Kubernetes Secret 前后或观测 Workload 前后崩溃，以及 Agent/Secret/config revision/Workload UID/generation/fence 任一 stale 值试图激活候选版本；任何路径都不能泄露明文、改变旧 Workload 的 active Secret、错误提升 active 或提前回收旧版本。
- Model Contract 负向测试覆盖目录外 Base URL、credential 被当作普通字段读取/返回、credential 跨 Agent 复用、模型或 reasoning 未获 Owner 允许，以及 Runtime capability 验证失败；浏览器与普通使用者响应中不得出现 API Key 或 Secret 明文。
- Agent Runtime Contract 和 Conformance Suite 实现 [Agent Runtime M1 HLD 验证矩阵](HLD-agent-runtime-M1.md#11-验证)，工程 Spec 不重复维护用例清单。
- Agent 配置契约验证标准模板拒绝 Registry 未声明的 env/Secret、Owner 输入不能覆盖平台模型配置、自定义镜像接受非保留前缀的任意 K/V。
- OpenConnector Adapter 运行固定来源、三项 GitHub Action、OAuth scope、repository allowlist、凭证隐藏和跨 scope 拒绝测试。
- 用户/应用 API 契约覆盖可信主体、凭证范围/失效、独立初始授权、跨主体及 Owner/责任人越权拒绝、SSE 撤权关闭；Runtime Grant 不能充当 Connection 凭据。
- 直连关联契约验证真实调用与原执行的绑定、伪造关联拒绝和两侧独立查询权限；不以相同调用方字符串证明关联。
- Connection 的直连身份、Grant、外部执行、幂等/未知结果、撤销和审计测试由其 HLD 验证矩阵维护；未知写操作不得自动重发。

### 19.3 集成测试

- PostgreSQL 与对象存储使用容器化真实依赖。
- Conversation、Execution、outbox、双 Worker 和 Pod 重启的集成与故障注入测试执行 [Agent Runtime M1 HLD 验证矩阵](HLD-agent-runtime-M1.md#11-验证)。
- Kubernetes `kind` 测试覆盖创建失败后无可路由入口、运行中 Workload 或遗留新 PVC，停止或停用后 StatefulSet 缩容到 0、重启后从 0 恢复且保留原 PVC 与 Platform DB 状态，候选 Service/健康检查变更，候选提升任一步骤的 Worker 重启和部分切换恢复，升级失败后恢复旧 Digest、路由、渠道和平台历史，切换期间不出现双路由或失败候选继续接收流量，原 PVC 复用，以及第 17 节的安全与网络边界。自有交互入口的两种身份责任选择分别只产生一条用户路由；切换并重新调谐后旧路由被删除，Agent Service、Pod 地址和未选入口均不可达。Pod 重启和 Session 恢复执行 [Agent Runtime M1 HLD 验证矩阵](HLD-agent-runtime-M1.md#11-验证)。
- API 受理事务、同会话串行、双 Worker/取消竞态、等待容量/到期、服务重启与未知结果验证持久状态不丢失；凭证失效任务继续与主体撤权系统取消分别注入故障验证。
- 审计事务失败、执行前意图保存失败、查询故障、Trace 采样/导出失败与事件重放分别验证，不能丢必要审计、伪造成功或重复计数。Eval 评分失败、版本变化、数据撤权/删除与用量缺失使用受控样本验证。
- Identity、OCI Registry、模型端点、对象存储和企微边界提供可控 Fake；Fake 使用与正式 Contract 相同的 Schema，不维护第二套接口。
- GitHub Adapter 使用专用测试账号和唯一受控 private 仓库完成 current-user、repository-read 和 create-PR；其他 Provider 不进入首个 Pilot。

### 19.4 端到端测试

Playwright 覆盖：

- 申请、撤回、审批、创建、停止、重启和停用。
- Owner、范围、组织变化和账号禁用；平台对话页、平台托管渠道和平台身份入口必须立即执行当前结果，确认撤权后平台中止仍可中止的活跃 Execution。
- 四个标准模板的平台 Web、API 真实任务、企微、模型切换、附件、独立 Connection 和长任务恢复；逐一验证实际模型/工具事件和完整 Trace，不以总任务耗时冒充模型耗时。
- 用户和应用分别 API 创建/启动/停止/重启、提交/查询/订阅/取消任务；无审批且初始授权和 Owner 归属正确，应用不继承责任人权限。审计 API 与基础管理页按条件查询，跨主体和两侧管理员越权拒绝。
- 同一获授权固定集含回答和受控工具样本，以两组模型或配置真实运行；查看汇总/失败样本、规则/人工/模型评分与独立复核，修订后再跑并保留历史。线上反馈独立汇总，评分失败/缺失不算通过，Eval 内容及真实材料用途授权有负向验证。
- 受控的自有身份样例验证匿名、伪造身份字段或在 Owner 身份体系中无权限的请求被 Agent 服务端拒绝，合法身份只能按该体系的权限使用；该入口不获得平台身份或撤权上下文。自有交互入口经平台 Auth Gateway 访问时不能绕过权限，调用方身份 Header 不能改变最终签名身份，缺失、签名无效或过期的上下文、错误签发者、错误受众和错误 Agent 绑定均被拒绝，且两类入口的历史都不进入平台。
- Generic ACP 自定义 Agent 的平台入口、capability、Runtime 模型选项读取与选择转发，以及创建拒绝路径；`self-managed` 的 capability 声明不能开放平台能力，Adapter 不从 Runtime 模型选项读取或保存凭证，平台只按 10.6 把 Owner env/Secret 作为不透明配置保存和注入，选项失效时不能静默改用其他模型。
- Connection 独立 Web 的 LDAP 登录、GitHub OAuth、Grant 再确认、三项 Action、调用记录、管理员未知结果处理、换账号和撤销。
- Alice/Bob 分别绑定专用 GitHub 账号；跨主体、客户端、Connection、Credential、OAuth transaction 和调用记录访问按资源不存在拒绝。
- 企微身份映射、群聊和线程按发送者隔离 Platform Conversation/Runtime Session、按发送者使用 Connection，以及其他发送者不能向活跃 Turn 追加补充指令。

### 19.5 负载与故障测试

M1 不承诺固定并发数，但发布前必须提供可重复的负载脚本，逐步增加：并发 Web/API 主体、同一 Agent 的多 Conversation/任务、SSE 连接、Eval 工作项和 Connection 调用。验收要求是消息有明确状态、不静默丢失、用户数据不串线，等待和投递有界、采集故障可见、持续积压有告警，并获得当前环境的容量基线。

## 20. 前后端职责

| 领域 | 前端交付 | 后端交付 |
| --- | --- | --- |
| 身份与权限 | 登录态、Owner/范围、个人凭证与应用管理 | IdentityAdapter、可信用户/应用上下文、凭证/当前授权交集 |
| Agent 生命周期 | Web 申请/审批、状态和操作入口 | API 直接创建与显式授权、状态机、Profile、outbox 和调谐 |
| Agent 使用 | 对话/任务详情、SSE、停止、重生成、模型选择 | API 闭环、会话/Execution、有界 Dispatch、RuntimeHost/Driver、恢复 |
| 附件 | 上传、预览、限制和下载 | 预签名地址、对象权限、元数据和 Agent 临时访问 |
| Connection | 独立中文登录、连接、Grant、扩权确认、调用记录和管理员待处理页面 | 独立用户/应用身份、OAuth、MCP/API、Credential、Grant、外部执行、恢复和审计 |
| 企微渠道 | Owner 绑定配置和状态 | 回调校验、身份映射、Channel 会话键和消息持久化 |
| 自有交互入口 | 入口、不可用与无权限状态 | Auth Gateway、Runtime Manifest、Service 和访问调谐 |
| 管理与审计 | 平台审计查询页；Connection 管理在独立入口 | 持久事务审计、受控查询 API、真实调用关联 |
| 运行观测 | 本主体执行阶段/失败详情；运维使用部署后端 | 实际模型/工具采集、日志/指标/Trace、去重与告警 |
| Eval | 数据集、实验、逐例对比、复核与反馈 | 版本/用途授权、复用任务、规则/人工/模型评分、可比汇总 |

前后端共同维护 `packages/contracts`，但后端是权限和数据结果的权威方。Web 从 OpenAPI 生成 Client，并使用同一 Schema 校验的 Mock/fixture 并行开发；后端通过 consumer contract 证明实现一致。

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

PR 和 `main` 的 `CI` 使用固定版本及 SHA-256 校验的 Trivy 0.74.0：

- 对根 `pnpm-lock.yaml` 启用 `--include-dev-deps`，扫描根 workspace、`apps/*` 和
  `packages/*` 的生产、开发/构建、可选及传递依赖；解析出的包清单必须覆盖 lockfile
  的全部精确包版本，workspace 清单必须与 lockfile importers 一致。
- 镜像清单为 `web`、`platform-api`、`platform-worker`、`connection-api`、
  `agent-runtime-host`。复用本次 CI 构建的最终运行镜像，以 Docker image ID（Docker
  存储后端的不可变 SHA-256）及 rootfs layers 绑定 OS 与应用扫描；不发布镜像。新增 Dockerfile
  必须同步覆盖清单。Connection 此项仅提供 HLD §14/§16 的镜像证据，不替代其 Pilot 门禁。
- 使用 Trivy 输出的 `Severity` 阻断所有 High/Critical，包括无修复版本；中低等级及
  Unknown 保留报告。severity 来源采用 Trivy 的 vendor 优先策略：OS 使用发行版
  advisory，应用包使用其生态数据源（npm 使用 GitHub Advisory Database）；报告保留
  `SeveritySource`、`VendorSeverity` 和 `DataSource`，不改用仅新增或仅有补丁策略。
  Trivy 未输出可选 `SeveritySource` 时，摘要注明 `Trivy auto (source unspecified)`，
  保留原始 vendor/advisory 数据，不自行重算或降低 severity。
  选择规则以[固定版本的 Trivy 文档](https://github.com/aquasecurity/trivy/blob/v0.74.0/docs/guide/scanner/vulnerability.md#severity-selection)为依据。
- 每次从漏洞库获取可用的当前快照，然后在本轮扫描中固定该快照。报告绑定源 commit、
  lockfile SHA-256、CI run/attempt、workspace/镜像清单、image ID/rootfs layers、Trivy
  版本、数据库 schema/更新时间/下次更新时间和数据库文件 SHA-256。工具/网络失败、
  数据库不可用或过期、报告缺失/无效、覆盖不全、来源不一致均失败。
- 原始 Trivy JSON、构建清单、扫描元数据、逐项可读摘要与最终判定作为同一 CI artifact
  保存 30 天，失败时也上传；CI 下载同一 run 的 artifact 后重新校验来源和判定。
  扫描只读取构建产物及外部漏洞数据，不扫描 Secret/用户数据、不使用仓库忽略文件。
- 必要例外经过现有 CODEOWNERS 人工 review 后，由仓库管理员登记到 Actions repository
  variable `VULNERABILITY_EXCEPTIONS`（JSON 数组，未配置等于空数组）。记录必须含
  `scope`（`lockfile` 或精确镜像名）、`vulnerability`、`package`、`version`、镜像
  `imageId`（lockfile 使用 `null`）、`reason`、UTC `expiresAt`、`approvalUrl`。
  审批 Review 正文必须单独包含 `vulnerability-exception sha256:<摘要>`；摘要为以上
  字段（不含 `approvalUrl`）按此顺序 JSON 编码的 SHA-256。CI 只读回查本仓库的
  未关闭或已合并 PR、当前 head 的最新有效 `APPROVED` Review 及审批人的实时
  maintain/admin 权限；后续 `CHANGES_REQUESTED` 或 `DISMISSED` 使旧批准失效。
  仓库配置登记与可回读 Review 缺一不可，不能由 PR 文件自填审批人。
  无效/到期记录、通配范围、版本/Digest 不匹配、审批撤销或回查失败不能豁免。
  普通基础设施 waiver 不参与漏洞判定，例外不改变其他人工门禁。

首次真实扫描命中阻断项时保留失败证据，由维护者批准精确例外或另开修复 Issue；不得自动
升级、修复或降低阈值。此检查是 readiness 的前置，不代表生产或完整人工安全审计完成。

### 21.2 发布

- 每个部署单元生成独立镜像并推送部署批准的 OCI Registry；`connection-web` 与 `connection-api` 分别构建，但通过同一批准 origin 路由。
- 镜像按 Commit SHA 和不可变 Digest 部署。
- Web 和 `platform-api` 可以由部署环境独立发布；Helm 管理 Kubernetes 中的平台部署单元，Agent Workload 只由 `platform-worker` 通过 KubernetesRuntimeAdapter 调谐。
- 数据库迁移使用独立 Job，先执行向后兼容迁移，再发布应用。
- 环境配置只保存非敏感值；部署向 `platform-api` 注入版本化加密公钥、向 `platform-worker` 注入 Worker-only 解密 keyring，Secret 明文和私钥不进入 values、镜像或仓库。

### 21.3 本地开发

- Docker Compose 提供 PostgreSQL、对象存储和部署边界 Fake。
- Web、API 和 Worker 由 Turborepo 启动。
- Kubernetes 调谐通过 `kind` 环境验证，不要求日常页面开发连接共享集群。

## 22. 实施顺序

本节只定义依赖顺序，不替代后续实施计划。

1. **工程底座：** monorepo、wire contracts、单一 `platform-core`、用例级 Store ports、部署边界 Fake、数据库迁移、可观测性和 CI。
2. **Agent 生命周期与 API 身份：** Web 申请审批、用户/应用与凭证、API 直接创建及显式授权、OCI Digest、Secret 修订、Worker 调谐和状态展示。
3. **Runtime 与任务闭环：** Conversation/Execution/outbox、API 有界等待/取消、Web 行为、SSE、RuntimeHost/固定 Driver、附件和恢复，逐个验证实际模型/工具采集与必要审计。
4. **Connection 独立直连：** 由 Connection 自身文档与实施计划交付身份、MCP/API、Grant、外部执行/恢复和审计，再验证平台实际执行与直连调用的独立授权关联；本文不重排其内部 DAG。
5. **渠道与自定义 Agent：** 企微 Channel、Runtime Manifest、自有交互入口 Auth Gateway。
6. **Eval 与查询入口：** 版本化数据集、实验/逐例任务、评分/复核/反馈、可比分析、审计查询 API 与页面、运行观测后端和告警。
7. **上线加固：** 真实任务/评测、故障注入、权限/隐私隔离、负载基线和运维手册；审计持久化随业务切片交付，不留到最后补日志。

## 23. 关键风险与处理

| 风险 | 处理方式 |
| --- | --- |
| TypeScript 缺少 `controller-runtime` 同等级框架 | Worker 与 API 分离，控制器保持单一职责，以 Platform DB 修订号和 Kubernetes 幂等 apply 为核心；使用受支持版本的 `kind` 做完整生命周期测试 |
| 部署产品渗入开源领域边界 | Identity、OCI Registry、模型目录、对象存储和 Kubernetes 路由通过窄 Adapter 接入，核心只保存稳定 ID、准入结果和业务状态 |
| Secret 外部服务成为强制依赖 | 项目使用随机 DEK、版本化 AEAD 和公钥封装；API 只能加密、Worker 独占解密私钥，候选修订通过可恢复两阶段协议激活 |
| OpenConnector 尚未原生满足公司多用户隔离 | 上游 Runtime 不直接暴露；只复用固定 allowlist Kernel，由 Connection Grant、repository policy 和跨用户攻击测试建立边界 |
| 长任务跨进程和断线后状态丢失 | 受理/等待/取消与原执行持久化，SSE 按游标恢复，未知结果不盲重放 |
| 模型/工具采集与审计被混为尽力日志 | 真实操作边界采集；必要审计先持久化，遥测导出故障独立报告 |
| Eval 分数掩盖缺失或数据越权 | 版本与可比覆盖可追溯，执行/评分失败分开，业务内容独立用途授权 |
| 自定义镜像的入口或能力声明不真实 | 使用最小 OCI Runtime Manifest；创建和升级时验证健康检查与 ACP capability；无有效交互入口则拒绝 |
| 原生 Runtime 的 Session 与事件语义不同 | 只维护四个固定 Adapter 和 Generic ACP；用统一 Conformance Suite 验证恢复、去重与并发，不建设动态协议矩阵 |
| 平台与 Connection 无分布式事务 | 使用稳定 ID、幂等键、状态机和审计关联；停用与撤销在权威系统即时拒绝 |
| 全 TypeScript 单仓库形成耦合 | 平台与 Connection 使用独立 core、store、数据库和部署单元；共享仅限契约与基础设施模块 |

## 24. 架构验收

工程架构完成 M1 的最低标准：

1. 两份 PRD 的上线验收场景均有对应模块、接口和自动化测试入口。
2. 浏览器、API 调用方、Agent 和模型不能伪造用户/应用、Connection 或组织身份完成越权，Owner/责任人不能读取或取消他人任务。
3. Agent 停止、重启、升级和平台进程重启后，配置、历史、附件引用和授权关系不丢失。
4. Web 断线或离开页面不影响已提交长任务，返回后可以按游标恢复状态。
5. Codex、Claude、OpenCode 和 Pi 通过统一 Runtime Conformance Suite；Generic ACP 自定义镜像无需新增 Adapter 即可使用平台入口。
6. Pod 重启恢复原 Runtime Session；恢复失败时只有原 Conversation 保持不可用，不静默创建新 Session，其他 Conversation 和 Agent 服务保持正常。
7. 自有交互入口只使用 `platform-worker` 发布的网络入口；自有身份入口由 Agent 服务端鉴权，平台身份入口不能绕过可信 IdentityContext 与 Agent 范围校验；其会话不进入平台历史。
8. 首个受监督 GitHub Pilot 使用两个测试 Principal、两个专用账号和一个受控 private 仓库完成 OAuth、Grant、三项 Action、真实 PR、幂等、审计和撤销；Connection 独立身份与 Grant 任一失败都拒绝调用，伪造关联不成立且两侧审计分别鉴权查询，结果只适用于具名环境和固定镜像。
9. 负载与故障测试中，所有消息都有可解释状态，企微群聊会话按发送者隔离，不出现静默丢失、重复 Turn 和跨用户数据混用。
10. Web、API、Worker、RuntimeHost 和 Delivery 只通过版本化 Contract 与窄 Port 汇合；架构测试阻止应用入口、Drizzle/Kubernetes 对象和部署产品类型进入 `platform-core` 或 wire contracts。
11. Web/API 位置无关，只有 Kubernetes Workload Plane 中的 Worker 持有 namespace-scoped Kubernetes authority；部署在现代 GA API 上通过生命周期、安全和失败恢复验证。
12. 用户/应用 API 无审批完成创建与初始授权、启动/停止/重启、任务受理/查询/订阅/取消；同会话串行、等待有界、幂等稳定，凭证失效与主体撤权各按产品规则生效。
13. 四模板有真实模型/工具观测与任务关联，采集缺失和故障如实呈现；运行后端覆盖服务/任务/依赖并验证告警，恢复不重复计数。
14. 审计 API 与基础管理页完整覆盖治理、执行和 Eval；必要审计与状态可靠保存，外部意图先记录，查询故障不显示空结果，记录不随 Trace 采样丢失。
15. 固定集基线/候选真实对比，支持规则/人工/模型评分、逐例分析、复核和新版本再跑；分母/覆盖/评分故障及独立反馈可见，Eval 用途授权与数据生命周期有正负向验证。

## 25. 评审结论记录

团队评审应围绕以下已选方案提出异议或确认，不在同一轮扩展 Roadmap 范围：

- 全 TypeScript 是否满足平台与运维团队的长期维护能力。
- TypeScript Kubernetes 调谐器的测试与值班责任是否可接受，部署是否提供受支持的现代 Kubernetes capability baseline。
- OpenConnector 固定 allowlist Kernel 的维护归属、来源验证和必要时建立最小 Fork 的批准方式。
- 部署的 IdentityAdapter、ImageRegistryAdapter、ModelCatalogAdapter、对象存储、加密公钥/Worker-only 解密 keyring 注入和企微 Adapter 是否满足本文 conformance。

产品行为或 M1 范围变化先更新 PRD。任何改变部署单元、权威数据归属、身份传递、Secret 模型、Kubernetes Workload Plane、Connection 授权、RuntimeHost 或 Agent Runtime Contract 的修改先更新工程 Spec；同时满足难以逆转、存在真实权衡、未来读者会疑惑时新增 ADR。OpenAPI/SSE breaking change 必须版本化并通过兼容评审。数据库表、索引、UI 结构和 Adapter 内部算法通过普通 Issue/PR、migration 与测试演进，不默认创建 ADR。
