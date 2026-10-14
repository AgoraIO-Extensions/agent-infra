# 上海普通公司 OAuth 入口接受共享 callback 日志风险

2026-10-14，项目操作者明确接受共享网关记录 OAuth callback 授权材料的已知风险，要求
上海普通公司 OAuth 入口不再等待网关脱敏后才开展真实登录。此决定由
[#2455](https://github.com/AgoraIO-Extensions/agent-infra/issues/2455) 跟踪，补充
[ADR 0004](0004-direct-company-oauth-entrance.md)，不代表安全团队或共享网关维护者批准。

例外的精确 origin/client/callback、残余风险、持续约束、整改和重新评审条件统一定义于
[HLD 日志风险接受](../architecture/HLD-connection-M1.md#上海普通公司-oauth-入口日志风险接受)。
这不是日志验收通过，也不放宽 LDAP 业务身份、机器消费者协议、真实登录或正式发布门禁。
