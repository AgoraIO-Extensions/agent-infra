# ADR-0034：提交前失败显式声明未提交，unknown 恢复改用墙钟预算

## 状态

已采纳。随 [#3373](https://github.com/AgoraIO-Extensions/agent-infra/issues/3373) 合入，属于 [#3371](https://github.com/AgoraIO-Extensions/agent-infra/issues/3371) 的 D5。

## 背景

固定环境（[#3230](https://github.com/AgoraIO-Extensions/agent-infra/issues/3230)）观察到以下链路：

1. Driver 在原生提交点之前失败，例如文件交换不可达、附件物化失败、提交前 Grant 过期。此时 Codex `turn/start`、ACP `session/prompt` 都还没有发出。
2. Driver 抛出普通错误，RuntimeHost 把它映射为可重试的 `RUNTIME_DRIVER_INVALID`。Worker 无法区分“未执行”和“结果不明”，于是记为 `unknown`。
3. Codex Driver 留下已准备的提交操作。之后的查询只能得到 `unknown`，同一原生会话的下一个 Turn 被判为 `RUNTIME_SESSION_BLOCKED`（[ADR-0029](0029-reject-turns-on-acceptance-unknown-native-session.md)）。
4. Worker 按认领次数恢复（120 次），约 30 分钟内占住 Agent 唯一的执行槽位。
5. Owner 重启 Agent 后，Session Sandbox 尚未就绪，只查询状态的恢复认领被就绪闸门挡住，不再推进。

[Runtime HLD §5](../architecture/HLD-agent-runtime-M1.md#5-platform-conversation-contract) 禁止无证据回填 rejected；[#3314](https://github.com/AgoraIO-Extensions/agent-infra/issues/3314) 只覆盖了平台明确拒绝附件这一种情况。

## 决策

1. **Driver 显式声明未提交。** 失败发生在原生提交点之前，本操作没有 Driver 持久记录（或已在声明前删除），也没有原生 Turn 副作用时，Driver 声明 `not_submitted`。声明带有阶段：`file_input_unavailable`（附件读取）或 `session_preparation_failed`（其他提交准备）。四个 Driver（Codex、ACP、Claude、Pi）都在各自的提交点之前声明；提交点之后的不确定仍是 `unknown`。
2. **Host 持久化可重试结果。** Host 只读核实 Driver 没有该操作记录后，持久化 `RUNTIME_TURN_NOT_SUBMITTED`（rejected、`retryable: true`、带阶段）。只有 submit V2 及以上包含该成员。相同 fence 的重放返回原结果；更高 fence 的同一操作重新进入已准备状态并再次执行，仍经过全部 Grant、fence 和记录核实。V3 状态核实把它报告为 `not_found`，Worker 据此退回投递前状态，不进入 `unknown` 恢复。
3. **Worker 有界重提。** Worker 把 Execution 退回投递前状态，之后的认领签发新的 Grant 重新投递同一 Execution。2 分钟内最多重提 3 次，之后按阶段以 `RUNTIME_FILE_INPUT_UNAVAILABLE` 或 `RUNTIME_SESSION_PREPARATION_FAILED` 失败，并在同一事务内收敛补充指令与 stop。
4. **unknown 恢复改用墙钟预算。** Execution 进入 `unknown` 时开始计时，离开时清除；默认 5 分钟，可由部署配置。用尽时以 `RUNTIME_RECOVERY_TIMEOUT` 失败，替代按认领次数计的上限。原生 Skill 等元数据恢复仍按认领次数。
5. **只查询状态的恢复不受 Sandbox 就绪约束。** `unknown` 或 `processing` 的 Execution 的恢复认领只沿原操作查询，不产生新副作用，因此不再以 Sandbox 就绪为前置；Owner 重启后恢复继续推进。首次投递和重提仍须 Sandbox 就绪。
6. **新消息唤醒恢复。** 新消息到达且 Conversation 被 `unknown` 占用时，平台立即唤醒该 Execution 的恢复工作项，先按 Host 的真实状态核实一次；不释放占用，也不改变受理结果。

## 影响

- 提交前故障在 2 分钟内自动重提成功或明确失败，不再占用执行槽位约 30 分钟，也不会把原生会话留在阻塞状态。
- 原生提交之后的不确定最长 5 分钟收敛为待核实结束后的失败。
- Runtime 操作结果 V2 新增一个可重试的 rejected 成员，需要重新生成 JSON Schema / OpenAPI 并通过兼容门禁；Worker 同步接受该结果。旧 Worker 无法解析时按原有的可重试失败处理，并经 V3 状态核实的 `not_found` 退回投递前状态。
- Platform DB 为 Execution 增加“进入 unknown 的时间”列（单向迁移），由触发器随状态迁移维护。

## 备选方案

- **Host 不持久化，保持已准备状态：** 否决。状态核实无法区分“Driver 仍在执行”和“已确认未提交”，只能报告 unknown。
- **Worker 把 `RUNTIME_DRIVER_INVALID` 当作未发送：** 否决。该错误也会出现在原生提交之后，违反“不确定时不重发”。
- **继续按认领次数计预算：** 否决。认领时长随故障类型变化，次数无法给出可预期的收敛时间。
- **从会话时间线事件推导 unknown 起始时间：** 否决。平台状态事件按 Execution 与状态去重，Execution 在 `unknown` 与其他状态之间往返后不能反映最近一次进入的时间。
