# 本地浏览器开发入口

此测试工具让正式 Web、Platform API 和 Worker 使用受控开发身份联调。它不实现产品
身份服务，不创建账号、业务数据或 Workload，也不证明真实登录、模型、Connection 授权或
GitHub PR 首通。真实验收仍使用部署 IdentityAdapter 和专用测试账号。

## 配置与启动

先启动本机 Web 和 API。在仓库外创建仅当前用户可读的配置文件，使用独立开发主体的
受控 token 文件和浏览器信任的本地 TLS 证书。不能恢复已撤权的主体，不能复用或修改
已有恢复任务。token 只由此工具读取，不写进 Web 构建、URL、日志或浏览器存储。

```json
{
  "schemaVersion": 1,
  "mode": "controlled-development",
  "port": 3511,
  "browserHostname": "127.0.0.1",
  "apiOrigin": "http://127.0.0.1:3508",
  "webOrigin": "http://127.0.0.1:3001",
  "tls": {
    "certFile": "/absolute/local-development/tls.crt",
    "keyFile": "/absolute/local-development/tls.key"
  },
  "accounts": [
    {
      "name": "owner",
      "label": "开发 Owner",
      "tokenFile": "/absolute/local-development/owner-token"
    },
    {
      "name": "admin",
      "label": "开发审批管理员",
      "tokenFile": "/absolute/local-development/admin-token"
    }
  ]
}
```

配置、TLS 私钥及 token 文件必须是当前用户拥有的普通文件，权限不向其他用户开放
（例如 `0600`）；不接受文件符号链接。上游仅接受显式 loopback IP 的 HTTP/HTTPS origin，
无路径、凭证和查询参数。HTTPS 上游使用 Node 默认的证书验证。

使用 Node 24 从仓库根启动：

```bash
node tests/local-real-e2e/local-browser.ts /absolute/local-development/config.json
```

打开 `https://127.0.0.1:3511/__local/login` 选择开发身份；退出入口为
`/__local/logout`。Web 部署可将登录与退出链接指向这两个同源地址，并持续显示受控开发
标识。本工具不需要修改现有 Vite 代理；页面和资源经同一个 HTTPS origin 转发。
HMR WebSocket 不转发，修改 Web 后重新加载页面。

登录前工具用服务端 token 查询正式 `/api/v1/session`，仅成功后建立最多一小时的
HttpOnly、Secure、SameSite=Strict opaque 会话。切换或退出撤销旧会话并整页跳转到
`/agents`。退出、切换或会话到期会结束该会话已有的 API/SSE 连接。真实身份仍由 API 和
Worker 在操作时重新解析。已认证 API 的写请求还会消耗会话绑定的一次性 CSRF cookie，
并在响应中轮换下一枚 token。

申请仍必须填写模型配置。开发用的模板、模型端点、模型、推理档位和合成模型凭证必须
来自同一受控部署；此工具不注入、改写或替换业务请求，也不替用户提交申请。不要把真实
凭证改成合成值后报告真实模型成功。

按 `Ctrl+C` 只停止此浏览器入口并清除内存会话；不停止 Web/API/Worker，不删除数据。

## 验证

测试使用临时本机 HTTP 服务、临时合成 token 和 OpenSSL 生成的一日 TLS 证书；不连接
现有后端、不读取部署凭证、不创建业务数据。TLS 客户端明确信任该测试证书。

```bash
node --test tests/local-real-e2e/local-browser.test.ts
```

覆盖配置和私密文件权限、实际登录会话校验、Cookie 属性、匿名与伪造身份、Host/Origin/
CSRF 拒绝、调用方身份头与上游 Cookie 隔离、切换与退出、禁止上游重定向，以及 SSE 的
即时转发和断连取消。测试通过仅证明受控开发入口行为。

## 对话真实浏览器验收

登录入口完成后，使用专用配置运行对话旅程：

```bash
node tests/local-real-e2e/conversation-browser.mjs /absolute/local-development/conversation.json
```

对话旅程配置只保存 origin、Agent ID、测试提示词和两个浏览器主体的私有
`storageState` 文件路径；它不保存 token 正文：

```json
{
  "origin": "https://127.0.0.1:3511",
  "agentId": "agent-under-test",
  "prompt": "请返回一段可核对的结果",
  "owner": {
    "userId": "controlled-owner",
    "stateFile": "/absolute/local-development/owner-state.json"
  },
  "other": {
    "userId": "controlled-other",
    "stateFile": "/absolute/local-development/other-state.json"
  }
}
```

两个 `storageState` 必须由同一受控部署登录流程生成、属于当前用户且权限为 `0600`；
不得把 token、Cookie 或真实消息正文提交到仓库。

没有可用服务端点时，可先运行 Node 24 的配置 smoke；它只检查配置、私有文件权限和
Playwright state JSON，不启动浏览器、不访问网络，输出中的主体和 Agent 标识仅为 SHA-256：

```bash
node tests/local-real-e2e/conversation-browser.mjs --check-config \
  /absolute/local-development/conversation.json
```

输出包含 `endpointChecked: false`，不能作为页面、SSE、模型或 Connection 验收证据。

该旅程会在 Owner 浏览器中创建会话、提交文本、读取 SSE，并在回答完成后刷新页面。
它记录浏览器实际消费到的增量 `text.delta` 与终态 `execution.status` 帧，并要求页面在终态
帧前显示增量文本、增量帧先于 `completed` 终态帧到达；随后回读持久化事件、恢复页面和窄
屏布局。第二个独立浏览器主体同时请求
会话详情和 `/events` 订阅，两者必须得到 `403` 或 `404`，页面不得保留另一个主体的正文。

输出目录中的 `evidence.json` 只保存主体、会话、执行和事件 ID 的 SHA-256，以及状态码和
帧类型，不保存 token、消息正文或原始凭证。桌面和移动截图会遮盖用户消息与 assistant 正文，
只保留布局和状态证据。`modelCallVerified` 与 `connectionVerified` 默认为 `false`；受控浏览器
旅程的通过不能替代真实模型调用或 Connection 授权证据。

`apps/web/tests/conversation-live.spec.ts` 是 Playwright 的合成 fixture 测试：它在浏览器
内延迟返回两帧 SSE，专门验证提交防重、增量渲染、刷新恢复和权限失效 UI。fixture 通过不
代表部署后端、模型或 Connection 已经可用。

## API 身份与授权真实验收

`api-identity-browser.mjs` 使用三个由同一受控部署生成的独立浏览器 `storageState`，覆盖
管理员、应用负责人和其他员工。它创建专用 API application，并回读应用列表隔离、delivery
授予与撤销、应用凭证签发与撤销、`manage`/`use` Agent grant、凭证 scope、过期、撤销、跨
主体拒绝和退休 V1 URI。管理员审计回读会检查所有已产生的响应和审计正文都不含凭证值。

配置只保存主体 ID、Agent ID、状态文件和 Bearer 探针的真实路径，不保存 token。状态文件和
输出目录必须属于当前用户且为 `0600`/`0700`。配置检查不访问后端：

```bash
node tests/local-real-e2e/api-identity-browser.mjs --check-config \
  /absolute/local-development/api-identity.json
```

真实旅程使用 Node 24：

```bash
node tests/local-real-e2e/api-identity-browser.mjs \
  /absolute/local-development/api-identity.json
```

最小配置形状如下。`bearer.readPath` 必须是接受应用 Bearer 凭证并验证 `agent:read` 的
Agent 读取入口，`bearer.grantPath` 必须是接受 `agent:manage` 的 grant POST/DELETE 入口；
脚本不会猜测或创建这两个入口。

```json
{
  "schemaVersion": 1,
  "mode": "api-identity-real",
  "origin": "https://127.0.0.1:3511",
  "outputDirectory": "/absolute/local-development/api-identity-evidence",
  "logFiles": ["/absolute/local-development/platform-api-acceptance.log"],
  "agentId": "agent-under-test",
  "admin": { "userId": "controlled-admin", "stateFile": "/absolute/local-development/admin-state.json", "expectRole": "system_admin" },
  "owner": { "userId": "controlled-owner", "stateFile": "/absolute/local-development/owner-state.json", "expectRole": "employee" },
  "other": { "userId": "controlled-other", "stateFile": "/absolute/local-development/other-state.json", "expectRole": "employee" },
  "bearer": {
    "readPath": "/api/v1/agents/{agentId}",
    "grantPath": "/api/v1/agents/{agentId}/grants",
    "grantPrincipal": { "kind": "user", "id": "controlled-other" }
  }
}
```

### #504 装配依赖

真实验收开始前，#504 需要在同一受信部署中提供以下可读回事实：

- Platform API、浏览器会话入口和 `IdentityAdapter` 使用同一目录；三个主体均为当前 active，
  管理员含 `system_admin`，Owner 对 `agentId` 具有管理权，数据库为本次专用隔离实例。
- `assemblePlatformApi` 使用同一 PostgreSQL `PostgresApiIdentityStoreV1`，并把
  `resolveApiCredential`、`resolveUser` 和当前 authorization revision 绑定到部署目录；不能用
  fixture、调用方提交的 user ID 或静态 Bearer 替代。
- 当前 `createPlatformApp` 只调用 `registerApiIdentityRoutes`；`management-routes.ts` 中由
  `registerManagementRoutes` 提供的 legacy Bearer 分支未自动挂载。#504 必须实际挂载该
  contract 的读取和 grant 路径，或提供完全等价且已记录的路径；仅挂载
  `/api/v1/api-credentials`、`/api/v1/applications` 等浏览器身份路由，不足以证明 scope、
  过期、撤销和 Agent grant。`bearer.*Path` 必须与实际装配路径一致。
- `/api/v1/admin/audit` 对管理员可读，返回的 `summary`、`subjectId`、actor 和错误信息不得
  包含凭证值；日志采集也应以本次 run 的 request/trace ID 或 hash 关联，而不记录 token。
- 如果 #504 能提供本次 run 的 API 日志文件，把路径放入 `logFiles`；脚本会回读并逐个检查凭证
  值。没有可读日志文件时，`evidence.logs.checked` 为 `false`，不能把它写成日志验收通过。
- #504 负责启动和修复隔离环境；本脚本只消费已提供的 endpoint、数据库和状态文件，不启动或
  恢复 default Colima，不接触生产 kube context。

输出 `evidence.json` 只含主体、应用、凭证和 Agent 标识的 SHA-256、状态码、协议错误码和
  审计数量。`endpointChecked: false` 的配置检查不能作为真实 API 验收证据；完整旅程必须
  以当前部署返回的状态和回读结果为准。
