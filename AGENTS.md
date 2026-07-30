# agent-infra Repository Guidance

## Project Context

`agent-infra` 是企业级 Agent 平台。仓库当前处于 M1 设计评审阶段，尚未生成工程脚手架或业务代码。

## Source Of Truth

按以下顺序读取与维护文档：

1. [Agent 平台 M1 PRD](docs/prd/PRD-agent-platform-M1.md)：产品范围、行为和验收标准。
2. [Connection M1 PRD](docs/prd/PRD-connection-M1.md)：Connection 的产品范围、授权和隔离标准。
3. [M1 工程架构 Spec](docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md)：技术栈、部署单元、模块接口和工程约束。

PRD 是产品结论的权威来源，工程 Spec 是实现边界的权威来源。两者冲突时不要自行选择，先明确冲突并修正文档。

本地 `archive/` 与 `research/` 已被 Git 忽略，只用于保留历史和调研证据，不是当前需求或架构依据。不要把其中的旧结论恢复到正式文档。

## Repository Layout

- `docs/prd/`：正式产品需求，只写已确认的产品结论。
- `docs/architecture/`：工程架构和跨模块技术决策。
- `README.md`：面向团队的仓库入口和文档导航。
- `AGENTS.md`：编码 Agent 的全仓工作规则。

工程初始化后，代码目录遵循架构 Spec 中定义的 `apps/`、`packages/`、`migrations/`、`deploy/` 和 `tests/` 边界。不要在脚手架生成前创建占位目录。

只有某个子项目出现稳定且不同的命令、语言或安全约束时，才在该目录增加嵌套 `AGENTS.md`。嵌套文件只写差异，不复制根文件。

## M1 Scope Discipline

- 不把 Roadmap 能力提前加入 M1。
- 不因历史稿存在某项需求就自动恢复该需求。
- 产品 PRD 不记录讨论过程、实现术语或未确认观点。
- 工程实现细节进入架构 Spec、ADR 或代码契约，不进入产品 PRD。
- 修改一个系统的接口或数据归属时，检查另一份 PRD 和工程 Spec 是否需要同步。

## Engineering Baseline

- 全 TypeScript，Better-T-Stack 只用于初始化工程骨架。
- Web 使用 React、TanStack Router 和 Vite。
- 后端使用 Hono 与 Node.js LTS。
- PostgreSQL 与 Drizzle 保存权威业务数据。
- 浏览器和内部接口使用 OpenAPI HTTP/JSON；对话增量使用 SSE。
- pnpm workspace 与 Turborepo 管理单仓库任务。
- Agent 平台与 Connection 使用独立模块、数据库账号和部署单元。

改变语言、权威数据归属、部署单元、身份传递、Connection 授权或 Agent Runtime Contract 前，先更新工程 Spec；实现阶段通过 ADR 记录已批准的架构变更。

## Module Boundaries

- `apps/*` 只负责进程启动、依赖装配和协议接入。
- 领域规则不能直接写在 Hono 路由、React 页面、Drizzle 查询或 Kubernetes Adapter 中。
- 平台产品状态以 Platform DB 为准，Kubernetes 只保存实际运行状态。
- Connection 凭证与外部账号属于 Connection；Agent、模型和浏览器不能获得原始凭证。
- 当前用户、组织、Agent 和 Connection 授权必须由服务端解析，不能信任调用方提交的身份字段。
- 只在存在两个真实 Adapter 时增加可替换接口，避免没有实际变化点的抽象。

## Documentation Rules

- 使用简洁、明确的中文，保留必要的英文技术名词。
- 一个结论只在一份权威文档中完整表述；其他文档使用相对链接引用。
- 修改文件路径或标题时，同步检查全部相对链接。
- 不提交聊天记录、调研过程、临时方案、个人路径或机器状态。
- `archive/` 和 `research/` 保持本地且不进入 Git 历史。

## Current Validation Commands

仓库仍是文档阶段。修改文档后，从仓库根目录执行：

```bash
pnpm dlx markdownlint-cli2 README.md AGENTS.md "docs/**/*.md"
pnpm dlx markdown-link-check README.md
pnpm dlx markdown-link-check <changed-file.md>
git diff --check
```

对每个修改过且包含链接的 Markdown 文件运行 `markdown-link-check`。工程脚手架生成后，用真实的 `package.json` 脚本替换本节，不提前编造安装、构建或测试命令。

## Security

- 不提交 Token、API Key、OAuth Secret、真实凭证或包含它们的示例。
- `.env` 只保留本地；需要说明配置时提交脱敏的 `.env.example`。
- 日志、错误、测试 fixture 和文档不得包含外部账号凭证或普通用户会话正文。
- 任何跨用户、跨 Agent 或跨 Connection 的访问都必须有负向测试。

## Git And Review

- 保持改动范围与当前任务一致，不顺手恢复本地历史材料或重构无关文档。
- 提交前检查 `git status`、完整 diff 和上述验证命令。
- Commit 使用简洁的 Conventional Commit，例如 `docs: refine M1 architecture`。
- 未经用户明确要求，不执行 force push、历史重写或破坏性清理。

## StaticSpaces Publication

只有以下正式 PRD 同步到 shared space `agent-infra`：

- `docs/prd/PRD-agent-platform-M1.md`
- `docs/prd/PRD-connection-M1.md`

通过 StaticSpaces Publish API 发布原始 Markdown，不生成 `index.html`，不上传 `README.md`、工程 Spec、`AGENTS.md`、研究材料或归档。发布后比较 bytes 与 SHA-256，并回读远端文件列表；评审入口使用 API 返回的 `review_url`。
