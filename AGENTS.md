# agent-infra Repository Guidance

## Project Context

`agent-infra` 是企业级 Agent 平台。仓库已进入 M1 工程底座阶段，脚手架已生成，领域功能尚未实现。

## Source Of Truth

按以下顺序读取与维护文档：

1. [Agent 平台 M1 PRD](docs/prd/PRD-agent-platform-M1.md)：产品范围、行为和验收标准。
2. [Connection M1 PRD](docs/prd/PRD-connection-M1.md)：Connection 的产品范围、授权和隔离标准。
3. [M1 工程架构 Spec](docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md)：技术栈、部署单元、模块接口和工程约束。
4. [AI 主导开发工作流 Spec](docs/architecture/SPEC-ai-native-development-workflow.md)：开发责任、人工检查点、Agent 分工和自动化边界。

PRD 是产品结论的权威来源，工程 Spec 是实现边界的权威来源，开发工作流 Spec 是交付流程的权威来源。文档冲突时不要自行选择，先明确冲突并修正文档。

Connection 相关工作还必须遵守 [Connection M1 HLD](docs/architecture/HLD-connection-M1.md)。实现、测试、部署配置和文档都要先映射到适用的 HLD 条款；发现与 HLD、PRD 或工程 Spec 的偏差、缺失门禁或相互冲突时，先报告并取得 HLD/ADR 的明确更新或评审批准。不得以开发 fixture、环境变量、部署说明或兼容性开关绕过 HLD 的门禁。

本地 `archive/` 与 `research/` 已被 Git 忽略，只用于保留历史和调研证据，不是当前需求或架构依据。不要把其中的旧结论恢复到正式文档。

## Agent skills

### Issue tracker

实现工作使用 `AgoraIO-Extensions/agent-infra` GitHub Issues 跟踪；正式 PRD 和工程 Spec
仍以仓库文档为准，PR 不作为需求入口。参见
[Issue Tracker](docs/agents/issue-tracker.md)。

### Triage labels

Skills 使用 `needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human` 和
`wontfix`；执行授权和人工验证的正式语义仍以开发工作流 Spec 为准。参见
[Triage Labels](docs/agents/triage-labels.md)。

### Domain docs

采用 single-context 布局；稳定的领域词汇进入根 `CONTEXT.md`，跨模块技术决策进入
`docs/adr/`，两者只补充而不覆盖 PRD 和工程 Spec。参见
[Domain Docs](docs/agents/domain.md)。

## Repository Layout

- Rehoboam v14 continuation READ returns confirmation/delivery steps, template-controlled numeric suffix replacement suggestions and downstream references. No version reservation, creation, notices or runs. Use existing replacement preview/confirm and explicitly select new upstream results. Completion comes from Rehoboam final-notice receipts, never Job success.

- Rehoboam Provider v14 adds explicit `record_release_family_repair` for every family stage (Jobs, manual PR, tests/results, decisions and delivery). Rehoboam owns nonterminal-task checks, revision/template guards and audit. Generic resolved evidence needs a validation link; compile evidence retains PR/full commit/CI requirements. Records are operator-reported and never advance tasks, change Jobs, send messages or edit source. Diagnose first; source changes need explicit user direction, without requiring users to declare a local checkout. v13 implementation remains immutable.

- `apps/`：Web、Platform API、Platform Worker 与 Connection API 的进程入口。
- `packages/`：被多个真实调用方复用的配置、领域或 Adapter 模块。
- Connection Provider 在 `packages/openconnector-adapter/src/providers/<名称>/` 维护 actions/definition/executors 入口；已发布源码及测试在 versions 中保持原字节。旧 src 文件只作兼容导出，源码位置校验使用 provider-source-layout.json。参见 [连接器目录](docs/connection/provider-layout.md)。
- `tests/`：跨应用 smoke、契约、集成、端到端和负载测试入口。
- `docs/prd/`：正式产品需求，只写已确认的产品结论。
- `docs/architecture/`：工程架构和跨模块技术决策。
- `docs/agents/`：Agent 操作入口，只引用正式工作流，不重复定义流程状态。
- `README.md`：面向团队的仓库入口和文档导航。
- `AGENTS.md`：编码 Agent 的全仓工作规则。

新增代码目录遵循架构 Spec 中定义的 `apps/`、`packages/`、`migrations/`、`deploy/` 和 `tests/` 边界。不要创建没有实际实现的占位目录。

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

- Rehoboam v16 帮助 Actions 只检索已发布参考或保存/读取待审核候选；Rehoboam 拥有文章、content_hash、owner 与幂等。候选验证是提交人报告，不得自动推广为正式规则。用户确认后提交，正式帮助通过 PR 审核/部署更新。维护新 Action 时同步 HLD 与 `docs/connection/rehoboam-help.md`，旧版本实现不变。

- 使用简洁、明确的中文，保留必要的英文技术名词。
- 一个结论只在一份权威文档中完整表述；其他文档使用相对链接引用。
- 修改文件路径或标题时，同步检查全部相对链接。
- 不提交聊天记录、调研过程、临时方案、个人路径或机器状态。
- `archive/` 和 `research/` 保持本地且不进入 Git 历史。

## Connection 用户文档同步

Connection 用户可见功能发生变化时，同一 Issue/PR 必须检查并同步对应教程、帮助和 Agent 接入说明，
包括操作步骤、默认值、权限与审批条件、错误恢复和实际页面入口。文案以当前 PRD/HLD 为准，
不能把条件流程写成所有用户必经步骤。

- 帮助页内容源：`apps/connection-web/src/features/user-guide/content.ts`；修改后运行
  `pnpm --filter @agent-infra/connection-web guide:generate`，同步生成的
  [用户手册](docs/guides/connection-user-manual.md)，并检查帮助页中的链接。
- Codex 安装入口：`apps/connection-web/public/connection/index.html` 与
  `apps/connection-web/public/llms.txt`。
- 通用 Agent 接入入口：`apps/connection-web/public/connection/agent/index.html` 与
  `apps/connection-web/public/connection/agent/llms.txt`；人读页面和机器说明都需核对。
- 检查 README 导航及相关页面引导；变更路径时同步链接。适用的生成产物必须通过一致性校验。

授权规则变化时，还须核对适用 PRD/HLD/Spec；行为结论只在权威文档中定义，教程与 Agent 指南保持一致。

PR 描述列出已更新的文档入口；无需修改的入口说明原因。提交文档、生成产物和部署后的在线内容
是不同结果，不得将本地修改描述为线上教程已更新。

## Current Validation Commands

修改仓库内容后，从仓库根目录按顺序执行：

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm check-types
pnpm test
pnpm build
pnpm smoke
npx --yes markdownlint-cli2@0.23.2 README.md AGENTS.md ".github/**/*.md" "docs/**/*.md"
find README.md AGENTS.md .github docs -type f -name '*.md' -print0 | while IFS= read -r -d '' file; do
  npx --yes markdown-link-check@3.15.0 --config .markdown-link-check.json "$file"
done
node .github/scripts/verify-workflow-policy.mjs
.github/scripts/run-actionlint.sh
git diff --check
```

Docker 镜像构建由 CI 必跑，本地不作为必跑检查，也不默认执行。只有用户明确要求容器调试或
主动选择本地镜像验证时才运行 `pnpm docker:build`；不得为满足本地验证自动清理镜像、缓存或
volume。本地省略 Docker 不替代当前 PR head 的 CI 镜像构建和正式发布门禁。

## Security

- GitHub 当前发布为 v10，保留 v9 源码及运行路由；v10 仅恢复 Kernel 包装错误中的原始
  HTTP 状态。405/409 等拒绝走现有确定性失败，真实 5xx/断线仍为 UNCERTAIN，不自动重试。

- Rehoboam 渠道取消 v15 仅取消本人的未获批申请；原生权限、状态 CAS 和回执真值在 Rehoboam，
  不能用 Pipeline Center 撤回或审批驳回代替。边界见已批准的渠道取消 ADR。

- 不提交 Token、API Key、OAuth Secret、真实凭证或包含它们的示例。
- `.env` 只保留本地；需要说明配置时提交脱敏的 `.env.example`。
- 日志、错误、测试 fixture 和文档不得包含外部账号凭证或普通用户会话正文。
- 任何跨用户、跨 Agent 或跨 Connection 的访问都必须有负向测试。

## Git And Review

### Connection 发布入口

Connection 现网已迁到上海，权威数据库亦在上海；GZ3 release 已退役。执行部署前必须阅读
[Connection 生产部署](docs/architecture/connection-production.md#发布步骤)。使用
`pnpm connection:release`、干净且等于最新 `origin/connection` 的 release worktree、显式
上海 kubeconfig 和兼容 kubectl；不能按默认 context 或旧 GZ3 脚本猜测目标。
保留 `connection-database-shanghai`、`connection-config`、RDS CA 挂载及单主策略，常规发布
只更换镜像。不得恢复旧库或 GZ3、自动扩大 Provider 授权、以 bootstrap 或环境开关绕过迁移门禁。

新增 SQL/journal 的发布使用生产文档中的 `--reviewed-migrations-pr` 显式路径，校验已合并 PR
的精确迁移来源，不重复检查该 PR 的 CI/review 状态。仅允许 schema Job，成功账本回执之前
不得更新镜像；失败/未知 Job 不自动重试。

### 提交与评审

- 所有可能产生 PR 的工作遵循 [AI 主导开发工作流 Spec](docs/architecture/SPEC-ai-native-development-workflow.md#2-基本原则) 的 `Issue -> 实现与验证 -> PR` 规则；创建任务分支、修改文件或提交代码前，必须先确认内容完整的 primary Issue。
- 保持改动范围与当前任务一致，不顺手恢复本地历史材料或重构无关文档。
- 提交前检查 `git status`、完整 diff 和上述验证命令。
- Commit 使用简洁的 Conventional Commit，例如 `docs: refine M1 architecture`。
- 未经用户明确要求，不执行 force push、历史重写或破坏性清理。

## StaticSpaces Publication

只有以下正式 PRD 同步到 shared space `agent-infra`：

- `docs/prd/PRD-agent-platform-M1.md`
- `docs/prd/PRD-connection-M1.md`

通过 StaticSpaces Publish API 发布原始 Markdown，不生成 `index.html`，不上传 `README.md`、工程 Spec、`AGENTS.md`、研究材料或归档。发布后比较 bytes 与 SHA-256，并回读远端文件列表；评审入口使用 API 返回的 `review_url`。
