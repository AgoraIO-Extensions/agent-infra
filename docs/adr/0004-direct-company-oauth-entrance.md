# 公司 OAuth 由 Connection 直接完成入口准入

为减少对 HCI 集成的依赖，Connection 直接完成公司 OAuth authorization-code 流程，再保留
LDAP 登录作为唯一业务身份；账号可以不同，既有连接、Grant、PAT、管理员和目录不迁移。
本决策替代 [ADR 0003](0003-company-oauth-gate-with-ldap-identity.md) 的 HCI 入口选择，
不替代其中的 LDAP 业务身份边界。

产品方向由 [#2256](https://github.com/AgoraIO-Extensions/agent-infra/issues/2256) 跟踪。
技术与启用条件统一见 [HLD](../architecture/HLD-connection-M1.md#直接公司-oauth-入口)。
callback 地址被接受不等同于完整登录通过；共享入口日志保护、真实公司字段契约及完整验收
尚未完成时不启用。取消 HCI 不解除这些直接 OAuth 的独立条件。
