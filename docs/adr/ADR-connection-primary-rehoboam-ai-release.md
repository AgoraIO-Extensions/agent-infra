# Connection 作为 Rehoboam AI 发版主入口

用户选择由 Connection 向 Codex 等 Direct MCP Client 分发发布族能力，客户端承担对话、分析和编排；Rehoboam 网页及企微是辅助入口。Connection 拥有账号、授权、ActionCall 和凭证隔离，Rehoboam 继续拥有发布族、模板、参数、审批、Job 与业务审计，所有客户端调用同一套业务服务。

新 ProviderRelease 不扩大旧 Grant。新增 Actions 在 Rehoboam 接口部署和真实 READ 验证后发布，用户显式升级/授权后可见；Provider 不接收调用方身份、任意 URL、Header 或凭证选择。

独立模板（如 RN RTM）不强制创建 Native 发布族。独立版本使用普通模板发现、持久化预览、显式确认三步，
确认参数及模板签名由 Rehoboam 持有；客户端不能修改已确认参数或提供操作者。创建不启动构建、发布、通知或 Jira 流转。
Connection 仅封装固定接口、权限和幂等调用，不拥有版本创建规则。Provider profile 与门禁以
[Connection HLD](../architecture/HLD-connection-M1.md) 为准。

独立版本提测、交付和测试通过使用原业务服务，预览持久化 owner/正文/收件人/模板/Jira 表单快照，
确认通过 durable CAS 与每版本 reservation 只提交一次。未知或部分结果保留回执与 reservation，禁止盲目重发。
reservation 仅串行化 Connection 通知，不声称与旧 Web 入口形成跨渠道原子事务；原服务成功不等于所有渠道送达。
操作顺序见 [独立版本指南](../connection/rehoboam-standalone-release.md)。

用户批准补齐版本与配置管理。v11 新增版本编辑/复制、模板和流水线配置管理、客户及 Native 标记发现、
执行申请重新提交和操作/时间线回查，继续由 Rehoboam 拥有校验、角色、状态和业务效果。
Connection 只映射固定接口，v10 实现不变，v10→v11 必须重新审批，不自动继承新增权限。
所有管理预览为持久化 WRITE；确认绑定 owner/token/期限及资源快照，并通过 CAS 与资源 reservation
防止重复提交。原生完成回执用于响应丢失后的回查；READ 不做对账写入，未知效果不自动重发。
配置不运行表达式、不启动 Job；申请修改明确包含原审批通知/调度副作用。实现批准不等于生产部署批准。
使用说明见 [版本与配置管理](../connection/rehoboam-management.md)。
