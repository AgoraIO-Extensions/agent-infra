# Issue 工作指导

> 适用范围：`AgoraIO-Extensions/agent-infra` 当前开放 Issue。本文把实时清单转成可执行的分派规则；具体产品结论仍以 PRD、工程 Spec、HLD 和 Issue 正文为准。
> 最近快照：2026-10-26；开放 Issue 86 个；主干 `58c544ed6`。状态明细见 [issue-status-tracking.md](issue-status-tracking.md)。

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

本轮已并行委派两条实现 lane；每条 lane 只拥有一个 primary Issue 和其声明文件，不共享写入。

| Agent lane | Primary Issue | 目标 | 禁止越界 |
| --- | ---: | --- | --- |
| Worker Diagnostics | [#3428](https://github.com/AgoraIO-Extensions/agent-infra/issues/3428) | 暴露有界、脱敏的多服务健康诊断并补齐未 Ready/无 Endpoint/最终失败测试 | 不改 ACK 资源、不输出原始 Pod 日志或会话正文 |
| Observability/Worker | [#3360](https://github.com/AgoraIO-Extensions/agent-infra/issues/3360) | 补齐 Sandbox 失败的稳定阶段/资源/版本/相关性字段，保持脱敏与有界重试 | 不改 ACK 资源、不把手工分类冒充结构化验收、不泄露凭证或资源正文 |

当前两条实现 lane 的子 agent 都必须先在最新 `origin/main` 上复读 Issue；若发现 AC、依赖或 owner 不满足实现门槛，返回带证据的只读 handoff，不创建伪 PR。#3472 已有开放 PR #3473，本轮只跟进其状态，不重复创建实现 PR；#2708、#2887、#2899、#2934、#2939 已复核为代码已交付/等待真实验收，不重复创建 PR。

## 本轮交付跟进

| 类别 / Primary Issue | 负责人 | 当前状态 | PR / 证据 |
| --- | --- | --- | --- |
| Worker 观测 / #3360 | observability_3360 | 已提交 PR；真实验收仍按 Issue AC 跟进 | [PR #3477](https://github.com/AgoraIO-Extensions/agent-infra/pull/3477)，新增 durable attempt；Worker 46/46、observability 46/46 |
| Worker 多服务诊断 / #3428 | workflow_dev_3472（已换任务） | 已提交 PR；类型验证受依赖产物缺失限制 | [PR #3479](https://github.com/AgoraIO-Extensions/agent-infra/pull/3479)，聚焦测试 24/24；待依赖构建后类型复核 |
| 工作指导 / #3475 | 根协调者 | 首版已合入，计数与状态回填中 | [PR #3476](https://github.com/AgoraIO-Extensions/agent-infra/pull/3476) |

已有开发流程 [PR #3473](https://github.com/AgoraIO-Extensions/agent-infra/pull/3473) 属于既有 owner；本轮不认领其分支。

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
