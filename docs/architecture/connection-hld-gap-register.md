# Connection HLD 差距登记表

本表记录实现与 [Connection M1 HLD](HLD-connection-M1.md) 的差距，仅作为状态证据；HLD 仍是架构
权威依据。任何条目都不能通过环境变量或部署文档绕过。

| HLD 条目 | 状态 | 已强制行为 | 关闭证据 |
| --- | --- | --- | --- |
| G-01：公司 LDAP 与目标 Direct MCP OAuth/PAT profile | 部分实现；真实验收未关闭 | 统一账号 ADR 已批准；正式 runtime 已装配 Connection OAuth、LDAP browser session、Portable PAT、LDAP Adapter、PostgreSQL session/token authority 和 Direct MCP。控制台先登录再签发 PAT，不重复收集 LDAP 密码；browser session 与 PAT 明文均不落库，PAT 复用 Principal freshness 与统一 Bearer verifier。当前 Agora LDAP profile 明确使用公司私网 `ldap://` direct bind，不存在自动 downgrade/fallback；该例外接受链路上的 credential 明文风险。生产只注册健康检查；conformance 启动同一正式 runtime 采集证据，不构成独立 profile。未配置 LDAP active attribute/value 时，Adapter 只验证唯一 `uid` 条目仍存在，无法识别“条目仍存在但账号已禁用”，因此不能关闭账号禁用门禁。 | 真实 LDAP 与目标 Codex 版本完成 browser session、OAuth metadata、受限 DCR、PKCE S256、resource、refresh rotation和实例撤销；真实 PAT 完成控制台签发、两类客户端 Bearer 调用、独立撤销、账号禁用和私网边界验收。 |
| G-02：GitHub 部署、scope 与真实 tenant 验收 | 未关闭 | 固定版本 Kernel 与 Adapter 已接入源码边界，但生产 OAuth/API 路由仍 fail-closed，尚未记录真实 tenant 验收证据。 | 获批的 GitHub 部署与 scope，以及隔离账号的读、写、撤销和错误 E2E 证据。 |
| OC-01：不可变且已审核的 OpenConnector package | 边界已实现；发布门禁未关闭 | `packages/openconnector-kernel` 是 Connection 持有的受控源码副本，固定 provenance 并保留许可证和 notice；`openconnector-adapter` 是唯一 Consumer。Legal/Security 发布门禁仍未关闭。 | 记录 package digest、SBOM、license/notice 和兼容性报告；取得 Legal 批准。 |
| OC-02 / WP2：Direct Session 与 delegated workload identity | 部分实现；真实验收未关闭 | Direct OAuth 使用 LDAP Principal、持久 authorization session、rotating refresh family 和独立 ConsumerInstance；Portable PAT 使用同一 Principal、内建 Consumer 和独立 TOKEN instance；delegated `jti`/recovery 仍保持独立。 | 真实 OAuth/PAT 客户端、实例撤销、账号禁用、已注册 workload/mTLS、Actor binding 和跨 Principal/Consumer/Instance 负向测试。 |
| OC-03 / WP1-WP8：独立权威 schema | 部分对齐；门禁未关闭 | PostgreSQL migration 和正式 Repository 已实现统一 identity mapping、OAuth client/session/token、hash-only PAT/token instance、Principal 级 Direct Root/Grant、Personal/Shared Connection ownership、`CONNECTION_ADMIN` role binding、显式 Principal SharedScope membership、Connection/Credential、Call/Effect/Dispatch、audit 与 reconciliation 基础状态；OpenConnector Runtime store 不存在于产品路径。 | 对齐剩余 HLD 权威字段，完成 organization-unit eligibility、全新与升级 PostgreSQL migration、并发 CAS、HA 和 PITR 测试。 |
| OC-04：受控 catalog 发布 | 部分实现；门禁未关闭 | 正式 runtime 启动时从 OpenConnector Kernel Action catalog 自动投影 GitHub ProviderRelease/ActionVersion；不再在 Connection Store 重复维护逐 Action 定义。尚无独立的评审、签名、kill switch 与发布工作流。 | 不可变 ProviderRelease/ActionVersion 的导入、评审、digest、兼容性、kill switch 和发布证据。 |
| OC-05：账号与 Credential 生命周期 | 部分实现；门禁未关闭 | PostgreSQL Repository 已实现 GitHub OAuth transaction、账号连接/断开、AES-256-GCM Credential 加密与仅在 Adapter 执行边界解密注入；同一 Principal 可保存多个 GitHub Connection，并通过短期授权预览为每个 Direct Consumer 选择唯一 current Connection。当前使用进程注入的单一加密 key，不是 KMS envelope key；refresh/rotation、stable account proof 和持久 attempt 尚未实现。 | KMS 支持的 Credential 生命周期、refresh/rotation/revoke、稳定 Provider 身份、持久 attempt，以及真实账号的换号、重连和 scope 变化测试。 |
| OC-06：Consent 与 Grant | 部分实现；门禁未关闭 | Connections 控制台已实现服务器计算的短期 preview 和显式 confirm；浏览器确认只提交 preview ID、opaque token 与幂等键。Consumer declaration 是不可变 authority，preview 只取 declaration 与 Connection pinned ProviderRelease 的 exact ActionVersion 交集，并展示 required scope；Grant 冻结 declaration、Connection revision/fence、Credential version/revision/scope digest、账号 fingerprint、Action digest 和 SharedScope direct-membership path hash。PostgreSQL 按 AuthorizationRoot 后 preview 的顺序加锁并重读这些 source revision；确认事务原子创建 Consent/immutable Grant、替换旧 Grant，并覆盖未声明 Action、token 错误、过期、declaration/root stale、SharedScope membership 撤销和幂等重放。同账号 reconnect 的 exact-proof 比较由 Connection Core 决定：仅在 ProviderRelease、declaration、Action digest、scope digest、账号 fingerprint 和 shared eligibility 均未变化时基于原 Consent 创建 replacement Grant；任一证明变化都把旧 Grant 标记为 `PAUSED_CREDENTIAL`、清空 Root pointer、提升 fence、写入 reconfirm audit 并要求重新确认。移除 direct membership 会在同一事务终止该 Principal 的共享 Grant、清 Root pointer并保留其他成员。preview、confirm、reconnect、disconnect 和 revoke 使用受控锁顺序；真实 PostgreSQL 测试覆盖 Personal reconnect 竞态、Shared eligibility 隔离/撤销和 Shared reconnect replacement。旧的 Direct 自授权、Direct Action REST 和原地 Action 更新入口已删除。尚未实现 KMS 加密 Consent 展示快照、organization eligibility authority 和 transactional outbox。 | 完成加密 display snapshot/outbox、organization eligibility revision，以及扩权、真实重连、撤销和并发确认的完整竞态证据。 |
| OC-07：Direct 与 Delegated Consumer 协议 | 部分实现；门禁未关闭 | 正式 runtime 将 OAuth/PAT Bearer、Direct MCP、PostgreSQL Grant/Connection/Credential 与 GitHub Adapter 汇聚到同一 Application Service；MCP 固定暴露 OpenConnector 兼容的五个通用 tool，Action 发现和执行只返回当前授权投影。Hono 只保留 JSON-RPC/tool schema/dispatch/result mapping，Action 搜索、过滤、public ID/Guide 和执行选择由 Connection Core application service 处理。delegated assertion 路由存在于协议层，但正式 runtime 尚未装配已批准的 workload identity；目标远程客户端和完整 AuthorizedInvocation conformance 尚未验收。 | 目标客户端 remote MCP OAuth/PAT conformance，以及汇聚到 AuthorizedInvocation 的已注册 delegated mTLS/签名 assertion 契约。 |
| OC-08：可靠 Provider Effect | 部分实现；门禁未关闭 | PostgreSQL Repository 已实现持久 Call/Effect/Dispatch、提交前二次授权、稳定写幂等、`SUBMISSION_STARTED` 与 `UNCERTAIN` 边界；真实数据库测试覆盖提交前拒绝映射，GitHub Adapter 已接入读写执行。尚无真实写入、response-lost 和 crash matrix 证据。 | 跨语言 canonicalization vector/registry 治理、真实 Provider natural-key/idempotency 分析、crash matrix、受控 egress 和获批的 uncertain-result 操作。 |
| OC-09：KMS 与受控 egress | 未关闭 | 正式 runtime 使用进程注入的 AES-256-GCM key 并固定 GitHub Adapter，但尚无 KMS envelope key、egress proxy/DNS policy 或 secret canary；生产镜像继续不发布业务路由。 | KMS envelope key 与 egress/SSRF/secret canary 证据。 |
| OC-10：审计与恢复控制 | 部分实现；门禁未关闭 | PostgreSQL Repository 已写入基础 audit，并实现 reconciliation job claim、lease、complete 与 reschedule；尚未装配独立 recovery worker、transactional outbox、retention 和 PITR mutation gate。 | Transactional outbox、retention、recovery generation、PITR mutation gate、全新 PostgreSQL lease-fencing 测试和恢复演练证据。 |
| OC-11：Connection 产品入口 | 部分实现；门禁未关闭 | 正式 runtime 提供 LDAP 登录、PostgreSQL browser session，以及带左侧导航的 Connections、Access tokens、Administrators 和 Shared GitHub Connections 控制台；服务端 RBAC保护管理路由。普通用户可连接多个个人 GitHub账号、查看 eligible shared账号、预览并确认 Consumer 换号、revoke Consumer、disconnect个人 Connection 和独立撤销 PAT；管理员可创建和改名 SharedScope、管理显式 membership且不能读取 Credential 明文。Rename 只更新展示名称和审计，不改变稳定 ID或现有授权。完整 Consent 历史、Call、catalog 和 audit 视图尚未冻结。 | 使用同一公司 session 的 Consent 历史、Call、Consumer、catalog 和 audit 视图，以及真实管理员/普通用户浏览器验收。 |
| OC-12 / WP10：Provider 适配 | 部分实现；门禁未关闭 | GitHub 通过 `openconnector-adapter` 使用固定版本 OpenConnector Kernel；真实账号部署、scope 与错误证据仍未关闭。 | 按 Provider 评审部署、auth、scope、identity、error、rate limit、idempotency 和真实账号验收证据。 |
| OC-13 / WP10-WP11：升级与生产验收 | 未关闭 | Kernel provenance 与 Docker wiring 已固定，但尚无获签的生产 ProviderRelease 验收。 | Upgrade diff、conformance、crash、load、HA、PITR、SLO 和 rollback 门禁。 |
| 工程 Spec 2.1 / HLD 21：Drizzle Store 与 expand/contract migration 纪律 | 部分对齐；门禁未关闭 | PostgreSQL 所有权位于 `packages/connection-store`；版本化 migration journal 通过 Drizzle `0.45.2` PostgreSQL migrator 执行，正式 Repository 已实现业务 query。当前业务 query 使用 `postgres` typed SQL，尚未形成工程 Spec 要求的 Drizzle schema/query 边界。 | 评审并统一 Drizzle schema/query 边界，证明向前兼容的 expand/contract migration，并验证全新 PostgreSQL migration 与升级路径。 |
| 工程 Spec 2.1、7.1 / HLD 22：OpenAPI 契约来源与生成客户端 | 未关闭 | 已删除本机 Runtime 管理契约；Connection OAuth/MCP 使用统一账号模型。 | 冻结管理 OpenAPI/error/status 骨架，生成 Browser 客户端，并以 golden vector 证明 MCP/OpenAPI ActionVersion schema 一致。 |

## 后续 LDAP Conformance TODO

以下事项不在当前本机验证阶段实施，也不关闭 G-01：

- [ ] Directory Owner 为 `ldap.agoralab.co` 提供可用的 LDAPS 或 StartTLS，并明确证书链与轮换
  责任人；完成前保留已批准的公司私网 `ldap://` profile。
- [ ] SRE 在 TLS 可用后迁移固定 LDAP profile，并验证不存在自动 downgrade 或 fallback；不得把
  CA PEM 或 bind credential 提交到仓库。
- [ ] Directory Owner 确认可用于判断账号禁用状态的 LDAP attribute/value；确认前继续使用唯一
  `uid` 条目存在性检查，并保持账号禁用生产门禁开放。
- [ ] Connection Owner 在隔离环境完成真实 LDAP 登录、错误密码、重复或缺失 `uid`、账号禁用、
  目录不可用和私网边界的 fail-closed conformance，只归档脱敏证据。

## OC-01 源码验证

以下事实已针对上游精确 Git commit `0cb0e0dd2ed686fa7fa2ff8d9eef97a7d6b31674` 重新检查。
这些是受控 package 的源码审核证据，不关闭 Legal/Security 发布门禁。

- `git rev-parse <commit>` 解析为要求的 40 字符 commit ID。
- `git rev-parse <commit>:LICENSE.txt` 解析为
  `261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64`，与 HLD 37.2 节一致；导出文件 SHA-256 为
  `c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4`。
- 该 commit 包含 `NOTICE.md`，导出文件 SHA-256 为
  `d0890661bf25e7327808610f773b055cb87bf949ff6bba5943c7d62d94d1bf0f`。文件保留 HLD 37.2 节要求的
  Apache-2.0 notice 和第三方 Provider/品牌所有权声明。
- 源码包含 GitHub Provider definition、executor 模块、OAuth flow/token/refresh helper 和受保护的
  fetch，也包含 Runtime MCP Server、SQLite/D1 Store、Runtime Token Service 和 Web Console。
  Connection 只通过 Adapter 打包 HLD 允许的资产；完整 Runtime 不进入正式部署。
- 上游 `package.json` 将 package 标记为 `@oomol-lab/open-connector` `1.3.4`。这不能证明它是可用依赖：
  package 自身的 build/start script 会组装被禁止的 Runtime。

`packages/openconnector-kernel` 是 Connection 持有并独立版本化的受控源码副本。其
`PROVENANCE.json` 记录精确 source 与 artifact digest，package 包含 `LICENSE.txt` 和 `NOTICE.md`。
发布任何生产 ProviderRelease 前，仍须评审 package digest、SBOM、第三方 notice、兼容性决策并取得
Legal 批准。

## 验证限制

源码级和 package 测试已覆盖 Drizzle migration journal 与 migrator wiring。把 migration 路径视为
部署就绪前，仍须执行全新 PostgreSQL 和升级路径验证。

## 实现规则

每项 Connection 实现变更都必须在 Issue 或 review 描述中引用适用的 HLD 章节。实现前必须报告冲突、
缺失前置条件或 HLD 范围外行为；这类情况需要更新 HLD/ADR 并取得明确评审批准，不能使用兼容开关绕过。
