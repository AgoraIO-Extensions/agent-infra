# 个人 API 凭证读取联调

本入口供个人 API 凭证的消费者核对账号与指定 Agent。产品授权规则见
[平台 PRD §7.3](../prd/PRD-agent-platform-M1.md#73-api-身份凭证与授权)，
接口、错误及事务规则见[工程 Spec §9.2](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#92-权限顺序)。
机器契约见[Platform V2 OpenAPI](../../packages/contracts/artifacts/openapi/pilot-browser.v2.openapi.json)。

## 请求顺序

1. 从受控凭证配置读取个人 Token，在 `Authorization: Bearer <个人 Token>` 中发送。
   不附带 Cookie，不把 Token 放入 URL、普通 Action 参数或日志。
2. 调用 `GET /api/v2/me/api-identity`。用所配置的平台来源和 `principal.kind/id` 标识账号；
   `credentialId` 只标识本次凭证。即使没有可见 Agent，也可完成此步。
3. 需要查询资源时，调用 `GET /api/v2/agents` 或 `GET /api/v2/agents/{agentId}`。
   列表允许 `limit/cursor`；自查与单项不接受 query/body 或自报身份头。
4. 后续每次操作使用其实际响应判断权限。自查返回的 scopes 是凭证操作范围，不是资源授权；
   单项读取仍须 `agent:read` 和该 Agent 的显式管理权或使用权。

`expiresAt: null` 表示未设置时间到期，不表示永不过期或不可撤销。换一把同用户的个人 Token
不会改变稳定账号标识。接口不会返回 Token 原值或其校验摘要。

## 联调结果

成功返回 200；无效凭证为 401，主体禁用或缺少读取范围为 403，不可见或不存在 Agent 为相同的
404，非法请求为 400，依赖不可用为 503。读取响应使用 `Cache-Control: no-store`。
完整错误代码以工程 Spec 和 OpenAPI 为准。

生成 SDK 的 `getPersonalApiIdentityV2` 与 `getAgentV2` 可传入个人 Bearer 作为 `auth`，
并省略浏览器凭据。浏览器调用单 Agent 时沿用会话认证；显式提供会话凭据的 SDK 调用方需选择
Cookie security 选项，不要将会话值作为 Bearer。

记录联调环境、源码版本、请求路径、响应状态及 request/trace 引用，避免记录凭证。
远端证书问题单独登记；本地 HTTP 集成通过不等于远端 Connection 已接通。

需要创建并迁入自建 Agent 时，继续使用[迁入与 API 验证流程](custom-agent-migration.md)。
