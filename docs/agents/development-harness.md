# 开发 Harness

开发 worktree 的 source 必须是本次运行前刚刚回读的 `origin/main` exact commit。仓库内的
`dev-preflight` 是开发 source provenance 和验证计划的唯一入口；通用 skill 只能作为说明，不能
覆盖本仓库的门禁。

## 创建 worktree

```bash
node scripts/dev-preflight.mjs worktree /absolute/path/to/worktree fix/3472-example
```

命令会按顺序 fetch `origin/main`、捕获 immutable SHA、从该 SHA 创建 branch/worktree，并回读
worktree `HEAD`。任一步失败都不能进入实现阶段。命令输出的 JSON 是本次 lane 的 provenance
receipt，应和 Issue、branch、PR 一起保存；它不包含凭证或工作区正文。

原生 worktree 工具创建后，必须立即执行：

```bash
node scripts/dev-preflight.mjs verify /absolute/path/to/worktree <source-sha>
```

没有这个回读结果，不能声称 worktree 基于最新 main。

## 验证计划

```bash
node scripts/dev-preflight.mjs plan
```

输出包含 `sourceSha`、`required` 和 `skipped`。`skipped` 每项必须带 reason；跳过不是通过，
receipt 只表示选择结果。命令复用仓库已有检查，不删除安全、类型、测试、构建或部署门禁。

## Secret 扫描

- 本地提交前（可选、推荐）：执行 `git config core.hooksPath .githooks` 为当前 clone 启用
  `.githooks/pre-commit`。hook 在检测到 `gitleaks` 时扫描 staged 变更；未安装时给出提示并以 CI 为准。
- CI：`.github/workflows/secret-scan.yml` 使用 `.gitleaks.toml`，PR 扫描 `base..head`，main push
  扫描 `before..after`；gitleaks 版本和 sha256 固定在工作流内。
- `.gitleaks.toml` 只 allowlist 已审计的合成测试夹具和历史误报；真实凭证不得加入 allowlist，
  必须先轮换、再从历史中移除。
- `.scratch/`、`.tmp-*` 和根目录 `status.md` 已被 `.gitignore` 忽略；不要把机器状态、会话日志或
  个人路径加入提交。
- GitHub 原生 secret scanning + push protection 仍是 provider 已知格式凭证的第一道门禁；本地和
  CI 扫描覆盖仓库配置与自定义规则，不替代原生门禁。

## 适用性

本仓库采用人工监督的本地 Agent 开发。外部要求后台 implementer/merger subagent、无人值守
修复或自动合并的通用 skill 不适用于本仓库，除非负责人另行确认并更新本仓库 workflow Spec。

Auto-merge Enrollment 会回读 PR 的 GraphQL review threads；任何未解决 thread 都会阻止登记，
如果已有 auto-merge request 则先取消它。review 或 review-comment 事件会重新执行检查。这个
日志判断不能替代 GitHub branch protection 的 required conversation resolution。
