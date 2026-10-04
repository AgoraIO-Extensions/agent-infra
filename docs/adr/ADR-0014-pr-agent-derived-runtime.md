# ADR-0014：PR-Agent derived runtime（已废止）

状态：由 [Workflow Spec §7.3](../architecture/SPEC-ai-native-development-workflow.md#73-automated-pr-review)
替代。

PR-Agent 改为直接使用官方 GitHub Action 的 `/review` 和 `/improve`。不再维护 plain-diff
文件保留补丁、派生镜像身份、scope/receipt 或 Coverage 验证，本 ADR 不再授权任何派生 runtime。
