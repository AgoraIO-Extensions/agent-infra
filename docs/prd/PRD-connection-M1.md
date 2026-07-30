# Connection M1 产品需求

关联文档：[企业级 Agent 平台 M1 产品需求](PRD-agent-platform-M1.md)

## 1. 产品目标

Connection 是与 Agent 平台并行建设的独立系统。它让员工连接自己的外部账号，或使用获准的公司共享账号，并将该连接授权给指定 Agent。

M1 需要保证：

1. Agent 可以使用外部平台提供的 API，但不能获得外部账号凭证。
2. Agent Owner 决定 Agent 可以使用哪些外部能力。
3. 使用者决定是否把自己的 Connection 授权给某个 Agent。
4. 不同用户和不同 Agent 的授权相互隔离。
5. 至少一个真实外部平台完成连接、授权、调用和撤销授权的完整闭环。

## 2. 核心概念

| 概念 | 产品含义 |
| --- | --- |
| Provider | Jira、GitHub、Outlook 等外部平台 |
| Action | Provider 向 Agent 提供的一项具体能力 |
| Connection | 已完成鉴权的外部账号或服务 |
| Agent 授权 | 用户允许某个 Agent 使用某个 Connection |

Agent Owner 选择 Provider 和 Action，不绑定普通使用者的外部账号。使用者为具体 Agent 选择自己的 Connection，或自己有权使用的公司共享 Connection。Agent 不能代替使用者选择其他外部账号。

### 2.1 管理角色

Connection 系统使用与 Agent 平台相同的系统管理员角色。系统管理员负责发布或停用 Provider 和 Action、配置公司共享 Connection，并查看 Connection 调用审计。普通 Agent Owner 只能从已发布目录中为自己的 Agent 选择 Action。

## 3. 系统边界

### 3.1 Connection 系统负责

- Provider 和 Action 目录。
- OAuth、API Key 等鉴权方式及凭证刷新。
- 外部凭证的加密保存。
- 外部账号识别、脱敏展示和连接状态。
- 个人 Connection 和公司共享 Connection 的管理。
- Action 的参数、返回结果和外部 API 调用。
- Connection 使用过程中的权限校验和审计。

### 3.2 Agent 平台负责

- 维护公司用户、组织、Agent Owner 和 Agent 可用范围。
- 让 Agent Owner 选择已经发布的 Action。
- 保存用户对具体 Agent 和 Connection 的授权关系。
- 在 Agent 对话中展示 Connection 入口和连接状态。
- 把当前用户身份和有效授权传给 Connection 系统。

### 3.3 Agent 负责

- 根据任务选择已配置的 Action 并提交参数。
- 使用 Connection 返回的结果继续完成任务。
- 不保存或读取 Connection 的原始凭证。

## 4. OpenConnector 参考范围

M1 的 Provider、Action、鉴权和执行模型参考 [OpenConnector](https://github.com/oomol-lab/open-connector)。OpenConnector 不是公司用户、组织和 Agent 授权的权威来源，也不能仅凭多个命名 Connection 满足公司多用户隔离要求。

本 PRD 中的授权和隔离要求是 M1 的产品规范。外部项目及其讨论只作为设计参考，不作为验收依据。具体采用、适配或扩展方式，以及内部令牌、存储字段和接口格式，均不在本 PRD 规定。

## 5. Provider 与 Action

- Connection 系统是 Provider 和 Action 的唯一目录来源。
- Agent 平台自动使用已经发布的目录，不重复登记或审批 Action。
- Agent Owner 只能选择已发布的 Action，不能填写任意 URL、请求模板或自定义凭证。
- Action 至少展示名称、用途说明、参数、返回结果和所需外部权限。
- Provider 或 Action 被停用后，Agent 立即停止使用该能力，并在下次使用时向用户说明不可用原因。M1 不发送主动通知。
- Action 的用途、参数、返回结果或所需外部权限发生实质变化时，系统管理员必须重新发布，Agent Owner 必须重新选择，不能静默覆盖已经配置的 Action。
- M1 至少接入一个真实 Provider。该 Provider 下的 Action 必须完成实际调用，不以模拟结果代替验收。

## 6. Connection 类型

### 6.1 个人 Connection

- 由员工本人完成授权。
- 只能由本人发现和使用。
- 不能分享、转赠或转换为公司共享 Connection。
- 公司账号被禁用后，该员工的个人 Connection 和 Agent 授权立即停止使用，不能转让给其他员工。

### 6.2 公司共享 Connection

- 由系统管理员配置，并限定可使用的员工或公司组织。
- 获得使用权的员工仍需决定是否授权给某个 Agent。
- 共享范围不等于 Agent 授权，系统不能替用户自动授权。
- 公司共享 Connection 的可用范围按当前公司账号和组织成员关系判断。权限来自公司组织时，员工调岗或退出该组织后立即失去由该组织获得的权限；直接指定给员工的权限只在该员工被移出共享范围后失效。账号被禁用后不能再发起新调用。

### 6.3 多账号

- 同一个 Provider 可以建立多个 Connection。
- 每个 Connection 都有稳定的内部标识。
- Connection 名称只用于展示和选择，不能作为权限判断依据。

## 7. 连接与授权

### 7.1 连接管理

- 用户可以在个人设置中连接、重连和断开个人 Connection。
- 页面展示 Provider、外部账号名称、组织或脱敏标识以及连接状态。
- Agent 需要 Connection 而用户尚未连接时，对话中提供连接入口。
- 用户完成授权后返回原对话继续使用。
- 断开 Connection 后，已有 Agent 授权进入暂停状态。用户重连同一个外部账号后，原授权恢复；重连为不同外部账号时，原授权失效，用户必须重新授权 Agent。

### 7.2 Agent 授权

- 授权关系以 Agent 和 Connection 为单位，不为每个 Action 建立独立授权；授权只覆盖用户最近一次确认时展示的 Action。
- Agent 只能调用 Owner 已配置且 Connection 系统仍允许的 Action。
- 授权界面必须同时展示 Agent、Connection 对应的外部账号，以及当前 Agent 已配置的 Action 和所需外部权限，避免选错账号或能力范围。
- M1 中，同一用户为同一个 Agent 和 Provider 只能设置一个当前 Connection。用户选择另一个账号时，产品必须明确提示将替换当前账号；Agent 不能自行选择默认账号或在多个账号之间切换。
- Owner 新增 Action 后，已有授权只继续覆盖用户上次确认过的 Action。用户确认更新后的能力范围前，Agent 不能代表该用户调用新增 Action；移除 Action 则立即生效。
- Agent 首次需要尚未确认的新增 Action 时，对话中提供确认入口。用户确认后返回原对话继续任务；拒绝或关闭确认时，不执行该 Action。
- 用户可以查看自己授权给各 Agent 的 Connection，并单独撤销其中一项授权。
- 撤销只影响对应 Agent，不影响其他 Agent 对同一个 Connection 的独立授权。
- 用户断开 Connection 后，依赖该 Connection 的所有 Agent 都不能继续发起新调用。
- 断开或撤销不会回滚已经提交给外部平台的操作，产品保留实际完成或失败结果。
- Agent 授权不设置独立期限。用户撤销、重连为不同外部账号、账号被禁用或共享范围失效时，授权终止；Connection 断开或外部凭证失效时，授权只暂停，重连规则按 7.1 执行。

## 8. 用户隔离

用户只能发现和使用本人或明确授权范围内的 Connection。

Agent 使用 Connection 时，平台必须根据当前公司用户对该 Agent 的有效授权，由服务端解析并校验目标 Connection。当前用户、授权关系和目标外部账号不能由 Agent 或调用方提交、替换或覆盖。任何跨用户或跨授权范围的访问都必须被拒绝，且不能泄露目标 Connection 是否存在。

修改 Connection 名称、标识或请求参数，不能让用户访问未授权的 Connection。OAuth 完成后，外部账号必须归属于发起授权的用户或公司共享范围，授权回调不能改变该归属。

## 9. 凭证保护与 Action 执行

- Agent、模型上下文、Agent 使用的 Sandbox 或其他执行环境、页面和审计导出都不能获得 Provider Access Token、Refresh Token、API Key 或其他原始凭证。
- Agent 只提交 Action 和参数。
- Connection 系统解析目标外部账号、注入凭证并调用 Provider API。

## 10. 错误与审计

- Connection 失效时，产品说明原因并提供重连入口。
- Provider 拒绝、外部权限不足或 Action 不可用时，产品展示对应原因和可执行的下一步。
- Provider 限流或暂时不可用时，产品明确提示稍后重试，不能表现为 Agent 无响应。
- 用户可以在对应会话的执行详情和 Connection 调用记录中查看本人实际使用的 Provider、外部账号名称、组织或脱敏标识、Action、时间、状态、结果和错误信息。该记录来自 Connection 系统，不能只依赖 Agent 自行描述。
- 审计覆盖 Connection 的连接、重连和断开，Agent 授权、更新确认和撤销，Provider 与 Action 变更，以及每次 Action 调用。
- 审计能够回答谁通过哪个 Agent、使用哪个 Connection、执行了哪个 Action，以及执行时间、状态和脱敏结果摘要。Agent 平台与 Connection 系统的记录必须能够关联同一次调用。
- 普通用户只能查看自己的 Connection 和调用记录；系统管理员可以查看全部 Connection 审计，但不能通过审计查看普通用户的原始会话内容。Agent Owner 不能通过 Connection 审计查看其他用户的调用记录、原始会话内容或原始凭证。
- 审计和错误信息不能包含原始凭证，也不能泄露其他用户的 Connection 是否存在。
- 审计保留遵循公司现有数据政策，M1 不单独设置保留期限或普通用户导出能力。

## 11. 页面与入口

Connection 系统在 M1 提供以下页面，并从 Agent 平台相关位置进入：

- 我的 Connection：连接、重连、断开和查看个人 Connection。
- Agent 授权：查看每个 Agent 当前使用的 Connection、确认新增 Action、切换账号和撤销授权。
- 调用记录：普通用户查看自己的 Connection Action 调用。
- Provider 与 Action 管理：系统管理员发布、更新和停用目录能力。
- 公司共享 Connection 管理：系统管理员配置账号及员工或组织可用范围。
- Connection 审计：系统管理员查询连接、授权和调用记录。

## 12. 上线验收

| 场景 | 验收结果 |
| --- | --- |
| 连接个人账号 | 用户可以完成连接、凭证刷新、重连和断开，并在授权后返回原 Agent 对话 |
| 重连账号 | 重连同一外部账号后原授权恢复；更换外部账号后原授权失效并要求重新授权 |
| 使用公司共享账号 | 只有当前指定员工或组织成员可以发现；使用者仍需单独授权目标 Agent |
| 多账号选择 | 同一用户、Agent 和 Provider 只有一个当前 Connection；更换账号需要用户明确确认 |
| 授权与撤销 | 用户可以授权或撤销某个 Agent；授权界面展示当前 Action；其他 Agent 的独立授权不受影响 |
| Action 变更 | Owner 新增 Action 后，已有用户必须确认才能使用新增能力；移除或停用立即生效 |
| 执行 Action | 至少一个真实 Provider 完成真实 API 调用，Agent 只能使用 Owner 已配置且当前用户已确认的 Action |
| 调用详情 | 用户可以看到本人实际使用的 Provider、脱敏账号、Action、时间、状态、结果和错误 |
| 多用户隔离 | 修改名称、标识、参数、用户或目标账号都不能访问其他用户的 Connection，也不能判断其是否存在 |
| 断开连接 | 后续调用立即被拒绝，授权暂停，已提交操作保留实际结果 |
| Provider 与 Action 停用 | 后续调用立即停止，并在用户下次使用时明确说明原因 |
| 凭证保护 | Agent、模型、Sandbox、页面和审计均无法读取原始凭证 |
