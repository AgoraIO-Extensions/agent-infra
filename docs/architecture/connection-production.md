# Connection 生产部署

`connection-api` 是唯一 Connection control plane。PostgreSQL 是唯一权威存储；OpenConnector
Runtime、SQLite、global alias 和 Runtime token 不进入部署拓扑。G-01 未关闭期间，生产入口只提供
容器内部健康检查，不发布身份或 MCP 业务路由。

## 前置条件

- PostgreSQL 可通过 `DATABASE_URL` 访问。
- Bootstrap 只接收 Secret Manager 注入进程环境的 `DATABASE_URL`。
- 公司 LDAP、Connection identity key、Credential KMS 和 Provider Secret 在对应门禁关闭前不注入
  生产 API。

不得创建或持久化已填写的 `.env.production` 文件。部署 orchestrator 必须从 Secret Manager 直接向
进程环境或 Secret Service reference 注入值。

## 部署

```bash
pnpm install --frozen-lockfile
pnpm connection:production:bootstrap
pnpm connection:production:up
```

bootstrap 角色只执行正式 migration，不插入 Principal、Consumer、Connection、Credential 或 Grant。

## 门禁期 Runtime 契约

- 当前生产镜像只启动 `/` 与 `/healthz`，且 Compose 不向主机发布端口。LDAP、OAuth metadata、DCR、
  PAT 签发、token、MCP、Provider、Consent、管理与 Action 路由全部不注册，不能通过环境变量启用。
- `apps/connection-api/src/runtime-app.ts` 是正式 Connection runtime 的唯一完整装配点，包含 LDAP、
  OAuth/PAT、PostgreSQL 账号与业务仓储、GitHub Kernel Adapter、Grant 和 Direct MCP。
  `apps/connection-api/src/conformance.ts` 只负责迁移数据库、启动该 runtime 并执行真实账号验收；
  conformance 是测试和证据过程，不是独立部署 profile 或另一套业务实现。两者在门禁关闭前均不进入
  生产镜像，只在受控 HTTPS 入口或精确 loopback 本机验收中运行。当前
  Agora profile 是公司私网 `ldap://` direct bind，不允许自动 downgrade 或 fallback；DCR 仅接受
  已实测 Codex native-client metadata 与受限 loopback redirect，注册在首次 code exchange 后失效。
  Connection 登录页建立 hash-only browser session；Access tokens 页面不重复收集 LDAP 密码，PAT
  只展示一次明文。PostgreSQL 保存 browser session hash，以及 PAT hash、Principal、token instance、
  有效期与撤销状态。
- Direct MCP、Delegated Invocation、Credential 和持久写契约仍以 HLD 为准。正式 runtime 的本机
  通过只能形成实现证据，不能代替尚未关闭的生产身份、KMS、egress、Consent 和恢复门禁。

## 验收边界

本机 type check、unit test、临时 PostgreSQL 集成测试和 Docker build 只能证明源码接线。生产验收
仍需要真实公司 LDAP、已登记的 Codex client、真实 PAT 在至少两个客户端的 Bearer 调用、真实
GitHub OAuth App、两个独立 ConsumerInstance、PostgreSQL 备份/恢复、受控 egress，以及最小只读
与写入 GitHub canary。参数清单见
`.env.conformance.example`；本机验收可使用被 Git 忽略的 `.env.conformance.local`，部署环境必须由
Secret Manager 注入。实际值不得进入已跟踪文件、日志或聊天。不能仅凭 test double 或本机 unit
test 验收。
