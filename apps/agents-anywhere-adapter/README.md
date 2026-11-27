# Agents Anywhere 设备发现

此 Adapter 将 Agents Anywhere 2.2 的账号、Connector 和 Runtime 目录映射到外部服务发现接口。
它使用供应方已经批准的员工账号关联，每次查询都用该账号的授权读取 `/api/v2/auth/me`，
再查询本人的 Connector 和各设备上的 Runtime。工作站离线时保留设备和 Runtime 引用。

在供应方环境中用 Node.js 24 启动，监听回环地址，HTTPS 入口转发至该端口。

```sh
pnpm --filter @agent-infra/agents-anywhere-adapter... build
PORT=8080 node apps/agents-anywhere-adapter/dist/index.mjs /run/agents-anywhere/accounts.json
```

配置文件示例使用虚构的标识。

```json
{
  "instanceId": "workstations",
  "origin": "https://agents-anywhere.example.test",
  "workerTokenFile": "/run/secrets/platform-worker-token",
  "accounts": [
    {
      "subjectId": "platform-employee",
      "userId": "agents-anywhere-employee",
      "grantFile": "/run/secrets/linked-employee-grant.json"
    }
  ]
}
```

`subjectId` 取自 Platform 用户记录，`userId` 取自本人已认证的 Agents Anywhere 账号。
`grantFile` 由供应方持有，包含签发该授权的 `origin` 和该员工的 `accessToken`。
Worker 使用单独的服务凭据。管理员在平台「外部服务」登记 Adapter 的 HTTPS 地址和 Worker 凭据，
选择测试并启用。已有账号关联的变更和撤销在下次发现请求时生效。
