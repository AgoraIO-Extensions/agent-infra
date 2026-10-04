# M1 三层交付与汇合计划

## 1. 状态与权威

本计划由 [#150](https://github.com/AgoraIO-Extensions/agent-infra/issues/150) 维护，
总入口为 [#144](https://github.com/AgoraIO-Extensions/agent-infra/issues/144)。
本次范围基线为 2026-10-04 的已确认产品边界；交付状态、负责人、PR 和依赖以 GitHub 当前回读为准。
规划、文档合并、组件测试和真实产品验收分别记录，不能互相代替。

产品范围以 [Platform PRD](../prd/PRD-agent-platform-M1.md) 和
[Connection PRD](../prd/PRD-connection-M1.md) 为准；实现遵守
[工程 Spec](SPEC-agent-infra-M1-engineering-architecture.md)、
[Runtime HLD](HLD-agent-runtime-M1.md) 与 [Connection HLD](HLD-connection-M1.md)；
交付遵守 [开发工作流](SPEC-ai-native-development-workflow.md)。本计划只维护阶段和汇合关系，
具体功能、权限和验收要求留在对应权威文档与原 Implementation Issue。

GitHub native dependencies 是执行图权威，正文 `Blocked by` 只作投影。
下表的相关票和责任交接不自动形成新的整票 blocker，不创建第二套调度状态。

## 2. 首发 P0 与后续范围

四模板与自定义入口均属首发。Paseo 类能力在本计划中指同一平台对话内的原生 `/` 指令、
已安装 Skill 的发现、选择和实际调用；其权威契约见 Platform PRD §11.3。
这些能力由真实 Runtime 支持情况决定，目录或菜单不能替代实际加载和调用证据。

| 交付结果 | 唯一主入口及现有分工 |
| --- | --- |
| 四模板可选择、申请并完成真实对话与恢复 | #535/#1259 真实 readiness，#481/#1260 默认 Key，#1261–#1264 各 Runtime 首通；复用 #504/#508，不另造执行循环 |
| 自定义 ACP 与独立 Web 入口 | #444 汇总；#1265/#1266 ACP 文本和模型选择；#1267/#1268 独立 Web 两种身份模式；不将自有会话冒充 Platform Conversation |
| 原生命令与已安装 Skill 的产品闭环 | #992 汇总；#1074 真实 Skill 发现，#1148 生产 metadata 读取链，#1050 受控安装；#192 同一对话页消费 |
| 用户与独立应用可管理 Agent、执行持久任务 | #481 管理与凭证，#482 Task/受理/查询/取消/恢复；#1217 等现有切片保持各自责任 |
| 同一 Agent 的 Session 具有独立运行边界 | #1250 分配权威、#1251/#1319 资源与生产 resolver、#1252 Runtime 消费、#1255 egress、#1253 真实隔离验收；沿原任务事务与唯一 Worker/Host |
| 托管企微真实收发 | #440：生产装配、Owner 配置、可信发送者、幂等与恢复；真实双发送者验证与 fixture 分列 |
| Builder 可构建、确认发布并恢复失败 | #1182 唯一构建批次实施入口；构建和创建 PR 独立，绑定同一不可变源码提交；完整清理与回退义务保留 |
| 真实工具操作、执行事实和双系统审计 | #508 可信执行、#483 四模板模型/工具事实生产与持久接收；#484/#441 消费原事实；外部 Connection 原 owner 负责其授权/执行/审计 |
| 同版本部署、必要页面、基础运维与可信证据 | #504 生命周期与装配，#400 既定 IA，#192 对话，#535 管理，#484/#441 审计观测，#171/#177 环境与签收输入 |

上述是交付责任索引，不表示每个主票都需要新的实现 PR。
已合入的实现先核对剩余 AC，确有差额时沿原票处理；不得将共享文件空闲或 assignee 为空视为接管授权。
原生命令、Skill 和其他模板的真实支持矩阵按固定 Runtime 版本回读，不能通过全部隐藏能力完成签收。

**P1 保留完整 M1 义务：** 文件权威与跨入口文件链 #442/#445、Eval #485、容量与运维恢复 #446、
其余体验、四模板全部能力组合以及完整多日 Pilot。混合票按具体 AC 报告阶段；P0 通过不代签剩余 P1。
可选 Langfuse sink 属后续观测扩展，不承担审计、授权或业务成功判定。

**P2 为本仓开发辅助改进：** 开发协调 #690 和 Goal 生成器 #702，保留未来目标与已有成果。
Connection 系统的 Provider、审批、部署和内部排期由其原 owner 管理，本计划不调整其优先级或任务状态。

Skill Hub 发布/分发治理、多 Agent 协作、通用 Sandbox 产品、Webhook/定时任务等按 PRD Roadmap 处理。
M1 的 Session 隔离、Agent API、Eval 与上述原生命令/Skill 已有正式范围，不再归入旧 Roadmap 摘要。

## 3. 三层验收与成功声明

| 层次 | 责任与输入 | 完成边界 |
| --- | --- | --- |
| L1 主系统本地 readiness | #194；正式 Web/API/Worker/RuntimeHost、PostgreSQL、受控 Kubernetes 与固定 Schema 的 Fake Connection | 同一源码/镜像/配置下完成原旅程与负向验证；Fake 不证明真实 Connection 或真实模型效果 |
| L2 当前 P0 真实闭环 | #192 当前代表旅程与 #481/#482、#484/#441、各模板/入口主票分别取证，#177 固定同版本环境包，回链 #150 | 创建、真实任务、恢复/取消、隔离/撤权、外部操作及审计逐项通过；每个首发模板/入口有其明确证据，未验证项不外推 |
| L3 完整 M1 | #150 汇合各原票；#177 安排具名参与者、资源窗口与 Go/No-Go | 逐项满足 Platform PRD §16、Connection 适用条款及工程验收；完整 P1、多用户和多日观察义务保留 |

原 #435/#668 保持 not_planned 历史状态，不恢复旧联合探针或另建竞争性验收体系。
总验收责任由 #144 主责承接，各领域原 owner、Security、SRE 与使用者分别签收；协调者不能代签。
L1 Kubernetes 证据保留独立 Workload reviewer，沿 #194 原责任记录签收。
Interface/Schema、源码、镜像 Digest、迁移、配置修订、环境和执行关联必须绑定同一受验版本。

## 4. Platform 消费外部 Connection 的边界

Connection 保持独立系统、身份、数据和部署归属。Platform/Agent 消费其 Direct MCP/API，
不恢复旧 Platform Gateway、delegated assertion、policy fence 或第二套 Connection DTO。
旧 #186/#398 只保留历史处置，不作为当前实现授权。

Platform 真实工具链消费 Connection 原 owner 提供的受限 GitHub 验收输入。
外部系统的两个独立测试主体、两个专用 GitHub 账号和受控 private 仓库等准入条件只按当前 PRD/HLD 回读，
本计划不代为安排其实现、环境或签收。
未知 WRITE 不盲目重发，原始凭据不进入 Agent；两侧审计关联来自同一次受信执行与请求/响应。

完整联合 Pilot 继续保留 #149 的 3–5 名独立正向参与者、5 个工作日、每人至少一次 PR、合计不少于 10 次任务。
扩大 Connection 正向主体前先完成对应 PRD/HLD 对齐、消费方评审和独立准入；不能共用两账号冒充多人隔离。
受限两主体验收不外推完整多日 Pilot。

外部 #395 提供当前独立 Connection 版本和运行 readiness，#402 协调其原有实施责任。
历史部署票 #301 的完成与替代条件沿原 owner 回读，状态本身不证明当前入口可消费。
L1 的 Fake 只消费 Connection owner 提供的固定、不可变 Schema artifact，固定版本、来源及校验值。

## 5. 责任、依赖与最小执行队列

每个正在执行的交付须具备完整 primary Issue、唯一负责者、实际 writer、明确修改边界、
所需生产者输入和可独立验收的结果。尚未解决的契约、资源或 owner 缺口在原票维护，保持 triage。
优先级、空 native 列表、旧 readiness 标签均不能替代执行准入。

产品票 #992 的必要生产接收沿 #1148：#481 提供 policy/公共契约，#482 提供原 Request/Store 当前复查，
由 #508 负责 Worker/Host，#504 负责服务身份与进程装配，#992 消费具体 Driver 能力。
已交付首片 #1029/#1051 等先收敛真实剩余验收和 post-merge 状态，不重复排开发工作。

共同修改面的工作先由原 owner 固定交接顺序、提交与接收者；只有互不冲突且输入齐全的独立交付才并行。
共享 DRI 不能被解释为无限容量；本地闲置、超时和未分配 assignee 均不自动移交责任。
新票仅用于现有范围无法容纳的独立交付；同一目标的步骤优先放在原票 checklist。

## 6. 状态收敛

- 父票记录产品结果和剩余 AC，子票记录实际独立交付；统计时不把父子各算一次实现工作。
- 合并步骤票先把剩余 AC 映射到存活票，再核对并维护相关 native dependencies；取消独立任务按 not_planned 记录。
- 只有原 AC 已完成且证据明确才关闭为 completed；PR 合并本身不充分，历史部署回执也不外推当前生产状态。
- post-merge 重开逐票核对原功能与失败根因；公共扫描问题统一回链已有 #984，保留其 strict gate。
  已完成子票可以在具名归因与原 AC 核验后收尾，运行或安全验收未完成的票继续开放。
- 不因本轮计划整理重新触发 Worker、清理他人分支/工作树或撤销已有 PR；原 owner 的有效边界保持。

## 7. 日期、资源与回读

原 P0 目标日期为 **2026-10-05（Asia/Shanghai）**。本计划不把新增首发范围或优先级标签当作可按期完成的证据。
剩余实施量、共享文件顺序、真实模型/账号/环境、人工评审或复验窗口不确定时，记录具名缺口与影响项，
保留待估，不虚构完成百分比或新的目标日期。

资源票 #171 负责运行资源，#177 固定身份/模型/Registry/keyring、测试主体、Runbook、窗口和 Go/No-Go；
Connection 原 owner 供应独立系统的准入与环境证据。资源准备状态与真实 ready 分开。
原生真实执行、Browser、Kubernetes、授权负向、恢复和适用人工签收缺一不可；验收仅清理自身创建的测试资源。

本轮完成须回读原计划、#144/#150、受影响 Issue 的正文/优先级/状态、AC 映射、原生边及相应 Project 投影。
阶段票 #150 关闭仍按其全部 AC 判断，文档 PR 合入不自动签收全部规划、真实运行或完整 M1。

```bash
gh issue view 150 --repo AgoraIO-Extensions/agent-infra --comments
gh issue view 144 --repo AgoraIO-Extensions/agent-infra --comments
gh issue list --repo AgoraIO-Extensions/agent-infra --state open --limit 2000 --json number,title,labels,assignees,milestone
gh api graphql -f query='query { repository(owner:"AgoraIO-Extensions",name:"agent-infra") { issue(number:992) { number state blockedBy(first:100) { totalCount nodes { number state } } } } }'
```
