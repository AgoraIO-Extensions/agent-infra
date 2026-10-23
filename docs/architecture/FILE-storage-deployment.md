# 文件存储部署与验收

文件权威与授权以[工程 Spec §15.4](SPEC-agent-infra-M1-engineering-architecture.md#154-文件)为准；本页说明装配和操作，不改变产品保留政策。

## 装配

Platform API 的 `PlatformApiAssemblyInput.files` 接收部署创建的 ObjectStorage Adapter、文件签名密钥、原 Execution Grant V4 验签公钥与其签名 Worker identity（`runtimeWorkerId`）、服务身份到允许 Agent 的映射，以及当前用户与文件限制查询。配置了文件能力但缺少 `runtimeWorkerId` 时装配必须 fail-closed；缺失整体配置时不注册文件入口，带附件的 Message 被拒绝。生产 deployment builder 已由 #3064 实现；四模板文件 E2E 与固定环境验收仍由 #3060 跟踪，本页不据此声明已全面交付。

使用 `createS3ObjectStorageV1` 创建 S3 Adapter。bucket 必须启用 versioning，并支持条件创建、按版本读取、版本列举及删除。部署独占一个前缀；所有对象引用均由平台生成。endpoint、region、bucket、prefix、凭证和 SDK 只在 Adapter／部署模块内配置。生产凭证通过部署凭证供应链提供，不写入仓库。

### 生产部署装配

Platform API 通过 `PLATFORM_API_FILE_DEPLOYMENT_CONFIGURATION_FILE` 指向部署私有的 JSON 配置。变量未设置或为空时不注册文件入口；设置但文件缺失、不是普通文件、JSON 或 schema 无效、密钥不匹配时启动失败，不回退到部分能力。示例中的路径均为容器内绝对路径，令牌与私钥只从只读文件读取：

```json
{
  "schemaVersion": 1,
  "storage": {
    "region": "us-east-1",
    "bucket": "agent-infra-files",
    "prefix": "prod/",
    "maxObjectBytes": 26214400,
    "timeoutMs": 30000,
    "endpoint": "https://s3.example.internal",
    "credentialsFile": "/var/run/agent-infra/files/s3-credentials.json"
  },
  "signing": {
    "issuer": "platform-api",
    "keyVersion": "file-2026-01",
    "privateKeyFile": "/var/run/agent-infra/files/signing-private.pem",
    "publicKeys": [
      {
        "keyVersion": "file-2026-01",
        "publicKeyFile": "/var/run/agent-infra/files/signing-public.pem"
      }
    ]
  },
  "runtime": {
    "issuer": "platform-worker",
    "workerId": "worker-a",
    "publicKeys": [
      {
        "keyId": "grant-a",
        "publicKeyFile": "/var/run/agent-infra/files/runtime-grant.pem"
      }
    ]
  },
  "limits": {
    "intentTtlMs": 86400000,
    "accessTtlMs": 900000,
    "maxConcurrentTransfers": 16
  },
  "services": [
    {
      "tokenFile": "/var/run/agent-infra/files/api-service-token",
      "agentIds": ["agent-a"]
    }
  ]
}
```

- `signing` 与 `runtime` 公钥使用 Ed25519；签名公钥必须与私钥匹配，密钥 ID 在各自集合内唯一。
- `services[].tokenFile` 至少 32 个可打印 ASCII 字符；同一令牌不得登记到不同条目。服务身份只来自该令牌，不接受请求体自报。
- 每个 TTL 不超过 24 小时，`maxConcurrentTransfers` 为 1–256。
- `storage.credentialsFile` 可选，内容为严格 JSON `{"accessKeyId","secretAccessKey","sessionToken"?}`，不写环境变量。
- 配置错误返回 `PLATFORM_FILE_DEPLOYMENT_CONFIGURATION_INVALID`，可附带静态字段名；日志、错误和测试不得回显配置值、路径或令牌。
- 部署模块也可以直接导出 `apiInput.files`。显式端口与环境配置只能二选一，同时提供时以 `PLATFORM_FILES_DUPLICATE` 拒绝。

文件 Actor 在每次交换时通过与浏览器会话相同的当前身份映射（部署对象暴露的 `resolveCurrentIdentity`）重新从 LDAP 当前目录与 Platform 停用状态解析，不复用浏览器会话或请求中的旧身份；目录、停用记录或组织快照查询失败时拒绝请求，停用账户以 `accountStatus: "disabled"` 拒绝。

文件数据面只接受平台路径和 `X-Platform-File-Grant` Header。浏览器同时携带当前会话；Worker 同时携带服务身份。S3 签名地址仅用于平台内部上传，不返回给用户或 Runtime。

`readLimits` 按当前 Agent configuration revision 和 Channel 返回 Agent、Channel、deployment 三方声明；平台再次检查已验证 capability，取支持类型与大小的交集。声明需要版本和有效期，缺失或过期拒绝。S3 Adapter 对实际内容探测类型、计数并计算 SHA-256；支持的声明必须与部署选择的可验证格式一致。普通历史读取不以 Agent 运行状态或新的执行输入限制为前提。

### FileLimits 声明存储

三方声明保存在 Platform DB 的 `platform.file_limit_declarations`（迁移 `0060_file_limit_declarations.sql`），以 `scope` 区分 `deployment`、`agent`、`channel`；Channel 声明同时绑定所属 Agent。每条记录包含单调递增 `revision`、`expiresAt`、`maxBytes`、`mediaTypes`，以及最后写入者与时间。写入使用 `Idempotency-Key` 与 `expectedRevision` 比较并交换：`null` 创建，revision 不一致返回 409 且不修改任何事实；相同键与请求摘要的重放返回原记录。

Agent 与 Channel 声明通过 `/api/v2/agents/{agentId}/file-limits`、`/api/v2/agents/{agentId}/channels/{channelId}/file-limits` 写入，只有当前 Owner/Co-owner 或 system_admin 可以读写；Deployment 声明通过 `/api/v2/admin/deployment/file-limits` 写入，只有 system_admin 可以读写。部署声明选择 Platform DB 行而非部署常量：它同样需要 revision、有效期和审计，固定环境可以在不新增部署环境变量的情况下通过正式 API 配置，是否装配文件面仍由部署决定。所有路由拒绝 `Authorization` Header、查询串和调用方提交的主体字段；Actor 由服务端会话解析，已撤销的管理员在下一次请求即被拒绝。

`PlatformFileDeploymentV1.readLimits` 保留为部署覆盖点；缺省时 Platform API 装配用 Platform DB 读取器读取三方声明，并以 `agents.current_configuration_revision` 作为配置修订事实。读取器返回的修订与调用方已验证的配置修订不一致时装配层拒绝；`resolveFileLimitsV1` 继续执行三方交集，缺失、过期或空交集返回 `null`；声明读取不可用会拒绝请求而不是放行。

## Worker 与恢复

### Runtime 文件交换注入

Worker 只有同时拿到精确的 Platform API origin 与 runtime-auth service token 引用时，才向 Agent Pod 和会话 Sandbox Pod 注入这两个变量：

- `AGENT_INFRA_RUNTIME_FILE_EXCHANGE_ORIGIN=<exact origin>`：两类 Pod 取同一值。
- `AGENT_INFRA_RUNTIME_FILE_EXCHANGE_SERVICE_TOKEN`：`secretKeyRef`，不是字面量。Agent Pod 指向 `runtimeAuthSecretRef`；会话 Sandbox 指向本 Sandbox 专属 Secret 的 `file-exchange-token` 键，值是 Worker 按本 Sandbox 分配派生的凭据，部署 token 不进入 Sandbox。派生规则见[工程 Spec §10.1.1](SPEC-agent-infra-M1-engineering-architecture.md#1011-session-owned-sandbox-权威与资源绑定)，Platform API 的校验见 [§15.4.2](SPEC-agent-infra-M1-engineering-architecture.md#1542-认证数据面与短期授权)。

来源为部署模块 `WorkloadRuntimeAuthV1.fileExchangeOrigin`，或固定环境的 `PLATFORM_WORKER_FILE_EXCHANGE_ORIGIN`（Helm `platformWorker.fileExchangeOrigin`／本地私有环境）。两者同时提供返回 `PLATFORM_WORKER_FILE_EXCHANGE_DUPLICATE`；只给 origin 而没有 Runtime auth 返回 `PLATFORM_WORKER_FILE_EXCHANGE_CONFIGURATION_INVALID`；origin 不是精确的 `http(s)://host[:port]`（无路径、查询、片段、凭据；明文仅限集群 DNS 名称）同样拒绝。配置错误在写入任何 Kubernetes 资源之前发生。

未提供 origin 时不注入两个变量，Runtime Host FileBridge 保持关闭，`capabilities.attachments` 为 false。只注入一个变量时 Runtime Host 以 `RUNTIME_CONFIGURATION_INVALID` 拒绝启动。Workload 不能通过自定义 `env` 添加 `AGENT_INFRA_RUNTIME_FILE_EXCHANGE_*`，命中即按 policy 拒绝。

令牌轮换：更新 deployment-owned runtime-auth Secret，并重启 Worker 与 Agent Workload；Platform API 的 `services[].tokenFile` 必须同时登记该令牌和允许的 Agent。会话 Sandbox 的派生凭据随部署令牌变化，Platform API 用同一登记令牌重新计算，无需另行登记。不得把令牌复制到 Pod env 字面量、Helm values、日志或错误。

已有会话 Sandbox：开启、关闭或修改 origin 会改变 Sandbox Pod 的 env 与 Secret 键，按 Spec §10.1.1 判为漂移（unknown/conflict），不原地修复，也不会自动替换。新建会话直接使用新配置；已有会话需对所属 Agent 执行一次停止再启动（管理意图，在原 PVC 上重建），或等空闲回收后由下一条消息恢复。部署配置了 Connection 投递时，漂移的 Sandbox 在替换前拒绝新 Turn（可重试）；未配置时仍路由到旧 Pod，旧 Pod 的 FileBridge 保持关闭。部署令牌轮换同样沿 §10.1.1 的受控停止与重建流程更新 Sandbox。

会话 Sandbox 的 NetworkPolicy 复用 Agent Workload 的 egress 声明（模型、Connection、native metadata 与 DNS），文件交换不会自动追加规则。生产 NetworkPolicy 是 allow-list egress，部署必须在 Agent egress 声明中放行该 Platform API origin 的端口，它同时作用于 Agent Pod 与会话 Sandbox；本地 kind（kindnet）不强制执行 NetworkPolicy，本地联调通过不证明生产可达。

`createWorkerFileClientV1` 提供输入读取与结果写入。它使用 RuntimeHost 已验证的原始 V4 Execution Grant 调用 `RuntimeFileExchangeRequestV2` 交换入口（`schemaVersion=2`、`executionGrant`、操作、单一文件引用或结果描述、幂等键），随后携带文件 Grant 与服务身份传输字节；不接受调用者指定的对象键或存储地址。旧 V1 自报身份 wire 继续被拒绝。原 Grant 仅证明执行委托范围，交换后的当前授权由持久 Conversation、Execution、generation、delivery fence、停止/终态和 `task_authorization_records` 决定，File Grant 有效期取部署 `accessTtlMs`。实际 Driver 文件桥接不属于本模块。

结果写入的 `idempotencyKey` 标识永久不变的写入意图。访问到期后，调用者可传入新的 `accessIdempotencyKey` 换取该意图的新临时权限；不要换一个意图键重试同一结果。已确认对象只允许重放完成确认，不能重新上传或覆盖字节。执行终态、撤权或代次变化仍拒绝执行授权。

部署在 `PlatformWorkloadWorkerOptionsV1.files` 提供清理配置后，现有 Worker 轮询同时执行文件对账并在停止时关闭其 Store。独立调度也可调用 `createPlatformFileReconciliationWorkerV1(...).runOnce()`，并在退出时调用 `close()`。单次最多处理 `batchSize` 个过期意图及一个不超过同一大小的对象版本页，`batchSize` 为 1–100。数据库保存扫描游标，协调锁避免多 Worker 同时推进；失败页保持游标供重试。`orphanGraceMs` 由部署政策设置，避免过早处理新对象。

协调器标记过期未完成上传，按确切对象版本删除孤立、失败、过期或已标记删除的对象，保留文件记录防止引用复用。迟到写入在后续扫描中再次清理。已确认历史文件不因 Agent 停止、升级、重启、停用或执行结束被清理。正式历史的保留由部署政策负责，本模块没有用户删除或会话导出接口。

## 验收

使用仓库固定的 Node／pnpm 工具链。完整 `pnpm test` 包含文件的真实 HTTP／PostgreSQL／MinIO 验收；单独执行 `pnpm test:file-authority` 前需构建 workspace 依赖。

测试创建随机命名、仅绑定 loopback 的独立容器，并仅回收这些容器。Fake 与 S3 使用同一对象契约，测试覆盖版本固定、重放、并发、过期、对象缺失、冲突及重复清理。平台联测覆盖上传、下载、结果写入、同入口跨用户拒绝、撤权与旧代次拒绝。V4 文件交换另覆盖签名伪造、错误 issuer/Worker/audience、控制用途、非 allowlist 文件、终态、停止、撤销的 `task_authorization_records`、fence/generation 变化，以及可读与不可读文件一致的 404。FileLimits 声明另有 PostgreSQL 集成测试覆盖持久化、revision 比较并交换、幂等重放、过期与配置修订失配；HTTP 路由测试覆盖 Owner、非 Owner、已撤销管理员、过期声明与 revision 冲突。

发布验收记录只保留 source commit、配置版本、对象存储实现／镜像 digest、测试命令和结果。禁止记录文件正文、服务凭证、JWS 或内部签名 URL。测试通过不替代后续文件消费者整装与人工验收。

本次（#3064）的自动化覆盖：builder 的合法装配、缺字段／未知字段／相对路径、非 Ed25519／公私钥不匹配／重复密钥、令牌与私钥脱敏、凭证文件严格解析；Worker 的 origin 注入、Secret 引用、半配置／重复／非法 origin、Workload 自带变量拒绝；Runtime Host 的双变量与精确 origin 校验；Helm 渲染与 schema。以下仍未执行，保留为 #3060 的验收项：四模板真实文件 E2E、固定环境浏览器上传／下载／结果写回、生产 S3 bucket 与 NetworkPolicy egress 装配。

会话 Sandbox 注入（#3276）的自动化覆盖：Sandbox 的 origin 与 Secret 引用注入、未配置不注入、非法配置在写入前拒绝、Pod 与 Secret 中无部署 token、开关文件交换判为漂移并经管理停止/启动重建；Platform API 的 Sandbox 派生凭据接受，以及部署 token、另一 Sandbox、旧 fence、未就绪分配的拒绝（含 PostgreSQL 联测），Agent 级执行的登记令牌路径不回归。固定环境的带附件 Turn 与结果文件回传仍待 #3230 验收。
