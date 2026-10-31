# 开放 Issue 状态跟进

> 采集时间：2026-10-31T00:06:00Z。
> 源码基线：fresh-fetched `origin/main`，`ffb45a65d1633aeb301d05982985676373d50552`。
> 本文是有时间边界的快照；执行前重新读取 GitHub、工作树与负责人回复。通用分派规则见 [Issue 工作指导](issue-work-guidance.md)。

本次开放 Issue **16**，开放 PR **0**。#3553 明确排除。
开放 Issue 为 #3786、#3783、#3779、#3747、#3692、#3295、#3230、#3108、#2998、#2983、#2858、#2857、#1548、#851、#171、#144。

## 分类计数

| 类别 | 数量 | Issue |
| --- | ---: | --- |
| Runtime/Worker/Core | 5 | #3786、#3747、#3108、#851、#2857 |
| Deploy/E2E/Channels | 6 | #3783、#3779、#3295、#3230、#2998、#171 |
| Platform/Web/Skill | 3 | #1548、#2983、#2858 |
| Workflow/Observability | 2 | #3692、#144 |

类别按主要工作范围计数，父票和独立验收票分别保留。新增或重开的开发票必须对应具体未完成行为，不能仅凭旧 review 摘要或空 checkbox 推断代码缺失。

## 当前分派与文件所有权

| Issue | 当前负责人及交接事实 | 当前工作与下一步 |
| --- | --- | --- |
| [#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851) | Web slice 已合入；原 Worker owner `01a17acb-4309-7b62-b94e-d5056faa7778` 独占 deployment-entry 两文件 | AC-8～10 已凭 #3792 的两视口浏览器证据补签；AC-11/12 已由 PR #3795 merge `ddc1c6318484de0eb09aded999c63965ef8a687d` 交付。自动 Consumer 注册合同、已批准生产供应及真实 MCP/Provider 联合验收仍未完成。 |
| [#3783](https://github.com/AgoraIO-Extensions/agent-infra/issues/3783) | ACK owner 已将只读私有输入交给协调者做离线候选；上线权仍由 ACK owner 持有 | 22 项离线回归已独立通过，原输入与非认证声明保留。旧 adapter 将 Directory 状态冒充 LDAP 当前状态；可信 current-status authority 合同仍待确认，标记 needs-info。候选未准入 rollout。 |
| [#3786](https://github.com/AgoraIO-Extensions/agent-infra/issues/3786) | session-owned，原 owner `01a187db-3f47-72e1-8855-dd94cae95dc3` 实际继续处理 | PR #3800 已合入 `1b983100`；Issue 当前仍 OPEN/REOPENED，由原 owner 继续控制真实 API/SSE/DB 验证，其他 session 不接管或重放旧 execution。 |
| [#3747](https://github.com/AgoraIO-Extensions/agent-infra/issues/3747) | 同一 session-owned owner | 保留真实自定义 Runtime 验收及原失败证据；新修复的源码/镜像不混入旧冻结候选。 |
| [#3779](https://github.com/AgoraIO-Extensions/agent-infra/issues/3779) | 性能/ACK owner，独立验收票 | 在 #3777/#3778 完整开发收口后冻结 source/image/config、资源窗口和到达轨迹，验证 warm 延迟、耗尽、隔离与清理；不以单测或 Pod Ready 代签。 |
| [#3692](https://github.com/AgoraIO-Extensions/agent-infra/issues/3692) | 性能/ACK owner，assignee LichKing-2234 | 仍需 fresh deployment 的分阶段、资源和负载基线；有限样本及子开发合入不证明生产 p95/SLO。 |
| [#1548](https://github.com/AgoraIO-Extensions/agent-infra/issues/1548) | Skill owner 已被唤醒并实际复现 #3796，未进入其他 owner 的共享文件 | 先交付 #3796；四模板 Skill 业务调用、恢复/撤销/隔离、Provider/source 与人工验收分别保留。 |
| [#3295](https://github.com/AgoraIO-Extensions/agent-infra/issues/3295) | 原网络调查范围仅为只读筹备，未交接共享 CNI 写权 | 需要受支持网络策略执行环境及云侧 addon 证据，再运行 allow/deny/recovery；不原地切换共享 CNI。 |
| [#171](https://github.com/AgoraIO-Extensions/agent-infra/issues/171) | ACK 资源 owner，原生依赖 #3295 | 网络外的 StorageClass/PVC、Registry、RBAC、DNS/TLS 和入口也需当前回读；不以已存在集群代替资源验收。 |
| [#3230](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230) | ready-for-human；协调者持有文件验收筹备 | 上次 FileLimits 读取为 404，需重新确认批准声明及固定环境，再验证 Web/企微文件矩阵；不接管 Skill Harness。 |
| [#3108](https://github.com/AgoraIO-Extensions/agent-infra/issues/3108) | 原 owner 已释放执行范围，协调者持有恢复验收筹备 | #3734 诊断代码已合入；仍需原 retained Conversation/Session/PVC 与当前部署 tuple，不能用新会话代签旧恢复。 |
| [#2998](https://github.com/AgoraIO-Extensions/agent-infra/issues/2998) | 协调者持有输入核查，旧执行租约已释放 | 缺获准企微主体、官方扫码窗口和机器人计数/标识读取权限；不以 mock、旧 Cookie 或历史扫码签收。 |
| [#2983](https://github.com/AgoraIO-Extensions/agent-infra/issues/2983) | ready-for-human；协调者仅持有验收筹备 | 待正式 allowedModels/配置及真实 Web、企微 reasoning 矩阵；不改共享 catalog/Secret，不以其他 Runtime 的 thinking 替代。 |
| [#2858](https://github.com/AgoraIO-Extensions/agent-infra/issues/2858) | 协调者持有管理 Web 验收筹备 | 登录和授权读取的历史结果保留，模板 readiness/revision 需按当前部署重读，再验证申请、修改、驳回、重提、撤回及跨主体矩阵。 |
| [#2857](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857) | 协调者持有隔离验收筹备，环境需与 Skill owner 另行交接 | 两主体、两 Agent、三入口的隔离/并发/恢复/撤权矩阵仍未签收；不抢占共享 Harness 或 ACK。 |
| [#144](https://github.com/AgoraIO-Extensions/agent-infra/issues/144) | Wayfinder 父票，协调者复核自身范围与原生 children | #171 等开放子项及自身跨系统/环境交接仍未完成，不能按已合入 PR 数量关闭。 |

当前 reserve writer 范围为 Core/Store reserve 模块及测试、reserve schema、0074 additive migration 与必要迁移注册测试，以及 Worker reserve controller。#851 writer 只修改 deployment-entry，Skill writer 只修改其具名三份文件与 Dockerfile hunk。共享测试环境按实际进程退出、原资源清理和接收方回读后显式移交；clean worktree 不代表可提前删除。

## 开发 PR 回读

| PR / Issue | exact head 或 merge | 证据与剩余阶段 |
| --- | --- | --- |
| [#3797](https://github.com/AgoraIO-Extensions/agent-infra/pull/3797) / #3778、#3777 | merge `ffb45a65d1633aeb301d05982985676373d50552` | Reserve timing observations、动态目标与冷却缩容已完成；Backend、Heavy、Workload、Web、Issue Gate 和 review 均通过。#3778 自动关闭，#3777 已完成开发关闭；真实 ACK 仍在 #3779。 |
| [#3798](https://github.com/AgoraIO-Extensions/agent-infra/pull/3798) / #3796 | merge `d6d2965d92a133e08fcc8a0a1b020dd35e1573ca` | Skill native path 修复已合入；Backend、Heavy、Workload、review 和 Issue Gate 通过，#3796 已关闭并完成 cleanup。 |
| [#3800](https://github.com/AgoraIO-Extensions/agent-infra/pull/3800) / #3786 | merge `1b983100a0e261e71feca567e1e1a78e5b6ff367` | ACP cancel/text recovery 修复已合入；Backend、Heavy、Workload、Issue Gate 通过。#3786 保持 session-owned OPEN/REOPENED，真实 API/SSE/DB 收口由原 owner 继续。 |
| [#3792](https://github.com/AgoraIO-Extensions/agent-infra/pull/3792) / #851 | merge `e4aa8ca36a35a9b7b02d0fcf906ccc0e33be5b25` | head `3db0db88229609d9949f7ac336b0c4b37d959df0` 的 [Hosted 浏览器 job](https://github.com/AgoraIO-Extensions/agent-infra/actions/runs/41109811474/job/124249598900) 有桌面 11＋移动 11 项安装用例全部通过，总 Web 1532 passed；报告与截图已独立核对。AC-8～10 已勾选，最初本地缺 Chromium 的结果保留。清理完成。 |
| [#3789](https://github.com/AgoraIO-Extensions/agent-infra/pull/3789) / #3777 | merge `4ea71ed3c941d92fbf1fd815835e46c5a857094b` | 首次禁用 revision fencing 与 recovery 修复合入；[Hosted Backend](https://github.com/AgoraIO-Extensions/agent-infra/actions/runs/41109854244/job/124249437359) 实际覆盖 Core 5、PG reserve 27、Conversation 79。原七项开发 AC 有证据；剩余 refill observation 由 #3797 交付。合入后补充本地复核曾被重复 cleanup 中断，该轮不计通过。 |
| [#3788](https://github.com/AgoraIO-Extensions/agent-infra/pull/3788) / #3778 | merge `985c16229571437affed57b9447ff20038e37306` | 初始六资源、lease/UID、未知操作和预算行为已有 [Hosted 测试](https://github.com/AgoraIO-Extensions/agent-infra/actions/runs/41099193485/job/124213347221)；具体动态目标/缩容缺口已重开，由 #3797 修复。专属清理完成。 |

最终开发批次已收口：当前无开放 PR；开放票均属于 session-owned 或待真实部署/账号/人工验收的外部门禁。

历史状态快照 #3791/#3793/#3794 已合入，不代表其采集时间后的状态。#3793 同名分支包含合入后新增提交，专属 cleanup 保留该分支而未删除；不得记成已完成清理。后续快照按批次刷新，实时状态以 GitHub 为准。

## 分派与收口规则

1. 所有权须结合实际 Issue/PR/文件与负责人直接回复二次核查。历史 Session ID、空 assignee、idle、clean 状态均不释放写权。
2. session-owned 范围（#3747/#3786）只由原 session 继续；#3553 不在本轮分派、验收或清理中。
3. 完整开发范围完成后关闭开发 Issue；部分 PR 合入不足以关闭整票。开发 AC 按同版本实际证据勾选，真实外部验收留在明确后续票；父票还需检查自身未完成范围。
4. PR 创建后使用专属后台 watcher。合入后只由一方派发该 PR 的 cleanup，确认活动进程退出并明确交接后再清理；未合入或额外提交保留。
5. 失败、未运行、环境缺口、诊断通过与正式通过分别记录。受控测试不代签部署、真实 Token、Provider、LDAP、企微或生产 SLO。

正式结论以 [Platform PRD](../prd/PRD-agent-platform-M1.md)、[Connection PRD](../prd/PRD-connection-M1.md)、[工程 Spec](../architecture/SPEC-agent-infra-M1-engineering-architecture.md)、[开发流程](../architecture/SPEC-ai-native-development-workflow.md) 和适用 HLD/ADR 为准。
