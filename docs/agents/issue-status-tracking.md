# 开放 Issue 状态跟进

> 本次回读截止（as-of）：2026-10-30T06:05:00+00:00。
> 来源基线：创建 worktree 前 fetch 回读的 `origin/main` exact SHA `4f348ad5a21dd55d31bd7d666845089ca1c4d2b1`。
> 本文是带时间的分派快照；执行前重新回读 GitHub、来源和资源占用，按 [Issue 工作指导](issue-work-guidance.md) 确认边界。

采集时开放 Issue **15**：业务与验收 **14**，本次文档治理 [#3762](https://github.com/AgoraIO-Extensions/agent-infra/issues/3762) **1**。
开发 child #3752/#3756 已分别由 PR #3754/#3757 合入并自动关闭；开放 PR 仅剩 Draft [#3751](https://github.com/AgoraIO-Extensions/agent-infra/pull/3751)，head `22ad52ee060bf8c213e932a8ef13b0e0988325d1`。
本快照自身 PR 尚未创建，不计入开放 PR 数量。PR head 或新票变化后重新采集，不能用此表覆盖 GitHub。

## 当前归属复核与纠正

历史创建者、描述中的 Session ID、标签、空 assignee 和闲置状态不能证明当前 writer。
本轮在 Issue/PR、工作树与活动会话交叉核对后，取得 Skill Hub、隔离/企微、网络筹备三条原 session
的直接接收；#851 改由协调者子代理实际核查，ACK 发布/性能和 Runtime 原 owner 继续各自工作。
筹备责任与完整验收排期分别记录。共享 Harness 的只读窗口已结束，后续写入由 Skill Hub owner
独占；其他验收需显式交接，不能从旧的释放记录或健康端口推断可接管。

历史“十六项均有 session 正在或将要处理”的说法已由 [#3720](https://github.com/AgoraIO-Extensions/agent-infra/pull/3720) 纠正：当时只有五项取得确认。
后续 [#3726](https://github.com/AgoraIO-Extensions/agent-infra/pull/3726) 记录有限筹备交接；本次以上述实际接收和新执行事实更新，不追认历史排期。

## 分类计数

| 类别 | 业务与验收数量 |
| --- | ---: |
| Runtime/Worker/Core | 3 |
| Deploy/E2E/Channels | 7 |
| Platform/Web/Skill | 2 |
| Workflow/Observability | 2 |

## 当前分派与文件所有权

Connection 服务端、Provider/Grant/凭据和共享部署资源不随 Platform 消费调查转移。
只有直接接收且有具体下一交付的 lane 记录执行责任；缺少外部输入的范围仍明确保留。

| Issue / 类别 | 采集时标签 | 当前责任 | 下一动作与证据边界 |
| --- | --- | --- | --- |
| [#3741](https://github.com/AgoraIO-Extensions/agent-infra/issues/3741) / Deploy/E2E/Channels | priority:P1, agent:codex | 发布 owner 当前实现 | PR #3751 保持 Draft。RuntimeHost 两架构 push 已确认 authorization 失败；需要 package admin 为本仓库设置 Manage Actions access=Write。Hosted Backend 的既有 codex-runtime-driver 断言与 Heavy 的 task-feedback reload 旅程失败独立处理，不将其混入发布生产改动。 |
| [#3692](https://github.com/AgoraIO-Extensions/agent-infra/issues/3692) / Workflow/Observability | priority:P1, agent:codex | 同一 ACK 发布/性能 owner 持有 | 继续同来源、同负载的阶段时延与资源基线；依赖发布产物与最终部署组合，不以本地主干或 Pod Ready 签性能验收。 |
| [#3747](https://github.com/AgoraIO-Extensions/agent-infra/issues/3747) / Runtime/Worker/Core | priority:P1, agent:codex, session-owned | Runtime owner 当前调查；子项 #3756 由同一 session 独占 | API projection 子项 #3756 已由 PR #3757 合入并关闭，父票不因 child 合入而关闭。#3750 已合入，但 custom child digest、同绑定 readiness/Store/API 投影及真实 ACP 结果仍缺。 |
| [#3295](https://github.com/AgoraIO-Extensions/agent-infra/issues/3295) / Deploy/E2E/Channels | agent:codex | 原网络 session 已确认接回只读方案筹备 | 普通节点需要支持 policy 的目标环境与具名实施 owner；ECI 可独立核 VirtualNode/Poseidon 前提。分开验证 allow/deny/recovery；迁移、费用和窗口未落实，现有 Flannel 不原地换 CNI。 |
| [#171](https://github.com/AgoraIO-Extensions/agent-infra/issues/171) / Deploy/E2E/Channels | wayfinder:task, wayfinder, priority:P0, agent:kiro | 网络筹备 owner 协调依赖；实施 owner 未落实 | 原生 blocked_by #3295。网络能力后仍需存储、Registry、RBAC、DNS/TLS 和访问入口证据；筹备接收不等于环境资源已交付。 |
| [#144](https://github.com/AgoraIO-Extensions/agent-infra/issues/144) / Workflow/Observability | wayfinder:map, wayfinder, priority:P0, agent:codex | 协调者与网络筹备 owner 复核父子范围 | 本次原生子项回读仅 #171 OPEN；该子项和父票自身 P0/P1、环境及跨系统交接范围未完成，不能关父票。 |
| [#1548](https://github.com/AgoraIO-Extensions/agent-infra/issues/1548) / Platform/Web/Skill | ready-for-human, priority:P0, agent:kiro | 原 Skill Hub session 已确认接回并实际推进 | 当前源码 Harness cache 修复已由 PR #3754 合入并关闭 #3752；仍需补四模板、恢复/撤销/隔离/UI。外部固定包、发布者签名、获准 approval 和部署 adapter 仍缺，内部正向链不代签外部来源或人工验收。 |
| [#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851) / Runtime/Worker/Core | priority:P0, agent:codex | 协调者子代理已实际接收 Platform 消费侧调查 | 当前 Connection main 仍缺机器注册、幂等/unknown 恢复和受保护秘密供应合同，服务端交付 owner/排期另确认；已批准的两 Agent 安装路径可独立推进，正在向部署 owner 核对非秘密映射。 |
| [#2857](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857) / Runtime/Worker/Core | agent:codex | 原验收 session 已确认接回筹备 | 已回读环境和 Harness，等待与 Skill Hub owner 交接同来源验证窗口；完成双主体/双 Agent/三入口/多 Runtime 隔离、并发、重启、撤权和恢复矩阵。历史端口或健康快照不证明环境可接管。 |
| [#2998](https://github.com/AgoraIO-Extensions/agent-infra/issues/2998) / Deploy/E2E/Channels | agent:codex | 同一验收 session 已确认接回输入核查 | 明确真实企业主体、官方扫码和机器人计数权限，再做绑定/重试/撤销矩阵；现有只读筹备不等于真实客户端验收已排期。 |
| [#2858](https://github.com/AgoraIO-Extensions/agent-infra/issues/2858) / Platform/Web/Skill | agent:codex | 协调者当前执行独立管理流程验收 | 两主体已重新正式登录并授权回读200；四标准模板目前 stale/revision=null，不能提交缺 revision 的申请。等待正式验证刷新后跑申请、修改、驳回、原申请重提、撤回与幂等/跨主体/Web刷新。 |
| [#3108](https://github.com/AgoraIO-Extensions/agent-infra/issues/3108) / Deploy/E2E/Channels | priority:P1, agent:codex | 协调者持有恢复验收；开发审计已回写 | #3734 已交付 Pi/OpenCode 诊断；当前 main 未发现可重复补写的代码差额。既定部署 owner 提供组合后，验证原保留会话/PVC 恢复、阶段/HTTP/stream 诊断与时延，不补造旧 sealed 历史。 |
| [#2983](https://github.com/AgoraIO-Extensions/agent-infra/issues/2983) / Deploy/E2E/Channels | ready-for-human, priority:P1, agent:kiro | 协调者持有筹备；共享目录策略待决定 | 正式 Responses/high 能力已测，部署 allowedModels 扩展仍未批准；保留候选。批准并验证 Codex/DeepSeek 组合后补 low/high/max、多轮 reasoning、刷新/隔离与企微；Claude 成功不代签 Codex 思考展示。 |
| [#3230](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230) / Deploy/E2E/Channels | ready-for-human, priority:P1, agent:kiro | 协调者持有文件验收筹备；声明输入待落实 | 三个已授权管理 GET 的404已定位为精确范围声明缺失。先落实类型、字节上限、有效期与当前 revision，经正式API写入再验 Web/企微文件矩阵；不自行选择限额绕过声明。 |

源码写入边界：已合入的 #3754 仅修复 `deploy/local/e2e-harness.mjs` 与 `tests/local-e2e-harness.test.mjs`；已合入的 #3757 仅修复 `apps/platform-api/src/deployment.ts` 与对应 production regression；
发布票 #3741 的发布 workflow 与相应 smoke 由发布 owner 管理；本次 #3762 仅两份 Issue 指导/状态文档。
其他验收发现实现缺口时先冻结具体文件，再按 primary Issue 开发；不因筹备交接取得重叠写权。
每个新 PR 委派后台 watcher，确认合入后委派单 PR 清理，协调者继续其他可执行项。

## 当前证据与输入

- [#3741 的 package 访问复核](https://github.com/AgoraIO-Extensions/agent-infra/issues/3741#issuecomment-6515821908)：用户已授权写权限，但 package 仍未完成 Manage Actions access；`repository=null` 只说明未关联，权限根因以隔离 smoke 的 authorization 失败为准。当前没有可用已登录 GitHub UI，未改可见性、仓库默认权限或 ACK。
- [#3751 当前 Hosted run](https://github.com/AgoraIO-Extensions/agent-infra/actions/runs/41006192728)：Backend 唯一失败为 codex-runtime-driver.test.ts 的 completed/operation 断言（2509 passed/1 failed/34 skipped），main focused 600/600 通过；Heavy 唯一失败为 task-feedback.spec.ts reload 后缺任务反馈按钮（1524 passed/1 failed/120 skipped）。失败保留并由各 owner 分类，不能宣称全绿。
- [#3295 的新筹备回执](https://github.com/AgoraIO-Extensions/agent-infra/issues/3295#issuecomment-6514019169)、[#2857 的接收范围](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857#issuecomment-6514023205) 和 [#2998 的输入核查](https://github.com/AgoraIO-Extensions/agent-infra/issues/2998#issuecomment-6514023230) 已公开回读；均明确实际筹备范围和下一交付，未签真实 AC。
- [#851 的新合同交接](https://github.com/AgoraIO-Extensions/agent-infra/issues/851#issuecomment-6513921407)：公开合同仍只有浏览器管理员注册和固定 Consumer 的 DCR；业务 Agent ID 与内部注册身份不能混为一谈。先确定机器身份、准确语义、幂等/unknown 恢复和受保护交付合同；已有批准安装配置独立核对，不用管理员 Cookie、共享 Consumer 或旧测试输入替代。
- [#2858 的当前管理前置](https://github.com/AgoraIO-Extensions/agent-infra/issues/2858#issuecomment-6513990960)：正式登录与已有 Agent 候选读取通过，四模板申请 readiness 已过期。本地主干 d970fd06 不等于当前全部部署组件来源；未执行新的申请/Workload 或共享配置更新。
- [#3108 的当前 main 审计](https://github.com/AgoraIO-Extensions/agent-infra/issues/3108#issuecomment-6513762537)：诊断开发已交付，剩余原会话/PVC 恢复与完整时延需要当前部署事实。只完成新会话或历史模型时延不能代签。
- [#3747 的能力路径核查](https://github.com/AgoraIO-Extensions/agent-infra/issues/3747#issuecomment-6513894681)：可选能力投影、模型目录装配和真实 ACP 结果分别取证；超时修复合入没有证明新镜像或真实任务已通过。其 API projection 子项 [#3756](https://github.com/AgoraIO-Extensions/agent-infra/issues/3756) / [#3757](https://github.com/AgoraIO-Extensions/agent-infra/pull/3757) 独立推进，父票仍保留运行时验收。
- [#3754](https://github.com/AgoraIO-Extensions/agent-infra/pull/3754) 已合入 `ce2a4f59` 并关闭 #3752；[#3757](https://github.com/AgoraIO-Extensions/agent-infra/pull/3757) 已合入 `cd16f38f` 并关闭 #3756。Draft [#3751](https://github.com/AgoraIO-Extensions/agent-infra/pull/3751) 当前 Hosted Backend/Heavy 已失败，不能以 main focused 通过或旧 receipt 关闭 #3741。
- #2983 按 [ADR-0026](../adr/0026-show-model-reasoning-as-conversation-content.md) 的 Codex 范围和 [ADR-0030](../adr/0030-source-standard-template-models-from-relay.md) 的默认 Key `/models`、保存时协议验证执行。[候选与待决策略](https://github.com/AgoraIO-Extensions/agent-infra/issues/2983#issuecomment-6503038688) 尚未 apply，旧烘焙目录不是当前前置。
- [#3230 的管理路由复核](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230#issuecomment-6502573560) 已区分精确声明缺失404与权限拒绝403，不外推整张表为空或数据面关闭；三方限制仍需有效输入。
- #1548、#2857、#2998 的四模板、外部签名/Provider、隔离、官方扫码和机器人计数各自取真实证据；历史正向链、健康状态、输入筹备和代码合入均不签未运行矩阵。

## 开发 PR 回读

下列 PR 在本次窗口均回读为 MERGED，关联开发 Issue 为 CLOSED。head 与 merge 分列；
开发交付不是部署或真实 AC 通过。#3740 与 #3742 共同关联 #3739，不重复计为两个开发 Issue。

| PR / 关联开发 Issue | 最终 head | merge SHA | 交付与剩余边界 |
| --- | --- | --- | --- |
| [#3726](https://github.com/AgoraIO-Extensions/agent-infra/pull/3726) / [#3725](https://github.com/AgoraIO-Extensions/agent-infra/issues/3725) | `332654cd51d804e234a7cacc6b11c24fe8bf8a36` | `d6bd08c781dcb439556bac41cd14d7cf90a01cfd` | 此前归属/筹备快照；本次更新当前执行状态。 |
| [#3730](https://github.com/AgoraIO-Extensions/agent-infra/pull/3730) / [#3729](https://github.com/AgoraIO-Extensions/agent-infra/issues/3729) | `547e6b70abd48faa942548d79c73536cbe0ce8b4` | `8a3ffe1013592f30bdd46260823332aa9ae36260` | Worker 内部 Service/ingress 声明；模型候选读取已复验，真实 NetworkPolicy deny 仍由 #3295 承接。 |
| [#3734](https://github.com/AgoraIO-Extensions/agent-infra/pull/3734) / [#3731](https://github.com/AgoraIO-Extensions/agent-infra/issues/3731) | `29122630bf177338efe4851b212259fa56b6d75f` | `4a4af9a14942facde4225c774a70be361860b03a` | Pi/OpenCode Messages 诊断与关闭时序；#3108 继续真实恢复验收。 |
| [#3740](https://github.com/AgoraIO-Extensions/agent-infra/pull/3740) / [#3739](https://github.com/AgoraIO-Extensions/agent-infra/issues/3739) | `eef23608fc8f656f815e1444e105c633ebab77fd` | `eee15f58026241c387af19ea9cfbc7f9a6dc6fdf` | 可携带 ACK capsule 文档；不证明当前产物、部署或性能完成。 |
| [#3742](https://github.com/AgoraIO-Extensions/agent-infra/pull/3742) / [#3739](https://github.com/AgoraIO-Extensions/agent-infra/issues/3739) | `c0986f658fa69864102da2fff423d0344ddb53f4` | `b113e689f762c11667eb89bdcd50eb6101855355` | 正常 Sandbox prepare 观察窗口；#3692 继续当前来源性能验收。 |
| [#3746](https://github.com/AgoraIO-Extensions/agent-infra/pull/3746) / [#3745](https://github.com/AgoraIO-Extensions/agent-infra/issues/3745) | `1de89cf36e5d0ea3aeee642c2dd4a83aa56e7511` | `505c6cfd35611f8d0843239de4163655b2686640` | 正常 ContainerCreating/PodInitializing 不记为 startup failure；真实部署另验。 |
| [#3744](https://github.com/AgoraIO-Extensions/agent-infra/pull/3744) / [#3743](https://github.com/AgoraIO-Extensions/agent-infra/issues/3743) | `4faa006ed61260c6c70d453bc563ee910684bb65` | `0a02c0f6dab7b477f2bc659fb29227b9664909c3` | RuntimeHost manifest 发布入口；实际发布 receipts 与失败仍由 #3741 跟进。 |
| [#3750](https://github.com/AgoraIO-Extensions/agent-infra/pull/3750) / [#3749](https://github.com/AgoraIO-Extensions/agent-infra/issues/3749) | `cca2e7b1662939085a9db4b1cf652b7847268928` | `d970fd06bf63fc3962b68b1f8a626db5b63e836e` | ACP prompt 挂起有界化；#3747 继续 custom Agent 能力路径验收。 |

| [#3754](https://github.com/AgoraIO-Extensions/agent-infra/pull/3754) / [#3752](https://github.com/AgoraIO-Extensions/agent-infra/issues/3752) | `b251546631060cc5f1838a9f1171187300fce5b7` | `ce2a4f59c928473ff02e15c82d426b28727a774a` | Harness cache rebinding修复；真实 Docker 补验曾受依赖下载超时影响，开发票已关闭，部署/验收不代签。 |
| [#3757](https://github.com/AgoraIO-Extensions/agent-infra/pull/3757) / [#3756](https://github.com/AgoraIO-Extensions/agent-infra/issues/3756) | `d1e472562ae40bd07ab9920c3efc05c15919b5e2` | `cd16f38f1698c307dd3d2779cfbb8dfa97e49d43` | modelDirectory capability projection修复；父 #3747 的 Runtime execution acceptance 继续 OPEN。 |

## 父子收口与真实验收

- #144 的原生子项本次回读仅 #171 OPEN；#171 的原生 `blocked_by` 仍为 #3295。父票自己的路线、环境和跨系统交接也未全部签收，继续 OPEN。
- #851 的 AC-5–7 开发已由 #3427 交付，但自动注册开发、生产安装供应与真实联合验收仍在原票；不能因一个切片合入而删除其余范围。
- #3752 与 #3756 的开发 child 已分别由 #3754/#3757 合入并关闭；#1548、#3747 等验收父票继续保留真实 AC。
- #3553 由其他 session 跟进，继续排除；本次无文件、环境或 Issue 接管。
- 当前 `ready-for-human` 只作人工处理/验证标记，不新增 required merge gate。来源标签保持原 `agent:*`，新 Issue/PR 按当前规则保留 Agent provenance。

历史 ACK v8 来源及限定验收见 [部署总结](../../deploy/ack/ACK-REDEPLOY-LESSONS.md#本轮完整清空重建)；
不得将历史 source192、后续 Worker/配置更新和当前 main 互换。已关闭开发票与待验收票分别回读，
新缺陷按完整 primary Issue 推进，不用本快照改写未通过 AC。
