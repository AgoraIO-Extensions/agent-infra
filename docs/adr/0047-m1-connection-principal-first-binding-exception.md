# ADR-0047：M1 限时例外，动态手工安装按使用者首次绑定锁定 Connection 主体

## 状态

提案，归属 [#4199](https://github.com/AgoraIO-Extensions/agent-infra/issues/4199)，
同属 [#4157](https://github.com/AgoraIO-Extensions/agent-infra/issues/4157) 的 Owner 手工关联交付线。
须经非实现方独立评审后合入。完整规则只在
[工程 Spec §13.5.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1351-字段与配置来源)
维护，本 ADR 只记录取舍、风险和接受依据，不单独覆盖两份 PRD、工程 Spec 或 HLD。

例外在 Connection 原 OAuth 事务回读合同（[EP-1123](https://jira.agoralab.co/browse/EP-1123)）
发布并获部署批准后失效，最迟在部署批准的 UTC 截止时间 `notAfter`（不晚于 M1 结束）到期；
到期时已有例外安装的处理见工程 Spec §13.5.1 例外第 8 项。

## 问题

工程 Spec §13.5.1 要求动态手工安装在换码前，把 Connection 实际 Principal 与 Platform 用户的
预期映射核对一致；§13.5.6 依赖 Connection 发布原 OAuth 事务回读合同才能启用。EP-1123 尚未
发布，也没有排期，#4199 的 PR C2 和 #4157 AC-4 因此无法完成。

Connection 没有已发布的接口能在换码后给出 Principal 的 `issuer + stable uid`：没有 token
introspection 和 userinfo，授权服务器元数据只公布 authorize、token、revoke 及按配置开启的
register 端点，token 不透明，MCP 也没有返回 Connection Principal 的工具。用邮箱、显示名、
JWT 或私有接口推断主体是工程 Spec §13.5.6 明确禁止的。

已发布且已挂载的 EP-1060 `GET /connection/v1/agents/{agentId}/oauth-clients/{registrationKey}`
可以在用户批准之后、换码之前，读出该安装 DEVICE 实例绑定的 `principalId`。agora-connector
main `2019ca075149ec5184ceadc06d923b69e64c37e5` 的
`packages/connection-store/src/oauth-repository.ts` 批准事务（L1567–1582）以
`principal_id IS NULL OR principal_id = 当前 Principal` 为条件更新实例，另一 Principal 再批准同一
实例返回 `access_denied`。所以一个安装只会绑定一个 Principal，换码前读到的 `principalId` 就是
token 将绑定的 Principal。这一行为不在 EP-1060 已发布合同中，工程 Spec §13.5.1 例外第 1 项把它
列为启用前提，并把例外批准绑定到已核实的 Connection 版本。缺的是这个不透明 ID 与公司员工的
对应关系。

## 决策

M1 期间，动态手工安装用“换码前回读 EP-1060 的实例 `principalId`，再做一致性约束”代替与预期
映射的核对：一个 `principalId` 只能对应一个 Platform 用户；一个 Platform 用户首次通过的
`principalId` 固定下来，之后所有安装必须相同；可首次固定的 `principalId` 总数受部署批准的
上限约束；首次绑定后由 Connection 管理员或其书面指定的非实现方在 Connection 管理端调用审计中
限期人工核对，超期或不一致即封闭并撤销；例外安装带 `consistency-exception-v1` 标记，到达
`notAfter` 时全部封闭并撤销，EP-1123 先获批时逐一回溯核对。前提、触发条件、补偿和失效的完整
规则见工程 Spec §13.5.1。

每个使用者照常用自己的身份为自己发起安装，Owner 关联 Agent 时不需要任何批准动作，与
[Platform PRD §9.1](../prd/PRD-agent-platform-M1.md#91-owner-按需关联与用户-oauth)
“使用者默认通过 Connection OAuth 独立确认自己的安装”一致。Connection 侧不改动。

## 风险与接受

state 和 PKCE 能证明回跳属于原 OAuth 事务、授权码不能在别的安装兑换，但证明不了在
Connection 上点“批准”的是谁。

**最坏情况。** 某个 Platform 用户的 Agent 安装绑定到另一位员工的 Connection 身份，并以那位
员工的外部授权调用工具，例如在他的 GitHub 上读写。Grant 在“同一 Principal 加同一 Consumer”
下可以跨实例复用，所以只要受害者已经在同一个 Agent 上授权过，这个错绑的安装就直接继承他的
Grant。

**在 M1 试点里实际发生需要的条件。**

- 攻击者需要是该 Agent 的使用者，并诱导另一位员工用其 Connection 账号批准自己的安装链接；
  或同一浏览器登录了别人的 Connection 账号。
- 受害者用自己的公司账号在 Connection 上批准了一个不属于自己的链接，属于同公司内部的诱导授权。
- 受害者已经在同一个 Agent 的 Consumer 上有 Grant，或者又被诱导去授权。
- 试点只有两个测试用户，由部署批准 `maximumPinnedPrincipals` 为 2，按工程 Spec §13.5.1 例外
  第 3 项在换码前强制；外部账号限于专用的 GitHub 测试账号和一个受控的 private 仓库，影响面限于
  测试资源。

更现实的一种情况是误操作：测试人员在同一个浏览器里登录着另一个测试账号去批准。一致性约束
和人工核对可以发现这种情况。

**风险接受依据。** 用户 2026-11-20T04:3xZ 原话（经 Kiro sess_714f2fb5 前台转达）：
“我觉得这是安全问题吧？先不管它打通流程再说，后续再优化”。用户 2026-11-20T05:4xZ 另确认
产品模型保持不变：Owner 关联 Agent 时不需要批准动作，每个使用者用自己的身份在 Connection
独立确认自己的安装。用户 2026-11-20T07:5xZ 决定（原话“按你的建议”，见
[#4269 评论 7033676112](https://github.com/AgoraIO-Extensions/agent-infra/pull/4269#issuecomment-7033676112)）
接受：去掉 Owner-only 后，上文最坏情况中的攻击者从该 Agent 的 Owner 扩大到该 Agent 的任一
使用者；补偿措施不变。

## 取舍

| 方案 | 结论 |
| --- | --- |
| 等 EP-1123 发布 | 不选。没有排期，#4157 AC-4 无法在 M1 内完成。 |
| 从已发布接口取得 `issuer + stable uid` | 不可行。Connection 没有对应接口，推断主体被工程 Spec 禁止。 |
| EP-1060 回读加一致性约束，并只允许 Owner 本人安装 | 不选。只允许 Owner 安装与 PRD §9.1 的按使用者身份模型冲突，需要改 PRD。 |
| EP-1060 回读加一致性约束，使用者照常为自己安装 | 选用。不改 PRD 和 Connection；错绑由唯一性、首次固定、人工核对和回溯核对发现并撤销。 |
| 试点界限只写在 ADR | 不选。使用者不限于 Owner 后例外覆盖全部使用者，界限须由工程 Spec 的批准上限强制。 |
| 到达 `notAfter` 后保留已核对的例外安装 | 不选。EP-1123 不来时例外会无限期有效；到期统一封闭撤销，使用者按届时有效路径重装。 |

EP-1123 获批后另开后续 PR：接入事务回读、完成回溯核对并移除例外。

## 验证

例外负例的验收见
[工程 Spec §13.5.7](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1357-agent-关联与-oauth-安装准备)
动态手工 confirm 验收。首次绑定的人工核对和 #4157 AC-4、AC-6 的真实验收由非实现方在目标环境
完成，源码测试不能代替。
