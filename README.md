# agent-infra

[![Docs CI](https://github.com/AgoraIO-Extensions/agent-infra/actions/workflows/docs-ci.yml/badge.svg?branch=main&event=push)](https://github.com/AgoraIO-Extensions/agent-infra/actions/workflows/docs-ci.yml?query=branch%3Amain+event%3Apush)

企业级 Agent 平台 M1 的产品、工程设计与单仓库实现。

## 文档

- [企业级 Agent 平台 M1 产品需求](docs/prd/PRD-agent-platform-M1.md)
- [Connection M1 产品需求](docs/prd/PRD-connection-M1.md)
- [M1 工程架构 Spec](docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md)
- [AI 主导开发工作流 Spec](docs/architecture/SPEC-ai-native-development-workflow.md)
- [Connection M1 HLD（Proposed for Design Review）](docs/architecture/HLD-connection-M1.md)

## 当前状态

仓库已进入 M1 工程底座阶段。当前提交提供可安装、构建、测试和独立生成镜像的工程骨架，
尚未实现领域功能。

| 部署单元 | 目录 | 当前能力 |
| --- | --- | --- |
| Web | `apps/web` | React、TanStack Router、Vite 与最小启动页 |
| Platform API | `apps/platform-api` | Hono 进程与健康检查 |
| Platform Worker | `apps/platform-worker` | 独立 Worker 进程与生命周期 smoke |
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
