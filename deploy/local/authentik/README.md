# 本地 Authentik 身份装配

这是部署 Adapter，复用独立 Authentik 的账号、登录和当前目录，不为 Platform 新建用户表。
主产品继续使用 [IdentityAdapter](../../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#91-identityadapter)，
Connection 的登录和授权保持独立。

## 身份服务与配置

按 [Authentik 官方 Compose 安装](https://docs.goauthentik.io/install-config/install/docker-compose/)
启动独立本地实例，使用独立 project、数据库卷和只绑定 loopback 的端口；不挂 Docker socket。
TLS 终止代理使用浏览器与 API/Worker 都信任的证书，保留公开 Host。容器内的 DNS 必须将同一
issuer 主机解析到实际身份服务，不能关闭证书校验或把签发方改为另一个地址。

使用 Authentik 正式管理 API 或管理页面准备两个独立测试主体、明确的员工/审批组及组织组。
用于目录读取的独立服务账号只授予 `authentik_core.view_user` 和
`authentik_core.view_group`。账号密码、服务 Token 和 OIDC client secret 保存到仓库外受保护文件；
不把 bootstrap 管理 Token 交给运行中的 Adapter。初始化与重启分开，不能每次启动重建账号。

注册 confidential OIDC provider，仅启用 authorization code，设置固定 HTTPS callback
`<Platform 公开 origin>/auth/callback`，采用严格匹配、`openid` scope、RS256 签名密钥和
`sub_mode=hashed_user_id`。后者对应 REST 的 `uid`，`user_id` 模式则对应数字 PK，二者不能混用。
issuer、authorization endpoint、token endpoint 和 JWKS URI 从该 provider 的实际配置回读。
参见 [OIDC provider](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/)。

`createAuthentikDirectory()` 配置字段如下：

| 字段 | 含义 |
| --- | --- |
| `origin` | 固定的 HTTPS Authentik origin；拒绝重定向 |
| `issuer` | provider 的精确 issuer，用于绑定已经验证的 subject |
| `instanceNamespace` | 当前身份实例的稳定标识，重启时保持不变 |
| `apiToken` | 从受保护文件读取的专用目录服务 Token |
| `roleGroups` | `employee`、`system_admin` 分别对应的组 UUID 数组 |
| `organizationGroups` | `{ groupId, organizationId }` 显式映射数组 |
| `timeoutMs` | 可选的单次完整查询截止时间，默认 5 秒 |

只解释直接组成员关系。Authentik superuser、同名组或上级组不会自动授予 Platform 管理权限。
每次调用重新读取完整、有界的当前目录；无账号、禁用、未映射、重复/不完整分页或上游失败均
拒绝授权。稳定用户引用同时绑定实例、origin、PK 和 UID，不能借 PK 重用继承旧业务数据。

## API 与 Worker

从仓库根使用 Node 24、pnpm 11 构建部署 bundle，输出位置由部署者指定：

```bash
pnpm install --frozen-lockfile
node deploy/local/authentik/build.ts /absolute/deployment/authentik-adapter.mjs
```

bundle 包含 OIDC 客户端代码，不包含任何实际配置或凭据。`createAuthentikBrowserAdapter()`
配置包含 `publicOrigin`、`issuer`、`authorizationEndpoint`、`tokenEndpoint`、`jwksUri`、
`clientId` 和从受保护文件读取的 `clientSecret`。全部 endpoint 必须属于 issuer 的 HTTPS origin。

API 部署入口调用 `startAuthentikPlatformApi()`，传入上述 `directory`、`browser` 配置、
监听 `port`、实际 API 模块的 `assemblePlatformApi`/`createPlatformApp`，以及
`createAssemblyInput({ identity, loadAuthorityContext })` 回调。该回调把收到的两项身份依赖
传给现有 `createProductionPlatformApiAssemblyInputV1()`；模板、模型、镜像、数据库与密钥
继续使用原部署输入。身份未真正连接时启动失败。退出进程时调用返回值的 `close()`。

Worker 在自己的进程内使用相同目录配置创建 `createAuthentikDirectory()`，将其 `resolveUser`
注入现有 `ConversationRuntimeOptionsV2.directory`。不传浏览器 Request、cookie 或 ID token。
`loadAuthorityContext` 和用户展示查询使用同一个当前目录，不保存第二份权威用户列表。

HTTPS Web 代理把 `/auth/*` 和 `/api/*` 转发给此 API，并保留公开 Host、请求 cookie 和
浏览器 Origin。不得从请求头构造身份。前端配置 `VITE_PLATFORM_LOGIN_URL=/auth/login`、
`VITE_PLATFORM_LOGOUT_URL=/auth/logout`，不启用受控开发身份标识。

## 会话与验收

OIDC callback 校验签名、issuer/audience、有效期、PKCE、state 和 nonce，并单次消费浏览器
绑定的登录挑战。Platform 仅保存随机 opaque session 与稳定用户引用，权限每次从当前目录解析。
cookie 为 host-only、HttpOnly、Secure、SameSite=Lax；会话在 API 重启后失效，需要重新登录。
此本地装配使用单 API 实例，不能把进程内 session 当作多副本共享会话。

`GET /auth/logout` 只显示退出确认；实际退出通过带同源 Origin 和非简单 CSRF header 的 POST
完成，随后返回 Agent 页面。退出 Platform 不替代独立 Authentik 或 Connection 的会话管理。

`pnpm test` 包含目录负向测试和真实 HTTPS/JWKS 签名的 OIDC 协议测试，`pnpm check-types`
与 `pnpm check` 覆盖部署源码。测试 provider 不证明指定账号已经真实登录；最终还需通过实际
浏览器完成两个账号的申请/审批/执行、当前撤权与隔离，并单独完成 Connection 和干净环境重现。
