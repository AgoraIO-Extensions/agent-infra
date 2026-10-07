# 本地 E2E Harness

本入口把本地 E2E 的源码、镜像、Compose 和 kind 资源绑定到一次可回读的运行。它不创建
第二套 Platform 部署逻辑：数据库、API、Web 和 Worker 生命周期仍由
[`platform.sh`](./platform.sh) 负责。

固定运行还会在同一 Compose project 内启动 `enterprise-directory-sync` 和 `connection-api`。
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

标准 Codex 模板的 Runtime readiness 会用镜像内固定版本 Codex 的 `model/list` 核对每个模型
选项及推理档位。私有 API/Worker Model Catalog 的 `allowedModels` 只能列出该列表中存在、且
模型端点实际可用的模型；否则申请和 Worker 预检都会通过，但 Runtime 以
`RUNTIME_CODEX_CONFIGURATION_INVALID` 拒绝 readiness，Worker 记为 `health_check_failed`。

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
