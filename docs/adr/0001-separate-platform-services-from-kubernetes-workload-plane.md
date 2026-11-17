# Platform 服务与 Kubernetes Workload Plane 分离

Web 和 `platform-api` 保持部署位置无关；`platform-worker`、KubernetesRuntimeAdapter、Agent Workload 和部署访问路由组成 Kubernetes Workload Plane。只有 `platform-worker` 获得 namespace-scoped Kubernetes 权限，Platform 服务通过 Platform DB 状态与 outbox 和它协作。这样既允许拆分部署，也不会把 Kubernetes 凭证暴露给浏览器、API、Connection 或 Agent 进程。

运维观测可由部署显式批准额外的受限集群只读权限，例外边界见
[ADR-0043](./0043-bounded-operations-cluster-reads.md) 与其引用的工程 Spec；既有 Workload
写权限仍限制在 namespace 内，API 不因此获得 Kubernetes 权限。
