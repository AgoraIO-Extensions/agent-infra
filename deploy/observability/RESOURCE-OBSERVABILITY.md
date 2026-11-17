# 管理员资源观测接入

产品范围和读取边界分别见 [PRD §14.2](../../docs/prd/PRD-agent-platform-M1.md#142-运维观测)、
[工程 Spec §18.2](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#182-运行指标与故障)。
本页说明装配与验证方式；源码、受控测试和正式环境可用性分别记录。

## 组件与配置

Worker 从部署批准的 Kubernetes 资源及 Metrics API 采样，在 Platform DB 保存一个有界当前投影，
并保存已验证资源 UID 与 Agent/Session 的短期关联用于历史查询。该读模型不修改业务预算、charge
或生命周期。API 读取投影并验证系统管理员身份，浏览器仅使用正式生成客户端。
历史指标查询优先复用现有 ARMS；日志与 Trace 后端通过单独配置的授权入口访问。

API 和 Worker 使用相同的版本化配置 Secret。`configuration.json` 内容示例：

```json
{
  "schemaVersion": 2,
  "enabled": true,
  "scope": { "clusterId": "approved-cluster-id", "namespace": "approved-namespace" },
  "readCluster": false,
  "cacheOwner": "agent-infra-release-cache-v1",
  "cacheInventoryLimit": 48,
  "intervalSeconds": 30,
  "workloadNamespaceRef": "approved-workload-namespace-ref",
  "alerts": { "capacityRatio": 0.9, "criticalRatio": 0.95, "queueCount": 100 }
}
```

`workloadNamespaceRef` 必须匹配现有 Workload 部署策略引用，不能用 namespace 名称猜测。
缺少可信映射或对象身份时归属保持未知。Agent 的 executor 是同一 Sandbox Pod 的容器，
实测按容器汇总，Pod 数不重复计算。

ACK values 通过 `operations.enabled` 启用挂载，`operations.configurationSecret` 引用已存在的
版本化 Secret；两个进程读取 `/var/run/agent-infra/operations/configuration.json`。
非 ACK 装配可显式配置 `AGENT_INFRA_OPERATIONS_CONFIG_FILE` 的绝对路径。
默认未启用；配置或采集故障不会改变原业务启动或任务结果。

## 权限与数据范围

默认只增加 namespace 内的 Pod/PVC/事件/配额、控制器链和容器指标只读权限。
同时设置 JSON 的 `readCluster` 与 values 的 `operations.clusterReads` 才会采集集群节点、
节点指标和 ImageCache。ClusterRole 只有这三类资源的 `get/list`，不包含跨 namespace
的 Pod/Secret/ConfigMap 读取或写权限，API 的 ServiceAccount token 仍不挂载。

集群级 `list` 权限可看到整类元数据；cache-owner 只限制采集输出，不能充当 RBAC 隔离。
实际启用前由部署负责人核实 cluster/namespace 身份、只读范围与配置 revision；不能用
Chart 默认配额或过往环境状态代签。ECI 虚拟节点的百分比不表示云端剩余容量。

## ARMS、日志与 Trace

配置可以增加以下对象。地址、认证和保留期必须来自当前获准后端的实际设置，不自动创建资源或购买容量。

```json
{
  "prometheus": {
    "endpoint": "https://prometheus.example.invalid/approved-instance",
    "tokenFile": "/var/run/agent-infra/operations/prometheus-token",
    "detailDays": 7,
    "aggregateDays": 30,
    "aggregateStepSeconds": 300
  },
  "logs": { "url": "https://logs.example.invalid/explore", "retentionDays": 7 },
  "traces": { "url": "https://traces.example.invalid/explore", "retentionDays": 7 }
}
```

`endpoint` 是实例的 HTTP API 基址；只使用 `query`/`query_range`，不是 OTLP 接收地址。
当前客户端支持服务端 Bearer token 文件或已经获准的无额外认证查询入口，禁止内联凭据、
带凭据 URL 和重定向。需要其他云认证方式的实例须由部署提供相应的获准查询接入；不能借
Kubernetes 权限代替云查询授权。原始凭据不进入 API 投影、日志或错误。

历史查询固定 namespace 和指标集合，不接受客户端 PromQL。Agent/Session 历史按采集时验证并
保存的 Pod UID 与 `kube_pod_info` 关联；UID 不匹配和未被本采集器观察过的时间不冒充该 Agent
历史。PVC 与节点指标若不带 UID，只在采集器记录的同 UID 首末观察区间内按名称关联；同名身份区间重叠或无法确认时不返回该点，避免跨重建串线。
查询与输出限制时间范围、序列数和响应大小；没有样本、未知数值与后端失败分别表达。

平台业务指标需要观测后端附加正确的 namespace 标签，并保留仓库既有 service/stage/outcome/kind
语义。平台指标不存在时历史图显示缺失，不自动建立 Collector 或把整次任务耗时解释为模型耗时。
只配置日志/Trace URL 不证明数据已接收；页面保留其未验证状态。

保留目标是 7 天细粒度与日志/Trace、30 天的五分钟聚合。示例保留期不证明后端实际设置或完整历史
已存在，页面实际覆盖须以样本与部署核实为准。增加采集量、存储或保留期前列出费用增量，取得负责人确认。

PostgreSQL 连接视图只聚合当前 API 数据库账号的活动、空闲、事务内空闲和锁等待，以及当前库总连接数和服务端上限；不查询或返回 SQL/会话正文。连接计数包含观测查询自身，服务端上限可能由多个数据库共享。依赖耗时曲线沿用既有有界观测，不冒充全部 SQL 的完整平均耗时。

## 页面告警与验证

默认容量阈值为 90%，95% 显示严重，队列阈值为 100；按实际部署容量调整。
规则读取样本、预算和积压，合并相同对象/原因并保留首次、最近和恢复；来源不可用期间不推定原故障恢复。
页面告警没有外部通知，也不会扩容、清理、调整准入或重放业务。

验证先沿管理员 HTTP 查询到 `/ops`，检查实测/申请/预算口径、可信 UID、零值与缺失、普通用户与
撤权拒绝、单来源故障和告警恢复。受控 PostgreSQL/数据源样本只证明对应代码行为。
正式接入须回读当前 source、image、配置、权限、样本时间、后端查询和保留范围；专项配额耗尽、
OOM、缓存过期、积压及后端中断演练按已确认顺序在实现后安排。
