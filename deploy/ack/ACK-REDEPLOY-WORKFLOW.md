# ACK 重部署工作流（实现中）

本工作流正在为清空后重建 ACK 准备工具。当前只支持已有私有依赖的 Platform 部署、
API Agent 创建和入口检查，尚未证明从空环境自动恢复，不能作为清空环境的前提。
相关真实验收保持在 #3072，脚本测试不完成该 Issue。

实现尚缺：数据库角色和 Secret 初始化、四模板 readiness 刷新、真实多轮与闲置恢复验收、自定义 ACP/多服务完整矩阵，以及目标绑定的 ECI 执行证据。
所有 kubeconfig、Secret、Cookie、浏览器 state 和真实环境输入留在仓库外。

入口脚本是 [`redeploy.sh`](./redeploy.sh)。它只接受 immutable image reference，渲染结果仍包含占位值时直接失败；每次运行把脱敏 receipt 写到外部 `ACK_EVIDENCE_DIR`，不会把会话正文或凭证写入仓库。

## 当前输入与已有环境部署

在目标机器准备 Node 24、`kubectl`、Helm、`curl` 和 Git。先从最终发布 commit 的 clean checkout 构建并发布 `web`、`platform-api`、`platform-worker`、`enterprise-directory-sync`、RuntimeHost 以及四个标准 Runtime 的 amd64 immutable manifest。自定义 Agent 也必须先取得部署批准的 OCI Digest；Tag 不能作为部署输入。

仓库外准备以下配置与发布 receipt：

```bash
export ACK_KUBECONFIG=/private/ack/kubeconfig
export ACK_VALUES_FILE=/private/ack/values.yaml
export ACK_SOURCE_SHA=0123456789abcdef0123456789abcdef01234567
export ACK_IMAGE_MANIFEST=/private/ack/platform-images.json
export ACK_RUNTIME_IMAGE_MANIFEST=/private/ack/runtime-host-manifest.json
export ACK_PUBLIC_ORIGIN=https://ack.example.test
export ACK_CA_CERT_FILE=/private/ack/ack-ca.pem
export ACK_AGENT_STATE_DIR=/private/ack/agent-state
export ACK_BROWSER_BLUEPRINT_DIR=/private/ack/browser-blueprints
export ACK_CUSTOM_AGENT_PROBE=platform-auth
export ACK_CUSTOM_AGENT_CONFIGS=$'/private/ack/custom-a.json\n/private/ack/custom-b.json'
export ACK_AGENT_REQUESTS_FILE=/private/ack/agent-requests.json
export ACK_EVIDENCE_DIR=/private/ack/evidence/$(date -u +%Y%m%dT%H%M%SZ)
```

`ACK_VALUES_FILE` 从 [`values.ack.example.yaml`](./values.ack.example.yaml) 复制并替换所有镜像、Ingress、Corp ID 和 Secret **名称**。`ACK_IMAGE_MANIFEST` 和 `ACK_RUNTIME_IMAGE_MANIFEST` 必须是同一 `ACK_SOURCE_SHA` 生成的 `linux/amd64` Platform/Runtime manifest；脚本会将 digest 逐项与渲染后的 Helm image 和 Runtime 输入绑定。HTTPS 探针默认使用系统 CA；自签名 ACK 入口必须提供仓库外的 `ACK_CA_CERT_FILE`，脚本不会跳过证书验证。Secret 内容通过 E2E/private 配置在目标集群预先创建，不能写进 values 或 Git。已有数据库环境保持 `postgres.enabled=false`、`migrations.enabled=false`；全新环境必须先单独评审数据库和 migration，再开启这两个开关。

`ACK_AGENT_STATE_DIR` 必须是仓库外、当前用户拥有的既有 `0700` 目录。
创建成功即以 `0600` 原子写入 `agent-bindings.json`；它是私有操作状态，
包含原始 Agent ID，不是可分享证据。状态绑定目标 origin、源码 SHA 和创建请求哈希；
任何变化都拒绝复用。再次运行会读回已有 Agent 的状态而不重复 POST 创建；
未收到创建响应时只能用原 Idempotency-Key 重试，不生成新 key。

`ACK_BROWSER_BLUEPRINT_DIR` 包含 `codex.json`、`claude.json`、`opencode.json`、
`pi.json`，自定义 ACP 用 `custom-<request-name>.json`。
内容沿用 [浏览器旅程配置](../../tests/local-real-e2e/README.md#对话真实浏览器验收)，
`agentId` 可以省略；origin 必须与创建清单一致，两个主体的 storageState 必须各自是
`0600` 私有文件。全部请求的输入先在本机检查，再开始创建。

所有 Agent 就绪后，生成的配置写入私有状态目录下的 `browser/`，自动替换新 Agent ID，
保留提示词、主体和 acceptance 要求。后续 `validate` 会从相同映射重新生成，
并依次执行四模板和自定义 ACP 的同一会话多轮旅程。原始 ID 不进入公开 provision receipt。
旧 Agent 存在与否、当前授权和业务是否成功仍由真实 API 和浏览器检查确定。

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

在已有环境中，以下命令执行当前支持的部署、创建和入口检查；结果不代表完整重建验收：

```bash
deploy/ack/redeploy.sh all
```

`all` 在 Helm 写入前检查四个不同标准模板和至少两个自定义 Agent 的创建清单及蓝图，
缺项则拒绝。每份浏览器蓝图还须含至少两条 `followUpPrompts` 和覆盖全部轮次的
`expectedReplies`，用于识别后续轮截断。此数量校验不代表模型或自定义业务验收。`provision` 可单独处理清单子集。

脚本按以下顺序运行：

1. 确认当前 worktree `HEAD` 等于 `ACK_SOURCE_SHA`，渲染 Helm 并拒绝占位值。
2. 运行 ACK 访问、Secret、目录 source ConfigMap 和 Helm lint 预检。
3. `helm upgrade --install --wait` 部署 Platform，并逐个等待 API、Web、Worker、Directory rollout。
4. 保存预期源码 SHA、精确 release 的 Helm revision，以及 workload/Pod 的名称、UID、节点和镜像哈希。原始 env、annotation、事件消息和地址不进入 snapshot；读取失败退出非零。
5. 按固定 Idempotency-Key 创建尚未绑定的 Agent，已绑定项只读状态；私有目录保留 ID 映射，分享 receipt 仅保存状态/哈希。
6. 检查公网 Web 为 `200`、匿名 `/api/v2/agents` 为 `401`。
7. 从私有映射生成当前 Agent ID 的浏览器配置，依次运行四模板和自定义 ACP 的至少三轮旅程；每个 receipt 必须有 `text.delta`、`execution.status=completed`、持久化刷新回读和跨主体拒绝证据。任一模板失败，整次检查失败。该 runner 明确设置 modelCallVerified=false，多轮检查通过仍不能据此宣称真实模型通过。
8. 对每个自定义 Agent 运行选择的真实入口 probe；`pass` 不等同于生命周期或 Kubernetes 验收，脚本只检查声明 Digest 的哈希是否出现在 workload 回读中，尚不能证明该 workload 对应目标入口。

若需要分步执行，使用 `plan`、`deploy`、`provision`、`validate`。
`plan` 不写集群；渲染配置仅保存在私有临时文件中，命令退出即移除。
当前 `validate` 是入口检查，未绑定真实模型执行证据和多轮成功。
`ACK_CA_CERT_FILE` 用于 curl；Node probe 信任私有 CA 时另设 `NODE_EXTRA_CA_CERTS`。
现有浏览器 runner 仍使用自身 TLS 配置，应在完整验收实现时统一。

## 清理与恢复门禁

`clean` 和 `destroy` 当前均拒绝执行。此前基于宽泛 label 删除资源的实现无法保证
所有权和数据保留，且删除 namespace 不能证明集群级准入策略、云盘或外部存储已清理。
后续清理必须绑定精确集群与 namespace UID、资源清单、备份恢复验证和用户清理指令，
通过读回确认后才能启用。当前未做任何 ACK 清理。

## 从 session 记录沉淀的成功与失败

原 session 的历史记录支持 Claude、Pi、OpenCode 和一个自定义镜像曾有真实回复；
Codex 在该记录中的 Landlock 预检失败，不能记为四模板全部成功。
Platform Ready、单次回复与多轮通过分别记录。后续其他 session 的 ACP 或多服务结果
不得回填成此 session 的成功证据；这些记录也不是当前部署状态。

失败路径及脚本中的对应门禁：

- main 在发布期间多次前进，导致“最新镜像”与部署/运行时绑定混用。脚本要求 `ACK_SOURCE_SHA == HEAD`，并把每次镜像和 Helm 回读放入同一 receipt。
- Pod Ready、healthz、受控回显和旧会话不能证明业务成功。脚本强制四个新浏览器旅程，要求真实 SSE、落库终态、刷新回读和第二主体拒绝。
- Pi 曾出现首轮成功、下一轮只返回一个字符、再失败。当前入口要求同一会话至少三轮，各轮验证独立 Execution 与期望回复；受控 Chromium 已覆盖第二轮截断失败，真实 ACK 多轮结果仍待验证。
- Codex 的 ECI/普通节点缺少可执行的 Landlock ABI，真实 `setpriv` 预检失败。脚本不会用 Pi 或受控 fixture 替代 Codex；当前规范另有 container-boundary 模式，按 [Runtime 预检](./RUNTIME-PREFLIGHT.md) 完成对应隔离和真实工具验收后才可使用；不能从历史 Landlock 失败推断当前方案必然失败。
- 运行时绑定曾指向旧 Digest，旧 Sandbox 进入 `RUNTIME_CONFIGURATION_INVALID`。当前浏览器配置尚未绑定 image/revision；必须补齐这一验证才能排除旧 Sandbox。
- malformed execution-capacity profile、重复 `templateModelBindings` 和配额耗尽曾阻断全局 workload reconciliation。部署前应从 Worker configuration 中删除坏 profile、确保每个标准模板只有一个当前绑定，并核对 `ResourceQuota hard/used`；现场排查应只读取配额数值与有界故障码；不要导出完整事件消息。
- ACK registry 对不完整 OCI config 返回 `409`，镜像 mirror tag 写入返回 `405`；发布阶段使用受支持的 GHCR/workflow 路径和完整 Digest，不能把临时 Tag 写入 values。
- 真实 ECI image pull 可能在短窗口停留 `ContainerCreating`。这只能记为冷启动/镜像交付证据，不能直接判定模型失败；必须等待同一执行的完成事件或明确失败。

这套脚本不会替平台创建账号、审批 Agent、生成登录 Cookie、修复内核或伪造模型凭证；这些输入必须由部署拥有者按现有 E2E 配置提供。上述缺口全部完成并通过真实演练后，才能称为一键移植方案。
