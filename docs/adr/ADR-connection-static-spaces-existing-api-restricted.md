# ADR: StaticSpaces 现有 API 的受限接入

## 状态

Accepted。Connection Owner 于 2026-10-11 明确批准 [#1831](https://github.com/AgoraIO-Extensions/agent-infra/pull/1831) 的长期受限方案及文中残余风险，并授权实现。
本 ADR 是该方向的批准契约，由 [#1672](https://github.com/AgoraIO-Extensions/agent-infra/issues/1672)
跟踪。发布/激活必须绑定本文及最终实现版本；架构批准不代表运行环境已激活。
上游改造任务 [EEP-1832](https://jira.agoralab.co/browse/EEP-1832) 已取消。

## 问题与已知能力

现有 StaticSpaces API 已在单账号隔离空间通过七项真实 Action、bytes/hash 回读、入站同键去重
和清理，证据见 [#1687](https://github.com/AgoraIO-Extensions/agent-infra/issues/1687)。
这些是旧 v3 的正常链路证据，不是新版本验收。

上游源码 `4b9afc47750ae2a8e73f01345745dbe3262d9e1e` 表明单文件写入采用临时文件、
fsync、rename 和目录 fsync，响应提供 size/SHA-256；整包依次写文件，publish-space 还可能
修复组、ACL 和 Application。整包/空间操作不是原子事务。未找到持久幂等执行账本、结果查询
或 Publish API 限流配置；源码没有配置不证明生产网关没有限流。网关 request ID 只用于诊断。

Connection 上海 v89 的实际镜像/SBOM/manifest 签名、运行容器文件与健康核验已完成，证据见
[#1745](https://github.com/AgoraIO-Extensions/agent-infra/issues/1745)。供应链证据不能替代
Legal 签收、凭证到期或新版本的真实授权链路。

## 决定

使用现有 HTTP API，不新增 StaticSpaces 幂等、回执、查询或限流接口。
仅允许具名受限接入；不将缺失能力记录为已实现，也不把受限批准转成 `LIVE_VERIFIED`。
广泛生产仍受 [HLD 13.4](../architecture/HLD-connection-M1.md#134-provider-onboarding) 约束。

| 项目 | 新批准版本的范围 |
| --- | --- |
| 部署 | 既有上海 Connection，origin `https://agent-connector.agoralab.co` |
| Principal | `e3cc9ece-4e3e-4f2e-866e-3ef38fcf5749`，激活前再次通过服务端身份核实 |
| Consumer | `consumer-codex`，仅 DEVICE/TOKEN 直接实例，禁止 Delegated/WORKLOAD |
| 外部账号 | stable pk `841`，保留现有 Token；Credential 不向 Consumer 暴露 |
| 内容空间 | shared `connection-test`；Application `0c1e6e33-6750-4127-9d72-157e8899ddcd`；owner `5c8d58a6-4732-4e7a-bf3e-c0174e771aa1`、viewer `9ba88b80-f9fb-43c8-8c91-684f0bbcdef0` |
| Action | 原四项 READ 与三项 WRITE，不增加业务 Action |
| WRITE | 仅新批准 run 的隔离路径和 marker；拒绝覆盖、其他空间、成员/ACL 参数扩权 |
| 版本 | 新的 immutable ProviderRelease/ActionVersion/profile/digest；不修改归档版本 |
| 授权 | 新批准记录、前置公司审批和显式 Consent/Grant，不继承已撤销的 Grant |
| 有效期 | 长期保持上述受限范围，沿用正常 Grant 生命周期；不是旧 pilot 续期，显式撤权或停用立即停止新准入 |
| 停用 | 撤权、账号/空间身份变化、凭证拒绝、隔离失败或未知效果时关闭新准入；保留在途效果审计 |

账号、Consumer、空间及参数限制必须覆盖 Credential 接入、发现、声明、Consent/Grant 和每次
server-side dispatch，不能只隐藏卡片或用环境开关放行。旧 v2/v3 永久关闭；原 pilot 在
2026-10-11 05:00 UTC 已到期，不重开、不延期。长期受限运行政策是本文独立的发布评审对象，不能套用旧 pilot 的批准；
激活前须绑定最终实现版本、审批记录和发布回执，不沿用旧 pilot 的激活。

固定组身份包含 UUID 与组名，防止同 UUID 被改名后对应另一角色。上游 Application binding 仅
控制门户发现，不是 Publish API 内容授权；READ 始终按上游有效路径 ACL，WRITE 按真实角色组
校验。普通 Token 没有全局 bindings/ACL 管理读取权限，受限接入不增加管理员凭证、不宣称取得
或锁定完整 ACL/binding 快照，也不得用已通过的身份检查代替上游逐请求权限检查。

## 写入与错误语义

- Connection 入站幂等键只防止同一请求创建重复 Call/Effect，不代表上游原生幂等。
- 一项 WRITE 只发出一次获准的上游 mutating 请求。publish-space/整包内部可能产生多个
  非原子效果，Consent 明确展示，不承诺全部成功或全部回滚。
- 提交后超时、连接中断、响应丢失、DB commit unknown 或无法证明 effect 前拒绝时保留
  `UNCERTAIN`，禁止自动重试、重建 Call/Dispatch、改键重放或自动刷新凭证后重发。
- 只有可信且匹配原 Dispatch 的确定结果可 finalize；HTTP 401/429/5xx 本身不能证明未执行。
- 人工用获准 READ 回读目标路径、bytes/hash、原 request ID 与时间进行对账。当前文件 hash
  不能证明历史 Dispatch 唯一成功；没有足够证据时保留未知，不伪造终态回执。
- 到期/撤权和关闭准入不能把已经提交的效果视为失败或回滚，不删除历史执行器或审计。

不承诺上游 quota、自动恢复或 exactly-once。Connection 本地请求预算、TLS/DNS/origin pinning、
权限检查和凭证零泄漏保护继续生效；限流拒绝不会授权更大范围或追加重试。

## 风险与激活门禁

本决定接受现有 API 的能力限制作为限范围已接受风险，不豁免服务端身份、Credential 隔离、
Consent/Grant、持久 Call/Effect/Dispatch、单写、签名供应链和提交后未知不重放。
Legal/开源合规及实际独立凭证 expiry 尚未取得证据；Owner 已对该具名受限范围接受这些未验证项，不将其记为 Legal 签收或 expiry 验证通过，也不扩展为广泛生产批准。

本次 HLD/工程 Spec/ADR 策略已获 Owner 批准；实现和激活须绑定新版本、审批记录及停用政策。
实现 PR 的当前 head 检查、正式 release/迁移回执、部署目标保护仍须通过。旧成功证据用于
定位回归基线，新版本必须通过真实页面公司审批、当前 Token 接入、显式 Consent/Grant，
再执行七项 MCP 的 READ/隔离 WRITE、bytes/hash、同键不重放及 marker/hash 清理。

不要求第二个公司测试身份；授权/参数/跨主体拒绝由已有通用负向测试及单账号实际撤权证据
分别证明，明确各自层次，不把模拟身份负向当作真实跨用户验收。response-lost/部分写入测试
在受控本地边界验证 UNKNOWN 不重放，不在生产增加故障开关或复用过期 pilot。

实施由 [#1834](https://github.com/AgoraIO-Extensions/agent-infra/issues/1834) 跟踪，使用独立
`static-spaces-connection-v4-restricted` 与七项 `@v4`；准入批准引用 #1830/#1831，
新的 run、最终源码/digest 与迁移回执在实现发布时固定。
