# 第一方 LDAP 身份 Adapter

`createLdapIdentityDirectory` 只接受 LDAPS；部署必须提供稳定的 `issuer`、不可变 UID 属性、邮箱属性及经 #388 核实的 active-state 属性与解析函数。查找必须唯一，密码仅用于员工 bind，不写入账号、会话、日志或 Platform Store。每次身份解析重新查询 LDAP；服务不可用或状态未知时拒绝授权。管理员只按配置的 LDAP 稳定 UID 集合赋权，空集合不产生管理员。

`createLdapBrowserAdapter` 是 #504 正式 Platform API 装配的输入。装配方提供当前 Platform 管理员禁用查询、#889 有效目录的组织映射及共享持久 `LdapSessionStore`。Store 只保存 SHA-256 会话摘要、稳定 UID 和到期时间；`find` 必须检查到期，`revoke` 和 `revokeUid` 必须跨所有 API 副本立即可见，故障必须抛错。不得用单进程 Map 作为生产 Store。浏览器 Cookie 只在原始 HTTPS 域使用，状态变更必须经同源 Origin 校验；正式入口须将 `handleRequest` 接入登录与登出路径，并将 `identityAdapter` 注入 Platform API。#504 负责生产装配与持久 Store，#192 验证真实 Web 流程。

当前受控测试验证协议和拒绝路径。#388 尚未提供 active-state 的权威字段、查询契约、变更时效、责任人及受控正负主体，因此真实停用即时生效不能签收。#504 接入后还需验证两个真实员工、管理员、停用账号、跨副本会话撤销和正式 Web/API 请求；Connection 会话不能复用。
