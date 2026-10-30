# Issue 工作指导

> 适用范围：`AgoraIO-Extensions/agent-infra` 当前开放 Issue。本文把实时清单转成可执行的分派规则；具体产品结论仍以 PRD、工程 Spec、HLD 和 Issue 正文为准。
> 最新时间、基线、标签、逐票责任与 PR head/merge 证据统一见 [状态跟进](issue-status-tracking.md)。

## 四类工作边界

| 类别 | 处理范围 | 进入实现前必须确认 |
| --- | --- | --- |
| Runtime/Worker/Core | Runtime Host、Worker、Core、原生命令、模型、Sandbox 和执行状态 | Runtime Contract 版本、授权/隔离、unknown/recovery 边界、负向测试和真实调用证据 |
| Deploy/E2E/Channels | Helm、ACK、local harness、E2E、企微、文件面和发布装配 | 当前镜像/配置来源、环境 owner、部署与登录门禁、真实资源回读；fixture 不能代替真实验收 |
| Platform/Web/Skill | Platform API、Web、Skill、目录和用户流程 | 服务端身份与授权、API/OpenAPI 契约、消费者边界、浏览器/可访问性证据 |
| Workflow/Observability | 开发流程、wayfinder、性能、观测、测试稳定性和状态治理 | 明确是实现、调查还是人工门禁；记录可复现窗口、指标和阻塞 owner |

## 通用执行顺序

1. 从 [issue-status-tracking.md](issue-status-tracking.md) 找到目标 Issue，重新读取完整正文、评论、依赖、关联 PR 和当前 `origin/main`；表格快照不授权实现。
2. 只接收正文具备 `Problem`、`Scope`、稳定 `AC-N`、`Validation` 和 `Blocked by` 的 Issue。缺失任一项时补充只读交接，不自行发明验收条件。
3. 刷新 `origin/main`，建立独立 worktree 和分支；冻结本 lane 的 Issue、文件和部署资源所有权。不得覆盖其他 lane 的脏工作树或分支。
4. 实现最小直接改动，优先补边界和负向测试；把受控 fixture、focused test、Hosted CI、真实部署/浏览器/外部账号证据分开记录。
5. 提交 Conventional Commit，创建 PR 时带 Issue 链接、变更边界、验证命令、剩余 blocker 和回滚风险；PR 创建后交给 CI watcher，合并确认后交给 merged-PR cleanup。
6. 完整开发工作完成即可关闭 development Issue；创建 PR 或部分 slice 不足以证明完整开发范围完成。真实验收 AC 保留原状态，在关闭说明中链接继续持有验收的 owner 与后续票；不得把开发关闭写成验收通过。父 Issue 只有在全部开发子项完成且无自身独立开发缺口时关闭。

## 并行分派入口

当前 lane、primary Issue/PR、文件 owner 和下一交付点集中维护在
[状态跟进的分派表](issue-status-tracking.md#当前分派与文件所有权)。该表带采集窗口；认领前回读
GitHub、当前 branch/worktree 和最新 main，再完成两次交叉确认：

1. 从 Issue 完整范围、原生依赖、关联 PR 当前 head/文件和工作树修改确认已有任务边界。
2. 从活动 session 的实际工作与负责人直接回复确认当前 writer；核对其分支/文件范围，不仅依据正文 Session ID、标签、空 assignee 或 idle 状态。

带 `session-owned` 的票由原 session 持有，即使同时有 `ready-for-agent` 也排除在其他 session 的
分派范围。确需接手时先满足该票的归属转移限制并取得明确交接，记录旧/新 writer、精确文件/资源、完成项和下一步，再由
新 writer 回读并确认接收；未确认时只做不依赖其写权的只读调查。接管影响原 owner 继续工作时，
主动通知对方已接收的范围、完成状态及资源释放，避免两边等待或重复写入。

归属记录区分“当前执行”“负责人明确排期”“待确认”“已明确释放/未认领”。历史创建者、
旧验收回执、验收标签和外部依赖都不能替代当前 owner 的确认；没有回复既不证明仍持有，也不
证明已释放。外部条件与 owner 分列：未确认执行者的项目继续核对可执行入口和输入，寻找不依赖
缺失条件的下一步，不把整组待验收票自动排除。取得有限调查/状态交接时，写实现或操作环境仍须
另核该范围与当前占用。每个待办都须留下下一动作、缺失输入及可定位证据；
只有 owner 明确接受了具体执行范围和窗口，才记录为已排期。
已确认停止且没有排期的原 owner，应在原授权范围内主动唤醒并明确下一交付；消息已发送不等于
已接收。原 owner 未实际接收时，按明确交接重新分派并通知对方，避免双方互等。
父 Issue 拆分出独立开发子项时，子项必须有自己的 primary Issue、来源标签和 PR 关闭引用；子项合入只关闭子项，父票的真实验收和剩余范围继续跟踪。 已合入的 #3754/#3757 仍不能代替 #1548/#3747 的真实验收。

每条 lane 独占已声明文件。缺失内部接口若已在 Issue Scope 中授权，属于待实现内容；只有实际
产品/架构冲突或外部输入缺失才记录 blocker，不将缺失代码本身当作外部审批门禁。

## 分派与状态更新规则

- `ready-for-agent` 只表示可以开始契约复核，不代表依赖已满足。
- `needs-triage` 先由协调者补齐问题、范围、验证和 blocker；不得直接认领。
- `ready-for-human` 按 [Triage Labels](triage-labels.md) 仅作人工处理/验证标记；真实部署、浏览器、外部账号与人工决策按各票签收要求取证，代码测试不代替。
- 同一文件、同一部署单元或同一 Issue 只能有一个写 owner；依赖关系写回 Issue 或 PR，不在状态表里推测。
- 每次状态更新必须带采集窗口、证据链接、准确的 head/merge/PR 状态和未完成 AC；业务待办与本次治理票分别计数。已结束的 lane 移入交付记录，当前分派表只保留实际责任。

## 权威来源

- [Agent 平台 M1 PRD](../prd/PRD-agent-platform-M1.md)
- [Connection M1 PRD](../prd/PRD-connection-M1.md)
- [M1 工程架构 Spec](../architecture/SPEC-agent-infra-M1-engineering-architecture.md)
- [AI 主导开发工作流 Spec](../architecture/SPEC-ai-native-development-workflow.md)
- [Issue Tracker](issue-tracker.md)
- [Triage Labels](triage-labels.md)

## 开发交付与来源

开发 PR 的准确状态、日期、head SHA、merge SHA、Issue AC 链接统一见
[开发 PR 回读](issue-status-tracking.md#开发-pr-回读)，不在此重复维护历史 SHA。
发现代码遗漏或回归继续修复并恢复跟踪，不把真实验收延期当成代码缺口已完成。
验收前回读 PRD/Spec 及适用 ADR 的当前范围，核对真实输入和部署来源；错误模板、旧协议或
缺声明导致的失败先定位并保留，不扩大需求或绕过准入来取得通过。

标签遵循 [Issue Tracker](issue-tracker.md#agent-provenance) 与
[Triage Labels](triage-labels.md)。新建 Issue/PR 显式传入唯一 `agent:*` 来源标签，
正文 `Agent` 与标签一致并保留 `Agent-Session-ID`；处理其他 Agent 创建的 Issue 保留原来源。
优先级按实际开发顺序设置，标签不替代依赖和权限判断。
