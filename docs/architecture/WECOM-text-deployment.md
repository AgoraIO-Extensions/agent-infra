# 企微文本渠道部署

绑定体验以[平台 PRD §10.2](../prd/PRD-agent-platform-M1.md#102-渠道绑定)为准；
配置、凭证、连接持有者与共享执行边界以[工程 Spec §14.2](SPEC-agent-infra-M1-engineering-architecture.md#142-企微)为准。
本文列出分模式的部署输入和验收要求，不能把配置字段或受控测试当作渠道已交付。

## 智能机器人：默认长连接

Owner 设置页提供两种入口，最终都保存到同一个 Agent 渠道绑定：

| 入口 | Owner 操作 | 部署输入 |
| --- | --- | --- |
| 扫码授权 | 打开企微授权窗口，扫码并确认创建或授权机器人 | 获准的授权来源标识 `source`、固定官方 origin、配置会话与有效期 |
| 手动配置 | 填写已有机器人的 Bot ID、Secret | 可连接官方 WebSocket 服务的 Worker、渠道凭证加密公钥和 Worker-only keyring |

Owner 无需提供公网回调 URL、Token、EncodingAESKey 或内部配置标识。
扫码不可用时展示原因与手动入口，不显示虚假的二维码或成功状态；扫码验收仍保持未完成。
浏览器仅在本次输入/授权交付中持有 Secret，提交后清除；读取配置只返回元数据与状态。
长连接认证、心跳和重连由 Worker 侧 Adapter 承担，不能由浏览器或 Agent Runtime 常驻连接。

优先复用企微发布的 SDK，并在引入时固定版本和校验依赖：

- 长连接：[@wecom/aibot-node-sdk](https://github.com/WecomTeam/aibot-node-sdk)。
- 扫码授权：[@wecom/wecom-aibot-sdk](https://www.npmjs.com/package/@wecom/wecom-aibot-sdk)。

扫码 SDK 返回 Bot ID 和 Secret，不等于已建立可用绑定。按工程 Spec 验证弹窗、一次性 state 和服务器配置会话，
再由 Worker 验证凭证与 Core 激活绑定；SDK 缺少宿主校验时必须补齐，无法建立可信关联则拒绝并提供手动入口。
不照抄官方示例中输出 Secret、消息正文或原始 payload 的日志。

目标部署需提供同集群企微目录每日完整快照、当前 LDAP 账号状态和唯一邮箱关联，以及加密/keyring、连接状态指标、PostgreSQL 中唯一连接持有者的租约与隔离。组织变化按快照生效；LDAP 停用和 Platform 管理员禁用立即拒绝。具体授权规则以[平台 PRD §7.1](../prd/PRD-agent-platform-M1.md#71-可用范围)为准。
替换凭证、解绑、重启和多副本接管都要验证旧持有者不再处理消息或发送回复。
对可能挤掉其他部署连接的验证或重新绑定，先向 Owner 展示影响并确认；不拿生产机器人做无提示的连接探测。

## 装配与凭证维护

当前长连接 Adapter 固定使用 `@wecom/aibot-node-sdk@1.0.7`；禁用 SDK 原始 payload 日志。
生产 API 的 `createProductionPlatformApiAssemblyInputV1` 默认不开放机器人配置 API。
部署同时配置下述 Worker `wecom.setup` 和 `connections` 后，在 API 部署输入里同时提供
`wecomCredentialEncryptionKeys`（与 Runtime Secret 相同格式的 `encryptionKeys` 公钥输入）和
`wecomIdentity`（API 侧当前企微身份映射），机器人配置模块才会装配；只提供密钥时启动失败。
直接调用 `assemblePlatformApi` 时提供同样两项。
回执查询/放弃接口使用当前企微身份映射独立装配，不依赖 HTTP 回调 Token 或回调路由。
身份 Adapter 必须提供 `resolveUser`，每次配置操作重新校验当前账号和 Owner 权限。

共享 Worker 的 `wecom` 输入除身份映射、回调 sender 和投递指标外，设置：

- `connections.bindings`：现有部署托管长连接的可信解析器；仅使用页面配置时返回空数组。
- `connections.protectReply/revealReply`：Worker 内部回复上下文保护，使用既有加密路由实现；不需公网回调。
- `connections.observeConnection/observeSetup/observeIngress`：固定状态指标出口，不添加 Bot ID、用户 ID 或正文标签。
- `setup.directory`：现有身份目录接口；接入独立企微快照服务后须按当前 LDAP 状态、邮箱唯一关联和快照有效期实现该接口，不能把现有部署输入视为已完成新身份验收。`setup.decryptor`：由 Worker-only 私钥 keyring 创建的 `createSecretKeyringDecryptorV1`。

配置候选与密文保存在 `wecom_setup_sessions`，不写入 Runtime Secret 投影表。
Worker 实际认证通过、Owner/配置版本/连接租约仍有效后，通过原 Agent 配置事务激活引用。
失败清除候选密文，保留原绑定；同一 Bot 的探测可能暂时中断原连接，必须先取得页面接管确认。
更新或解除绑定同时清除不再使用的机器人密文，旧 Worker 失去租约后不能继续收发或终结新候选。

渠道密文纳入共享 wrapping key 退役引用检查，新凭证写入与退役使用同一个数据库锁。
当前渠道密文尚不参与 Runtime Secret 的自动重新封装任务：更换加密公钥后，逐个重新验证并绑定机器人，
确认旧渠道引用清除后再退役旧 key；在此之前保留旧 Worker 私钥。不能用 Runtime Secret 轮换完成状态代替该检查。

扫码入口由 API 部署输入 `wecomBotQr` 开启，不提供时返回 `authorization_correlation_unverified` 并展示手动替代入口：

```js
wecomBotQr: {
  source: "<部署自定的来源标识>",
  authOrigin: "https://work.weixin.qq.com",
  authorizationEndpoint: "https://work.weixin.qq.com/ai/qc/gen",
}
```

- 授权地址由平台拼上 `source` 和本次配置会话的一次性 `state`。官方扫码页的二维码 300 秒后过期，
  页面在 Owner 用企业微信确认后只向 opener 发送 `{type:"AUTH_SUCCESS", payload:{botid, secret}}`，不回传 `state`。
- 浏览器只接受来自 `authOrigin`、且正是本页为这次配置会话打开的那个弹窗的结果；
  `AUTH_CANCEL`、`WINDOW_CLOSE` 按取消处理，`AUTH_ERROR` 按失败处理，其他类型忽略。
- 一次性 `state` 仍由本页随凭证提交，服务端照旧校验摘要、有效期和配置版本；之后与手动配置一样，
  由 Worker 用真实长连接认证、Core 激活绑定。
- 等待扫码默认到配置会话到期前 30 秒，留给面板确认与 Worker 验证。
- 部署自有的中转页也可以发送 `{botId, secret, source, state}`，`source` 与 `state` 必须一致。

## 自建应用与显式回调模式

自建应用需要企业 ID、应用 ID、应用 Secret，以及接收消息配置的 Token、EncodingAESKey 和公开 TLS 回调。
`/callbacks/wecom/{bindingReference}` 的 GET 验证 challenge，POST 验证签名、期限、接收方与大小。
平台生成内部引用，Owner 不需要手工编造该标识；已有主动推送凭证不能证明接收回调已配置。
回调 Token/EncodingAESKey 由部署可信绑定解析器受限注入 API；Bot/App 发送 Secret 仅由 Worker 解密使用，
两类材料不能混用，也不通过 API–Worker RPC 传递。
不得自动覆盖已有正式应用回调。

机器人回调仅作为显式兼容模式，使用机器人 ID、Token、EncodingAESKey 和 TLS 回调；
不把该模式的材料列为机器人长连接或扫码的前置条件。

HTTP 回调的临时回复路由按既有实现使用 RSA ≥3072 bit OAEP SHA256 与每条路由独立的 AES-GCM DEK 加密；
API 仅持公钥，Worker 使用私钥 keyring，密文绑定 Agent、渠道、接收方和配置作用域。
这套临时回复路由不能替代长连接 Bot Secret 的持久凭证管理，也不能作为长连接回复的必需输入。

## 共用执行与回复

两类传输调用同一 Channel Core，用同一 PostgreSQL 事务提交 Conversation、Message、Execution、
原任务授权、Runtime outbox、回复意图与审计。`PlatformConversationWorkerOptionsV2.wecom`
接入共享 Worker 的当前授权与回复处理，不能再创建 Runtime 调度循环。
接入方式不改变按发送者隔离、默认模型、撤权停止和审计边界；标准模板按[平台 PRD 第 8 节](../prd/PRD-agent-platform-M1.md#8-标准模板的模型配置)在任务受理时绑定本次 Relay Key 版本。

部署身份 Adapter 从完整、未过期的企微目录快照与 LDAP 按唯一邮箱关联发送者，实时核对 LDAP 账号及 Platform 禁用状态；
使用加密 userid 的协议按企微[身份对接协议](https://developer.work.weixin.qq.com/document/path/101521)转换，
不能把未经验证的标识、Owner 或平台服务身份当作消息发送者。

回复沿当前有效绑定的协议发送；长连接使用其受支持的回复/发送命令，回调模式使用其获准回复路由。

新建会话与会话不可用（[平台 PRD §10.3](../prd/PRD-agent-platform-M1.md#103-企微会话)）：

- 去掉开头对机器人的 @ 提及和首尾空白后，文本与 `/new` 一致（ASCII 不区分大小写）且不带附件，按新建会话处理；
  其他文本仍作为普通消息。新建会话不调用 Agent、不发处理中提示。回执受理状态为 `new_conversation`，
  回复固定文案“已开始新会话”。
- 映射到的 Conversation 不可用或处于代次隔离时，回执受理状态为 `unavailable`（指当前会话不可用，不是 Agent 不可用），
  回复“当前会话不可用，发送 /new 开始新会话”。Agent 不可用、依赖不可用或无权限时仍按原有拒绝路径回复，不写这类回执。
- 已受理消息的执行失败时，如果它所属的 Conversation 已经不可用，失败文案改为
  “本次任务执行失败，当前会话不可用，发送 /new 开始新会话”。

SDK 自动重连、重试或队列不能突破已持久化的发送状态：

- 长连接受理（回执写入）后，用回调的 `req_id` 与该消息的 stream ID 立即发送一帧 `finish=false` 的
  “已收到，正在处理”。它不经回执状态机、不记发送意图；发送失败或 ACK 丢失不重发，也不影响最终回复。
  最终回复（答案或固定提示）在同一 stream 上 `finish=true`，覆盖处理中提示；繁忙与拒绝的消息不发处理中提示。
- 回复有效期：长连接为收到消息后 9 分钟，留在[官方 stream 时限](https://developer.work.weixin.qq.com/document/path/101463)
  （首次发送起 10 分钟内必须结束）之内。到期前 30 秒回答仍未就绪时领取回执，发送固定超时提示
  “回复超时，Agent 未能在企微回复时限内完成，请稍后重试”；已经到期则记为 `expired`。
- `pending` / `claimed`：尚未开始外部发送，领取前重验授权与当前绑定。已受理消息的答案只取已落库的正文：
  执行 `completed` 后，还要等 Runtime 的终态 `execution.status` 事件落库才领取（状态响应或恢复可能先写入终态）；
  `failed`、`cancelled` 只发固定文案，不等待；回复过期时照常领取并记为 `expired`。
- `sending`：发送意图已落库；ACK 丢失或 Worker 崩溃时转为 `unknown`。
- `sent`：企微明确受理，不代表终端送达或已读。
- `failed` / `expired` / `cancelled`：明确失败、失去有效回复上下文或权限失效。
- `abandoned`：原发送者放弃未知结果的投递，不产生新的外部发送。

原发送者通过已认证的 `/api/v1/wecom/receipts`、`/api/v1/wecom/receipts/{receiptId}` 查询状态，
通过 `POST /api/v1/wecom/receipts/{receiptId}/abandon` 处置 `unknown`。
查询不返回正文、回复路由或凭证；其他用户和没有当前访问权的主体得到资源不存在。
具体长度、时效和可恢复能力按固定 SDK/协议版本验证，超过限制明确失败，不静默截断或盲目重发；
思考过程的截短规则见下节。

## 媒体

收发规则以[工程 Spec §14.2.3](SPEC-agent-infra-M1-engineering-architecture.md#1423-媒体)为准，决策见
[ADR-0032](../adr/0032-sandbox-file-exchange-and-wecom-media.md)。本节列出企微官方限额和部署要求。

只有智能机器人长连接支持媒体。下表依据[智能机器人长连接](https://developer.work.weixin.qq.com/document/path/101463)，
核对日期为 2026-10-22，SDK 为 `@wecom/aibot-node-sdk@1.0.7`：

| 项目 | 官方限制 |
| --- | --- |
| 入站图片、文件、视频 | 消息中的下载地址 5 分钟内有效，内容已加密；每个地址带独立 `aeskey`。SDK `downloadFile` 不限制响应大小，Worker 自行有界下载，再用同一 SDK 的 `decryptFile` 解密；文件名取下载响应的 `Content-Disposition` |
| 入站语音 | 长连接下只提供转写文本 |
| 出站临时素材 | 分片上传，每片不超过 512KB，最多 100 片；素材 3 天内有效 |
| 出站大小与格式 | 图片不超过 10MB（png、jpg、gif）；视频不超过 10MB（mp4）；语音不超过 2MB（amr）；普通文件不超过 20MB；最小 5 字节 |
| 频率 | 每个会话的回复与主动推送合计 30 条/分钟、1000 条/小时；每个机器人上传 30 次/分钟、1000 次/小时 |
| 回复窗口 | 收到消息后 24 小时内可以回复；stream 回复仍受上文 10 分钟时限约束 |

部署要求：

- 为企微 Channel 声明 FileLimits，媒体类型和大小不超过上表限额。没有声明时，按工程 Spec §15.4.1 拒绝收发媒体。
- Worker 需要能访问企微下载与上传所用的官方域名。下载地址、`aeskey`、`media_id` 和文件内容不进入日志、指标或 Trace。
- 自建应用和显式机器人回调目前不支持媒体：结果文件改为在文本中说明，入站媒体回复固定说明。
  以后要启用，需另行验证 `media/upload` 等接口，并更新工程 Spec。
- 长连接入站媒体由 Worker 部署输入 `wecom.media` 装配：`storage` 是与 Platform API 文件面同一 bucket 和前缀的
  对象存储 Adapter（需要 `upload` 与 `inspect`），可选 `downloadTimeoutMs`（默认 60 秒）、`maxConcurrentDownloads`
  （整个 Worker 进程，默认 4）、`allowedDownloadHosts`（批准的下载域名，初始地址与每一跳重定向都必须落在其中）、
  `intentTtlMs`、`accessTtlMs` 和出站 `fetch`。不提供 `allowedDownloadHosts` 时只接受 HTTPS、不带凭据的公网 DNS 名称，
  拒绝 IP 字面量与集群内部名称。没有 `wecom.media` 时 Worker 不装配入站媒体，媒体消息按不支持回复。
- 长连接出站媒体同样由 `wecom.media` 装配：`storage` 还提供 `download` 时，Worker 按文件记录的固定版本读取结果文件，
  整个 Worker 进程同时发送 2 个媒体，单个媒体的读取与上传限 90 秒。没有 `download` 或没有 `wecom.media` 时，
  结果文件按“当前渠道不支持发送文件”在文本中说明。

入站回执（工程 Spec §14.2.3）：

- 只带图片、文件或视频的消息正文为空，附件随 Message 与 Execution 交给 Agent；附件清单由 Runtime 追加到原生输入
  （工程 Spec §15.4.4），不改写平台消息。
- 不调用 Agent 时，回执受理状态为 `media_rejected`，回执只记录原因与生效上限，审计动作为 `wecom.media_rejected`，
  并在同一 stream 上回复固定说明，不发处理中提示：

| 原因 | 回复 |
| --- | --- |
| 超过 FileLimits 交集与 Driver 单文件上限中较小的一个 | 文件超过 {上限}，未发送给 Agent |
| 按实际字节识别的类型不在 FileLimits 内，或无法确认格式 | 不支持该文件类型，未发送给 Agent |
| 下载地址已过有效期 | 文件下载地址已过期，未发送给 Agent，请重新发送 |
| 下载、解密或写入文件面失败 | 文件接收失败，未发送给 Agent，请重新发送 |
| 当前模式不支持媒体、Worker 未装配文件面或未声明 FileLimits | 当前渠道不支持接收图片、文件、语音或视频，未发送给 Agent |

出站回复（工程 Spec §14.2.3）：

- 回答中的每个 `sandbox:` 链接或图片改写为“文件名（说明）”；没有出现在回答中的结果文件逐行附在末尾。
  说明按下表；回执按文件记录的进度只用于状态判定与恢复，不通过回执查询返回。

| 情况 | 说明 |
| --- | --- |
| 随本次回复发送 | 见下方文件 |
| 超过企微大小限制、小于 5 字节，或超过每次回复 10 个 | 超出企微限制，未发送 |
| 类型不在该企微 Channel 当前 FileLimits 内 | 类型不支持，未发送 |
| 超出每会话或每机器人的频率限制 | 超出企微发送频率限制，未发送 |
| 引用的文件没有成为已确认的结果文件 | 未发布 |
| 自建应用、显式机器人回调，或 Worker 未装配出站媒体 | 当前渠道不支持发送文件 |

## 思考过程

回答带有思考过程（[平台 PRD §10.3](../prd/PRD-agent-platform-M1.md#103-企微会话)）时，回复按以下规则组合；
事件保存、发送状态机、fence 与一次性发送语义不变，决策见
[ADR-0026](../adr/0026-show-model-reasoning-as-conversation-content.md)。

- 只有执行完成（completed）的回复组合思考过程。处理中、超时、繁忙、不可用、无权限、取消和失败等固定文案不附带；
  答案为空时不发送只有思考过程的回复。
- 格式为 `<think>{思考过程}</think>`、一个空行、答案。企微按
  [被动回复消息](https://developer.work.weixin.qq.com/document/path/101031)把 `<think></think>` 中的内容
  展示为思考过程。组合前先中和思考内容里的 `<think>`、`</think>` 字面量，不能提前闭合或另起思考块。
- 整条回复不超过 20480 字节，答案优先：答案本身超过上限时仍按原规则明确失败；否则思考过程在 UTF-8
  码点边界截短，并在末尾附“（思考过程较长，已截断）”；连提示都放不下时只发答案。
- Store 只在 completed 时按顺序读取 `reasoning.delta` 的有界前缀（累计约 20480 字节、最多 10000 条）；
  没有读完时同样按截短处理并附提示，答案照常发送。摘要与原始推理各自按顺序拼接，先摘要、后原始推理，与 Web 一致。
- 发送端口同时拿到只含答案的文本和带思考过程的完整回复，只有长连接 stream 回复使用后者；后者不合规时退回只发答案。
- 单聊和群聊规则相同；群聊中的思考过程与答案一样对群成员可见。

| 回复方式 | 思考过程 |
| --- | --- |
| 智能机器人长连接（stream 回复） | 附带 |
| 智能机器人 HTTP 回调（`response_url` markdown） | 真实验证渲染后再启用，之前不附带 |
| 自建应用文本消息 | 不附带，不出现原样的 `<think>` 标签 |

## 验收资源与证据

| 场景 | 需要的资源 |
| --- | --- |
| 机器人扫码 | 可完成企微授权的测试主体、获准 source、平台配置页面 |
| 机器人手动配置与长连接 | 专用或明确获准接管的 Bot ID/Secret、Worker 出站网络；不需要公网回调 |
| 自建应用及显式机器人回调 | 对应凭证、接收消息配置、可达 TLS 回调；保留已有正式用途 |
| 所有真实文本场景 | 两个实际公司测试发送者、当前身份映射、正式 Runtime 与配置链路 |

验证扫码取消/超时/重放和错误弹窗来源、跨 Owner/Agent、配置冲突、认证失败、轮换/解绑；
再验证机器人单聊/群聊、双发送者隔离、撤权、繁忙、重连/重投、多副本与重启、发送未知及应用文本回调。
思考过程另验长连接单聊与群聊的展示、答案完整、过长截短提示，以及固定文案和自建应用文本不附带。
协议不提供独立线程时明确记录，不伪造线程支持。
证据绑定 source SHA、SDK 版本、镜像、配置版本、传输模式与实际 Runtime。
Fake、协议 fixture、仅获取 Token 或受控 Runtime transport 不能替代真实收发。长连接文件与媒体的真实收发由
[#3230](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230) 验收；Connection 不在本票验收范围内。
