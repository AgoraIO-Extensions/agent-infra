# agent-infra

[![CI](https://github.com/AgoraIO-Extensions/agent-infra/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/AgoraIO-Extensions/agent-infra/actions/workflows/ci.yml?query=branch%3Amain+event%3Apush)

企业级 Agent 平台 M1 的产品、工程设计与单仓库实现。

## 文档

- [企业级 Agent 平台 M1 产品需求](docs/prd/PRD-agent-platform-M1.md)
- [Connection M1 产品需求](docs/prd/PRD-connection-M1.md)
- [M1 工程架构 Spec](docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md)
- [Agent Runtime M1 HLD](docs/architecture/HLD-agent-runtime-M1.md)
- [Connection M1 HLD](docs/architecture/HLD-connection-M1.md)
- [ADR: Platform 服务与 Kubernetes Workload Plane 分离](docs/adr/0001-separate-platform-services-from-kubernetes-workload-plane.md)
- [ADR: Platform Secret 使用项目内置密文存储](docs/adr/0002-store-platform-secrets-as-application-ciphertext.md)
- [ADR: Wire Contract 使用 Zod authoring 与标准发布产物](docs/adr/0003-zod-authored-wire-contracts.md)
- [ADR: 将 Execution 有效模型选择绑定到 Runtime submit](docs/adr/0004-bind-execution-model-selection-to-runtime-submit.md)
- [ADR: Connection 使用单一账号级权威](docs/adr/0005-use-one-account-backed-connection-authority.md)
- [ADR: 独立部署 Connection Web](docs/adr/0006-deploy-connection-web-independently.md)
- [AI 主导开发工作流 Spec](docs/architecture/SPEC-ai-native-development-workflow.md)
- [M1 三层交付与汇合计划](docs/architecture/PLAN-M1-delivery-convergence.md)

## 当前状态

仓库已进入 M1 领域功能实现阶段，已交付 Platform 管理、配置、Conversation 持久化与
HTTP/SSE、RuntimeHost 和 Codex Driver 组件。主系统本地整装、真实 GitHub Pilot 和完整
M1 上线是独立验收层次，当前仍有未完成门禁，见交付与汇合计划。

| 部署单元 | 目录 | 当前能力 |
| --- | --- | --- |
| Web | `apps/web` | Agent 列表、申请/审批和 Owner 配置；对话页面与设计确认待交付 |
| Platform API | `apps/platform-api` | Agent 管理、配置、Conversation、审计 HTTP API 与 SSE |
| Platform Worker | `apps/platform-worker` | Conversation dispatch 和 Secret 装配；完整 Kubernetes 调谐待交付 |
| Agent RuntimeHost | `apps/agent-runtime-host` | HTTP/SSE Host、持久 store 与 Driver 组件；环境启动入口仍为 Fake，正式 Codex 镜像装配待交付 |
| Connection API | `apps/connection-api` | 独立 Hono 服务与健康检查 |

Connection 与 Platform 位于同一 monorepo。当前骨架已经分离进程、构建和镜像；后续实现按
工程架构 Spec 保持独立部署、运行身份和数据边界。

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

## 开发工作流

开发流转、角色权限、Worker 授权、门禁、失败恢复和通知规则见
[AI 主导开发工作流 Spec](docs/architecture/SPEC-ai-native-development-workflow.md)。

开始工作前请阅读 [AGENTS.md](AGENTS.md)。
