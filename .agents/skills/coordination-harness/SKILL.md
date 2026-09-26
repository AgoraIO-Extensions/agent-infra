---
name: coordination-harness
description: 从当前 Issue、PR、CI 与 Git 启动有明确边界的本地协调会话。
disable-model-invocation: true
---

# 协调会话启动

本入口对应 #691。复用既有 Goal 上下文，读取当前事实并固定本轮 slice；
启动回执只描述 `Ready to implement` 或 `Blocked`，后续 ownership、handoff、
验证和阶段推进分别由独立 Issue 负责。GitHub 是正式事实源，本地缓存可删除后重建。

## 声明与调用

在目标 worktree 根目录，用 Node.js 24 执行；需要已登录且有仓库只读权限的 `gh` 和 Git。
声明文件放在本地忽略的位置，不提供 Issue/PR/worktree 事实快照：

```json
{
  "repository": "AgoraIO-Extensions/agent-infra",
  "issue": 691,
  "baseRef": "origin/main",
  "goalContext": "existing-goal-reference",
  "slice": { "name": "协调启动", "acceptanceCriteria": ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5"] },
  "roles": { "owner": "coordinator", "writer": "startup-writer", "verifier": null },
  "resources": {
    "files": [".agents/skills/coordination-harness/", "tests/coordination-harness.test.ts", "tests/coordination-harness-replay.ts", "package.json", ".gitignore"],
    "external": []
  },
  "validation": ["node --test tests/coordination-harness.test.ts", "pnpm check-types"]
}
```

```bash
node .agents/skills/coordination-harness/scripts/coordination.ts start .local-coordination/declaration.json
```

`goalContext` 指向当前 Goal，不创建或扩展 Goal。`slice.acceptanceCriteria` 必须引用当前
primary Issue 的稳定 AC。文件边界为相对文件名或以 `/` 结尾的目录前缀，不使用 glob；
外部资源必须明确列出，空数组表示本轮没有外部写入。三个角色必须显式给出，未分配用
`null`，回执标记为 `unassigned` 并阻塞实施。验证入口只记录命令，不在启动时执行。

## 当前事实与回执

入口先用 `gh repo view` 将声明仓库绑定到当前 worktree，忽略 `GH_REPO` 环境覆盖；
身份读取失败或仓库不匹配时阻塞。入口只调用 Git 的读取命令与 `gh` 的 Issue GraphQL 查询、native dependency REST
查询、关联 PR 搜索和 PR/CI 回读。保留现有 `Issue -> 实现与验证 -> PR`、人工检查点和
仓库门禁。启动回执包含：

- Issue 链接、更新时间、契约 SHA-256、稳定 AC、适用 milestone 或本次观察到的 `none`。
- native blocker 的状态和链接；关联 PR 的当前 head、base 与 CI 检查状态。
- 当前 worktree、branch、base/head/merge-base SHA、变更文件与 diff/untracked 内容摘要。
- 既有 Goal 指针、声明的 slice、角色、文件及外部资源边界、验证入口、blocker 与下一动作。

缺少结构化契约、AC、必要依赖或 ownership，以及查询失败、分页不完整、文件超出声明
边界时，都不能进入 `Ready to implement`。失败不推断为空或通过；`Blocked` 退出码为 1。
成功启动退出码为 0，表示可以开始声明范围内的实施，不代表已有实现或验收通过。

## 本地缓存

每个 worktree 仅写入已被 Git 忽略的 `.local-coordination/issue-<number>/`，包含
`session.json`、`SESSION_BOARD.md`、`CONTEXT.md`。stdout 是同一份 JSON 回执。
每次启动重新读取事实并覆盖缓存；旧缓存不作为本轮输入。

缓存只保存必要元数据、内容摘要和证据指针，不保存原始 Issue 正文、diff 内容或会话正文。
不要在声明中放凭据或用户会话内容，不上传缓存。工具失败不回显可能含敏感信息的 stdout
或 stderr；本入口不写 GitHub、Project、Git 历史或业务系统。
