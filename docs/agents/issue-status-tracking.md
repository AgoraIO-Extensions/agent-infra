# 开放 Issue 状态跟进

> 采集回读窗口（as-of）：2026-10-29T11:18:07.740100+00:00 至 2026-10-29T11:18:09.199823+00:00。
> 来源基线：新 worktree 创建前 fetch 回读的 `origin/main` exact SHA `f1b3934ab1550496759f644baf167117967d1ebf`。
> 本文是带时间的快照；动态状态以 GitHub 回读为准，旧 head 或其他环境的结果不代签当前验收。

采集时开放 Issue **16**：业务与验收 **15**，本次阶段治理 [#3697](https://github.com/AgoraIO-Extensions/agent-infra/issues/3697) **1**；
开放 PR **1**。本快照 PR 尚未创建，不计入该数。本次记录 Eval 开发及父票关闭后的交接阶段，
不因每次合入自动创建下一张刷新票。操作顺序见 [Issue 工作指导](issue-work-guidance.md)。

## 分类计数

| 类别 | 业务与验收数量 |
| --- | ---: |
| Runtime/Worker/Core | 2 |
| Deploy/E2E/Channels | 8 |
| Platform/Web/Skill | 2 |
| Workflow/Observability | 3 |

## 明细

| 类别 | Issue | 标题 | 采集时标签 | 下一步与边界 |
| --- | --- | --- | --- | --- |
| Deploy/E2E/Channels | [#3696](https://github.com/AgoraIO-Extensions/agent-infra/issues/3696) | test(ack): allow first browser turn to wait for cold ECI Session readiness | priority:P1, agent:codex | 原 ACK owner 持有首条消息观察器：ECI 冷启动超过默认30秒，正在复用既有180秒阶段预算；真实延迟fixture旧RED/新GREEN及三轮现场诊断不回填失败整轮 |
| Workflow/Observability | [#3694](https://github.com/AgoraIO-Extensions/agent-infra/issues/3694) | fix(harness): classify deployment Markdown as documentation | priority:P1, agent:codex | PR #3695 待CI/合并；Coordinator独占计划脚本及原测试，修正deploy Markdown误触Docker且漏文档检查，真实部署门禁保留 |
| Workflow/Observability | [#3692](https://github.com/AgoraIO-Extensions/agent-infra/issues/3692) | perf(ack): establish per-stage latency and resource baselines for fresh deployment | priority:P1, agent:codex | 原 ACK owner 采集分阶段延迟/资源并建立SLO；样本不足或无批准阈值保持未定，不用少量成功样本宣称性能达标 |
| Deploy/E2E/Channels | [#3685](https://github.com/AgoraIO-Extensions/agent-infra/issues/3685) | docs(ack): finalize portable redeploy workflow and fresh acceptance evidence | priority:P1, agent:codex | 原 ACK owner 持有最终fresh运行与部署文档；前轮功能通过但未满足ECI，后轮正确ECI又触发首消息观察窗口问题，完整合规矩阵仍待收口 |
| Deploy/E2E/Channels | [#3295](https://github.com/AgoraIO-Extensions/agent-infra/issues/3295) | blocker(ack): Flannel 环境未通过 Worker NetworkPolicy 负向验证 | agent:codex | 真实网络策略负向验收仍开放；需当前获准环境证据，不原地替换其他会话使用的 CNI |
| Deploy/E2E/Channels | [#3230](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230) | test(e2e): 固定环境 Web 与企微双向文件和图片验收（#3221） | needs-triage, priority:P1, agent:kiro | 固定环境 Web/企微双向文件图片矩阵待验；完整哈希、撤权和跨主体负例不可由局部回执代签 |
| Deploy/E2E/Channels | [#3108](https://github.com/AgoraIO-Extensions/agent-infra/issues/3108) | acceptance: ACK resumed conversations receive Messages gateway errors | priority:P1, agent:codex | 真实历史会话恢复、Messages 网关错误及完整时延证据待验；旧成功会话不代替当前矩阵 |
| Deploy/E2E/Channels | [#2998](https://github.com/AgoraIO-Extensions/agent-infra/issues/2998) | test(e2e): real WeCom credential and official QR binding acceptance | agent:codex | 真实企微凭证、官方扫码和绑定回读待验；不虚构账号或扫码完成 |
| Deploy/E2E/Channels | [#2983](https://github.com/AgoraIO-Extensions/agent-infra/issues/2983) | test(e2e): 固定环境验收 DeepSeek 与思考过程（Web 与企微） | ready-for-agent, priority:P1, agent:kiro | DeepSeek 与思考过程的 Web/企微真实矩阵待验；ready-for-agent 不代替部署验证 |
| Platform/Web/Skill | [#2858](https://github.com/AgoraIO-Extensions/agent-infra/issues/2858) | test: accept Platform management Web flow from #535 | agent:codex | 真实管理 Web/API/PG 旅程待验，覆盖身份门禁、Owner 重试与完整页面交互 |
| Runtime/Worker/Core | [#2857](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857) | test: accept Session Sandbox multi-entry isolation from #1253 | agent:codex | Session Sandbox 多入口、多 Runtime、重启撤权和跨主体隔离真实矩阵待验 |
| Platform/Web/Skill | [#1548](https://github.com/AgoraIO-Extensions/agent-infra/issues/1548) | test(skill-hub): accept the deployed lifecycle and Web conversation chain | ready-for-human, priority:P0, agent:kiro | 原 Skill session 持有真实 lifecycle/Web 验收；#3643/#3652/#3655 已合入，仍保留 #3553 排除 |
| Runtime/Worker/Core | [#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851) | feat(runtime): deliver standard MCP Agent token client | priority:P0, agent:codex | 平台已支持批准的逐 Agent 绑定；自动独立 Consumer 注册仍缺 Connection 机器认证合同，不能使用管理员 Cookie 或把 DCR ID 当 Consumer |
| Deploy/E2E/Channels | [#171](https://github.com/AgoraIO-Extensions/agent-infra/issues/171) | 准备 P0 首发真实环境 ACK tenancy 与访问入口资源 | wayfinder:task, wayfinder, priority:P0, agent:kiro | ACK tenancy、NetworkPolicy、存储、Registry、RBAC、DNS/TLS 真实环境门禁继续由环境 owner 跟进 |
| Workflow/Observability | [#144](https://github.com/AgoraIO-Extensions/agent-infra/issues/144) | wayfinder: 形成 Agent 平台 M1 启动与落地路线 | wayfinder:map, wayfinder, priority:P0, agent:codex | 全部原生children已分页回读，当前仅#171开放；#485开发已关闭，地图仍须环境前置及自身范围闭环 |

## 当前分派与文件所有权

| Lane | Primary / PR | 唯一写入范围与下一交付点 |
| --- | --- | --- |
| Eval 开发交接 | #3640 / #3684、父 #485 | 已合入并关闭，两个 Project 状态 Done；真实四模板固定集实验与其余未签收 AC 保留。后续新缺口按具名票接收，不重复认领实现 |
| 开发验证计划 | #3694 / #3695 | Coordinator 仅计划脚本与原测试；部署 Markdown 分类修复已提交，待当前 CI/合并，不碰 ACK 文档或环境 |
| ECI 首轮观察器 | #3696 | 原 ACK owner 独占真实浏览器探针与 ACK 多轮测试；其他会话只读复核，首轮预算不是产品性能优化 |
| ACK 部署与验收 | #3685 / #3692 | 原 ACK session 保留私有输入、环境、文档和性能采样；发布来源固定2848503fb，未把新合入Eval算成已部署 |
| Skill 真实验收 | #1548 | 原 Skill session 保留 lifecycle/Web 旅程；#3553 仍由其他会话跟进 |
| Connection 使用方合同 | #851 | 平台等待独立 Consumer 机器注册合同；Provider、Grant、凭据与 Connection 部署仍归原 owner |
| 状态与交接 | #3697 | Coordinator 仅更新本状态文档；每个PR专属后台watcher，合并后单PR清理，不并发抢写他人文件 |

owner 是采集时角色记录，不是跨会话接管授权。新 writer 必须重新确认 exact source、现有修改和显式交接。

## 开发 PR 回读

| PR | 采集时 head | 当前证据与下一步 |
| --- | --- | --- |
| [#3695](https://github.com/AgoraIO-Extensions/agent-infra/pull/3695) | `ae52f4451280b2b45b8af760caa689ff17e14a20` | OPEN；部署 Markdown 计划分类，原4例加新7例共11/11及独立11/11通过；正式复审无主要问题，完整Hosted仍待完成，不豁免脚本变更门禁 |

## 已关闭开发与待验收

开发关闭与真实AC签收分开。下列最终交付回读均为MERGED，required CI通过；正文原AC状态保留。

| 已关闭 Issue | 合入 PR | 收口与仍待事项 |
| --- | --- | --- |
| #3640、父 #485 | #3684 | 四个原生开发子票全关闭，父自身实现逐项核对；真实四模板回答/工具固定集两组实验仍待验，未声称ACK已部署Eval |
| #3693 | #3684 | 对话框初始焦点后单次反向Tab，双端Hosted通过；原CI瞬间焦点来源未完全复现，历史失败保留 |
| #3681 | #3682 / #3689 | 当前精确时钟边界及原1ms耗尽测试稳定性已交付；AC-4完整fresh ACK仍由#3685跟进 |
| #3686 | #3687 | 创建原键恢复、有界等待与错误分类已交付；最终八Agent/18轮/双入口AC保留 |
| #3688 | #3687 | 脚本ERR_NETWORK_CHANGED与Docker夹具清理重叠证据、项目调度隔离及完整Hosted通过；未修改产品重试或放宽断言 |
| #3653 | #3656 | 迁移后fresh ACK rehearsal（AC-5）仍待 |
| #3665 | #3666 | 最终clean ACK多轮矩阵（AC-4）仍待 |
| #3667 | #3668 | 同源迁移、8 Agent /18轮/双自有入口；原AC状态保留 |
| #3670 | #3671 | 实际镜像准入与ACK（AC-4）仍待；同Digest批准mirror由Worker独立准入 |
| #3673 | #3674 | 最终clean all及个人/默认Key独立用途验收仍待 |
| #3676 | #3678 | 最终ACK8Agent矩阵（AC-4）仍待 |

PR #3684 最终 head `7d0bed84cf46eb5b4f48f24e4b3ee7de8928e479` 的 run40855601110 全部门禁通过，
浏览器1648总项、1528通过、120原规则跳过、0失败、0flaky；六个真实HTTP/PG/S3双端集成用例全部通过。
执行时序验证普通项目结束后才运行集成桌面与移动端；受控Runtime和评分端点不代签真实四模板AC。
PR #3689 的同head第二次运行通过，首次独立Skill点击等待失败与限次重验界限保留，不改写为首次即通过。

## 本批已合入开发交付

| PR | 交付 | merge SHA |
| --- | --- | --- |
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

- #485 的原生子票 #3633/#3638/#3639/#3640 全部 CLOSED；父实现范围已独立核对并关闭开发，Project Done。AC-6真实四模板矩阵及其他未签收AC保持原状态。
- #144 全部原生children已分页回读，当前仅 #171 OPEN；地图的真实环境前置和自身范围仍须闭环，不能因Eval完成直接关闭。
- #3198 → #3202/#3203、#3202 → #3218/#3664 均已关闭；原生工具开发范围完成，真实矩阵另记。
- #3639 已随 #3672 合入而关闭；真实四模板两组Eval的AC-5仍待验。#3640的受控HTTP集成不替代它。
- #851 的最新只读外部main为 `65367b8241498f2737e135ad646ee183190aca57`：新增Provider HTTPS与本人连接Relay Key补填，不提供平台独立Consumer机器注册。管理员Cookie、DCR client_id或补Key浏览器接口均不替代缺失合同。
- ACK当前发布来源 `2848503fb001c03756bbd4a574147930a35870ea`。前轮功能通过但Session未按要求落ECI，后轮正确ECI的首消息观察默认30秒早于约61秒冷启动；后续补丁三轮成功仅属诊断，不回填原失败整轮。最终同源完整结果由 #3685/#3696 与原环境owner回读，性能目标及样本不足由 #3692保留。
- #3295/#171 的NetworkPolicy、存储、Registry、RBAC、DNS/TLS等现场证据不能由Pod Ready、健康检查或历史会话替代。验收前确认相应实现已部署，先协调原环境owner。
- 已完成PR的清理只处理各自工作树/分支，保留不明私有证据、活动进程及无关未提交内容，不执行强制全局清理。
- 用户/应用身份、凭证scope、Agent使用权与独立Eval用途分别核验；开发关闭不自动勾选真实AC。
