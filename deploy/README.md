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
PLATFORM=linux/amd64 node deploy/release/build-images.mjs /tmp/agent-infra-images.json
```

该入口对每个镜像执行两次无缓存构建并比较 Digest，检查最终镜像的 non-root 用户，并以只读
根文件系统运行最小 probe。只有全部检查通过后才写入 image manifest；`PLATFORM` 也可设为
`linux/arm64`。

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
