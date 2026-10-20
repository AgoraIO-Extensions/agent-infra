# ACK E2E 配置部署记录

## 当前入口

- 前端：`https://118.178.91.138/`
- HTTP 备用入口：`http://118.178.91.138/`
- HTTPS 使用 ACK Ingress LoadBalancer `118.178.91.138` 和临时自签名证书，证书包含该 IP 的 SAN。
- IngressClass：`new-magic-nginx`。
- ACK kubeconfig 使用仓库外受保护副本，不写入仓库。

浏览器第一次访问 HTTPS 会提示自签名证书。前端构建注入了 `/auth/login` 和 `/auth/logout`，Web 的 `/api/*`、`/auth/*` 由 Nginx 反代到 `agent-infra-api`。

## 已部署组件

Namespace：`agent-infra`。本次 ACK 试部署使用受控 raw manifests（通过 `codex-ack-deploy` 应用），不是 Helm release；仓库现有 chart 仍需要补齐 ECI selector/toleration、E2E Secret 投影和 ACK Ingress/ESSD 参数后，才能作为可复用的 Helm 发布入口。

已补充 ACK 专用 Helm wrapper：[`deploy/ack/chart`](./chart)。它使用现有 E2E Secret、目录 source ConfigMap 和 GHCR immutable image，不在 chart 中保存敏感值；默认 `migrations.enabled=false`、`postgres.enabled=false`，适合接管当前已初始化的 ACK 数据库。全新集群可显式开启 PostgreSQL 和 migrations。当前线上资源仍由 raw manifests 管理，wrapper 已完成 `helm lint`、渲染校验和 ACK server dry-run；Web 登录代理修复已同步到源 Dockerfile/Helm values，后续新部署会自动注入 API proxy token。可复用入口为 [`preflight.sh`](./preflight.sh) 和 [`deploy.sh`](./deploy.sh)，环境变量模板为 [`ack.env.example`](./ack.env.example)，值文件模板为 [`values.ack.example.yaml`](./values.ack.example.yaml)。`preflight.sh` 会检查 ACK 访问、Helm chart、所有 E2E Secret 和目录 source ConfigMap，不会打印 Secret 内容。

| 组件 | 结果 | 说明 |
| --- | --- | --- |
| Web | `1/1 Running` | GHCR amd64 immutable image；公网 Ingress |
| Platform API | `1/1 Running` | 使用 E2E API configuration；连接 ACK PostgreSQL |
| Platform Worker | `1/1 Running` | 使用 ECI virtual-kubelet，带 `type=virtual-kubelet` selector 和 `virtual-kubelet.io/provider=alibabacloud:NoSchedule` toleration |
| PostgreSQL | `1/1 Running` | ACK ESSD 20Gi PVC，`alicloud-disk-essd` |
| Platform migration | `Complete` | 使用 Platform API image 执行 |
| Enterprise Directory Sync | `1/1 Running` | 使用 E2E source adapter；HTTPS Service |
| Directory migration | `Complete` | 独立 migration Job |

目录同步最新回执为 612 名成员、185 个部门，`/readyz` 返回 200。Worker 通过 ACK Service 名称访问目录；保留了 E2E 证书的 `enterprise-directory-sync` SAN，并创建了同名 Service alias。

## E2E 配置迁移

迁移来源为当前 E2E harness 生成的仓库外 private 配置快照；该目录只作为部署输入，不进入 Git。

已迁移到 ACK Secret 的内容包括：

- API `configuration.mjs`、LDAP secret、directory identity bindings、encryption public key、directory read token、template validation 和 object-storage credential 文件；
- Worker `configuration.mjs`、directory identity bindings、execution capacity profiles、runtime grant、service token 和 keyring；
- Directory source adapter、service key、目录 TLS 证书和 read token。

仅替换了部署拓扑相关输入：

- `enterprise-directory-sync` 使用 ACK Service；
- Worker namespace 改为 `agent-infra`；
- Registry endpoint/prefix 改为 GHCR；
- Platform public origin 改为 `https://118.178.91.138`；
- Worker Runtime image repository 改为 GHCR；
- `storageClassName` 改为 ACK 的 `alicloud-disk-essd`。

没有把 Secret 明文、LDAP 密码、service key 或私钥写入仓库、镜像或日志。

## 镜像

当前 ACK 使用的 amd64 image digest：

- Web（登录代理修复）：`sha256:df1ee9b1d284b6dc4fc92a5033477fe4e82de7e53e78aabacdb21f9af78c1162`（当前 ACK 线上已滚动到协议边界修正版 `sha256:5cba731cce608a721fbc377d468b413b6f2f786a7f028c252b360e28bd8acea9`）
- Platform API：`sha256:1ff771514f0fa426fc719f700f16d7f7428d3ccdb33e5c4380ffe8e19625ecea`
- Platform Worker（E2E configuration 依赖补齐版）：`sha256:f99076114c2690c0a9716b504bb0a12132703a645dc13138110136ae033c4efa`
- Runtime Host（E2E amd64 版本）：`sha256:6e0ac15d6f953bc2eb1b36e02c60ddfebe5137bdb08b1835dd2e0b133866bdee`
- Directory Sync：`sha256:cb8a377ab39877149fd8d852731fc74023b95b7f1e9396d47c7cc79e9501fa37`
- PostgreSQL：`sha256:3a1c948f0c6c857ce1db23caa700794725f0f1a7b3dc395925aa363d3284af49`

GHCR 的 Web/API/Worker package 为 public；目录和 PostgreSQL package 受组织可见性策略影响，因此 ACK 使用了只包含 GHCR 的 Kubernetes pull Secret `ack-ghcr-pull`。

## 验证

```bash
curl -k -I https://118.178.91.138/
curl -k https://118.178.91.138/api/v2/agents
kubectl -n agent-infra get deploy,pod,job,svc,ingress,pvc -o wide
```

已验证：

- 前端 HTTPS 返回 `200`；
- `/api/v2/agents` 未登录返回 `401 AUTHENTICATION_REQUIRED`；
- API、Web、PostgreSQL、Directory Sync 和 ECI Worker 均已运行；
- Platform/Directory migration 均完成；
- Directory `/readyz` 返回 `200`，快照有效。
- `helm lint deploy/helm/agent-infra` 和 `helm lint deploy/ack/chart` 均通过；ACK 当前 `helm list -n agent-infra` 为空，线上资源仍是 raw manifests。
- `helm template ack-e2e deploy/ack/chart --set ingress.enabled=false | kubectl apply --dry-run=server -f -` 通过 ACK API 校验；Ingress 因线上已有同名 wildcard 路由未在该 dry-run 中重复提交；Helm wrapper 对 ACK Ingress 开启 HTTP→HTTPS 重定向，`publicOrigin` 由每个环境的实际 LB 地址填写。登录回归探针：无 Origin 的合成请求会被安全边界拒绝；带 `Origin: https://118.178.91.138` 的合成请求到达 LDAP 校验并返回 `401`，证明 Web→API token 和 HTTPS 转发链路已打通。

## 仍需真实业务验收

登录入口已经配置。此前 ACK Web Nginx 未注入 API proxy token 且覆盖了外部 HTTPS 标记，导致 `/auth/login` 被 API 安全边界拒绝；现已通过 Web entrypoint 从 Secret 渲染 token，并保留/设置 HTTPS 转发标记。实际账号登录仍依赖 E2E 配置中的 LDAP endpoint、用户凭据和网络可达性；本次没有读取或生成用户密码，也没有伪造登录成功。Runtime Host 已补齐 ACK 所需的 amd64 版本并完成 ECI 启动探针：在 `virtual-kubelet-cn-hangzhou-i` 上成功拉取并启动，返回 `status=ready`、`configVersion=probe-v4`、`port=3003`。探针使用合成配置，不能替代真实用户 Agent Workload 验收；真实首通仍需终端用户登录、Relay 和模型凭据。
