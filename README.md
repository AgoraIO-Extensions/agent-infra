# agent-infra

[![CI](https://github.com/AgoraIO-Extensions/agent-infra/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/AgoraIO-Extensions/agent-infra/actions/workflows/ci.yml?query=branch%3Amain+event%3Apush)

企业级 Agent 平台 M1 的产品、工程设计与单仓库实现。

## 文档

- [企业级 Agent 平台 M1 产品需求](docs/prd/PRD-agent-platform-M1.md)
- [Connection M1 产品需求](docs/prd/PRD-connection-M1.md)
- [M1 工程架构 Spec](docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md)
- [AI 主导开发工作流 Spec](docs/architecture/SPEC-ai-native-development-workflow.md)
- [Connection M1 HLD（Proposed for Design Review）](docs/architecture/HLD-connection-M1.md)
- [Connection 生产部署](docs/architecture/connection-production.md)
- [OpenConnector Kernel 构建记录](docs/architecture/openconnector-kernel-build.md)

## 当前状态

仓库包含 M1 工程底座，以及基于 PostgreSQL、公司 LDAP、Connection OAuth/PAT 和 pinned
OpenConnector GitHub kernel 的统一 Connection account 架构。所有 Consumer 都通过 Connection
识别 Principal；同一 Principal 在多台设备共享个人 Connection 和 Direct Consumer Grant。OAuth
设备会话和命名 PAT 可以单独撤销；同一 PAT 跨端复用时共享一个撤销与审计边界。OpenConnector
只作为进程内 Provider/Action/OAuth/executor Kernel，不保存产品账号、Credential 或授权权威。Connection
管理员使用 PostgreSQL role binding 管理共享 GitHub账号和显式 Principal eligibility；管理员角色不自动
获得共享账号使用资格，每个 eligible Principal 仍需独立确认 Consumer Grant。
独立 `connection-web` 使用 React 和生成的 OpenAPI Client 提供简体中文控制台，不属于 Agora Agent
Platform Web；`connection-api` 不再拼接管理页面 HTML。

| 部署单元 | 目录 | 当前能力 |
| --- | --- | --- |
| Agent Platform Web | `apps/web` | React、TanStack Router、Vite 与平台最小启动页 |
| Connection Web | `apps/connection-web` | 独立简体中文 React 控制台、生成 Browser Client 与同源 Nginx 入口 |
| Platform API | `apps/platform-api` | Hono 进程与健康检查 |
| Platform Worker | `apps/platform-worker` | 独立 Worker 进程与生命周期 smoke |
| Connection API | `apps/connection-api` | 正式 runtime 已装配 LDAP、OAuth/PAT、PostgreSQL、GitHub Adapter、Grant 与 MCP；G-01 未关闭时生产镜像仍只提供健康检查 |
| OpenConnector Kernel | `packages/openconnector-kernel` | 仅由 `openconnector-adapter` 使用的受控 Provider execution closure |

Connection 与 Platform 位于同一 monorepo。当前骨架已经分离进程、构建和镜像；后续实现按
工程架构 Spec 保持独立部署、运行身份和数据边界。

## 生产骨架

`docker-compose.production.yml` 定义门禁期生产骨架。由部署 Secret Manager 向进程环境注入
`DATABASE_URL` 并准备 PostgreSQL，然后运行：

```bash
pnpm connection:production:bootstrap
pnpm connection:production:up
```

bootstrap 只执行正式 migration。G-01 未关闭时，生产 API 只提供容器内部健康检查，不发布 LDAP、
OAuth、MCP、Provider、Credential 或 Action 路由。详见
[Connection 生产部署](docs/architecture/connection-production.md)。

## 本地验证

使用 Node.js 24 和 pnpm 11：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm check-types
pnpm test
pnpm build
pnpm smoke
pnpm docker:build
```

真实账号 conformance 使用本机忽略的 `.env.conformance.local`，或由 Secret Manager 注入
`.env.conformance.example` 中列出的参数后运行 `pnpm connection:conformance`。该命令启动
`runtime-app.ts` 定义的正式 Connection runtime 并采集验收证据；conformance 是测试过程，不是第二套
部署 profile 或业务实现。门禁关闭前该启动器与正式 runtime factory 都不进入生产镜像，测试结果也
不能替代 G-01/G-02 的审批与验收记录。

本机开发也使用 PostgreSQL 和同一账号模型，不启动 OpenConnector Runtime 或本机 Credential store。
本机由 Connection Web 占用 public origin `http://127.0.0.1:3002`，完整 Connection API 作为内部进程
监听 `3013` 并由 Vite 同源代理。使用两个终端启动：

```bash
PORT=3013 pnpm connection:conformance
pnpm dev:connection-web
```

浏览器访问 `http://127.0.0.1:3002/connection/login`。生产由 `connection-web` Nginx 对
`/api/v1/connection/*`、`/oauth/*`、`/.well-known/*` 和 `/mcp` 反向代理到 `connection-api`。
完成公司 LDAP、Connection identity key、Credential 加密和 HTTPS 配置后，Codex 或其他 MCP
Consumer 只配置 Connection。支持 OAuth 的客户端使用：

```toml
[mcp_servers.connection]
url = "https://connection.example.com/mcp"
```

执行 `codex mcp login connection` 后，Codex 通过 Connection OAuth 打开浏览器登录页。公司 LDAP
密码只提交给 Connection，不进入 Codex 配置。Provider OAuth callback、真实 LDAP 和目标 Codex
版本仍需按 HLD 记录脱敏 conformance 证据。

需要跨客户端或无头部署时，用户先访问 `https://connection.example.com/connection/login` 完成 LDAP
登录，再从中文控制台的“访问令牌”页面签发一次性展示的 Connection PAT。签发表单不会再次要求
LDAP 密码。消费端只引用 Secret Manager 或进程环境中的 token：

```toml
[mcp_servers.connection]
url = "https://connection.example.com/mcp"
bearer_token_env_var = "CONNECTION_TOKEN"
```

PAT 明文不写入仓库、普通配置文件或日志。多个客户端复用同一 PAT 时无法分别撤销或审计；需要独立
边界时分别签发命名 PAT。

## 开发工作流

开发流转、角色权限、Worker 授权、门禁、失败恢复和通知规则见
[AI 主导开发工作流 Spec](docs/architecture/SPEC-ai-native-development-workflow.md)。

开始工作前请阅读 [AGENTS.md](AGENTS.md)。
