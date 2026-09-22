# Issue Tracker: GitHub

本仓库的 Issues 与 specs 使用 GitHub Issues，通过 `gh` CLI 操作。

## Conventions

- 创建：`gh issue create --title "..." --body "..."`
- 读取：`gh issue view <number> --comments`
- 列出：`gh issue list --state open --json number,title,body,labels,comments`
- 评论：`gh issue comment <number> --body "..."`
- 标签：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- 关闭：`gh issue close <number> --comment "..."`

仓库由当前 Git remote 推断。

## Planning priority labels

- `priority:P0`：M1 后端主链路或首个 Pilot 的必要前置。
- `priority:P1`：M1 必须完成，但依赖 P0 或属于后续验收门禁。
- `priority:P2`：当前较低优先级的消费者、体验补齐或延后工作。

这些标签只表示当前排序，不表示产品阶段，也不替代 native blockers、PRD、工程 Spec 或人工验收门禁。M1、M2、M3 等阶段使用 GitHub Milestone、独立 Wayfinder map 或 roadmap issue 表达；阶段建立时再单独定义，不为每个阶段创建标签。

## Pull requests as a triage surface

**PRs as a request surface: no.**

GitHub Issue 与 PR 共用编号；遇到裸 `#<number>` 时，先读取 PR，再读取 Issue。

## Skill operations

Skill 要求发布时创建 GitHub Issue；要求读取 ticket 时运行
`gh issue view <number> --comments`。

## Wayfinding operations

- Map：使用 `wayfinder:map` 标签。
- Child：使用 GitHub sub-issue；不可用时退回 map task list。
- Blocking：GitHub native issue dependencies 是 canonical 表示。
- Frontier：从 map 的未关闭、无 blocker、无 assignee children 中选择。
- Claim：`gh issue edit <number> --add-assignee @me`。
- Resolve：评论结论、关闭 child，并把 context pointer 加入 map。
