---
name: coordinate-development
description: 协调 agent-infra 已授权 Issue 的并行开发、显式交接和证据收口；适用于多 writer 的启动、恢复和独立验证。
---

# 有界开发协调

执行已授权的本仓开发范围，遵循[开发工作流](../../../docs/architecture/SPEC-ai-native-development-workflow.md)。
GitHub Issue、原生依赖、PR、CI 和 Project 是事实源；本 Skill 的本地记录是可丢弃的工作缓存，
不提供跨进程锁、执行授权或新 workflow 状态。仅有标签、空 assignee 或 Agent idle 不能证明可接管。
需要选择新的 Roadmap 范围时交回负责人；不隐式调用只读 Goal 生成器，不扩大当前任务。

## 启动或恢复

1. 确认负责人已授权的 milestone、primary Issues、稳定 AC 和本轮边界。原授权仍有效时继续使用，
   不重复索取。读取根及适用的嵌套 AGENTS、各 Issue 的完整正文/评论和正式权威文档。
2. 回读以下事实并记录观察时间及证据链接。分页未读全、权限不足、无法定位资源都记为缺失，
   不能把读取失败变成“无依赖/无人占用”。用 `gh repo view --json nameWithOwner` 确认仓库：

   ```bash
   gh issue view ISSUE --json number,state,body,comments,updatedAt,milestone,projectItems,assignees
   gh api --paginate repos/OWNER/REPO/issues/ISSUE/dependencies/blocked_by
   gh api --paginate repos/OWNER/REPO/issues/ISSUE/timeline
   gh pr list --state open --limit 100 --json number,body,headRefName,headRefOid,isDraft,url
   gh pr view PR --json state,headRefOid,baseRefOid,statusCheckRollup,mergeStateStatus,reviewDecision
   git worktree list --porcelain
   git -C WORKTREE status --short --branch
   git -C WORKTREE rev-parse HEAD
   ```

   `--limit` 命中上限时继续分页。按 Issue 时间线回读关联的 open/closed/merged PR，不能把开放列表
   当作完整交付历史。由关联 PR、分支、工作树及当前可用的 Agent/session 清单交叉核对
   writer；Issue assignee 不等于活动 writer。回读 Project 的适用字段和原生 review threads，
   不从 `reviewDecision` 推断线程已解决。读取到确实无 Project 可记录不适用；无法读取不能冒充无。
3. 在已授权的仓库外私有目录中使用 [CONTEXT](templates/CONTEXT.template.md) 和
   [SESSION_BOARD](templates/SESSION_BOARD.template.md) 建立或恢复记录。只写脱敏元数据、源码/产物身份和
   证据指针，不写凭据、私有环境文件内容、用户会话正文或原始错误响应；记录不提交到 Git。
   同一协调会话只有 Coordinator 写 board。缓存缺失时仅重建可证明事实；未找到的 owner、dirty
   工作内容和交接状态保留为未知，相关 lane 不进入写入。
4. 把当前事实与冻结记录比较：Issue 的 Scope/AC/依赖/授权变化暂停受影响 lane，先更新 Issue
   和正式契约；`updatedAt` 变化应核对正文差额，不能只凭新时间戳重新授权。head、组合版本、
   镜像或环境变化使相关验证失效，按下表退回最早未证明阶段；保留旧回执但标明失效原因。

完成条件：每条拟执行 lane 的契约、当前依赖、owner、源码和资源边界均有回读；其余 lane 留下
可定位 blocker 与下一动作。前置未交付、版本或 ownership 未知时只做不依赖它们的只读调查。

## 分派与唯一 writer

- 以一个 primary Issue 的明确 slice 为单位，记录 writer、独立 verifier、AC、文件/资源边界、
  worktree/branch、base/head、验证入口及终点。按[开发 Harness](../../../docs/agents/development-harness.md)
  建立隔离 worktree；保留其 exact source receipt。共用 index、assembly、迁移顺序和集成版本由
  一个明确 writer 接收，不能靠多个 worktree 假定它们不冲突。
- 分派前逐项比较全部已知活动 lane：源码资源以仓库身份 + 相对路径识别（含目录/文件重叠、
  重命名和符号链接别名）；PR、branch、worktree、namespace、外部对象以精确身份识别。无法枚举的
  glob 或未知外部 owner 要先展开/查明。同一资源有两个 writer 即拒绝第二次分派，记录双方及资源。
- 两条不相交 lane 可并行；第三条重叠 lane 保留待办。使用当前可用协作工具传递冻结边界，要求
  writer 保留他人修改，报告范围漂移和自己的 exact head。没有可用协作工具时保留相同记录串行
  执行，不虚构子代理或独立 verifier；未完成独立验证的阶段不得提升。
- 每次失败记录步骤、稳定脱敏错误码、被测 head/环境和回执；预算按 lane + 失败步骤 + 已确认原因
  归组，head 是观察身份而非预算重置键。原因未明时沿原故障组继续。启动时给定有限重试次数，
  耗尽后留下可恢复条件和原生 Issue/CI 链接，不循环创建 blocker。新 head 不会自动重置预算；
  有新证据再由 Coordinator 记录原因并调整预算。

## 交接、阶段与验证

idle、timeout、进程退出和工作树看似干净都不释放写权。先将双方已确认的交接写入 board：旧/新
writer、Issue/AC、精确资源、base/head、dirty 内容边界、已完成/剩余工作、blocker、下一动作和证据。
新 writer 在接收时重新读取 GitHub/Git/current ownership，并明确确认接收；确认前旧 writer 保持
登记且双方不并发写入。旧 writer 不可联系时，由原授权负责人明确决定接管，记录决定后再接收。

以下是本地证据阶段，不替代 GitHub 状态或工作流的 L1/L2/L3：

| 阶段 | 可观察条件 | 失效时退回 |
| --- | --- | --- |
| Ready to implement | 完整契约、依赖、授权、唯一 writer、source receipt 与验证计划 | 条件缺失则停在未准入 |
| Implemented | 当前 slice 的代码与 focused checks 完成，关联 PR/head 和未完成 AC 明确 | 源码变化后重新验证；范围变化先重新准入 |
| Integrated | 同一组合源码/配置及适用镜像可启动，至少一条真实纵向入口完成 | 组合或环境变化后重新集成验证 |
| Accepted | 独立 verifier 的当前版本结果、命令/环境/限制完整，全部适用人工门禁实际签收 | 缺证据退回相应阶段；未签收不能填 Accepted |

Verifier 与该 lane 的 writer 不同，只运行已有真实验证入口/旅程，不修改实现、不为实现者批准。
命令取现有 package scripts、dev-preflight receipt 或正式验证文档；失败、跳过、环境缺口、未知
和通过分别记录。发现问题回给 writer；修复产生新 head 后重新绑定验证。验证没有独立身份、
精确版本或实际命令输出时，不接受口头“测试全绿”。

每次交接、阶段推进与收口都回读当前 Issue/PR/head/CI/review threads、merge SHA 和 Project。
原生依赖缺口链接到已有事实；确需新 Issue 时先查重并按仓库流程创建。关闭开发 Issue 与签收真实
AC 分开，父票还要复核自身范围；PR 创建后的 watcher 和合入后的专属 cleanup 沿 AGENTS 执行。
保留被拒旧证据与真实验收待办，不用快照或缓存覆盖 GitHub。

## 试运行与输出

完成一次获授权 milestone 的真实试运行：从本入口启动两个不冲突实现任务，实际显式交接一次，
由独立 verifier 运行同组合版本的已有入口，回读最终阶段。冲突、缺契约、依赖/读取失败、
head 更新、缓存缺失、timeout 抢占、重试耗尽和缺人工签收的负例在隔离环境回放；不能对真实
共享资源制造冲突。没有匹配的 milestone、两条已授权 lane 或 verifier 时列缺口，不用合成记录
声称试运行完成。

事件发生时立即写 board，不事后猜时间。报告范围漂移/ownership 冲突/旧证据拒绝次数、交接
成功数/尝试数、各阶段进入与离开时间及 verifier findings；无事件记 0，未观察记未知，零尝试的
成功率记不适用。最终输出当前交付、未完成项、阻塞来源和下一动作，附 exact head/merge/回执。
记录只用于判断下一次是否需要更多自动化；首轮不增加常驻服务、Hook 或通用编排框架。
