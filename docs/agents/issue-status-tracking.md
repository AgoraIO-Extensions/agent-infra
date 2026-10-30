# 开放 Issue 状态跟进

> GitHub 清单采集时间：2026-10-30T19:35:00Z。
> 当前来源：fresh-fetched `origin/main` exact SHA `e4aa8ca36a35a9b7b02d0fcf906ccc0e33be5b25`。
> 这是有时间边界的状态快照，不是写入授权；执行前必须重新回读 Issue 正文、评论、依赖、关联 PR、当前 worktree 和 session owner。通用分派规则见 [Issue 工作指导](issue-work-guidance.md)。

本次全量开放 Issue **17**，开放 PR **0**。#3553 明确排除。开放清单为：#3786、#3783、#3779、#3777、#3747、#3692、#3295、#3230、#3108、#2998、#2983、#2858、#2857、#1548、#851、#171、#144。

开放 PR：暂无。

## 分类计数

| 类别 | Issue 数量 | Issue |
| --- | ---: | --- |
| Runtime/Worker/Core | 6 | #3786、#3777、#3747、#3108、#851、#2857 |
| Deploy/E2E/Channels | 6 | #3779、#3783、#3295、#3230、#2998、#171 |
| Platform/Web/Skill | 3 | #1548、#2983、#2858 |
| Workflow/Observability | 2 | #3692、#144 |

数量按 Issue 主范围计；父票和验收票继续独立记录，不因开发 child 合入自动关闭。

## 当前分派与下一动作

| Issue / 类别 | 当前 owner / 归属证据 | 状态与下一动作 | 主要边界 |
| --- | --- | --- | --- |
| [#3777](https://github.com/AgoraIO-Extensions/agent-infra/issues/3777) / Runtime/Worker/Core | recovery PR #3789 已合入；复核后重新打开，当前 coordinator/Store writer 继续补开发级并发/authority/fence 回归 | 保留 OPEN：当前 authority/profile/idempotency gate、同锁序与 durable facts、parallel/race/rollback/unknown 矩阵仍未充分证明；ACK 验收另在 #3779 | 不改 Worker/ACK；不把 merge 或历史 CI 代签未证明 AC |
| [#3779](https://github.com/AgoraIO-Extensions/agent-infra/issues/3779) / Deploy/E2E/Channels | #3778 已关闭；#3777 的开发级补缺仍在收口；由性能/ACK owner 协调，已标 `ready-for-human` | 待 #3777 开发缺口收口后固定 capsule、namespace、source/image/config tuple，做 warm latency/isolation/depletion 实证 | 不把设计 PR、Worker 单测或历史 PodReady 当验收 |
| [#3783](https://github.com/AgoraIO-Extensions/agent-infra/issues/3783) / Deploy/E2E/Channels | 私有 ACK API/Worker adapter 的原 owner 范围；当前没有公开 handoff | Directory-only identity 资格修复仍 OPEN；先由原 owner 完成代码/负向检查，其他 session 不接管 | 保留历史 canonical ID；不伪造 LDAP UID、不改 Directory/LDAP/Provider |
| [#3747](https://github.com/AgoraIO-Extensions/agent-infra/issues/3747) / Runtime/Worker/Core | `session-owned`，Exclusive-Owner-Session-ID `01a187db-3f47-72e1-8855-dd94cae95dc3` | 跳过接管；当前已有真实 API task/续接/取消回执，SSE 中间 unknown 由 #3786 独立跟进 | 不重放旧 execution、不改 ACK overlay；只有原 session 或用户明确转交可继续 |
| [#3786](https://github.com/AgoraIO-Extensions/agent-infra/issues/3786) / Runtime/Worker/Core | `session-owned`，Exclusive-Owner-Session-ID `01a187db-3f47-72e1-8855-dd94cae95dc3` | 跳过接管；PR #3787 已合入，当前仍缺新镜像上的续接/重放/隔离/取消和清理回执 | 不重放 #3747 旧 execution；只有原 session 或用户明确转交可继续 |
| [#3692](https://github.com/AgoraIO-Extensions/agent-infra/issues/3692) / Workflow/Observability | assignee `LichKing-2234`，ACK 性能 owner | 757 四模板真实 preflight 和有限样本已回读；仍缺 fresh deployment 的分阶段、资源和负载基线，不能称 p95/SLO 达标 | 采集排队、准备、Pod、首字、完成分段；保留样本边界 |
| [#3295](https://github.com/AgoraIO-Extensions/agent-infra/issues/3295) / Deploy/E2E/Channels | 网络 owner 仅接收只读方案筹备，未取得 CNI/集群写权 | Flannel 不能证明 NetworkPolicy 生效；需受支持 Terway/ECI Poseidon 目标和云侧 addon 回执，再跑 allow/deny/recovery | 不原地切 CNI，不改共享集群 |
| [#3230](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230) / Deploy/E2E/Channels | `agent:kiro`、`ready-for-human`；声明写入和固定环境 owner 未落实 | 三个 FileLimits 管理 GET 当前均 404；先取得批准的类型/上限/有效期/revision，再由声明 owner 写入并跑 Web/企微双向文件矩阵 | 404、fixture 或历史登录态不能签收文件验收 |
| [#3108](https://github.com/AgoraIO-Extensions/agent-infra/issues/3108) / Runtime/Worker/Core | ROOT 持有恢复验收协调；开发诊断 PR #3734 已合入 | 缺当前部署 tuple 和原 retained Session/PVC 的新回执；保留历史 Messages gateway failure，不用新会话代签恢复 | 不操作未交接的 ACK session/PVC |
| [#2998](https://github.com/AgoraIO-Extensions/agent-infra/issues/2998) / Deploy/E2E/Channels | ROOT 持有输入核查和验收筹备；原 owner 已释放旧执行租约 | 缺获准企业微信主体、官方扫码窗口、机器人计数/标识读取权限；未执行登录、扫码或机器人写入 | 不用 mock、截图、旧 Cookie 或历史 Session ID |
| [#2983](https://github.com/AgoraIO-Extensions/agent-infra/issues/2983) / Platform/Web/Skill | `agent:kiro`、`ready-for-human`；共享 allowedModels 决策未签收 | DeepSeek Responses high 的只读能力已证实；仍缺正式 allowedModels 批准、low/high/max 三档 reasoning、刷新/隔离和企微真实回执 | 不改 catalog/Secret，不用 Claude thinking 代签 Codex 范围 |
| [#2858](https://github.com/AgoraIO-Extensions/agent-infra/issues/2858) / Platform/Web/Skill | ROOT 持有管理流程验收协调 | 正式登录/授权读回通过，但四模板 `readiness=stale`、`revision=null`；待正式模板刷新后跑申请→修改→驳回→重提→撤回及跨主体矩阵 | 不用占位镜像、复用幂等键或 409 伪造产品缺陷 |
| [#2857](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857) / Runtime/Worker/Core | ROOT 持有验收筹备；#1548 owner 仍持有 `local-e2e-01a094f5` Harness 写入 | 等 #1548 Harness 修复和明确执行窗口；再固定两个主体、两个 Agent、三入口，做隔离/并发/重启/撤权/旧代次矩阵 | 不接管 #1548 Harness、ACK 环境或 #3553 |
| [#1548](https://github.com/AgoraIO-Extensions/agent-infra/issues/1548) / Platform/Web/Skill | `agent:kiro`、`ready-for-human`；原 owner 已释放旧 writer，当前协调者只做筹备 | 缺获准 Provider/source/signature/approval、Skill materializer/Applied tuple 和四模板恢复/撤销/隔离/UI 真实链；#3752/#3754 只修 Harness cache | 不把发布成功、镜像 digest 或 fixture 链当完整 Skill 验收 |
| [#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851) / Runtime/Worker/Core | Web confirm PR #3792 已合入 `e4aa8ca3`；原 Worker owner 已接收 AC-11/12 | 浏览器 AC-10 仍待人审，Worker installation 隔离、自动 Consumer 注册、生产供应和真实 MCP/Provider 仍 OPEN | 不扩写 Connection、不代持 token、不使用管理员 Cookie |
| [#171](https://github.com/AgoraIO-Extensions/agent-infra/issues/171) / Deploy/E2E/Channels | assignee `LichKing-2234`、`wayfinder:task`；ACK 环境 owner 负责资源窗口 | 原生 blocked_by #3295；除网络外仍需 StorageClass/PVC、Registry pull、RBAC、DNS/TLS、入口和 `can-i` 回执 | 资源筹备不等于真实环境交付；父 #144 保持 OPEN |
| [#144](https://github.com/AgoraIO-Extensions/agent-infra/issues/144) / Workflow/Observability | assignee `LichKing-2234`、`wayfinder:map`；协调者复核父子范围 | #171/#3295 和自身路线/环境/跨系统交接未完成；所有开发 child 与真实验收必须分别回读后再审父票 | #3553 明确排除；不能按已关闭 child 数量关父票 |

## 当前证据与交付记录

- Root `main` 与 `origin/main` 当前均为 `e4aa8ca36a35a9b7b02d0fcf906ccc0e33be5b25`，根目录仅保留既有未跟踪 `.scratch/`；其他 worktree 不因 idle 或 clean 自动释放 owner。
- PR #3789 的 migration 0073 将新 Session allocation 的 `admission_profile_digest` 作为可空、不可猜补的创建时事实；Store PostgreSQL focused 27/27、Core reserve 5/5、migration contract、API deployment、Core/Store build/types/迁移 drift 及当前 Hosted required checks 已通过。旧 Hosted Backend 的迁移期望失败已在最终 head 修正。
- PR #3788 的 Worker follow-up 已合入 `985c16229571437affed57b9447ff20038e37306`，Issue #3778 已关闭；140/140 focused tests、Biome、Worker types 和 Hosted required checks 通过。ACK 验收与动态 reserve 真实证据仍由 #3779 跟踪。
- PR #3789 已合入 `4ea71ed3c941d92fbf1fd815835e46c5a857094b`；revision fencing、migration 0073、DELETE/late-response recovery 和 Store Hosted checks 已完成，但 #3777 复核后因开发级并发/authority/fence 证据不足重新打开，Worker owner 可从新 main 接收 #851 AC-11/12。
- PR #3792 的 Web confirm slice 已合入 `e4aa8ca36a35a9b7b02d0fcf906ccc0e33be5b25`；28 个 focused Vitest、Web build/types、Biome 和 diff-check 通过，本机缺 pinned Chromium，11 个 Playwright 测试未启动，浏览器 AC-10 仍保留 `ready-for-human` 人审边界。
- PR #3791、#3793 已合入并完成专属清理；本次快照只更新 GitHub 当前 Issue/PR 状态，不把历史快照或旧 session receipt 作为实时 owner 证据。
- 已合入的相关交付：PR #3787 merge `9ef35544bf1a30780c9e455678a375ccf6a82ad8`（ACP operation start time）；PR #3785 merge `5264fbbac6351ec84cb90cb5310fe5e78fc6ac4b`（Session reserve 初始 Core/Store，后续 recovery 已重开 #3777）；PR #3784 merge `cd1a518ea67515f99dddce3881f1630402d13346`；设计 PR #3775 merge `0d78b7849a40d69aca474716b397841f228942b1`。合入不等于父票真实 ACK 验收。
- PR #3776、#3768 等历史开发交付均已按 exact head/Hosted receipt 独立回读；本快照不把其本地 arm64 下载失败改写为通过。

## 分派与收口规则

1. 标签、历史 Session ID、空 assignee、idle、旧验收 receipt 和 clean worktree 都不能证明当前 owner 或可接管；必须回读 Issue/PR/branch/worktree，并取得明确执行权/环境租约 handoff。
2. `session-owned` Issue（包括 #3747；当前 #3783 的私有 adapter 范围也保留原 owner）由原 session 持有；未交接时只做只读审计并通知 owner，不创建实现分支。
3. 只有一个 writer 修改同一文件/部署单元。PR 创建后交给后台 watcher；确认 merge 后交给对应单 PR cleanup。开发 Issue 可在完整开发范围交付后关闭，真实验收 AC 继续留在原票或后续验收票；父票还需复核自身范围。
4. #3777/#3778/#3779 是同一 reserve 链的独立 Store、Worker、ACK 验收阶段；子项合入不自动关闭父票。#3553 不在本轮任何分派或清理范围。
5. 采集失败、环境缺口、Hosted CI 在跑和历史证据都要单独标注；不能用本地 focused tests、Pod Ready、fixture、旧 SHA 或评论意图替代当前外部证据。

正式产品/架构结论仍以 [Agent 平台 M1 PRD](../prd/PRD-agent-platform-M1.md)、[Connection M1 PRD](../prd/PRD-connection-M1.md)、工程 [Spec](../architecture/SPEC-agent-infra-M1-engineering-architecture.md)、[AI 开发流程 Spec](../architecture/SPEC-ai-native-development-workflow.md) 和适用 HLD/ADR 为准。
