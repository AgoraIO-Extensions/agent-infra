# ADR-0043：限制运维观测的集群元数据读取

现有 Worker 权限以 namespace 为边界，但节点容量与 ACK ImageCache 属于集群范围，单靠
namespace 内对象不能完整解释资源和镜像准备瓶颈。优先复用已有指标后端；部署需要直接读取时，
允许 Worker 获得默认关闭、显式启用的集群只读例外，资源和动词白名单、对外投影范围统一见
[工程 Spec §18.2.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1821-资源口径与可信关联)。

沿现有 Worker 采集和 Platform DB 投影可以保留 API 的部署位置无关性，避免新增持有 Kubernetes
凭证的 API 或独立观测服务。代价是受信 Worker 能读取白名单中的集群元数据；应用层筛选不能
替代 Kubernetes 授权，部署必须明确接受这个读取范围。既有 namespace 写权限、业务生命周期和
Agent 隔离规则保持原语义。

本决策随文档评审采纳；实际启用、权限发布及现场验证由部署流程单独完成。
