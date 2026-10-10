# Platform API 部署模块

本地 Compose 从镜像内加载[部署模块](../../apps/platform-api/src/deployment-entry.ts) 编译成的
`deployment.mjs`，并只读挂载 API 专属
`configuration.mjs` 到 `/app/deployment`。内置模块创建第一方 LDAP 目录、
PostgreSQL 浏览器会话和生产 Platform API 装配；私有配置由部署者提供当前受信事实，
不得放入镜像或 Git。

Compose 固定 `PLATFORM_API_CONFIGURATION_MODULE=file:///app/deployment/configuration.mjs`
和 `PLATFORM_API_PROXY_TOKEN_FILE=/run/secrets/platform_proxy_token`；模块只接受本地
文件 URL 和绝对令牌路径。`configuration.mjs` 必须导出：

| 导出 | 契约 |
| --- | --- |
| `ldap` | [`LdapIdentityConfiguration`](../../packages/identity/src/ldap.ts)，含实际 LDAP（`tls: true` 默认使用 LDAPS，`tls: false` 使用 LDAP，见工程 Spec §9.1）、受控 `verifyCurrentStatus` 和持久 issuer/UID 映射；无需专用 active 属性 |
| `isPlatformDisabled` | 查询当前 Platform PostgreSQL 用户停用状态的函数；依赖不可用时抛错，不能返回默认 `false` |
| `organizationIds` | 从 #889 当前目录快照解析完整组织映射的函数；不可用时抛错 |
| `directorySnapshot` | 可选的通用快照 consumer：`{ endpoint, token, organizationIdForDepartment }`。配置后每次敏感身份解析从 HTTPS 当前快照按 LDAP email 唯一匹配 active 成员，并映射组织 ID；失败不得回退到旧 `organizationIds`。快照 revision/fetchedAt/validUntil 已由 consumer 校验，但现有 LDAP identity wire 尚未携带 sidecar，跨 #481/#508/#440 的不可变版本绑定仍需后续契约接收。 |
| `publicOrigin` | 与本地 HTTPS Web 相同的精确 Origin |
| `apiInput` | [`ProductionPlatformApiInputV1`](../../apps/platform-api/src/deployment.ts) 中除 `databaseUrl`、`identity` 外的真实 Registry、模板、ModelCatalog、密钥公钥、准入和展示依赖 |
| `directorySearch` | 查询当前用户和组织目录记录的函数，返回 canonical ID、可读名称及邮箱或组织路径；依赖不可用时抛错 |

`apiInput.taskAdmissionPolicy` 必须由真实部署配置显式提供。`maximumWaitingTasksPerAgent`
是每个 Agent 的等待任务容量（单位：任务），`waitingTimeoutMs` 是等待期限（单位：毫秒）；
两者均为正安全整数。平台不提供隐含生产默认值；缺失或无效时启动失败。
测试 fixture 中的受控数值仅用于测试，不是生产建议值，也不能通过关闭 Task 路由绕过配置。

内置模块从 `PLATFORM_DATABASE_URL` 取数据库 URL，从上述 Secret 文件读取高熵
代理令牌，并覆盖 `apiInput` 中的
数据库和身份字段。缺失或无效配置启动失败。API 不接收 Worker 解密私钥、
Kubernetes 凭证或模型原始凭据。issuer/UID 映射由 `@agent-infra/platform-store` 的 `PostgresLdapIdentityIds` 提供，使用同一 Platform 数据库 URL；正式迁移自动创建映射表，首次成功 LDAP 认证时原子分配随机平台 ID，部署方无需手工录入 UID 对应表。`isPlatformDisabled` 查询现有 `platform_user_disables` 表。示例固定值、内存映射和历史 Authentik proof 不能作为真实身份验收。

启动和验收入口见[本地生命周期](../local/README.md)。镜像内模块可加载、
代理令牌正确与否及 PostgreSQL 会话装配属于部署证据；实际 LDAP 登录、
停用传播、申请审批、Worker Pod/PVC、模型访问和重启持久化须单独实测。

## 应用 Token 管理 Agent

机器人或服务复用独立应用及其 API Token；同一应用可获得多个 Agent 的显式授权。
个人 Token 继续使用用户主体。两种主体的同名 ID、幂等记录和审计归属分别处理。

| 操作 | HTTP 入口 | 当前权限 |
| --- | --- | --- |
| 授予、撤销应用管理权限 | `PUT` / `DELETE /api/v2/agents/{agentId}/application-managers/{applicationId}` | 当前有效的 Agent Owner 浏览器会话；责任人或管理员身份不替代 Owner |
| 授予、撤销应用使用权限 | `PUT` / `DELETE /api/v2/agents/{agentId}/application-use-grants/{applicationId}` | 当前有效的 Agent Owner 浏览器会话；与 manage 独立 |
| 查询 Agent 状态 | `GET /api/v2/agents/{agentId}/state` | Token 的 `agent:read` 范围与该主体当前 manage/use 授权 |
| 启动、停止、重启 | `POST /api/v2/agents/{agentId}/commands` | Token 的 `agent:manage` 范围与该主体当前 manage 授权 |

授予、撤销的请求体为 `{"schemaVersion":1}`。生命周期请求体为
`{"schemaVersion":1,"command":"start"}`，`command` 也可为 `stop` 或 `restart`。
写入操作均需 `Idempotency-Key`；重试仍复核当前权限，撤权后的旧请求不能恢复权限。
`start` 只接受已停止 Agent；管理员停用的 Agent 不可通过这些命令恢复。

调用接口使用 `Authorization: Bearer <API Token>`，不混用浏览器 Cookie 或自报身份字段。
Owner 治理入口分别修改应用 manage 或 use 授权，撤销一项不隐式撤销另一项，也不授予应用凭证材料权限。两项授权使用不同幂等命名空间；use 变更由原任务当前授权读取链路消费，不另建授权事实或取消状态机。凭证材料继续按
[工程 Spec §9.2](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#92-权限顺序)
独立处理。Token 范围、到期、撤销及当前主体状态在原管理事务内复核，状态、outbox、
幂等与必要审计共同提交。HTTP 返回管理状态，不等同于 Workload 已就绪。
