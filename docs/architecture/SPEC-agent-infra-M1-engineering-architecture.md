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

M1 的自有产品与控制代码采用全 TypeScript 单仓库，使用 Better-T-Stack 初始化基础工程。Better-T-Stack 只负责生成工程骨架，不作为运行时依赖，也不决定领域模块的接口。Codex 使用固定官方 release，由 Native Driver/Adapter 消费上游能力；第三方源码、私有接缝与执行屏障的边界见 [10.11](#1011-codex-上游原生补丁与执行屏障)。

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
    QW[企微] -->|自建应用 / 显式机器人回调| PA[Platform API]
    CLI[用户或应用客户端] --> PA
    CLI -->|独立身份 / MCP + API| CA
    W --> PA
    CW --> CA[Connection API]

    PA --> PD[(Platform DB)]
    PA --> OS[(Object Storage)]
    PA --> IDP[IdentityAdapter]
    PW[Platform Worker] --> PD
    PW <-->|智能机器人长连接| QW

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
| `platform-api` | 可信用户/应用接入、Agent 与任务 API、权限、业务状态/outbox/审计事务、SSE、企微配置与回调、Eval 管理和查询；部署位置无关 | 否 |
| `platform-worker` | Kubernetes Workload Plane 中的 Workload 调谐、模板升级、outbox 认领、有界任务投递、RuntimeHost Client、企微长连接与回复、Eval 执行/评分工作项 | 否 |
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
| Builder / Build Service | 受控 Repo 工作区、构建定义、镜像构建与推送、Digest 版本、构建审计和可部署性评估 | 用户业务授权、Connection 凭证、生产合并与发布决定 |
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
- RepositoryConnectionAdapter 与受控分支/工作区操作；Builder 只能通过现有 Connection 授权读取或修改 Repo。
- BuildServiceAdapter 与构建任务、目标架构、资源/网络/隔离策略、镜像推送和不可变 Digest；具体构建后端由部署提供，不在领域模块内固定。
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

Connection 使用独立 `connection-web` 和独立浏览器会话，包含登录、个人 Connection、Consumer/Actor Grant、调用记录、待人工处理、Provider/Action、共享 Connection 和 Connection 审计页面。Platform Web 只跳转到 Connection 返回的受控 URL，不能承载或复制 Connection 管理页面。

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
- 文件使用平台签发的短期、认证数据面入口上传/下载；业务接口只传文件引用和元数据。入口与执行期文件授权见 [文件](#154-文件)，S3 预签名 URL 不返回浏览器或 Runtime。

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

应用凭证管理与取得/使用凭证材料分别授权。责任人角色只授予元数据、范围、轮换和撤销等管理权限，不自动获得凭证值或应用任务权限；签发与轮换时由 Core 重验接收者当前的独立凭证使用授权，只向该接收者受控交付，不能回显给仅有管理权的请求者，也不能通过重设接收者或交付入口绕过授权。授权、接收者及实际交付结果记录必要审计，凭证值不入审计；不引入新的身份或凭证服务。获授权接收者调用时仍以应用为任务主体，当前 Agent 权限和凭证范围继续生效。

创建用例将 Agent、创建主体、Owner、初始管理/使用授权、outbox 和必要审计原子保存。用户创建的 Owner 为本人，应用创建的 Owner 为登记的自然人责任人，创建主体仍为应用。API 不进入 Web 申请审批状态机，也不设预审批；镜像/配置与运行能力准入仍适用。管理与使用授权可分别撤销，应用不继承责任人的权限，Owner 不能绕过已撤销的 API 授权。

上述事务是创建请求的可靠受理点，先于 Workload 创建；实例创建失败保留原 Agent 与初始授权，按现有生命周期权限查询、停止或重试，不能产生只有成功部署后才能管理的 Agent。

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

平台来源的停止、恢复核实及代次隔离复用同一签名机制，使用与业务执行显式区分的控制用途 Grant。Core 依据已持久化的撤权、停止、隔离记录或经可信历史证明后提交的系统迁移审计及目标当前状态签发，绑定原主体、Agent、Conversation、适用的 Execution、Session 代次、控制操作引用与命令范围；原主体保留为目标和审计归属，不要求其仍具备业务使用权。Host 必须校验控制用途与上述绑定，并继续执行该操作的租约、fence 和屏障规则。控制用途只允许停止、无正文状态核实、必要代次屏障，以及原执行未确认事件向平台持久化处理器的续传与确认。事件续传须绑定原 Execution、代次、当前 fence 和持久确认游标，由处理器按原任务隔离保存；该通道不授予用户查询或正文回放权限。控制 Grant 不能提交或补充 Turn、发起模型/工具调用、读取附件或向用户返回正文，也不能用于 Connection 授权。服务身份或调用方自报撤权不能替代该 Grant；过期后仅能沿同一持久控制记录重新校验签发，不能借此恢复业务权限。

历史执行主体缺失时，只能依据部署受信的原 producer 证据建立原主体与对象绑定，不能按
当前角色补造原受理范围。只有完整原授权边界可恢复业务授权记录；仅能证明主体时，将原
Execution、Session 代次、原操作摘要和迁移来源与必要系统审计原子保存，其持久审计引用
可作为无正文恢复、停止及原事件续传/确认的独立控制来源，不授予提交、补充或业务续期。
Worker 每次签发重新读取该来源与当前租约、fence 和 Workload，不要求原用户仍可用。
Host 通过独立部署信任根验证版本化签名迁移映射，核对当前 Workload 及完整旧 Session
执行集合；签名方须先核实 Platform 迁移审计已提交。映射仅证明历史归属，不是操作 Grant
或 Connection 授权；实际调用仍须独立的短期 Grant。来源缺失、矛盾或不可确认均拒绝。

Runtime Execution Grant 仅授权平台 Runtime 操作，不是 Connection 访问凭据。平台不为 Connection 签发 assertion、不传递 Owner Action policy，也不替 Connection 决定客户端可调用的外部账号。

Workload 就绪检查不以业务 Conversation/Execution 为授权上下文，而使用独立版本化的
只读 Workload Readiness Grant。Worker 在当前调谐候选的权限与 fence 下签发最多 30 秒有效的
证明，绑定签发方、专用 RuntimeHost readiness audience、唯一 Grant/请求标识、Worker、Agent、
Workload revision、fence、镜像 Digest 和 `readiness.read` 用途。Host 同时校验服务身份、签名、
时效及部署注入的本机 Agent/revision/fence/Digest，并将已认证 Worker 与 Grant 绑定核对；
缺失本机绑定或任何不匹配均拒绝。
该接口仅执行无副作用的核心与 capability 读取，不创建 Session/Turn、不读会话或附件，
不调用模型、工具或 Connection。它没有用户、Conversation、Execution 或 Action 字段，不能
用于业务或控制命令；同一有效请求的重复只允许重复读取。Worker 必须按当前候选和 fence
提交检查结果，迟到结果不能激活其他候选。该边界见
[ADR: 独立的 Workload 就绪授权](../adr/0010-separate-workload-readiness-authorization.md)。

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

将既定标准模板发布应用到单个 Agent，使用独立的部署运维操作。部署绑定允许发布的
当前主体与精确发布目标；主体须经真实身份入口解析为 active 系统管理员，且仍有该部署
运维资格。系统管理员身份本身不授予任意发布权限，Owner 身份也不替代此资格。
普通配置操作继续只接受其既有 Owner 授权，不能消费运维 authority 或请求字段指定的 intent。
取舍见 [ADR: 隔离标准模板发布权限](../adr/0013-isolate-standard-template-release-authority.md)。

部署目标绑定 release ID、Agent、template、预期配置修订与旧 Digest、目标 Digest；
受限内部 HTTP 操作按 Zod/OpenAPI 契约仅接受该既定发布，不接受调用者自报的主体、
角色或任意配置。实际 Request 贯穿身份解析与 request scope。Core 在当前配置读取后
校验旧基线、同一 standard template 和生产 Registry 重新准入的目标 Digest，保持模板的
env/Secret 开放键、平台保留键及 Connection 声明策略不变；只更新 source 的镜像与
准入证据，保留模型、Secret 完整引用、Owner、可用范围、env 和渠道。该操作不授予
Owner 配置权限，不替换 PVC，也不恢复已停止或停用 Agent 的运行资格。

发布使用独立、用途绑定的授权事实；Registry 准入之后、提交之前再次校验当前主体和
部署发布资格。身份修订与 Agent 授权修订分别校验，后者参与现有配置事务的 CAS。
完整发布目标与操作种类进入 canonical 幂等摘要；授权先于 replay，匹配的原持久结果
先于旧基线校验返回，不因重试新增修订。复用原配置事务，原子提交配置、幂等、真实
操作者审计和 outbox；受理只表示新期望已保存，后续验证与回滚仍由唯一 Worker 执行。
此单 Agent 步骤不替代模板目录对所有关联 Agent 的自动升级义务。

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

已验证 Workload 的 StatefulSet 本身缺失时，原 activation fence 不授权新 StatefulSet。
Core/Store 只能在当前 Agent 锁和管理 fence 下，从当前配置及已验证 Workload 派生恢复来源，
校验完整 Secret reference、原 active record 与当前 Owner 绑定；Worker 先关闭路由并通过
Kubernetes API 确认 StatefulSet 缺失，读取失败或同名对象身份不符不能视为缺失。
在任何恢复解密或资源创建前，Platform DB 的候选 Workload 持久保存恢复意图，绑定来源
reference 与 fence、候选 Workload revision、管理 fence 和确定的新 immutable Secret 名称。
新名称保留 Agent、Secret 版本及来源配置修订关联，并包含本次恢复身份，满足 Kubernetes
命名限制；调用方不能提交或覆盖该映射。取舍见
[ADR: 为缺失 Workload 重建 Secret 物化](../adr/0012-reconstruct-secret-materializations-for-missing-workloads.md)。

Worker 从原始密文可信解密并审计，以新名称创建或精确校验 immutable Opaque Secret 的
完整身份与全部数据，再调谐只引用该候选物化的 Workload；模型投影与 env 必须消费同一映射。
创建后崩溃时按持久意图重试相同名称并重新校验值。新 StatefulSet 只可收养与候选
Agent、revision、fence 和完整期望 spec 精确一致的幂等创建；观测身份一经持久保存，
其他 UID 不得替代。Worker 回读新 StatefulSet UID/generation 与实际 Secret UID，
沿 resourceVersion CAS 绑定本次恢复 fence，完成健康检查、适用核心探测以及所有新绑定的
再次观察后，才能提升已验证 Workload 并恢复路由。任一身份、管理 fence、值、探测或 CAS
不一致均保持路由关闭，沿既有有界重试和失败流程处理，不使用原 activation fence 放行。

恢复物化属于 Workload 私有持久状态，不修改原 Secret ID、版本、来源 configRevision、
密文、AAD、原 Kubernetes reference 或 activation fence，不将 active record 改回 pending，
也不重新激活原记录。后续重启、配置更新与回滚在锁内继承仍适用的已验证物化映射及身份，
不能回退到已失效的原名称或仅凭 annotation 补造绑定；恢复后的 StatefulSet 再次缺失时，
按新的候选恢复意图处理。

恢复后的 StatefulSet 仍存在，但恢复物化的 Secret 缺失或 UID 改变时，目标名称与 fence
只能来自锁内校验的已验证 Workload 私有映射。Worker 校验该映射与原 active record、
完整来源 reference 和当前 Owner 绑定，从原密文可信解密并审计；仅在同一 StatefulSet UID、
generation 未回退、逐 Secret 恢复 fence 精确相等及当前管理 fence 通过时，沿上述精确值
校验、live Secret UID 回读和 resourceVersion CAS 流程修复该物化的 UID 绑定。
原 record 与原 activation fence 保持不变；缺失可信映射时拒绝，不从 annotation 推导。

失败清理保留恢复意图及未完成回收义务，只可按实际 UID/fence
回收本候选且未被已验证或回滚 Workload 引用的物化，不能删除原 active Secret、原 PVC
或任务数据。尚未提升为已验证版本的恢复候选 StatefulSet，可在关闭路由后按持久意图的
精确 UID、revision、fence 及 Kubernetes 删除前置条件清理；确认其不再引用候选 Secret 后
才回收对应物化。保留已验证恢复来源和回收义务，全部清理完成后才清除候选 Workload
身份并进入新的恢复意图；已验证 Workload 不适用此删除例外。
删除成功但进度尚未保存时，按原持久意图和可信缺失观察幂等继续；读取失败、同名不同
UID 或不匹配的 fence 不能授权删除。停止、停用或更高管理 fence 到来时保留清理义务，
按最新管理 fence 关闭路由，清理完成后重新解析当前期望，不能恢复已撤销的运行资格。
恢复运行资源不产生任务恢复授权；原 Conversation、Execution、Session、
撤权、停止、unknown 和 generation barrier 继续按既有契约处理，不重放业务操作。

不涉及上述 StatefulSet 重建的失败升级在切换到已验证配置前，先在关闭路由的 cleaning 步骤回收当前候选中尚未激活的 Secret；回收未完成则保留该步骤重试，避免回滚替换候选绑定和 UID/fence 见证后失去回收路径。该步骤不删除 Workload 或 PVC，仍保护 active、active-origin 与回滚保留项。 停止、重启或配置更新不能覆盖未完成的回收义务；清理期间继续按候选历史配置解析 Secret，使用最新管理 fence 保持路由关闭，完成后才切换至最新管理和配置期望。初次创建失败且无已验证配置时同样保留清理义务，沿既有路径完成候选 Secret、失败 Workload 与新 PVC 回收，并清除旧 Workload 身份后才接纳最新期望。

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
按目录 profile 分派的访问验证器执行候选预检。目录快照必须带
`schemaVersion: 1`、精确 `revision` 和毫秒时间戳 `validUntil`；每个端点带
`endpointId`、精确 `baseUrl`/`origin`、protocol profile、TLS 与禁止重定向策略、
streaming/tool/reasoning policy、可选 `allowedModels` 和可用状态。`allowedModels: null`
表示目录不额外限制模型名单，仍须验证 Owner 指定的模型。未知字段、缺失、移除、过期、
修订不匹配和不可用结果均返回 `MODEL_CONFIGURATION_UNAVAILABLE`，不回传原始异常。

目录的 `protocol` 是 profile 的唯一协议判别字段；当前实现范围为 `openai-responses-v1`
与 `anthropic-messages-v1`。Messages 端点还必须由目录声明 `authentication` 为 `bearer`
或 `api-key`，分别映射到 Authorization 或 x-api-key；Owner 只提供对应 credential，不能选择
认证方式或提交任意 header。旧 Responses 端点继续使用固定 Bearer 认证，其缺省语义不扩展到
Messages。预检先校验目录 profile 与可信标准模板 Driver 绑定兼容，未知或不兼容组合在模型
请求与候选物化前拒绝；不能根据 URL、模型名或探测回退猜测协议。

Worker 在 preflight 对每个 option 独立可信解密并审计，通过该 profile 的有界合成请求验证
credential、模型、每个 reasoning 档位、流式完成和工具调用；探测不使用会话内容，不执行工具。
Responses 保留 `createResponsesModelAccessValidatorV1()` 与 `store: false`；Messages 使用
实际 `/v1/messages` 路径、选定认证方式和 pinned SDK 所需的版本/capability 参数，按该协议
验证完整终态，不能以 Responses 成功替代。覆盖 `/v1/messages/count_tokens`：固定原生版本
要求该能力时必须成功；版本明确支持缺失时的估算回退，须验证其真实行为，不能把可选接口
误作必需能力，也不能将认证、协议或模型错误当作可选缺失忽略。
整个投影最多 60 秒，每次响应最多 1 MiB。
部署应计入这些配置验证请求的额度。Runtime Driver 继续负责 pinned native profile 验证。
任何选项失败都不物化候选 Workload；临时解密 buffer 在验证后清零。
Workload 部署使用 Worker-only `createWorkloadSecretKeyringDecryptorV1`，允许解密 Store
已确认的 current/active-origin 记录；仍验证完整记录与加密 AAD，不改变 Secret 状态。
候选 preflight 的访问验证是 10.6 物化复用规则的受控解密例外：沿原 AAD 解密并记录既有
Secret ID、Agent ID、keyVersion、结果与 traceId 审计；不复制、重新加密或重新激活 active-origin。
已验证配置的正常调谐、漂移修复与回滚不重复访问验证；物化恢复仍遵循 10.6。
独立 Secret 激活入口继续使用拒绝 active 记录的 `createSecretKeyringDecryptorV1`。

通过验证的投影及 SHA-256 指纹与 candidate/verified 一起保存在 Worker 的持久调谐状态，
不进入公开 desired contract。版本化 Runtime JSON 写入独立 immutable 配置 Secret，每个 option
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

新增 profile 使用 Runtime 配置 V3，每个 option 除既有字段外携带目录确认的 `protocol` 和
`authentication`，二者纳入持久投影、指纹、重验和 Host 校验，不能在 Worker 到 Host 的装配中
丢失。旧 V2 只按既有 Codex/Responses 语义读取；不能把 V2 当作 Claude 配置或为其推断新的
协议。旧 verified 投影的读取和指纹保持兼容，不通过添加缺省字段改写历史快照。
Host 在启动 Driver 前校验全部选项与部署固定绑定兼容；执行命令仍只传平台模型选项及
reasoning，不携带 profile、endpoint 或 credential。共享 Schema 由 `packages/contracts`
维护，ModelCatalog/Worker 与 Host 消费同一版本；后续 ACP/Pi 的真实 profile 在各自实现中
扩展，不提前宣称兼容。取舍见 [ADR: 按目录协议绑定标准模板模型配置](../adr/0009-bind-model-profiles-to-runtime-configuration.md)。

V3 JSON Schema 的具名定义提供结构校验；选项 ID 与选项内 reasoning 的唯一性、默认选项和
reasoning 的关联由共享 `RuntimeModelConfigurationV3Schema` 执行语义校验，Worker 与 Host
均必须执行，不能仅凭 JSON Schema 校验通过物化候选配置或准入 Runtime。

### 10.8 Codex 原生模型传输边界

Codex Driver 在 Agent Pod 内管理一个仅绑定 loopback 的模型传输入口，将原生模型请求转发到
该 Agent 当前配置中所选模型选项的已批准 endpoint。每个选项的上游 credential 仅保留在父进程；
每个 Conversation 代次的原生进程只持有独立随机、短期且绑定该进程的 loopback token，
不能跨 Conversation 共享。入口由 token 得到服务端固定的 Conversation，再查询已确认的
原生 thread/Turn 与原 Execution 关联；请求 header 或正文不能建立、迁移或恢复该关联。
准入、在途请求和撤销均按该 Conversation 划分，外来请求失败不能影响其他 Conversation。
该入口只接受固定的 Responses 路径，不接受调用方选择上游、任意路径、跳转或代理配置；
原生进程退役时撤销其 token 与新准入，重建进程使用新 token；关闭 Driver 后关闭入口。

部署配置以版本化、不可变的选项集合传入 RuntimeHost；每个 `modelOptionId` 独立绑定 endpoint、
真实 model、允许的 reasoning 与注入 credential，不因 model 名称相同而合并。Execution 已冻结
的 optionId/reasoning 决定该次原生 Turn；重试沿用原选择，未知选项、配置版本或路由标识拒绝。
Worker 负责目录解析和配置/SecretRef 投影，RuntimeHost 不读取目录、数据库或 Kubernetes。

Codex 模型切换所需的 local pre-turn compaction 也必须使用该 Execution 已冻结且当前获准的
模型选项与 reasoning。原 Session 的上一模型记为 A，本次有效选择记为 B；在原生调用点
显式使用 B 的 TurnContext，覆盖 `CompHashChanged / PreTurn` 和 `ModelDownshift / PreTurn`，
不先请求 A，也不因压缩失败切换模型。A 仅用于原生历史与触发条件判断，不要求 A 的选项
仍在当前清单或凭据仍可用，不为 A 增加授权。B 的准入、实际压缩请求与后续回答沿用现有
模型 operation/attempt、意图、结果和用量事实，不新增 compaction Grant、公共 Schema 或
私有 FD 协议；若实现不能满足既有屏障，须明确缺口并评审，不能以用途字段放宽准入。

该策略保留原 Session/thread、模型切换和压缩触发、原生历史标准化、窗口与 overflow 算法、
实际压缩及摘要安装顺序；普通当前模型的 context-limit 压缩仍遵循同一选择与授权边界。
禁止在 HTTP body 中把 A 请求改写成 B、伪造或删除 comp_hash、为通过兼容验证而人为删改
reasoning/加密项或历史、跳过实际压缩或更换 Session。既有内部别名到所选真实模型的映射
保持不变。原生重试仍须通过现有每次实际请求的意图与授权屏障，unknown 不授予下一次请求。

这是待验证的原生工程策略，不是对任意真实 provider 或历史格式的兼容承诺。完整验证矩阵
以 [Runtime HLD 第 11 节](HLD-agent-runtime-M1.md#11-验证)为准；部分案例通过不形成永久
支持清单，也不缩减 PRD 的会话内模型切换要求。任一切换路径仍需请求 A 时，唯一 B 准入
继续拒绝该请求；这表示模型选择对接尚未完成，不能作为新的产品例外或宣称完整修复。失败边界见
[Runtime HLD 8.5.2](HLD-agent-runtime-M1.md#852-codex-模型切换前置压缩)，取舍见
[ADR: Codex 模型切换压缩使用当前有效选择](../adr/0014-use-current-selection-for-codex-switch-compaction.md)。

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

每个提交操作在持久 prepare 阶段绑定非敏感模型配置版本，先于原生副作用；恢复 running 或准入不确定执行的业务能力时，在首次 native RPC 和转发授权前验证该版本与当前配置一致。历史绑定缺失或版本不匹配只拒绝对应执行的业务恢复，不阻止 Host 启动，不回填未知来源。已持久终态和事件无需原生恢复时仍可读取；同一 Session 无旧 active 或不确定执行后，新授权 Turn 可使用当前配置。配置版本随端点、凭证值或引用轮换、模型选项集合、模型、推理等级或默认选择变化而更新；持久状态不保存端点、凭证或其摘要。

原执行已通过持久屏障封闭模型与工具新准入时，原受理回执、已保存事件和无正文状态核实
不因当前业务模型配置变化而失去恢复入口。Host 仍须验证原执行现有查询授权，或 9.3 的
控制用途 Grant；系统停止只能使用其允许的控制命令。Host 从受保护的原持久记录核对
主体、Agent、Conversation、Execution、Session 代次和原请求摘要。Driver 消费 Host 已验证
的命令，核对自身持久化的原 Session/thread/Turn/operation/attempt 及模型选择绑定，并在
原 fence 和屏障约束下回放原 journal、查询原生状态或精确停止原执行。配置差异
不能成为更换上述绑定、模型选择或重写原回执的依据；缺失、冲突或损坏的绑定仍失败关闭。

该路径不得注册或恢复模型准入、转发模型请求、提交或补充 Turn、重发工具操作，也不得
清除原执行的封闭状态；即使主体权限或配置随后恢复，也不能重新激活已撤销的原执行。
需要启动原执行的查询或控制进程时，仍校验原生 provenance、隔离及原执行所需的屏障能力，并禁止
业务副作用。已有 accepted/running 回执只证明曾被接受，不能充当当前运行状态；停止
ACK、模型连接中断或进程退出不能合成原 Turn 终态。状态收敛、占用与事件确认沿用
[Runtime HLD 7–8](HLD-agent-runtime-M1.md#7-sessionturn-与恢复)，缺少可靠结果时保持
unknown 和原占用。控制续传只交给平台持久化处理器，不向已撤权用户回放正文。

RuntimeHost wire contract、Execution 模型选择、Platform/Connection 权威边界和 #403 的原生
持久数据保持；多用户隔离仍由独立验收证明。正式镜像验收必须包含成功 Turn，以及 HTTP 与
流内失败、取消、异常流的合成负向场景，递归检查原生持久历史、日志与 HTTP/SSE 的脱敏结果。
取舍见 [ADR: Codex 模型错误在原生持久化前脱敏](../adr/0007-sanitize-codex-model-errors-before-native-storage.md)。

### 10.9 Codex 原生 Conversation 隔离边界

Codex Driver 为每个 Conversation 代次维护一个独立的原生 `app-server` 进程。进程选择键由服务端
从可信 `agentId`、`conversationId` 与 `sessionGeneration` 派生，不接受调用方提交的字段，也不由
原生回包决定。每个进程独立完成 pinned provenance、`initialize` 与受限配置准入；一个进程的准入
结果不为另一个进程担保。一个原生传输只允许一个请求多路复用器。

原生持久存储位于该 Agent PVC 上 Driver 状态的同级目录，按 `conversations/<key>/{home,workspace}`
分配；`CODEX_HOME` 与 cwd 按 Conversation 绑定，因此原生历史与 rollout 天然不共享目录。所有层级
以 0700 创建并校验归属与权限位，持久目录中出现原生配置或凭证文件即拒绝启动。旧布局与丢失所属
目录的 Session 保留原始文件与映射，相关原生操作 fail closed。

文件边界按平台施加，两种方式都限定到本 Conversation 目录，且不落盘配置文件。任一平台无法施加
边界时拒绝启动原生进程，不回退到无边界模式。

Linux 由部署提供的可信 `setpriv` 对整个原生进程施加 Landlock 边界：pinned legacy Landlock 后端
拒绝需要直接运行时强制的权限 profile，而它的替代后端需要该部署不具备的 namespace 权限。Landlock
规则只能增加访问，深层规则无法收窄父规则，所以必须使用 allowlist。受管权限覆盖可触达常规文件与
目录的文件系统权限，不含只作用于字符/块设备的 `ioctl-dev`；allowlist 只允许 pinned 发行版及其资源、
系统程序与库目录只读，`/etc` 与 `/sys` 只读元数据，`/proc` 只可列举而不可读取（读取会让模型工具从
原生进程环境中取出模型传输凭证），`/dev` 只可读写已有设备节点，以及本次临时 HOME/TMPDIR 与本
Conversation 自己的 `home`、`workspace` 可读写；Conversation 根自身、兄弟 Conversation 目录与共享边界
目录都不在 allowlist 内。规则路径必须是绝对且已规范化的目录：helper 在原生进程工作目录下解析它们，
而 Landlock 把规则绑定到解析后的目录，因此路径中任意一段符号链接都会静默放宽边界。任何落在共享边界
内、或反向包含该边界的外部条目都被拒绝，包括把 pinned 发行版装在系统根目录时推导出的程序目录。

该平台边界在 Linux 是唯一的文件边界：pinned legacy Landlock 后端在执行工具前需要对 `/` 的递归
`read-dir`，而 Landlock 只能增加访问，授予它会让全部兄弟 Conversation 目录重新可列举，本人
`workspace` 写入同时失效。因此 Linux 关闭 pinned Codex 自身的文件 sandbox（`sandbox_mode`），保留
legacy 后端选择只为避免残留代码路径落到需要 namespace 权限的后端。代价是同一 Conversation 内的
模型工具与该 Conversation 自身权限相同，可写入本 Conversation 的原生 `home`；跨 Conversation 读取、
列举、搜索与写入仍全部被拒绝，且必须由镜像验收的负向用例证明。Darwin 不受此影响。

Darwin 由 pinned Codex 自身的权限 profile 施加，以 session flag 注入：Conversation 根 `deny`、
本 Conversation `home` 只读、`workspace` 可写。Darwin 不在原生进程外再包一层平台沙箱：pinned 版本
在 Darwin 用 `sandbox-exec` 执行工具，任何具有约束力的外层 profile 都会使内层 `sandbox_apply` 失败，
从而让工具普遍不可用并伪造出“隔离通过”。

两条路径在跨 Conversation 上的效果一致：模型工具不能读取、列举、搜索、修改或引用其他 Conversation
的工作区与历史；路径别名、符号链接与父目录穿越同样被拒绝。本 Conversation 内的写入能力按平台记录：
Darwin 的 profile 使本人 `workspace` 可写、`home` 只读，因此原生配置、skills 与 HOME 不允许模型
工具写入；Linux 只有平台 Landlock 边界，本 Conversation 的 `home` 对模型工具可写，这是上述后端
限制的已记录代价，不外推为跨 Conversation 结论。

平台自有模型传输始终是 loopback 入口，原生进程必须拒绝为 loopback 走代理，避免宿主代理配置
拦截该入口。原生进程的环境仍是白名单，不继承宿主代理变量或凭证。

Runtime Contract、部署单元、Grant 校验与 §10.8 的模型传输边界不变，也不引入平台统一 Sandbox。
验收必须使用真实 pinned Codex 与正式 Host/Driver/Bridge，覆盖并发、进程重启与原 Session 恢复；
本人访问必须成功，工具普遍不可用或平台能力关闭都不构成隔离通过。取舍见
[ADR: 按 Conversation 隔离 Codex 原生进程与文件边界](../adr/0008-isolate-codex-native-processes-per-conversation.md)。

### 10.10 Claude 原生模型传输边界

Claude 原生进程会将模型 API 的错误正文写入会话记录；仅归一化 SDK 事件不能满足凭证与
供应商错误正文不落盘的要求。固定 Claude Driver 在同一 Agent Pod 内为每次 Query 创建
独立的 loopback 传输入口，绑定该 Query 已批准的唯一 endpoint、认证、模型和 reasoning。
真实 credential 只保留在 Driver 传输层内存；原生进程只获得该入口的随机短期能力，不能
通过模型名、请求 URL 或请求 header 选择其他选项。该入口不提供平台服务、协议转换、
供应商发现、重试或故障切换。

只允许固定 Messages profile 的 POST 路径；目录 base URL 表示供应商根路径，入口追加
`/v1/messages` 或 `/v1/messages/count_tokens`，保留 pinned CLI 所需的固定查询参数与
版本/capability header，拒绝重定向。每次发送前核对模型、reasoning、Query 与已持久提交
操作的绑定；尚未持久接受、取消中、已退役或配置版本不匹配的 Query 不得向供应商发送。
原生网络重试不能重投接受结果不确定的请求；模型请求已发送但完整响应未确认时，关闭
该 Query 的转发能力并保持执行 unknown，禁止静默重试。

非成功 HTTP、流内错误、非法帧和不完整终态在进入原生进程前替换为固定脱敏错误；不转发
供应商错误正文或响应 header。合法文本和工具内容使用既有凭证泄漏检测原则，传输层不写
请求、响应或诊断日志。停止和 Query 退役先撤销能力、取消并排空上游请求，再确认原生
进程退出；能力不转移到下一个 Query。恢复保持原 Session，不能携带旧入口能力。

### 10.11 Codex 上游原生补丁与执行屏障

M1 的标准 Codex 路径使用固定的官方 upstream release。现有
[Codex release 声明](../../packages/agent-runtime/src/codex-release.json)是 provenance 的唯一
版本来源，至少固定上游 tag/commit、协议与 Schema、每个 target 的 archive/executable hash、
许可证和 NOTICE。安装阶段校验声明与精确字节、Linux sandbox、原生协议以及已声明的 built-in
能力覆盖；运行时不下载依赖、不编译源码，也不把官方发行物描述为包含不存在的私有 barrier。
官方 release 未提供可验证的每次尝试 callback 时，标准路径不宣称 Codex 原生屏障 conformance；
无法观察或控制的隐藏尝试必须记录为能力缺口，不能用日志、普通 approval 或缓存补足。无论
发行路径如何，PRD 要求的每次实际外部动作持久 intent、当前授权、结果或 unknown 确认仍是
准入前置；官方路径无法在该边界可靠控制的操作必须拒绝或标记未支持，不能作为正式 conformance。

需要私有 FD callback、Connection bootstrap/recovery 或等价 native lane 的能力，只有在部署
provenance 明确声明该 lane、协议/Schema 与工具覆盖，并实际验证不可关闭的 native barrier 后
才能启用。该 barrier 在每个真实外部动作前等待 Driver 的持久 intent 与 Host 当前授权，在
结果或 unknown 可靠保存前不得交付原生推理循环；缺失、错配、断连、过期或被模型/Owner
配置关闭时 fail closed。专用 FD 必须由 native 接管后设置 close-on-exec，工具子进程不能继承
或重开控制端。普通官方路径与私有 lane 的 capability 必须分别声明和验收。

本 M1 路径不维护第三方 Codex 源码补丁、vendor builder、派生二进制或下载编译流程。若
上游 release 缺少所需接缝，先走 upstream contribution；引入任何受控 derived/private artifact
前须由单独架构决策明确其来源、供应链证明、维护责任和退出路径，不能在实现中隐式恢复旧
vendor 方案。Platform、Connection、Host 和 Driver 继续使用 TypeScript，不新增自有 Rust
crate、推理循环、服务、插件平台或统一 Sandbox。

PRD 的外部操作持久意图、当前授权和真实结果要求不变；官方 release 的协议可用或部分
能力通过不能被解释为完整 M1 验收。尚不能满足的实际操作必须标记未通过，不能以本节豁免
产品门禁。原生字段和私有协议留在 Driver 内部，事实沿现有版本化公共 Schema 和原事务/游标交付。详细状态、attempt 覆盖和确认顺序只在
[Runtime HLD 8.5.1](HLD-agent-runtime-M1.md#851-codex-原生执行屏障)维护；接缝验收和
Connection prep 边界见 [Runtime HLD 11.2](HLD-agent-runtime-M1.md#112-codex-与-connection-接缝验收)。

升级和回滚完整执行 10.4 的自动恢复流程：候选失败后，将旧 Digest 和 Workload 配置写成
新的期望修订，实际重新调谐并验证旧修订，不能因缺少预先兼容证明跳过该尝试。回滚仍复用
原 PVC；Driver 持久记录原 Session/代次要求的 provenance、lane 和 barrier 能力，旧终态和
事件保持可读，旧 active、unknown 或新协议状态只能核实原执行，不得新建 Session/Turn、
回填成功或重发工具。旧修订仍须通过原执行要求的状态兼容、屏障及 10.9 隔离验证；缺少任一
要求时记录实际恢复失败，保留原数据与核实证据。不得把依赖私有 lane 的原执行降级为普通官方路径。旧修订实际恢复成功后继续提供服务并显示升级失败原因；只有该恢复也失败时才
保持路由关闭、显示“暂时不可用”，由平台团队人工恢复。

官方 release、私有接缝声明和 native contract 须先完成适用架构/安全/维护评审，随后才更新
pin。真实 target 产物、built-ins 正向能力、隔离、故障与恢复均按 Runtime HLD 第 11 节验证；
官方路径与私有 lane 的证明不能互相转移。长期维护及 barrier 替代的取舍见
[ADR: Codex 原生操作必须经过持久执行屏障](../adr/0011-require-codex-native-operation-barrier.md)及
[ADR: Codex 模型切换压缩使用当前有效选择](../adr/0014-use-current-selection-for-codex-switch-compaction.md)。
原执行屏障的既有评审不代表新增压缩策略已获评审；差额的文档和 Issue 范围先完成独立架构、
安全及维护评审，再修改 native/code/pin，沿同一 primary Issue 与实现 PR 交付。

### 10.12 Builder 与平台受控镜像构建

Builder 是现有对话式 Web 中的一个受授权任务能力，复用 Platform 的 IdentityContext、Agent 可用范围、Conversation/Execution、审计和部署状态；M1 不新增独立 Builder 生成 API。API 仍只提供普通非对话 Agent 创建和管理能力。Builder 读取或修改 Repo 必须经现有 Connection 授权，使用隔离分支和独立临时工作区，不接受调用方粘贴的 Token，也不能直接写入受保护分支。代码变更须可查看、可审计并提交 PR，但 PR 与构建/推送是独立链路，构建不等待 PR 合并。

Builder 可以生成或修改 Dockerfile、构建定义以及受平台约束的 System Manifest/Helm 部署。多服务系统在 Platform DB 中仍表示为一个 Agent 管理对象；每个服务的镜像、Service 和部署描述属于该 Agent 的同一版本。平台不创建多 Agent 生命周期，也不为多服务切换提供分布式原子性。数据库迁移、持久业务数据兼容和恢复由系统部署流程与 System Owner 负责，Builder 可以分析、提示或阻断高风险发布，但不自动回退或恢复业务数据。

Builder 生成 System Manifest/Helm 不构成部署授权。Agent 版本绑定前和实际部署前，平台服务端必须按 [Workload 形态](#101-workload-形态)、[环境变量与 Secret](#106-环境变量与-secret) 和[安全基线](#17-安全基线)对最终部署资源（含 Helm 渲染结果）执行准入，拒绝 `privileged`、`hostNetwork`、`hostPath`、未授权的 ServiceAccount/Secret 引用及绕过 Connection 独立授权的配置。不可校验或校验失败时拒绝绑定或部署，用户确认不得豁免；实际资源仍仅由 `platform-worker` 调谐。该静态准入不能替代 Connection 对每次调用的独立授权。

BuildServiceAdapter 至少提供以下语义：

- 为每次构建创建独立、短期的源码/工具/缓存工作区，任务完成或取消后清理；禁止跨用户或跨 Agent 复用工作区、运行时依赖和缓存。
- 按部署目标 ACK 的 Linux OCI 与节点架构构建；目标架构无法产出或验证时失败。GPU、Windows、特定内核和特权运行要求在 M1 中明确不支持。
- 允许受平台网络策略约束的公网依赖下载；不提供私有依赖凭证注入。构建所需私有凭证不可用时失败并说明原因，不能向用户索取粘贴 Token。
- 强制禁止宿主 Docker socket、`privileged`、`hostNetwork`、`hostPath`、Kubernetes API 和内核模块；不得为使构建成功自动放宽隔离。任务超过平台时间、CPU、内存或磁盘上限时终止，不自动申请更高资源。
- 平台负责 Registry 推送和部署拉取权限。镜像仓库统一位于 `agent-infra` 项目，单服务使用服务端生成且不可变的 `agent-id/service-id` 作为路径组件，用户可见名称不得直接参与 Registry 路径；平台拒绝路径分隔符、控制字符和规范化碰撞。任务只有在所有服务镜像构建、推送并取得不可变 Digest 后才可提交 Agent 创建。非研发用户不需要 Harbor/OCI Registry 账号、仓库管理权限或 `imagePullSecret`。
- Builder 可临时安装工具或依赖，但最终镜像必须包含自身运行时依赖。未完成镜像和中间产物不得进入 Agent 版本；跨 Registry 复制私有镜像不属于 M1 P0。

Builder 在构建前根据 Repo、构建定义、声明依赖、网络/环境约束和 ACK 政策进行可部署性预检，部署启动后执行真实能力检查。预检发现必需或核心能力不可用时阻断发布；可选能力缺失只能在明确展示限制并获得用户确认后降级发布；无法判断核心性的能力必须说明不确定并取得确认。静态分析、healthz 或 mock 不能单独证明能力可用；无法部署或证据不足时返回如实的自然语言限制说明，不发布未就绪系统。

BuildServiceAdapter 的任务状态至少区分排队、运行、成功、失败和取消，并持久保存构建批次、输入摘要、源码版本、构建后端版本、目标架构、镜像 Digest、脱敏日志摘要和错误/取消原因。凭证和敏感内容不得进入日志、错误、Trace 或审计正文。失败、取消或 Agent 创建回滚必须终止任务、清理临时资源、未完成产物及该批次已推送但未绑定的 Digest，并阻止后续 Agent 创建；后台 GC 按构建批次追踪并清理异常残留。

成功结果形成不可变 Agent/系统版本；发布需要用户确认，Platform DB 保留当前运行版本与版本历史，升级和回滚复用既有 Agent 生命周期。合并受保护分支和正式生产发布仍需现有相应授权主体明确确认。签名、扫描和 Registry 准入沿用部署政策，不在 BuildServiceAdapter 外新增 Builder 审批流程。当前真实构建、OCI 导出/Digest 及 Registry push 尚待验证；本 Spec 不将某个具体构建器、rootless 实现或探针结果视为已验收事实。

## 11. Agent Runtime 边界

### 11.1 Platform Conversation Contract

Web、任务 API、Eval 执行和平台托管渠道只面对统一 Platform Conversation Contract。该 Contract 定义创建或恢复 Runtime Session、为新消息或重新生成提交一个带 Execution 已固化有效模型选择的 Turn、停止 Turn、查询状态、接收规范化事件和读取 capability，不暴露 ACP、Pi RPC、stdio 或其他 Runtime 原生消息。

四个标准模板实现完整 Contract。使用平台交互入口的自定义 Agent 通过 Generic ACP Adapter 实现 Contract；使用自有交互入口的自定义 Agent 不进入该 Contract；管理 API 可用不能被解释为任务 API、观测或 Eval 可用。自定义 Agent 的这些能力以接入验证结果为准。

### 11.2 Adapter 部署与 Registry 边界

`platform-worker` 只运行 RuntimeHost Client Adapter，并通过 Agent Service 的内部 HTTP/SSE Interface 调用 Pod；RuntimeHost 和 Native/ACP Driver 在 Agent Pod 内运行。M1 使用固定 Registry，不动态发现或加载 Driver；标准模板绑定、自定义交互模式和 capability 派生规则只在 [Agent Runtime M1 HLD](HLD-agent-runtime-M1.md#3-runtime-registry-与交互模式) 中完整维护。RuntimeHost 的依赖方向和未来抽取维护标准见 [RuntimeHost 未来抽取与维护标准](HLD-agent-runtime-M1.md#12-runtimehost-未来抽取与维护标准)，工程 Spec 不重复定义。

Codex Linux 部署必须启用并完整支持 Landlock ABI V5 的文件系统权限，且允许运行用户在非 root、只读根文件系统、移除全部 capabilities 和 `no-new-privileges` 的约束下安装并应用规则集。原生执行前必须通过实际规则集安装完成能力准入；不能根据 `uname` 或内核版本推断支持，也不能接受部分权限降级。内部后端、可信部署工具与启动顺序见 [Codex Linux sandbox 启动准入](HLD-agent-runtime-M1.md#101-codex-linux-sandbox-启动准入)。

Agent Pod 的 `/tmp` 挂载部署控制、具有显式容量上限的内存临时卷，随 Pod 删除，不保存业务持久数据。Runtime 为每次原生启动分配独立临时目录，仍遵循 [Conversation 隔离边界](#109-codex-原生-conversation-隔离边界)，不能把共享 `/tmp` 根加入原生文件访问许可。生产 Workload 和镜像准入探针必须使用一致的临时卷容量与安全约束；部署参数见 [Kubernetes 交付拓扑](../../deploy/README.md)。

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

- HTTP/Web/回调入口由 `platform-api` 调用 Core，企微长连接入口由 `platform-worker` 调用同一 Core；两者都在同一 Conversation 数据库锁内完成命令准入，将业务记录与 outbox 原子写入 Platform DB。Runtime 投递仅由共享 Worker 认领已提交的 outbox，再通过 RuntimeHost Client 调用 Agent Pod 内的固定 Driver；长连接入站不得直接调用 Runtime。
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

- **受理事务：** Core 在 Agent 容量与 Conversation 锁定的用例级事务内检查当前资格和等待容量，保存幂等绑定、输入引用、Execution、受理顺序、等待期限、outbox 与必要审计。API 与 Web/渠道命令共用同一 Conversation 锁或等价条件更新边界，锁内按已提交顺序判定等待和占用，不能各自读取空闲快照后同时准入。重复请求先查原绑定，不重复消耗容量；容量满或停止/停用/故障未恢复时拒绝且不创建新任务。启动/更新中允许有界等待，任务提交不隐式启动 Agent。
- **投递：** Worker 认领持久工作项；Dispatch 只允许同 Conversation 最早的可执行任务占用 Turn，并在 Agent 经验证的并发能力内调度不同 Conversation。准入须重新检查当前授权、能力、平台运行状态及对应 Workload 就绪事实；启动/更新中仍等待，停止/停用/故障则终结确认未投递的等待任务并记录原因。状态变更与准入的原子边界、已占位但未发送和已在途任务的收敛由 Runtime HLD §8.4 定义。认领租约、修订/fence 与事务条件防止双 Worker 重复投递。等待期限由平台配置，在重启后沿用；只对确认未投递的到期任务明确失败。RuntimeHost 管理原生 Turn，不再维护另一套用户排队状态。
- **入口差异：** 等待中的 Execution 还没有活跃 Runtime Turn。API 后续任务排队不改变 Web 的补充指令/繁忙语义；Web 与 API 均通过同一 Conversation 串行准入，后续新 Turn 不能越过已受理任务或改写其他主体上下文；对当前活跃 Turn 的合法补充指令仍按 Web 规则处理。
- **取消：** 未投递任务在与认领互斥的事务中终结，Worker 不能继续启动；投递或接受结果不确定时，先核实原操作。运行中持久保存取消请求、停止工作项和平台规定的停止确认期限，确认停止后才标记已取消。确认超时转为非终态的待核实，保留原操作并沿 Runtime HLD 的查询/屏障恢复；无法自动收敛时由运维按受控恢复流程处置，不能人工猜测完成或直接释放占用。未确认或待核实状态占住该 Conversation，下一任务不能启动；期限不因重复取消或 Worker 重启延长，也不是调用方可设的任务执行时限。
- **恢复：** API/Worker 重启重新认领未开始工作，沿原执行查询 Runtime 接受状态与 Session。已运行任务能恢复则沿原身份继续，确认不可恢复则明确失败；无法确认时标记待核实并阻止受影响 Conversation，不能新建 Session 或重放可能有副作用的任务。结果与审计恢复均按原操作引用去重。

RuntimeHost 命令、租约/fence、原生 Session 和事件字段继续由 [Runtime HLD](HLD-agent-runtime-M1.md) 细化；API 的持久等待属于 Platform Dispatch，不把排队义务下推到 Driver。

## 13. Connection 架构

### 13.1 独立直连与权威边界

按 [平台 Connection PRD](../prd/PRD-agent-platform-M1.md#9-connection-集成)，Agent 或客户端直接调用独立 Connection MCP/API。Connection 负责自己的用户/应用身份、客户端访问凭据、Grant、外部账号、Provider/Action、原始凭证、外部调用和审计。Platform 不代理调用、不签发 Connection 代调用证明、不维护其目录、授权或状态/审计投影；应用在 Connection 独立获权，不继承自然人责任人的权限。

Platform 仅记录自己的任务、模型和工具执行事实。Connection 访问凭据与 Platform API 凭证分别管理；外部账号原始凭证只由 Connection 的受控执行路径使用，不能进入 Agent、模型、浏览器或 Platform DB。平台 Runtime Execution Grant 不参与 Connection 的授权判定。

后台 Agent 的工具执行同样使用原用户或应用在 Connection 独立取得的客户端访问凭据；Pod/workload 或 Platform 服务身份不提供替代授权，凭据缺失/失效时拒绝直连，不回退到 Owner 或应用责任人。直连客户端执行 [PRD 第 9 节](../prd/PRD-agent-platform-M1.md#9-connection-集成)的凭据主体隔离和内容排除规则，并验证其他主体及模型无法取得凭据；客户端凭据的签发、交付及撤销由 Connection HLD 定义，不新增 Platform 签发的执行授权协议。

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

Runtime callback/client 的准备契约边界见 [Runtime HLD §9.1](HLD-agent-runtime-M1.md#91-codex-独立-connection-consumer-profile)。
其 bootstrap/provenance 投影校验不构成 Connection conformance；真实 HTTP/MCP 接入仍须满足
Connection HLD 的 ConsumerInstance 安装绑定、sender-constrained token 或获准 PAT 规则。

可信采集在发起工具调用前绑定原 Execution、操作和尝试，并从同一次经过服务端认证的 Connection 请求/响应中取得由 Connection 生成的原调用引用。引用须能在 Connection 自身授权下核实其服务端解析的调用主体、操作和真实记录；受信采集再核对该记录确实属于本次请求。难以猜测的引用、签名、同一主体或相近时间都不能单独证明执行绑定，也不能接受模型或客户端从其他任务转交的真实引用。重试核实只查询原记录，不再次执行 Provider 操作；缺失任一侧证据保持未核实。

Connection HLD 的 [§5.2](HLD-connection-M1.md#52-consumer-与-instance) 与 [§7](HLD-connection-M1.md#7-mcpapi-调用流程) 定义独立客户端的安装绑定、身份解析和调用准入；[§11](HLD-connection-M1.md#11-审计与跨系统关联) 定义真实调用关联与分别授权查询。Runtime HLD 的[身份上下文](HLD-agent-runtime-M1.md#9-runtime-身份上下文)定义原执行 slot、受保护 FD3 交付及真实 MCP leaf 的可靠采集；这些字段不构成 Platform 签发的 Connection 授权。Platform API/Worker 不为核实建立 Connection 代理或获得 Connection 查询凭据，也不签发供 Connection 授权的上下文。平台只接收受信采集产生的关联引用与核实状态；Connection 调用详情仍在其独立授权入口查询。

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

企微 Adapter 位于平台侧，绑定体验以[平台 PRD §10.2](../prd/PRD-agent-platform-M1.md#102-渠道绑定)为准。
平台只为四个标准模板和通过 Generic ACP 验证的 `platform-adapter` 自定义 Agent 创建企微绑定；
`self-managed` Agent 的绑定请求在保存前拒绝。

#### 14.2.1 配置与凭证

智能机器人默认使用 WebSocket 长连接。Owner 扫码授权或手动提交 Bot ID、Secret，
两者调用相同的 Core 配置用例；服务端生成渠道引用并复用 Agent 配置的版本、绑定和审计权威。
浏览器表单不要求用户填写内部 `bindingReference`。扫码优先复用企微授权 SDK，手动配置作为独立入口；
部署提供获准的 `source` 与固定官方授权 origin，不能由普通请求指定授权端点。

配置会话绑定当前 Owner、Agent、配置版本及一次性短时随机 state；验证弹窗 origin、source、state、
过期和一次消费，防止跨用户、跨 Agent、重放及旧配置覆盖。SDK 的成功回调不是平台授权或凭证有效证明，
激活前仍由 Core 重验 Owner 权限和当前配置版本，由 Worker 验证企微认证。配置失败或取消保留原有效绑定。
若认证探测会争用正在使用的机器人连接，先展示影响并取得 Owner 确认，不能以“验证”名义静默接管。

企微 Channel 凭证属于 Platform 的渠道接入，不属于 Agent 运行时 env/Secret 或 Connection 外部账号。
Bot Secret 与应用发送 Secret 按既有平台应用层加密规范由 API 只写密文，Worker-only keyring 解密用于连接/发送；
密文用途绑定 Agent、渠道和配置版本，不走会向 Agent Pod 投射 Secret 的路径。
官方扫码返回及手动输入的 Secret 只在本次提交中短暂存在，提交后清除；不得查询回显、写浏览器持久存储、
URL、日志或审计。Agent、模型和 Runtime 均不得获得渠道凭证。

自建应用单独校验企业 ID、应用 ID、应用 Secret 和接收消息的 Token、EncodingAESKey、TLS 回调地址。
应用主动发送凭证不能代替接收消息配置；启用自建应用或显式机器人回调模式时才要求可达的 TLS 回调。
回调 Token、EncodingAESKey 是 API 校验/解密入站消息所必需的独立材料，由部署的可信绑定解析器按获准绑定
受限注入 API，不从 Worker-only 密文库解密，也不通过 API–Worker RPC 获取。
API 不因此获得 Bot Secret、应用发送 Secret 或历史回复路由的解密私钥；回调校验材料亦不得进入用户查询、
日志或 Agent Pod。部署注入仅提供协议验证能力，不替代 Core 中的绑定与业务授权。

#### 14.2.2 传输与执行

1. `platform-worker` 的企微 Adapter 优先使用固定版本官方 Node SDK 建立、认证并维护长连接，
   SDK 负责协议与心跳/有界重连，业务授权、持久化和投递语义仍由平台负责。重连不等于重放业务发送。
   同一机器人只有一个有效连接持有者；复用 PostgreSQL 租约/隔离令牌，在多副本、重启、解绑和轮换时
   关闭旧连接、隔离旧持有者，防止连接互踢和重复副作用，不新增渠道微服务。
2. 长连接入站验证已认证连接的机器人身份、帧结构、大小、有效期和稳定消息标识，不能信任任意帧自报的身份。
   自建应用与显式机器人回调由 `platform-api` 验证签名、加密接收方、有效期和大小；
   两类传输统一转换为 Core 命令，不向 Core 传递 SDK 对象。
3. 通过部署身份边界把企微发送者映射为公司稳定用户 ID，校验当前身份、组织、Agent 可用范围和绑定。
4. 按单聊、群聊和协议支持的线程生成稳定的 Conversation 映射，键包含 Agent、绑定、渠道及服务端发送者；
   同群不同发送者保持独立 Runtime Session，协议无独立线程标识时不伪造线程支持。
5. 复用同一事务保存消息、Execution、授权边界、outbox 与回复意图，由共享 Worker 通过 RuntimeHost Client
   投递 Agent Pod 内的固定 Driver。重投/重连按稳定事件 ID 去重，变更同 ID 的内容、主体或绑定则拒绝。
6. 回复前再次校验当前身份、绑定和权限，沿获准协议发送。长连接回复不依赖 HTTP `response_url`；
   发送前记录意图，ACK 丢失或断连后保留 `unknown`，不得自动重发或将服务端受理宣称为终端送达。
   协议不支持可验证恢复时保留有界处置；失去有效回复上下文时明确失败/过期。
7. 需要外部操作时由 Agent/客户端直连 Connection；Connection 独立验证触发消息发送者已授予的调用权限，
   不能使用其他群成员的授权。渠道传输变化不得绕过既有授权或新增 Runtime 调度器。

SDK 默认日志、debug 和重试行为必须验证，不照抄输出凭证或正文的示例。审计与指标覆盖绑定、凭证替换、
配置会话、连接状态、受理及回复，保持固定标签和脱敏投影。
群聊、线程和附件映射由 Channel 层负责，RuntimeHost/Driver 不感知企微身份或自行改变映射。
四个标准模板和通过 ACP 验证的自定义 Agent 使用同一执行链路；Web 与企微会话不合并。

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

文件服务属于 Platform Module。`platform-core` 决定授权、幂等、绑定和生命周期；Platform DB 是元数据权威；`platform-api` 负责认证与有界流式数据面；`platform-worker` 负责执行期访问签发和有界对账。窄 `ObjectStorageAdapter` 同时提供 Fake 和 S3 兼容实现，部署 SDK、bucket、endpoint、role 和凭证只存在于 Adapter 与装配层。Core、Store 和公共 Schema 不接收文件字节或部署位置。

#### 15.4.1 文件记录与写入

- 平台分配稳定 `fileId` 与不透明对象引用，保存 `attachment`/`result`、owner actor、Agent、Channel、Conversation、适用的 Message/Execution 与 Session generation、原始文件名、媒体类型、大小、SHA-256、对象版本/etag、状态和时间。对象引用不能由调用方选择，也不能跨绑定重用；对象存储中的键由 Adapter 根据平台分配引用生成。
- 上传意图以 actor/Agent/Channel/Conversation、种类、适用 Execution 和 `Idempotency-Key` 唯一绑定完整请求摘要。相同请求返回同一文件，内容或绑定冲突拒绝。输入附件在关联 Message/Execution 前保留空关联；关联是同一 owner/Agent/Channel/Conversation 内的单次绑定，不能把已绑定附件改绑给另一执行。
- 文件服务通过部署装配的可信 capability reader 获取目标 Agent 已验证能力、Channel 限制及部署允许类型/大小；以当前配置修订和探测版本绑定，取三者交集。缺失、过期、未验证或空交集拒绝上传/结果分配。独立 `FileLimitsV1` 契约返回该交集及版本，供后续 Web/Channel 在上传前展示并拒绝超限、Runtime 在接收前执行同一限制；本票不把配置布尔值当作类型/大小声明。历史读取不因当前上传 capability 关闭而失效。
- 写入仅在当前 capability、媒体类型与大小限制内开放。数据面限制字节数、持续时间和并发量，流式计算 SHA-256；S3 写入使用条件创建，已存在对象不覆盖。完成确认读取实际对象的固定版本/etag，重新验证媒体类型、实际大小和内容 Hash 后才将记录变为 `available`。调用方声明或 S3 metadata 不能独立证明内容 Hash 或媒体类型；Adapter 根据实际字节核验允许格式，无法确认的格式拒绝，不提供任意二进制类型回退。
- 文件状态为 `pending`、`available`、`failed`、`expired`、`deleting`、`deleted`。对象已写但响应丢失或提交未知时保持原意图，沿同一对象核实；存储不可用不解释为对象缺失，不把 unknown 当成功。已确认文件的完成重放返回原结果；它不再授予写入权。对象版本不可确认或实际内容不匹配时不得引用。

重新生成可通过当前 Execution 的新 Grant 读取原 Message 附件，不修改文件的原始绑定；旧 Grant 或旧 generation 不能因此恢复有效。

#### 15.4.2 认证数据面与短期授权

- 文件服务先持久保存对象/操作/主体/时间/限制绑定的 access 记录，再由部署可信签名器产生独立 `FileAccessGrantV1`（compact JWS、EdDSA、受信 key version）。签发方是配置固定的 Platform 文件授权服务，唯一 audience 为 `platform_files`；`purpose=file_access` 与 Execution Grant 用途显式分离。验证器只接受部署登记的签发方、key 和 audience。
- Claims 绑定 `accessId`、`fileId`、actor、Agent、Channel、Conversation、`read`/`write`、签发/过期时间、最大字节数；执行用途另绑定 Execution、Session generation 和原 Execution Grant 引用。签名器仅消费 Core 已提交的 access 记录，不能接受 Runtime 自报 owner、对象键或任意 claims。数据库保存该记录及 key version，不保存 JWS 或可复用 URL。
- 浏览器取得平台相对数据面路径和独立短期 Grant；Grant 只通过专用请求 Header 传输，不写入 URL、业务历史、日志或审计。每次实际使用同时解析当前用户会话/有效 API 凭证并比较持久主体和全部对象/操作绑定；同一 URL 或 Grant 被其他主体持有也不能使用。读写、完成确认和续签重新检查当前授权；Owner/应用责任人角色不授予内容读取权。Eval 文件另走独立用途授权。
- 执行期访问生产者由可信 Worker 调用 Platform API 的 `/internal/v1/files/exchange`：请求携带原 Execution Grant 及所需单一输入引用或结果描述，且须通过部署服务身份认证；后续 RuntimeHost 文件桥接可复用同一受认证客户端。部署仅向受信 Worker/RuntimeHost 配置服务凭据，并固定映射其允许访问的 Agent 集合；两类组件不具有不同的文件操作权限，请求 Header/Body 不能选择或扩大该映射。Platform API 的文件授权服务是新 File Grant 的唯一签发边界；先验证原 Execution Grant 的签名、配置 issuer 与既有 `runtime_host` audience，原 Grant 只作为执行委托范围的输入证明，不能独立认证交换或直接访问数据面。交换同时检查可信服务身份允许的 Agent 及持久执行状态；不修改旧 Grant 的 audience 或操作含义。再按持久 Execution、Conversation、当前主体/Agent 权限、Session generation、已验证 capability 与限制授权。输入仅可为该 Grant 精确列出的 `attachmentId + read` 签发对象访问；结果先通过文件 Core 分配 execution-bound 文件，再签发仅该对象的 `write` 权限。现有 `ExecutionGrantClaimsV1`、其 audience 和只读附件范围不变，不能用旧 Grant 直接调用文件数据面或凭服务身份签发写入。
- RuntimeHost/Worker 消费新 File Grant；执行数据面还须通过部署提供的服务身份认证，身份绑定受信 RuntimeHost/Worker 与目标 Agent，不能仅凭 Grant bearer 请求访问。数据面重新验签并查询当前 Execution、主体授权及 generation；终态、取消、撤权、过期、代次变化或对象/操作不匹配拒绝。历史读取走当前主体的历史权限，不要求 Agent 正在运行，也不能用过期执行权限读取。控制用途 Grant 不允许文件操作。
- 数据面在授权后由服务端流式访问对象存储；S3 预签名能力只用于服务端内部请求，不返回或重定向到 S3 bearer URL。读取固定版本并检查 etag；写入完成前再次授权，过期/撤销的写入即使产生对象也不能成为可见文件。数据面依赖错误只返回受限代码，不暴露对象存在性、内部 URL、证明或凭证。

#### 15.4.3 消费、恢复与清理

- 新文件 API 和 File Grant 使用独立 V1 Schema、生成的 JSON Schema/OpenAPI 与客户端；不改写既有 Browser、RuntimeHost、Execution Grant 或 `result.file` V1 的含义。后续消费者通过 `fileId` 复用已有附件引用/事件，不能手写第二套文件 DTO；Worker 持久化 `result.file` 前必须核对同一执行中已确认的 `available` 结果记录；事件 `name`、`mediaType`、`sizeBytes` 必须与该记录一致，Runtime 返回值不能成为第二元数据权威，不一致拒绝持久化。
- 正式文件与引用按部署数据政策保留，停止、重启、升级和停用不删除合法历史。平台不新增产品级保留期限、用户删除或导出能力。上传期限、临时访问期限和对账批量是部署资源限制，不能作为正式文件保留策略。
- 对账持久记录处理游标与重试状态，有界处理过期意图、失败对象及本部署文件命名空间中的孤立对象；删除须在状态检查后限定到目标版本，重试不影响其他对象。写入与清理通过状态和租约隔离；清理失败保留 `deleting` 并有界重试。对象写入最晚期限及未完成写入的收敛窗口结束前不遗忘其记录，迟到写入须再次核实清理。
- 文件服务本身提供 Worker/RuntimeHost 的访问生产者与数据面契约；Web 控件、企微媒体映射、具体 Driver 文件桥接和四模板文件 E2E 属于后续整装，不在基础文件服务中伪装为已交付。

权衡记录见 [认证文件数据面与独立执行期文件授权](../adr/0010-authenticated-file-data-plane.md)。

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
- API 创建和任务受理将上述幂等绑定、请求摘要及返回对象引用与业务对象、outbox 和必要审计保存在同一事务；任一写入失败全部回滚。事务提交后的响应丢失或进程重启仍沿原绑定返回结果；原操作仍可能执行或结果待核实时不能回收绑定或复用键创建新操作。
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
- 用户/应用 API 契约覆盖可信主体、凭证范围/失效、独立初始授权、创建受理后部署失败仍可管理、跨主体及 Owner/责任人越权拒绝、仅有凭证管理权时签发/轮换/交付不能取得应用凭证、SSE 撤权关闭；Runtime Grant 或 workload 身份不能充当 Connection 凭据。
- 直连关联契约验证真实调用与原执行的绑定、伪造关联拒绝和两侧独立查询权限；覆盖同一主体/Agent 下不同任务的真实调用引用调换、响应丢失与核实重试，不以相同调用方字符串或可转交的真实引用证明关联。
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
| 企微渠道 | Owner 扫码/手动配置、连接状态和解绑 | 机器人长连接、自建应用/显式回调校验、身份映射、Channel 会话键、消息持久化及回复 |
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
  `agent-runtime-host`、`custom-agent-base`。复用本次 CI 构建的最终运行镜像，以 Docker image ID（Docker
  存储后端的不可变 SHA-256）及 rootfs layers 绑定 OS 与应用扫描；此 CI 扫描步骤不发布镜像。
  镜像发布使用独立的 [release 入口](../../deploy/README.md#不可变镜像与-release-检查)。新增
  Dockerfile 必须同步覆盖清单。Connection 此项仅提供 HLD §14/§16 的镜像证据，不替代其 Pilot 门禁。
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
5. **渠道、自定义 Agent 与 Builder：** 企微 Channel、Runtime Manifest、自有交互入口 Auth Gateway、Connection 授权的 Builder、受控 Build Service 和 ACK 可部署性验证。
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
8. 首个受监督 GitHub Pilot 使用两个测试 Principal、两个专用账号和一个受控 private 仓库完成 Direct MCP OAuth、Consumer/Actor Grant、三项 Action、真实 PR、幂等、审计和撤销；Connection 独立身份与 Grant 任一失败都拒绝调用，伪造关联不成立且两侧审计分别鉴权查询，结果只适用于具名环境和固定镜像。
9. 负载与故障测试中，所有消息都有可解释状态，企微群聊会话按发送者隔离，不出现静默丢失、重复 Turn 和跨用户数据混用。
10. Web、API、Worker、RuntimeHost 和 Delivery 只通过版本化 Contract 与窄 Port 汇合；架构测试阻止应用入口、Drizzle/Kubernetes 对象和部署产品类型进入 `platform-core` 或 wire contracts。
11. Web/API 位置无关，只有 Kubernetes Workload Plane 中的 Worker 持有 namespace-scoped Kubernetes authority；部署在现代 GA API 上通过生命周期、安全和失败恢复验证。
12. 用户/应用 API 无审批完成创建与初始授权、启动/停止/重启、任务受理/查询/订阅/取消；同会话串行、等待有界、幂等稳定，凭证失效与主体撤权各按产品规则生效。
13. 四模板有真实模型/工具观测与任务关联，采集缺失和故障如实呈现；运行后端覆盖服务/任务/依赖并验证告警，恢复不重复计数。
14. 审计 API 与基础管理页完整覆盖治理、执行和 Eval；必要审计与状态可靠保存，外部意图先记录，查询故障不显示空结果，记录不随 Trace 采样丢失。
15. 固定集基线/候选真实对比，支持规则/人工/模型评分、逐例分析、复核和新版本再跑；分母/覆盖/评分故障及独立反馈可见，Eval 用途授权与数据生命周期有正负向验证。
16. Builder 仅通过现有对话式 Web 和 Connection 授权工作；构建任务具备独立工作区、资源/网络/隔离上限、目标 ACK 架构约束、脱敏审计和取消清理语义。所有服务镜像成功推送并取得不可变 Digest 后才创建 Agent；Registry 路径使用服务端生成的不可变 Agent/Service ID；失败、取消或创建回滚按构建批次清理未绑定 Digest，后台 GC 兜底。核心能力缺失阻断发布，可选或不确定能力按用户确认规则处理，真实构建与 Registry push 证据齐全后才能宣称验收。

## 25. 评审结论记录

团队评审应围绕以下已选方案提出异议或确认，不在同一轮扩展 Roadmap 范围：

- 全 TypeScript 是否满足平台与运维团队的长期维护能力。
- TypeScript Kubernetes 调谐器的测试与值班责任是否可接受，部署是否提供受支持的现代 Kubernetes capability baseline。
- OpenConnector 固定 allowlist Kernel 的维护归属、来源验证和必要时建立最小 Fork 的批准方式。
- 部署的 IdentityAdapter、ImageRegistryAdapter、ModelCatalogAdapter、对象存储、加密公钥/Worker-only 解密 keyring 注入和企微 Adapter 是否满足本文 conformance。
- Codex 采用官方 upstream release provenance；普通官方路径不强制假设私有 vendor barrier。需要私有 FD callback、Connection bootstrap/recovery 或等价 native lane 时，必须有不可关闭且可回读的 barrier，并在缺失时 fail closed；不恢复第三方源码补丁、vendor builder、派生二进制或下载编译流程。该纠偏以 [#678](https://github.com/AgoraIO-Extensions/agent-infra/issues/678) 的已确认架构方向为依据，具体实现仍须走独立评审。
- Runtime callback/client 的准备契约与真实 Connection 接入按 [§13.2](#132-调用与审计关联) 分别验收；不得以准备层通过替代 Connection HLD 的独立授权门禁。

产品行为或 M1 范围变化先更新 PRD。任何改变部署单元、权威数据归属、身份传递、Secret 模型、Kubernetes Workload Plane、Connection 授权、RuntimeHost 或 Agent Runtime Contract 的修改先更新工程 Spec；同时满足难以逆转、存在真实权衡、未来读者会疑惑时新增 ADR。OpenAPI/SSE breaking change 必须版本化并通过兼容评审。数据库表、索引、UI 结构和 Adapter 内部算法通过普通 Issue/PR、migration 与测试演进，不默认创建 ADR。
