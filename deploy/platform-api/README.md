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
| `publicOrigin` | 与本地 HTTPS Web 相同的精确 Origin |
| `apiInput` | [`ProductionPlatformApiInputV1`](../../apps/platform-api/src/deployment.ts) 中除 `databaseUrl`、`identity` 外的真实 Registry、模板、ModelCatalog、密钥公钥、准入和展示依赖 |

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
