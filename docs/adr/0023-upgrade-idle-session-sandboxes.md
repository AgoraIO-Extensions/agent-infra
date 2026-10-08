# 空闲 Session Sandbox 沿原卷升级到新的已验证部署

## 状态

提议中，归属 [#1523](https://github.com/AgoraIO-Extensions/agent-infra/issues/1523)。

## 背景

Agent 的配置修订或已验证 Workload（镜像 Digest、资源配置）变化后，已有会话的 Session Sandbox 仍记录旧的 `resource_policy`。[#1522](https://github.com/AgoraIO-Extensions/agent-infra/issues/1522) 让这类会话的新 Turn 在投递前以 `SESSION_SANDBOX_UPDATING` 等待，但没有任何流程把 Sandbox 升级到新部署，原会话因此永久无法继续。

[工程 Spec §10.1.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1011-session-owned-sandbox-权威与资源绑定) 已规定 Agent 升级时管理资格作用于所有所属 Sandbox，升级只复用该 Sandbox 原持久卷；§10.4 规定升级期间显示“更新中”、不能静默丢弃消息。现有代码只为 Agent 停止、停用等管理变更规划“排空 → `stopReceipt` → 按原卷重新准备”，没有升级触发点。

## 决策

1. **复用管理排空路径，不新增状态机。** 升级意图沿现有管理生命周期写入同一会话的 Sandbox 调谐 outbox：`resourceFence + 1`、`desired_state = stopped`，目标仍为 `running`。排空按原资源 UID/resourceVersion 回收 Pod、Secret、Service 等计算与路由对象并保留 PVC，生成 `stopReceipt`；随后以新 policy、同一 `sandboxId`、资源名和 PVC 重新准备，PVC UID 不变，其余资源在新 fence 下重建。生命周期内标记 `reason: upgrade`，只用于审计和“更新中”展示，不改变授权判断。
2. **只升级空闲 Sandbox。** 写入意图时，存在 `processing`/`unknown` 执行、待确认的代次 tombstone、未完成的上一轮生命周期、或缺少完整原 deployment 的 Sandbox 不排空；原执行的恢复与停止路由保持可用。
3. **“尚未交给 Runtime”的任务不阻止升级。** `submitted`/`waiting` 状态表示任务从未交给 Runtime，或经 #1522 证明未发送后退回原位置；这类任务不产生 Runtime 副作用，升级排空与重新准备均不因其阻止，任务保留原顺序，在 Sandbox 就绪后投递。`processing`、`unknown` 仍阻止排空并保持占用。
   - 判定只看执行状态，不看投递 fence。认领在检查 policy 之前递增执行的投递 fence，因此每个因 `SESSION_SANDBOX_UPDATING` 等待的 Turn 都已有 `deliveryFence ≥ 1`；沿用现有重新准备判定中的 `deliveryFence = 0` 条件，会让该 Turn 反过来阻止它所等待的升级。排空与重新准备因此使用同一判定，并去掉该条件。
   - 安全性来自写前日志：Runtime 请求发出前，投递准备须在持有 Agent 行锁的事务内复核 Sandbox 就绪与 policy 当前，并写入 `unknown`。升级意图在同一 Agent 行锁下写入并令 Sandbox 不再就绪；先提交意图时投递只能等待，先写 `unknown` 时该 Sandbox 不再空闲，不会被排空。
4. **触发点。** 在提交新的已验证 Workload 状态（phase `ready`）的同一 Workload 写回事务内，按 Agent 行 → 会话 → Sandbox 分配 → 调谐 outbox 的既有加锁顺序写入升级意图，并写入审计。该事务也在周期性监测时运行，因此写入时忙碌的 Sandbox 会在其空闲后的下一次监测中升级；只选择 policy 已过期的分配。
5. **升级期间的等待。** 该会话的 Turn 继续等待：不写 `unknown`、不计入 Agent 占用、保留原顺序。Sandbox 未就绪且存在升级生命周期时，投递等待原因报告为 `SESSION_SANDBOX_UPDATING`；Web 会话可用性显示“更新中”。
6. **恢复失败。** 新 Pod 从原 PVC 恢复 Host-to-native Session；恢复被原生 Runtime 明确拒绝时，沿 [Runtime HLD §7.3](../architecture/HLD-agent-runtime-M1.md#73-重启恢复) 的 `RUNTIME_SESSION_RECOVERY_FAILED` 与代次隔离流程，只使该会话不可用。

## 风险与边界

- 升级会让每个空闲会话经历一次 Pod 重建，首条消息需要等待 Sandbox 重新就绪（当前约 10–13 秒，见 [#1562](https://github.com/AgoraIO-Extensions/agent-infra/issues/1562)）。
- M1 不创建 PVC 快照，也不承诺 Runtime 自有数据兼容旧版本（Spec §10.4）。新版本无法读取原卷数据时按恢复失败处理，不自动新建 Session。
- 升级期间的管理变更（停止、停用）继续按现有规则覆盖升级意图；生命周期授权必须与当前管理状态一致，否则调谐不认领。
- 不在本决策内：已卡在 `unknown` 的历史执行、跨 Agent 迁移、PVC 数据迁移。

## 备选方案

- **在投递路径发现过期 policy 时就地触发升级：** 投递准备以事务内抛出等待结果，写入会随之回滚；改为返回结果会扩散到全部投递分支，拒绝。
- **就地替换 Pod 规格而不排空：** Kubernetes 不允许修改运行中 Pod 的探针等字段，且绕过按原 UID 回收与 fence 校验，违反 Spec §10.1.1，拒绝。
- **为升级新建独立生命周期权威：** 需要复制停止/重新准备的全部校验，增加第二套状态机，拒绝。
