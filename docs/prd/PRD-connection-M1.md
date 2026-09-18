# Connection M1 产品需求

关联文档：[企业级 Agent 平台 M1 产品需求](PRD-agent-platform-M1.md)

## 1. 产品目标

Connection 是与 Agent 平台并行建设的独立系统。员工在 Connection 中登录、连接外部账号、查看可用能力，并把明确选择的能力授权给独立 Consumer。Agent Platform 可以作为一个 Consumer 使用，但不是 Connection 的必经入口、授权权威或状态存储。

首个受监督 Pilot 使用 GitHub，目标是：

1. 两名测试员工分别通过 Connection 中文入口登录并连接专用 GitHub 测试账号。
2. Direct MCP Client 只配置 Connection MCP endpoint，通过 Connection OAuth 登录。
3. 员工明确选择 Connection、Consumer/Actor 和 Action 后再授权。
4. Connection 独立校验当前 Principal、Consumer/Actor、Grant、Action、Provider 和 Credential 状态。
5. Agent、模型、浏览器、Platform 和 MCP Client 均不能获得 Provider 原始凭证。
6. 两名测试员工完成真实读取、创建 Pull Request、幂等、撤权、未知结果和审计闭环。

Pilot 成功只适用于具名环境、测试主体、专用账号、受控 private 仓库和记录的 Consumer 版本，不代表其他 Provider、Consumer 或广泛生产可用。

## 2. 核心概念

| 概念 | 产品含义 |
| --- | --- |
| Principal | Connection 识别的稳定员工主体 |
| Consumer | 使用 Connection MCP/API 的客户端或服务；每种产品独立注册 |
| ConsumerInstance | Consumer 的独立登录实例，可单独撤销 |
| Actor | Consumer 内由 Connection 解析并单独授权的稳定单元 |
| Provider | GitHub 等外部平台 |
| Action | Provider 的一项受控能力 |
| Connection | 已完成外部鉴权、对应稳定外部账号的连接 |
| Grant | Principal 对 Consumer/Actor、Connection 和明确 Action 集合的授权 |
| ActionCall | Connection 接受并持久化的一次调用 |
| Effect | WRITE Action 可能产生的外部副作用 |

Connection 是这些对象的唯一权威。Platform 只保存自身 Agent、Execution、工具事实和经受信采集得到的关联引用。

## 3. 系统边界

### 3.1 Connection 负责

- 独立登录、OAuth Authorization Server、MCP/API endpoint 和管理 Web。
- Principal、Consumer、ConsumerInstance、Actor、Connection Grant 和撤权。
- Provider/Action Catalog、版本、Schema、effect、required scope 和发布状态。
- 外部账号、Credential 加密保护、刷新、撤销和 Provider 执行。
- Action 参数校验、幂等、未知结果对账、调用/效果/审计记录。
- 跨 Principal、Consumer、Instance、Actor 和 Connection 的访问隔离。

### 3.2 Platform 负责

- Agent、Owner、使用范围、任务和自身工具执行事实。
- 作为已注册 Consumer 使用 Connection 的公开 MCP/API；不通过 Platform API 代理调用。
- 在可信运行采集得到时保存 Connection 返回的调用关联引用和核实状态。
- 只在 Platform 自己的 Agent policy 范围内决定是否发起自身任务，不把该 policy 当作 Connection 授权输入。

Platform 不保存 Connection Grant、Provider Credential、Connection Catalog 的可写副本，不签发 Connection 授权证明，不读取 Connection DB，不替 Connection 选择 Principal、Connection、账号或 Credential。

### 3.3 Client/Agent 负责

- 只提交 Action 和 Schema 合法参数。
- 保存 Connection access token 的最小客户端状态，不把 Provider Credential 传给模型或任务输入。
- 仅根据 Connection 返回的脱敏结果继续执行。

## 4. Direct MCP/API 入口

- Direct MCP Client 只配置 Connection MCP endpoint，例如 `https://agent-connector.la3.agoralab.co/mcp`。
- Connection OAuth 使用 Authorization Code + PKCE；OAuth access token 绑定 Principal、Consumer、ConsumerInstance、audience 和 scope。
- Connection PAT 只适用于经过注册和批准的 Consumer，不能替代 OAuth 的主体隔离规则。
- BrowserSession 只用于 Connection Web 管理操作，不能作为 MCP 调用凭据。
- MCP、浏览器管理 API 和内部 HTTP API 共享同一 Connection application service 与授权权威。

## 5. Provider 与 Action

- Connection 是 Provider/Action 的唯一发布来源。
- Catalog 只公开 Provider、不可变 ActionVersion、输入/输出 Schema、effect、required scope 和发布状态；不公开 Principal、Connection、Grant、Credential 或审计。
- 首个 Pilot 只发布三项 GitHub Action：`get_current_user`、`list_my_repositories`、`create_pull_request`。
- 首个 Pilot 只允许一个受控 private 测试仓库；不开放 Issue、Workflow、Release、删除、合并或其他写能力。
- Bitbucket、Jira、Confluence、Outlook 和其他 Provider 不进入首个 GitHub Pilot。
- Consumer 不能扩大 Catalog；ActionVersion 变更必须发布新不可变版本。

## 6. Principal、Consumer 与授权

- Connection 使用部署批准的公司 LDAP 建立 `issuer + stable uid` Principal；邮箱、显示名和登录名只用于展示。
- LDAP 密码不保存、不记录、不进入 Token、Cookie、错误、审计或模型上下文。
- OAuth 客户端注册、ConsumerInstance、token、Grant 和撤销均由 Connection 服务端解析和持久化。
- Grant 始终绑定当前 Principal、Consumer、ConsumerInstance、Connection 和用户确认的精确 ActionVersion 集合；Consumer 定义 Actor 时还必须绑定由 Connection 解析的唯一 Actor，不能以 Actor 取代 ConsumerInstance 绑定。
- Provider OAuth 只建立或更新 Connection，不自动创建 Grant。
- Owner 或 Consumer policy 不能替 Principal 创建、扩大或替换 Grant；能力扩张必须由授权主体在 Connection 中重新确认。
- 拒绝响应不能泄露其他 Principal、Connection、Grant、Credential、调用或审计是否存在。

## 7. 调用、幂等与未知结果

- Connection 在创建 ActionCall 前校验 access token、Principal、ConsumerInstance、Actor、Grant、ActionVersion、ProviderRelease、Credential 和参数 Schema。
- 每次调用保存稳定 `requestId`、`idempotencyKey`、`callId`、ActionVersion、主体绑定、参数摘要、状态和 trace correlation。
- 同一幂等键与同一请求返回原调用；同一幂等键与不同请求拒绝。
- WRITE Action 在访问 Provider 前持久保存 Effect/Dispatch 意图，并重新校验当前 Grant、Credential、Action 和 repository policy。
- 只有能够证明请求未被 Provider 接受的确定性业务或协议拒绝，Connection 才返回脱敏终态失败；超时、连接中断、响应丢失、无法确认提交语义的 `5xx` 或其他可能已提交副作用的响应进入 `RESULT_PENDING/UNCERTAIN`。
- 未知写结果不自动重发；只沿原调用对账，管理员人工处理和最终未知状态均保留审计。

## 8. 凭证与隔离

- Provider Credential 只由 Connection 受控执行路径解密和使用。
- MCP Client、Agent、模型、浏览器、Platform DB、日志、错误和审计不得获得原始 Credential。
- 任何调用方提交的 `principalId`、`consumerId`、`connectionId`、外部账号、Credential selector 或 Platform identity 字段都不是授权依据；服务端从认证上下文和自身状态解析。
- 跨主体、跨 Consumer、跨 Instance、跨 Actor 和跨 Connection 的读取、调用、撤销和审计查询必须 fail closed。

## 9. Web 与审计

Connection 提供独立中文 Web，包含登录、个人 Connection、Consumer/Actor 授权、撤销、调用记录、待人工处理、Provider/Action 管理和审计入口。Platform Web 只能跳转到受控 Connection URL，不能复制这些页面。

Connection 审计回答 Principal、Consumer/Instance、Actor、Connection、ActionCall、Effect、Dispatch、Provider 结果、撤权和人工处理之间的关系。Platform 与 Connection 通过真实调用产生的关联引用关联记录；关联标识本身不授予访问权。

Provider/Action、共享 Connection、审计和未知结果处理属于独立的管理员权限。LDAP 登录只建立 Principal，不自动授予管理员权限；管理员角色必须由部署批准的 bootstrap 配置或已授权管理员在 Connection 中授予，支持单独撤销和审计。Bootstrap 只能由受信部署身份使用一次性高熵凭据触发，服务端原子消费并排除并发重复请求，完成后永久关闭入口；浏览器会话、普通 Principal、Provider 回调和重放请求均不能触发 Bootstrap。每个管理请求由服务端重新校验当前管理员角色、租户范围和资源权限，普通 Principal 的拒绝响应不得泄露管理对象是否存在。

## 10. 首个 GitHub Pilot 验收

| 场景 | 验收结果 |
| --- | --- |
| 测试主体 | 两个 LDAP Principal 分别绑定两个专用 GitHub 测试账号和同一受控 private 仓库 |
| Direct MCP | 客户端只配置 Connection MCP endpoint，OAuth 登录成功并获得当前 ConsumerInstance token |
| 两次确认 | GitHub OAuth 后仍须在 Connection 中确认具体 Consumer/Actor 和三项 Action |
| 真实调用 | 两名测试主体分别读取账号/仓库并创建真实 Pull Request |
| 幂等 | 同一请求重试复用原调用和 PR，不产生第二个 PR |
| 隔离 | 任何主体不能发现或使用其他主体的 Connection、Grant、Credential 或调用记录 |
| 撤权 | 撤销 Grant、断开 Connection、停用 Action 或撤销 Credential 后新调用立即失败 |
| Provider 撤销 | 断开 Connection 或撤销 Credential 时创建可审计的 Provider revoke attempt；失败可重试并保留状态，直至成功或进入明确终态 |
| 未知结果 | 响应丢失进入待确认，只沿原调用对账，不自动重发 |
| Credential 边界 | 原始 Credential 不出现在 Client、Agent、Platform、日志、错误或审计 |
| 真实关联 | Platform 侧若记录关联，必须来自同一次受信执行采集；缺失或无法核实则标记未核实 |

成功声明只允许覆盖上述环境、主体、Consumer、版本、Provider、仓库和任务范围，不代表完整 M1 或广泛生产上线。

## 11. M1 外范围

员工日常账号、GitHub App 细粒度授权、公司共享组织的完整生产范围、其他 Provider 的生产化、容量/灾备/HA/SLO、完整离职权威和广泛 Consumer 兼容性均需独立门禁和验收。
