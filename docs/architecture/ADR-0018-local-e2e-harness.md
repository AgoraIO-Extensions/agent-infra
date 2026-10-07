# ADR-0018：固定环境的本地 E2E Harness

## 状态

已接受

## 背景

本地 E2E 曾从脏 worktree、旧镜像和多个 Colima/kind 环境启动。Compose、Helm、Worker
私有配置和 Runtime Digest 由不同入口维护，导致磁盘/DNS、Registry 准入、私有依赖导入、
模型预检和 Runtime readiness 的失败只能在 Pod 反复重启后发现。

## 决策

使用一个固定命名的 Harness 作为本地 E2E 入口。它按当前 branch 的 upstream 同步
`sourceRevision`，允许当前 branch 在 upstream 之上，拒绝落后未快进、分叉和 tracked 修改，用 tracked archive/临时 worktree 构建，记录
`imageBundle`，并复用现有 `platform.sh` 管理数据、迁移、Helm Worker 和停止流程。

Kubernetes 调度 Worker、目录同步、Runtime Host 和 Sandbox/Base 镜像通过 GitHub Actions
发布到 GHCR 并按多架构 Digest 复用；开发分支缺少镜像时允许本地当前架构构建并推送
GHCR。Platform Web/API 等业务镜像只在 release/tag 或手动发布时由 GitHub Actions 发布，
本地 E2E 从当前 sourceRevision 构建。

API/Worker 继续使用部署 adapter 契约。adapter 可以从 env 和 `_FILE` 读取基础输入，但
真实身份、目录、Registry、ModelCatalog、Kubernetes、签名和 keyring 必须由受审阅 factory
组装，并在最终镜像和挂载下执行 import/startup probe。

## 取舍

固定名称降低多 session 误操作概率；ownership 校验承担资源安全边界。远端 GHCR 提供可复用
Digest，开发分支的本地 fallback 牺牲一次构建时间换取当前架构的快速验证。Harness 不用
mock、静态 healthz、wrapper 或上游 patch 代替真实 Runtime 和模型门禁。

## 结果

后续 E2E 证据必须同时绑定 `sourceRevision`、镜像 Digest、Helm release、namespace 和
脱敏配置/就绪结果。完整业务验收仍由浏览器和真实模型流程完成，Harness 不把部署就绪
冒充业务成功。
