# ADR-0021：Browser action record 的 Execution binding

状态：accepted

## 背景

Browser action 已通过 Platform Worker 的 durable operation seam 执行，并由 Runtime controller 保留 terminal record。恢复读取如果只能依据 actionId 或 idempotency key，无法证明记录属于当前 Agent、Conversation、Execution、capability revision 或 Session allocation。仅依赖事件事实或调用方重新组合 binding 会把 Runtime record 变成不完整事实。

## 决策

Browser action request 在存在受控 execution seam 时携带一个不可变 binding：Agent、Conversation、Execution、capability version、page revision、Session generation 和 resource fence。Runtime controller 将同一 binding 原样写入每个 terminal action record，包含 rejected、failed、unknown 和 cancelled 结果。

`readAction` 只做内存中的只读回读：按 actionId 或 idempotency key 找到记录；调用方同时提供 binding 时逐字段比较，任何不一致都 fail closed。比较使用明确字段，不使用 JSON 序列化字符串，以免属性顺序成为身份语义。

该 binding 是 Runtime record 的归属投影，不取代 Platform Conversation Event、Execution Grant、Session authority 或 Worker 调度；Runtime 不因此新增持久化、调度器或授权主体。

## 影响

- Worker/Host 可在恢复前核对 readback record 的 Execution binding。
- actionId-only 与 idempotency-key readback 保持同一 terminal record。
- 跨主体、跨 Execution、跨 generation 或 fence 的回读稳定拒绝。
- 真实持久恢复、Pod/Host 重启和四模板验收仍需由后续 Issue 完成。
