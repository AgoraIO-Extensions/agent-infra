# ADR-0029：受理不明阻塞的原生会话以明确拒绝收敛为会话不可用

## 状态

已采纳。随 [#3117](https://github.com/AgoraIO-Extensions/agent-infra/issues/3117) 的文档评审（#3118）合入；实现归属 [#3017](https://github.com/AgoraIO-Extensions/agent-infra/issues/3017)。

## 背景

[#3017](https://github.com/AgoraIO-Extensions/agent-infra/issues/3017) 在固定 E2E 环境定位了一条故障链路，并用 Driver 单测复现：

1. 首条 Turn 在 Codex `thread/start` 或 `turn/start` 期间进程被杀，或响应丢失。Codex Driver 留下受理不明的已准备操作，并持久标记该原生会话受理不明。RuntimeHost 恢复后，这条 Turn 为 `unknown`，没有原生会话引用。
2. 同一 Conversation、同一 `sessionGeneration` 的后续 Turn（新消息或重新生成）会复用该原生会话，Driver 每次都拒绝。Driver 返回的是可重试的 `RUNTIME_CODEX_UNAVAILABLE`，Host 把它映射为可重试的 `RUNTIME_DRIVER_INVALID`。Worker 于是持续重试：固定环境中一条执行重试了 120 次，约 3 小时后才失败。
3. 这个阻塞在本代次内是永久的。受理不明的标记没有清除路径，`RUNTIME_DRIVER_INVALID` 也不会触发代次隔离。

这种处理不违反现有约束，但现有约束没有覆盖这一场景：

- [Runtime HLD §7.3](../architecture/HLD-agent-runtime-M1.md#73-重启恢复) 已有以下规定：
  - 原生进程退出且没有可靠结果证据时，原 Turn 保持 `unknown`；
  - 平台不自动替换 Session，单次结果 `unknown` 不触发代次隔离；
  - 用户可以明确新建 Conversation。
- [§8.1](../architecture/HLD-agent-runtime-M1.md#81-消息与命令幂等) 禁止在受理不明时盲目再次产生 Runtime 副作用。
- [平台 PRD](../prd/PRD-agent-platform-M1.md) 不允许静默替换不可恢复的会话。
- 但这些文档都没有定义：Runtime 怎样明确拒绝在这种会话上继续，平台怎样告诉用户。

对照的两个开源项目都没有对应机制：

- getpaseo/paseo（`5878680f7`）：进程退出时，把在途 Turn 判为失败。下一条消息照常受理：还没有原生线程就新建线程，已有线程就继续该线程。受理不明只记录在单条消息的回执上，不阻塞会话，也不提示用户新建会话。
- dtyq/magic（`f9973c5cf`）：新消息直接抢占旧任务，必要时重建沙箱，用最近一次归档的历史在同一话题继续。崩溃那一轮可能丢失上下文；残留任务由定时检查按沙箱状态慢慢收敛为失败。

两者都靠「自动继续」换取可用性，与本仓「不确定时不重发、不静默换 Session」的约束冲突，因此不采用。

## 决策

1. **Runtime 明确拒绝。** 同一 Conversation 与 generation 的原生会话满足以下任一条件时，不再接受新 Turn：
   - 已持久标记受理不明；
   - 存在不属于当前进程内在途调用的残留已准备 Turn 提交操作（stop 等中断类操作可由原请求重放收敛，不计入）。

   对不同 `executionId` 的新 submit，Driver 在任何原生调用之前返回稳定且脱敏的 rejected 结果 `RUNTIME_SESSION_BLOCKED`，并把它与该操作原子持久化。同一 Execution 的重放仍按原操作返回 `unknown`。该结果：
   - 不可重试；
   - 不是 Session 恢复失败的证明，不触发代次隔离；
   - 不能用新的原生 Session 替代。
2. **Host 持久化。** RuntimeHost 像其他已持久 rejected 结果一样保存它，同请求重放时返回同一结果，不再调用 Driver 执行。只有 submit V2 及以上的结果枚举新增该成员。旧 V1 结果不扩展，保持现有的失败关闭。
3. **平台收敛。** Worker 收到该结果后，本次 Execution 收敛为失败，不换 `executionId` 重投。同一个 Dispatch 事务内，把 Conversation 标记为「会话不可用」：
   - 历史只读，不能继续发送；
   - 用户可以明确新建 Conversation；
   - 不提升 `sessionGeneration`，不创建 generation tombstone，也不新建 Runtime Session；
   - 绑定本次 Execution 的待处理补充指令按「投递失败：原回复未开始」终结，stop 置为成功终态；会话不可用后它们无法再被认领，必须在同一事务内收敛；
   - 原受理不明的 Execution 保留已持久的状态与证据；
   - 其他 Conversation 不受影响。
4. **范围。** 当前只有 Codex Driver 持有这种持久阻塞状态。其他 Driver 出现同类状态时，适用同一规则和同一结果码。产品表现沿用 PRD 已定义的「会话不可用」，不新增公共错误码。

## 影响

- 用户在被阻塞的会话里再发消息时，会立刻看到本次失败和「会话不可用」，不会再等待数小时的重试。新消息不会产生原生副作用。
- 已经处于阻塞状态的历史会话，会在下一次发送时转为「会话不可用」。
- 契约新增一个 rejected 成员，需要重新生成 Runtime Host 的 JSON Schema / OpenAPI，并通过兼容门禁。Worker 的响应解析需要同步接受该码。

## 备选方案

- **平台继续占用：** 不把这类 `unknown` 释放为失败，新消息直接返回繁忙。否决：会话会永久停在「待核实」，用户得不到可执行的提示。
- **代次隔离：** 视为会话恢复失败，提升代次。否决：这与 HLD §7.3「`unknown` 不构成恢复失败证明」冲突；而且 Driver 无法证明旧 Turn 已无副作用，tombstone 无法确认，会话会停在「代次隔离中」。
- **自动换新原生会话（paseo / magic 的做法）：** 否决：违反「不确定时不重发、不静默替换 Session」，可能重复执行外部副作用或丢失上下文。
