# ADR: Connection Web 独立部署边界

## 状态

已由产品负责人批准进入实现；生产发布仍受 Connection HLD 中未关闭门禁约束。

## 背景

Agora Agent Platform 的 `apps/web` 与 Connection 属于不同产品和授权边界。将 Connection 管理页面
继续拼接在 `connection-api`，或放入 `apps/web`，都会让展示层与 OAuth 协议接入混合，并使 Platform
前端成为 Connection 授权状态的隐式依赖。M1 的首批使用者为中国员工，Connection 还需要独立的中文
管理入口。

## 决策

1. 新增 `apps/connection-web`，作为独立构建、镜像和部署的 React SPA；`apps/web` 只承载 Agora
   Agent Platform 页面。
2. Connection Web 只通过版本化 OpenAPI Browser API 访问 `connection-api`。Principal、Consumer、
   Connection、Credential 和管理员权限均由服务端从 HttpOnly browser session 解析。
3. Connection Web 与 `connection-api` 必须位于同一批准的 public origin。`/connection/*` 进入 SPA，
   `/api/v1/connection/*`、`/connection/v1/*`、`/oauth/*`、`/.well-known/*` 和 `/mcp` 进入 API；不使用
   跨域 Cookie、Origin allowlist 或公共 tunnel 补偿错误路由。
4. 登录、Connection、Access Token、管理员和共享 Connection 管理页面默认使用简体中文。GitHub、
   OAuth、Connection、Consumer 和 Action 等必要领域术语保留英文。
5. OAuth authorization 等必须由 Authorization Server 直接生成的安全交互页继续由
   `connection-api` server-render，并使用中文文案；普通管理控制台 HTML 不再由 API 拼接。

## 影响

- Connection Web 可以独立部署和迭代，不依赖 Agora Agent Platform 的发布周期或登录状态。
- Public ingress 必须显式覆盖 SPA、Browser API、Direct Auth API 和 MCP 路由；缺少任一路由都属于部署
  契约失败。
- 独立部署单元增加一个镜像和健康检查，但不增加新的权威数据存储；所有账号、授权和凭证仍归
  Connection PostgreSQL 与 `connection-api`。
- 本 ADR 不关闭 KMS、LDAP active-state、egress、HA/PITR 或真实客户端 conformance 门禁。

## 证据

- [Connection M1 PRD](../prd/PRD-connection-M1.md) 的产品入口与中文 Web 验收标准。
- [M1 工程架构 Spec](../architecture/SPEC-agent-infra-M1-engineering-architecture.md) 的部署单元、页面模块和
  同源 Browser API 边界。
- [Connection M1 HLD](../architecture/HLD-connection-M1.md) 的 Direct Auth API、Browser API 与 WP9。
