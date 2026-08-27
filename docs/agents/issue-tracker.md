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
