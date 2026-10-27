# 开放 Issue 状态跟进

> 快照：2026-10-27 06:00 UTC；`origin/main` `de18fba6d`。
> GitHub 状态不代表验收通过；Issue 与 PR 链接是持续更新的证据入口。

当前开放 Issue：**33**。完整开发工作完成即可关闭，真实验收 AC 由负责人后续统一跟进。

## 分类计数

| 类别 | 数量 |
| --- | ---: |
| Runtime/Worker/Core | 10 |
| Deploy/E2E/Channels | 12 |
| Platform/Web/Skill | 6 |
| Workflow/Observability | 5 |

## 明细

| 类别 | Issue | 标题 | 优先级 | 实时标签 | 最近更新 | 下一步 |
| --- | --- | --- | --- | --- | --- | --- |
| Runtime/Worker/Core | [#3295](https://github.com/AgoraIO-Extensions/agent-infra/issues/3295) | blocker(ack): Flannel 环境未通过 Worker NetworkPolicy 负向验证 | 未标注 | agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Runtime/Worker/Core | [#3277](https://github.com/AgoraIO-Extensions/agent-infra/issues/3277) | fix(worker): 开启文件交换后，镜像早于 #3256 的 Agent Workload 启动即退出（CrashLoop） | priority:P2 | needs-triage, priority:P2, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Runtime/Worker/Core | [#3218](https://github.com/AgoraIO-Extensions/agent-infra/issues/3218) | feat(runtime): Claude、Pi、OpenCode 原生进程补 Landlock 边界后开放 shell（#3202 第 2 步） | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Runtime/Worker/Core | [#3203](https://github.com/AgoraIO-Extensions/agent-infra/issues/3203) | feat(worker): Session Sandbox 支持部署批准的通用出网（#3198） | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Runtime/Worker/Core | [#3202](https://github.com/AgoraIO-Extensions/agent-infra/issues/3202) | feat(runtime): Claude、OpenCode、Pi 标准模板开放原生工具（#3198） | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 | 核对 #3218 与原生工具开发子项 |
| Runtime/Worker/Core | [#3198](https://github.com/AgoraIO-Extensions/agent-infra/issues/3198) | feat(runtime): 恢复标准模板 Agent 的原生能力，以 Session Sandbox 为隔离边界 | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 | 核对全部开发子项后才能关闭父票 |
| Runtime/Worker/Core | [#2929](https://github.com/AgoraIO-Extensions/agent-infra/issues/2929) | test(runtime): isolate native early-stop failure during recovery setup | priority:P2 | ready-for-agent, priority:P2, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Runtime/Worker/Core | [#2857](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857) | test: accept Session Sandbox multi-entry isolation from #1253 | 未标注 | agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Runtime/Worker/Core | [#2757](https://github.com/AgoraIO-Extensions/agent-infra/issues/2757) | fix: local concurrent native metadata reads intermittently return 503 (79/100 rounds) | priority:P1 | ready-for-agent, priority:P1, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Runtime/Worker/Core | [#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851) | feat(runtime): deliver standard MCP Agent token client | priority:P0 | priority:P0, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#3356](https://github.com/AgoraIO-Extensions/agent-infra/issues/3356) | fix(ack): refresh standard-template readiness from real ECI validation | 未标注 | agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#3232](https://github.com/AgoraIO-Extensions/agent-infra/issues/3232) | feat(deploy): expose authenticated standard-template release app for ACK upgrades | priority:P1 | priority:P1, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#3230](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230) | test(e2e): 固定环境 Web 与企微双向文件和图片验收（#3221） | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#3149](https://github.com/AgoraIO-Extensions/agent-infra/issues/3149) | feat(deployment): automate safe template validation receipt refresh | priority:P1 | priority:P1, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#3108](https://github.com/AgoraIO-Extensions/agent-infra/issues/3108) | acceptance: ACK resumed conversations receive Messages gateway errors | priority:P1 | priority:P1, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#3072](https://github.com/AgoraIO-Extensions/agent-infra/issues/3072) | 验收 ACK main 部署的四基础模板与自定义镜像真实链路 | priority:P0 | priority:P0, agent:codex | 2026-10-26 | PR #3509 属其他会话且声明未完成，保留 Draft/验收边界 |
| Deploy/E2E/Channels | [#2998](https://github.com/AgoraIO-Extensions/agent-infra/issues/2998) | test(e2e): real WeCom credential and official QR binding acceptance | 未标注 | agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#2983](https://github.com/AgoraIO-Extensions/agent-infra/issues/2983) | test(e2e): 固定环境验收 DeepSeek 与思考过程（Web 与企微） | priority:P1 | ready-for-agent, priority:P1, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#2938](https://github.com/AgoraIO-Extensions/agent-infra/issues/2938) | fix(local): validate official kindnet NFQUEUE flush fix under default policy | priority:P2 | ready-for-agent, priority:P2, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#2742](https://github.com/AgoraIO-Extensions/agent-infra/issues/2742) | feat(skill): connect project snapshot packaging to the production publication path | 未标注 | agent:codex | 2026-10-26 | 核对 #2949/#2946 消费者交付后收口 |
| Deploy/E2E/Channels | [#1548](https://github.com/AgoraIO-Extensions/agent-infra/issues/1548) | test(skill-hub): accept the deployed lifecycle and Web conversation chain | priority:P0 | ready-for-human, priority:P0, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#171](https://github.com/AgoraIO-Extensions/agent-infra/issues/171) | 准备 P0 首发真实环境 ACK tenancy 与访问入口资源 | priority:P0 | wayfinder:task, wayfinder, priority:P0, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Platform/Web/Skill | [#3139](https://github.com/AgoraIO-Extensions/agent-infra/issues/3139) | fix(model): Catalog 端点追加模型或档位后，已有 Agent 的模型投影全部失效 | 未标注 | needs-triage, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Platform/Web/Skill | [#2858](https://github.com/AgoraIO-Extensions/agent-infra/issues/2858) | test: accept Platform management Web flow from #535 | 未标注 | agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Platform/Web/Skill | [#702](https://github.com/AgoraIO-Extensions/agent-infra/issues/702) | feat(skill): add project-level Roadmap Goal generator | priority:P2 | enhancement, ready-for-human, priority:P2, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Platform/Web/Skill | [#485](https://github.com/AgoraIO-Extensions/agent-infra/issues/485) | feat(platform): deliver authorized evaluation and quality analysis | priority:P2 | needs-triage, priority:P2, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Platform/Web/Skill | [#481](https://github.com/AgoraIO-Extensions/agent-infra/issues/481) | feat(platform): deliver user and application Agent management API | priority:P0 | needs-triage, priority:P0, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Platform/Web/Skill | [#400](https://github.com/AgoraIO-Extensions/agent-infra/issues/400) | design(web): restore agent-infra IA as the implementation and acceptance baseline | priority:P0 | enhancement, needs-triage, priority:P0, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Workflow/Observability | [#3547](https://github.com/AgoraIO-Extensions/agent-infra/issues/3547) | docs: refresh open Issue tracker after development closures | priority:P2 | agent:codex, priority:P2 | 2026-10-27 | 本票用于跟踪当前开放清单与开发关闭后的快照同步 |
| Workflow/Observability | [#3371](https://github.com/AgoraIO-Extensions/agent-infra/issues/3371) | 体验与时效性：Web 与企微在真实负载下近乎不可用（整体方案） | priority:P0 | needs-triage, priority:P0, agent:kiro | 2026-10-26 | 逐项核对开发子项及父票自身缺口 |
| Workflow/Observability | [#3301](https://github.com/AgoraIO-Extensions/agent-infra/issues/3301) | perf(workload): separate apply and readiness retry budgets | priority:P1 | bug, ready-for-human, priority:P1, agent:codex | 2026-10-26 | 仍缺镜像/PVC 等待与 signed readiness 的实际预算分离 |
| Workflow/Observability | [#690](https://github.com/AgoraIO-Extensions/agent-infra/issues/690) | feat(workflow): add bounded AI coding coordination harness | priority:P2 | enhancement, priority:P2, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Workflow/Observability | [#144](https://github.com/AgoraIO-Extensions/agent-infra/issues/144) | wayfinder: 形成 Agent 平台 M1 启动与落地路线 | priority:P0 | wayfinder:map, wayfinder, priority:P0, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |

## 开发 PR 回读

状态截至 2026-10-27 06:00 UTC。OPEN 不等于合入，MERGED 不等于真实验收完成。

| PR | 状态 | head SHA | 未完成验收 |
| --- | --- | --- | --- |
| [#3509](https://github.com/AgoraIO-Extensions/agent-infra/pull/3509) | OPEN / Draft | `7e5ad36853e448d4183bd6d98bf37b57220e3f19` | #3072 的 ACK 真实部署/恢复 AC 仍未完成；保留 Draft |
| [#3520](https://github.com/AgoraIO-Extensions/agent-infra/pull/3520) | OPEN | `547fec4845b26c89c85c4c590f6a3e7c43f39a4f` | #3146 已按开发交付关闭；真实 Web/ACK AC 待后续 |
| [#3532](https://github.com/AgoraIO-Extensions/agent-infra/pull/3532) | OPEN | `acef1e3ff306243577278859071efe9b359a20a3` | #3527 已按开发交付关闭；真实部署/Skill AC 待后续 |
