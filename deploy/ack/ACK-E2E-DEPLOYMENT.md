# ACK 部署前提与历史 E2E 记录（脱敏）

本文保留早期 ACK 试部署记录及仍适用的配置前提；历史状态不代表当前集群或新版本已验收。
新部署、搬迁和清空后重建以[ACK 重部署工作流](./ACK-REDEPLOY-WORKFLOW.md)及其
`run-capsule.ts` / `redeploy.sh` 入口为准，每轮重新核对 source/image/config 和真实业务证据。
真实 LB IP、企微 Corp ID、镜像
digest、Secret 名和集群细节属于部署机器状态，只允许出现在仓库外的 private env/values；
仓库内 chart 和脚本使用占位符，`deploy.sh` 会拒绝未替换的占位值。不要把真实值补回本文件。

## 历史入口

- 早期前端使用 `https://<ACK_LB_IP>/`，并配置了 HTTP 入口；新部署按其实际 HTTPS Origin 验证，不能用 HTTP 回退绕过证书错误。
- 早期 HTTPS 使用 ACK Ingress LoadBalancer 和临时自签名证书，证书的 SAN 为该 LB IP；新部署证书必须匹配实际主机名。
- IngressClass 由目标集群提供，名称放在 private values 中。
- ACK kubeconfig 使用仓库外受保护副本，不写入仓库。

浏览器信任与 HTTP 探针信任分别验证；私有 CA 的配置见下文。Web 的 `/api/*`、`/auth/*`
由 Nginx 反代到 `agent-infra-api`，路径可达不等于真实登录成功。

## 历史试部署组件与当前 Chart 前提

Namespace 示例为 `agent-infra`。首次试部署使用受控 raw manifests，不是 Helm release；
这不描述当前安装。ACK 专用 Chart 见 [`chart`](./chart)，其依赖和 immutable image 由
仓库外 private values 指定。默认 `migrations.enabled=false`、`postgres.enabled=false`；
全新安装按重部署工作流显式配置 PostgreSQL 和 migrations，已有环境先核对实际 Helm/资源
归属，不能因历史记录而接管或覆盖已有对象。

Chart 默认声明 `agent-infra-ack-quota` ResourceQuota：25 个 PVC、500Gi 请求存储、30 个 Pod 和 50 个 Service，覆盖保留的 Session Sandbox PVC。接管已有 namespace 前必须核对 quota 的 `hard/used`，不能用默认值覆盖其他租户的预算；Chart 不删除历史 PVC，回收由 Session Sandbox 生命周期负责。

可复用入口为 [`preflight.sh`](./preflight.sh) 和 [`deploy.sh`](./deploy.sh)，环境变量模板为 [`ack.env.example`](./ack.env.example)，值文件模板为 [`values.ack.example.yaml`](./values.ack.example.yaml)。`preflight.sh` 会检查 ACK 访问、Helm chart、所有 E2E Secret 和目录 source ConfigMap，不会打印 Secret 内容。

加密版本由 private values 的 `encryption.keyVersion` 和 `worker.keyVersions` 显式提供，默认仍为 `key-v1`；values schema 会拒绝空值、非法字符和不完整的 worker 版本列表。wrapper 不生成或替换任何密钥。

| 组件 | 结果 | 说明 |
| --- | --- | --- |
| Web | `1/1 Running` | GHCR amd64 immutable image；公网 Ingress |
| Platform API | `1/1 Running` | 使用 E2E API configuration；连接 ACK PostgreSQL |
| Platform Worker | `1/1 Running` | 使用 ECI virtual-kubelet，带 `type=virtual-kubelet` selector 和 `virtual-kubelet.io/provider=alibabacloud:NoSchedule` toleration |
| PostgreSQL | `1/1 Running` | ACK ESSD PVC，`alicloud-disk-essd` |
| Platform migration | `Complete` | 使用 Platform API image 执行 |
| Enterprise Directory Sync | `1/1 Running` | 使用 E2E source adapter；HTTPS Service |
| Directory migration | `Complete` | 独立 migration Job |

上表是早期运行观察，不是当前就绪清单。该轮目录同步 `/readyz` 返回 `200`，快照有效
（成员与部门数量不写入仓库）。当时 Worker 通过 ACK Service 名称访问目录，并保留了
E2E 证书的 `enterprise-directory-sync` SAN 和同名 Service alias；迁移时重新核对实际名称与证书。

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

镜像只引用 immutable digest，由仓库外 private values 提供；Chart 默认占位 digest 会被
部署入口拒绝。实际 package 可见性与拉取权限应按目标环境回读；需要认证时使用声明的
Kubernetes pull Secret，不能由历史可见性推断当前可拉取。发布凭据的 Actions Write 与
部署拉取权限是两个独立条件，详见[发布与拉取](./ACK-REDEPLOY-WORKFLOW.md)。

## 验证

使用 private env 中声明的精确 Origin、kubeconfig 与 namespace。私有 CA 示例：

```bash
curl --cacert "$ACK_CA_CERT_FILE" -I "${ACK_PUBLIC_ORIGIN%/}/"
curl --cacert "$ACK_CA_CERT_FILE" "${ACK_PUBLIC_ORIGIN%/}/api/v2/agents"
kubectl --kubeconfig "$ACK_KUBECONFIG" -n "$ACK_NAMESPACE" get deploy,pod,job,svc,ingress,pvc
```

使用系统信任链时省略 `--cacert`，保留主机名校验；Node probe 的私有 CA 使用
`NODE_EXTRA_CA_CERTS`。这些是连通性检查，未登录的 `401` 不证明账号密码、Session 或授权 API 可用。

早期记录中的验证结果：

- 前端 HTTPS 返回 `200`；
- `/api/v2/agents` 未登录返回 `401 AUTHENTICATION_REQUIRED`；
- API、Web、PostgreSQL、Directory Sync 和 ECI Worker 均已运行；
- Platform/Directory migration 均完成；
- Directory `/readyz` 返回 `200`，快照有效。
- 当时 `helm lint deploy/helm/agent-infra` 和 `helm lint deploy/ack/chart` 均通过，`helm list` 为空；这是早期 raw-manifest 安装的事实，不可作为新部署归属判断。
- `helm template ack-e2e deploy/ack/chart --set ingress.enabled=false | kubectl apply --dry-run=server -f -` 通过 ACK API 校验；Ingress 因线上已有同名 wildcard 路由未在该 dry-run 中重复提交；Helm wrapper 对 ACK Ingress 开启 HTTP→HTTPS 重定向，`publicOrigin` 由每个环境的实际 LB 地址填写。登录回归探针：无 Origin 的合成请求会被安全边界拒绝；带 `Origin: https://<ACK_LB_IP>` 的合成请求到达 LDAP 校验并返回 `401`，证明 Web→API token 和 HTTPS 转发链路已打通。

## 每轮部署的真实业务验收

早期 Web Nginx 未注入 API proxy token 且覆盖外部 HTTPS 标记，导致 `/auth/login` 被安全
边界拒绝。Web entrypoint 从 Secret 渲染 token 并保留 HTTPS 转发标记修复了该接入缺口，
但入口修复、匿名 `401` 和合成 Runtime 启动探针都不能代替真实登录与业务结果。

每轮按[重部署工作流](./ACK-REDEPLOY-WORKFLOW.md)回读真实登录、Session、授权 API、
四模板真实模型完成事实、当前自定义 Agent 的多轮对话及单/多服务自有入口。
实际 Pod/imageID、主体/Session 绑定与 source/config 必须对应本轮；旧成功、Pod Ready 和
文档中的历史状态不能填入新运行的验收结果。API 模型目录等可选配置的迁移要求见
[配置模块与模型目录](./ACK-REDEPLOY-WORKFLOW.md#配置模块与模型目录)。
