# ADR-0014：RuntimeHost 执行期文件桥接

状态：Draft for Review（#1725）

修订：在标准模板 Session Sandbox 中，业务附件的物化位置与保留期（§3、§6）、媒体类型来源（§5）以及结果文件的发布方式，均由 [ADR-0032](../adr/0032-sandbox-file-exchange-and-wecom-media.md) 修订。§1、§2、§4 和 V4 文件交换保持不变。

关联：工程 Spec §15.4、[文件存储部署与验收](FILE-storage-deployment.md)、Issue #442、Issue #445

## 背景

Platform 已有 `FileAuthority`、`FileAccessGrantV1`、Execution Grant 附件范围和 `result.file` 事件契约。Worker 可以通过受认证的 `/internal/v1/files/exchange` 取得短期文件访问，但 RuntimeHost 与固定 Driver 之间还没有执行期文件桥。当前 Codex、Claude、ACP/OpenCode 和 Pi Driver 对附件保持 fail-closed；不能把 `fileId` 当作本地路径，也不能把 Platform bearer、S3 URL 或原始字节写入 Runtime 持久状态。

## 决策

1. **签发方与认证边界。** Platform API 的文件授权服务是唯一 `FileAccessGrantV1` 签发方。Worker 继续签发和验证现有 Runtime Execution Grant；RuntimeHost 不自行签发 File Grant，也不把 Runtime Grant 直接当作文件数据面凭证。Worker 与 RuntimeHost 使用部署提供的服务身份访问 Platform API，服务身份固定绑定允许的 Agent 集合；会话 Sandbox 内的 RuntimeHost 只持有按本 Sandbox 分配从该身份派生的凭据，校验规则见[工程 Spec §15.4.2](SPEC-agent-infra-M1-engineering-architecture.md#1542-认证数据面与短期授权)。

2. **桥接上下文。** Worker 在一次业务投递期间向 RuntimeHost 提供短期、请求级文件桥接上下文；上下文只包含已验证的执行绑定、原 Grant 引用、允许的 `fileId + operation` 集合和过期时间，不写入 durable journal、文件 Store 或普通日志。RuntimeHost 在每次读写前校验 `agentId`、`actorId`、`channelId`、`conversationId`、`executionId`、`sessionGeneration`、`grantId`、`fileId` 和 operation，并要求当前 Runtime service identity 与目标 Agent 匹配。

3. **输入读取。** Driver 只能通过 Host 提供的 `readInput(fileId)` 读取本次 Grant 精确列出的附件。Host 使用现有 Worker File Client/交换入口取得短期访问，固定版本流式读取并限制总字节、时间和并发；读取结果只物化到运行时专属的临时目录，临时路径不得进入业务请求、Driver journal 或事件。撤权、终态、过期、generation/fence 变化或任何绑定不一致均在读取前失败。

4. **结果写入。** Driver 只能通过 Host 提供的 `writeResult(descriptor, body)` 写入结果。Host 通过既有文件 Core 分配 execution-bound `result` 意图并取得只写 File Grant；Driver 不能选择 owner、对象引用、execution 或对象键。完成确认重新校验当前执行和对象版本；只有 `available` 文件的元数据与 `result.file` 事件完全一致时，Platform Store 才持久化该事件。重复调用复用同一 idempotency intent，响应丢失、重启和 unknown 不创建第二对象或虚报成功。

5. **Driver 适配。** 每个 Driver 单独声明支持的媒体类型和输入/结果映射。Codex 的图片输入使用协议定义的临时 `local_image` 形状，路径只在一次执行的临时目录有效；不支持的媒体类型在 native side effect 前拒绝。能力只有在该 Driver 的 bridge、清理、重启和负向 conformance 完成后才可从 `false` 改为 `true`。

6. **恢复与清理。** Host 重启后不恢复旧的临时路径或 File Grant；Worker 必须重新验证当前执行并发放新的短期上下文。临时文件在执行终态、取消、过期或恢复失败后有界清理；清理失败只保留受限诊断，不改变 Platform 文件记录的权威状态。

## 接收契约

后续实现必须提供以下具名接收点，再开启任一 Driver capability：

- Worker → RuntimeHost 的短期桥接输入与绑定校验器；
- RuntimeHost → Driver 的 `readInput`/`writeResult` ephemeral port；
- Platform API origin、服务身份和允许 Agent 映射的 deployment-owned 配置；
- Codex `local_image` 物化与清理实现；
- `result.file` 写入/确认后的 Runtime event 投递与 Store 负向测试。

## V4 Worker ↔ File Authority exchange

V4 Runtime Grant 不能直接作为 File Grant 使用。Worker 与 Platform API 之间增加一个受认证的内部 exchange seam；该 seam 的 request 只传业务绑定和操作意图，Platform API 仍是唯一 `FileAccessGrantV1` 签发方。现有 `ExecutionGrantV1` exchange 保持兼容，不接收 V4 token 作为替代输入。

请求使用独立的 `RuntimeFileExchangeRequestV2` wire，字段仅为：`schemaVersion=2`、`executionGrant`（RuntimeHost 收到并验证过的 V4 Execution Grant 签名原文）、`operation`（`read` 或 `result`）、`fileId`（read 必填）、`descriptor`（result 必填）和 `idempotencyKey`。V1 的自报 `actorId`、`agentId`、`channelId`、`conversationId`、`executionId`、`sessionGeneration`、`grantId`、`expiresAt` 字段已从 V2 wire 移除；同一内部路由继续严格拒绝 V1 请求，不把旧字段解释为授权，也不把旧 verifier 扩宽为接受 V4 token。`result` 的 idempotency key 仍由当前 execution binding 与规范化 descriptor 确定，重试和响应丢失复用同一意图。

Platform API 在任一对象 I/O 前验证 V4 JWS：header 恰为 `alg=EdDSA`、`kid`、`typ=runtime_execution+jws`，签发者与签名 Worker 身份均等于部署配置，命令只允许 `turn.submit`/`turn.supplement`，submit 必须绑定同一 Execution 与相等 delivery fence。随后认证 Worker service identity，检查该 identity 被 deployment 映射到目标 Agent，并在同一事务内重新读取持久 Conversation、Execution、session generation、delivery fence、终态/停止标记及 `task_authorization_records`（存在、未撤销、principal/Agent/Channel 和 `agentAuthorizationRevision` 匹配）。输入 allowlist 只来自签名 claims 的 attachments；File Grant 有效期取部署 `accessTtlMs`，不复制请求或原 Grant 的 `expiresAt`。签名中的 30 秒窗口只限制签发时的委托范围；该 Grant 是委托范围证明而非持续授权，窗口自然过期不构成放行，当前授权始终由持久状态决定（本票 OQ-1 的评审确认决策）。任何绑定不一致、终态、停止、撤权、generation/fence 变化或 service identity 越权都在对象访问前拒绝，且不返回对象存在性。通过后，Platform File Authority 执行现有 read access exchange，或创建 execution-bound result intent/access；响应复用现有 `FileAccessResponseV1`，其中短期 File Grant 只存在于 Worker 内存和一次有界数据面请求，不进入 RuntimeHost、Driver、journal、普通日志或业务 JSON。

Worker 将 response 的短期 grant 封装为 Runtime bridge 的 stream port。RuntimeHost 只看到已校验的 `FileDescriptorV1`、有限流和 `RuntimeFileBridgeContextV1`；它不能读取 File Grant、S3 URL、objectRef 或 service token。读取固定对象版本并限制大小、时间和并发；结果写入完成确认再次检查当前 binding 与对象版本，只有 `available` 文件才能进入 `result.file` 事件。

该 wire 作为独立 contracts seam 生成 JSON Schema/OpenAPI，并已由 Platform API、Worker、RuntimeHost 评审；旧 `ExecutionGrantV1` 未被扩展为 V4 兼容层。`PlatformFileDeploymentV1` 新增 `runtimeWorkerId`：配置了文件能力但缺少该 Worker identity 时，装配必须 fail-closed。生产 deployment builder 与四模板文件 E2E 由 #3060 负责，本 ADR 不据此声称 Driver attachment/result capability 已全面开启。

## Codex Skill 文本输入接收

Issue #2887 的文本输入复用上述 FileAuthority/FileBridge，不增加第二套文件授权。新增的
Invocation V2 / Native V5 将附件绑定到同一次 Skill Execution；旧 V1/V4 继续严格接收。
Codex 的物化位置是当前 Conversation cwd 内、只属于本次执行的临时子目录，不成为长期
工作区数据，也不允许下次 Skill 复用过期授权下的副本。输入来源、签名摘要、恢复与清理的
完整约束见 [Runtime HLD](HLD-agent-runtime-M1.md#codex-skill-的执行期文本输入)。
实际接收与 conformance 完成前，不以文档或操作员 fixture 开放能力。

## 后果

该决定复用现有 File Authority 和 Runtime Grant，不新增对象存储、文件表或第二套授权 DTO。短期内所有 Driver capability 仍可保持 false；真实文件能力必须按 Driver 逐个通过受控 Fake、PostgreSQL/S3、重启/unknown 和跨主体负向测试后再开放。Web、企微和 ObjectStorage 只能消费已确认的 `fileId`，不能绕过此桥直接向 Runtime 提供文件。
