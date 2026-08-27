# Issue Tracker: GitHub

本仓库使用 `AgoraIO-Extensions/agent-infra` GitHub Issues 跟踪实现工作，使用
`gh` CLI 操作。正式 PRD、工程架构和开发工作流仍以 `docs/` 中的权威文档为准。

## Conventions

- 创建 Issue：`gh issue create --title "..." --body-file <file>`
- 读取 Issue：`gh issue view <number> --comments --json number,title,body,labels,comments`
- 列出 Issue：`gh issue list --state open --json number,title,body,labels,comments`
- 评论 Issue：`gh issue comment <number> --body "..."`
- 修改标签：`gh issue edit <number> --add-label "..."` 或 `--remove-label "..."`
- 关闭 Issue：`gh issue close <number> --comment "..."`

仓库名从当前 Git remote 推断。

## Pull requests as a request surface

**PRs as a request surface: no.**

GitHub 的 Issue 和 PR 共用编号。遇到裸 `#<number>` 时，先读取 PR，失败后再读取 Issue。

## Skill operations

- Skill 要求发布 ticket 时，创建 GitHub Issue。
- Skill 要求读取 ticket 时，读取完整正文、标签和评论。
- Skill 路由和可选阶段以
  [AI 主导开发工作流 Spec](../architecture/SPEC-ai-native-development-workflow.md#21-matt-skill-交付路径)
  为准。
- Implementation Issue 必须使用项目模板规定的 `Problem`、`Scope`、`Acceptance criteria`、
  `Validation` 和 `Blocked by`；其 Execution Contract 语义以工作流 Spec 为准。
- 每条验收标准使用稳定且唯一的 `AC-N`。
- 发布或领取时按 [Triage Labels](triage-labels.md) 映射 canonical role；本文件不从标签推断授权。

## Relationships

- GitHub native issue dependencies 是权威依赖来源。添加依赖时使用
  `repos/<owner>/<repo>/issues/<issue>/dependencies/blocked_by` API，并传 blocker 的 numeric
  database ID。
- `## Blocked by` 只保留为迁移期投影，写 `None` 或每行一个 `- #<issue-number>`；不得仅修改
  正文来创建、删除或改变依赖边。
- 只有明确的 umbrella Issue 才使用 GitHub sub-issues；普通相关 Issue 不自动建立父子关系。
- 正文投影与 GitHub native dependencies 不一致时，以 native dependencies 为准，并进入
  `needs-triage` 修复投影。
- `bug`、`enhancement`、`documentation` 等类型标签只在语义明确时添加，不代表执行授权。

Issue 状态、授权周期、DAG 和门禁的正式规则以
[AI 主导开发工作流 Spec](../architecture/SPEC-ai-native-development-workflow.md) 为准。
