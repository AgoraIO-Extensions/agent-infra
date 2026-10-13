# Connection 使用说明书

本说明与 Connection Web 共用一份内容，适用于 Connection 的当前产品流程。实际能力以部署发布目录及客户端验收为准。

## 01 · 从这里开始

登录、连接外部账号、确认客户端授权，是三个独立步骤。

### Connection 是什么

Connection 负责外部账号、Provider Credential、Consumer 授权和外部 Action 调用。Codex、其他 MCP Client、Agent Platform 和内部服务都可以使用它；使用 Direct MCP 不需要先创建平台 Agent。

Provider 是外部服务，Action 是一项受控能力，Connection 是已连接的具体外部账号，Consumer 是使用能力的客户端或服务。公司登录、Provider 连接、Consumer 授权分别完成，任何一步成功都不等于其他步骤已完成。

### 完成第一次只读调用

1. 打开团队提供的 Connection HTTPS 地址，登录控制台并确认公司身份。
2. 在“我的 Connection”选择目标服务。连接器默认关闭公司审批，可直接连接；仅管理员开启审批的服务需要先申请接入资格。
3. 完成必要审批后，连接自己的外部账号并核对返回的账号名称。
4. 选择客户端 Consumer 与当前账号，勾选所需 Action，阅读预览后确认授权。
5. 按对应客户端的安装说明配置 Connection MCP，完成 OAuth 登录或引用获准 PAT。
6. 在客户端重新发现能力，先用已授权的只读 Action 核对账号和实际结果。

### 完成标志

控制台账号连接有效，目标 Consumer 已获得明确的 Action 授权，客户端返回真实只读结果。模型自报“连接成功”、目录出现服务名或浏览器登录成功都不能替代这三个条件。

## 02 · 控制台与登录

公司身份用于 Connection Account，外部服务凭证另行管理。

### 登录与退出

访问 /connection/login，使用部署提供的公司 LDAP 登录。密码只用于当次认证，不保存、不进入 MCP 配置或模型上下文。退出浏览器管理会话与撤销客户端实例是不同操作；需要终止客户端调用时，还要撤销相应实例、PAT 或授权。

### 找到自己的入口

“我的 Connection”管理账号与 Consumer 授权；“待我审批”处理分配给你的审批任务；“访问令牌”签发和撤销 PAT。通知与待办汇总待审批、续期和升级事项，不把通知已读当作审批完成。

管理员另有审批管理、操作记录、Agent 接入、共享 Connection 和管理员入口。角色只授予管理职责，不自动赋予共享账号使用资格、审批通过权或他人的调用内容权限。

## 03 · 服务目录与外部账号

按当前发布的 Provider、认证方式与能力选择服务。

### 选择正确服务

目录由 Connection 发布，具体可用 Provider、版本、Action 和认证入口以当前控制台为准。同品牌的不同 Jenkins 等部署可能是独立 Provider，必须核对目标环境，不按名称猜测 endpoint。

Connection 提供多服务接入，支持范围以当前发布目录为准，不按单一示例服务推断其他能力。目录展示不代表所有 Action、账号或客户端已完成真实验收。

### 连接自己的账号

1. 进入“我的 Connection”，选定服务及能力范围。
2. 审批关闭时直接连接自己的账号；审批开启且页面提示资格不足时，先按下一章完成接入审批，再提交外部 Credential。
3. 使用页面实际提供的 OAuth、PAT/API Key 或账号密码表单。
4. OAuth 时核对目标服务和授权范围；手工凭证只填专用表单，不粘贴到聊天或 MCP 工具参数。
5. 回到控制台检查外部账号标识、连接状态及能力范围，再授权 Consumer。

### 认证方式的区别

GitHub 等 OAuth 服务通过提供方页面完成连接；Bitbucket 等可使用 Provider PAT；Jira/Confluence 的 Provider 账号凭证与公司 LDAP 登录分别处理。以该服务当前表单和说明为准，不能在不同 Provider 间复用另一套鉴权配置。

Provider PAT 属于外部服务 Credential，Connection PAT 属于客户端访问令牌，两者不可互换。凭证验证成功仍不自动授权任何 Consumer。

## 04 · 按连接器审批与续期

默认直接连接；仅开启审批的连接器要求公司准入资格。

### 先确认是否需要审批

现有及新增连接器默认关闭公司审批。关闭时可直接绑定自己的外部账号，不需要提交审批申请；Provider 身份验证和 Consumer/Action 授权仍须分别完成。共享账号的使用资格另行管理。

管理员在“审批管理”的连接器审批开关中按服务开启或关闭。开启后，已有直连账号若无有效审批资格也无法发起新调用；请按页面提示申请资格。关闭保留历史记录，旧审批资格到期不再单独阻止新调用；重新开启后，已过期资格不能继续使用。关闭不自动恢复已暂停或撤销的客户端授权，也不扩大账号权限或已选择的 Action。

### 开启审批后，申请前查看范围

管理员为 Provider 能力配置审批策略、能力包、顺序阶段、通过人数、有效期和免责声明。用户选择当前发布的能力范围并阅读说明；能力包修订不会将旧版批准自动扩张到新版本。

### 开启审批后，从申请到连接

1. 在服务的接入入口选择能力包并提交申请。
2. 在申请详情查看每个阶段的状态；审批人从“待我审批”处理任务。
3. 等待全部必要阶段通过，再进入允许的连接入口。
4. 完成 Provider 鉴权并连接指定账号；连接许可只能成功创建一个外部账号 Connection。
5. 另行选择 Consumer 和 Action 并确认授权。

### 资格到期与重新审批

开启审批的连接器，其有限期资格按页面提示在允许的续期窗口申请。续期待审期间原期限照常生效，过期后新调用停止；审批提前通过不损失原剩余时间。换号、能力范围变化、资格失效等按当前策略重新处理。

管理员身份不自动产生审批通过权；员工不能自行审批自己的接入申请。审批通过不是外部账号身份验证，也不会建立 Consumer Grant。

## 05 · Consumer 与 Action 授权

明确选择谁可以使用哪个账号，以及允许执行哪些操作。

### 确认授权

1. 在 Connection 卡片进入授权操作，选定目标 Consumer；Delegated Consumer 要求 Actor 时选择已注册的实际 Actor。
2. 核对 Provider、外部账号、Connection、Action 版本、参数说明、scope 和外部效果。
3. 只勾选本次需要的能力，检查搜索或筛选后的选中范围。
4. 获取并阅读授权预览；信息或权限范围变化时重新预览。
5. 明确确认后保存，再让客户端重新发现可用能力。

### 授权的边界

Consumer 管理者声明产品需要的 Action，但不能替你选择账号或扩大授权。Direct Consumer 不使用 Actor；需要 Actor 的 Delegated Consumer 必须携带获准的稳定 Actor，不能缺省回退。

客户端只看到当前授权允许的能力。新增 Action 或 Action 定义中的所需 scope、effect 扩张必须重新确认；取消确认不会扩权。停用、撤回或 Connection 内授权范围收缩立即影响新调用。外部权限由目标系统判断，不改变已确认能力。调整 Action 子集通常不需要重新签发客户端 PAT。

## 06 · 个人、共享与多个账号

每个客户端只使用你为它明确选择的当前账号。

### 个人与共享 Connection

个人 Connection 属于当前员工。公司共享 Connection 由管理员配置共享账号及使用资格；进入共享范围不等于已授权 Consumer，符合资格的员工仍需独立确认。

普通管理员身份不自动获得共享账号使用资格，Owner 或其他用户的个人账号不能作为你的默认后备身份。

### 同一服务的多个账号

可以同时保存个人与公司等多个外部账号。一个 Consumer/Actor 在同一 Provider 下只使用已确认的当前 Connection，不存在调用方指定账号或自动轮询账号的规则。

切换前核对账号、范围和将受影响的 Consumer；切换必须由本人明确确认，不能因鉴权失败静默使用另一账号。断开某个账号前检查它关联的客户端授权。

## 07 · 安装到 Codex

Codex 专用安装说明保持独立。

### 使用专用入口

打开 /connection/，按该页面及根 /llms.txt 的 Codex 专用说明安装。不要把通用 Agent SDK 接入说明混入 Codex 的机器安装指令。

### OAuth 配置示例

以部署公布的真实 HTTPS 地址替换下面示例域名；配置本地 Codex 的 Connection MCP server 后启动 OAuth 登录。公司密码只提交到 Connection 浏览器入口，不进入 Codex 配置。

```toml
[mcp_servers.connection]
url = "https://connection.example.com/mcp"
```

### 登录并核验

运行 codex mcp login connection，完成浏览器登录及授权。回到 Codex 后读取当前可用能力并先执行无副作用的账号查询；缺少服务或权限时回到控制台处理，而不是传入自报身份字段。

```bash
codex mcp login connection
```

### 兼容性

只使用部署批准并验证的客户端版本。OAuth 刷新、重放拒绝、撤销和多设备行为必须按实际版本验证；某一客户端通过不代表其他产品已兼容。

## 08 · 跨设备与登录实例

同一账号共享已连接的 Provider 和同一 Consumer 的授权。

### 第二台设备

在第二台设备配置相同 Connection endpoint，并通过其独立 OAuth 登录实例认证为同一员工。已存在的个人 Connection 和该 Direct Consumer 的 Grant 可以复用，不重复做 Provider OAuth或逐设备重新确认。

每台安装仍有独立 ConsumerInstance，不共享 session 或 refresh token。设备退出或实例撤销只终止该实例，不取消其他活跃实例使用已有 Grant 的资格。

### 产品与实例不要混淆

Codex、Claude App、Cursor 等产品是独立 Consumer，不能把一个产品的 OAuth 会话导入另一个产品。换设备共享账号并不自动授权另一个 Consumer；在新产品下仍须明确确认它的能力。

## 09 · Connection PAT

一次性展示的客户端令牌，与 Provider 凭证不同。

### 签发与保存

1. 先登录 Connection 控制台，进入“访问令牌”。
2. 按当前页面提供的获准 Consumer 与有效期选项，为令牌取能识别用途的名称。
3. 签发后立即保存到客户端受控环境变量或 Secret Manager，明文只展示一次。
4. 为该 PAT 的 Consumer 配置实际账号和 Action 授权。
5. 先做只读验证，不再使用时在访问令牌页面撤销。

### 通用与具名 PAT

通用 PAT 使用内建 Portable PAT Consumer；获准的具名 MCP Consumer 可以通过固定回调和单次领取流程绑定自己的 PAT。调用方自报产品名称或 Consumer ID 不会改变身份。

具名客户端可不提供预期邮箱，由用户登录 Connection 后确认关联当前账号；若客户端提供预期邮箱，则必须一致。确认页展示账号及将交付客户端后端的用户标识、邮箱和显示名，Token 只交付后端。业务系统必须隔离各用户的 Token，已有连接无需重新绑定。

同一枚 PAT 可以部署到多个消费端，但它们共享同一个撤销和审计边界；需要逐端独立撤销或追溯时分别签发命名 PAT。PAT 不包含外部账号原始 Credential。

### 配置示例

只引用环境变量，不将明文写入版本库、聊天、日志或 URL。下面域名需替换为实际部署地址。

```toml
[mcp_servers.connection]
url = "https://connection.example.com/mcp"
bearer_token_env_var = "CONNECTION_TOKEN"
```

## 10 · 通用 Agent 与五个 MCP 工具

Agent 的 MCP 接入和多用户平台的 Delegated 接入分别处理。

### 通用 Agent

打开 /connection/agent/ 及 /connection/agent/llms.txt。使用支持 Streamable HTTP 的 MCP 客户端连接 /mcp；支持 remote OAuth 时按 PKCE 登录，否则引用用户签发的获准 Connection PAT。

MCP 客户端初始化后使用 tools/list 读取实际工具 Schema，不猜 Action ID，不传入 Provider Credential 或 Principal/Consumer/账号选择器。

### 发现到执行

1. list_apps：发现当前可用 Provider。
2. list_connections：核对当前可用账号及安全信息。
3. search_actions：搜索本次需要的 Action。
4. get_action_guide：阅读参数、结果、scope、effect 和幂等要求。
5. execute_action：使用实际 Schema 和 guide 执行，检查返回结果。

### 多用户服务与 Delegated

Portable PAT 的 MCP 调用属于 Direct。代表当前用户调用的多用户平台须与管理员完成 Delegated HTTP/OpenAPI 接入，包括受信 workload 身份、短期委托上下文及必要 Actor。

Agent Platform 要求稳定 Agent Actor，不能用共享 PAT、Owner 身份、自报用户 ID 或 MCP URL 拼出 Delegated 身份和接口。委托上下文只证明请求主体，不自动建立或扩张授权。

## 11 · 升级、重连与凭证轮换

保留已有选择，明确确认变化。

### Provider 升级

查看控制台升级任务中的版本、兼容性、认证变化和 Action 差异。能证明相同账号与相同 scope 的已保存 Credential 可以复用；不要仅因版本更新就重新输入只展示一次的 Token。

原 Action 选择应保留在有明确兼容性证明的范围内；新增或扩大能力必须由本人确认。Token 失效、认证方式不兼容、换号和主动轮换时，按任务提示重新鉴权。

### 新增能力与账号恢复

连接器发布新增能力后，旧客户端授权保留原来的选择，不自动扩权。客户端旁的新增能力提示比较当前目录与上次确认授权所对应的发布目录；以前未选的旧能力不会反复提示为新增，新增项也不代表已满足账号权限、客户端声明或审批条件。

“管理能力”的候选列表由当前目录、客户端配置和公司审批范围决定，不按外部 scope 快照过滤。确认能力表示允许客户端使用，不保证外部系统已授予实际权限；权限不足只影响对应操作，其他已确认能力仍可用，外部权限恢复无需重复客户端确认。正常账号不显示“更新账号权限”按钮。系统判定需要升级或重连时才显示对应操作；兼容升级复用已有凭据，只有凭据失效、需要 OAuth 或无法复验时才要求更新凭据。账号或原能力语义改变仍需处理受影响授权；不同外部账号不能继承原授权。开启审批的连接器仍按审批流程处理；共享账号由管理员更新。

核对账号，在目标客户端的“管理能力”中选择需要的新增 Action，阅读授权预览并确认，再让客户端重新发现工具。此过程不要求断开原连接，也不自动勾选或批准新增能力。

### 重连与换号

重连时核对外部稳定账号标识。连接到不同外部账号不是原账号的透明重连，不能将旧 Grant 静默带给新账号。换号前检查受影响的 Consumer 并重新确认。

Credential refresh/rotation 和 Consumer 访问 token 是不同生命周期。客户端失去 OAuth 登录资格不一定需要重新连接 Provider；先按错误说明检查实例、授权与账号。

## 12 · 写操作、结果未知与撤销

写入前确认效果，超时后先核实原调用。

### 执行写操作

先确认目标账号、仓库或对象、参数、Action 版本与外部效果。用户要求“分析”不等于允许发布、删除或合并。写 Action 必须由客户端生成并保留跨重试稳定的 idempotencyKey，不能使用每次变化的传输请求 ID。未通过稳定幂等键验收的客户端版本只能调用只读 Action。同一业务操作重试不换新的幂等键。

### 结果未知

1. 看到 UNCERTAIN、超时或断连时保留原调用编号和幂等信息。
2. 回读原调用状态并检查目标系统实际结果，例如 PR 是否已存在。
3. 核实前不重复创建、不用新幂等键重放，也不把查询失败当作没有产生效果。
4. 需要人工对账时由获准人员处理，再依据确认结果继续。

### 撤销的层次

撤销某个 Consumer/Actor 的 Grant 只影响目标授权；撤销设备实例只影响该实例；撤销 PAT 影响复用该枚令牌的全部消费端；断开 Connection 影响依赖该账号的调用。

撤权阻止新的调用，不把已经派发的外部操作撤销或自动回滚。若用户实际 scope 已被外部服务扩大或凭证失效，按服务提示修复，不静默绕过。

## 13 · 管理员与操作记录

目录、审批、Consumer、共享账号分别治理。

### 管理员职责

“审批管理”顶部的“连接器审批设置”默认收起；展开后可搜索连接器、按审批状态筛选并分页查看，每页 15 条。该页面按连接器配置审批开关（默认关闭），并维护已发布的能力包、免责声明、审批策略和资格；“Agent 接入”管理获准 Consumer、实例、声明与固定回调；“共享 Connection”维护账号和员工资格；“管理员”管理角色。

管理员不凭角色取得其他用户账号或共享 Connection 使用资格，也不能替普通用户选择外部账号、授权或完成公司审批。

配置公司 OAuth 身份探测后，已登录的管理员可打开 /api/v1/connection/identity/oauth/probe，点击“开始公司 OAuth 身份探测”，完成公司登录，再点击“完成身份探测”。结果仅显示字段类型与当前 LDAP 标识的比较结论，不显示身份原值或 token；这不会修改账号、授权或登录方式。失败、过期或已消费时重新发起；该流程只用于管理员诊断，普通用户和 MCP 客户端无需执行。

### 查询与审计

“操作记录”按当前身份和获准范围展示调用状态、效果与关联信息。普通用户只能访问自己的获准记录，管理员按独立的审计权限查询。记录不公开 Provider Credential、PAT、LDAP 密码或普通会话正文。

查询失败时保留脱敏错误码、调用 ID、时间与服务信息。不能以另一条成功调用证明本次成功，也不能用控制台页面可见性替代服务端授权。

## 14 · 排障与安全使用

按身份、账号、资格、Consumer 授权和调用结果逐层检查。

### 常见排查顺序

1. 无法登录：核对公司账号、公开 HTTPS 入口及认证服务提示。
2. 服务不可用：核对发布状态、实际 Provider deployment 与目录提示。
3. 不能连接：检查前置申请、资格有效期、能力包和 Provider 鉴权。
4. 客户端没有能力：确认当前 Consumer、账号和 Action Grant，不把登录成功当作已授权。若提示客户端尚未配置所需能力，请联系 Connection 管理员申请开通。管理员在“Agent 接入”注册后直接配置能力，也可点击“配置能力”查看和修改已保存的 Provider 与 Actions；该配置不会直接获得用户账号授权。
5. 第二台设备重复登录失败：区分实例认证与 Provider 账号；不要拷贝 refresh token。
6. PAT 不可用：检查期限、撤销状态、对应 Consumer 和 Action 授权。
7. 升级或重连失败：核对账号是否变化、scope、Credential 状态和任务要求。
8. 写入超时：先回读原调用并对账，不盲目重复执行。

### 反馈问题

提供时间、页面、Provider、客户端版本、脱敏错误码及调用或申请 ID。不要发送密码、Cookie、PAT、OAuth token、Provider Credential 或完整私密会话。

本指南说明 Connection 的产品流程；实际开放能力及客户端兼容性以当前部署目录与验收为准。正式规则见 Connection PRD 和 Connection HLD，运行与发布见 Connection 生产部署说明。

## 15 · GitHub 接入

通过 GitHub OAuth 连接自己的账号，不需要手工创建 PAT。

### GitHub · 账号与入口

先确认能用自己的 GitHub 账号访问 <https://github.com/> 的目标仓库。组织仓库还受组织成员、SSO 和应用访问策略限制。

### GitHub · 连接步骤

1. 在 GitHub 连接入口检查公司审批是否启用；若启用，先申请并等待通过。
2. 点击连接账号，前往 GitHub OAuth 页面，核对账号、应用与授权范围后确认。无需在 Connection 填写 GitHub 密码或 PAT。
3. 返回 Connection 核对外部账号，再选择 Consumer、Action 并确认授权。

### GitHub · 验证与常见问题

先调用 github.get_current_user，确认是自己的账号，再读取有权限的仓库。OAuth 成功不等于能访问所有组织仓库；仓库 403/404 时检查 GitHub 权限、组织 SSO 和应用策略。连接失败与某个仓库不可见是不同问题。

### GitHub · 读取 Actions Job 日志

当前目录发布日志能力后，可在“我的 Connection”的 GitHub 账号中，为目标 Consumer 勾选 github.get_workflow_job_logs 并确认。原有授权不会自动获得日志能力；只有页面提示需要升级或重连时才处理对应入口。公司审批开启且原批准范围未包含日志时，先申请包含日志的能力范围。

先用 github.list_workflow_run_jobs 找到目标 Run 中的 Job ID，再调用 github.get_workflow_job_logs，提交 owner、repo、jobId。startLine 从 1 开始，maxLines 默认 200、最多 1000；每页正文最多 64 KiB。

有 nextStartLine 时用该值继续读取。truncated 表示未完整返回；lineTruncated 表示超长行只返回前缀，继续读取会跳过该行剩余部分。scanLimitReached 表示达到单次 8 MiB 扫描上限；nextStartLine 为空时，剩余日志请到 GitHub Actions 页面查看，不要将当前结果当作完整日志。

日志仅读取，不会重跑或停止 Job。403/404 时检查仓库权限、组织 SSO、日志是否已生成或已过期；超时稍后重新读取，不要因此触发构建。日志正文不额外脱敏，会进入已授权客户端或模型上下文，请仅授权适合交给该客户端分析的构建日志。

## 16 · Bitbucket 接入

使用公司 Bitbucket Server 的个人访问令牌。

### Bitbucket · 获取凭据

登录 <https://bitbucket.agoralab.co/> ，打开头像下的个人账户设置，在 Personal access tokens 中创建个人 Token。按需要的仓库读取/写入范围及有效期选择权限；没有该入口时联系 Bitbucket 管理员，不使用 SSH 私钥代替 Token。

### Bitbucket · 连接步骤

1. 进入 Bitbucket 连接入口；公司审批启用时先取得所需能力的资格。
2. 将自己的个人 Token 填入 Bitbucket 专用表单，提交后检查返回的账号。不要填写公司密码或 Connection PAT。
3. 选择 Consumer 和所需 Action，预览并确认授权。

### Bitbucket · 验证与权限

先调用 bitbucket.get_current_user，再读取自己有权限的仓库。Token 权限、仓库权限与 Connection Action 授权共同限制实际操作；Token 可读不代表能创建或合并 PR。401 检查 Token 到期/撤销，403 检查 Token 范围和仓库权限。

## 17 · Jira 接入

当前公司 Jira Server 使用 Jira 用户名和密码，不是 Atlassian Cloud API Token。

### Jira · 账号准备

先在 <https://jira.agoralab.co/> 确认自己的 Jira 账号可登录、能查看目标项目。Connection 登录与 Jira 鉴权分开；用户名表单的默认邮箱仍需核对是否是实际 Jira 用户名。

### Jira · 连接步骤

1. 进入 Jira 连接入口，按页面完成公司审批（若启用）。
2. 在 Jira 专用表单填写 Jira 用户名和密码。凭据由 Connection 加密保存，只在网页提交，不发送给 AI。
3. 核对外部账号，选择 Consumer 与需要的 Action，确认授权。

### Jira · 验证与权限

先调用 jira.get_current_user，再查看有权限的项目或 Issue。项目浏览、编辑、评论和工作流流转权限仍由 Jira 控制。浏览器已登录但连接失败时，检查实际账号密码及 Jira 认证限制；不要用 Cloud Token 或 Bitbucket PAT 替代密码。

## 18 · Confluence 接入

使用公司 Confluence Server 的用户名和密码，空间权限仍由 Confluence 控制。

### Confluence · 账号准备

先在 <https://confluence.agoralab.co/> 确认自己的账号能登录并打开目标空间/页面。此接入不是 Atlassian Cloud OAuth 或 Cloud API Token。

### Confluence · 连接步骤

1. 进入 Confluence 连接入口，公司审批启用时先完成申请。
2. 在专用表单填写 Confluence 用户名和密码，核对默认用户名；凭据只在 Connection 页面提交并加密保存。
3. 核对外部账号，再为 Consumer 选择、确认所需 Action。

### Confluence · 验证与权限

先调用 confluence.get_current_user，再读取自己能访问的页面。连接成功不会授予空间或页面编辑权限。403/404 可能来自空间权限或页面限制；修改前需要当前页面信息和对应编辑权限。

## 19 · Jenkins CI 接入

使用 CI 部署中的 Jenkins 用户名与个人 API Token。

### Jenkins CI · 获取 API Token

打开公司 Jenkins CI 入口，核对目标为 Jenkins CI（服务入口 <https://jenkins-ci.agoralab.co/>）。点击自己的用户进入配置，在 API Token 中创建具名 Token；入口不可用或没有生成权限时联系该部署管理员。这里需要 API Token，不是公司密码。

### Jenkins CI · 连接步骤

1. 在 Connection 选择 Jenkins CI；不要误选 Jenkins Release。公司审批启用时先完成申请。
2. 填写该 CI 部署中的实际 Jenkins 用户名和个人 API Token，不提交服务 URL 或其他部署的凭据。
3. 验证账号后选择 Consumer 和所需 Action，确认授权。

### Jenkins CI · 首次验证与排障

先调用 jenkins-ci.get_current_user，再用 list_jobs 查看获准 Job。目录读取不会启动构建。Job 权限仍由 Jenkins 控制；网关 IP restriction/403 可能是服务出口限制，不要因此反复更换个人 Token。

## 20 · Jenkins Release 接入

Release 与 CI 是两个独立部署，分别取得凭据和授权。

### Jenkins Release · 获取 API Token

从团队提供的 Jenkins Release 入口登录自己的账号；没有入口时联系 Release 管理员取得该部署地址。点击自己的用户进入配置，在 API Token 中创建具名 Token。不要在不受信任的地址填写凭据，也不要假定 CI Token 可跨部署使用。

### Jenkins Release · 连接步骤

1. 在 Connection 选择 Jenkins Release，检查并完成该部署的公司审批（若启用）。
2. 填写 Release 部署的 Jenkins 用户名和 API Token；接口目标由 Connection 固定，不需要自己输入地址。
3. 核对账号，为 Consumer 单独选择 Release Action 并确认授权。

### Jenkins Release · 首次验证与排障

先调用 jenkins-release.get_current_user，再用 list_jobs 查看获准 Job，不触发构建或发布。Release Job 的读取/执行权限与 CI 分开；连接成功不代表能发布。认证失败检查部署、用户名和 Token；网关拒绝则交由服务管理员排查出口。

## 21 · Rehoboam 接入

从自己的 Rehoboam Security 页面取得个人 PAT。

### Rehoboam · 获取凭据

登录 <https://justinia.gz3.agoralab.co/> ，在个人 Security 页面创建 PAT。基础发现使用 metadata:read；发布写操作需要 release:write，其他操作按页面范围选择。只选择实际需要的权限，不使用机器 API Key 或其他人的 PAT。

### Rehoboam · 连接步骤

1. 选择 Rehoboam，按页面要求完成公司审批（若启用）。
2. 把个人 PAT 填入 Rehoboam PAT 表单，提交后核对账号；不填写公司密码。
3. 选择 Consumer 和具体 Action，阅读预览后确认。PAT scope 与 Action 授权都需要满足。

### Rehoboam · 首次验证与效果

帮助与对话示例也用于 AI 主动引导。直接用自己的话说明目标即可，AI 应结合真实状态查对应场景、说明下一步并补齐最少缺失信息；不要求先复制模板，也不照搬示例。写操作仍须明确确认，帮助不是执行授权。

先调用 rehoboam.get_current_user，再查询有权限的模板或版本。创建、启动流水线、提测、交付和通知有不同效果；先预览，再明确确认，不能用一次连接授权代替业务操作确认。403 检查 PAT scope、资源角色及 Consumer Action。

发布帮助的对话示例从 Rehoboam 数据库实时读取。管理员先读取文章当前 revision，让 AI 展示完整新版，明确确认后可通过 v17 update_pipeline_help_example 原地保存；网页/AI立即生效，无需重新部署，旧正文保留历史。新增 Action 要明确授权，普通申请人不能越权修改核心示例，但仍可明确加入自己的发版经验。

## 22 · Manhattan 接入

使用公司 OAuth 登录，不再在 Connection 提交公司密码或个人 Token。

### Manhattan · 账号准备

先确认自己的公司账号可以访问 <https://manhattan.agoralab.co/> 。连接使用公司 OAuth 验证个人身份，SDK/Symbol 等资源权限另行判断。

### Manhattan · 连接步骤

1. 选择 Manhattan；若要求公司审批，先按页面申请。
2. 点击连接账号，在公司 OAuth 页面完成登录和授权，返回 Connection；不要填写手工 Token 或共享 Cookie。
3. 核对个人账号，选择 Consumer 和需要的 Action，确认授权。

### Manhattan · 验证与排障

先调用 manhattan.get_current_user。账号验证成功不要求已拥有全部 SDK API 权限，实际 SDK/Symbol 路由可能返回 403。资源权限向 Manhattan 管理员申请；连接回跳失败则按页面检查 OAuth 状态，不重复使用旧 callback 链接。

## 23 · DataLego 接入

通过公司 OAuth 连接个人账号，查询资格与表权限另行检查。

### DataLego · 账号准备

先确认公司账号可以访问 <https://datalego.agoralab.co/> 和目标数据源。当前 DataLego 使用公司 OAuth，不需要手工从 Grafana 复制 Token、Cookie 或密码。

### DataLego · 连接步骤

1. 选择 DataLego，按页面完成公司审批（若启用）。
2. 点击连接，前往公司 OAuth 页面完成个人授权，返回后核对账号。
3. 选择 Consumer 和所需 Action，确认授权；新增能力需要单独确认，不自动进入旧 Grant。

### DataLego · 验证与查询

先调用 datalego.get_current_user。列出表、查看表结构和 SQL 查询会创建查询任务，属于 WRITE，不作为无副作用连接验证。实际表权限仍由数据源控制；查询提交成功不代表任务已完成，需要查询任务状态。OAuth 失效按重连提示处理，表权限不足联系数据 Owner。

## 24 · StaticSpaces 接入

个人 API Token、Connection 授权和空间访问权限是三件不同的事。

### StaticSpaces · 取得自己的个人 API Token

1. 打开 StaticSpaces 门户，用自己的公司账号登录：<https://auth-static-spaces.sh3.agoralab.co/if/user/#/library> 。
2. 进入账号设置的凭据页面：<https://auth-static-spaces.sh3.agoralab.co/if/user/#/settings> 。在 Tokens / App passwords 中创建个人 API Token，intent 选择 API，不使用 App password 或浏览器 Cookie。
3. 为 Token 设置可识别名称和适当有效期，创建后保存到安全位置；只填写 Connection 专用表单，不发送给 AI。找不到创建入口时联系 StaticSpaces 管理员。

### StaticSpaces · 连接并授权

1. 在 StaticSpaces 连接入口选择需要的能力，公司审批启用时先完成申请。
2. 在“个人 Authentik API Token”表单填写自己的 Token；Connection 验证真实外部账号并加密保存凭据，不需要提供公司密码。
3. 核对返回账号，为当前 Consumer 选择 StaticSpaces full 中需要的 Action，预览后确认。升级新增能力时重新按页面完成审批/Consent，旧 Grant 不自动扩权。
4. 先调用 static-spaces.get_current_user，再读取自己可访问空间中的文件，确认实际权限。

### StaticSpaces · 发布到哪里与分享给谁

Connection 不限于 connection-test：user 是个人空间，shared 是指定名称的共享空间，public 是所有已登录用户可读的空间；public 不代表匿名公开。能否创建、发布或删除由 StaticSpaces 中的真实权限决定。

共享文档时让空间 owner/manager 为明确邮箱添加 viewer，权限覆盖整个空间，不能仅凭文章链接获得访问权。目录组授权覆盖该组当前及未来成员。连接凭据或选择 StaticSpaces full 不会自动获得所有空间权限或管理员身份。

阅读使用 API 返回的完整 review_url，或从 StaticSpaces 门户打开获准空间。/spaces/shared/ 根目录没有匹配 ACL 时会显示“Forbidden: no ACL rule matched this path”，不代表所有文章都不可读；当前接口禁止给这个命名空间根开放 ACL。

### StaticSpaces · 常见问题与验证

完整文章链接仍被拒绝：核对浏览器登录账号是否与获准邮箱相同，联系该空间 owner/manager 检查成员资格。管理员 Action 返回 403：当前 Token 对应账号不是 StaticSpaces 管理员，Connection 管理员角色不能替代它。

401 或 Token 到期/撤销：在上游检查个人 Token，再按 Connection 提示重连；普通内容 403 是权限不足，不等于 Token 必然失效。发表评论前读取最新 Markdown SHA；DOCUMENT_CHANGED 时重新读取。写入结果未知时先对账，不换 key 重试。

## 权威文档

- [Connection PRD](../prd/PRD-connection-M1.md)
- [Connection HLD](../architecture/HLD-connection-M1.md)
- [Connection 生产部署](../architecture/connection-production.md)
