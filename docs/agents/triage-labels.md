# Triage Labels

Skills 使用以下 canonical role；右侧是本仓库实际 GitHub 标签。

| Canonical role | GitHub label | 含义 |
| --- | --- | --- |
| `needs-triage` | `needs-triage` | 契约、依赖、授权或执行状态需要人工处理 |
| `needs-info` | `needs-info` | 等待报告者补充必要信息，不授予执行权限 |
| `ready-for-agent` | `ready-for-agent` | Issue 已完整，适合 AFK Agent；不选择执行器或授予执行权限 |
| `ready-for-human` | `ready-for-human` | Issue 由人或本地受监督 Codex 实现；用于 PR 时表示仍需人工验证 |
| `wontfix` | `wontfix` | 不再实施并终止对应执行 |

Skill 提及 canonical role 时使用对应 GitHub 标签。AFK 执行授权、迁移期兼容和人工验证的
完整语义以
[AI 主导开发工作流 Spec](../architecture/SPEC-ai-native-development-workflow.md) 为准。
