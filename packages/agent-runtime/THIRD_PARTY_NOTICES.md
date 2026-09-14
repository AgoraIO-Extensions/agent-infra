# 第三方来源

Claude Query 启动与退役逻辑采用 Paseo 的叶子实现：

- 仓库与固定版本：`getpaseo/paseo@d1b705a0cd91617a5707fae25d80cb0be3057950`。
- 来源：`packages/server/src/server/agent/providers/claude/query.ts` 的
  `applyRuntimeSettingsToClaudeOptions` 和 `claudeQuery`；`claude/agent.ts` 的 `ensureQuery`。
- 本仓落点：`src/claude-query.ts` 和 Claude Driver 的 Query 退役与原 Session 恢复。
- 改动：移除产品环境覆盖、用户 HOME、权限默认值和 stderr 日志；每 Query 绑定一个已验证
  模型选项，注入独立会话目录及短期传输能力，停止后确认进程退出。
- Copyright (c) 2025-present Mohamed Boudra，Apache-2.0。
  原始许可证完整保留于 [paseo-LICENSE](third-party/paseo-LICENSE)。

官方 Claude Agent SDK 固定为 `0.3.246`，随包原生 CLI 为 `2.1.246`；其 Anthropic 许可证
随依赖分发，与上述 Paseo 源码许可证分别保留。
