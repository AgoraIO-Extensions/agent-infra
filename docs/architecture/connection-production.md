# Connection 生产部署

`connection-api` 是唯一 Connection control plane，`connection-web` 是独立的无状态中文 React
入口。PostgreSQL 是唯一权威存储；OpenConnector
Runtime、SQLite、global alias 和 Runtime token 不进入部署拓扑。[#301](https://github.com/AgoraIO-Extensions/agent-infra/issues/301)
批准 `https://agent-connector.gz3.agoralab.co` 的 GZ3 control plane 使用完整 Connection runtime；
该批准不关闭 HLD 中面向其他环境、客户端或广泛生产支持的门禁。

## 前置条件

- PostgreSQL 可通过 `DATABASE_URL` 访问。
- Bootstrap 只接收 Secret Manager 注入进程环境的 `DATABASE_URL`。
- 公司 LDAP、Connection identity key、Credential key 和 Provider Secret 由 Secret Manager 注入
  pilot API；缺少任一必需值时进程必须在监听端口前失败。

不得创建或持久化已填写的 `.env.production` 文件。部署 orchestrator 必须从 Secret Manager 直接向
进程环境或 Secret Service reference 注入值。

## 部署

```bash
pnpm install --frozen-lockfile
pnpm connection:production:bootstrap
pnpm connection:production:up
```

Connection 生产镜像只使用专用的 `connection-vX.Y.Z` tag，且该 tag 必须恰好指向最新
`origin/connection`。其他产品的 `vX.Y.Z` tag 不执行 Connection catalog 门禁。发布工作流必须比较上一正式 Connection tag
与候选提交的 Provider catalog，拒绝 Provider 删除、Action 版本下降或 ProviderRelease 版本下降，并在
Job Summary 输出逐 Provider diff。feature branch、旧 SHA 或 divergent SHA 不得发布生产镜像。

bootstrap 角色只执行正式 migration，不插入 Principal、Consumer、Connection、Credential 或 Grant。
Compose 只向主机发布 `connection-web:8080`，由它将 `/api/v1/connection/*`、`/connection/v1/*`、
`/oauth/*`、`/.well-known/*` 和 `/mcp` 同源代理到不暴露主机端口的 `connection-api`。API 直接启动
`runtime-app.ts` 的正式装配；Compose 只传递显式 allowlist 中的环境变量，不读取已填写的 env 文件。

## 首个 Connection 管理员

目标员工必须先通过 LDAP 成功登录一次，使稳定 identity mapping 已存在。随后由持有部署权限的操作员
在 Secret Manager 注入完整 Connection runtime 配置的环境中执行：

```bash
pnpm connection:admin:bootstrap -- --ldap-subject '<stable-ldap-uid>'
```

命令使用 Connection identity key计算与登录相同的 environment-bound subject hash，只写
`CONNECTION_ADMIN` role binding 和脱敏审计；不接受邮箱，不读取 LDAP 密码，不输出 Principal ID或
Credential。命令幂等，但系统已有其他管理员或目标 role 已撤销后 fail closed。后续管理员变更只能从
`/connection/admin/administrators` 执行，且不能撤销最后一个 active 管理员。

## 受监督 HCI pilot Runtime 契约

- `connection-api` 生产入口与 conformance 入口调用同一个 `createConnectionRuntimeApp`。LDAP、OAuth
  metadata、受限 DCR、PAT、token、MCP、Provider、Consent、管理与 Action 路由只在完整配置、migration
  和不可变 catalog 校验通过后注册；不存在健康检查专用回退或环境开关。
- `apps/connection-api/src/runtime-app.ts` 是正式 Connection runtime 的唯一完整装配点，包含 LDAP、
  OAuth/PAT、PostgreSQL 账号与业务仓储、GitHub/Bitbucket/Jira/Confluence Server Adapter、Grant 和 Direct MCP。
  `apps/connection-api/src/conformance.ts` 只负责迁移数据库、启动该 runtime 并执行真实账号验收；
  conformance 是测试和证据过程，不是独立部署 profile 或另一套业务实现；该 conformance 启动器不进入
  生产镜像。当前
  Agora profile 是公司私网 `ldap://` direct bind，不允许自动 downgrade 或 fallback；DCR 仅接受
  已实测 Codex native-client metadata 与受限 loopback redirect，注册在首次 code exchange 后失效。
  `apps/connection-web` 提供简体中文登录、Connection、访问令牌、管理员和共享 Connection 页面；
  浏览器只使用生成的 `/api/v1/connection/*` Client。登录建立 hash-only browser session；PAT
  只展示一次明文。PostgreSQL 保存 browser session hash，以及 PAT hash、Principal、token instance、
  有效期与撤销状态。管理员使用同一 LDAP 登录；服务端 PostgreSQL RBAC 控制管理员和共享 Connection
  API。SharedScope 当前只支持显式 Principal membership；管理员本身不会
  自动获得共享 Connection 使用资格。
- Direct MCP、Delegated Invocation、Credential 和持久写契约仍以 HLD 为准。HCI pilot 的通过只能
  形成具名环境和客户端证据，不能代替尚未关闭的广泛生产身份、KMS、egress、Consent 和恢复门禁。

审批 enforcement 尚未启用时，当前不可变回滚点是 `connection-api:v0.0.1` 和 `connection-web:v0.0.1`。身份、Credential、授权、
Provider Effect 或 secret 暴露检查失败时，Helm 必须把 API/Web 镜像恢复为该版本；v0.0.1 只开放
健康检查，因此回滚会立即关闭 OAuth、MCP 和 Provider 业务路由，但不删除 PostgreSQL 权威数据。
审批 cutoff 生效后，该旧版不理解审批 fence，不再是合法回滚点；只能回滚到理解当前 schema 和审批协议的
已验收版本。不能以停用业务路由为理由将旧版重新部署到该数据库。

Jira/Confluence Server 的 `JIRA_TOKEN_*` 参数由 Secret Manager 注入服务端，用于按需签发短期应用级
`accessToken`；它不进入用户 credential envelope。用户的 Jira 用户名/密码仍按 Connection
credential 规则加密保存，并由 Adapter 与该应用级 Header 一起发送。Connection 不读取或执行
本机 Atlassian CLI 配置或脚本。

Rehoboam Provider 的 `REHOBOAM_KONG_API_KEY` 由 Secret Manager 注入服务端，只用于通过固定
Rehoboam Ingress 的 Kong `key-auth`。用户个人 Rehoboam Bearer Token 仍由 Connection 加密保存；机器
`apiKey` 不进入浏览器、用户 credential envelope、MCP 参数或调用结果。

## 验收边界

本机 type check、unit test、临时 PostgreSQL 集成测试和 Docker build 只能证明源码接线。HCI pilot 验收
仍需要真实公司 LDAP、已登记的 Codex client、真实 Bitbucket/Jira/Confluence credential 在至少两个客户端的
Bearer 调用、真实 GitHub OAuth App、两个独立 ConsumerInstance、PostgreSQL 备份/恢复、受控 egress，
以及最小只读与写入 Provider canary。参数清单见
`.env.conformance.example`；本机验收可使用被 Git 忽略的 `.env.conformance.local`，部署环境必须由
Secret Manager 注入。实际值不得进入已跟踪文件、日志或聊天。不能仅凭 test double 或本机 unit
test 验收。

## GZ3 受监督发布

创建 PR 前先运行：

```bash
pnpm connection:pr:preflight -- --issue <issue-number>
```

该命令校验受监督分支没有占用 Worker branch namespace、Issue 契约与 `ready-for-human` 标签完整、
工作区干净且分支基于当前 `origin/connection`，并报告 base commit 已存在的失败 checks。

PR 合并后切到对应的 `origin/connection` commit，再执行：

```bash
pnpm connection:gz3:release connection-vX.Y.Z --publish --deploy
```

命令只允许 tag 指向当前 `origin/connection`，等待 GHCR workflow 完成，然后固定使用 GZ3 context、
`gz3-agent-connector-prod` namespace 和 `connection-gz3` release。无 migration 的发布从一开始使用
`--no-hooks`，并通过无 watch 的 Deployment image/readyReplica 轮询验收，避免旧 Kubernetes 的
`event bookmark expired` 造成伪失败。检测到 `migrations/connection` 变化时命令 fail closed，必须改走
经过评审的 migration 发布流程。脚本不会读取 Secret、自动合并 PR 或执行 Provider WRITE Action。

审批迁移 `0032_connection_access_approval` 属于上述需评审的发布，不得用普通 GZ3 脚本跳过
migration hook。候选提交必须包含 `packages/connection-contracts/approval-fence.json`；正常 Connection
tag 的 catalog guard 从已提交的 Git 版本读取 migration journal 和 manifest，拒绝缺失、移除或
协议版本下降。工作区未提交文件的单元测试不等于 tag 发布验证。

启用 `ENFORCED` 前，Data Owner 必须确认个人 Connection 清单和 baseline 适用性，DBA/SRE 必须完成
0032 迁移重放及兼容回滚演练，Identity/Security/QA 必须确认正式目录、免责声明和真实 Provider
验收，并提供 cutoff 后只准部署审批兼容镜像的集群级控制及审计证据。当前 guard 只覆盖上述正常
tag 路径，不能阻止手工 Helm、旧镜像或其他部署途径；缺少集群级控制时保持 `PRE_LAUNCH`，不得
执行 cutover。cutover 一经执行不可用旧镜像回滚，也不得通过手工修改数据库状态关闭审批。

站内投影 outbox 连续 10 次失败后进入 `FAILED`，管理员审批页展示脱敏的事件类型、次数与创建时间。
管理员可对已排查原因的失败事件显式重投递；该动作只重新排队站内 WorkItem/Notification
投影，不重试 Provider 请求或已提交的外部 WRITE。事件真正送达后运营待办才完成；仅归档失败
通知不完成待办。恢复前必须先核对缺失的审计/任务事实，不得为了消除告警伪造业务完成状态。
