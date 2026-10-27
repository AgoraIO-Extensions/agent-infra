# 开放 Issue 状态跟进

> 快照：2026-10-27 02:17 UTC；`origin/main` `143395cff1`。
> GitHub 状态不代表验收通过；Issue 与 PR 链接是持续更新的证据入口。

当前开放 Issue：**41**。完整开发工作完成即可关闭，真实验收 AC 由负责人后续统一跟进。

## 分类计数

| 类别 | 数量 |
| --- | ---: |
| Runtime/Worker/Core | 13 |
| Deploy/E2E/Channels | 15 |
| Platform/Web/Skill | 8 |
| Workflow/Observability | 4 |

## 明细

| 类别 | Issue | 标题 | 优先级 | 实时标签 | 最近更新 | 下一步 |
| --- | --- | --- | --- | --- | --- | --- |
| Runtime/Worker/Core | [#3352](https://github.com/AgoraIO-Extensions/agent-infra/issues/3352) | feat(runtime): deliver Codex native context compaction in conversations | 未标注 | agent:codex | 2026-10-26 | 继续核对有状态原生命令的 Host/Driver 消费链 |
| Runtime/Worker/Core | [#3295](https://github.com/AgoraIO-Extensions/agent-infra/issues/3295) | blocker(ack): Flannel 环境未通过 Worker NetworkPolicy 负向验证 | 未标注 | agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Runtime/Worker/Core | [#3277](https://github.com/AgoraIO-Extensions/agent-infra/issues/3277) | fix(worker): 开启文件交换后，镜像早于 #3256 的 Agent Workload 启动即退出（CrashLoop） | priority:P2 | needs-triage, priority:P2, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Runtime/Worker/Core | [#3218](https://github.com/AgoraIO-Extensions/agent-infra/issues/3218) | feat(runtime): Claude、Pi、OpenCode 原生进程补 Landlock 边界后开放 shell（#3202 第 2 步） | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Runtime/Worker/Core | [#3203](https://github.com/AgoraIO-Extensions/agent-infra/issues/3203) | feat(worker): Session Sandbox 支持部署批准的通用出网（#3198） | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Runtime/Worker/Core | [#3202](https://github.com/AgoraIO-Extensions/agent-infra/issues/3202) | feat(runtime): Claude、OpenCode、Pi 标准模板开放原生工具（#3198） | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 | 核对 #3218 与原生工具开发子项 |
| Runtime/Worker/Core | [#3198](https://github.com/AgoraIO-Extensions/agent-infra/issues/3198) | feat(runtime): 恢复标准模板 Agent 的原生能力，以 Session Sandbox 为隔离边界 | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 | 核对全部开发子项后才能关闭父票 |
| Runtime/Worker/Core | [#2946](https://github.com/AgoraIO-Extensions/agent-infra/issues/2946) | fix(worker): deliver Skill generations to the real Runtime PVC with separated identities | priority:P1 | priority:P1, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Runtime/Worker/Core | [#2929](https://github.com/AgoraIO-Extensions/agent-infra/issues/2929) | test(runtime): isolate native early-stop failure during recovery setup | priority:P2 | ready-for-agent, priority:P2, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Runtime/Worker/Core | [#2857](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857) | test: accept Session Sandbox multi-entry isolation from #1253 | 未标注 | agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Runtime/Worker/Core | [#2757](https://github.com/AgoraIO-Extensions/agent-infra/issues/2757) | fix: local concurrent native metadata reads intermittently return 503 (79/100 rounds) | priority:P1 | ready-for-agent, priority:P1, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Runtime/Worker/Core | [#1578](https://github.com/AgoraIO-Extensions/agent-infra/issues/1578) | perf(worker): cut route verification cost on the Runtime submit path | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Runtime/Worker/Core | [#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851) | feat(runtime): deliver standard MCP Agent token client | priority:P0 | priority:P0, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#3356](https://github.com/AgoraIO-Extensions/agent-infra/issues/3356) | fix(ack): refresh standard-template readiness from real ECI validation | 未标注 | agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#3337](https://github.com/AgoraIO-Extensions/agent-infra/issues/3337) | fix(deploy): ACK pre-render uses default Helm Kubernetes version | priority:P2 | priority:P2, agent:codex | 2026-10-27 | 跟进 PR #3512 的 kubectl JSON 兼容性修复 |
| Deploy/E2E/Channels | [#3232](https://github.com/AgoraIO-Extensions/agent-infra/issues/3232) | feat(deploy): expose authenticated standard-template release app for ACK upgrades | priority:P1 | priority:P1, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#3230](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230) | test(e2e): 固定环境 Web 与企微双向文件和图片验收（#3221） | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#3221](https://github.com/AgoraIO-Extensions/agent-infra/issues/3221) | feat(files): 企微与 Web 双向收发文件和图片（附件进入 Sandbox、显式结果文件、企微媒体） | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#3149](https://github.com/AgoraIO-Extensions/agent-infra/issues/3149) | feat(deployment): automate safe template validation receipt refresh | priority:P1 | priority:P1, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#3108](https://github.com/AgoraIO-Extensions/agent-infra/issues/3108) | acceptance: ACK resumed conversations receive Messages gateway errors | priority:P1 | priority:P1, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#3072](https://github.com/AgoraIO-Extensions/agent-infra/issues/3072) | 验收 ACK main 部署的四基础模板与自定义镜像真实链路 | priority:P0 | priority:P0, agent:codex | 2026-10-26 | PR #3509 属其他会话且声明未完成，保留 Draft/验收边界 |
| Deploy/E2E/Channels | [#3060](https://github.com/AgoraIO-Extensions/agent-infra/issues/3060) | fix(local): 固定 E2E 部署缺少文件面装配、FileLimits 声明与 Runtime 文件交换注入 | 未标注 | agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#2998](https://github.com/AgoraIO-Extensions/agent-infra/issues/2998) | test(e2e): real WeCom credential and official QR binding acceptance | 未标注 | agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#2983](https://github.com/AgoraIO-Extensions/agent-infra/issues/2983) | test(e2e): 固定环境验收 DeepSeek 与思考过程（Web 与企微） | priority:P1 | ready-for-agent, priority:P1, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#2938](https://github.com/AgoraIO-Extensions/agent-infra/issues/2938) | fix(local): validate official kindnet NFQUEUE flush fix under default policy | priority:P2 | ready-for-agent, priority:P2, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#2742](https://github.com/AgoraIO-Extensions/agent-infra/issues/2742) | feat(skill): connect project snapshot packaging to the production publication path | 未标注 | agent:codex | 2026-10-26 | 核对 #2949/#2946 消费者交付后收口 |
| Deploy/E2E/Channels | [#1548](https://github.com/AgoraIO-Extensions/agent-infra/issues/1548) | test(skill-hub): accept the deployed lifecycle and Web conversation chain | priority:P0 | ready-for-human, priority:P0, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Deploy/E2E/Channels | [#171](https://github.com/AgoraIO-Extensions/agent-infra/issues/171) | 准备 P0 首发真实环境 ACK tenancy 与访问入口资源 | priority:P0 | wayfinder:task, wayfinder, priority:P0, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Platform/Web/Skill | [#3146](https://github.com/AgoraIO-Extensions/agent-infra/issues/3146) | feat(web): 新建标准模板申请按默认 Key 的 /models 候选选择模型（支持 allowedModels: null） | priority:P1 | ready-for-agent, priority:P1, agent:kiro | 2026-10-27 | 开发中：候选 API、生成客户端和 Web 消费者；遵循当前 ADR-0030 档位 |
| Platform/Web/Skill | [#3139](https://github.com/AgoraIO-Extensions/agent-infra/issues/3139) | fix(model): Catalog 端点追加模型或档位后，已有 Agent 的模型投影全部失效 | 未标注 | needs-triage, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Platform/Web/Skill | [#2976](https://github.com/AgoraIO-Extensions/agent-infra/issues/2976) | feat: 标准 Codex 模板接入 DeepSeek，并在 Web 与企微展示思考过程 | priority:P1 | ready-for-agent, priority:P1, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Platform/Web/Skill | [#2858](https://github.com/AgoraIO-Extensions/agent-infra/issues/2858) | test: accept Platform management Web flow from #535 | 未标注 | agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Platform/Web/Skill | [#702](https://github.com/AgoraIO-Extensions/agent-infra/issues/702) | feat(skill): add project-level Roadmap Goal generator | priority:P2 | enhancement, ready-for-human, priority:P2, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Platform/Web/Skill | [#485](https://github.com/AgoraIO-Extensions/agent-infra/issues/485) | feat(platform): deliver authorized evaluation and quality analysis | priority:P2 | needs-triage, priority:P2, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Platform/Web/Skill | [#481](https://github.com/AgoraIO-Extensions/agent-infra/issues/481) | feat(platform): deliver user and application Agent management API | priority:P0 | needs-triage, priority:P0, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Platform/Web/Skill | [#400](https://github.com/AgoraIO-Extensions/agent-infra/issues/400) | design(web): restore agent-infra IA as the implementation and acceptance baseline | priority:P0 | enhancement, needs-triage, priority:P0, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Workflow/Observability | [#3371](https://github.com/AgoraIO-Extensions/agent-infra/issues/3371) | 体验与时效性：Web 与企微在真实负载下近乎不可用（整体方案） | priority:P0 | needs-triage, priority:P0, agent:kiro | 2026-10-26 | 逐项核对开发子项及父票自身缺口 |
| Workflow/Observability | [#3301](https://github.com/AgoraIO-Extensions/agent-infra/issues/3301) | perf(workload): separate apply and readiness retry budgets | priority:P1 | bug, ready-for-human, priority:P1, agent:codex | 2026-10-26 | 仍缺镜像/PVC 等待与 signed readiness 的实际预算分离 |
| Workflow/Observability | [#690](https://github.com/AgoraIO-Extensions/agent-infra/issues/690) | feat(workflow): add bounded AI coding coordination harness | priority:P2 | enhancement, priority:P2, agent:kiro | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |
| Workflow/Observability | [#144](https://github.com/AgoraIO-Extensions/agent-infra/issues/144) | wayfinder: 形成 Agent 平台 M1 启动与落地路线 | priority:P0 | wayfinder:map, wayfinder, priority:P0, agent:codex | 2026-10-26 | 核对完整开发范围、关联 PR 与依赖；仅余真实验收时记录交接 |

## 开发 PR 回读

状态截至 2026-10-27 02:17 UTC。OPEN 不等于合入，MERGED 不等于真实验收完成。

| PR | 状态 | head SHA | merge SHA | 未完成验收 |
| --- | --- | --- | --- | --- |
| [#3324](https://github.com/AgoraIO-Extensions/agent-infra/pull/3324) | MERGED | `11cfceccb2c9bcd14c89e91582d5797249b8bf3d` | `9cce7b63ea02fb5a9baf004accd40ac60287834c` | 原 [#3193](https://github.com/AgoraIO-Extensions/agent-infra/issues/3193) 的 AC 保持原状态；本表不代勾 |
| [#3469](https://github.com/AgoraIO-Extensions/agent-infra/pull/3469) | OPEN | `f9423929233787799748fabfe3b376418d3ea83f` | — | 原 [#3036](https://github.com/AgoraIO-Extensions/agent-infra/issues/3036) 的 AC 保持原状态；本表不代勾 |
| [#3479](https://github.com/AgoraIO-Extensions/agent-infra/pull/3479) | MERGED | `8abb0a00b0ee07ae30ba49757776ad35c4cdc4b7` | `5e6a73f07fecc082e95ea45336265a3e2233bb13` | 原 [#3428](https://github.com/AgoraIO-Extensions/agent-infra/issues/3428) 的 AC 保持原状态；本表不代勾 |
| [#3495](https://github.com/AgoraIO-Extensions/agent-infra/pull/3495) | MERGED | `ab94692d5291e28ccf6def295f87c00a15ba4ba3` | `0015b97c5e28f72d10782047ad1ecbb60ca020af` | 原 [#3380](https://github.com/AgoraIO-Extensions/agent-infra/issues/3380) 的 AC 保持原状态；本表不代勾 |
| [#3499](https://github.com/AgoraIO-Extensions/agent-infra/pull/3499) | OPEN | `47b50d20139f5e815c09542cc24197d2fada9f75` | — | 原 [#3498](https://github.com/AgoraIO-Extensions/agent-infra/issues/3498) 的 AC 保持原状态；本表不代勾 |
| [#3502](https://github.com/AgoraIO-Extensions/agent-infra/pull/3502) | OPEN | `92757341d64600b5dab669f625b0a2ac4b2e6905` | — | 原 [#3303](https://github.com/AgoraIO-Extensions/agent-infra/issues/3303) 的 AC 保持原状态；本表不代勾 |
| [#3503](https://github.com/AgoraIO-Extensions/agent-infra/pull/3503) | MERGED | `19835f9ae4f6ff17eafdf9d9fdcd0286b90e1c67` | `56e6f7ab08a6bc90c7062a720a2036cba94abc90` | 原 [#3382](https://github.com/AgoraIO-Extensions/agent-infra/issues/3382) 的 AC 保持原状态；本表不代勾 |
| [#3504](https://github.com/AgoraIO-Extensions/agent-infra/pull/3504) | OPEN | `a53399ff64267999a7f50070d8e056ad4467a81d` | — | 原 [#3342](https://github.com/AgoraIO-Extensions/agent-infra/issues/3342) 的 AC 保持原状态；本表不代勾 |
| [#3505](https://github.com/AgoraIO-Extensions/agent-infra/pull/3505) | MERGED | `688654150f8c5198cb9a1898685952fbb12bfd6e` | `d7a36c7738a38ef4467d813f7fcc77062d55c75a` | 原 [#3309](https://github.com/AgoraIO-Extensions/agent-infra/issues/3309) 的 AC 保持原状态；本表不代勾 |
| [#3506](https://github.com/AgoraIO-Extensions/agent-infra/pull/3506) | MERGED | `3f88ab2d77b057aa20492b672c10509633fbe039` | `9926bd7747627803c428c323b30b8c47d12d4820` | 原 [#3365](https://github.com/AgoraIO-Extensions/agent-infra/issues/3365) 的 AC 保持原状态；本表不代勾 |
| [#3507](https://github.com/AgoraIO-Extensions/agent-infra/pull/3507) | MERGED | `3b29fdcb6ae8ef5e81411cf379b8789cafeabac0` | `11ba83ee10eeb5739a7777eec909b6dc8fe73d84` | 原 [#3337](https://github.com/AgoraIO-Extensions/agent-infra/issues/3337) 的 AC 保持原状态；本表不代勾 |
| [#3508](https://github.com/AgoraIO-Extensions/agent-infra/pull/3508) | OPEN | `8afd4e1c906e52fbb163d445f1beaf2341b3d238` | — | 原 [#2989](https://github.com/AgoraIO-Extensions/agent-infra/issues/2989) 的 AC 保持原状态；本表不代勾 |
| [#3509](https://github.com/AgoraIO-Extensions/agent-infra/pull/3509) | OPEN / Draft | `fed51822047417185d1335cb6de84a669a144151` | — | 原 [#3072](https://github.com/AgoraIO-Extensions/agent-infra/issues/3072) 的 AC 保持原状态；本表不代勾 |
| [#3510](https://github.com/AgoraIO-Extensions/agent-infra/pull/3510) | OPEN | `cee18c2eb19cd0d26e66a5d28d392be84b6d8786` | — | 原 [#3106](https://github.com/AgoraIO-Extensions/agent-infra/issues/3106) 的 AC 保持原状态；本表不代勾 |
| [#3511](https://github.com/AgoraIO-Extensions/agent-infra/pull/3511) | MERGED | `d86d52134fb5fe1927d69b05e620d4c75a1ad8bc` | `9b2407c5cb30c8c9de1b6fcc7078600c817a9e47` | 原 [#3159](https://github.com/AgoraIO-Extensions/agent-infra/issues/3159) 的 AC 保持原状态；本表不代勾 |
| [#3512](https://github.com/AgoraIO-Extensions/agent-infra/pull/3512) | OPEN | `d4021c4b56c95b97497fb7127a0a7c356b3b5397` | — | 原 [#3337](https://github.com/AgoraIO-Extensions/agent-infra/issues/3337) 的 AC 保持原状态；本表不代勾 |

| [#3517](https://github.com/AgoraIO-Extensions/agent-infra/pull/3517) | OPEN | `2ccd2e5048fe12c97164489f51396ec9c2d2e98b` | — | #2949 已关闭；真实部署 AC 待后续 |
