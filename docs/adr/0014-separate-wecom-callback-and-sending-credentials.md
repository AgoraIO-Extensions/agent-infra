# 隔离企微回调与发送凭证

Owner 自助配置自建应用时，原先依赖部署逐应用注入回调材料的方式无法完成闭环。
平台保存回调专用密文，由 API 的独立 keyring 解密；应用发送 Secret 仍仅由 Worker 解密。
配置与激活规则完整定义在[工程 Spec §14.2.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1421-配置与凭证)。

该选择保持 Platform DB 的配置权威与原 Agent 配置事务，增加 API 回调密钥的部署、轮换与引用检查责任。
它不增加服务或 API–Worker RPC，也不改变 Connection 和 Runtime 的凭证权限。
已有部署解析器仅保留旧绑定读取能力，新配置不依赖运维预先注入单个应用凭证。
