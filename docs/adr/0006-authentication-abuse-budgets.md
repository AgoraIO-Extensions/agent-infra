# 登录与动态注册使用 PostgreSQL 共享预算

公司 OAuth 不替代 LDAP 密码登录，也不能要求机器客户端先取得公司入口 Cookie。
[#2472](https://github.com/AgoraIO-Extensions/agent-infra/issues/2472) 因此采用现有 OAuth domain
与 PostgreSQL repository 的原子共享预算保护认证和 DCR，不新增缓存服务或依赖。

具体阈值、HMAC 隐私边界、动态注册来源分类和保护性清理统一见
[HLD](../architecture/HLD-connection-M1.md#登录与动态注册防滥用)。完整管理 API 文档改为
登录后访问，机器协议与精确令牌所属会话撤销保持原有边界。历史注册来源不可靠，迁移按
TRUSTED 保留；本次不追溯清理现有客户端，也不把测试通过等同于安全团队线上复测完成。
