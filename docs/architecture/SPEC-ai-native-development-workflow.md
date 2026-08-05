# agent-infra AI 主导开发工作流 Spec

## 1. 文档目的

本文定义 agent-infra 的开发流转、AI Agent 分工、人工检查点和自动化边界。它适用于产品、
架构、代码、测试、迁移和 CI 变更，不改变 Agent 平台 M1 的产品范围或运行时架构。

本文同时描述目标流程和分阶段实施顺序。只有已经合并到默认分支并完成验证的自动化能力，
才视为仓库当前能力。

## 2. 基本原则

- 所有开发工作从 GitHub Issue 开始，并通过一个主要 Issue、一个实现 PR 完成追踪。
- AI 负责需求梳理、实现、自检和独立评审；人负责确认需求、必要的真实测试和最终批准。
- GitHub Issue、PR、Check、Review 和分支保护是流程状态的权威来源。
- 确定性检查优先于模型判断。AI 不能覆盖 CI、人工批准或分支保护结果。
- 自动化失败必须停止或转人工处理，不能无限重试。
- 所有人和 AI 创建的 PR 使用相同的合并门禁。
- 当前不建设独立的 Loop Engine、Graph Engine 或通用开发调度平台。

## 3. 权威依据

开发工作按以下顺序确定依据：

1. 产品行为以 [Agent 平台 M1 PRD](../prd/PRD-agent-platform-M1.md) 和
   [Connection M1 PRD](../prd/PRD-connection-M1.md) 为准。
2. 运行架构和模块边界以
   [M1 工程架构 Spec](SPEC-agent-infra-M1-engineering-architecture.md) 为准。
3. 开发流转和自动化边界以本文为准。
4. 已确认的 Issue、ADR 和接口契约只能细化上级文档，不能隐式修改上级结论。
5. `AGENTS.md` 和 Skills 提供执行方法，不是产品或架构事实源。

发现冲突或验收标准无法确定时，AI 停止实现并在 Issue 中说明需要确认的内容。

## 4. 参与方与职责

### 4.1 人

- 创建或确认 Issue 的目标、范围和验收标准。
- 在本地 Codex 梳理完成后，决定 Issue 是否进入自动实现。
- 评审设计、代码和 AI findings。
- 执行不能由自动化测试充分覆盖的真实环境验证。
- 提交至少一个符合分支保护要求的 Approve。

### 4.2 本地 Codex

- 使用项目 Skills 对 Issue 进行 triage、追问、形成 Agent Brief、Spec 和 tickets。
- 在人确认后，使用当前操作者的 GitHub 身份为 Issue 添加 `ready-for-agent`。
- 不在无人监督的 GitHub Actions 中执行需求 grilling。

### 4.3 GitHub Actions 中的 Codex

- 领取符合条件的 `ready-for-agent` Issue。
- 在隔离工作区完成实现和自检，向可信发布 job 提供固定 Patch Artifact，不直接写入远端
  branch 或 PR。
- 按授权触发修复，不批准或绕过自己的 PR。
- 通过结构化输出向可信发布 job 提供变更摘要和验证结果。

### 4.4 Claude

- 自动给新 Issue 提供需求完整性建议。
- 在确定性 CI 通过后独立 Review PR。
- 可以报告问题和建议人工验证，不能 Approve、Merge、修改代码或直接改变流程标签。

### 4.5 确定性系统

- CI 执行格式、静态检查、测试、构建和工作流策略检查。
- Issue Gate 校验 PR 与来源 Issue 的关系和状态。
- Human Validation Gate 校验是否仍有待完成的人工验证。
- GitHub 分支保护校验 Approve、required checks 和评论解决状态。

## 5. Issue 流程

### 5.1 Issue 创建与 Claude Review

- 仓库成员创建 Issue 后，Claude 自动进行一次只读 Review 并评论建议。
- 外部用户创建的 Issue 不自动调用模型；仓库成员添加 `claude` 标签后才触发 Review。
- Issue 中的 `@claude` 可以请求补充分析。
- Claude Issue Review 只提供建议，不改变 Issue 状态，也不是进入实现的门禁。
- Issue 事件先由默认分支中的可信步骤判断成员身份或 `claude` 标签授权；只有授权通过的
  模型步骤才能读取 Claude Secret。外部 Issue 内容不能参与授权判断或组成可执行命令。
- 新建 Issue 事件未提供可信成员关系时，可信步骤通过 GitHub API 回读作者对仓库的权限。
  只有 `triage`、`write`、`maintain` 或 `admin` 权限可以触发自动 Review；公开仓库默认的
  `read` 权限不属于可信成员。查询失败时不执行模型步骤。查询使用的 GitHub Token 只进入
  可信步骤，且请求目标和授权判断不受 Issue 内容控制。

### 5.2 本地需求梳理

需求梳理由成员在本地 Codex 中完成。优先复用
[mattpocock/skills](https://github.com/mattpocock/skills/tree/2ab958093e83e0ec752e6c1c5932da465bf23e0c)
commit `2ab958093e83e0ec752e6c1c5932da465bf23e0c` 中适用的 `triage`、`grilling`、
Agent Brief、`to-spec` 和 `to-tickets` 能力，不重复建设同类流程。

进入实现前，Issue 至少要明确：

- 要解决的问题和不在范围内的内容。
- 可观察的验收标准。
- 已知依赖和阻塞关系。
- 预期验证方式。

### 5.3 实现标签

| 标签 | 用于 Issue 时的含义 |
| --- | --- |
| `ready-for-agent` | 需求已由人确认，可以由 Codex 自动实现 |
| `ready-for-human` | 该 Issue 由人实现，不进入 Codex 自动领取流程 |
| `needs-triage` | 需要重新梳理需求或处理状态 |
| `wontfix` | 不再实施，并终止对应的自动执行 |
| `claude` | 由成员授权 Claude 分析外部用户创建的 Issue |

`ready-for-agent` 只能由人或由人监督的本地 Codex 添加。无人值守的 GitHub Actions 不能
自行添加该标签。

### 5.4 可执行 Issue

Codex 只领取同时满足以下条件的 Issue：

- Issue 处于打开状态并带有 `ready-for-agent`。
- 不带 `ready-for-human`、`needs-triage` 或 `wontfix`。
- 必须存在 `## Blocked by`；其中只包含 `- #<issue-number>` 格式的依赖且均已关闭，或只写
  `None` 表示没有 blocker。章节缺失或使用其他格式时视为需要重新梳理。
- 当前没有该 Issue 的其他活动执行，也没有已进入 Ready for review 的未合并 Worker PR；固定
  branch 和现有 Draft PR 只能属于同一个 Issue 并可被复用。

满足这些条件的 Issue 称为 frontier Issue。多个互不阻塞的 frontier Issue 可以并行执行。

## 6. Codex 实现流程

### 6.1 执行方式

- 使用官方 [`openai/codex-action`](https://github.com/openai/codex-action)。
- 直接调用项目级 `implement` Skill，不额外包装一套重复的实现方法。
- Codex Worker 使用一个 workflow，内部包含相互隔离的 `implement` 和 `publish` job。
- 每个 Issue 使用 `codex/issue-<number>` 固定 branch、一个并发组和最多一个未合并 PR。
- 首次执行以当时的默认分支 head 为起始 commit；已有固定 branch 时以该 branch head 为起始
  commit。发布只允许在该起始 commit 上增加普通 commit 并 fast-forward，不使用 force push。
- `implement` job checkout 记录的起始 commit；恢复执行时，该 commit 即发布前校验通过的固定
  branch head。无论起始 commit 来自默认分支还是固定 branch，checkout 都不保留凭证，工作区
  内容都按不可信代码处理。
- `implement` job 在只读 GitHub 权限下完成实现、自检和结果导出，不提交远端变更。
- `publish` job 在新的 Runner 上校验实现结果，创建或复用 Draft PR，并在发布完成后标记为
  Ready for review。

移除 `ready-for-agent` 会取消当前运行，但保留 branch 和 PR。`publish` 在每次远端写入前重新
校验 Issue 状态；重新添加后，仅在没有 PR 或现有 PR 仍为 Draft 时恢复执行，已进入 Ready for
review 的 PR 只恢复 Issue Gate，不启动新的模型运行。Issue 被关闭或添加 `wontfix` 后，自动
关闭该 Issue 的所有未合并 Worker PR，且不再添加 `needs-triage` 或失败评论。除此情形外，PR
未合并而被关闭，或发布校验失败时，Worker 保留 `ready-for-agent`、添加 `needs-triage`，并用
固定格式评论说明可公开的失败原因；移除 `needs-triage` 后才能重新执行。

### 6.2 执行环境与权限

- 可信默认分支的 `.codex/config.toml` 定义名为 `github-worker` 的 permission profile。Worker
  通过官方 Action 的 `codex-home` 和 `permission-profile` 输入选择它；该 profile 继承
  `:workspace`，只允许写入 checkout workspace，允许完整公网访问，禁止本地和私有网络访问。
- 官方 Codex Action 固定到完整 commit SHA，Codex CLI 固定到支持 permission profile 的明确
  版本，且不得低于 `0.138.0`；同时使用 `safety-strategy: drop-sudo`。
- `implement` job checkout 起始 commit 时必须设置 `persist-credentials: false`，job 权限仅为
  `contents: read`，不得把 `GITHUB_TOKEN` 或其他仓库凭证写入 workspace、Git 配置或模型环境。
- 模型只获得完成实现所需的代码工作区和工具，不获得用于发布 GitHub 变更的 PAT。
- API Key、Responses endpoint、模型和 effort 使用 GitHub Actions Secrets 配置，并与
  fine-grained GitHub PAT 分开保存。
- `CODEX_API_KEY` 只传给 `implement` job 中的官方 Codex Action；该 Action 之后只允许固定
  commit SHA 的 Artifact Action 上传固定路径，不运行 shell 命令，也不引入仓库写凭证。
- `CODEX_GITHUB_TOKEN` 只传给 `publish` job 中固定的 Git push 和 PR 发布步骤，以及
  Auto-merge enrollment 中固定的原生 auto-merge 启用步骤；不进入 job 级环境、模型环境，
  也不写入 remote URL 或命令参数。使用该 PAT 是为了让自动创建、推送或合并的变更正常触发
  现有 GitHub Actions；由 `GITHUB_TOKEN` 执行的变更不会触发所需的后续 workflow。
- workflow policy 按 Secret 名称和 job/Action 身份分别维护允许位置，并验证模型 job 不包含
  `CODEX_GITHUB_TOKEN`、发布 job 不包含 `CODEX_API_KEY`，不能放宽为允许任意固定 SHA Action。
- Issue 标题、正文等不可信内容只能经 `env` 或固定输入文件传递，不能插入 `run:` 或参与
  endpoint、模型、permission profile、分支名和命令的生成。
- Codex 模型 job 只有超时使用仓库变量 `CODEX_WORKER_TIMEOUT_MINUTES` 配置，默认 `60` 分钟。
  endpoint、模型、effort 和超时在调用前按固定类型、枚举和格式校验，不能由 Issue 内容覆盖。
- 当前不处理来自外部 fork 的 PR。

### 6.3 实现结果交接

`implement` job 输出固定名称的 Patch Artifact 和 Schema 校验后的结果 JSON。JSON 不超过
256 KiB，各文本字段设置独立长度上限；结果至少包含：

- Issue 编号、起始 commit SHA 和固定 branch。
- 变更摘要与验收标准完成情况。
- 已执行和未执行的检查。
- 是否需要人工验证及验证内容。

`publish` job 在新的 Runner 上重新 checkout 起始版本，在获得 GitHub PAT 前完成以下校验：

- Issue 仍满足 frontier 条件，目标 branch 和 PR 属于当前 Issue。已有 branch 的远端 head 必须
  等于起始 commit；首次发布时固定 branch 必须尚不存在。模型运行期间默认分支可以前进，
  合并冲突由 GitHub PR 检测；Stage 2 不自动验证 Worker PR 与最新默认分支的兼容性。
- Patch 不超过 400 KiB，不包含二进制内容、路径穿越、符号链接、gitlink/submodule、可执行位
  或其他文件模式变更。
- Patch 不修改 `.github/`、`.codex/`、`.claude/`、`.agents/skills/`、任意层级的 `AGENTS.md`
  或 `CLAUDE.md`、`.mcp.json`、`.gitattributes`、`.markdownlint-cli2.jsonc` 和
  `.markdown-link-check.json`。
- Patch 不修改任意层级的 `.npmrc` 或 `package.json`，也不修改 `pnpm-workspace.yaml`、
  `pnpm-lock.yaml`、`package-lock.json` 或 `npm-shrinkwrap.json` 等决定依赖与 CI 工具解析的文件。
- Patch 不修改 `docs/prd/` 或 `docs/architecture/` 中的权威产品与架构文档。
- 上述信任边界只能由人创建的 PR 修改。
- Patch 能在干净工作区完整应用，结果 JSON 字段、长度和枚举值符合 Schema。

发布 job 不执行 Patch 引入的代码、脚本或测试。Patch 应用后只调用固定的 Git 和 PR 操作；
真正的构建、测试和 Review 由新 PR 上的现有门禁执行。校验失败时不发布新的 commit 或 PR，
只执行前述固定的转人工状态更新。

### 6.4 PR 内容

可信发布 job 生成固定结构的 PR 正文，至少包含：

- `Closes #<primary-issue>`。
- 变更摘要。
- 验收标准完成情况。
- 已执行测试。
- 是否需要人工验证及验证内容。
- 未执行检查、风险和限制。

每个 PR 必须且只能声明一个 primary Issue。可以引用其他 Issue 作为上下文，但不能再使用
会自动关闭 Issue 的关键字。模型提供的所有文本在进入 PR 正文或评论前统一净化：关闭关键字、
`@` mention、HTML comment 和 Markdown fence 不能改变 primary Issue、触发其他 Agent 或隐藏
额外内容。`ready-for-human` 只接受 Schema 中的布尔值，模型不能提供任意标签名。

## 7. PR 检查与 Claude Review

### 7.1 确定性 CI

PR 首先运行仓库定义的确定性 CI。Claude 只 Review 当前 head 上 CI 已通过的 PR。Runner、
Action 或网关基础设施失败时，不触发 Codex 修改代码。

### 7.2 Issue Gate

Issue Gate 是 required check，并在每个 PR head 上校验：

- PR 只关联一个 primary Issue。
- primary Issue 存在、仍处于打开状态且不带 `wontfix`。
- head branch 符合 `codex/issue-<number>` 的 Worker PR，其 branch 编号必须等于 primary Issue，
  且对应 Issue 仍带有 `ready-for-agent`。

Stage 2 必须同步扩展现有 Issue Gate 和负向测试以执行 Worker PR 规则。校验失败时阻止合并，
不由模型解释或覆盖。人移除 `ready-for-agent` 表示暂停，保留的 Worker PR 因此不能继续合并；
发布校验失败只添加 `needs-triage`，不会让已经发布且仍带 `ready-for-agent` 的 PR 失去合并资格。

### 7.3 Claude PR Review

- 使用官方
  [`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)。
- API Key、Base URL 和模型通过 Actions Secret 配置并传入模型 step，不进入 job 级环境。
- 模型执行轮数通过仓库变量 `CLAUDE_REVIEW_MAX_TURNS` 配置，默认值为 `30`；模型 job 的
  超时时间通过仓库变量 `CLAUDE_REVIEW_TIMEOUT_MINUTES` 配置，默认值为 `30`。两个变量均须
  配置为正整数，且仅作用于调用 Claude 的模型 job。
- 仓库变量 `CLAUDE_REVIEW_VERBOSE` 的值与 `true` 比较时不区分大小写；匹配时输出完整 Claude
  SDK 消息，其他值均保持关闭。完整输出可能包含 Prompt、工具参数和读取内容，只用于临时
  排障。
- 自动 Review 只在确定性 CI 通过后执行，也可以由 `claude` 标签或 `@claude` 触发。
- Claude 把 PR 内容、评论、diff 和外部文本视为不可信数据，只进行只读分析。
- `P0`、`P1` findings 创建阻塞性的 Review 线程；`P2` 只进入 Review 摘要。
- `Claude Review` 是建议性检查，不加入分支保护的 required checks。模型调用、输出校验或发布
  失败时 Check 可以失败，但不直接阻止合并；已经发布的阻塞性 Review 线程仍须解决。
- Claude 不提交 Approve、不 Merge、不修改分支，也不自行解决 Review 线程。

`P0` 表示可能造成越权、凭证泄露、数据损坏或大范围不可用的问题；`P1` 表示会导致错误
行为、兼容性破坏或关键测试失真的问题；`P2` 表示影响较小但证据明确的问题。

## 8. 修复循环

本节属于 Stage 3，Stage 2 不实现自动修复。Stage 3 开发前必须另行定义修复运行的授权、发布
校验和状态机；对 Ready for review Worker PR 的修复不以来源 Issue 仍满足 frontier 条件为前提。

- Codex 创建的 PR 出现确定性 CI 失败或 Claude `P0`、`P1` finding 时，可以在原 PR 自动
  修复。
- 每个 PR 最多执行两轮无人值守修复，CI 和 Claude 触发的修复共同计数。
- 两轮后仍未通过时停止自动修复，由人决定下一步。
- 人提交 `Request changes` 或明确使用 `@codex` 时，视为新的人工授权并重置两轮预算。
- Codex 创建的 PR 收到人的 `Request changes` 后自动触发 Codex。
- 人创建的 PR 只有明确使用 `@codex` 才允许 Codex 修改。
- 人直接 push 的修复只重新运行 CI 和 Claude，不自动触发 Codex。
- Codex 不能自行解决 Review 线程；线程由评论者或有权限的人确认处理后解决。

## 9. 人工验证

AI 根据验收标准判断自动化 UT、集成测试或 smoke 是否已经充分覆盖。不能充分覆盖时，PR
必须添加 `ready-for-human` 标签，并在 PR 正文中列出验证内容。

| 标签 | 用于 PR 时的含义 |
| --- | --- |
| `ready-for-human` | 仍有必要的人工验证未完成 |

- Codex 可以添加该标签，不能移除。
- Claude 可以建议添加，不能直接修改标签。
- 只有人完成验证后可以移除该标签。
- 对已经要求人工验证的 PR，出现新 commit 后必须自动重新添加该标签。
- Approve 表示代码评审完成；移除 `ready-for-human` 表示人工验证完成，两者不能互相替代。

Human Validation Gate 是 required check。标签存在时失败，标签不存在时通过。手工移除标签
是允许的人工确认方式，但不会跳过 CI、Approve、阻塞性 Review 线程或其他分支保护规则。

## 10. 合并规则

所有 PR，不区分由人还是 AI 创建，必须同时满足：

- Issue Gate 通过。
- 当前 head 的确定性 CI 通过。
- Human Validation Gate 通过。
- 至少一名符合分支保护要求的人提交 Approve。
- 所有阻塞性的 Review 线程已解决。

满足门禁后使用 GitHub 原生 Squash Auto-merge。仓库不实现自定义 Merge job，AI 不能批准
自己的 PR，也不能绕过 required checks 或分支保护。

`main` 分支保护必须将 `Docs CI`、`Issue Gate`、`Human Validation Gate`、至少一名人工
Approve 和评论解决同时设为合并门禁。Auto-merge 自动化只负责为 PR 启用 GitHub 原生
Squash Auto-merge，不重复判断或替代这些门禁。

Auto-merge enrollment 使用独立的 `pull_request_target` workflow，并只处理打开、重新打开或
转为 Ready 的 PR。PR 必须处于打开、非 Draft 状态，目标为默认分支，且 head 属于当前仓库；
PR 作者可以是人、AI 或 Bot。workflow 只 checkout 默认分支，不读取或执行 PR head。已经
启用 auto-merge 时按成功处理；人手工关闭后，后续 commit 不会自动重新启用。Squash 标题和
提交信息沿用仓库默认配置。

## 11. 安全边界

- GitHub Actions 默认使用只读 `GITHUB_TOKEN`，写权限按 job 明确声明。
- 第三方 Actions 固定到完整 commit SHA，不使用浮动 tag。
- `pull_request_target` 只用于默认分支中的元数据门禁，不 checkout 或执行 PR 内容。
- Auto-merge enrollment 使用单独的 PR 级并发组，job 的默认 `GITHUB_TOKEN` 只有可信
  checkout 所需的 `contents: read`；固定启用步骤使用 `CODEX_GITHUB_TOKEN` 调用原生
  auto-merge，不能调用直接合并或管理员绕过接口。
- Codex Worker 的模型 job 与发布 job 使用不同 Runner；模型 job 不获得仓库写凭证，发布
  job 只接受经过校验的固定 Artifact，且不执行其中的代码。
- Claude PR Review 的模型分析 job 与持有 GitHub 写凭证的发布 job 分离。
- Issue 建议和 `@claude` 回复复用官方 Action 的评论机制，禁止模型使用文件写入和 Bash，
  只保留官方 Action 对当前评论的受控更新。
- 模型输出必须经过 Schema 和目标状态校验，不能直接组成任意 GitHub API 请求。
- Actions 不能提交 Approve，不能修改分支保护，也不能获取生产凭证。
- Secrets 不写入日志、评论、PR 正文、测试 fixture 或模型结构化输出。

## 12. 分阶段实施

### Stage 1：Issue 与 Review 基线

- 创建标准标签。
- 实现 Issue Gate 和 Human Validation Gate。
- 实现 Claude Issue Review 和 CI 后的 Claude PR Review。
- 将确定性 CI、Issue Gate、Human Validation Gate 和评论解决设为合并门禁。
- 启用 GitHub 原生 Squash Auto-merge enrollment，不新增自定义 Merge 实现。

### Stage 2：Codex Worker

- 以 `ready-for-agent` 驱动 Codex Worker。
- 提供包含 `## Blocked by` 的 Issue 模板，使 blocker 使用确定性格式声明。
- 实现 frontier Issue 校验、Issue 级并发、固定 branch/PR 和暂停恢复。
- 从固定的 mattpocock/skills revision 接入项目级 `implement`、`tdd` 和 `code-review` Skill。
- 使用独立模型 job、固定 Artifact 和可信发布 job 维护 branch、PR 正文与标签。
- 首版只支持不超过 400 KiB 的文本 Patch；二进制和信任边界变更转人工处理。
- 扩展 Issue Gate、required workflow 清单和按 Secret 身份隔离的 workflow policy 测试。

### Stage 3：修复循环

- 实现 CI 和 Claude finding 驱动的两轮自动修复。
- 实现人工重新授权、失败停止和 Issue/PR 状态回写。

每个 Stage 独立通过 PR 评审和真实 GitHub 冒烟验证。只有前一阶段在默认分支稳定运行后，
才启用下一阶段。

## 13. 验收标准

- 新的成员 Issue 自动收到 Claude 建议；外部用户 Issue 只有成员添加 `claude` 后调用模型。
- 未经人确认的 Issue 不能被无人值守流程标记为 `ready-for-agent`。
- Codex 只领取无未关闭 blocker 的 frontier Issue，同一 Issue 不产生并发执行或多个活动 PR。
- 每个 PR 只有一个有效且打开的 primary Issue，关系异常时 Issue Gate 阻止合并。
- Claude 只 Review CI 通过的当前 PR head；Review check 本身不阻塞合并，成功发布的 `P0`、
  `P1` 线程阻塞合并，`P2` 不阻塞。
- 需要人工验证的 PR 在标签被人移除前不能合并；新增 commit 后标签重新出现。
- 人工 Approve 和人工验证是两个独立门禁，任何标签操作都不能跳过 required checks。
- Stage 3 启用后，无人值守修复最多两轮；人工重新授权后才能开始新的两轮。
- Codex、Claude 和发布 job 均不能 Approve、绕过门禁或直接修改分支保护。
- 同仓库、非 Draft、目标为默认分支的 PR 可以启用原生 Squash Auto-merge；人工关闭后，
  新增 commit 不会自动重新启用。
- 所有门禁通过后，GitHub 原生 Squash Auto-merge 完成合并，并正常触发默认分支 CI。
- 新增或修改 `pull_request_target` workflow 后，使用合入后的默认分支和后续 PR 完成真实
  冒烟验证，不能用实现 PR 自证其写权限行为。
