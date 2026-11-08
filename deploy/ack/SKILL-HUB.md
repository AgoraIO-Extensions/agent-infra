# ACK Skill Hub 装配

产品与权限边界见 [PRD §11.5](../../docs/prd/PRD-agent-platform-M1.md#115-skill-hub)，
版本、包准入与运行装配见[工程 Spec §11.6](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#116-skill-hub版本绑定与-worker-装配)。
本文说明部署输入，不是当前 ACK 的验收记录。

## API 与包供应

API 配置模块须提供真实 `providerImport`：版本化 S3 兼容存储、当前来源校验、扫描器与
admission policy。固定包样本不能替代网页项目供应。API 镜像必须实际包含所配置的扫描器，
其版本、规则集与分析器清单按 [SkillSpector 部署说明](../platform-api/README.md#skillspector-原生扫描器)固定。

ACK `skillHub.enabled` 会在 API Pod 的 init container 中从固定 digest 的 Platform API 镜像投影
其内置的 `clamscan`、动态库和预加载的签名数据库；API 配置必须把 scanner executable 指向该只读投影，
不能继续指向不存在的 `/usr/bin/clamscan` 或空数据库目录。扫描器随 API 镜像 source-bound 发布，
升级时必须一起回读其 ClamAV engine 与 `rulesetDigest`。

API 镜像构建时由官方 FreshClam 更新并自检签名库，再执行要求无警告的原生扫描；
上游镜像自带数据库用于版本检查及复用未变更的完整库。更新失败或扫描出现过期警告时构建失败。
更新关闭本地增量重建，固定使用官方签名的完整 CVD；同版本本地生成的 CLD 可能字节不同，
不能用于要求规则集摘要及镜像可复现的发布。两次独立镜像构建仍须通过既有摘要一致性检查。
签名库固化在最终镜像中，运行中不更新；部署须在库过期前重新发布镜像，并同步当前
admission policy 的 engine 与 `rulesetDigest`，不能忽略警告或改写已发布包的扫描回执。

Signer 由部署维护；同一发布的签名必须能在 API 重启、多副本和 Worker 校验时验证。
不得在配置模块加载时临时生成签名 key。签名私钥只进入 API；Worker 只读取对应的公钥、
当前 key 状态及 trust/policy 修订。缺少包存储、扫描器或当前信任输入时，发布保持不可用。

## 固定版本与 Worker 交付

ACK private values 可显式启用有界交付：

```yaml
agentVersion: skill-hub-v1
skillHub:
  enabled: true
```

API 自动读取 `AGENT_INFRA_AGENT_VERSION`；模块若显式声明 `apiInput.agentVersion`，两者必须
一致。Worker 的 `skillMaterialization.agentVersion` 使用同一环境值，不能从模板或 Agent 请求派生。

启用后 Chart 将 Worker 与 Runtime 的 UID 分开，并准备 Worker 独占的内存 assembly root。
配置模块仍须导出完整的 `skillMaterialization`：

- `assemblyRoot` 取 `PLATFORM_WORKER_SKILL_ASSEMBLY_ROOT`；`runtimeUid` 为标准 Runtime 的 UID。
- `delivery.client` 使用当前 namespace 的 `createWorkerKubernetesClientV1`。
- `workloadInput.policy.skillDeliveryImage` 使用 Chart 注入的 `PLATFORM_WORKER_SKILL_INIT_IMAGE`；
  未显式配置时 deployment entry 使用该环境值，显式值与环境值不一致时拒绝启动。
- `store` 复用 `PostgresSkillHubAgentBindingAdmissionV1` 的原发布、同步与 Applied 方法。
- `actor` 可使用受信异步 resolver，每次按 Agent 当前 Owner 和当前 Directory 状态解析主体、
  组织及管理员事实；不能使用请求提交的身份，也不能为所有 Agent 固定一个测试用户。
- 对象存储、公钥、来源与当前扫描 policy 沿
  [Worker 原发布证据消费者](../platform-worker/README.md#skill-原发布证据消费者)装配。

`skillHub.enabled` 不会生成这些业务输入。声明开启但 materializer、固定版本、namespace、
assembly root 或 init image 不完整、不一致时，Worker 拒绝启动。

启用 `skillHub.objectStorage` 时，ACK Chart 会在当前 namespace 创建独占的 `agent-infra-minio`
Service、PVC 和单副本 MinIO，并用 post-install/post-upgrade Job 创建同名 bucket、开启 versioning。
访问密钥只从预先创建的 Secret 引用；API/Worker 配置中的 S3 endpoint、bucket、prefix 和凭证必须
与这些值完全一致。不要把现有其他 namespace 的 MinIO 当作该 Skill 包存储。

MinIO 默认使用同一固定 API 镜像中的二进制，bucket hook 使用 API 声明的生产 S3 SDK 依赖，
开启 versioning 后立即回读确认。PVC 带有 Helm 保留策略，回滚或卸载不会删除已发布包；
数据清理由版本、配置和执行引用的生命周期决定，不能作为失败部署的自动回滚步骤。

配置模块的最小结构如下；具体数据库、目录、公钥、存储和扫描实现必须继续使用部署已有的
适配器，不能把下面的占位函数直接部署：

```typescript
import { PostgresSkillHubAgentBindingAdmissionV1 } from "@agent-infra/platform-store";
import { createWorkerKubernetesClientV1 } from "@agent-infra/platform-worker";

const skillAdmission = new PostgresSkillHubAgentBindingAdmissionV1({
  databaseUrl: process.env.PLATFORM_DATABASE_URL,
});
const skillKubernetes = createWorkerKubernetesClientV1(process.env.PLATFORM_WORKER_NAMESPACE);

export const skillMaterialization = {
  storage, // versioned S3-compatible ObjectStorageDataV1
  assemblyRoot: process.env.PLATFORM_WORKER_SKILL_ASSEMBLY_ROOT,
  runtimeUid: 1000,
  delivery: { client: skillKubernetes },
  agentVersion: process.env.AGENT_INFRA_AGENT_VERSION,
  actor: async ({ agentId }) => resolveCurrentOwnerActor(agentId),
  store: {
    resolveSyncBindings: skillAdmission.resolveSyncBindings.bind(skillAdmission),
    readPublication: skillAdmission.readPublication.bind(skillAdmission),
    recordAppliedReceipt: skillAdmission.recordAppliedReceipt.bind(skillAdmission),
  },
  resolveAdmissionPolicy,
  sourceVerifier,
};
```

`runtimeUid` 必须与 Worker UID 不同，并匹配实际 Runtime 文件主体。
`resolveCurrentOwnerActor` 每次物化均查询当前 Directory/Platform 权威，不能返回固定测试用户。

## 字节与挂载

此交付方式用于 Worker、Agent 与 Session 不在同一节点、不能共同挂载 RWO 云盘的部署。
它不搬迁现有 `/workspace`，也不将 Agent 可写卷挂入 Worker。

Worker 在自己的 Agent 专属目录验证和生成完整 generation，逐文件核对摘要后创建并回读
Agent/generation/configuration 绑定的不可变交付 Secret，再写 Applied receipt。
每次准备 Workload 或 Session 都重新验证交付对象。固定 Worker 镜像中的 init entrypoint
按 Pod 内冻结的交付摘要，将文件复制到独立内存卷，检查完整文件集合及摘要，并封存为普通只读文件。
Runtime 只读挂载 `.agents`，不挂载交付 Secret；init container 不接收 DB、签名私钥、
Worker service token 或长期对象存储凭据。

Worker 的 assembly root 使用 128 MiB 内存临时卷；包供应的 50 MiB 单包上限和 generation 保留策略
必须共同纳入部署容量评审，超过容量时物化失败并保持原 Applied 状态。

交付 init 镜像随原 Workload Desired/Applied 的 `skillDeliveryImage` 冻结，Session 使用
原已验证部署中的值。Worker 升级不会把旧 Pod 的 init 镜像换成当前 Worker 镜像；旧 PVC 模式
继续使用原挂载。无 Skill 绑定时不增加 generation 挂载，保留原工作区路径。

当前有界交付总 payload（包括 `SKILLS.md`）最多 512 KiB，最多 2001 个文件；超过上限拒绝，
不回退到缺少实际字节的 PVC 或伪造 Applied。包供应的全局上限不变，部署应在绑定前明确该交付限制。
交付对象在原配置及执行仍可引用时保留，不因新 generation 发布而覆盖或批量删除。
已有 Skill generation 的旧 PVC 交付模式保持原配置；模式切换须先按原生命周期排空并明确验证。
此前没有 Skill generation 的 Agent 在新配置修订中首次绑定时，可采用当前部署声明的有界交付，
不改变原可写工作区。已有有界交付的新配置继续沿用已验证的 init 镜像；不能仅凭 Pod 身份存在、
消失或 Worker 镜像升级重新推断交付方式。

## 真实验收

用同一份 source-bound 发布与部署输入完成：

1. 两个合法主体分别回读创建、内容保存、发布、自动准入或独立审核，以及安装；不能批准本人共享发布。
2. Owner 绑定固定版本，回读 configuration revision、Worker sync/Applied、generation 和交付对象身份。
3. 实际 Pod 的 init container 完成；Runtime 按需读取的 bytes/digest 与发布 manifest 一致。
4. 同一会话发现并使用该 Skill，持久化真实工具结果，刷新及 Runtime 重启后回读。
5. 分别验证超限/损坏/撤销拒绝、升级提示、重复提交/CAS，以及跨主体、Agent 和 Session 隔离。

健康检查、交付对象创建、Applied、实际挂载与业务结果是不同证据，不能互相代替。
