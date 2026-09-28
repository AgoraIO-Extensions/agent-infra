# 企业目录快照契约

`enterprise-directory-sync` 使用独立数据库和企微通讯录读取权限，抓取配置根部门及其全部子部门的员工详情。每个部门成功返回、成员关系一致且部门图完整后，服务才将一份快照作为单条数据库记录发布。失败不会修改已发布版本；读取时仍按 `validUntil` 拒绝过期版本。

数据库读写由 `enterprise-directory-store` 的 Drizzle Adapter 完成；迁移 Job 使用独立迁移账号按 `migrations/enterprise-directory/` 的 Drizzle journal 执行。每次抓取前从 PostgreSQL sequence 取得递增扫描代次；发布事务拒绝已被较新代次超越的结果，读取按代次选择当前快照，防止旧扫描晚完成后夺回权威。迁移入口要求 `DIRECTORY_RUNTIME_DATABASE_ROLE` 指定已存在、与迁移账号不同的运行数据库角色，并在迁移后授予该角色 `enterprise_directory` schema 的 `USAGE`、`snapshots` 表的 `SELECT/INSERT` 和扫描 sequence 的 `USAGE`，不授予删改或迁移 history 访问。迁移账号须能创建独立的迁移 history schema。部署方仍须分别配置迁移与运行账号凭据。

内部接口为 `GET /internal/directory/snapshot`，Zod 源与生成的 OpenAPI 3.1 分别由 `@agent-infra/contracts/enterprise-directory` 和 `@agent-infra/contracts/openapi/enterprise-directory.v1` 发布；仅经带证书校验的 HTTPS 和 `Authorization: Bearer <部署密钥>` 调用。成功返回 `schemaVersion: 1`、UUID `revision`、`source: "wecom"`、`rootDepartmentId`、毫秒时间戳 `fetchedAt` 和 `validUntil`、`complete: true`、`departments` 与 `members`。`fetchedAt` 是抓取完成时间，`validUntil` 最迟为抓取开始后 24 小时；扫描超过一天时拒绝发布。无有效快照返回 503，认证失败返回 401；响应禁止缓存。调用方必须验证 Schema、完整性和时效，不能保留旧版作为权限来源。

服务在 HTTP 与数据库边界将版本化 wire DTO 显式映射为目录领域快照，读取方再次验证完整性和时效。`/readyz` 只在持久快照有效时返回 200，并附 `fetchedAt`、`validUntil` 供部署告警核对。同步成功日志只对已发布版本记录版本、时间、耗时及聚合计数：部门/成员总数、相对实际前版的成员新增/移除/部门关系变化、inactive、缺失/无效/重复邮箱与不可唯一关联人数。首版 `baselineRevision` 和变更计数为 `null`；这些不可关联计数可能重叠，`unmappableMembers` 按人去重。被较新代次超越的扫描不输出发布计数；失败日志仅记录 `source_unavailable`、`invalid_snapshot` 或 `store_unavailable` 等受限原因及耗时。日志不记录成员标识、邮箱或企微凭据。部署方须对持续 503 和同步失败配置采集与告警。

成功抓取后以下次失效时间为基准，提前 4 小时启动下一次完整扫描；失败每 5 分钟重试，旧版过期后仍拒绝读取。较旧的并发扫描若被超越，只记录 `snapshot_superseded`，不会声明其已发布，也不会改变当前版。

`members` 只含企微 `userId`、`email`、企微侧 `active` 和 `departmentIds`。`resolveActiveMemberByEmail` 用受信 LDAP 查询取得的邮箱匹配，且仅在有效快照中存在恰好一个同邮箱、有效的企微账号时返回成员；缺失、重复或停用均拒绝。该服务既不查询 LDAP，也不证明 LDAP 账号当前有效。Platform 的 LDAP 当前状态、管理员禁用、Owner 与范围决策由各自 owner 在敏感操作时重新核验。发送者身份也必须由可信企微渠道解析，不能使用请求字段猜测。

生产部署须提供独立的运行数据库账号、迁移账号、专用企微通讯录读取凭据、至少 32 字节随机内部读取密钥以及匹配 Service DNS 名称的 TLS 证书。企微应用必须被批准读取完整目标组织及邮箱；普通新建自建应用可能不返回邮箱，接口成功本身不能证明权限范围完整。真实目录权限、两名员工、停用、组织变化及跨用户映射需在受控环境分别验证；本包的受控测试只覆盖协议和失败路径。

Platform 授权与任务消费由 #481/#508 集成，企微发送者映射由 #440 集成。本服务不保存 Platform 授权、LDAP 密码、机器人消息或 Connection 凭证。
