# 开放 Issue 状态跟进

> 采集时刻（as-of）：2026-10-28 02:51 UTC。
> 来源基线：本次 fetch 回读的 `origin/main` exact SHA `ba94ec90fed7b5e29b06456ef3d5a1888805ba8e`。
> 下表记录采集时刻的 GitHub 状态；Issue 与 PR 链接用于后续实时回读，状态不代表验收通过。

本快照按采集时刻核对开放集合、计数和 PR head。后续 main 推进、Issue 关闭或本次文档 PR 合入，
不会使这份历史快照失真，也不自动触发下一次刷新或创建新的 tracker Issue。需要重新盘点时，
再明确新的采集时刻和来源基线；本次文档 PR 在采集后创建，不计入下表。

采集时刻开放 Issue：**25**。开发交付与真实验收分别跟进，未完成的 AC 仍以各 Issue 为准。

## 分类计数

| 类别 | 数量 |
| --- | ---: |
| Runtime/Worker/Core | 10 |
| Deploy/E2E/Channels | 7 |
| Platform/Web/Skill | 6 |
| Workflow/Observability | 2 |

## 明细

| 类别 | Issue | 标题 | 优先级 | 采集时标签 | 最近更新（UTC） | 下一步 |
| --- | --- | --- | --- | --- | --- | --- |
| Runtime/Worker/Core | [#3605](https://github.com/AgoraIO-Extensions/agent-infra/issues/3605) | fix(worker): preserve valid Skill mounts during workload reconciliation | priority:P0 | priority:P0, agent:codex | 2026-10-28 | 原会话负责 Skill 挂载调谐修复；等待回归、稳定 Pod identity 与真实运行回读，关联 #1548 |
| Runtime/Worker/Core | [#3603](https://github.com/AgoraIO-Extensions/agent-infra/issues/3603) | fix(worker): inject Codex container boundary for standard workloads | priority:P1 | priority:P1, agent:codex | 2026-10-28 | 原会话负责 PR #3604；等待当前 head CI、合入、ACK 来源 tuple 与真实 turn 回读 |
| Runtime/Worker/Core | [#3295](https://github.com/AgoraIO-Extensions/agent-infra/issues/3295) | blocker(ack): Flannel 环境未通过 Worker NetworkPolicy 负向验证 | 未标注 | agent:codex | 2026-10-27 | 环境门禁：准备支持策略执行的 ACK 环境，补普通节点与 ECI 的 allow/deny/recovery；不原地更换共享集群 CNI |
| Runtime/Worker/Core | [#3277](https://github.com/AgoraIO-Extensions/agent-infra/issues/3277) | fix(worker): 开启文件交换后，镜像早于 #3256 的 Agent Workload 启动即退出（CrashLoop） | priority:P2 | needs-triage, priority:P2, agent:kiro | 2026-10-27 | 先确认按 Agent 能力注入或部署前迁移/停止旧镜像的方案及负责人，再实现回归与启用顺序 |
| Runtime/Worker/Core | [#3218](https://github.com/AgoraIO-Extensions/agent-infra/issues/3218) | feat(runtime): Claude、Pi、OpenCode 原生进程补 Landlock 边界后开放 shell（#3202 第 2 步） | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 | 先实测固定三模板二进制的 Landlock 与子进程凭证清理，再实现 shell/probe 和真实负例 |
| Runtime/Worker/Core | [#3203](https://github.com/AgoraIO-Extensions/agent-infra/issues/3203) | feat(worker): Session Sandbox 支持部署批准的通用出网（#3198） | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 | 确认部署批准的出网契约与负责人，交付策略编译及固定拒绝项，补真实 CNI 正负例 |
| Runtime/Worker/Core | [#3202](https://github.com/AgoraIO-Extensions/agent-infra/issues/3202) | feat(runtime): Claude、OpenCode、Pi 标准模板开放原生工具（#3198） | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 | 第 1 步已合入；等待 #3218 的 Landlock、凭证清理和原生 shell 开发交付 |
| Runtime/Worker/Core | [#3198](https://github.com/AgoraIO-Extensions/agent-infra/issues/3198) | feat(runtime): 恢复标准模板 Agent 的原生能力，以 Session Sandbox 为隔离边界 | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-27 | 等待 #3202/#3218 原生工具边界与 #3203 通用出网交付，再核对父票完整范围 |
| Runtime/Worker/Core | [#2857](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857) | test: accept Session Sandbox multi-entry isolation from #1253 | 未标注 | agent:codex | 2026-10-26 | 固定 Harness/镜像/配置与双主体，完成三入口、多 Runtime、重启撤权和跨 Session/Agent 隔离 |
| Runtime/Worker/Core | [#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851) | feat(runtime): deliver standard MCP Agent token client | priority:P0 | priority:P0, agent:codex | 2026-10-26 | 等待 Connection 提供获准的独立 Consumer 注册与 token 供应契约；不以 DCR 或管理员 Cookie 替代 |
| Deploy/E2E/Channels | [#3581](https://github.com/AgoraIO-Extensions/agent-infra/issues/3581) | fix(deploy): validate ACK preflight jobs against template manifest | priority:P0 | priority:P0, agent:codex | 2026-10-28 | 已重开；PR #3582 已修复 sourceCommit formatter，等待当前 head CI 和模板 manifest 预检回读；非空断言为 warning |
| Deploy/E2E/Channels | [#3230](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230) | test(e2e): 固定环境 Web 与企微双向文件和图片验收（#3221） | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 | 在固定环境补 Web 双向文件、企微 PDF/语音、跨主体负例及哈希回读；已有图片证据不覆盖其余 AC |
| Deploy/E2E/Channels | [#3108](https://github.com/AgoraIO-Extensions/agent-infra/issues/3108) | acceptance: ACK resumed conversations receive Messages gateway errors | priority:P1 | priority:P1, agent:codex | 2026-10-28 | fresh Claude 会话仅见 UI 准备中；待回读消息/execution 受理、事件和终态，尚不能确认服务端根因 |
| Deploy/E2E/Channels | [#2998](https://github.com/AgoraIO-Extensions/agent-infra/issues/2998) | test(e2e): real WeCom credential and official QR binding acceptance | 未标注 | agent:codex | 2026-10-26 | 等待获准企微真实账号与人工扫码，验证无效凭证、一次确认、机器人计数和绑定回读 |
| Deploy/E2E/Channels | [#2983](https://github.com/AgoraIO-Extensions/agent-infra/issues/2983) | test(e2e): 固定环境验收 DeepSeek 与思考过程（Web 与企微） | priority:P1 | ready-for-agent, priority:P1, agent:kiro | 2026-10-26 | 在固定环境复验 DeepSeek 首条消息与思考/答案投递，补群聊及 B 账号隔离证据 |
| Deploy/E2E/Channels | [#1548](https://github.com/AgoraIO-Extensions/agent-infra/issues/1548) | test(skill-hub): accept the deployed lifecycle and Web conversation chain | priority:P0 | ready-for-human, priority:P0, agent:kiro | 2026-10-28 | 原会话继续真实 Skill 生命周期验收；先完成 #3605 挂载调谐修复，再回读 Runtime 文件与对话工具结果 |
| Deploy/E2E/Channels | [#171](https://github.com/AgoraIO-Extensions/agent-infra/issues/171) | 准备 P0 首发真实环境 ACK tenancy 与访问入口资源 | priority:P0 | wayfinder:task, wayfinder, priority:P0, agent:kiro | 2026-10-26 | 回读 ACK 策略执行、PVC/StorageClass、Registry pull、RBAC 与 DNS/TLS；历史资源清单不作当前签收 |
| Platform/Web/Skill | [#3139](https://github.com/AgoraIO-Extensions/agent-infra/issues/3139) | fix(model): Catalog 端点追加模型或档位后，已有 Agent 的模型投影全部失效 | 未标注 | needs-triage, agent:kiro | 2026-10-28 | 等待维护者明确 V1/V4 字段级兼容方案和负责人；随后补保存投影的兼容变更正例与不兼容负例 |
| Platform/Web/Skill | [#2858](https://github.com/AgoraIO-Extensions/agent-infra/issues/2858) | test: accept Platform management Web flow from #535 | 未标注 | agent:codex | 2026-10-26 | 复验真实管理 Web/API/PG 闭环，覆盖 Auth Gateway 缺失的申请拒绝和 Owner 重试回执 |
| Platform/Web/Skill | [#702](https://github.com/AgoraIO-Extensions/agent-infra/issues/702) | feat(skill): add project-level Roadmap Goal generator | priority:P2 | enhancement, ready-for-human, priority:P2, agent:kiro | 2026-10-26 | 保留 P2 后续开发目标；等待明确资源窗口与剩余 AC，不混入平台用户 Skill 产品链 |
| Platform/Web/Skill | [#485](https://github.com/AgoraIO-Extensions/agent-infra/issues/485) | feat(platform): deliver authorized evaluation and quality analysis | priority:P2 | needs-triage, priority:P2, agent:codex | 2026-10-26 | 等待明确 M1 执行窗口及完整依赖准入，维持 needs-triage |
| Platform/Web/Skill | [#481](https://github.com/AgoraIO-Extensions/agent-infra/issues/481) | feat(platform): deliver user and application Agent management API | priority:P0 | needs-triage, priority:P0, agent:kiro | 2026-10-26 | 核对剩余 Web/凭证/Workload 开发范围、负责人和准入；既有幂等 API 测试不代替其余 AC |
| Platform/Web/Skill | [#400](https://github.com/AgoraIO-Extensions/agent-infra/issues/400) | design(web): restore agent-infra IA as the implementation and acceptance baseline | priority:P0 | enhancement, needs-triage, priority:P0, agent:codex | 2026-10-26 | 按原始 IA 与获准视觉修订核对 AC-7–AC-11，明确剩余页面交互及真实 API/权限验收交接 |
| Workflow/Observability | [#690](https://github.com/AgoraIO-Extensions/agent-infra/issues/690) | feat(workflow): add bounded AI coding coordination harness | priority:P2 | enhancement, priority:P2, agent:kiro | 2026-10-26 | 保留 P2；确认执行窗口后按原 AC-1–AC-12 继续，不进入无人值守执行队列 |
| Workflow/Observability | [#144](https://github.com/AgoraIO-Extensions/agent-infra/issues/144) | wayfinder: 形成 Agent 平台 M1 启动与落地路线 | priority:P0 | wayfinder:map, wayfinder, priority:P0, agent:codex | 2026-10-27 | 按开放开发子项和地图自身范围逐项跟进；保留真实 ACK/Browser/Connection 验收，暂不能关闭 |

## 开发 PR 回读

状态截至同一采集时刻，开放 PR 共 **2** 个。OPEN 不等于合入，MERGED 不等于真实验收完成。

| PR | 状态 | head SHA | 未完成门禁与下一步 |
| --- | --- | --- | --- |
| [#3582](https://github.com/AgoraIO-Extensions/agent-infra/pull/3582) | OPEN / BLOCKED | `3284ae2409325d50343779e3057f219aa1d07d17` | Issue Gate、Web unit tests 已通过；Backend integration tests、CI heavy validation、Workload kind 运行中；未解决 review threads 为 0，等待当前 head CI 与合入 |
| [#3604](https://github.com/AgoraIO-Extensions/agent-infra/pull/3604) | OPEN / BLOCKED | `998813cb477db529ba881b7f15ea1d07c9f7d7ab` | Issue Gate、Web unit tests 已通过；Backend integration tests、CI heavy validation、Workload kind 运行中；未解决 review threads 为 0；auto-merge enrollment 已取消，由原会话跟进 |
