# ADR: OpenConnector Runtime 与企业 Connection Profile

## 状态

已被 [Connection Account 与公司 LDAP 身份](ADR-connection-account-ldap.md) 取代。

## 背景

本机 Codex 的消费模型是单一 installation：调用者不需要提交公司用户身份，OAuth、Connection
alias 和 Credential 都属于本机 Runtime，但 Consumer 仍只连接 Connection façade。把这一模型
强行套入企业
`Principal/Consumer/Grant` 体系会产生无效的 OIDC 配置、伪造的本机用户和重复的 OAuth/storage
逻辑。

OpenConnector 已经提供本机 Runtime 所需的 installation scope、OAuth、Credential、Action 和
MCP/HTTP 运行模型。企业远程场景仍需要公司身份、多个 Consumer/Instance、跨用户隔离、审计、
撤销、PostgreSQL 权威和可靠副作用控制，这些不是 OpenConnector Runtime token 或本机 alias 能
替代的。

## 决策

Connection M1 明确定义两个 profile：

1. `LOCAL_SINGLE_USER` 由 Connection 本机 façade 私下部署或嵌入固定版本的 OpenConnector
   Runtime。Runtime 本机 store 是 installation 范围内的账号/凭证权威；Connection façade 是唯一
   Consumer endpoint，使用独立的高熵 Connection capability，只允许 loopback/Unix socket，并持有
   不向 Consumer 暴露的 Runtime token。该 profile 不创建公司 USER Principal，不要求公司 OIDC，
   也不接受请求中的 `userId`、`principalId` 或远程 Connection selector。
2. `REMOTE_SHARED` 使用 `connection-api` 和 Connection PostgreSQL。它在 OpenConnector 固定版本
   的 Provider/Action/OAuth/executor 之上增加公司 OIDC、Principal、Consumer/Instance、Grant、
   Credential、Call/Effect/Dispatch、受控 egress、审计和恢复。调用者身份和 Connection/Account
   选择均由服务端解析，不能由请求体决定。

两种 profile 共享 Connection 对外入口、Provider 安全原则和版本化 Action 契约，但不共享身份、
存储权威或调用者语义。
本机 Runtime 的本地 token、SQLite/store、alias 和 OAuth transaction 不写入企业 Connection DB；
企业数据库中的 Principal/Grant 也不参与本机调用。

## 影响

- `REMOTE_SHARED` 的 Connection Domain 不依赖 OpenConnector Runtime API，只通过
  `openconnector-adapter` 使用 pinned kernel。
- `LOCAL_SINGLE_USER` 的 Connection façade 可以私下复用 OpenConnector Runtime Server，但该 Runtime artifact 必须从固定
  commit 单独构建、记录 digest、许可证/SBOM 和安全证据；不能把当前仅含 Provider execution
  closure 的 `packages/openconnector-kernel` 宣称为完整 Runtime。
- façade 必须把 MCP identity、Action guide 和调用约束投影为 Connection，不能向 Consumer 返回
  Runtime endpoint 或直连示例。通用 `execute_action` 的写调用要求稳定 `idempotencyKey`，由 façade
  从 Provider input 中剥离后绑定私有 Runtime 幂等记录。
- 本机不需要公司 OIDC 或伪造 Grant 表；Connection capability 负责 Consumer 入口撤销，Runtime
  本地 store 负责账号、凭证和执行审计。
- 远程企业 profile 不能把 OpenConnector Runtime Server、Runtime token、global alias 或 SQLite
  作为多租户授权权威。

## 已拒绝方案

- 用环境变量缺失隐式切换到“匿名”模式：无法审计，容易把远程部署错误降级为无身份服务。
- 为本机安装创建普通 USER Principal 并复用企业 Grant：语义错误且引入无用 OIDC/Consumer 状态。
- 直接把 OpenConnector Runtime Server 暴露给任何 Consumer：绕过 Connection 的唯一入口、
  capability、审计与稳定契约。

## 取代原因

该决策把本机 installation 当成身份和 Credential 权威。同一员工使用多台电脑时会形成多套
SQLite、多个安装身份和重复的 Provider OAuth，无法满足跨设备共享个人 Connection 的产品要求。
Connection M1 现统一使用账号级 Principal、PostgreSQL 和服务端 Credential 权威；本机组件若保留，
只能作为无状态 edge，不能继续使用本 ADR 的 installation 身份或本机 store 语义。

以下内容只保留为历史记录，不再作为实现或部署依据。

## 证据与后续工作

- 固定源码和当前 kernel 复制清单：[`openconnector-kernel-build.md`](../architecture/openconnector-kernel-build.md)。
- HLD profile 与 Direct Session：[`HLD-connection-M1.md`](../architecture/HLD-connection-M1.md)。
- 已构建的本机 Runtime artifact 和真实 GitHub OAuth/Action 结果只证明 Provider 资产可复用，
  不证明 installation 身份、本机 SQLite 或两套 profile 仍是目标架构。
