# ADR: StaticSpaces 普通使用与现有 API 风险批准

## 状态

Accepted。Connection Owner 在 #1878 合并后明确授权继续实施，批准本文普通用户、业务空间、
覆盖/public 范围与逐项残余风险。实现由 [#1880](https://github.com/AgoraIO-Extensions/agent-infra/issues/1880)
交付；[#1672](https://github.com/AgoraIO-Extensions/agent-infra/issues/1672) 保留真实验收追踪。
该批准只适用新 static-spaces-connection-v6-standard，最终 executor digest 与发布证据绑定；
不改旧版本/Grant 权限，不免除持久未知写入冻结、正常授权及供应链/迁移保护。

## 目标范围

发布新的普通 StaticSpaces Provider，继续使用现有 HTTP API 和原七项业务 Action。
用户通过公司的 Connection 审批、账号连接及显式 Consent/Grant 后，使用自己的个人 Token
操作 StaticSpaces 实际允许的内容。普通使用由授权交集确定，不依赖特定测试账号或目录。

| 维度 | 拟移除的测试限制 | 普通使用的边界 |
| --- | --- | --- |
| 使用者 | 固定本人 Principal | 所有获公司审批的合法用户；服务端解析当前 Principal |
| 外部账号 | 固定账号 841 | 当前 Token 验证出的稳定账号；保持个人 Connection ownership |
| Consumer | 固定 consumer-codex、直接实例 | 已注册并声明能力的 Consumer；沿用框架支持的 Direct/Delegated 与实例类型，不新增身份协议 |
| 内容空间 | 固定 shared connection-test | user、shared、public；每次请求仍由上游判断实际 READ/WRITE 权限 |
| 路径 | 固定 canary run 和 marker | 空间内任意合法相对路径；仍拒绝越界、绝对路径、保留目录和不安全归档 |
| 覆盖 | 固定 overwrite=false | 默认不覆盖；用户明确提交 overwrite=true 时允许覆盖 |
| 生命周期 | 单用户试点式整版本永久关闭 | 沿用正常 Credential/Connection/Grant 生命周期，隔离受影响的账号和调用 |

个人空间的用户名从 Token identity 解析，Consumer 不能提交可信 username、Principal、Connection
或原始 Credential selector。shared/public 使用显式安全 slug。public 表示所有登录用户可读，
不等于匿名公开；该可见性须在 Action 说明和 Consent 中清楚展示，不能替用户猜选 public。

七项能力保持为 get_current_user、list_files、download_file、get_markdown_review、publish_space、
upload_html、upload_static_package。publish_space 允许在用户指定且获准的空间首次发布；
不新增成员管理、ACL 管理、Application 管理、删除或任意 HTTP Action。发布接口内部初始化或
维护组、ACL、Application 的既有行为属于已说明的外部效果，不开放对应管理参数。

本次使用既有个人 Token connector；内容 shared space 与公司共享 Credential/Connection 是不同
概念，不以解除内容空间限制为理由额外开放共享凭证入口。原 Token 保留，不轮换、不输出。

## 保留的安全与执行契约

- 公司连接审批、有效 Access Authorization、Consumer declaration、明确 Consent/Grant，以及
  Direct/Delegated 身份、Actor、ownership、scope、revision/fence 和恢复门禁仍在服务端校验。
- Credential 仅在 Connection 内保存及注入；稳定账号 active/non-superuser 校验、凭证回显检测、
  输入输出 schema、响应和归档上限、TLS/DNS/redirect/origin allowlist 继续生效。
- READ 按上游有效路径 ACL，WRITE 按实际 owner/manager 或个人空间权限；不要求普通 Token
  读取它无权访问的全局管理策略，也不以 Application 门户可见性代替内容授权。
- WRITE 保留持久 Call/Effect/Dispatch、入站幂等及一次获准提交。上游缺少原生幂等时，不因
  401、429、5xx、timeout、断连、响应丢失或 commit unknown 自动刷新后重发、改键或换 Grant 重放。
- 已获准的测试目录只是验收夹具，不进入普通版本的固定主体、空间或路径准入条件。

## 故障隔离与未知效果

错误参数或明确的 READ 权限拒绝只拒绝该请求；已证明有效的 Token 不因某个内容 ACL 拒绝而
失效。Credential 拒绝、撤销或账号失效影响对应 Credential/Connection/Grant，不关闭其他用户
的整个 ProviderRelease。公司审批撤销、Grant 撤销和 disconnect 保持原有即时停止新准入规则。

WRITE 提交后无法证明终态时保持 UNCERTAIN，并冻结受影响 Connection 的新 WRITE 入口，
覆盖同键、改键、换客户端、重新授权和版本升级；允许仍获正常授权的 READ 用于对账。
冻结从持久未决 WRITE Effect 判断，不能只记录在进程内，也不能靠重连清除。其他 Connection
继续执行。实现若尚不能证明该隔离与不重放条件，新版本不得激活。

对账沿用 [HLD 20.6](../architecture/HLD-connection-M1.md#206-reconciliation) 与
[34.4](../architecture/HLD-connection-M1.md#344-uncertain-外部效果)：没有可信证据时保留未知，
文件当前 hash、网关 request ID 或新的成功写入不能单独证明旧 Dispatch 唯一成功或未发生。
人工终态方案仍遵守既有独立评审与审计规则；不新增无证据的“恢复写入”开关。

## 已批准的推广范围风险

已核对的上游源码为 4b9afc47750ae2a8e73f01345745dbe3262d9e1e。当前 v5 的单账号真实七项
链路与上海签名部署证据见 #1672；它们不能外推为新版本、所有用户或所有空间的验收。

| 项目 | 已知事实或证据缺口 | 已批准的普通使用政策 |
| --- | --- | --- |
| 幂等与终态查询 | 未发现原生持久幂等账本或可查询终态回执 | 接受该能力缺失；只防止本系统重复提交，未知不自动重放，可能长期需要人工处理 |
| 发布与整包 | 单文件原子替换；整包和空间发布非原子，可能涉及内容及权限元数据 | 接受部分完成风险；不承诺整批回滚，覆盖及 public 可见性明确提示 |
| 上游限流 | 未取得边缘 rate-limit/quota 完整合同；没有源码配置不证明生产不存在限流 | 保留本地预算和上游拒绝，WRITE 不增加限流重试或扩容权限 |
| 凭证生命周期 | 原 Token 接入与独立撤销有旧证据；实际独立 expiry 尚未核实 | 按账号拒绝/撤权停止准入；Owner 已接受该未核实项，补证仍保留，不能记成 expiry 通过 |
| Legal 与跨主体现场验证 | 签名/SBOM 不等于 Legal 签收；不预设第二公司测试身份 | Owner 已接受未完成项，补证仍保留；通用/真实 PG 负向与现场测试分层，不冒充多用户现场结果 |

批准必须覆盖所有获批用户、其获准业务空间和覆盖写入的推广范围，明确每项接受或仍阻塞，
并绑定新版本和最终 digest；不能引用旧单用户 risk acceptance 自动放行。不可豁免的身份、
Credential 隔离、真实上游权限、持久执行、未知不重放、供应链与迁移保护不列入风险接受。

该政策改变 [HLD G-02/G-03](../architecture/HLD-connection-M1.md#42-待批准门禁) 和
[13.4](../architecture/HLD-connection-M1.md#134-provider-onboarding) 的 StaticSpaces 准入范围。
批准时必须同步这些条款的实际发布条件、UNKNOWN 文案及对账责任。本批准适用以下 HLD 实际发布条件。
已验证、已接受的能力缺失和未验证项分别记录；PUBLISHED 运行批准不等同 LIVE_VERIFIED，
也不伪造 Legal/Security 或凭证 expiry 签收。

## 版本与升级

计划以独立 static-spaces-connection-v6-standard 与七项 @v6 实现，最终 ID/digest 在实现票
固定。保留 v1–v5 字节、登记路由及关闭审计；不删除旧关闭记录、不改写当前 v5 executor，
不重开已关闭 pilot。普通版的失败隔离不能反向改变旧受限版的关闭规则。

v5→新版本增加用户、空间、路径、Consumer 和覆盖范围，必须登记 REAPPROVAL_REQUIRED。
公司的 StaticSpaces full 名称可保留，但普通版需新的 Capability Profile/Policy、实际公司审批及
逐项 Consent/Grant。发布代码不会给现有 Grant 自动扩权。原账号和 Token 可以经正常凭证复用
升级，旧 Credential 撤销仍归属旧版本；所有未决 Effect 与安全冻结跨升级保留。

## 实施与验收顺序

1. Owner 批准推广范围、逐项风险和上述 HLD 条款更新；将本 ADR 转为 Accepted，并建立独立
   实现 Issue。不得先删除硬编码或使用环境开关开放现网。
2. 实现新 immutable 版本和追加迁移，复用既有 connector、授权与 egress。真实 PostgreSQL 验证
   普通主体/客户端、账号 ownership、跨主体拒绝、凭证复用升级、撤权、故障隔离及未知 WRITE
   的同键/改键/跨 Grant/跨版本不重放。归档与路径保护覆盖正常业务文件和恶意输入。
3. 按仓库流程完成当前 head CI/真实 Review、签名镜像/SBOM/license、canonical 上海迁移与
   hash 回执核验、精确 digest 部署与健康核验。供应链证据绑定新发布物。
4. 发布普通版 StaticSpaces full 策略，并通过真实页面公司审批、原 Token 复用、完整七项 Consent
   和 MCP 验证。实测个人空间、获准 shared/public 空间、非测试路径、默认不覆盖和显式覆盖，
   回读 bytes/hash/review URL、同键去重及允许/拒绝路径。
5. 真实 WRITE 只使用另行明确授权的隔离目标与内容，不猜测或写现有业务文件；按 marker/hash
   清理验收数据。第二公司测试身份不是预设前提，缺少现场多用户/expiry 证据如实记录。
   收集本方案全部必需证据后才完成推广，不以旧 v5 成功、文档或部署本身关闭验收。
