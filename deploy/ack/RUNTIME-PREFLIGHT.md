# ACK Runtime 隔离预检

Worker 可运行在 ECI。Runtime 的系统要求按 Driver 单独确认；Codex 默认需要镜像中包含新版
`setpriv`，并由目标内核实际安装 Landlock ABI 5 的 `ioctl-dev` 规则。容器镜像不能补齐
宿主内核缺失的能力。经 ADR-0035 评审的标准 Runtime Pod 可使用 Worker-owned
`container-boundary` 模式，由专属 Pod/PVC/NetworkPolicy 和 Codex `workspace-write` 承担
边界；该模式必须单独做 Pod 安全上下文、跨 Session 负例和真实工具验收，不能用 Landlock
预检结果冒充。Pi 等 Messages Driver 不能替 Codex 通过任一检查。

## Session 独立 executor

当目标环境缺少 namespace/Landlock 能力时，标准 Codex 业务 Session 可以选择
[独立 executor](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#1121-codex-session-独立-executor提案)。
它复用现有 Session Pod，由独立无凭据容器执行命令与文件 I/O；不需要 RAM 登录或新增节点池。
在 Worker 私有部署模块的 `policy` 中显式增加以下配置，旧 `codexContainerBoundaryEnabled`
不启用本模式：

```typescript
codexSessionExecutor: {
  resources: {
    requests: { cpu: "250m", memory: "256Mi" },
    limits: { cpu: "1", memory: "512Mi" },
  },
  tmpSizeLimit: "128Mi",
  // 与该 release 的 Session ECI admission / Runtime image 架构一致。
  placement: { architecture: "amd64" },
}
```

资源值只是格式示例，须按真实执行负载批准。`placement` 是可信部署输入：未配置时不添加调度字段；
ECI 使用精确架构/virtual-kubelet selector 与 provider toleration，RuntimeClass 则显式设置
`runtimeClassName` 并跳过 ECI 字段。它必须与该 release 的实际准入策略一致，漂移仍拒绝。控制容器与 executor 的 limits 总和进入 Store
资源费用；部署须提供新资源摘要对应的足额 `resourceCosts`，缺失或低报在启动前拒绝。
首版不接受该模式的预留 reserve，须使用正式分配的新 Session；旧 reserves 不被升级或冒名采用。
API/Worker/Runtime 镜像和配置仍沿正式 bootstrap/deploy/runtime-inputs 流程交付。

保持普通节点继承调度时，四个预检 job 与 executor policy 均省略 `placement`，不临时增加
selector、toleration 或 RuntimeClass。沿既有 `expectedNodePrefix` 字段填写本次可信目标的
完整节点名；该分支要求实际调度节点精确匹配，并回读其 UID、Linux/amd64 架构。调度到其他
节点或被注入 ECI 字段均拒绝；显式 ECI 分支保持原 selector、provider toleration 和缓存门禁。

正式 `template-preflight` 的四个 job 与容量输入必须声明相同的 `resourceProfileRef`、
`resources`、`codexSessionExecutor`、`storageSize` 和 `storageClassName`；已有
`workspaceSnapshotEgress` 也属于资源摘要，不能在发布时省略。未声明 executor 的旧 job
继续沿原单容器路径，不得拿它的测量回执启用新模式。

控制容器的 `resources` 和 `expectedResourceLimits` 保留完整 CPU、memory 及已声明的
`ephemeral-storage`，四 job 不得混用不同声明。executor/init 仍只接受原 CPU/memory 资源。
原 portable 资源摘要和费用公式不变；新模式另逐项比较控制资源的完整键集与等值数量，
容量回执字节摘要和 mounted Worker 检查共同绑定声明。缺失、额外键或数量漂移均拒绝，
不能用相同 portable 摘要掩盖 ephemeral-storage 差异。

启用新模式的 Codex job 创建独立、带 ownership 的临时 PVC、初始化容器、控制容器和 executor，
绑定固定的合成 Conversation 与代次。模型凭据只在控制侧；实际 Pod/PVC、初始化终态、
容器实例、资源和挂载回读匹配后才生成容量回执。回执同时保存共享资源摘要、控制与执行容器
资源及派生费用；其他模板仍为单容器，其摘要绑定同一部署策略，费用只证明自身实际布局。
新容量 job 还须声明获准的 `modelEgress` 和 `dnsEgress`；模型出口只接受精确 IP 与模型
端口，DNS 只接受精确 IP 或非空 namespace/Pod 选择器。预检创建独立 ServiceAccount 和
默认拒绝入站、出站的 NetworkPolicy，只放行这些出口。ECI 添加的 region/zone 标签须在
`allowedPodTopologyLabelValues` 中明确允许。结束后只清理本次拥有的临时资源。
该独立预检只提供模板与容量证据，NetworkPolicy 回读不代表数据面隔离或真实业务 Session 验收。

已有环境先从当前 release 只读采集候选，保留历史绑定和无关配置键。新增 owned 配置 Secret
名称并在候选 values 中绑定，经正式 `bootstrap-inputs`、Helm `deploy` 和 `runtime-inputs`
采用；既有数据库使用 `initializeDatabase=false`。发布门禁与部署后 mounted-capacity 检查
使用同一资源摘要，并核对 Worker 实际加载的 executor、快照出口和存储策略。不能手工改摘要、
补造测量或覆盖旧状态绕过资源不足与配置漂移。

首次采用 executor 使用既有空 reserve `profiles: []` 冷分配路径，保留历史成本与 charge，
追加新布局的足额成本。已有 reserve 由 Worker 正式退休并回读；活动或 unknown 未收敛时
停止采用。非空旧 reserve profiles 与混合资源摘要仍拒绝，不删旧成本或手工改 Pod/PVC。

Worker 创建精确工作区 `subPath`，只向控制容器注入签名绑定及派生服务 token；executor 不拿
Host Secret/PVC 根/历史或模型凭据，不共享 PID，只有固定 loopback 执行端点。
受信启动程序在业务开放前完成独立合成目录的执行/读写检查；readiness 只读核对绑定、实例和活性。
断连使当前实例准入永久失效，不自动重连为原执行担保。正式 Worker 替换准备须先通过 Store
停止回执、执行占用和保留 PVC UID 校验；只有同一 Conversation/代次的全部既有工作均为已知
终态，且本次已验证绑定的 resource fence 更高时，Driver 才更新执行边界要求并恢复后续新 Turn。
旧操作、历史和事实不改写；unknown/在途不据新实例补造终态。同 fence 替换会被持久 epoch
拒绝，不能删除该记录、手工改 PVC/DB 或重复投递命令来恢复。

采用前须在目标同版本镜像上完成真实 shell/patch/图片与搜索、凭据/进程/文件/跨 Session 负向、
取消/后台进程/重启恢复，以及 Web/企微和 PNG/PDF 字节/hash 验收。配置、Pod Ready 和离线
模型替身均不能代签。未启用时原 Landlock、`container-boundary` 与 RuntimeClass 路径保持。

## Cluster-provided RuntimeClass

当当前节点/ECI 不支持 bwrap 所需的 user/mount/pid namespace 时，部署可以为 Session
Sandbox 选择一个由集群管理员提供的 `RuntimeClass`（例如 ACK Sandboxed Container V2/runV）。
在私有 values 中设置 `sessionRuntimeScheduling.runtimeClassName` 后，Admission Policy 会给
受管 Session Pod 注入该 RuntimeClass 和架构 selector，并跳过 ECI `virtual-kubelet` selector
与 toleration。Chart 不创建或伪造 RuntimeClass handler；handler、专用节点池、RuntimeClass
调度规则和 NetworkPolicy 能力由 SRE 提供。

启用前须核对 RuntimeClass 提供方支持的集群版本。
[ACK runV 支持范围](https://www.alibabacloud.com/help/en/ack/ack-managed-and-ack-dedicated/user-guide/overview-10/)
当前列出 Kubernetes 1.16–1.34，而本 Chart 的 Session 准入策略要求 1.36 及以上；在提供方确认
目标版本兼容前，不能把 `runtimeClassName: runv` 示例视为该版本可部署方案。

该模式的独立探针使用同一 pinned image 和安全上下文创建短生命周期 Pod：设置
`ACK_RUNTIME_CLASS=<cluster-runtime-class>` 后运行
`node deploy/ack/runtime-isolation-preflight.mjs`，脚本会执行
`bwrap --unshare-user --unshare-pid --unshare-net ... /bin/true`。未设置该环境变量时，脚本
保持默认的 Landlock ABI V5 `setpriv` 探针；两种结果不能互相代签。探针只验证 namespace
能力，不注入模型凭证，也不代表真实业务回合通过。

该模式仍使用 Worker-owned `container-boundary`、专属 PVC/ServiceAccount/Secret、non-root、
只读 rootfs、drop ALL、no-new-privileges 和 RuntimeDefault。启用前必须用相同 pinned Runtime
image 和安全上下文执行真实 bwrap/user/mount/pid namespace、工作区写入、跨 Session 隔离、
网络拒绝、取消/重启 probe；通过后再执行真实 Codex 模型和 PNG/PDF 字节/hash 验收。仅有
RuntimeClass、Pod Ready 或 handler 配置不能代替 capability probe。ECI image cache admission
与 RuntimeClass 模式不能同时启用。

镜像使用正式 `deploy/release/build-images.mjs` 或 `publish-images` workflow 的产物，
从发布 receipt 选择节点架构对应的 OCI image manifest Digest。不要使用 tag、multi-arch
index 或临时简化的 Dockerfile。每个模板仍需同一 image/Driver/configurationRevision 的真实
模型验证记录；模型端点和 Key 通过已有私有配置及 Secret 交付。

在仓库外的环境文件设置 `ACK_KUBECONFIG`、`ACK_RUNTIME_IMAGE`（完整 `repository@sha256:…`）
与 `ACK_NAMESPACE`。私有镜像可设置 `ACK_IMAGE_PULL_SECRET`。需要指定节点时，设置
`ACK_RUNTIME_PLACEMENT_FILE` 指向仓库外 JSON；它只接受 `labels`、`annotations`、
`nodeSelector`、`tolerations`，内容须与待部署 Runtime 的实际调度条件一致。

```bash
ACK_RUNTIME_DRIVER=codex node deploy/ack/runtime-isolation-preflight.mjs
```

脚本创建唯一命名的无凭证 Pod，按 non-root、read-only rootfs、禁提权、drop ALL 和
RuntimeDefault seccomp 执行真实规则安装。调度、拉取、工具或内核失败均返回非零；结束前
核对 ownership 再清理。namespace 应预留 1 CPU / 2 GiB limits 配额。它只验证该目标的
Codex 隔离能力，不验证网络、模型或用户业务流程。

ECI 的 NetworkPolicy 需要 ACK 的 Poseidon 支持，ECS 的 Terway 配置不能替 ECI 生效。
部署方须按[阿里云 ECI NetworkPolicy 文档](https://www.alibabacloud.com/help/en/ack/serverless-kubernetes/user-guide/using-the-network-policy-networkpolicy)
启用组件，并实际验证已知可达目标在 deny-all 后不可达、放行后恢复。仅创建 NetworkPolicy
对象不能证明隔离成立。ESSD 持久卷还须满足 StorageClass 最小容量及 namespace quota。

完整验收顺序：目标节点隔离与网络检查、同一不可变镜像的真实模型验证、浏览器申请/审批、
Worker 创建 Session Pod/PVC、实际回复和 SSE 回读。组件 readiness 与受控 fixture 均不能
替代后续步骤。
