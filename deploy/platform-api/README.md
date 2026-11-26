# Platform API 部署模块

## 私有标准模板 Registry

`registry.standardTemplates` 为标准模板提供独立的准入绑定，API 的 `apiInput.registry`
与 Worker 的 `workloadInput.registry` 使用同一契约。外层 Registry 继续处理自定义镜像。
部署配置提供以下字段，并由模板目录及 Worker 的当前、保留绑定决定实际镜像和 digest。

| 字段 | 部署输入 |
| --- | --- |
| `endpoint` | 私有 Registry 的 HTTPS origin |
| `imageReferencePrefix` | Registry host，可含端口，不含仓库路径 |
| `repositories` | 精确仓库路径列表，不含 host、tag 或 digest |
| `authentication.realm` | HTTPS 令牌服务完整 URL，不含 query、fragment 或用户信息 |
| `authentication.service` | 固定令牌服务 audience |
| `authentication.loadCredentials(signal)` | 从服务进程只读挂载的部署 Secret 读取 `{username, password}`，缺失时返回 `undefined` |
| `allowedBlobRedirectOrigins` | 可选的 HTTPS 存储 origin 列表，跳转不携带凭据 |

读取回调仅在 challenge 与目标仓库、realm、service 匹配后执行，每次交换都重新调用，
便于部署通过文件轮换凭据。回调须响应取消信号，读取失败时关闭准入。调用者提供的地址
不能选用标准模板身份。正式凭据持有和发送边界见
[工程 Spec §6.3.1](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#631-私有标准模板镜像准入)。

## 进程装配

本地 Compose 从镜像内加载[部署模块](../../apps/platform-api/src/deployment-entry.ts) 编译成的
`deployment.mjs`，并只读挂载 API 专属
`configuration.mjs` 到 `/app/deployment`。内置模块创建第一方 OIDC 身份适配器、
PostgreSQL 浏览器会话和生产 Platform API 装配；私有配置由部署者提供当前受信事实，
不得放入镜像或 Git。

Compose 固定 `PLATFORM_API_CONFIGURATION_MODULE=file:///app/deployment/configuration.mjs`
和 `PLATFORM_API_PROXY_TOKEN_FILE=/run/secrets/platform_proxy_token`；模块只接受本地
文件 URL 和绝对令牌路径。`configuration.mjs` 必须导出：

当 Helm 的 `platformWorker.nativeMetadataGateway.enabled=true` 且 API 使用
`platformApi.placement=in-cluster` 时，Chart 会把固定的
`http://platform-worker-native-metadata` origin 和 Worker runtime service-token Secret
只读投影到 API，并由内置入口自动组装 `nativeMetadataWorker`。部署模块显式导出的
`nativeMetadataWorker` 或 `nativeMetadata` 仍优先；请求不能选择 origin、token 或主体。
关闭该开关时不会注入环境变量、Secret volume 或 API→Worker 入口。

Kubernetes Helm 部署可选配置 `platformApi.connectionCallbackAuthSecretRef`，由部署 owner
提供只用于 Runtime OAuth callback 的 Secret name/key。`platformApi.placement=in-cluster` 时，
Chart 以只读 `0600` 文件投影该 Secret key，并设置
`PLATFORM_API_CONNECTION_CALLBACK_AUTH_FILE=/var/run/agent-infra/connection-callback-auth/callback.auth`。
Secret 内容不进入 values、模板渲染日志或 API 配置；省略该 SecretRef 时 callback 能力保持关闭。
该凭据只允许固定的 `/internal/runtime/oauth/v1/callback` 路由，不能复用 Worker business/
installation credential。外置 `platform-api` 的文件装配仍由其部署方负责。

第一方部署复用 `PLATFORM_API_PROXY_TOKEN_FILE` 的 Web/API 共享代理令牌验证 OAuth 回跳。
HTTP upstream 只在代理令牌有效、`Host`（含非默认端口）精确等于 `publicOrigin` 的 host 且
代理标记为 `https` 时承认该公网 origin；`Forwarded` 和 `X-Forwarded-Host` 不参与判断。
直接 HTTPS 请求仍须匹配同一精确 origin；此验证不替代原 state/issuer/安装绑定和期限检查。

Web 的 `PLATFORM_CONNECTION_CALLBACK_PATH` 必须等于已登记 `callbackUrl` 的 pathname，
缺省为 `/api/connection-installations/callback`；自定义路径须同步配置。它只能来自部署配置，
不接受 query/fragment、非法编码或控制字符。Web 对该精确路径保留原始 Host authority，
覆盖浏览器提交的代理令牌和 scheme；scheme 取 `PLATFORM_PROXY_SCHEME`，生产须为 `https`。
该路径的 access log 不含 query，upstream error log 送入 `/dev/null`，防止任一级别回显一次性凭据；
普通 API 的 scheme 与日志策略保持原样，回调失败仍由 HTTP 状态和 API 固定码观测。

每个 Platform Store 有独立的 PostgreSQL 连接池。API 进程启动时把每个池的上限压到
`PLATFORM_API_STORE_POOL_MAX`（默认 2，取值 1–10，非法值拒绝启动），空闲连接 30 秒后回收
（可用 `PGIDLE_TIMEOUT` 覆盖），避免多个 API 副本用尽数据库连接（#4048）。Worker 不受此设置影响。

Helm 的第一方 in-cluster API 使用以下仅含引用的 values。部署 owner 预先创建 API 专属
Secret；配置 Secret 的全部文件只读挂到 `/app/deployment`，入口加载所选 key，辅助模块可用
相对 import，私有 adapter 的依赖包仍由部署镜像提供。不要把 Worker keyring 放入该 Secret。

```yaml
platformApi:
  placement: in-cluster
  deploymentModule: file:///app/dist/deployment.mjs
  configurationModuleSecretRef:
    name: agent-infra-api-configuration
    key: configuration.mjs
  proxyTokenSecretRef:
    name: agent-infra-api-proxy-token
    key: token
  trustedCaSecretRef:
    name: agent-infra-api-trusted-ca
    key: ca.crt
```

Chart 设置 `PLATFORM_API_CONFIGURATION_MODULE=file:///app/deployment/configuration.mjs`、
`PLATFORM_API_PROXY_TOKEN_FILE=/var/run/agent-infra/proxy-token/token`；可选 CA 设置
`NODE_EXTRA_CA_CERTS=/var/run/agent-infra/trusted-ca/ca.crt`。文件权限为 `0440`，API 的
`fsGroup=1000` 可读，root filesystem 和各挂载均只读，ServiceAccount token 不挂载。
内置入口缺少配置或代理令牌引用时拒绝渲染；自带可信部署模块可以省略未使用的引用，
external API 不接受这些 in-cluster 引用。模板验证不代替实际 OIDC 登录、目录、授权与
native 业务验收；外联仍由部署方配置明确的 NetworkPolicy。

| 导出 | 契约 |
| --- | --- |
| `oidc` | 受信 issuer、专属 clientId、clientSecret、allowEmailLink 和可选的平台管理员稳定 ID。见 [OIDC 配置](../local/oidc-identity.md)。 |
| `directorySnapshot` | 受认证的 HTTPS 当前目录和部门映射，包含 endpoint、token 和 organizationIdForDepartment。 |
| `publicOrigin` | 与本地 HTTPS Web 相同的精确 Origin |
| `apiInput` | [`ProductionPlatformApiInputV1`](../../apps/platform-api/src/deployment.ts) 中除 `databaseUrl`、`identity` 外的真实 Registry、模板、ModelCatalog、密钥公钥、准入和展示依赖；其中必须包含与模板 `modelBinding`/Model Catalog 端点一致的 `agentDefaultRelayKeyPolicy` 和 `personalRelayKeyValidation`；可选 `modelDisplayMetadata` 为非秘密 `{ schemaVersion: 1, models: [{ endpointId, modelId, displayName }] }`，按精确模型关联提供展示名，缺名保留真实 ID，不改变模型授权；边界见[工程 Spec §10.7](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#107-标准模板模型配置)；可选的 `agentVersion` 见[Skill 绑定的 Agent Version](#skill-绑定的-agent-version) |
| `customAgentGateway` | 可选的部署端 Gateway port：提供 `resolveDeployment`、`authorizeAgent`、签名 issuer/key version/private key；不要同时放入 `apiInput.customAgentGateway`。只有配置了它，平台身份入口（自有交互入口由平台校验）才可用；未配置时 Web 申请、修改重提和 API 创建对该选择返回 409 `ACTION_UNAVAILABLE`。Worker 的 `platformAuthAnnotations` 必须同时配置，见[平台身份入口](../platform-worker/README.md#平台身份入口) |
| `modelSelection` | 可选的 Runtime ACP model-directory reader；应由部署方用 `createRuntimeModelSelectionReaderV1` 和受认证 transport 组装；不要同时放入 `apiInput.modelSelection` |
| `modelDirectory` | 可选的 `{ baseUrl, serviceToken }` Worker 内部模型目录服务输入；配置后 API 自动从 Platform Store 绑定当前 Web Conversation/Execution/Session/fence，并创建默认 `modelSelection` reader；不要同时提供 `modelSelection` |
| `savedKeyCandidates` | 可选的 `{ baseUrl, serviceToken }` Worker 内部已保存 Agent default Relay Key 候选读取服务；API 只发送服务端解析的 Owner/Agent/配置修订/Key version，响应仅含候选 metadata；Key 明文与 ciphertext 不进入 API/Web |
| `nativeMetadata` | 已经组装好的 API reader；它只能调用固定 Worker ingress，不能直连 RuntimeHost 或自行签发 proof |
| `nativeMetadataWorker` | 默认装配输入：固定 Worker `{ baseUrl, serviceToken }`。Platform API 使用自身的 Platform Store `PostgresConversationQueryV1` 自动解析 exact Execution→原始 Host scope，并创建 Worker gateway client；不再要求部署方实现 `resolveRequest` |
| `nativeMetadataResolveRequest` | 可选的显式 resolver override，仅用于受控 deployment/test seam；必须同时提供 `nativeMetadataWorker`、`nativeMetadataRequestRegistry` 和消费同一 registry 的 `nativeMetadataCurrent`。生产默认路径不要配置它 |
| `nativeMetadataRequestRegistry` | 显式 resolver override 的有界原请求关联；使用 `createRuntimeNativeMetadataRequestRegistryV1`，reader 与 current checker 必须共享同一实例。不能从 wire 或数据库恢复旧 context |
| `nativeMetadataCurrent` | 可选的 current-confirmation override。与默认 reader 组合时，必须由 `nativeMetadataWorker.requestRegistry` 显式提供同一 registry；缺失即拒绝启动。未配置时，API 自动使用 request-local registry、现有 ConversationAuthorization 和同一个 Worker service token 装配 current route；过期、释放、跨 binding、撤权和 authorization revision 变化均 fail closed |
| `nativeCapabilityMetadata` | native command/Skill admission 的可信 metadata revalidation port；必须来自已认证的当前 Runtime metadata boundary，缺失时 admission 保持 unavailable，平台不提供 fake 默认值 |
| `providerImport` | 可选的受控 Skill Hub Provider import port：部署方提供已获准 registry、ObjectStorage、source verifier、scanner 和 admission policy；HTTP 只提交 provider/name/version 选择，不能提交 archive bytes、存储路径、trust、policy 或 approval 事实；不要同时放入 `apiInput.providerImport`。版本详情也只从同一 ObjectStorage 按固定对象版本有界读取 `SKILL.md` 与资源清单；未提供时详情内容显示不可用。网页编辑的 Skill 项目发布复用同一 ObjectStorage、scanner 与 admission policy（含签名 key 与 trust/policy 修订），来源证明由平台项目供应生成，不调用这里的 source verifier；未提供时网页发布返回不可用，项目内容仍可编辑 |
| `directorySearch` | 查询当前用户和组织目录记录的函数，返回 canonical ID、可读名称及邮箱或组织路径；依赖不可用时抛错。每条记录须符合浏览器契约 `DirectorySearchItemV1`（`kind`、非空 `canonicalId`、字符串 `displayName`，可选字符串 `email`、`organizationPath`），其他字段不进入响应；抛错或记录不符合契约时 `GET /api/v2/directory/search` 返回 503 `DEPENDENCY_UNAVAILABLE` |

`apiInput.taskAdmissionPolicy` 必须由真实部署配置显式提供。`maximumWaitingTasksPerAgent`
是每个 Agent 的等待任务容量（单位：任务），`waitingTimeoutMs` 是等待期限（单位：毫秒）；
两者均为正安全整数。平台不提供隐含生产默认值；缺失或无效时启动失败。
测试 fixture 中的受控数值仅用于测试，不是生产建议值，也不能通过关闭 Task 路由绕过配置。

Relay Key 策略必须作为配置模块 `apiInput` 的 `agentDefaultRelayKeyPolicy` 和
`personalRelayKeyValidation` 字段提供；两者来源必须与模板 `modelBinding`、Model Catalog 端点和固定 billing transport 一致。
`agentDefaultRelayKeyPolicy` 可以使用兼容的单端点 `{ relayEndpointId, relayBaseUrl, templateBindings }`，
或使用受信多端点 `{ relayEndpoints: [{ endpointId, baseUrl, protocol }], templateBindings }`。
两种格式不能混用。多端点列表只允许部署配置提供，`endpointId` 必须唯一；每个端点必须与 Model Catalog 的精确 ID、URL、协议、TLS
和重定向策略一致。模板的 digest 与 Driver 协议仍由 `templateBindings` 校验，不能由 Owner 或请求方覆盖。
任一字段缺失时，Platform API 仍可启动，但以稳定的 `PLATFORM_RELAY_KEY_POLICY_MISSING` degraded
warning 只列出缺失字段名，不输出 Relay Key、endpoint、billing URL 或 credential 内容；依赖缺失策略的
标准模板申请保持失败关闭。

API 直接创建 Agent 由 `apiInput.agentApiCreation` 开启。`allowedPrincipals` 列出获准的应用或用户主体，规则见[工程 Spec](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md)。
省略 `agentApiCreation` 或列表为空时，直接创建保持失败关闭。
标准模板创建时提交的默认 Relay Key 默认按上面两项 Relay Key 策略校验，与 Web 申请同源；任一策略缺失时，标准模板的 API 创建同样失败关闭。
只有部署需要不同的 endpoint/模型策略时，才另外提供受审阅的 `candidates` adapter，并且必须同时提供对应的
保存时验证 `verify`；只提供其一时标准模板的 API 创建失败关闭（见[标准模板的模型与推理档位](#标准模板的模型与推理档位)）。

标准模板使用独立镜像仓库时，部署配置须为每个模板提供 `modelBinding.imageRepository`，
其 `templateId` 和 `imageDigest` 必须与模板登记一致，并与 Worker 对应的
`templateModelBindings` 匹配。API 按模板的不可变 `imageReference` 执行 Registry 准入；
Worker 按受信 `imageRepository` 拉取相同 Digest。它们可使用经部署验证的镜像代理。
全局 `apiInput.imageRepository` 继续约束 custom 单镜像和多服务镜像；没有显式模板仓库时，
标准模板也必须属于该全局仓库。不能删除全局仓库配置来迁就多模板，否则多服务无法准入。

Registry 返回的配置 blob 若需跳转到对象存储，部署可通过
`apiInput.registry.allowedBlobRedirectOrigins` 登记精确 HTTPS origin（例如
`https://pkg-containers.githubusercontent.com`）。默认不允许跳转；只支持配置 blob 的一次
302/307 跳转，不向存储端转发 Registry Authorization，读取后仍校验大小和 SHA-256。
API 与 Worker 的 Registry 配置应登记相同的获准存储 origin，禁止通配符或调用方覆盖。

API 创建时，镜像准入交给 `registry.policy.authorize` 的 `subjectRef` 不是用户 ID，而是
`api-subject-<sha256>`；其中 `<sha256>` 是 `JSON.stringify({ kind, id })` 的 SHA-256 十六进制，`kind` 为 `user` 或
`application`，`id` 为该主体的稳定 ID。部署策略必须能识别获准的 API 主体，例如把它映射回对应的用户 / 应用 ID 后再按原规则判定；
否则镜像准入返回 `rejected`，API 创建以 `400 INVALID_REQUEST` 失败。
Key 被 billing 拒绝时返回 `INVALID_REQUEST`；校验依赖不可用时返回 `DEPENDENCY_UNAVAILABLE`。

内置模块从 `PLATFORM_DATABASE_URL` 取数据库 URL，从上述 Secret 文件读取高熵
代理令牌，并覆盖 `apiInput` 中的
数据库和身份字段。缺失或无效配置启动失败。API 不接收 Worker 解密私钥、
Kubernetes 凭证或模型原始凭据。OIDC 按 issuer 和 sub 绑定平台稳定 ID。已有员工迁移与管理员配置见 [OIDC 配置](../local/oidc-identity.md)。平台禁用由数据库持续复核。

启动和验收入口见[本地生命周期](../local/README.md)。镜像内模块可加载、
代理令牌正确与否及 PostgreSQL 会话装配属于部署证据；实际 OIDC 登录、
停用传播、申请审批、Worker Pod/PVC、模型访问和重启持久化须单独实测。

## SkillSpector 原生扫描器

`providerImport.scanner` 可使用 `createSkillSpectorPackageScannerV1` 与
`createSkillSpectorAdapterV1` 组合，沿用现有发布 supplier。部署必须固定官方 CLI 的版本与规则集，
`engineVersion` 必须等于原生报告的 `metadata.skillspector_version`；`requiredAnalyzerIds` 必须从
已固定版本的源码和扫描策略确定，不能从待验报告推导，缺少任何必需账本条目均拒绝。
`rulesetDigest` 是部署固定的规则集摘要，应包含这些必需分析器与配置，不来自发布请求。
CLI 以 `scan <archive> --no-llm --format json` 运行，不传平台自定义
参数，不发送内容给模型。它仍可能按官方行为向 OSV 查询声明的依赖坐标。

只有原生报告的执行成功、完整静态覆盖、逐文件清单与包内文件一致、analyzer 账本无失败/遗漏、
没有抑制结果时才生成既有扫描回执。退出码 1 的完整发现继续交给平台策略判定；进程错误、超时、
版本错配及不完整报告拒绝。`SAFE` 文案和退出码 0 不能单独使版本发布。

本适配只证明静态扫描，动态探测永远不会由它写成完成；部署策略要求动态探测时仍拒绝。真实 CLI
回归可通过仓库外的 `NATIVE_SKILLSPECTOR_EXECUTABLE` 指定固定版本的可执行文件运行。原生 CLI
与模型/动态执行的验收分别记录，不能把受控报告测试视为真实扫描。

## Skill 绑定的 Agent Version

Skill 绑定挂在 Agent Version 下。它是整个部署共用的固定值，来源与升级语义见
[工程 Spec §11.6](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#116-skill-hub版本绑定与-worker-装配)。
Platform API 从 `apiInput.agentVersion` 读取，Worker 从 `skillMaterialization.agentVersion`
读取，两边必须取同一个值。取值为 1–128 个字符，以字母或数字开头，只含字母、数字、`.`、`_`、`:`
和 `-`。

- Helm：设置顶层 `agentVersion`。非空时 Chart 以 `AGENT_INFRA_AGENT_VERSION` 把同一个值注入
  in-cluster API 与正式 Worker，两边的配置模块都从这个变量读取。external API 由其部署方注入同一个值。
- 本地：在 `.env` 设置 `AGENT_INFRA_AGENT_VERSION`。Compose 把它交给 API 容器，`platform.sh`
  用它设置 Worker 的 Helm 值；示例配置模块演示了两边的读取写法。

未配置时 API 照常启动，但 Skill 绑定读取不可用、写入一律拒绝，绑定页显示“暂时无法读取当前
Agent 版本”。取值不符合规则时 API 以 `PLATFORM_DEPLOYMENT_CONFIGURATION_INVALID` 启动失败。
标准模板升级不改变这个值，已有绑定沿用。修改这个值等于换用新的 Agent Version，原值下的绑定不会
出现在新值下，因此只在确实要切换版本时修改。

## 标准模板的模型与推理档位

标准模板的可选模型只来自 Agent 默认 Relay Key 调用 `/models` 返回的模型 ID。Relay 负责模型白名单。
推理档位是平台固定的 `low`、`medium`、`high`、`xhigh`、`max`，
不按模型、端点或模板登记。Web 申请、API 创建和配置更新在保存前用默认 Key 按模板协议，对每个
所选模型与档位各发一次有界的真实请求（Codex 用 Responses，Claude 用 Messages），全部通过才保存。
用已保存 Key 改模型时，只验证新增的组合；已保存的组合沿用原档位。决策与边界见
[ADR-0030](../../docs/adr/0030-source-standard-template-models-from-relay.md) 和
[工程 Spec §10.7](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#107-标准模板模型配置)。

旧配置中模板的 `codexModelProfiles`、模板绑定的 `reasoningLevels` 仍可读取，但会被忽略，可以在
后续配置变更中删除，不需要与镜像同时发布。端点的 `capabilities.reasoningLevels` 也不再限制标准
模板的选择。Runtime 镜像不再追加模型条目，固定 Codex 遇到未内置的模型时使用其默认回退元数据，
见 [Codex 运行装配](../runtime/README.md#固定镜像)。

所选模型或档位未通过验证时，Web 申请、API 创建与配置更新都返回 409 `MODEL_SELECTION_INVALID`；
验证请求被 Relay 以 401、403 拒绝时按 Key 无效处理，结果与 billing 拒绝该 Key 相同；超时或 Relay
返回 429、5xx 时返回 `DEPENDENCY_UNAVAILABLE`。

## 多服务 Agent 资源档位

多服务 Agent 的每个 Deployment、StatefulSet 和迁移 Job 都按平台档位注入资源；清单不能声明
container `resources`，`replicas` 固定为 1，用户 PVC 中的大小也不生效。档位与单 Agent 总量
上限由部署配置提供：

| 字段 | 含义 |
| --- | --- |
| `apiInput.multiServiceResourceProfiles` | 可选的档位数组，最多 64 项。每项为 `{ profileId, displayName, estimatedResources: { cpuMillicores, memoryMiB, storageGiB }, resources: { requests, limits }, storageSize? }`；`resources` 是注入容器的 Kubernetes 量，`estimatedResources` 用于总量估算，`storageSize`（如 `10Gi`）只对挂载 PVC 的 StatefulSet 生效 |
| `apiInput.multiServiceResourceCap` | 可选的单 Agent 估算总量上限 `{ cpuMillicores, memoryMiB, storageGiB }` |

清单通过 annotation `agent-infra.agora.io/resource-profile: <profileId>` 选择档位：工作负载自身
的 annotation 优先，其次是选中它的 Service；迁移 Job 只读取自身 annotation。都未声明时使用
平台内置的 `default` 档位：估算 `100m` CPU、`128` MiB 内存、`1` GiB 存储，注入
requests `25m`/`32Mi`、limits `100m`/`128Mi`，不设 `storageSize`。`default` 始终存在，
配置的档位不能使用该 ID。未配置上限时默认 `2000m` CPU、`4096` MiB 内存、`20` GiB 存储。
`GET /api/v2/deployment/configuration` 返回全部档位（不含 `resources`）、上限、默认档位 ID，
以及 `multiServiceResourceProfilesSource`（配置了档位为 `deployment`，否则为 `default`）；
Agent 详情的 `source.services` 返回每个 Service 实际使用的档位。

创建、修订申请和更新配置时，API 汇总每个 Deployment、StatefulSet 与迁移 Job 各一份估算量，
在调用 Registry 或写入任何数据前与上限比较。浏览器会话与 API Token 创建使用同一份配置；
超限返回 HTTP 409 `MULTI_SERVICE_RESOURCE_CAP_EXCEEDED`（`retryable: false`），引用未配置
的档位按普通准入拒绝处理。档位重复、使用 `default`、字段非法或上限非法时，生产 API 装配抛出
`PLATFORM_DEPLOYMENT_ADMISSION_CONFIGURATION_INVALID`，进程拒绝启动。

两项配置必须与 Worker 的 `workloadInput.policy` 同名字段取相同值，Worker 侧规则见
[Worker 部署说明](../platform-worker/README.md#多服务资源档位)。

## 文件数据面装配

文件能力有两种互斥来源：

- `configuration.mjs` 导出 `apiInput.files`（[`PlatformFileDeploymentV1`](../../apps/platform-api/src/file-assembly.ts)）。
- 环境变量 `PLATFORM_API_FILE_DEPLOYMENT_CONFIGURATION_FILE` 指向部署私有 JSON。变量为空时不启用；设置后文件缺失、不是普通文件、schema／密钥／令牌无效时启动失败。

两者同时提供返回 `PLATFORM_FILES_DUPLICATE`。配置字段、密钥与令牌约束、Actor 解析和失败语义见[文件存储部署与验收](../../docs/architecture/FILE-storage-deployment.md#生产部署装配)。`apiInput.files.runtimeWorkerId` 必须等于 Worker 的签名 identity；`services` 必须登记 Worker 注入的 runtime service token 所对应的 Agent。

本地 Compose 把该变量默认置空，只在私有 `.env` 中指向容器内绝对路径；Helm in-cluster API 不注入该变量，由部署配置模块显式导出。文件入口是否启用不影响无关 API 路由；启用后 S3、签名密钥或服务令牌不可用会拒绝文件请求，不会回退到无文件能力。

## HTTP 失败日志

每个请求结束时 Platform API 输出一条 `stage=http` 的结构化日志（5xx 为 error 级，4xx 为 info 级的
`outcome=rejected`）。被拒绝或失败的请求额外带有：

| 字段 | 含义 |
| --- | --- |
| `status` | HTTP 状态码 |
| `operationRef` | 方法加路由模板，例如 `POST.api.v2.agents.:agentId.lifecycle`；没有匹配到路由的请求是 `GET.unmatched`，不含具体 ID 和查询串 |
| `protocolCode` | 响应里的协议错误码，例如 `DEPENDENCY_UNAVAILABLE`、`RESOURCE_UNAVAILABLE`；只取这个有界标识，不记录响应正文；响应不是 JSON、正文超过 4 KiB 或 100 毫秒内没有读完时没有这一项 |

完成的请求（2xx、3xx）不带这些字段。日志不包含请求或响应正文、凭证、用户标识和 Agent ID。同一个请求
的 `requestId`、`traceId` 与响应里的 `traceId` 一致，可以用来对应一次具体的失败。

## 应用 Token 管理 Agent

机器人或服务复用独立应用及其 API Token；同一应用可获得多个 Agent 的显式授权。
个人 Token 继续使用用户主体。两种主体的同名 ID、幂等记录和审计归属分别处理。

| 操作 | HTTP 入口 | 当前权限 |
| --- | --- | --- |
| 授予、撤销应用管理权限 | `PUT` / `DELETE /api/v2/agents/{agentId}/application-managers/{applicationId}` | 当前有效的 Agent Owner 浏览器会话；责任人或管理员身份不替代 Owner |
| 授予、撤销应用使用权限 | `PUT` / `DELETE /api/v2/agents/{agentId}/application-use-grants/{applicationId}` | 当前有效的 Agent Owner 浏览器会话；与 manage 独立 |
| 查询 Agent 状态 | `GET /api/v2/agents/{agentId}/state` | Token 的 `agent:read` 范围与该主体当前 manage/use 授权 |
| 启动、停止、重启 | `POST /api/v2/agents/{agentId}/commands` | Token 的 `agent:manage` 范围与该主体当前 manage 授权 |

授予、撤销的请求体为 `{"schemaVersion":1}`。生命周期请求体为
`{"schemaVersion":1,"command":"start"}`，`command` 也可为 `stop` 或 `restart`。
写入操作均需 `Idempotency-Key`；重试仍复核当前权限，撤权后的旧请求不能恢复权限。
`start` 只接受已停止 Agent；管理员停用的 Agent 不可通过这些命令恢复。

调用接口使用 `Authorization: Bearer <API Token>`，不混用浏览器 Cookie 或自报身份字段。
Owner 治理入口分别修改应用 manage 或 use 授权，撤销一项不隐式撤销另一项，也不授予应用凭证材料权限。两项授权使用不同幂等命名空间；use 变更由原任务当前授权读取链路消费，不另建授权事实或取消状态机。凭证材料继续按
[工程 Spec §9.2](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#92-权限顺序)
独立处理。Token 范围、到期、撤销及当前主体状态在原管理事务内复核，状态、outbox、
幂等与必要审计共同提交。HTTP 返回管理状态，不等同于 Workload 已就绪。

### 一次性应用凭证材料交付

工程合同见[工程 Spec §9.2.1](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#921-应用凭证材料的进程外一次性交付)。
API 的受保护配置模块可导出以下非秘密配置；缺省或 `enabled: false` 保持关闭：

```ts
export const applicationCredentialMaterialDelivery = {
  schemaVersion: 1,
  enabled: false,
  publicOrigin: "https://platform.example.test",
  recipients: [
    { applicationId: "test-application-id", principalType: "user", principalId: "test-recipient-id" },
  ],
};
```

`publicOrigin` 必须是部署的精确 HTTPS origin。当前接收入口使用用户浏览器会话，`recipients` 仅接受 user 主体；
未接入应用接收身份，不允许借本次待签凭证自认证。配置列表不授予材料权限，仍须由当前系统管理员显式授予同一应用/主体的 material grant。
账号、应用 ID 和生产接收者由部署采用时核实，不使用示例值或 callback 占位消费者。

使用正式 `/api/v2/applications/{applicationId}/credential-material-deliveries` 创建意图，再由独立认证的接收者
POST `/{attemptId}/receive`。接收者仅在第一响应的 `kind: material` 中取得材料；重复请求只返回 `kind: metadata`。
接收者以返回的 credentialId/fence POST `/{attemptId}/confirm`，确认提交后才为 accepted；GET `/{attemptId}` 仅返回状态。
所有 POST 使用平台精确 Origin，管理意图还须有 Idempotency-Key；接收及确认 body 的 schemaVersion 为 1。

启用前须完成所有相关读写副本的兼容升级，且运输链为该专用响应关闭缓存、落盘、正文采样及自动重放；Helm 接线独立评审。
本次复用既有幂等表的非秘密 JSON 元数据及已有凭证校验表，无新增数据库迁移。未知结果只读核实原 attempt，不能重送原材料。
