# ACK 重部署工作流（实现中）

本工作流为清空后重建 ACK 提供可重复的 Platform 部署、四模板真实 Runtime preflight、
API Agent 创建和入口验收入口；每次真实运行仍必须以当前 source/image/config receipt 为准。
空环境数据库、真实多轮/闲置恢复、自定义 ACP/多服务完整矩阵和目标绑定的 ECI 执行证据仍需
在目标集群执行并回读，脚本测试本身不替代这些外部证据。

待完成的外部验收包括：完整空环境演练、真实多轮与闲置恢复、自定义 ACP/多服务完整矩阵，以及目标绑定的 ECI 执行证据。
所有 kubeconfig、Secret、Cookie、浏览器 state 和真实环境输入留在仓库外。

入口脚本是 [`redeploy.sh`](./redeploy.sh)。它只接受 immutable image reference，渲染结果仍包含占位值时直接失败；每次运行把脱敏 receipt 写到外部 `ACK_EVIDENCE_DIR`，不会把会话正文或凭证写入仓库。

## 搬迁私有输入包

在另一台机器检出已发布镜像对应的源码 commit，并安装 Node 24、pnpm 依赖、kubectl 和 Helm。
将私有输入包完整复制到 Git 仓库外的 `0700` 目录，文件保持 `0600`，再执行：

```bash
node --experimental-strip-types deploy/ack/run-capsule.ts /private/ack/capsule.json all
```

`run-capsule.ts` 只解析输入路径，然后调用同一 checkout 的 `redeploy.sh`。它不复制部署逻辑，
也不修改镜像与源码约束。`capsule.json` 示例：

```json
{
  "schemaVersion": 1,
  "sourceSha": "0123456789abcdef0123456789abcdef01234567",
  "inputs": ["bootstrap.json", "requests.json", "jobs.json", "jobs/codex.json"],
  "directories": ["state", "evidence"],
  "environment": {
    "ACK_KUBECONFIG": "@CAPSULE_ROOT@/kubeconfig",
    "ACK_NAMESPACE": "agent-infra",
    "ACK_RELEASE": "agent-infra-ack",
    "ACK_VALUES_FILE": "@CAPSULE_ROOT@/values.fresh.yaml",
    "ACK_BOOTSTRAP_INPUTS_FILE": "@CAPSULE_ROOT@/bootstrap.json",
    "ACK_AGENT_REQUESTS_FILE": "@CAPSULE_ROOT@/requests.json",
    "ACK_EVIDENCE_DIR": "@CAPSULE_ROOT@/evidence",
    "ACK_PUBLIC_ORIGIN": "https://ack.example.test"
  }
}
```

示例只展示格式；完整输入包仍需后文规定的所有镜像 manifest、四份 job、容量/登录/credential
配置和六个或更多 Agent 请求及浏览器蓝图。`inputs` 显式列出需要解析路径的 JSON 模板。
模板中的 `@CAPSULE_ROOT@/relative/path` 指向包内路径；目标也在 `inputs` 中时，指向本轮生成
的 JSON 副本，否则指向包内原始文件或声明的输出目录。job 的 `worktree` 使用 `@SOURCE_ROOT@`。
证据与原始凭证不需要改写；运行后保留 `.resolved-*` 私有目录用于诊断，原 JSON 模板保持不变。

`directories` 声明允许创建的输出目录，例如浏览器 state、API credential 和证据目录。
除这些目录内的预期输出外，所有引用必须事先存在；符号链接、越界路径、公开权限和未知
环境变量均被拒绝。`ACK_CUSTOM_AGENT_CONFIGS` 可使用路径 token 数组，入口会转换为既有脚本
接受的换行列表。旧 shell 中的 ACK 配置不参与此次运行；删除确认只接受调用方明确设置的
`ACK_CLEAN_CONFIRM` 和 `ACK_CLEAN_ALLOW_FOREIGN`，输入包不能内置这两个变量。

第三个参数可选择既有 `plan`、`bootstrap-login`、`runtime-inputs`、`provision`、`validate` 或
其他已声明阶段；所有原有 source/image、ownership 和破坏性清理门禁继续执行。不要把含凭证的
输入包或 `.resolved-*` 目录提交到 Git、PR 或共享文档。

清理计划的 installation ID 必须与待删除 namespace 的 `agent-infra.agora.io/bootstrap-id`
一致。它是 `bootstrap-inputs` 写入的安装归属；fresh 输入包中的新 installation ID 不能代替
旧环境的清理身份。cluster UID 和 namespace UID 仍须与现场完全一致。

上一轮演练的成功与失败因果、以及 fresh 环境的一键顺序，见 [`ACK-REDEPLOY-LESSONS.md`](./ACK-REDEPLOY-LESSONS.md)。

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
export ACK_TEMPLATE_VALIDATIONS_FILE=/private/ack/template-validations.json
export ACK_TEMPLATE_PREFLIGHT_JOBS_FILE=/private/ack/template-preflight-jobs.json
export ACK_TEMPLATE_IMAGE_MANIFEST=/private/ack/templates-amd64.json
export ACK_EVIDENCE_DIR=/private/ack/evidence/$(date -u +%Y%m%dT%H%M%SZ)
```

`ACK_VALUES_FILE` 从 [`values.ack.example.yaml`](./values.ack.example.yaml) 复制并替换所有镜像、Ingress、Corp ID 和 Secret **名称**。`ACK_IMAGE_MANIFEST` 和 `ACK_RUNTIME_IMAGE_MANIFEST` 必须是同一 `ACK_SOURCE_SHA` 生成的 `linux/amd64` Platform/Runtime manifest；脚本会将 digest 逐项与渲染后的 Helm image 和 Runtime 输入绑定。HTTPS 探针默认使用系统 CA；自签名 ACK 入口必须提供仓库外的 `ACK_CA_CERT_FILE`，脚本不会跳过证书验证。Secret 内容通过 E2E/private 配置在目标集群预先创建，不能写进 values 或 Git。已有数据库环境保持 `postgres.enabled=false`、`migrations.enabled=false`；全新环境必须先单独评审数据库和 migration，再开启这两个开关。

如果需要从现有 ACK 生成迁移 capsule，可先执行只读采集：

```bash
export ACK_KUBECONFIG=/private/ack/kubeconfig
export ACK_CAPTURE_DIR=/private/ack/input-capsule
deploy/ack/redeploy.sh capture-inputs
```

该命令读取精确 Helm release 的合并 values、集群版本和渲染出的 Secret/ConfigMap 依赖，
在 `ACK_CAPTURE_DIR` 下以 `0600` 保存文件引用和脱敏 receipt，不写 ACK。它生成
`values.reuse.yaml`、`values.fresh.yaml`、`bootstrap-inputs.reuse.json` 和
`bootstrap-inputs.fresh.json`。fresh 配置会为新的 PostgreSQL 生成独立的管理员、Platform、
目录运行和目录迁移账号；不会错误复用旧环境中共用一个角色/数据库的 URL。旧 values 中被
当前 schema 拒绝的字段会被移除并记录在本地 receipt。采集仍不生成源码绑定的镜像 manifest，
部署前必须补齐同一个 `ACK_SOURCE_SHA` 的 Platform/Runtime amd64 manifest。

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

自定义 `platform-adapter` Agent 使用当前 ID 绑定生成的 `custom-*.json` Platform 对话蓝图。
`validate` 必须读取同一源码、同一 Agent 的三轮浏览器 receipt，逐轮检查 SSE、完成状态、刷新恢复
和跨主体拒绝；不为这类 Agent 要求独立 HTML 入口。缺失、未完成或身份/来源不匹配的 receipt
都拒绝。

自定义 `self-managed` Agent 仍使用 [`custom-agent-web-probe.md`](../../tests/local-real-e2e/custom-agent-web-probe.md)
规定的私有 JSON；`ACK_CUSTOM_AGENT_CONFIGS` 只列出这类 Agent，数量必须匹配创建清单。
全部 custom 都为 `platform-adapter` 时不设置该变量。`platform-auth` 只适用于已经接入
Platform Auth 的自有入口；其他自有入口使用 `web`。每份配置必须声明来源 commit、不可变
Digest、configuration revision、期望内容 hash 和两个不同主体的私有授权文件。

清空后重建自有入口时，同一个 `ACK_CUSTOM_AGENT_CONFIGS` 可改为列出按 `requestName` 绑定的
私有配置。该模式用于仓库的签名身份示例，支持单服务和 web/api 多服务；一旦选择此模式，
所有 self-managed 请求都必须有自己的绑定配置，不能混入静态 URL 探针：

```json
{
  "schemaVersion": 1,
  "requestName": "own-web",
  "sourceSha": "0123456789abcdef0123456789abcdef01234567",
  "imageSourceSha": "0123456789abcdef0123456789abcdef01234567",
  "routeHostSuffix": "apps.example.test",
  "contentSha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123",
  "issuer": "example-application-owner",
  "audience": "example-own-web",
  "signingKeyFile": "@CAPSULE_ROOT@/credentials/application-signing.pem",
  "browserCertificateFile": "@CAPSULE_ROOT@/certificates/application-leaf.pem",
  "expectedReply": "Hello from application service"
}
```

将该 JSON 加入 capsule 的 `inputs` 后，`self-managed-entry.ts` 会从本轮 Agent binding 和授权
API 回读当前入口，验证批准的 host suffix、同 Agent 的全部工作负载、Pod owner chain、Service、
EndpointSlice、Ingress 和实际 imageID。它不接受任意旧 URL 或仅在其他 Pod 中找到的 Digest。
应用签名私钥只由本地验证工具读取，生成两个短期应用身份；部署仅包含公钥、issuer 和 audience。
工具先用 Node 的正常 CA/hostname 校验执行受保护页面和身份反例，再以明确的 leaf SPKI pin
运行 Chromium 登录、按钮调用内部 API、刷新和拒绝无权主体的旅程。截图保存在私有证据目录。
这不是操作系统 CA 安装或通用浏览器信任验收；不能据此宣称公共 CA 已签发。

示例源码和构建方式见 [自有入口示例](../../tests/fixtures/custom-agent-web/README.md#签名身份与多服务示例)。
受控本地测试不替代实际镜像发布、平台创建、入口和多服务调用证据。

`ACK_AGENT_REQUESTS_FILE` 是仓库外的 API 创建/重放清单。每项引用一个 `0600` Bearer credential 文件、一个 `0600` JSON body 文件和固定 `Idempotency-Key`；credential 需要创建和读取 Agent 的权限。body 可以是标准模板或自定义 Agent 的 `POST /api/v2/agents` 请求。脚本只输出 HTTP 状态、状态枚举和 Agent ID 的 SHA-256，不输出 Token、Secret 或响应正文；创建后会轮询 `/state`，直到 `available/ready` 或明确失败/超时。API 创建不需要 Web 审批；需要审批的 Web application 流程仍应由真实管理员完成并回读。

`ACK_TEMPLATE_VALIDATIONS_FILE` 是四个标准模板的私有 receipt 清单。每项同时引用同一
模板、image digest、configuration revision 和 model 的 validation candidate，以及产生它的
真实 Runtime preflight receipt；清单还固定 `ACK_SOURCE_SHA` 和至少 60 秒的剩余有效期。
`provision` 和 `validate` 在任何 Agent 写入或浏览器旅程前执行该门禁，拒绝缺失、过期、
simulation、失败、来源 SHA 漂移或 tuple 漂移。validation candidate 只能放入 API/Worker
Secret，清单和 preflight receipt 仍留在仓库外。

若需要由 `all` 自动生成四份 receipt，`ACK_TEMPLATE_PREFLIGHT_JOBS_FILE` 使用以下私有清单；
每个 job 文件声明一个当前 source SHA、不可变 Runtime image、template/config/model tuple、
ECI placement，以及 grant private key、Runtime service token 和 Relay key 的私有文件路径。

job 可设置 `podReadyTimeoutSeconds`，默认 900 秒，接受 60–1800 秒的整数。该预算覆盖
ECI 调度、镜像拉取和容器就绪，独立于 `ACK_HELM_TIMEOUT`。等待失败仍清理本轮临时资源，
并保存私有 `pod-readiness-failure.json`，记录 source/image、预算和有界 Pod phase/容器 waiting
reason；这份失败记录明确表示模型调用尚未开始，不保存原始错误或凭证。

四个 job 的清单形状如下：

```json
{
  "schemaVersion": 1,
  "jobs": [
    "/private/ack/template-jobs/codex.json",
    "/private/ack/template-jobs/claude.json",
    "/private/ack/template-jobs/opencode.json",
    "/private/ack/template-jobs/pi.json"
  ]
}
```

`template-preflight` 会为每个 job 创建带 ownership label 的临时 ECI Pod，生成 HMAC boundary
attestation，执行真实 Runtime turn 和事件回读，写入私有 candidate/preflight receipt，随后
删除 Pod 和 Secret。镜像拉取、Runtime 启动、真实模型、完成事件或 cleanup 任一步失败都会
让流程失败；它不会复用历史 receipt。
每次执行先校验四份 job 与发布 manifest、kubeconfig、namespace 的绑定，再在
`ACK_EVIDENCE_DIR` 下创建独立 `template-run-*` 目录，生成绑定当前 worktree 的 job 副本。
原 job 的 `outputDirectory` 不用于本轮执行；新 checkpoint、receipt 和诊断日志均写入本轮
私有目录。重跑不会继承旧 Pod 的进度，也不覆盖旧证据或原始 job 文件。
模板校验使用同次生成的 `template-model-validation.receipt.json`；详细诊断
`template-model-preflight.receipt.json` 和 `runtime-capacity.receipt.json` 分别保留运行证据与实测容量，均保持私有。

`all` 在生成新 preflight receipts 或读取已有 `ACK_TEMPLATE_VALIDATIONS_FILE` 后，均执行
`runtime-inputs`，并在部署前要求 bootstrap 与 capacity 私有输入。该阶段复用
`ACK_BOOTSTRAP_INPUTS_FILE`，要求 API、Worker 的 configuration Secret 文件清单都声明
`template-validation-<templateId>.json` 四个键。Worker capacity key 必须与
`ACK_WORKLOAD_CAPACITY_FILE` 的 `workerSecretRef` 和 `profilesFile` 对应；候选文件同目录必须有
本轮生成的 `runtime-capacity.receipt.json`。自定义镜像仍需提供自己的实测容量证据。

`runtime-inputs` 校验本轮 source/image/config、实测资源和容量后，更新这些已声明的私有文件
和 configuration Secret。它先验证 cluster UID、namespace/Secret 归属、原配置字节及实际
Deployment mount，再带 resourceVersion 更新，回读 Secret 后让 API/Worker 加载新配置。
内容 hash 注解使相同输入无需再次更新或滚动；上次 rollout 中断时可用同一组仍有效的 receipts
重试并等待收敛。任何配置漂移、回读或 rollout 失败均停止后续 provisioning。
完成后还必须通过 Worker 的 mounted-capacity gate。此步骤不签发登录会话、不修改 principal
映射，也不代表真实模型或完整重建验收已经通过。

```bash
deploy/ack/redeploy.sh runtime-inputs
```

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
3. `helm upgrade --install --wait` 部署 Platform，并逐个等待 API、Web、Worker、Directory rollout。`bootstrap-inputs` 更新私有 Secret 后会显式滚动 API/Worker 并再次等待 rollout，避免进程继续使用旧的 readiness 或 origin。
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

## 私有依赖供应

`bootstrap-plan` 和 `bootstrap-inputs` 分别预览和创建 namespace、Secret、ConfigMap，
它们是空环境恢复的第一阶段；数据库启动使用后续 `bootstrap-database`，schema migrations 随正常 `deploy` 执行。
`ACK_BOOTSTRAP_INPUTS_FILE` 指向仓库外的 `0600` JSON 文件，示意片段如下：

```json
{
  "schemaVersion": 1,
  "installationId": "11111111-1111-1111-1111-111111111111",
  "clusterUid": "22222222-2222-2222-2222-222222222222",
  "namespace": "agent-infra",
  "initializeDatabase": true,
  "objects": [
    {
      "kind": "Secret",
      "name": "agent-infra-api-configuration",
      "files": {
        "configuration.mjs": "/private/ack/api/configuration.mjs"
      }
    },
    {
      "kind": "ConfigMap",
      "name": "agent-infra-directory-source",
      "files": {
        "source.ts": "/private/ack/directory/source.ts"
      }
    }
  ]
}
```

实际清单必须包含渲染出的全部依赖及其必需键；上例仅说明结构，不是完整清单。
`clusterUid` 是目标集群 `kube-system` namespace 的 UID；`installationId` 是这次安装
自行生成并固定的 UUID。所有输入文件须是当前用户拥有的私有普通文件，禁止符号链接。
Secret 可选 `secretType` 为 `Opaque`、`kubernetes.io/tls` 或
`kubernetes.io/dockerconfigjson`。凭证始终放 Secret，ConfigMap 只放非秘密内容。

```bash
deploy/ack/redeploy.sh bootstrap-plan
deploy/ack/redeploy.sh bootstrap-inputs
```

工具先校验全部本地输入、集群 UID、namespace ownership 和已有对象，再创建缺失对象；
任何已有内容漂移均拒绝，不覆盖、收养或删除既有资源。每个写入后立即回读字节和 ownership。
重跑复用同一安装标识和输入；创建请求失去响应时，下一次回读实际状态再决定，不强制重建。
支持迁移前准备其他显式列出的运行时 Secret，但不会从 configuration 模块中执行代码
或猜测缺失凭证。分享 receipt 只包含数量及集群/namespace 哈希，不包含文件内容、路径或名称。

已有环境的 `preflight.sh` 只读检查依赖，不会在连接失败时创建 namespace。

## 新环境的 API 凭证

### 创建 Agent 前的 Session 容量检查

`provision`（含 `all`）同时读取 `ACK_WORKLOAD_CAPACITY_FILE`。标准模板和
`platform-adapter` 自定义 Agent 的每个最终镜像都必须有唯一容量记录，绑定当前
`resourceProfileRef`、CPU/内存 requests/limits 与真实测量收据的 SHA-256。
`self-managed` 入口通过自己的业务探针验收，不使用 Platform Session 容量。

私有检查文件示例：

```json
{
  "schemaVersion": 1,
  "sourceSha": "0123456789abcdef0123456789abcdef01234567",
  "resourceProfileRef": "small",
  "resources": {
    "requests": { "cpu": "100m", "memory": "128Mi" },
    "limits": { "cpu": "1", "memory": "2Gi" }
  },
  "profilesFile": "/private/ack/execution-capacity-profiles.json",
  "workerSecretRef": { "name": "worker-configuration", "key": "execution-capacity-profiles.json" },
  "evidence": [
    {
      "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "file": "/private/ack/runtime-measurement.json"
    }
  ]
}
```

`resources` 必须与 Worker policy 一致，`profilesFile` 必须是 bootstrap 交付给 Worker 的同一
文件。工具在创建 Agent 前核对当前 Worker Pod 的实际挂载及装配输出，再比较本地文件与集群 Secret 字节；缺失、重复、资源不匹配、
全零证据哈希、收据字节变化或 Secret 漂移均失败。当前检查只支持单执行测量收据，
同时校验镜像、完整 CPU/内存资源、真实模型事实、完成状态、回复匹配和上限 1。
标准模板 preflight 自动生成 `runtime-capacity.receipt.json`；容量 profile 的证据哈希
指向该文件。自定义 ACP 可使用 `isolated-custom-runtime-capacity` 收据。
纯 Pod-ready、任意文件、缺少模型事实或把容量扩大到测量上限以上都不能通过。
更新配置后须等待 Worker rollout；已有 Agent 通过正式 lifecycle 重启重新生成 verified
capacity，禁止手工写数据库补齐。

### 签发个人 API credential

Fresh 数据库可以先设置 `ACK_LOGIN_BOOTSTRAP_FILE` 并运行 `bootstrap-login`。`all` 在模型
preflight 后、`runtime-inputs` 前执行此步骤，使用正常 `/auth/login` 和 `/api/v1/session`
取得当前 canonical user ID。它为每个声明主体创建全新 Cookie context，验证两次 session
身份一致且主体不同，然后写入私有 storageState、身份候选文件和对应浏览器蓝图。
HTTPS 必须通过系统信任或 `NODE_EXTRA_CA_CERTS` 验证；不跟随登录重定向。

```json
{
  "schemaVersion": 1,
  "origin": "https://ack.example.test",
  "identityFile": "/private/ack/login/identities.candidate.json",
  "identitySecretRef": {
    "name": "agent-infra-api-configuration",
    "key": "deployment-identities.json"
  },
  "subjects": [
    {
      "name": "owner",
      "loginFile": "/private/ack/login/owner-login",
      "passwordFile": "/private/ack/login/owner-password",
      "storageStateFile": "/private/ack/login/owner-state.json"
    },
    {
      "name": "other",
      "loginFile": "/private/ack/login/other-login",
      "passwordFile": "/private/ack/login/other-password",
      "storageStateFile": "/private/ack/login/other-state.json"
    }
  ],
  "blueprints": ["/private/ack/blueprints/codex.json"]
}
```

输入文件和输出目录必须在 Git 仓库外，分别使用 `0600` 与 `0700` 权限。`origin` 必须等于
`ACK_PUBLIC_ORIGIN`。`passwordFile` 的首尾空格属于密码，只去掉文件末尾一个 LF 或 CRLF
行终止符。为完整验收，`blueprints` 应列出四模板和每个 custom platform-adapter
的蓝图；每份蓝图的 owner/other `stateFile` 必须对应本次声明的两个不同主体。
只替换它们的 `userId`，其余对话计划保持原样。

身份候选包含 `schemaVersion/sourceSha/origin/createdAt/subjects`，其中
`subjects.<name>.userId` 来自服务端 session。`runtime-inputs` 在发布前用私有 Cookie 再核对
当前 session，只把候选写入已声明的 API Secret `deployment-identities.json` 键并等待 API
加载。bootstrap 文件清单须事先声明这个键，其初始文件可以是 `{"subjects":{}}`。
部署自有 `configuration.mjs` 必须明确读取此文件，并仅把原本批准的主体名称映射到现有
`allowedPrincipals` 和 custom admission 规则；脚本不生成角色、授权列表或修改数据库。
身份候选十分钟后失效，需重新执行登录步骤。

```bash
deploy/ack/redeploy.sh bootstrap-login
```

登录输出采用私有提交门禁：所有主体验证完成后，先在私有 generation 目录写完整恢复记录，
再独占创建 `identityFile.promotion` 符号链接门禁，逐项发布身份、浏览器状态和蓝图。
提交标记也在完整写入后原子发布；初始化中断不会发布空日志或不完整提交标记。门禁存在期间，新登录和 `verifiedLoginCandidate` 均拒绝。
失败时只回滚本次仍可核实的输出；并发写入保留，无法恢复时门禁及私有备份继续保留，不能发布混合材料。
原始文件缺失会恢复为缺失。恢复记录/备份含敏感浏览器状态，只能留在原私有目录，禁止提交或打印。

进程退出后可显式恢复同一配置的声明输出，再重新执行登录；恢复拒绝仍存活的本机 writer、不同主机、
声明输出变化和不可信恢复记录，不通过删除门禁绕过检查：

```bash
node --experimental-strip-types deploy/ack/bootstrap-login.ts recover "$ACK_LOGIN_BOOTSTRAP_FILE"
```

该命令不发起登录、部署或授权，只按已保存 generation 恢复；并发冲突未解决时保持失败。
恢复先原子转移完整日志到含恢复进程 PID 的唯一 claim，只有取得 claim 的进程可回滚或退役门禁。
恢复进程中断后，下一进程只接管已退出进程的完整 claim；存活或被复用 PID、多份日志和未知路径均保守拒绝。
新日志名称和私有目录均绑定 generation，旧格式只读取已有完整日志。旧的空门禁、损坏日志或非声明私有目录的链接仍保守拒绝。
初始化或清理中断可能留下私有 `.prepared` 目录或 `.retired` 门禁；它们不是恢复权限，
不会被新运行扫描或用于覆盖输出。上述恢复覆盖进程中断，不承诺机器掉电后的文件系统持久性。

数据库、迁移和 Platform 就绪后，部署拥有者必须先通过真实 LDAP/浏览器登录生成一个新的
Playwright `storageState`。工具不会接收 LDAP 密码，也不会模拟登录。将下列私有请求文件
放在仓库外，storageState 和输出 credential 文件都必须是当前用户拥有、权限 `0600` 的普通文件：

```json
{
  "schemaVersion": 1,
  "origin": "https://ack.example.test",
  "storageStateFile": "/private/ack/login/owner-state.json",
  "outputFile": "/private/ack/credentials/owner-create.token",
  "scopes": ["agent:create", "agent:read", "agent:use", "agent:manage"],
  "expiresAt": null,
  "idempotencyKey": "fresh-install-owner-credential-v1"
}
```

运行 `bootstrap-credential` 会 POST `/api/v2/me/api-credentials`，把一次性返回的
`papi_...` 材料原子写入 `outputFile`，receipt 只包含状态和 SHA-256。相同 key 重试时，
服务器返回 null 材料；只有本地已存在且权限正确的 credential 文件才允许继续。文件随后
作为 Agent 请求清单的 `credentialFile`，不会复制到 values、Secret、日志或浏览器 evidence。
此阶段只验证 credential 签发，不验证 Agent、模型或 Connection 业务成功。

```bash
deploy/ack/redeploy.sh bootstrap-credential
```

## 数据库与迁移顺序

全新环境在 private values 中显式设置：

```yaml
postgres:
  enabled: true
  adminUser: bootstrap_admin
  initialDatabase: postgres
  adminSecret: database-administrator
  initializationSecret: database-initialization
  bootstrapInstallationId: 11111111-1111-1111-1111-111111111111
migrations:
  enabled: true
```

管理员 Secret 的 `password` 来自私有文件；它不能复用 Platform 的数据库账号。
在私有供应清单设置 `initializeDatabase: true`，且 `installationId` 必须与 values 一致。
工具从渲染后的 Platform、目录迁移和目录运行 Secret 引用读取三条 URL，要求三个不同账号、
两个不同业务数据库及同一目标 PostgreSQL Service；目录迁移账号和目录运行账号连接同一
目录数据库，管理员与三个账号各自独立。数据库密码要求 16–256 个可打印 ASCII 字符。

工具自动生成 `initializationSecret`，无需在 objects 中手工供应 SQL。
初始化 SQL 使用 [PostgreSQL SCRAM verifier 格式](https://www.postgresql.org/docs/16/catalog-pg-authid.html)，
不含明文密码；SQL 与 verifier 仍属于私有材料，不能进入分享 receipt。
SQL 只在空 PGDATA 首次启动时执行，创建受限业务账号和数据库，撤销公共数据库连接和建表
权限。目录运行账号的具体表权限仍由现有目录 migration 授予。

```bash
deploy/ack/redeploy.sh bootstrap-inputs
deploy/ack/redeploy.sh bootstrap-database
deploy/ack/redeploy.sh deploy
```

配置了 `ACK_BOOTSTRAP_INPUTS_FILE` 的 `all` 会按上述顺序运行。
数据库阶段使用同一个 Helm release 的 `bootstrap.databaseOnly=true`，此时只部署数据库
及其配额，不运行 migration，也不启动 Platform。等待 TCP readiness 后，核对 namespace、
PVC、Pod ownership、镜像、账号 verifier/权限和数据库归属，再允许正常 `deploy` 显式切回
`databaseOnly=false`，执行迁移并启动平台。已有完整 Platform release 不会被降回数据库阶段；
遇到外部 PVC、账号漂移或验证失败会停止，不覆盖或清空数据。

本机隔离 PostgreSQL 17 已通过生成密码认证、跨数据库拒绝和运行账号权限负例；
这不是 ACK PostgreSQL 16 镜像、空环境或模型验收。真实 ACK 演练、fresh DB 后的登录/API
凭证初始化和完整业务矩阵仍需完成，不能因数据库阶段通过而关闭 #3072。

## 清理与恢复门禁

`clean` 保持拒绝执行；`destroy` 只在明确的双重确认下删除完整 ACK namespace。
它绑定精确集群与 namespace UID、namespace ownership labels 和当前清理计划，并要求
`ACK_CLEAN_CONFIRM=DELETE_ACK_ENV` 与 `ACK_CLEAN_ALLOW_FOREIGN=DELETE_ALL_ACK_NAMESPACE`。
该模式删除 namespace 内所有资源以及精确名称的 Session ECI admission 对象，完成后读回
namespace 已不存在；不会输出资源名称、UID、Secret 或数据库内容。执行前应保留外部备份
或确认数据可丢弃。

现在可以先生成只读清理计划：

```bash
deploy/ack/redeploy.sh cleanup-plan
```

`ACK_CLEANUP_PLAN_FILE` 只包含 namespace UID、cluster UID、installationId、release 和
ownership 预期；输出 receipt 对资源名称、UID 和节点只保存哈希。计划会读取 namespace 内
的 Deployment、StatefulSet、Pod、Job、Service、Secret、ConfigMap、PVC、Ingress、RBAC、
NetworkPolicy、Quota，以及 Session ECI 的 cluster-scoped admission 对象。任何外来资源、
UID 漂移或 ownership 缺失都会使 `deletionReady=false`。该命令不删除资源、不暂停业务、不
备份数据库。确认数据可丢弃后，使用同一份 `ACK_CLEANUP_PLAN_FILE` 执行：

```bash
ACK_CLEAN_CONFIRM=DELETE_ACK_ENV \
ACK_CLEAN_ALLOW_FOREIGN=DELETE_ALL_ACK_NAMESPACE \
deploy/ack/redeploy.sh destroy
```

## 从 session 记录沉淀的成功与失败

原 session 早期记录过 Codex Landlock 失败，后续记录了四个标准模板的真实回复及完成终态；
自定义 ACP 的对话与自有多服务入口也分别留下成功证据。仍有历史自定义 Agent 创建失败，
不能把已成功的目标扩写成所有记录都成功。
Platform Ready、单次回复与多轮通过分别记录。后续其他 session 的 ACP 或多服务结果
不得回填成此 session 的成功证据；这些记录也不是当前部署状态。

失败路径及脚本中的对应门禁：

- main 在发布期间多次前进，导致“最新镜像”与部署/运行时绑定混用。脚本要求 `ACK_SOURCE_SHA == HEAD`，并把每次镜像和 Helm 回读放入同一 receipt。
- Pod Ready、healthz、受控回显和旧会话不能证明业务成功。脚本强制四个新浏览器旅程，要求真实 SSE、落库终态、刷新回读和第二主体拒绝。
- Pi 曾出现首轮成功、下一轮只返回一个字符、再失败。当前入口要求同一会话至少三轮，各轮验证独立 Execution 与期望回复；受控 Chromium 已覆盖第二轮截断失败，真实 ACK 多轮结果仍待验证。
- Codex 的 ECI/普通节点可能缺少可执行的 Landlock ABI，真实 `setpriv` 预检会失败。脚本不会用 Pi 或受控 fixture 替代 Codex；ACK 的标准 Runtime Pod 可在 `policy.codexContainerBoundaryEnabled=true` 且 Worker 注入匹配 HMAC attestation 时使用 reviewed `container-boundary` 模式。该模式必须先通过 [Runtime 预检](./RUNTIME-PREFLIGHT.md)，再对同一标准 Workload 做签名真实 readiness 和真实模型回合；缺少边界输入时仍应 fail closed，不能从历史 Landlock 失败或 Pod Ready 推断当前方案成功。
- Fresh 数据库会生成新的 canonical Platform user ID。`allowedPrincipals`、API subject 映射和 custom admission 不能写死历史 UUID；登录后读取当前 session，再更新仓库外私有配置，删除并重建 owned configuration Secret，滚动 API/Worker 后重新签发 credential。
- 标准 Workload 的 Codex boundary 输入由 Worker 在运行时根据当前 Agent ID 生成；私有 values 只打开部署策略开关。任何手工给 Agent Pod 加 `AGENT_INFRA_*` boundary 输入、复用旧 UID 或直接改 StatefulSet 都会破坏 ownership/attestation 验证。
- 运行时绑定曾指向旧 Digest，旧 Sandbox 进入 `RUNTIME_CONFIGURATION_INVALID`。当前浏览器配置尚未绑定 image/revision；必须补齐这一验证才能排除旧 Sandbox。
- malformed execution-capacity profile、重复 `templateModelBindings` 和配额耗尽曾阻断全局 workload reconciliation。部署前应从 Worker configuration 中删除坏 profile、确保每个标准模板只有一个当前绑定，并核对 `ResourceQuota hard/used`；现场排查应只读取配额数值与有界故障码；不要导出完整事件消息。
- ACK registry 对不完整 OCI config 返回 `409`，镜像 mirror tag 写入返回 `405`；发布阶段使用受支持的 GHCR/workflow 路径和完整 Digest，不能把临时 Tag 写入 values。
- 真实 ECI image pull 可能在短窗口停留 `ContainerCreating`。这只能记为冷启动/镜像交付证据，不能直接判定模型失败；必须等待同一执行的完成事件或明确失败。
- 四模板 Agent 全部 ready 后，真实会话仍可能返回 `AGENT_STARTING`：更换模板 digest 却漏更新 capacity profiles 时，verified capacity 为空，Session 记录 `capacity_mismatch`。创建前使用上述容量检查，创建后仍要求新 Session 的真实回复和持久化终态。
- 自定义镜像未设置 Driver 默认值时，Agent Workload 的 `acp` 注入不能覆盖到 Session。Session 装配必须同样注入服务端选择的 Driver，同时保留镜像/Owner 管理的模型配置与会话专属 Secret。
- 浏览器写请求的直接 HTTP 探针必须携带目标 Origin。GET session 成功而 POST 返回 401 时先核对协议边界，不应先认定密码错误或重启丢 Cookie。
- CI run 的 `updatedAt` 不是执行心跳。应读取 job 的当前 step 与终态；长测试仍在运行时继续等待，不因顶层时间戳未变就取消重跑。

这套脚本不会替平台创建账号、审批 Agent、生成登录 Cookie、修复内核或伪造模型凭证；这些输入必须由部署拥有者按现有 E2E 配置提供。上述缺口全部完成并通过真实演练后，才能称为一键移植方案。
