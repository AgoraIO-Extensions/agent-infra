# Platform Worker 部署模块

正式 CLI 通过 `PLATFORM_WORKER_DEPLOYMENT_MODULE` 同时启动 Workload 与 Conversation
循环。[deployment-entry.ts](../../apps/platform-worker/src/deployment-entry.ts) 装配两个现有工厂及可选的 WeCom 渠道实例，共享一次经过
验证的 Kubernetes、Registry、模型目录、keyring、Runtime readiness 与路由配置。
每个进程生成独立的数据库 lease owner；Runtime 服务身份仍使用部署提供的稳定 Worker ID。
配置模块可选导出 `modelDirectory`，由 `createPlatformRuntimeModelDirectoryGatewayV1`
装配 API→Worker 的 ACP model-directory 内部入口（默认端口 3005）。Worker 默认读取
Store 当前 Workload 状态并复用 Conversation 的生产 resolver 选择已验证的 RuntimeHost
路由；部署可提供已验证的 `resolveRuntimeHost` 覆盖该默认行为。Grant signer 可省略，Worker
会使用同一份 `signing` 私钥创建 Worker-owned 的短时 signer。请求不能选择 URL、Session 或 Grant。
入口使用同一 `serviceToken`，失败和绑定漂移均 fail closed；部署需要把端口作为 Worker 内部
Service/NetworkPolicy 输入暴露给 Platform API，不能暴露给浏览器或 Agent。启用 native metadata
时，两个入口共享同一个 Worker internal HTTP listener；显式配置的 port/hostname 必须一致，
否则启动失败。
Helm 的 `platformWorker.wecomEnabled=true` 还会在同一进程启动 WeCom 连接调谐和回复
派发。未提供受信 WeCom 配置时启动失败；关闭该开关时不受理 WeCom Runtime 授权。
启用该开关须使用 `workloadTopology.enabled=false` 的正式 Worker 部署；受控 topology
模式不运行渠道，组合启用会拒绝渲染。

Native metadata 的正式 `configuration.mjs` 可导出 `nativeMetadataGateway`。默认会使用
`PLATFORM_DATABASE_URL` 通过 Platform Store 查询原 Execution scope 并装配
`binding.resolve({ request, signal })`；只有需要替换 Store 读取时才显式提供该 binding。

Helm 的 `platformWorker.nativeMetadataGateway.enabled` 默认开启时，Worker 入口会从
固定环境变量装配网关端口，并把 `http://platform-worker-native-metadata`、当前 namespace、
Worker Pod selector 和网关端口写入默认 Session Sandbox egress。`configuration.mjs` 显式导出
`nativeMetadataGateway` 或显式提供 workload policy 字段时优先使用部署模块输入；显式关闭开关
不会注入这些默认值。
当没有显式 `transport` 或 `runtimeTarget` 且存在 `PLATFORM_DATABASE_URL` 时，Worker 会读取
当前 Conversation/Execution、Workload 与 Session Sandbox receipt，并复用生产
Conversation resolver：Agent-level 走 verified control Service，Session Sandbox 只使用当前
allocation 的已验证 Service、namespace、generation、resource fence 和 Sandbox token。缺少
数据库、Store scope、就绪 receipt、Service/Pod/readiness 或任一 binding/auth revision 漂移时
保持 unavailable。部署仍可通过显式 `transport` 或 `runtimeTarget` 覆盖该默认目标；显式 override
优先且不会重复装配默认 query。
`proofIssuer` 可以省略：deployment entry 会用同一份 `signing.privateKey`、`issuer`、
`workerId` 和 `keyId` 创建 Worker-only proof issuer；也可以在密钥轮换期间显式提供已
验证的 issuer/key 组合。`platformApiCurrent` 可提供固定 `{ baseUrl, serviceToken }`，由
Worker 自动创建 Platform API current-confirmation client。请求本身不能选择 Runtime/API
URL、token、Host Session 或主体；任一 binding、transport、current 或 proof 依赖缺失时
网关保持 unavailable。Worker 停止 internal listener 时会一并关闭默认 Store query client。

未显式提供 `current` 或 `platformApiCurrent` 时，部署入口读取
`PLATFORM_WORKER_NATIVE_METADATA_PLATFORM_API_ORIGIN`，使用同一部署 service token 装配
current-confirmation client。Helm 为 in-cluster API 推导本 release 的 API Service；external API
由部署方提供 `platformWorker.nativeMetadataGateway.platformApiOrigin`，本地入口自动绑定到
当前 Compose API 容器。Chart 的 API 保持单副本并使用 `Recreate` 更新，避免滚动期间确认请求
落到未承载原 Request 的另一实例；升级会短暂中断 API。关闭网关时不装配此默认 client；
显式配置继续优先。

Session Sandbox 的空闲计算回收属于同一 Worker 的会话生命周期策略。部署配置模块的
`workloadInput.idleSandboxReclaimAfterMs` 可以配置空闲阈值，设为 `null` 可关闭，未配置时默认
30 分钟；只有没有 `active`、`waiting` 或 `unknown` 执行的 Sandbox 才会停止计算资源，PVC 和会话映射保留，
下一条消息会重新准备原 Sandbox。该策略与已验证 Workload 升级分开，
不会改变 policy 或 Workload revision。

Workload 调谐还可以分别配置 `workloadInput.maximumApplyAttempts` 和
`workloadInput.maximumObserveAttempts`。前者覆盖资源申请、镜像拉取和 PVC 等待的重试预算；
后者覆盖资源已创建后的健康检查与 signed readiness 观察预算。未设置时两者均沿用
`maximumAttempts`；预算耗尽分别进入现有创建清理或健康检查失败路径，
不会把确定性 readiness 错误继续当作慢镜像拉取等待。

配置模块也可选导出 `savedKeyCandidates`，由部署实现
`createWorkerSavedKeyCandidatesApp` 的 `reader`；该 reader 在 Worker-only keyring
边界内短暂解密当前 Agent 默认 Key，只返回候选 metadata。API 通过固定
`serviceToken` 调用 `/internal/worker/v1/saved-key-candidates`；Key 明文和 ciphertext
不得进入响应、日志或浏览器。未提供该部署 seam 时，saved-Key read 保持 unavailable。

部署也可以导出 `savedKeyCandidatesPolicy`，由 Worker 生产入口组装
`PostgresAgentDefaultRelayKeyStoreV1`、`PostgresRelayKeyVersionStoreV1`、Worker keyring、
当前模板/image binding 和 model catalog。Policy 必须提供 catalog revision、approved billing validation
和 Relay 路由。路由支持旧的固定 `relayEndpointId` / `relayBaseUrl`，或部署批准的
`relayEndpoints: [{ endpointId, baseUrl, protocol }]` 列表（ID 唯一），两种格式不能混用。
路由必须与 Model Catalog 精确匹配，模板仍按 digest 与 Driver 协议筛选。
请求会重新检查 Owner、禁用状态、配置修订和 Key version。`savedKeyCandidates` 仍可作为受控部署 override。

Native metadata 的 Worker 网关还提供固定的当前确认入口
`/internal/platform-worker/v1/native-metadata/current`。Runtime Host 使用固定 Worker origin；
Session Sandbox 使用由当前 Store allocation、固定 Worker namespace 和
`sessionSandboxServiceTokenV1` 派生的 Sandbox token，未绑定 Sandbox 的 Agent-level Execution
才使用部署 service token。Worker 先按 body 的 Conversation/Execution scope 重新解析权威 binding，
再校验对应 credential；调用方不能提交 URL、namespace、token、主体或 Host scope。缺少当前确认配置、
关联失效、Sandbox allocation 非 ready/running 或 Worker 不可达时，读取保持 unavailable。

Session Sandbox 也使用同一固定 Worker origin，但其 token 由 Worker 按
`sessionSandboxServiceTokenV1` 为每个 Sandbox 派生，并通过该 Sandbox 自己的 Secret
以 `AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_SERVICE_TOKEN` 注入 Runtime；部署级
service token 永不写入 Sandbox。Session 的 `nativeMetadataWorkerEgress` 只能使用部署批准的
namespace/pod-label selector 与单一 TCP port，缺失策略保持 NetworkPolicy deny-all，IP/CIDR
目标会在资源写入前拒绝。

## Session Runtime Driver

Session Sandbox 的 Driver 来自部署已信任的标准模板绑定，不能由用户请求选择。
Codex 使用 `openai-responses-v1`；Claude、OpenCode（`acp`）与 Pi 使用
`anthropic-messages-v1`。Worker 核对 Driver 与无凭证 V4 模型配置的协议，再将配置和派生的
传输 Token 写入该 Session 自己的 Secret；未知 Driver、协议错配或模板信任撤销时拒绝创建。

每个模板仍须通过自身的真实模型验证及目标节点上的隔离检查。Messages 模板可被装配，
不代表它已通过真实用户对话验收，也不代替 Codex 的 Landlock 要求。

## Skill 物化的 Agent Version

配置模块可选导出 `skillMaterialization`，装配 Store 与对象存储支撑的 Skill 物化。其中
`agentVersion` 必须与 Platform API 的 `apiInput.agentVersion` 取同一个值，取值规则与 Helm、
本地注入方式见 [API 部署说明](../platform-api/README.md#skill-绑定的-agent-version)。未导出或配置
不完整时 Skill 物化不可用，普通 Workload 照常启动。

## 集群注入的 Pod 标签

集群向运行中 Pod 注入地域标签时，可在
`workloadInput.policy.allowedPodTopologyLabelValues` 登记精确获准值列表；键仅限
`topology.kubernetes.io/region` 和 `topology.kubernetes.io/zone`。默认不接受额外标签。
此配置只允许运行中 Pod 携带这些标签，不改变模板、Agent 身份、revision 或 Pod spec 校验。

## 多服务资源档位

`workloadInput.policy.multiServiceResourceProfiles` 与 `workloadInput.policy.multiServiceResourceCap`
的字段形状、默认档位与默认上限见
[API 部署说明](../platform-api/README.md#多服务-agent-资源档位)，两侧必须配置相同的值：API 按它准入，
Worker 按它注入容器资源并在调谐时再次校验。

- Worker 在装配阶段解析这两项配置；档位重复、使用 `default`、字段非法或上限非法时，
  `createProductionWorkloadWorkerOptionsV1` 以 `WORKER_KUBERNETES_CONFIGURATION_INVALID`
  失败，进程在打开数据库或修改 Kubernetes 资源前退出。
- 每次创建或更新多服务资源前，Worker 先汇总全部 Deployment、StatefulSet 与迁移 Job 的
  估算量。超过上限时该次调谐以 `MULTI_SERVICE_RESOURCE_CAP_EXCEEDED` 错误失败，不读写任何
  Kubernetes 资源，也不清理旧版本资源。
- PVC 大小取挂载它的 StatefulSet 所用档位的 `storageSize`；档位未设置时（包括 `default`
  档位）沿用 `workloadInput.policy.storageSize`。已有 PVC 的大小与该结果不同时视为漂移：
  调谐失败关闭，观测为 `unhealthy`，Worker 不会自动扩缩 PVC。因此给已有 Agent 使用的档位
  新增或修改 `storageSize` 前，需先迁移其 PVC。

## 平台身份入口

`workloadInput.policy.platformAuthAnnotations` 是平台身份入口（自有交互入口由平台校验身份）路由的
可信集成，只在 Platform API 装配了 `customAgentGateway` 时配置，两侧必须一致；规则见
[工程 Spec §14.3](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#143-自有交互入口)。
该项为空时，Worker 在 preflight 开始、Registry 准入和任何 Kubernetes 写入之前，以
`kubernetes_policy` 让这类 Agent 立即创建失败，不消耗重试预算。

## 调谐失败日志

Workload 调谐的步骤抛出异常时，调谐只会让 `attempts` 加一后重试，预算耗尽后进入清理，原因不进入
持久状态。Worker 为此输出一条结构化日志（`console.info`，可用 `log` 选项替换）：

```json
{"service":"platform-worker","code":"WORKLOAD_STEP_FAILED","agentId":"agent_…","phase":"applying","attempts":4,"terminal":false,"reason":"kubernetes_forbidden","kubernetes":{"status":403,"kind":"Deployment","verb":"create"}}
```

- `reason` 取自有界集合：`kubernetes_unauthorized`、`kubernetes_forbidden`、`kubernetes_not_found`、
  `kubernetes_conflict`、`kubernetes_invalid`、`kubernetes_throttled`、`kubernetes_server_error`、
  `kubernetes_unreachable`（没有拿到 HTTP 应答）、`kubernetes_policy`、`preflight_rejected`、
  `capabilities_unavailable` 和 `unexpected_error`（附带过滤后的错误类名 `errorName`）。
- `kubernetes` 只有 HTTP 状态、资源种类和动词，不含响应体、资源名、用户名或凭证；Worker 从不读取
  未知错误的 `message`。
- 同一个 Agent、阶段、原因在 30 秒内只记一条，被合并的次数放在 `suppressed`；`terminal` 为
  `true`（预算耗尽或永久拒绝，Workload 转入清理或候选被拒绝）的记录总是输出。
- 清理（`cleaning`）与路由关闭（`closing`）在预算耗尽后仍会持久重试：连续失败 5 次后，重试间隔
  按 2、4、8、16、32 秒退避，上限 60 秒；其余阶段保持 `pollIntervalMs`，不拖慢就绪检测。

## 打包与启动

在仓库根目录、Node.js 24 与仓库固定 pnpm 版本下执行：

```bash
pnpm install --frozen-lockfile
pnpm --filter @agent-infra/platform-worker... build
```

构建生成 `apps/platform-worker/dist/index.mjs` 与 `dist/deployment.mjs`。
`configuration.mjs` 不属于构建输入，也不进入镜像。Helm 通过
`platformWorker.configurationModuleSecretRef` 把经审阅的源码只读挂载到 Worker 的
`dist/configuration.mjs`，并将同一只含受审阅代码的 Secret 完整挂到
`/var/run/agent-infra/deployment`，供模块引用相邻部署代码。
`platformWorker.runtimeAuthSecretRef` 在 Worker 内提供
`/var/run/agent-infra/runtime-auth/runtime-grant.pem` 和 `service-token`。这些私有文件
不放进代码 Secret 或镜像；模块必须读取实际路径并与 `policy.runtimeAuth` 的公钥、
issuer、key ID 和 Worker ID 核对。

Worker 访问的 Runtime Host 或模型预检 Relay 使用私有 CA 时，在 Helm values 配置
`platformWorker.trustedCaSecretRef` 的 Secret 名称和 CA bundle 键。Worker 在启动时通过
`NODE_EXTRA_CA_CERTS` 读取只读挂载的 `ca.crt`；不把 CA 写入代码 Secret，也不关闭 TLS
证书校验。使用公开受信 CA 时可省略此项。此挂载只影响 Worker；Agent Pod 执行期
Relay 请求的 CA 信任须由 Workload 装配并在真实模型请求中独立验证。

先从受信部署配置设置并导出 `PLATFORM_DATABASE_URL` 与
`PLATFORM_WORKER_NAMESPACE`，随后执行：

```bash
cd apps/platform-worker
: "${PLATFORM_DATABASE_URL:?Set the selected PostgreSQL database URL}"
: "${PLATFORM_WORKER_NAMESPACE:?Set the workload namespace}"
export PLATFORM_DATABASE_URL PLATFORM_WORKER_NAMESPACE
PLATFORM_WORKER_DEPLOYMENT_MODULE="$(pwd)/dist/deployment.mjs" node dist/index.mjs
```

Worker 镜像中的对应目录是 `/app/dist`。部署模块与配置模块必须来自受信任部署代码，
不能来自请求、模型输出或 Agent 镜像。配置读取失败时进程退出；收到 SIGTERM 后停止发现、
中止 Runtime 请求并关闭数据库连接。数据库迁移先按现有 Platform Store 入口执行。

内置模块以 `PLATFORM_DATABASE_URL` 为唯一数据库绑定，忽略挂载配置中的
`workloadInput.databaseUrl`；Helm 从 `database.secretRef` 注入该值。
正式 Helm Worker 通过 downward API 将 Pod namespace 注入 `PLATFORM_WORKER_NAMESPACE`，
必须与 `workloadInput.policy.namespace` 相同。直接启动也必须显式设置这两个变量；
缺失、不合法或 namespace 不匹配时，在创建 Worker 依赖前返回固定脱敏错误。
Workload、Conversation 和可选 WeCom 实例共同使用这一数据库绑定。

## unknown 恢复预算

接受结果不确定（`unknown`）的执行从进入 `unknown` 起按墙钟预算恢复，默认 5 分钟；用尽时以
`RUNTIME_RECOVERY_TIMEOUT` 收敛为失败。部署可用 `PLATFORM_WORKER_RUNTIME_RECOVERY_BUDGET_MS`
（1 到 86400000 的整数毫秒）调整，取值无效时 Worker 拒绝启动。规则见
[Runtime HLD §7.3](../../docs/architecture/HLD-agent-runtime-M1.md#73-重启恢复)。

## Runtime 文件交换注入

Worker 向 Agent Workload 和会话 Sandbox 注入文件交换配置的前提是 `policy.runtimeAuth` 存在，并且提供精确的 Platform API origin：

- 部署模块：`workloadInput.policy.runtimeAuth.fileExchangeOrigin = "https://platform-api.example.internal"`。
- 固定环境：Helm `platformWorker.fileExchangeOrigin`，或直接设置 `PLATFORM_WORKER_FILE_EXCHANGE_ORIGIN`。模块已显式提供时不得再给环境变量，否则返回 `PLATFORM_WORKER_FILE_EXCHANGE_DUPLICATE`；只给 origin 而没有 Runtime auth 返回 `PLATFORM_WORKER_FILE_EXCHANGE_CONFIGURATION_INVALID`。

origin 必须是精确的 `http(s)://host[:port]`，不含路径、查询、片段或凭据；明文 HTTP 只接受集群 DNS 名称。缺失时两类 Pod 都不注入，Runtime FileBridge 关闭；存在时同时注入 `AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN` 和 `AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN`。后者都是 `secretKeyRef`：Agent Pod 引用 `runtimeAuthSecretRef`，会话 Sandbox 引用本 Sandbox Secret 中按本分配派生的 `file-exchange-token`，部署级 service token 永不写入 Sandbox。令牌不写入 Pod env、values、日志或错误。

配置 origin 时还必须声明它的出站目的地：部署模块 `workloadInput.policy.fileExchangeEgress`，或 Helm `platformWorker.fileExchangeEgress`（渲染为 `PLATFORM_WORKER_FILE_EXCHANGE_EGRESS`）。Worker 据此为 Agent Workload 与会话 Sandbox 的 NetworkPolicy 各生成一条到 origin 端口的规则；缺少或无效时启动即以 `PLATFORM_WORKER_FILE_EXCHANGE_CONFIGURATION_INVALID` 失败。目的地形状、端口规则与集群外 API 的写法见[文件存储部署与验收](../../docs/architecture/FILE-storage-deployment.md#runtime-文件交换注入)。

令牌轮换：更新 runtime-auth Secret，重启 Worker 与 Agent Workload；同时确保 Platform API 的 `services` 登记同一令牌和允许的 Agent。已有会话 Sandbox 如何获得新配置、完整配置与失败语义见[文件存储部署与验收](../../docs/architecture/FILE-storage-deployment.md#runtime-文件交换注入)。

## 配置模块形状

以下只说明已有工厂参数的装配方式，具体 IdentityAdapter、Registry policy 和模型目录
由部署代码实现，不定义新的身份服务或配置协议：

```javascript
import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  directory,
  registry,
  modelCatalog,
  policy,
  loadReviewedKeyring,
} from "/var/run/agent-infra/deployment/environment.mjs";

export { directory };
export const signing = {
  workerId: "platform-worker-runtime",
  issuer: "agent-platform",
  keyId: "runtime-grant-current",
  privateKey: createPrivateKey(await readFile("/var/run/agent-infra/runtime-auth/runtime-grant.pem")),
};
export const serviceToken = (
  await readFile("/var/run/agent-infra/runtime-auth/service-token", "utf8")
).trim();
export const workloadInput = {
  kubernetes: { mode: "in-cluster" },
  policy,
  registry,
  admissionPolicyRef: "approved-runtime-images",
  registrySubjectRef: "platform-worker",
  keyring: await loadReviewedKeyring(),
  modelCatalog,
  templateModelBindings: [],
  executionCapacityProfiles: [],
};

// 启用 WeCom 时还须导出 wecom：可信发送者身份、发送端、观察端、
// connections 的绑定与回复路由保护，以及 setup 的 Worker-only 解密和
// 当前目录查询。setup 同时验证机器人和自建应用候选；应用回调的 API 接入
// 仍须独立配置。长连接入站与出站媒体另由 wecom.media 提供与 Platform API 文件面
// 同一 bucket 的对象存储 Adapter；出站还需要它的 download（见 WECOM-text-deployment.md「媒体」）。
```

- `directory.resolveUser(userId)` 必须查询部署的当前身份事实；依赖失败应抛错，不能返回一个
  假造的 active 用户，也不能把临时故障当作账号删除。账号确认不存在时才返回 `null`。
- 示例中的 `environment.mjs` 必须是同一个受审阅代码 Secret 的键；不用它时把真实
  `directory`、`registry`、`modelCatalog`、`policy` 和 keyring 加载逻辑写入
  `configuration.mjs` 本身。私钥、数据库 URL 与 token 不得放进代码 Secret；本地固定 E2E 的对象存储凭证
  例外见 [E2E Harness「Worker 企微媒体装配」](../local/E2E-HARNESS.md#worker-企微媒体装配)。
- `loadReviewedKeyring()` 必须只读取 Worker 的
  `/var/run/agent-infra/keyring/keyring.pem`，按
  `AGENT_INFRA_WORKER_KEY_VERSIONS` 核对每个版本，并转成工厂要求的版本化 PKCS#8 DER
  Base64 输入；不能把 PEM 原样传给工厂，也不能以同一把私钥冒充多个版本。
- `policy.runtimeAuth` 的 Worker ID、issuer、key ID、公钥必须与 `signing` 匹配；其中只保存
  Kubernetes 内预置的 Runtime transport Secret 名称/键，不保存私钥或 Token 值。可选的
  `fileExchangeOrigin` 见 [Runtime 文件交换注入](#runtime-文件交换注入)。
- `templateModelBindings` 使用当前获准标准模板 digest、必需 `driver` 与协议，绑定规则见
  [Runtime HLD §3.1](../../docs/architecture/HLD-agent-runtime-M1.md#31-标准-runtime)。上面空数组仅是形状示例，
  不能验证标准模板；自定义 Agent 可使用空数组。
- `executionCapacityProfiles` 必须由真实负载/conformance 证据产生，绑定精确 image digest、
  resource profile 与资源配置 hash。空数组不允许新 Turn。撤回容量证明仍保留原执行控制。
- 内置消费者对 Web 使用当前 Core 权威判断；启用 WeCom 时同一 Worker 的渠道实例
  复核当前发送者、绑定与配置版本。未知渠道返回 unavailable。`wecom.identity` 须以
  #889 当前完整快照和 LDAP/Platform 当前状态映射可信发送者，不能采信请求字段或固定用户。
  标准模板的渠道资格不取决于暂时 Ready 状态；自定义平台入口须有已验证
  兼容事实。新业务仍需通过当前身份、Agent 使用权、配置、Workload 与容量终审。
- Worker-only 文件不得挂载到 API、Agent 或 Web，也不得进入日志、任务正文或 Git。目录
  Adapter 的具体接入与 API taskBoundary 接线由各自后继完成。

## 验证边界

`conversation-worker.integration.test.ts` 使用真实 PostgreSQL、正式打包模块和两个 CLI
进程，经生产 Core 合法受理任务，覆盖自动发现、竞争 claim、容量、持久事件、停止及退出。
其 Kubernetes 与 Runtime HTTP 是受控对端；不代表真实模型、身份服务、Connection 或 Web
首通。签名 readiness 对真实 RuntimeHost 的独立验证位于 `workload-deployment.test.ts`。
整体汇合仍遵循 [ADR 0015](../../docs/adr/0015-m1-shared-contract-assembly-convergence.md)。
