# ADR: StaticSpaces 完整 Skill 工作流与统一能力包

## 状态与依据

Accepted。Connection Owner 于 2026-10-12 明确批准 #1927 的 24 项 Action、统一
`StaticSpaces full`、个人 superuser Token 准入及重新审批/Consent 边界，授权实施。
Owner 同日另行批准 [EEP-1834](https://jira.agoralab.co/browse/EEP-1834) 的最小上游回执补充，
仅增加目录组 pk 与门户 pk/slug，不改变输入、权限行为或凭证。
实现追踪为 [#1927](https://github.com/AgoraIO-Extensions/agent-infra/issues/1927)。

依据为 AI/agora-skills 的 main `1c3f22a8409e6438b1389a1c86fe86e93ecc3bbb`：
[Skill](https://bitbucket.agoralab.co/projects/AI/repos/agora-skills/browse/skills/static-spaces/SKILL.md)、
[API](https://bitbucket.agoralab.co/projects/AI/repos/agora-skills/browse/skills/static-spaces/references/api.md)、
[订阅指南](https://bitbucket.agoralab.co/projects/AI/repos/agora-skills/browse/skills/static-spaces/references/subscriptions.md)。
通过 Connection 的提交差异取得完整文件源文本；系统代码核对版本为
`4b9afc47750ae2a8e73f01345745dbe3262d9e1e`。
文档存在不证明线上已部署所有 endpoint；实际验收须逐项标明。
新回执补丁的源码提交为 `3c8dc811dacf09887dfcc6edcb13567d164aaf22`，由
[上游 PR #5](https://bitbucket.agoralab.co/users/luxuhui_agora.io/repos/static-spaces/pull-requests/5)
交付；源码引用不表示已经合并或部署上游。新目录组授权须上游回执字段先部署并验证后才能激活。

## 决策与版本边界

以新的 `static-spaces-connection-v7-full` 和不可变 `@v7` ActionVersion 扩展七项 v6。
统一申请入口继续使用 `StaticSpaces full`；不拆管理员能力包。
每项 Action 仍有独立 Effect、输入/输出 Schema、能力声明和授权交集。
新增 Action 与管理员可用性必须重新公司审批及显式 Consumer Consent，旧 Grant 不自动扩权。
不改写 v1–v6 executor、历史关闭记录、旧审计和未决 Effect。

允许活跃的普通用户及 superuser **个人** Authentik API Token；服务端查询稳定 pk、username
与上游 `is_superuser`。不信任调用方 role/admin/current-user 字段，不使用公司共享管理员凭证。
这显式更新 HLD 3.2.2 中拒绝 superuser 的准入规则，不扩展为 break-glass/internal token。
身份与角色在当前 Credential fence 内验证；管理员能力每次提交前重新验证，最终仍由上游拒绝越权。
非管理员调用 admin Action 必须在提交前拒绝；上游拒绝也不能误作凭证失效。
管理员身份不跳过 Connection 的授权、审批、Consent、审计、egress 和执行保护。

## Agent Action 覆盖矩阵

所有 endpoint 固定在已有 Publish API；identity 使用既有 Authentik `/users/me/`。
表内 Action 前缀均为 `static-spaces.`。共 24 项，其中保留七项，新增 17 项。

| Action | Effect | HTTP endpoint | 权限与范围 |
| --- | --- | --- | --- |
| `get_current_user` | READ | 既有 identity endpoint | 当前已验证账号 |
| `list_files` | READ | GET `/v1/files` | effective path ACL |
| `download_file` | READ | GET `/v1/download-file` | effective path ACL；原 bytes/hash |
| `get_markdown_review` | READ | GET `/v1/markdown-review` | effective path ACL |
| `publish_space` | WRITE | POST `/v1/publish-space` | 本人或空间 owner/manager；首次初始化非原子 |
| `upload_html` | WRITE | POST `/v1/upload-html` | 已初始化空间的写权限 |
| `upload_static_package` | WRITE | POST `/v1/upload-static-package` | 已初始化空间的写权限 |
| `search_directory_groups` | READ | GET `/v1/directory-groups` | 普通用户可用；不返回成员明细 |
| `manage_shared_membership` | WRITE | POST `/v1/shared-memberships` | owner 管全部角色；manager 仅 viewer |
| `manage_shared_group_grant` | WRITE | POST `/v1/shared-group-grants` | owner/manager；仅 directory group viewer |
| `delete_file` | WRITE | POST `/v1/delete-file` | 明确单文件；写权限 |
| `delete_space` | WRITE | POST `/v1/delete-space` | 本人 personal 或 shared/public owner；包含 ACL/组清理 |
| `render_index` | WRITE | POST `/v1/render-index` | 写权限；明确 index 覆盖 |
| `create_markdown_comment` | WRITE | POST `/v1/markdown-review/comments` | 文档可读者；document/selection/thread reply |
| `edit_markdown_comment` | WRITE | PATCH `/v1/markdown-review/comments/{id}` | 本人评论且 latest can_edit |
| `delete_markdown_comment` | WRITE | DELETE `/v1/markdown-review/comments/{id}` | 本人评论且 latest can_delete |
| `admin_find_users` | READ | GET `/v1/users` | 当前上游管理员 |
| `admin_find_groups` | READ | GET `/v1/groups` | 当前上游管理员 |
| `admin_list_acl` | READ | GET `/v1/acl` | 当前上游管理员；明确 prefix |
| `admin_ensure_group` | WRITE | POST `/v1/groups` | 当前上游管理员；明确组名 |
| `admin_manage_membership` | WRITE | POST `/v1/memberships` | 当前上游管理员；明确目标用户名/组/add/remove |
| `admin_set_acl` | WRITE | POST `/v1/acl` | 当前上游管理员；明确空间/子目录 prefix，禁止根路径扩大 |
| `admin_check_access` | READ | POST `/v1/check-access` | 当前上游管理员；只读判断，不改变权限 |
| `admin_ensure_internal_user` | WRITE | POST `/v1/users` | 显式管理员遗留内部账号操作；无密码路径 |

`admin_check_access` 的 HTTP POST 不改变外部状态，Effect 声明为 READ。
`admin_ensure_internal_user` 不创建 LDAP 用户，不提供密码生成、重设或返回能力；输入拒绝
`temporary_password`、`generate_password`、`return_password` 等凭证字段，上游请求固定
`generate_password=false`、`return_password=false`，输出只投影 created 与最小用户摘要。
初始化内容或普通成员授权不得顺带调用该遗留接口；缺失用户应提示 LDAP 同步处理。
此边界不宣称覆盖上游密码管理能力。

个人空间默认由当前账号解析。读取他人 personal 文件可显式指定目标 username 并由 effective
path ACL 判断；普通写入只能本人，管理员跨个人空间写入须显式指定目标并在提交前核验
管理员身份。目标 username 不改变当前账号、组织、Credential 或 Grant。

目录组授权回执必须包含 `group.pk` 与 `application: {pk, slug}`：add 的 binding.group/target
分别匹配目录组/门户 pk，门户 slug 匹配请求空间；remove 的门户不存在时返回 null。
缺字段、错误组或门户引用不得记为成功或回退旧校验。EEP-1834 是该 Action 的上游合同前置；
仅接受已批准的 additive 回执改动，不加入旧 EEP-1832 的幂等、限流或恢复改造。

## 仅浏览器与内部能力

| 能力 | 接入方式 | 不作为 Agent Action 的原因 |
| --- | --- | --- |
| runtime-state CRUD | 生成同源相对路由并提供指南 | 依赖浏览器会话及 Caddy 内部 token，不提供 Bearer API |
| HTML 订阅/取消/我的订阅 | 返回实际 subscription_url 与页面入口 | 读者登录浏览器自行登记，不代理订阅身份 |
| HTML 内容块与每日通知 | 保留 data-sub/id、回传 subscription_warnings、说明 cutoff/baseline | 内容标记和通知服务不是 Agent 管理 API；发布成功不等于通知送达 |
| browser-only 评论 | 使用公开文档所列 Agent 评论接口替代 | 不伪造 X-Authentik-* 或浏览器会话 |
| healthz | 运维只读探测 | 不作为用户业务能力 |
| runtime 内部维护/备份/企微发送 | 不开放 | 不是用户 Skill 的 Bearer 操作，不获得内部服务密钥 |
| 遗留密码生成/重设 | 不开放 | Connection/Agent 不处理或回传外部账号密码 |

覆盖表区分业务 API、浏览器功能和内部路由，不以“全量”承诺不存在的 Bearer 能力。
不得通过 SSH、DB、管理员 UI 或调用 Authentik 私有控制面替代 Publish API。

## 使用流程

1. 上传目标不明确时提示 personal/shared/public 选择；shared/public 必须由用户确认 slug，
   不自动创建随机名字。shared 必须询问邮箱、目录组或仅本人。
2. 邮箱列表规范化后确认目标；目录组搜索展示名称、组织路径与人数，再确认一个组。
   目录组授权涵盖当前及未来成员，viewer 不授予写权限。owner/manager 目标角色不得猜测。
3. 普通内容管理优先使用 scoped Action。管理员 Action 需明确业务意图和目标，包授权不能
   代替具体人员授权、删除、发表评论或全局 ACL 变更的操作意图。
4. 评论只读先 GET；创建使用当前 document SHA/精确 source line quote；回复只用 thread_id。
   修改删除先查本人 can_edit/can_delete；DOCUMENT_CHANGED 重新读取，不盲重放旧 anchor。
5. WRITE 后执行适用 READ 回读；Markdown 原样 bytes/hash，返回上游原样 review_url 再 raw_url。
   包发布回传 subscription_warnings，区分 markup、浏览器行为和企微送达证据。
6. 浏览器组权限刷新可能需要退出重登；网页会话与个人 Token 独立，不把 API 成功当网页授权。

## 可靠性与权限保护

新 WRITE 全部沿用持久 Call/Effect/Dispatch、一次获准提交和对应 Connection 的未知冻结。
权限修改、删除空间、整包发布可能部分完成；上游没有原生幂等或可查询终态，提交后未知仍
保留 UNCERTAIN，不以 HTTP 4xx、文件存在或同键本地去重声称整体外部结果可证。
READ 可用于对账；跨 Consumer、Grant、Credential 重连与升级保留未决 Effect 和冻结。
不复用 v6 风险接受自动批准新管理员/删除/评论范围；#1672 原缺口保持开放。

每个 Action 输出只投影已声明业务结果，不回传内部账号属性、密码、凭证或服务配置。
保留固定 endpoint、archive/path/size、Content-Type、redirect/DNS/IP/egress 保护；
JSON 结果仍有界，下载不能截断后假称完整。上游拒绝与返回字段变化按精确 contract 验证。

## 验收与发布

先批准本 ADR 及同步 HLD/PRD/Spec，再实现新版本。角色矩阵、跨主体、跨 Connection、评论
作者权限、最后 owner、目录组只读、未知冻结、多次幂等提交与升级负向均须有测试。
本地必要检查、当前 head CI 镜像、真实 review、签名/SBOM/迁移/上海发布保护继续生效。
统一 full 的新 Policy/Profile/Consumer 声明、公司审批和显式 Consent 后才允许实际使用。

部署与真实授权/评论/删除验收须绑定用户另行批准的具体空间、人员/目录组、角色、文件和
副作用。没有真实管理员凭证时管理员 Action 仅能记实现/模拟或 PostgreSQL 验证，不能
记作真实上游验收。不得为测试索取共享超级凭证、修改上游或自动解除未知结果冻结。
