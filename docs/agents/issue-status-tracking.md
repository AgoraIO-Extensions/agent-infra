# 开放 Issue 状态跟进

> GitHub 清单采集时间：2026-10-30T09:19:02Z。
> 开发来源：fresh-fetched `origin/main` exact SHA `07f7bb4d11474f09db184571c8e9d9ec4b7a5770`。
> 本文是有时间边界的分派快照；执行前按 [Issue 工作指导](issue-work-guidance.md) 重新回读 GitHub、当前来源与资源归属。

采集时开放 Issue **17**：业务、开发与验收 **16**，本次文档治理 [#3772](https://github.com/AgoraIO-Extensions/agent-infra/issues/3772) **1**。
开放 PR 只有 Draft [#3769](https://github.com/AgoraIO-Extensions/agent-infra/pull/3769)，head `d0ea3aab1452bceaddb846355003da5cc6d30653`；本快照自身 PR 尚未创建，不计入该数量。

## 当前归属复核与纠正

下表的执行责任来自 Issue/PR/工作树交叉核对和负责人直接回复。只读筹备、当前实现与真实验收
排期分开记录；历史 Session ID、标签、空 assignee 和 idle 都不是接管依据。
PR 观察交给后台 watcher，合入后交给单 PR cleanup；协调者继续可执行的开发与交接。

GHCR RuntimeHost 的 Manage Actions access 已直接核实为 Write，当时无需修改权限；
仓库 source 关联字段本身不证明 ACL。发布 PR 已取得最终提交的双架构 smoke，旧权限阻塞不再成立。
本轮还纠正了“Hosted 只是部分镜像”的过宽判断：按各 PR 实际分类与构建回执逐一核对目标，
不能用任务名称推断覆盖，也不能将 Hosted amd64 成功改写为本地 Compose/arm64 成功。

## 分类计数

| 类别 | 业务、开发与验收数量 |
| --- | ---: |
| Runtime/Worker/Core | 3 |
| Deploy/E2E/Channels | 7 |
| Platform/Web/Skill | 2 |
| Workflow/Observability | 4 |

## 当前分派与文件所有权

| Issue / 类别 | 采集时标签 | 当前责任 | 下一动作与证据边界 |
| --- | --- | --- | --- |
| [#3764](https://github.com/AgoraIO-Extensions/agent-infra/issues/3764) / Workflow/Observability | ready-for-agent, priority:P1, agent:codex | 协调者的 Web 测试 writer 当前交付；后台 watcher 观察 PR #3769 | 真实 Linux 原症状复现、最终 desktop/mobile 回归、独立审阅已通过；PR #3769 保持 Draft，待其 exact-head Hosted 镜像和最终门禁。两次本地完整构建的下载失败保留，成功子目标与整条命令结果分开。 |
| [#3771](https://github.com/AgoraIO-Extensions/agent-infra/issues/3771) / Workflow/Observability | priority:P1, agent:codex | ACK 发布/性能 owner 已接收，准备实现 | 只改模板预检脚本、对应回归和部署教训三文件；增加绑定 Pod/source/image 的脱敏启动收据。尚无 PR；不把诊断能力当作已降低启动耗时。 |
| [#3741](https://github.com/AgoraIO-Extensions/agent-infra/issues/3741) / Deploy/E2E/Channels | priority:P1, agent:codex | ACK 发布 owner 持有收口 | PR #3751 已合入；最终 source 字段反馈已由 #3767 / PR #3768 合入并关闭 child。采集时父票仍 OPEN，等待原 owner 回读自身剩余范围并回填，不能只凭 review job 成功关闭。 |
| [#3692](https://github.com/AgoraIO-Extensions/agent-infra/issues/3692) / Workflow/Observability | priority:P1, agent:codex | 同一 ACK 性能 owner 当前执行 | 同 source757 四模板真实模型预检通过，临时 Pod/Secret 已清理；一次 Codex 对照显示 PodReady 102→52秒，N=1，不是 SLO。#3771 补自动采集；完整新部署、资源与负载基线仍待。 |
| [#3747](https://github.com/AgoraIO-Extensions/agent-infra/issues/3747) / Runtime/Worker/Core | priority:P1, agent:codex, session-owned | Runtime 原 owner 独占 session-owned 范围 | #3756 / PR #3757 能力投影开发已完成。source96c2 候选已发布并远端核 Digest；QEMU readiness 503 与版本命令耗时只构成环境线索。原生 amd64 临时验证由原 owner 执行，环境 owner 只协调窗口，不覆盖现有 Agent 或共享允许列表。 |
| [#3295](https://github.com/AgoraIO-Extensions/agent-infra/issues/3295) / Deploy/E2E/Channels | agent:codex | 网络 owner 已接收只读方案筹备；未承诺实施窗口 | ECI Poseidon 前提可单独评估；普通 Flannel 节点完整 allow/deny/recovery 需要受支持目标。云资源实施 owner、目标与迁移窗口尚缺，不原地切 CNI。 |
| [#171](https://github.com/AgoraIO-Extensions/agent-infra/issues/171) / Deploy/E2E/Channels | wayfinder:task, wayfinder, priority:P0, agent:kiro | 网络筹备 owner 协调依赖；资源实施 owner 未落实 | 原生 blocked_by #3295；网络之外仍需存储、Registry、RBAC、DNS/TLS 与访问入口证据。筹备接收不代表环境已交付。 |
| [#144](https://github.com/AgoraIO-Extensions/agent-infra/issues/144) / Workflow/Observability | wayfinder:map, wayfinder, priority:P0, agent:codex | 协调者复核父子范围，网络 owner 承接环境筹备 | 原生子项仅 #171 OPEN；父票自身路线、环境与跨系统交接范围仍未完成，不能只按已关闭 child 数量关票。 |
| [#1548](https://github.com/AgoraIO-Extensions/agent-infra/issues/1548) / Platform/Web/Skill | ready-for-human, priority:P0, agent:kiro | Skill Hub 原 owner 已唤醒并实际准备候选 | Harness cache 修复 #3752 已完成；新 source757 API 候选及组件输入闭包已核。四模板发布/ECI 模型预检可供准备，但新 Skill 业务链、恢复/撤销/隔离/UI、外部包签名与审批仍须各自证据。 |
| [#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851) / Runtime/Worker/Core | priority:P0, agent:codex | 协调者持有 Platform 消费侧调查，原消费 owner 已明确交接 | 逐 Agent 安装配置开发 #3427 已交付；自动 Consumer 注册仍缺 Connection 机器认证、幂等/unknown 恢复与受保护秘密交付合同。两个 Agent 的已批准安装映射可独立准备，当前输入未核实；不改服务端、Provider/Grant 或凭据。 |
| [#2857](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857) / Runtime/Worker/Core | agent:codex | 原验收 owner 已接收筹备，无完整矩阵排期 | 确认同来源窗口后，验证双主体/双 Agent/三入口/多 Runtime 的隔离、并发、重启、撤权和恢复。旧端口、idle 和健康状态不表示环境写权已释放。 |
| [#2998](https://github.com/AgoraIO-Extensions/agent-infra/issues/2998) / Deploy/E2E/Channels | agent:codex | 同一验收 owner 已接收真实输入核查 | 仍需真实企业主体、官方扫码和机器人计数权限，再执行绑定/重试/撤销矩阵；输入筹备不等于客户端验收完成。 |
| [#2858](https://github.com/AgoraIO-Extensions/agent-infra/issues/2858) / Platform/Web/Skill | agent:codex | 协调者持有管理流程验收 | 已有正式登录与授权 API 读回；现有标准模板配置曾 stale/revision=null，新候选预检不刷新已部署配置。等待正式模板就绪后验证申请、驳回、重提、撤回及跨主体/UI刷新。 |
| [#3108](https://github.com/AgoraIO-Extensions/agent-infra/issues/3108) / Deploy/E2E/Channels | priority:P1, agent:codex | 协调者持有恢复验收；开发审计已完成 | Pi/OpenCode 诊断 #3734 已合入；仍需当前部署组合和原保留会话/PVC 的恢复证据，不能用新会话或旧时延代签。 |
| [#2983](https://github.com/AgoraIO-Extensions/agent-infra/issues/2983) / Deploy/E2E/Channels | ready-for-human, priority:P1, agent:kiro | 协调者持有筹备；模型目录策略待决定 | Responses/high 候选能力已测，部署 allowedModels 扩展仍未批准；保持 ADR-0026/0030 的 Codex 范围，补多轮 reasoning、刷新/隔离和企微真实证据，不用其他模板成功代签。 |
| [#3230](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230) / Deploy/E2E/Channels | ready-for-human, priority:P1, agent:kiro | 协调者持有文件验收筹备；声明输入未落实 | 已授权管理 GET 的三处404对应精确 FileLimits 声明缺失；需有效类型、字节上限、有效期和 revision 后经正式 API 写入，再跑 Web/企微双向文件和跨主体负向矩阵。 |

源码写入边界：#3764 的六个测试/测试支持文件由其 writer 独占；#3771 的模板启动收据三文件由
ACK owner 独占；本次 #3772 只写本文。#851 仅移交 Platform 消费调查，不移交 Connection
服务端、Provider、Grant 或凭据。新发现实现缺口先冻结具体 primary Issue 与文件，避免重叠。

环境写权按明确窗口交接。专用浏览器/构建环境的失败与停机回执单独保留；ACK 模板预检和
自定义候选探针使用各自临时资源，不推定取得现有业务配置、PVC 或全环境的写权。

## 当前证据与输入

- [#3741 权限实证](https://github.com/AgoraIO-Extensions/agent-infra/issues/3741#issuecomment-6516320903)与 [PR #3751](https://github.com/AgoraIO-Extensions/agent-infra/pull/3751)：最终 head `baaffa8796566017a86b1963d9e5e6bc97df5189` 的 [smoke 41016731756](https://github.com/AgoraIO-Extensions/agent-infra/actions/runs/41016731756) 成功，双架构模板、RuntimeHost/custom-base、六索引均有远端读回。source 字段反馈另由 PR #3768 交付；代码合入与 ACK fresh redeploy 分开。
- [#3692 的现场预检](https://github.com/AgoraIO-Extensions/agent-infra/issues/3692#issuecomment-6518950864)：固定 source757 的四模板真实模型预检通过，现有平台 Deployment spec 未变；新模板验证、一次冷暖对照和最终新版本部署不是同一结论，限时预检收据过期需重新执行。
- [#3764 网络采样](https://github.com/AgoraIO-Extensions/agent-infra/issues/3764#issuecomment-6517928339)与 [PR #3769](https://github.com/AgoraIO-Extensions/agent-infra/pull/3769)：真实 PG/MinIO fixture 的 veth 地址初始化晚于 HTTP-ready；最终 desktop/mobile 在地址就绪后启动独立 Chromium并通过原反馈/reload断言。PR 的 Hosted 最终构建仍未完成；本地外部下载失败保留。
- [#851 合同交接](https://github.com/AgoraIO-Extensions/agent-infra/issues/851#issuecomment-6513921407)：Connection source `15fa28bb954b16b4a1df506ebae9ea4605fcb141` 的管理员浏览器注册与固定 Consumer DCR，不等于 Platform 独立 Consumer 的机器注册合同。服务端责任线已定位，尚无新合同交付承诺；不使用管理员 Cookie 或旧测试 Consumer 绕过。
- [#3295 方案筹备](https://github.com/AgoraIO-Extensions/agent-infra/issues/3295#issuecomment-6514019169)、[#2857 接收](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857#issuecomment-6514023205)与 [#2998 输入核查](https://github.com/AgoraIO-Extensions/agent-infra/issues/2998#issuecomment-6514023230)各自只有明确记录的范围，没有因此签真实 AC。
- [#2858 管理前置](https://github.com/AgoraIO-Extensions/agent-infra/issues/2858#issuecomment-6513990960)：已有正式登录/授权读回；[此前占位镜像与幂等键使用的更正](https://github.com/AgoraIO-Extensions/agent-infra/issues/2858#issuecomment-6514370066)明确：用占位镜像且复用幂等键改变请求得到的409，不足以证明合法部署准入缺陷，不能作为产品 bug 证据。
- [#3108 恢复审计](https://github.com/AgoraIO-Extensions/agent-infra/issues/3108#issuecomment-6513762537)、[#2983 模型策略](https://github.com/AgoraIO-Extensions/agent-infra/issues/2983#issuecomment-6503038688)与 [#3230 声明回读](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230#issuecomment-6502573560)保留具体缺失输入，不把整组待验收票等同于开发已全部完成。

## 开发 PR 回读

下列开发 PR 在本轮已回读 MERGED。head 与 merge 分列；不以此签父票的真实外部验收。

| PR / 开发 Issue | 最终 head | merge SHA | 交付与验证边界 |
| --- | --- | --- | --- |
| [#3754](https://github.com/AgoraIO-Extensions/agent-infra/pull/3754) / [#3752](https://github.com/AgoraIO-Extensions/agent-infra/issues/3752) | `b251546631060cc5f1838a9f1171187300fce5b7` | `ce2a4f59c928473ff02e15c82d426b28727a774a` | Harness cache rebinding；其自身 [run40996635464 attempt2](https://github.com/AgoraIO-Extensions/agent-infra/actions/runs/40996635464/attempts/2) 的六个 amd64 镜像覆盖全部 Compose runtime 目标。本地 arm64 下载超时仍保留，AC已据精确 Hosted 证据回填。 |
| [#3757](https://github.com/AgoraIO-Extensions/agent-infra/pull/3757) / [#3756](https://github.com/AgoraIO-Extensions/agent-infra/issues/3756) | `d1e472562ae40bd07ab9920c3efc05c15919b5e2` | `cd16f38f1698c307dd3d2779cfbb8dfa97e49d43` | modelDirectory capability projection；开发票 CLOSED，父 #3747 仍保留运行时验收。 |
| [#3751](https://github.com/AgoraIO-Extensions/agent-infra/pull/3751) / [#3741](https://github.com/AgoraIO-Extensions/agent-infra/issues/3741) | `baaffa8796566017a86b1963d9e5e6bc97df5189` | `7579266349289423e6121cd66130b31964c484ae` | 发布 smoke 与 ACK receipt 消费；后续诊断字段修复见 #3768，采集时父票仍待最终回填。 |
| [#3766](https://github.com/AgoraIO-Extensions/agent-infra/pull/3766) / [#3765](https://github.com/AgoraIO-Extensions/agent-infra/issues/3765) | `f648a53ae3f08c4b45cce87695769a3d8d4dc6fb` | `ae52aa4f7a3bd8568de9c26dc35489321e1fb4b7` | completed replay 竞态测试：确定性 RED/GREEN、601 tests、本地完整五镜像、Hosted和审阅通过；Issue CLOSED、AC全勾。 |
| [#3770](https://github.com/AgoraIO-Extensions/agent-infra/pull/3770) / [#3760](https://github.com/AgoraIO-Extensions/agent-infra/issues/3760) | `19e9f68dcce837e72f872ef0b8714eaa112e14f8` | `a1263c677cba33e80773f95372fa5ff98a38a254` | 修复旧表格空行与通用规则中的快照编号；#3761 两条原生 review threads 已解决，AC和清理回读完成。 |
| [#3768](https://github.com/AgoraIO-Extensions/agent-infra/pull/3768) / [#3767](https://github.com/AgoraIO-Extensions/agent-infra/issues/3767) | `0e1f0ee45007afe57f5b2d72a43bd3f760ea3db8` | `07f7bb4d11474f09db184571c8e9d9ec4b7a5770` | 发布诊断补 source，保留 commitSha；[run41022351174](https://github.com/AgoraIO-Extensions/agent-infra/actions/runs/41022351174) 六个 amd64 镜像、完整 tree/lock/source 回执已独立核验。本地 arm64 命令下载失败不改写；开发票 CLOSED、AC全勾。 |

## 父子收口与真实验收

- #144 的开放原生子项仍为 #171，#171 原生依赖为 #3295；父票自身范围和环境交付未完成，继续 OPEN。
- #851 的 AC-5–7 安装配置开发已交付，但自动注册仍有未完成开发与外部合同；不能将整票归为“只差 AC”。
- #1548、#3747、#2857 等真实验收与已关闭开发 child 分开签收；四模板预检不能替代新 Skill、原会话恢复、外部 Provider 或跨主体矩阵。
- #3553 由其他 session 跟进，继续明确排除。`ready-for-human` 只作人工处理/验证标记，不新增 required merge gate。
- 历史闭票审计仍有未完成项；本轮开发票 AC 回填不代表全仓闭票已全部验收。没有全量当前证据时不报告“零未完成”。

历史 ACK 部署来源见 [部署总结](../../deploy/ack/ACK-REDEPLOY-LESSONS.md#本轮完整清空重建)。
当前 main、固定发布 source757、自定义候选 source96c2 和现有部署 tuple 不可互换。
