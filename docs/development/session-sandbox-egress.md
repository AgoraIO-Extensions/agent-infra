# Session Sandbox 出站策略接入与验证

本实现对应 [#1255](https://github.com/AgoraIO-Extensions/agent-infra/issues/1255)，
消费[工程 Spec §10.1.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1011-session-owned-sandbox-权威与资源绑定)。

## 当前落实方式

[#1445](https://github.com/AgoraIO-Extensions/agent-infra/issues/1445) 起，Session Sandbox 的出站
由五类必需资源中的 NetworkPolicy 落实：Worker 从受审阅部署 policy 取 `dnsEgress`、`modelEgress`
与 `connectionEgress`，用与 Agent 级 Workload 相同的 `workloadEgressRulesV1` 编译为该 Sandbox
NetworkPolicy 的出站规则；部署未批准目标时出站为空，即全部拒绝。Store claim、请求、镜像和 Runtime
回包都不能提供或扩大目标。该 NetworkPolicy 已随 Sandbox 就绪回执记录 UID/resourceVersion；同 UID
漂移沿 adapter 既有语义判定 unknown 并拒绝原地更新。部署出站策略变化后既有 Session 的恢复路径尚未定义。

下文的 `createSessionSandboxEgressV1` 是另一种独立策略的 Worker 内部 enforcement seam，不是新的
分配、授权、Store 事务或调度入口；当前未接入 Session 生命周期，以下接线要求仅在启用该 seam 时适用。

## 接收边界

- #1250/#1251 从原持久分配构造 `SessionSandboxEgressBindingV1`，包括主体、Agent、Session、
  Sandbox、代次、配置/Workload 修订与原租约/fence。不能从请求或 Runtime 回包构造。
- `withCurrentAllocation` 必须沿原权威重新校验完整绑定，并将回调与分配状态迁移串行化；
  只检查一次再脱离保护执行不满足契约。`remove` 还要求实例正在回收且禁止并发创建 Pod。
  此实现不提供临时 Store 或仅靠进程内锁的替代实现。
- 部署传入不可变的获准 profile。Connection 规则须由 #1271 的完整
  [Consumer 配置](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#135-platform-外部-connection-consumer-配置契约)
  与 `egressProfile` 编译而来；本 seam 不定义另一份 endpoint 配置，也不提供 TLS、
  Connection 授权或客户端安装身份。缺少接线时不能开启 Connection 调用。
- #1251 在 Pod 创建前 `apply`，并在准入前 `observe`。Pod 标签必须精确包含 Agent、Session、
  Sandbox 与 generation 四项；标签命名与 #1251 的 Session workload 接口对齐。
  不得将此策略应用于现有 Agent 共享 Pod 并宣称完成 Session 隔离。
- 创建返回的 name/UID/resourceVersion 必须交回原分配权威保存。已存在资源若没有原 UID
  receipt，或同名 UID 更换，均不接管；创建后 receipt 未持久保存属于待核实，不能凭标签补认。
- 同一代次、同一 profile 下允许当前 fence 与配置/Workload 修订单调推进；旧 writer 拒绝。
  改代次或 profile 必须由生命周期 owner 先关闭入口并完成旧资源撤销和回收，不能静默接管。
- `revoke` 保留空 egress 策略。`remove` 只删除已撤销且没有任何代次 Sandbox Pod 的精确 UID，
  通过现有 Kubernetes client 执行 UID/resourceVersion 前置条件删除。
- Kubernetes NetworkPolicy 是叠加放行。seam 拒绝同 namespace 其他可能选中该 Sandbox 的
  非空出站策略；expression selector 保守拒绝。该检查不替代部署 RBAC、CNI 策略或持续调谐，
  API 回读不证明 CNI 已落实规则；发现漂移后生命周期 owner 必须阻止业务准入并调谐。

## 验证与证据

focused tests：

```bash
pnpm --dir apps/platform-worker exec vitest run \
  src/session-sandbox-egress.test.ts src/workload-network.test.ts
```

这些测试使用 Kubernetes fixture，只证明编译、身份核对、CAS、生命周期调用和漂移拒绝。
不能作为 Pod/CNI、外部 endpoint 或生产验收证明。

可选的真实 CNI probe 使用固定 digest 的 Node 镜像，在指定集群新建唯一测试 namespace：

```bash
SANDBOX_EGRESS_KIND_KUBECONFIG="$TEST_KUBECONFIG" \
SANDBOX_EGRESS_KIND_IMAGE="$PINNED_NODE_IMAGE" \
SANDBOX_EGRESS_KIND_EVIDENCE="$EVIDENCE_DIRECTORY" \
pnpm --dir apps/platform-worker exec vitest run src/session-sandbox-egress.kind.test.ts
```

probe 回读真实 Pod/Service/NetworkPolicy 与 CNI，先验证负向目标确实可达，再验证受限 Pod
无法访问。它仅使用合成分配与受控 HTTP endpoint，不证明原 Store、实际 Runtime、外部模型或
Connection conformance。结束时回收精确策略 UID，并只删除本次创建且核对 UID 的临时 namespace。

接线完成后的完整验收还须在独立测试 namespace 使用支持 NetworkPolicy 的 kind/CNI：

1. 固定源码 SHA、Runtime 镜像 digest、配置/profile 修订和 CNI 版本；从原分配权威创建同 Agent
   的两个独立 Session，记录 Sandbox、generation、lease/fence 与实际 Pod UID。
2. 通过每个实际 Runtime Pod 验证集群 DNS、获准模型与 Connection endpoint；同时验证
   未获准 endpoint、另一 Sandbox Service、变更端口和叠加放行策略的拒绝/隔离行为。
3. 注入策略漂移、过期租约、旧代次和外部同名 UID，确认无法准入或覆盖其他资源；验证
   当前 fence 下的撤销与回收，独立 Session 的规则和可用性保持。
4. 保存 Pod、Service、NetworkPolicy 和原分配的回读及命令结果。不能仅保存 healthz、模板、
   目录、模型自报或上述 fixture 的通过信息。
5. 仅对本次两个 Sandbox 关闭入口、停止 Pod、执行 `revoke` 与 `remove`，使用原记录的
   UID/resourceVersion 清理；不按 Agent、namespace 或宽 label 批量删除，不删除持久工作区。

任一真实 endpoint、CNI、原分配接线或资源关联证据缺失时，AC-2/AC-5 仍未验收，
不将 PR 标记为可合并，也不关闭 primary Issue。
