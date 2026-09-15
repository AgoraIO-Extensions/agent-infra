# 企微文本渠道部署

本文说明 [工程 Spec §14.2](SPEC-agent-infra-M1-engineering-architecture.md#142-企微)
的文本渠道装配。文件、媒体与 Connection 不在本次文本验收范围。

## 部署输入

每个获准配置由部署分配到唯一 Agent，使用稳定 `bindingReference`。
`wecom_bot` 配置包含机器人 ID、回调 Token、EncodingAESKey 和凭证版本；
`wecom_app` 配置包含企业 ID、应用 ID、回调 Token、EncodingAESKey 和凭证版本。
Owner 只在现有 Agent 配置中绑定该引用，不能提交任意发送 URL 或公司用户 ID。
凭证在部署中加密保存、只替换、不回显，不能进入浏览器投影或日志。

部署身份 Adapter 必须把当前企微发送者映射到公司身份，并实时返回账号状态与组织关系，
同时提供 Owner 的当前有效状态。智能机器人回调的 userid 可能是加密值，不能直接当作公司
用户 ID；按企业微信[身份对接协议](https://developer.work.weixin.qq.com/document/path/101521)
转换后再交给公司身份边界。禁止回退到 Owner 或平台服务身份。

API 使用部署公钥加密临时回复路由；Worker 持有对应私钥。RSA 密钥至少 3072 bit；
每条路由使用新随机 DEK 和 AES-GCM。密文携带公钥指纹；Worker 解密器接受私钥 keyring，
轮换后保留旧私钥直到其未完成路由过期，再按部署密钥流程退役。密文内绑定 Agent、渠道、发送者和群聊。
API 不获得历史路由的解密私钥。此路由不会物化到 Agent Pod 或进入 Runtime 输入。

## API 与 Worker 装配

1. 在 `PlatformApiAssemblyInput.wecom` 提供可信 `identity`、`resolveBinding`、
   `replyEncryptionPublicKeyPem` 和仅接收固定状态的 `observe` 指标出口。
   装配使用既有 Configuration Use Case，并校验配置确实分配给当前 Agent。
2. 将企微接收 URL 配置为 `/callbacks/wecom/{bindingReference}`。GET 验证回调原样返回
   解密后的 challenge；POST 校验签名、时效、接收方与大小后受理。
3. Worker 使用 `@agent-infra/wecom/worker` 的回复解密器与发送 Adapter。
   发送 Adapter 通过部署获取应用 access token，不在 Core 或 Store 保存明文 token。
4. 在共享 `PlatformConversationWorkerOptionsV2.wecom` 注入公司身份、发送 Adapter 和固定状态 `observe` 指标出口。
   共享 Worker 自动发现 Runtime outbox、持久化原任务授权并处理撤权停止；
   每个轮询周期最多领取一条企微回复。`createPlatformWecomWorkerV1` 只处理回复，
   不创建第二个 Runtime 调度器。未配置企微授权时，共享 Worker 拒绝企微业务执行，
   仍允许原任务的系统停止与恢复。关闭共享 Worker 时一并关闭企微 Store。
   Runtime 授权与回复发送前均重新验证当前发送者、绑定、Agent 状态和可用范围。
   受理时固化的授权来源不会因后来新增角色或组织权限而扩张。
   回调及投递审计进入平台既有审计表，保留可信主体、Agent、组件与回执关联；
   未知主体显式记录为未知。运行指标仅使用固定结果标签，不携带内容或用户标识。

回调受理记录、Conversation/Message/Execution、Runtime outbox 与回复意图在同一
PostgreSQL 事务提交。重复回调返回原受理结果；同一事件改变正文或身份时拒绝。
同群不同发送者的 Conversation 和 Runtime Session 独立；企微历史不进入 Web 会话列表。
Owner 设置页在绑定前说明群消息和回复公开可见。

## 回复与故障处置

机器人按官方[主动回复协议](https://developer.work.weixin.qq.com/document/path/101138)
使用一次性 `response_url`，有效期一小时。当前文本实现使用完整的最终回复；
不使用超过六分钟的流式刷新维持长期任务。自建应用调用文本消息发送接口。
机器人单条内容上限 20480 bytes，应用单条上限 2048 bytes；超过限制明确记录失败，
不静默截断。当前公开回调协议不提供独立线程 ID，群聊按群 ID 与发送者映射；
引用内容不会被当成另一个发送者的共享上下文。

- `pending` / `claimed`：尚未开始外部发送；失去 lease 后可重新验证并领取。
- `sending`：发送意图已落库。响应丢失或此时 Worker 崩溃后转为 `unknown`，不自动重发。
- `sent`：企微 API 明确接受，不代表收件人已阅读或可证明的终端送达。
- `failed` / `expired` / `cancelled`：明确失败、回复路由到期或发送前权限失效。
- `abandoned`：原发送者确认不再发送；不会生成新的外部效果。

原发送者可通过已认证的 `/api/v1/wecom/receipts`、
`/api/v1/wecom/receipts/{receiptId}` 查询状态；
`POST /api/v1/wecom/receipts/{receiptId}/abandon` 只处置 `unknown`。
接口不返回正文、回复 URL 或凭证；其他用户和没有当前访问权的主体收到资源不存在。
Web 的身份认证和写操作来源防护沿用部署现有边界。

## 验收要求

受控协议 fixture、Fake 发送端和数据库故障测试只证明自动化覆盖。
真实验收必须使用获准的智能机器人、自建应用、两个公司测试发送者、公开 TLS 回调入口，
以及正式 Runtime 配置链路，绑定 source SHA、镜像与配置版本。
至少验证单聊、机器人群聊、双发送者、撤权、繁忙、重投、API/Worker 重启和发送不确定性。
未提供这些资源或未完成实际收发时，保持真实验收未完成及人工门禁。
