# Connection 作为 Rehoboam AI 发版主入口

用户选择由 Connection 向 Codex 等 Direct MCP Client 分发发布族能力，客户端承担对话、分析和编排；Rehoboam 网页及企微是辅助入口。Connection 拥有账号、授权、ActionCall 和凭证隔离，Rehoboam 继续拥有发布族、模板、参数、审批、Job 与业务审计，所有客户端调用同一套业务服务。

新 ProviderRelease 不扩大旧 Grant。新增 Actions 在 Rehoboam 接口部署和真实 READ 验证后发布，用户显式升级/授权后可见；Provider 不接收调用方身份、任意 URL、Header 或凭证选择。

独立模板（如 RN RTM）不强制创建 Native 发布族。独立版本使用普通模板发现、持久化预览、显式确认三步，
确认参数及模板签名由 Rehoboam 持有；客户端不能修改已确认参数或提供操作者。创建不启动构建、发布、通知或 Jira 流转。
Connection 仅封装固定接口、权限和幂等调用，不拥有版本创建规则。Provider profile 与门禁以
[Connection HLD](../architecture/HLD-connection-M1.md) 为准。
