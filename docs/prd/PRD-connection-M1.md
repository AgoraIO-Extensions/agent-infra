# Connection M1 产品需求

关联文档：[企业级 Agent 平台 M1 产品需求](PRD-agent-platform-M1.md)

## 1. 产品目标

Connection 是可独立部署、可被多种客户端和服务消费的外部能力系统。它让员工连接自己的外部账号，或使用获准的公司共享账号，再把该 Connection 的指定 Action 授权给 Codex、Claude App、Cursor、Agent Platform、CI/CD 或内部应用等 Consumer。

用户使用 Direct MCP Client 时只配置 Connection，不需要同时配置 Agent Platform。Codex、Claude App、Cursor 等客户端分别注册为独立 Consumer；Agora Agent Platform 是另一个 Consumer，不是 Connection 的必经入口或授权权威。

M1 需要保证：

1. Consumer 可以使用外部平台 API，但不能获得外部账号原始凭证。
2. 使用者决定哪个 Consumer 可以使用自己的哪个 Connection 和哪些 Action。
3. Connection 独立保存并校验 Consumer 授权，不依赖 Consumer 内部数据库作授权结论。
4. 不同用户、Consumer、Consumer 内部 Actor 和 Connection 的授权相互隔离。
5. 同一 Provider 支持多用户分别连接账号，也支持同一用户连接多个外部账号。
6. 至少一个真实 Provider 完成连接、授权、调用、审计和撤销的完整闭环。

## 2. 核心概念

| 概念 | 产品含义 |
| --- | --- |
| Provider | Jira、GitHub、Outlook 等外部平台 |
| Action | Provider 对外提供的一项受控能力，例如创建 Pull Request |
| Principal | Connection 识别的员工或受管理服务主体 |
| Consumer | 使用 Connection 的客户端或服务，例如 Codex、Claude App、Cursor、Agent Platform 或 CI/CD |
| Actor | Delegated Consumer 内可选的细分使用单元，例如一个 Agent；对 Connection 是不透明稳定标识 |
| Connection | 已完成鉴权、对应一个稳定外部账号的连接 |
| Consumer 授权 | Principal 允许 Consumer 或其指定 Actor 使用某个 Connection 的已确认 Action 集合 |

Consumer 管理者可以声明产品需要的 Provider 和 Action，但不能替普通使用者绑定外部账号或扩大授权。使用者必须在 Connection 中明确选择具体账号和能力范围。Consumer 不能选择默认账号、替换目标 Connection 或读取原始凭证。

### 2.1 管理角色

Connection 接入公司身份和组织系统，并定义自己的系统管理员角色。系统管理员负责：

- 发布、更新或停用 Provider 和 Action。
- 注册和停用 Consumer，审核其请求的 Action 集合与回调配置。
- 配置公司共享 Connection 及其员工或组织使用范围。
- 查看 Connection 管理审计和调用审计。

Consumer 管理者只能管理自己的 Consumer 注册、显示信息和所需 Action 声明。最终账号授权始终由有资格使用该 Connection 的 Principal 确认。

## 3. 系统边界

### 3.1 Connection 负责

- Provider 和 Action 目录及不可变发布版本。
- Principal 身份接入、Consumer 注册和 ConsumerInstance 管理。
- Consumer 授权、Action 确认、账号选择、撤销和审计。
- OAuth、API Key/PAT 等鉴权方式及 Credential 刷新、轮换和撤销。
- 外部账号稳定识别、脱敏展示和 Connection 生命周期。
- 个人 Connection 和公司共享 Connection。
- Direct MCP Client 的 MCP 接入，以及 Delegated Service 和管理操作的 HTTP/OpenAPI 接入。
- Action 参数校验、凭证注入、Provider API 调用和脱敏结果。
- 幂等、未知结果处理、调用审计、限流和受控网络出口。

### 3.2 Consumer 负责

- Direct MCP Client 使用 MCP；Delegated Service 使用 HTTP/OpenAPI。两者都通过 Connection 发布的契约发现和调用 Action。
- 声明需要的 Action，并向用户解释自身用途。
- 使用 Connection 支持的 Direct 或 Delegated 身份方式接入。
- 只提交 Action 参数，不提交可信用户身份、目标 Connection 或原始凭证。
- 自行管理内部 Agent、对话、任务、审批和业务策略。
- 保存自己的任务记录时只引用 Connection 返回的稳定调用 ID 和脱敏结果。

### 3.3 Connection 不负责

- Consumer 内部 Agent、Conversation、Task、Pipeline 或审批设计。
- 替 Consumer 决定内部哪些任务可以发起请求。
- 任意 URL、通用 HTTP Proxy、Webhook、定时任务或主动通知。
- 向 Consumer、模型、Sandbox 或浏览器导出外部账号原始凭证。

## 4. OpenConnector 参考范围

M1 的 Provider、Action、外部鉴权和执行模型参考 [OpenConnector](https://github.com/oomol-lab/open-connector)。OpenConnector 不是公司 Principal、Consumer、组织、授权和审计的权威来源，也不能仅凭多个命名 Connection 满足企业多用户隔离要求。

本 PRD 的独立服务、Consumer 授权、多账号和隔离要求是 M1 产品规范。OpenConnector 的具体固定版本、复用范围、Fork、内部令牌和存储字段属于工程设计，不在本 PRD 规定。

## 5. Provider 与 Action

- Connection 是 Provider 和 Action 的唯一目录来源。
- Consumer 使用已发布目录，不重复定义任意 URL、请求模板或自定义 Credential。
- Consumer 注册时声明所需 Action；Connection 系统管理员审核并发布该声明版本。
- Action 至少展示名称、用途、参数、返回结果、外部效果类型和所需 scope。
- Provider、Action 或 Consumer 声明被停用后，后续调用立即停止；M1 不发送主动通知。
- Action 的用途、参数、结果、外部效果或所需 scope 发生实质变化时必须发布新版本，不能静默覆盖。
- Consumer 新声明 Action 或 Action 权限范围扩大时，已有授权不能自动获得新增能力，必须由用户重新确认。
- M1 至少接入一个真实 Provider；至少一个写 Action 必须完成真实调用，不以模拟结果代替验收。

## 6. Principal 与 Consumer

### 6.1 Principal

- 普通员工通过公司身份登录 Connection。
- Connection 使用公司稳定用户 ID，不以邮箱、显示名或 Consumer 提交的 `userId` 作为授权依据。
- 公司账号禁用后，该 Principal 的个人 Connection、会话和 Consumer 授权立即停止使用。
- 组织成员关系用于公司共享 Connection 的当前资格判断，不复制成永久权限。

### 6.2 Consumer

- Consumer 有稳定 ID、类型、名称、管理者、状态和已发布 Action 声明。
- 同一 Consumer 可以有多个 ConsumerInstance，例如同一客户端产品的不同设备或服务的不同 workload。
- ConsumerInstance 可以单独退出登录或撤销，不改变 Consumer 的稳定身份。
- Codex、Claude App、Cursor 等客户端产品分别注册为 Direct Consumer，不能共享 Consumer 身份、用户会话或授权。
- Direct MCP Consumer 通过 MCP access token 调用；token 必须绑定当前 Principal、已注册 Consumer、ConsumerInstance 和 Connection audience，浏览器登录会话不能单独决定 Consumer 或实例。同一 Direct Consumer 的不同 ConsumerInstance 不共享会话或授权，必须分别确认。Delegated Service Consumer 通过 HTTP/OpenAPI，以注册 workload 身份代表当前 Principal 调用。
- Direct Consumer 不使用 Actor。Delegated Consumer 注册时必须固定选择不使用 Actor 或要求 Actor；要求 Actor 时，每次授权和调用都必须携带已注册的稳定 Actor，缺失、未注册或当前 workload 无权代表该 Actor 时直接拒绝，不能回退到 Consumer 级授权。
- Actor 对 Connection 是不透明稳定标识，不能要求 Connection 理解 Consumer 的内部领域模型。Agent Platform 必须要求 Actor，并以每个 Agent 的稳定 ID 作为 Actor。

### 6.3 Direct MCP Client

- 用户只需在 Direct MCP Client 中配置 Connection MCP endpoint。
- 首次使用时由 Connection 提供浏览器或设备登录入口。
- 客户端登录 Connection 后只发现当前用户已授权给该 Consumer 的 Action。
- 客户端不保存 GitHub、Jira 等 Provider Credential，也不需要配置 Agora Agent Platform。
- 拟支持的 Codex、Claude App、Cursor 等客户端版本必须分别通过 MCP/OAuth、请求幂等、刷新和撤销验收；一个客户端通过不能证明其他客户端兼容。

## 7. Connection 类型与多账号

### 7.1 个人 Connection

- 由员工本人完成外部账号鉴权。
- 只能由本人发现、授权和使用。
- 不能分享、转赠或转换为公司共享 Connection。
- 公司账号被禁用后不能转让给其他员工。

### 7.2 公司共享 Connection

- 由 Connection 系统管理员配置，并限定可使用的员工或公司组织。
- 共享范围只表示 Principal 有资格选择该 Connection，不等于已授权给任何 Consumer。
- 获得使用资格的员工仍需为每个 Consumer 或 Actor 明确授权。
- 员工调岗、退出组织、被移出共享范围或账号禁用后，后续调用立即停止。

### 7.3 多账号

- 同一个 Provider 可以建立多个 Connection。
- 不同用户可以分别建立自己的 Connection。
- 同一用户可以为同一 Provider 建立多个外部账号，例如个人 GitHub 和公司 GitHub。
- 每个 Connection 有稳定内部 ID和稳定外部账号身份，展示名称不作为权限键。
- M1 中，同一 `Principal + Consumer + Actor（如有）+ Provider` 只能选择一个当前 Connection。
- 更换账号必须由用户明确确认；Consumer 不能自行选择、轮换或降级到另一个账号。

## 8. 连接与 Credential

### 8.1 连接管理

- 用户可以在 Connection 页面连接、重连和断开个人 Connection。
- 页面展示 Provider、外部账号名称、组织或脱敏标识、scope 和状态。
- Consumer 需要账号而用户尚未连接时，Connection 返回可打开的连接入口。
- 用户完成连接或重新授权后返回原 Consumer 继续任务。
- 重连同一外部账号后，因连接中断暂停的授权可以恢复。
- 重连为不同外部账号时，旧授权终止，用户必须重新选择和确认。

### 8.2 Credential 保护

- Connection 可以为每个 Connection 保存多个 Credential 版本，以支持 OAuth refresh、API Key/PAT 轮换、并发调用绑定、审计和恢复。
- 一个 Connection 在任一时刻只能有一个 current Credential 版本。
- 新调用只能使用授权时解析出的 Connection 的 current Credential，不能自动回退到历史版本。
- Consumer、模型上下文、Sandbox、页面、日志、错误和审计导出都不能获得原始 Credential。
- 断开 Connection 后，后续调用立即停止；已提交给 Provider 的操作保留实际结果。

## 9. Consumer 授权

### 9.1 授权单位

- 授权由 Connection 保存，绑定 Principal、Consumer、Direct Consumer 的具体 ConsumerInstance（或 Delegated 的可选 Actor）、Provider、具体 Connection 和确认过的 Action 集合。
- Consumer 只能调用自己已发布声明、用户已确认且 Connection 仍允许的 Action。
- 授权界面同时展示 Consumer、Actor（如有）、外部账号、Action、外部效果和所需 scope。
- 用户可以查看、更新和撤销给每个 Consumer 的授权。
- 撤销只影响目标 Consumer/Actor，不影响其他 Consumer 对同一 Connection 的独立授权。
- Consumer 授权不设置独立期限；用户撤销、换号、账号禁用或共享资格失效时终止，Connection 或 Credential 暂时失效时暂停。

### 9.2 Action 变化

- Consumer 新增 Action 或 Action scope/effect 扩大时，已有授权只覆盖上次确认集合。
- 用户确认前，Consumer 不能调用新增或扩大的能力。
- Consumer 撤回已授权 Action、Provider/Action 停用或权限收缩立即生效，不需要用户确认；仅发布不含该 Action 的新 declaration 不会隐式撤回既有 Grant。
- 新 declaration 替换旧 declaration 后，旧 declaration 只能供其已绑定 Grant 继续执行，不能用于发现或新授权；显式撤回 declaration 或 Action 必须同时终结或收缩受影响 Grant。
- 用户拒绝或关闭确认时，不执行该 Action，原授权范围不扩大。

### 9.3 Direct 与 Delegated 调用

- Direct MCP Consumer 通过 MCP 使用绑定 Principal、Consumer、ConsumerInstance 和 audience 的 access token，Connection 自行解析身份和授权。
- Delegated Consumer 使用注册 workload 身份，并通过 Connection token exchange 获取短期委托上下文；如由受信公司身份系统签发，该系统必须同时认证当前 Principal、workload 及其注册 Consumer/Instance 映射。上下文绑定稳定 Principal subject、组织或租户、workload、Consumer、Actor、Action、参数摘要和期限，Consumer 不能自签或自报 Principal。
- 委托上下文只能证明“谁在请求”，不能创建、替换或扩大 Connection 中的授权。
- 两种调用最终使用同一授权校验、账号解析、执行、审计和错误语义。

## 10. 用户与 Consumer 隔离

Connection 必须根据服务端认证结果和 Connection DB 中的当前授权解析目标账号。当前 Principal、Consumer、Actor、授权关系、Connection 和外部账号不能由 Action 参数提交、替换或覆盖。

以下行为必须被拒绝，且不能泄露目标资源是否存在：

- Alice 修改 ID、名称、参数或 MCP tool name 尝试使用 Bob 的 Connection。
- Consumer A 重放 Consumer B 的会话、委托令牌或调用 ID。
- 同一用户的个人账号和公司账号未经确认互换。
- Delegated Consumer 使用未授权 Actor 或把授权从一个 Actor 转给另一个 Actor。
- 已撤销 ConsumerInstance、授权或共享资格继续发起新调用。

OAuth callback 只能完成 Connection 服务端创建且尚未消费的事务。Connection 必须校验高熵 state、PKCE、Provider、发起 Principal、目标用途、过期时间和预注册返回地址；Consumer 发起时还必须校验事务绑定的 Consumer 和 ConsumerInstance，独立 Connection 管理流程则不得在 callback 临时附加 Consumer。系统在首次处理后原子消费事务；任何字段缺失、不匹配、过期或重放都必须拒绝，且不能改变 Connection 的所有者、共享范围或事务中已绑定的目标 Consumer。

## 11. Action 执行、错误与审计

- Consumer 提交 Action 和参数。HTTP 写 Action 必须通过 `Idempotency-Key` 提交由 Consumer 生成、跨重试稳定的业务幂等键，不能使用每次重试可能变化的传输层 request ID。
- Direct MCP Client 版本只有在通过验收、证明其在响应丢失、传输重试和用户重试时提供并保留同一稳定 request key 后，才能发现和调用写 Action；没有该能力的客户端版本只能使用只读 Action。
- Connection 解析唯一授权 Connection，并在首次接受调用时冻结当时的 current CredentialVersion；执行前校验该版本及其 fence 仍可用，再注入凭证并调用 Provider。并发 refresh/rotation 不得让已接受调用自动切换或回退到其他 CredentialVersion。
- 写 Action 在访问 Provider 前，把幂等键与已认证 Principal、Consumer、ConsumerInstance、Actor（如有）、Action 和请求摘要绑定，并提交稳定调用 ID、调用记录和外部效果意图。
- Connection 认证当前 Principal、Consumer、ConsumerInstance 和 Actor（如有）后，先以这些稳定主体和幂等键查找原调用，再决定是否解析新目标。首次请求冻结 Connection、CredentialVersion、ActionVersion 和请求摘要；命中同键、同请求时，当前身份、实例或授权已撤销则拒绝且绝不重新执行，否则返回原调用，不因换号、非撤销类授权更新或版本发布创建第二次调用；同键不同请求拒绝为冲突。
- Provider 可能已执行但结果无法确认时，产品显示“结果待确认”，不能直接按失败自动重试。
- Provider 原生幂等键或可证明的 natural key 只能保护同一已接受调用的 Provider 重试，不能替代 HTTP 或 MCP 的入站业务幂等键。
- Provider 拒绝、scope 不足、限流或暂时不可用时，返回稳定原因和可执行下一步。
- 用户可以在 Connection 调用记录查看自己的 Provider、脱敏账号、Consumer、Actor、Action、时间、状态、结果和错误。
- Consumer 可以使用稳定 correlation ID 关联自己的任务记录，但 Connection 不保存 Consumer 对话正文。
- 审计覆盖连接、重连、断开、Consumer 注册、授权确认、撤销、Provider/Action 变更和每次调用。
- 审计能够回答哪个 Principal 通过哪个 Consumer/Actor、使用哪个 Connection、执行了哪个 Action以及结果如何。

## 12. 页面与入口

Connection 在 M1 提供独立入口：

- 我的 Connection：连接、重连、断开和查看个人 Connection。
- Consumer 授权：选择账号、确认 Action、切换账号和撤销授权。
- 调用记录：普通用户查看自己的 Connection Action 调用。
- Consumer 管理：管理员注册 Consumer、管理实例和 Action 声明。
- Provider 与 Action 管理：管理员发布、更新和停用目录能力。
- 公司共享 Connection 管理：管理员配置账号及员工或组织范围。
- Connection 审计：管理员查询连接、授权和调用记录。

Consumer 可以通过 Connection 返回的 URL 进入连接、授权或重认证页面。Connection 页面不是 Agent Platform 页面的一部分，也可以被 Direct MCP Client 等其他 Consumer 使用。

## 13. M1 上线验收

| 场景 | 验收结果 |
| --- | --- |
| Direct MCP Client 独立接入 | 拟支持的客户端版本分别完成 MCP/OAuth conformance；至少一个客户端只配置 Connection MCP，完成登录、GitHub 连接、授权和真实 PR 创建 |
| Delegated Consumer | Agent Platform 通过通用 Delegated 契约调用同一 Action，不成为授权权威 |
| 多用户 | Alice 与 Bob 连接各自 GitHub 账号，不能互相发现、选择或调用 |
| 同用户多账号 | Alice 可同时保存个人和公司 GitHub Connection；每个 Consumer 只使用用户明确选择的当前账号 |
| 多 Credential | 同一 Connection 可完成 refresh/rotation 并保留版本历史，新调用只使用 current 版本 |
| 共享账号 | 只有当前指定员工或组织成员可发现；使用者仍需单独授权 Consumer |
| 授权与撤销 | 用户可以授权或撤销 Consumer/Actor；其他 Consumer 的独立授权不受影响 |
| Action 变化 | 新增或扩权必须重新确认；移除、收缩或停用立即生效 |
| 写 Action 可靠性 | 响应丢失不会重复创建 PR；结果进入可查询、可对账的“待确认”状态 |
| 调用详情 | 用户可以看到本人使用的 Provider、脱敏账号、Consumer、Action、时间、状态和结果 |
| 跨主体隔离 | 修改身份、ID、名称、参数、Actor 或 Consumer 都不能访问其他授权，也不能判断其是否存在 |
| 凭证保护 | Consumer、模型、Sandbox、页面、日志和审计均无法读取原始 Credential |
| 断开与停用 | 后续调用立即拒绝，已提交外部操作保留实际结果 |
