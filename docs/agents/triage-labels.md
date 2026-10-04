# Triage Labels

| Matt canonical role | GitHub label | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer 需要评估 |
| `needs-info` | `needs-info` | 等待报告者补充信息 |
| `ready-for-agent` | `ready-for-agent` | 已完整，可由本地 Agent 协助处理；不自动执行 |
| `ready-for-human` | `ready-for-human` | 需要人工处理或验证 |
| `wontfix` | `wontfix` | 不再处理 |

Skill 提及 canonical role 时，使用对应 GitHub label。

`ci:skip` 是 PR 的 CI 豁免标签，不是 triage 状态。需要豁免时添加，恢复检查时移除；适用范围与
行为以[工作流 Spec §7.2.1](../architecture/SPEC-ai-native-development-workflow.md#721-ci-豁免) 为准。
