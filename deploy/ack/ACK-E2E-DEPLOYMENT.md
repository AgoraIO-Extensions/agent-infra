# ACK 真实环境 E2E 部署记录（脱敏）

本文件只保留 ACK 真实环境 E2E 的部署方式和验收结论。真实 LB IP、企微 Corp ID、镜像
digest、Secret 名和集群细节属于部署机器状态，只允许出现在仓库外的 private env/values；
仓库内 chart 和脚本使用占位符，`deploy.sh` 会拒绝未替换的占位值。不要把真实值补回本文件。

## 入口

- 前端：`https://<ACK_LB_IP>/`，HTTP 备用入口 `http://<ACK_LB_IP>/`。
- HTTPS 使用 ACK Ingress LoadBalancer 和临时自签名证书，证书的 SAN 为该 LB IP。
- IngressClass 由集群提供，本次使用 ACK 的 `new-magic-nginx`。
- ACK kubeconfig 使用仓库外受保护副本，不写入仓库。

浏览器第一次访问 HTTPS 会提示自签名证书。前端构建注入了 `/auth/login` 和 `/auth/logout`，Web 的 `/api/*`、`/auth/*` 由 Nginx 反代到 `agent-infra-api`。

## 已部署组件

Namespace 示例为 `agent-infra`。首次试部署使用受控 raw manifests，不是 Helm release；ACK 专用 Helm wrapper 见 [`deploy/ack/chart`](./chart)，它复用现有 E2E Secret、目录 source ConfigMap 和 GHCR immutable image，真实环境值只放在仓库外 private values。默认 `migrations.enabled=false`、`postgres.enabled=false`，适合接管已初始化的 ACK 数据库；全新集群可显式开启 PostgreSQL 和 migrations。当前线上资源仍由 raw manifests 管理，wrapper 已完成 `helm lint`、渲染校验和 ACK server dry-run。

可复用入口为 [`preflight.sh`](./preflight.sh) 和 [`deploy.sh`](./deploy.sh)，环境变量模板为 [`ack.env.example`](./ack.env.example)，值文件模板为 [`values.ack.example.yaml`](./values.ack.example.yaml)。`preflight.sh` 会检查 ACK 访问、Helm chart、所有 E2E Secret 和目录 source ConfigMap，不会打印 Secret 内容。

复用现有加密配置时，在 private values 中设置 `encryption.currentKeyVersion` 为 API 公钥对应的版本，
`encryption.workerKeyVersions` 为 Worker keyring 已具备的版本列表；后者必须包含当前版本。
两者默认均使用 `key-v1`。这些字段只声明已有密钥版本，不生成密钥；轮换时应保留解密历史数据所需的旧版本。

| 组件 | 结果 | 说明 |
| --- | --- | --- |
| Web | `1/1 Running` | GHCR amd64 immutable image；公网 Ingress |
| Platform API | `1/1 Running` | 使用 E2E API configuration；连接 ACK PostgreSQL |
| Platform Worker | `1/1 Running` | 使用 ECI virtual-kubelet，带 `type=virtual-kubelet` selector 和 `virtual-kubelet.io/provider=alibabacloud:NoSchedule` toleration |
| PostgreSQL | `1/1 Running` | ACK ESSD PVC，`alicloud-disk-essd` |
| Platform migration | `Complete` | 使用 Platform API image 执行 |
| Enterprise Directory Sync | `1/1 Running` | 使用 E2E source adapter；HTTPS Service |
| Directory migration | `Complete` | 独立 migration Job |

目录同步 `/readyz` 返回 `200`，快照有效（成员与部门数量属于环境数据，不写入仓库）。Worker 通过 ACK Service 名称访问目录；保留了 E2E 证书的 `enterprise-directory-sync` SAN，并创建了同名 Service alias。

## Session Runtime 的 ECI 调度

`scheduling.worker` 只决定 `platform-worker` 调度服务本身的位置，不决定它创建的 Session
Runtime Pod。常驻平台服务可以使用同一集群的普通节点，按会话创建的执行 Pod 使用 ECI。

Kubernetes 1.36 及以上可在仓库外 private values 显式开启：

```yaml
scheduling:
  worker:
    nodeSelector: null
    tolerations: []
sessionRuntimeScheduling:
  enabled: true
  architecture: amd64
```

`nodeSelector: null` 用于清除 chart 默认的 Worker selector；空对象会与默认值合并。

该选项默认关闭，使用 GA `MutatingAdmissionPolicy`，不依赖外部调度 Webhook。策略和绑定
同时限定 Helm release namespace、`agent-infra.agora.io/managed=session-sandbox-v1`
标签与 Pod `CREATE` 操作；只补 ECI nodeSelector 和 provider toleration，保留其他非冲突调度
字段，不修改容器、安全上下文、资源、身份或凭证。重复求值不追加相同 toleration。
开启该选项的部署账号需要创建集群级准入策略的权限，低于 1.36 的版本在渲染阶段拒绝。
关闭选项只影响后续 Pod 创建，已有 Pod 仍沿原有生命周期运行。

ECI 调度成功不代表网络策略生效。还须单独验证目标 Driver 的内核能力、实际模型调用、
持久卷、出站和入口隔离；不能用 Pod Ready 或已创建 NetworkPolicy 对象代替真实负向验证。
Runtime image 必须是 `architecture` 对应的不可变 manifest Digest。

## E2E 配置迁移

迁移来源为当前 E2E harness 生成的仓库外 private 配置快照；该目录只作为部署输入，不进入 Git。

已迁移到 ACK Secret 的内容包括：

- API `configuration.mjs`、LDAP secret、directory identity bindings、encryption public key、directory read token、template validation 和 object-storage credential 文件；
- Worker `configuration.mjs`、directory identity bindings、execution capacity profiles、runtime grant、service token 和 keyring；
- Directory source adapter、service key、目录 TLS 证书和 read token。

仅替换了部署拓扑相关输入：

- `enterprise-directory-sync` 使用 ACK Service；
- Worker namespace 改为部署 namespace；
- Registry endpoint/prefix 改为 GHCR；
- Platform public origin 改为实际 LB origin；
- Worker Runtime image repository 改为 GHCR；
- `storageClassName` 改为 ACK 的 `alicloud-disk-essd`。

没有把 Secret 明文、LDAP 密码、service key 或私钥写入仓库、镜像或日志。

## 镜像

镜像只引用 immutable digest；当前 ACK 使用的 amd64 digest 由仓库外 private values 提供，仓库 chart 默认值为占位 digest，`deploy.sh` 会拒绝未替换的占位值。GHCR 的 Web/API/Worker package 为 public；目录和 PostgreSQL package 受组织可见性策略影响，因此 ACK 使用只包含 GHCR 凭据的 Kubernetes pull Secret `ack-ghcr-pull`。

## 验证

```bash
curl -k -I https://<ACK_LB_IP>/
curl -k https://<ACK_LB_IP>/api/v2/agents
kubectl -n <ACK_NAMESPACE> get deploy,pod,job,svc,ingress,pvc -o wide
```

已验证：

- 前端 HTTPS 返回 `200`；
- `/api/v2/agents` 未登录返回 `401 AUTHENTICATION_REQUIRED`；
- API、Web、PostgreSQL、Directory Sync 和 ECI Worker 均已运行；
- Platform/Directory migration 均完成；
- Directory `/readyz` 返回 `200`，快照有效。
- `helm lint deploy/helm/agent-infra` 和 `helm lint deploy/ack/chart` 均通过；ACK 当前 `helm list -n agent-infra` 为空，线上资源仍是 raw manifests。
- `helm template ack-e2e deploy/ack/chart --set ingress.enabled=false | kubectl apply --dry-run=server -f -` 通过 ACK API 校验；Ingress 因线上已有同名 wildcard 路由未在该 dry-run 中重复提交；Helm wrapper 对 ACK Ingress 开启 HTTP→HTTPS 重定向，`publicOrigin` 由每个环境的实际 LB 地址填写。登录回归探针：无 Origin 的合成请求会被安全边界拒绝；带 `Origin: https://<ACK_LB_IP>` 的合成请求到达 LDAP 校验并返回 `401`，证明 Web→API token 和 HTTPS 转发链路已打通。

## 仍需真实业务验收

登录入口已经配置。此前 ACK Web Nginx 未注入 API proxy token 且覆盖了外部 HTTPS 标记，导致 `/auth/login` 被 API 安全边界拒绝；现已通过 Web entrypoint 从 Secret 渲染 token，并保留/设置 HTTPS 转发标记。实际账号登录仍依赖 E2E 配置中的 LDAP endpoint、用户凭据和网络可达性；本次没有读取或生成用户密码，也没有伪造登录成功。Runtime Host 已补齐 ACK 所需的 amd64 版本并完成 ECI 启动探针：在 ECI virtual-kubelet 节点上成功拉取并启动，返回 `status=ready`、`port=3003`。探针使用合成配置，不能替代真实用户 Agent Workload 验收；真实首通仍需终端用户登录、Relay 和模型凭据。
