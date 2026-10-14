# 公司 OAuth 入口准入与 LDAP 业务身份分离

公司 OAuth 由 HCI Auth 保护具名交互入口，Connection 保留 LDAP 登录和目录，仍以 LDAP
issuer + uid 识别业务 Principal。允许入口账号与 LDAP 账号不同；不绑定二者，不迁移或删除
已有连接、授权、PAT 或管理员角色。HCI 的身份和权限不产生 Connection 权限。

该产品和身份边界已确认，由 [#2256](https://github.com/AgoraIO-Extensions/agent-infra/issues/2256)
跟踪；HCI 生产启用仍需域名白名单、网关和真实双登录验收。具体路由及门禁由
[HLD](../architecture/HLD-connection-M1.md#公司-oauthhci-入口与-ldap-身份分离) 定义。
原 [LDAP ADR](ADR-connection-account-ldap.md) 继续适用，不启用公司 OAuth 独立身份探测或新账号。

这避免了旧身份映射和数据迁移，但意味着入口身份只证明准入，业务操作与审计属于 LDAP 账号；
两次登录不构成同一员工的双因素认证。两种会话分别退出和过期，机器协议维持原有凭据。
