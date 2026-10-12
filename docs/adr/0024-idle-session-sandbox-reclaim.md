# 空闲 Session Sandbox 回收计算资源

## 状态

已采纳，设计归属 [#2156](https://github.com/AgoraIO-Extensions/agent-infra/issues/2156)。

## 背景

Platform Session 没有用户删除入口。会话关闭、Agent 停止或管理员停用可以沿既有生命周期回收
计算资源，但长期没有新消息的会话仍会保留 Pod，CPU 和内存随会话数量增长。空闲计算资源需要
回收，而 Session 的工作区、历史和归属必须继续保留。

## 决策

1. **按部署策略判断空闲。** 每个部署可以配置 Session Sandbox 空闲阈值，未配置时默认为 30 分钟。
   连续达到阈值且没有新的会话活动时，Worker 才评估回收；空闲回收不关闭 Session，也不改变
   Agent、Sandbox、授权或 Workload policy。
2. **只回收安全的执行状态。** Sandbox 中所有执行必须已进入终态，且不存在 `active`、`waiting` 或
   `unknown` 执行；停止屏障、上一轮生命周期和资源身份均已确认时，才可写入 idle reclaim 意图。
   存在任一上述执行或待核实屏障时保留计算资源和原占用；不能用超时推断执行已停止。
3. **复用管理排空与停止回执。** 回收沿 [工程 Spec §10.1.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1011-session-owned-sandbox-权威与资源绑定)
   的条件删除、CAS、fence 和 `stopReceipt` 路径，停止 Pod、Service、ServiceAccount、NetworkPolicy
   和专属 Secret 等计算与路由资源，只保留原 PVC 及其 UID/resourceVersion。删除部分失败或结果
   未知时保留原意图和占用，不创建替代 Sandbox。
4. **下一条消息恢复原会话。** 回收完成后，下一条 Web、企微或 API 消息沿现有会话准备流程重新
   准备同一 Sandbox 和 PVC，再按原会话归属投递；平台历史、工作区和合法授权保持不变。准备失败
   时按既有会话不可用和恢复规则反馈，不能静默丢弃消息或新建会话重放。
5. **与升级严格区分。** idle reclaim 由空闲阈值触发，只负责释放计算资源；已验证 Workload
   policy 变化触发的升级仍使用 [ADR 0023](./0023-upgrade-idle-session-sandboxes.md) 的
   `reason: upgrade`、排空、`stopReceipt` 和重新准备规则。idle reclaim 不改变 policy 或
   Workload revision，也不把 `SESSION_SANDBOX_UPDATING` 当作空闲回收结果。

## 风险与边界

- 回收后下一条消息需要重新准备 Sandbox，首条消息的延迟增加；准备失败只影响该 Session。
- PVC 继续占用存储配额，idle reclaim 只释放计算和路由资源，不是 Session 或数据删除。
- 该策略只适用于 Platform Session-owned Sandbox，不改变 `self-managed` Agent 的部署和会话责任。
- 该策略不提供通用队列、调度或 Agent 级自动休眠能力；执行未知或停止未确认时始终 fail closed。

## 备选方案

- **永不回收空闲 Sandbox：** 保持首条消息延迟，但在没有会话关闭入口时会让计算资源随会话数线性增长，拒绝。
- **关闭 Session 或删除 PVC：** 会破坏历史、工作区或会话归属，违反 Session-owned Sandbox 的持久化边界，拒绝。
- **为 idle reclaim 新建独立资源状态机：** 重复现有管理排空、删除确认和恢复屏障，容易产生两个生命周期权威，拒绝。
