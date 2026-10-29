# 开放 Issue 状态跟进

> 采集回读窗口（as-of）：2026-10-29T14:11:38.615913+00:00 至 2026-10-29T14:11:39.474674+00:00。
> 来源基线：新 worktree 创建前 fetch 回读的 `origin/main` exact SHA `911b67db5f02480268dd2e3b4519940dba9ce800`。
> 本文是带时间的快照；动态状态以 GitHub 回读为准，旧 head 或其他环境的结果不代签当前验收。

采集时开放 Issue **19**：业务与验收 **18**，本次阶段治理 [#3712](https://github.com/AgoraIO-Extensions/agent-infra/issues/3712) **1**；
开放 PR **4**。本快照 PR 尚未创建，不计入该数。本次记录 ACK v8 功能验收与实际 session 归属，
不因每次合入自动创建刷新票。操作顺序见 [Issue 工作指导](issue-work-guidance.md)。

## 当前归属复核与纠正（2026-10-29）

上方及后续列表保留原采集窗口，不表示所有待办都已有当前执行者。此前把历史负责人、待验收和
外部依赖推断成“仍由原 session 处理”不准确；现以直接回复与当前 PR/工作树交叉回读纠正：

| 范围 | 当前确认 | 下一步 |
| --- | --- | --- |
| #3707/#3715 | 原迁移 session 明确持有并正在执行，关联 #3711 | 继续由原 owner 完成；本协调 session 不认领 |
| #3692 | 原 ACK 性能 session 明确持有并已安排发布后对比 | 保留其共享环境静默窗口，不混入新验收负载 |
| #3708/#3709 | 原架构 session 明确持有时计入五个已确认项；现已随 #3710 合入并由原 owner 关闭 | 原 owner 负责该 PR 清理，不再计入未完成开发 |
| #851 | 历史 owner 明确当前无活动 writer，已交接仅 Platform 消费侧调查及状态收口 | 核对完整注册/供应范围与现有规范；不接管 Connection 服务、凭据、Grant 或部署 |
| #1548 | 历史 owner 明确未继续且未排期剩余矩阵，释放其 writer 与旧本地环境预留 | Coordinator 接收调查/验收筹备；旧证据只作历史，实际运行前核对其他环境 owner；#3553 继续排除 |
| #2857/#2858/#2983/#2998/#3108/#3230 | 活动迁移及 ACK owner 明确均未认领、未排期；当前没有已确认执行者 | 核对既有验收入口与输入，按可执行步骤安排责任；不能因“待验收”就自动跳过 |
| #3295/#171/#144 | 依赖或父子关系不证明有执行 owner；ACK 性能 owner 明确未认领 | 分别确定网络环境方案/真实资源核验/父票收口责任，保持未完成项 |

因此，第一次二次确认覆盖的是五项，**不是全部十六项**。另外十一项当时没有当前 owner 或
未来执行计划的充分证明；随后 #851/#1548 才取得上述有限交接。Coordinator 的整体目标仍未完成。

可执行工作先从 #2858 的真实管理 UI 角色、导航、深链与目录请求回读，以及 #2983 的既有
`requireThinking` 浏览器入口准备开始；ACK 当前由性能 owner 使用，新的登录、创建、模型和
生命周期验收须等待其明确释放共享窗口。外部账号/扫码、旧失败会话恢复及未发布合同分别记录
真实缺口，不据此笼统宣布所有验收不可执行。参考 [Issue 工作指导](issue-work-guidance.md#并行分派入口)。

后续窄范围只读复核发现：v8 汇总中的模型耗时 `null` 不能证明原始事实不存在。18 个既有
执行详情请求均为 200，其中 Codex 三轮返回同 operation/attempt 的 completed 起止时间与
6970/6287/7082ms 耗时；另外 15 个执行未返回同形 V2 model 事件，仍须核对历史事件版本或
投影。未新增登录、Task 或模型请求，原 v8 索引未修改；此部分证据不足以签收 #3108 完整时延。
#851 的 AC-5–7 已按合入和当前 assembly/PG 证据更新开发完成，整票仍保留自动注册、生产安装
供应及真实联合验收三条工作线；不能把整票都当作等待机器注册而停止已有绑定的接入调查。

## 分类计数

| 类别 | 业务与验收数量 |
| --- | ---: |
| Runtime/Worker/Core | 3 |
| Deploy/E2E/Channels | 8 |
| Platform/Web/Skill | 3 |
| Workflow/Observability | 4 |

## 明细

| 类别 | Issue | 标题 | 采集时标签 | 下一步与边界 |
| --- | --- | --- | --- | --- |
| Platform/Web/Skill | [#3713](https://github.com/AgoraIO-Extensions/agent-infra/issues/3713) | fix(api): accept contract-defined Eval queries with Bearer credentials | priority:P1, agent:codex | Coordinator 已经实际路由复现 Bearer 合法 query 被管理 helper 拒绝；原架构 owner 现场确认不持有该候选，独立 HTTP helper/Eval 测试范围正在开发，不触及 metadata/ACK binding |
| Deploy/E2E/Channels | [#3709](https://github.com/AgoraIO-Extensions/agent-infra/issues/3709) | [session-owned] refactor(ack): 集中 Agent binding 来源与请求一致性校验 | ready-for-agent, priority:P2, agent:codex, session-owned | session-owned；原架构 session 独占 ACK binding 及两个消费者/对应测试，PR #3710；本协调 session 跳过，不操作其文件或 ACK |
| Runtime/Worker/Core | [#3708](https://github.com/AgoraIO-Extensions/agent-infra/issues/3708) | [session-owned] refactor(runtime): 收拢 native metadata 固定 JSON transport | ready-for-agent, priority:P2, agent:codex, session-owned | session-owned；原架构 session 独占四个 metadata client、专用 transport 包及依赖接线，PR #3710；本协调 session 跳过 |
| Deploy/E2E/Channels | [#3707](https://github.com/AgoraIO-Extensions/agent-infra/issues/3707) | [session-owned] test: 验证本地自建 Agent 的 API 迁入与持续更新闭环 | ready-for-agent, priority:P1, agent:codex, session-owned | session-owned；原迁移 session 独占本地自建 Agent 迁入/持续更新验收及 PR #3711；本协调 session 不领取、实施、测试或关闭 |
| Workflow/Observability | [#3705](https://github.com/AgoraIO-Extensions/agent-infra/issues/3705) | test(eval): isolate final-expiry assertions from transfer timeout | priority:P1, agent:codex | Coordinator 持有 Eval 到期测试修复；PR #3706 全部适用 CI 通过但 GitHub 仍报 required CI expected；已普通合入 #3704 验证组合提交，不绕过保护 |
| Workflow/Observability | [#3703](https://github.com/AgoraIO-Extensions/agent-infra/issues/3703) | test(harness): isolate CLI state and locks from developer sessions | priority:P1, agent:codex | Coordinator 持有四个 Harness CLI 测试状态/锁隔离；PR #3704 原后端 Eval 失败保留，组合 head 已含 #3705 修复，等待新 CI |
| Workflow/Observability | [#3692](https://github.com/AgoraIO-Extensions/agent-infra/issues/3692) | perf(ack): establish per-stage latency and resource baselines for fresh deployment | priority:P1, agent:codex | 原 ACK owner 持有性能调查；v8 有限样本已采集，内部模型/队列/Session 准备时延仍未知，负载与 SLO 待定，不代签性能达标 |
| Deploy/E2E/Channels | [#3295](https://github.com/AgoraIO-Extensions/agent-infra/issues/3295) | blocker(ack): Flannel 环境未通过 Worker NetworkPolicy 负向验证 | agent:codex | 真实普通节点与 ECI NetworkPolicy 负向验收仍未完成；v8 的业务 Session ECI 归属不证明网络 deny，保持环境 owner 边界 |
| Deploy/E2E/Channels | [#3230](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230) | test(e2e): 固定环境 Web 与企微双向文件和图片验收（#3221） | needs-triage, priority:P1, agent:kiro | Web/企微双向文件图片矩阵待验；v8 无文件事件，不能代签哈希、撤权和跨主体负例 |
| Deploy/E2E/Channels | [#3108](https://github.com/AgoraIO-Extensions/agent-infra/issues/3108) | acceptance: ACK resumed conversations receive Messages gateway errors | priority:P1, agent:codex | 原失败会话/同 PVC 恢复与完整时延仍待验；v8 为新会话且模型分段时延为 null，AC-3 也保持未签收 |
| Deploy/E2E/Channels | [#2998](https://github.com/AgoraIO-Extensions/agent-infra/issues/2998) | test(e2e): real WeCom credential and official QR binding acceptance | agent:codex | 真实企微凭证、官方扫码及绑定回读待验；平台双账号登录和 Relay Key 安装不能替代 |
| Deploy/E2E/Channels | [#2983](https://github.com/AgoraIO-Extensions/agent-infra/issues/2983) | test(e2e): 固定环境验收 DeepSeek 与思考过程（Web 与企微） | ready-for-agent, priority:P1, agent:kiro | DeepSeek/思考过程的 Web 与企微矩阵待验；v8 reasoning 计数为零，不代签 low/high/max、单/群聊和回归 |
| Platform/Web/Skill | [#2858](https://github.com/AgoraIO-Extensions/agent-infra/issues/2858) | test: accept Platform management Web flow from #535 | agent:codex | 管理 Web/API/PG 完整旅程待验；v8 API 创建/就绪与对话不代替申请审批、Owner 配置及完整页面矩阵 |
| Runtime/Worker/Core | [#2857](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857) | test: accept Session Sandbox multi-entry isolation from #1253 | agent:codex | 多入口、多 Runtime、重启撤权与隔离矩阵待验；v8 六个 ECI Session 与入口拒绝仅覆盖本轮具体路径 |
| Platform/Web/Skill | [#1548](https://github.com/AgoraIO-Extensions/agent-infra/issues/1548) | test(skill-hub): accept the deployed lifecycle and Web conversation chain | ready-for-human, priority:P0, agent:kiro | 历史 Skill 正向验证已结束；当前有限交接见归属复核，#3553 继续排除，完整矩阵与人工签收仍待 |
| Runtime/Worker/Core | [#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851) | feat(runtime): deliver standard MCP Agent token client | priority:P0, agent:codex | 平台逐 Agent 安装绑定消费已交付；自动独立 Consumer 注册仍缺 Connection 机器认证合同，个人 Token/管理员 Cookie/DCR ID 不替代 |
| Deploy/E2E/Channels | [#171](https://github.com/AgoraIO-Extensions/agent-infra/issues/171) | 准备 P0 首发真实环境 ACK tenancy 与访问入口资源 | wayfinder:task, wayfinder, priority:P0, agent:kiro | 原生 blocked_by #3295；网络、存储、Registry、RBAC、DNS/TLS 等原范围仍须当前证据，v8 功能矩阵不能整票关闭 |
| Workflow/Observability | [#144](https://github.com/AgoraIO-Extensions/agent-infra/issues/144) | wayfinder: 形成 Agent 平台 M1 启动与落地路线 | wayfinder:map, wayfinder, priority:P0, agent:codex | 75 个原生子项已分页回读，仅 #171 OPEN；父地图仍等待环境前置及自身范围闭环 |

## 当前分派与文件所有权

本轮在 GitHub Issue/PR/head/文件范围之外，已向活动负责人再次确认实际持有项，并交叉核对工作树。
Session ID、标签或 idle 状态只提供线索；认领规则见 [工作指导](issue-work-guidance.md#并行分派入口)。

| Lane | Primary / PR | 已确认写入范围与下一交付点 |
| --- | --- | --- |
| Eval Bearer 查询 | #3713 | Coordinator 仅管理 HTTP helper 与 Eval 路由回归；已通过实际 PR/文件范围与原架构 owner 现场回复二次确认无重叠 |
| Harness / Eval 测试 | #3703/#3705；#3704/#3706 | Coordinator 持有 Harness CLI 状态隔离与 Eval 到期 fixture；组合 CI 仍在运行。两个修复均不改生产超时或授权规则 |
| 本地 Agent 迁入 | #3707 / #3711 | 原迁移 session 持有迁入验收、custom-agent-migration 与 personal-api-read 文档；已现场确认不写本表两份全局文档，本协调 session 跳过 |
| 架构收拢 | #3708/#3709 / #3710 | 原架构 session 持有 metadata transport、client 接线及 ACK binding/消费者；已现场确认不写本表两份全局文档，不操作 ACK 环境，本协调 session 跳过 |
| ACK 交付与性能 | #3685 已关闭 / #3700 已合入；#3692 OPEN | 原 ACK session 完成 v8 与两份部署文档，保留性能后续及私有包；已确认不写两份全局文档，无未释放资源等待。只读复核和已明确交接的五项 AC-4 更新不扩大后续写权 |
| Skill 真实验收 | #1548 | 历史 owner 已明确释放剩余验收筹备，Coordinator 已接收；旧环境须另核资源占用，#3553 仍排除 |
| Connection 使用方合同 | #851 | 平台等待已发布的机器注册合同；Connection 服务端、Provider、Grant、凭据与部署仍归原 owner |
| 状态与交接 | #3712 | Coordinator 仅这两份全局文档；已交叉确认上述活动 owner 无重叠写入。每个 PR 由专属后台 watcher 跟进，合并后单 PR 清理 |

## 开发 PR 回读

| PR | 采集时 head | 当前证据与下一步 |
| --- | --- | --- |
| [#3711](https://github.com/AgoraIO-Extensions/agent-infra/pull/3711) | `29d3d0a2ca3dc40f3b99d7b8902dc117e56d3094` | DRAFT；原迁移 session 持有 #3707；文档与真实迁入验收由原 owner 收口，本协调 session 跳过 |
| [#3710](https://github.com/AgoraIO-Extensions/agent-infra/pull/3710) | `8c589b81b0dcd8c7afd4fc26a4d835f3cb91b86c` | DRAFT；原架构 session 持有 #3708/#3709；本协调 session 仅记录状态，不评估其实现完成或接管检查 |
| [#3706](https://github.com/AgoraIO-Extensions/agent-infra/pull/3706) | `8d3517133d04382fb945062b5d917c8feac9a348` | OPEN；Eval 原期限/两种 lifetime/404 断言保持；完整 31/31、独立复验及全部适用 Hosted CI 通过，GitHub 仍报告 required CI expected。仅汇总任务重验与自动合并登记刷新未解除，未绕过保护 |
| [#3704](https://github.com/AgoraIO-Extensions/agent-infra/pull/3704) | `d6f6e6e6bcab00f7b61899e8ac30a3cec67e381f` | OPEN；Harness 状态隔离与 Eval fixture 普通合并组合；原失败轮次保留。组合 focused Harness 11/11、Eval 原用例通过，当前正式评审无主要问题，Hosted Backend/Heavy/Workload 尚在运行 |

## 已关闭开发与待验收

开发关闭与真实 AC 签收分别回读。ACK v8 的限定范围与证据详见
[本轮完整清空重建](../../deploy/ack/ACK-REDEPLOY-LESSONS.md#本轮完整清空重建)，
不在本表复述性能数值。实际运行 source 为 `192bb8c87ad4cfe5eb28e6b1e3617d8bd5dc2705`，
部署文档 PR #3700 的 merge 为 `911b67db5f02480268dd2e3b4519940dba9ce800`；两者不能互换。

| 已关闭 Issue | 合入 PR | 收口与仍待事项 |
| --- | --- | --- |
| #3685 | #3700 | v8 限定功能矩阵与可移植部署文档完成，AC-1–4 已签；后续性能 #3692 和独立验收票保持开放 |
| #3696 | #3698 / #3700 | 首轮 ECI 观察窗口修复及最终文档完成；原 v7 失败与诊断保留，不回填为成功 |
| #3694 | #3695 | deploy Markdown 验证计划分类已合入；原 Issue checkbox 状态保留，不把开发关闭改写为额外验收 |
| #3701 | #3702 | CI 路径分类改为 PR merge-base，实际 Git 分叉回归与全部适用 Hosted 检查通过 |
| #3640、父 #485 | #3684 | 四个原生开发子票全关闭，父自身实现已核对；真实四模板回答/工具固定集两组 Eval 与原未签收 AC 仍待 |
| #3693 | #3684 | 对话框焦点测试双端 Hosted 通过；原 CI 瞬间焦点来源未完全复现，历史失败保留 |
| #3681 | #3682 / #3689 | AC-4 已由 v8 fresh 18 轮及双自有入口证据签收 |
| #3686 | #3687 | AC-4 已由 v8 签收；AC-2 仍未勾选，未由八次首次创建成功外推重试路径 |
| #3688 | #3687 | 浏览器脚本网络失败与 Docker 生命周期重叠的诊断、调度隔离及 Hosted 交付完成 |
| #3653 | #3656 | 原 AC-5 状态未在本轮改动，按原范围继续回读 |
| #3665 | #3666 | AC-4 四标准与两 ACP 的新三轮浏览器/模型矩阵已签收 |
| #3667 | #3668 | AC-4 fresh 八 Agent 与双自有入口已签收；其余原 AC 状态保留 |
| #3670 | #3671 | 原 AC 状态保留；同 Digest 批准 mirror 仍由 Worker 独立准入 |
| #3673 | #3674 | 原 AC 状态保留；个人/默认 Key 各自用途不能由单一路径外推 |
| #3676 | #3678 | AC-4 原目标八 Agent 矩阵已签收；本轮无工具事件，不外推原生工具业务验收 |

上述五项 AC-4 由原 ACK owner 明确交接后更新并回读，其他 AC 未改。独立核验包括 23 份回执
哈希、18 个唯一 Execution 的 browser/model 关联、六个 ECI Session、双自有入口，以及当前
双账号严格 TLS 登录和授权 Agent 状态、平台/迁移/Session Pod UID 与镜像绑定。证据索引
SHA-256 为 `091cf0e352b38b0f4bf5f1ff0a3c249bd15e6c7aa843d4ba7eb6194122c0471f`。

本轮工具与 reasoning 事件计数为零，10 轮回复为 coalesced；不证明全部逐帧增量渲染。
NetworkPolicy 隔离、长期 idle/旧失败会话恢复及内部模型/队列/Session 准备时延仍未证明，
不能由 v8 直接关闭 #2858/#2857/#3108/#2983/#3230/#2998。

## 本批已合入开发交付

| PR | 交付 | merge SHA |
| --- | --- | --- |
| [#3700](https://github.com/AgoraIO-Extensions/agent-infra/pull/3700) | docs(ack): finalize portable redeploy workflow and acceptance evidence | `911b67db5f02480268dd2e3b4519940dba9ce800` |
| [#3702](https://github.com/AgoraIO-Extensions/agent-infra/pull/3702) | fix(ci): classify PR changes from their merge base | `9813063bf4b37208dcdd36cc30c552895c9d8bbd` |
| [#3698](https://github.com/AgoraIO-Extensions/agent-infra/pull/3698) | test(ack): wait for cold Session before first browser message | `192bb8c87ad4cfe5eb28e6b1e3617d8bd5dc2705` |
| [#3695](https://github.com/AgoraIO-Extensions/agent-infra/pull/3695) | fix(harness): classify deployment Markdown as documentation | `63c9ae83c967920d7b8d80bbf3532f6b89ac3bb3` |
| [#3699](https://github.com/AgoraIO-Extensions/agent-infra/pull/3699) | docs: record Eval delivery and remaining acceptance | `763d8ca8bc72b8d8d161d2cfebb609f8da1d877b` |
| [#3684](https://github.com/AgoraIO-Extensions/agent-infra/pull/3684) | feat(eval): complete comparative analysis feedback and Web workflow | `f1b3934ab1550496759f644baf167117967d1ebf` |
| [#3689](https://github.com/AgoraIO-Extensions/agent-infra/pull/3689) | test(ack): verify retry boundaries and isolate browser fixtures | `d5a9080d7deda41b1349081ad888272a44ac82ad` |
| [#3687](https://github.com/AgoraIO-Extensions/agent-infra/pull/3687) | fix(ack): recover creation and isolate browser validation | `2848503fb001c03756bbd4a574147930a35870ea` |
| [#3691](https://github.com/AgoraIO-Extensions/agent-infra/pull/3691) | docs: refresh development closures and acceptance ownership | `a359b17f8d711d79097d3adca4f44c54a0c4dc32` |
| [#3682](https://github.com/AgoraIO-Extensions/agent-infra/pull/3682) | fix(ack): retain entry failures and bound connection retries | `fe30f2f72b74c7cd99450d4fefd2b1e35a79fca2` |
| [#3680](https://github.com/AgoraIO-Extensions/agent-infra/pull/3680) | docs: refresh Eval delivery and ownership status | `e65c90c8b12c0f0ee518d50b71ca5773fd2a76e4` |
| [#3678](https://github.com/AgoraIO-Extensions/agent-infra/pull/3678) | fix(runtime): authorize complete ACP tool arguments | `cd30cb7ccdc64a7b7d50bad2b21cd39971f5f4de` |
| [#3674](https://github.com/AgoraIO-Extensions/agent-infra/pull/3674) | fix(ack): bootstrap the authenticated user Relay Key | `da87c6c29320e332ca37e99534156aabc41dd5bd` |
| [#3672](https://github.com/AgoraIO-Extensions/agent-infra/pull/3672) | feat(eval): run purpose-authorized experiments with scoring and review | `b1049e631f9e8b6e69c8dc791867894aac779531` |
| [#3671](https://github.com/AgoraIO-Extensions/agent-infra/pull/3671) | fix(api): honor explicit template image repositories | `b1785dc2525966c2f1841619b102ecd15a8ae7e1` |
| [#3669](https://github.com/AgoraIO-Extensions/agent-infra/pull/3669) | feat(runtime): complete native network tools and per-request model facts | `35f42a8ae52c368e49cc2f4e0b3f0a640f88730e` |
| [#3668](https://github.com/AgoraIO-Extensions/agent-infra/pull/3668) | feat(ack): verify fresh self-managed Agent entrypoints | `9015dd8cbab7378ab693d1c65bc5eb8164057ab7` |
| [#3666](https://github.com/AgoraIO-Extensions/agent-infra/pull/3666) | fix(ack): allow bounded cold Runtime image readiness waits | `d8884174e2404d3c126734727679cb29fc6f06f9` |
| [#3661](https://github.com/AgoraIO-Extensions/agent-infra/pull/3661) | docs: refresh delivery and ownership tracking | `8e7e83479b9256690750227a7176522d2ebe32da` |
| [#3659](https://github.com/AgoraIO-Extensions/agent-infra/pull/3659) | perf(store): narrow conversation authorization lookup | `5440c0d4f3ca2afc96d4302340c3581967968db4` |
| [#3657](https://github.com/AgoraIO-Extensions/agent-infra/pull/3657) | feat(eval): add purpose-bound datasets and content lifecycle | `60940568013729397ec04f1ac94a6e295e32d427` |
| [#3656](https://github.com/AgoraIO-Extensions/agent-infra/pull/3656) | feat(ack): relocate deployment capsules and verify cleanup ownership | `d6cd1d69b9a266bb3f2c2d33ce5016dcbfa6a95d` |
| [#3655](https://github.com/AgoraIO-Extensions/agent-infra/pull/3655) | fix(web): include native invocation request metadata | `e7aa1a76ae6edcabead893a0ee122e12cb104e98` |
| [#3652](https://github.com/AgoraIO-Extensions/agent-infra/pull/3652) | fix(skill-hub): retain bindings across runtime revisions | `e822650a82d0f21f8ae294fbb377bf93f26daf12` |
| [#3650](https://github.com/AgoraIO-Extensions/agent-infra/pull/3650) | fix(ack): recover interrupted login output promotion | `f7a2b63896c35f65edddb0a9dd18e5a23df27212` |
| [#3647](https://github.com/AgoraIO-Extensions/agent-infra/pull/3647) | fix(ack): validate custom Agents by interaction mode | `19fe1d5fe998cd7085a9bf05c6347eb905d963e8` |
| [#3645](https://github.com/AgoraIO-Extensions/agent-infra/pull/3645) | feat(skill): coordinate bounded development and explicit handoffs | `85c40eb1b43979aee38321b8a71d8a6d1dba8ce2` |
| [#3643](https://github.com/AgoraIO-Extensions/agent-infra/pull/3643) | fix(worker): mount verified skills in session sandboxes | `c8f916f2b57edbf79f61b0120b96d78e30c594f4` |
| [#3642](https://github.com/AgoraIO-Extensions/agent-infra/pull/3642) | test(wecom): make media decryption failure deterministic | `03aa36230834a3fecf8ce8c54d996f35144e4890` |
| [#3636](https://github.com/AgoraIO-Extensions/agent-infra/pull/3636) | docs(eval): clarify pending versions and feedback denominators | `39fb0ab8aac2ffebdbedc53cf17533fe3f01de1b` |
| [#3635](https://github.com/AgoraIO-Extensions/agent-infra/pull/3635) | feat(runtime): isolate native Bash for Claude Pi and OpenCode | `14afd6d08634861a341f40fa0b6844729f5fcc3b` |
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

## 父子收口与真实验收

- #485 原生子票 #3633/#3638/#3639/#3640 均 CLOSED；父开发已关闭，真实四模板 Eval AC 保留。
- #144 的 75 个原生子项已分页回读，仅 #171 OPEN；#171 原生 blocked_by #3295。v8 功能成功不解除网络隔离前置，父票保持 OPEN。
- #3198 → #3202/#3203、#3202 → #3218/#3664 均已关闭；原生工具开发交付与真实业务验收分别记录。
- #851 的[外部合同最新回读](https://github.com/AgoraIO-Extensions/agent-infra/issues/851#issuecomment-6491428253)固定 Connection main `15fa28bb954b16b4a1df506ebae9ea4605fcb141`：Provider v3 个人 scope 兼容不提供机器注册合同；不能以管理员 Cookie、DCR ID 或 Relay Key 补填接口替代。
- #3108 仍缺原失败会话/同 PVC 恢复及独立模型时延；#3692 仍缺内部阶段归因、代表性负载与合理 SLO。浏览器总时长不通过减差推算模型时间。
- session-owned 的 #3707/#3708/#3709 及其 PR 保持原负责人；相关文档引用或测试结果不构成接管授权。#3553 继续排除。
- 清理仅处理该 PR 的工作树和分支；保留私有证据、活动进程及无关未提交内容，不执行强制全局清理。
