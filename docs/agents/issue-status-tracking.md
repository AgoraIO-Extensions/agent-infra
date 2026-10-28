# 开放 Issue 状态跟进

> 采集回读窗口（as-of）：2026-10-28T22:27:57.249164+00:00 至 2026-10-28T22:27:58.805147+00:00。
> 来源基线：新 worktree 创建前 fetch 回读的 `origin/main` exact SHA `b1049e631f9e8b6e69c8dc791867894aac779531`。
> 本文是带时间的快照；动态状态以 GitHub 回读为准，旧 head 或其他环境的结果不代签当前验收。

采集时开放 Issue **20**：业务与验收 **19**，本次快照治理 [#3679](https://github.com/AgoraIO-Extensions/agent-infra/issues/3679) **1**；
开放 PR **0**。本快照 PR 尚未创建，不计入该数。此次更新对应 Eval 实验交付后进入分析/反馈阶段，
不因每次合入自动创建下一张刷新票。操作顺序见 [Issue 工作指导](issue-work-guidance.md)。

## 分类计数

| 类别 | 业务与验收数量 |
| --- | ---: |
| Runtime/Worker/Core | 3 |
| Deploy/E2E/Channels | 11 |
| Platform/Web/Skill | 4 |
| Workflow/Observability | 1 |

## 明细

| 类别 | Issue | 标题 | 采集时标签 | 下一步与边界 |
| --- | --- | --- | --- | --- |
| Runtime/Worker/Core | [#3676](https://github.com/AgoraIO-Extensions/agent-infra/issues/3676) | fix(runtime): authorize complete ACP permission inputs after partial tool updates | priority:P1, agent:codex | PR #3678 已合入；原 ACK owner 保留同源部署/真实矩阵验收，不重复实现 ACP 参数顺序修复 |
| Deploy/E2E/Channels | [#3673](https://github.com/AgoraIO-Extensions/agent-infra/issues/3673) | fix(ack): restore the authenticated user Relay Key before browser acceptance | priority:P1, agent:codex | PR #3674 已合入；原 ACK owner 继续最终 clean-run 验收，个人 Key 与 Agent 默认 Key 用途保持独立 |
| Deploy/E2E/Channels | [#3670](https://github.com/AgoraIO-Extensions/agent-infra/issues/3670) | fix(api): honor per-template repositories alongside multi-service admission | priority:P1, agent:codex | PR #3671 已合入；按每模板镜像仓库与多服务实际部署验收，原 ACK session 持有环境 |
| Deploy/E2E/Channels | [#3667](https://github.com/AgoraIO-Extensions/agent-infra/issues/3667) | feat(ack): bind self-managed and multi-service entry acceptance to fresh Agents | priority:P1, agent:codex | PR #3668 已合入；原 ACK session 验证全新 self-managed/多服务 Agent 的自有入口 |
| Deploy/E2E/Channels | [#3665](https://github.com/AgoraIO-Extensions/agent-infra/issues/3665) | fix(ack): bound cold Runtime image readiness wait and report failures | priority:P1, agent:codex | PR #3666 已合入；冷 Runtime 就绪等待与失败回读仍需当前环境证据 |
| Deploy/E2E/Channels | [#3653](https://github.com/AgoraIO-Extensions/agent-infra/issues/3653) | feat(ack): run portable private deployment capsules | priority:P1, agent:codex | PR #3656 已合入；私有 capsule 的最终同源重部署与业务矩阵由原 ACK owner 收口 |
| Platform/Web/Skill | [#3640](https://github.com/AgoraIO-Extensions/agent-infra/issues/3640) | feat(eval): deliver comparative analysis feedback and complete Web workflow | priority:P2, agent:codex | In Progress；#3638/#3639 已关闭，从本次最新 main 隔离实现完整分析、反馈分母与正式 Web 流程 |
| Deploy/E2E/Channels | [#3295](https://github.com/AgoraIO-Extensions/agent-infra/issues/3295) | blocker(ack): Flannel 环境未通过 Worker NetworkPolicy 负向验证 | agent:codex | 真实网络策略负向验收仍开放；需当前获准环境证据，不原地替换其他会话使用的 CNI |
| Deploy/E2E/Channels | [#3230](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230) | test(e2e): 固定环境 Web 与企微双向文件和图片验收（#3221） | needs-triage, priority:P1, agent:kiro | 固定环境 Web/企微双向文件图片矩阵待验；完整哈希、撤权和跨主体负例不可由局部回执代签 |
| Deploy/E2E/Channels | [#3108](https://github.com/AgoraIO-Extensions/agent-infra/issues/3108) | acceptance: ACK resumed conversations receive Messages gateway errors | priority:P1, agent:codex | 真实历史会话恢复、Messages 网关错误及完整时延证据待验；旧成功会话不代替当前矩阵 |
| Deploy/E2E/Channels | [#2998](https://github.com/AgoraIO-Extensions/agent-infra/issues/2998) | test(e2e): real WeCom credential and official QR binding acceptance | agent:codex | 真实企微凭证、官方扫码和绑定回读待验；不虚构账号或扫码完成 |
| Deploy/E2E/Channels | [#2983](https://github.com/AgoraIO-Extensions/agent-infra/issues/2983) | test(e2e): 固定环境验收 DeepSeek 与思考过程（Web 与企微） | ready-for-agent, priority:P1, agent:kiro | DeepSeek 与思考过程的 Web/企微真实矩阵待验；ready-for-agent 不代替部署验证 |
| Platform/Web/Skill | [#2858](https://github.com/AgoraIO-Extensions/agent-infra/issues/2858) | test: accept Platform management Web flow from #535 | agent:codex | 真实管理 Web/API/PG 旅程待验，覆盖身份门禁、Owner 重试与完整页面交互 |
| Runtime/Worker/Core | [#2857](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857) | test: accept Session Sandbox multi-entry isolation from #1253 | agent:codex | Session Sandbox 多入口、多 Runtime、重启撤权和跨主体隔离真实矩阵待验 |
| Platform/Web/Skill | [#1548](https://github.com/AgoraIO-Extensions/agent-infra/issues/1548) | test(skill-hub): accept the deployed lifecycle and Web conversation chain | ready-for-human, priority:P0, agent:kiro | 原 Skill session 持有真实 lifecycle/Web 验收；#3643/#3652/#3655 已合入，仍保留 #3553 排除 |
| Runtime/Worker/Core | [#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851) | feat(runtime): deliver standard MCP Agent token client | priority:P0, agent:codex | 平台已支持批准的逐 Agent 绑定；自动独立 Consumer 注册仍缺 Connection 机器认证合同，不能使用管理员 Cookie 或把 DCR ID 当 Consumer |
| Platform/Web/Skill | [#485](https://github.com/AgoraIO-Extensions/agent-infra/issues/485) | feat(platform): deliver authorized evaluation and quality analysis | priority:P2, agent:codex | In Progress；#3633/#3638/#3639 已关闭，仅开发 child #3640 开放；完整分析/反馈/页面及真实 AC 未签收 |
| Deploy/E2E/Channels | [#171](https://github.com/AgoraIO-Extensions/agent-infra/issues/171) | 准备 P0 首发真实环境 ACK tenancy 与访问入口资源 | wayfinder:task, wayfinder, priority:P0, agent:kiro | ACK tenancy、NetworkPolicy、存储、Registry、RBAC、DNS/TLS 真实环境门禁继续由环境 owner 跟进 |
| Workflow/Observability | [#144](https://github.com/AgoraIO-Extensions/agent-infra/issues/144) | wayfinder: 形成 Agent 平台 M1 启动与落地路线 | wayfinder:map, wayfinder, priority:P0, agent:codex | 原生 children 完整回读，仍开放 #171/#485；子项收口后还须核对父票自身范围 |

## 当前分派与文件所有权

| Lane | Primary / PR | 唯一写入范围与下一交付点 |
| --- | --- | --- |
| Eval 分析与反馈 | #3640 | 当前 Eval 集成 writer：Core/Store/API/Contracts、生成 Client、迁移、共享导出、工程契约与真实 fixture。先固定用途授权、统计分母和查询语义，再交付完整纵向链路 |
| Eval Web | #3640 | 尚未单独移交写权；接口冻结后显式分派现有 evaluation 页面、本人反馈组件及具名 conversation 接线 hunk。不得抢写生成代码或共享装配 |
| ACK 部署与验收 | #3653/#3665/#3667/#3670/#3673/#3676 | 原 ACK session 保留私有部署输入、环境和真实矩阵；上述开发 PR 已合入，当前开放不表示可接管或 AC 已通过 |
| Skill 真实验收 | #1548 | 原 Skill session 保留 lifecycle/Web 旅程；#3553 仍由其他会话跟进 |
| Connection 使用方合同 | #851 | 平台消费方等待独立 Consumer 机器注册合同；不修改 Connection 服务、Provider/Grant 权威或其 tickets |
| 状态与交接 | #3679 | Coordinator 仅更新本状态文档、回读依赖与交接；PR 创建后专用 watcher，合入后单 PR cleanup |

owner 是采集时角色记录，不是跨会话接管授权。新 writer 必须重新确认 exact source、现有修改和显式交接。

## 开发 PR 回读

采集时无开放 PR。最近交付均以各自 merged 状态与 merge commit 回读；以下表格不把旧 CI 作为后续新提交证据。
已关闭而未合并的诊断 PR #3677 不计开发交付；#3675 作为 #3676 的重复项关闭，原诊断证据保留。

## 本批已合入开发交付

| PR | 交付 | merge SHA |
| --- | --- | --- |
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
- #485 → #3633/#3638/#3639 已关闭、#3640 开放；父票保持 In Progress，不以实验/评分交付代替完整分析、反馈与页面。
- #144 的全部原生 children 已分页回读，仍开放 #171 与 #485；父票自身范围及全部子项闭环后才关闭。
- #3639 开发已随 #3672 合入而关闭、Project 为 Done；四模板两组真实 Eval AC-5 保留待验。
- #3673/#3676 等由原 ACK owner 在开发 PR 合入后重新打开继续验收；不因本表刷新反复切换其状态。
- #851 是尚未满足的外部开发合同依赖；#3295/#171 是真实环境门禁，不能混称“代码全部完成”。
- fixture、健康检查、Pod Ready、历史会话和不同 source/image 均不替代当前完整 AC。ACK 验收须先确认对应实现已部署并协调环境 owner。
- 清理遵循活动进程、未提交内容与所有权预检，不强制删除；具体本机证据保留在私有交接记录。
- 用户/应用身份、当前凭证 scope、Agent 使用权和独立 Eval 用途分别核验；调用方取消与系统控制分开，真实 AC 状态不由开发测试自动勾选。
