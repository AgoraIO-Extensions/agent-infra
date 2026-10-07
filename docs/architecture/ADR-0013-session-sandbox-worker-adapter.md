# ADR-0013：Session-owned Sandbox 的 Worker 资源交接

状态：Accepted for #1251 implementation seam

## 决策

Platform Worker 只消费 Platform Store 提供的当前 `Session → Sandbox` allocation，不读取 allocation 表，也不创建第二套事务或调度循环。当前 #1250 尚未合并时，交接使用 `SessionSandboxAllocationV1` typed boundary，字段必须包含：`agentId`、`sessionId`、`sandboxId`、`generation`、`fence`、namespace、六个资源名、不可变 image digest、容器端口、workspace mount path，以及 Worker 组装的 Runtime 投影输入（#1466）。

Worker adapter 为一个 Sandbox 管理一个 Pod、ClusterIP Service、ServiceAccount、保留型 ReadWriteOnce PVC、NetworkPolicy 和该 Sandbox 专属 Secret。普通 cleanup 只回收计算、入口、凭据和身份资源，保留 PVC；显式销毁工作区必须由未来 Store 事务授权。六类资源都写入有界的 Agent、Session 引用标签（`agent-ref`、`session-ref`，取 ID 的 SHA-256 前 32 位）及 Sandbox、generation 标签，完整 Agent/Session ID 与 fence 写入 annotation，并要求 managed marker；Kubernetes 标签值不超过 63 字符，真实 Agent ID 不能直接作标签值（#1461）。读取到标签、managed marker 或 fence 不匹配的同名资源时拒绝操作；旧 generation/fence 不得覆盖或删除当前资源。PVC 不跨 fence 替换，必须由 Store 分配的新 Sandbox 名称承载新工作区。

专属 Secret 不可变，只含该 Sandbox 派生的 transport token 和 verified V4 投影的非敏感模型配置；Pod 以 secretKeyRef 引用两者，安全上下文与 Agent 级 Workload 一致。Store claim 原样携带 verified 投影，Worker 只接受 V4 无 Key 投影并在任何写入前拒绝其他输入，不自行推导，也不挂载 Agent 级 Secret。完整契约以[工程 Spec §10.1.1](SPEC-agent-infra-M1-engineering-architecture.md#1011-session-owned-sandbox-权威与资源绑定) 为准。#1466 之前创建的 Session Pod 不含这些输入，按既有 fail-closed 语义判为 conflict 或 unknown，不原地修复。

资源编排属于已有 Worker tick/reconciliation 的一次调用。adapter 不轮询、不持久化 allocation，不改变 Platform 权威状态；健康、停止、恢复和未知结果仍由现有 Store contract 写回。

## #1250 合并后的集成手册

1250 合并后，将 Store 返回的 allocation 映射为 `SessionSandboxAllocationV1` 并在同一 `runNext` transaction snapshot 中调用 adapter。映射必须保留 Store 的 generation/fence；调用方提交的 sandbox ID、资源名或身份字段不得覆盖 Store 值。若 #1250 字段名或状态枚举不同，只在该映射处调整，不在 Worker adapter 中复制查询或授权逻辑。

此 ADR 不把本地 fake、资源清单或单元测试当作 kind 隔离验收；两个 Session 的真实资源和负向访问证据由后续集成验收补齐。#1248/#1250 集成还必须把 Store 的资源 UID、配置/Workload revision、approved DNS/model/Connection egress、runtime readiness/route-close 结果映射到此 seam；本文件不复制这些事实或增加 poller。
