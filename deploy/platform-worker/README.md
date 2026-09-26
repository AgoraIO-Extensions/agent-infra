# Platform Worker 部署模块

正式 CLI 通过 `PLATFORM_WORKER_DEPLOYMENT_MODULE` 同时启动 Workload 与 Conversation
循环。[deployment.mjs](deployment.mjs) 是两个现有工厂的具体部署消费者：两者共享一次经过
验证的 Kubernetes、Registry、模型目录、keyring、Runtime readiness 与路由配置。
每个进程生成独立的数据库 lease owner；Runtime 服务身份仍使用部署提供的稳定 Worker ID。

## 打包与启动

在仓库根目录、Node.js 24 与仓库固定 pnpm 版本下执行：

```bash
pnpm install --frozen-lockfile
pnpm --filter @agent-infra/platform-worker... build
```

构建生成 `apps/platform-worker/dist/index.mjs` 与 `dist/deployment.mjs`。
`configuration.mjs` 不属于构建输入，也不进入镜像。部署将自己的配置模块只读挂载到
Worker 的 `dist/configuration.mjs`，然后执行：

```bash
cd apps/platform-worker
PLATFORM_WORKER_DEPLOYMENT_MODULE="$(pwd)/dist/deployment.mjs" node dist/index.mjs
```

Worker 镜像中的对应目录是 `/app/dist`。部署模块与配置模块必须来自受信任部署代码，
不能来自请求、模型输出或 Agent 镜像。配置读取失败时进程退出；收到 SIGTERM 后停止发现、
中止 Runtime 请求并关闭数据库连接。数据库迁移先按现有 Platform Store 入口执行。

## 配置模块形状

以下只说明已有工厂参数的装配方式，具体 IdentityAdapter、Registry policy 和模型目录
由部署代码实现，不定义新的身份服务或配置协议：

```javascript
import { createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { directory, registry, modelCatalog, policy } from "./environment.mjs";

export { directory };
export const signing = {
  workerId: "platform-worker-runtime",
  issuer: "agent-platform",
  keyId: "runtime-grant-current",
  privateKey: createPrivateKey(await readFile("/run/worker/runtime-grant.pem")),
};
export const serviceToken = (
  await readFile("/run/worker/runtime-service-token", "utf8")
).trim();
export const workloadInput = {
  databaseUrl: (await readFile("/run/worker/database-url", "utf8")).trim(),
  kubernetes: { mode: "in-cluster" },
  policy,
  registry,
  admissionPolicyRef: "approved-runtime-images",
  registrySubjectRef: "platform-worker",
  keyring: JSON.parse(await readFile("/run/worker/keyring.json", "utf8")),
  modelCatalog,
  templateModelBindings: [],
  executionCapacityProfiles: [],
};
```

- `directory.resolveUser(userId)` 必须查询部署的当前身份事实；依赖失败应抛错，不能返回一个
  假造的 active 用户，也不能把临时故障当作账号删除。账号确认不存在时才返回 `null`。
- `policy.runtimeAuth` 的 Worker ID、issuer、key ID、公钥必须与 `signing` 匹配；其中只保存
  Kubernetes 内预置的 Runtime transport Secret 名称/键，不保存私钥或 Token 值。
- `templateModelBindings` 使用当前获准标准模板 digest 与协议。上面空数组仅是形状示例，
  不能验证标准模板；自定义 Agent 可使用空数组。
- `executionCapacityProfiles` 必须由真实负载/conformance 证据产生，绑定精确 image digest、
  resource profile 与资源配置 hash。空数组不允许新 Turn。撤回容量证明仍保留原执行控制。
- 内置消费者接通平台 Web 与固定 `api:user` / `api:application` 渠道的当前 Core 权威判断。
  API 任务沿原 Conversation/Execution 与自动发现循环执行，应用消费自己的当前授权事实。
  未知渠道返回 unavailable；企微仍需
  其独立装配与验收。标准模板的渠道资格不取决于暂时 Ready 状态；自定义平台入口须有已验证
  兼容事实。新业务仍需通过当前身份、Agent 使用权、配置、Workload 与容量终审。
- Worker-only 文件不得挂载到 API、Agent 或 Web，也不得进入日志、任务正文或 Git。目录
  Adapter 的具体接入依赖受信任目录装配；API 任务的正式原生闭环与故障矩阵仍按
  [#482](https://github.com/AgoraIO-Extensions/agent-infra/issues/482) 验收。

## 验证边界

`conversation-worker.integration.test.ts` 使用真实 PostgreSQL、正式打包模块和两个 CLI
进程，经生产 Core 合法受理任务，覆盖自动发现、竞争 claim、容量、持久事件、停止及退出。
其 Kubernetes 与 Runtime HTTP 是受控对端；不代表真实模型、身份服务、Connection 或 Web
首通。签名 readiness 对真实 RuntimeHost 的独立验证位于 `workload-deployment.test.ts`。
整体汇合仍遵循 [ADR 0015](../../docs/adr/0015-m1-shared-contract-assembly-convergence.md)。
