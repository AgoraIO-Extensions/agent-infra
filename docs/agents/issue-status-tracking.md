# 开放 Issue 状态跟进

> 快照时间：2026-10-27（UTC）；来源：GitHub `AgoraIO-Extensions/agent-infra` 开放 Issue 实时回读。
> 基线：`origin/main` `56e6f7ab0`。本表是调度快照，Issue 正文、依赖、PR 和真实验收仍是权威来源。

当前开放 Issue：**44**。状态标签不能替代 AC、native blocker、PRD/工程 Spec 或真实环境证据。

## 分类计数

| 类别 | 数量 |
| --- | ---: |
| Runtime/Worker/Core | 14 |
| Deploy/E2E/Channels | 16 |
| Platform/Web/Skill | 8 |
| Workflow/Observability | 6 |

## 明细

| 类别 | Issue | 标题 | 优先级 | 状态/标签 | 来源或负责人 | 最近更新 | 下一步 |
| --- | ---: | --- | --- | --- | --- | --- | --- |
| Runtime/Worker/Core | [#3352](https://github.com/AgoraIO-Extensions/agent-infra/issues/3352) | feat(runtime): deliver Codex native context compaction in conversations | 未标注 | agent:codex | codex（来源标签） | 2026-10-26 | 按优先级和依赖复核后分派 |
| Runtime/Worker/Core | [#3295](https://github.com/AgoraIO-Extensions/agent-infra/issues/3295) | blocker(ack): Flannel 环境未通过 Worker NetworkPolicy 负向验证 | 未标注 | agent:codex | codex（来源标签） | 2026-10-26 | 按优先级和依赖复核后分派 |
| Runtime/Worker/Core | [#3277](https://github.com/AgoraIO-Extensions/agent-infra/issues/3277) | fix(worker): 开启文件交换后，镜像早于 #3256 的 Agent Workload 启动即退出（CrashLoop） | priority:P2 | needs-triage, priority:P2, agent:kiro | kiro（来源标签） | 2026-10-26 | 先补齐 Problem/Scope/Validation/Blocked by，再分派 |
| Runtime/Worker/Core | [#3218](https://github.com/AgoraIO-Extensions/agent-infra/issues/3218) | feat(runtime): Claude、Pi、OpenCode 原生进程补 Landlock 边界后开放 shell（#3202 第 2 步） | priority:P1 | needs-triage, priority:P1, agent:kiro | kiro（来源标签） | 2026-10-26 | 先补齐 Problem/Scope/Validation/Blocked by，再分派 |
| Runtime/Worker/Core | [#3203](https://github.com/AgoraIO-Extensions/agent-infra/issues/3203) | feat(worker): Session Sandbox 支持部署批准的通用出网（#3198） | priority:P1 | needs-triage, priority:P1, agent:kiro | kiro（来源标签） | 2026-10-26 | 先补齐 Problem/Scope/Validation/Blocked by，再分派 |
| Runtime/Worker/Core | [#3202](https://github.com/AgoraIO-Extensions/agent-infra/issues/3202) | feat(runtime): Claude、OpenCode、Pi 标准模板开放原生工具（#3198） | priority:P1 | needs-triage, priority:P1, agent:kiro | kiro（来源标签） | 2026-10-26 | 先补齐 Problem/Scope/Validation/Blocked by，再分派 |
| Runtime/Worker/Core | [#3198](https://github.com/AgoraIO-Extensions/agent-infra/issues/3198) | feat(runtime): 恢复标准模板 Agent 的原生能力，以 Session Sandbox 为隔离边界 | priority:P1 | needs-triage, priority:P1, agent:kiro | kiro（来源标签） | 2026-10-26 | 先补齐 Problem/Scope/Validation/Blocked by，再分派 |
| Runtime/Worker/Core | [#2949](https://github.com/AgoraIO-Extensions/agent-infra/issues/2949) | feat(worker): verify immutable Skill publication evidence before materialization | priority:P1 | priority:P1, agent:codex | codex（来源标签） | 2026-10-26 | 按优先级和依赖复核后分派 |
| Runtime/Worker/Core | [#2946](https://github.com/AgoraIO-Extensions/agent-infra/issues/2946) | fix(worker): deliver Skill generations to the real Runtime PVC with separated identities | priority:P1 | priority:P1, agent:codex | codex（来源标签） | 2026-10-26 | 按优先级和依赖复核后分派 |
| Runtime/Worker/Core | [#2929](https://github.com/AgoraIO-Extensions/agent-infra/issues/2929) | test(runtime): isolate native early-stop failure during recovery setup | priority:P2 | ready-for-agent, priority:P2, agent:codex | codex（来源标签） | 2026-10-26 | 可进入实现；先复读 AC、依赖和当前 head |
| Runtime/Worker/Core | [#2857](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857) | test: accept Session Sandbox multi-entry isolation from #1253 | 未标注 | agent:codex | codex（来源标签） | 2026-10-26 | 按优先级和依赖复核后分派 |
| Runtime/Worker/Core | [#2757](https://github.com/AgoraIO-Extensions/agent-infra/issues/2757) | fix: local concurrent native metadata reads intermittently return 503 (79/100 rounds) | priority:P1 | ready-for-agent, priority:P1, agent:codex | LichKing-2234 | 2026-10-26 | 可进入实现；先复读 AC、依赖和当前 head |
| Runtime/Worker/Core | [#1578](https://github.com/AgoraIO-Extensions/agent-infra/issues/1578) | perf(worker): cut route verification cost on the Runtime submit path | priority:P1 | needs-triage, priority:P1, agent:kiro | kiro（来源标签） | 2026-10-26 | 先补齐 Problem/Scope/Validation/Blocked by，再分派 |
| Runtime/Worker/Core | [#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851) | feat(runtime): deliver standard MCP Agent token client | priority:P0 | priority:P0, agent:codex | LichKing-2234 | 2026-10-26 | 按优先级和依赖复核后分派 |
| Deploy/E2E/Channels | [#3356](https://github.com/AgoraIO-Extensions/agent-infra/issues/3356) | fix(ack): refresh standard-template readiness from real ECI validation | 未标注 | agent:codex | codex（来源标签） | 2026-10-26 | 按优先级和依赖复核后分派 |
| Deploy/E2E/Channels | [#3232](https://github.com/AgoraIO-Extensions/agent-infra/issues/3232) | feat(deploy): expose authenticated standard-template release app for ACK upgrades | priority:P1 | priority:P1, agent:codex | codex（来源标签） | 2026-10-26 | 按优先级和依赖复核后分派 |
| Deploy/E2E/Channels | [#3230](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230) | test(e2e): 固定环境 Web 与企微双向文件和图片验收（#3221） | priority:P1 | needs-triage, priority:P1, agent:kiro | kiro（来源标签） | 2026-10-26 | 先补齐 Problem/Scope/Validation/Blocked by，再分派 |
| Deploy/E2E/Channels | [#3221](https://github.com/AgoraIO-Extensions/agent-infra/issues/3221) | feat(files): 企微与 Web 双向收发文件和图片（附件进入 Sandbox、显式结果文件、企微媒体） | priority:P1 | needs-triage, priority:P1, agent:kiro | kiro（来源标签） | 2026-10-26 | 先补齐 Problem/Scope/Validation/Blocked by，再分派 |
| Deploy/E2E/Channels | [#3193](https://github.com/AgoraIO-Extensions/agent-infra/issues/3193) | test(e2e): read Skill metadata before sandbox terminal teardown | 未标注 | agent:codex | codex（来源标签） | 2026-10-26 | 按优先级和依赖复核后分派 |
| Deploy/E2E/Channels | [#3149](https://github.com/AgoraIO-Extensions/agent-infra/issues/3149) | feat(deployment): automate safe template validation receipt refresh | priority:P1 | priority:P1, agent:codex | codex（来源标签） | 2026-10-26 | 按优先级和依赖复核后分派 |
| Deploy/E2E/Channels | [#3108](https://github.com/AgoraIO-Extensions/agent-infra/issues/3108) | acceptance: ACK resumed conversations receive Messages gateway errors | priority:P1 | priority:P1, agent:codex | codex（来源标签） | 2026-10-26 | 按优先级和依赖复核后分派 |
| Deploy/E2E/Channels | [#3072](https://github.com/AgoraIO-Extensions/agent-infra/issues/3072) | 验收 ACK main 部署的四基础模板与自定义镜像真实链路 | priority:P0 | priority:P0, agent:codex | LichKing-2234 | 2026-10-26 | 按优先级和依赖复核后分派 |
| Deploy/E2E/Channels | [#3060](https://github.com/AgoraIO-Extensions/agent-infra/issues/3060) | fix(local): 固定 E2E 部署缺少文件面装配、FileLimits 声明与 Runtime 文件交换注入 | 未标注 | agent:kiro | kiro（来源标签） | 2026-10-26 | 按优先级和依赖复核后分派 |
| Deploy/E2E/Channels | [#2998](https://github.com/AgoraIO-Extensions/agent-infra/issues/2998) | test(e2e): real WeCom credential and official QR binding acceptance | 未标注 | agent:codex | codex（来源标签） | 2026-10-26 | 按优先级和依赖复核后分派 |
| Deploy/E2E/Channels | [#2983](https://github.com/AgoraIO-Extensions/agent-infra/issues/2983) | test(e2e): 固定环境验收 DeepSeek 与思考过程（Web 与企微） | priority:P1 | ready-for-agent, priority:P1, agent:kiro | kiro（来源标签） | 2026-10-26 | 可进入实现；先复读 AC、依赖和当前 head |
| Deploy/E2E/Channels | [#2939](https://github.com/AgoraIO-Extensions/agent-infra/issues/2939) | perf(local): batch fresh canonical identity reads for directory authority | priority:P1 | ready-for-agent, priority:P1, agent:codex | codex（来源标签） | 2026-10-26 | 可进入实现；先复读 AC、依赖和当前 head |
| Deploy/E2E/Channels | [#2938](https://github.com/AgoraIO-Extensions/agent-infra/issues/2938) | fix(local): validate official kindnet NFQUEUE flush fix under default policy | priority:P2 | ready-for-agent, priority:P2, agent:codex | codex（来源标签） | 2026-10-26 | 可进入实现；先复读 AC、依赖和当前 head |
| Deploy/E2E/Channels | [#2742](https://github.com/AgoraIO-Extensions/agent-infra/issues/2742) | feat(skill): connect project snapshot packaging to the production publication path | 未标注 | agent:codex | codex（来源标签） | 2026-10-26 | 按优先级和依赖复核后分派 |
| Deploy/E2E/Channels | [#1548](https://github.com/AgoraIO-Extensions/agent-infra/issues/1548) | test(skill-hub): accept the deployed lifecycle and Web conversation chain | priority:P0 | ready-for-human, priority:P0, agent:kiro | kiro（来源标签） | 2026-10-26 | 人工门禁；只做证据准备，不自动宣称通过 |
| Deploy/E2E/Channels | [#171](https://github.com/AgoraIO-Extensions/agent-infra/issues/171) | 准备 P0 首发真实环境 ACK tenancy 与访问入口资源 | priority:P0 | wayfinder:task, wayfinder, priority:P0, agent:kiro | LichKing-2234 | 2026-10-26 | 路线/协调项；维护依赖和 owner，不直接当实现票 |
| Platform/Web/Skill | [#3146](https://github.com/AgoraIO-Extensions/agent-infra/issues/3146) | feat(web): 新建标准模板申请按默认 Key 的 /models 候选选择模型（支持 allowedModels: null） | 未标注 | needs-triage, agent:kiro | kiro（来源标签） | 2026-10-26 | 先补齐 Problem/Scope/Validation/Blocked by，再分派 |
| Platform/Web/Skill | [#3139](https://github.com/AgoraIO-Extensions/agent-infra/issues/3139) | fix(model): Catalog 端点追加模型或档位后，已有 Agent 的模型投影全部失效 | 未标注 | needs-triage, agent:kiro | kiro（来源标签） | 2026-10-26 | 先补齐 Problem/Scope/Validation/Blocked by，再分派 |
| Platform/Web/Skill | [#2976](https://github.com/AgoraIO-Extensions/agent-infra/issues/2976) | feat: 标准 Codex 模板接入 DeepSeek，并在 Web 与企微展示思考过程 | priority:P1 | ready-for-agent, priority:P1, agent:kiro | kiro（来源标签） | 2026-10-26 | 可进入实现；先复读 AC、依赖和当前 head |
| Platform/Web/Skill | [#2858](https://github.com/AgoraIO-Extensions/agent-infra/issues/2858) | test: accept Platform management Web flow from #535 | 未标注 | agent:codex | codex（来源标签） | 2026-10-26 | 按优先级和依赖复核后分派 |
| Platform/Web/Skill | [#702](https://github.com/AgoraIO-Extensions/agent-infra/issues/702) | feat(skill): add project-level Roadmap Goal generator | priority:P2 | enhancement, ready-for-human, priority:P2, agent:kiro | LichKing-2234 | 2026-10-26 | 人工门禁；只做证据准备，不自动宣称通过 |
| Platform/Web/Skill | [#485](https://github.com/AgoraIO-Extensions/agent-infra/issues/485) | feat(platform): deliver authorized evaluation and quality analysis | priority:P2 | needs-triage, priority:P2, agent:codex | LichKing-2234 | 2026-10-26 | 先补齐 Problem/Scope/Validation/Blocked by，再分派 |
| Platform/Web/Skill | [#481](https://github.com/AgoraIO-Extensions/agent-infra/issues/481) | feat(platform): deliver user and application Agent management API | priority:P0 | needs-triage, priority:P0, agent:kiro | LichKing-2234 | 2026-10-26 | 先补齐 Problem/Scope/Validation/Blocked by，再分派 |
| Platform/Web/Skill | [#400](https://github.com/AgoraIO-Extensions/agent-infra/issues/400) | design(web): restore agent-infra IA as the implementation and acceptance baseline | priority:P0 | enhancement, needs-triage, priority:P0, agent:codex | LichKing-2234 | 2026-10-26 | 先补齐 Problem/Scope/Validation/Blocked by，再分派 |
| Workflow/Observability | [#3371](https://github.com/AgoraIO-Extensions/agent-infra/issues/3371) | 体验与时效性：Web 与企微在真实负载下近乎不可用（整体方案） | priority:P0 | needs-triage, priority:P0, agent:kiro | kiro（来源标签） | 2026-10-26 | 先补齐 Problem/Scope/Validation/Blocked by，再分派 |
| Workflow/Observability | [#3301](https://github.com/AgoraIO-Extensions/agent-infra/issues/3301) | perf(workload): separate apply and readiness retry budgets | priority:P1 | bug, ready-for-human, priority:P1, agent:codex | codex（来源标签） | 2026-10-26 | 人工门禁；只做证据准备，不自动宣称通过 |
| Workflow/Observability | [#3254](https://github.com/AgoraIO-Extensions/agent-infra/issues/3254) | test(wecom): media.test 的地址到期用例依赖 60ms 真实时间窗口，CI 偶发失败 | priority:P2 | needs-triage, priority:P2, agent:kiro | kiro（来源标签） | 2026-10-26 | 先补齐 Problem/Scope/Validation/Blocked by，再分派 |
| Workflow/Observability | [#3159](https://github.com/AgoraIO-Extensions/agent-infra/issues/3159) | test(runtime): bounds historical bootstrap slots 用例在 CI 负载下偶发 5 秒超时 | priority:P2 | needs-triage, priority:P2, agent:kiro | kiro（来源标签） | 2026-10-26 | 先补齐 Problem/Scope/Validation/Blocked by，再分派 |
| Workflow/Observability | [#690](https://github.com/AgoraIO-Extensions/agent-infra/issues/690) | feat(workflow): add bounded AI coding coordination harness | priority:P2 | enhancement, priority:P2, agent:kiro | LichKing-2234 | 2026-10-26 | 按优先级和依赖复核后分派 |
| Workflow/Observability | [#144](https://github.com/AgoraIO-Extensions/agent-infra/issues/144) | wayfinder: 形成 Agent 平台 M1 启动与落地路线 | priority:P0 | wayfinder:map, wayfinder, priority:P0, agent:codex | LichKing-2234 | 2026-10-26 | 路线/协调项；维护依赖和 owner，不直接当实现票 |
