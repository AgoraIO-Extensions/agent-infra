# 员工身份与当前权限

AgentInfra 网页登录使用 OIDC，已验证的企微消息与网页会话映射到同一平台员工 ID。
员工身份与组织关系来自当前有效的通用目录快照。每次授权同时校验平台账号禁用状态和适用的 Agent 权限。

`EmployeeIdentityDirectory` 按平台用户 ID 或服务端会话引用查询当前员工。
`resolveEmployeePrincipal` 结合员工状态、平台禁用记录及组织目录生成当前身份上下文。
企微部署使用 `createWecomEmployeeIdentity` 解析受信渠道的发送者，任务执行时通过
`resolveCurrentTaskUserV1` 重验稳定身份与当前权限。

已有账号的迁移和首次登录绑定见[部署说明](../../deploy/local/oidc-identity.md)。
产品要求见 [Agent 平台 M1 PRD](../../docs/prd/PRD-agent-platform-M1.md)，身份契约见[工程 Spec §9.1](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#91-identityadapter)。
