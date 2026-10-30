# 开放 Issue 状态跟进

> 采集时间：2026-10-30T21:36:37Z。
> 源码基线：fresh-fetched `origin/main`，`5a067680262282e2f8d6de73e9fb3346e488054a`。
> 本文是有时间边界的快照；执行前重新读取 GitHub、工作树与负责人回复。通用分派规则见 [Issue 工作指导](issue-work-guidance.md)。

本次开放 Issue **19**，开放 PR **3**。#3553 明确排除。
开放 Issue 为 #3796、#3786、#3783、#3779、#3778、#3777、#3747、#3692、#3295、#3230、#3108、#2998、#2983、#2858、#2857、#1548、#851、#171、#144。

## 分类计数

| 类别 | 数量 | Issue |
| --- | ---: | --- |
| Runtime/Worker/Core | 7 | #3786、#3778、#3777、#3747、#3108、#851、#2857 |
| Deploy/E2E/Channels | 6 | #3783、#3779、#3295、#3230、#2998、#171 |
| Platform/Web/Skill | 4 | #3796、#1548、#2983、#2858 |
| Workflow/Observability | 2 | #3692、#144 |

类别按主要工作范围计数，父票和独立验收票分别保留。新增或重开的开发票必须对应具体未完成行为，不能仅凭旧 review 摘要或空 checkbox 推断代码缺失。

## 当前分派与文件所有权

| Issue | 当前负责人及交接事实 | 当前工作与下一步 |
| --- | --- | --- |
| [#3777](https://github.com/AgoraIO-Extensions/agent-infra/issues/3777) | 协调者已接收原 owner 明确交接的 Core/Store reserve 统计写权 | 原七项开发 AC 已独立映射并勾选；AC-8 由 PR #3797 交付，待该 PR 基于当前 main 完成 Hosted 收口。已有并发、权限、回滚测试不重复列为缺口。 |
| [#3778](https://github.com/AgoraIO-Extensions/agent-infra/issues/3778) | 同一 writer 独占 reserve controller 与上述统计接口 | PR #3797 交付动态目标、实际补充耗时和冷却缩容；当前 Draft head `e32fa7b2efdd994b04692110f0493025c44d9dcb` 仍基于旧 main `182281dab`，等待 owner 普通合并当前 main、重跑 exact-head Hosted checks 后再收口。 |
| [#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851) | Web slice 已合入；原 Worker owner `01a17acb-4309-7b62-b94e-d5056faa7778` 独占 deployment-entry 两文件 | AC-8～10 已凭 #3792 的两视口浏览器证据补签；AC-11/12 已由 PR #3795 merge `ddc1c6318484de0eb09aded999c63965ef8a687d` 交付。自动 Consumer 注册合同、已批准生产供应及真实 MCP/Provider 联合验收仍未完成。 |
| [#3796](https://github.com/AgoraIO-Extensions/agent-infra/issues/3796) | Skill owner `01a1335c-e8eb-7db3-98a1-d898ffa7d29a`，已与 release/custom owner 交叉确认无文件冲突 | PR #3798 已 Ready，head `5e529502109db46752c2cbe63e6a5af1b4a76dca` 基于当前 main；Backend/Heavy/Workload Hosted checks 仍在运行。三份 Skill 文件及 RuntimeHost Dockerfile 的具名 hunk 由该 owner 持有；已设为 #1548 原生 child。 |
| [#3783](https://github.com/AgoraIO-Extensions/agent-infra/issues/3783) | ACK owner 已将只读私有输入交给协调者做离线候选；上线权仍由 ACK owner 持有 | 22 项离线回归已独立通过，原输入与非认证声明保留。旧 adapter 将 Directory 状态冒充 LDAP 当前状态；可信 current-status authority 合同仍待确认，标记 needs-info。候选未准入 rollout。 |
| [#3786](https://github.com/AgoraIO-Extensions/agent-infra/issues/3786) | session-owned，原 owner `01a187db-3f47-72e1-8855-dd94cae95dc3` 实际继续处理 | PR #3800 已创建并基于当前 main；Backend/Heavy 重跑中，Workload 旧失败日志为 Hosted runner Docker `no space left on device`，不据此改代码。原 owner 继续控制真实 API/SSE/DB 验证，其他 session 不接管或重放旧 execution。 |
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
| [#3797](https://github.com/AgoraIO-Extensions/agent-infra/pull/3797) / #3778、#3777 | head `e32fa7b2efdd994b04692110f0493025c44d9dcb`，Draft，base `182281dab` | Core 9、Worker 78、真实 PG reserve 36、凭据迁移 8 通过；全仓 check/types/build/smoke、meta 与迁移 drift 通过，独立最终审阅无 finding。完整迁移为 43/44，既有 original27 用例默认 5 秒超时；15 秒单项诊断通过不替代默认门禁。等待 owner 普通合并当前 main 后重跑 exact-head Hosted 迁移与镜像构建证据。 |
| [#3795](https://github.com/AgoraIO-Extensions/agent-infra/pull/3795) / #851 | merge `ddc1c6318484de0eb09aded999c63965ef8a687d` | Hosted checks 已通过并已由原 owner 完成专属 cleanup；#851 仍开放以跟踪自动 Consumer 注册、批准生产供应和真实 MCP/Provider 联合验收。 |
| [#3798](https://github.com/AgoraIO-Extensions/agent-infra/pull/3798) / #3796 | head `5e529502109db46752c2cbe63e6a5af1b4a76dca`，Ready，base `5a067680` | PR-Agent review、Issue Gate 和 CI setup 已通过；Backend/Heavy/Workload Hosted checks 仍在运行。旧 head/旧 Draft 记录不再作为当前证据。 |
| [#3800](https://github.com/AgoraIO-Extensions/agent-infra/pull/3800) / #3786 | head `a79d19d66691d058c65fb33cd6e48395e0e57010`，Ready，base `5a067680` | Backend/Heavy 重跑中；旧 Workload failure 的日志是 runner Docker layer `no space left on device`，不能当作代码失败，也未据此关闭 Issue。由 session-owned owner 继续收口。 |
| [#3792](https://github.com/AgoraIO-Extensions/agent-infra/pull/3792) / #851 | merge `e4aa8ca36a35a9b7b02d0fcf906ccc0e33be5b25` | head `3db0db88229609d9949f7ac336b0c4b37d959df0` 的 [Hosted 浏览器 job](https://github.com/AgoraIO-Extensions/agent-infra/actions/runs/41109811474/job/124249598900) 有桌面 11＋移动 11 项安装用例全部通过，总 Web 1532 passed；报告与截图已独立核对。AC-8～10 已勾选，最初本地缺 Chromium 的结果保留。清理完成。 |
| [#3789](https://github.com/AgoraIO-Extensions/agent-infra/pull/3789) / #3777 | merge `4ea71ed3c941d92fbf1fd815835e46c5a857094b` | 首次禁用 revision fencing 与 recovery 修复合入；[Hosted Backend](https://github.com/AgoraIO-Extensions/agent-infra/actions/runs/41109854244/job/124249437359) 实际覆盖 Core 5、PG reserve 27、Conversation 79。原七项开发 AC 有证据；剩余 refill observation 由 #3797 交付。合入后补充本地复核曾被重复 cleanup 中断，该轮不计通过。 |
| [#3788](https://github.com/AgoraIO-Extensions/agent-infra/pull/3788) / #3778 | merge `985c16229571437affed57b9447ff20038e37306` | 初始六资源、lease/UID、未知操作和预算行为已有 [Hosted 测试](https://github.com/AgoraIO-Extensions/agent-infra/actions/runs/41099193485/job/124213347221)；具体动态目标/缩容缺口已重开，由 #3797 修复。专属清理完成。 |

历史状态快照 #3791/#3793/#3794 已合入，不代表其采集时间后的状态。#3793 同名分支包含合入后新增提交，专属 cleanup 保留该分支而未删除；不得记成已完成清理。后续快照按批次刷新，实时状态以 GitHub 为准。

## 分派与收口规则

1. 所有权须结合实际 Issue/PR/文件与负责人直接回复二次核查。历史 Session ID、空 assignee、idle、clean 状态均不释放写权。
2. session-owned 范围（#3747/#3786）只由原 session 继续；#3553 不在本轮分派、验收或清理中。
3. 完整开发范围完成后关闭开发 Issue；部分 PR 合入不足以关闭整票。开发 AC 按同版本实际证据勾选，真实外部验收留在明确后续票；父票还需检查自身未完成范围。
4. PR 创建后使用专属后台 watcher。合入后只由一方派发该 PR 的 cleanup，确认活动进程退出并明确交接后再清理；未合入或额外提交保留。
5. 失败、未运行、环境缺口、诊断通过与正式通过分别记录。受控测试不代签部署、真实 Token、Provider、LDAP、企微或生产 SLO。

正式结论以 [Platform PRD](../prd/PRD-agent-platform-M1.md)、[Connection PRD](../prd/PRD-connection-M1.md)、[工程 Spec](../architecture/SPEC-agent-infra-M1-engineering-architecture.md)、[开发流程](../architecture/SPEC-ai-native-development-workflow.md) 和适用 HLD/ADR 为准。
