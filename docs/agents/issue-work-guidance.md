# Issue 工作指导

> 适用范围：`AgoraIO-Extensions/agent-infra` 当前开放 Issue。本文把实时清单转成可执行的分派规则；具体产品结论仍以 PRD、工程 Spec、HLD 和 Issue 正文为准。
> 最近快照：2026-10-27；开放 Issue 43 个；主干 `56e6f7ab0`。状态明细见 [issue-status-tracking.md](issue-status-tracking.md)。

## 四类工作边界

| 类别 | 处理范围 | 进入实现前必须确认 |
| --- | --- | --- |
| Runtime/Worker/Core | Runtime Host、Worker、Core、原生命令、模型、Sandbox 和执行状态 | Runtime Contract 版本、授权/隔离、unknown/recovery 边界、负向测试和真实调用证据 |
| Deploy/E2E/Channels | Helm、ACK、local harness、E2E、企微、文件面和发布装配 | 当前镜像/配置来源、环境 owner、部署与登录门禁、真实资源回读；fixture 不能代替真实验收 |
| Platform/Web/Skill | Platform API、Web、Skill、目录和用户流程 | 服务端身份与授权、API/OpenAPI 契约、消费者边界、浏览器/可访问性证据 |
| Workflow/Observability | 开发流程、wayfinder、性能、观测、测试稳定性和状态治理 | 明确是实现、调查还是人工门禁；记录可复现窗口、指标和阻塞 owner |

## 通用执行顺序

1. 从 [issue-status-tracking.md](issue-status-tracking.md) 找到目标 Issue，重新读取完整正文、评论、依赖、关联 PR 和当前 `origin/main`；表格快照不授权实现。
2. 只接收正文具备 `Problem`、`Scope`、稳定 `AC-N`、`Validation` 和 `Blocked by` 的 Issue。缺失任一项时补充只读交接，不自行发明验收条件。
3. 刷新 `origin/main`，建立独立 worktree 和分支；冻结本 lane 的 Issue、文件和部署资源所有权。不得覆盖其他 lane 的脏工作树或分支。
4. 实现最小直接改动，优先补边界和负向测试；把受控 fixture、focused test、Hosted CI、真实部署/浏览器/外部账号证据分开记录。
5. 提交 Conventional Commit，创建 PR 时带 Issue 链接、变更边界、验证命令、剩余 blocker 和回滚风险；PR 创建后交给 CI watcher，合并确认后交给 merged-PR cleanup。
6. 只有在 PR head、required checks、review threads、merge state 和 Issue AC 回读一致后，才把状态推进为完成；任何未验证的真实验收 AC 保持未勾选。

## 本轮并行委派

本轮按三条可独立交付的 lane 委派；每条 lane 只拥有一个 primary Issue 和其声明文件，不共享写入。

| Agent lane | Primary Issue | 目标 | 禁止越界 |
| --- | ---: | --- | --- |
| Runtime Pi session | 已关闭 #3342；PR #3504 | 等待开发合入，确认 durable terminal suffix 校验和 fail-closed 边界 | 不处理 AC/ACK/真实验收 |
| Worker application outbox | 已关闭 #3382；PR #3503 | 等待开发合入，确认 outbox identity validation 和终态事件 | 不处理 AC/ACK/真实验收 |
| Runtime idle CPU | 已关闭 #3303；PR #3502 | 等待开发合入，确认 probe 观测不影响调谐 | 不处理 AC/真实验收 |
| Active development PRs | 开发 Issue #3337 重新开放，PR #3512 修复合并后的 kubectl 兼容性缺陷；其余已关闭的 development Issues #2989/#3106/#3159/#3193/#3309/#3342/#3362/#3365/#3382/#3428/#3036；PR #3469、#3499、#3502、#3504、#3506、#3508、#3510、#3511、#3512 | 等待 Hosted checks 和开发合入；合入后保留 AC 待办 | 不处理真实验收 |

三条 lane 的子 agent 都必须先在最新 `origin/main` 上复读 Issue；若发现 AC、依赖或 owner 不满足实现门槛，返回带证据的只读 handoff，不创建伪 PR。

## 分派与状态更新规则

- `ready-for-agent` 只表示可以开始契约复核，不代表依赖已满足。
- `needs-triage` 先由协调者补齐问题、范围、验证和 blocker；不得直接认领。
- `ready-for-human`、真实部署、真实浏览器、外部账号和人工决策保持人工门禁；代码测试通过不等于验收完成。
- 同一文件、同一部署单元或同一 Issue 只能有一个写 owner；依赖关系写回 Issue 或 PR，不在状态表里推测。
- 每次状态更新必须带日期、证据链接、准确的 head/PR 状态和未完成 AC；不使用“看起来完成”“CI 绿色”作为完成依据。

## 权威来源

- [Agent 平台 M1 PRD](../prd/PRD-agent-platform-M1.md)
- [Connection M1 PRD](../prd/PRD-connection-M1.md)
- [M1 工程架构 Spec](../architecture/SPEC-agent-infra-M1-engineering-architecture.md)
- [AI 主导开发工作流 Spec](../architecture/SPEC-ai-native-development-workflow.md)
- [Issue Tracker](issue-tracker.md)
- [Triage Labels](triage-labels.md)

## 当前开发交付

- #3495 stale binding fix：已合入 `0015b97c5`，Issue #3380 已按开发完成关闭；AC 留待后续。
- #3479 diagnostics：已合入 `5e6a73f0`，Issue #3428 已按开发完成关闭；AC 留待后续。
- #3362 API admission：主干已有修复并已关闭；剩余为 ACK/Worker 外部状态与 #3369。
- #3309 Messages transport：已合入 `9b2407c5c`，Issue 已按开发完成关闭；AC 留待后续。
- #2989 local auth port、#3508：开发 PR 已提交，Issue 已按开发完成关闭，等待 Hosted checks/合入。
- #3106 encryption key versions、#3510：开发 PR 已提交，Issue 已按开发完成关闭，等待 Hosted checks/合入。
- #3159 bootstrap timeout、#3511：开发 PR 已提交，Issue 已按开发完成关闭，等待 Hosted checks/合入。
- #3193 Skill metadata timing：PR #3324 已合入，Issue 已按开发完成关闭；真实环境 AC 留待后续。
- #3337 ACK Helm version：PR #3507 已合入但发现 kubectl CLI 兼容性缺陷；Issue 重开，PR #3512 修复中。
- #3365 manifest digest、#3506：开发 PR 已提交，Issue 已按开发完成关闭，等待 Hosted checks/合入。
- #3469 E2E Harness、#3502 idle CPU、#3504 Pi session：开发 PR 已提交，等待 Hosted checks/合入。
- 已提交开发 PR 的 development Issue 按当前指示关闭；AC/真实验收作为后续跟进。
