# 本地 Platform 生命周期

本入口运行持久 PostgreSQL、对象存储、HTTPS Web 和正式 Platform API；Worker 使用同一
本地 kind 的正式 Helm 部署。申请、审批、配置与 Workload 调谐复用生产 Core/Store。
任务投递仍由 [#482](https://github.com/AgoraIO-Extensions/agent-infra/issues/482) 的唯一生产
循环提供，Connection 使用自己的服务、身份与授权。

## 配置

复制 [.env.example](.env.example) 到仓库外的本地配置文件，填写本地 Docker context、独立
Compose project、API 专属部署目录、浏览器信任的 localhost TLS 文件、私有 kind kubeconfig、
context、已创建的 namespace 和 Worker values 文件。执行前载入所填写的本地配置。
各 host 端口可在配置文件中为当前 project 单独设置，避免与其他本地运行实例冲突。
`platform.sh` 要求 Docker 使用本机 Unix socket，并核对 kind control-plane 容器标签、
暴露端口与 kubeconfig 的 loopback API 地址；Helm release 和 namespace 均与 Compose
project 同名。普通停止保留数据库、对象存储卷和 Agent PVC。

API 镜像内置[部署模块](../../apps/platform-api/src/deployment-entry.ts)，固定从
`file:///app/dist/deployment.mjs` 加载。API 专属目录只提供受审阅的
`configuration.mjs` 及其私有导入；所需导出及受信身份、目录、Registry 和模型
依赖见 [API 部署说明](../platform-api/README.md)。内置模块从
`PLATFORM_DATABASE_URL` 取得数据库 URL，建立第一方 LDAP Adapter 和 PostgreSQL
会话 Store，再将同一个身份 Adapter 交给生产 API 装配工厂。API 只将
`/auth/login` 和 `/auth/logout` 交给浏览器处理器；处理器失败返回无正文 503。
先执行 Platform 增量迁移；跨 API 副本的到期和撤销由 PostgreSQL Store 执行，
测试用内存 Store 不能作为正式部署配置。工厂还要求高熵
`trustedProxyToken`，只从 Compose Secret 读取。将 32–96 字节随机值
编码为 Base64URL，保存在用户持有、权限为 `0600` 的
`PLATFORM_LOCAL_PROXY_TOKEN_FILE`；其他用户可读或符号链接文件在启动前被拒绝。
`migrate` 与 `up` 在当前 project 的 `0700` 私有状态目录生成 nginx 配置和 API 专用的只读运行副本，
供容器中的非 root API 通过 Compose Secret `/run/secrets/platform_proxy_token` 读取；
内置 API 模块将该值传给工厂。代理固定覆盖客户端提交的 `X-Platform-Proxy-Token`；正常
`stop` 删除两个生成文件，即使源令牌变量已移除也可继续清理。默认状态目录为
`${XDG_STATE_HOME:-$HOME/.local/state}/agent-infra/local`，
可通过 `PLATFORM_LOCAL_STATE_DIRECTORY` 指定绝对路径。配置和令牌不进入镜像、源码或
Compose 环境变量。选定 Docker context 必须能读取 API 配置、TLS 和生成状态目录；
源令牌只由本地主机上的启动脚本读取。
`up` 在开放 Web 前从本机 loopback 以 `HEAD /auth/login` 检查 API：正确令牌须返回
`405`，错误令牌须返回 `400`。`HEAD` 不触发 LDAP 登录或 Authentik OIDC 跳转；
这只验证挂载的部署模块与代理令牌接线，
不提交账号密码，也不代表 LDAP 登录或当前账号复核已经通过；探测失败时 API/Web 保持关闭。
真实浏览器登录仍需当前 LDAP 与账号事实验收。

| 输入 | 来源和要求 |
| --- | --- |
| `ldap`、`organizationIds`、`loadAuthorityContext` | 第一方 LDAP 配置、目录组织映射和权限事实；Platform 停用状态由内置模块查询 PostgreSQL，每次敏感操作重新解析，不能固定管理员或信任浏览器身份字段 |
| `registry`、`templates`、`imageRepository` | 实际 OCI endpoint、按当前主体和 Digest 判断的准入政策、不可变标准模板与允许配置键；镜像 repository 与 Worker 保持一致 |
| `modelCatalog` | 相同 revision 的有效获准端点快照；模型和推理强度必须在快照范围内 |
| `encryptionKeys` | 版本化加密公钥；不含 Worker 解密私钥 |
| `channelPolicy` | 明确绑定到 Agent 和主体的部署登记；未配置渠道时 `bindings: []` |
| `resourceProfile` | 与 Worker 实际资源 Profile 一致的展示值 |

身份部署负责 HttpOnly、Secure、SameSite 会话及其真实登录过程，符合
[身份边界](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#91-identityadapter)。
此目录只挂给 API，不包含 Kubernetes credential、Worker keyring 或签名私钥。
独立本地 Authentik 可使用[部署身份 Adapter](authentik/README.md)，同时接通浏览器登录和
Worker 的当前用户目录；这不替代实际账号和完整首通验收。
模型凭证由 Owner 在申请和配置时提交，经现有加密公钥加密，只由 Worker 解密注入。

Web 默认使用 `https://localhost:3001`（可由 `PLATFORM_LOCAL_WEB_PORT` 调整），
`/api/` 同源转发给 API，SSE 不经过响应缓冲。
TLS 文件须可由 Web 镜像中的非 root 用户读取。开发时也可使用 `pnpm dev:web`，通过
`PLATFORM_WEB_TLS_CERT_FILE`、`PLATFORM_WEB_TLS_KEY_FILE` 和
`PLATFORM_API_PROXY_TARGET` 配置相同的 HTTPS/同源访问。

## 启动与停止

从仓库根使用 Node 24、pnpm 11 完成安装和构建；先运行数据库，再执行迁移，最后启动业务
进程。构建与正常重启分开，重启不会自动生成新镜像。

```bash
pnpm install --frozen-lockfile
pnpm build
bash deploy/local/platform.sh build
bash deploy/local/platform.sh data
bash deploy/local/platform.sh migrate
bash deploy/local/platform.sh up
bash deploy/local/platform.sh status
```

Worker 的模块接口、私有文件挂载和 Runtime 授权以
[Worker 部署模块说明](../platform-worker/README.md) 为准。本地 values 只引用已经创建的
`configurationModuleSecretRef`、`runtimeAuthSecretRef` 和 Worker 镜像 Digest；
Kubernetes 凭证由 Pod ServiceAccount 提供。Worker 与 API 使用同一模板 Digest、
ModelCatalog revision 和资源政策。挂载或 rollout 成功仍需后续业务验收。
Worker 访问的内部 Host 或模型预检 Relay 使用私有 CA 时，本地 values 还需指定
`platformWorker.trustedCaSecretRef`，指向已创建的 CA bundle Secret；Helm 只把它挂给
Worker。Agent Pod 执行期 Relay 的 CA 信任和地址匹配须在实际模型请求中另行验证。

`PLATFORM_LOCAL_KUBECONFIG` 必须为可读绝对路径，context 必须是 `kind-*` 且当前集群
API 使用与所选 Docker context 的 kind control-plane 一致的 loopback 端口，namespace
须已创建且与 Compose project 同名。`PLATFORM_LOCAL_WORKER_VALUES` 是可读绝对
路径，指向最终 Worker 镜像 Digest、`configurationModuleSecretRef` 与
`runtimeAuthSecretRef`；脚本把部署模块固定为镜像内的
`file:///app/dist/deployment.mjs`。本地 `build` 不会自动发布
镜像或生成 manifest Digest。迁移由上面的命令完成，
`up` 将当前 project 的 PostgreSQL 容器接入所选 Docker context 的 `kind` 网络，
并在同名 namespace 建立 `<project>-postgres` Service 与 EndpointSlice。Worker 的
`database.secretRef` 被固定到同名本地 Secret：脚本从 Compose API 的数据库 URL
派生同一账号、密码和库名，只把主机换成
`<project>-postgres.<namespace>.svc.cluster.local`。Secret 通过 Kubernetes API 写入，
不进入 values 文件、源码或脚本输出。重复 `up` 会刷新容器 IP 和 Secret；`status`
回读路由对象；正常 `stop` 在 Worker 卸载后删除路由与该 Secret，并断开容器的
`kind` 网络，保留数据库和对象卷。此路由仅供隔离本地 kind 使用。
脚本给自己建立的 `kind` 网络链路生成一次性 alias，并在 EndpointSlice 注记中记录。
仅当注记与 Docker alias 精确匹配时才复用或断开链路；同名但不属于当前 project 的
Kubernetes 对象及预先由其他流程连接的链路均被拒绝。Helm 卸载后若路由清理中断，
可再次执行 `stop`。若进程恰在连接网络与写入注记之间中断，脚本会拒绝接管无标记的
链路，须先核对该测试容器的网络归属，再人工处理孤立连接。
脚本会固定关闭 Helm migration、目录服务及拓扑占位进程；升级前关闭已有 Web/API，
启动数据服务并等待 Worker Deployment 就绪，再开放 Compose 中的 Web/API。Worker
启动失败时 Web/API 保持关闭。每次 `up` 都重建 API 与 Web 容器，使新生成的代理令牌
文件重新绑定；PostgreSQL 与对象存储容器不因此重建。

```bash
bash deploy/local/platform.sh up
bash deploy/local/platform.sh status
```

模型出站由 Worker 唯一调谐的 `modelEgress` 与 `dnsEgress` 配置：只允许固定 IP 或指定
namespace/Pod 标签和端口，缺省拒绝全部出站。不增加另一条 allow-all NetworkPolicy。
Worker 预检与 Agent 模型调用都必须在真实网络上验证。
隔离 kind 的合成 A/B HTTPS 目标、测试 CA 和脱敏计数回执可通过
[受控 Relay 探针](relay-probe.md)准备；它只为相同 Pod/Profile 的正负例提供目标，
不能替代真实 Provider 或 Connection 验收。

停止时先通过 Platform 正常停止 Agent 并确认调谐完成。脚本先关闭 Web/API 写入口，
把 Worker 缩至零副本并等待退出，再核对 namespace 中的 Agent StatefulSet 已缩至零副本
且 Agent Pod 已退出；否则先恢复 Worker，待其就绪后恢复 Web/API。Helm 卸载须等待
完成；失败时也尝试恢复。若 Worker 无法恢复，Web/API 保持关闭，数据库与对象存储
继续运行并给出诊断。正常停止不删除 Agent PVC、数据卷或审计。
再次启动复用相同 project 和数据卷。

```bash
bash deploy/local/platform.sh stop
```

## 数据重置

重置与正常停止分开。只有明确丢弃本地测试数据时，在停止 Agent 和 Worker 后对所选独立
project 执行下面的命令；它删除 PostgreSQL 和对象存储的数据卷。Agent PVC 的删除也必须
单独确认具体本地集群和 PVC 名称，不能通过普通停止命令隐式完成。

```bash
docker --context "$PLATFORM_LOCAL_DOCKER_CONTEXT" compose \
  --project-name "$PLATFORM_LOCAL_PROJECT" \
  -f docker-compose.yml -f deploy/local/compose.yaml down --volumes
```

## 验证边界

`status`、`healthz`、组件测试和就绪探测分别报告自己的结果。真实验收还需从空业务库通过
浏览器申请、审批、配置、Workload 创建和重启，并回读实际 revision、Digest、Secret 引用及
PVC；最终任务、真实模型、独立 Connection 授权与 GitHub Draft PR 必须另外完成。
旧 Agent 管理与配置入口的退役接线及 `/api/v2` 迁移由后续 Platform API 切片负责；本地
装配切片不把当前 `/api/v1` 管理行为宣称为已退役，也不伪造已退役的 Action 投影。现有
Conversation 与会话接口继续遵循各自版本。

## 单 Agent 标准模板发布

已登记发布通过独立工厂
[`createProductionSingleAgentTemplateReleaseAppV1`](../../apps/platform-api/src/template-release.ts)
提供受限 HTTP 入口；不挂入普通 Web API。部署模块提供既有生产身份、Registry 和模板
配置，以及经过部署校验的 `target` 与每次重读的 `loadReleaseBinding`。后者返回
`{ schemaVersion: 1, revision, target, operatorIds }`；撤销运维资格时须更新其当前结果。
`target` 包含 `schemaVersion: 1`、`releaseId`、`agentId`、`templateId`、
`expectedConfigurationRevision`、`expectedImageDigest` 与 `targetImageDigest`。
它固定到一个 Agent 的同模板 OLD→NEW 发布，不能从 HTTP 载荷派生。

以下示例在 API 部署目录运行，`approved-release.mjs` 属于部署配置，提供当前身份和
当前发布绑定，不在源码或镜像中保存凭证。HTTPS 入口须原样传递真实认证请求；内部监听
地址不替代认证，IdentityAdapter 必须支持此受限路径，不能把请求伪装成普通配置操作。

```javascript
import { serve } from "@hono/node-server";
import { createProductionSingleAgentTemplateReleaseAppV1 } from "../dist/index.mjs";
import { loadApprovedReleaseInput } from "./approved-release.mjs";

const release = createProductionSingleAgentTemplateReleaseAppV1(
  await loadApprovedReleaseInput(),
);
const server = serve({ fetch: release.app.fetch, hostname: "127.0.0.1", port: 3510 });
process.once("SIGINT", () => {
  server.close(() => void release.close());
});
```

通过实际身份认证后，发送
`POST /internal/ops/standard-template-releases/{releaseId}/apply`，请求体严格为
`{ "schemaVersion": 1 }`，并提供稳定的 `Idempotency-Key`。完整请求与固定发布内容相同
才可重放；重放仍要求当前身份及部署运维资格。契约见
[发布 OpenAPI](../../packages/contracts/artifacts/openapi/standard-template-release.v1.openapi.json)。

`202` 只表示配置新修订已保存；还须由唯一 Worker 正常准入、验证和提升。部署者需准备
OLD/NEW 的实际 Registry 政策与 Worker 模板配置；不能直接改 Kubernetes、配置表或
原任务终态来完成发布。模型、Secret 引用、Owner、可用范围、env、渠道和原 PVC 的保留
遵循[工程 Spec 第 10.4 节](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#104-模板与自定义镜像升级)。
此入口的通过不等于所有关联 Agent 自动升级或真实账号首通已验收。
