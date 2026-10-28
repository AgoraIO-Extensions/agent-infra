# 开放 Issue 状态跟进

> 采集回读窗口（as-of）：2026-10-28 11:11:42 UTC 至 2026-10-28 11:11:48 UTC。
> 来源基线：新 worktree 创建前 fetch 回读的 `origin/main` exact SHA `c8f916f2b57edbf79f61b0120b96d78e30c594f4`。
> 这是带时间的快照；动态状态以 GitHub 链接重新回读为准，旧 head 的验证不得用于新提交或 dirty 组合。

采集时开放 Issue **26**：业务与验收 **25**，本次快照治理 [#3660](https://github.com/AgoraIO-Extensions/agent-infra/issues/3660) **1**；
开放 PR **9**。本快照 PR 尚未创建，不计入该数。后续合入不自动触发下一张刷新票，
不为追逐数字形成文档循环。操作顺序见 [Issue 工作指导](issue-work-guidance.md)。

## 分类计数

| 类别 | 数量 |
| --- | ---: |
| Runtime/Worker/Core | 7 |
| Deploy/E2E/Channels | 9 |
| Platform/Web/Skill | 7 |
| Workflow/Observability | 2 |

## 明细

| 类别 | Issue | 标题 | 采集时标签 | 下一步与边界 |
| --- | --- | --- | --- | --- |
| Runtime/Worker/Core | [#3658](https://github.com/AgoraIO-Extensions/agent-infra/issues/3658) | perf(store): 授权目标读取只查询必要的会话归属 | priority:P0, agent:codex | 原性能 lane / PR #3659；收窄会话授权查询，等待当前 head 验证，不接管其 Store 文件 |
| Platform/Web/Skill | [#3654](https://github.com/AgoraIO-Extensions/agent-infra/issues/3654) | fix(web): 补齐无附件 Skill 调用的请求元数据 | priority:P0, agent:codex | 原 Skill session / PR #3655；补无附件调用请求元数据，真实 Skill 验收仍由原 owner 跟进 |
| Deploy/E2E/Channels | [#3653](https://github.com/AgoraIO-Extensions/agent-infra/issues/3653) | feat(ack): run portable private deployment capsules | priority:P1, agent:codex | 原 ACK session / PR #3656；可迁移私有部署 capsule，实际重部署与业务回执由原 owner 负责 |
| Platform/Web/Skill | [#3651](https://github.com/AgoraIO-Extensions/agent-infra/issues/3651) | fix(skill-hub): 配置修订更新时保留固定版本绑定 | priority:P0, agent:codex | 原 Skill session / PR #3652；修订更新时保留固定绑定，保持原文件所有权 |
| Deploy/E2E/Channels | [#3649](https://github.com/AgoraIO-Extensions/agent-infra/issues/3649) | fix(ack): recover interrupted login output promotion without mixed bundles | priority:P1, agent:codex | PR #3650；独立 85 项、竞争差分与恢复进程中断验证通过，等待当前 head 完整 CI；未执行真实 ACK |
| Deploy/E2E/Channels | [#3646](https://github.com/AgoraIO-Extensions/agent-infra/issues/3646) | test(e2e): distinguish coalesced SSE completion from incremental rendering | priority:P1, agent:codex | 原 ACK session / PR #3648；区分合并 SSE 完成与增量显示，等待 Heavy；不以完成时间冒充首 token |
| Platform/Web/Skill | [#3640](https://github.com/AgoraIO-Extensions/agent-infra/issues/3640) | feat(eval): deliver comparative analysis feedback and complete Web workflow | priority:P2, agent:codex | 待 #3638/#3639 合入；完整分析、反馈分母与页面闭环，不能仅交静态界面 |
| Runtime/Worker/Core | [#3639](https://github.com/AgoraIO-Extensions/agent-infra/issues/3639) | feat(eval): run authorized experiments with independent scoring and review | priority:P2, agent:codex | 待 #3638 合入冻结数据权威；用户/应用真实 Eval Task、三评分与独立复核，保留四模板真实 AC |
| Platform/Web/Skill | [#3638](https://github.com/AgoraIO-Extensions/agent-infra/issues/3638) | feat(eval): deliver versioned datasets and purpose-bound content authority | priority:P2, agent:codex | PR #3657 Draft；数据/授权/API/PG/S3/页面已实现，最新提交全量检查与 CI 仍在推进 |
| Deploy/E2E/Channels | [#3295](https://github.com/AgoraIO-Extensions/agent-infra/issues/3295) | blocker(ack): Flannel 环境未通过 Worker NetworkPolicy 负向验证 | agent:codex | 真实网络隔离环境门禁；Flannel 缺少策略执行证明，需获准环境与负向验证，不原地更换共享 CNI |
| Deploy/E2E/Channels | [#3230](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230) | test(e2e): 固定环境 Web 与企微双向文件和图片验收（#3221） | needs-triage, priority:P1, agent:kiro | 真实 Web/企微双向文件图片矩阵待验；局部回执不代替跨主体、哈希与完整 AC |
| Runtime/Worker/Core | [#3218](https://github.com/AgoraIO-Extensions/agent-infra/issues/3218) | feat(runtime): Claude、Pi、OpenCode 原生进程补 Landlock 边界后开放 shell（#3202 第 2 步） | priority:P1, agent:kiro | PR #3635 Draft；三模板原生 shell/凭证隔离仍在开发验证，Claude 真实 Bash 失败待定位，不放宽安全上下文 |
| Runtime/Worker/Core | [#3202](https://github.com/AgoraIO-Extensions/agent-infra/issues/3202) | feat(runtime): Claude、OpenCode、Pi 标准模板开放原生工具（#3198） | needs-triage, priority:P1, agent:kiro | 开发 child #3218 未完成；三模板 shell 全范围交付前保留开放 |
| Runtime/Worker/Core | [#3198](https://github.com/AgoraIO-Extensions/agent-infra/issues/3198) | feat(runtime): 恢复标准模板 Agent 的原生能力，以 Session Sandbox 为隔离边界 | needs-triage, priority:P1, agent:kiro | child #3203 已完成、#3202 未完成；不因通用出网合入关闭原生能力父票 |
| Deploy/E2E/Channels | [#3108](https://github.com/AgoraIO-Extensions/agent-infra/issues/3108) | acceptance: ACK resumed conversations receive Messages gateway errors | priority:P1, agent:codex | 已有当前 Claude 两轮证据；原历史失败会话恢复、完整时延与错误诊断 AC 未完成 |
| Deploy/E2E/Channels | [#2998](https://github.com/AgoraIO-Extensions/agent-infra/issues/2998) | test(e2e): real WeCom credential and official QR binding acceptance | agent:codex | 真实企微凭证、扫码与绑定回读待验；需要实际账号/扫码，不虚构结果 |
| Deploy/E2E/Channels | [#2983](https://github.com/AgoraIO-Extensions/agent-infra/issues/2983) | test(e2e): 固定环境验收 DeepSeek 与思考过程（Web 与企微） | ready-for-agent, priority:P1, agent:kiro | DeepSeek 与思考过程的 Web/企微真实矩阵待验，标签不代替当前部署证据 |
| Platform/Web/Skill | [#2858](https://github.com/AgoraIO-Extensions/agent-infra/issues/2858) | test: accept Platform management Web flow from #535 | agent:codex | 真实管理 Web/API/PG 流程待验；包含 Auth Gateway 缺失拒绝与 Owner 重试回执 |
| Runtime/Worker/Core | [#2857](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857) | test: accept Session Sandbox multi-entry isolation from #1253 | agent:codex | 真实 Session Sandbox 三入口、多 Runtime、重启撤权和跨主体隔离待验 |
| Platform/Web/Skill | [#1548](https://github.com/AgoraIO-Extensions/agent-infra/issues/1548) | test(skill-hub): accept the deployed lifecycle and Web conversation chain | ready-for-human, priority:P0, agent:kiro | 原 Skill session 持续跟进；已合入 #3643，#3652/#3655 在途，服务端局部证据不代签浏览器/模型全矩阵 |
| Runtime/Worker/Core | [#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851) | feat(runtime): deliver standard MCP Agent token client | priority:P0, agent:codex | 开发外部依赖未满足：Connection 机器注册/独立 Consumer 与 token 供应合同；现有管理员 Cookie 或 DCR 不替代 |
| Workflow/Observability | [#690](https://github.com/AgoraIO-Extensions/agent-infra/issues/690) | feat(workflow): add bounded AI coding coordination harness | enhancement, priority:P2, agent:kiro | PR #3645；真实两 lane 协调、显式交接和独立验证已发生，正在收口 AC-1–12 试运行证据；不代表整个 M1 完成 |
| Platform/Web/Skill | [#485](https://github.com/AgoraIO-Extensions/agent-infra/issues/485) | feat(platform): deliver authorized evaluation and quality analysis | priority:P2, agent:codex | 子票 #3633 已关闭；#3638/#3639/#3640 开放，完整 Eval 数据/实验/评分/分析/页面尚未交付 |
| Deploy/E2E/Channels | [#171](https://github.com/AgoraIO-Extensions/agent-infra/issues/171) | 准备 P0 首发真实环境 ACK tenancy 与访问入口资源 | wayfinder:task, wayfinder, priority:P0, agent:kiro | ACK tenancy、策略执行、存储、Registry、RBAC、DNS/TLS 真实环境门禁待验 |
| Workflow/Observability | [#144](https://github.com/AgoraIO-Extensions/agent-infra/issues/144) | wayfinder: 形成 Agent 平台 M1 启动与落地路线 | wayfinder:map, wayfinder, priority:P0, agent:codex | 完整原生分页回读开放 child #171/#485；环境与 Eval 开发均未闭环，父票保留开放 |

## 当前分派与文件所有权

| Lane | Primary / PR | 唯一写入范围与下一交付点 |
| --- | --- | --- |
| Runtime 原生隔离 | #3218 / #3635 | 当前 Runtime implementer：原生 child launcher、Claude/Pi/OpenCode 接线及对应测试；固定安全上下文中的实际 shell 证据 |
| Eval 数据 | #3638 / #3657 | 当前 Eval implementer：Core/Store/Contracts/API/Worker/Web 数据权威、0069 迁移及共享装配；完整检查后冻结接口 |
| Eval 实验与分析 | #3639 / #3640 | 尚未准入写入；前者依赖 #3638，后者依赖 #3638/#3639；不得抢写在途共享模块 |
| 登录输出恢复 | #3649 / #3650 | 交接后 Coordinator 持有 writer；仅 bootstrap、promotion helper、专属测试和 ACK workflow 文档；当前独立复验通过，等待 CI |
| ACK capsule / SSE 验收 | #3653 / #3656；#3646 / #3648 | 原 ACK session；部署私有输入及 SSE 验证文件，不接管其环境或 credentials |
| Skill / Web native 调用 | #3651 / #3652；#3654 / #3655 | 原 Skill session；绑定与 native 调用请求链，继续保留 #3553 排除范围 |
| 授权查询性能 | #3658 / #3659 | 原性能 session；会话授权目标读取及对应测试，与 Eval Store 集成先核对具体路径 |
| 协调与状态 | #690 / #3645；#3660 | Coordinator 负责交接、依赖、阶段与快照；watcher 只观察，合并后单 PR cleanup 按活动进程/dirty 预检 |

上述 owner 是采集时角色记录；新执行者必须回读当前 Issue、PR、worktree 和显式交接，不能凭表格接管。

## 开发 PR 回读

取消的重复 run 不视为当前 head 失败；Draft、失败与运行中分别保留。下表为采集窗口原始状态，
即使正文编辑或 review 后状态再变化，也不改写历史采集值。

| PR | 状态 | exact head | 采集时检查 |
| --- | --- | --- | --- |
| [#3659](https://github.com/AgoraIO-Extensions/agent-infra/pull/3659) | Ready / BLOCKED | `427f0e425da8a97701cef1e410a072f91d13f4d3` | 运行/排队：Backend integration tests, CI heavy validation, Workload kind |
| [#3657](https://github.com/AgoraIO-Extensions/agent-infra/pull/3657) | Draft / BLOCKED | `55af29df8d300fd8abde38d9bc99f1dd3b7920d1` | 失败：Backend integration tests, Web unit tests；运行/排队：CI heavy validation, Workload kind |
| [#3656](https://github.com/AgoraIO-Extensions/agent-infra/pull/3656) | Ready / BLOCKED | `cf934120c95089a94cc3828105690acd61c9c775` | 运行/排队：Backend integration tests, CI heavy validation, Workload kind |
| [#3655](https://github.com/AgoraIO-Extensions/agent-infra/pull/3655) | Ready / UNKNOWN | `04459ece5d5ee1d0e94cbcfa4d5a639200e2fc4e` | 运行/排队：CI heavy validation |
| [#3652](https://github.com/AgoraIO-Extensions/agent-infra/pull/3652) | Ready / UNKNOWN | `06531265dbaccb0b0e57d78ebc809df537c80b35` | 无运行中检查；已完成项见 PR |
| [#3650](https://github.com/AgoraIO-Extensions/agent-infra/pull/3650) | Ready / BLOCKED | `fbda127ba52a2213ff2eed9d8193ccd21a4da98d` | 运行/排队：CI heavy validation |
| [#3648](https://github.com/AgoraIO-Extensions/agent-infra/pull/3648) | Ready / BLOCKED | `991844e9788184f0a1f560a709420949cc779b7c` | 运行/排队：CI heavy validation |
| [#3645](https://github.com/AgoraIO-Extensions/agent-infra/pull/3645) | Draft / BLOCKED | `4e31fba014dd9be05ed3dec1cd7e12c32a68a7fa` | 无运行中检查；已完成项见 PR |
| [#3635](https://github.com/AgoraIO-Extensions/agent-infra/pull/3635) | Draft / BLOCKED | `192a7002daf6058d8673b5b705e450e0b22a95bd` | 运行/排队：Backend integration tests, CI heavy validation, Workload kind |

## 本批已合入开发交付

| PR | 交付 | merge SHA |
| --- | --- | --- |
| [#3647](https://github.com/AgoraIO-Extensions/agent-infra/pull/3647) | fix(ack): validate custom Agents by interaction mode | `19fe1d5fe998cd7085a9bf05c6347eb905d963e8` |
| [#3643](https://github.com/AgoraIO-Extensions/agent-infra/pull/3643) | fix(worker): mount verified skills in session sandboxes | `c8f916f2b57edbf79f61b0120b96d78e30c594f4` |
| [#3642](https://github.com/AgoraIO-Extensions/agent-infra/pull/3642) | test(wecom): make media decryption failure deterministic | `03aa36230834a3fecf8ce8c54d996f35144e4890` |
| [#3636](https://github.com/AgoraIO-Extensions/agent-infra/pull/3636) | docs(eval): clarify pending versions and feedback denominators | `39fb0ab8aac2ffebdbedc53cf17533fe3f01de1b` |
| [#3634](https://github.com/AgoraIO-Extensions/agent-infra/pull/3634) | docs(eval): define purpose authority retention and scorer admission | `c6752487472c382f6516c1c7dd8d70457af4f09d` |
| [#3632](https://github.com/AgoraIO-Extensions/agent-infra/pull/3632) | fix(ack): derive deployment identities from fresh login | `446744a822caa7769d81bef33053deeab486ca4e` |
| [#3631](https://github.com/AgoraIO-Extensions/agent-infra/pull/3631) | fix(audit): expose application credential governance facts | `d5af9f9d0888f493f222b291b5318421d3526804` |
| [#3630](https://github.com/AgoraIO-Extensions/agent-infra/pull/3630) | feat(worker): enforce deployment-approved native egress | `69a9ec9233375dfa2552a2dadef119a28cbc178b` |
| [#3629](https://github.com/AgoraIO-Extensions/agent-infra/pull/3629) | feat(api): support personal Token identity and single Agent reads | `cd4087f9f44565037bdd24b4c6bddac02a45ebb1` |
| [#3627](https://github.com/AgoraIO-Extensions/agent-infra/pull/3627) | fix(ack): isolate template preflight state per deployment run | `a15a4bbb5e3cd5dd05d2a8540c362eba55e3990c` |
| [#3623](https://github.com/AgoraIO-Extensions/agent-infra/pull/3623) | fix(model): preserve saved projections across compatible catalog changes | `0c8e7c383162bf6ebf768077b17cbf8a758bd3fa` |
| [#3621](https://github.com/AgoraIO-Extensions/agent-infra/pull/3621) | fix(ack): publish measured runtime inputs before provisioning | `d19094bff041c8b7ae3e77c4d2e594c1c72d7c97` |
| [#3620](https://github.com/AgoraIO-Extensions/agent-infra/pull/3620) | fix(core): decouple V6 admission from wire contracts | `10ee58fad3a11eb55f7d6ce9d9f1afb5132f7657` |
| [#3618](https://github.com/AgoraIO-Extensions/agent-infra/pull/3618) | fix(storage): classify persisted invalid S3 content as conflict | `af1e9c78c5fc1e15fa730c02bd4c57cb38c3f7a1` |
| [#3613](https://github.com/AgoraIO-Extensions/agent-infra/pull/3613) | fix(skill): connect native SkillSpector reports to publication | `93d56323ae71281f3f01dfdd1bd4768106bbbe84` |
| [#3612](https://github.com/AgoraIO-Extensions/agent-infra/pull/3612) | feat(platform): complete application credential metadata and revocation | `6b3b8b8c5562cba62081cc7f4e44b7f43445ec8f` |

开发完成关闭与真实 AC 签收分开。#3625 随 #3629 关闭；#3644 随 #3647 关闭；#3637 随 #3643 关闭。
父票 #481 的开发子项及自身范围已收口关闭；关联真实验收不因此自动通过。#3608 当前已关闭，其部署证据
由原 ACK owner 维护，不因历史快照曾开放而反复切换状态。

## 父子收口与真实验收

- 原生关系：#3198 → #3202（open）/#3203（closed）；#3202 → #3218（open）。原生 shell 全范围未完成，父票保持开放。
- #485 → #3633（closed）、#3638/#3639/#3640（open）；数据交付不代替实验、三评分、独立复核、分析与反馈完整范围。
- #144 的原生 children 已完整分页回读，仍开放 #171 与 #485；子项闭环后还须检查父票自身决策/交付要求。
- #851 属于开发合同依赖，#3295 属于真实网络策略环境门禁；不能混为“代码已完成只待 AC”。
- 真实 AC 沿原 Issue 保留逐项证据；fixture、健康检查、Pod Ready、历史会话和其他 head 均不替代当前完整验收。
- ACK 验收须确认对应实现已经部署，并协调环境 owner；未部署不操作。#3553 由其他 session 跟进。
