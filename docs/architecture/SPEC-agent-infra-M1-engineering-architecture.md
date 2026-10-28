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

本文不改变 PRD 的产品范围。M1 包含用户与应用 API、后台任务调度、运行可观测、模型质量评估与效果分析（Eval）、持久审计、§10.1.1 的 Session-owned Sandbox 隔离、Browser Capability 和 §11.6 的 Skill Hub。Skill Hub 与 Browser Capability 的工程边界见 §11.5–§11.6；平台会话隔离以外的通用 Sandbox 产品能力、多 Agent 协作、知识能力、Agent 删除、Webhook、定时任务和主动通知仍在 Roadmap。

## 2. 架构结论

M1 的自有产品与控制代码采用全 TypeScript 单仓库，使用 Better-T-Stack 初始化基础工程。Better-T-Stack 只负责生成工程骨架，不作为运行时依赖，也不决定领域模块的接口。Codex 使用固定官方 release，由 Native Driver/Adapter 消费上游能力；第三方源码、私有接缝与执行屏障的边界见 [10.11](#1011-codex-上游原生补丁与执行屏障)。

CI 的 PR-Agent 直接使用官方 GitHub Action，仅启用 Review 与 Suggestions；不维护自有
PR-Agent 脚本、上游补丁或派生 runtime。配置与权限边界见
[Workflow Spec §7.3](SPEC-ai-native-development-workflow.md#73-automated-pr-review)。

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

Web 页面中凡 shadcn/ui 提供的可复用交互、导航、反馈或表格组件，均使用项目的 `components/ui` 实现，无业务页面例外。Base UI 原语只允许在 shadcn/ui 组件内部使用；语义内容标签和业务状态逻辑不属于组件替代。

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

选择 `auth=none` 是为了不引入第二套框架认证协议。仓库提供第一方 LDAP IdentityAdapter，Platform Core 仍只消费可信 IdentityContext，其他部署可替换 Adapter。独立 Connection 按其 HLD 登录，不复用 Platform 浏览器会话。选择 `api=none` 是为了避免同时维护 tRPC/oRPC 与 OpenAPI 两套契约；M1 的浏览器接口、内部接口和 Agent Runtime Contract 统一以 HTTP/OpenAPI 为主，SSE 事件单独定义 Schema。

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
    PA --> IDP[LDAP IdentityAdapter]
    IDP --> LDAP[Company LDAP]
    PA --> DIR[Enterprise Directory Sync]
    DIR --> DD[(Directory Snapshot DB)]
    DIR --> QW
    PW[Platform Worker] --> PD
    PW <-->|智能机器人长连接| QW

    PW --> K8S[Kubernetes]
    K8S --> AP[Agent Pod]
    PW -->|RuntimeHost Client / HTTP + SSE| AP

    AP -->|独立身份 / MCP + API| CA
    CA --> CD[(Connection DB)]
    CA --> LDAP
    PA -.->|写入版本化 Secret 密文| PD
    PW -.->|读取 active Secret 密文| PD
    PUB[Deployment Encryption Public Keys] --> PA
    PRIV[Deployment Decryption Keyring] --> PW
    CA --> EXT[外部 Provider]

    AP --> MODEL[Deployment-approved Relay]
    PW --> REG[OCI Registry]
```

### 4.1 部署单元

| 部署单元 | 职责 | 是否保存权威状态 |
| --- | --- | --- |
| `web` | Agent、凭证与应用管理、审批、对话、执行详情、Eval 和审计；可独立静态托管 | 否 |
| `connection-web` | 独立 Connection 中文 SPA、登录和 OAuth/Grant 管理入口 | 否 |
| `platform-api` | 可信用户/应用接入、Agent 与任务 API、权限、业务状态/outbox/审计事务、SSE、企微配置与回调、Eval 管理和查询；部署位置无关 | 否 |
| `platform-worker` | Kubernetes Workload Plane 中的 Workload 调谐、模板升级、outbox 认领、有界任务投递、RuntimeHost Client、企微长连接与回复、Eval 执行/评分工作项 | 否 |
| `enterprise-directory-sync` | 每日同步企微员工和部门，原子发布完整、带版本与有效期的目录快照；通过内网受控接口供 Platform 查询 | 否 |
| `connection-api` | 独立登录与客户端身份、MCP/API、Provider/Action、OAuth、Grant、凭证、外部执行、恢复和审计 | 否 |
| `agent pod` | 标准模板与 `platform-adapter` 按 Session-owned Sandbox 运行 RuntimeHost/Driver；`self-managed` 保持自有服务边界 | 仅保存所属运行实例的自有数据 |
| `platform database` | Agent、Owner、范围、管理员手动禁用、应用/API 凭证及授权、个人和 Agent 默认 Relay Key 密文、审批、配置、会话、执行、Eval、反馈和平台审计 | 是 |
| `directory snapshot database` | 企微员工与部门的已确认完整快照、同步版本和有效期；不是 LDAP 身份或 Platform 授权权威 | 是，仅对目录快照 |
| `connection database` | 独立身份与客户端授权、Grant、Provider/Action、外部账号、加密凭证、OAuth 状态、调用/效果和审计 | 是 |

`platform-api` 与 `platform-worker` 使用同一平台领域模块，但以不同进程部署，并通过 Platform DB 状态与 outbox 协作；除下述 `native_metadata_read` 例外外，不建立直接 RPC 依赖。Web 和 `platform-api` 的部署位置不受 Kubernetes Workload Plane 限制；只有 `platform-worker` 获得目标 Kubernetes namespace 的 API 权限。Connection 使用独立数据库和数据库账号；两个数据库可以位于同一 PostgreSQL 集群，但不能跨库直接读写。

仅 [§9.3.1 的 `native_metadata_read`](#931-原生元数据读取授权) 可使用受认证内部 HTTP，
承载 API→Worker 的一次读取投递，以及 Host→Worker→承载原 Request 的 API 实例的在线当前确认。
Worker 保持唯一证明签发与投递方；Host 不直接查询 Platform DB 或 IdentityAdapter。
该通路只服务于同一原 Request 及其可信绑定的 API/Worker/Host 实例关联；服务身份和实例映射由可信部署装配固定，
不能接受调用方回调 URL、任意 origin 或通过负载均衡猜测原实例。
原请求终结、当前确认不可核实、关联丢失或任一关联实例重启使本次读取永久失效，不恢复、续期或复用旧允许结果。
原用户凭证只留承载原 Request 的 API 内存，不进入内部 wire、DB、journal、日志或遥测。
当前认证、读取政策、原持久范围、固定期限、逐相关 await 与响应 bytes 前的复核均遵循 §9.3.1，不能用服务身份替代读取权。
任务调度、Execution/Session/Turn 创建和 control/recovery 仍通过 Platform DB/outbox，不能使用此通路；
metadata 读取不写任务、恢复、fence 或 Key 状态，也不新增持久授权或消息状态机。

目录服务与 Platform 同集群部署，经内部受认证服务边界通信，可使用同一 PostgreSQL 集群的独立数据库账号。它不读取 Platform 或 Connection 数据库；Platform 不把同步快照当作 LDAP 账号状态。Connection 的单一账号级权威和独立 Web 部署取舍分别见 [ADR: Connection 使用单一账号级权威](../adr/0005-use-one-account-backed-connection-authority.md)与 [ADR: 独立部署 Connection Web](../adr/0006-deploy-connection-web-independently.md)。

### 4.2 不拆分的部署单元

M1 不单独部署审批、企微渠道、审计、附件、任务调度、Eval 或模型配置微服务。这些能力作为平台领域模块存在，由 `platform-api` 或 `platform-worker` 调用。企微目录每日同步有独立的数据来源与快照完整性职责，因此使用上表的独立服务；它不处理机器人会话或 Agent 任务。

## 5. 单仓库结构

Connection 服务源码已迁至独立私有仓库 `AI/agora-connector`。本仓库保留 Agent 平台及其
Connection consumer 集成、共享 Wire 契约和部署配置，不再构建或启动 Connection 服务。
Connection 的身份、授权、数据和独立部署边界保持不变，其服务端实现与发布由独立仓库维护。
下图只列本仓库维护的模块；其他章节中的 Connection 服务职责仍描述跨系统契约。

```text
agent-infra/
  apps/
    web/                     React SPA
    platform-api/            Hono HTTP API、SSE、企微和查询入口
    platform-worker/         调谐、outbox、RuntimeHost Client、投递和 Eval 工作项
    enterprise-directory-sync/  企微目录同步服务入口
    agent-runtime-host/      Agent Pod 内的薄 RuntimeHost 进程入口
  packages/
    platform-core/           单一深 Platform 领域 Module、Use Case 与 Port
    contracts/               Wire-only OpenAPI、内部 HTTP、SSE 与 RuntimeHost Schema
    platform-store/          用例级事务 Port 的 Drizzle/PostgreSQL Adapter
    identity/                Platform IdentityAdapter、IdentityContext 与测试 Fake
    enterprise-directory/    企微快照、完整性与内网读取契约
    enterprise-directory-store/  目录快照的 Drizzle/PostgreSQL Adapter
    image-registry/          ImageRegistryAdapter、OCI Digest/Manifest 与测试 Fake
    secret-store/            版本化 AEAD 密文、DEK 封装与密钥轮换
    model-catalog/           ModelCatalogAdapter 与模型端点政策
    agent-runtime/           RuntimeHost 深 Module、固定 Driver 和 Conversation Contract
    kubernetes-runtime/      KubernetesRuntimeAdapter 与部署路由 Adapter
    observability/           Trace、Metric、日志和关联 ID
    test-support/            Fake Adapter、fixture 和契约测试工具
  migrations/
    platform/
    enterprise-directory/
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
| Agent Access | Owner、员工/组织范围、管理员手动禁用、应用与责任人、API 凭证范围/失效、显式授权及当前权限交集 | LDAP 员工身份、企微目录快照、Connection 授权 |
| Agent Configuration | 模板、自定义镜像、交互模式、自有交互入口身份责任、env/Secret、个人与 Agent 默认 Relay Key、模型、渠道和已验证的集成能力 | Relay 路由和 Connection Provider 凭证 |
| Builder / 多服务 Agent | 普通 Agent 通过现有 Connection 读写 Repo；平台准入受限的多服务资源描述、Digest 版本和最终部署资源 | 用户业务授权、Connection 凭证、生产合并与发布决定 |
| Conversation | 会话、消息、回答版本、思考过程、附件引用、执行事件和历史查询 | 模型未公开的推理（加密内容、签名或被隐藏的思考） |
| Agent Dispatch | API 有界受理/等待与投递、幂等、取消/恢复、Web 繁忙与补充指令 | Runtime 内部执行算法、通用调度服务 |
| Channel | Web、API、企微的主体、会话与附件映射 | Runtime 原生 Session 和协议语义 |
| Platform Audit | 治理、API/执行/Eval 元数据、持久审计与受控查询 | 会话正文、Connection 状态或审计副本 |
| Evaluation | 评测用途授权、版本化数据集/标准、实验/逐例评分、对比、人工复核与主动反馈 | 第二套任务调度、自动导入线上正文 |

### 6.2 Connection 模块

Connection 在自己的 Core/Store/API/Web 中负责客户端身份、Provider/Action、外部账号与凭证、授权、执行、恢复和审计。Platform 只消费独立入口与真实调用的关联信息，不维护这些模块的目录、状态或授权投影。内部模块和 wire contract 由 [Connection M1 HLD](HLD-connection-M1.md) 维护，系统边界见第 13 节。

### 6.3 Adapter 接口

以下位置必须形成明确接口，并至少提供部署 Adapter 或项目实现，以及测试 Fake：

- IdentityAdapter 与可信 IdentityContext；仓库提供第一方 LDAP 实现和测试 Fake。
- 企微目录服务的版本化、受认证快照读取契约与测试 Fake。
- ImageRegistryAdapter、OCI Digest 与 Runtime Manifest 准入。
- RepositoryConnectionAdapter 与受控分支/工作区操作；Builder 只能通过现有 Connection 授权读取或修改 Repo。
- MultiServiceManifestAdapter 与受限 Kubernetes 资源描述、入口服务、规格档位和最终资源准入；镜像由仓库已有 CI 或用户自己的构建流程提供并按 Digest 固定。
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
| 企微目录快照内部 HTTP/OpenAPI | 目录服务，Platform 消费方评审 | [#889](https://github.com/AgoraIO-Extensions/agent-infra/issues/889) |
| RuntimeHost/Driver wire Schema | Codex Runtime，Worker 消费方评审 | [#181](https://github.com/AgoraIO-Extensions/agent-infra/issues/181) |
| Registry、Secret、Kubernetes Workload 与 Runtime Manifest Contract | Agent Workload，Core/Delivery 消费方评审 | [#182](https://github.com/AgoraIO-Extensions/agent-infra/issues/182)；OCI admission 由 [#188](https://github.com/AgoraIO-Extensions/agent-infra/issues/188) 实现 |
| Browser Capability declaration、内部 probe 与 conformance artifact | Runtime/Workload，#1252/#508/#992 消费方评审；Platform/API projection 后续接收 | [#1370](https://github.com/AgoraIO-Extensions/agent-infra/issues/1370) |

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
- 对话时间线使用独立 reducer 合并持久化消息、SSE 增量和重连补发事件。命令受理、回复结束或 `timeline.reload` 后重新读取会话详情时，新首屏与已加载事件按 `eventId` 有重叠，就保留重叠之前已加载的更早事件，已显示的回合不因首屏窗口收窄而消失；没有重叠时无法排除缺口，按新首屏重建。
- 表单使用 Schema 校验；服务端重复执行同一校验，不能信任浏览器结果。
- 不预装全局状态库。只有出现跨路由、非服务端且难以由 React Context 管理的状态后再引入。
- Web 使用 OpenAPI 生成的 TypeScript Client，并通过同一 Contract Schema 校验的 Mock Server 和场景 fixture 独立开发。Mock 必须覆盖正常、无权限、启动中、繁忙、排队、失败和 SSE 重连，不能维护另一套手写假接口。

### 7.3 前端安全职责

前端只负责隐藏无权限入口和展示明确错误，不负责最终授权。普通用户不能获得模型 API Key、Connection 原始凭证、内部 Kubernetes 状态或其他用户的资源标识。

## 8. HTTP 与事件契约

### 8.1 浏览器与用户/应用 API

- 管理和查询使用 OpenAPI 声明的 `/api/v1/*` 或 `/api/v2/*` HTTP/JSON。Agent 申请、审批、配置和管理的 V2 契约不包含旧 Action 配置；V1 管理入口退役时，V1 Conversation 入口仍独立保留。
- 创建、更新和命令类请求支持 `Idempotency-Key`。
- 浏览器与用户/应用 API 遵循 [Contract Schema authority](#64-contract-schema-authority)；生成并提交的 OpenAPI 3.1 是消费者使用的规范来源。
- TypeScript 客户端由 OpenAPI 生成，禁止手写重复的请求/响应类型。
- 文件使用平台签发的短期、认证数据面入口上传/下载；业务接口只传文件引用和元数据。入口与执行期文件授权见 [文件](#154-文件)，S3 预签名 URL 不返回浏览器或 Runtime。

API 契约覆盖 Agent 创建/启动/停止/重启、任务提交/查询/取消、结果订阅、凭证与应用授权、审计和 Eval。产品行为分别引用 PRD [API 身份](../prd/PRD-agent-platform-M1.md#73-api-身份凭证与授权)、[后台任务](../prd/PRD-agent-platform-M1.md#104-agent-api-与后台任务)、[审计](../prd/PRD-agent-platform-M1.md#13-平台操作审计)和 [Eval](../prd/PRD-agent-platform-M1.md#15-模型质量评估与效果分析)。路由只解析可信上下文、校验 Schema 并调用 Core；创建和任务受理返回稳定资源 ID 与持久状态，不能把 HTTP 成功等同于 Workload 就绪或任务完成。

### 8.2 SSE

对话回复和状态流使用 `text/event-stream`：

Platform 的 `task.status` 事实与 Task API 共用状态和受限原因 Schema，原样进入 V2 会话历史、执行详情和 SSE；V1 SSE 完整校验后跳过无法表示的事实并推进原持久游标。Web 将 `unknown` 保持为待核实，只有后续权威终态才能结束执行占位。

- 每个事件包含稳定 `eventId`、`executionId`、Execution 内递增 `sequence`、Conversation 内严格递增 `conversationCursor`、`type`、`occurredAt` 和类型化 payload。
- Runtime 来源事件与 Platform 来源事件写入同一持久化时间线并共享上述排序空间。Runtime 来源必须携带非空 Runtime cursor，且不能写入 Platform 保留事件类型；Platform 来源按 Schema 显式区分任务受理/等待/取消/失败/待核实等状态事件和 `model.selection.fell_back`，其中 Worker 失败与待核实收敛事件在同一 Dispatch 事务内写入并保持空 Runtime cursor，Runtime 终态事件已持久化时不追加（见 [Agent Runtime M1 HLD §8.1](HLD-agent-runtime-M1.md#81-消息与命令幂等)）；模型回退事件绑定接收消息的 Execution、Runtime cursor 为空，payload 只包含实际采用的模型选项、推理强度、固定的受限原因，以及会话原所选选项的 ID 与受理时的显示名。
- 原选项显示名在写入回退事件的同一事务中确定：从不晚于当前已应用配置修订、且包含该选项的最新修订读取原 endpoint/model 关联；部署配置了可信名称时，按该关联解析受理时的显示名，未配置时沿用模型 ID。历史关联或名称无法确认时记为空，之后的配置或部署名称变化不改写已写入的事件。endpoint 标识只在服务端解析名称，不进入公开事件；名称解析不改变原授权与回退选择，也不增加 stop/native metadata 路径的外部依赖。带原选项的回退事件以 `schemaVersion: 2` 进入 V2 混合版本事件历史（V2 Conversation 读取、V2 SSE 与 Task 投影）；只接受 V1 事件的 V1 SSE 仍收到不含原选项的 V1 形状，未记录原选项的旧事件在各读取方保持 V1 原样。
- 标准模板当前选择失效时，`platform-api` 在接受消息的同一 Conversation 事务中写入一条 `model.selection.fell_back`：初始消息和重新生成绑定新建 Execution，补充指令绑定当前活跃 Execution。该事务同时分配下一 Execution `sequence` 和 Conversation `conversationCursor`、推进两个平台计数器并保存对应审计；幂等重放复用原分配，任何一步失败均整体回滚，且不推进 Execution 的 Runtime cursor。
- 思考过程：Runtime 以 `schemaVersion: 2` 的 `reasoning` 事件输出模型提供的原始推理或推理摘要增量（`kind` 为 `raw` 或 `summary`，单条上限与正文增量相同），Worker 保存为 Runtime 来源的 `reasoning.delta`，属于会话正文，只在 Conversation 读取权限内返回。该事件只进入 V2 Conversation 读取与 V2 SSE；V1 SSE 和 Task 投影（任务查询、输出与事件订阅）跳过它但推进持久游标。回答正文、任务输出和企微答案只拼接 `text.delta`。发布时先让 Platform 各读取方接受该事件，再更新 Runtime。决策与边界见 [ADR-0026](../adr/0026-show-model-reasoning-as-conversation-content.md)。
- Web/API 调用方通过 `Last-Event-ID` 或显式游标重连；服务端验证游标属于当前主体有权访问的 Conversation/Execution，任务流不能带出同会话其他任务的数据。
- 会话详情首屏只返回最近的有界事件窗口，「加载更早内容」用 `beforeCursor` 按同一规则逐页向前读取。每页是连续的 `conversationCursor` 区间，由完整 Execution 组成：从最近的 Execution 向前逐个加入，`reasoning.delta` 以外的事件累计达到 200 条时停止，跨过该数的 Execution 仍完整加入；页内事件总数不超过 2,000 条，加入后会超出的 Execution 留给更早的页。最近的 Execution 自身超过总上限时，该页只含它且完整返回，不切断单轮回复。思考增量不计入 200 条，前几轮回答不会被思考过程挤出首屏；总上限约束首屏响应大小。窗口不改变 `conversationCursor`、`Last-Event-ID`、SSE 补发和 `timeline.reload` 语义。
- 服务端先保存事件，再向在线连接推送；断线后按持久化序列补发。事件事务提交后，数据库发出只含 Conversation 标识的唤醒提示，在线连接据此立即从持久化游标读取；提示只用于缩短等待，丢失时按固定轮询送达，不改变持久化、排序和授权规则。
- 心跳只用于保持连接，不进入业务时间线。
- 同一事件可能被重复投递，消费者按 `eventId` 去重。订阅建立、续传和存续期间执行当前主体/凭证授权：每批事件写出前复核一次，空闲期间按固定间隔复核；失效后该批不写出并关闭流，审计订阅起止，不逐条审计输出。
- Web/渠道排队消息的入队、开始处理、撤回、排队超时与取消按 [§12.5](#125-执行中消息的补充指令与排队) 写入平台来源的 `task.status` 事件，与其他事件共享排序、补发和授权规则。排队位次从持久等待顺序派生，不作为可变字段写入事件；浏览器收到队列变化后按同一规则更新位次。

M1 不使用 WebSocket。用户发送消息、停止回复和补充指令都通过普通 HTTP 命令完成；只有出现必须由同一连接双向交换低延迟事件的需求后才重新评估。

### 8.3 内部接口

`platform-worker` 到 Agent Pod 使用遵循 [Contract Schema authority](#64-contract-schema-authority) 的版本化 OpenAPI HTTP 契约；Runtime 增量事件使用由 JSON Schema 校验的内部 SSE。内部接口通过部署提供的服务身份认证，并验证执行授权，不因位于集群内而跳过鉴权。

#### 内部 Runtime 传输与身份

Worker 到 RuntimeHost 使用集群内明文 HTTP，决策与接受的风险见 [ADR-0020](../adr/0020-use-in-cluster-plaintext-runtime-transport.md)。它只约束 Worker 到 RuntimeHost 的集群内传输，不改变 Connection 或 Host/Grant/Driver wire；跨集群、跨 VPC 或经过公网的 Runtime 访问必须使用 TLS 并另行评审。

| 要求 | 机制及边界 |
| --- | --- |
| Worker 只访问获准 Host | 只连接服务端从持久 Workload 或 Session 分配解析出的精确 origin `http://<Service>.<namespace>.svc:<port>`；拒绝其他 scheme、userinfo、query、hash 与 redirect，调用方不能覆盖 origin。 |
| 限定访问面 | Agent 级 Workload 与 Session Sandbox 的 NetworkPolicy ingress 只放行 Worker 选择器；healthz 或 Service 存在不证明隔离。 |
| Host 认证部署调用方 | 继续校验既有 service token；它证明持有部署凭证，不是某个 Worker 进程的私钥持有证明。部署控制其发布、访问、轮换和撤销；Host 所持 token 不能取得 Grant 签名私钥。 |
| Host 核对当前授权与部署 | 保留独立 signed readiness 的 Worker/Agent/revision/fence/Digest 本机绑定；业务及控制 Grant 仍按 [§9.3](#93-服务端授权上下文) 校验签名、issuer、audience、时间、对象、用途和操作范围，继续执行原持久幂等、租约与屏障。 |

明文传输意味着能观察集群 Pod 网络的节点、CNI 或特权组件可以看到 token、Grant、会话正文和执行期交付的模型 Key。捕获的 Grant 不能靠传输层消除重放，必须依赖原用途/对象校验、持久幂等与 fence；token 泄露时在两端撤旧并受控重载。

**沿既有 Service 拓扑。** [Runtime HLD §4.1](HLD-agent-runtime-M1.md#41-内部-runtime-service-映射) 区分 Agent 级 candidate/verified Workload 与业务 Session Sandbox。Agent 级主 Service 和 `-probe` Service 分别承载 business 与 readiness/verified control；Sandbox 只使用其原已批准分配的唯一 Service，不复用 Agent 级路由或擅加 `-probe`。本契约不改变 §10.1.1 或 #1322 的资源合同。

**受信部署输入。** 复用[现有 Worker 部署模块](../../deploy/platform-worker/README.md#配置模块形状)：

| 输入 | 入口 |
| --- | --- |
| 部署代码与身份 | `platformWorker.configurationModuleSecretRef.{name,key}` 只读挂载 `/app/dist/configuration.mjs`；导出 `workloadInput`、`signing`、`serviceToken`。`workloadInput.policy.namespace` 必须与 `PLATFORM_WORKER_NAMESPACE` 一致，Agent 来自服务端持久 Workload，不能从请求、Owner env、模型或 live annotation 获取。 |
| token 与 Grant | `platformWorker.runtimeAuthSecretRef.{name,privateKeyKey,serviceTokenKey}` 向 Worker 提供 `/var/run/agent-infra/runtime-auth/{runtime-grant.pem,service-token}`；Host 通过 `policy.runtimeAuth.serviceTokenSecret.{name,key}` 的 `secretKeyRef` 得到同一 transport token。保留 `WorkloadRuntimeAuthV1` 原五字段 `workerId/grantKeyId/grantPublicKey/grantIssuer/serviceTokenSecret`；签名私钥仅在 Worker，Host 只得到公钥和预期身份。 |

`platformWorker.trustedCaSecretRef` 继续作为 Worker 访问目录、Registry 等 HTTPS 依赖的附加信任入口，不用于 Runtime 传输。部署不签发 Runtime CA 或 server leaf，Runtime Pod 不挂载 TLS Secret，kubelet readiness 使用 HTTP。

**迁移。** 旧 TLS Pod 在新期望 Pod 规格下判定为 drift，由既有 fenced 调谐替换，不保留双栈或 HTTPS 兼容层。替换期间沿原受权持久流程停止新准入、核实原执行；旧控制不可达时保持 pending/unknown，使用原 Kubernetes fenced closeRoute、scale-zero 和 ownership cleanup 权限收敛，不重放副作用。

**验收。** business、control、readiness 和 Session 路由均覆盖非精确 origin、redirect、userinfo/query/hash、无效 token 和跨用途/主体/Agent/对象的 Grant；分别验证本机 revision/fence/Digest 与旧请求、重复请求的原屏障。Agent 级主 Service/`-probe` 分别验证 candidate/verified 与业务关路后的控制，Sandbox 验证其独立 Service/分配归属且拒绝跨 Session 路由。kubelet readiness 的 HTTP scheme、path/port 与实际 Pod/StatefulSet drift 核验保持一致。

Agent/客户端到 Connection 的 MCP/API 使用 Connection 的独立身份和契约，不经过 Platform API。平台不读取 Connection Catalog，不持有其目录读取或代调用 workload credential。

M1 不引入 tRPC/oRPC/ConnectRPC。

## 9. 身份与权限

### 9.1 IdentityAdapter

- 仓库提供第一方 LDAP IdentityAdapter 作为企业部署默认实现：浏览器登录由平台服务端查找唯一员工条目并以用户密码完成 LDAP bind，仅从受信查询取得稳定 UID、邮箱与当前账号状态。密码不保存、不送入 Worker/Agent、不进入日志或审计；LDAP 连接通过服务端 `tls` 开关选择协议：默认 `true` 使用受信 `ldaps://`，显式 `false` 使用 `ldap://`；显式端口保留，未指定端口时使用协议默认端口。开关不来自浏览器登录请求，不允许 URL 内嵌凭据，不改变用户 bind、稳定 UID、账号状态或会话校验。Platform Core 仍只消费 IdentityContext，其他部署可替换 Adapter，不要求配置 LDAP。
- 部署通过进程内可信 Adapter、经过认证的服务边界或版本化签名信封向 `platform-api` 提供当前 IdentityContext；跨进程传递时必须校验签发方、audience、签发/过期时间、唯一 context ID、keyVersion 和部署身份绑定，并在缺失、过期、重放或验证失败时 fail closed。
- IdentityContext 至少包含稳定且不透明的用户 ID、当前账号状态、组织成员关系、平台角色，以及足以判断上下文是否仍有效的版本或时效信息。
- 浏览器、Agent、模型和普通调用方不能提交、覆盖或伪造这些字段；`platform-api` 必须验证部署身份边界后才创建 HttpOnly、Secure、SameSite 会话，且不在 Local Storage 保存上游身份凭证。
- Helm 以环境变量向第一方 Adapter 注入允许成为 `system_admin` 的 LDAP 稳定 UID 集合；每次敏感管理员操作按当前 LDAP UID 精确匹配并检查账号有效。邮箱、企微 userid、Relay 角色和请求字段都不能赋予平台管理员身份。该配置为空时不产生隐式管理员。
- Platform 通过受认证的版本化接口消费通用组织目录，不直接调用企业上游协议。独立配套同步服务的 Adapter 每天从企微或企业内部接口拉取员工与部门，上游 Adapter 负责核实成员有效性与部门归属语义，不能把未知状态默认为有效或把查询范围当成直接归属。只有全量校验成功才原子发布带来源、版本、完整性标记和最长一天有效期的快照；失败保留上一版用于诊断，但过期或不完整快照不能继续授权。Platform 以 LDAP 与快照中唯一、有效的邮箱一对一关联，缺失、重复、停用或无法核实均拒绝依赖该映射的 Owner/可用范围新增与敏感操作；不按名字或请求提交的邮箱猜测。组织成员变化以新完整快照生效，允许最长一天延迟。
- 平台不维护独立员工目录，只保存业务所需的稳定 LDAP 用户引用、管理员手动禁用状态和授权记录。管理员禁用在 Platform DB 中持久化并审计，优先于 LDAP active 结果；解除禁用也须当前 LDAP 账号有效，不修改 LDAP 或企微源数据。
- LDAP 当前账号状态、Platform 手动禁用及适用的组织快照在每次敏感操作前重新解析；LDAP 停用和手动禁用立即拒绝，短期缓存不能成为独立权限来源。IdentityAdapter 或目录依赖缺失、非法、过期或不可用时，依赖其结果的敏感操作 fail closed，不能使用调用方字段或不受控旧缓存继续授权。
- Agent 详情投影 `GET /api/v2/agents/{agentId}/detail` 为每个 Owner 返回服务端当次解析的有效状态，可见性与 `GET /api/v2/agents/{agentId}` 相同，不可见与不存在不可区分；`AgentProjectionV2`、列表和命令响应保持不变。第一方 LDAP IdentityAdapter 逐个 Owner 按上述当前事实判定：LDAP 中已查不到该账号为 `departed`；LDAP 停用或 Platform 管理员禁用为 `disabled`；LDAP、禁用记录与适用的目录快照均确认有效才为 `active`；任一依赖失败、快照缺失或过期、邮箱关联无法核实时为 `unavailable`。单个 Owner 的状态不使整个投影失败，也不以默认值、旧缓存或调用方字段补齐；未提供该能力的 IdentityAdapter 只返回 `unavailable`。状态只用于展示，不替代 9.2 的授权检查。
- IdentityAdapter 确认账号禁用时，平台为该用户全部仍活跃的 Execution 幂等创建平台来源的停止工作项；若平台确认用户失去某个 Agent 的可用范围或某个渠道的权限，则只处理服务端保存的 Agent 或渠道授权上下文受该撤权事实影响的活跃 Execution。该控制操作不借用已撤权用户的调用权限。具体投递和竞态规则见 [Agent Runtime M1 HLD](HLD-agent-runtime-M1.md#81-消息与命令幂等)。

Connection 不消费 Platform 浏览器会话或 Platform API 凭证；其 LDAP 登录、OAuth 客户端身份、授权及复核机制由 [Connection M1 HLD](HLD-connection-M1.md) 定义。

### 9.2 权限顺序

Web/企微依次校验可信用户当前状态、Agent 可用范围/有效 Owner、渠道权限和已验证 Runtime 能力。模型选择须属于标准模板 Owner 当前允许清单或 ACP Runtime 当前有效选项，API 也遵循该模型边界。标准模板的 Relay Key 选择与 Execution 绑定以 10.7 为准；Platform API 凭证和 Connection 凭证均不能替代它。Connection 的独立授权在其调用入口完成。

`platform-core` 的 Access 模块维护独立应用、注册责任人、API 凭证元数据与显式 Agent 授权；用户状态/组织关系仍来自 IdentityAdapter。API Adapter 验证凭证后生成可信用户或应用上下文，保留主体类型、稳定 ID、凭证引用、操作范围及有效期，不能由请求字段覆盖。凭证只保存不可逆校验材料和必要元数据，首次交付后不提供原值读取；个人凭证由本人管理，应用凭证由登记责任人管理。

应用凭证管理与取得/使用凭证材料分别授权。责任人角色只授予元数据、范围、轮换和撤销等管理权限，不自动获得凭证值或应用任务权限；签发与轮换时由 Core 重验接收者当前的独立凭证使用授权，只向该接收者受控交付，不能回显给仅有管理权的请求者，也不能通过重设接收者或交付入口绕过授权。授权、接收者及实际交付结果记录必要审计，凭证值不入审计；不引入新的身份或凭证服务。获授权接收者调用时仍以应用为任务主体，当前 Agent 权限和凭证范围继续生效。

应用凭证材料 grant 的授予/撤销遵循[平台 PRD 7.3](../prd/PRD-agent-platform-M1.md#73-api-身份凭证与授权)：writer 仅来自 9.1 的可信 `system_admin`，每次操作重验当前账号有效、Platform 未禁用及 LDAP 稳定 UID 仍精确匹配管理员配置；责任人或凭证管理角色不能替代该检查。Access 持久保存应用 ID 与接收者可信主体类型、稳定 ID 的绑定，授予、撤销及材料使用均按完整绑定检查，不能仅比较裸 ID。授权变更与必要审计原子保存，审计失败不得放行；授予命令仅返回授权元数据，不签发或交付材料。管理员作为接收者（包括显式自授）仍须在签发、轮换和交付时通过当前独立 grant 检查，撤销后不能继续交付；材料不得进入普通读取、日志、Trace 或审计。

API 创建许可由部署显式配置获准主体集合，以主体类型和稳定 ID 精确匹配，并与凭证的 `agent:create` 范围取交集。集合缺失、主体未列入或当前主体不可确认时拒绝创建；应用不借用责任人的许可，用户与同名应用的裸 ID 不互相代替。该集合只控制创建，不构成逐次审批，也不替代目标 Agent 的独立管理/使用授权。

创建用例将 Agent、创建主体、Owner、初始管理/使用授权、outbox 和必要审计原子保存。用户创建的 Owner 为本人，应用创建的 Owner 为登记的自然人责任人，创建主体仍为应用。API 不进入 Web 申请审批状态机，也不设预审批；镜像/配置与运行能力准入仍适用。管理与使用授权可分别撤销，应用不继承责任人的权限，Owner 不能绕过已撤销的 API 授权。

其他方式创建的 Agent 没有初始 API 授权。当前 Owner 经浏览器会话为用户显式授予或撤销逐主体的 API 管理/使用授权（`api-manage-grants`、`api-use-grants`），按 Agent 管理修订校验、幂等并审计；该修订只在 Owner 读取 Agent 投影时以 `managementRevision` 返回，非 Owner 的投影不含此字段。该入口不接受 API 凭证，授权不随 Owner 身份自动产生或延续。

上述事务是创建请求的可靠受理点，先于 Workload 创建；实例创建失败保留原 Agent 与初始授权，按现有生命周期权限查询、停止或重试，不能产生只有成功部署后才能管理的 Agent。

每次 API 操作在 Core 中检查：当前主体有效、当前对应业务授权、凭证操作范围与有效期、目标 Agent/渠道/Runtime 能力。任务查询、订阅、结果文件访问与调用方取消还须匹配持久保存的提交主体，并具有当前 Agent 使用权；Owner 或责任人角色不能替代这项匹配。相同主体的另一有效凭证可在其权限范围内操作原任务。

Agent 资源授权修订与逐主体的 manage/use 授权修订属于不同版本域。独立授权的撤销、重新授予产生新的授权修订；消费者按完整主体类型、稳定 ID、Agent 与授权类型复核当前记录，不能以授权修订等于 Agent 修订判断是否授权。任务边界分别绑定 `agentAuthorizationRevision` 与 `useGrantRevision` 并复验；审计查询使用当前使用权，同时保留原提交主体和执行关联校验。

Agent 元数据的个人 API 列表与单项读取要求凭证包含 `agent:read`，并仅返回主体当前显式拥有管理或使用授权的 Agent；任一授权有效即可读取元数据，两项均撤销时排除该 Agent。元数据读取不授予管理或使用操作权，Owner 或系统管理员角色不能替代独立 API 授权。无可见 Agent 时返回空页，浏览器发现与 Owner 读取仍按其既有规则执行。

个人凭证自查使用 `GET /api/v2/me/api-identity`，仅接受当前个人 Bearer，不接受 Cookie、
其他凭证类型或调用方选择主体。返回 `schemaVersion: 1`、`principal: { kind: "user", id }`、
`credentialId`、当前 `scopes` 和 UTC `expiresAt`；`null` 仅表示未设置到期时间，撤销和禁用仍
生效。稳定主体来自已有用户 ID；凭证引用不作为账号身份。不要求 `agent:read` 或 Agent 授权，
不返回凭证值、校验摘要或个人资料，不代表 Connection 的身份或授权。

`GET /api/v2/agents/:agentId` 的个人 Bearer 路径使用与列表项相同的 V2 投影及 API 用户查询范围。
两项读取均复核当前凭证、目录及禁用事实，沿用读取事务和必要审计；提交失败不得返回成功。
单项读取额外检查上述 `agent:read` 与目标显式授权；已通过身份和范围校验后，不可见或不存在
均返回 `404 RESOURCE_UNAVAILABLE`。无效凭证返回 `401 AUTHENTICATION_REQUIRED`，禁用主体
或缺少读取范围返回 `403 FORBIDDEN`，非法输入返回 `400 INVALID_REQUEST`，依赖故障返回
`503 DEPENDENCY_UNAVAILABLE`。两项 Bearer 请求拒绝混合 Cookie、额外 query/body 和自报身份头，
响应禁止缓存。浏览器单项读取、`/detail`、管理员入口和凭证管理保持各自认证规则。
调用步骤见[个人 API 凭证读取联调](../agents/personal-api-read.md)。

| 变化 | API/订阅 | 已受理任务 |
| --- | --- | --- |
| 单个凭证过期或撤销 | 拒绝该凭证并关闭其流 | 继续执行，不把凭证失效当作主体撤权 |
| 主体禁用 | 拒绝该主体全部 API 访问和订阅 | 取消未开始任务，向进行中任务投递系统取消，并阻止后续平台受控操作 |
| Agent 使用权撤销 | 拒绝新任务及依赖该使用权的访问和订阅；独立管理授权不被一并撤销，元数据和管理操作按当前对应权限检查 | 取消未开始任务，向进行中任务投递系统取消，并阻止后续平台受控操作 |
| Agent 管理权撤销 | 拒绝该主体之后的生命周期命令；使用权与元数据读取按各自授权检查 | 不受影响 |
| 身份或授权依赖无法确认 | 敏感操作 fail closed | 不凭旧缓存继续投递；保持可解释的等待/未知状态，按原执行恢复核实 |

撤权控制以服务端持久授权关系定位 Execution，由系统身份执行，不能借用已失效调用方凭证。取消请求与实际停止分开保存，不回滚已发生的外部效果；Connection 在自己的入口执行当前授权。

系统管理员按[平台 PRD 2.3](../prd/PRD-agent-platform-M1.md#23-系统管理员)的职责读取 Agent 管理投影：列表 `GET /api/v2/admin/agents` 与单项 `GET /api/v2/admin/agents/{agentId}` 只接受浏览器会话，每次按 9.1 重新确认当前账号有效且为 `system_admin`，返回与普通读取相同的 `AgentProjectionV2`，Owner 等字段均由服务端投影，单项不存在时返回不可用。管理员读取不授予配置写入、授权变更或使用权，管理员命令仍在各自入口按当前身份独立授权；它也不扩大 `GET /api/v2/agents`、`GET /api/v2/agents/{agentId}` 及详情投影的可见范围，管理员不在可用范围内时普通读取仍按不可见处理。

### 9.3 服务端授权上下文

Web 和企微仍按可信用户、当前 Agent 可用范围及渠道权限校验；API 按 9.2 校验。每次 Turn 或补充指令实际投递前，平台重验当前主体和 Agent 使用权，再生成短期、不可篡改且版本化的 Runtime Execution Grant；Web/渠道排队消息出队时同样在首次 Runtime 准备前重验（[§12.5](#125-执行中消息的补充指令与排队)）。Grant 绑定签发方、RuntimeHost audience、签发/过期时间、唯一 `grantId`、Execution、Agent、提交主体及类型、渠道、Conversation/Turn、允许命令和附件操作；标准模板业务 Grant 还绑定该 Execution 已固化的 Relay Key 用途、引用与版本，但不含原值。执行范围受原受理授权边界约束，不能因后台 Worker 的服务权限而扩张；Platform API 凭证的后续失效按 9.2 处理，Relay Key 的执行期规则按 10.7 处理。

RuntimeHost 在读取附件或运行命令前校验签名、签发方、audience、有效期与全部对象绑定。服务身份、请求字段、Session Ref 或 Runtime 返回值不能单独作为授权依据。补充指令取原 Execution 边界与当前授权的交集；不匹配或过期时拒绝，日志和审计只保存 Grant 引用及受限原因，不保存原始证明。

平台来源的停止、恢复核实及代次隔离复用同一签名机制，使用与业务执行显式区分的控制用途 Grant。Core 依据已持久化的撤权、停止、隔离记录或经可信历史证明后提交的系统迁移审计及目标当前状态签发，绑定原主体、Agent、Conversation、适用的 Execution、Session 代次、控制操作引用与命令范围；原主体保留为目标和审计归属，不要求其仍具备业务使用权。Host 必须校验控制用途与上述绑定，并继续执行该操作的租约、fence 和屏障规则。控制用途只允许停止、无正文状态核实、必要代次屏障，以及原执行未确认事件向平台持久化处理器的续传与确认。业务 Grant 只在原执行运行中续期；原执行在其事件读完前结束时，Worker 须经状态核实取得 Host 对终态的正面证明，并在同一租约内将该终态持久化，之后才在同一次认领中改用控制用途 Grant 续传至终态事件，不重新排队，也不恢复业务权限。续期被拒本身不证明终态，无法证明时沿原恢复路径重新认领。事件续传须绑定原 Execution、代次、当前 fence 和持久确认游标，由处理器按原任务隔离保存；该通道不授予用户查询或正文回放权限。控制 Grant 不能提交或补充 Turn、发起模型/工具调用、读取附件或向用户返回正文，也不能用于 Connection 授权。服务身份或调用方自报撤权不能替代该 Grant；过期后仅能沿同一持久控制记录重新校验签发，不能借此恢复业务权限。

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

#### 9.3.1 原生元数据读取授权

原生命令状态、命令目录和已安装 Skill 目录使用独立版本化读取用途 `native_metadata_read`，
每次读取固定一个 `status | commands | skills` selector。该用途只授权原已持久会话的获准
元数据，不授予正文、附件、模型、工具、压缩、Turn、控制、恢复、事件回放或 Connection
权限；business、control、recovery 和 readiness 的许可不能转换成用户读取许可。

`platform-api` 从本次受认证请求重新解析当前主体和适用凭证，Core 按当前读取政策检查
主体状态、Platform 禁用、对应 Agent/渠道权限及持久提交归属。Web 沿原用户读取规则；
API/应用仅在其当前读取与实际所用凭证合同已接入时启用，不能外推 Web 或任务受理结果。
Owner、管理员或服务身份不替代对应读取权。终态或暂不可执行业务的原执行仍按读取政策
判断，不借业务租约、readiness 或原控制权限放行。

原范围由服务端持久记录解析，绑定主体、Agent、channel、Conversation、原 Execution、
该 Execution 的 sessionGeneration 和 authorizationRevision。Worker/Host 再核唯一的
原持久 Host/Driver/native 与配置绑定，以不透明 `originalHostScopeRef` 关联；当前会话代次、
当前 Agent 配置和模型配置修订不能替代原执行的 Host 配置。调用方不得提交或覆盖主体、
代次、Host/native ref、thread、配置、路径或任意 RPC。范围或原映射无法唯一确认时拒绝。

读取证明是独立版本化数据，绑定读取用途与 selector、可信 issuer、专用 RuntimeHost
metadata audience、keyVersion、issuedAt/expiresAt、唯一 readId、上述原范围和
originalHostScopeRef。API/Core 先完成当前授权及原范围确认，再由唯一投递方 Worker
沿受认证内部链生成并投递证明；Host 校验部署服务身份、签名与所有绑定。证明不含原始
凭证、正文、函数或 native 路径；服务身份、readId、证明未过期和修订相等都不能单独授权。
实际 wire 的版本及字段由读取 producer/consumer 的实现 primary 固定，不扩用旧 Grant
用途或兼容回退。

本次 operation 使用可信服务器时钟，固定期限不晚于读取起点后 30 秒、可信上游 deadline
及适用且已知的会话/凭证绝对到期时间，取最早值；调用方不能指定或续长。浏览器认证源
未暴露绝对到期时间时，不补造该字段，每次重验原请求的当前会话有效性；API 凭证须逐次
核真实到期、撤销、范围与主体，缺合同不启用。30 秒是资源上限，不是授权缓存或撤权宽限。

API 在原请求存续且等待此次 Worker 读取期间登记有界 request-local readId 与认证来源；
该关联只允许受认证 Worker/Host 链按同一 selector 和原范围请求当前确认，引用本身不授权。
每次确认重新核当前认证、Core 政策与同一持久原范围，不使用 initial allowed 或旧 revision
闭包。API→Worker→Host→Driver 保持原单向投递；Host 的异步确认沿受认证内部链回到该
请求关联，不直接查询 Platform DB 或 IdentityAdapter，不向 Runtime 传用户原始凭证。

Host 将原请求取消、固定 deadline、本机生命周期及当前确认失败合并为读取 signal；
同步护栏只核本机已确认状态、deadline、abort 与原持久绑定，异步重验另显式等待。
在各相关 await 后和结果返回前重新确认；API 也须在写出任何响应 bytes 前重验原请求及
同一原范围。明确无权、认证失效、范围/配置/进程变化、期限、abort 或依赖无法确认时，
丢弃结果并使该 context 永久失效，不返回旧结果或伪空目录。请求结束、issuer/Worker/Host
重启或关联丢失时不恢复旧 context；新的读取须重新认证。该方案不宣称存在即时撤权 feed。

读取不新建业务 Execution、Session 或 Turn，不恢复业务、不写 recovery latch、fence、Key
或任务状态，不推进 successor。纯原绑定断言独立于旧业务、控制及 evidence-query latch；
目录不授权后续执行。内部 ref、正文、路径、原始证明和凭证不进入公开投影、审计或遥测。
具体 Host/Driver 生命周期见 [Runtime HLD §5.2](HLD-agent-runtime-M1.md#52-调用生命周期与兼容)。

## 10. Agent Workload 与调谐

### 10.1 Workload 形态

Web 与 `platform-api` 是位置无关的 Platform 服务；`platform-worker`、KubernetesRuntimeAdapter、Agent Workload 和部署访问路由组成 Kubernetes Workload Plane。只有 `platform-worker` 的部署身份可以访问 Kubernetes API，并且权限限制在目标 namespace 内。Web、`platform-api`、Connection 和 Agent Pod 都不能持有 Kubernetes API credential。取舍见 [ADR: Platform 服务与 Kubernetes Workload Plane 分离](../adr/0001-separate-platform-services-from-kubernetes-workload-plane.md)。

开源实现只使用受维护 Kubernetes 版本中的 GA capability baseline：`apps/v1` StatefulSet、core/v1 Pod/Service/ServiceAccount/PVC/Secret、`networking.k8s.io/v1` NetworkPolicy，以及 `networking.k8s.io/v1` Ingress 或部署 Adapter 提供的等价受控路由。每个 release 记录经过 `kind` 和真实部署验证的版本矩阵；不为 Kubernetes 1.16、`networking.k8s.io/v1beta1` Ingress 或超出支持 skew 的客户端维护兼容分支。

- 标准模板与 `platform-adapter` 的每个 Sandbox 对应独立的实际 Pod/Runtime；可使用副本为 0 或 1 的 StatefulSet 管理该 Pod，不再按 Agent 共享一个运行 Pod。
- 每个 Sandbox 使用独立内部 Service、ServiceAccount、PVC、NetworkPolicy 和受控 Secret materialization，不与其他 Sandbox 共享可写工作区、进程命名空间、运行时 HOME/cwd 或凭据挂载。
- Agent 的管理状态控制其所属 Sandbox 的运行资格；实例是否就绪按各自绑定、健康、网络和 Runtime 探测决定，不能用一个实例的就绪代表全部会话。
- `self-managed` 自有服务不承载 Platform Session；保留其既有部署与唯一用户路由，不自动转换为平台会话或按外部会话创建 Sandbox。
- ServiceAccount 默认没有 Kubernetes API 权限。
- Agent Service 只提供集群内部地址，Pod 或 Service 地址不作为用户入口。Pod、可选 StatefulSet、Service、ServiceAccount、PVC、部署访问路由和 NetworkPolicy 只由 `platform-worker` 通过 KubernetesRuntimeAdapter 调谐，Agent 与 Owner 都不能直接创建或修改这些资源。
- 平台配置、对话和 Connection 授权不保存在 Pod 本地。
- 平台会话的个人记忆、工作区和原生 Session 数据保存在所属 Sandbox 的独立持久卷；Runtime 内的文件与进程防护继续有效，不能以 Pod 分离代替必要负向验证。

Owner 不能修改 CPU、内存、副本数和存储规格。资源规格由平台按 Agent 类型选择预设 Profile，Web 审批页展示该配置；API 创建复用相同规格选择，不增加审批。

#### 10.1.1 Session-owned Sandbox 权威与资源绑定

平台采用 `agent_id → session_id → sandbox_id`。`session_id` 表示 Platform Conversation 的
稳定逻辑会话标识，复用 `conversationId`，不新增平行 Session 服务；它不是 Native Session ID、
Host Session Ref 或登录 Session。Platform DB 保存 Session 到唯一 Sandbox 的分配及主体、
Agent、渠道、当前代次、资源归属和状态。`sandbox_id` 由服务端分配，不由请求、Runtime 回包、
Pod 名称或 Connection 身份推导；`project_id` 不参与主键、分配或授权。未来业务工作区字段
不能改变该隔离键或允许复用另一 Session 的可写资源。

创建或续接会话时，在原 Conversation/任务事务内校验当前主体、Agent 与渠道，并持久化或读取
同一 Sandbox 绑定；幂等重试、并发受理和 Worker 恢复不能分配第二个有效 Sandbox。分配不等于
已经创建 Pod 或 Native Session：资源由唯一 Worker 调谐，原生 Session 仍在首次实际投递时创建。
Web、企微回调/长连接和 API 共用该权威；企微会话键保留发送者，渠道会话不自动合并。

Agent 运行资格、镜像修订验证和 Session 实例就绪分别保存，不能互相代替。创建/升级时的
Manifest、健康和 ACP 核心验证由 Worker 使用绑定 Agent、候选修订与管理 fence 的独立验证
Workload 完成；它不属于业务 Session，不挂载任何业务 PVC、会话正文或用户 Connection 凭据，
不加入业务路由，也不能提升或复用为业务 Sandbox。只读探测授权绑定该验证用途与实例，
通过或失败后按原修订回收验证资源；它不创建业务 Execution 或 Native Session。
无 Session 时，当前修订验证通过且管理资格有效即可允许创建首个会话，不要求先有业务 Pod。
Web 打开新会话先完成持久分配和实例准备，就绪前该会话只读；API/企微沿原任务受理与
有界等待规则触发分配，就绪前不投递。已有 Session 的可用性只由自身实例决定；Agent 级
修订验证通过不能覆盖实例失败，单个实例失败也不能将其他就绪会话判为不可用。

Worker 只消费已提交分配，按 Sandbox 串行调谐并校验原 Agent 管理资格。资源名、selector、
ownership、UID、Runtime/Workload 修订和租约/fence 必须绑定同一 Sandbox、Session 和代次；
仅按 Agent ID 选择 Service、PVC 或清理集合不再足够。旧代次、外部同名对象和归属不明的资源
均拒绝接管；部分创建失败从原分配幂等恢复，不删除其他 Sandbox。只有实例身份、路由、健康、
Runtime readiness 和出站策略全部符合当前期望时才能投递业务；healthz 成功不单独证明隔离。

Session Sandbox 的必需实际资源为 Pod、Service、ServiceAccount、PVC、NetworkPolicy 和
该 Sandbox 专属 Secret 六类。
就绪回执须逐资源回读真实 UID、resourceVersion 与归属，绑定原 allocation、主体、渠道、
租约、代次及当前 `resourceFence`；不能用资源名、期望清单或合成 receipt 代替实际对象。
StatefulSet 仅为可选 Pod 控制器，不是所有 Sandbox 就绪回执的必选资源；实际使用时，
须同时核验其真实 UID/resourceVersion、owner 及与 Pod 的控制关系，不得忽略实际控制器。
此可选性不改变 `self-managed` 部署、独立验证 Workload 及 §10.6 的既有 StatefulSet 规则。

专属 Secret 是该 Sandbox 的受控 Secret materialization，与 Sandbox 同名且 `immutable`。
Sandbox 只持有本 Sandbox 派生的凭据，部署级 service token 不进入其 Secret、env 或文件。
所有 Session 都有独立的 `token`：部署级 service token 对 `session-sandbox-v1`、namespace 与
Sandbox ID 的 HMAC-SHA256（base64url）。Worker 每次路由时重新计算，不另行存储；business 与
control 路由只发送该值，部署 token 和其他 Sandbox 的 token 均被该 Host 拒绝。部署配置了
Runtime 文件交换 origin 时，Secret 另含文件交换用途的 `file-exchange-token`：部署级 service
token 对 `session-sandbox-file-exchange-v1`、namespace、Sandbox ID、Session 代次与
`resourceFence` 的 HMAC-SHA256（base64url），由 Platform API 按 §15.4.2 重新计算校验；未配置
时不写入。两种用途互不通用，代次或 `resourceFence` 前进后旧值失效。Agent 级路由不变，部署
token 轮换仍遵循下述受控停止与重建流程。

Session 输入按 Store 已验证的来源使用独立、版本化的辨别形状，标准模板与 custom ACP
不得互相推断或回退；缺失、未知或与 verified 来源不一致的输入，在任何资源写入前拒绝。

- 标准模板的专属 Secret 只含 `token`、`model-config` 和适用的 `file-exchange-token`。
  `model-config` 只接受 Store 随
  claim 交付的 verified V4 无 Key 模型投影；投影缺失或不是 V4、模板绑定不再受信，或标准模板
  verified 部署含 Agent 级 `secretRefs` 时，prepare 以 policy 失败。Worker 不自行推导投影，
  不挂载 Agent 级 Secret 或静态模型 Key；个人与 Agent 默认 Relay Key 仍按
  [ADR-0016](../adr/0016-bind-relay-key-to-execution.md) 随 Execution 交付。
- `platform-adapter` 自定义 Agent 不生成标准模板模型投影，不要求 `standardTemplateBinding`，
  不取得平台保存的个人或 Agent 默认 Relay Key。Worker 只消费 Store 随 claim 交付、绑定当前
  已验证镜像与 Runtime 修订的 Owner env 和加密 Secret 引用，按 [§10.6](#106-环境变量与-secret)
  从原始密文记录可信解密并物化到本 Sandbox 的专属 Secret。不得从 Agent Pod 或其他
  Kubernetes Secret 反向读取、复制明文；不得把 Secret 值改放普通 env。
- custom 物化保留 Secret 原始 AAD、用途、Owner/Agent 绑定、ID、版本及引用来源 Runtime 修订，
  并绑定 Session、Sandbox、代次、resourceFence 和当前已验证部署。写入及接受就绪观测前均须
  重校验相同绑定；缺失、失效、跨主体/Agent/Session 或版本不一致时拒绝。Secret 版本或运行
  输入变更沿既有更新、停止和原执行恢复流程处理，不就地修改在用对象或改绑原执行。
  本流程不重新加密或重新激活旧引用，也不把镜像自报或请求字段当作 Secret 物化授权。

Pod 通过 secretKeyRef 引用本 Sandbox 的 token 和适用的配置项；custom 的 Owner Secret
使用与系统保留键不冲突的受控映射，缺项或冲突拒绝，不拼接未声明的引用。明文不进入 claim、
配置投影、annotation、日志、事件或持久会话文件。Owner 为同一 Agent 配置的外部密钥可以
具有相同值，但各 Session 不共享 Kubernetes 凭据对象、可读路径或运行实例。

Driver/Host 装配、Agent/Worker 身份、端口、Grant key ID、公钥与 issuer 均由受信部署来源
确定，Owner 输入不能覆盖平台保留字段；custom 镜像负责自己的模型装配，不借标准模板配置
取得平台 Key。数据目录位于本 Sandbox PVC。安全上下文与 Agent 级 Workload 一致：UID/GID/fsGroup
1000、只读根文件系统且 `/tmp` 使用内存 emptyDir、去掉全部 capabilities、seccomp RuntimeDefault，
且不注入其他 Service 的地址。任一字段或 Secret 内容漂移均判为 unknown 或 conflict，不原地
修复。Secret 随计算资源按原 UID/resourceVersion 停止和回收，只保留 PVC；同名外部 Secret
不被接管，恢复仍沿原 Sandbox/PVC 及既有授权流程，不改变历史归属。

部署 token 轮换须沿现有 Agent 管理停止/重启意图进行：先关闭业务路由并确认原执行和停止
屏障，再以原资源 UID/resourceVersion 回收 Pod 和 Secret；轮换后在同一 Sandbox/PVC 上重新
准备专属 Secret 和 Pod，并取得新的逐资源就绪回执。轮换尚未完成时不继续发送新业务。
原执行或删除结果仍为 unknown 时保留占用，不能把 token 内容漂移当作自动替换资源的授权。
drain 保留原 V4 投影、资源身份与删除 CAS 校验，但不重新要求原模板处于当前 prepare allowlist；
模板撤销不得阻断已获管理授权的原资源回收。

Pod 重建仍沿同一 Session、Sandbox、PVC 和原 allocation 恢复，先证明旧执行源不能双活，
再在当前 `resourceFence` 下由原 Store CAS 接受新 Pod UID 与逐资源版本；不能凭 Pod 消失
推断原 Turn 的副作用或终态。证据不足时保留原身份、占用和 `unknown`，不分配另一实例
重放业务，也不绕过 Runtime HLD §7.3 的 generation tombstone 与 cancellation barrier。
停止或删除按当前受控意图操作，以逐资源 UID/resourceVersion 为前置条件，并回读实际
absence；未证实停止时仍保留占用。计算资源回收不删除原 PVC 或改变原执行未知结果。

删除意图必须在原 `outbox.lifecycle` 中持久保存，并按每个非 PVC 资源记录
`delete-requested`、`absent` 或 `unknown` 进度、唯一 delete-attempt、原 UID/resourceVersion、
Session generation、`resourceFence` 及当前管理 fence。Worker 在实际 DELETE 前，必须在当前
claim/CAS 条件下原子提交 `delete-requested` intent、唯一 attempt identity 及上述原始条件；这只
证明获准发送，不证明 DELETE 已发出或已得到 ACK。随后才能按该原 UID/resourceVersion 发出条件
DELETE，并分别记录实际 ACK、失败或 unknown。删除后即使响应丢失、对象仍处于 terminating 或
进程在回写前崩溃，恢复也必须保留原 intent、attempt 和新回读结果，不能把 absence 伪称为 DELETE ACK。
`absent` 只有在同一 namespace/name 的新回读确认对象不存在、原 UID/resourceVersion 条件已记录、
且不存在同名新 UID 或 fence 冲突时，才可作为该资源的 removed 证据；否则保持 `unknown` 并沿原
intent 重试。每次 progress 写回必须重新取得并校验当前 outbox lease、delivery fence 和 CAS/claim
版本；lease 换手、stale context、同名新 UID 或 fence 变化时拒绝旧写入并沿原意图重新认领。
只有全部计算、路由和身份对象均有上述 removed 证据、保留 PVC 仍按原 UID/resourceVersion
核实、且原执行和停止屏障满足时，才能生成完整 `stopReceipt`；部分成功、失败或未知都保留原
占用和可恢复意图，不得以永久 `unknown` 结束收敛。

业务、控制、readiness 与执行文件授权分别在既有用途内绑定目标 Sandbox；Host 校验服务身份、
已签名对象绑定和部署注入的本机 Sandbox/Session/代次，不能信任孤立的 `sandbox_id`。
控制授权仍只允许原执行的停止、核实和屏障，不恢复业务使用权，不成为 Connection 授权。
新增绑定由原契约 owner 发布版本化 Schema，并同步签发方、Host、文件数据面及消费者；不得
静默改变既有 V1/V2/V4 wire 含义或兼容性放行无 Sandbox 的新业务调用。readiness 不创建
业务 Execution；只对已分配实例作只读检查，不能用其授权读取会话或调用模型/工具。

部署批准的出站策略由 Worker 按 Sandbox 落实，默认拒绝未批准目标；始终允许集群 DNS、获准模型
和独立 Connection endpoint，部署还可以批准供标准模板原生工具直接出网的通用目标
（[§10.14](#1014-标准模板-session-sandbox-原生工具)）。部署配置了 Runtime 文件交换 origin 时，
Agent Workload 与 Session Sandbox 还各有且只有一条到该 origin 的出站规则：目的地由部署为该
origin 声明（精确 IP 或 namespace/Pod 选择器，不接受网段），端口取 origin 的端口；缺少或无效声明
在任何资源写入前拒绝（装配见[文件存储部署](FILE-storage-deployment.md#runtime-文件交换注入)）。
Connection 目标和策略修订消费 [§13.5](#135-platform-外部-connection-consumer-配置契约)
的完整 Consumer 配置，不另建 endpoint 或授权来源。Runtime、镜像、模型参数和调用方不能扩大
目的地。Connection 安装凭据仍按 Principal/ConsumerInstance/Actor 隔离并经受保护客户端交付；
Sandbox 身份、ServiceAccount、通用出网或网络可达均不授予 Connection 权限。

| 触发 | 必须保持的边界 |
| --- | --- |
| Session 关闭 | 先拒绝新命令、关闭业务路由，再沿原执行停止/核实；确认无剩余副作用后回收计算资源。平台历史和合法持久数据按数据政策保留，不新增删除会话入口。 |
| 空闲 Session Sandbox 回收 | 连续空闲达到部署配置的时长（默认 30 分钟），且所有执行均已终态、不存在 `active`、`waiting` 或 `unknown` 执行时，沿现有管理排空路径回收 Pod、Service、ServiceAccount、NetworkPolicy 和专属 Secret 等计算与路由资源，保留 Sandbox ID、PVC、工作区、历史和授权映射。是否回收只取决于该 Sandbox 自身，不要求所属 Agent 的 Workload 处于就绪，也不要求其 policy 仍是当前版本。下一条消息沿“会话准备中”，按 Agent 当前已验证部署重新准备同一 Sandbox；执行活跃、等待、待核实或停止屏障未确认时不回收。 |
| Agent 停止、停用或升级 | 管理资格作用于所有所属 Sandbox；先阻止新投递，按各实例记录收敛在途任务与路由。升级只复用该 Sandbox 原持久卷，不能共享或交换会话卷；未知执行按恢复规则保持占用。新的已验证部署提交时，空闲 Sandbox 沿管理排空与重新准备路径升级，详见下文。 |
| 重启或恢复 | Sandbox ID、Session、原执行、Key 版本、持久映射及游标保持；新 Pod UID 须由原分配在当前 fence 下核实，不凭同名资源认定恢复。 |
| 撤权 | 单凭证失效与主体/Agent 使用权撤销按 §9.2 区分；后者取消等待任务并持久停止活跃执行，阻止后续受控操作。历史读取仍需当前授权，控制恢复不向被撤权用户输出正文。 |
| 并发或重试 | 同 Session 保持原串行准入；不同 Session 使用不同 Sandbox 并在获准容量内运行。原幂等结果、租约和 fence 防止重复资源及重复副作用，不新增调度权威。 |
| unknown 或恢复失败 | 超时不证明停止；原 Sandbox 保留核实证据和占用，不换实例重放。代次提升必须等待原 cancellation barrier 确认，详见 Runtime HLD §7.3；其他 Session 不受牵连。 |
| 跨主体/Session 访问 | 查询、订阅、文件、控制和 Runtime 投递均复核主体及完整对象绑定；同主体另一 Session 也不得直接访问本 Sandbox。拒绝不泄漏对象存在性。 |

新的已验证 Workload 状态提交时，同一事务按 Agent → 会话 → Sandbox 分配 → 调谐 outbox 的
加锁顺序，为 policy 已过期的空闲 Sandbox 写入升级意图：`resourceFence + 1`、目标保持运行，
沿上文排空规则生成 `stopReceipt` 后，以新 policy 在同一 Sandbox ID、资源名和 PVC 上重新准备。
policy 已过期指 Sandbox 记录的 Runtime 修订（§10.2）、管理 fence 或已验证部署（Workload revision、镜像
Digest、资源配置）与当前不一致；只改变非 Runtime 输入的配置修订不使 policy 过期，也不阻止新 Sandbox 准备。
存在 `processing`/`unknown` 执行、待确认代次 tombstone 或未完成生命周期的 Sandbox 不排空，
在后续监测中空闲后再升级。`submitted`/`waiting` 任务尚未交给 Runtime（含证明未发送后退回的
任务），不阻止排空或重新准备，保留原顺序并在就绪后投递；升级期间该会话的投递以
`SESSION_SANDBOX_UPDATING` 等待，不写 `unknown`、不计入占用，产品显示“更新中”。决策与备选方案见
[ADR: 空闲 Session Sandbox 升级](../adr/0023-upgrade-idle-session-sandboxes.md)。

空闲回收与上述升级是两个独立的生命周期原因。空闲回收由连续无活动达到部署配置时长触发，默认时长为
30 分钟；它不改变 Agent 或 Sandbox 的 policy、Workload revision、授权或会话归属，只停止计算与路由资源并保留
PVC。回收判断只看该 Sandbox 自身，在所属 Agent 的每次 Workload 写回中执行，与 Agent Workload 是否就绪、
Sandbox policy 是否过期无关；所属 Agent 的管理状态不是可用且运行时，仍由管理生命周期处理。只有不存在 `active`、`waiting` 或 `unknown` 执行，且停止屏障和上一轮生命周期均已确认时才能写入回收意图；
所有执行还必须已经进入终态；任一执行活跃、等待或待核实时保留占用。回收完成后，下一条消息触发现有会话准备流程，在原 Sandbox 和 PVC 上恢复，
不新建 Session 或以新实例重放任务。恢复按 Agent 当前已验证部署准备：回收时 policy 已过期的 Sandbox 因此在恢复时
使用新 policy；Agent Workload 未就绪时，会话保持“会话准备中”，就绪后再准备。升级仍只由已验证 Workload policy
变化触发，沿 `reason: upgrade` 的排空、`stopReceipt` 和重新准备规则执行；已满足空闲回收条件的过期 Sandbox
先回收，不立即为其重新准备计算资源，其余过期的空闲 Sandbox 仍按升级处理；不能把升级期间的等待解释为空闲回收。

历史 Agent 共享 PVC 不能直接标记为新 Sandbox 已隔离。迁移须先停止旧业务准入，核实并排空
旧执行源；unknown 或归属不明时保持隔离维护，不自动复制共享历史、补造主体或新建 Session。
只有逐 Session 证明原映射、数据归属和独占资源，才可在原事务/fence 下切换；原证据按政策保留。
本契约不授予数据删除或破坏性迁移权限。历史与实施交接见
[ADR: Session-owned Sandbox](../adr/0017-session-owned-sandbox-isolation.md)。

### 10.2 期望状态

Platform DB 保存：

- 管理状态与期望运行状态。
- 模板或自定义镜像的不可变 Digest。
- 配置修订号，以及每个配置修订对应的 Runtime 修订：最近一次改变 Runtime 输入的配置修订号。只改变渠道绑定等非 Runtime 输入时，推进配置修订并保留 Runtime 修订，不触发 Workload 调谐、Session Sandbox 升级或“更新中”。Workload、Secret 物化、Sandbox policy 与投递就绪比较 Runtime 修订；配置 CAS、渠道授权与配置展示比较配置修订。字段分类、比较归属与迁移见 [ADR-0028：区分 Runtime 修订与配置修订](../adr/0028-separate-runtime-revision-from-configuration-revision.md)。
- 资源 Profile，以及 §10.1.1 的 Session/Sandbox 分配、代次、实例期望与恢复状态。
- 交互模式、渠道和 Runtime 能力声明。
- 普通 env、版本化 Secret 密文状态和 active/pending 配置修订。

`platform-worker` 通过幂等调谐完成：

1. 读取待处理的 Runtime 修订及其配置。
2. 通过 ImageRegistryAdapter 解析并校验获准 OCI Digest、Runtime Manifest 和访问政策。
3. 按已提交 Sandbox 分配生成或更新 §10.1.1 的六类资源和内部路由；实际使用 StatefulSet 时一并调谐并核验。自有入口与独立验证 Workload 保留原 StatefulSet 规则。
4. 根据探针和 Workload 状态计算产品服务可用性。
5. 写回已应用的 Runtime 修订、可用性和脱敏失败原因。

已提升的 Workload 仍按第 4 步周期复核。复核探测在期限内没有完成（超时或连接失败），或 Pod 以 5xx
答复健康检查或 readiness（服务端暂时无法处理）时，连续未达阈值（默认 3 次，`platform-worker` 可配置）前
保持现有可用性和路由；达到阈值，或探测明确报告不健康（其他非 2xx、超限、格式错误、身份或签名不匹配）、
Workload 漂移、Pod 未就绪时，立即关闭路由并重新验证。验证阶段（含达到阈值后的重新验证）把上述暂时性
失败按 Pod 未就绪处理，在原有重试预算内重试，不因此删除实例；只有明确不健康的回答立即判定健康检查失败。每次探测
失败只记录 Agent、Workload 修订、阶段（health / readiness）与原因，不记录凭证。业务请求前的实际路由
观测不受该阈值影响，探测不成功时仍不发送。

HTTP 请求只提交期望状态，不等待 Kubernetes 操作完成。

Session Sandbox 的停止与资源缺失按 §10.1.1 核实，不能要求未使用的 StatefulSet 身份。
既有自有入口与独立验证 Workload 的 Kubernetes 调谐结果在已停止、期望副本为 0、
实际 StatefulSet 不存在且路由已关闭时返回
`status: absent`，保留请求、Agent、Runtime 修订、Workload 修订和 fence 的完整关联，固定
`replicas: 0`、`routeClosed: true`，不生成虚构的 Workload UID 或 generation。
运行中期望不能接受该结果；资源期望身份、归属、fence 或路由关闭校验失败仍返回失败，
不能以资源缺失掩盖拒绝或不完整操作。保留的持久卷不因该结果被删除。

Platform DB 的 outbox 保证状态变更和投递可恢复；outbox 写入事务提交后，数据库向 Worker 发出不含业务内容的唤醒提示，Worker 收到后立即发现待投递项，提示丢失时按固定轮询发现，认领、租约和 fence 校验不变。API 任务在同一 Store 内另保存受理顺序、等待期限和调度状态，由 Dispatch 实施第 12.4 节的有界等待。M1 不提供通用队列管理、优先级、定时调度、资源池或调用方逐任务执行时限参数。Session Sandbox 的空闲计算回收仅按 §10.1.1 的生命周期规则执行，不构成通用调度器或 Agent 级自动休眠。

### 10.3 并发与 Leader

- 多个 `platform-worker` 实例可以同时运行。
- Agent 管理变更在原 Agent 锁内串行化；Sandbox 调谐按其分配与修订串行化，复核 Agent 当前资格，不以 Agent 全局运行实例代替会话隔离。
- Agent Workload 调谐每个 Agent 同时只执行一个步骤：Worker 以会话级 advisory lock 取得该 Agent 的调谐权，连接断开即释放，其他 Worker 可接管。Agent 行锁只用于短事务：选择到期 Agent、读取管理状态、Runtime 修订、Workload 状态与 Secret 绑定并认领 outbox 后立即提交。Kubernetes、Registry 与健康探针 I/O 在该事务之外执行，期间不持有 Agent 行锁或打开事务；Secret 激活与解密审计使用各自的短条件事务。
- Workload 调谐写回在新的短事务中重新锁定 Agent，确认管理状态、Runtime 修订和读取时的 Workload 状态均未变化后，才保存新状态、生命周期观测并完成 outbox。任一值变化即丢弃本步结果、交还 outbox 认领，并从已保存状态按新意图重新调谐；只推进配置修订而 Runtime 修订不变时，本步结果仍有效。步骤内的 Kubernetes 操作因此必须幂等并携带所绑定的 fence。
- 每次 apply 携带 Runtime 修订号，旧任务不能覆盖新状态。
- 平台会话的 Kubernetes 资源使用稳定 label 和 annotation 关联 Agent、Session、Sandbox、代次与修订/fence。
- M1 不创建 CRD；Platform DB 是产品期望状态的唯一来源。

### 10.4 模板与自定义镜像升级

- 标准模板目录保存当前镜像 Digest。模板更新后，所有关联 Agent 进入新修订并自动调谐。
- 自定义 Agent 创建时把 Tag 解析为 Digest；只有 Owner 主动选择新镜像时更新 Digest。
- 同名 Tag 指向新 Digest 时可以通知 Owner，但不能改变已有自定义 Agent 的期望 Digest。
- 自定义 Agent 的新 Digest 先进入候选修订。平台重新读取并校验 Manifest；M1 不支持在升级中切换 `interactionMode`，Schema、Service 或健康检查字段无效，或模式与当前 Agent 不一致时不更新 Workload。有效的新 Service 和健康检查配置进入候选 Workload。
- Manifest 预检通过后，`platform-worker` 应用候选 Workload 并验证健康检查；`platform-adapter` 还必须重新执行 ACP 核心探测。候选 Workload 在验证完成前不加入用户路由或原渠道；无法与旧修订隔离运行时，先关闭用户路由再应用候选 Workload。
- 全部验证通过后，`platform-worker` 按候选修订号执行可重入提升。Platform DB 保存期望修订和切换进度，Workload、用户路由和渠道确认均绑定该修订号；这些跨 PostgreSQL 与 Kubernetes 的操作不要求分布式原子事务。每一步必须幂等，Worker 重启或部分切换后根据 Platform DB 和 Kubernetes 资源上的修订号继续收敛；用户路由配置始终只指向一个已验证修订，判定失败的候选修订不能继续接收流量。任一步失败时，把旧 Digest 和 Workload 配置写成新的期望修订并重新调谐，保持或恢复旧路由，保留原渠道绑定和平台历史。
- 标准模板升级失败时，平台把旧 Digest 和 Workload 配置写成新的期望修订，再由 `platform-worker` 通过 Kubernetes API 重新调谐；不能把 Kubernetes 当前状态当作回滚来源。
- 平台会话的升级和回滚只复用目标 Sandbox 自己的原 PVC；自有入口保留原部署由平台管理的持久卷和数据。两者均保留 Platform DB 中的配置、渠道和会话数据。M1 不自动创建 PVC 快照，也不承诺 Runtime 自有数据兼容旧版本。
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

审批通过后，只有 ImageRegistryAdapter 准入与 Manifest 预检通过才启动 Workload。自有入口与 §10.1.1 的独立验证 Workload 沿既有规则，由 `platform-worker` 创建 StatefulSet、Service、部署访问路由、NetworkPolicy、Kubernetes 配置、Secret 和新 PVC，验证健康检查，再请求 HLD 定义的 Runtime 探测；自有入口的访问路由只有在健康检查和所需核心探测通过后才接收用户流量，独立验证 Workload 不加入业务路由。任一步失败时产品状态为“创建失败”，并返回脱敏且可修复的原因。

业务 Session Sandbox 消费已验证修订，资源准备与就绪遵循 §10.1.1；StatefulSet 可选，不能用 Agent 级验证 Workload 或其就绪结果替代 Session 的六类实际资源证据。

启动 Workload 后创建失败时，`platform-worker` 必须先关闭访问路由，再幂等清理本次创建的 Kubernetes Workload、访问资源、配置、Secret 和尚未进入“可用”的新 PVC；Platform DB 中的申请、Agent 配置、失败原因和审计保留，重试时重新创建运行资源。升级的候选修订、路由切换和失败恢复见 10.4。

Workload 调谐区分永久配置或 admission 拒绝与可重试的基础设施异常。永久拒绝立即进入既有失败处理；临时 Registry、Kubernetes 或依赖异常使用持久化尝试次数，在 `maximumAttempts` 预算内保留步骤重试。部署可以将资源申请/镜像与 PVC 等待配置为独立的 `maximumApplyAttempts`，将已创建资源的健康与 signed readiness 观察配置为独立的 `maximumObserveAttempts`；未配置时两者均沿用 `maximumAttempts`，由部署按冷拉取和 readiness 失败特征选择不同预算，避免两类等待共用不可解释的单一预算。预算耗尽后复用既有清理或候选拒绝路径，更新失败时保留已验证版本。

步骤异常可以在 Workload 状态中保存一个可选的 `lastFailure`：只允许版本化的有界原因码、该原因的连续失败次数以及 Kubernetes HTTP status、资源 kind 和 verb；旧状态缺少该字段时必须继续解析，未知或越界字段必须拒绝。`lastFailure` 不能包含异常正文、堆栈、资源名、URL、Secret、凭证或用户内容；日志和 API 展示同样只能使用这些有界字段。任一步成功推进后清除该字段，终态 `reconciliation_failed` 保留最近一次失败原因供管理员与审计读取。

连续的 Kubernetes 401 或 403 属于明确授权拒绝，默认连续三次后进入既有失败清理/候选拒绝路径，不再消耗完整 `maximumAttempts` 预算；部署可把阈值限制在更小的有效预算内。其他原因继续使用原有重试预算，401/403 的连续计数在原因改变或步骤成功后归零。该规则只改变提前终止时机，不改变既有 `failureCode` 的含义或清理语义。

部署策略不支持期望配置属于确定性拒绝。preflight 中的 `kubernetes_policy` 只来自部署策略对期望配置的静态校验（目前是下述访问路由核对），与 Registry/Manifest 的永久拒绝一样立即进入既有失败处理，不消耗 `maximumAttempts` 预算；preflight 内的临时 Registry、模型目录或依赖异常仍按预算重试。其中访问路由在 preflight 开始时、Registry 准入和任何 Kubernetes 写入之前核对：期望为平台身份入口（自有交互入口且身份责任为 `platform-managed`，对应 `route.exposure: platform-auth`），而部署策略没有提供可信的平台身份路由集成（`platformAuthAnnotations` 为空）时，本步以 `kubernetes_policy` 结束；Owner 或系统管理员重试创建时同样在首个 preflight 结束。该规则不改变已配置平台身份路由的部署，也不改变 preflight 之后各阶段对 `kubernetes_policy` 的重试语义。

`creation_failed` 的 Agent 只向当前 Owner 与系统管理员提供一个失败类别。`platform-core` 由管理状态的 `failureCode` 与 Workload `lastFailure.reason` 推导：`health_check_failed` 为健康检查未通过；`preflight_rejected` 或 `kubernetes_policy` 为配置与部署不兼容，需要先调整配置或部署，重试不会成功；其余为部署暂不可用，可以稍后重试。浏览器经 `GET /api/v2/agents/{agentId}/creation-failure` 读取 `AgentCreationFailureProjectionV1`，其中只有 `schemaVersion`、`agentId` 和该类别，不返回原因码、尝试次数、Kubernetes status/kind/verb 或资源名；其他主体、不处于 `creation_failed` 的 Agent 与不存在的 Agent 一律返回 `RESOURCE_UNAVAILABLE`。

### 10.6 环境变量与 Secret

Platform Secret 使用项目内置密文、部署加密公钥和 Worker-only 解密 keyring，取舍见 [ADR: Platform Secret 使用项目内置密文存储](../adr/0002-store-platform-secrets-as-application-ciphertext.md)。该模型不自动扩展到 Connection Provider 凭证。

以下 Kubernetes Secret 物化、激活和回滚规则只适用于 Agent env/Secret；标准模板的个人与 Agent 默认 Relay Key 采用同一加密原语，但不物化到长期 Agent Pod 的 env 或 Kubernetes Secret，执行期交付与版本保留见 10.7。两类记录须有不同用途和 AAD，不能将个人 Key 伪装成某个 Agent 的 Owner Secret。

- 固定 Runtime Registry 为每个标准模板声明 Owner 可配置的 env/Secret 键。`platform-api` 在保存前拒绝该模板未声明的键，`platform-worker` 只装配已声明的键。
- Registry 不得向 Owner 开放代理设置、进程加载器或 Runtime 启动选项等能够改变标准模板受信运行边界的键。
- 自定义镜像接受 Owner 配置的任意 env/Secret K/V，但不能使用平台保留前缀。
- `AGENT_INFRA_*` 由平台保留并按执行环境注入；标准模板或自定义镜像的 Owner 输入使用该前缀时均在保存前拒绝。
- 普通 env 保存于 Platform DB。Agent 级 Secret `algorithmVersion = aes-256-gcm:v1` 要求每次加密（包括轮换和失败重试）都由 CSPRNG 新生成 256-bit DEK 和 96-bit nonce，同一 DEK 只允许加密一条记录且不得复用 nonce；`platform-api` 计算不泄露 DEK 的 SHA-256 fingerprint，并通过 Platform DB 唯一约束检测冲突，冲突时丢弃结果并重新生成 DEK/nonce。AEAD 使用 128-bit authentication tag 和版本化 canonical AAD；AAD 按固定顺序对 Secret ID、Owner 类型/ID、Agent ID、Secret 名称、Secret 版本和 `algorithmVersion` 做无歧义的长度前缀 UTF-8 编码。`platform-api` 用 DEK 加密明文，再用部署 active 公钥按 `wrappingAlgorithmVersion = rsa-oaep-sha256:v1` 和至少 3072-bit RSA key 封装 DEK。Platform DB 保存 DEK fingerprint、nonce、ciphertext、authentication tag、wrapped DEK、`algorithmVersion`、`wrappingAlgorithmVersion`、`wrappingKeyVersion` 和生命周期状态；任何字段或 AAD 绑定不一致都必须认证失败。
- 部署只向 `platform-api` 注入版本化加密公钥，向 `platform-worker` 注入对应私钥 keyring；API 不持有可解密历史 Secret 的私钥。私钥不进入仓库、数据库、日志、错误、审计、模型上下文或 Agent Pod；缺少目标私钥、DEK 解封或 AEAD 认证失败、密文元数据非法时 fail closed。
- 新 Secret 先保存为 pending 版本并产生配置修订。`platform-worker` 解封 DEK、受控解密，并以包含 Agent、Secret 版本和配置修订标识的不可变名称创建 Agent 专属 Kubernetes Secret；禁止原地修改已被任一 Workload 引用的 Secret，再调谐只引用该版本化名称的候选 Workload。
- Secret record/reference 的 `configRevision` 表示该不可变 Secret 物化的来源修订，即引入该 Secret 引用的配置修订。Secret 属于 Runtime 输入，该修订必然推进 Runtime 修订，因此它与 Runtime 修订同属一个版本域（[ADR-0028](../adr/0028-separate-runtime-revision-from-configuration-revision.md)），但可以早于后续 Workload 的当前 Runtime 修订；只改变非 Runtime 输入的配置修订不引入 Secret 引用，不产生新的物化，也不改变已有物化的复用。后续配置保留完全相同的名称、Secret ID 和版本时，Core/Store 只能在 Agent 锁内从当前 Runtime 修订的持久化配置派生已验证的 active 物化；Worker 沿用其原始 AAD、Kubernetes 名称和激活 fence，正常物化复用时不解密、复制、重新加密或重新激活；候选模型访问验证仅允许 10.7 的受控解密例外，物化丢失或 UID 变化时仅允许下述受控恢复。custom ACP 的 Session 专属物化按 10.1.1 从原密文进行独立解密和审计，不属于 Agent 级 active 对象的复用，不复制其 Kubernetes 明文或重新激活旧版本。只有新引入或替换的引用才创建并激活新的 pending 版本。
- Platform DB 与 Kubernetes 不共享事务。Worker 只有在观测到目标 Workload 已使用对应版本化 Secret、通过健康检查，且观测到的 Agent ID、Secret 版本、Runtime 修订、Workload UID/generation 与当前 fence 全部匹配后，才能在同一条件更新中将 pending 版本提升为 active；任一值变化都拒绝激活并重新调谐。Worker 重启时幂等恢复 pending、applying、observed 和 active 中间状态。失败或状态不确定时旧 Workload 与旧 active Secret 继续有效，确认新版本生效、没有 Workload 引用旧名称且满足回滚保留策略前不得回收旧版本。
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

- 部署通过既有 ModelCatalogAdapter 提供固定、获准的 Relay endpoint、protocol profile 和流式/tool/reasoning 能力政策；Owner 不能输入 Base URL、认证 header 或目录外 endpoint。目录快照继续使用 `schemaVersion: 1`、精确 `revision`、`validUntil`、TLS/禁止重定向和可用状态，过期、移除或不兼容时拒绝新配置。Responses 与 Messages 仍分别按目录 profile 和标准模板 Driver 绑定，不能按 URL 或模型名猜协议。
- 标准模板申请或 API 创建提交一把 Agent 默认 Relay Key；任一当前 Owner 可替换。使用者在个人设置提交本人用于 Web/企微的 Relay Key。两类 Key 分别以 Agent 或用户为用途和 AAD 加密、版本化、不可回显；API 只写密文，Worker-only keyring 按授权用途解密。平台审计提交者，不使用 Relay Admin API 枚举 Key，也不声称已核实个人 Key 的 Relay 账号归属。Relay 实际按 Key 归属计费和授权；Platform 不建 Agent Group 权威。
- Owner 允许模型与默认模型从 Agent 默认 Key 的 Relay `/v1/models` 可见结果中选取；部署目录可以用 `allowedModels` 进一步限制，但不要求逐个登记模型，值为 `null` 时不限制。reasoning 档位为平台固定的 `low`、`medium`、`high`、`xhigh`、`max`，不按模型、端点或模板登记。`/v1/models` 仅用于候选展示，不证明真实模型请求必然成功：保存时用默认 Key 对新增的（模型，档位）组合各发起一次按模板协议的极小真实请求，失败即拒绝保存，并返回稳定、可操作的原因；已保存且未变化的组合不重复验证。Web/企微只展示 Owner 允许清单，不按个人 Key 预过滤；API 使用同一 Owner 清单。候选、默认值或 capability 无效时拒绝保存或提交，不静默切换模型。实际认证、模型和额度错误由 Relay 返回后映射为稳定、脱敏、可操作的错误。来源与验证的取舍见 [ADR-0030](../adr/0030-source-standard-template-models-from-relay.md)。
- 模型显示名由 API 的受信部署输入提供，按精确的 `endpointId`、`modelId` 关联，并由 ModelCatalog 模块校验名称表及其当前目录关联。名称只用于展示，不参与允许集合、协议、Key、版本或执行绑定；不能从浏览器输入、模型自报名称或解析 `optionId` 推导。名称非空、有界且不含控制字符，重复关联、未知端点或目录政策不允许的模型拒绝；缺少名称时保留真实 `modelId`，不杜撰名称或缩小候选集合。已授权配置查询为内部展示保留端点关联，对外明确选取既有 `ModelOptionProjectionV1` 字段，不透传端点或部署输入。
- 带显示名的默认 Key 候选使用独立的 `GET` / `POST /api/v2/agents/{agentId}/default-relay-key/display-candidates`，响应 envelope 与候选项组成独立的 strict `schemaVersion: 2` 投影；新 Key 和已存 Key 两条路径沿用原授权、候选交集、配置修订及 Key 版本检查后，由 API 装配名称。旧 `/candidates` 路径精确保留原 V1 响应，政策 Catalog V1、部署目录 V2 与 Worker 私有 saved-Key V1 不增加字段。Web 显式消费新入口，选择、比较和保存仍使用原稳定 ID；同名不合并，不把旧响应推断为已支持显示名。契约继续按 §6.4 从 Zod 生成并验证精确兼容边界。
- 每次受理标准模板 Execution 时，在同一持久事务内冻结 `modelOptionId`、`reasoningLevel`、Key 用途、密文引用和版本：Web/企微绑定实际发送者的个人 Key，全部 Platform API 调用及 Eval 样本运行绑定 Agent 默认 Key；Eval 模型评分也绑定其工作项开始时的 Agent 默认 Key。界面明确费用归属。缺 Key、失效或额度不足不自动回退到其他主体的 Key；Relay 拒绝调用时如实失败。个人或 Agent Key 替换后，新执行选新版本，已受理执行继续用旧版本至终态；仅 Relay 撤销或实际调用失败才使其失败。旧密文在所有引用它的执行终态前不能回收，停止和恢复也不得改绑版本。
- 标准模板 Workload 候选仅预检目录/Driver/profile/模型选项结构及固定 Relay 路由；四个模板的真实镜像与模型链路须逐项独立验证。模型选项集合以 `RuntimeModelConfigurationV4` 保存并校验；该配置仅包含 endpoint、protocol、authentication、模型、reasoning 和能力绑定，**不包含 Key 原值或引用**。它可以沿用现有 immutable 配置 Secret、candidate/verified 投影、指纹、fence 和回滚机制，但不再生成 `AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_*`。调谐、回滚和 Pod 重启不能从 Kubernetes Secret、env 或旧 active 配置取得任何用户或 Agent 默认 Relay Key。
- Worker 在当前业务 Grant、Execution、选择与 Key 引用/版本一致后，才通过既有受认证且具传输保密的 Worker–Host 私有接口交付本次 Key；原值只在 Worker 解密缓冲区和 Host/Driver 的本次执行内存存在，不进入 Grant、公共 RuntimeSelection、配置、Pod env、PVC、journal、日志、事件或普通错误。Host 在模型请求前核对 Agent、Conversation、Execution、渠道/用途、版本及 operation/fence；同 Agent 的不同用户和相邻 Execution 不能复用传输能力。补充指令继续绑定原 Execution。Worker/Host 重启时只为仍获准的原执行重交同一版本；无法确认旧版本或授权时拒绝恢复，不用当前 Key 替代。执行结束排空在途请求后清除内存中的 Key。
- `RuntimeHostV4` 的 `existing-accepted-only` Key 恢复输入仅允许原 Submit 或原 native Skill 请求。Skill 保留原能力、目录修订、来源版本和参数摘要，不虚构普通 Turn 的 input/selection，不重新发现同名 Skill。Host 必须以原 journal 的 accepted/running 回执、操作摘要、Key scope、模型配置绑定和当前授权/fence 核实；缺少原记录或冻结绑定、unknown/终态、stop/control 均不安装 Key，command/supplement 不能冒充恢复原操作。恢复只重交原版本到受保护内存，不重新 invoke，也不改变既有控制绑定和元数据只读边界。
- 四个 Driver 均须在每次实际模型请求前证明原 Execution Key 版本绑定。Codex/Claude 的本地传输按原生 Turn/Query 隔离；OpenCode/Pi 即使相邻执行选择同一模型，也不能复用在启动时固定了旧 Key 的原生 handle。若固定上游不支持可信的执行期换 Key，Driver 须先停止并排空旧 handle，再以同一原 Session 和新执行 Key 重建；无法确认旧 handle 退役或 Session 连续性时拒绝新执行。恢复旧执行只可重交旧版本，不能以新 Key 重建后继续旧执行。
- 标准模板的 Worker–Host 使用 `RuntimeHostV4` 的独立版本化私有 Key 字段和共享 Schema；不能把旧 Runtime 配置 V2/V3 中静态 credential 当作新执行的默认值。旧 Host V1–V3 和 verified 投影保持原样可读以供已受理执行的查询、有界恢复和迁移，不推断缺失字段或重写指纹；迁移到 V4 无 Key 配置并完成实际链路验证前，旧版本不接纳新业务 Execution。候选失败沿原 verified 投影和精确清理机制收敛，但不能回滚到会重新准入静态 Key 的配置。既有 [Execution 模型选择 ADR](../adr/0004-bind-execution-model-selection-to-runtime-submit.md)和[协议绑定 ADR](../adr/0009-bind-model-profiles-to-runtime-configuration.md)继续约束选择和 profile；静态凭证交付部分由[按 Execution 绑定 Relay Key ADR](../adr/0016-bind-relay-key-to-execution.md)替代。
- 自定义 Agent 的模型配置仍属镜像内部。Generic ACP 只读取当前 Runtime 模型选项并转发选择，不能取得平台保存的个人或 Agent 默认 Relay Key；Owner env/Secret 按 10.1.1、10.6 进入其专属 Session。custom ACP 沿已验证的 Worker/Host 版本化业务契约使用不含标准模板 Key 绑定的业务 Grant，业务与控制授权仍严格分离；当前 HTTP V3、Grant V2 与 Store 内部协议标记分别按各自共享 Schema 校验，不能用内部标记推导 HTTP 版本。此 custom 路径不允许标准模板降级，不修改 V4 Schema 或把其 Key 绑定变成可选。

### 10.8 Codex 原生模型传输边界

Codex Driver 在 Agent Pod 内管理一个仅绑定 loopback 的模型传输入口，将原生模型请求转发到
该 Agent 当前配置中所选模型选项的已批准 Relay endpoint。本次 Execution 的 Relay Key 仅保留在父进程内存；
每个 Conversation 代次的原生进程只持有独立随机、短期且绑定该进程的 loopback token，
不能跨 Conversation 共享。入口由 token 得到服务端固定的 Conversation，再查询已确认的
原生 thread/Turn 与原 Execution 关联；请求 header 或正文不能建立、迁移或恢复该关联。
准入、在途请求和撤销均按该 Conversation 划分，外来请求失败不能影响其他 Conversation。
该入口只接受固定的 Responses 路径，不接受调用方选择上游、任意路径、跳转或代理配置；
原生进程退役时撤销其 token 与新准入，重建进程使用新 token；关闭 Driver 后关闭入口。

部署配置以版本化、不可变的选项集合传入 RuntimeHost；每个 `modelOptionId` 独立绑定 endpoint、
真实 model、允许的 reasoning，不因 model 名称相同而合并。Execution 已冻结
的 optionId/reasoning 决定该次原生 Turn；重试沿用原选择，未知选项、配置版本或路由标识拒绝。
Worker 负责目录解析和无 Key 的配置投影、按 Execution 交付受限 Key；RuntimeHost 不读取目录、数据库或 Kubernetes。

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
的 loopback 地址，不接受主机名或其他 IP 别名。V4 标准模板配置的 HTTPS endpoint
只接受域名，不接受 IP 字面量、`localhost` 或其子域；目录准入仍须核对获准的固定 Relay
端点，域名输入校验不能替代出站目的地址与禁止重定向的运行时约束。
本次交付的 Relay Key 必须为 16–8192 个可打印
非空格 ASCII 字符；配置准入拒绝过短值，避免逐子串泄漏检测误拒正常 SSE 字段。
长度下限不替代既有凭证泄漏检测，也不作为凭证熵或供应商认证有效性的证明。

固定 Codex 版本的 `turn/start` 不能切换 provider，因此 Driver 使用每选项唯一的内部模型名
`namespace/model`，namespace 从选项身份确定性生成且仅含非空 ASCII 字母、数字、`_` 或 `-`；
整个别名恰好一个 `/`，model 保留不含 `/` 的真实模型名。固定版本按 model 后缀最长前缀匹配
能力元数据：命中固定 release 内置条目时沿用其元数据，未命中时使用固定 Codex 的默认回退元数据与默认系统指令；
Driver 不要求模型出现在 `model/list` 中，也不为单个模型生成、复制或登记元数据。多斜线或非法 namespace 的配置拒绝。父进程仅按完整
内部模型名查询当前批准集合，将请求的 model 改回真实 model，并使用该项固定 Relay endpoint 与原 Execution 的 Key；不根据模型正文、调用方 URL 或同名 model 猜测路由。
标准 Codex 模板的模型目录随 Runtime 镜像固定，只包含固定 release 的内置条目，不含平台追加条目；
有特殊需要的模型参数由 Owner 通过模板开放的环境变量配置。模型与档位能否使用由 §10.7 的保存时真实请求判定，见
[ADR-0030](../adr/0030-source-standard-template-models-from-relay.md)。
同一会话连续切换两个真实 model 同名的选项，以及相邻 Execution 使用不同 Key 版本，必须有原生测试；
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

每个提交操作在持久 prepare 阶段绑定非敏感模型配置版本，先于原生副作用；恢复 running 或准入不确定执行的业务能力时，在首次 native RPC 和转发授权前验证该版本与当前配置一致。历史绑定缺失或版本不匹配只拒绝对应执行的业务恢复，不阻止 Host 启动，不回填未知来源。已持久终态和事件无需原生恢复时仍可读取；同一 Session 无旧 active 或不确定执行后，新授权 Turn 可使用当前配置。模型配置版本随端点、模型选项集合、模型、推理等级或默认选择变化而更新；Key 替换只更新 Execution 绑定的 Key 版本，不改变旧执行的模型配置绑定。持久状态不保存端点、Key 或其摘要。

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

V4 原执行已被 Host 接受而 Platform 丢失 Host Session Ref 时，Worker 可持原执行的
`session.status` 控制 Grant 和原请求摘要调用 V3 私有控制接口的只读
`original-binding` 操作，查询
FileRuntimeStore 已持久的原接受绑定。Host 须重新校验服务身份、控制授权、原
Execution/Turn/代次/fence 与请求摘要；仅返回已保存的真实 Host Session Ref，
不得创建或猜测引用、恢复业务准入或重装 Key。Core 在原 claim 的租约/fence 下
CAS 回填该引用，失败或来源不明时保留 unknown 占用；成功后继续原 stop、终态、
事件游标与 ACK 路径，不晋升后继执行。该只读控制响应以版本化 Schema 和生成
OpenAPI 发布，旧 V3 操作与响应保持原义。

RuntimeHost wire contract、Execution 模型选择、Platform/Connection 权威边界和 #403 的原生
持久数据保持；多用户隔离仍由独立验收证明。正式镜像验收必须包含成功 Turn，以及 HTTP 与
流内失败、取消、异常流的合成负向场景，递归检查原生持久历史、日志与 HTTP/SSE 的脱敏结果。
取舍见 [ADR: Codex 模型错误在原生持久化前脱敏](../adr/0007-sanitize-codex-model-errors-before-native-storage.md)。

### 10.9 Codex 原生 Conversation 隔离边界

Codex Driver 为每个 Conversation 代次维护一个独立的原生 `app-server` 进程。进程选择键由服务端
从可信 `agentId`、`conversationId` 与 `sessionGeneration` 派生，不接受调用方提交的字段，也不由
原生回包决定。每个进程独立完成 pinned provenance、`initialize` 与受限配置准入；一个进程的准入
结果不为另一个进程担保。一个原生传输只允许一个请求多路复用器。

原生持久存储位于该 Session 所属 Sandbox PVC 上 Driver 状态的同级目录，按 `conversations/<key>/{home,workspace}`
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

上述 Codex 进程/文件边界是 Sandbox 内的防护，不再充当 Agent 共享 Pod/PVC 的隔离依据。
它约束跨 Conversation 访问与凭证读取，不限制本 Conversation 内原生工具的种类（§10.14）。
资源与版本化 Grant 绑定遵循 §10.1.1，§10.8 的模型传输与凭据保护继续有效。
验收必须使用真实 pinned Codex 与正式 Host/Driver/Bridge，覆盖并发、进程重启与原 Session 恢复；
本人访问必须成功，工具普遍不可用或平台能力关闭都不构成隔离通过。取舍见
[ADR: 按 Conversation 隔离 Codex 原生进程与文件边界](../adr/0008-isolate-codex-native-processes-per-conversation.md)。

### 10.10 Claude 原生模型传输边界

Claude 原生进程会将模型 API 的错误正文写入会话记录；仅归一化 SDK 事件不能满足凭证与
供应商错误正文不落盘的要求。固定 Claude Driver 在所属 Sandbox Pod 内为每次 Query 创建
独立的 loopback 传输入口，绑定该 Query 已批准的唯一 endpoint、认证、模型和 reasoning。
本次 Execution 的 Relay Key 只保留在 Driver 传输层内存；原生进程只获得该入口的随机短期能力，不能
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
官方 release 未提供可验证的每次尝试 callback 时，标准路径不宣称 Codex 原生屏障 conformance。
PRD 的外部操作只指 [§10.14](#1014-标准模板-session-sandbox-原生工具) 的平台中介调用。无论发行路径
如何，这类调用的持久 intent、当前授权、结果或 unknown 确认仍是准入前置；其中无法观察或控制的
隐藏尝试必须记录为能力缺口，不能用日志、普通 approval 或缓存补足。官方路径无法在该边界可靠
控制的平台中介调用必须拒绝或标记未支持，不能作为正式 conformance。Sandbox 内的原生工具与获准的
原生出网按 §10.14 默认启用，不以缺少该 callback 为由拒绝。

Runtime Driver 直接执行的标准 MCP 路径按 [§13.5.4](#1354-runtime-driver-直接消费标准-mcp)
使用官方工具请求/结果接缝：网络动作与秘密读取留在受保护 Driver 内，在原生工具响应前完成
持久确认。此覆盖仅适用于该 Driver 执行的 MCP 操作，不授予其他原生工具 native barrier
conformance，也不改变下述私有 lane 的前置；Sandbox 内原生工具本身不需要该 conformance（§10.14）。

首方 `workspace-summary` 使用 Driver 直接执行的受控 `workspace.read_text_file` client tool，
不依赖原生 shell。工具根目录由已验证的原生进程与当前 Conversation 绑定派生；模型只能提供
相对文本路径，每次最多返回 4096 字节、每个 Execution 最多四次新读取。绝对路径、父路径、
符号链接、非普通文件或无法确认归属的目标拒绝读取。新 Thread 固定工具版本；既有 Thread
不能因部署更新静默增加工具。读取前保存原 Execution 的操作意图并等待确认，实际读取及
结果交付分别重验 Host 当前授权；结果或 unknown 仍沿原 journal、游标与 ACK 交付。路径、
文件正文和凭据不进入操作事实。该本地只读能力使用独立 namespace，不复用 Connection
身份，也不授予私有 native barrier conformance；原生文件、进程与网络工具按 §10.14 另行启用。
详细约束见
[Runtime HLD 8.5.1](HLD-agent-runtime-M1.md#851-codex-原生执行屏障)。

带附件的原生 Skill 使用独立的浏览器 Invocation V2 与 Worker→Host Native V5 契约；既有
Invocation V1、Native V4 和无附件 command 的严格请求/响应保持原样。附件必须成为同一次
Execution 的持久输入、幂等摘要与 V4 business Grant 的精确只读集合。签名摘要覆盖 V5
业务请求的规范化字段及完整附件序列，排除 Grant token、独立私有 Key 原值及其摘要；Key
用途、引用和版本仍精确绑定。不得从自由参数解析文件授权，也不新增 Grant 用途或交付凭据。
Codex 只通过现有 FileAuthority/FileBridge 将有界文本准备到当前 Conversation、当前执行的
专属临时子目录，再由上述只读工具读取；不保留供下一次执行绕过授权的副本。版本接收、
清理与启用门禁见 [Runtime HLD 的执行期文本输入](HLD-agent-runtime-M1.md#codex-skill-的执行期文本输入)。

需要私有 FD callback、Connection bootstrap/recovery 或等价 native lane 的能力，只有在部署
provenance 明确声明该 lane、协议/Schema 与工具覆盖，并实际验证不可关闭的 native barrier 后
才能启用。私有 lane 只服务于平台中介调用，不是 Sandbox 内原生工具的启用前置。该 barrier 在每个真实外部动作前等待 Driver 的持久 intent 与 Host 当前授权，在
结果或 unknown 可靠保存前不得交付原生推理循环；缺失、错配、断连、过期或被模型/Owner
配置关闭时 fail closed。专用 FD 必须由 native 接管后设置 close-on-exec，工具子进程不能继承
或重开控制端。普通官方路径与私有 lane 的 capability 必须分别声明和验收。

本 M1 路径不维护第三方 Codex 源码补丁、vendor builder、派生二进制或下载编译流程。若
上游 release 缺少所需接缝，先走 upstream contribution；引入任何受控 derived/private artifact
前须由单独架构决策明确其来源、供应链证明、维护责任和退出路径，不能在实现中隐式恢复旧
vendor 方案。Platform、Connection、Host 和 Driver 继续使用 TypeScript，不新增自有 Rust
crate、推理循环、服务、插件平台或统一 Sandbox。

PRD 的外部操作持久意图、当前授权和真实结果要求不变，适用范围是 §10.14 的平台中介调用；官方 release 的协议可用或部分
能力通过不能被解释为完整 M1 验收。尚不能满足的平台中介调用必须标记未通过，不能以本节豁免
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
[ADR: Codex 原生操作必须经过持久执行屏障](../adr/0011-require-codex-native-operation-barrier.md)（适用范围由
[ADR-0031](../adr/0031-enable-native-tools-inside-session-sandbox.md) 收窄为平台中介调用）及
[ADR: Codex 模型切换压缩使用当前有效选择](../adr/0014-use-current-selection-for-codex-switch-compaction.md)。
原执行屏障的既有评审不代表新增压缩策略已获评审；差额的文档和 Issue 范围先完成独立架构、
安全及维护评审，再修改 native/code/pin，沿同一 primary Issue 与实现 PR 交付。

### 10.12 Builder 与多服务自定义 Agent

本节决策记录见 [ADR-0026：Builder 是普通 Agent](ADR-0026-builder-is-an-ordinary-agent.md) 和 [ADR-0027：多服务使用受限的标准 Kubernetes 资源描述](ADR-0027-multi-service-standard-resource-description.md)；领域术语见仓库根目录 [CONTEXT.md](../../CONTEXT.md)。

Builder 是标准模板上的普通 Agent，复用 Platform 的 IdentityContext、Agent 可用范围、Conversation/Execution、审计和部署状态。M1 不提供独立 Builder API、平台 Build Service、构建批次或构建清理能力。Builder 读取或修改 Repo 必须经现有 Connection 授权，使用隔离分支和独立临时工作区，不接受调用方粘贴的 Token，也不能直接写入受保护分支；源码变更必须可查看、可审计并提交 PR。镜像由仓库已有 CI 或用户自己的构建流程提供，平台只消费部署批准的不可变 Digest。

Builder 可以生成 Dockerfile 和受平台约束的多服务 System Manifest。多服务系统在 Platform DB 中仍表示为一个 Agent 管理对象，只支持 self-managed 模式；平台不创建多 Agent 生命周期，不把 Compose 作为请求格式，也不渲染 Helm。服务集合、入口服务、镜像 Digest、配置和版本整体管理，不承诺服务切换具有分布式原子性；数据库迁移、持久业务数据兼容和恢复由系统部署流程与 System Owner 负责。

多服务版本只接受受限的标准 Kubernetes 资源描述：Deployment 或 StatefulSet、Service、ConfigMap、PVC 和发布前迁移 Job。请求以内联 YAML 提交并作为不可变版本的一部分保存。字段白名单、资源规格档位、单 Agent 总量上限和固定入口 annotation 是契约的一部分；平台注入名称、标签、ServiceAccount、NetworkPolicy、入口路由和规格档位。平台拒绝 privileged、hostNetwork、hostPath、自带 ServiceAccount 或 RBAC、未经批准的 Secret 引用、未获准 Registry 和非 Digest 镜像。

平台在绑定 Agent 版本和实际调谐前，按最终资源内容执行准入。所有服务通过准入和真实就绪检查后，才创建或切换版本；实际资源只能由 platform-worker 调谐，并且必须与已准入内容一致，内容变化必须重新准入。入口服务是唯一对外路由，非入口服务只在同一 Agent 内可达。任一服务失败时返回受控失败原因，旧版本继续提供服务；失败原因不含日志正文、凭证、内部地址或用户输入。

Builder 的部署前评估和运行后检查必须以真实资源和批准的镜像为依据。静态分析、mock 或 healthz 不能单独证明能力可用；不支持的资源、不能部署或证据不足时如实拒绝。多服务能力通过契约 seam、准入、Worker 调谐、服务网络、入口路由、失败回滚和升级验收逐步交付，单服务或 fixture 通过不能替代完整多服务验收。

### 10.13 OpenCode 原生工具回执与来源

标准 OpenCode 路径使用固定官方 release，版本和 target 字节以
[OpenCode release 声明](../../packages/agent-runtime/src/opencode-release.json)为唯一来源。
ACP 权限请求和进度通知只按各自协议含义消费。Sandbox 内的 OpenCode 原生工具按
[§10.14](#1014-标准模板-session-sandbox-原生工具) 默认启用：ACP 权限请求由 Driver 按部署固定策略
应答，工具事实取自 ACP 工具调用的开始与终态通知。本节其余的逐 attempt 回执、受控扩展与
fail closed 前置，只适用于需要承担平台中介调用的工具路径。这类路径须逐项证明每次外部动作的
持久 intent、当前授权、可信开始及结果或 unknown；权限通过、Plugin before/after hook
或某个工具通过不能补足未观察到的实际尝试与失败终态。

Issue #957 的固定源码回读记录了 v1.18.30 (`3104c1428ec91f809e5ab86631300de41eb6952`)
与官方 v1.18.33 (`51ef4be1d3c122f18fefb510dca8d778571f4f18`) 的五个接缝文件字节相同；
该局部比较不等同于整版相同或升级批准。当前仓库 release 清单的 target 是
`darwin-arm64`、`linux-arm64-musl` 和 `linux-x64-baseline-musl`，其 artifact/hash 仍以
上方 release 声明为准。源码观察点和边界如下：

| 接缝/观察点 | 固定源码证据 | 结论 |
| --- | --- | --- |
| 权限与实际写入 | `packages/opencode/src/tool/edit.ts:102-111`；内部先 `ctx.ask` 再写入 | before hook 不能证明权限通过或实际 I/O 开始 |
| 调用与成功 | `packages/opencode/src/session/tools.ts:106-133` | `execute`/after hook 只表示外层调用返回，不是逐 attempt receipt |
| running、错误与取消 | `packages/opencode/src/session/processor.ts:164-206,331-352,585-606` | 原生状态/中断清理不证明实际 I/O 已开始或执行源已退出 |
| Plugin 接缝 | `packages/plugin/src/index.ts:266-285`；`packages/plugin/src/tool.ts` 的 V1 `ToolContext` | 公开契约没有覆盖每次内部尝试和失败终态的强制 receipt barrier |
| 内部新尝试 | `packages/opencode/src/session/processor.ts:674-688` | provider retry 不是每个工具内部动作的回执 |

因此固定版本、target 和已有 artifact/hash 可以回读；公开扩展的来源/hash、无歧义调用绑定
及逐 attempt receipt 仍是启用前置，未证明时保持 fail closed。上述源码观察只证明文档决策，
不证明四模板真实 Provider/Connection 或 Runtime 验收。

本决策与既有产品和功能票的映射保持如下边界：

| 权威/义务 | 本决策保留的边界 | 状态 |
| --- | --- | --- |
| Platform PRD §2/§13.3/§14、#483 | 实际 I/O 与唯一事实仍由受控 Driver 执行叶子和既有 journal/Worker 事务产生 | 设计约束；#483 真实 Provider/Connection 仍开放 |
| #929 AC-2 | permit 是准入，`started` 只来自实际 I/O/dispatch；未观察到的开始不填造 | 文案已澄清；#929 仍未验收 |
| #930 | ACP progress、before/after 和自有工具不能替代原生 effect receipt；原 built-in 缺口保留 | #930 Draft/能力缺口保留 |
| 四模板、恢复、取消、隔离与 P1 工具义务 | 不因本决策或受控扩展通过而缩减原产品矩阵 | 由后续实现票逐项验证 |

优先通过 upstream contribution 提供可等待、不可由模型或 Owner 关闭的原生接缝。
官方 artifact 缺少可靠接缝时，记录对应能力未通过；不把完整 M1 义务改成模型子集或永久
unsupported 清单。当前 M1 不维护、准备、应用或构建 OpenCode 上游补丁、derived/private
artifact、vendor builder 或修改版发行物，也不把 source-review packet 当作实现交付。若官方
artifact 缺少可靠接缝，运行时必须拒绝对应能力并保留能力缺口；不能通过本 Issue、架构评审、
fixture、环境变量或部署说明授权例外。Upstream contribution 可以由上游项目另行接收和维护，
但不属于本仓实现、运行 pin 或验收证据；不能因此在本仓下载依赖、编译源码、发布或启用修改版，
也不能另建 vendor 服务、插件平台或推理循环。

官方公开工具扩展可以作为受控执行请求入口，实际 I/O 位于现有 Driver 信任域的执行叶子；
扩展只能请求执行并等待结果，不能提交可信开始或结果事实。该路径复用既有 journal、Host
当前授权和 Worker 事务，不新增部署单元或事实权威。启用前须证明工具行为、每次实际尝试、
取消与恢复等价，并阻断所有绕过屏障的原工具入口；固定扩展及配置不可由模型或 Owner
改写。受控工具的证明与官方原 built-in 分别记录，不能因替代路径通过而声称原 built-in 已通过，
也不能缩减完整 M1 工具义务。调用绑定、控制隔离或等价能力尚未证明时，对应能力保持未通过。

原生工具接缝留在 Driver 与原生进程边界，复用唯一公共实际操作事实、现有 journal、Host
授权和 Worker 事务/游标。控制通道不得被工具子进程继承或由模型配置改写；具体确认顺序、
取消与隔离要求只在 [Runtime HLD 8.5.3](HLD-agent-runtime-M1.md#853-opencode-原生工具回执)维护。
OpenCode 模型传输与 Execution Key 版本、原 Session 和 Connection 独立权限继续遵循
既有契约；工具接缝通过不转移这些验收证明。

候选与回滚 artifact 均须验证原数据、终态读取及 active/unknown 的兼容恢复，复用原 PVC
并核实原 attempt；缺少原执行要求的接缝时保留未确认状态，不能重建 Session、降级协议或
重发副作用。官方 artifact 与扩展升级须满足原执行所需的工具覆盖、隔离与故障矩阵，
升级和回滚继续执行 10.4 的恢复流程。[Runtime HLD 11.1](HLD-agent-runtime-M1.md#111-通用-runtime-与-driver-验证)
记录原生矩阵；文档决策、Fixture 或共享 Host 通过均不证明四模板真实模型/工具验收完成。

### 10.14 标准模板 Session Sandbox 原生工具

产品范围见 [平台 PRD 第 4 节](../prd/PRD-agent-platform-M1.md#4-标准模板)与
[§13.3](../prd/PRD-agent-platform-M1.md#133-真实结果与可靠性)，决策与取舍见
[ADR-0031](../adr/0031-enable-native-tools-inside-session-sandbox.md)。本节是原生工具准入范围的
唯一工程权威；各 Driver 的映射与验收只在
[Runtime HLD 8.5.4](HLD-agent-runtime-M1.md#854-session-sandbox-原生工具)维护。

四个标准模板在 Session Sandbox 内默认启用固定版本的原生工具：shell 与进程、文件读写、编辑与
补丁、目录列举与搜索、原生 Skill 及其脚本，以及该版本自带的网络工具。隔离依据是 §10.1.1 的
Session Sandbox，以及 §10.9 等各 Driver 的 Conversation 文件边界。原生工具不以缺少每次尝试的
执行前回调为由拒绝，Driver 也不能为此退回只允许模型输出的模式。自定义 Agent 不受本节约束。

| 类别 | 范围 | 准入与事实 |
| --- | --- | --- |
| Sandbox 内本地操作 | 命令、脚本、后台进程、文件读写/编辑/补丁、列举与搜索 | 默认放行；同时受 Conversation 文件边界、独立进程/挂载/IPC namespace、设备与 syscall 限制及资源配额约束，不得访问其他 Conversation 或宿主控制面。Driver 从原生开始与终态事件记录工具事实（§18.1），不保存执行前 intent，也不逐次重验 Host 授权 |
| 原生直接出网 | 命令行网络访问、包管理器、原生网络工具 | 由部署批准的出站策略（§10.1.1）在网络层预先授权；Runtime 只记录工具事实，不逐请求拦截。策略外目标由网络层拒绝 |
| 平台中介调用 | 模型请求（§10.8、§10.10）、Driver 执行的标准 MCP 与 Connection 调用（§13.5.4）、Driver 执行的受控工具、平台文件与接口操作、Browser 外部副作用（§11.5） | 这就是 PRD §13.3 所说的外部操作，保留持久 intent、当前授权、结果或 unknown 的执行前屏障（§18.3） |

模型供应商托管的工具（例如 Codex `web_search`）随模型请求执行，属于平台中介调用，是否可用取决于
获准模型端点。原生功能中需要额外平台中介调用的部分，例如需要归属额外模型请求的原生子 Agent，按
该类调用的规则单独验证后启用。

- **凭证。** Relay Key、模型传输 loopback token、Connection、MCP 与 Browser token 和平台服务凭证
  只留在受保护 Driver 的内存或不向工具子进程开放的通道。原生工具子进程使用最小环境白名单，
  不继承宿主环境、代理变量或任意 `AGENT_INFRA_*` 变量；不挂载凭证类 Secret 或凭证文件，并在启动
  前关闭非必要的继承 FD。仅排除已知变量名不构成证明：部署须用负向验收证明上述凭证不能经环境、
  `/proc`、挂载文件或继承的 FD 读取。某模板做不到时，只关闭受影响的工具并记录缺口（fail closed），
  不关闭其余原生工具。
- **审批与配置。** 原生审批或权限请求由 Driver 按部署固定的策略应答：Sandbox 内本地操作批准，越出
  Conversation 文件边界的请求拒绝。模型、Owner、工作区文件或 Skill 都不能改写该策略，也不能关闭
  文件边界。
- **事实。** 工具事实记录实际工具标识、开始、终态、耗时和受限的结果引用。命令行、参数、
  stdin/stdout 和文件内容不进入事实、审计或遥测，原生合法输出仍走既有业务路径。
- **恢复与停止。** 原生进程或 Driver 崩溃后，原 Turn 按 [Runtime HLD 7.3](HLD-agent-runtime-M1.md#73-重启恢复)
  收敛为真实终态或 unknown，不自动重放 Turn 或工具。停止以原生 Turn 中断确认为准。Turn 结束后，
  残留的后台进程只能作用于本 Sandbox 和获准出网，不延长 Execution 占用，也不能取得平台中介调用的
  新准入；这些进程随 Session 关闭或空闲回收清理。
- **文件交换。** 回答内 `sandbox:` 引用的结果发布属于平台文件操作，按平台中介调用保存 intent、
  核对当前授权并保存结果或 unknown。附件物化属于 Turn 提交准备，沿 Execution Grant 与运行期文件交换的
  当前授权执行，不另记工具事实。两者的规则见 §15.4.4。原生工具对工作区内已物化附件和待交付文件的
  读写仍是 Sandbox 内本地操作。
- **不变。** 跨 Conversation 与跨 Session 隔离及其负向验收、§10.8 的模型错误脱敏、Connection 授权，
  以及 §10.11 对私有 lane 的要求（只用于平台中介调用）均保持不变。

## 11. Agent Runtime 边界

### 11.1 Platform Conversation Contract

Web、任务 API、Eval 执行和平台托管渠道只面对统一 Platform Conversation Contract。该 Contract 定义创建或恢复 Runtime Session、为新消息或重新生成提交一个带 Execution 已固化有效模型选择的 Turn、停止 Turn、查询状态、接收规范化事件和读取 capability，不暴露 ACP、Pi RPC、stdio 或其他 Runtime 原生消息。

四个标准模板实现完整 Contract。使用平台交互入口的自定义 Agent 通过 Generic ACP Adapter 实现 Contract；使用自有交互入口的自定义 Agent 不进入该 Contract；管理 API 可用不能被解释为任务 API、观测或 Eval 可用。自定义 Agent 的这些能力以接入验证结果为准。

### 11.2 Adapter 部署与 Registry 边界

`platform-worker` 只运行 RuntimeHost Client Adapter，并通过 Agent Service 的内部 HTTP/SSE Interface 调用 Pod；RuntimeHost 和 Native/ACP Driver 在 Agent Pod 内运行。M1 使用固定 Registry，不动态发现或加载 Driver；标准模板绑定、自定义交互模式和 capability 派生规则只在 [Agent Runtime M1 HLD](HLD-agent-runtime-M1.md#3-runtime-registry-与交互模式) 中完整维护。RuntimeHost 的依赖方向和未来抽取维护标准见 [RuntimeHost 未来抽取与维护标准](HLD-agent-runtime-M1.md#12-runtimehost-未来抽取与维护标准)，工程 Spec 不重复定义。

Codex Linux 的默认 Landlock 部署必须启用并完整支持 ABI V5 的文件系统权限，且允许运行用户在非 root、只读根文件系统、移除全部 capabilities 和 `no-new-privileges` 的约束下安装并应用规则集。原生执行前必须通过实际规则集安装完成能力准入；不能根据 `uname` 或内核版本推断支持，也不能接受部分权限降级。对于每个由 Worker 独占管理、具备专属 Pod/PVC/NetworkPolicy/Secret 的标准 Runtime Pod，可以按 [ADR-0035](../adr/0035-codex-container-boundary-mode.md) 选择 `container-boundary`：Codex 保持 Provider `workspace-write`，专属 Pod 是文件/进程边界；该模式适用于标准 Agent-level Workload 和 Session Sandbox，不适用于共享 Pod、私有 callback lane 或自定义 Agent。Worker 必须以部署 service token 对唯一 Agent 或 Agent/Session scope 生成 HMAC attestation，Runtime Host 只接受匹配的 `worker-v1` boundary 输入。内部后端、可信部署工具与启动顺序见 [Codex Linux sandbox 启动准入](HLD-agent-runtime-M1.md#101-codex-linux-sandbox-启动准入)。

Agent Pod 的 `/tmp` 挂载部署控制、具有显式容量上限的内存临时卷，随 Pod 删除，不保存业务持久数据。Runtime 为每次原生启动分配独立临时目录，仍遵循 [Conversation 隔离边界](#109-codex-原生-conversation-隔离边界)，不能把共享 `/tmp` 根加入原生文件访问许可。生产 Workload 和镜像准入探针必须使用一致的临时卷容量与安全约束；部署参数见 [Kubernetes 交付拓扑](../../deploy/README.md)。

### 11.3 数据与生命周期边界

Platform DB 是 Conversation、Message、Execution 和规范化事件的权威来源，只保存 worker 侧 Client Adapter 使用的不透明 RuntimeHost Session Ref。RuntimeHost 在所属 Sandbox PVC 上保存该引用与 `agentId`、`conversationId`、`sessionGeneration`、§10.1.1 的 Sandbox 归属及 Native Session ID 的绑定；Native Session ID 和原生事件细节不能跨出 RuntimeHost。Host Session Ref 和 Native Session ID 都不能成为浏览器、API、渠道或 Agent 请求中的身份与授权依据。API 与 Eval 复用这套权威关系，不新增 Session 或调度服务。

Session/Turn/Event 映射、并发、幂等、SSE 补发和 Pod 重启恢复的完整契约见 [Agent Runtime M1 HLD](HLD-agent-runtime-M1.md)，本文不重复定义协议字段。

### 11.4 原生命令与已安装 Skill 边界

产品范围见 [平台 PRD §11.3](../prd/PRD-agent-platform-M1.md#113-原生命令与已安装-skill)；目录、调用、固定官方版本及验证矩阵只在 [Runtime HLD §5.1–5.4](HLD-agent-runtime-M1.md#51-命令与-skill-目录及调用) 维护。该能力扩展现有 Platform Conversation Contract，复用公共 Schema、生成 Client、HTTP/SSE 和固定 Driver，不创建插件框架、第二任务调度器或独立聊天应用。

- 部署维护者负责审核并固定命令映射、Skill 包来源、版本及内容摘要，与 Runtime 镜像和配置修订共同验证、升级和回滚。部署只装配获准的目录及资源，排除个人 HOME、祖先目录、全局配置和未经批准的自动发现来源；不把放开一个禁用开关视为完成装配。Skill 包不得夹带凭据、自动安装依赖或扩大 §10.14 之外的工具/网络权限，运行时不能改写已选择版本。
- Platform Core 解析当前主体、Agent 与 Conversation 归属，校验参数、能力修订及调用权限；Store 继续保存权威受理和结果，Worker 仍是唯一投递方。Host 只在已认证的内部接口上消费当前授权及冻结绑定，Driver 将获准能力映射到该固定版本真实公开接口；原生 ID、文件路径、配置和协议帧不透传 Web。
- 能力目录不是授权凭据。新业务调用取当前权限与原受理范围的交集，并保持原模型选择、Key 版本、文件授权和 Connection 独立身份边界；目录读取不获得执行权限。只读命令不创建业务 Turn；产生 Turn 或改变原生状态的操作必须先持久受理，复用原 outbox、串行占用、操作事实和恢复路径。
- 命令目录按固定 Driver 的受控方法映射描述真实副作用和参数，不能从命令自由文本、Skill、模型或浏览器声明推断授权类别。副作用与参数描述必须进入目录修订，变更后旧选择失效；同名命令及别名不能绕过分类。目录读取本身保持只读，不因描述有状态命令而获得执行权。
- 既有命令目录 V1 只表达真实只读、无参数的命令。有状态或需要参数的命令以显式新版本贯通 Runtime、Host、Worker、API、生成 Client 与 Web，不放宽 V1，也不把压缩等操作误标为只读以迁就旧 Schema。新版本未协商或执行接缝不完整时，明确表示该能力不可用；不能以全部隐藏宣称交付完成。Web 按声明呈现副作用及参数，只有确实只读的命令才能显示“只读”；无参数命令继续拒绝未声明参数。
- 原生 CLI 支持不等于 SDK/API 支持。公开接口缺少所需绑定、事实或恢复接缝时，按具体能力拒绝并记录差额；不能用普通提示、模型自报、私有协议或修改上游产物补齐。尤其不能以 Skill 作为绕过 §10.8–10.14 或文件、隔离、授权门禁的入口。
- 新契约采用显式版本协商；旧 Driver/Host 缺少命令或 Skill 语义时返回不支持，不把新输入降级为旧文本 submit。旧消息、控制、任务与恢复语义保持；新增能力不能迫使旧任务重建或重放。
- 目录只在已有原 Execution 时读取（[§9.3.1](#931-原生元数据读取授权)、[Runtime HLD §5.1](HLD-agent-runtime-M1.md#51-命令与-skill-目录及调用)）。尚无原 Execution 的会话，包括首条消息前的新会话，不读取原生目录，也不为读取目录创建 Runtime Session 或 Execution（[Runtime HLD §7.1](HLD-agent-runtime-M1.md#71-session-生命周期)）；Web 在输入框说明发送首条消息后才能使用命令与 Skill。这是 M1 的确定行为，不属于能力缺口。

#### 11.4.1 有状态原生命令

本节定义 Codex 原生压缩的有状态命令合同，使用业务执行授权。命令发现及执行前的目录
重验仍是只读操作；§9.3.1 的 metadata context、证明和期限不能授予压缩的执行权，也不能
充当受理后执行的生命周期。已受理命令沿既有 Execution 租约、停止和恢复机制运行。

该调用以新版本贯穿受理计划、Worker、Host 和 Driver，除既有命令标识、目录修订、来源
版本、参数及其摘要外，还须在持久受理时冻结有效 `modelOptionId`、`reasoningLevel` 和
Execution Key 绑定。能力类别及原生方法由服务端受控映射确定，调用方不能自行声明只读或
有状态来改变授权。旧版本缺少上述绑定时明确返回不支持；旧只读命令保持原义，存量计划
不从当前 Conversation、默认模型或当前 Key 补值后重新投递。

当前 Runtime Driver 的 authoring contract 为
`RuntimeDriverNativeCommandV2Schema` 与
`RuntimeDriverNativeCommandOperationRecordV2Schema`；它们以 `schemaVersion: 2`、
`effect: "state_changing"`、冻结选择、Key binding 和授权记录 ID 固定该边界。V1
`RuntimeDriverNativeCommandV1Schema` 仍只表示既有命令，不能接收或降级解析 V2 输入。

Host 校验当前业务 Grant、原 Session、命令与冻结选择后，先持久准备原操作，再将同一
Execution 的 Key 安装到受保护传输边界。Driver 在原生副作用前确认当前原生会话实际使用的
模型、endpoint、reasoning 和 Key 与本次冻结绑定一致；原生接口不能显式设置这些值时，
无法证明一致就拒绝，不能借普通提示、新建 Session 或静默回退模型来执行命令。每次模型
请求继续经过 §10.8 的持久意图与当前授权屏障，原生内部重试同样适用。

原生调用 ACK 只证明协议接收，不能释放会话占用或发布完成。Driver 在发送前持久化不可变
的 operationId、完整请求摘要和原 Session 绑定，再将协议确认的原生操作/Turn 标识与该
记录建立一一对应并持久保存，用于核对 `contextCompaction` item 和 Turn 终态。无法建立
唯一关联时保持 unknown，不能以时间窗口、最新 item 或再次调用推断成功；停止、响应丢失、
Host/Worker 重启和 SSE 重连沿该原操作核实。
受理或副作用未知时保持 unknown，不重发有状态命令、不生成替代 Execution，也不通过
再执行一次来补结果。协议不能提供可靠关联或恢复证据时，保留缺口并拒绝宣称成功。

该新版本需要恢复内存 Key 时，只允许已持久 accepted/running 的原有状态命令；须核对原请求摘要、
命令与目录绑定、有效选择、Key scope、配置及当前授权/fence，重交原 Key 版本。该恢复不
重新发现同名命令、不再次 invoke，不适用于 unknown、终态、只读查询或停止；Key 不能写入
命令、journal、环境、原生可见文件或日志。具体固定 Runtime 映射见
[Runtime HLD §5.3](HLD-agent-runtime-M1.md#53-固定官方能力矩阵)。

##### 有状态命令的端到端版本与受理

有状态命令使用独立的公开 Invocation V3、`NativeCapabilityInvocationPlanV2`、
`conversation.native-capability.invoke.v2` outbox 和 Worker→Host Native V6。
旧 Invocation V1、带 Skill 附件的 V2、Native V4/V5 及其签名和恢复语义保持不变。
V3 只承载服务端受控目录认定的有状态 command，不接受附件、Skill、自由原生方法或路径；
旧 native 请求缺少冻结选择时返回不支持，不能从上一条消息、当前默认配置或最新 Key 补值。

浏览器以当前 V2 command metadata 选择确定能力及目录修订，提交参数和所选模型选项、
推理强度；这些输入不是授权。Core 在既有受理事务中复用普通 Execution 的模型准入和 Key
选择规则，验证当前主体、会话及无活跃/等待/unknown 占用，并重验当前目录和参数。
服务端决定 `effect: state_changing`，不信任浏览器对副作用类别的声明。准备与提交之间
目录、授权、配置或模型/Key 选择发生变化时拒绝受理，不换成其他能力或普通消息。

新计划与 outbox 原子保存以下不可变绑定，Worker 只消费该版本的已持久值：

| 绑定 | 权威来源与约束 |
| --- | --- |
| 主体、Agent、Conversation、Execution、Turn、Session 代次和渠道 | 当前服务端授权与同一受理事务；沿既有 Sandbox 归属与 fence 校验，不由目录或原生 ID 建立身份 |
| capability ID、目录修订、来源版本、参数及摘要 | 当前受控目录和校验后的输入；名称不能代替确定版本，参数摘要不能代替完整调用摘要 |
| selection 与 configVersion | 当前获准的有效 modelOptionId、reasoningLevel 和 Runtime 配置修订；不得在投递时重选或从旧消息推导 |
| keyBinding | 原 Execution 的 Key 用途、主体、密文引用和版本；只保存引用，不保存明文或明文摘要 |

受理幂等摘要覆盖公开 V3 输入、版本及主体、Agent、Conversation、Session 代次等授权范围；
原操作摘要另覆盖完整冻结绑定。两者用途不同，重试同一公开输入应回读原受理结果，不能因
当前模型或 Key 变化重新受理。同键异参、不同模型选择或附件注入在副作用前冲突/拒绝。
检查活跃占用、创建计划和写入 outbox 必须在同一事务中完成，并由存储层唯一约束或条件写入
保证并发请求最多产生一个原操作。旧计划保持旧版本；缺失字段不是可迁移的默认值。

##### Native V6 的签名、执行与恢复

Native V6 使用独立的 stateful-command request/transport、business Grant 和 Key restore
Schema，固定 `schemaVersion: 6`；生成 JSON Schema、OpenAPI 与 Client 同步发布。
请求携带上表冻结绑定、原 Host Session Ref、operation/fence、requestId/traceId，命令类别
固定为 command。Grant 仅授权 `native-capability.invoke`，精确绑定同一请求、主体及范围；
当前授权与原受理范围取交集。请求签名摘要覆盖版本和全部业务字段，排除 Grant token 与
独立私有 Key 原值；持久原操作摘要按既有规则排除可换手的投递 fence，仍包含 selection、
configVersion、keyBinding、能力修订及参数摘要。不能把 V6 请求降为 V4 验签或复用旧摘要。
私有 Key 沿既有独立字段交付，绑定该次已验证 V6 请求摘要与同一 Key 引用/版本。

Host 在当前目录重验后持久准备原操作，再安装原 Execution Key，并以独立的业务执行
context 调用 Driver V2。metadata context 只用于前置目录读取，其固定 30 秒期限和 HTTP
连接结束不终止已受理业务，也不能授予业务执行权。已受理命令沿原 Execution 租约、
当前授权、停止和恢复机制运行，不保存回调、signal 或私有 Key。

Driver 在发送压缩 RPC 前校验原 Session 实际模型、endpoint、reasoning、Key 绑定与冻结
选择一致，持久保存完整命令摘要和原操作意图，并为本 Execution 建立带 fence 的短期受保护
模型传输 admission。模型请求只有在原生 Turn 与该持久操作唯一绑定、当前授权通过且该
admission 租约在发送时仍有效时才能出网；授权撤销、租约失效或冻结摘要变化必须在出网前
原子拒绝；
模型 intent/started/结果事实归属于该压缩 Execution，不沿用上一条消息的模型授权或 journal。
所有异步通知同时核对所属进程/传输、Conversation、原 Session、原生 Turn/item 和原操作；
仅 threadId 相同或收到第一条通知不足以建立关联。官方接口或装配不能证明这些条件时
保持不支持，不以受控 transport 的成功代替真实进程证据。

完成须同时具有原 `contextCompaction` item、Turn 终态及已持久的真实模型事实。
空 RPC ACK 不建立完成事实；已唯一确认受理但仍执行时返回 accepted/running，未知时
保留 unknown 和会话占用。重投必须先比较完整冻结摘要，再回读原操作；内存中已有 Promise
也不能吞掉同键异参冲突。重启和停止只核实原 Turn/item，不发送第二次压缩。

V6 Key restore 仅接受已持久 accepted/running 的原 V6 命令，Grant 仅授权
`execution.key.restore`，固定 existing-accepted-only。它绑定原请求/操作摘要、原 Host
Session、命令和目录、selection、configVersion、Key 引用/版本、当前权限和 fence；
只恢复原执行的内存 Key，不创建意图、重读目录、再次 invoke 或授予新的业务副作用。
unknown、终态、停止和只读查询不能取得该恢复权。历史事件仍沿原 journal、游标和 ACK
回读，不因协议升级改绑或重放。

### 11.5 Browser Capability 边界

Browser Capability 复用 Platform Conversation Contract、Session-owned Sandbox、RuntimeHost、Execution 事件和 File Grant，不新增浏览器调度器、共享浏览器服务或第二套 Session 权威。共享契约位于 `packages/contracts/src/runtime/browser-capability.ts`，同时作为 Runtime Manifest declaration、Runtime capability projection 和 Platform/API projection 的唯一来源。

- Manifest declaration 只声明 capability version、操作类别和 policy limits；它不能证明 Chromium/Playwright 已安装或可用。只有当前 Sandbox 内固定 Browser Runtime probe 通过后，Runtime 才能返回 `available`。
- `available` projection 必须绑定 Chromium/Playwright provenance、不可变镜像 Digest、操作类别、域/资源 policy 和 conformance receipt。`not_configured`、`probe_failed`、`unavailable`、`stale` 和版本不支持必须返回稳定脱敏错误码；调用方不能把缺少投影解释为可用。
- `GET /internal/runtime/v1/browser-capability` 沿用 Runtime Host 的 Worker 服务身份认证，只接受 `schemaVersion` 和可选的 `minimumCapabilityVersion`。无效、重复或未知查询参数返回 `400/BROWSER_CAPABILITY_POLICY_DENIED`；高于实现版本的最低能力版本返回 `409/BROWSER_CAPABILITY_VERSION_UNSUPPORTED`。当前没有生产 Browser 装配时返回版本化 `not_configured`，不把固定二进制、受控镜像探针、客户端字段或环境开关解释为生产 `available`。
- 生产接收路径复用 signed readiness binding：Worker 只从已准入 Runtime Manifest 注入可选 Browser declaration；RuntimeHost readiness 返回当前 Sandbox probe 的 provenance/receipt，并以同一 Agent、workload revision、fence 和 immutable image digest 交给 Host assembly。嵌套 declaration/evidence 必须按结构比较回读，不能按对象引用或调用方字段判断一致；任一 binding、声明、probe、receipt 或镜像不一致都 fail closed。
- Platform/API projection 只读取 Worker 在 verified Workload reconciliation state 中持久化的 Browser projection；API 不直连 RuntimeHost，也不把客户端、Owner、env 或 prompt 字段作为能力来源。projection 必须随 Agent/Runtime 修订、Workload revision 和 fence 一起通过既有 presentation snapshot 校验，过期或缺失时返回明确不可用状态。
- Browser Runtime 不把 Cookie、Storage、BrowserContext、页面原生标识、凭证或无关页面内容带出 RuntimeHost。浏览器动作继续绑定当前 Agent、Conversation、Execution、Session generation 和 fence。
- Browser action request 与 terminal record 必须携带同一不可变 execution binding：Agent、Conversation、Execution、capability version、page revision、Session generation 和 resource fence；Runtime 的 readback 只接受与当前 binding 逐字段一致的记录，不能用 JSON 文本顺序或调用方重新推断替代核对。该 binding 透传与 record 归属见 [ADR-0021](ADR-0021-browser-action-record-binding.md)。
- 导航和观察属于普通 Browser operation；提交、发布、删除、购买、权限变更等动作必须进入现有持久确认与审计协议。超时、连接中断、进程退出或 ACK 丢失时沿原 operation 查询，不自动重放副作用。
- 截图、下载和上传只能经现有 File Grant。Runtime 不能读取任意 Sandbox 路径、枚举对象或取得长期对象存储凭证；File Grant 的对象、主体、Execution、generation 和 operation 绑定保持不变。
- Web/API 只消费版本化 projection；能力状态读取失败必须明确报错，不能返回空能力或由 prompt、env、Skill、Owner 配置伪造。四个标准模板和 `platform-adapter` 的实际可用能力取 Manifest、probe 和启动 conformance 的交集。

### 11.6 Skill Hub、版本绑定与 Worker 装配

Skill Hub 是 Platform DB、版本化 S3 兼容对象存储、Platform API/Web、Platform Worker 和 Sandbox Runtime 的组合能力，不是第二个调度器、权限主体、Connection Store、MCP Server 或 Agent Pod。跨模块决策记录在 [ADR-0019](ADR-0019-magic-aligned-skill-hub.md)。

- Skill project 的规范目录为 `.agents/skills/<name>/SKILL.md`，可选 scripts/、references/ 和 assets/；`.magic/skills` 不属于本平台兼容路径。发布从项目快照生成不可变 ZIP、manifest、内容 digest/signature 和版本记录，对象存储保存字节，Platform DB 保存关系与状态。
- Platform DB 保存 Skill 主记录、Skill Version、发布范围（PRIVATE、MEMBER、ORGANIZATION、MARKET）、审核、市场目录、用户/组织安装、Agent Version 绑定、权限 grant、同步修订、need_upgrade、撤销和审计。Skill Version 一经发布不可变；Agent Version 保存具体 skillVersionId，市场更新不得静默替换已绑定版本。
- Agent Version 是部署级固定事实，整个部署共用一个值：Platform API 与 Platform Worker 读取同一部署输入，取值满足绑定接口的 Agent Version 标识规则。Platform DB 不保存版本表或 Agent 版本列，平台也不从 Workload、浏览器、Agent 投影或模板派生它。标准模板升级与平台回滚不改变 Agent Version，已有绑定沿用。部署未配置时，绑定读取不可用，写入一律拒绝。注入方式见 [Platform API 部署说明](../../deploy/platform-api/README.md#skill-绑定的-agent-version)。
- 当前 Agent Version 只通过当前 Owner 可读的独立入口返回，Agent、配置和状态投影不增加该字段。绑定读写先完成 Owner 授权，再要求路径中的 Agent Version 等于当前值，非 Owner 不能借此探测版本。绑定写入提交该 Agent Version 的完整集合，以当前 Agent Configuration Revision 做 CAS；空集合表示解除全部绑定。
- Provider Registry 按 system → my_library → market → clawhub → skillhub → npx → github 的固定顺序聚合来源。Provider 适配器由平台部署维护，不能由 Skill、Owner、浏览器或 Runtime 动态注册；外部来源必须固定可验证版本，验证发布者/签名和内容 digest，强制扫描/审核，并拒绝归档路径逃逸、符号链接逃逸、超限包和未授权依赖。
- 上传/导入、Provider 安装和批量安装统一经过临时目录、大小/文件数/SKILL.md/路径验证、staging、manifest 写入、目标目录原子替换和失败恢复；批量安装最多 10 个、并发最多 3 个。安装状态与绑定状态分离，安装成功不代表 Runtime 已挂载。
- Web 的版本详情与本人版本目录是独立的版本化只读投影，已发布目录与原版本读取保持不变。发布者本人可回读自己审核中、已驳回和已撤销的版本；其他主体仍只按发布范围读取已发布版本，不可见与不存在不可区分。详情只返回当前用户本人的安装状态，并从该版本已完成供应操作的包描述按固定对象版本、ETag 与长度读取 ZIP，核对 `packageDigest` 及重建 manifest 的 `manifestDigest` 后，返回不超过 64 KiB UTF-8 的 `SKILL.md` 文本（超出时标记截断）和资源清单（路径、类别、大小）。资源内容、对象地址与审核原因不进入该投影；包描述缺失、存储未装配或核对失败时内容标记为不可用。正文不进入目录、审计或日志。
- 系统管理员审核共享发布时，经独立的版本化只读入口 `GET /api/v2/skills/reviews/{skillVersionId}/content`（`readSkillHubReviewContentV1`，投影 `SkillHubReviewContentV1`）读取待审版本内容；版本详情、目录、审核队列响应与 `canViewSkillHubVersionDetailV1` 保持不变。服务端按当前身份判定：非系统管理员一律拒绝；系统管理员只能读取审核队列中仍为 `pending_review` 的共享发布版本（ORGANIZATION 须有目标组织），审核入口对调用者本人发布的版本拒绝，发布者本人改走版本详情。已处理、不存在与本人版本一律按不存在返回，互不可区分。正文读取、64 KiB 上限与截断标记、包描述核对和资源清单沿用版本详情的同一实现，内容不可用的条件也相同。投影只含契约版本、版本 ID 与内容，不含对象地址、审核原因或资源内容；正文不进入审核队列投影、目录、审计、日志或遥测，审计只记版本 ID 与状态。Web 审阅弹窗只按纯文本显示正文。
- 网页编辑的 Skill 项目内容是该项目的可变草稿，只属于项目 Owner，由 Platform DB 以有界字节保存，不进入目录、审计、日志、Worker 或 Runtime。内容按整体替换保存，以项目内容修订号做 CAS；根目录必须有非空 UTF-8 `SKILL.md`，其余文件只能位于 `scripts/`、`references/` 或 `assets/` 下，路径沿用 §11.6.1 的规则。普通文件最多 100 个、单个最多 256 KiB、解码后合计最多 512 KiB；该上限低于 §11.6.1 的包上限，并受 1 MiB JSON 请求上限约束，调用方不能提高。
- 网页发布只提交内容修订、版本号与发布范围，不接收对象版本、摘要、签名、来源或准入字段。服务端在当前授权下读取本人启用项目该修订的内容，由平台项目打包器生成 ZIP，`provider` 固定为 `my_library`；来源证明由平台项目供应生成：`publisherId` 为项目 Owner，`sourceVersion` 为项目与内容修订引用，`sourceDigest` 等于实际 ZIP 的 `packageDigest`，`approvalRef` 为 null。扫描、Ed25519 admission 签名（部署维护的同一 signer 及 trust/policy 修订）、固定对象版本和原操作提交沿 §11.6.1–11.6.4 的同一包供应，不另设签名密钥、发布路径或部署来源校验器。ORGANIZATION 范围的组织取项目所属组织，且须仍属于当前主体。同一项目已登记的版本号直接冲突，不进入供应；同一幂等键的重试按原修订重新打包并核对原输入摘要，修订已变化时拒绝，不用新内容续接原操作。草稿之后的修改不影响已提交版本，修改内容须以新版本号重新发布。部署未装配 Skill 包供应时网页发布返回不可用，内容编辑不受影响。
- Agent Version 绑定后由受控异步同步将固定包 materialize 到 Agent project 的 `.agents/skills/<name>`，并维护 `.agents/SKILLS.md`；只有同步成功、Worker Applied 与 Runtime 装配摘要一致后，Skill 才进入可发现目录。同步失败、撤权、版本撤销、digest/signature 不一致和 Applied 未确认均 fail closed。
- Platform Worker 消费带有 Skill Version、对象版本、manifest、digest/signature、目标相对路径和只读策略的不可变投影，写入并回读版本化 Workload Desired/Applied/恢复事实。调用方不能提交路径、URL、身份、Agent、Connection 或权限字段；Worker 不直接解析 Provider，也不执行未经 grant 的脚本。
- Runtime 的 find_skills、install_skills 和 read_skills 仅作用于当前主体、Agent Version、Sandbox 和已批准 grant 的交集。初始 Prompt 只放有界 metadata（最多 150 项、约 30000 字符），正文和关联资源按需读取；读取结果必须包含实际包版本和加载证据。Runtime 不能自行改变 Hub 权威状态，不能静默跟随同名新版本。
- Skill 的 Tool、Connection、文件、网络和脚本执行 grant 只能收敛既有授权；脚本默认关闭。当前权限失效、跨组织/Agent/Session、无实际加载证据、包不可用或工具结果无法核实时，调用拒绝或保持 unknown，不降级为普通文本。
- Skill Hub 的 API、事务、CAS、idempotency、outbox、audit 和 recovery 必须复用现有 Agent Configuration Revision 和 Execution/Worker fence；不建立第二套 Skill 状态机或调度循环。旧 Driver/Host 不支持该契约时显式返回不支持。

#### 11.6.1 包字节与摘要

包供应在受控临时目录处理项目快照或批准 Provider 的固定来源；它只接收受权选择与字节流，不接收调用方文件系统路径、任意 URL、执行命令或准入标记。对象存储负责包字节，Platform DB 负责版本、关系与原操作事实，Runtime 工作区文件不能反推业务授权。

- ZIP 只包含 Skill payload：根目录 `SKILL.md` 与获准资源。manifest、来源证明、扫描回执和签名作为独立对象保存，不放入待计算 `packageDigest` 的 ZIP，避免摘要自引用。
- `packageDigest` 是实际 ZIP 完整字节的 SHA-256；`manifestDigest` 是 canonical manifest 字节的 SHA-256；`signatureDigest` 是原始 detached signature 字节的 SHA-256。ETag、对象名和调用方声明不能替代内容摘要。
- manifest 沿既有 Skill Package Manifest：`schemaVersion`、`name`、`version`、`entryPath`、`files`、`packageDigest`。每个文件按 `path`、`sizeBytes`、`sha256` 表述，覆盖 payload 的完整普通文件集合；文件大小与摘要由实际展开字节计算，不能只读归档声明值。
- canonical JSON 使用 UTF-8、无 BOM、无多余空白。先按严格 schema 校验所有值：数值仅允许安全非负整数，字符串须为有效 Unicode，拒绝孤立 surrogate、额外字段及非普通数据；文件数组按合法相对路径的 UTF-8 字节序排序。再按合同列出的字段顺序构造普通数据对象，使用 ECMAScript `JSON.stringify`（无 replacer/space）序列化并编码为 UTF-8；字符串转义和数值表示均以此算法为准。接收方按同一规则重建并逐字节比较完整输入，拒绝重复字段、另一种转义/数值写法及任何非 canonical 编码；manifest、来源证明、扫描回执和签名记录统一使用此规则。
- 归档和展开总量各最多 50,000,000 bytes，普通文件最多 2,000 个；部署策略可以降低限额，调用方不能提高。校验同时计量实际输入和实际展开字节，拒绝截断、重复/重叠条目、声明与实际不一致、加密归档及不支持的归档特性。
- 文件路径使用既有 manifest 的相对路径约束；目录按同一规则校验相对层级，不计入普通文件集合，不能声明权限或执行入口。绝对路径、dot component、反斜杠、NUL、文件/目录冲突、符号链接、特殊文件及缺少 `SKILL.md` 均拒绝。内容只写入本操作 staging，校验与扫描阶段不执行 Skill、安装脚本或嵌套依赖。

#### 11.6.2 来源、签名与扫描准入

信任配置、签名 key、Provider 发布者及扫描服务由平台部署维护，具有可核对的 `trustRevision` 和 `policyRevision`。key ID 只索引受控信任配置，包内公钥、frontmatter、Owner env、模型输出和浏览器字段不能建立信任。

| 证据 | 受控内容与检查 |
| --- | --- |
| 来源证明 | `schemaVersion`、`provider`、`publisherId`、`sourceVersion`、`sourceDigest`、`approvalRef`、`trustRevision`；由受信 Provider Adapter/平台项目供应产生并复核，固定实际源版本和内容摘要。仅策略未要求审批的内部来源允许 `approvalRef: null`；外部来源必须有当前有效审批，PRIVATE 初始状态不能替代 |
| 扫描回执 | `schemaVersion`、`scannerId`、`engineVersion`、`rulesetDigest`、`policyRevision`、`scannedAt`、`expiresAt`、`packageDigest`、`manifestDigest`、`scannedFileCount`、`scannedBytes`、`verdict`；实际扫描覆盖已校验的完整 payload，摘要及覆盖文件数/字节数均与实际 manifest 一致 |
| 签名记录 | `schemaVersion`、`skillId`、`skillVersionId`、`ownerId`、`provider`、`version`、`packageObjectVersion`、`packageDigest`、`manifestDigest`、`sourceProofDigest`、`scanReceiptDigest`、`trustRevision`、`policyRevision`、`signingKeyId`；身份与版本事实由当前受权服务端原操作派生 |

来源证明和扫描回执按上表字段顺序进行 canonical 编码并计算 SHA-256，不能签名任意字典。摘要均为小写 SHA-256 hex，版本/身份引用与政策修订为有界受控字段；时间使用 UTC ISO 8601。扫描有效期限由服务端策略限制，回读时再次核对当前期限、策略与来源审批，调用方不能延长期限。平台只接纳真实受信扫描器的 `clean` 结果；未知、感染、超限、不支持、依赖失败或无法确认完整扫描均拒绝。外部发布者/签名验证、内容校验和审批分别执行，平台签名不能补造缺失的外部证据。

平台 admission 签名使用 Ed25519，签名输入为 ASCII `agent-infra:skill-package-admission:v1\n` 前缀字节与上述 canonical 签名记录字节的连接；前缀末尾为一个 LF，不包含两个字面字符 `\`、`n`。使用 Node.js 原生 `crypto.sign(null, ...)` / `crypto.verify(null, ...)`，具体 API 见 [Node.js Crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html)。签名私钥只由平台受控供应服务持有，不交给 Agent、模型、Worker、Runtime 或浏览器；验证者只消费当前受信公钥。

签名记录的对象版本来自实际版本化上传回读。签名不包含自己的摘要或自己的存储版本；`signatureDigest` 由已生成签名计算，再与完整包描述一起保存到原供应操作结果。包描述逐项绑定 ZIP、manifest、来源证明、扫描回执、签名记录和 signature 的固定对象版本、ETag、字节长度及摘要，读取任何对象都核对这些字段。扫描及签名完成不代替共享发布的独立管理员审核，也不产生安装、sync 或 Runtime available 状态。

供应开始、相关外部等待之后及登记/返回之前，重新核对当前身份、包来源授权和同一信任/扫描政策修订。修订变化、key 撤销、结果来源不明、证据缺失或摘要不一致时 fail closed。Worker materialization 与 Runtime 的实际加载沿同一受权包引用复核当前准入条件；旧签名的历史存在不表示当前仍可使用，已受理 Execution 保留原版本关联并遵循原调用的当前权限/恢复边界。

#### 11.6.3 对象版本与发布顺序

平台派生受控包对象键与 staging 标识，复用既有版本化 S3 存储能力，不通过虚构 Agent、Conversation 或附件归属复用存储。包对象、manifest 与各证据不可覆盖已确认引用；发布后所有读取固定对象版本，并重新验证实际字节，禁止把 latest 或重新下载的同名包当作原版本。

S3 VersionId 使用原始、不透明的 UTF-8 值，非空且不能是未启用版本化的 `null`，最多 1,024 bytes；不 trim、解码或规范化，不按业务 identifier、路径或 URL 解释。真实格式依据见 [S3 Versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/versioning-workflows.html)。业务 `skillId`、`skillVersionId`、逻辑版本与受控相对路径继续沿各自既有约束。将 S3 版本作为业务 identifier 的旧合同/解析差额须在包供应实现同步修正，不能用伪造短版本 ID 适配真实存储。

1. 认证及当前授权通过后，持久受理原供应操作，冻结项目快照或批准来源的固定版本及输入摘要；原始字节进入受控隔离存储，DB 原操作只保存固定输入对象引用、摘要及有界控制 metadata，普通正文不进入配置、目录或审计。
2. 对同一输入验证真实 ZIP/payload、生成 canonical manifest，复核发布者/源签名与审批，并扫描完整 payload；保留实际来源和扫描证据。
3. 上传并回读固定 ZIP、manifest 和证据对象，核真实版本及内容；生成一次 admission 签名，保存签名记录、signature 和完整固定包描述。
4. 最终当前权限/政策复核通过后，以该原操作的包描述调用 Skill 生命周期登记，并完成同一业务提交中的成功审计、幂等结果和必要 outbox。登记、PRIVATE/共享初始状态及独立审核沿既有 Core/Store，不增加第二套 Skill 状态机。
5. 后续安装、Agent Version 配置、同步和加载只使用同一已准入包描述与现有配置/Worker fence；可用性仍要求实际 sync、Worker Applied 和 Runtime 装配一致。

对象存储写入与 PostgreSQL 不假装为分布式原子事务。隔离对象上传、验证、签名/包描述保存及最终登记之间的提交边界必须显式记录，由原操作的幂等、outbox 和既有恢复机制接续；只有已提交的版本与当前准入证据共同满足条件时才可供后续操作消费。

#### 11.6.4 重放、故障与证据边界

- 同一主体/资源/命令/key 的重试核对原输入摘要，重放原操作及固定包描述；异输入冲突。扫描时间、签名及对象版本一经保存就属于原结果，不能重签、重新扫描或换包后冒充同一已完成发布。
- 未完成操作从已持久化阶段恢复，无法确认某次外部步骤结果时先核原固定输入/对象，不把 unknown 伪装为成功。完成前的缺失步骤可以沿原输入执行；当前授权或政策修订失效则拒绝或明确失败，需要新的合法操作，不重写已完成结果。已完成版本的准入失效后，重新准入须生成新的固定 Skill Version；原版本和签名保留，既有绑定不会静默换用新版本。
- metadata、成功审计、幂等结果或提交失败时，不暴露为可安装版本；上传对象保留隔离/未引用状态供原恢复机制处理。清理只处理可证明未被版本、配置或历史 Execution 引用的本操作对象版本，不能清除发布历史或借清理推进业务状态。
- 业务 API、Runtime 与 Worker 不能接收 `verified`、`clean`、任意 source URL、调用方路径或权限声明来绕过该供应入口。目录与操作审计只含获准有界 metadata、受控引用、状态与原因码，不含 Skill 全文、普通 reason、对象地址、原始凭证或签名私钥。
- 源代码测试、受控真实 PG/S3/扫描器与部署验收分别记录。包准入正向必须有实际归档、固定对象版本、manifest、真实签名及扫描证据；安装/挂载/加载/工具结果须再取得各自回执。合同、metadata 登记或固定安装包发现不代签完整 Skill Hub 与会话验收。

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

上图描述没有活跃 Turn 的普通消息路径。补充指令、重新生成、停止命令和繁忙拒绝按 12.2 的独立事务分支处理；会话被占用时普通消息的补充指令、排队与繁忙判定见 [12.5](#125-执行中消息的补充指令与排队)。

### 12.2 可靠性规则

- HTTP/Web/回调入口由 `platform-api` 调用 Core，企微长连接入口由 `platform-worker` 调用同一 Core；两者都在同一 Conversation 数据库锁内完成命令准入，将业务记录与 outbox 原子写入 Platform DB。Runtime 投递仅由共享 Worker 认领已提交的 outbox，再通过 RuntimeHost Client 调用 Agent Pod 内的固定 Driver；长连接入站不得直接调用 Runtime。
- 消息持久化成功后才向用户显示“已提交”。后续投递失败不能删除消息或静默丢弃，必须收敛为可解释状态。
- 同一 Conversation 同时只有一个活跃 Turn。普通消息、补充指令、重新生成和停止的重试不能产生重复 Execution、越过发送者边界，或改绑到后续 Execution。
- `platform-worker` 在实际投递前重新解析当前授权；Runtime 是否接受命令不确定时按持久化状态恢复查询，不能盲目重放可能产生副作用的请求。
- Runtime 明确报告本次 Turn 在原生提交点之前未提交（`RUNTIME_TURN_NOT_SUBMITTED`）时，Worker 把 Execution 退回投递前的状态，用新的 Grant 重新投递同一 Execution：2 分钟内最多 3 次，之后以 `RUNTIME_FILE_INPUT_UNAVAILABLE` 或 `RUNTIME_SESSION_PREPARATION_FAILED` 明确失败。接受结果不确定的恢复按墙钟预算收敛，默认 5 分钟，由部署配置（Worker 环境变量 `PLATFORM_WORKER_RUNTIME_RECOVERY_BUDGET_MS`），用尽时以 `RUNTIME_RECOVERY_TIMEOUT` 失败。只核实状态的恢复不以 Session Sandbox 就绪为前置。完整契约见 [Runtime HLD §5](HLD-agent-runtime-M1.md#5-platform-conversation-contract) 与 [§7.3](HLD-agent-runtime-M1.md#73-重启恢复)，决策见 [ADR-0034](../adr/0034-not-submitted-turns-and-wall-clock-recovery-budget.md)。
- 用户可见结果以 [Agent Platform PRD 11.2](../prd/PRD-agent-platform-M1.md#112-对话能力) 为准；幂等键、事务分支、outbox 状态迁移、Runtime 接受竞态和失败收敛的完整工程契约见 [Agent Runtime M1 HLD](HLD-agent-runtime-M1.md#8-消息事件与-sse-可靠性)。
- 停止是尽力而为；已经提交给外部 Provider 的操作不自动撤回。
- Connection 的外部调用幂等、未知结果与恢复由 Connection 负责；平台不能通过重投整个任务来绕过原调用对账。

### 12.3 事件保存

平台保存用户可见消息、最终回答、思考过程、状态变化、模型/工具调用事实和已验证的 Connection 关联引用。Runtime 原生事件由 RuntimeHost/Driver 归一化，再由 `platform-worker` 按 fence 去重并保存；保存成功后才由 `platform-api` 推送给浏览器。有限补发规则见 [Agent Runtime M1 HLD](HLD-agent-runtime-M1.md)。思考过程按 [§8.2](#82-sse) 保存为会话正文；模型未公开的推理（加密内容、签名或被隐藏的思考）、Provider 原始凭证和未脱敏请求不能进入事件表。

### 12.4 API 受理、调度与恢复

API task 直接映射一个 Platform Execution，不另设与 Execution 竞争的任务状态权威。默认在当前主体与 Agent 下创建新 Conversation；显式续接只接受同主体、同 Agent 且可恢复的 Conversation。任务输入/结果属于受控业务存储，查询和 SSE 从持久状态读取。

- **受理事务：** Core 在 Agent 容量与 Conversation 锁定的用例级事务内检查当前资格和等待容量，保存幂等绑定、输入引用、Execution、受理顺序、等待期限、outbox 与必要审计。API 与 Web/渠道命令共用同一 Conversation 锁或等价条件更新边界，锁内按已提交顺序判定等待和占用，不能各自读取空闲快照后同时准入。重复请求先查原绑定，不重复消耗容量；容量满或停止/停用/故障未恢复时拒绝且不创建新任务。启动/更新中允许有界等待，任务提交不隐式启动 Agent。
- **投递：** Worker 认领持久工作项；Dispatch 只允许同 Conversation 最早的可执行任务占用 Turn，并在 Agent 经验证的并发能力内调度不同 Conversation。准入须重新检查当前授权、能力、平台运行状态及对应 Workload 就绪事实；启动/更新中仍等待，停止/停用/故障则终结确认未投递的等待任务并记录原因。状态变更与准入的原子边界、已占位但未发送和已在途任务的收敛由 Runtime HLD §8.4 定义。认领租约、修订/fence 与事务条件防止双 Worker 重复投递。等待期限由平台配置，在重启后沿用；只对确认未投递的到期任务明确失败。RuntimeHost 管理原生 Turn，不再维护另一套用户排队状态。
- **入口差异：** 等待中的 Execution 还没有活跃 Runtime Turn。API 后续任务与 Web/渠道排队消息共用同一等待结构、顺序和认领规则（[12.5](#125-执行中消息的补充指令与排队)），但 API 任务不转换为补充指令；Web 与 API 均通过同一 Conversation 串行准入，后续新 Turn 不能越过已受理任务或改写其他主体上下文；对当前活跃 Turn 的合法补充指令仍按 Web 规则处理。
- **取消：** 未投递任务在与认领互斥的事务中终结，Worker 不能继续启动；投递或接受结果不确定时，先核实原操作。运行中持久保存取消请求、停止工作项和平台规定的停止确认期限，确认停止后才标记已取消。确认超时转为非终态的待核实，保留原操作并沿 Runtime HLD 的查询/屏障恢复；无法自动收敛时由运维按受控恢复流程处置，不能人工猜测完成或直接释放占用。未确认或待核实状态占住该 Conversation，下一任务不能启动；期限不因重复取消或 Worker 重启延长，也不是调用方可设的任务执行时限。
- **恢复：** API/Worker 重启重新认领未开始工作，沿原执行查询 Runtime 接受状态与 Session。已运行任务能恢复则沿原身份继续，确认不可恢复则明确失败；无法确认时标记待核实并阻止受影响 Conversation，不能新建 Session 或重放可能有副作用的任务。结果与审计恢复均按原操作引用去重。

RuntimeHost 命令、租约/fence、原生 Session 和事件字段继续由 [Runtime HLD](HLD-agent-runtime-M1.md) 细化；API 的持久等待属于 Platform Dispatch，不把排队义务下推到 Driver。

### 12.5 执行中消息的补充指令与排队

产品行为见[平台 PRD 10.5](../prd/PRD-agent-platform-M1.md#105-执行中消息与失败提示)，决策见 [ADR-0033](../adr/0033-in-flight-messages-wecom-ordering-and-streaming-progress.md)。本节是 Web 与托管渠道 `message` 命令在 Conversation 被占用时的工程权威。Conversation 锁内的事务写入与补充指令 outbox 见 [Runtime HLD §8.1](HLD-agent-runtime-M1.md#81-消息与命令幂等)，补充指令 capability 与 Driver 映射见 [Runtime HLD §5](HLD-agent-runtime-M1.md#5-platform-conversation-contract)，企微侧的提示与更新见 [§14.2.4](#1424-入站保序附件合并与流式进度)。

**范围。** Conversation 被占用指存在等待中、投递中、运行中、取消待确认或 `unknown` 的 Execution。本节只适用于 Web 与托管渠道的 `message` 命令；重新生成、原生命令和 Skill 在占用时仍返回繁忙，不进入排队；任务 API 的后续任务按 12.4 等待，不转换为补充指令。

**判定顺序。** `platform-api`（企微长连接为 `platform-worker`）在同一 Conversation 锁内依次判定，判定与写入原子完成，并在判定前先完成幂等查询：

1. 没有占用：按普通消息创建初始 Execution 与 Turn outbox（12.1）。
2. 发送者 `actorId` 与当前活跃 Execution 相同，该 Execution 的初始 Turn 已被 Runtime 明确接受且处于可接收补充指令的运行状态，有效补充指令 capability 为真，当前 Execution 不处于 `unknown` 且没有待确认的 stop，该 Conversation 也没有等待中的 Web/渠道 Execution：作为补充指令处理。`waiting` 或其他尚无已接受 Runtime Turn 的 Execution 不进入本分支，直接按第 3 条排队，不先尝试 `turn/steer`。
3. 占用或等待中的 Execution 都属于同一 `actorId`，且未达到下述容量：作为排队消息处理。
4. 其他情况返回繁忙，不创建 Message、Execution 或 outbox：占用者属于其他 `actorId`、本 Conversation 排队已满或 Agent 等待容量已满。繁忙响应只返回本 Conversation 当前排队条数。

**复用 Task 有界等待。** 排队不新增排队表、内存队列或 Driver 侧队列，也不形成第二套排队权威：

- 排队消息与 API 等待任务使用同一持久结构：受理事务写入 Message、状态为 `waiting` 的 Execution、Turn outbox 与必要审计，Execution 保存 `task_wait_order` 与 `task_wait_deadline`。`task_wait_order` 与 API 任务共用 Agent 内单调分配的顺序空间；RuntimeHost 不感知排队。
- 期限：`task_wait_deadline` 为进入排队时刻加 10 分钟，由平台固定，调用方不能设置；企微消息再与该消息回复有效期结束前 30 秒（§14.2.4）取较早者。重启、重复请求和位次变化都不重置期限。
- 容量：同一 Conversation 的等待 Execution 最多 3 条，并与 API 任务共用 Agent 等待容量，任一已满即繁忙。
- 出队：Worker 使用与 API 等待任务相同的认领决策（`waitingDecision`）。只准入同 Conversation 中 `task_wait_order` 最小的等待 Execution；存在占用（含取消待确认、`unknown` 和代次隔离中）或 Workload、Sandbox 尚未就绪时继续等待；到期以 `TASK_WAIT_TIMEOUT` 失败；Agent 已停止、停用或故障未恢复时以 `AGENT_UNAVAILABLE` 终结；Conversation 不可用时以 `CONVERSATION_UNAVAILABLE` 终结；Agent 启动或更新中继续等待。
- 出队前重验：首次 Runtime 准备前，在同一次认领中按 [§9.2](#92-权限顺序) 重验发送者当前状态、Agent 可用范围与渠道权限；失效时以 `AUTHORIZATION_REVOKED` 取消且不投递。认领、撤回、到期与撤权在同一 Conversation 锁或条件更新边界内互斥。

**补充指令转入排队。** 出现以下情况时，在记录该结果或状态变化的同一 Conversation 锁事务中，把补充指令消息转为排队消息：为它新建等待 Execution（新的 `task_wait_order` 与期限），将 Message 改为绑定该 Execution，原补充指令 outbox 以“已转排队”终结。同一 Execution 之后仍待投递的补充指令按原顺序一并转换；超出容量的部分将 Message 标记为“投递失败：排队已满”。

- Runtime 对该补充指令持久返回明确拒绝，例如 Codex `turn/steer` 报告无活跃 Turn、`expectedTurnId` 不符或当前 Turn 不接受 steer（[Runtime HLD §5](HLD-agent-runtime-M1.md#5-platform-conversation-contract)）。
- 绑定 Execution 已被 Runtime 接受，但在补充指令实际投递前进入终态、出现待确认的 stop 或转为 `unknown`。

按上述判定条件，新的补充指令只在初始 Turn 已被 Runtime 接受后创建；此前已创建、初始 Turn 却未被接受即终结的补充指令，仍按 Runtime HLD §8.1 标记“投递失败：原回复未开始”。其他补充指令结果保持原规则：权限失效时标记“投递失败：权限已失效”；投递超时、断连或结果不明时保持 unknown，按原 `messageId` 恢复查询，不转入排队，也不重复投递。转换与触发它的状态变化在同一事务内完成，之后受理的消息因此排在转换结果之后；仍在投递中、结果未定的补充指令若之后被明确拒绝，其排队位置按转换时刻确定。

**与停止、重启、待核实和撤权的关系。**

- 停止：只针对目标 Execution，不终结等待 Execution。停止确认、占用释放后，下一条等待 Execution 按序准入；停止确认超时转为待核实期间继续等待，到期按 `TASK_WAIT_TIMEOUT` 终结。
- 待核实：`unknown` 不释放占用，等待 Execution 不出队，直到原执行核实为终态、恢复预算用尽（[§12.2](#122-可靠性规则)）或等待到期。代次隔离完成、Conversation 标记为会话不可用的事务（[Runtime HLD §7.3](HLD-agent-runtime-M1.md#73-重启恢复)）同时终结该 Conversation 的全部等待 Execution；`RUNTIME_SESSION_BLOCKED` 使会话不可用后，等待 Execution 在随后的认领中以 `CONVERSATION_UNAVAILABLE` 终结。
- 重启：`platform-api`、`platform-worker` 或 Agent 重启后，等待 Execution 沿原顺序与期限继续（§16.3）。Agent 启动或更新中继续等待，停止或停用时终结。
- 撤权：主体禁用、Agent 可用范围或渠道权限撤销时，按 §9.2 与 [Runtime HLD §8.1](HLD-agent-runtime-M1.md#81-消息与命令幂等) 取消受影响的等待 Execution，原因为 `AUTHORIZATION_REVOKED`，不投递。
- 撤回：Web 发送者撤回自己的排队消息，复用 12.4 未投递任务的取消路径。撤回与认领互斥：Execution 仍为 `waiting` 时以 `cancelled` 终结，记录撤回原因与必要审计；已离开 `waiting` 时返回已开始处理，不影响执行。撤回入口遵循 §8.1 的命令约定，校验可信主体与 Conversation 归属并支持幂等。企微不提供撤回入口。

**位次与状态事件。**

- 位次 N 等于同一 Conversation 中 `task_wait_order` 不大于本条的等待 Execution 数，前面还有 N−1 条排队消息。位次只从持久等待顺序派生，不另存可变计数。
- 入队、开始处理、撤回、超时与取消在改变等待集合的同一事务中写入平台来源的 `task.status` 事件，Web/渠道 Execution 与 API 任务一样写入，原因使用受限枚举；Web 按 §8.2 更新，企微按 §14.2.4 更新受影响消息的回复。

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
Connection HLD 的 token/ConsumerInstance 绑定及 profile 明确要求的 sender constraint。

可信采集在发起工具调用前绑定原 Execution、操作和尝试，并从同一次经过服务端认证的 Connection 请求/响应中取得由 Connection 生成的原调用引用。引用须能在 Connection 自身授权下核实其服务端解析的调用主体、操作和真实记录；受信采集再核对该记录确实属于本次请求。难以猜测的引用、签名、同一主体或相近时间都不能单独证明执行绑定，也不能接受模型或客户端从其他任务转交的真实引用。重试核实只查询原记录，不再次执行 Provider 操作；缺失任一侧证据保持未核实。

Connection HLD 的 [§5.2](HLD-connection-M1.md#52-consumer-与-instance) 与 [§7](HLD-connection-M1.md#7-mcpapi-调用流程) 定义独立客户端的 token 绑定、身份解析和调用准入；[§11](HLD-connection-M1.md#11-审计与跨系统关联) 定义真实调用关联与分别授权查询。Runtime HLD 的[身份上下文](HLD-agent-runtime-M1.md#9-runtime-身份上下文)定义原执行客户端绑定、受保护凭据消费与真实 MCP 调用的可靠采集；私有 FD3 只约束明确启用的 native lane。这些字段不构成 Platform 签发的 Connection 授权。Platform API/Worker 不为核实建立 Connection 代理或获得 Connection 查询凭据，也不签发供 Connection 授权的上下文。平台只接收受信采集产生的关联引用与核实状态；Connection 调用详情仍在其独立授权入口查询。

关联信息不是授权。调用方与两侧管理员分别在各自受控 API/页面查询；无权访问时不返回对方对象、状态或存在性。平台工具成功只表示自身已确认的执行事实，不能替代 Connection 对外部效果的结论。响应丢失、关联缺失或无法核实时如实标记，沿原调用补充核实，不把猜测写为成功。

### 13.3 外部执行与恢复

Connection 在实际外部操作开始前持久保存意图，并在执行前重验自己的当前身份、Grant 与凭证状态；拒绝不能因审计故障变为放行。业务幂等键绑定原调用主体、操作及请求，同键同请求复用原操作，冲突拒绝。可能已经提交且无可证明幂等保障的写操作只沿原调用对账，不自动重发。

取消或撤权不抹去既有外部效果。Connection 的执行尝试、结果不确定、后续对账、人工处理和凭证撤销均保留自身审计；平台不接管其状态机或建立分布式事务。

### 13.4 实现与详细设计归属

Connection 只复用固定且经 allowlist 审核的 OpenConnector Provider/OAuth/executor Kernel，保留来源、许可证、notice 和 digest；上游 Runtime Server、Credential Store 和 Web Console 不进入正式拓扑。首个受监督 GitHub Pilot 的范围以 PRD 为准，不把局部 Pilot 推广为完整 M1。

Connection 的 LDAP、OAuth 客户端、MCP/API、Grant、凭证保护、Provider Action、幂等/对账及 Pilot 验证矩阵由 [Connection M1 HLD](HLD-connection-M1.md) 细化。跨文档整合按第 25 节完成，不能以旧的代调用协议覆盖本节独立直连边界。

### 13.5 Platform 外部 Connection Consumer 配置契约

本节冻结 [#1269](https://github.com/AgoraIO-Extensions/agent-infra/issues/1269) 的部署配置，
不改变两份 PRD 的独立直连边界。适用的 Connection HLD 条款为
[§3 系统上下文](HLD-connection-M1.md#3-系统上下文)、
[§5.2 Consumer 与 Instance](HLD-connection-M1.md#52-consumer-与-instance)、
[§7 MCP/API 调用流程](HLD-connection-M1.md#7-mcpapi-调用流程)和
[§11 审计与跨系统关联](HLD-connection-M1.md#11-审计与跨系统关联)。

#### 13.5.1 字段与配置来源

一个部署使用一个完整的 Consumer 配置快照；以下字段全部必填，不能从用户、Agent 或任务输入补齐。

| 字段 | 语义与约束 |
| --- | --- |
| `schemaVersion` | 本配置契约的整数版本，当前为 `1`；不是 Connection API、MCP 或客户端产物版本。 |
| `publicOrigin` | 部署批准并与 Connection 发布配置一致的 HTTPS origin，只含 scheme、host 和可选端口；使用 URL origin 的规范形式，不含凭据、路径、尾斜杠、query 或 fragment。批准范围按完整 origin 精确匹配，不使用域名后缀或通配符。 |
| `mcpPath` | 相对此 origin 的独立绝对路径，以单个 `/` 开始；不含 scheme、host、query、fragment、反斜杠、`.`/`..` 路径段或编码后的路径分隔符及点段。最终 MCP endpoint 为 `publicOrigin + mcpPath`，不以 URL 解析的相对路径回退或重定向改变目标。 |
| `webPath` | Connection Web 控制台的独立绝对路径，以单个 `/` 开始；与 `mcpPath` 分开批准和校验。Platform Web 的授权入口使用 `publicOrigin + webPath`，不能把 MCP endpoint 当作浏览器管理入口；该字段不进入 MCP 配置指纹。 |
| `consumerId` | Connection 为该产品注册的非空 Consumer 标识，按原值精确匹配；不是 Principal、ConsumerInstance、Actor 或授权证明，不能由 Platform 创建实例身份或代替 Connection 的认证解析。 |
| `audience` | Connection 为该 Consumer 部署批准的非空目标资源标识，按原值精确匹配；不能从 origin、路径或 Platform Runtime Execution Grant 的 audience 推导。 |
| `egressProfile` | 非敏感的 `{ ref, revision }`，两项均为非空字符串，引用部署批准的出站策略及不可变修订。该策略限定到达上述 Connection 目标所需的网络路径、DNS 和 TLS 校验；引用名不授予授权，也不允许访问 Connection DB 或 Provider。 |

配置来源按以下顺序确定，不在进程内逐字段叠加：

1. 部署显式选择外部配置引用时，该引用的固定修订是整个快照的唯一来源；无法读取或校验失败
   时拒绝启用，不能回退到 Helm values。
2. 未选择外部引用时，使用目标环境的 Helm values 渲染完整非敏感 ConfigMap；ConfigMap 是
   该 values 的交付形式，不是另一层覆盖源。外部引用与内联快照同时配置时视为冲突并拒绝。
3. 对无法直接挂载该 ConfigMap 的第一方 Platform API，部署启动器可以把同一份完整快照
   作为受控环境投影传入。该投影必须同时包含 profile、`1-<fingerprint>`、fingerprint、
   approval source ref/revision；API 只在部署模块未提供 profile 时整体读取它，并按同一完整
   快照校验，不能逐字段与模块导出合并。该环境投影是 ConfigMap/外部引用的运输方式，不是
   新的配置来源或普通运行时覆盖入口。源码、镜像和前端包不内置 endpoint 或兜底值；请求体、
   Agent 配置、模型/工具参数和前端常量均不能覆盖快照。

#### 13.5.2 版本、指纹与失败行为

版本 `1` 只接受上述字段及 `egressProfile` 的两个子字段，拒绝未知字段、缺失值、错误类型和
不满足约束的值；不静默忽略新字段或自动降级。字段集合、语义或规范化规则变化须发布新
`schemaVersion`，并在启用前确认部署与消费方均支持。支持配置版本不表示客户端、MCP/API
或 Connection 服务端兼容；它们仍须通过各自的版本和 readiness 门禁。

配置指纹为以下数组经 `JSON.stringify` 序列化后的 UTF-8 字节的 SHA-256，以小写十六进制
表示；不添加空白、BOM 或尾换行。先完成字段校验；字符串保持原值，不 trim、改写大小写或隐式解码。

```text
[schemaVersion, publicOrigin, mcpPath, consumerId, audience, egressProfile.ref, egressProfile.revision]
```

指纹覆盖有效非敏感配置及出站策略修订，不包含 SecretRef、token、私钥或其 hash；
它用于配置一致性核对，不是签名、安装身份或 Connection 授权。源引用及修订与指纹一并记录，
相同内容从不同批准来源交付可具有相同指纹；出站策略内容变化必须产生新修订和新指纹。

部署以完整快照校验并发布，消费方在启用 Connection 能力前核对预期版本和指纹。
缺失批准来源、origin 未获准、路径非法、Consumer/audience 与批准登记不符、出站策略
不可解析或未落实、版本不支持、指纹不符时，受影响的 Connection 能力保持不可用，不发出调用。
更新不允许混用新旧字段；现有客户端不能原地切换 origin、Consumer 或 audience 并复用旧安装
凭据。恢复须重新核对完整配置和原安装绑定，不回退到旧快照、其他环境、匿名、Owner 或平台
服务身份；已发生但结果未知的外部操作仍沿原调用核实，不向新 endpoint 重放。

#### 13.5.3 SecretRef、权威与交付边界

非敏感快照使用 Helm values/ConfigMap 或上述受控外部配置。必要的安装凭据仅由已批准的
SecretRef 和受保护客户端边界提供；SecretRef 只定位安装隔离的受控凭据，不构成授权，
不得来自请求或 Agent 输入。引用必须解析到与原 Principal、ConsumerInstance、Actor（如适用）、
audience 和凭据修订一致的安装；缺失、失效或绑定不符时拒绝，不能跨安装共享。
具体签发、token 绑定、撤销和刷新遵循 Connection HLD §5.2；profile 明确要求的持有证明另行验证。Codex 的交付与隔离遵循
[Runtime HLD §9.1](HLD-agent-runtime-M1.md#91-codex-独立-connection-consumer-profile)，
不能把 SecretRef 解释为普通 env、argv 或工具进程可读的 token 注入许可。

Platform 在 Connection 相关数据中只保存 Consumer 非敏感配置和 §13.2 的受信关联引用；
不代理 MCP、不读取 Connection DB、不保存 Provider Credential 或 Grant，不复制 Connection
授权与审计权威。Platform API/Worker 不取得客户端凭据来代调用或查询 Connection。
客户端凭据和原始秘密不得进入 Platform DB、ConfigMap、普通配置、日志/错误、模型上下文、
前端 bundle、Issue 或 PR 文本；SecretRef 的解析仅发生在已批准的安装凭据/客户端边界。

**标准 MCP 与 Agent token 消费。** 固定官方 Runtime 的标准 MCP 客户端优先使用 Connection
签发的 OAuth token 或获准 PAT。每个原用户/独立应用与 Agent 组合使用独立 token；不同
Platform Session 仍按所属 Sandbox 隔离客户端状态，不能由 token 共享合并会话、工作区或记忆。
同一获准 Consumer 可管理多个独立 token/ConsumerInstance，不默认为每个 Agent 新建 Consumer；
只有所需外部账号或 Action 权限不同，才消费能表达差异的 Consumer/Actor/Grant 配置。

客户端按所选路线复用 Connection 的独立用户确认：标准 OAuth 使用授权码＋PKCE 和
受控 callback；Agent PAT binding 使用固定 callback、不透明 binding 与受保护 claim。
两条路线不互相强加未选用的私有领取接口。只保存消费方需要的非秘密主体/Agent/安装引用。
服务端先从当前身份与持久关系固定主体及 Agent，再由获准的受保护客户端领取、保存、
选择和撤销 token。callback/query/body、token 名称、
Owner 或 Runtime 自报字段不能改绑；binding 服务凭据与 MCP token 不互换，API/Worker
不领取 token 来代调用。原主体与 Agent、Consumer/实例、issuer/resource、凭据修订/期限
或当前授权无法确认时拒绝，不回退到另一 token、Owner、责任人或共享部署凭据。

标准 MCP/token 接入不以私有 FD3、native callback 或 DPoP 为通用前置。选用额外证明的
profile 必须明确配置、两端可互操作且保持自身门禁；不允许凭兼容开关跳过必需证明。
任何客户端只有在真实版本的凭据保护、主体/Agent 选择、撤权、原执行事实及恢复验证通过后
才开放对应能力。token 接入与可信关联分别验证：没有同次原调用证据时保持未核实，不能
以完成登录、获得 token 或模型返回 callId 宣称关联通过；原执行前意图、必要审计与 unknown
不重放的要求不变。实现与取舍见 [ADR 0018](../adr/0018-use-standard-mcp-with-agent-scoped-tokens.md)。

本消费契约的正式修订由 Platform API/Web、Runtime 客户端和 Connection 契约原 owner
评审，按 PRD → Spec → HLD 的共同版本合入；CODEOWNER 与适用 CI 门禁仍由当前工作流维护。
未完成共同文档对齐与消费方评审时，不据文档候选启用客户端。
后续 #851/#1271 只消费已合入版本及具名接收接口；本节不改变 Connection 运行实现、
部署、Provider 或其原 owner 的 tickets，也不签收客户端和真实双系统验收。

本节不实现 API/Worker/Web 接线（分别由
[#1270](https://github.com/AgoraIO-Extensions/agent-infra/issues/1270)、
[#1271](https://github.com/AgoraIO-Extensions/agent-infra/issues/1271)、
[#1272](https://github.com/AgoraIO-Extensions/agent-infra/issues/1272)承接）。
[#1378](https://github.com/AgoraIO-Extensions/agent-infra/issues/1378)负责本消费契约对齐；
[#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851)负责真实客户端的 token 绑定验证和
受保护交付；[#395](https://github.com/AgoraIO-Extensions/agent-infra/issues/395)负责独立
Connection runtime/readiness；[#435](https://github.com/AgoraIO-Extensions/agent-infra/issues/435)
是已关闭（NOT_PLANNED）的历史联合验收回链，不恢复该入口或已停止探针；当前代表旅程由
[#192](https://github.com/AgoraIO-Extensions/agent-infra/issues/192)回链
[#144](https://github.com/AgoraIO-Extensions/agent-infra/issues/144)；多日 Pilot 已退出 M1 规划，P0 首发真实环境验收由
[#171](https://github.com/AgoraIO-Extensions/agent-infra/issues/171)供应资源并回链 #144。
配置契约或静态校验通过不代表这些验收完成，也不接管
[#907](https://github.com/AgoraIO-Extensions/agent-infra/issues/907)、
[#601](https://github.com/AgoraIO-Extensions/agent-infra/issues/601)或 Connection 服务端实现。

#### 13.5.4 Runtime Driver 直接消费标准 MCP

当固定原生客户端不能满足 §13.5.3 的凭据保护与持久确认时，Runtime 可明确选择由其
Driver 内的 TypeScript 标准 MCP 客户端执行 Connection 操作。客户端只存在于所属 Sandbox
的 RuntimeHost/Driver 受保护范围，直接连接完整获准 profile 的固定 HTTPS endpoint；
API/Worker/Web 交付非敏感配置与自身执行授权，不取得 token，不转发 MCP，也不创建
Platform/Connection MCP proxy、Provider 执行器、Connection 目录或授权/审计投影。
Generic ACP 只有在 [ADR-0025](../adr/0025-propose-runtime-host-acp-protected-mcp-bridge.md)
及本节后文的 bridge 门禁全部满足时，才可使用 RuntimeHost-owned 的 loopback transport
adapter；该 adapter 不是 Platform API 或 Connection 服务的代理，Connection token 仍只在
Host 内的 `StandardMcpClient` 中，native 只收到单 Execution 的本地 bearer。敏感临时授权码仅允许按
[§13.5.6](#1356-标准-oauth-安装供应)的固定 callback 窄通道瞬时转交；该例外不允许
access/refresh Token、PKCE verifier 或 Consumer secret 进入控制面。产品边界与 token 选择以
§13.5.3 为准。本路径的取舍见 [ADR 0019](../adr/0019-run-standard-mcp-in-protected-runtime-driver.md)。

固定官方 Codex 通过 `thread/start.dynamicTools` 安装有界工具定义，由 `item/tool/call`
向 Driver 请求操作并等待工具响应。此字段属于固定版本的 experimental API，须显式 opt-in，
固定协议/schema，并在最终产物验证；不修改原生 release。定义只来自当前受信 MCP 发现快照，
每个工具名、输入 schema 和修订绑定原 Conversation/generation；它是会话内的客户端元数据，
不成为平台工具目录或 Grant 权威。原生只取得工具定义及按业务权限可见的脱敏结果，token、
SecretRef 内容、服务认证头与客户端对象均不交给原生。原生 Connection MCP 配置保持空；ACP adapter 的本地 URL 不是 Connection endpoint，
也不能读取 Connection token、SecretRef 或服务认证 header。同一会话不同时启用另一
native MCP、private bootstrap 或 token helper 路径。Pi 和不满足固定 artifact 门禁的
Generic ACP 继续 `connection:false`。

**ADR-0025 ACP adapter gate。** 只有固定 artifact/protocol 明确证明 ACP session 级
HTTP MCP 注册、bounded discovery/call/close、native 不持久化本地 bearer、工具子进程
和日志不读取 bearer，且最终 Linux 保护负测通过时才允许启用。adapter 必须位于
`packages/agent-runtime`，按 Execution 创建、关闭和重建；`apps/agent-runtime-host`
只做配置和 capability 装配。bridge 请求固定到 `127.0.0.1`、单一 `/mcp` 路径、HTTP
method/body 上限、短 expiry、replay/duplicate 拒绝、无 redirect 和 constant-time
bearer 校验。每次 call 由 Driver/Host 生成 `operationRef`/`attemptRef`，不能从 ACP
JSON-RPC id 或 native 字段推导；调用必须按 `prepare → started → confirm/block`
屏障，响应丢失、重复发送、确认失败或 close 不确定都封闭当前 native Session，
unknown WRITE 不得让原生继续推理。缺少任一门禁时能力保持关闭。

**受保护输入。** Host 从当前经过验证且已持久接受的原执行解析 principal、Agent、
Conversation、Sandbox、generation 与授权修订，再定位获准安装的 SecretRef。安装的
Consumer/实例、issuer/resource、凭据修订与期限必须与该原执行及完整 profile 一致。
callback、请求字段、模型/工具参数和 token 名称不能选择安装；SecretRef 或安装映射缺失
时不可用，不尝试其他 token。领取、刷新与撤销只消费 Connection 实际发布且匹配部署的
合同，不发明 identity、binder 或 record-query 路由，不把 metadata 声明当作服务端身份验证。

秘密输入属于 Host 的专用受保护材料，不能写入普通配置、native home/workspace 或原
journal。原生及其工具的真实文件边界必须排除这些材料、父 Host 状态、路径别名与可重开的
FD；传给原生的 stdin/stdout 只携带当前协议内容，秘密句柄不继承。客户端在自身内存中
构造固定目标的认证请求，拒绝重定向、caller header/URL 覆盖和跨安装复用；SDK、错误、
trace、dump 与诊断不能把秘密输出给模型或持久记录。关闭或撤销时停止客户端并释放引用，
不把 JavaScript 引用释放或 Buffer 清零宣称为完整内存保护。

初始受保护 Host profile 限 Linux：真实非 root UID、无有效/许可/继承/ambient capabilities、
`no_new_privs`、原有无 inspector/loader/dump 的进程准入，以及对 native/tool 子进程落实的
文件边界须同时有效。另须从可信内核读取 Yama `ptrace_scope=2` 或 `3`，以阻止同 UID
进程的 attach-mode 内存访问及 `pidfd_getfd`；proc FD/link/fdinfo 读取与重开另由真实
文件边界限制，不能以 Yama 数值代替。最终镜像须分别验证 `ptrace`、`process_vm_readv`、
`/proc/*/mem`、`pidfd_getfd`、`/proc/*/fd`、`fdinfo` 重开与继承攻击实际被拒绝。缺失、不可核实或
策略变化时，先封闭该能力且不读取/领取新 token；原控制与只读恢复仍沿原执行可用。
Runtime 不修改节点 sysctl、不提升权限、不接受 env 的保护声明，不回退另一 OS/profile。

**执行与确认。** 每次工具请求严格复用原 Driver/Host 的 journal、fence、事务/游标和
取消流程；标准 SDK 及 MCP session 只属于原主体/Agent/Conversation/generation，不能
跨 Sandbox 共享。当前 token 与 Connection 自身授权仍由服务端逐次验证。安全分类不
以模型声明或 MCP annotations 为授权；不能确认的副作用按可能有 WRITE 处理。

1. Driver 从受信原生进程的 thread/Turn/callId 映射原 Execution，验证已安装工具及参数
   schema；重复相同请求复用原 operation/attempt，身份、参数或映射冲突拒绝。
2. 在原持久层确认 intent，释放持久队列后等待 Host 当前业务授权，再核对原代次、
   fence、deadline、安装修订、token 期限及保护状态；任一 await 后都重验。
3. 标准客户端发出一次具名 MCP 工具操作，采集同次请求身份/摘要及实际响应；实际开始与
   远端已接受分别记录，不以前置 intent 冒充已执行。所有 SDK 内部实际工具发送也经过此
   边界；无法阻断隐藏重试时不启用该操作。响应丢失或提交不确定的 WRITE 保持 unknown，
   不重发。初始化/发现只做固定目标下的有界协议读取，不代替业务工具意图或授权。
4. 实际结果或 unknown、必要事实与审计沿原 journal 和原 ACK 可靠保存。只有可确认终态
   才回答原生 `item/tool/call`；unknown WRITE 即使已保存，也须封闭原 Turn 的新模型/工具
   动作，保留 Conversation 占用并停止或隔离原生，不能用普通工具错误让推理继续。不能
   确认副作用类别的 unknown 同样处理。Connection 引用仅从同次认证响应采集，并按已发布
   的原记录合同核对；缺失或不能核实保持 unverified，MCP success 不等于外部效果已核实。

结果保存失败时不能发送普通工具错误并任由原生继续推理：官方断连可能产生 fallback 工具
响应。Driver 必须先封闭该原执行的新模型/工具准入，保留已有 intent/未决事实，并按原停止
流程终止或隔离原生进程后处理协议连接；未确认退出不释放会话。崩溃、断连、取消与恢复
均不能新建业务 Session/Turn 或重放未决 MCP；只在当前有效原 token 和两侧独立查询权限下
核实原记录，缺少查询合同则保持 unknown。此流程不新增调度器、事实来源或恢复真值。

源码实现可先以固定官方协议、真实标准 SDK 与受控安装输入开发；功能启用还须通过
Runtime HLD §11.2 的最终产物、主体/Agent、秘密保护、撤销、确认/故障与恢复验证。
文档合入与 fixture 不签收这些结果。该路径只声明 Driver 所执行 MCP 的覆盖，其他原生
外部工具继续按 §10.11 准入；不得以本路径批准隐藏原生动作或私有 lane。

#### 13.5.5 受保护安装交付

本节定义 §13.5.4 客户端的安装输入交付，不定义 Connection 签发、身份或 Grant 的第二权威。
初始文件 profile 复用 Host 现有专用 `standard-mcp-input/bindings` 与 `materials` 布局。
供应方是部署批准的 SecretRef 供应边界：只有在 Connection 原主体的独立确认、安装/实例及
当前凭据引用能按实际发布的合同核实时，才提供对应原 principal＋Agent 的安装输入。
部署或文件声明不能替代服务端身份、当前授权及合法领取。缺少匹配部署的服务合同或供应
引用时，该安装保持不可用；客户端不猜 binder、identity 或原记录路由。

**供应与接收。** 可信部署配置固定输入供应引用与修订，以及完整 Consumer profile 的
fingerprint/source；请求、callback、模型、工具、Token 名称和 Owner 不能选择或覆盖它们。
输入包含非敏感安装 metadata 和分离的 material 引用，不在同一普通 JSON/config 中嵌入
Token。metadata 使用已有客户端字段：principal、Agent、service/Consumer/instance、
issuer/resource/audience、profile/source、credentialRef/revision/expiry 与获准服务合同引用。
Runtime 的当前原执行仍须在使用前独立解析并匹配这些字段，不从安装 descriptor 取得业务
执行权限。API/Worker/Web 交付非敏感配置，不读取、解密或代转客户端秘密；一次性
授权码的固定 callback 窄例外仅见 [§13.5.6](#1356-标准-oauth-安装供应)，不适用于
access/refresh Token、PKCE verifier 或 Consumer secret。不能复用 Worker-only 密文库、
keyring、普通 `envFrom` Secret 或模型 Key 交付来运输 Connection Token。

交付格式固定当前 reader 的版本 `1`：metadata 为
`Omit<StandardMcpInput, "scope" | "token"> & { agentId: string }`，UTF-8 JSON 上限
65,536 bytes；拒绝未知字段及内嵌 `scope`/`token`。`expiresAt` 为现有毫秒时间戳，
`contract` 保留同一版本的服务/工具结果 schema。分离 material 是 1–4,096 bytes 的 UTF-8
Token，按现有客户端约束验证，不 trim 或改写。供应引用及修订与 Consumer 的 `source`
分别核对，不能把一个当成另一个。安装时不伪造 Conversation、generation 或 Execution
来补 `scope`；它只在当前 reader 从原持久执行解析后补入并重验。

初始供应形式限定部署批准的 Runtime 私有文件 SecretRef export，不新增 Kubernetes Secret
取值、HTTP Token 上传、原生 header helper、MCP 代理或通用秘密服务。供应路径、临时材料
与目标均位于现有 native/tool 共享拒绝树的固定非 Conversation 子目录，禁止路径别名、
任意 URL/外部路径和请求选择。输入文件保持 Host 专用 UID、私有目录与有界、非符号/硬链接
材料；这些文件条件只是准入条件，不签收隔离。供应方须在已批准的秘密边界交付 export，
不能先在模型、工具或普通 staging 文件暴露秘密再声明安装安全。

Host 内安装接收与装配必须在任何 material 读取前通过 §13.5.4 的真实 Linux/进程保护。
原生启动与工具文件边界仍按同节在最终产物验证；不更改节点政策、不提升权限、不接受
环境变量的保护声明。安装过程不向 native/stdin/stdout、普通日志、错误、journal 或平台
接口输出秘密，不继承秘密 FD；失败与诊断只提供受限非敏感状态。

初始接收调用位于 `assembleRuntimeHost`：打开原 Store 后、调用
`createProtectedStandardMcpInput` 前，消费固定供应修订并发布到该 reader 的输入布局。
本次装配不隐式监听其他来源或刷新供应；新供应修订经受控安装重新装配，运行中的客户端
仍沿原 resolver 在每次使用前核对当前绑定。后续实现 primary 必须列出真实供应路径、
批准来源及接收函数，缺失时不能把测试 export 或占位接收器当作生产交付。

**发布与修订。** 接收器复用当前 `installationKey`（principal＋Agent＋完整 profile/source）
和 `materialKey`（installationKey＋credentialRef＋revision），不另建主体或授权索引。
先以私有权限、独占创建和完整持久确认发布不可变 material，成功后才原子发布 metadata。
相同 material 引用和修订只有完全相同内容才能视为同次交付；不同内容或绑定必须拒绝，
不得覆盖旧修订。metadata 临时文件先持久确认，再原子切换并确认目录持久性；切换前
失败保留旧绑定。切换后的持久确认失败或崩溃不承诺旧绑定仍在，须沿同一安装引用核实
当前发布结果，确认前保持不可用；未被引用的 material 不能被选择，失败不能生成可用
声明。重复交付、崩溃及修订冲突不重新领取或重发 Connection 业务操作来补造结果。

已配置供应但不可读取、保护不足或发布失败时，保持选中但不可用，不转为未配置，也不
关闭整台 Host；原 stop/status、已存事实与只读恢复继续可用。确实未配置的输入不独自
启用客户端，非敏感路由快照保留。已有 Thread 工具快照及 unknown 占用不随安装变更
升级、降级或释放；新会话与当次真实发送继续按当前原授权及修订重验。

安装删除、替换或本地关闭不表示 Connection 已远端撤销。刷新、撤销与原记录核实仅消费
其实际发布且匹配部署的合同；不复制 Grant 状态或建立后台同步/调度循环。旧材料的移除
不能消除未决原操作事实或触发新的 Token/操作 fallback，秘密可达引用释放亦不作为完整
内存擦除证明。实现与取舍见 [ADR 0020](../adr/0020-protect-connection-installation-delivery.md)。

源码接收器可先使用受控 export 实现与验证；供应方实际输出、可信 SecretRef 解析、合法
确认/领取、最终 Linux 文件/内存/FD、真实 Runtime/Connection/Provider 与撤销/unknown
验证分别回链 #851。来源未知或证据不足不启用真实 Token，不以未来整票验收替代当前
实施所需的最小合同输入，也不以此方案或 fixture 签收真实保护。

#### 13.5.6 标准 OAuth 安装供应

新增生产供应优先采用受保护 Runtime 客户端直接执行标准 OAuth Authorization Code +
PKCE（S256）；既有获准 PAT/export 路线继续遵循 §13.5.3/§13.5.5，不自动迁移或共享 Token。
本节只定义平台使用方，不注册 Consumer、不修改 Connection 服务、Provider 或 Grant。
取舍见 [ADR 0022](../adr/0022-acquire-oauth-tokens-in-protected-runtime.md)。

**批准与入口。** 部署固定获准 Connection issuer、authorization/token/revocation endpoint、
resource、scope 和合同修订；这些输入与完整 profile/source 一起校验，不能由请求或 OAuth
discovery 动态扩大目标。部署若选择标准 OAuth Dynamic Client Registration（DCR），还必须把
同一 issuer 下的 `registration_endpoint` 固定为批准的 `/oauth/register`，只发送本节规定的
native client metadata，并把每个 Agent 的返回 `client_id` 绑定到该 Agent 的安装记录。DCR
只创建独立 OAuth client/Consumer 入口，不创建 Grant、不替代用户确认，也不能把多个 Agent
折叠到一个部署 client。DCR 成功、Consumer 可见或本机登录本身不构成连接器授权；不得使用
其他产品 Consumer 或 Portable PAT 作为自动 fallback。API/Worker/Web 不持有 Consumer
secret、PKCE verifier、access/refresh Token，也不兑换授权码、刷新或代调用 MCP。

**逐 Agent 安装配置。** 部署可为不同 Agent 提供完整的非敏感安装绑定，每项包含已有
Consumer profile、approval 和 `RuntimeOAuthConfigurationV1`；复用现有 schema、指纹及
source 校验，不创建另一种身份或凭据权威。API、Worker 与安装 Store 捕获同一批准修订。
显式配置逐 Agent 绑定时，该映射是安装能力的唯一来源：缺少 Agent、条目无效、profile 与
OAuth resource/source/指纹不一致时拒绝该安装，不回退到共享配置、Owner 或其他 Agent。
原单份配置部署继续使用原路径；两种安装配置来源同时提供时拒绝安装能力装配。
安装能力不可用不扩大为普通模型执行或原 stop/status、只读恢复不可用。

API begin 只从已认证原主体的既有 Execution 和数据库 Agent 关系选择绑定。confirm、status、
callback 及 Worker 命令领取沿原授权记录重新核对同一 Agent、主体、配置 ref/revision、
profile/source、Pod 和代次。浏览器不能提交配置选择器。Worker 在已验证的原执行路由内选择
相应 OAuth 配置，并在最后发送前核对它与目标 Consumer 快照一致。多个 Agent 继续共用现有
持久安装命令表和事务，不新增调度器或逐 Agent 后台循环。

一个 Platform callback 接收入口仍固定同一 HTTPS callback URL、Connection issuer 和
callback 格式（标准 OAuth 或既有 PAT binding）；逐 Agent 配置必须与该入口一致，拒绝混用。
回调中的 state/binding ID 只定位原持久记录，不能选择 Agent、Runtime 地址或凭据。
Store 从原记录的 Agent 重新选择当前绑定；跨 Agent、配置漂移、过期或来源缺失均拒绝转交。
既有一次性领取、callback-only 服务认证和 unknown 不重放规则保持不变。

上述安装选择不创建 Consumer、不执行管理员注册，也不表示外部授权已成立。API/Worker
只传非秘密配置和原安装命令；API 瞬时转交一次性授权码的窄通道仍遵循本节“浏览器与回跳”。
授权码兑换及 access/refresh Token 仍由受保护 Host 执行和保管。

**DCR metadata。** 受保护 Runtime 为每个 Agent/安装生成唯一短期 loopback callback 路径，
并发送固定 metadata：`client_name="Codex"`、该 callback 的单元素 `redirect_uris`、
`grant_types=["authorization_code","refresh_token"]`、`response_types=["code"]`、
`token_endpoint_auth_method="none"`、`scope="mcp"`、`application_type="native"`。不得
接受 Agent、模型或请求覆盖这些字段；issuer、registration endpoint、回调 origin、resource
和 scope 必须与已批准 profile 完全匹配。注册响应只保留非秘密 `client_id` 及部署合同引用；
缺少可信的 Consumer/Instance 映射时保持安装不可用，不能把本地 client_id 猜作服务端实例。
DCR 响应还必须逐字段校验 `client_id`、返回的 `redirect_uris`、grant/response 类型、
scope、`token_endpoint_auth_method` 和 token endpoint 与批准 metadata 完全一致；未知字段、
服务端 secret、状态不明或无法建立可信 Consumer/Instance 映射都拒绝安装，并清除本地注册
结果。注册成功、Consumer 可见或本机登录不构成连接器授权，也不允许自动回退到其他 Consumer
或 Portable PAT。

**Loopback callback binding。** 路径由受保护 Runtime 使用高熵随机值生成，绝不接受 Agent、
模型、请求或 Connection 回调中的路径覆盖；它与原 principal、Agent、安装/Execution、
client_id、配置修订、PKCE/state 和期限在同一受保护安装记录中绑定。Runtime 只为该记录
启动有界 callback receiver，receiver 仅接受已登记的精确 loopback URI、一次性 state、
匹配 issuer/client/resource 和内部 callback 认证；成功、拒绝、超时或进程关闭后立即使
路径失效并关闭 receiver。通用 `/callback`、未知路径、第二次回调、跨安装 state、任意
redirect 或未绑定的本地监听器都 fail closed。若部署不能把 loopback receiver 可靠地绑定到
原安装（例如远程 Pod 无受控回传），不得选择 DCR，必须使用部署批准的预注册 client/HTTPS
callback 路线。

Platform 从当前认证身份与 Agent 使用权限固定原 principal＋Agent，并将安装授权发给
其所属受保护 Runtime。此授权只允许原客户端发起或确认登录，不签发 Connection 权限；
不能由 Owner、应用责任人、工作负载身份或模型代替原主体确认。命令合同和接收符号须在
实现 primary 中具名，经现有 Host Contract 的共同 owner 评审；不复用业务 Turn 来隐藏登录。
应用凭据不得通过员工浏览器确认取得，未获准的应用登录路线保持不可用。

**原安装事务。** Runtime 在读取任何秘密或访问 token endpoint 前，验证当前平台授权、
完整 profile/source 及 §13.5.4 的真实进程保护。它生成高熵、短期、单次 state 和 PKCE verifier，
在现有私有拒绝树中持久绑定原 principal＋Agent、Sandbox/generation、Consumer/client、
精确 callback、issuer/resource/scope、安装与配置修订以及期限；并发同一安装串行化。
state 不含主体或凭据，verifier 不离开该秘密边界。每个用户/应用＋Agent 独立创建安装，
不能把另一安装的授权事务、Token 或 Session 客户端状态拿来复用。

**浏览器与回跳。** 用户在 Connection 的独立页面确认授权；Platform 只呈现该次登录
入口与受限状态。固定 callback 可以由 Platform HTTP 入口接收并立即转交一次性授权码、
state、issuer 或协议错误，精确目标只从原受信安装事务定位。授权码按敏感临时材料处理：
不得进入 DB、队列、journal、URL 访问日志、Trace、错误正文、模型或工具；不得缓存响应、
跟随任意回跳或作为 bearer Token 使用。回跳不能选择 principal、Agent、Host URL、Consumer
或安装。回跳转交通道必须具传输保密和内部服务认证，有界且不隐式重试；缺少此接线即拒绝。
该窄通道不传 access/refresh Token、verifier 或 Consumer secret，不成为 MCP/Token 代理。

Runtime 对回跳校验单次 state、期限、原代次、精确 callback、响应 issuer 和未变配置；
成功回跳不独自启用安装。原平台主体须经当前登录态、Agent 权限及正常 CSRF/Origin 门禁
明确确认原安装，Runtime 消费对应具名确认并再次验证当前授权；其他主体确认拒绝。
随后只向固定 token endpoint 兑换一次原授权码与 verifier，拒绝重定向、调用方 header/URL
覆盖、跨 issuer/resource 响应和 SDK 隐藏重试。认证与 Token 响应仅在受保护客户端内处理。

**平台确认生产者与命令交付。** 独立确认由 Platform 实现，不等待 Connection 提供平台
身份或 Agent 权限接口。`registerConnectionInstallationRoutesV1` 在既有 Platform API 中接收
员工浏览器的安装发起、确认与受限状态读取；敏感命令复用当前登录态、exact Origin、
正常 CSRF/Fetch Metadata 门禁，拒绝 API/application 凭据。Core 的
`createConnectionInstallationAuthorizationV1` 从当前 IdentityAdapter 与 Agent 使用权限解析
原用户，不能用 Owner、显示名、邮箱或请求中的 principal 代替。管理员也不能代确认其他
用户的安装。初版只支持原用户已有且仍有效的 processing Execution；无原执行、已停止、
代次隔离、应用执行或无有效原 claim 时拒绝，不为登录新建、延长或恢复 Turn。

`PostgresConnectionInstallationAuthorizationTransactionV1` 在 Platform DB 原子保存平台
自己的非敏感安装授权及命令事实：authorizationId、原 user＋Agent、原 Execution/Session、
Sandbox/generation/Pod、完整 profile/source 与 OAuth 配置引用、当前授权修订、期限、显式
确认与撤销状态，以及各安装命令的交付状态。所有目标先从原执行和部署的当前受信事实解析，
请求不能选择 Runtime URL、Pod、scope、配置、凭据或主体。同一授权对象绑定不可变的
confirmationRevision；确认只推进原事务的状态，绑定/授权修订发生变化即使旧事务失效，
不得把新修订补进旧 OAuth 事务。发起确认不等于兑换确认；confirm 命令须有原用户对该次
安装的明确确认，status 不消费确认或推进权限。审计只记录引用、命令和结果状态。

`createPlatformConversationWorkerV2` 在既有运行循环中消费这些独立安装命令，并调用
`createConversationRuntimeV2.connectionInstallation.request`；不经业务 Turn、模型或工具
发起登录，也不建立第二个任务调度器。Worker 仅沿本进程当前持有的原 claim 执行，不能从
安装记录重造 business RuntimeGrant、续期 lease 或占用新的 Agent/Sandbox。部署的
`connectionInstallation.authorize(input, signal, finalCheck)` 逐次读取相同授权对象、当前员工
身份与 Agent 使用权限；等待 finalCheck 后再核对授权未撤销、期限、修订和全部绑定，返回
与 input 完全一致且带原 confirmationRevision 的批准。业务授权只作复核，不产生独立确认。

原 claim 的接缝具名为 `ConversationConnectionInstallationScopeV1.register`：Core 的
`createConversationDispatchUseCaseV1` 在 `persistRuntimeEvents` 已构造原
`ConversationRuntimeEventRequestV1` 后、打开事件流前登记；只登记非 control-only、非
metadata recovery 的原 processing 执行。它把同一个 in-process runtimeGrant 与原 heartbeat
signal 交给 Worker 的 `createConnectionInstallationCommandDrainV1`，不序列化 Grant 或
从 DB 重建授权 Context。Worker 在现有 tick/commit wakeup 的有界扫描中处理登记执行的
安装命令，因此不需要等事件流返回才消费，也不另开轮询器。登记只保存当前调用范围，
不取得执行/租约权威；原流退出、执行终结、失去 claim 或 signal 取消即关闭登记并排空
在途消费。尚未进入 sending 的命令在当前事实复核后拒绝或过期，不能挂到其他 claim；
已经 sending 的命令保留结果或 unknown，不因关闭登记转成可重试。

每个 begin/confirm/status 命令有独立的非敏感命令引用和严格请求摘要。领取命令与发送意图
通过原事务 CAS 串行化；必须在任何 HTTP send 前持久提交 sending。崩溃、超时、丢响应或
结果提交失败保留 unknown，不让下一 Worker 自动重发 begin/confirm；必要的 status 是原
用户另行请求的只读核实，不重放未知命令，也不重新调用业务工具。Platform 保存自身交付
事实及 Host 的受限状态响应，不把其 phase 当作 Connection token/Grant/实例事实。经原
目标校验的短期 authorization URL 可作为只向原用户提供的登录入口保存，过期或撤销即不可
读取；它不进入任务、模型、工具、审计或日志，不包含 Token、verifier、授权码或原主体信息。

**回跳定位与专用认证。** `registerConnectionOAuthCallbackV1` 接收部署固定的精确 HTTPS
callback。Worker 收到合法 begin 响应后，把 state 的 hash、authorizationId、原 scope、
当前 Runtime HTTPS 目标及期限关联到同一 Platform 安装事务，再开放登录入口；未保存映射
时不向浏览器返回 URL。原事务唯一约束与 CAS 保证同一 state 只定位一个当前安装且只消费
一次。回跳只接受标准 code/state/iss 或协议 error，拒绝额外、重复和矛盾参数；目标、主体、
Consumer、安装和任意 redirect 参数均不能来自回跳。与 Connection 原流程一致，回跳不
依赖浏览器 Cookie、CSRF 或 Origin，也不创建用户会话或自动确认；独立用户确认仍走上述
正常门禁。schema、体积、期限、issuer、配置及当前原执行/Pod 都须在转交前匹配。

API 在有界请求内向原目标的 `/internal/runtime/oauth/v1/callback` 瞬时转交一次；授权码
只存在于该窄通道和受保护 Runtime，不进入 Platform DB、outbox、journal、Trace、日志或
错误。state 单次消费须先提交，转交失响应/取消/崩溃保留 delivery unknown；不靠 HTTP
重试、重定向、队列或重开事务再次提交 code。响应和浏览器跳转仅含原安装非敏感引用与
受限状态，采用 no-store/no-referrer；部署入口必须排除 callback query 的访问日志与追踪。

回跳使用独立 callback-only 服务认证，其部署 SecretRef 与 Worker business/installation
凭据分开。它只能进入 callback 路由，不能访问 business、begin/confirm/status 或 MCP；
Worker 凭据也不成为 callback 的认证替代。`createRuntimeOAuthApp` 验证该专用认证后，
调用原 `createProtectedRuntimeOAuthClient.callback`，继续校验 state、原执行、配置、
保护和当前代次。API 不持有 Worker 签名私钥，不生成 installation JWS；缺少受控 TLS、
callback-only 凭据或唯一原事务定位时不转交、不降级到原 Runtime HTTP listener。
现有 Host 共用 Worker serviceToken 的 callback 接收须先拆分；缺少专用 callback 配置
仅关闭该能力，保留原业务/控制入口，不同时接受新旧两类凭据作为兼容路径。

平台确认/命令/callback 的设计与具名接缝沿
[#1589](https://github.com/AgoraIO-Extensions/agent-infra/issues/1589) 评审后再实施。
平台可先完成这些受控源码，但获准 Consumer/client/callback、真实部署路由和
Connection 原主体/实例映射仍是生产启用及凭据发布输入；不以 future 整票验收反向阻断
平台自有生产者的设计/开发，也不凭平台确认签收 Connection 授权或真实隔离。

**来源与发布。** PKCE/state 证明原 OAuth 事务的领取来源，不能证明两系统 Principal 相同、
当前 Grant、ConsumerInstance 或外部效果。Connection 仍按自身合同独立解析并逐次校验
Token 主体、Consumer/实例、generation、期限和授权。供应方仅消费部署匹配的已发布合同
核对 §13.5.3 要求的原主体/安装映射；标准 OAuth response 未提供的 identity/instance 字段
不能从邮箱、显示名、Token 名称、local state、JWT 猜测或 metadata 声明补造。缺少可信映射
时，即使领取成功也不发布可用安装，不调用业务工具；不得为了补证查询猜测的私有接口。

有效凭据通过 §13.5.5 的同一私有 export/接收器交付，access Token 与 metadata 分离；
refresh Token/verifier 只保留在同一受保护客户端的专用材料中，不进入 reader 的普通 metadata。
安装/凭据引用区分本地事务引用与 Connection 已确认引用，不以本地随机 ID 冒充服务端实例。
发布复用现有 material 先持久确认、metadata 后原子切换及修订冲突规则。初版仍采用受控
重新装配和固定安装快照：新安装修订须经批准配置、原接收器与 resolver 重新核对；不得
热改已有 Thread 工具快照，或因登录成功释放 unknown、强停未确认执行及借新 Pod 重放。

**失败、刷新与撤销。** 兑换或轮换响应丢失、崩溃及持久确认失败均保留该安装的不确定状态，
不自动重发授权码、refresh 或业务调用；只按实际已发布的恢复合同核实，否则由原主体重新
确认新的安装，旧事务不变为已成功。过期/撤销/保护失效时封闭新 MCP 发送，原控制、持久
事实及只读恢复保留。刷新只消费实际发布的 token 合同与 rotation/replay 语义，先持久确认
新修订再选择；远端撤销只消费固定 revoke 合同。停止 Session、本地关闭、删文件或请求
revoke 超时都不宣称已远端撤销，不替代 Connection 的逐次授权检查，也不启动同步循环。

首次实施必须具名列出 Consumer/client/callback 的批准来源、受保护回跳通道的接收函数、
原平台安装授权与确认合同、Connection 原主体/实例映射来源，以及同版本 MCP 服务/结果
合同。公开 OAuth/resource metadata 只足以固定协议端点，Browser Token CRUD 不成为领取
或安装映射合同；上述最小输入缺失时仅推进有明确接收者的受控源码实现，不启用真实 Token。
两主体/两 Agent、跨 Session/代次、错 state/issuer/resource、重放/撤权、丢响应与最终 Linux
秘密保护分别沿 #851 验证；登录、文档、export fixture 不代签这些结果。

## 14. 使用渠道

### 14.1 Web

平台对话页统一经过 `platform-api`，使用公司登录态、Agent 可用范围和平台 Conversation。自定义 Agent 的自有交互入口不进入 Platform Conversation Contract，历史不互相合并。

个人 Web 最近对话（`GET /api/v2/me/conversations/recent`）在全局 limit 之前，按 Agent 判定当前用户的使用范围和该 Agent 的平台对话渠道资格，只返回资格已确认的 Agent 下本人的 Web Conversation（[PRD §12.2](../prd/PRD-agent-platform-M1.md#122-会话历史)）。

- 某个 Agent 的资格无法确认时，只省略该 Agent 的会话，不让整个列表失败；其余会话照常返回。无法确认的情形包括：缺少 Workload 状态或状态无法解析、Workload 修订与当前配置修订不一致、fence 非法，以及自定义平台入口缺少已验证修订。
- 被省略的 Agent 必须仍在当前用户的使用范围内，且本人在当前位置之后还有 Web 会话。这些 Agent 的 ID 列在响应的 `unavailableAgentIds` 中，最多 100 个，不附带配置、修订或原因细节。没有被省略的 Agent 时不返回该字段。
- 无法确认资格的 Agent 不能按已确认处理：它的会话不进入列表，cursor 只在已确认的集合内分页。
- 当前身份、账号状态、查询或已返回记录校验失败时，整页仍按原错误失败。

### 14.2 企微

企微 Adapter 位于平台侧，绑定体验以[平台 PRD §10.2](../prd/PRD-agent-platform-M1.md#102-渠道绑定)为准。
平台只为四个标准模板和通过 Generic ACP 验证的 `platform-adapter` 自定义 Agent 创建企微绑定；
`self-managed` Agent 的绑定请求在保存前拒绝。

#### 14.2.1 配置与凭证

智能机器人默认使用 WebSocket 长连接。Owner 扫码授权或手动提交 Bot ID、Secret，
两者调用相同的 Core 配置用例；服务端生成渠道引用并复用 Agent 配置的版本、绑定和审计权威。
渠道变更只推进配置修订，不改变 Runtime 修订（§10.2），因此不重建 Agent Workload，也不升级 Session Sandbox。
浏览器表单不要求用户填写内部 `bindingReference`。扫码优先复用企微授权 SDK，手动配置作为独立入口；
部署提供获准的 `source` 与固定官方授权 origin，不能由普通请求指定授权端点。
扫码是否可用只由部署是否提供上述获准配置决定：机器人连接状态的 V2 入口（`GET /api/v2/agents/{agentId}/wecom-bot`）
与建立配置会话的响应使用同一份判定，不可用时附原因枚举，不含授权地址或 state。该字段只在服务端按当前账号确认
Owner 权限后返回，非 Owner、其他 Agent 与不存在的 Agent 不可区分；V1 状态入口及其 strict 投影保持不变。
浏览器据此在首次点击前门控扫码入口，不可用时直接给出手动配置，不建立配置会话。

配置会话绑定当前 Owner、Agent、配置版本及一次性短时随机 state；验证弹窗 origin、source、state、
过期和一次消费，防止跨用户、跨 Agent、重放及旧配置覆盖。SDK 的成功回调不是平台授权或凭证有效证明，
激活前仍由 Core 重验 Owner 权限和当前配置版本，由 Worker 验证企微认证。配置失败或取消保留原有效绑定。
若认证探测会争用正在使用的机器人连接，先展示影响并取得 Owner 确认，不能以“验证”名义静默接管。

企微 Channel 凭证属于 Platform 的渠道接入，不属于 Agent 运行时 env/Secret 或 Connection 外部账号。
Bot Secret 与应用发送 Secret 按既有平台应用层加密规范由 API 只写密文，Worker-only keyring 解密用于连接/发送；
密文用途绑定 Agent、渠道和配置版本，不走会向 Agent Pod 投射 Secret 的路径。
官方扫码返回及手动输入的 Secret 只在本次提交中短暂存在，提交后清除；不得查询回显、写浏览器持久存储、
URL、日志或审计。Agent、模型和 Runtime 均不得获得渠道凭证。
企微自建应用的官方 [`gettoken`](https://developer.work.weixin.qq.com/document/path/91039) 协议要求 Worker 以
HTTPS GET 向固定的 `qyapi.weixin.qq.com/cgi-bin/gettoken` 提交 `corpsecret` 查询参数。此供应商出站请求是
上述 URL 禁令的唯一例外；不得将该 URL 传给浏览器、平台 API、Agent、Runtime、日志、链路追踪或审计。
Adapter 禁止重定向并将网络及响应错误统一脱敏；部署的出站代理和观测设施必须移除该请求的完整查询串。

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
3. 通过受认证的企微目录快照与 LDAP 唯一邮箱关联，把企微发送者映射为公司稳定用户 ID；校验当前 LDAP 状态、管理员禁用、目录有效期、组织、Agent 可用范围和绑定。无法唯一关联或依赖不可用时拒绝，不按显示名或请求字段猜测。
4. 按单聊、群聊和协议支持的线程生成稳定的 Conversation 映射，键包含 Agent、绑定、渠道及服务端发送者；
   同群不同发送者保持独立 Runtime Session，协议无独立线程标识时不伪造线程支持。
   每个映射键在 Platform DB 中有一个当前会话轮次，默认为 0，表示沿用原有映射。
   发送者单独发送 `/new` 时，同一受理事务按映射键串行化，把轮次加一。之后的消息按新轮次创建新的 Conversation；
   旧 Conversation 不再受理消息，已受理执行的回复照常投递。`/new` 和普通消息一样按稳定事件 ID 去重，同一事件重放不会再次轮换。
   映射到的 Conversation 不可用或处于代次隔离时，不受理消息，写回执与审计并回复固定提示。
5. 标准模板按发送者个人 Relay Key 版本复用同一事务保存消息、Execution、授权边界、outbox 与回复意图，由共享 Worker 通过 RuntimeHost Client
   投递 Agent Pod 内的固定 Driver。重投/重连按稳定事件 ID 去重，变更同 ID 的内容、主体或绑定则拒绝。
6. 回复前再次校验当前身份、绑定和权限，沿获准协议发送。长连接回复不依赖 HTTP `response_url`；
   发送前记录意图，ACK 丢失或断连后保留 `unknown`，不得自动重发或将服务端受理宣称为终端送达。
   协议不支持可验证恢复时保留有界处置；失去有效回复上下文时明确失败/过期。
   长连接受理后立即在该消息的 stream 上发送 `finish=false` 的处理中提示（不属于业务回复，不记发送意图，
   失败不影响最终回复），处理期间按 §14.2.4 覆盖更新进度；最终回复在同一 stream 上 `finish=true`。
   回复有效期、超时定稿与失败提示送达见 §14.2.4，不静默过期。
7. 需要外部操作时由 Agent/客户端直连 Connection；Connection 独立验证触发消息发送者已授予的调用权限，
   不能使用其他群成员的授权。渠道传输变化不得绕过既有授权或新增 Runtime 调度器。

SDK 默认日志、debug 和重试行为必须验证，不照抄输出凭证或正文的示例。审计与指标覆盖绑定、凭证替换、
配置会话、连接状态、受理及回复，保持固定标签和脱敏投影。
Agent 投影的 `channels[].status` 只列出当前配置修订已配置的企微渠道，在可见性判定的同一只读快照内
按该修订的绑定引用读取连接事实，取值限于已发布枚举，不展示可见范围：
智能机器人以 `wecom_connections` 中同一 Agent、同一绑定引用的连接行为准，平台托管绑定还须是其配置会话记录的机器人，
租约已失效按断开处理；已认证为 `bound`，认证中或尚无连接行为 `binding`，断开或认证失败为 `failed`。
自建应用没有长连接，以配置会话为准：已激活且回调已验证为 `bound`，部署静态绑定没有平台验证事实时为 `binding`。
托管配置会话不再有效、不属于该 Agent 或渠道类型、连接事实不唯一或认证失败时一律 `failed`。
其他 Agent 或旧绑定引用的连接不参与；状态只用于展示，不替代绑定与授权检查，也不返回机器人 ID、会话、持有者或租约。
群聊、线程和附件映射由 Channel 层负责，RuntimeHost/Driver 不感知企微身份或自行改变映射。
四个标准模板和通过 ACP 验证的自定义 Agent 使用同一执行链路；Web 与企微会话不合并。

#### 14.2.3 媒体

本节规定企微渠道与 §15.4.4 文件交换的映射。决策见 [ADR-0032](../adr/0032-sandbox-file-exchange-and-wecom-media.md)；企微限额与部署要求见[企微部署](WECOM-text-deployment.md#媒体)。M1 只有智能机器人长连接支持媒体收发；自建应用和显式机器人回调声明为不支持。

长连接入站：

- image、file、video 消息：取下载地址、`aeskey` 和文件名。
- voice 消息：取转写文本，按普通文本受理。
- mixed 消息：文本项拼成消息正文，图片项作为附件。
- 下载前按 §15.4.1 核对目标 Agent 当前配置已验证的附件能力，并读取同一配置修订的 FileLimits 交集；与 Web 上传使用同一读取。
- Worker 在受理事务之外有界下载，并用固定版本 SDK 的解密工具解密（SDK 自带的下载不限制大小，不直接使用）。时间和大小都有上限：下载地址按官方说明 5 分钟内有效，大小取该企微 Channel 的 FileLimits 交集。
- 媒体类型按实际字节识别，经 File Authority 写入 attachment，绑定服务端解析的发送者、Agent、Channel 和 Conversation；幂等键由绑定、稳定消息 ID 和序号派生。附件写入前，按与受理相同的映射与轮次、经同一幂等创建路径确定并提交当前 Conversation；受理时映射已轮换的，重新确定会话后再写入。
- 受理事务只绑定已确认的附件。只带媒体的消息正文为空。
- 以下情况不调用 Agent，写回执与审计，并回复固定说明：Agent 未验证附件能力或未声明 FileLimits、类型不支持、超限、下载或解密失败、地址过期。
- 下载地址和 `aeskey` 只在 Worker 内存中短暂使用，不进入请求摘要、回执、日志、审计或事件。

长连接出站：

- Core 组装回复时，把回答中的 `sandbox:` 链接和图片改写为文件名，并写明会在下方发送或未发送的原因；`sandbox:` 引用式定义一并去掉，没有出现在回答中的结果文件逐行附在末尾。`text` 与 `textWithThinking` 同时改写，持久事件不变。引用按 CommonMark 解析，规则与 Runtime 发布一致（§15.4.4）。
- 文本 stream 以 `finish=true` 结束后，按引用顺序逐个处理已确认的结果文件，每次回复最多 10 个；没有引用顺序的文件（ACP image 块等）排在后面。文本未被明确受理时不发送媒体。每个文件发送前，都重新核对当前授权与回复路由，再经 Worker File Client 读取固定版本，上传临时素材并被动回复。Worker File Client 在进程内按文件记录的对象版本与 etag 读取，核对它仍是该执行已确认的结果文件以及实际大小与 SHA-256，不签发 File Grant。
- 类型映射：
  - png、jpeg、gif 且不超过 10MB：图片消息；
  - mp4 且不超过 10MB：视频消息；
  - 其他文件不超过 20MB：文件消息（超过 10MB 的图片和视频也按文件发送）；
  - 小于 5 字节、超过上述限制、不在该企微 Channel 当前 FileLimits 内或超出企微频率限制的文件不发送。
- 频率额度由当前连接持有者在内存中按滑动窗口计数，发送文本前规划媒体时占用；文本 stream 计为一条。持有者切换后重新计数。
- 回执按文件记录发送进度（`wecom_receipt_media`）：进入 `sending` 的同一事务按发送顺序写入，只能从待发送经 `sending` 前进到 `sent`、`failed` 或 `unknown`；每个媒体先记录发送意图并延长发送租约，再产生外部效果。不保存 `media_id`、File Grant 或文件内容。
  - 全部受理：`sent`；
  - 文本已受理，但有媒体失败或未确认：`unknown`；
  - 什么都没发出：`failed`。
- 已受理的媒体在恢复时不重发；ACK 丢失的媒体保持未确认，不自动重发。回执结束或发送租约到期时，已开始的媒体保持未确认，未开始的不再发送。撤权或绑定变化后，未发送的媒体不再发出。

不支持媒体的模式：

- Core 在交给 sender 之前去掉结果文件，并按出站规则改写文本，文本照常发送。
- 收到入站媒体（含回调模式的图文混排）时回复固定说明，不调用 Agent。
- sender 不再因为结果文件而整条失败，也不静默丢弃结果文件。

#### 14.2.4 入站保序、附件合并与流式进度

产品行为见[平台 PRD §10.3](../prd/PRD-agent-platform-M1.md#103-企微会话)与 [§10.5](../prd/PRD-agent-platform-M1.md#105-执行中消息与失败提示)，决策见 [ADR-0033](../adr/0033-in-flight-messages-wecom-ordering-and-streaming-progress.md)，固定文案见[企微部署](WECOM-text-deployment.md#共用执行与回复)。入站保序、附件合并和流式进度只适用于智能机器人长连接。自建应用和显式机器人回调不能覆盖更新已发送的回复，只发送终态回复（答案、排队超时、取消或失败说明），不发送位次与进度更新；失败提示送达规则对所有传输适用。

入站保序：

- 连接持有者按会话键串行处理入站帧。会话键由已认证连接的机器人与帧中的会话类型、单聊或群聊标识、发送者标识组成，在身份映射前即可确定，不使用显示名。同一会话键的帧按长连接收到的顺序逐条完成去重、身份映射、媒体下载与受理事务（或明确拒绝）后，才处理下一帧；不同会话键并行。
- 媒体下载、解密与写入 File Authority 在该会话键的串行槽位内完成，受部署的下载超时约束；下载期间同一会话键后到的文字等待，不能先受理。
- 每个会话键待处理的帧数有界，超出时按繁忙回复，不静默丢弃。
- 串行只在当前连接持有者内保证。受理事务写入 Message、Execution、附件绑定和回复意图前，必须在同一事务中校验 §14.2.2 第 1 项的当前连接持有者租约与隔离令牌（fence）；失去租约的旧持有者迟到帧一律拒绝，不产生任何绑定或执行。持有者切换先隔离旧持有者再接受新连接，新持有者对新连接收到的帧重新按会话键串行；重投帧仍按稳定事件 ID 去重（§14.2.2 第 5 项）。事件 ID 去重只消除重复，不代替租约/fence 对迟到写入和乱序受理的拒绝。
- 受理被拒（繁忙、无权限、会话不可用等）的消息已写入的附件不绑定任何 Message，同一处理流程把这些附件记录交给 §15.4.3 的对账有界清理，不留下长期无归属的附件。

附件合并：

- 只含附件的消息指 image、file、video，以及只有图片项的 mixed。它受理后新建的 Execution（直接投递或按 §12.5 排队）设合并窗口：Turn outbox 在受理后 3 秒内不可认领。作为补充指令受理的附件消息不设窗口。
- 窗口内同一会话键受理的下一条文字消息（text、voice 转写或含文本的 mixed）在自己的受理事务中作为新 Message 绑定到该尚未认领的 Execution，与已有附件一起组成初始 Turn 输入（文字在前、附件清单在后），并立即结束窗口。窗口内再收到的只含附件的消息并入同一 Execution 并重新计时；一个 Execution 最多合并 10 个附件，超出时新消息不再并入，按 §12.5 处理。
- 是否并入在 Conversation 锁内按 Platform DB 判定：目标 Execution 未被认领、窗口未到期且属于同一会话键与发送者。窗口状态不依赖进程内存；Worker 重启不丢失已受理的附件消息，窗口到期后按只含附件的消息执行。
- 合并后的 Execution 由文字消息的回执承担进度与最终回复；被并入的附件消息回执以固定说明结束其 stream。
- 附件接收失败的消息按 §14.2.3 回复固定说明（`media_rejected`），不建立 Execution，也不打开合并窗口。同一会话键在该失败回复后 3 秒内受理的下一条文字消息，在自己的受理事务中记录这些未能接收的附件（只含文件名与失败原因，不含下载地址、`aeskey` 或内容）；Runtime 把它们与附件清单一起作为平台说明追加到原生输入（§15.4.4），使 Agent 知道有附件未能接收，不改写用户消息。该记录在受理前只保存在当前连接持有者的内存中，持有者切换或重启时丢失只少一条说明，不影响消息受理。
- 合并结束后再收到的消息按 §12.5 作为补充指令、排队或繁忙处理。

流式进度：

- 每个 stream 只有一个发送者，覆盖式发送当前全量内容：收到上一帧 ACK 后才发送下一帧，相邻两帧至少间隔 1 秒，等待期间的新内容合并为最新全量。首次阶段变化与首段正文在间隔允许时立即发送；15 秒没有新内容时只刷新耗时。
- 进度帧与终态回复共用 §14.2.3 的发送租约和 §14.2.2 第 1 项的连接持有者隔离令牌：每帧发送前校验租约仍属于当前 Worker，失去租约后立即停止发送；每帧带单调递增的 `streamFrameSeq` 并随回执持久化，重启或持有者切换后由新持有者从已确认序号之后继续覆盖，旧持有者的迟到帧不重发也不被采用。
- 内容依次为阶段行、已持久化的回答正文前缀、按[企微部署](WECOM-text-deployment.md#思考过程)规则组合的思考过程（答案优先、截短提示）。阶段行显示阶段和自受理起的已用秒数，阶段包括排队中（第 N 位）、准备会话、执行中、调用工具（展示名）和模型重试。阶段只取自已持久化的平台状态事件与实际模型/工具事实（[Runtime HLD §8.5](HLD-agent-runtime-M1.md#85-实际模型工具事实与必要审计)），没有对应事实时不显示，不按时间推测；工具只显示展示名，不含参数或结果。
- 进度帧与处理中提示一样不经终态回执状态机、不记发送意图（帧序号按上一条持久化）；发送失败或 ACK 丢失不重发该帧，由后续帧覆盖，不影响终态回复。每帧发送前按 §8.2 的订阅复核规则重验当前发送者授权与绑定（每批复核、空闲时按固定间隔），失效后停止更新并按撤权规则结束。
- 进度帧与媒体共用 §14.2.3 的频率额度规划；额度不足时降低更新频率，优先保留终态回复。
- 只在终态发送 `finish=true`：完成时为最终答案；失败、取消和排队超时时为 [§16.1.1](#1611-用户可见失败分类) 的分类说明。终态回复沿用回执状态机和一次性发送语义。
- 回复有效期为收到消息后 9 分钟，留在官方 stream 时限（首次发送起 10 分钟）之内；合并后的 Execution 按文字消息计算。有效期结束前 30 秒仍未到终态时，领取回执并在当前 stream 定稿：保留已有回答，附固定超时提示，以 `finish=true` 结束。Execution 继续运行，结果保留在平台历史中；之后以主动消息补发最终答案，须先核实长连接主动发送的能力与限额，核实前不承诺补发。
- 排队与补充指令：入队时首帧为排队提示，位次变化后更新，出队时改为“开始处理”，随后按上述规则更新进度。补充指令消息的首帧说明正在补充，Runtime 接受后以“已补充到当前回复”结束；转入排队后按排队提示继续；投递失败时以对应失败说明结束。

失败提示送达：

- 终态回复领取前重验当前身份、绑定与权限。依赖暂时不可用时不放弃回执：在回复有效期内按有界指数退避重试（首次 1 秒、上限 15 秒）；有效期结束前 30 秒仍不能完成复核时，改发不含业务内容的固定失败说明（内部错误类，附 `traceId`）并结束 stream，不静默转为 `expired`。
- 复核确认主体禁用、权限撤销，或绑定、配置修订不一致时，仍按原规则取消，不发送。
- 已经到期的回执记为 `expired`；`sending`、`unknown` 与 `abandoned` 的语义不变。

### 14.3 自有交互入口

- 自有交互入口的流量、协议、Session 和历史由自定义 Agent 负责，不经过 Runtime Adapter。
- `platform-worker` 根据 Platform DB 中保存的 Owner 身份责任选择只发布对应的一条用户访问路由；Agent Service 与 Pod 地址始终只在集群内部使用，Agent ServiceAccount 和 Owner 无权创建或修改 Service、Ingress 或 NetworkPolicy。
- 选择自有身份入口时，平台发布 TLS 路由但不经过 Auth Gateway，也不注入可信 IdentityContext、Execution Grant 或平台撤权上下文；自定义 Agent 必须在服务端实施身份和权限，不能信任浏览器自行提交的用户 ID Header。账号生命周期、停用、撤权和会话终止由 Owner 的身份体系负责；需要部署身份状态或 Agent 可用范围变化立即生效时必须选择平台身份入口。
- 选择平台身份入口时，路由必须经过 Auth Gateway。Gateway 每次请求校验公司账号和 Agent 可用范围，移除或覆盖调用方提交的身份 Header，并传递绑定公司用户、受众、Agent 与有效期的短期签名上下文；自定义 Agent 服务端必须校验签名、签发者、受众、有效期和 Agent 绑定，不能信任浏览器字段。权限撤销后新请求立即失败，长连接按短期凭证到期或服务端主动关闭。
- 平台身份入口是部署能力。只有部署为 `platform-api` 装配了 Auth Gateway（`customAgentGateway`）时它才可用，此时 `platform-worker` 也必须配置平台身份路由集成（`platformAuthAnnotations`）。未装配时，Web 申请、修改后重新提交和 API 直接创建都在镜像准入前对“自有交互入口 + 平台身份入口”失败关闭，返回 409 `ACTION_UNAVAILABLE`：不创建或更新申请，也不进入审批队列，Web 在入口身份字段说明原因。两侧配置不一致时，由 [§10.5](#105-自定义-agent-runtime-manifest) 的 Worker preflight 规则兜底。

## 15. 数据与一致性

### 15.1 Platform DB 主要实体

- Agent 申请、Agent、创建主体、Owner、可用范围、独立应用/责任人和显式管理/使用授权。
- API 凭证的校验材料、范围、有效期和撤销状态，不保存可回读原值。
- 模板版本、自定义镜像 Digest、Runtime Manifest、env、版本化 Secret 密文状态和资源 Profile。
- Relay endpoint 的获准配置、Agent 默认与个人 Relay Key 密文/版本/用途、Execution Key 引用、模型选项、渠道绑定和已验证的集成能力。
- 会话、消息、回答版本、执行和执行事件。
- Session 到 Sandbox 的唯一分配与资源归属、worker 侧不透明 RuntimeHost Session Ref、`sessionGeneration` 和恢复状态；标识权威见 §10.1.1。
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
- Agent、Channel 与 deployment 三方文件限制声明保存在 Platform DB，包含单调修订、有效期、媒体类型与最大字节数。Agent 与 Channel 声明只能由当前 Owner/Co-owner 或 system_admin 经管理 API 写入，deployment 声明只能由 system_admin 写入；写入以 `Idempotency-Key` 和期望修订比较并交换。读取按当前配置修订绑定，缺失、过期或修订不一致拒绝，不能用部署常量或请求体代替权威声明。
- 写入仅在当前 capability、媒体类型与大小限制内开放。数据面限制字节数、持续时间和并发量，流式计算 SHA-256；S3 写入使用条件创建，已存在对象不覆盖。完成确认读取实际对象的固定版本/etag，重新验证媒体类型、实际大小和内容 Hash 后才将记录变为 `available`。调用方声明或 S3 metadata 不能独立证明内容 Hash 或媒体类型；Adapter 根据实际字节核验允许格式，无法确认的格式拒绝，不提供任意二进制类型回退。
- 媒体类型以规范化结果为准：字节只能确认为纯文本（合法 UTF-8，除制表符、换行和回车外不含控制字符）、无法确认子类型时，采用平台固定白名单内的声明类型，其他情况采用字节识别结果。白名单为 `text/csv`、`text/markdown`、`application/json`、`text/tab-separated-values`，由平台代码维护，调用方、FileLimits 声明和请求体都不能扩展。规范化结果须与声明一致，所以白名单之外的文本子类型、字节不是纯文本的白名单声明（例如声明 `text/csv` 而实际是 PNG）一律拒绝。FileLimits 匹配、完成确认和记录的媒体类型都使用规范化结果，FileLimits 只列 `text/plain` 时不接受其子类型；没有声明类型的写入（企微入站、15.4.4 的结果发布）记录字节识别结果。Web 上传前复用同一实现提前拒绝声明为文本却不是纯文本的内容，最终仍以 Adapter 核验为准。
- 文件状态为 `pending`、`available`、`failed`、`expired`、`deleting`、`deleted`。对象已写但响应丢失或提交未知时保持原意图，沿同一对象核实；存储不可用不解释为对象缺失，不把 unknown 当成功。已确认文件的完成重放返回原结果；它不再授予写入权。对象版本不可确认或实际内容不匹配时不得引用。

重新生成可通过当前 Execution 的新 Grant 读取原 Message 附件，不修改文件的原始绑定；旧 Grant 或旧 generation 不能因此恢复有效。

#### 15.4.2 认证数据面与短期授权

- 文件服务先持久保存对象/操作/主体/时间/限制绑定的 access 记录，再由部署可信签名器产生独立 `FileAccessGrantV1`（compact JWS、EdDSA、受信 key version）。签发方是配置固定的 Platform 文件授权服务，唯一 audience 为 `platform_files`；`purpose=file_access` 与 Execution Grant 用途显式分离。验证器只接受部署登记的签发方、key 和 audience。
- Claims 绑定 `accessId`、`fileId`、actor、Agent、Channel、Conversation、`read`/`write`、签发/过期时间、最大字节数；执行用途另绑定 Execution、Session generation 和原 Execution Grant 引用。签名器仅消费 Core 已提交的 access 记录，不能接受 Runtime 自报 owner、对象键或任意 claims。数据库保存该记录及 key version，不保存 JWS 或可复用 URL。
- 浏览器取得平台相对数据面路径和独立短期 Grant；Grant 只通过专用请求 Header 传输，不写入 URL、业务历史、日志或审计。每次实际使用同时解析当前用户会话/有效 API 凭证并比较持久主体和全部对象/操作绑定；同一 URL 或 Grant 被其他主体持有也不能使用。读写、完成确认和续签重新检查当前授权；Owner/应用责任人角色不授予内容读取权。Eval 文件另走独立用途授权。
- 执行期访问生产者调用 Platform API 的 `POST /internal/v1/files/runtime-exchange`，且须通过执行期服务身份认证（见下）；RuntimeHost 文件桥接复用同一受认证客户端。请求只携带 `RuntimeFileExchangeRequestV2`：原 Execution Grant V4 签名原文、操作、单一 `fileId` 或结果描述及幂等键；旧的 V1 自报身份/过期时间/附件范围字段在同一路由继续拒绝，不得被解释为授权。请求不含可与签名原文竞争的 actor、Execution、generation、fence、allowlist 或 Grant 有效期，这些事实一律取自签名 claims 与持久记录。
- Platform API 的文件授权服务是新 File Grant 的唯一签发边界。交换在对象 I/O 前依次校验：V4 JWS（`typ=runtime_execution+jws`，固定 `alg`/`kid`，配置 issuer 与签名 Worker identity）、授权的 `turn.submit`/`turn.supplement` 命令及 Execution/Message 操作绑定、执行期服务身份及其允许的 Agent，然后在一个事务内读取持久 Conversation、Execution、Session generation、delivery fence、终态/停止标记和 `task_authorization_records`（存在、未撤销、主体/Agent/Channel 与 `agentAuthorizationRevision` 均匹配）。输入只能来自签名 claims 的附件 allowlist；结果先由文件 Core 分配 execution-bound 文件，再签发仅该对象的 `write` 权限。新 File Grant 的有效期取部署 `accessTtlMs`，不从请求或原 Grant 复制。
- 原 Execution Grant 是“执行委托范围”的证明，不是持续有效的授权凭证；签名中的 30 秒窗口只约束签发时的委托范围，交换不因窗口自然流逝而放行，当前授权始终由上述持久状态决定（见 [ADR-0014](ADR-0014-runtime-execution-file-bridge.md)）。现有 `ExecutionGrantClaimsV1`、其 audience 和只读附件范围不变，不能用旧 Grant 直接调用文件数据面或凭服务身份签发写入。
- 执行期服务身份按执行的 Sandbox 绑定确定：未绑定 Sandbox 的执行（Agent Workload）使用部署登记的服务 token；绑定会话 Sandbox 的执行只接受该 Sandbox 的文件交换派生凭据（§10.1.1）。Platform API 从 Platform DB 读取该执行当前的 Sandbox 分配（同一 Conversation、Execution 与代次，`ready`/`running` 且观测就绪，含 Sandbox、namespace 与 `resourceFence`），用登记且映射到该 Agent 的服务 token 重新计算后恒定时间比较。分配缺失、未就绪或不匹配，部署 token 本身，另一 Sandbox 或旧代次、旧 fence 的派生值均拒绝，拒绝与对象不存在不可区分。部署仅向受信 Worker/RuntimeHost 配置服务凭据并固定映射允许的 Agent；两类组件不具有不同的文件权限，请求 Header/Body 不能选择或扩大该映射，凭据不进入日志或错误。
- RuntimeHost/Worker 消费新 File Grant；执行数据面还须通过同一执行期服务身份认证，不能仅凭 Grant bearer 请求访问。数据面重新验签并查询当前 Execution、主体授权及 generation；终态、取消、撤权、过期、代次变化或对象/操作不匹配拒绝。历史读取走当前主体的历史权限，不要求 Agent 正在运行，也不能用过期执行权限读取。控制用途 Grant 不允许文件操作。
- 数据面在授权后由服务端流式访问对象存储；S3 预签名能力只用于服务端内部请求，不返回或重定向到 S3 bearer URL。读取固定版本并检查 etag；写入完成前再次授权，过期/撤销的写入即使产生对象也不能成为可见文件。数据面依赖错误只返回受限代码，不暴露对象存在性、内部 URL、证明或凭证。

#### 15.4.3 消费、恢复与清理

- 新文件 API 和 File Grant 使用独立 V1 Schema、生成的 JSON Schema/OpenAPI 与客户端；不改写既有 Browser、RuntimeHost、Execution Grant 或 `result.file` V1 的含义。后续消费者通过 `fileId` 复用已有附件引用/事件，不能手写第二套文件 DTO；Worker 持久化 `result.file` 前必须核对同一执行中已确认的 `available` 结果记录；事件 `name`、`mediaType`、`sizeBytes` 必须与该记录一致，Runtime 返回值不能成为第二元数据权威，不一致拒绝持久化。
- 正式文件与引用按部署数据政策保留，停止、重启、升级和停用不删除合法历史。平台不新增产品级保留期限、用户删除或导出能力。上传期限、临时访问期限和对账批量是部署资源限制，不能作为正式文件保留策略。
- 对账持久记录处理游标与重试状态，有界处理过期意图、失败对象及本部署文件命名空间中的孤立对象；删除须在状态检查后限定到目标版本，重试不影响其他对象。写入与清理通过状态和租约隔离；清理失败保留 `deleting` 并有界重试。对象写入最晚期限及未完成写入的收敛窗口结束前不遗忘其记录，迟到写入须再次核实清理。
- 文件服务本身提供 Worker/RuntimeHost 的访问生产者与数据面契约。Driver 文件交换按 15.4.4，企微媒体映射按 §14.2.3；四模板文件 E2E 完成前不能宣称已交付。
- Web 对话的结果文件预览是文件数据面之上的受控消费者：读取仍须先取得当前 File Grant，再使用一次性内存 Blob，不能把对象地址或 Grant 放入 URL、消息正文或持久化状态。文本、图片、PDF 与统一 diff 可在有界大小内预览；静态 HTML 只能在不授予 `allow-same-origin` 的 sandbox iframe 中预览。媒体类型、大小、内容无法确认或超出预览上限时只显示下载。预览读取失败、撤权、跨主体/Session 和会话失效必须与下载一样拒绝且不泄漏对象存在性。
- Web 结果文件卡应显示预览、下载和状态反馈；统一 diff 至少显示文件范围与增删统计。上传控件可以对当前获准的图片提供本地临时缩略图，但缩略图只来自用户选择的 File 对象，上传和消息绑定仍走本节正式 File Grant。模型正文中的图片 URL 不进入浏览器加载路径，唯一例外是 15.4.4 的 `sandbox:` 引用：它与同一执行中已确认结果文件的 `workspaceReference` 匹配时，经当前 File Grant 读取内存 Blob 后显示。外链只允许安全 HTTPS，并拒绝凭证和危险协议。

权衡记录见 [认证文件数据面与独立执行期文件授权](../adr/0010-authenticated-file-data-plane.md)。

#### 15.4.4 会话 Sandbox 文件交换

本节规定四个标准模板在 Session Sandbox 内交换附件和结果文件的方式。通过 ACP 验证的 `platform-adapter` 自定义 Agent 只适用下文“契约与 ACP”中的 ACP 块映射，附件仍按其协商的 ACP 能力传递。决策与取舍见 [ADR-0032](../adr/0032-sandbox-file-exchange-and-wecom-media.md)，各 Driver 的映射见 [Runtime HLD 8.5.5](HLD-agent-runtime-M1.md#855-会话-sandbox-文件交换)。15.4.1–15.4.3 的授权、数据面和 Store 核对规则不变。

附件物化：

- Driver 只通过 FileBridge 的 `readInput` 读取本次 Grant 精确列出的附件。
- 读取被平台明确拒绝时（交换或数据面返回 4xx，408、429 除外），若拒绝发生在原生副作用和该操作的 Driver 持久记录之前，RuntimeHost 持久化不可重试的 `RUNTIME_FILE_INPUT_REJECTED`，只有 submit V2 及以上返回该结果。Worker 按 [Runtime HLD 8.1](HLD-agent-runtime-M1.md#81-消息与命令幂等) 中“初始 Execution 在 Runtime 明确接受前失败”的规则，把本次 Execution 收敛为失败，并在同一事务内终结其待处理的补充指令与 stop，会话保持可用。读取失败但不是明确拒绝时（超时、断连、5xx、响应无法解析），若失败发生在原生提交点和该操作的 Driver 持久记录之前，Driver 声明本次 Turn 未提交，RuntimeHost 持久化可重试的 `RUNTIME_TURN_NOT_SUBMITTED`，Worker 按 [§12.2](#122-可靠性规则) 重提或明确失败；无法排除已有副作用时保持“接受结果不确定”，不推断为失败。
- 写入位置为当前 Conversation 工作区的 `.agent-infra/attachments/<ref>/<name>`：
  - `<ref>` 取 fileId 的 SHA-256 前 16 位十六进制。
  - `<name>` 只保留 basename，去掉控制字符、路径分隔符和开头的点，不超过 255 字节。
  - 文件以只读权限创建。只读权限只用来防止误改，不构成安全边界；平台目录中逐级拒绝链接和越界。
  - 工作区副本不是权威数据：Agent 在本 Sandbox 内改写或删除副本属于本地操作，权威字节始终在 File Authority 中。
  - 目标已存在且 SHA-256 一致时直接复用。内容不一致或文件缺失时，在同一目录写临时文件，再以 rename 恢复平台副本；不会写到平台目录之外。
- 可接受的媒体类型和大小取 15.4.1 的 FileLimits 交集。Driver 自身的上限为单文件 50 MiB、单条消息 32 个；超限在 native side effect 之前拒绝。
- 原生输入在用户消息之后附加平台生成的附件清单，列出名称、媒体类型、大小和工作区相对路径。清单不改写平台消息，也不进入事件、审计或遥测。
- 图片仍按各 Runtime 的原生图片输入交给模型。
- 附件属于该会话的工作区数据，保留到 Session 结束，随 Sandbox PVC 回收。
- 重试或重新生成时，按新的 Grant 重新读取并核对内容，复用同一路径。
- Host 临时路径、对象引用和 File Grant 不进入 journal、事件或日志。

回答内引用：

- Agent 交付文件的唯一方式，是在最终回答中使用 CommonMark 链接或图片（含引用式定义），并以 `sandbox:` 作为 URL scheme。
- 路径规则：
  - 路径相对工作区根目录，开头的 `/` 也表示工作区根目录；
  - 先做百分号解码，然后拒绝以下情况：NUL、反斜杠、`..` 越过工作区根目录、解析后不在工作区内。
- 以下内容都不是引用：代码块、行内代码、普通相对链接、裸路径。

解析与发布：

- 解析时机：原生 Turn 以 completed 结束、最终回答已确认之后，写终态事件之前。失败、取消或 unknown 的 Turn 不发布。
- 引用按首次出现的顺序、以规范化路径去重，每次执行最多发布 10 个。超出的引用不逐个记录，合并为一次 failed 的发布操作。
- 每个引用逐项校验：
  - 用 `O_NOFOLLOW` 打开，且必须是普通文件；
  - 打开之后，读取、类型识别、SHA-256 计算和上传都使用同一个文件描述符，不再按路径重新打开，避免校验之后文件被替换；
  - 实际读到的大小不超过 FileLimits 和单文件 50 MiB 上限；
  - 媒体类型按 15.4.1 的同一规则识别；结果发布不携带声明类型，因此记录字节识别结果（纯文本为 `text/plain`），且必须在 FileLimits 内；
  - 名称取 basename。
- 结果意图的 descriptor 包含上述 SHA-256 与大小。
- 发布属于 §10.14 的平台中介操作：
  - 发布计划（解析出的引用清单）与每个引用的发布进度保存在 Driver 持久状态中；计划收敛前不写终态事件。
  - 每个引用先保存带 descriptor 的 intent，再保存 started，然后调用 `writeResult`（经运行期文件交换核对当前授权），最后保存 completed、failed 或 unknown。
  - 已 started、但当前进程没有 `writeResult` 结论的引用记 unknown，沿原结果意图核实，不新建意图重发。
  - 事实中不含路径或内容。
- 执行期文件交换上下文只存在于本次投递的 Host 内存中（[ADR-0014](ADR-0014-runtime-execution-file-bridge.md) §6）：
  - 上下文仍在时，已保存 intent、尚未 started 的引用在继续发布前重新打开文件并校验；内容与 intent 的 descriptor 不一致则记 failed，不改发新内容。
  - Driver 或 Host 重启后不重建该上下文，也不补发；部署未装配文件交换时同样没有上下文。此时未收敛的计划按已保存进度一次收敛，再按原生终态写终态事件：
    - 尚未 started 的引用记 failed；
    - 已 started，且 journal 中已有 `workspaceReference`、名称、媒体类型和大小都与 intent 相同的 `result.file` V2 事件的，记 completed；
    - 已 started 但没有对应事件的，记 unknown。
  - 原生终态在重启后才确认的 Turn 同样没有上下文：回答内引用直接记 failed，不发布。

契约与 ACP：

- `result.file` V2 在 V1 字段之外增加 `workspaceReference`：规范化的工作区相对路径，不超过 1024 字符，可为 null。
  - 该值在分配结果意图时写入 File 记录；Worker 持久化事件前，核对它与记录一致。
  - V1 读取方仍收到原有 V1 事件。
  - 15.4.3 中关于 `result.file` V1 的约束保持不变。
- ACP 的 `agent_message_chunk` 中：
  - `image` 块按同样的限制直接发布，`workspaceReference` 为 null；
  - `resource_link` 按引用处理须同时满足：URI 是 `file:` scheme，authority 为空，百分号解码后的绝对路径位于工作区根目录内，并通过与 `sandbox:` 相同的越界、链接和普通文件校验；带主机 authority、工作区外路径或其他 scheme 的一律不发布；
  - 其他块不发布。

模板指令与隐式发布：

- 平台在各模板的开发者指令或系统指令中，固定说明附件清单与 `sandbox:` 约定。指令内容由平台维护，不是能力来源，模型、Owner、工作区文件和 Skill 都不能改写。
- apply_patch、Write/Edit 和 ACP diff 不再隐式产生结果文件。

## 16. 错误、幂等与恢复

### 16.1 错误模型

所有接口返回稳定错误码、用户可读消息、`traceId` 和可重试标记。内部异常、SQL、Pod 名称、Token 和凭证不能进入普通用户错误。

产品状态映射：

| 工程状态 | 产品表现 |
| --- | --- |
| Workload 未就绪 | 启动中 |
| 正在应用新的 Runtime 修订 | 更新中 |
| 探针失败或 Adapter 不可达 | 暂时不可用 |
| 单个 Runtime Session 恢复失败 | 对应 Conversation 显示“会话不可用”，历史只读且禁止继续发送；其他 Conversation 不受影响；企微回复“当前会话不可用，发送 /new 开始新会话” |
| 原生会话被受理不明的 Turn 阻塞（Runtime 返回 `RUNTIME_SESSION_BLOCKED`） | 本次执行失败；对应 Conversation 显示“会话不可用”，历史只读且禁止继续发送，可明确新建会话；其他 Conversation 不受影响；企微的失败提示附带 `/new` 指引 |
| API 等待容量已满 | 受理前拒绝，可稍后重试，不返回新任务标识 |
| Web/渠道排队已满或 Agent 等待容量已满 | 繁忙，返回当前排队条数，不创建消息（§12.5） |
| 已受理任务等待到期 | 原执行明确失败，保留失败原因；Web/渠道排队消息显示排队超时 |
| 取消已请求但停止未确认 | 取消处理中，同 Conversation 后续任务继续等待 |
| Runtime 接受或外部结果不确定 | 待核实，不能显示已取消或成功；相关 Conversation 禁止继续执行 |
| Agent 明确拒绝新任务 | 繁忙，可重试 |
| Provider 限流或短暂故障 | 明确提示稍后重试 |
| Connection 失效 | 说明原因并提供重连入口 |

#### 16.1.1 用户可见失败分类

Web 与托管渠道的执行失败按下表归入渠道无关的用户可见分类，产品要求见[平台 PRD 10.5](../prd/PRD-agent-platform-M1.md#105-执行中消息与失败提示)。规则如下：

- 只按已持久的受限原因映射：Runtime `protocolCode`、模型调用 `failureCode`、文件交换错误码和 Platform 任务原因。不解析错误正文、供应商消息或日志。
- 每个码只映射一个分类，未知码归入内部错误。分类与文案模板由 Core 统一维护，Web 与企微读取同一结果；企微的具体文案见[企微部署](WECOM-text-deployment.md#共用执行与回复)。
- 码到分类的完整对照随实现以 Contract 固定并测试。新增码先确定分类再发布。
- 文案不含内部异常、SQL、Pod 名称、Token、凭证或供应商错误正文。
- 待核实不是失败分类，仍按 §16.1 显示；停止与取消、繁忙、回复超时继续使用各自的提示。

| 分类 | 主要来源（示例） | 用户说明与建议 |
| --- | --- | --- |
| 模型服务繁忙或超时 | 可重试的模型调用 `failureCode` 或 Runtime `protocolCode`：限流、超时、上游暂时故障、流中断 | 模型服务暂时繁忙或超时，请稍后重试 |
| Agent 正在更新 | 正在应用新的 Runtime 修订，或 Workload 启动、更新中导致的 `AGENT_UNAVAILABLE` | Agent 正在更新，完成后重试；有可靠阶段信息时给出预计等待时间 |
| 会话准备失败 | Session Sandbox 准备或恢复失败，Driver 物化或启动失败（含未提交重提用尽的 `RUNTIME_SESSION_PREPARATION_FAILED`）；已判定会话不可用的除外 | 会话准备失败，请重试，仍失败时新建会话 |
| 附件读取失败 | `RUNTIME_FILE_INPUT_*`（含未提交重提用尽的 `RUNTIME_FILE_INPUT_UNAVAILABLE`）、`RUNTIME_FILE_BRIDGE_*` 等文件交换错误，附件过期或超限 | 附件无法读取，请重新发送附件 |
| 权限已失效 | `AUTHORIZATION_REVOKED`、`RUNTIME_AUTHORIZATION_DENIED`、渠道权限撤销 | 当前没有使用该 Agent 的权限，请联系 Owner 或管理员 |
| 个人 Relay Key 不可用 | 个人 Key 缺失、失效、额度不足或无权调用所选模型（§10.7） | 请到个人设置处理 Relay Key |
| 排队超时 | `TASK_WAIT_TIMEOUT` | 排队超过等待时限，未处理，请稍后重新发送 |
| 会话不可用 | `CONVERSATION_UNAVAILABLE`、`RUNTIME_SESSION_BLOCKED`、Runtime Session 恢复失败 | 当前会话不可用，请新建会话；企微发送 `/new` |
| 内部错误 | 其他未分类的错误 | 平台内部错误，附 `traceId` 便于反馈 |

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
- 平台会话的 Sandbox 出站遵循 §10.1.1；标准模板的模型请求只使用获准模型端点，原生工具直接出网只能到达部署批准的目标（§10.14），自定义 `platform-adapter` 的模型端点同样须获部署批准。`self-managed` 的其他出站沿部署网络策略，不从其声明推导平台会话的出站权限。
- 标准模板原生工具在 Session Sandbox 内运行，工具子进程不能读取 Relay Key、模型传输 token、Connection、MCP 与 Browser token 或平台服务凭证（§10.14）。
- 自定义镜像必须通过 ImageRegistryAdapter 准入，并使用不可变 Digest。
- 容器以非 root 用户运行，根文件系统默认只读；需要写入的数据挂载到明确卷。
- 个人与 Agent 默认 Relay Key、Owner Secret 和企微凭证按各自用途加密保存、不回显，只能替换。旧 Key 密文只在仍有已受理 Execution 引用时保留。
- 审计和日志不记录聊天正文（含思考过程）和原始凭证。M1 不从会话正文派生标题，标题投影保持空值，由 Web 按 [PRD §12.2](../prd/PRD-agent-platform-M1.md#122-会话历史) 统一展示“未命名对话”。
- 所有跨主体（用户或应用）资源访问测试按“资源不存在”返回，避免枚举。
- 任务、会话、附件、执行详情和自身审计查询始终匹配提交主体；Owner/应用责任人不因此获得他人内容或使用记录。Eval 按独立用途和对象授权，不能成为会话访问旁路。

网络、可替换 IdentityAdapter、OCI Registry、固定 Relay 目录、加密公钥/解密 keyring 注入和对象存储的具体装配由部署环境决定，但上述访问结果是 M1 的硬性要求。企业部署默认使用本仓第一方 LDAP Adapter 和独立企微目录同步服务。

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

API/Worker 的外部操作在调用前保存意图；RuntimeHost/Driver 的平台中介调用（§10.14：模型请求、Driver 执行的 MCP、Connection 与受控工具、平台文件与 Browser 外部副作用）须在执行侧可靠记录原操作意图及结果，再按稳定引用投递平台必要审计。Session Sandbox 内的原生工具操作和获准的原生出网只记录实际工具事实（§18.1），不保存执行前意图。只有已持久确认的意图才允许开始操作，记录失败时阻止尚未发生的操作并报告故障。响应或结果保存失败只能记录未确认并沿原操作核实，不能重发有副作用的请求制造结果；Connection 的外部意图/效果始终由 Connection 自己记录。

请求尝试与业务幂等操作、受理与完成、取消请求与停止确认、工具结果与外部效果分别表达。必要审计无法可靠保存时不返回虚假成功；已经发生的效果不能抹去，授权拒绝不能变成放行。审计 API/页面按时间、主体、Agent、动作、结果和执行引用筛选、分页并查看详情；查询故障明确报错，不返回伪空列表。

系统管理员仅按职责读取平台元数据，用户/应用只能查询自己的执行审计；Owner/责任人没有他人使用记录权限，Connection 管理权限不互相继承。审计不存正文、附件、思考、证明或凭证值；保留与受控清理服从部署数据政策，清理不伪造历史业务结果，访问和清理均受权限控制。

审计查询的 V2 入口（`/api/v2/audit`、`/api/v4/admin/audit`）为记录附带 Agent、创建申请和应用的显示名，V1 入口与其 strict 投影保持不变。名称只为本页已授权记录中的引用解析，在同一查询事务中按查询方的当前权限确定：系统管理员按职责可见上述平台元数据；用户/应用只解析本次已按当前访问权核验的 Agent 名称，不返回创建申请和应用名称。无权、不存在或无法确认时只返回类型与 ID。名称不按调用方提交的 ID 解析，Agent 筛选对不可见与不存在的 Agent 同样拒绝，审计不能成为探测对象是否存在的旁路；用户名称仍由目录按权限解析，名称不写入审计记录本身。

### 18.4 Eval 数据与执行

Evaluation 是 `platform-core` 内部模块，API 提供管理与查询，Store 保存权威业务数据，Worker 消费持久工作项。Web 提供数据集/实验/逐例对比/人工复核入口，对话或任务详情提供主动反馈；不新增 Eval 服务、通用评测框架或固定厂商依赖。产品闭环和评分维度以 [Eval PRD](../prd/PRD-agent-platform-M1.md#15-模型质量评估与效果分析) 为准。

- **版本与数据：** 数据集保存获授权样本的输入、必要上下文、任务类型及预期结果/判定标准；修改生成新版本。实验固定数据集/标准版本、基线/候选及评分器版本，每例引用实际 Execution、实际模型、模板/镜像、非敏感配置版本和工具环境。请求的版本与实际执行版本不能混同；条件变化或随机性影响须可见，不可比样本不能冒充同条件排名。
- **任务复用：** 每例通过现有 Dispatch/Conversation/Execution 执行，拥有独立任务引用，默认隔离样本上下文；使用原发起主体的当前 Agent 使用权和独立数据权限，模型调用使用 Agent 默认 Relay Key 并标明费用归属，不能借 Worker 身份、Owner 或责任人身份访问其他任务。取消、查询与恢复复用任务用例，Connection 调用仍需独立授权。四模板必须验证；模板版本对比由平台受控测试配置执行，不赋予 Owner 锁定生产旧模板的能力。
- **评分与复核：** Worker 执行版本化确定性规则或获授权模型评分工作项，人工评分/复核经同一 Core 保存独立结论；评分理由、来源、评分模型与 rubric 版本可追溯。模型评分复用 Agent 默认 Relay Key、获准模型目录与受控请求能力，不扩展 Runtime 传输协议或另建模型路由；Key 无权调用时评分失败并提示费用归属。任务业务失败、评分器故障、缺失和不适用独立保存，评分重试只重跑评分，不重放业务任务。
- **分析与反馈：** 汇总和逐例对比使用相同样本/标准，展示分母、已评分数、缺失/错误及可比覆盖；耗时和 Token 取实际采集值。历史结论保留，新样本/标准以新版本重跑。反馈仅由提交主体对自己的任务主动提交有用/无用和问题分类，绑定实际模型/配置/时间；单独统计数量、反馈率和分布，未反馈不作成功，反馈不混入离线通过率。
- **内容与授权：** 样本、输出、评分理由与实验明细走独立 Eval 用途授权和受控存储，不进入遥测/审计。线上正文禁止自动导入，实际材料须获明确 Eval 用途授权并脱敏；原任务访问权不替代该授权。获授权 Owner 可访问允许的评测数据与反馈汇总，不能因此读取其他主体原会话。评分端点与数据用途需获准，工具使用受控测试账号/环境/响应，不自动重放线上写操作。
- **生命周期：** API、Worker 执行/评分和内容读取都校验当前数据授权；保留、撤权和删除按部署政策执行，历史可回看不绕过当前授权。删除正文后仅保留政策允许的版本和结果元数据，不能继续展示被撤权或删除的样本。

#### 18.4.1 部署批准与用途授权

Eval 的私有部署输入由 API/Worker 启动装配为只读、版本化政策，Core 通过窄 Port 消费当前政策事实。
Platform DB 保存用途授权及其撤销状态；部署输入限定谁能授予什么，不直接构成样本读取凭证。
具体主体、地址、期限和限额由部署明确提供，不内置生产默认值。

| 必填政策 | 内容与拒绝条件 |
| --- | --- |
| 政策身份与授予边界 | `policyId`、单调 `revision`、有效期；具主体类型和稳定 ID 的授权管理者，以及各自可管理的数据集范围、操作上限和最大授权期限。未知主体、重复或重叠矛盾声明、越界授予拒绝 |
| 内容生命周期 | 各类内容的保留期限、起算事件、删除完成期限，以及可保留元数据字段与期限；缺少任何一类规则不能导入或产生该类内容。规则覆盖样本/上下文、rubric、执行输出副本、评分理由及复核内容 |
| 执行与评分许可 | 获准 Agent/模板能力、受控工具环境；每个评分器的不可变版本、结果规则和执行限额；模型评分另含精确 Catalog endpoint/model 与数据用途范围。可达性或 Key 可用不替代许可 |

未配置政策时 Eval 保持未配置；已启用而政策非法或当前事实不可读取时拒绝受理、内容访问和新投递。
API 与 Worker 必须使用同一政策身份及当前 revision，不能回退旧缓存。政策失效不阻止系统完成既有
停止、撤销和已持久化删除义务，也不授权读取正文；处置按 §18.4.3 的原义务执行。

数据集 API 的个人与应用凭证须显式包含 `eval:data` 最大权限范围，并校验当前凭证、主体启用状态及身份修订。该范围仅允许进入数据集元数据、版本、用途授权及内容生命周期接口，不直接授予任何数据权限，也不授予 Agent 使用、实验运行或评分权限。每项操作继续与当前部署管理许可或精确版本用途授权取交集；浏览器会话沿相同数据授权边界。现有 `agent:create/manage/use/read` 范围不替代 `eval:data`，存量凭证不自动扩权；签发必须显式选择，收窄只能移除既有范围。涉及 Agent 的后续运行仍须独立 Agent 使用权和运行授权。

用途授权由经过当前身份校验的部署批准管理者，经 Core 用例写入 Platform DB，不能由浏览器自报
issuer、Owner、应用责任人或 Worker 服务身份授予。授权记录绑定 `grantId`、授予主体、接收主体
类型/ID、`purpose=eval`、政策身份/revision、数据集及明确版本集合、操作集合、有效期和自身修订。
新版本默认不继承旧版本授权；扩展版本、操作或期限须重新核验授予者的当前范围并提交新修订。
创建数据集的许可只允许在批准范围建立空记录。Core 在批准的创建/导入范围内先分配不可变的 pending
版本 ID，不写入正文；授权管理者据该版本 ID 显式授予操作后，才能上传、读取或使用内容。预留版本
不自动授予创建者内容权限；未获授权、上传失败或过期的 pending 记录按部署政策收敛，不能当作可用版本。

操作分别表示创建数据集、导入/新增版本、读取内容、运行样本、评分、人工复核、查看分析、管理授权
和删除内容，不隐含互相授予。实验、输出、评分与复核必须关联原数据集版本及用途授权，生成派生
对象不会扩大接收者或操作范围。管理授权只可在部署批准的上限内签发/撤销，不允许转授授予权。
授权/撤销命令按主体、操作、幂等键和完整请求摘要绑定，使用期望修订比较并交换；业务变更、outbox
和必要审计同事务提交，冲突及审计失败不能返回成功。

API 读取/写入、Worker 投递样本/评分、受控对象访问及结果提交均检查当前主体、相关 Agent 权限、
政策、授权修订、对象/版本状态和期限。涉及 Agent 的 Owner 管理关系不能替代使用权或数据权限；
应用保持自身主体，不借责任人的许可。事务锁定相关授权/对象修订，投递使用现有 lease/fence 和
执行前授权边界；撤权后不接纳新操作、取消等待工作，并沿现有停止路径处理活跃执行。已经发生的
外部效果不回滚或盲目重放，未确认结果保留 unknown；授权变化后不能提交或展示未获准的正文。

数据集 V1 装配消费 `EvaluationPolicyV1`：政策 revision 在该部署内单调递增，更换 policyId 也不能重置 revision；DB 保存当前政策检查点并拒绝旧实例回退。样本/rubric 的 `startsAt=version_reserved` 明确以版本预留时刻起算，pending 另受 `pendingMs` 限制，确认后使用已绑定内容期限；输出/评分/复核声明 `startsAt=content_created`，由后续用例按实际产生时刻固化。`retainedMetadataFields` 必须显式批准该版本公开的有限元数据字段集合；未知字段或不支持的字段子集视为政策不匹配，不能静默保留被禁止的名称或摘要。`materialApprovals` 由部署批准，逐项绑定 `approvalId`、数据集范围、`synthetic/approved` 类型；实际材料还必须包含已确认的 `redactionRef`。上传 JSON 仅选择 `provenance.approvalId`，不能自报审批结论；该引用必须匹配当前政策及版本所属范围，合成材料同样需要部署批准及精确版本导入授权。

数据 API 路径为 `/api/v2/evaluation/datasets` 及其版本、授权和内容子路径，使用生成 Client。写入携带 `Idempotency-Key`；期望修订冲突返回 409，无当前用途权限返回 404，未配置或当前政策不可读取返回 503。列表及内部授权集合的 V1 支持上限均为 1000，超过上限整体拒绝，不能返回被静默截断的授权结果。API/Worker 的部署模块须使用 `createEvaluationObjectStorageV1` 装配现有 S3 Adapter，固定独立 `eval/` 前缀；普通 FileGrant 存储实例不能接入。对象传输在短事务之外执行，意图和传输截止时间先持久化，提交前用当前 DB 时间再次检查政策、主体、授权和内容有效期。

部署沿用现有私有配置模块：API 的 `apiInput.evaluation` 经 `deployment-entry.ts` 传入生产装配，Worker 的 `workloadInput.evaluation` 经同一启动入口传入既有清理轮询。不新增环境变量或独立服务；省略该配置时 API 返回未配置，不能从 Owner 或普通文件配置推导默认值。API 的 `loadPolicy` 每次读取当前私有政策文件并调用 `parseEvaluationPolicyV1`，不能永久捕获启动快照；政策读取错误使请求失败。两端使用相同政策版本和存储绑定，Worker 只执行 DB 已固化的清理义务，政策失效不撤销清理。

私有配置模块的接线形式如下，文件路径及对象存储参数由部署提供；配置和凭证不写入镜像或 Git：

```typescript
import { readFile } from "node:fs/promises";
import { parseEvaluationPolicyV1 } from "@agent-infra/platform-core";
import { createEvaluationObjectStorageV1 } from "@agent-infra/object-storage";

const settings = JSON.parse(await readFile(privateConfigurationFile, "utf8"));
const loadPolicy = async () =>
  parseEvaluationPolicyV1(JSON.parse(await readFile(settings.policyFile, "utf8")));
await loadPolicy(); // 已声明启用但配置非法时启动失败
const storage = createEvaluationObjectStorageV1(settings.objectStorage);
// API 私有 configuration.mjs：
apiInput.evaluation = { loadPolicy, storage, close: async () => storage.close() };
// Worker 的独立私有 configuration.mjs 使用相同批准输入：
workloadInput.evaluation = {
  storage,
  batchSize: settings.cleanup.batchSize,
  timeoutMs: settings.cleanup.timeoutMs,
  closeStorage: () => storage.close(),
};
```

Eval 幂等回执的保留截止时间不得晚于相关数据集/版本的元数据期限。到期由 Worker 物理删除整个专属回执，包含主体、摘要和时间字段；不留下无限期可关联墓碑。迟到重试始终重新检查当前版本和授权，过期/已删除版本不能重新导入或恢复正文；空数据集/新 pending 版本仍不授予内容访问权。幂等窗口之后，相同键可受理一个新的空数据集意图，但不能因此复活旧版本或已撤授权。

数据基础模块的 `read` 用例仅校验 `read` 用途。后续实验和评分在该模块的事务/版本/授权边界扩展服务端固定的 `run`、`score`、`review` 或 `analyze` 入口，并与 Execution/fence 绑定；不得借用浏览器 `read` 入口或要求额外授予 `read` 来实现这些独立用途，也不接受客户端自报用途来扩大正文权限。

#### 18.4.2 版本、对象与任务绑定

数据集、样本集合与 rubric 的版本不可变。新版本保存来源版本和必要变更元数据；真实材料导入记录
用途许可及脱敏确认的受控引用，不自动复制线上会话。实验固定基线/候选、同一数据集/rubric 版本、
评分器版本、工具环境声明与原发起主体，分别保留请求配置和每例实际 Execution 事实。

内容使用现有 `ObjectStorageDataV1`，由 Store 保存 Eval 自身的对象引用、版本/etag、大小、Hash、
媒体类型及生命周期状态；写入和确认复用实际字节/固定对象版本核验，不新建存储 Adapter。Eval 对象
采用独立用途和部署前缀，不伪装为普通 attachment/result。普通 `file_access` Grant、会话权限和对象
键不是 Eval 访问依据；API 数据面必须重新解析受信主体及上述用途/对象绑定，临时访问证明还须绑定
该对象版本、读写操作、授权修订和有界期限，且不能在普通文件入口使用。

每个样本任务复用现有 Conversation/Execution/Dispatch，独立 Conversation 默认隔离上下文。Core
受理时将原用户或应用主体、`executionSource=eval`、实验/样本版本、当前用途授权、Agent 授权及
标准模板 Agent 默认 Key 引用/版本与任务/outbox 原子绑定。来源由服务端确定，不把应用 Eval 映射
为 `platform-api`，也不能只增 enum 而绕过现有 task boundary 与 Worker 渠道授权。生产装配须提供
同一 Eval 当前权限复核，缺失时不投递；协议字段增量按 §6.4 发布，Runtime 不保存第二套实验状态。

任务查询、取消、停止及恢复复用原任务 ID、主体和 generation/fence；同一受理意图重放不创建第二个
样本任务。保存输出副本前再次检查 Eval 权限，原任务内容及其引用仍受原权限保护。共用 Conversation
读取、SSE、文件与恢复入口也必须识别 Eval 绑定并检查用途权限，不能通过底层任务入口绕过数据撤销。
自定义 Agent 只接纳已验证的平台任务能力，`self-managed` 不因声明进入本路径；模板对比沿平台批准的
测试配置，不授予 Owner 锁定生产旧镜像的能力。

#### 18.4.3 保留、撤销与删除

保留政策分别定义内容期限和允许留下的元数据期限/字段，实验开始时固化政策身份和应执行的截止时间。
政策变更不能默默延长已绑定的期限；内容访问仍受当前政策更严格的限制。撤权立即停止后续访问，内容
是否随后删除由已绑定政策决定；到期或批准删除先在 DB 标记不可读取并递增对象修订，再由现有 Worker
持久工作项按精确对象引用和版本执行幂等删除。清理读取失败、版本不符或结果未知不能标记已删除，
只能沿原删除意图核实，不删除其他版本或借重试重新获取正文。

删除范围覆盖 Eval 内容、派生输出、评分理由、复核内容及其可访问副本；共享不可变对象须核实全部
受控引用后才可物理回收，任一已删除引用始终不可读。原 Execution 的内容留存独立遵循任务数据政策，
Eval 删除不擅自删除其他业务权威数据；反向引用也不允许重新展示已撤销的 Eval 内容。只保留政策允许的
版本 ID、实际配置引用和有界结果统计，不以摘要、评分理由、任意错误文本或对象下载地址保留已删除正文。
审计按 §18.3 保存必要治理事实，不能复制内容充当长期备份。

#### 18.4.4 评分、复核与分析

评分器登记使用不可变 ID/版本、实现或配置摘要、rubric 版本、结果 Schema、有限评分范围和通过规则。
确定性规则使用固定受控实现，不执行用户上传脚本。人工评分与复核保存各自操作者、依据引用及修订；
复核操作者须有独立 review 权限，结论独立于原评分，不原地覆盖或冒充其他人的判断。

模型评分还须匹配部署批准的精确 endpoint/model、数据集用途范围、允许发送的内容类别、单次输入/输出
大小和 deadline。API/Worker 只引用获准评分器，调用方不能指定 URL、认证 Header 或任意评分端点。
评分工作项开始时按 §10.7 冻结该 Agent 默认 Key 引用/版本；协议、当前数据投递许可与 Key 任一不可确认
则评分失败，不回退个人 Key。经过原模型传输安全边界验证响应，再按固定结果 Schema、范围和大小校验；
模型文本不能建立授权、触发工具或成为新的业务任务指令。评分依据和理由作为 Eval 内容保存，日志/审计
只保留评分器、对象引用、版本和受限结果码。

样本业务任务和评分是不同持久工作项。评分键绑定实验/样本、实际 Execution 结果版本、rubric 和评分器
版本；有限重试沿同一评分意图并在每次发送前重验权限，绝不重新提交样本业务任务。新评分器或 rubric
产生新评分记录，历史结论按当前权限回看。业务失败、评分故障、未评分和不适用分开保存；确定性/人工/
模型结果的聚合遵循固定 rubric，不用错误或缺失充当零分、成功或同条件排名。

反馈沿原任务提交主体校验，仅允许本人任务的有用/无用和受控问题分类；汇总绑定实际模型、配置和时间，
Owner 可看获准汇总但不能下钻他人原会话。实验分析以固定样本集合为分母，同时返回可比较、已评分、缺失、
错误与不适用数量；实际耗时/用量缺失明确标记。线上反馈率的分母是当前查询范围内、按任务终态时间落入
所选窗口并匹配实际模型/配置的可反馈任务数；分子是这些任务中有有效主动反馈的去重任务数。同一任务
更新反馈不增加任务数，未反馈数量单列；本人的查询仅计本人任务，Owner 汇总须获相应汇总权限。筛选、
窗口和分母随结果返回，不从反馈记录数反推总任务量；线上统计不并入离线实验通过率。

#### 18.4.5 实现交接与验证

开发分工按以下依赖交接；各模块仍在现有部署单元内。Contracts/API/Web 的公共入口、migration 顺序和
共享装配文件由本轮指定的单一 writer 统一接收，不允许各 lane 建立平行协议或授权事实源。

| 交付范围 | 前置与验证终点 |
| --- | --- |
| 数据与用途权限 | 先交付当前政策/授权 Port、不可变版本、独立对象及删除义务；真实 PG 与同一 S3 Adapter 验证跨用途/主体、撤权/删除竞态及审计失败回滚 |
| 实验与任务接线 | 消费数据权限/版本；以原用户和应用实际受理、投递、取消及恢复，证明 eval 来源、默认 Key 固定和幂等，不只验证枚举 |
| 评分与复核 | 消费已绑定的真实样本结果；规则/人工/模型评分及独立复核可查询，评分失败重试不重复业务 Execution |
| 分析与反馈 | 消费实际版本/评分/执行事实；验证分母、缺失、错误、不可比数据，以及本人反馈和独立反馈率 |
| 协议与页面 | 生成 Client、正式 HTTP 与现有 Eval 页面贯通上述用途；审计消费者验证元数据而非正文，跨主体、恶意游标、撤权与故障均有负例 |

文档与受控回归完成不等于 Eval 完整交付。正式验收仍须对四个标准模板运行获授权固定集中的回答与
受控工具样本，以两组模型/配置完成实验、三类评分/复核及新版本再跑，记录准确源码、镜像、实际版本、
命令、结果和限制。任一 lane 或真实矩阵缺失均保留为未完成，不用反馈功能、Fake 分数或空态页面代签。

## 19. 测试策略

### 19.1 模块测试

- `platform-core` 使用 Fake Port 验证状态机、权限交集、授权扩展、用例级事务和幂等，不依赖 Hono、Drizzle 或 Kubernetes。
- React 使用 Vitest 与 Testing Library 验证关键交互和错误状态。
- 不以大量 Hono 路由快照代替领域测试。

### 19.2 契约测试

- Contract 测试执行 [Contract Schema authority](#64-contract-schema-authority) 定义的单向生成、漂移、merge-base breaking-change、consumer contract 和发布边界；数据库/领域类型不能绕过映射直接成为 wire contract。
- IdentityAdapter、企微目录快照、ImageRegistryAdapter、ModelCatalogAdapter、部署加密公钥/Worker-only 解密 keyring 和 KubernetesRuntimeAdapter 运行同一 Interface 的 Fake 与部署实现 conformance；缺失、非法或不可用结果都验证 fail closed。
- 第一方 LDAP 登录验证唯一 UID、密码 bind、当前 active 状态、TLS、会话与 Helm 管理员 UID 精确匹配；IdentityAdapter 负向测试覆盖签发方、audience、签发/过期时间、context ID、keyVersion、部署身份绑定和重放。企微目录测试覆盖完整快照原子发布、过期、邮箱缺失/重复、账号停用、LDAP 与企微映射不一致和管理员立即禁用；调用方字段、旧快照或身份依赖不可用都不能形成授权。Connection 会话和角色不被 Platform 继承。
- Platform Secret 负向测试覆盖 API 进程无解密私钥、非 CSPRNG/错误长度、重用 DEK/nonce、DEK fingerprint 冲突、失败重试复用加密材料、非 canonical AAD、跨 Agent/Secret ID 调换 ciphertext 或 wrapped DEK、错误 `wrappingAlgorithmVersion`/`wrappingKeyVersion`、AEAD 认证失败、原地更新被引用的 Kubernetes Secret、候选 Workload 引用错误版本化名称、Worker 在创建 Kubernetes Secret 前后或观测 Workload 前后崩溃，以及 Agent/Secret/config revision/Workload UID/generation/fence 任一 stale 值试图激活候选版本；任何路径都不能泄露明文、改变旧 Workload 的 active Secret、错误提升 active 或提前回收旧版本。
- Model Contract 负向测试覆盖目录外 Base URL、Relay Key 被当普通字段读取/返回、个人与 Agent 默认 Key 跨主体/Agent/Execution/渠道用途复用、旧 V2/V3 静态 Key 接纳新执行、模型或 reasoning 未获 Owner 允许，以及 Runtime capability 验证失败；浏览器与普通使用者响应中不得出现 Key 或 Secret 明文。`/v1/models` 可见不算真实调用成功。
- Agent Runtime Contract 和 Conformance Suite 实现 [Agent Runtime M1 HLD 验证矩阵](HLD-agent-runtime-M1.md#11-验证)，工程 Spec 不重复维护用例清单。
- Agent 配置契约验证标准模板拒绝 Registry 未声明的 env/Secret、Owner 输入不能覆盖平台模型配置、自定义镜像接受非保留前缀的任意 K/V。
- OpenConnector Adapter 运行固定来源、三项 GitHub Action、OAuth scope、repository allowlist、凭证隐藏和跨 scope 拒绝测试。
- 用户/应用 API 契约覆盖可信主体、凭证范围/失效、独立初始授权、创建受理后部署失败仍可管理、跨主体及 Owner/责任人越权拒绝、仅有凭证管理权时签发/轮换/交付不能取得应用凭证、SSE 撤权关闭；Runtime Grant 或 workload 身份不能充当 Connection 凭据。
- 直连关联契约验证真实调用与原执行的绑定、伪造关联拒绝和两侧独立查询权限；覆盖同一主体/Agent 下不同任务的真实调用引用调换、响应丢失与核实重试，不以相同调用方字符串或可转交的真实引用证明关联。
- Connection 的直连身份、Grant、外部执行、幂等/未知结果、撤销和审计测试由其 HLD 验证矩阵维护；未知写操作不得自动重发。

### 19.3 集成测试

- PostgreSQL 与对象存储使用容器化真实依赖。
- Conversation、Execution、outbox、双 Worker 和 Pod 重启的集成与故障注入测试执行 [Agent Runtime M1 HLD 验证矩阵](HLD-agent-runtime-M1.md#11-验证)。
- Kubernetes `kind` 测试覆盖创建失败后无可路由入口、运行中 Workload 或遗留新 PVC，自有入口与独立验证 Workload 停止或停用后 StatefulSet 缩容到 0、重启后从 0 恢复且保留原 PVC 与 Platform DB 状态，候选 Service/健康检查变更，候选提升任一步骤的 Worker 重启和部分切换恢复，升级失败后恢复旧 Digest、路由、渠道和平台历史，切换期间不出现双路由或失败候选继续接收流量，原 PVC 复用，以及第 17 节的安全与网络边界。自有交互入口的两种身份责任选择分别只产生一条用户路由；切换并重新调谐后旧路由被删除，Agent Service、Pod 地址和未选入口均不可达。Pod 重启和 Session 恢复执行 [Agent Runtime M1 HLD 验证矩阵](HLD-agent-runtime-M1.md#11-验证)。
- Session Sandbox 的 `kind` 验证覆盖 §10.1.1 六类实际资源及使用时的 StatefulSet 身份与控制关系；未使用 StatefulSet 时不得要求或合成其 receipt。覆盖逐资源 UID/resourceVersion 漂移、旧 resourceFence、同名外部对象、停止删除前置条件与 absence 回读、原 PVC 保留、Pod 重建的旧执行源排除与 Store CAS，以及 unknown 保留原身份和占用而不重放业务。
- API 受理事务、同会话串行、双 Worker/取消竞态、等待容量/到期、服务重启与未知结果验证持久状态不丢失；凭证失效任务继续与主体撤权系统取消分别注入故障验证。
- 审计事务失败、执行前意图保存失败、查询故障、Trace 采样/导出失败与事件重放分别验证，不能丢必要审计、伪造成功或重复计数。Eval 评分失败、版本变化、数据撤权/删除与用量缺失使用受控样本验证。
- Identity、OCI Registry、模型端点、对象存储和企微边界提供可控 Fake；Fake 使用与正式 Contract 相同的 Schema，不维护第二套接口。
- GitHub Adapter 使用专用测试账号和唯一受控 private 仓库完成 current-user、repository-read 和 create-PR；其他 Provider 不进入首个 Pilot。

### 19.4 端到端测试

Playwright 覆盖：

- 申请、撤回、审批、创建、停止、重启和停用。
- Owner、范围、每日完整企微目录快照及账号禁用；组织变化按最新快照生效且最多延迟一天，LDAP 停用与管理员禁用立即生效。平台对话页、平台托管渠道和平台身份入口须按当前结果撤权，确认撤权后平台中止仍可中止的活跃 Execution。
- 四个标准模板分别用真实镜像、Driver、Relay 模型链路验证就绪和可申请状态，再验证平台 Web、API 真实任务、企微、模型切换、附件、独立 Connection 和长任务恢复；逐一验证实际模型/工具事件和完整 Trace，不以总任务耗时冒充模型耗时。
- 标准模板用两名使用者的不同个人 Key 及 Agent 默认 Key 验证 Web/企微、API、Eval 的费用主体；覆盖 Key 缺失、过期、额度不足不回退，模型可见但无权调用，Key 替换后旧执行固定原版本、新执行使用新版本，Relay 撤销、Worker/Pod 重启恢复及跨用户/Agent/Execution 负向隔离。
- 用户和应用分别 API 创建/启动/停止/重启、提交/查询/订阅/取消任务；无审批且初始授权和 Owner 归属正确，应用不继承责任人权限。审计 API 与基础管理页按条件查询，跨主体和两侧管理员越权拒绝。
- 同一获授权固定集含回答和受控工具样本，以两组模型或配置真实运行；查看汇总/失败样本、规则/人工/模型评分与独立复核，修订后再跑并保留历史。线上反馈独立汇总，评分失败/缺失不算通过，Eval 内容及真实材料用途授权有负向验证。
- 受控的自有身份样例验证匿名、伪造身份字段或在 Owner 身份体系中无权限的请求被 Agent 服务端拒绝，合法身份只能按该体系的权限使用；该入口不获得平台身份或撤权上下文。自有交互入口经平台 Auth Gateway 访问时不能绕过权限，调用方身份 Header 不能改变最终签名身份，缺失、签名无效或过期的上下文、错误签发者、错误受众和错误 Agent 绑定均被拒绝，且两类入口的历史都不进入平台。
- Generic ACP 自定义 Agent 的平台入口、capability、Runtime 模型选项读取与选择转发，以及创建拒绝路径；`self-managed` 的 capability 声明不能开放平台能力，Adapter 不从 Runtime 模型选项读取或保存凭证，平台只按 10.6 把 Owner env/Secret 作为不透明配置保存和注入，选项失效时不能静默改用其他模型。
- Connection 独立 Web 的 LDAP 登录、GitHub OAuth、Grant 再确认、三项 Action、调用记录、管理员未知结果处理、换账号和撤销。
- Alice/Bob 分别绑定专用 GitHub 账号；跨主体、客户端、Connection、Credential、OAuth transaction 和调用记录访问按资源不存在拒绝。
- 企微身份映射、群聊和线程按发送者隔离 Platform Conversation/Runtime Session、按发送者使用 Connection，以及其他发送者不能向活跃 Turn 追加补充指令。
- 执行中消息按 §12.5 与 §14.2.4 验证：Web 与企微在补充指令 capability 为真、为假两种 Runtime 下的补充、排队与繁忙；入队、位次变化、开始处理、撤回（Web）、排队超时和取消的提示；停止、待核实、重启、撤权和会话不可用后排队消息的收敛；企微先图后文合并、同一会话保序、流式进度、超时定稿，以及失败提示在复核依赖暂时不可用时仍在有效期内送达。

### 19.5 负载与故障测试

M1 不承诺固定并发数，但发布前必须提供可重复的负载脚本，逐步增加：并发 Web/API 主体、同一 Agent 的多 Conversation/任务、SSE 连接、Eval 工作项和 Connection 调用。验收要求是消息有明确状态、不静默丢失、用户数据不串线，等待和投递有界、采集故障可见、持续积压有告警，并获得当前环境的容量基线。

## 20. 前后端职责

| 领域 | 前端交付 | 后端交付 |
| --- | --- | --- |
| 身份与权限 | LDAP 登录态、Owner/范围、个人 Relay Key 与 API 凭证管理 | 第一方 LDAP Adapter、独立企微目录快照、管理员禁用、可信用户/应用上下文与当前授权交集 |
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

依赖和镜像漏洞发现使用 GitHub repository security alerts 及其维护的依赖图，不在仓库 CI 中复制一套 Trivy 扫描、漏洞库快照、例外审批或漏洞判定门禁。GitHub 安全告警负责报告已知依赖风险；依赖升级 PR、风险处置和安全设置由仓库维护者管理。

CI 仍验证构建出的镜像、不可变 image ID、Runtime probe、Web smoke、Custom Base Image inheritance 及其他产品契约。上述构建和运行验证不等同于漏洞扫描，也不因 GitHub Advisory 数据库更新而失败。依赖和镜像漏洞的修复、风险接受及生产发布审批沿用仓库外部安全流程；不得把普通 CI 通过表述为漏洞已修复。

### 21.2 发布

- 每个部署单元生成独立镜像并推送部署批准的 OCI Registry；`connection-web` 与 `connection-api` 分别构建，但通过同一批准 origin 路由。
- 镜像按 Commit SHA 和不可变 Digest 部署。
- Web 和 `platform-api` 可以由部署环境独立发布；Helm 管理 Kubernetes 中的平台部署单元，Agent Workload 只由 `platform-worker` 通过 KubernetesRuntimeAdapter 调谐。
- 数据库迁移使用独立 Job，先执行向后兼容迁移，再发布应用。
- 环境配置只保存非敏感值；部署向 `platform-api` 注入版本化加密公钥、向 `platform-worker` 注入 Worker-only 解密 keyring，Secret 明文和私钥不进入 values、镜像或仓库。
- Helm 的 in-cluster API 通过 API-only Secret references 只读交付私有配置模块及同目录辅助文件、独立代理令牌和可选受信 CA；第一方入口的必要引用缺失时拒绝渲染。API 不因此获得 Kubernetes API 权限或 Worker 解密材料；外置 API 由其部署方提供同一文件契约。

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
5. **渠道、自定义 Agent 与 Builder：** 企微 Channel、Runtime Manifest、自有交互入口 Auth Gateway、Connection 授权的 Builder、受限多服务资源准入和 ACK 可部署性验证。
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
   四个标准模板还须分别有真实镜像、Driver 与 Relay 模型链路证据；未就绪项显示原因且不可申请。标准模板 Key 按 Web/企微个人、API/Eval Agent 默认用途和受理版本隔离，不能从旧 Pod 静态凭证恢复。
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
16. Builder 仅通过现有对话式 Web 和 Connection 授权工作；仓库已有 CI 或用户自己的流程提供镜像，平台按不可变 Digest 和受限多服务资源描述准入。平台固定入口、NetworkPolicy、规格档位和服务端资源身份；不支持的资源、核心能力缺失或证据不足时拒绝发布，真实资源和就绪检查通过后才能宣称验收。

## 25. 评审结论记录

团队评审应围绕以下已选方案提出异议或确认，不在同一轮扩展 Roadmap 范围：

- 全 TypeScript 是否满足平台与运维团队的长期维护能力。
- TypeScript Kubernetes 调谐器的测试与值班责任是否可接受，部署是否提供受支持的现代 Kubernetes capability baseline。
- OpenConnector 固定 allowlist Kernel 的维护归属、来源验证和必要时建立最小 Fork 的批准方式。
- 部署的 IdentityAdapter、ImageRegistryAdapter、ModelCatalogAdapter、对象存储、加密公钥/Worker-only 解密 keyring 注入和企微 Adapter 是否满足本文 conformance。
- Codex 采用官方 upstream release provenance；普通官方路径不强制假设私有 vendor barrier。Sandbox 内原生工具与部署批准的原生出网按 [§10.14](#1014-标准模板-session-sandbox-原生工具) 默认启用，执行前屏障只用于平台中介调用（[ADR-0031](../adr/0031-enable-native-tools-inside-session-sandbox.md)）。需要私有 FD callback、Connection bootstrap/recovery 或等价 native lane 时，必须有不可关闭且可回读的 barrier，并在缺失时 fail closed；不恢复第三方源码补丁、vendor builder、派生二进制或下载编译流程。该纠偏以 [#678](https://github.com/AgoraIO-Extensions/agent-infra/issues/678) 的已确认架构方向为依据，具体实现仍须走独立评审。
- Runtime callback/client 的准备契约与真实 Connection 接入按 [§13.2](#132-调用与审计关联) 分别验收；不得以准备层通过替代 Connection HLD 的独立授权门禁。

产品行为或 M1 范围变化先更新 PRD。任何改变部署单元、权威数据归属、身份传递、Secret 模型、Kubernetes Workload Plane、Connection 授权、RuntimeHost 或 Agent Runtime Contract 的修改先更新工程 Spec；同时满足难以逆转、存在真实权衡、未来读者会疑惑时新增 ADR。OpenAPI/SSE breaking change 必须版本化并通过兼容评审。数据库表、索引、UI 结构和 Adapter 内部算法通过普通 Issue/PR、migration 与测试演进，不默认创建 ADR。
