# 开放 Issue 状态跟进

> 采集窗口（as-of）：2026-10-28 06:03:40–06:03:44 UTC。
> 来源基线：本次 fetch 回读的 `origin/main` exact SHA `8ca6866d329f5e3e86232e98e85faa730bd1d564`。
> 下表只表示该窗口内的 GitHub 状态；实时状态以链接回读为准，开发合入与真实 AC 分开跟进。

本次更新反映新开发缺口、合入和父子关系变化。保留 as-of 语义：后续 main 推进、Issue 关闭或
本文 PR 合入，不自动触发新的 tracker Issue/PR。本次文档 PR 在采集后创建，不计入下表。

采集时开放 Issue：**24**；开放实现 PR：**5**。未完成 AC 保留在原 Issue。

## 分类计数

| 类别 | 数量 |
| --- | ---: |
| Runtime/Worker/Core | 8 |
| Deploy/E2E/Channels | 7 |
| Platform/Web/Skill | 7 |
| Workflow/Observability | 2 |

## 明细

| 类别 | Issue | 标题 | 优先级 | 采集时标签 | 最近更新（UTC） | 下一步 |
| --- | --- | --- | --- | --- | --- | --- |
| Runtime/Worker/Core | [#3619](https://github.com/AgoraIO-Extensions/agent-infra/issues/3619) | fix(core): decouple V6 admission from Runtime wire contracts | priority:P1 | priority:P1, agent:codex | 2026-10-28 05:47:31 | PR #3620：Core V6 去除 wire 依赖；focused/PG/架构检查通过，等待 Hosted CI 和合入 |
| Runtime/Worker/Core | [#3295](https://github.com/AgoraIO-Extensions/agent-infra/issues/3295) | blocker(ack): Flannel 环境未通过 Worker NetworkPolicy 负向验证 | 未标注 | agent:codex | 2026-10-27 23:50:07 | 环境门禁：准备支持策略执行的 ACK 环境，补普通节点与 ECI 的 allow/deny/recovery；不原地更换共享集群 CNI |
| Runtime/Worker/Core | [#3218](https://github.com/AgoraIO-Extensions/agent-infra/issues/3218) | feat(runtime): Claude、Pi、OpenCode 原生进程补 Landlock 边界后开放 shell（#3202 第 2 步） | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 14:08:13 | 真实开发缺口：三模板 Landlock、子进程凭证清理和原生 shell；父票 #3202，needs-triage 准入保持 |
| Runtime/Worker/Core | [#3203](https://github.com/AgoraIO-Extensions/agent-infra/issues/3203) | feat(worker): Session Sandbox 支持部署批准的通用出网（#3198） | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 14:08:08 | 真实开发缺口：部署批准的通用出网、固定拒绝项与 CNI 负例；父票 #3198，先固定出网契约 |
| Runtime/Worker/Core | [#3202](https://github.com/AgoraIO-Extensions/agent-infra/issues/3202) | feat(runtime): Claude、OpenCode、Pi 标准模板开放原生工具（#3198） | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 14:08:03 | 第 1 步已合入，原生 child #3218 尚未交付；保留三模板 shell 与凭证隔离开发范围 |
| Runtime/Worker/Core | [#3198](https://github.com/AgoraIO-Extensions/agent-infra/issues/3198) | feat(runtime): 恢复标准模板 Agent 的原生能力，以 Session Sandbox 为隔离边界 | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-27 23:24:01 | 原生 children #3202/#3203 尚未完成；继续跟进原生能力与通用出网，父票暂不能关闭 |
| Runtime/Worker/Core | [#2857](https://github.com/AgoraIO-Extensions/agent-infra/issues/2857) | test: accept Session Sandbox multi-entry isolation from #1253 | 未标注 | agent:codex | 2026-10-26 14:04:28 | 固定 Harness/镜像/配置与双主体，验收三入口、多 Runtime、重启撤权及跨 Session/Agent 隔离 |
| Runtime/Worker/Core | [#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851) | feat(runtime): deliver standard MCP Agent token client | priority:P0 | priority:P0, agent:codex | 2026-10-26 14:31:39 | 仍有开发缺口：等待 Connection 获准机器注册/独立 Consumer 与 token 供应契约；不以 DCR 或管理员 Cookie 替代 |
| Deploy/E2E/Channels | [#3616](https://github.com/AgoraIO-Extensions/agent-infra/issues/3616) | fix(ack): publish fresh runtime inputs before provisioning | priority:P1 | priority:P1, agent:codex | 2026-10-28 05:05:48 | 原 ACK 实现方已创建 PR #3621；前置 #3610 已合入，等待精确 head 的发布输入/回读/rollout 回归与 CI |
| Deploy/E2E/Channels | [#3230](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230) | test(e2e): 固定环境 Web 与企微双向文件和图片验收（#3221） | priority:P1 | needs-triage, priority:P1, agent:kiro | 2026-10-26 14:10:36 | 固定环境补 Web 双向文件、企微 PDF/语音、跨主体负例及哈希回读；已有局部图片证据不覆盖全部 AC |
| Deploy/E2E/Channels | [#3108](https://github.com/AgoraIO-Extensions/agent-infra/issues/3108) | acceptance: ACK resumed conversations receive Messages gateway errors | priority:P1 | priority:P1, agent:codex | 2026-10-28 03:20:51 | Claude/Pi/OpenCode 新会话各两轮已有记录；历史失败会话恢复、完整浏览器 TTFT 与根因验收仍未完成 |
| Deploy/E2E/Channels | [#2998](https://github.com/AgoraIO-Extensions/agent-infra/issues/2998) | test(e2e): real WeCom credential and official QR binding acceptance | 未标注 | agent:codex | 2026-10-26 14:06:20 | 等待获准企微真实账号与人工扫码，验证无效凭证、一次确认、机器人计数和绑定回读 |
| Deploy/E2E/Channels | [#2983](https://github.com/AgoraIO-Extensions/agent-infra/issues/2983) | test(e2e): 固定环境验收 DeepSeek 与思考过程（Web 与企微） | priority:P1 | ready-for-agent, priority:P1, agent:kiro | 2026-10-26 14:06:09 | 固定环境复验 DeepSeek 首条消息、思考/答案投递、群聊和 B 账号隔离；ready-for-agent 不替代真实验收 |
| Deploy/E2E/Channels | [#1548](https://github.com/AgoraIO-Extensions/agent-infra/issues/1548) | test(skill-hub): accept the deployed lifecycle and Web conversation chain | priority:P0 | ready-for-human, priority:P0, agent:kiro | 2026-10-28 03:01:44 | 原 Skill 验收方继续真实生命周期/模型工具证据；#3605 修复已合入，#3609 scanner 增量等待交付 |
| Deploy/E2E/Channels | [#171](https://github.com/AgoraIO-Extensions/agent-infra/issues/171) | 准备 P0 首发真实环境 ACK tenancy 与访问入口资源 | priority:P0 | wayfinder:task, wayfinder, priority:P0, agent:kiro | 2026-10-26 14:31:12 | ACK 环境验收：策略执行、PVC/StorageClass、Registry pull、RBAC 与 DNS/TLS；历史资源清单不作当前签收 |
| Platform/Web/Skill | [#3617](https://github.com/AgoraIO-Extensions/agent-infra/issues/3617) | fix(storage): classify persisted invalid S3 content as conflict | priority:P1 | priority:P1, agent:codex | 2026-10-28 05:10:46 | PR #3618：S3 内容冲突修复；101 项对象存储测试通过，Draft 等待完整门禁；本地 Docker 上游下载超时 |
| Platform/Web/Skill | [#3611](https://github.com/AgoraIO-Extensions/agent-infra/issues/3611) | feat(platform): complete application credential metadata and revocation | priority:P1 | priority:P1, agent:codex | 2026-10-28 03:29:23 | PR #3612：应用凭证列表/撤销闭环；已补齐兼容性与 Core 导出清单，等待新 head CI；合入后复核父票 #481 |
| Platform/Web/Skill | [#3609](https://github.com/AgoraIO-Extensions/agent-infra/issues/3609) | fix(skill): integrate the native SkillSpector CLI report | priority:P0 | priority:P0, agent:codex | 2026-10-28 05:32:21 | PR #3613：原生 scanner 与必需 analyzer 校验已推送；Backend 被既有 S3 内容分类错误阻塞，跟进 #3617 |
| Platform/Web/Skill | [#3139](https://github.com/AgoraIO-Extensions/agent-infra/issues/3139) | fix(model): Catalog 端点追加模型或档位后，已有 Agent 的模型投影全部失效 | 未标注 | needs-triage, agent:kiro | 2026-10-28 02:45:06 | V1/V4 全量 endpoint 快照比较仍有兼容追加缺口；待明确字段级兼容决策、完整 Scope/Validation 与负责人 |
| Platform/Web/Skill | [#2858](https://github.com/AgoraIO-Extensions/agent-infra/issues/2858) | test: accept Platform management Web flow from #535 | 未标注 | agent:codex | 2026-10-26 14:04:34 | 真实管理 Web/API/PG 闭环验收，覆盖 Auth Gateway 缺失时的申请拒绝和 Owner 重试回执 |
| Platform/Web/Skill | [#485](https://github.com/AgoraIO-Extensions/agent-infra/issues/485) | feat(platform): deliver authorized evaluation and quality analysis | priority:P2 | needs-triage, priority:P2, agent:codex | 2026-10-26 14:31:27 | 待确认 Eval 的 M1 执行窗口、权威文档和原生依赖准入；维持 needs-triage |
| Platform/Web/Skill | [#481](https://github.com/AgoraIO-Extensions/agent-infra/issues/481) | feat(platform): deliver user and application Agent management API | priority:P0 | needs-triage, priority:P0, agent:kiro | 2026-10-28 03:30:13 | 原生开发 child 仅 #3611 尚 open；PR #3612 合入后核对父票自身范围，真实 AC 保留原状态 |
| Workflow/Observability | [#690](https://github.com/AgoraIO-Extensions/agent-infra/issues/690) | feat(workflow): add bounded AI coding coordination harness | priority:P2 | enhancement, priority:P2, agent:kiro | 2026-10-26 14:31:31 | P2 协调 Harness 尚待执行窗口；按原 AC-1–AC-12 交付；已合入的只读 Goal Skill #702 不代替本票 |
| Workflow/Observability | [#144](https://github.com/AgoraIO-Extensions/agent-infra/issues/144) | wayfinder: 形成 Agent 平台 M1 启动与落地路线 | priority:P0 | wayfinder:map, wayfinder, priority:P0, agent:codex | 2026-10-27 23:27:34 | 原生 open children 为 #171/#481/#485；按开发与环境/决策门禁分别推进，子项未完成不关闭父票 |

## 当前分派与文件所有权

| Lane | Primary / PR | 文件范围与下一交付点 |
| --- | --- | --- |
| ACK 输入发布 | [#3616](https://github.com/AgoraIO-Extensions/agent-infra/issues/3616) / [#3621](https://github.com/AgoraIO-Extensions/agent-infra/pull/3621) | 原 ACK 实现方负责 `deploy/ack` 发布阶段及专属测试；复用已合入容量门禁，等待 CI 与受控环境回读 |
| Platform 凭证治理 | [#3611](https://github.com/AgoraIO-Extensions/agent-infra/issues/3611) / [#3612](https://github.com/AgoraIO-Extensions/agent-infra/pull/3612) | Contracts、Core/Store、API、Web 凭证列表/撤销；精确 head CI 通过后关闭开发 child 并复核 #481 |
| Skill 原生扫描 | [#3609](https://github.com/AgoraIO-Extensions/agent-infra/issues/3609) / [#3613](https://github.com/AgoraIO-Extensions/agent-infra/pull/3613) | 原 Skill 集成方负责 `skill-package-skillspector` 与部署说明；S3 基线错误由独立 lane 修复 |
| 对象存储错误分类 | [#3617](https://github.com/AgoraIO-Extensions/agent-infra/issues/3617) / [#3618](https://github.com/AgoraIO-Extensions/agent-infra/pull/3618) | 仅 `packages/object-storage/src/s3.ts` 与 S3 测试；内容冲突与传输失败分开，补齐 CI 后交付 |
| Core 协议边界 | [#3619](https://github.com/AgoraIO-Extensions/agent-infra/issues/3619) / [#3620](https://github.com/AgoraIO-Extensions/agent-infra/pull/3620) | Core V6 admission、Core 单测及 Store integration/replay harness；不改 wire Schema、生产事务或 policy |
| 协调与状态 | 本文 / 工作指导 | 每个 PR 独立 watcher；合入后委派专属 cleanup，刷新 main，并按完整开发范围关闭子票/父票 |

## 开发 PR 回读

以下状态对应同一采集窗口。取消的重复 CI run 不视为新 head 的失败；Draft 与失败门禁均显式保留。

| PR | 状态 | head SHA | 未完成门禁与下一步 |
| --- | --- | --- | --- |
| [#3621](https://github.com/AgoraIO-Extensions/agent-infra/pull/3621) | OPEN / BLOCKED | `58687faa202eba518b48eddbc0be67fa278cda86` | Issue Gate、Web 和 review 已通过；Backend、Heavy、Workload 运行中；发布输入/真实部署 AC 不由 CI 代签 |
| [#3620](https://github.com/AgoraIO-Extensions/agent-infra/pull/3620) | OPEN / BLOCKED | `6b5935e2efc3597bc609ceea64fa0826fb7fb571` | Issue Gate、review、Heavy 已通过；Backend 与 Workload 运行中；本地 Core 45、Store/PG 53、架构 9 项通过 |
| [#3618](https://github.com/AgoraIO-Extensions/agent-infra/pull/3618) | DRAFT / BLOCKED | `b4cdc8c3c639744f4a8a6c803bb3cad118bb478f` | Web、Backend、Workload 已通过，Heavy 运行中；本地 Docker 下载超时；meta 的 Core 边界失败由 #3620 修复 |
| [#3613](https://github.com/AgoraIO-Extensions/agent-infra/pull/3613) | OPEN / BLOCKED | `82bf7f065e12635831701bd384475dc524ae0577` | Backend/CI 失败定位为既有 S3 内容分类错误；scanner 测试通过；等待 #3618 修复交付后重新基于 main 验证 |
| [#3612](https://github.com/AgoraIO-Extensions/agent-infra/pull/3612) | OPEN / BLOCKED | `2f0400b1015fe6a9f4659baa1277143ee4c8743f` | 新 head 已修复兼容性与 package-surface 清单；Web 已通过，Backend/Heavy/Workload 运行中；本地 contracts 715、Core 1984 项通过 |

## 本轮已合入开发交付

| Primary | PR | merge SHA | 关闭范围 |
| --- | --- | --- | --- |
| [#3608](https://github.com/AgoraIO-Extensions/agent-infra/issues/3608) | [#3610](https://github.com/AgoraIO-Extensions/agent-infra/pull/3610) | `8ca6866d329f5e3e86232e98e85faa730bd1d564` | 容量门禁与 custom ACP driver 开发；部署/真实对话 AC 保留 |
| [#702](https://github.com/AgoraIO-Extensions/agent-infra/issues/702) | [#3615](https://github.com/AgoraIO-Extensions/agent-infra/pull/3615) | `008a8a2a598a3fc020b6ef5d8c799bc1633e128f` | 只读 Roadmap Goal Skill；不代替 #690 协调 Harness |
| [#3277](https://github.com/AgoraIO-Extensions/agent-infra/issues/3277) | [#3614](https://github.com/AgoraIO-Extensions/agent-infra/pull/3614) | `4374ec4a6d586946a73ed30c50dffd416c7147ab` | 文件面启用前旧 Runtime 清单与迁移/停止顺序；真实启用验收保留 |
| [#3605](https://github.com/AgoraIO-Extensions/agent-infra/issues/3605) | [#3607](https://github.com/AgoraIO-Extensions/agent-infra/pull/3607) | `1573cf043e8606b25ac7bfb4d07c82f5e9332f69` | Skill mount reconciliation 修复；真实 Skill 生命周期由 #1548 跟进 |
| [#3603](https://github.com/AgoraIO-Extensions/agent-infra/issues/3603) | [#3604](https://github.com/AgoraIO-Extensions/agent-infra/pull/3604) | `77b6c9704d217e8ccce9c3b8390ea8133ffe4012` | 标准 Codex Workload container boundary 注入；实际隔离/模型回合单独验收 |

## 父子收口与真实验收

- GitHub 原生层级已回读：#3198 → #3202/#3203；#3202 → #3218。三个开发 child 仍 open，父票不能仅凭先前局部 PR 合入关闭。
- #481 的历史开发 children 已关闭，仅 #3611 尚 open；#144 的原生 open children 为 #171/#481/#485。子项完成后还须检查父票自身开发范围。
- #3108 已记录 Claude/Pi/OpenCode 新会话各两轮完成；历史失败会话恢复、完整浏览器 TTFT 和根因验收仍未完成。原 AC 不因新会话成功而自动勾选。
- #3295 是真实网络隔离环境门禁；#851 仍缺获准独立 Consumer 注册/供应接线，属于开发依赖，不能归为纯 AC。
- 本轮不接管其他 session 的 #3553；真实 AC、凭证和部署写入以各 Issue 的授权及 owner 为准。
