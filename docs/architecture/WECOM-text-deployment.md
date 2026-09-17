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

部署必须提供实时公司身份映射、加密/keyring、连接状态指标，以及 PostgreSQL 中唯一连接持有者的租约与隔离。
替换凭证、解绑、重启和多副本接管都要验证旧持有者不再处理消息或发送回复。
对可能挤掉其他部署连接的验证或重新绑定，先向 Owner 展示影响并确认；不拿生产机器人做无提示的连接探测。

## 装配与凭证维护

当前长连接 Adapter 固定使用 `@wecom/aibot-node-sdk@1.0.7`；禁用 SDK 原始 payload 日志。
生产 API 的 `createProductionPlatformApiAssemblyInputV1` 默认不开放机器人配置 API。
部署同时配置下述 Worker `wecom.setup` 和 `connections` 后，显式设置 `wecomSetupEnabled: true`，
并提供 API 侧 `wecomIdentity` 当前企微身份映射，才把已有 `encryptionKeys` 公钥输入传给机器人配置模块；
直接调用 `assemblePlatformApi` 时显式提供 `wecomCredentialEncryptionKeys` 和 `wecomIdentity`。
回执查询/放弃接口使用当前企微身份映射独立装配，不依赖 HTTP 回调 Token 或回调路由。
身份 Adapter 必须提供 `resolveUser`，每次配置操作重新校验当前账号和 Owner 权限。

共享 Worker 的 `wecom` 输入除身份映射、回调 sender 和投递指标外，设置：

- `connections.bindings`：现有部署托管长连接的可信解析器；仅使用页面配置时返回空数组。
- `connections.protectReply/revealReply`：Worker 内部回复上下文保护，使用既有加密路由实现；不需公网回调。
- `connections.observeConnection/observeSetup/observeIngress`：固定状态指标出口，不添加 Bot ID、用户 ID 或正文标签。
- `setup.directory`：实时公司身份目录；`setup.decryptor`：由 Worker-only 私钥 keyring 创建的 `createSecretKeyringDecryptorV1`。

配置候选与密文保存在 `wecom_setup_sessions`，不写入 Runtime Secret 投影表。
Worker 实际认证通过、Owner/配置版本/连接租约仍有效后，通过原 Agent 配置事务激活引用。
失败清除候选密文，保留原绑定；同一 Bot 的探测可能暂时中断原连接，必须先取得页面接管确认。
更新或解除绑定同时清除不再使用的机器人密文，旧 Worker 失去租约后不能继续收发或终结新候选。

渠道密文纳入共享 wrapping key 退役引用检查，新凭证写入与退役使用同一个数据库锁。
当前渠道密文尚不参与 Runtime Secret 的自动重新封装任务：更换加密公钥后，逐个重新验证并绑定机器人，
确认旧渠道引用清除后再退役旧 key；在此之前保留旧 Worker 私钥。不能用 Runtime Secret 轮换完成状态代替该检查。

扫码入口当前返回 `authorization_correlation_unverified` 并展示手动替代入口；
没有通过官方授权来源与一次性配置会话关联验证前，不启用扫码提交，不将本实现计为扫码验收通过。

## 自建应用与显式回调模式

自建应用需要企业 ID、应用 ID、应用 Secret，以及接收消息配置的 Token、EncodingAESKey 和公开 TLS 回调。
`/callbacks/wecom/{bindingReference}` 的 GET 验证 challenge，POST 验证签名、期限、接收方与大小。
平台生成内部引用，Owner 不需要手工编造该标识；已有主动推送凭证不能证明接收回调已配置。
新自助配置由平台保存回调专用密文，API 仅用独立回调 keyring 解密 Token/EncodingAESKey；
Bot/App 发送 Secret 仍仅由 Worker 解密，两类材料不通过 API–Worker RPC 传递。
旧绑定可继续使用部署可信解析器，新配置不会回退该解析器。
不得自动覆盖已有正式应用回调。

在已启用 `wecomSetupEnabled` 并配套上述 Worker 的部署上，API 增加 `wecomApplicationSetup`：

- `publicOrigin`：固定公开 HTTPS origin，不带路径、查询、用户名或密码；平台生成该 origin 下的回调 URL。
- `callbackKeys`：`activeKeyId` 与 `{ id, keyBase64 }` 数组，密钥为平台部署生成的 32 字节 CSPRNG 材料，采用 canonical Base64；仅挂载给 API。
- `replyEncryptionPublicKeyPem`：回调回复路由公钥；对应私钥仍仅位于 Worker。

应用凭证沿 `/api/v1/agents/{agentId}/wecom-app-setup` 配置会话提交，发送和回调密文分别保存；
Owner 无需提供平台 keyring。配置页返回接收消息 URL，Owner 在企微后台显式保存后才进入应用身份验证和激活。
候选收到业务消息时拒绝；回调验证与 Worker 应用认证未完成时不替换原绑定。

回调密文格式固定为 `version: 1`，AES-256-GCM 使用每次生成的 12 字节 nonce 和完整 16 字节 tag，
认证材料包含用途、key ID、Agent、Owner、配置会话和版本。轮换先将新 key 加入所有 API 的 keyring，
再切换 `activeKeyId`；仍被候选或有效绑定引用的旧 key 必须保留。新提交检查已有密文 key 引用，
读取缺少 key 时保持不可用；不能以失败回退旧解析器、明文或 Worker 私钥。
更新绑定后旧密文随原配置事务清除；过期、取消、失效候选由既有配置生命周期清除。
Worker 应用认证仅请求固定企微 `gettoken` 和 `agent/get` 接口，不发送探测消息；
真实回调与文本收发仍需单独验收，不能用应用认证成功替代。

机器人回调仅作为显式兼容模式，使用机器人 ID、Token、EncodingAESKey 和 TLS 回调；
不把该模式的材料列为机器人长连接或扫码的前置条件。

HTTP 回调的临时回复路由按既有实现使用 RSA ≥3072 bit OAEP SHA256 与每条路由独立的 AES-GCM DEK 加密；
API 仅持公钥，Worker 使用私钥 keyring，密文绑定 Agent、渠道、接收方和配置作用域。
这套临时回复路由不能替代长连接 Bot Secret 的持久凭证管理，也不能作为长连接回复的必需输入。

## 共用执行与回复

两类传输调用同一 Channel Core，用同一 PostgreSQL 事务提交 Conversation、Message、Execution、
原任务授权、Runtime outbox、回复意图与审计。`PlatformConversationWorkerOptionsV2.wecom`
接入共享 Worker 的当前授权与回复处理，不能再创建 Runtime 调度循环。
接入方式不改变按发送者隔离、默认模型、撤权停止和审计边界。

部署身份 Adapter 把企微发送者映射到公司身份并实时返回账号/组织状态；
使用加密 userid 的协议按企微[身份对接协议](https://developer.work.weixin.qq.com/document/path/101521)转换，
不能把未经验证的标识、Owner 或平台服务身份当作消息发送者。

回复沿当前有效绑定的协议发送；长连接使用其受支持的回复/发送命令，回调模式使用其获准回复路由。
SDK 自动重连、重试或队列不能突破已持久化的发送状态：

- `pending` / `claimed`：尚未开始外部发送，领取前重验授权与当前绑定。
- `sending`：发送意图已落库；ACK 丢失或 Worker 崩溃时转为 `unknown`。
- `sent`：企微明确受理，不代表终端送达或已读。
- `failed` / `expired` / `cancelled`：明确失败、失去有效回复上下文或权限失效。
- `abandoned`：原发送者放弃未知结果的投递，不产生新的外部发送。

原发送者通过已认证的 `/api/v1/wecom/receipts`、`/api/v1/wecom/receipts/{receiptId}` 查询状态，
通过 `POST /api/v1/wecom/receipts/{receiptId}/abandon` 处置 `unknown`。
查询不返回正文、回复路由或凭证；其他用户和没有当前访问权的主体得到资源不存在。
具体长度、时效和可恢复能力按固定 SDK/协议版本验证，超过限制明确失败，不静默截断或盲目重发。

## 验收资源与证据

| 场景 | 需要的资源 |
| --- | --- |
| 机器人扫码 | 可完成企微授权的测试主体、获准 source、平台配置页面 |
| 机器人手动配置与长连接 | 专用或明确获准接管的 Bot ID/Secret、Worker 出站网络；不需要公网回调 |
| 自建应用及显式机器人回调 | 对应凭证、接收消息配置、可达 TLS 回调；保留已有正式用途 |
| 所有真实文本场景 | 两个实际公司测试发送者、当前身份映射、正式 Runtime 与配置链路 |

验证扫码取消/超时/重放和错误弹窗来源、跨 Owner/Agent、配置冲突、认证失败、轮换/解绑；
再验证机器人单聊/群聊、双发送者隔离、撤权、繁忙、重连/重投、多副本与重启、发送未知及应用文本回调。
协议不提供独立线程时明确记录，不伪造线程支持。
证据绑定 source SHA、SDK 版本、镜像、配置版本、传输模式与实际 Runtime。
Fake、协议 fixture、仅获取 Token 或受控 Runtime transport 不能替代真实收发；文件/媒体与 Connection 未在本票验收。
