# Connection 登记 Owner 读取与机器客户端

任务：#4455；Connection 对应 EP-1153。只交付代码和接线说明，生产配置、批准、凭据交付和部署由部署负责人执行。

## 用途与边界

现有 v2 首次 201 返回一次 secret、200/GET 不返回、加密关联及 Host 供应保持。
普通 Agent detail/metadata 的个人 Bearer 不能充当登记机器身份。新增只读事实入口：
`GET /api/internal/connection-registration/v1/owners/{sourceNamespace}/{platformAgentId}?purpose=create|read|disable|delete`。
专用 Owner-read Bearer 只核验 SHA-256；Cookie、Origin、正文、其他 query、错源/Agent 拒绝，错误不含个人资料或秘密。
默认不装配该入口；部署模块须提供 `connectionRegistrationOwnerRead: { credentialHash, directorySource }`，
同时具备原 `apiInput.connectionConsumerRegistration` policy 和当前目录 snapshot，才能构造真实生产 reader。
这些输入只绑定已评审来源，不构成批准。

## 当前事实

读取原 `connection_consumer_registrations.request.platformOwnerId`；核对当前 `agent_owners`、申请人、
Agent 状态及 `platform_user_disables`，复用原 current 判定。create 仅允许原可登记状态；
read/disable/delete 可核实已发送且当前 disabled Agent，不能重新创建，删除或失权不放行。
当前账号从现有 `directory.currentByUserId` 的平台稳定映射解析，不创建用户或登录；
其当前邮件在可信 snapshot 中必须唯一且 active。OIDC沿原 employeeId 绑定核验；当前主干已退役LDAP运行时，不恢复密码登录或LDAP查询。snapshot 的成员 ID 是 WeChat userid。
外部身份读取前后各读一次数据库事实，变化时拒绝；不持锁等待网络。

200 严格 JSON：`schemaVersion:1, sourceNamespace, platformAgentId, platformOwnerId, policyRevision,
directorySource, wechatUserId, email, ownerRevision, expiresAt`，20秒有效且不超过 snapshot 有效期。
revision 绑定原 intent/current 数据与账号授权和成员事实，不因 TTL 续期变化。
Connection 再按 WeChat userid 和邮件匹配同一当前 IAM 记录与既有 ACTIVE Principal；不能等同两个系统的 UUID。

## Worker 接线

编译入口 `connectionRegistration` 导出原 v1/v2 adapter 及生产机器客户端。
客户端仅访问固定 HTTPS Connection origin 和该 source 的 v2 登记路径，使用独立登记 Bearer，
严格 TLS、禁止 Cookie/Origin/重定向、原取消信号、单次 HTTPS 派发，不使用隐式重试 POST 的 fetch。
`resolveOwnerBinding` 使用独立 `/owner-binding` READ，严格核对原 intent 的 source/Agent/Owner/policy、
有效期及额外字段；不将 create receipt 的 Owner 当期望值。原 POST/摘要/加密保存/unknown 保持。
机器认证和 Owner-read 凭据分离，不授予 Provider、用户 OAuth 或任意员工查询权限。

## 验证

公开 HTTP 与隔离 PostgreSQL 验证当前 Owner/停用/原 intent、跨 source/Agent、身份变更、
取消、响应界限和秘密投影。生产 D1-D4、部署和真实创建/Host/OAuth/MCP READ 单独验收，未执行保持 pending。

## 部署负责人接线

在 API 的现有 configuration module 导出 `connectionRegistrationOwnerRead`，值为 Connection
定向交付的 `infra-owner-reader.json`（只有 `credentialHash` 和 `directorySource`，没有原文 Key）。
保留原 `apiInput.connectionConsumerRegistration` policy 与目录配置；API 自己装配 Store 和当前身份，
不要把普通用户 Bearer、API detail 或客户端提交的 Owner 接进来。

Worker 的现有 configuration module 从镜像编译入口
`/app/dist/connectionRegistration.mjs` 引入
`createConnectionRegistrationWorkerConfigurationV2`，用既有值构造：

```javascript
const registration = createConnectionRegistrationWorkerConfigurationV2({
  publicOrigin: "https://agent-connector.agoralab.co",
  policy: approvedRegistrationPolicy,
  credentialFile: approvedRegistrationTokenFile,
  encryptionKeys: existingPublicWrappingKeyConfiguration,
});
// 合入现有 workloadInput，不覆盖其他配置：
workloadInput.connectionConsumerRegistration = registration;
```

变量由部署负责人从已有受保护配置提供，示例不是已批准值。
`policy.schemaVersion` 仍为 1；新 adapter 的 HTTP DTO 为 2。API/Worker 的 policy 必须相同，
包含同一 sourceNamespace/revision、callback/resource/scope。生产 callback 是
`https://agent-infra.agoralab.co/api/connection-installations/callback`；resource 是
`https://agent-connector.agoralab.co/mcp`，scope 是 `mcp`。

登记原文 token 仅挂给 Worker，Owner-read token 原文仅留 Connection；两个 hash 不可混用。
Worker 支持受控同目录内的 Kubernetes Secret 原子投影，特殊文件、目录外 symlink、
world-readable 或超限文件拒绝。加密复用现有 public wrapping key，私钥仍沿原 Worker keyring 和 Host 供应；
不能另造一套 Key、把浏览器 Relay Key 当机器凭据，或省略加密以使登记可用。

先部署含 Owner reader 的 infra API（保持 Owner 启用功能关闭），再由 Connection 负责人部署并
核验具名来源投影，最后 infra 负责人接 Worker 配置、部署并用原 Owner 启用入口验收。
每一步先核对当前 CI/source 与 D1-D4 批准；没有批准或真实输入时保持入口关闭。
创建成功、Host 获取服务凭据、本人 OAuth、MCP READ、重试及跨 Owner/Agent 隔离分别留证。
