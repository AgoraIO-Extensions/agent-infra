# Issue Tracker

本仓库使用 GitHub Issues 跟踪需求，使用 `gh` CLI 读写 Issue 和 Pull Request。

## 常用操作

- 读取 Issue：`gh issue view <number> --comments --json number,title,body,labels,comments`
- 创建 Issue：`gh issue create --title "..." --body-file <file>`
- 添加或移除标签：`gh issue edit <number> --add-label "..."` 或
  `gh issue edit <number> --remove-label "..."`
- 读取 PR：`gh pr view <number> --comments --json number,title,body,labels,reviews`

仓库名由当前 Git remote 推断。无人值守 Worker 的 Issue 状态和 `## Blocked by` 格式以
[AI 主导开发工作流 Spec](../architecture/SPEC-ai-native-development-workflow.md) 为准。
