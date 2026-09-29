# Connection 生产部署

`connection-api` 是唯一 Connection control plane，`connection-web` 是独立的无状态中文 React
入口。PostgreSQL 是唯一权威存储；OpenConnector
Runtime、SQLite、global alias 和 Runtime token 不进入部署拓扑。[#301](https://github.com/AgoraIO-Extensions/agent-infra/issues/301)
批准 `https://agent-connector.gz3.agoralab.co` 的 GZ3 control plane 使用完整 Connection runtime；
该批准不关闭 HLD 中面向其他环境、客户端或广泛生产支持的门禁。

## 前置条件

- PostgreSQL 可通过 `DATABASE_URL` 访问。
- Bootstrap 只接收现有 Kubernetes Secret 注入进程环境的 `DATABASE_URL`。
- 公司 LDAP、Connection identity key、Credential key 和 Provider Secret 由现有 Kubernetes Secret 注入
  pilot API；缺少任一必需值时进程必须在监听端口前失败。

不得创建或持久化已填写的 `.env.production` 文件。GZ3 继续使用现有 Kubernetes Secret
及 `secretKeyRef` 注入值；不把值放进 Helm values 或 release 历史。后续 Secret Manager 治理见
[#907](https://github.com/AgoraIO-Extensions/agent-infra/issues/907)，不作为本次发布前置条件。

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
在 Kubernetes Secret 已注入完整 Connection runtime 配置的环境中执行：

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

Jira/Confluence Server 的 `JIRA_TOKEN_*` 参数由 Kubernetes Secret 注入服务端，用于按需签发短期应用级
`accessToken`；它不进入用户 credential envelope。用户的 Jira 用户名/密码仍按 Connection
credential 规则加密保存，并由 Adapter 与该应用级 Header 一起发送。Connection 不读取或执行
本机 Atlassian CLI 配置或脚本。

Rehoboam Provider 的 `REHOBOAM_KONG_API_KEY` 由 Kubernetes Secret 注入服务端，只用于通过固定
Rehoboam Ingress 的 Kong `key-auth`。用户从 Rehoboam Security 创建隐含 `metadata:read` 的 PAT 并提交给
Connection；Connection 不接收 Rehoboam 密码，只加密保存该 PAT。
机器 `apiKey` 不进入浏览器、用户 credential envelope、MCP 参数或调用结果。

Manhattan v4 连接使用公司 OAuth confidential client 的 authorization-code 回调，不再收集公司密码。
先登记精确回调 `https://agent-connector.gz3.agoralab.co/oauth/callback?provider=manhattan`，
再由现有 Kubernetes Secret 注入 `MANHATTAN_OAUTH_CLIENT_ID`、`MANHATTAN_OAUTH_CLIENT_SECRET` 和现有
`MANHATTAN_KONG_API_KEY`。Connection 用服务端 client secret 交换并刷新个人 Token，经 Manhattan
`/api/connection/whoami` 验证个人 Token 和邮箱身份后才加密存储，不要求建连时已有 SDK API 权限；
SDK dump 和 Symbol Action 在实际调用时由 Manhattan 逐路由检查 RBAC，缺少权限返回 403。
旧 v3 Connection 不自动升级，需要重新授权。
此发布包含 `0035_provider_oauth_transactions.sql`，必须先执行经评审的生产 migration 路径；
普通 GZ3 `--no-hooks` 发布脚本会按设计阻止直接部署。

## 验收边界

本机 type check、unit test、临时 PostgreSQL 集成测试和 Docker build 只能证明源码接线。HCI pilot 验收
仍需要真实公司 LDAP、已登记的 Codex client、真实 Bitbucket/Jira/Confluence credential 在至少两个客户端的
Bearer 调用、真实 GitHub OAuth App、两个独立 ConsumerInstance、PostgreSQL 备份/恢复、受控 egress，
以及最小只读与写入 Provider canary。参数清单见
`.env.conformance.example`；本机验收可使用被 Git 忽略的 `.env.conformance.local`，部署环境必须由
Kubernetes Secret 注入。实际值不得进入已跟踪文件、日志或聊天。不能仅凭 test double 或本机 unit
test 验收。

## GZ3 受监督发布

### 管理员操作记录

`/connection/admin/action-calls` 使用当前浏览器会话查询调用记录；仅当前有效的
`CONNECTION_ADMIN` 可访问列表与详情。姓名、邮箱、Action 和 Call ID 搜索与时间、结果组合过滤。
日期按 UTC+08:00 的自然日计算，自定义结束分钟包含在范围内，单次范围不超过 93 天。
分页每页最多 50 条，按创建时间和 Call ID 排序；查询审计写入失败时不返回查询结果。

页面遵循 [HLD 21.7、21.8 与 26 节](HLD-connection-M1.md#26-审计模型与查询权限)，
只展示固定白名单的输入输出摘要，不提供原始 JSON、Credential、业务正文或对话内容。
未知 Action、未记录的事件、失败原因和耗时不推断或补造。历史调用的人员姓名、邮箱与
Consumer 名称来自当前身份目录，不表示执行时的 profile 快照；稳定标识保留在技术详情。

本入口不覆盖尚未创建 Call 的请求拒绝，也不关闭审计防篡改、保留策略、outbox 或 PITR 门禁。
新增查询索引必须走下述经评审的 migration 发布流程；上线前确认表规模和建索引锁影响。

输入摘要结合已冻结 Action schema 区分无需参数、未传入可选参数和历史未记录；输出支持
固定字段的脱敏投影、集合数量和账号指纹，不按少量 Action 名称排除整个 Provider。
未适配结构明确标记，不将其显示为无输入或无输出。

详情中的「后端排查信息」默认折叠，不提供 curl、复制、导出或重放。Connection 在实际传输边界
按执行批次采集 HTTP 方法、服务地址、脱敏路径模板、开始/响应头或异常时间、HTTP 状态和
受控格式的对方请求编号；不记录 URL 用户信息、查询参数、片段、任意请求头、响应头或正文，
不向上游注入额外请求头。请求编号只接受具名 Header 的 UUID、十六进制或已知 Provider 格式。
耗时截止到响应头或传输异常，不表示完整响应读取或业务执行耗时；超时不证明对方未执行。

诊断与调用终态或有效 lease 的对账状态在同一事务保存。每批最多采集 32 次 HTTP 请求，超过时
保留超限数量；查询最多展示最近 20 批并明确截断。Call 创建前的 OAuth/credential 操作不属于
该 Call 的诊断。历史数据不回填；进程崩溃前未提交的诊断可能缺失，不能用它代替持久
Attempt、Effect receipt、完整审计或恢复证据，数据保留门禁不因此关闭。

### 发布步骤

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

审计迁移 `0033_audit_query_indexes` 与 `0034_call_diagnostics` 先进入主线，其既有 journal 时间戳保持不变。
审批迁移尚未发布，journal 将 `0032_connection_access_approval` 排在这些审计迁移之后；
实际执行顺序以 journal 的 `idx` 和 `when` 为准，不按文件名排序，避免已有审计迁移的数据库跳过审批表。
升级回归必须覆盖仅含审计索引的基线升级至审批版本，并验证重复迁移幂等。

允许先部署管理模块、后配置启用。员工身份映射未验证或免责声明尚未就绪时，保持
`CONNECTION_APPROVAL_DIRECTORY_ENABLED=false`，管理员可搜索、选择并保存已完成唯一 LDAP 身份映射的员工候选草稿，
但不得发布 Policy 或为新连接绕过审批。免责声明通过管理界面补充，目录参数通过部署配置与
Secret 补充；该阶段不执行 cutoff，也不自动扩张旧连接的账号、scope 或 Grant。迁移评审、
代码评审与适用于本次部署的人工验证仍须完成，不能用此分阶段安排豁免下述启用门禁。

审批人搜索可使用与 Rehoboam 相同的公司员工列表契约：配置
`CONNECTION_EMPLOYEE_DIRECTORY_URL` 为经过批准的 HTTPS 员工列表完整地址，配置
`CONNECTION_EMPLOYEE_DIRECTORY_SERVICE_KEY` 为 Secret 中的专用服务密钥，两项必须同时配置。
服务端使用 `agora-service-key` 请求头；响应为含 `name`、`email`、`iamId` 的数组。
管理员请求不能覆盖地址或请求头；不跟随重定向，不关闭 TLS 验证，响应限制为 5 MiB。
服务端按姓名和邮箱做不区分大小写的包含匹配，最多处理 20 个匹配员工；没有 `iamId`
的记录不参与候选搜索。员工邮箱仅用于精确查找 LDAP 账号，身份关联仍取 LDAP
issuer + uid；没有对应账号的员工不返回，映射歧义或上游异常时拒绝搜索，不能降级为
以邮箱或外部 `iamId` 授权。未配置该数据源时保留现有 LDAP 搜索。
启用审批目录不要求 `LDAP_ACTIVE_ATTRIBUTE` 与 `LDAP_ACTIVE_VALUE`；两者若配置则须成对提供。
未配置时发布与实际审批仅按 LDAP issuer + uid 的唯一条目存在性复核，不能据此宣称在职或离职即时停权，
详见 [HLD 16.7](HLD-connection-M1.md#167-connection-access-approval)。
员工列表配置不替代唯一邮箱映射与稳定 uid 的生产验证，也不自动开启
`CONNECTION_APPROVAL_DIRECTORY_ENABLED`。上线前需验证实际目录响应、服务密钥权限、
LDAP 映射与缺失、重复账号和重复邮箱负向场景；无在职字段时不得将离职但仍保留 LDAP 条目的账号视为已停权。
不得复用源码中的历史硬编码密钥。

启用 `ENFORCED` 前，Data Owner 必须确认个人 Connection 清单和 baseline 适用性，DBA/SRE 必须完成
0032 迁移重放及兼容回滚演练，Identity/Security/QA 必须确认正式目录、免责声明和真实 Provider
验收，并提供 cutoff 后只准部署审批兼容镜像的集群级控制及审计证据。当前 guard 只覆盖上述正常
tag 路径，不能阻止手工 Helm、旧镜像或其他部署途径；缺少集群级控制时保持 `PRE_LAUNCH`，不得
执行 cutover。cutover 一经执行不可用旧镜像回滚，也不得通过手工修改数据库状态关闭审批。

站内投影 outbox 连续 10 次失败后进入 `FAILED`，管理员审批页展示脱敏的事件类型、次数与创建时间。
管理员可对已排查原因的失败事件显式重投递；该动作只重新排队站内 WorkItem/Notification
投影，不重试 Provider 请求或已提交的外部 WRITE。事件真正送达后运营待办才完成；仅归档失败
通知不完成待办。恢复前必须先核对缺失的审计/任务事实，不得为了消除告警伪造业务完成状态。
