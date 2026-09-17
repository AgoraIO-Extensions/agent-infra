# ADR: GitHub Credential Mode 与 Action Compatibility

## 状态

已批准进入实现。

## 背景

GitHub `connection-v7` 从上游 Catalog 投影了 145 个 Action，并把
`rerequest_check_run` 与 `rerequest_check_suite` 错误映射为 OAuth `workflow` scope。GitHub
官方契约要求这两个 endpoint 使用 `Checks: write`，且 Check 必须属于对应 GitHub App。当前
Connection 只保存 OAuth App classic-scope Credential，因此这两个 Action 无法执行，也不能被描述为
OAuth Connection 能力。

143 个其余 ActionVersion 已通过专用账号和隔离资源完成真实 Provider E2E。继续把认证模式不兼容的
Action 计入同一 ProviderRelease，会让 Catalog、Consumer declaration、Consent 与 Grant 展示一个
永远无法成功的权限集合。

## 决策

1. 发布 GitHub OAuth `connection-v8` ProviderRelease，只包含当前 OAuth App credential mode 可执行且
   已验证的 143 个 ActionVersion。
2. `connection-v8` 不发布 `rerequest_check_run` 与 `rerequest_check_suite`；`workflow` 不是
   `Checks: write` 的兼容替代。
3. v8 发布迁移整体停用 `connection-v7` ProviderRelease，并显式停用两个不兼容的 v7
   ActionVersion。旧 v7 Grant 因 Release fence 立即 fail closed，不能继续发现或 dispatch。
4. 既有 GitHub Connection 必须通过同账号重连切换到 v8 CredentialVersion；旧 Grant 不跨 Release
   自动迁移，用户必须基于 v8 declaration 重新确认 143 项能力。
5. 未来 GitHub App 支持使用独立 ProviderRelease 和 Connection。GitHub App Credential、OAuth
   Credential、Consent 与 Grant 不互换，调用方也不能在 Action 参数中选择 credential mode。

## 影响

- OAuth v8 覆盖率分母为 143；只有 exact v8 ActionVersion 的真实证据才能计为 `LIVE_VERIFIED`。
- v8 部署后，已有 v7 Connection 在重连前不可执行，避免静默使用旧 Release。
- Consumer current declaration 由启动发布流程替换为 v8 的 143 项；旧 declaration 只保留审计历史，
  不能为 disabled v7 Release 恢复执行资格。
- GitHub App 模式需要单独的 identity proof、权限配置、App-owned Check fixture、撤销和 E2E，不在本次
  实现范围内。

## 已拒绝方案

- 继续把两个 Action 标为 OAuth `workflow` scope：权限模型错误，Provider 会永久拒绝。
- 原地删除 v7 的两个 Action：破坏 ProviderRelease 和 ActionVersion 不可变性。
- 在一个 Connection 中运行时选择 OAuth 或 GitHub App Credential：绕过固定 auth profile、Consent
  与 Grant 边界。
- 把两个 Action 记为“已实现但未验证”并继续对外展示：会把不可执行能力当成测试欠账。
