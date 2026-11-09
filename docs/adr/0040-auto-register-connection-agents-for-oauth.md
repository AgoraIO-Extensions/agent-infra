# 创建 Agent 时自动登记 Connection，并独立完成用户 OAuth

## 状态

产品与工程合同修订候选，primary 为
[#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851)。
须经 Platform API/Web、Runtime 与 Connection 契约原 owner 共同评审，按既有门禁合入后再实施。
文档不批准机器权限、真实 Token 启用或未发布服务接口，也不接管 Connection 原实现及 tickets。

## 问题

Platform Agent 的长期 Consumer 关联与用户 OAuth 安装属于不同生命周期。只配置 MCP endpoint、
登记一个 OAuth client 或取得 PAT，不能保证 WebUI/API 创建的每个 Agent 都有唯一、可恢复的
Connection 对应对象。按 Agent 共用固定 clientId 也无法表达用户和安装隔离。

## 决策

Web 审批通过与 API 正式创建采用相同 Core 登记规则，经原创建事务和既有 outbox 完成
Consumer 登记、回执核实及持久关联。Connection 独立批准受限机器登记身份；本平台只保存
自己的外部关联和交付事实，不复制其 Grant 或凭据权威。实际用户在各自安装中经 OAuth＋PKCE
取得独立凭据，由受保护 Host 直连 MCP，登记不代替本人确认或业务授权。
已核实回执与批准策略提供具名的动态配置来源，完整快照校验及版本字段保持；Consumer 登记
和逐安装 client 登记分别保留原操作及 unknown 核实，避免用新对象掩盖部分成功。

产品行为只在 [Platform PRD §9.1](../prd/PRD-agent-platform-M1.md#91-创建时自动关联与用户-oauth)
维护；完整登记、回执、OAuth 准备及失败合同只在工程 Spec
[§13.5.7](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1357-agent-自动登记与-oauth-安装准备)
维护。本 ADR 不单独覆盖两份 PRD、工程 Spec 或 HLD。

## 取舍与验证

登记采用可恢复的分步交付，代价是 Agent 已创建时外部关联可能仍处于 pending/unknown；
界面和 API 必须明确这一区别，不能通过删除重建掩盖部分成功。稳定外部引用、操作幂等、
精确非秘密回执及原对象修订共同防止重复登记和错绑；命名或时间近似不能替代它们。

机器管理请求与用户 OAuth 分开，使 API 无需浏览器也能触发登记，同时保留用户对外部账号
和能力的独立确认。登记先于 Runtime 准备不表示可读取 Token 或调用工具；实际领取仍须满足
原秘密边界和原执行门禁。既有获准 PAT 路线保留，不成为自动 OAuth 失败的 fallback。

实施须先具名固定实际机器登记/恢复及 Consumer 定向 OAuth 服务合同和生产接收函数，
不以空 helper、browser-admin Cookie、通用 DCR 或测试回执替代。验证覆盖 Web/API、重试与
丢响应、跨用户/Agent/来源、修订和停用；真实 OAuth/MCP/Provider、撤权及 Linux 保护另验。
