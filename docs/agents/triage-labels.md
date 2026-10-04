# Triage Labels

| Matt canonical role | GitHub label | Meaning |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | Maintainer 需要评估 |
| `needs-info` | `needs-info` | 等待报告者补充信息 |
| `ready-for-agent` | `ready-for-agent` | 已完整，可由 AFK Agent 处理 |
| `ready-for-human` | `ready-for-human` | 需要人工实现 |
| `wontfix` | `wontfix` | 不再处理 |

Skill 提及 canonical role 时，使用对应 GitHub label。

`ci:skip` 是 PR 的 CI 豁免标签，不是 triage 状态。需要豁免时添加，恢复检查时移除；适用范围与
行为以[工作流 Spec §7.1](../architecture/SPEC-ai-native-development-workflow.md#71-确定性-ci) 为准。
