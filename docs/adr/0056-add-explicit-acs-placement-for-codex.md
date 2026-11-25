# ADR-0056：通过部署配置为 Codex 增加显式 ACS 算力

运维需要在同一 ACK 中按需选择 ACS，同时保留 ECI 和既有 Agent / Session 生命周期。决定复用
现有 Kubernetes 调谐链路，以 Helm / env 分别配置 Agent Workload 和 Session Sandbox 的算力，
不引入通用多云适配层；范围与安全门禁统一维护在
[工程 Spec §10.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#101-workload-形态)。

算力类型必须参与可信调度输入和验收证据的绑定。两个后端可共享虚拟节点，因此节点名或
旧 ECI 结果不足以证明 ACS 的数据面与原生隔离能力。能力验证失败时停止采用，不能通过
自动换算力、放宽 Codex 保护或关闭严格缓存绕过。

采用显式选择而非自动混合调度：创建失败仍沿原后端和现有重试规则收口，存量也不因发布配置
而迁移。这使运维能够逐个验收算力组合，并保持原资源身份和未知执行结果的恢复语义。
