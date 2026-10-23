# 本地 E2E Harness

本入口把本地 E2E 的源码、镜像、Compose 和 kind 资源绑定到一次可回读的运行。它不创建
第二套 Platform 部署逻辑：数据库、API、Web 和 Worker 生命周期仍由
[`platform.sh`](./platform.sh) 负责。

固定运行还会在同一 Compose project 内启动 `enterprise-directory-sync`。
Connection 服务由独立仓库部署，本地平台不再启动其健康检查脚手架；真实 Connection 联调仍需单独配置消费者授权。
目录同步服务使用本次运行自己的镜像、私有源适配、读取 Token、TLS 和数据库角色；Worker
通过本次运行创建且带 ownership 标记的 kind `Service`/`EndpointSlice` 访问它。禁止把旧项目
的目录容器或 EndpointSlice 接到当前 namespace。LDAP 与企业目录源的 host 映射只放在仓库外
的 env 文件，不能提交到 Git。

## 固定环境

默认环境必须使用同一组名称：

| 资源 | 名称 |
| --- | --- |
| Compose project | `agent-infra-e2e` |
| kind cluster | `agent-infra-e2e` |
| kube context | `kind-agent-infra-e2e` |
| namespace | `agent-infra-e2e` |
| Helm release | `agent-infra-e2e` |

在仓库外准备现有的 `deploy/local/.env.example` 副本，至少填写 Docker context、TLS、API
私有目录、Worker values、kubeconfig 和端口。Harness 会拒绝没有 upstream 的 branch、
发生分叉的 worktree、tracked 修改、未知 ownership 的同名 Kubernetes 资源和未绑定当前
Docker context 的 kind control-plane。当前 branch 可以包含尚未推送但基于 upstream 的提交；
如果 branch 落后 upstream，Harness 只做 fast-forward。

Docker context 所在 VM 的系统时钟不能回拨：Worker 签发的 Runtime Grant 若晚于 Host 当前
时间即被拒绝。Colima（Lima）VM 只保留 guest agent 与宿主机对时；VM 内 `systemd-timesyncd`
同时对时会与它反复拉扯，使时钟每 20–30 秒回拨约 100 ms，长回复间歇失败于
`RUNTIME_GRANT_INVALID`（#1888）。启动后执行
`colima ssh -p <profile> -- sudo timedatectl set-ntp false` 关闭 VM 内 NTP；它已写入的内核
频率校正保留到 VM 下次重启。

外网不可用时可显式设置 `E2E_HARNESS_OFFLINE=true` 使用已经回读的本地 upstream ref；这
不会刷新 remote，适合记录离线环境缺口，默认运行仍然强制 fetch。

## 镜像来源

四个标准 Runtime 模板（Codex、Claude、OpenCode、Pi）共用 Runtime Host 的已验证镜像
闭包；Kubernetes 调度 Worker、目录同步和 Sandbox/Base 镜像属于基础设施镜像集合。它们
优先从公开 GHCR 的 `sha-<sourceRevision>` tag 读取并立即回读 Digest。GHCR 缺少当前
开发分支的基础设施镜像时，Harness 可以用当前架构在干净临时 worktree 中本地构建并推送
到 GHCR，再按 Digest 使用；不会从当前脏目录发送 Docker context。

Kubernetes 调度 Worker、目录同步、Runtime Host 和 Sandbox/Base 镜像属于基础设施集合，
由 main push、release tag 或手动触发 `publish-images` workflow 发布。Platform Web/API 等
业务镜像不由 main push 发布，只有 release tag 或手动 `publish_platform=true` 才发布；本地
E2E 始终按当前 worktree 的 Platform 源码构建它们。

GitHub workflow 为基础设施镜像发布 `linux/amd64` 和 `linux/arm64`，并生成多架构 index。
业务镜像只有 release/tag 或手动 `publish_platform=true` 才进入发布 job。tag 只用于定位，
Helm、Worker 和 Agent 配置始终使用不可变 Digest。

## 命令

```bash
node deploy/local/e2e-harness.mjs sync
node deploy/local/e2e-harness.mjs images
node deploy/local/e2e-harness.mjs build
node deploy/local/e2e-harness.mjs deploy
node deploy/local/e2e-harness.mjs runtime
node deploy/local/e2e-harness.mjs verify
node deploy/local/e2e-harness.mjs all
```

`all` 依次同步当前 branch upstream、解析/构建基础设施镜像、从干净 tracked context 构建
Platform 镜像、执行数据库迁移、交付 Runtime 部署材料和 `platform.sh up`，最后回读组件状态。
`reset` 只接受
`PLATFORM_LOCAL_PROJECT=agent-infra-e2e`，并沿用 `platform.sh reset` 的 ownership 校验；
默认保留数据库卷、Agent PVC 和 GHCR 镜像。

Runtime 镜像绑定必须是当前节点架构的 OCI image manifest Digest：API 与 Worker 准入不接受
多架构 index。Harness 读取到 index 时只解析唯一的当前架构子 manifest，无法唯一解析即失败。

## Runtime 部署材料

`runtime` 阶段（`deploy`/`all` 在 `platform.sh up` 前也会执行）交付 Worker 的部署输入。
Worker 到 Runtime 是集群内明文 HTTP（[ADR-0020](../../docs/adr/0020-use-in-cluster-plaintext-runtime-transport.md)），
因此 Harness 不签发 Runtime CA 或 server leaf。它只写固定集群里带
`app.kubernetes.io/managed-by=agent-infra-e2e-harness` 的对象；同名但无此标记的对象直接失败：

- 按 `E2E_CLUSTER_DNS_FORWARD`（`zone=ip,ip;zone=ip`）向 CoreDNS 写入带标记的转发块，
  使 Worker 和 Runtime 能解析外部模型端点；未设置时移除该块。
- 把 `E2E_WORKER_TRUSTED_CA_FILES` 列出的 CA（例如目录服务和本地 Registry CA）合成为
  Worker 信任 bundle，写入 values 中 `platformWorker.trustedCaSecretRef` 指向的 Secret。
- 用 `PLATFORM_LOCAL_WORKER_CONFIGURATION` 发布 Worker 配置模块 Secret；
  `E2E_WORKER_DEPLOYMENT_FILES` 列出的私有只读输入以文件名为键加入同一 Secret，
  私有 adapter 从 `/var/run/agent-infra/deployment/` 读取。
- 从 Worker runtime-auth Secret 发布 Host transport token Secret（默认
  `platform-runtime-transport`，键 `token`，可用 `E2E_RUNTIME_TRANSPORT_SECRET` 覆盖），
  名称须与私有 `policy.runtimeAuth.serviceTokenSecret` 一致。

Worker 只在启动时加载这些材料；配置、部署输入或信任 bundle 变化时 Harness 更新 Pod 模板
注解并等待滚动完成。新 Agent 通过审批后，先执行 `runtime` 再等待或重试创建。

标准 Codex 模板的 Runtime readiness 不再用镜像内 Codex 的 `model/list` 核对模型选项
（[ADR-0030](../../docs/adr/0030-source-standard-template-models-from-relay.md)）。可选模型来自
Agent 默认 Relay Key 的 `/models`，私有 API/Worker Model Catalog 的 `allowedModels` 只做收窄
（`null` 不收窄）；推理档位固定为 `low`、`medium`、`high`，保存时用默认 Key 真实验证。私有配置里
旧的 `codexModelProfiles` 与模板 `reasoningLevels` 会被忽略，见
[Platform API 部署模块](../platform-api/README.md#标准模板的模型与推理档位)。

## 文件数据面（分阶段）

文件 E2E 仍由 #3060 跟踪，Harness 的 `verify` 不执行它。需要显式启用时才设置：

1. 把 `file-deployment.json`、Ed25519 签名密钥、Runtime 公钥和服务令牌文件放入
   `PLATFORM_LOCAL_API_DIRECTORY`（该目录只读挂到 API 的 `/app/deployment`），并设置
   `PLATFORM_LOCAL_API_FILE_DEPLOYMENT_CONFIGURATION_FILE=/app/deployment/file-deployment.json`。
   配置形状见[文件存储部署与验收](../../docs/architecture/FILE-storage-deployment.md#生产部署装配)。
2. 设置 `PLATFORM_LOCAL_FILE_EXCHANGE_ENABLED=true`，它是 `platform.sh` 的 Worker 侧文件面开关：
   - 向 Worker values 写入 `platformWorker.fileExchangeOrigin=http://<release>-native-metadata-api:3000`，
     以及它的出站声明 `platformWorker.fileExchangeEgress.ip=<API 在 kind 网络上的地址>`。该 Service 与
     EndpointSlice 只在 native metadata 路由启用时存在，未启用时 `up`/`validate` 在停止任何服务前失败。
     origin 必须是精确值，不能带路径或尾斜杠。
   - Platform API 在集群外：Sandbox 访问 origin 时经 Service 转发到 EndpointSlice 中的 API 地址，
     NetworkPolicy 按这个地址和 3000 端口放行。`up` 先沿用上次 EndpointSlice 记录的地址升级 Worker；
     API 重建并接入 kind 后地址不同（或首次 `up`、`stop` 之后尚无记录）时，再以新地址升级一次 Worker，
     期间 Web 保持关闭。地址变化会使已有会话 Sandbox 的 NetworkPolicy 漂移，按
     [文件存储部署](../../docs/architecture/FILE-storage-deployment.md#runtime-文件交换注入)的已有会话流程处理。
   - 把 Compose `object-storage` 以随机别名接入 kind 网络，并创建带 ownership 标记的
     `<release>-object-storage` Service 与 `<release>-object-storage-docker` EndpointSlice（端口 9000），
     Worker Pod 通过 `http://<release>-object-storage:9000` 访问对象存储。未设置时不接入，`up` 会清理
     本项目已有的接入；同名资源没有 ownership 标记，或容器已以其他别名接入 kind 时，`up`/`stop`
     在停止任何服务前失败退出。
3. `services[].tokenFile` 必须与 Worker 的 runtime-auth transport Secret（默认
   `platform-runtime-transport`／键 `token`，可用 `E2E_RUNTIME_TRANSPORT_SECRET` 覆盖）使用
   同一令牌，并登记允许的 Agent。Harness 不会把该令牌复制到 API 目录，避免隐式扩大 Secret 暴露面。
4. 准备可从 API 容器访问的 S3／MinIO bucket 和部署独占前缀；bucket 必须启用 versioning。
   未准备时不要启用文件入口，否则上传与交换会失败。

固定环境的 kindnet 会执行 NetworkPolicy：文件交换只为 Agent Pod 与会话 Sandbox 放行上述 API 地址的
3000 端口，Worker 除 native metadata 端口外的其他端口和对象存储仍不可达。本地往返只证明本地声明可用，
生产须按自己的 API 位置声明目的地。

### Worker 企微媒体装配

企微长连接的入站与出站媒体需要 Worker 部署输入 `wecom.media`，字段与收发规则见
[企微文本渠道部署「媒体」](../../docs/architecture/WECOM-text-deployment.md#媒体)。在上面的文件面之上：

1. 在仓库外准备对象存储凭证文件，例如 `object-storage-credentials.json`，内容与 API
   `storage.credentialsFile` 同形状（严格 JSON `{"accessKeyId","secretAccessKey","sessionToken"?}`），
   可以是 API 使用的同一份访问密钥。使用部署私有的访问密钥，不要使用仓库 `docker-compose.yml`
   中的 MinIO 本地默认值。
2. 把该文件的绝对路径加入 `E2E_WORKER_DEPLOYMENT_FILES`。Harness 以文件名为键把它并入 Worker 配置模块
   Secret，Worker 从 `/var/run/agent-infra/deployment/object-storage-credentials.json` 读取；凭证不写入
   Helm values、Pod env、日志或 Git。这是本地固定环境的例外：
   [Worker 部署模块](../platform-worker/README.md#配置模块形状)不允许把凭证放进代码 Secret，
   生产对象存储凭证仍经部署凭证供应链提供。
3. 私有 `configuration.mjs` 用 `createS3ObjectStorageV1` 创建 Adapter，并放进现有 `wecom` 导出：

   ```javascript
   import { readFile } from "node:fs/promises";
   import { createS3ObjectStorageV1 } from "@agent-infra/object-storage";

   const storage = createS3ObjectStorageV1({
     endpoint: "http://agent-infra-e2e-object-storage:9000",
     // region、bucket、prefix、maxObjectBytes 与 API file-deployment.json 的 storage 取相同值。
     region: "us-east-1",
     bucket: "agent-infra-files",
     prefix: "e2e/",
     maxObjectBytes: 26214400,
     timeoutMs: 30000,
     credentials: JSON.parse(
       await readFile("/var/run/agent-infra/deployment/object-storage-credentials.json", "utf8"),
     ),
   });
   export const wecom = { /* 现有身份、连接与 setup 输入 */ media: { storage } };
   ```

   `storage` 同时提供 `upload`、`inspect` 与 `download`，因此入站与出站媒体都会装配。bucket 和 prefix
   必须与 API 一致：入站写入的文件要由 API 交给 Agent，出站读取的是 API 写入的结果文件。
4. `maxObjectBytes` 是对象存储 Adapter 的硬上限：超过它的对象写入被拒绝，读取失败。
   取与 API `storage.maxObjectBytes` 相同的值，并让企微 Channel 生效的 FileLimits 交集 `maxBytes`
   不超过它。入站按 FileLimits 交集与 Driver 单文件上限（50 MiB）中较小的一个判断是否过大；
   该值高于 `maxObjectBytes` 时，两者之间的媒体会按“文件接收失败”回复，而不是“文件超过 {上限}”。
5. 为企微 Channel 声明 FileLimits 后执行 `deploy`：它先交付部署输入（变化时滚动 Worker），
   再由 `platform.sh up` 在 Worker 升级前创建对象存储路由。只执行 `runtime` 不会创建该路由。

## 配置模块

API/Worker 的私有 `configuration.mjs` 是部署 adapter，不是业务代码或 Secret 容器。
可复制 [`environment.mjs`](./environment.mjs) 到同一私有目录：基础 URL、开关和文件路径
用环境变量读取，敏感值只通过 `_FILE` 读取。LDAP、目录、Registry、Model Catalog、
Kubernetes policy、签名和 keyring 仍由受审阅 factory 组装；它们不能通过任意字符串环境变量
绕过类型和当前事实校验。Worker 的 `templateModelBindings` 使用 Harness 提供的
`AGENT_INFRA_RUNTIME_IMAGE_REPOSITORY` 与 `AGENT_INFRA_RUNTIME_IMAGE_DIGEST`，并继续由
部署准入和真实模型/容量事实确认。

API/Worker 的基础业务镜像构建完成后，Harness 会自动读取仓库外的
`<state>/api-overlay` 与 `<state>/worker-overlay`（存在 `Dockerfile` 时）重新生成同名
E2E 镜像；这些 overlay 只补齐当前部署 adapter 的真实运行依赖，避免下一次构建覆盖掉
`enterprise-directory`、目录读取和私有包。LDAP 登录属性（例如 `uid` 或 `mail`）由私有
deployment adapter 按目标目录明确配置，并与浏览器登录入口使用的账号格式一致；重建镜像不会
改变该配置。

## 验收边界

Harness 的 `verify` 只表示固定环境、镜像、Secret 引用、Worker 和 Runtime readiness 已
通过。真实 LDAP 登录、申请/审批、模型凭证、Agent Workload、真实模型 SSE 和 Connection
仍须通过现有浏览器 E2E 入口显式完成；任何 mock、静态 healthz、wrapper 或上游 patch 都
不能把 readiness 失败改写为成功。失败 Secret 只能通过正式 UI 重新生成 pending Secret，
不能直接修改业务数据库。
