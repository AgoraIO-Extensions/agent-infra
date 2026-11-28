# ACK Runtime 隔离预检

M1 的 Paseo SDK 轻量路径遵循 [ADR-0056](../../docs/adr/0056-lightweight-paseo-sdk-magic-sandbox-m1.md)。
Shell、Landlock、NetworkPolicy 分别报告能力；以下 Native/隔离预检只约束适用模式，
不能作为全部 SDK 对话或原生命令的共同前置。ACS 的 SDK 部署选择见
[ADR-0058](../../docs/adr/0058-add-explicit-acs-placement-for-codex.md)。

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
节点或被注入 ECI 字段均拒绝；显式 ECI 分支保持原 selector、provider toleration 和已启用的严格缓存准入门禁；
未启用严格缓存准入时的报告口径见[工作流 Spec §10.1](../../docs/architecture/SPEC-ai-native-development-workflow.md#101-ack-镜像缓存部署)。

普通节点分支和下文的 RuntimeClass 分支是通用能力，只适用于已证实际执行 NetworkPolicy 的
环境。本 ACK 的 ECS 节点使用 flannel，不执行 NetworkPolicy，不能用于正式 Agent 或 Session
的准备与采用；正式 job、executor policy 和 Worker placement 都使用显式 ECI 分支，并满足
[工程 Spec §10.1“运行形态与调度”](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#101-workload-形态)
的执行证据门禁。

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
调度规则和 NetworkPolicy 能力由 SRE 提供。RuntimeClass 节点池同样须满足上文的执行证据门禁，
提供方证明前不作为本 ACK 的正式运行形态。

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

预检回执记录实际 Pod UID、节点、可读的内核版本和失败阶段。本段的 Landlock 规则安装要求适用于
使用 Landlock 的 Native 路径；安装返回 `landlock_unavailable` 时，应先落实支持所需 ABI 的运行环境，
再进行该路径的业务准入。#4405 的轻量 RuntimeHost/Paseo SDK 试验按
[Core 冷启动契约](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#隔离环境的-sig-core-冷启动试验)
核对业务就绪与可选加固边界，不以本段的原生规则安装作为普通 SDK 消息的前置。

ECI 的 NetworkPolicy 需要 ACK 的 Poseidon 支持，ECS 的 Terway 配置不能替 ECI 生效。
部署方须按[阿里云 ECI NetworkPolicy 文档](https://www.alibabacloud.com/help/en/ack/serverless-kubernetes/user-guide/using-the-network-policy-networkpolicy)
启用组件，并实际验证已知可达目标在 deny-all 后不可达、放行后恢复。仅创建 NetworkPolicy
对象不能证明隔离成立。ESSD 持久卷还须满足 StorageClass 最小容量及 namespace quota。

## NetworkPolicy 执行证据门禁

`preflight.sh`（`deploy.sh` 与 `redeploy.sh` 都会调用）在渲染 chart 之后、读取部署依赖之前运行
`deploy/ack/networkpolicy-enforcement.mjs`；`redeploy.sh template-preflight` 在创建模板 Pod 之前
先渲染 chart 再运行它。规则见
[工程 Spec §10.1“运行形态与调度”](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#101-workload-形态)。
它只读：读取证据文件和本次渲染结果，执行 `kubectl get` 读取 namespace、`kube-system`、
Node 与带 `agent-infra.agora.io/agent` 标签的 StatefulSet/Deployment/Job。它不读取探针目标
Pod 或原 NetworkPolicy（探针对象已删除），不创建探针，也不写集群。
旧 Native 模式任一输入缺失或不符都以退出码 2 失败，stderr 只输出固定原因码，不输出凭据或对象正文。
混合部署保留适用的 Native 门禁。Helm 选用 ACS 时，独立 Codex SDK 预检先核对唯一 Job 的
算力、transport、镜像和安装目标。未提供网络探针回执时，该次测量记录网络能力为 `unknown`；
提供回执时继续校验。独立 SDK 预检根据实际 Job 的 transport 渲染轻量模式，
不能用期望文件替实际部署选择放宽门禁。

普通 ACS 发布的 `deploy.sh` 和 `redeploy.sh deploy` 使用本次升级的 Helm 参数渲染，再将该清单交给预检。
预检读取仍能写入的 Worker，以及现存的 Agent 控制器和 Session Pod、StatefulSet。每个候选节点须有上述资源可使用的每种算力的回执。
ACS 切换期间，仍在工作的副本须能绑定到候选 Worker 的镜像、有效网络配置和不可变配置文件。无法绑定时报告原因。

Session 可以在 Pod 已删除后按原 allocation 恢复。普通发布的 Kubernetes 准入策略在重新创建 Pod 时核对原算力。
需要保留另一种算力恢复能力时，可在探针计划的 Helm values 设置 `sessionRuntimeScheduling.retainBothComputes=true`。
两个发布入口读到两种算力的回执时会自动保留两者，并逐节点验证。单一算力回执仅允许对应算力创建 Session Pod；
另一算力上的原 allocation 和 PVC 可在覆盖其算力的发布后继续恢复。缺少回执时返回 `EVIDENCE_REQUIRED`、
`networkPolicy: unknown`、渲染摘要和现场资源数。普通 SDK 业务操作的准入由
[#4646](https://github.com/AgoraIO-Extensions/agent-infra/issues/4646) 跟踪。

在 [#4405 隔离 SDK 试验](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#隔离环境的-sig-core-冷启动试验)中，
使用 `sigCorePilot: new` 并将 `sigCoreSdkTrialImage` 设为该次发布的官方 Codex 完整镜像引用。
`redeploy.sh deploy --codex-trial`、`template-preflight --codex-trial`、`runtime-inputs --codex-trial`
分别部署、验证单个 Codex 模板和发布验证结果。部署和模板预检缺少 NetworkPolicy 执行证据时，
核对 `ACK_TRUSTED_TRIAL_TARGET_FILE`、本次源码及镜像清单、Worker 配置与现场资源；
只接受该试验首次建立业务资源前的状态。回执记录 `networkDataplaneVerified: false`。
提供证据文件时仍按下文验证该文件。专用 namespace 中的直接预检也会读取 Worker 的实际绑定。
撤销试验并完成 Worker 切换后，可按原有执行证据和四模板流程恢复普通部署。

探针何时重跑、其余部署做哪些静态检查、残余风险，只在工程 Spec 该条维护，本节只写文件字段与拒绝条件。

| 环境变量 | 内容 |
| --- | --- |
| `ACK_NETWORKPOLICY_EVIDENCE_FILE` | 已批准的执行证据，`kind: agent-infra-networkpolicy-enforcement-evidence` |
| `ACK_BOOTSTRAP_INPUTS_FILE` | 私有 Secret/ConfigMap 文件引用包（与 `redeploy.sh` 相同的输入）。预检按渲染结果里 Worker 的 `PLATFORM_WORKER_DEPLOYMENT_MODULE` 与 `configuration.mjs` 只读挂载找到本次要部署的 Worker `configuration.mjs`，在只能读该文件副本、无子进程、无原生扩展的隔离子进程里加载它（Node 24 权限模型没有网络开关，加载前锁死 `net`、`tls`、`http2`、`dgram`（含不能创建任何 UDP socket，因此拿不到原生 handle）、`dns`、`fetch`、`WebSocket` 的入口，模块只能看到下列 Worker 网络环境变量（来自渲染结果，不传入运维进程环境），读取（含反射读取）其他环境变量、写入/删除/重定义任何环境变量（即使模块捕获了错误）一律拒绝，负例用可达的本机监听器验证连接数为零），只取 `workloadInput.policy` 的 `workerSelector`、`routeNamespace`、`routeSelector`、`platformApiSelector` 与模型、Connection、原生元数据回调、文件交换、快照、DNS 和原生工具出站字段，`runtimeAuth.fileExchangeOrigin`、模块顶层 `nativeMetadataGateway.port`、是否配置了 `workloadInput.workspaceSnapshotResolver.project`；再用渲染结果里 Worker 容器的 `PLATFORM_WORKER_FILE_EXCHANGE_ORIGIN`、`PLATFORM_WORKER_FILE_EXCHANGE_EGRESS`、`PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_ENABLED`、`PLATFORM_WORKER_NATIVE_METADATA_GATEWAY_PORT`、`PLATFORM_WORKER_NAMESPACE`（`fieldRef: metadata.namespace` 取部署 namespace）与 `PLATFORM_WORKER_RELEASE_NAME`，调用 Worker 同一函数合并最终出站；这些变量用 `secretKeyRef` 等无法读取的来源、容器有 `envFrom`、或合并被 Worker 规则拒绝，一律拒绝；没有独立维护的副本，通过时摘要里记录该文件的 `workerConfigurationSha256`。读取、加载或字段校验失败一律拒绝（模块依赖了隔离环境读不到的文件或包也属于此类） |
| `ACK_RENDERED_MANIFEST_FILE` | 本次 `helm template` 结果；`preflight.sh` 与 `template-preflight` 自动传入 |

证据文件字段（时间都用 UTC `Date#toISOString()` 格式）：

- `cluster`：`kubeSystemNamespaceUid` 与 `clusterId`；`namespace`：`name` 与 `uid`。
- `enforcer`：`runtime: eci`、`component: poseidon`、`version: "unobservable"`（托管侧不可见，
  没有配置回读，也没有 `configSha256`）。
- `placement`：`architecture`、`legacyUnplaced` 与 `selectorSha256`（Worker placement 的
  `nodeSelector` 与 `tolerations` 规范化 JSON 的 SHA-256），必须等于渲染结果中 Worker 容器的
  `AGENT_INFRA_AGENT_WORKLOAD_PLACEMENT`（即 values `agentWorkloadScheduling`，见
  [Worker 部署说明](../platform-worker/README.md#agent-级-workload-placement)）。Worker 拒绝配置
  模块自带 placement，所以这一项绑定的就是 Worker 实际注入的值。
- `nodes`：已证执行的 ECI 虚拟节点 `name` 与 `uid`。
- `probes`：每个可落节点至少一组探针（目标 Pod 运行在该节点上）。`destination` 记录目标 Pod 的 `pod`、`uid`、`nodeName`、`port` 与其
  控制器 `controller`（`kind`、`name`、`uid`）；`policy` 记录原 NetworkPolicy 的 `name`、`uid`、
  所选模板变体 `variant`、替换表 `substitutions`（探针专用的 Agent 选择器与 Worker 来源标签，
  标签条件见 Spec 同条）、`podLabels`（目标、Worker 来源与非 Worker 来源 Pod 的完整标签）与 `instantiatedSha256`（该变体按替换表实例化后的摘要，预检复算）。按顺序记录
  `allow`（Worker 来源连通）、`deny`（施加临时 deny-all 后不通，含该策略 `policyUid`）、
  `recovery`（恢复后连通），另记 `nonWorker`（非 Worker 来源在原策略下不通）。探针目标
  Pod、临时 deny-all 与探针来源在探针结束后按 UID 删除；预检不要求它们仍存在，也不要求
  `probes` 覆盖现场全部 Agent 级控制器。
- `networkPolicy`：`templateSha256`，按变体名记录全部规范化模板摘要（单服务三种 `route.exposure`，
  多服务入口、非入口与迁移，及其带快照与不带快照的形态；部署配置含 `nativeEgress` 时，单服务另有未绑定标准模板的 `+no-native` 形态）。摘要是“有效 spec 加原生工具出站受保护网段”的规范化 SHA-256。模板与摘要的定义、探针原策略的生成方式，只在工程 Spec 同条之后的
  “NetworkPolicy 规范化模板”维护。
- `observedAt` 与 `expiresAt`：有效期不超过 7 天。

以下情况都拒绝发布：

- 探针所选变体的策略没有任何入站来源（迁移），`PROBE_VARIANT_NO_INGRESS`。

- 执行组件不是所选 ECI / ACS 上的 Poseidon（包括 ECS 的 flannel），或证据的 `enforcer` 字段不符。
- 证据超过 7 天、已过期或时间在未来；cluster、namespace 名称或 UID 与现场不符。
- 按 placement 的 selector 与 toleration 可落的节点中，有节点不在证据里、UID 变化、缺少
  `virtual-kubelet.io/provider=alibabacloud:NoSchedule` 污点，证据节点已不存在，或没有可落节点。
- 探针缺少 allow 或 recovery 的连通结果（只有 timeout 不算），deny 后仍连通，非 Worker
  来源可达，探针目标不在可落节点上，或时间顺序不对；任一可落节点没有自己的探针结果。
- 证据自相矛盾：探针记录的 Pod 的 `nodeName` 不是该探针所属的可落节点，或替换表的端口不是探针的 `destination.port`；缺少 `ACK_BOOTSTRAP_INPUTS_FILE`（`WORKER_CONFIGURATION_REQUIRED`），Worker `configuration.mjs` 不可读取、不可加载或缺少 `workloadInput.policy`（`WORKER_CONFIGURATION_UNVERIFIABLE`），派生或合并出的部署配置不合法（`NETWORKPOLICY_CONFIG_INVALID`），或其 `workerSelector` 不被渲染结果中的 Worker Pod 满足；预检用部署配置
  重新计算的全部规范化模板摘要，与证据 `networkPolicy.templateSha256` 的变体集合或任一摘要不一致；探针记录的
  `policy.instantiatedSha256` 与预检按其 `variant` 和 `substitutions` 复算的结果不同，或任一探针 Pod 的 `podLabels` 不满足 Spec 同条的标签条件；Worker placement 的 selector
  与 toleration 摘要与证据 `placement.selectorSha256` 不一致。
- 渲染结果缺少 Worker 的 placement env、取值不合法，或与证据的 `architecture`、`legacyUnplaced`
  不一致；渲染结果不可解析或 Worker Deployment 不唯一。
- 现场控制器带非部署注入的调度字段（包括没有 Worker 记录
  `agent-infra.agora.io/agent-workload-placement` 的 ECI 字段）；控制器记录的架构不是证据的
  架构（其可落节点未被证明）；`legacyUnplaced: reject` 时仍有未采用 placement 的运行中
  StatefulSet/Deployment 或未完成的 Job。
- 渲染结果没有唯一的 Session ECI `MutatingAdmissionPolicy`（`failurePolicy: Fail`，限定本
  namespace 与 `session-sandbox-v1` 标签，唯一的 mutation 含 virtual-kubelet selector 与 provider
  toleration）及指向它的 Binding，或走 RuntimeClass 分支；本 ACK 须开启
  `sessionRuntimeScheduling` 且不设 `runtimeClassName`。Session 准入的架构必须等于证据架构
  （`SESSION_PLACEMENT_MISMATCH`），使 Session Sandbox 的可落节点与已证的 Agent 可落节点相同。
- 任一 `kubectl get` 失败，包括权限不足。

通过时 stderr 输出一行摘要，含 `legacyUnplacedActiveTargets` 与
`allAgentWorkloadsOnEnforcedForm`。保留态（`retain-until-lifecycle`）下尚未采用的 Host
计入前者，后者为 `false`，表示这些 Host 尚未隔离。摘要的 `fieldAcceptanceSigned` 恒为
`false`：预检只证明发布前提，不代签部署后的现场正负矩阵。

证据由部署 owner 在获批窗口内用已评审的探针包产生，并由非实现 lane 复核。缺少当期证据时
预检直接失败，不在生产自动补造探针。探针包在产生证据后删除其创建的全部对象（按 UID），
并回读确认。探针包是 [`networkpolicy-probe.mjs`](networkpolicy-probe.mjs)（`render`、`probe`、
`assemble`、`cleanup`）：原策略由 Worker 的同一模板函数按替换表生成，标签从存活 Pod 回读，
`assemble` 在清理前用本门禁的校验函数自检。NetworkPolicy 按并集生效，deny 步只能先撤原策略、只留临时 deny-all，所以证据里的 `policy.uid` 是 recovery 时重建的那条原策略。它不自动创建或应用对象，窗口内的具体步骤由部署 owner
的执行计划给出。

## 验收顺序

完整验收顺序：目标节点隔离与网络检查、同一不可变镜像的真实模型验证、浏览器申请/审批、
Worker 创建 Session Pod/PVC、实际回复和 SSE 回读。组件 readiness 与受控 fixture 均不能
替代后续步骤。

## ACS 证据绑定

以下网络成功证据流程约束需要该能力的旧 Native 模式。SDK 轻量模式报告实际探针状态，
不以网络或 Landlock 成功作为全部业务的共同前置；容量与算力身份仍须精确绑定。

ACS 的配置和采用顺序见 [部署说明](ACK-E2E-DEPLOYMENT.md#codex-的-acs-算力配置)。
`networkpolicy-probe.mjs` 从渲染的 Worker env 与 Session admission 读取两个算力选择，在每个
候选虚拟节点为实际需要的 ECI / ACS 分别生成探针。ACS 标签调度可能忽略虚拟节点 hostname
selector，因此只有临时 ACS 探针显式绑定 `nodeName`；ECI 探针保持 hostname selector。两者
都核对实际 Pod 的节点与实例，错节点结果不生成成功证据。含 ACS 时，证据增加
`placement.computes: {agent, session}`，`enforcer.runtime` 为 `acs` 或 `mixed`；每个
`probes[].destination` 同时记录 `compute` 和云端回读的 `instanceId`。selector digest 绑定算力
组合与固定 ACS metadata。缺少任一节点 / 后端的执行证据、实例类型不符、配置变化或过期均停止。
旧格式只证明 ECI，不能授权 ACS；网络探针仍不代替原生隔离、模型 / 工具、PVC 与恢复验收。
