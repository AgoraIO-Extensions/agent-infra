# ADR: StaticSpaces 单用户受监督 pilot

## 状态

Accepted：Connection Owner 于 2026-10-10 明确批准本提案；来源为
[#1681](https://github.com/AgoraIO-Extensions/agent-infra/issues/1681)。批准限于本文单用户、单空间、
最长 24 小时的受监督实现、发布与联调。激活前的真实身份、profile/head/digest 绑定及验证条件
仍须全部满足；该批准不是广泛生产签收。

在既有上海 Connection 上完成单用户、单空间的完整联调，明确接受本次 pilot 的残余风险，
而不把它表述为正式 onboarding 或广泛生产验收。正式门禁继续由
[HLD 3.2.2](../architecture/HLD-connection-M1.md#322-staticspaces-deployment-与-action-边界)、
[13.4](../architecture/HLD-connection-M1.md#134-provider-onboarding) 和
[27.6](../architecture/HLD-connection-M1.md#276-供应链与运行身份) 及
[Kernel ADR](ADR-connection-openconnector-kernel-boundary.md) 定义。

## 批准边界

| 项目 | 唯一获准范围 |
| --- | --- |
| 部署 | 既有上海集群 `hcicore-acs-sh-prod01`，namespace `agent-connector`，origin `https://agent-connector.agoralab.co` |
| Principal | 当前操作者本人；实施前通过 Connection 服务端身份解析绑定真实、稳定的 Principal ID，不以 email/username 代替主键 |
| Consumer | Codex 已注册的单个 Consumer（客户端产品身份）；实施前核实并冻结 Consumer ID，不扩展到其他 Consumer 或 Delegated caller |
| 外部账号 | StaticSpaces stable `pk=841`；活跃且非 superuser；保留现有个人 Token |
| 内容空间 | 仅 shared `connection-test`；Application UUID `0c1e6e33-6750-4127-9d72-157e8899ddcd` |
| 空间身份 | owner group UUID `5c8d58a6-4732-4e7a-bf3e-c0174e771aa1`、viewer group UUID `9ba88b80-f9fb-43c8-8c91-684f0bbcdef0` |
| Action | `get_current_user`、`list_files`、`download_file`、`get_markdown_review`、`publish_space`、`upload_html`、`upload_static_package` |
| WRITE | 仅专用空间内带本轮 ownership marker 的隔离 canary；不覆盖现有文件、不扩展成员，不允许 user/public 空间 |
| 期限 | 激活后最多 24 小时；开始、结束时刻与批准记录固定，不能由模型、调用参数或环境开关延长 |

`get_current_user` 只校验所选外部账号。其余六项均显式要求 shared kind 和固定 slug。
`publish_space` 即使针对既有空间，也可能检查或修复组、ACL 和 Application；它仍是有多个外部
效果的非原子请求，Consent 必须展示这些效果，不能描述为单纯上传文件。

该 profile 必须在 Credential 接入、发现、声明、Consent/Grant 和每次 dispatch 前由服务端校验
上述边界。只隐藏 Web 卡片、只检查 Token 的 pk、只靠已有 Grant，均不能替代 Principal/Consumer
与期限的限制。非获准 Principal/Consumer、额外身份字段、其他空间或过期请求必须在 Provider
提交前拒绝。已在途的外部效果不能因关闭准入就被视为撤销或失败。
Consumer/Agent 不能提交 token、Credential ID/version 或其他 Credential selector 覆盖解析；
Credential 由服务端依据获批 Connection/Grant 选择。本人在专用 Credential 表单提交 Token
仍遵循既有浏览器契约，不把该提交能力暴露给 Consumer。

## 实施绑定

已通过本人的 Connection MCP Call 服务端记录核实并冻结：

- Principal：`e3cc9ece-4e3e-4f2e-866e-3ef38fcf5749`。
- Consumer：`consumer-codex`；仅 DEVICE/TOKEN 直接实例，禁止 WORKLOAD 委托调用。
- 受限版本：`static-spaces-connection-v2-supervised`，七项 Action 使用 `@v2`。
- 固定窗口：2026-10-10 05:00:00 UTC 至 2026-10-11 05:00:00 UTC；
  实际发布晚于开始时刻时，可用窗口只会缩短，不顺延或自动续期。
- 本轮 canary：`static-spaces-7a0e99e4-419b-4f83-babb-33f7d9dfe768`；
  文件仅位于该 run 的 `connection-onboarding/` 子目录，正文必须含同 run ownership marker。

实现由 [#1686](https://github.com/AgoraIO-Extensions/agent-infra/issues/1686) 跟踪。
版本源文件、归档 v1 digest 与受限 profile 共同绑定执行摘要；最终 PR head、CI 与 migration
receipt 通过既有正式发布流程关联。数据库持久关闭记录不会因重启或重新授权消失。

## 风险接受

Owner 对以下未关闭项作具名、限范围、限期限的 pilot 风险接受，不将其标为已验收：

- Legal/Security 正式签收、最终容器 SBOM 与 artifact 签名发布证据尚未闭合。
- 当前 Token 的实际到期场景未验证；独立临时 Token 的撤销拒绝已验证，不冒充 expiry 验证。
- 部署边缘限流及 Provider mutating receipt 合同不完整；网关 request ID 不等于幂等或结果证明。
- 完整 Connection 生命周期、页面/MCP 链路尚未验证；它们是本次 pilot 的验收目标。
- 上游没有原生幂等或原子空间身份前置条件。只读 identity preflight 不消除外部 TOCTOU 风险；
  pilot 期间操作者不得并行变更空间、ACL、组或 Application。

以下保护不在风险接受范围内：个人 Credential 隔离、服务端身份与授权、前置连接审批、显式
Consent/Grant、TLS 与固定 origin、DNS/IP pinning、凭证零泄漏、持久 Call/Effect/Dispatch、
入站幂等、提交后未知保留 `UNCERTAIN` 且禁止重试，以及 PostgreSQL 权威数据与单写入实例。
出现隔离失败、凭证泄漏或未知效果时立即停止本 Provider 的新 dispatch。
HLD 27.6 的进程运行身份、Secret 隔离和无动态代码加载边界保持不变；本提案仅请求接受上述
尚未完成的供应链签收/签名证据风险，不豁免这些运行保护或依赖来源/digest 校验。

## 与最新架构的实施映射

基线为 `origin/connection` 的 `231beed8cda353cb59cbf4755a93dc6ffe624913`，遵循
[Provider 目录](../connection/provider-layout.md) 和
[版本生命周期](../connection/provider-release-lifecycle.md)。

- 使用 `providers/static-spaces/` 的 definition/actions/executors 公开入口；不恢复旧扁平实现。
- 保留 `versions/` 中 v1 源码和 digest。收窄 schema、增加 pilot 准入或改变执行闭包时，发布新的
  独立 ProviderRelease/ActionVersion，重新计算 digest；不原地修改归档或伪造 v1 验证矩阵。
- pilot 批准记录与真实验证记录分别保存；不能把风险接受转换成 `LIVE_VERIFIED`，也不能用
  fixture、部署说明、环境变量或未经评审的手动 SQL 开放 Provider。
- 核实 Principal/Consumer 的真实 ID、固定 profile 和有效期，并将其绑定到具名批准记录、最终
  PR head 与发布摘要。任一信息缺失、变化或批准范围不匹配时不激活。
- 记录实际 Codex client 版本并通过现有入口的 OAuth/MCP conformance；不新增旁路 Runtime App，
  不把旧客户端或旧环境的成功外推到本次部署。
- 批准后先同步 HLD 3.2.2/4.3、工程 Spec 和本 ADR；实现通过全仓检查、当前 head CI 与正式
  上海 release/migration 门禁后，才执行受监督发布。不继承旧 LA3/GZ3 例外。

## 验收与退出

从 Connection 页面提交现有 Token，完成前置连接审批和七项新 ActionVersion 的显式 Consent；
通过真实 MCP 验证 READ 与隔离 WRITE。保留 call ID、Effect/Dispatch 终态、入站幂等键、
上游 request ID、bytes/hash 和逐项清理证据；Adapter 探测不能替代这一完整链路。
执行前后验证其他 Principal/Consumer、其他账号/空间、到期准入和未知结果不重放的负向边界。
当前已有证据见 [#1673](https://github.com/AgoraIO-Extensions/agent-infra/pull/1673)，
不得外推为本次新的受限版本已验收。

到期或中止时先关闭该 pilot 的新连接、授权和 dispatch，并按现有 API 撤销相关 Grant；
逐项回读、清理本轮拥有的资源，未知效果由人工对账。期限到达不等于在途 WRITE 已回滚。
不迁移回旧库、不重跑 bootstrap，也不影响其他 Provider。
资源清理由操作者通过获准的上游清理接口完成，仍须逐项核对本轮 marker、路径与 hash；
不新增 Connection 删除 Action，不删除测试空间、ACL、组或 Application。

停止准入不等于退休版本。已登记的执行器仍须保留；新架构要求账号、Grant、当前声明、未完成
Call/Effect/Dispatch 四类依赖全部清理，并有合法接替版本及弃用记录，才能退休及移除路由。
若没有接替版本，保留关闭准入的版本与路由，不能以 pilot 结束为由绕过生命周期门禁。

Owner 的批准仅覆盖本次受监督范围；广泛生产需要另行完成正式 onboarding 和签收，
并重新评审发布及用户授权，不自动复用本次 pilot 批准。
