# Kubernetes 交付拓扑

`deploy/helm/agent-infra` 提供 M1 Platform 的 Kubernetes 配置入口。它固定以下边界：

- `platform-worker` 始终部署在 Workload Plane，并只获得 release namespace 内的 RBAC。
- Web 与 `platform-api` 分别选择 `external` 或 `in-cluster`，两者不获得 Kubernetes API 凭证。
- Platform migration 使用独立的 Helm pre-install/pre-upgrade Job，并复用
  `platform-api` 的不可变镜像。
- 镜像只接受 `repository@sha256:<digest>`；values 不接受 Tag、内联数据库 URL 或密钥内容。
- `platform-api` 只挂载版本化加密公钥，`platform-worker` 只挂载包含同一版本的解密
  keyring，两个引用必须属于不同 Secret。
- Identity、Image Registry、Model Catalog、Object Storage、Kubernetes Runtime 和 Workload
  Route 只保存部署 Adapter binding，不限定部署产品或内部地址。

所有 values 都由 `values.schema.json` fail closed 校验。默认值只用于展示结构；部署前必须替换
镜像 Digest、Secret 引用、Adapter binding 和对外 Base URL。数据库兼容基线是 PostgreSQL 16
与 `expand-contract-v1` migration 策略。

`workloadTopology.enabled` 只用于拓扑验证。它渲染一个单副本 StatefulSet、无 Kubernetes API
权限的 ServiceAccount、PVC、内部 RuntimeHost 端口、受控路由端口、NetworkPolicy 和 TLS
Ingress。真实 Agent Workload 的创建、停止、升级、回滚和失败恢复仍由
[#190](https://github.com/AgoraIO-Extensions/agent-infra/issues/190) 的
KubernetesRuntimeAdapter 调谐；镜像发布与 release/rollback 校验属于
[#334](https://github.com/AgoraIO-Extensions/agent-infra/issues/334)。

## Helm 检查

```bash
helm lint deploy/helm/agent-infra \
  --values deploy/environments/kind.values.yaml \
  --strict
deploy/kind/topology.sh render
```

## 不可变镜像与 release 检查

从 clean Git commit 构建四个 Platform 镜像并生成 image manifest：

```bash
IMAGE_REPOSITORY_PREFIX=registry.example/agent-infra \
  PLATFORM=linux/amd64 \
  node deploy/release/build-images.mjs /tmp/agent-infra-images.json
```

该入口对每个镜像执行两次无缓存构建并比较 Digest，检查最终镜像的 non-root 用户，并以只读
根文件系统运行最小 probe。全部镜像通过后，入口使用现有 Docker 登录态发布唯一一份已验证
artifact；发布 Tag 由 Commit SHA 与目标 Platform 共同限定，避免不同架构互相覆盖。入口回读
Registry Digest 作为 image manifest 的权威引用；必须显式提供通用
`IMAGE_REPOSITORY_PREFIX`，`PLATFORM` 也可设为 `linux/arm64`。仅本机测试 Registry 可设置
`IMAGE_REGISTRY_INSECURE=true`，生产 Registry 必须使用 HTTPS。

RuntimeHost 镜像额外通过[Codex Pilot 原生 HTTP/SSE probe](runtime/README.md#镜像验证)，
对应证据与 image manifest 使用相同 commit 和镜像 Digest。

release、独立 migration 和 rollback 在部署前复用同一 Helm schema、模板与现有 migration
检查：

```bash
node deploy/release/validate.mjs release /tmp/agent-infra-images.json deployment-values.yaml
node deploy/release/validate.mjs migration /tmp/agent-infra-images.json deployment-values.yaml
node deploy/release/validate.mjs rollback current-images.json target-images.json target-values.yaml
```

release 和 migration 要求启用 migration Job；rollback 要求目标是另一份不可变 image manifest，
并关闭 migration Job。任一 image 引用与 manifest 不一致、配置无效或 migration 漂移都会在 Helm
部署前失败。三种检查都必须在 clean checkout 中执行；release 和 migration 的 `HEAD` 必须等于
image manifest 的 Commit，rollback 的 `HEAD` 必须等于 target image manifest 的 Commit，current
image manifest 只标识当前已部署 release。

## kind 拓扑验证

### Workload 调谐

生产 Worker 必须在 `platformWorker.deploymentModule` 显式配置部署镜像中已打包模块的绝对路径或 `file:///` URL，例如 `file:///app/deployment/platform-worker.mjs`；该示例不代表基础镜像包含此文件。仓库基础镜像不提供环境专属装配包，发布前必须在最终镜像内确认模块可加载并导出下述工厂。未配置路径时，生产 Helm 渲染失败；Kind 拓扑仅运行占位进程，不代表生产 Worker 可用。Worker 加载部署包导出的
`createPlatformWorkloadWorkerOptionsV1(signal: AbortSignal)`。部署包必须在装配前检查
signal，并把它传给数据库、网络和其他异步装配操作；取消后须停止继续创建资源并清理已经
创建的资源。收到 SIGINT 或 SIGTERM 后，Worker 会取消装配并停止已有循环；装配或停止未在
10 秒内全部完成时进程以状态 1 强制退出。该截止可能截断 60 秒 admission 排空，后续实例
依靠 Platform DB 中的持久化调谐状态恢复。

部署包装配 namespace-scoped Kubernetes client、ImageRegistryAdapter、Worker-only
Secret decryptor、资源和网络 Profile，
以及 RuntimeHost Client 的核心与 capability 探测。探测必须绑定传入的 Agent、
Workload revision 和固定 Service origin；`platform-adapter` 的核心探测必须满足
[Runtime HLD](../docs/architecture/HLD-agent-runtime-M1.md#4-runtime-manifest)。
Worker 不从 API RPC 获取期望状态，也不加载 Runtime Driver。

部署包必须显式提供 `templateModelBindings`，将标准模板 ID、实际镜像 Digest 与模型协议
绑定；支持标准 Agent 时还须装配 `modelCatalog` 和 `modelAccess`。升级已有部署包时需一起
补齐此字段，缺失会在 Worker 打开 Store 前拒绝启动。仅支持自定义 Agent 的部署包传入空
数组；标准 Agent 不会从模板名称或模型 ID 推断协议。绑定契约见
[Runtime HLD](../docs/architecture/HLD-agent-runtime-M1.md)。

迁移 `0012` 保存每个 Agent 的调谐进度、候选与已验证修订。Worker 在 Agent 行锁内
执行一个可重入步骤；多个 Worker 使用 `SKIP LOCKED` 处理不同 Agent。停止和停用
先关闭路由再缩容，升级先停止旧 Pod，再复用 PVC 启动候选。预检拒绝保留旧版本，
运行期候选失败则把已验证配置作为新的 Workload revision 调谐。新建失败清理完成后
才记录创建失败。Secret 明文只在 Worker 解密和 Kubernetes Secret 写入期间存在。

Agent 默认拒绝全部 egress，Profile 不接受 Owner 提交的任意网络规则。唯一受控出站
属于[后续生产化加固](../docs/architecture/PLAN-M1-delivery-convergence.md)，当前
Workload 调谐不开放直接 DNS 或可选代理出站，也不宣称完成外部模型与 Connection 出站能力。

独立的生命周期与网络测试使用 kind v0.30.0、Kubernetes v1.33.4 和 Calico v3.30.3：

```bash
pnpm build
bash deploy/kind/workload.sh
```

脚本创建临时 registry 与独立 kind cluster，构建两个不同 Digest 的合成测试镜像，
验证真实 Kubernetes RBAC、NetworkPolicy、版本化 Secret、PVC、停止/重启、路由切换、
失败候选回滚和资源清理，退出时删除该次测试资源。普通 `pnpm test` 不启动 kind；
CI 的 Workload kind job 单独运行本测试。网络插件安装依据
[Calico kind 安装说明](https://docs.tigera.io/calico/3.30/getting-started/kubernetes/kind)。

### 部署拓扑

安装 `kind v0.30.0`、Helm 3、kubectl 和 Docker 后运行：

```bash
deploy/kind/topology.sh up
deploy/kind/topology.sh verify
deploy/kind/topology.sh down
```

脚本使用固定的 Kubernetes `v1.33.4` node image Digest、独立临时 kubeconfig 和唯一集群名
`agent-infra-topology`。fixture Secret 只包含不可用于真实系统的占位内容。验证只覆盖资源、存储、
网络入口和 RBAC，不覆盖 [M1 工程架构 Spec](../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md)
定义的生命周期状态机或产品 E2E。
