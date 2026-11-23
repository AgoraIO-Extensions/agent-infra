# Sub2API 模型授权 Adapter

已有 Sub2API 实例可以在同一 HTTPS 入口下挂载此 Adapter。将
`GET /.well-known/agent-infra-adapter` 和 `POST /v1/model-authorizations`
转发给 Adapter，其余路径由 Sub2API 处理。在 infra 的「管理 / 外部服务」登记该入口的
HTTPS origin、实例标识和服务凭据。管理员启用已验证版本后，员工可以按本人身份查询授权。

Adapter 使用 Node.js 24。安装仓库锁定的依赖后，执行
`pnpm --filter @agent-infra/sub2api-adapter start /run/secrets/relay-adapter.json`。
服务监听回环地址，默认端口 8090，可用 `PORT` 指定端口。

受保护配置文件由供应方维护，包含以下字段。

| 字段 | 用途 |
| --- | --- |
| `instanceId` | 与平台登记的稳定实例标识一致 |
| `origin` | 本实例上游 Sub2API HTTPS origin |
| `serviceBearer` | 平台访问 Adapter 使用的专用凭据 |
| `relayReadKey` | 获准读取已关联用户及其 API Key 列表的 Sub2API 服务凭据 |
| `accounts` | 供应方核实的 Platform 主体 ID 到 Sub2API 数字账号 ID 的对象映射 |
| `agentGroupIds` | 供应方允许用于 Agent 的分组 ID 数组 |

Adapter 使用公开设置接口核对上游连通性。授权查询验证服务凭据、已关联账号和当前用户状态，
按分组、状态、到期时间及配额过滤候选，按 Key ID 升序返回引用和脱敏显示名。
供应方账号关联和分组策略只保存在 Adapter 一侧。
