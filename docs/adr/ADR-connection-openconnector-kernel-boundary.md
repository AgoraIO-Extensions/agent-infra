# ADR: OpenConnector Kernel 边界

## 状态

已批准进入实现；Legal 与 Security 发布门禁仍未关闭。

## 背景

Connection 必须持有身份、授权、PostgreSQL 权威数据、Credential、Effect 和审计。
OpenConnector 可以提供 Provider 元数据、OAuth helper 和 Provider executor，但其 Runtime Server
不能成为 Connection 的授权或存储边界。

固定版本的 `@oomol-lab/open-connector@1.3.4` artifact 从 commit
`0cb0e0dd2ed686fa7fa2ff8d9eef97a7d6b31674` 构建，并已完成本地审核。该 package 为 private，
没有暴露可嵌入的 `exports`/`main` runtime API。可用的 Provider executor 模块依赖 private 内部
runtime type、受保护的 fetch context、Provider Loader 和 SQLite Runtime Store。

## 决策

Connection 使用 `packages/openconnector-kernel` 中受控复制的最小 GitHub
Provider Kernel。该副本固定到已审核 commit，保留 `LICENSE.txt` 和 `NOTICE.md`，并且只能通过
`packages/openconnector-adapter` 使用。Connection 不导入上游 Runtime Server、Provider Loader、
SQLite Store、Web Console 或 Credential Store；Adapter 是唯一依赖该 Kernel 的模块。

本决策只批准实现，不批准发布。在完成 Legal/Security 审核、SBOM 与依赖 triage、兼容性证据和 HLD
ProviderRelease 门禁前，该 artifact 不能成为生产 ProviderRelease。

完整 OpenConnector Runtime 的本机构建只保留为 Provider 来源与兼容性证据，不进入正式部署，
也不能作为 Connection Account、Credential store 或 Consumer endpoint。

## 证据

- `archive/openconnector/oomol-lab-open-connector-1.3.4.tgz`
- `docs/architecture/openconnector-kernel-build.md`
- `docs/architecture/HLD-connection-M1.md`, sections 10 and 18
- `packages/openconnector-kernel/PROVENANCE.json` 记录 source commit、artifact digest 和复制文件
  allowlist。
- 生产 Docker 构建包含 Kernel 与 Adapter，同时排除上游 Runtime Server 和 SQLite Runtime。
