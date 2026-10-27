# Issue 工作指导

> 适用范围：`AgoraIO-Extensions/agent-infra` 当前开放 Issue。本文把实时清单转成可执行的分派规则；具体产品结论仍以 PRD、工程 Spec、HLD 和 Issue 正文为准。
> 最新时间、基线、标签与 PR head/merge 证据统一见 [状态跟进](issue-status-tracking.md)。

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
6. 完整开发工作完成即可关闭 development Issue；创建 PR 或部分 slice 不足以证明完整开发范围完成。真实验收 AC 保留原状态，后续由负责人统一跟进。父 Issue 只有在全部开发子项完成且无自身独立开发缺口时关闭。

## 本轮并行委派

| Lane | Primary Issue | 文件范围与交付终点 |
| --- | --- | --- |
| 模型候选 | [#3146](https://github.com/AgoraIO-Extensions/agent-infra/issues/3146) | Core、API、Contracts/生成物、Web 新建申请；实现候选查询至提交的完整消费者 |
| Skill consumer | PR #3517；Issue #2949 已按开发交付关闭 | Store publication reader、Object Storage 证据 verifier、Worker 接线；不触碰其他 lane 的生成物 |
| 协调者 | [#3499](https://github.com/AgoraIO-Extensions/agent-infra/pull/3499) | 状态文档、父子开发范围、标签和未解决 review threads |

每条 lane 独占已声明文件，基于刷新后的 main 和隔离 worktree 开发。
缺失内部接口若已在 Issue Scope 中授权，属于待实现内容；只有实际产品/架构冲突或外部输入缺失
才记录 blocker，不将缺失代码本身当作外部审批门禁。

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

## 开发交付与来源

开发 PR 的准确状态、日期、head SHA、merge SHA、Issue AC 链接统一见
[开发 PR 回读](issue-status-tracking.md#开发-pr-回读)，不在此重复维护历史 SHA。
发现代码遗漏或回归继续修复并恢复跟踪，不把真实验收延期当成代码缺口已完成。

标签遵循 [Issue Tracker](issue-tracker.md#agent-provenance) 与
[Triage Labels](triage-labels.md)。新建 Issue/PR 显式传入唯一 `agent:*` 来源标签，
正文 `Agent` 与标签一致并保留 `Agent-Session-ID`；处理其他 Agent 创建的 Issue 保留原来源。
优先级按实际开发顺序设置，标签不替代依赖和权限判断。
