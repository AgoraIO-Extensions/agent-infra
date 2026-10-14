# 公司 OAuth 身份探测与登录迁移分离

为取得登录迁移所需的真实身份字段证据，Connection 先提供管理员受监督的公司 OAuth
身份探测，使用已注册的公网 callback。该阶段复用既有浏览器会话与 PostgreSQL 单次消费，
不创建或合并 Principal，不签发 PAT/MCP token，不改变 LDAP 认证或 Grant。
具体约束由 [HLD 身份探测](../architecture/HLD-connection-M1.md#公司-oauth-身份探测) 定义。

该边界对应 [#2279](https://github.com/AgoraIO-Extensions/agent-infra/issues/2279) 的受监督
实现与上海部署授权。身份字段吻合只形成诊断证据，不授予权限。
[#2256](https://github.com/AgoraIO-Extensions/agent-infra/issues/2256) 现按
[入口准入与 LDAP 身份分离](0003-company-oauth-gate-with-ldap-identity.md) 实施，不迁移身份，
也不因启用 HCI 而启用本探测。
