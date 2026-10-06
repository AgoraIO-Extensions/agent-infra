# Connection 作为 Rehoboam AI 发版主入口

用户选择由 Connection 向 Codex 等 Direct MCP Client 分发发布族能力，客户端承担对话、分析和编排；Rehoboam 网页及企微是辅助入口。Connection 拥有账号、授权、ActionCall 和凭证隔离，Rehoboam 继续拥有发布族、模板、参数、审批、Job 与业务审计，所有客户端调用同一套业务服务。

新 ProviderRelease 不扩大旧 Grant。新增 Actions 在 Rehoboam 接口部署和真实 READ 验证后发布，用户显式升级/授权后可见；Provider 不接收调用方身份、任意 URL、Header 或凭证选择。
