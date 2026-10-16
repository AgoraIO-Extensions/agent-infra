# Outbox 投递发现按可证明就绪状态过滤

## 状态

草案，待 [#2676](https://github.com/AgoraIO-Extensions/agent-infra/issues/2676) 评审后采纳；实现归属 [#2457](https://github.com/AgoraIO-Extensions/agent-infra/issues/2457)。

## 背景

Platform Worker 通过固定轮询发现到期的 Conversation outbox，再在数据库事务中重新取得 Agent、Conversation、Execution 和 outbox 锁并做权威准入。发现阶段目前只检查 outbox 的时间、租约和等待期限，因此 Session Sandbox 尚未就绪的业务任务、以及已停止 Agent 的无生命周期调谐条目，每个轮询周期都会进入一次 claim 事务。

`busy` 已在 #2671 中改为 `waiting` 观测，但这只降低了错误日志噪声，不能减少重复锁事务。发现阶段可以过滤“当前已知不可能成功”的条目，但发现结果只是提示，不能替代 claim 中的授权、fence、租约和状态复核。

## 决策

1. **按操作类型定义发现例外。**

   - `conversation.turn.submit.v1`、`conversation.turn.regenerate.v1`、`conversation.turn.supplement.v1`、`conversation.native-capability.invoke.v1` 和 `conversation.browser.handoff.v1` 只有在同一 Conversation 的 Session Sandbox 具有可查询的就绪事实时才进入普通发现结果。就绪事实沿 `readSessionSandboxReadiness` 的四个持久字段定义：allocation `status = ready`、`desired_state = running`、`resource_fence > 0`，以及 `resource_observation.status = ready`。
   - `conversation.turn.stop.v1` 始终保留在发现结果中。停止确认、已提交控制操作和恢复核实不能被业务就绪过滤饿死。
   - 带 `metadataRecovery` 的任务、generation tombstone 重试和已有停止确认期限的条目走现有例外分支，继续发现；它们的 claim 事务仍按原执行和代次核实。
   - `conversation.sandbox.reconcile.v1` 只有在 Agent 管理记录明确为 `stopped/disabled`、`desired_state = stopped`、`service_availability is null`，且 payload 明确没有 lifecycle 时过滤。任何 lifecycle 字段（包括未知或格式非法的值）都保留给 claim 做完整校验；缺失或未知的 Agent 管理记录也保留。带有合法且与当前 Agent、Conversation、generation 匹配的 schema 1 lifecycle 的 drain 或 preparation 条目始终保留，因为停止期间的排空和恢复本身就是它的进展条件。

2. **发现过滤使用持久、可查询的条件。**

   Store 在 `findDispatchable` 内以窄 SQL `EXISTS` 子查询读取上述 allocation 和 management 字段；不复制完整的 TypeScript 状态机，也不把内存中的 Worker 观测当作权威。三类分支彼此互斥，普通业务分支的核心谓词固定为：

   ```sql
   and (
     o.operation = 'conversation.turn.stop.v1'
     or (
       o.operation in (
         'conversation.turn.submit.v1',
         'conversation.turn.regenerate.v1',
         'conversation.turn.supplement.v1',
         'conversation.native-capability.invoke.v1',
         'conversation.browser.handoff.v1'
       )
       and o.payload ? 'metadataRecovery'
     )
     or (
       o.operation = 'conversation.sandbox.reconcile.v1'
       and (
         o.payload ? 'lifecycle'
         or not exists (
           select 1 from platform.agent_applications a
           join platform.conversations c2 on c2.agent_id = a.agent_id
           where c2.id = c.id
         )
         or exists (
           select 1 from platform.agent_applications a
           where a.agent_id = c.agent_id
             and not (
               a.status in ('stopped', 'disabled')
               and a.desired_state = 'stopped'
               and a.service_availability is null
             )
         )
       )
     )
     or (
       o.operation in (
         'conversation.turn.submit.v1',
         'conversation.turn.regenerate.v1',
         'conversation.turn.supplement.v1',
         'conversation.native-capability.invoke.v1',
         'conversation.browser.handoff.v1'
       )
       and exists (
         select 1
         from platform.session_sandbox_allocations s
         where s.conversation_id = c.id
           and s.status = 'ready'
           and s.desired_state = 'running'
           and s.resource_fence > 0
           and s.resource_observation->>'status' = 'ready'
       )
     )
   )
   ```

   Generation tombstones and stop confirmation deadlines remain separate top-level discovery branches, so they bypass this predicate. A readiness subquery that returns no row, NULL, or missing JSON status is false and therefore filters the ordinary business item. If the discovery SQL itself errors, `findDispatchable` propagates the error and the Worker returns no candidates for that pass; it never treats the error as ready. The first implementation uses the existing indexes: `outbox_eligibility_idx(status, available_at)` or the ordered `outbox_items` primary key for the paged `id` scan, `conversations` primary key, `session_sandbox_conversation_unique(conversation_id)`, and `agent_application_agent_unique(agent_id)`. The `EXISTS` shape guarantees at most one result row per outbox item even if future tables gain history rows. No JSON expression index is proposed because `resource_observation` is read only after the unique conversation lookup; a migration is required only if the implementation's real `EXPLAIN (ANALYZE, BUFFERS)` shows a broader scan.

   A representative `EXPLAIN (COSTS OFF, SUMMARY OFF)` against a controlled PostgreSQL schema with those indexes produced the expected bounded shape:

   ```text
   Limit
     -> Nested Loop
          -> Index Scan using outbox_items_pkey on outbox_items
               Index Cond: (id > 'item-000000')
               Filter: (status/operation/scope/available_at predicates)
          -> Index Only Scan using conversations_pkey on conversations
               Index Cond: (id = o.scope_id)
               Filter: (stop/reconcile exception OR readiness subplan)
               SubPlan 1
                 -> Index Scan using session_sandbox_allocations_conversation_id_key
                      Index Cond: (conversation_id = c.id)
                      Filter: (resource_fence/status/desired_state/observation)
   ```

   The reconcile branch uses the same one-row `agent_application_agent_unique` lookup and treats missing/unknown management or lifecycle values as candidates for claim validation, so the discovery optimization can produce false positives but never filters a control/recovery item on an untrusted interpretation.

   The implementation PR must repeat this check on the migrated repository schema with `EXPLAIN (ANALYZE, BUFFERS)` and record the plan plus row counts; the controlled plan is design evidence, not production acceptance.

3. **claim 仍是唯一权威边界。**

   Discovery 发生后，Agent 可能立即停止、Sandbox 可能变为不可用或租约可能被另一 Worker 取得。`claimWork`、`claimSandboxReconciliation` 和现有控制/恢复路径保持全部锁、授权、generation、fence 和 lease 复核；竞态只返回既有 `busy`/`stale`/失败结果，不产生 Runtime 副作用，也不改变任务顺序。

4. **继续使用固定轮询保证就绪后的发现。**

   本设计不为 `busy` 引入 Worker 内存退避，也不把 PostgreSQL `NOTIFY` 当作唯一唤醒。默认轮询周期仍是 1 秒，Sandbox ready、Agent restart 或 workload observation 提交后的下一轮即可发现条目；因此过滤不会牺牲 #2208 的就绪后首条消息时延保证。若以后采用 NOTIFY，只能作为缩短等待的提示，且每个 readiness transition 必须有同事务提交唤醒并保留轮询兜底。

5. **不改变任务语义。**

   等待期限、受理顺序、容量、取消/unknown 收口和 Runtime dispatch outcome 均保持现有契约。#2456 的 unknown reconcile 退避与审计写放大另行处理。

## 实现前的验证契约

实现票必须至少覆盖以下真实 PostgreSQL 情形：

- 未就绪的业务 outbox 不出现在 discovery，claim/lock/attempt 计数不增长；ready transition 后下一轮可发现。
- 已停止 Agent 的无 lifecycle reconcile 不出现在 discovery；restart/running 后可发现。
- 停止期间带 drain/preparation lifecycle 的 reconcile 仍可发现。
- discovery 与 stop/readiness 变化竞态时，claim fail closed 且无 Runtime 调用。
- stop、metadata recovery、generation tombstone 和停止确认期限例外不会被过滤或饿死。
- 多项混合时仍按现有顺序返回，且查询计划不会退化为全表扫描。

固定本地 E2E 需比较改动前后 busy turn 和 stopped reconcile 的 claim/lock 速率，并验证 Sandbox ready 到首条消息发现的延迟仍在 #2208 的 20 秒目标内。

## 备选方案

- **只在 claim 返回 busy 后增加指数退避：** 拒绝。Sandbox ready、Agent restart 和 observation 提交没有统一的 Worker 内存唤醒；退避会延长首条消息发现并在 Worker 重启后丢失状态。
- **只增加 NOTIFY：** 拒绝。当前 `0046_commit_wakeups.sql` 未覆盖 allocation readiness、Agent management 和 workload observation 的所有提交路径，不能作为唯一保证。
- **放宽 claim 的就绪校验：** 拒绝。发现是优化提示，不能削弱授权、fence、租约和 Session 隔离门禁。
