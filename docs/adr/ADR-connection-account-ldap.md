# ADR: Connection Account 与公司 LDAP 身份

## 状态

已由产品负责人批准进入实现；LDAP、MCP OAuth、KMS 与生产发布仍需完成 HLD 门禁和真实验收。

## 背景

同一员工可能在多台电脑上使用 Codex、Cursor 或其他 Consumer。第三方 Connection 与 Credential
必须属于员工的 Connection Account，而不是某台电脑或某个本机 Runtime。设备只代表独立的登录
会话和撤销边界。

Rehoboam 已使用公司 LDAP：后端以员工凭证 bind 用户 DN，再读取 LDAP 用户信息并使用稳定 `uid`
建立应用用户。Connection 复用该目录和稳定身份语义，但不能复用 Rehoboam 的 Socket 登录、私有
Token、硬编码目录配置或应用会话。当前 Agora LDAP 不提供可用的 LDAPS/StartTLS，因此产品负责人
批准 Connection 在公司私网内复用 Rehoboam 的 `ldap://` direct bind transport，并接受该链路上的
LDAP credential 明文传输风险。

## 决策

1. Connection 只有一套账号、授权、Credential 和审计权威。所有正式部署都使用 Connection
   PostgreSQL；不再以本机 installation、OpenConnector alias 或 SQLite 代表用户。
2. 公司 LDAP 是 M1 的第一种 Identity Source。Connection 使用 `issuer + LDAP uid` 映射稳定
   Principal；邮箱、`cn`、显示名和 Consumer 提交字段均不得作为授权键。
3. Direct MCP Client 支持两种 Connection 自有认证方式。支持浏览器 OAuth 的客户端通过
   Authorization Code + PKCE 换取短期 access token 和轮换 refresh token；其他客户端或无头部署可
   使用用户先登录 Connection 控制台、再从 Access tokens 页面签发的 Connection PAT。控制台使用
   同一 LDAP Principal 的独立浏览器会话，不构成第二套账号。两种 Direct credential 只面向
   Connection MCP resource，均不能得到 Provider Credential。
4. OAuth 客户端安装登记为独立 DEVICE ConsumerInstance。每枚 Connection PAT 登记为内建 Portable
   PAT Consumer 下的 TOKEN ConsumerInstance，明文只展示一次，PostgreSQL 只保存 hash。PAT 可跨
   客户端部署，但同一 PAT 的所有使用共享 Grant、撤销和审计边界；需要独立边界时签发不同 PAT。
5. 个人 ConnectionAccount 和 Direct Consumer Grant 绑定 Principal 与 Consumer，在同一 Principal
   的活跃 ConsumerInstance 之间共享。新增设备只登录 Connection，不重复执行 GitHub OAuth。
6. LDAP 密码只存在于一次 HTTPS 登录请求和 LDAP bind 调用期间，不持久化、不写日志、不进入
   OAuth code/token、浏览器 Cookie、审计、错误或模型上下文。登录成功后只签发高熵 opaque
   浏览器会话，Cookie 为 HttpOnly、Secure、SameSite=Strict，PostgreSQL 只保存 session hash。
   LDAP transport 必须使用部署批准的固定 profile；
   当前 Agora profile 使用公司私网内的 `ldap://` direct bind，不允许自动 TLS downgrade、fallback
   或由请求选择 endpoint。所有 DN/filter 输入必须转义，并设置连接、bind、search 和总请求
   deadline。目录服务提供可用 TLS 后必须迁移并关闭该例外。
7. OpenConnector 只提供固定版本审核过的 Provider/Action/OAuth/executor 资产，并位于 Connection
   Adapter 后。OpenConnector Runtime token、global alias、Web Console 和 SQLite 不属于正式路径。
8. 团队或公司共享 Connection 是同一账号模型上的 SharedScope/Grant 策略，不是另一种 runtime
   profile 或 Credential store。
9. LDAP 只认证 Principal，不声明 Connection 管理权限。Connection PostgreSQL 保存可撤销、可审计的
   `CONNECTION_ADMIN` role binding；管理路由每次按当前 Principal 和 role revision 在服务端授权，
   不信任邮箱、显示名、请求字段或前端菜单状态。第一个管理员只能由持有部署权限的操作员使用稳定
   LDAP subject 执行一次性 bootstrap；系统已有管理员后，该入口不能再授予角色。
10. 共享 GitHub Connection 属于 SharedScope，不属于创建它的管理员。管理员角色不自动获得共享
    使用资格；SharedScope 资格也不授予管理权限。当前 M1 实现只装配显式 Principal membership，
    LDAP Group 和组织单元的 current eligibility Adapter 仍需另行验收。

## OAuth、PAT 与实例语义

- MCP server 实现 Protected Resource Metadata；Authorization Server 实现 RFC 8414 metadata。
- Authorization Code 必须一次性、短期、绑定 client、精确 redirect URI、PKCE S256、resource、
  scope、Principal、Consumer 和 ConsumerInstance。
- MCP access token 必须验证 issuer、audience、expiry、scope、session、Principal、Consumer 和
  ConsumerInstance 当前状态；不得接收 Provider token 或其他 resource 的 token。
- refresh token 只保存 hash，使用一次即轮换；重放会撤销对应 session family。
- Connection 控制台浏览器会话独立于 MCP OAuth session，绑定 Principal、identity issuer、current
  recovery generation 和有效期；退出、过期、Principal/identity 停用或 recovery generation 变化
  后立即失效。
- Connection 自有 credential-bearing form（包括 OAuth 登录和控制台）优先要求精确 same-origin
  `Origin`。目标 WebKit 处于 opaque-origin
  环境并发送 `Origin: null` 时，只接受浏览器生成的 `Sec-Fetch-Site: same-origin` 与 issuer
  精确 Host 同时成立；缺失 Origin/Fetch Metadata、跨站或 Host 不匹配仍 fail closed。Rehoboam
  的可用登录路径通过同源 Socket.IO 发送 LDAP 凭据，Connection 参考其 LDAP 行为，但不复制其
  Socket 协议或省略 HTTP form 的 CSRF 门禁。
- 设备撤销只终止该 ConsumerInstance 的 session family。Provider disconnect 终止该 Connection，
  因而阻止该 Principal 所有设备的新调用。
- Connection PAT 使用高熵 opaque value、固定有效期、hash-only storage 和幂等撤销。每次使用校验
  PAT、TOKEN instance、Principal 和 identity 当前状态；PAT 不创建 OAuth refresh family。

## 影响

- 原 `LOCAL_SINGLE_USER` 与 `REMOTE_SHARED` 的身份和存储差异被删除。部署可以有中央 control
  plane 和可选本机 edge，但 edge 无状态且不保存第三方 Credential。
- Direct AuthorizationRoot/Grant 不再绑定 ConsumerInstance；ConsumerInstance 仍记录在 session、
  PAT、invocation 和 audit 中。Direct 幂等作用域使用 Principal + Consumer + key，使同一业务重试
  可以跨该用户的 OAuth 设备或 Portable PAT 使用端查询原调用，而不是重复产生副作用。
- 现有本机真实 GitHub OAuth 需要在中央 Connection Account 路径重新授权一次；之后同一 Principal
  的其他设备不再重复授权。
- 缺少 PostgreSQL、Credential 加密、HTTPS、批准的 LDAP profile 或 OAuth 安全配置时，生产业务
  路由启动失败。

## 已拒绝方案

- 每台电脑保存独立 SQLite Credential：无法跨设备共享，且撤销和审计被拆散。
- 让 Codex 收集或保存 LDAP 密码：违反 OAuth 客户端和 Credential 边界。
- 直接向 MCP Client 返回 Rehoboam Token：它不是 Connection credential，缺少 Connection 的
  resource、Principal、实例、撤销和审计绑定。Connection PAT 使用独立格式和权威数据模型。
- 自建用户名密码数据库：重复建设公司身份生命周期、密码策略和账号禁用能力。
- 把邮箱或 `cn` 当稳定 Principal：属性可变，无法作为长期授权键。

## 证据与后续工作

- Primary Issue：[#140](https://github.com/AgoraIO-Extensions/agent-infra/issues/140)
- 管理员与共享 GitHub Issue：
  [#158](https://github.com/AgoraIO-Extensions/agent-infra/issues/158)
- Rehoboam 参考实现：`justinia/server/services/auth.py`，仅用于确认 LDAP bind、目录 DN 与 `uid`
  语义及当前 Agora LDAP transport；不复制应用 Token、硬编码配置或应用会话。
- MCP Authorization：<https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization>
- Connection HLD：[`HLD-connection-M1.md`](../architecture/HLD-connection-M1.md)
