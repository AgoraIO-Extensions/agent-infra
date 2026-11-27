# ADR-0058：通过部署配置为 Codex SDK 增加显式 ACS 算力

运维需要在同一 ACK 中按需选择 ACS，同时保留 ECI 和既有 Agent / Session 生命周期。决定复用
现有 Kubernetes 调谐链路，以 Helm / env 分别配置 Agent Workload 和 Session Sandbox 的算力，
不引入通用云适配层。首条 ACS 业务路径使用
[ADR-0056 的 Paseo SDK 轻量模式](0056-lightweight-paseo-sdk-magic-sandbox-m1.md)；
范围和资源约束维护在[工程 Spec §10.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#101-workload-形态)。

算力是可信部署输入，须绑定实际实例、受控 metadata、SDK/companion 容器、资源预算及恢复身份。
两个后端共享虚拟节点时，节点名或 ECI 回执不能证明 ACS 实例归属。Shell、Landlock 和
NetworkPolicy 的探针结果分别记录，只限制依赖该能力的操作，不构成所有 SDK 对话和原生命令的
共同前置；主体、会话、工作区与凭据隔离仍须验收。旧 Native 的模式检查保留在旧路径内。

采用显式选择而非自动混合调度：创建失败仍沿原后端和既有规则收口，存量不因发布配置而迁移。
恢复保留原 transport、Sandbox、PVC、allocation 和 fence，未知执行不重放。首版仅开放标准
Codex CPU general-purpose / amd64 / default QoS 的按需创建，不重启暂缓的 Landlock 节点池工作。
