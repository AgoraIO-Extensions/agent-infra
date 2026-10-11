# Connection 生产部署

Connection 已按 [#1276](https://github.com/AgoraIO-Extensions/agent-infra/issues/1276) 批准的
[区域 ADR](../adr/ADR-connection-regional-control-plane-and-github-egress.md#上海分阶段迁移)
迁入上海，API/Web 与权威 PostgreSQL 均已切换。GZ3 release 已退役，不再作为发布或回退目标。
本迁移不代表开放中的广泛生产、Security/SRE、HA/PITR 或 Provider WRITE 门禁已经验收。

| 配置 | 上海契约 |
| --- | --- |
| 集群 | `hcicore-acs-sh-prod01`；API server `https://106.14.182.204:6443` |
| namespace | `agent-connector` |
| 公开 origin | `https://agent-connector.agoralab.co` |
| MCP | `https://agent-connector.agoralab.co/mcp` |
| 控制面 | `connection-api`，1 副本，`Recreate`；Web 为 `connection-web` |
| 权威库 | 上海 PostgreSQL 17，数据库 `agent_connector`，账号 `agent_infra` |
| 数据库 Secret | `connection-database-shanghai`，键 `DATABASE_URL`；`sslmode=verify-full` |
| Runtime Secret | `connection-config`；身份 realm、身份/凭证密钥保持不变 |
| TLS CA | ConfigMap `connection-rds-ca`，键 `ApsaraDB-CA-Chain.pem` |
| API CA 挂载 | 只读 `/etc/connection-rds`；`NODE_EXTRA_CA_CERTS=/etc/connection-rds/ApsaraDB-CA-Chain.pem` |

原 `connection-database` 是保留的旧库连接，不能用于新 API 或 bootstrap。namespace 隔离不替代
访问控制、资源配额和受控出口；本文命令仅更新现有上海 Deployment 镜像，不新建 namespace、
不复制 Secret、不改变数据库、CA、节点调度、安全上下文或其他服务。

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

## Compose 部署边界

以下 Compose 命令用于另行批准并配置的环境，不是现有上海集群的升级命令；常规发布使用
下文的[上海发布步骤](#发布步骤)。不要对现网重复运行 bootstrap 或创建第二个写入实例。

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

DataLego OAuth 只读试验的批准边界见 [HLD DataLego profile](HLD-connection-M1.md#321-初期-provider-实现范围)。
`DATALEGO_OAUTH_CLIENT_ID` 和 `DATALEGO_OAUTH_CLIENT_SECRET` 必须先存在于 `connection-config`，并在
Helm 的 `secretEnv` 中仅登记空值键名，使 API 通过 `secretKeyRef` 注入；使用 `--reuse-values` 时须显式
补齐这两项，不能只更新 Secret 后假定 Pod 已读取。注册回调固定为
`https://agent-connector.gz3.agoralab.co/oauth/callback?provider=datalego`，对应独立的
`datalego` Provider 的 v4；页面只保留正式 DataLego 入口。旧 DataLego 不自动迁移，试验 Provider
由迁移停用但历史记录保留，不能删除或重写 v3 Credential/Grant。发布前应完成 chart 渲染和当前
release 安全检查；发布后由测试用户完成 SSO、个人身份和真实 READ 验收，才能宣称线上可用。
旧申请与 v4 不匹配时须按新版本重新申请并连接；新增 Action 不自动进入 Consumer Grant。
v4→v5 的取消修复通过精确 release/digest 兼容证据支持显式升级：员工点击“处理升级”后，
保留有效原审批的来源、有效期、已批准 Action 子集和 OAuth refresh/到期信息；不自动扩大
Consumer 已选能力。证据不匹配或原审批已失效时，页面引导申请新版能力；凭据验证失败时
仍需重新授权，不能通过手工更新 Credential 或审批状态绕过门禁。
试验 Provider 停用迁移完成后，不可直接回滚至仍发布该 Provider 的旧程序；旧程序会拒绝已停用的
catalog。恢复应发布修复后的正式版本，不能通过重启或重写 Credential 绕过版本门禁。

## 验收边界

### DataLego Hive 表发现与结构查询

v6 提供 `datalego.list_tables` 和 `datalego.describe_table`，复用个人 OAuth 的 SQL HTTP API。
两项 Action 创建查询任务，因此为 WRITE；使用前需要目标能力档案批准与 Consumer 明确确认。
旧批准只继承原四项能力，新动作不会自动进入旧 Grant。

发现表时传入数据库及精确表名或以 `*` 结尾的前缀，例如
`{"database":"analytics","pattern":"event*"}`。查看结构时传入
`{"database":"analytics","table":"events"}`。
每次有意创建新任务使用新的 `idempotencyKey`；仅重试同一次请求时复用原 key 和相同参数。
动作返回 DataLego 任务 `id`，将它作为 `jobId` 调用现有 `datalego.get_query_status`，直到外部
任务成功或失败；不要把 Connection Call 的 SUCCEEDED 当成外部查询已经完成。

表发现结果包含 namespace、tableName、isTemporary；结构结果包含字段名、类型、引擎注释
及分区标记。注释可能为空，不提供目录全文搜索、属主、治理标签或其他引擎支持。
数据库/表名只支持至多 128 个 ASCII 标识符字符；拒绝任意 SQL、URL、Header、下载参数及
纯 `*` 模式。服务端固定构造 Hive SHOW TABLES/DESCRIBE，Adapter 不轮询、不重放提交。

本机 type check、unit test、临时 PostgreSQL 集成测试和 Docker build 只能证明源码接线。HCI pilot 验收
仍需要真实公司 LDAP、已登记的 Codex client、真实 Bitbucket/Jira/Confluence credential 在至少两个客户端的
Bearer 调用、真实 GitHub OAuth App、两个独立 ConsumerInstance、PostgreSQL 备份/恢复、受控 egress，
以及最小只读与写入 Provider canary。参数清单见
`.env.conformance.example`；本机验收可使用被 Git 忽略的 `.env.conformance.local`，部署环境必须由
Kubernetes Secret 注入。实际值不得进入已跟踪文件、日志或聊天。不能仅凭 test double 或本机 unit
test 验收。

## 上海受监督发布

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

### Direct OAuth 刷新排查

API 运行日志输出以下结构化事件，遵循 [HLD 18.1、26 节](HLD-connection-M1.md#18-direct-sessiondelegated-assertion-与-authorizedinvocation)：

- `connection_oauth_request_rejected`：HTTP 边界拒绝，只记录固定 operation、OAuth error code 和实际响应 status。
- `connection_oauth_refresh_rejected`：记录 `read` 或 `rotate` 阶段、reasonCode、服务端解析的
  Principal/Consumer/instance/session ID、状态和 Token 的签发、消费、撤销、到期时间。
- `connection_oauth_refresh_rotation_committed`：轮换事务提交后记录；不证明客户端收到响应或保存了新 Token。

| reasonCode | 含义 |
| --- | --- |
| `TOKEN_UNAVAILABLE` | Token 未找到，或其关联对象被当前资格查询过滤；不能只据此认定 Token 不存在 |
| `TOKEN_REPLAY` / `TOKEN_REVOKED` | 已消费或已撤销 Token 再次使用 |
| `TOKEN_EXPIRED` | Token 已到期 |
| `CLIENT_MISMATCH` / `RESOURCE_MISMATCH` | client 或 resource 绑定不匹配 |
| `RECOVERY_GENERATION_MISMATCH` | 签发时与当前恢复代际不匹配 |
| `IDENTITY_INACTIVE` | Principal、identity、instance 或 session 非 ACTIVE；结合状态字段判断 |

刷新拒绝不等于会话被撤销。会话首次从 ACTIVE 变为 REVOKED 时，同事务写入
`connection_audit_records` 的 `DIRECT_SESSION_REVOKED` 事件。detail 只保存 sessionId、consumerId、
consumerInstanceId 和 reasonCode：`REFRESH_TOKEN_REPLAY`、`REFRESH_TOKEN_REVOKED`、
`TOKEN_REVOKED`（显式 Token 撤销）、`CONSUMER_INSTANCE_REVOKED` 或 `PRINCIPAL_DISABLED`。
后续重复撤销不覆盖首次原因，也不重复生成该状态转换事件；Pod 重启后仍可由有权限的运维按 sessionId 查证。

所有诊断均不保存 Token、Authorization Code 及其 hash、Credential、identityReference、用户 profile、原始请求/响应、
URL/query 或任意 Header。用同一 sessionId 和生命周期时间关联轮换、拒绝与首次撤销，不能仅凭时间接近
认定客户端并发。历史事件不回填，缺失撤销原因记录不能证明主动退出。

### 发布步骤

上海使用 `connection:release`，GitHub 当前采用区域 ADR 的直连配置。该入口不会启用 GZ3 Helm
release。历史 GZ3 pilot 的直连回退和风险接受不能自动沿用于上海的广泛生产验收。

创建 PR 前先运行：

```bash
pnpm connection:pr:preflight --issue <issue-number>
```

该命令校验受监督分支没有占用 Worker branch namespace、Issue 契约与 `ready-for-human` 标签完整、
工作区干净且分支基于当前 `origin/connection`，并报告 base commit 已存在的失败 checks。

PR 合并后，从干净的 release worktree 发布。不要切换或清理正在开发的脏工作区：

```bash
git fetch origin connection --prune
git worktree add --detach ../connection-release origin/connection
cd ../connection-release
pnpm install --frozen-lockfile
```

若该 worktree 目录已存在，先确认其中 `git status --short` 为空，再在该目录 fetch 并
`git switch --detach origin/connection`。有未提交改动时换新的 release 目录，不执行 reset、
clean 或覆盖开发文件。

使用 Node.js 24、仓库 `packageManager` 指定的 pnpm、GitHub `gh` 登录和上海集群权限。
部署验签还需要 `cosign` 3.0.2 在 PATH 中；Linux/macOS 的 x64、arm64 官方二进制 hash
由 `deploy/connection-supply-chain.mjs` 固定，不接受其他二进制或关闭验签的环境开关。
工具来源与 OIDC 信任范围见[签名 ADR](../adr/ADR-connection-signed-release-evidence.md)。
kubectl 与 API server 的 minor 版本差不能超过 1；例如 Kubernetes 1.34 使用 kubectl 1.34。
不要沿用机器上旧的 kubectl 1.27 或仅按全局 context 名称猜测集群。

```bash
export CONNECTION_KUBECONFIG="/path/to/approved-shanghai-kubeconfig"
export CONNECTION_KUBECTL="/path/to/compatible-kubectl"
"$CONNECTION_KUBECTL" --kubeconfig "$CONNECTION_KUBECONFIG" version -o json
```

上述路径由操作者配置，不存入 Git。脚本总是显式传 `--kubeconfig` 和 `-n agent-connector`，
检查 API server，不修改全局 Kubernetes context。不能只凭 context 名称包含 Shanghai 推断目标；
名称相近但 server 不符时拒绝部署。API/Web 和已有 Secret/CA 必须已经存在。

先选择大于最新发布且未占用的 `connection-vX.Y.Z`，将以下占位版本替换成该版本。
三个阶段可以分开执行：

```bash
pnpm connection:release connection-vX.Y.Z
pnpm connection:release connection-vX.Y.Z --publish
pnpm connection:release connection-vX.Y.Z --deploy
```

也可以一次完成：

```bash
pnpm connection:release connection-vX.Y.Z --publish --deploy \
  --kubeconfig "$CONNECTION_KUBECONFIG"
```

显式配置 kubeconfig 后，dry-run 也检查上海目标、单主、数据库身份、`verify-full`、CA 挂载及
image-only patch 的 server dry-run。凭据只在进程内用于校验，不打印 Secret、数据库 URL 或密钥。

发布要求工作区干净、HEAD 和 tag 精确等于当前 `origin/connection`；保留 migration、catalog、
approval fence 和既有账号升级回归门禁。存在 migration 变化时拒绝普通发布，须先走经评审的
迁移流程，不能用手工导表或跳过 hook 替代。部署要求该 tag、同一 SHA 的 GHCR workflow 完成且
成功，随后只执行 API/Web 的 `set image`，等待新镜像的 Pod Ready 和 Deployment generation
生效。它不触发 bootstrap，不自动创建业务对象、升级用户授权或执行 Provider WRITE。

发布 workflow 对两份 Connection 镜像生成最终镜像与实际 bundler 输入合并的 SBOM，
核对许可/来源文件、Node runtime bytes，分别签名镜像、executor manifest 和 SBOM。
只有限定仓库 tag push 的签名 Job 获得 OIDC 权限；原生 workflow 终态包含签名验证结果。
部署从可信 OCI attestation 回读原字节及独立签名 bundle，核对 issuer、workflow/tag/source、
证书中的 immutable repository ID 和当前源码/许可 hash。全部通过后，API/Web 与 schema Job
使用不可变 image digest。缺失、错身份、篡改、服务失败或未签的历史镜像均拒绝，不降级。
目标/runtime dry-run 不代表验签通过；签名也不代替 Legal 签收或 Provider onboarding。

`connection:gz3:release` 只保留发布/预检兼容别名；包含 `--deploy` 时在外部副作用前立即拒绝。

#### 经评审的 schema 迁移发布

存在新迁移时，普通发布继续拒绝。仅当变更是新增版本化 SQL 和追加 journal，且精确字节已包含在
同仓库已合并的 PR 中，才使用显式模式。迁移来源校验不重复要求该 PR 的 CI/review Check
成功；PR 合并门禁和正式镜像发布的 CI 检查仍按各自流程执行：

```bash
pnpm connection:release connection-vX.Y.Z --publish --deploy \
  --kubeconfig "$CONNECTION_KUBECONFIG" --reviewed-migrations-pr <migration-pr-number>
```

预检验证来源、旧 journal/SQL 不被重写、上海目标、数据库/TLS 和 Job 的 server dry-run，不执行迁移。
发布先生成精确 SHA 镜像；部署确认 GHCR 成功后，创建单次 `connection-migrate-<version>` Job。
它仅运行镜像内的 `bootstrap-production.mjs` schema 角色，只注入既有上海 DATABASE_URL Secret 与
只读 RDS CA，不注入 Provider/LDAP 密钥，不装载账户/授权服务，不自动重试或删除 Job。
迁移角色先检查旧 Drizzle 账本是提交历史的完整前缀，再执行正式 migrator，最后核验全部提交 SQL 摘要。
只有 Job 成功且唯一回执与候选提交全部 migration hash 匹配，才执行 API/Web 的 image-only 更新。

响应丢失时可回读同一 SHA/镜像/配置的成功 Job，不重新执行迁移。失败、未知、配置不符或账本漂移时
保留现场并阻止镜像更新；不能覆盖历史 migration、手改账本、切换数据库或以业务 bootstrap 绕过。
上线前评审新 SQL 与旧应用兼容性、锁影响和回滚点，通常保留已追加 schema 并只回滚兼容镜像。
不要重新安装 `connection-gz3`、使用旧 Helm chart 的固定副本设置或恢复 GZ3 写入角色。

### 发布后验收

```bash
"$CONNECTION_KUBECTL" --kubeconfig "$CONNECTION_KUBECONFIG" -n agent-connector \
  get deployment,pods
curl --fail --silent --show-error https://agent-connector.agoralab.co/healthz
curl --fail --silent --show-error \
  https://agent-connector.agoralab.co/.well-known/oauth-authorization-server
curl --fail --silent --show-error --output /dev/null \
  https://agent-connector.agoralab.co/connection/connections
curl --fail --silent --show-error --output /dev/null \
  https://agent-connector.agoralab.co/connection/help
```

检查运行中的 API 实际数据库 host、`agent_infra`、PostgreSQL 17、SSL/TLS，并只输出这些元数据。
在已授权的只读数据库连接中，以下 SQL 可核对身份和该会话的 TLS；不要把密码或完整连接 URL
放入命令行、日志、文档或聊天：

```sql
BEGIN READ ONLY;
SELECT current_database(), current_user, current_setting('server_version');
SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid();
COMMIT;
```

通过 Connection MCP 做已获授权的有界 READ，如 GitHub 当前账号、指定 Jira Issue、指定 Confluence
页面或 Rehoboam 版本。目录可发现、Pod Ready、READ 成功和业务 WRITE 验收是不同结论。
新 ProviderRelease 的 Action 仍须原有审批/兼容升级/Consent，不因部署自动扩大权限。

### 镜像回退与故障定位

发布输出会列出原 API/Web 镜像。先检查失败 Pod 的事件与脱敏错误，确认上一镜像对当前 schema、
Catalog 和已经产生的新数据兼容后，只把对应容器设回原镜像。保持当前上海数据库和 CA 配置。
不要直接 `rollout undo` 整个 Pod template，因为旧 revision 可能引用美国库或缺少 CA。

```bash
"$CONNECTION_KUBECTL" --kubeconfig "$CONNECTION_KUBECONFIG" -n agent-connector \
  set image deployment/connection-api "api=$PREVIOUS_API_IMAGE"
"$CONNECTION_KUBECTL" --kubeconfig "$CONNECTION_KUBECONFIG" -n agent-connector \
  set image deployment/connection-web "web=$PREVIOUS_WEB_IMAGE"
```

`PREVIOUS_*_IMAGE` 从本次发布记录取值，不硬编码历史版本。镜像回退不恢复数据库备份、不复活
撤销授权，也不删除 UNCERTAIN。上海库已开放写入后，回迁旧库必须重新停写、同步并证明连续性；
保留旧 Secret 或备份不等于可直接回切。

Jenkins 等入口需要在其实际 API 网关维护出口白名单。当前出口必须从运行的 API Pod 实测，
节点地址不证明固定 SNAT；不猜测公网网段。网关 403/IP restriction、个人认证失败、未获 Consumer
授权和网络 timeout 要分开诊断。MCP 元数据发现/传输错误也不能直接归因于 GitHub 代理。

### 使用指南目录与 Nginx 覆盖

`/connection/help` 是 SPA route，`/connection/help/user-manual.md` 是静态下载；前者必须优先返回
`index.html`，不能由 `try_files $uri/` 匹配下载目录后产生 403。`/connection/help/` 规范化至不带
斜杠的地址，并保留 query。不要全局关闭目录处理，以免破坏 Codex/Agent 静态入口。

上海曾为该路由使用临时只读 ConfigMap `connection-web-nginx`，挂载
`/etc/nginx/conf.d/default.conf`。发布脚本保留现有挂载，不自动删除配置。在正式镜像已包含修复、
且其内置 Nginx 配置与已验收覆盖一致时，先从 Web Pod template 删除该 volumeMount 和 volume，
等待 Web Ready 并验证指南与下载，再删除该 ConfigMap。不要先删 ConfigMap，也不要让旧覆盖长期
遮蔽后续镜像中的代理或路由修改。更新覆盖配置需要重新创建 Web Pod；subPath 不会热更新。

确认正式镜像的 tag/提交已包含上述 Nginx 修复后，按此顺序退出临时覆盖：

```bash
"$CONNECTION_KUBECTL" --kubeconfig "$CONNECTION_KUBECONFIG" -n agent-connector \
  patch deployment connection-web --type=strategic \
  -p '{"spec":{"template":{"spec":{"volumes":[{"name":"connection-web-nginx","$patch":"delete"}],"containers":[{"name":"web","volumeMounts":[{"name":"connection-web-nginx","$patch":"delete"}]}]}}}}'
"$CONNECTION_KUBECTL" --kubeconfig "$CONNECTION_KUBECONFIG" -n agent-connector \
  rollout status deployment/connection-web --timeout=300s
curl --fail --silent --show-error --output /dev/null \
  https://agent-connector.agoralab.co/connection/help
curl --fail --silent --show-error --output /dev/null \
  https://agent-connector.agoralab.co/connection/help/user-manual.md
```

只有全部通过后才删除 `connection-web-nginx` ConfigMap；失败时保留 ConfigMap，先恢复已验收的
只读挂载并重建 Web Pod，不调整 API 或数据库。仍运行缺少该修复的旧镜像时不要执行退出步骤。

审批迁移 `0032_connection_access_approval` 属于上述需评审的发布，不得用普通 GZ3 脚本跳过
migration hook。候选提交必须包含 `packages/connection-contracts/approval-fence.json`；正常 Connection
tag 的 catalog guard 从已提交的 Git 版本读取 migration journal 和 manifest，拒绝缺失、移除或
协议版本下降。工作区未提交文件的单元测试不等于 tag 发布验证。

审计迁移 `0033_audit_query_indexes` 与 `0034_call_diagnostics` 先进入主线，其既有 journal 时间戳保持不变。
审批迁移的 journal 将 `0032_connection_access_approval` 排在这些审计迁移之后；
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

## 出站安全验证

Provider 连接级 IP pinning、精确依赖 NetworkPolicy 和隔离 enforcement 探针按
[Connection 出站安全验证](connection-egress-security.md) 执行。目标集群未证明策略执行能力时，
不得把策略 API 接受或源码测试通过当作生产出口隔离。使用 GitHub forward proxy 的环境必须先
完成 pinned CONNECT transport 评审；新的 pinned runtime 不接受未验证的代理配置，也不自动
切换网络路径。
