# AgentInfra 网页 OIDC 登录

Platform API 的受信配置模块由 `PLATFORM_API_CONFIGURATION_MODULE` 指向。模块导出
`oidc = { issuer, clientId, clientSecret, allowEmailLink, administratorUserIds }` 和已有的
`directorySnapshot` 配置。后者提供目录端点、服务认证及部门映射。模块从受保护的部署配置读取
`clientSecret` 与目录认证材料。管理员列表使用平台稳定用户 ID。开启 `allowEmailLink` 后，
首次绑定依据受信 issuer 的已验证公司邮箱与当前目录唯一匹配。

为 AgentInfra 注册专属机密 client，登记精确回调地址
`https://<AgentInfra 主机>/auth/oidc/callback`。Web 使用
`VITE_PLATFORM_LOGIN_URL=/auth/oidc/login`。反向代理将这两个路径转发到 Platform API，
同时沿用平台的可信代理头和外部 HTTPS 主机配置。

## 登记既有账号

在切换前，逐条复核 Platform 数据库中的旧 `user_id`、该账号历史 LDAP UID 对应的员工和
权威目录中的当前归属。输入 JSON 对象包含以下字段。

| 字段 | 取值 |
| --- | --- |
| `userId` | 已复核的旧平台用户 ID |
| `source` | 当前目录快照的来源标识 |
| `employeeId` | 此人在该来源中的稳定员工 ID |
| `email` | 权威目录中唯一的有效公司邮箱 |

在可访问该部署数据库和目录服务的受信环境中执行。先应用本版本的 Platform 迁移，
设置 `PLATFORM_DATABASE_URL` 和 `PLATFORM_API_CONFIGURATION_MODULE`。
从构建完成的工作区运行以下命令，以权限受控的文件通过标准输入传入一条记录。

```sh
pnpm --filter @agent-infra/platform-store oidc:stage-legacy < reviewed-account.json
```

命令核对当前完整快照的来源、员工 ID、唯一有效邮箱和数据库内的旧用户 ID。
每条记录独立提交，可以用相同输入重试。冲突时退出并保留原记录，输出仅含操作结果。
如果仍有待核实的旧账号，其他已确认没有历史账号的新员工可单独登记。操作人先核对历史账号来源，
将已确认新员工的输入设置为 `"kind": "confirmed-new"`，省略 `userId`，保留目录来源、员工 ID 与邮箱。
此操作只预留普通用户身份，后续首次网页绑定仍需验证邮箱。

完成后以原 Owner 和管理员身份分别登录，回读原 Agent 权限及管理员权限。
