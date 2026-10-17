# Platform API 部署模块

本地 Compose 从镜像内加载[部署模块](../../apps/platform-api/src/deployment-entry.ts) 编译成的
`deployment.mjs`，并只读挂载 API 专属
`configuration.mjs` 到 `/app/deployment`。内置模块创建第一方 LDAP 目录、
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

| 导出 | 契约 |
| --- | --- |
| `ldap` | [`LdapIdentityConfiguration`](../../packages/identity/src/ldap.ts)，含实际 LDAP（`tls: true` 默认使用 LDAPS，`tls: false` 使用 LDAP，见工程 Spec §9.1）、受控 `verifyCurrentStatus` 和持久 issuer/UID 映射；无需专用 active 属性 |
| `isPlatformDisabled` | 查询当前 Platform PostgreSQL 用户停用状态的函数；依赖不可用时抛错，不能返回默认 `false` |
| `organizationIds` | 从 #889 当前目录快照解析完整组织映射的函数；不可用时抛错 |
| `directorySnapshot` | 可选的通用快照 consumer：`{ endpoint, token, organizationIdForDepartment }`。配置后每次敏感身份解析从 HTTPS 当前快照按 LDAP email 唯一匹配 active 成员，并映射组织 ID；失败不得回退到旧 `organizationIds`。快照 revision/fetchedAt/validUntil 已由 consumer 校验，但现有 LDAP identity wire 尚未携带 sidecar，跨 #481/#508/#440 的不可变版本绑定仍需后续契约接收。 |
| `publicOrigin` | 与本地 HTTPS Web 相同的精确 Origin |
| `apiInput` | [`ProductionPlatformApiInputV1`](../../apps/platform-api/src/deployment.ts) 中除 `databaseUrl`、`identity` 外的真实 Registry、模板、ModelCatalog、密钥公钥、准入和展示依赖；其中必须包含与模板 `modelBinding`/Model Catalog 端点一致的 `agentDefaultRelayKeyPolicy` 和 `personalRelayKeyValidation` |
| `customAgentGateway` | 可选的部署端 Gateway port：提供 `resolveDeployment`、`authorizeAgent`、签名 issuer/key version/private key；不要同时放入 `apiInput.customAgentGateway` |
| `modelSelection` | 可选的 Runtime ACP model-directory reader；应由部署方用 `createRuntimeModelSelectionReaderV1` 和受认证 transport 组装；不要同时放入 `apiInput.modelSelection` |
| `modelDirectory` | 可选的 `{ baseUrl, serviceToken }` Worker 内部模型目录服务输入；配置后 API 自动从 Platform Store 绑定当前 Web Conversation/Execution/Session/fence，并创建默认 `modelSelection` reader；不要同时提供 `modelSelection` |
| `savedKeyCandidates` | 可选的 `{ baseUrl, serviceToken }` Worker 内部已保存 Agent default Relay Key 候选读取服务；API 只发送服务端解析的 Owner/Agent/配置修订/Key version，响应仅含候选 metadata；Key 明文与 ciphertext 不进入 API/Web |
| `nativeMetadata` | 已经组装好的 API reader；它只能调用固定 Worker ingress，不能直连 RuntimeHost 或自行签发 proof |
| `nativeMetadataWorker` | 默认装配输入：固定 Worker `{ baseUrl, serviceToken }`。Platform API 使用自身的 Platform Store `PostgresConversationQueryV1` 自动解析 exact Execution→原始 Host scope，并创建 Worker gateway client；不再要求部署方实现 `resolveRequest` |
| `nativeMetadataResolveRequest` | 可选的显式 resolver override，仅用于受控 deployment/test seam；必须与 `nativeMetadataWorker` 同时提供。生产默认路径不要配置它 |
| `nativeMetadataCurrent` | 可选的 current-confirmation override。未配置时，API 自动使用 request-local registry、现有 ConversationAuthorization 和同一个 Worker service token 装配 current route；过期、释放、跨 binding、撤权和 authorization revision 变化均 fail closed |
| `nativeCapabilityMetadata` | native command/Skill admission 的可信 metadata revalidation port；必须来自已认证的当前 Runtime metadata boundary，缺失时 admission 保持 unavailable，平台不提供 fake 默认值 |
| `providerImport` | 可选的受控 Skill Hub Provider import port：部署方提供已获准 registry、ObjectStorage、source verifier、scanner 和 admission policy；HTTP 只提交 provider/name/version 选择，不能提交 archive bytes、存储路径、trust、policy 或 approval 事实；不要同时放入 `apiInput.providerImport` |
| `directorySearch` | 查询当前用户和组织目录记录的函数，返回 canonical ID、可读名称及邮箱或组织路径；依赖不可用时抛错 |

`apiInput.taskAdmissionPolicy` 必须由真实部署配置显式提供。`maximumWaitingTasksPerAgent`
是每个 Agent 的等待任务容量（单位：任务），`waitingTimeoutMs` 是等待期限（单位：毫秒）；
两者均为正安全整数。平台不提供隐含生产默认值；缺失或无效时启动失败。
测试 fixture 中的受控数值仅用于测试，不是生产建议值，也不能通过关闭 Task 路由绕过配置。

Relay Key 策略必须作为配置模块 `apiInput` 的 `agentDefaultRelayKeyPolicy` 和
`personalRelayKeyValidation` 字段提供；两者来源必须与模板 `modelBinding`、Model Catalog 端点和固定 billing transport 一致。
任一字段缺失时，Platform API 仍可启动，但以稳定的 `PLATFORM_RELAY_KEY_POLICY_MISSING` degraded
warning 只列出缺失字段名，不输出 Relay Key、endpoint、billing URL 或 credential 内容；依赖缺失策略的
标准模板申请保持失败关闭。

内置模块从 `PLATFORM_DATABASE_URL` 取数据库 URL，从上述 Secret 文件读取高熵
代理令牌，并覆盖 `apiInput` 中的
数据库和身份字段。缺失或无效配置启动失败。API 不接收 Worker 解密私钥、
Kubernetes 凭证或模型原始凭据。issuer/UID 映射由 `@agent-infra/platform-store` 的 `PostgresLdapIdentityIds` 提供，使用同一 Platform 数据库 URL；正式迁移自动创建映射表，首次成功 LDAP 认证时原子分配随机平台 ID，部署方无需手工录入 UID 对应表。`isPlatformDisabled` 查询现有 `platform_user_disables` 表。示例固定值、内存映射和历史 Authentik proof 不能作为真实身份验收。

启动和验收入口见[本地生命周期](../local/README.md)。镜像内模块可加载、
代理令牌正确与否及 PostgreSQL 会话装配属于部署证据；实际 LDAP 登录、
停用传播、申请审批、Worker Pod/PVC、模型访问和重启持久化须单独实测。

## 标准 Codex 模板的模型画像

`apiInput.templates` 中 `modelBinding.driver` 为 `codex` 的模板必须提供
`codexModelProfiles`：一个非空数组，每项为 `{ model, reasoningLevels }`，内容必须是该模板
`imageDigest` 镜像内固定 Codex 的 `model/list` 结果。申请和配置准入用它提前拒绝固定 Codex
不支持的模型或推理档位；Runtime readiness 仍按同一列表做 fail-closed 校验。其他 driver 的模板
不得提供该字段。缺失、为空、格式无效或出现在非 Codex 模板上时，Platform API 拒绝启动，日志为
`Platform API failed to start: codex_model_profiles_<missing|invalid|unexpected> (template <templateId>)`，
不包含任何配置值。

用模板镜像离线生成该列表，镜像 digest 变化时必须重新生成：

```bash
docker run --rm -i --network none --entrypoint node \
  <registry>/agent-runtime-host@sha256:<digest> --input-type=module - \
  < deploy/runtime/codex-model-profiles.mjs > codex-model-profiles.json
```

[`codex-model-profiles.mjs`](../runtime/codex-model-profiles.mjs) 在容器内以临时空 HOME 启动
`codex app-server`，按 Runtime 相同的分页读取含隐藏项的 `model/list`；不联网、不读取凭证，
失败时只输出固定错误码。把生成的数组原样写入私有配置的 `codexModelProfiles`。Model Catalog
的 `allowedModels` 仍只应列出该数组中存在、且模型端点实际可用的模型。

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
