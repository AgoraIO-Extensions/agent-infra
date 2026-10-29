# 开放 Issue 状态跟进

> 采集回读窗口（as-of）：2026-10-29T05:39:49.939805+00:00 至 2026-10-29T05:39:51.377152+00:00。
> 来源基线：新 worktree 创建前 fetch 回读的 `origin/main` exact SHA `fe30f2f72b74c7cd99450d4fefd2b1e35a79fca2`。
> 本文是带时间的快照；动态状态以 GitHub 回读为准，旧 head 或其他环境的结果不代签当前验收。

采集时开放 Issue **18**：业务与验收 **17**，本次快照治理 [#3690](https://github.com/AgoraIO-Extensions/agent-infra/issues/3690) **1**；
开放 PR **3**。本快照 PR 尚未创建，不计入该数。此次更新记录六张 ACK 开发票关闭、
Eval 全链路与时钟补证进入 PR、浏览器诊断的显式交接，不因每次合入自动创建下一张刷新票。
操作顺序见 [Issue 工作指导](issue-work-guidance.md)。

## 分类计数

| 类别 | 业务与验收数量 |
| --- | ---: |
| Runtime/Worker/Core | 2 |
| Deploy/E2E/Channels | 9 |
| Platform/Web/Skill | 5 |
| Workflow/Observability | 1 |

## 明细

| 类别 | Issue | 标题 | 采集时标签 | 下一步与边界 |
| --- | --- | --- | --- | --- |
| Platform/Web/Skill | [#3688](https://github.com/AgoraIO-Extensions/agent-infra/issues/3688) | test(web): diagnose intermittent approval journey navigation failures | priority:P1, agent:codex | 原 ACK session 持有审批旅程诊断；复用有界启动观测，未确认白屏根因，不放宽断言、超时或重试 |
| Deploy/E2E/Channels | [#3686](https://github.com/AgoraIO-Extensions/agent-infra/issues/3686) | fix(ack): bound creation waits and recover uncertain idempotent results | priority:P0, agent:codex | PR #3687 待合并；原 ACK owner 修复创建等待与同一幂等请求的未知结果恢复，当前 CI 失败由 #3688 继续诊断 |
| Deploy/E2E/Channels | [#3685](https://github.com/AgoraIO-Extensions/agent-infra/issues/3685) | docs(ack): finalize portable redeploy workflow and fresh acceptance evidence | priority:P1, agent:codex | 原 ACK session 持有两份部署文档和最终 fresh-run 证据；完整同源 8 Agent / 18 轮 / 双入口矩阵未代签 |
| Deploy/E2E/Channels | [#3681](https://github.com/AgoraIO-Extensions/agent-infra/issues/3681) | fix(ack): retain entry probe failures and bound transient connection retries | priority:P0, agent:codex | 生产 PR #3682 已合入；原 owner 显式移交两项时钟边界测试，补证 PR #3689 待 CI/合并；AC-4 留给原 ACK owner |
| Platform/Web/Skill | [#3640](https://github.com/AgoraIO-Extensions/agent-infra/issues/3640) | feat(eval): deliver comparative analysis feedback and complete Web workflow | priority:P2, agent:codex | 完整分析、反馈与 Web 已提交 PR #3684；当前 CI/复审未收齐，前一 head 有三项浏览器首屏失败，不能提前关闭开发 |
| Deploy/E2E/Channels | [#3295](https://github.com/AgoraIO-Extensions/agent-infra/issues/3295) | blocker(ack): Flannel 环境未通过 Worker NetworkPolicy 负向验证 | agent:codex | 真实网络策略负向验收仍开放；需当前获准环境证据，不原地替换其他会话使用的 CNI |
| Deploy/E2E/Channels | [#3230](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230) | test(e2e): 固定环境 Web 与企微双向文件和图片验收（#3221） | needs-triage, priority:P1, agent:kiro | 固定环境 Web/企微双向文件图片矩阵待验；完整哈希、撤权和跨主体负例不可由局部回执代签 |
| Deploy/E2E/Channels | [#3108](https://github.com/AgoraIO-Extensions/agent-infra/issues/3108) | acceptance: ACK resumed conversations receive Messages gateway errors | priority:P1, agent:codex | 真实历史会话恢复、Messages 网关错误及完整时延证据待验；旧成功会话不代替当前矩阵 |
| Deploy/E2E/Channels | [#2998](https://github.com/AgoraIO-Extensions/agent-infra/issues/2998) | test(e2e): real WeCom credential and official QR binding acceptance | agent:codex | 真实企微凭证、官方扫码和绑定回读待验；不虚构账号或扫码完成 |
| Deploy/E2E/Channels | [#2983](https://github.com/AgoraIO-Extensions/agent-infra/issues/2983) | test(e2e): 固定环境验收 DeepSeek 与思考过程（Web 与企微） | ready-for-agent, priority:P1, agent:kiro | DeepSeek 与思考过程的 Web/企微真实矩阵待验；ready-for-agent 不代替部署验证 |
| Platform/Web/Skill | [#2858](https://github.com/AgoraIO-Extensions/agent-infra/issues/2858) | test: accept Platform management Web flow from #535 | agent:codex | 真实管理 Web/API/PG 旅程待验，覆盖身份门禁、Owner 重试与完整页面交互 |
| Runtime/Worker/Core | [#2857](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857) | test: accept Session Sandbox multi-entry isolation from #1253 | agent:codex | Session Sandbox 多入口、多 Runtime、重启撤权和跨主体隔离真实矩阵待验 |
| Platform/Web/Skill | [#1548](https://github.com/AgoraIO-Extensions/agent-infra/issues/1548) | test(skill-hub): accept the deployed lifecycle and Web conversation chain | ready-for-human, priority:P0, agent:kiro | 原 Skill session 持有真实 lifecycle/Web 验收；#3643/#3652/#3655 已合入，仍保留 #3553 排除 |
| Runtime/Worker/Core | [#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851) | feat(runtime): deliver standard MCP Agent token client | priority:P0, agent:codex | 平台已支持批准的逐 Agent 绑定；自动独立 Consumer 注册仍缺 Connection 机器认证合同，不能使用管理员 Cookie 或把 DCR ID 当 Consumer |
| Platform/Web/Skill | [#485](https://github.com/AgoraIO-Extensions/agent-infra/issues/485) | feat(platform): deliver authorized evaluation and quality analysis | priority:P2, agent:codex | 原生 child #3633/#3638/#3639 已关闭，#3640 开放；等待其合并及父范围复核后关闭开发，真实四模板 AC-6 仍待验 |
| Deploy/E2E/Channels | [#171](https://github.com/AgoraIO-Extensions/agent-infra/issues/171) | 准备 P0 首发真实环境 ACK tenancy 与访问入口资源 | wayfinder:task, wayfinder, priority:P0, agent:kiro | ACK tenancy、NetworkPolicy、存储、Registry、RBAC、DNS/TLS 真实环境门禁继续由环境 owner 跟进 |
| Workflow/Observability | [#144](https://github.com/AgoraIO-Extensions/agent-infra/issues/144) | wayfinder: 形成 Agent 平台 M1 启动与落地路线 | wayfinder:map, wayfinder, priority:P0, agent:codex | 原生 children 完整回读，仍开放 #171/#485；子项收口后还须核对父票自身范围 |

## 当前分派与文件所有权

| Lane | Primary / PR | 唯一写入范围与下一交付点 |
| --- | --- | --- |
| Eval 集成 | #3640 / #3684 | Eval 集成 writer 的 Core/Store/API/Contracts、生成 Client、迁移与 Web 已提交；当前源码冻结供 CI/评审，不以旧 head 通过证明新 head |
| 浏览器启动诊断 | #3688 | 原 ACK owner 接收既有 page-health 诊断 helper 的后续写权及审批用例；Eval 侧 helper 冻结，不并发修改共享文件。失败取证不等于根因修复 |
| ACK 时钟补证 | #3681 / #3689 | 原 ACK owner 明确移交既有 custom-agent-web-probe 测试文件的两个边界；补证 writer 已交回 Coordinator，测试提交冻结待 CI |
| ACK 部署与验收 | #3686 / #3687、#3685 | 原 ACK session 保留创建恢复、私有部署输入、环境和最终真实矩阵；六张已关闭开发票的 AC 仍由此 owner 跟进 |
| Skill 真实验收 | #1548 | 原 Skill session 保留 lifecycle/Web 旅程；#3553 仍由其他会话跟进 |
| Connection 使用方合同 | #851 | 平台消费方等待独立 Consumer 机器注册合同；不修改 Connection 服务、Provider/Grant 权威或其 tickets |
| 状态与交接 | #3690 | Coordinator 仅更新状态文档与边界说明；每个 PR 独立后台 watcher，合入后单 PR cleanup |

owner 是采集时角色记录，不是跨会话接管授权。新 writer 必须重新确认 exact source、现有修改和显式交接。

## 开发 PR 回读

| PR | 采集时 head | 当前证据与下一步 |
| --- | --- | --- |
| [#3689](https://github.com/AgoraIO-Extensions/agent-infra/pull/3689) | `e4950140c980cf31267c5e6a20f3f3dd0e61c21c` | OPEN；仅补两项 MockTimers 边界，原文件 13/13 与独立两例通过；正式评审未发现主要问题，当前完整 CI 仍在运行 |
| [#3687](https://github.com/AgoraIO-Extensions/agent-infra/pull/3687) | `9b0d20899bbeca70886bc9f97f6e1135c3e97b16` | OPEN；原 ACK owner 的创建恢复；当前 head 的浏览器审批用例失败，关联 #3688 诊断，不能以其他检查通过认定可合并 |
| [#3684](https://github.com/AgoraIO-Extensions/agent-infra/pull/3684) | `87c2ead1e87d606db83ddc1fbb8f37bb4c744357` | OPEN；9b84 的 Web/Backend/Workload 通过、浏览器 1521 通过/120 跳过/3 失败。87c2 仅补启动观测，原双端六例本地通过，当前完整 CI/复审仍待收齐；真实 Eval AC 未签收 |

## 已关闭开发与待验收

下列六票按负责人“开发完成即可关闭”的授权收口，均回读对应 PR 已合并、最终适用 CI 通过。
关闭评论保留原 AC 状态和原 ACK owner，不把开发关闭当作最终 fresh-run 通过。

| 已关闭 Issue | 合入 PR | 真实验收仍待 |
| --- | --- | --- |
| #3653 | #3656 | 迁移后的 fresh ACK rehearsal（AC-5） |
| #3665 | #3666 | 最终 clean ACK 及完整多轮矩阵（AC-4） |
| #3667 | #3668 | 同源迁移、8 Agent / 18 轮 / 双自有入口；原 AC 勾选状态保留 |
| #3670 | #3671 | 实际镜像准入及 ACK（AC-4）；批准的同 Digest mirror 由 Worker 独立准入，不强加来源/拉取仓库字符串相等 |
| #3673 | #3674 | 最终 clean all、18 轮与双入口（AC-4）；个人与默认 Relay Key 用途保持独立 |
| #3676 | #3678 | 最终 ACK 8 Agent 矩阵（AC-4） |

最终 fresh-run 证据与部署文档关联 #3685；没有当前现场结果时不补勾 AC。

## 本批已合入开发交付

| PR | 交付 | merge SHA |
| --- | --- | --- |
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

- #3198 → #3202/#3203、#3202 → #3218/#3664：子票与父票均已关闭；原生工具开发范围已收口，真实环境矩阵单独记录。
- #485 的全部原生 children 已回读：#3633/#3638/#3639 已关闭、#3640 开放。父范围包括版本化数据、评分/复核、分析、线上反馈、用途授权、取消/恢复及审计；#3684 合并后还须回读这些交付，不能只按子票数量关闭。真实四模板 AC-6 保持待验。
- #144 的全部原生 children 已分页回读，仍开放 #171 与 #485；地图自身的范围、依赖、唯一实施归属和阶段验收跟踪也须闭环。关闭 #485 不会自动关闭仍有 #171 的父地图。
- #3639 开发已随 #3672 合入而关闭；四模板两组真实 Eval AC-5 保留待验。
- 已关闭 ACK 开发票的最终验收继续由原 owner 跟进；仅当出现明确代码缺口才恢复开发跟踪，不因状态表刷新反复开关票。
- #851 是尚未满足的外部开发合同依赖；最新只读外部 main `496114fb4c5388866acc15e909dfc13a799c7df9` 未新增 Consumer 机器注册。已有 Platform Provider Actions 不替代机器注册，管理员 Cookie 或 DCR ID 也不能替代独立 Consumer。
- #3295/#171 是真实环境门禁，不能混称“代码全部完成”。fixture、健康检查、Pod Ready、历史会话和不同 source/image 均不替代当前完整 AC。ACK 验收须先确认对应实现已部署并协调环境 owner。
- 清理遵循活动进程、未提交内容与所有权预检，不强制删除；具体本机证据保留在私有交接记录。
- 用户/应用身份、当前凭证 scope、Agent 使用权和独立 Eval 用途分别核验；调用方取消与系统控制分开，真实 AC 状态不由开发测试自动勾选。
