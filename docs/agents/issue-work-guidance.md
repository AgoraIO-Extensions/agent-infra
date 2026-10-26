# Issue 工作指导

> 适用范围：`AgoraIO-Extensions/agent-infra` 当前开放 Issue。本文把实时清单转成可执行的分派规则；具体产品结论仍以 PRD、工程 Spec、HLD 和 Issue 正文为准。
> 最近快照：2026-10-26；开放 Issue 57 个；主干 `247f8face`。状态明细见 [issue-status-tracking.md](issue-status-tracking.md)。

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
| Worker stale binding | [#3380](https://github.com/AgoraIO-Extensions/agent-infra/issues/3380) | 分类永久 model binding mismatch，停止 ready 热循环并保留 retryable outage 重试 | 不改 ACK/Helm，不处理 AC |
| Worker diagnostics | [#3428](https://github.com/AgoraIO-Extensions/agent-infra/issues/3428) | PR #3479 复核与合入 | 不改变健康状态机 |
| Platform/Directory | [#3481](https://github.com/AgoraIO-Extensions/agent-infra/issues/3481) | 代码已合入，开发关闭；真实 AC 后续跟进 | 不把 AC 结果写成开发完成证明 |

三条 lane 的子 agent 都必须先在最新 `origin/main` 上复读 Issue；若发现 AC、依赖或 owner 不满足实现门槛，返回带证据的只读 handoff，不创建伪 PR。

## 分派与状态更新规则

- 开发完成且代码已合入即可关闭开发 Issue；AC/真实验收保留在评论和后续验收票中。
- 有开放开发 PR、未提交实现或明确外部 blocker 的 Issue 保持开放。
- 子 Issue 的开发全部完成后关闭父开发 Issue；Parent 的真实验收范围另行跟进。
- 同一文件、部署单元或 Issue 只允许一个写 owner。

## 当前交付跟进

| Primary Issue | 当前状态 | 证据 |
| --- | --- | --- |
| #3380 | 开发 lane 复核/实现中 | 诊断确认永久 mismatch 分类缺口；待 PR |
| #3428 | Draft PR，Hosted checks 通过，待 review/转 Ready | [PR #3479](https://github.com/AgoraIO-Extensions/agent-infra/pull/3479) |
| #3481 | 开发已合入，Issue 按开发口径关闭；真实 AC 后续跟进 | [PR #3482](https://github.com/AgoraIO-Extensions/agent-infra/pull/3482)、[PR #3489](https://github.com/AgoraIO-Extensions/agent-infra/pull/3489) |
| #3494 | 开发已合入并清理 | [PR #3494](https://github.com/AgoraIO-Extensions/agent-infra/pull/3494) |

## 权威来源

- [Agent 平台 M1 PRD](../prd/PRD-agent-platform-M1.md)
- [Connection M1 PRD](../prd/PRD-connection-M1.md)
- [M1 工程架构 Spec](../architecture/SPEC-agent-infra-M1-engineering-architecture.md)
- [AI 主导开发工作流 Spec](../architecture/SPEC-ai-native-development-workflow.md)
- [Issue Tracker](issue-tracker.md)
- [Triage Labels](triage-labels.md)
