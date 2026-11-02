# 自建 Agent 迁入与 API 验证

本入口用于把一个已能执行真实业务的本地 Agent 迁入平台，并核对哪些步骤可以使用 API Token
完成。产品边界见[自定义 Agent](../prd/PRD-agent-platform-M1.md#5-自定义-agent)，
机器契约以 [Agent 管理 V2 OpenAPI](../../packages/contracts/artifacts/openapi/pilot-browser.v2.openapi.json)
和[任务 V1 OpenAPI](../../packages/contracts/artifacts/openapi/pilot-browser.v1.openapi.json)为准。

冻结版本的真实能力矩阵、复现步骤和限制见[API 迁入验收报告（2026-11-01）](custom-agent-migration-acceptance-20261101.md)。

## 选择交互入口

| 本地应用的目标 | 创建时选择 | 业务验收入口 |
| --- | --- | --- |
| 保留自己的 Web/API、会话和历史 | `self-managed` | 应用发布后的自有入口 |
| 使用平台对话、任务 API 和平台历史 | `platform-adapter` | 通过接入验证的平台入口 |

`self-managed` 还需明确 `identityResponsibility`，选择 `self-managed` 或 `platform-managed`。
选择平台身份入口前，确认部署和应用均已完成
[身份集成](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#143-自有交互入口)。
自有入口的管理 API 可用不代表平台任务 API 可用。

`platform-adapter` 的协议为 ACP。镜像还需完成平台 RuntimeHost 接入、执行授权及会话隔离；
仅提供 ACP 进程、健康检查或镜像 Label 不足以接入生产链路。按
[Runtime HLD](../architecture/HLD-agent-runtime-M1.md#32-自定义-agent)完成验证。
[Custom Agent Base Image](../../deploy/images/custom-agent-base/README.md)不包含这些组件。

## 准备输入和本地基线

1. 固定应用源码版本，选定一个真实业务用例，记录输入、预期结果及本地运行结果。
   使用可公开的合成业务材料；固定回复、健康检查和登录页不能代替业务执行。
2. 由自己的构建流程生成 OCI 镜像，提供
   [Runtime Manifest](../architecture/HLD-agent-runtime-M1.md#4-runtime-manifest)，
   推送到部署批准的 Registry，记录目标架构及不可变 Digest。
3. 将配置映射到环境变量和 Secret。保留 `AGENT_INFRA_*` 前缀，凭据不进入镜像、源码和报告。
   自定义 Agent 的模型配置由镜像及其 Owner 管理。
4. 准备有效的用户或应用 API 凭证。创建需要凭证的 `agent:create` 范围及部署创建许可，
   后续读取、管理和使用还分别受凭证范围与 Agent 授权约束。个人凭证可先按
   [身份自查流程](personal-api-read.md)核对身份；不要从个人凭证结果推导应用凭证能力。
5. 固定目标环境、资源所有权和本次私有输出目录。只对本次创建的 Agent 做启停、升级和取消测试。
   使用本地环境时先遵循[本地 E2E Harness](../../deploy/local/E2E-HARNESS.md)。

当前 M1 的源码和依赖进入镜像；业务数据库和应用记忆按应用自己的存储方式迁移。Skills 按
Skill Hub 流程分别处理。当前 M1 创建契约没有源码目录、Git URL、外部 Agent URL 或原生历史
导入字段，不能把新建空 Agent 当成完整迁移。

M1.1 的只读工作区快照范围见 [PRD 5.8](../prd/PRD-agent-platform-M1.md#58-工作区快照m11)，
接收与物化边界见[工程 Spec 10.15](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1015-工作区快照m11)。
实际迁入前必须回读目标部署的契约与能力：快照 API、配置绑定、Worker 物化和安全门禁均
已交付时，才能通过平台 API 上传 repo/环境归档并在自定义 source 中绑定。文档获批、
镜像迁入成功或存在 snapshotId 均不能证明快照业务可用；未启用的部署继续使用镜像输入。
快照不导入数据库、应用记忆、原生历史或现有 PVC，不提供源码下载或可写覆盖层。
本入口的既有镜像验收与工作区快照验收分别记录，后者须验证真实依赖加载、只读、版本切换、
回滚、恢复、跨主体隔离及日志无内容泄漏；不能以合成快照成功宣称用户私有工程已迁入。

需要独立验证迁入流程时，可使用[自有入口发票参考应用](../../tests/fixtures/custom-agent-invoice/README.md)。
它实际调用模型并持久化业务结果，使用应用自身的身份；受控测试、本地真实模型和平台部署
必须分别验收，不能把参考应用迁入成功推导为用户现有工程已迁入。

## 创建与幂等重放

调用 `POST /api/v2/agents`，使用 `Authorization: Bearer <API Token>`、
`Content-Type: application/json` 和固定的 `Idempotency-Key`。不要混用浏览器 Cookie 或自报身份头。
以下是自有入口的请求形状；将镜像、配置和 Secret 替换为已经核对的私有输入：

```json
{
  "schemaVersion": 2,
  "name": "Migration sample",
  "description": "Existing application migration",
  "source": {
    "kind": "custom",
    "imageReference": "registry.example/team/agent:v1",
    "interactionMode": "self-managed",
    "identityResponsibility": "self-managed"
  },
  "coOwnerIds": [],
  "availability": [],
  "environment": [],
  "secrets": []
}
```

已适配的平台入口改用 `interactionMode: "platform-adapter"`，并省略
`identityResponsibility`。自定义创建请求使用 `schemaVersion: 2`；标准模板创建使用另一份
契约，不能直接复用此请求。

首次受理返回 201 和 `agentId`。用同一身份、原请求内容和原幂等键重放，核对返回 200、
`replayed: true` 及同一 `agentId`。响应中断时保留原键和请求，先核实结果，不创建新的重试身份。

通过 `GET /api/v2/agents/{agentId}/state` 等待 `status: available` 且
`serviceAvailability: ready`；采用明确的等待期限，保存失败码或超时状态。201、创建中和
Workload 就绪分别记录，只有真实业务操作完成才能证明该用例迁入成功。

已有 ACK 验证工具可复用
[`provision-agents.ts`](../../deploy/ack/provision-agents.ts)及
[`agent-bindings.ts`](../../deploy/ack/agent-bindings.ts)；后者保存私有 Agent 绑定。
重跑绑定工具可能只查询已有 Agent，不能代替上述 HTTP 幂等重放检查。输入与证据规则见
[ACK 工作流](../../deploy/ack/ACK-REDEPLOY-WORKFLOW.md)。

## 执行业务、重启与更新

自有入口使用应用自己的访问地址、身份和业务协议执行与本地基线相同的用例。平台入口通过
验证后，可用 `POST /api/v1/agents/{agentId}/tasks` 提交文本任务。请求使用 Bearer Token、
`Content-Type: application/json` 和该任务独立的 `Idempotency-Key`：

```json
{"schemaVersion":1,"text":"本次已定义的业务输入"}
```

任务受理返回 202 及 `conversationId`、`executionId`。随后读取
`/api/v1/conversations/{conversationId}/tasks/{executionId}`，通过该路径的 `/events`
订阅 SSE。取消使用 `POST` 请求该路径的 `/cancel`，携带 Bearer Token、
`Content-Type: application/json`、取消操作独立的 `Idempotency-Key` 和
`{"schemaVersion":1}` 请求体。同会话后续任务在提交体中带上 `conversationId`，使用新的任务幂等键。
核对实际输出和终态；取消受理不是停止确认，结果不明不能记为成功。

| 后续操作 | 当前入口与核对方式 |
| --- | --- |
| 启动、停止、重启 | Token 调用 `POST /api/v2/agents/{agentId}/commands`，请求为 `schemaVersion: 1` 和 `command: start/stop/restart`；带幂等键，随后读取状态并检查业务效果 |
| 修改环境变量或 Secret | Owner 浏览器管理入口；记录实际认证方式及配置结果 |
| 升级自定义镜像 | Owner 浏览器管理入口选择新的获准镜像；核对目标 Digest、运行状态及升级后的业务结果 |
| Skill 导入、发布和绑定 | 当前 Skill Hub 浏览器入口；分别核对安装和运行结果 |
| 带文件任务或单次模型选择 | 当前 Token 任务提交体仅包含 `text` 与可选 `conversationId`，不能推导附件及单次模型参数已经接通 |

配置和镜像升级的浏览器接口与 Token `/commands` 是不同认证路径，不能为了实现自动化而
把 Cookie 当作 API Token。重启后核对契约承诺保留的状态；升级失败时核对旧版本可用性。
不通过直写数据库、修改 Workload 或关闭授权来补齐外部接口缺口。

## 验收记录

每项记录实际入口、认证类型、平台与工具源码版本、镜像 Digest、时间和脱敏请求/执行引用。
分别报告本地基线、API 受理、运行就绪、真实业务、生命周期和升级结果。
校验 HTTPS 证书；私有 CA 使用显式信任配置，不跳过 TLS 验证。

负向检查至少包含无创建权限、无目标 Agent 权限和所选入口的未授权访问。平台任务还需检查
跨主体读取、订阅和取消被拒绝；Owner 身份不能替代任务提交主体。

能力矩阵使用“已验证、失败、配置或环境阻塞、产品不支持、未测试”区分结果。已有 fixture、
历史回执和静态接口检查不能替代本次业务证据。缺少真实应用或授权环境时保留待验收项；
发现缺口后先记录复现与最小建议，另行确定产品变更范围。
