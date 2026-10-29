# 开放 Issue 状态跟进

> 采集回读窗口（as-of）：2026-10-29T16:42:48.781806+00:00 至 2026-10-29T16:47:16.619434+00:00。
> 来源基线：创建本次 worktree 前 fetch 回读的 `origin/main` exact SHA `4ac13ee53e9f5b7809d81f18ec2f4124c5860d0b`。
> 本文是带时间的分派快照；执行前重新回读 GitHub、来源和资源占用，按 [Issue 工作指导](issue-work-guidance.md) 确认边界。

采集时开放 Issue **13**：业务与验收 **12**，本次文档治理 [#3725](https://github.com/AgoraIO-Extensions/agent-infra/issues/3725) **1**；
开放 PR **0**。本快照的 PR 尚未创建，不计入该数。下表分类只计业务与验收，治理票另列。
Project 回读：#144 与 #171 位于 `agent-infra`，状态均为 `In Progress`；其余开放票返回空列表。
Project 状态不代表相关 AC 已通过，不推定未回读的其他字段。

## 当前归属复核与纠正（2026-10-29）

此前把历史负责人、待验收和外部依赖推断为“十六项均有 session 正在或将要处理”不准确。
当时直接确认的只有 **5 项**：#3707/#3715、#3708/#3709、#3692；前四项现已关闭，
Issue #3692 仍由原 ACK 性能 owner 推进。另十一项当时没有当前执行者或未来排期的充分证明，
[归属纠正 PR #3720](https://github.com/AgoraIO-Extensions/agent-infra/pull/3720) 保留该结论。

随后 #851/#1548 取得有限调查或筹备交接，#2857/#2998/#3295 的历史 owner 也已明确释放并由
协调者接收筹备范围；#2858/#2983/#3108/#3230 已有实际局部执行。下表分别写出责任与缺口，
**筹备责任不等于完整验收已排期**。原 owner 已获接收和资源释放通知；新操作仍须核对当前窗口。

## 分类计数

| 类别 | 业务与验收数量 |
| --- | ---: |
| Runtime/Worker/Core | 2 |
| Deploy/E2E/Channels | 6 |
| Platform/Web/Skill | 2 |
| Workflow/Observability | 2 |

## 当前分派与文件所有权

“协调者”指本轮已接收上述有限交接的协调会话。表中责任仅覆盖所写范围；Connection 服务端、
Provider/Grant/凭据与其他 session 的部署资源不随调查交接转移。当前完整验收仍有输入、环境和
签收缺口，不把全部十二项写成已开工。

| Issue / 类别 | 采集时标签 | 当前责任 | 下一动作与证据边界 |
| --- | --- | --- | --- |
| [#3692](https://github.com/AgoraIO-Extensions/agent-infra/issues/3692) / Workflow/Observability | priority:P1, agent:codex | 原 ACK 性能 owner 正在执行 | 发布并验证 #3723 的 Worker 候选，完成同来源/同负载的前后对比；内部阶段、代表性负载与 SLO 仍由该 owner 跟进。 |
| [#3295](https://github.com/AgoraIO-Extensions/agent-infra/issues/3295) / Deploy/E2E/Channels | agent:codex | 协调者接收网络方案与验收计划调查 | [原 owner 已释放](https://github.com/AgoraIO-Extensions/agent-infra/issues/3295#issuecomment-6502439555)，没有已落实环境或排期。先确定支持 policy 的目标环境、实施 owner、迁移与费用边界，再做普通节点和 ECI 各自 allow/deny/recovery；现有 Flannel 不原地换 CNI。 |
| [#3230](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230) / Deploy/E2E/Channels | needs-triage, priority:P1, agent:kiro | 协调者已做前置回读，继续筹备 | [三条正式管理 GET](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230#issuecomment-6502573560) 的 404 证明该 deployment/Agent/Web Channel 声明缺失，授权拒绝为 403。需批准类型、字节上限、有效期和当前 revision 后经正式 API 配置，再核文件交换装配；企微输入另核。 |
| [#3108](https://github.com/AgoraIO-Extensions/agent-infra/issues/3108) / Deploy/E2E/Channels | priority:P1, agent:codex | 协调者已调查并交付关联修复，继续验收准备 | [关联开发 #3721 已关闭](https://github.com/AgoraIO-Extensions/agent-infra/issues/3721#issuecomment-6502483009)，本采集窗口尚未部署。安排新版本事实消费验证，另取原失败会话/同 PVC 恢复、完整时延与错误/unknown 证据；旧 sealed 历史不回填。 |
| [#2998](https://github.com/AgoraIO-Extensions/agent-infra/issues/2998) / Deploy/E2E/Channels | agent:codex | 协调者接收输入核查与验收筹备 | [原 owner 已释放](https://github.com/AgoraIO-Extensions/agent-infra/issues/2998#issuecomment-6502440811)。尚无已核实扫码登录态或 Provider 权限；先落实获准测试主体、官方扫码和企业侧机器人计数，再安排真实绑定/重试矩阵。 |
| [#2983](https://github.com/AgoraIO-Extensions/agent-infra/issues/2983) / Deploy/E2E/Channels | ready-for-agent, priority:P1, agent:kiro | 协调者已执行前置与局部旅程，等待准入条件 | [当前实测](https://github.com/AgoraIO-Extensions/agent-infra/issues/2983#issuecomment-6502626563)：误选的 Claude 首轮完成但无 reasoning，未计通过；Codex/DeepSeek 创建 400、未生成绑定。当前 Responses 端点仅允许 `gpt-5.6-sol`，需正式批准并验证 DeepSeek 组合后做 Codex 多轮、刷新、隔离及企微。 |
| [#2858](https://github.com/AgoraIO-Extensions/agent-infra/issues/2858) / Platform/Web/Skill | agent:codex | 协调者已完成只读 UI 子矩阵，继续验收准备 | [双主体、桌面/移动列表与刷新](https://github.com/AgoraIO-Extensions/agent-infra/issues/2858#issuecomment-6501157609) 有真实部分证据。下一步固定版本与专用对象，补申请/审批、Owner 配置、生命周期、跨主体 API 和完整交互；列表通过不签整票。 |
| [#2857](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857) / Runtime/Worker/Core | agent:codex | 协调者接收协调与验收筹备 | [原 owner 已释放](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857#issuecomment-6502440197)。先固定最新 main、专用 Harness、两主体/两 Agent/三入口及至少两个 Runtime，再跑隔离、并发、重启、撤权和旧代次矩阵；外部输入仍须核实。 |
| [#1548](https://github.com/AgoraIO-Extensions/agent-infra/issues/1548) / Platform/Web/Skill | ready-for-human, priority:P0, agent:kiro | 协调者仅接收调查与验收筹备 | 历史 owner 已明确停止并释放；[已有本地真实正向链](https://github.com/AgoraIO-Extensions/agent-infra/issues/1548#issuecomment-6468617036) 保留其来源。[当前装配复核](https://github.com/AgoraIO-Extensions/agent-infra/issues/1548#issuecomment-6502790421) 尚不证明外部 Provider、扫描信任或 Applied 链就绪；先核完整来源/版本/配置组合，再补四模板、恢复/撤销/隔离和人工签收；#3553 排除。 |
| [#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851) / Runtime/Worker/Core | priority:P0, agent:codex | 协调者仅接收 Platform 消费侧调查与状态收口 | AC-5–7 开发已完成；[机器注册合同仍缺](https://github.com/AgoraIO-Extensions/agent-infra/issues/851#issuecomment-6491428253)。自动注册、已批准逐 Agent 安装/Token 供应、真实联合验收分别推进；后两项先核两主体/两 Agent 的批准映射，不等待第一项而停止调查。 |
| [#171](https://github.com/AgoraIO-Extensions/agent-infra/issues/171) / Deploy/E2E/Channels | wayfinder:task, wayfinder, priority:P0, agent:kiro | 协调者负责依赖收口；环境实施责任待落实 | 原生 blocked_by 为 #3295。网络能力通过后仍需当前 namespace/quota、存储、Registry、RBAC、DNS/TLS 和入口证据；筹备交接不代表集群迁移或资源实施已排期。 |
| [#144](https://github.com/AgoraIO-Extensions/agent-infra/issues/144) / Workflow/Observability | wayfinder:map, wayfinder, priority:P0, agent:codex | 协调者负责父子状态复核；原范围签收责任保留 | 75 个原生子项中仅 #171 OPEN；待其收口后重审父票自身 P0/P1、环境及跨系统交接范围，不能只按已关闭子票数量关父票。 |

文档 lane 的 primary 为 #3725，writer 仅拥有 `issue-work-guidance.md` 与本文件；活动 ACK
owner 已再次确认不写这两份文档。其他 lane 的实施文件须在具体 primary Issue 下另行冻结，
本表不授予新的代码或环境写权。每个新 PR 委派后台 watcher，确认合入后委派单 PR 清理；
协调者继续处理其他可执行项。

## 验收依据与输入

- #2983 的思考展示按 [ADR-0026](../adr/0026-show-model-reasoning-as-conversation-content.md) 的 Codex 范围验收。模型来源按 [ADR-0030](../adr/0030-source-standard-template-models-from-relay.md) 的默认 Key `/models` 与保存时真实协议验证；旧票的烘焙目录/`codexModelProfiles` 不是当前前置。Claude 一轮成功回答没有思考事件，不能用于本票签收，也不能据此扩展 Claude 需求。
- #3230 已区分管理声明缺失和权限拒绝；三条管理 404 不能推定整表为空或文件数据面开关关闭。部署、Agent、Channel 限额必须有批准的类型/大小/有效期/revision，再与环境 owner 确认变更窗口。
- #2998 的官方扫码、机器人计数和 #2857/#1548 的外部 Provider/Connection 证据需要真实获准输入。先完成不依赖缺失输入的调查，实际运行时逐项记录未测范围。
- #3295 当前只有可审阅的执行顺序，目标环境、实施 owner、迁移和费用边界尚未落实；其普通节点与 ECI 网络拒绝须分别实测。HTTP 401、Pod Ready 或 NetworkPolicy 对象存在均不代签网络 deny。

## 开发 PR 回读

以下 PR 状态、最终 head 和 merge 均在上述采集窗口回读；对应开发 Issue 已关闭。
合入来源不能当作已部署来源，真实验收仍由上表各票承接。

| PR / 开发 Issue | 最终 head | merge SHA | 交付与剩余边界 |
| --- | --- | --- | --- |
| [#3724](https://github.com/AgoraIO-Extensions/agent-infra/pull/3724) / #3721 | `499750e2955ebe0a07df2f743f88e1cb699eb7a9` | `4ac13ee53e9f5b7809d81f18ec2f4124c5860d0b` | Runtime operation facts 与 replay 事件在同一持久提交中发布；[最终开发证据](https://github.com/AgoraIO-Extensions/agent-infra/issues/3721#issuecomment-6502483009) 包含全 Runtime 2444 passed/37 skipped、独立回归与适用 Hosted CI。尚未部署 ACK，旧 sealed 历史不补写。 |
| [#3723](https://github.com/AgoraIO-Extensions/agent-infra/pull/3723) / #3722 | `5cabc78908ca213b83a368a88ca936c8ebc605df` | `7549fd5d169bab68deef7163e9dd50399b7cc071` | Workload monitoring 下的生命周期等待修复；性能 owner 继续 #3692 的正式发布、部署和可比测量，开发合入不签性能达标。 |
| [#3720](https://github.com/AgoraIO-Extensions/agent-infra/pull/3720) / #3719 | `5746f309e258934094266a6c361f340b579ad228` | `1e4fb9e2d96d3c8d41d9ab1442c6152a0acb49c2` | 纠正未验证归属；本次继续补直接释放、有限接收和实际前置结果。 |
| [#3718](https://github.com/AgoraIO-Extensions/agent-infra/pull/3718) / #3714 | `cc8854d4ad206613d225395f58fabeea3e05c59d` | `540ab71ad8891b6d7420005b6b5d80c8a2c9bc09` | 同次 promotion 复用签名 readiness；不引入跨轮缓存，不代替后续性能对比。 |
| [#3717](https://github.com/AgoraIO-Extensions/agent-infra/pull/3717) / #3713 | `d7d2551c9c855e68dad94f8f7a7654293f24672e` | `96ee52e1bfbf76d6fb373df1cb381dd045ff8353` | Eval Bearer 接受契约定义的 query，适用 Hosted 检查完成；不扩大其他管理路由参数。 |
| [#3716](https://github.com/AgoraIO-Extensions/agent-infra/pull/3716) / #3712 | `2fe6490c13b63924a484637e0552dfb38206c2bd` | `29ccad078b97aed243731790403f292acccde057` | 历史 v8 与当时分派快照；当前责任以本文件本次采集窗口为准。 |
| [#3711](https://github.com/AgoraIO-Extensions/agent-infra/pull/3711) / #3707/#3715 | `bc222e8cff57d9b09d5f23014411aa65ee17a056` | `69f7700f320365418c093e2038b8f8e9c6eda67b` | 原迁移 owner 完成自建 Agent API 迁入与持续更新证据，已收口，不再列为活动开发 writer。 |
| [#3710](https://github.com/AgoraIO-Extensions/agent-infra/pull/3710) / #3708/#3709 | `8c589b81b0dcd8c7afd4fc26a4d835f3cb91b86c` | `50bc1b3e4dd1b012f29382a52c39fa85bc60b763` | 原架构 owner 完成 native metadata transport 与 ACK binding 收拢，已收口。 |
| [#3704](https://github.com/AgoraIO-Extensions/agent-infra/pull/3704) / #3703/#3705 | `d6f6e6e6bcab00f7b61899e8ac30a3cec67e381f` | `836cacd2740fb8b62eafcbdbdc11d44975168b66` | Harness CLI 状态隔离与 Eval 到期 fixture 一并交付，保留原失败轮次；不改变生产超时或授权。 |

[PR #3706](https://github.com/AgoraIO-Extensions/agent-infra/pull/3706) 已关闭但未合入，最终 head
`8d3517133d04382fb945062b5d917c8feac9a348`；其 Eval 修复通过 #3704 交付，不能记录为另一次 merge。

## 历史证据与当前验收边界

ACK v8 限定功能矩阵的 source 为 `192bb8c87ad4cfe5eb28e6b1e3617d8bd5dc2705`，
[部署总结](../../deploy/ack/ACK-REDEPLOY-LESSONS.md#本轮完整清空重建) 记录其范围。
原八 Agent、十八浏览器/模型完成事实、六个业务 ECI Session 与双自有入口只证明该次组合。
后续 Worker、模板验证或配置更新各有独立来源，不能把当前 main、部署文档 merge 和 v8 运行源互换。

[#3108 的原十八轮只读复核](https://github.com/AgoraIO-Extensions/agent-infra/issues/3108#issuecomment-6500775499)
取得三轮 Codex 的原模型耗时；另外十五轮非 Codex 的 Platform 事件未同步 Runtime journal 中的
模型事实，已由 #3724 修复新发布路径。三轮时延、历史 journal、页面列表通过均不足以签收完整
时延、思考/工具、文件、隔离、原失败会话恢复或外部账号矩阵。

开发关闭与真实 AC 签收分别回读。已关闭开发票的历史未勾 AC 继续由具名验收范围承接，
本次文档不改验收 checkbox；发现新代码缺口时按原 primary 范围修复或建立完整 Issue。

## 父子收口与真实验收

- [#144](https://github.com/AgoraIO-Extensions/agent-infra/issues/144) 的 75 个原生子项已分页回读，仅 #171 OPEN；[#171](https://github.com/AgoraIO-Extensions/agent-infra/issues/171) 的原生 `blocked_by` 为 #3295，正文已同步。父票仍须完成自身范围审核，当前保持 OPEN。
- #851 的 AC-5–7 开发完成不代表自动注册、生产安装供应和联合验收全完成；协调者只处理 Platform 消费侧调查，不代排 Connection 内部工作。
- #3553 由另一 session 跟进，继续排除；本次交接不授权操作其文件、环境或 Issue。
- 当前无开放 PR 不等于整体目标完成；关闭每个开发票、验收票或父票前，回读其自身范围、全部子项与原生依赖。
