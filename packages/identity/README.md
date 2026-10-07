# 第一方 LDAP 身份 Adapter

产品行为见 [Agent 平台 M1 PRD](../../docs/prd/PRD-agent-platform-M1.md)，身份边界与部署要求见 [M1 工程架构 Spec](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md)。#388 验证真实 LDAP/Authentik 的 bind、停用传播与已有会话行为；专用 active-state 字段不是前置条件。

`createLdapIdentityDirectory` 的部署输入包括受信 LDAPS 地址、issuer、员工条目/稳定 UID/邮箱属性、管理员 UID 集合和 `identityIds`。新登录搜索唯一条目、完成用户密码 bind，并复核 UID/邮箱后才创建身份映射；用户 bind 拒绝即拒绝登录。LDAP search 条目存在不能证明已有会话仍有效。配置错误、查询歧义、身份映射故障都会抛出 `LDAP_IDENTITY_UNAVAILABLE`。

部署方使用 `current()` 和 `currentByUserId()` 复核既有会话时，须显式注入 `verifyCurrentStatus({ issuer, uid })`，连接受控的当前账号或会话权威。它只可返回已核实的 `active` 或 `disabled`；`null` 表示未知，缺少函数、未知返回、异常或超过 `timeoutMs` 均抛出 `LDAP_IDENTITY_UNAVAILABLE`，不将搜索结果或旧会话推断为 active。复核结果不会缓存。#504 须在每次敏感操作前调用该入口，并与 Platform 禁用记录、#889 有效目录快照共同判定；浏览器会话 Store 的有界空闲和绝对过期策略由 Platform 装配维护，本模块不定义时长。本模块的模拟 verifier 只用于协议测试，真实 LDAP/Authentik 信号及停用时效仍需 #388 受控验证。

`identityIds` 由 #481 在 Platform DB 持久实现，以 `issuer + UID` 唯一定位用户，并以随机 UUID v4 作为稳定、不透明且全局唯一的 Platform `userId`。`getOrCreate` 原子保存新键与 Adapter 提供的候选 ID；已有键返回原 ID。`findByUid` 与 `findUidByUserId` 须相互一致。Adapter 只在密码 bind 和二次账号/邮箱检查通过后创建映射；现有会话的预检查只读取映射。此前可解码的 `ldap_...` ID 格式不能用于正式授权记录。

`createLdapBrowserAdapter` 在 #504 的正式 Platform API 装配中需要当前 Platform 禁用查询、#889 快照的组织映射，以及跨 API 副本共享的持久 `LdapSessionStore`。Store 的 `create`、`find`、`renew`、`revoke` 和 `revokeUid` 必须强制空闲/绝对过期边界与跨副本撤销，并在故障时抛错。`userIdForUid` 在 LDAP 查询前从持久映射读取 Platform ID，供禁用检查使用。正式 `/auth/login` 与 `/auth/logout` 的 JSON/POST 契约见 [Platform Auth OpenAPI](../contracts/artifacts/openapi/platform-auth.v1.openapi.json)；#192 负责 Web 登录页和 POST 登出动作，#504 负责路由、Store 与 Adapter 装配。

当前 focused tests 覆盖模块协议与拒绝路径；真实 LDAP、两名员工、管理员、停用账号、既有会话失效、跨副本会话撤销和正式 Web/API 流程仍需分别验证。Connection 保持独立身份边界。
