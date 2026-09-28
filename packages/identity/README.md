# 第一方 LDAP 身份 Adapter

产品行为见 [Agent 平台 M1 PRD](../../docs/prd/PRD-agent-platform-M1.md)，身份边界与部署要求见 [M1 工程架构 Spec](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md)。本模块只实现该边界；真实 active-state 字段、查询时效、责任人与受控主体仍由 #388 确认。

`createLdapIdentityDirectory` 的部署输入包括 LDAPS 地址、issuer、员工条目/稳定 UID/邮箱/状态属性、状态解析函数、管理员 UID 集合和 `identityIds`。配置错误、查询歧义、身份映射故障都会抛出 `LDAP_IDENTITY_UNAVAILABLE`。部署方必须在 #388 核实后提供状态解析函数；当前测试 fixture 不是实际 LDAP 配置。

`identityIds` 由 #481 在 Platform DB 持久实现，以 `issuer + UID` 唯一定位用户，并以随机 UUID v4 作为稳定、不透明且全局唯一的 Platform `userId`。`getOrCreate` 原子保存新键与 Adapter 提供的候选 ID；已有键返回原 ID。`findByUid` 与 `findUidByUserId` 须相互一致。Adapter 只在密码 bind 和二次账号/邮箱检查通过后创建映射；现有会话的预检查只读取映射。此前可解码的 `ldap_...` ID 格式不能用于正式授权记录。

`createLdapBrowserAdapter` 在 #504 的正式 Platform API 装配中需要当前 Platform 禁用查询、#889 快照的组织映射，以及跨 API 副本共享的持久 `LdapSessionStore`。Store 的 `create`、`find`、`revoke` 和 `revokeUid` 必须强制到期与跨副本撤销，并在故障时抛错。`userIdForUid` 在 LDAP 查询前从持久映射读取 Platform ID，供禁用检查使用。正式 `/auth/login` 与 `/auth/logout` 的 JSON/POST 契约见 [Platform Auth OpenAPI](../contracts/artifacts/openapi/platform-auth.v1.openapi.json)；#192 负责 Web 登录页和 POST 登出动作，#504 负责路由、Store 与 Adapter 装配。

当前受控测试覆盖模块协议和拒绝路径；真实 LDAP、两名员工、管理员、停用账号、跨副本会话撤销和正式 Web/API 流程仍需分别验证。Connection 保持独立身份边界。
