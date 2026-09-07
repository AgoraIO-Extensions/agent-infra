# Connection M1 产品需求

关联文档：[企业级 Agent 平台 M1 产品需求](PRD-agent-platform-M1.md)

## 1. 产品目标

Connection 是与 Agent 平台并行建设的独立系统。它让员工连接自己的外部账号，或使用获准的公司共享账号，再把指定能力授权给代表某个 Agent 的 Agent Platform Consumer。

M1 首个受监督 Pilot 使用 GitHub，目标是：

1. 员工通过 Connection 的独立中文入口连接专用 GitHub 测试账号。
2. Agent Owner 决定 Agent 可以请求哪些 Provider 和 Action。
3. 使用者决定是否允许具体 Agent 使用自己的哪个 Connection 和哪些已确认能力。
4. Platform 与 Connection 任一授权不满足时都拒绝调用。
5. Agent、模型、Platform 和浏览器都不能获得外部账号原始凭证。
6. 两个测试用户完成真实读取、创建 Pull Request、审计、撤权和故障恢复闭环。

Pilot 完成不表示员工日常 GitHub 账号、其他 Provider、其他 Consumer 或广泛生产环境已经可用。

## 2. 核心概念

| 概念 | 产品含义 |
| --- | --- |
| Provider | GitHub 等外部平台 |
| Action | Provider 对外提供的一项受控能力 |
| Principal | Connection 识别的稳定员工主体 |
| Consumer | 使用 Connection 的客户端或服务；首个 Pilot 为 Agent Platform |
| Actor | Consumer 内被单独授权的稳定单元；首个 Pilot 为具体 Agent |
| Connection | 已完成外部鉴权、对应一个稳定外部账号的连接 |
| Connection Grant | Principal 允许 Consumer/Actor 使用某个 Connection 和已确认 Action 的授权 |

Agent Owner 只能选择 Agent 的 Provider 和 Action policy，不能替普通使用者绑定外部账号或创建 Connection Grant。使用者在 Connection 中选择具体账号并确认能力；Agent 不能选择默认账号或替换目标 Connection。

## 3. 系统边界

### 3.1 Connection 负责

- 独立的登录、Connection 管理、授权、调用记录和管理入口。
- Principal、Consumer、Actor 注册和 Connection Grant。
- Provider、Action 目录及发布状态。
- 外部账号鉴权、稳定识别、脱敏展示和 Connection 生命周期。
- 外部凭证保护、刷新、撤销和 Provider API 调用。
- Action 参数校验、幂等、未知结果处理、调用审计和跨用户隔离。

### 3.2 Agent Platform 负责

- Agent、Owner、使用范围和 Agent Action policy。
- 只读同步 Connection 发布的 Provider/Action 目录。
- 为当前用户、当前 Agent 和当前 Action 提供受信且短期有效的调用身份。
- 在执行记录中保存 Connection 返回的稳定调用引用、状态和脱敏结果。
- 在调用 Connection 前再次检查当前 Platform policy。

Platform 不保存第二份可写 Connection Grant，不保存 Provider Credential，也不能向 Connection 指定 Principal、Connection 或外部账号。

### 3.3 Agent 负责

- 从当前 Agent policy 中选择 Action 并只提交 Action 参数。
- 使用脱敏结果继续完成任务。
- 不保存或读取 Connection 原始凭证、用户身份或账号选择信息。

## 4. OpenConnector 复用范围

Connection 可以复用固定版本、经过审核的 Provider metadata、Action schema、OAuth helper 和执行代码，但 OpenConnector 不是 Principal、Consumer、Actor、Grant、Connection、Credential、审计或恢复权威。

上游 Runtime、SQLite、本机账号别名、Runtime token 和 Web Console 不进入正式 Connection 路径。具体固定版本、来源校验和 Adapter 方式属于工程设计。

## 5. Provider 与 Action

- Connection 是 Provider 和 Action 的唯一目录来源；Agent Platform 只保存只读投影。
- Action 至少展示名称、用途、参数、返回结果、外部效果和所需外部权限。
- Consumer 或 Agent policy 只能收紧当前发布目录，不能扩大 Provider 或 Action 能力。
- Owner 新增 Action 后，已有 Connection Grant 不自动获得新能力；使用者确认后才可使用。
- Owner 移除 Action，或 Connection 停用 Provider/Action 后，后续调用立即停止。
- 首个 Pilot 只发布读取当前账号、列出本人可见仓库和创建 Pull Request 三项 GitHub Action。
- 首个 Pilot 只允许一个受控 private 测试仓库，不开放文件修改、分支创建、合并、Issue、Workflow、Release 或删除仓库等其他能力。
- Bitbucket、Jira、Confluence 和其他 Provider 不进入首个 GitHub Pilot。

## 6. Principal 与登录

- Connection 提供自己的员工浏览器登录入口，并使用部署批准的公司 LDAP 配置验证员工。
- Connection 以 LDAP 来源和稳定 `uid` 映射 Principal；邮箱、登录名和显示名只用于展示，不能作为授权键。
- LDAP 密码只用于当次登录验证，不保存、不记录，也不进入 Token、Cookie、错误、审计或模型上下文。
- 登录成功后由 Connection 建立独立、可撤销且有期限的浏览器会话。
- 登录后定期复核 LDAP 条目；身份服务不可用时敏感操作拒绝执行，具体频率和并发控制由工程设计规定。
- 当前 Pilot 只能确认 LDAP 条目是否仍存在，不能证明员工仍在职；离职状态的权威来源属于 Pilot 后生产化门禁。

## 7. Connection 与授权

### 7.1 个人 Connection

- 员工本人完成 GitHub OAuth，并只能发现和管理自己的 Connection。
- Connection 使用 GitHub 稳定账号标识识别外部账号；登录名变化不产生新 Connection。
- GitHub OAuth 只建立 Connection，不自动授权任何 Agent。
- 断开 Connection 立即阻止所有依赖它的新调用，并单独撤销该 Connection 使用的 GitHub Token；不默认撤销该用户对整个 OAuth App 的授权。

### 7.2 公司共享 Connection

- 获准管理员可以配置公司共享 Connection 及使用范围。
- 共享资格不等于 Connection Grant；有资格的员工仍需为具体 Agent 单独确认授权。
- 公司共享 Connection 不使用另一套身份、存储或运行模式。
- 首个 GitHub Pilot 不验收共享 Connection 的真实组织范围和账号。

### 7.3 Connection Grant

- Connection Grant 绑定当前用户、Agent Platform、具体 Agent、Connection 和用户确认时展示的 Action 集合。
- 授权页面必须展示 Agent、脱敏 GitHub 账号、三项 Action、写操作效果和 GitHub OAuth 权限范围。
- 用户可以拒绝、创建、替换或撤销 Grant；拒绝 Grant 不删除已经建立的 Connection。
- 同一用户、Agent 和 Provider 在首个 Pilot 中只有一个当前 Connection；切换账号必须明确确认。
- 撤销一个 Agent 的 Grant 不影响其他 Agent 或其他用户的独立 Grant。

## 8. 双层授权与隔离

一次调用只有同时满足以下条件才可执行：

- 当前用户仍可使用 Agent。
- Action 仍在 Agent Owner 配置的 Platform policy 中。
- Connection 中存在当前用户对 Agent Platform、具体 Agent、Connection 和 Action 的有效 Grant。
- Provider、Action、Connection 和外部凭证当前可用。

当前用户、Agent Platform、具体 Agent、Connection 和外部账号均由服务端解析。Agent、模型、浏览器或调用方提交的身份和账号字段不能创建、替换或扩大授权。

Alice 与 Bob 不能互相发现、授权、调用、断开或查询对方的 Connection、Grant、Credential、OAuth 事务和调用记录；拒绝响应不能泄露目标是否存在。

## 9. 凭证与调用

- GitHub OAuth 与 Connection Grant 是两个独立确认步骤。
- 首个 Pilot 使用专用 GitHub 测试账号和受控 private 仓库。页面必须明确展示 OAuth App 获得的广泛仓库权限；员工日常 GitHub 账号不进入 Pilot。
- Agent Platform 使用受信短期调用证明代表当前 Principal 和 Agent Actor；普通浏览器会话不能作为 Action 调用凭据。
- Connection 每次解析唯一授权 Connection，注入 Credential 并调用 Provider；原始 Credential 不离开 Connection。
- 写 Action 必须使用跨重试稳定的请求标识。相同标识和请求返回同一次调用；相同标识用于不同请求时拒绝。

## 10. 撤权与未知结果

- Connection 在向 Provider 提交写操作前再次检查当前 Principal、Consumer/Actor、Grant、Connection、Credential、Action 和 Provider 状态。
- 撤权在外部提交开始前完成时，本次调用拒绝；提交开始后才撤权时，不伪造回滚，保留 Provider 实际结果。
- Provider 可能已接受写操作但结果无法确认时，产品显示“结果待确认”，不能自动按失败重试。
- 自动对账最多持续 24 小时。唯一且完整匹配的结果可以确认成功；多个候选或字段冲突转管理员处理。
- 到达工程设计规定的最长处理期限后仍无法确认则显示“结果无法确认”；该状态既不是成功也不是失败，停止自动查询和重试，原请求标识不能复用。
- 普通用户可以查看自己的脱敏证据并提供线索，但只有 Connection 管理员可以改变人工处理结果，且必须记录审计。

## 11. 页面与入口

Connection M1 提供独立于 Agent Platform 的中文 Web 入口和部署单元。Agent Platform 只能跳转到该入口或调用公开契约，不能承载或复制 Connection 管理页面。

页面包括：

- 登录。
- 我的 Connection：连接、重连、断开和查看个人 Connection。
- Agent 授权：选择账号、确认 Action、切换账号和撤销 Grant。
- 调用记录：查看本人调用、待确认状态和脱敏结果。
- 待人工处理：管理员处理有歧义或超时的外部结果。
- Provider、Action、共享 Connection 和审计管理。

## 12. 审计

- Connection 审计覆盖登录、连接、重连、断开、授权确认、撤销、Provider/Action 变更、每次调用、外部撤销和人工处理。
- 审计能够回答哪个 Principal 通过哪个 Consumer/Actor、使用哪个 Connection、执行哪个 Action、何时提交以及结果如何。
- Platform 与 Connection 通过稳定调用引用关联同一次调用，但 Platform 不复制 Connection 的可写状态机。
- 审计和普通错误不记录 LDAP 密码、GitHub Token、Cookie、调用证明、密钥、聊天正文或模型内部思考。

## 13. 首个 GitHub Pilot 验收

| 场景 | 验收结果 |
| --- | --- |
| 测试主体 | 两个 LDAP 测试用户分别绑定两个专用 GitHub 测试账号，只访问一个受控 private 仓库 |
| 连接与账号 | 两人分别完成 LDAP 登录和 GitHub OAuth，并以稳定账号标识识别账号 |
| 两次确认 | GitHub OAuth 后仍需为具体 Agent Actor 确认三项 Action |
| 目录与 policy | Platform 只读同步三项 Action；Owner policy 或 Connection Grant 任一缺失都拒绝调用 |
| 真实写操作 | 两个测试用户使用预先准备的不同分支创建真实 Pull Request |
| 幂等 | 相同请求标识重试返回同一调用和 Pull Request，不创建第二个 PR |
| 跨用户隔离 | Alice 与 Bob 不能发现或使用对方的 Connection、Grant、Credential 和调用记录 |
| 调用证明 | 错误签名、受众、期限、workload、Actor、Action、参数或重复证明均拒绝 |
| 撤权 | 移除 Platform policy、撤销 Grant、断开 Connection 或停用 Action 后，新调用立即失败 |
| 未知结果 | 响应丢失进入待确认，覆盖自动对账、管理员处理和最终无法确认状态，不自动重发 |
| Provider 撤销 | 断开时撤销单个 GitHub Token，并能看到成功、失败或待重试状态 |
| 凭证保护 | 页面、Platform、Agent、日志、错误和审计均无法读取原始凭证或密钥 |
| 失败停止 | 越权、凭证泄露、错误调用证明被接受、重复 PR 或撤权失效时立即停止 Pilot 并保留证据 |
| 联合签收 | Platform、Connection、Security、SRE 和 Pilot 使用者分别签收自己的边界 |

验收只允许声明：在具名 HCI 环境、固定镜像、两个测试 Principal、两个专用 GitHub 账号和一个受控 private 仓库范围内，Agent Platform delegated GitHub Pilot 已通过。

## 14. Pilot 后范围

- 员工日常 GitHub 账号和 GitHub App 细粒度授权。
- LDAP 离职状态的权威来源和正式停权时效。
- 公司共享 Connection 的真实组织范围和账号。
- Direct MCP Client、Connection PAT 和 Connection OAuth Authorization Server。
- Bitbucket、Jira、Confluence、Outlook 和其他 Provider。
- 正式容量、灾备、值班、推广和广泛生产可用性。
