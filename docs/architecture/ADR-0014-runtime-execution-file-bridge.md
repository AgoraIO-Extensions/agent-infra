# ADR-0014：RuntimeHost 执行期文件桥接

状态：Draft for Review（#1725）

关联：工程 Spec §15.4、[文件存储部署与验收](FILE-storage-deployment.md)、Issue #442、Issue #445

## 背景

Platform 已有 `FileAuthority`、`FileAccessGrantV1`、Execution Grant 附件范围和 `result.file` 事件契约。Worker 可以通过受认证的 `/internal/v1/files/exchange` 取得短期文件访问，但 RuntimeHost 与固定 Driver 之间还没有执行期文件桥。当前 Codex、Claude、ACP/OpenCode 和 Pi Driver 对附件保持 fail-closed；不能把 `fileId` 当作本地路径，也不能把 Platform bearer、S3 URL 或原始字节写入 Runtime 持久状态。

## 决策

1. **签发方与认证边界。** Platform API 的文件授权服务是唯一 `FileAccessGrantV1` 签发方。Worker 继续签发和验证现有 Runtime Execution Grant；RuntimeHost 不自行签发 File Grant，也不把 Runtime Grant 直接当作文件数据面凭证。Worker 与 RuntimeHost 使用部署提供的服务身份访问 Platform API，服务身份固定绑定允许的 Agent 集合。

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

## 后果

该决定复用现有 File Authority 和 Runtime Grant，不新增对象存储、文件表或第二套授权 DTO。短期内所有 Driver capability 仍可保持 false；真实文件能力必须按 Driver 逐个通过受控 Fake、PostgreSQL/S3、重启/unknown 和跨主体负向测试后再开放。Web、企微和 ObjectStorage 只能消费已确认的 `fileId`，不能绕过此桥直接向 Runtime 提供文件。
