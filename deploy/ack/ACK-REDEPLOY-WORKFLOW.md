# ACK 可迁移重部署工作流

这个入口把 `01a154f5-6f94-7c90-9d70-d935c6a9b85e` 中已经验证过的步骤收敛成一个可重复流程：固定源码和镜像 tuple，预检私有配置，部署 Platform，记录 Helm/Kubernetes 回读，然后用真实浏览器会话验收 Codex、Claude、OpenCode、Pi 和自定义 Agent。所有 kubeconfig、Secret、Cookie、浏览器 state、LB 地址和镜像 Digest 都留在仓库外。

入口脚本是 [`redeploy.sh`](./redeploy.sh)。它只接受 immutable image reference，渲染结果仍包含占位值时直接失败；每次运行把脱敏 receipt 写到外部 `ACK_EVIDENCE_DIR`，不会把会话正文或凭证写入仓库。

## 从零迁移

在目标机器准备 Node 24、`kubectl`、Helm、`curl` 和 Git。先从最终发布 commit 的 clean checkout 构建并发布 `web`、`platform-api`、`platform-worker`、`enterprise-directory-sync`、RuntimeHost 以及四个标准 Runtime 的 amd64 immutable manifest。自定义 Agent 也必须先取得部署批准的 OCI Digest；Tag 不能作为部署输入。

仓库外准备两个文件：

```bash
export ACK_KUBECONFIG=/private/ack/kubeconfig
export ACK_VALUES_FILE=/private/ack/values.yaml
export ACK_SOURCE_SHA=0123456789abcdef0123456789abcdef01234567
export ACK_IMAGE_MANIFEST=/private/ack/platform-images.json
export ACK_PUBLIC_ORIGIN=https://ack.example.test
export ACK_TEMPLATE_CONFIG_DIR=/private/ack/templates
export ACK_CUSTOM_AGENT_PROBE=platform-auth
export ACK_CUSTOM_AGENT_CONFIGS=$'/private/ack/custom-a.json\n/private/ack/custom-b.json'
export ACK_AGENT_REQUESTS_FILE=/private/ack/agent-requests.json
export ACK_EVIDENCE_DIR=/private/ack/evidence/$(date -u +%Y%m%dT%H%M%SZ)
```

`ACK_VALUES_FILE` 从 [`values.ack.example.yaml`](./values.ack.example.yaml) 复制并替换所有镜像、Ingress、Corp ID 和 Secret **名称**。`ACK_IMAGE_MANIFEST` 必须是同一 `ACK_SOURCE_SHA` 生成的 `linux/amd64` platform image manifest；脚本会检查 commit、架构和四个 Platform image digest。Secret 内容通过 E2E/private 配置在目标集群预先创建，不能写进 values 或 Git。已有数据库环境保持 `postgres.enabled=false`、`migrations.enabled=false`；全新环境必须先单独评审数据库和 migration，再开启这两个开关。

`ACK_TEMPLATE_CONFIG_DIR` 必须包含 `codex.json`、`claude.json`、`opencode.json`、`pi.json` 四个文件。每个文件使用 [`conversation-browser.mjs`](../../tests/local-real-e2e/conversation-browser.mjs) 的真实配置，引用当前部署登录后生成的两个 `0600` Playwright state 文件，并填写该模板的实际 Agent ID。不要复用旧会话；每次 Platform/Worker 或 Runtime revision 变化后都创建新的对话。

自定义 Agent 配置使用 [`custom-agent-web-probe.md`](../../tests/local-real-e2e/custom-agent-web-probe.md) 规定的私有 JSON。`platform-auth` 只适用于已经接入 Platform Auth 的 Agent；自有入口使用 `web`。每份配置必须声明当前来源 commit、不可变 Digest、configuration revision、期望内容 hash 和两个不同主体的私有授权文件。

`ACK_AGENT_REQUESTS_FILE` 是仓库外的 API 创建/重放清单。每项引用一个 `0600` Bearer credential 文件、一个 `0600` JSON body 文件和固定 `Idempotency-Key`；credential 需要创建和读取 Agent 的权限。body 可以是标准模板或自定义 Agent 的 `POST /api/v2/agents` 请求。脚本只输出 HTTP 状态、状态枚举和 Agent ID 的 SHA-256，不输出 Token、Secret 或响应正文；创建后会轮询 `/state`，直到 `available/ready` 或明确失败/超时。API 创建不需要 Web 审批；需要审批的 Web application 流程仍应由真实管理员完成并回读。

清单结构如下，具体 body 和 credential 仍放在仓库外：

```json
{
  "schemaVersion": 1,
  "origin": "https://ack.example.test",
  "waitSeconds": 300,
  "requests": [
    {
      "name": "custom-agent-a",
      "bodyFile": "/private/ack/requests/custom-agent-a.json",
      "credentialFile": "/private/ack/credentials/agent-api.token",
      "idempotencyKey": "custom-agent-a-create-v1"
    }
  ]
}
```

完成上述准备后，一条命令执行部署、Agent 创建/重放和真实验收：

```bash
deploy/ack/redeploy.sh all
```

脚本按以下顺序运行：

1. 确认当前 worktree `HEAD` 等于 `ACK_SOURCE_SHA`，渲染 Helm 并拒绝占位值。
2. 运行 ACK 访问、Secret、目录 source ConfigMap 和 Helm lint 预检。
3. `helm upgrade --install --wait` 部署 Platform，并逐个等待 API、Web、Worker、Directory rollout。
4. 保存源码 SHA、Helm history、Deployment image、Pod/Job/Service/Ingress/PVC、事件和 HTTP 状态码的脱敏回读。
5. 若设置 `ACK_AGENT_REQUESTS_FILE`，按固定 Idempotency-Key 创建或重放 Agent，并保存状态/哈希化 Agent ID。
6. 检查公网 Web 为 `200`、匿名 `/api/v2/agents` 为 `401`。
7. 依次运行四个真实浏览器旅程；每个 receipt 必须有 `text.delta`、`execution.status=completed`、持久化刷新回读和跨主体拒绝证据。任一模板失败，整次验收失败，失败 receipt 原样保留。
8. 对每个自定义 Agent 运行选择的真实入口 probe；`pass` 不等同于生命周期或 Kubernetes 验收，脚本同时保存 Deployment/Pod 回读供人工核对。

若需要分步执行，使用 `plan`、`deploy`、`provision`、`validate`。`plan` 只读集群并生成渲染结果；`clean` 卸载本次 Helm release 和 chart-owned workload，但保留 PVC、Secret、用户 Agent、历史和数据库；这适合重新部署而不丢业务数据。

## 清理 ACK 环境

`destroy` 是删除 namespace 的不可逆入口，只有同时满足三个显式开关才会执行：

```bash
ACK_CLEAN_CONFIRM=DELETE_ACK_ENV \
ACK_CLEAN_DELETE_DATA=true \
ACK_CLEAN_DELETE_NAMESPACE=true \
deploy/ack/redeploy.sh destroy
```

运行前脚本会把当前资源和事件写入外部 evidence 目录。namespace 删除会清除 PVC、Secret、用户 Agent、会话历史和该 namespace 下的其他资源；如果只想保留数据并重装平台，使用 `clean`。

## 从 session 记录沉淀的成功与失败

成功路径：ACK Platform 的 Web、API、Directory、Worker 曾在同一环境达到 Ready；四个标准模板和一个自定义 ACP 曾完成真实模型首通，回读包含执行终态和浏览器可见文本；ECI Worker 通过 `type=virtual-kubelet` selector 与 Alibaba toleration 调度；自定义 Agent 生命周期在带当前 management revision 的 `retry_creation` 后恢复到 available/ready，多服务入口的 Deployment、Service、EndpointSlice 和入口路由均可核对。

失败路径及脚本中的对应门禁：

- main 在发布期间多次前进，导致“最新镜像”与部署/运行时绑定混用。脚本要求 `ACK_SOURCE_SHA == HEAD`，并把每次镜像和 Helm 回读放入同一 receipt。
- Pod Ready、healthz、受控回显和旧会话不能证明业务成功。脚本强制四个新浏览器旅程，要求真实 SSE、落库终态、刷新回读和第二主体拒绝。
- Pi 曾出现首轮成功、下一轮只返回一个字符、再失败。脚本不把首轮结果聚合为通过；任一旅程非 `passed` 都使整次退出非零。
- Codex 的 ECI/普通节点缺少可执行的 Landlock ABI，真实 `setpriv` 预检失败。脚本不会用 Pi 或受控 fixture 替代 Codex；修复节点/镜像后必须重新跑完整四模板验收。
- 运行时绑定曾指向旧 Digest，旧 Sandbox 进入 `RUNTIME_CONFIGURATION_INVALID`。脚本禁止复用旧浏览器配置和旧 receipt，要求配置中固定当前 Agent ID、Digest 和 revision。
- malformed execution-capacity profile、重复 `templateModelBindings` 和配额耗尽曾阻断全局 workload reconciliation。部署前应从 Worker configuration 中删除坏 profile、确保每个标准模板只有一个当前绑定，并核对 `ResourceQuota hard/used`；脚本保留 quota/PVC/事件回读以便定位。
- ACK registry 对不完整 OCI config 返回 `409`，镜像 mirror tag 写入返回 `405`；发布阶段使用受支持的 GHCR/workflow 路径和完整 Digest，不能把临时 Tag 写入 values。
- 真实 ECI image pull 可能在短窗口停留 `ContainerCreating`。这只能记为冷启动/镜像交付证据，不能直接判定模型失败；必须等待同一执行的完成事件或明确失败。

这套脚本不会替平台创建账号、审批 Agent、生成登录 Cookie、修复内核或伪造模型凭证；这些输入必须由部署拥有者按现有 E2E 配置提供。它把这些人工/外部门禁变成显式输入和失败条件，保证下一次清理后重部署可以复用同一套步骤。
