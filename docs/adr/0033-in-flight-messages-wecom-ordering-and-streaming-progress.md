# ADR-0033：执行中消息、企微入站保序与流式进度

## 状态

已采纳。本文随 [#3372](https://github.com/AgoraIO-Extensions/agent-infra/issues/3372) 的文档评审合入，决策来源见 [#3371](https://github.com/AgoraIO-Extensions/agent-infra/issues/3371) 的方案 D1–D4，以及 Owner 已确认的产品决策 Q1、Q2 和“排队在 Web 与企微都要提示”。实现归属如下：

- [#3374](https://github.com/AgoraIO-Extensions/agent-infra/issues/3374)：企微入站保序与附件合并；
- [#3375](https://github.com/AgoraIO-Extensions/agent-infra/issues/3375)：Codex 补充指令（`turn/steer`）；
- [#3376](https://github.com/AgoraIO-Extensions/agent-infra/issues/3376)：有界排队，Web 与企微的排队提示；
- [#3377](https://github.com/AgoraIO-Extensions/agent-infra/issues/3377)：企微流式进度、Web 阶段与耗时、错误分类与失败提示送达。

受理前失败的确定性收敛与 unknown 恢复预算（D5）由 [#3373](https://github.com/AgoraIO-Extensions/agent-infra/issues/3373) 另行定义，本文不涉及。

规则只在以下位置完整定义：

- 产品行为：[平台 PRD 10.3](../prd/PRD-agent-platform-M1.md#103-企微会话)、[10.5](../prd/PRD-agent-platform-M1.md#105-执行中消息与失败提示) 与 [11.2](../prd/PRD-agent-platform-M1.md#112-对话能力)；
- 排队工程语义：[工程 Spec §12.5](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#125-执行中消息的补充指令与排队)；
- 企微入站、合并、进度与送达：[§14.2.4](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1424-入站保序附件合并与流式进度)；
- 用户可见失败分类：[§16.1.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1611-用户可见失败分类)；
- 补充指令 capability 与 Codex 映射：[Runtime HLD §5](../architecture/HLD-agent-runtime-M1.md#5-platform-conversation-contract)，事务分支见 [§8.1](../architecture/HLD-agent-runtime-M1.md#81-消息与命令幂等)；
- 企微固定文案：[企微部署](../architecture/WECOM-text-deployment.md#共用执行与回复)。

## 背景

固定环境按 Web 与企微做真实验收时，平台在负载下几乎不可用（#3371）。与本文相关的用户可见问题如下：

- **执行中再发消息直接被拒“正忙”。** 所有真实 Driver 都声明 `supplementaryInstruction: false`，企微渠道也固定不支持补充指令；PRD 规定 Web 活跃回复期间只能补充指令或提示繁忙，不自动排队。固定 Codex 0.153 的 app-server 实际提供 [`turn/steer`](https://github.com/openai/codex/blob/41e22fee981a63b3698df7ed36bad393cda24715/codex-rs/app-server/README.md)。
- **企微“先发图、紧跟一句提问”时图片被丢弃。** 同一单聊的多条入站并发受理。图片要先下载、写入文件面才受理，比文字晚约 2 秒；此时文字已占住会话，图片按繁忙被拒，Agent 回答“没看到图片”，已写入的附件也留下没有 Message 归属的文件。
- **长时间只有“已收到，正在处理”。** 企微只发受理提示和最终回复两次，中间没有进度。失败提示的投递前复核遇到偶发不可用会一直重领，直到回复有效期过去变为 `expired`，用户收不到失败原因。
- **错误提示笼统。** 只有“Agent 当前不可用”“本次任务执行失败，请稍后重试”，用户无法判断该等待、重发还是换种说法。

## 决策

1. **执行中消息：补充指令优先，其次有界排队，满了才繁忙，不默认打断。**
   - 同一会话被占用时，同一发送者的新消息先作为补充指令注入当前回复；Runtime 不支持或明确拒绝时进入该会话的持久 FIFO 排队；排队已满才返回繁忙。
   - 每个会话最多排队 3 条，每条最长等待 10 分钟。会话已有排队消息时，新消息直接排在队尾，不再作为补充指令，以免越过先到的消息。
   - 补充指令只在原回复已被 Runtime 接受并处于可补充的运行状态后创建；原回复尚未开始时再发的消息直接排队，不先尝试注入再吃一次明确拒绝。
   - 补充指令在实际投递前，因原回复结束、停止待确认或转为待核实而无法投递时，也转入排队。
   - 停止只作用于当前回复，不清空排队。重新生成、原生命令和 Skill 不进入排队，继续按原规则返回繁忙。
2. **排队复用 Task API 的有界等待，不新增第二套排队权威。** 排队消息就是 `waiting` 状态的 Execution，沿用 `task_wait_order`、`task_wait_deadline` 和认领决策 `waitingDecision`，与 API 等待任务共用顺序空间和 Agent 等待容量。位次从持久等待顺序派生；入队、出队、撤回、超时和取消写入平台来源的 `task.status` 事件。RuntimeHost 与 Driver 不感知排队。
3. **补充指令按 Driver 分别通过 Conformance 后开启，先开 Codex。** Codex 映射为 `turn/steer`：`expectedTurnId` 必填并取该 Execution 已持久的原生 Turn，`clientUserMessageId` 取平台 `messageId`。app-server 以 invalid request 明确拒绝时才转入排队；超时、断连按结果不明恢复查询，不重复提交。Claude、OpenCode、Pi 通过各自 Conformance 前走排队。
4. **排队在 Web 与企微都有明确提示。** 入队、位次变化、开始处理、排队超时、撤回（仅 Web）和取消各有可验收的提示，不静默丢弃排队消息。企微用该消息自己的 stream 提示与更新；企微排队的等待期限还不晚于该消息回复有效期结束前 30 秒。
5. **企微入站按会话保序，只含附件的消息与随后 3 秒内的文字合并为一个任务。**
   - 连接持有者按会话键串行完成去重、身份映射、媒体下载与受理，后到的文字不能抢先受理。
   - 只含附件的消息新建的 Execution 在 3 秒内不可认领；窗口内同一发送者的文字作为新 Message 绑定到该 Execution，组成同一个初始 Turn，最多合并 10 个附件。窗口状态保存在 Platform DB，不依赖进程内存。
   - 合并后的回复由文字消息的 stream 承担，附件消息的 stream 以“已合并”说明结束。
   - 接收失败的附件按 ADR-0032 的固定说明单独回复，不建立 Execution，也不打开合并窗口。随后 3 秒内同一发送者的文字照常受理，并以平台说明（文件名与原因）告知 Agent 有附件未能接收，即 #3371 D2 的“降级为文字说明并告知用户”；用户消息不被改写。受理被拒的消息已写入的附件交给文件对账清理。
   - 连接持有者切换时，受理事务校验当前持有者租约与隔离令牌，旧持有者的迟到帧不产生绑定或执行。
6. **企微处理中持续流式更新同一条回复。**
   - 每个 stream 由单个发送者覆盖式发送最新全量内容，收到 ACK 后才发下一帧，最多每秒一帧，15 秒无新内容只刷新耗时。发送前校验发送租约与连接隔离令牌，帧带持久的单调序号，重启或持有者切换后旧持有者的迟到帧不被采用。
   - 内容为阶段行与已用时长、已有回答和思考过程。阶段只取自已持久化的平台事件与实际模型/工具事实。
   - 只有终态发送 `finish=true`。回复有效期结束前 30 秒仍未完成时，在当前 stream 定稿为已有回答加超时提示。
   - Web 同样显示阶段与实时耗时。
7. **用户可见的失败分类与送达。**
   - Web 与企微共用一组渠道无关的失败分类，每类绑定可操作的说明，只按已持久的受限错误码映射，未知码归内部错误并附 `traceId`。
   - 失败提示的投递前复核遇到依赖暂时不可用时，在有效期内有界退避重试；到期前 30 秒改发不含业务内容的失败说明，不能静默 `expired`。复核确认主体或修订不一致时仍取消。

## 借鉴与取舍

只读调研的版本为 Paseo `getpaseo/paseo@b8bb335c5632`、Magic `dtyq/magic@f9973c5cfe5d`，链接均为 #3371 中的永久链接。

| 主题 | Paseo | Magic | 本决策 |
| --- | --- | --- | --- |
| 执行中再发消息 | 默认注入当前 Turn，Provider 明确拒绝才退化，超时或断连按结果不明且不重复提交（[agent-manager.ts](https://github.com/getpaseo/paseo/blob/b8bb335c563279be45544b1b20a1fa5b3e56d422/packages/server/src/server/agent/agent-manager.ts#L2845-L2935)、[codex-app-server-agent.ts](https://github.com/getpaseo/paseo/blob/b8bb335c563279be45544b1b20a1fa5b3e56d422/packages/server/src/server/agent/providers/codex-app-server-agent.ts#L4433-L4476)）；可选客户端排队，可见、可撤回、空闲时 FIFO 出队（[actions.ts](https://github.com/getpaseo/paseo/blob/b8bb335c563279be45544b1b20a1fa5b3e56d422/packages/app/src/composer/actions.ts#L246-L338)） | IM 默认打断并重启（[agent_dispatcher.py](https://github.com/dtyq/magic/blob/f9973c5cfe5d668867b1a8dc5c50e4be5081ee56/backend/super-magic/app/service/agent_dispatcher.py#L556-L583)）；Web 有每话题持久队列，靠话题锁、active 守卫和幂等出队（[MessageQueueProcessAppService.php](https://github.com/dtyq/magic/blob/f9973c5cfe5d668867b1a8dc5c50e4be5081ee56/backend/super-magic-module/src/Application/SuperAgent/Service/MessageQueueProcessAppService.php#L151-L222)） | 采用 Paseo 的补充指令优先与“明确拒绝才退化、结果不明不重投”；排队采用 Magic Web 的服务端持久队列形态，并落在现有 Task 等待结构上；保留 Paseo 的可见与可撤回（Web） |
| 附件与文字 | 附件与文字是同一条消息，上传未完成时禁止发送（[prompt-attachments.ts](https://github.com/getpaseo/paseo/blob/b8bb335c563279be45544b1b20a1fa5b3e56d422/packages/server/src/server/agent/prompt-attachments.ts#L7-L38)）；Agent 间消息按接收方 2 秒防抖合并（[delivery.ts](https://github.com/getpaseo/paseo/blob/b8bb335c563279be45544b1b20a1fa5b3e56d422/packages/server/src/server/agent/agent-messages/delivery.ts#L143-L162)） | 媒体在 dispatch 前有界下载，失败降级为占位文本（[wechat/media.py](https://github.com/dtyq/magic/blob/f9973c5cfe5d668867b1a8dc5c50e4be5081ee56/backend/super-magic/app/channel/wechat/media.py#L155-L236)）；企微没有合并，先图后文会互相打断 | 企微入站按会话保序，借鉴 Paseo 的短防抖窗口，取 3 秒且只对只含附件的消息开窗 |
| 进度反馈 | 流式合并窗口 60ms，首事件与工具终态立即发出，运行中实时显示耗时（[agent-stream-coalescer.ts](https://github.com/getpaseo/paseo/blob/b8bb335c563279be45544b1b20a1fa5b3e56d422/packages/server/src/server/agent/agent-stream-coalescer.ts#L105-L137)） | 企微 `reply_stream` 覆盖式更新：单个发送协程每次发最新全量文本，靠 ACK 往返节流，`finish=true` 只在整个 run 结束时发（[streaming_driver.py](https://github.com/dtyq/magic/blob/f9973c5cfe5d668867b1a8dc5c50e4be5081ee56/backend/super-magic/app/channel/wecom/streaming_driver.py#L15-L149)） | 企微采用 Magic 的流式驱动，补上阶段行与耗时，并加每秒一帧的下限间隔；Web 借鉴 Paseo 显示阶段与实时耗时 |
| 错误与送达 | 回执区分 `pending`、`completed`、`outcome_unknown`，带指纹冲突检测（[message-receipts/index.ts](https://github.com/getpaseo/paseo/blob/b8bb335c563279be45544b1b20a1fa5b3e56d422/packages/server/src/server/message-receipts/index.ts#L21-L56)） | 终态码绑定状态与文案，按超时、限流、连接、配置、加载失败分类（[final_task_state.py](https://github.com/dtyq/magic/blob/f9973c5cfe5d668867b1a8dc5c50e4be5081ee56/backend/super-magic/app/core/entity/final_task_state.py#L13-L134)、[agent.py](https://github.com/dtyq/magic/blob/f9973c5cfe5d668867b1a8dc5c50e4be5081ee56/backend/super-magic/app/magic/agent.py#L773-L843)） | 借鉴 Magic 的分类与文案绑定，按平台已持久的受限错误码映射；送达沿用现有回执状态机，结果不明不重发 |

## 不采用

- **Magic 的 IM 默认打断并重启当前任务。** 企业任务常有外部副作用，打断后重做可能重复执行写操作；用户需要放弃时仍使用停止。
- **Magic 把 IM 长连接放在沙箱内。** 违反渠道凭证只在 Platform Worker 的边界，Agent 与 Runtime 不能获得渠道凭证。
- **Paseo 的纯客户端排队。** 企微没有平台客户端，浏览器刷新或多端也会丢失队列；排队必须是服务端持久状态。
- **为排队新建独立的消息队列表或 Driver 侧队列。** 会与 Execution 的等待状态形成第二套排队权威，违反 Runtime HLD §7.2。
- **合并窗口内把接收失败的附件当作空附件并入任务，或只凭失败说明单独调用 Agent。** 前者让 Agent 误以为附件已到达，后者产生没有用户意图的任务。ADR-0032 的单独失败回复保留，失败信息只随用户随后的文字交给 Agent。
- **回复超时后以主动消息补发最终答案。** 需要先核实企微长连接主动发送的能力与限额；核实前只在当前 stream 定稿，不承诺补发。
- **企微撤回排队消息。** M1 只在 Web 提供撤回入口；企微的排队消息只会开始处理、超时或被取消。
- **沙箱自行保活与 Sandbox 预热池。** 前者绕开平台的回收与授权边界；后者按 Owner 决策 Q3 不进入 M1（参照 Magic 的 [WarmPoolSandboxDomainService.php](https://github.com/dtyq/magic/blob/f9973c5cfe5d668867b1a8dc5c50e4be5081ee56/backend/super-magic-module/src/Domain/SuperAgent/Service/WarmPoolSandboxDomainService.php#L275-L375)）。

## 影响

- PRD 新增 10.5，10.3、10.4、11.2 及上线验收表随之调整：Web 不再只能“补充指令或繁忙”，企微不再只有“已收到”和最终答案两条回复。新消息不再出现“投递失败：原回复未开始”与“投递失败：原回复已结束”，对应情形改为排队。
- 工程 Spec 新增 §12.5、§14.2.4 与 §16.1.1；Runtime HLD 的补充指令 capability、§7.2 并发与 §8.1 事务分支改为引用 §12.5。
- 数据模型不新增表。Web/渠道消息开始使用 `waiting` 状态的 Execution；补充指令转入排队时，Message 改为绑定新建的等待 Execution；Web/渠道 Execution 也写入 `task.status` 事件，撤回需要新的受限原因。这些契约变化由 #3376 在 Contract 中固定。
- 企微排队的实际最长等待约 8.5 分钟，短于产品上限 10 分钟，因为必须在回复有效期内结束 stream。
- 只含附件的企微消息即使没有后续文字，也会多等 3 秒才开始执行。
- `docs/development/web-ui.md` 中处理中输入框“发送补充指令”“不支持补充指令”的说明，由 #3376 实现时同步改为排队语义。

## 备选方案

- **维持繁忙即拒绝。** 否决：执行中再发消息全部失败，Web 与企微都无法正常连续对话。
- **默认打断当前回复。** 否决，理由同“不采用”第一项。
- **不设上限的排队。** 否决：一条长任务后堆积的消息会长时间占住会话和 Agent 等待容量，用户也无法判断何时处理；3 条与 10 分钟是 Owner 确认的上限。
- **按语义判断附件与文字是否相关后再合并。** 否决：需要模型参与入站判定，结果不可预测；固定 3 秒窗口可解释、可测试。
- **每个进度变化都立即发送。** 否决：会触发企微频率限制并挤占终态回复的额度；ACK 往返加每秒一帧已能满足进度可见。
