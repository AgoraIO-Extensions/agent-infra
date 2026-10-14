# ADR-0021：Browser action record 的 Execution binding

状态：accepted

## 背景

Browser action 在 Runtime Driver 的实际执行边界产生 operation fact，并由 Runtime journal 保留 terminal record；Platform Worker 消费该 fact 进入通用 `execution.operation` 事务。Worker 中的 Browser operation/recovery adapter 是受控消费 seam，不是当前 Chromium controller 的生产执行入口。恢复读取如果只能依据 actionId 或 idempotency key，无法证明记录属于当前 Agent、Conversation、Execution、capability revision 或 Session allocation。仅依赖事件事实或调用方重新组合 binding 会把 Runtime record 变成不完整事实。

## 决策

Browser action request 在存在受控 execution seam 时携带一个不可变 binding：Agent、Conversation、Execution、capability version、page revision、Session generation 和 resource fence。Runtime controller 将同一 binding 原样写入每个 terminal action record，包含 rejected、failed、unknown 和 cancelled 结果。

`readAction` 只做内存中的只读回读：按 actionId 或 idempotency key 找到记录；调用方同时提供 binding 时逐字段比较，任何不一致都 fail closed。比较使用明确字段，不使用 JSON 序列化字符串，以免属性顺序成为身份语义。

该 binding 是 Runtime record 的归属投影，不取代 Platform Conversation Event、Execution Grant、Session authority 或 Worker 调度；Runtime 不因此新增持久化、调度器或授权主体。

当前恢复边界：Runtime 产生的 `unknown`/`recovery_unconfirmed` fact 只保留原操作的未确认状态，不向 Browser controller 反向读取真实 terminal record，也不自动重放副作用。真实 controller 回读、Worker durable reconciliation 和完整四模板验收由 [#1376](https://github.com/AgoraIO-Extensions/agent-infra/issues/1376) 与 [#1377](https://github.com/AgoraIO-Extensions/agent-infra/issues/1377) 承接；本 ADR 不把受控测试或静态 binding 证据写成生产恢复完成。

## 影响

- Worker/Host 可在恢复前核对 readback record 的 Execution binding。
- actionId-only 与 idempotency-key readback 保持同一 terminal record。
- 跨主体、跨 Execution、跨 generation 或 fence 的回读稳定拒绝。
- 真实持久恢复、Pod/Host 重启和四模板验收仍需由后续 Issue 完成。
