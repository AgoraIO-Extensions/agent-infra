# 本地 Platform 生命周期

本入口运行持久 PostgreSQL、对象存储、HTTPS Web 和正式 Platform API；Worker 使用同一
本地 kind 的正式 Helm 部署。申请、审批、配置与 Workload 调谐复用生产 Core/Store。
任务投递仍由 [#482](https://github.com/AgoraIO-Extensions/agent-infra/issues/482) 的唯一生产
循环提供，Connection 使用自己的服务、身份与授权。

## 配置

复制 [.env.example](.env.example) 到仓库外的本地配置文件，填写本地 Docker context、独立
Compose project、API 专属部署目录、浏览器信任的 localhost TLS 文件、私有 kind kubeconfig、
context、已创建的 namespace 和 Worker values 文件。执行前载入所填写的本地配置。
`platform.sh` 拒绝远程 Docker endpoint 和非 loopback 的 Kubernetes API；Helm release
与 Compose project 同名，普通停止保留数据库、对象存储卷和 Agent PVC。

API 专属目录至少包含 `platform-api.mjs`。该模块导出
`createPlatformApiAssemblyInput()`，调用
[`createProductionPlatformApiAssemblyInputV1`](../../apps/platform-api/src/deployment.ts)。
容器内可从 `../dist/index.mjs` 导入工厂，数据库 URL 取 `PLATFORM_DATABASE_URL`。部署输入为：

| 输入 | 来源和要求 |
| --- | --- |
| `identity`、`loadAuthorityContext` | 获准身份服务的真实 Adapter 和当前目录查询；每次敏感操作重新解析，不能固定管理员或信任浏览器身份字段 |
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

Web 使用 `https://localhost:3001`，`/api/` 同源转发给 API，SSE 不经过响应缓冲。
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

Worker 使用 [`createProductionWorkloadWorkerOptionsV1`](../../apps/platform-worker/src/workload-deployment.ts)
装配，并在最终部署镜像内提供 `platformWorker.deploymentModule`。配置 `kubernetes.mode`
为 `in-cluster`，复用 [Helm](../README.md#workload-调谐) 的 namespace-scoped RBAC。
Worker 必须能导入与 `dist/deployment.mjs` 相邻的受信任 `configuration.mjs`；该模块提供
真实的 `workloadInput`、`signing`、`serviceToken` 和当前用户 `directory`。基础 Worker
镜像只打包两个工厂，不提供此配置模块。配置代码可在受审阅的最终镜像中，私钥、服务
token、数据库 URL 和 Kubernetes 凭证只从部署 Secret/只读文件读取，不写进镜像。
当前 Helm 尚未挂载此模块或 Runtime 签名材料；完成受控挂载和最终镜像校验前，
`up` 的 Helm rollout 不能作为真实 Worker 通过证据。

Worker 与 API 使用同一模板 Digest、ModelCatalog revision 和资源政策。Worker 的
`runtimeProbe` 使用 `createWorkloadReadinessAuthorizationV1`，`workerId` 与
`policy.runtimeAuth.workerId` 一致；仅把公钥、服务 token 的 Secret 引用和本机 Workload
绑定注入 Agent。专用就绪授权见
[工程 Spec](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#93-服务端授权上下文)。

`PLATFORM_LOCAL_KUBECONFIG` 必须为可读绝对路径，context 必须是 `kind-*` 且当前集群
API 使用 loopback，namespace 须已创建。`PLATFORM_LOCAL_WORKER_VALUES` 是可读绝对
路径，指向最终 Worker 镜像 Digest、`platformWorker.deploymentModule` 和受控 Secret
引用；本地 `build` 不会自动发布镜像或生成 manifest Digest。迁移由上面的命令完成，
脚本会固定关闭 Helm migration、目录服务及拓扑占位进程，并保持 Web/API 在 Compose 中。

```bash
bash deploy/local/platform.sh up
bash deploy/local/platform.sh status
```

模型出站由 Worker 唯一调谐的 `modelEgress` 与 `dnsEgress` 配置：只允许固定 IP 或指定
namespace/Pod 标签和端口，缺省拒绝全部出站。不增加另一条 allow-all NetworkPolicy。
Worker 预检与 Agent 模型调用都必须在真实网络上验证。

停止时先通过 Platform 正常停止 Agent 并确认调谐完成，再调用脚本卸载本 project 的
Worker release、停止 Compose 服务；这不删除 Agent PVC、数据库、对象存储卷或审计。
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
