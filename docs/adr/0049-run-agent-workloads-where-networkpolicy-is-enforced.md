# ADR-0049：Agent 级 Workload 只运行在已证执行 NetworkPolicy 的运行形态

## 状态

提案，归属 [#4351](https://github.com/AgoraIO-Extensions/agent-infra/issues/4351)。用户于
2026-11-21T15:4xZ 选定方案 ①（[#4351 评论 7065363992](https://github.com/AgoraIO-Extensions/agent-infra/issues/4351#issuecomment-7065363992)）。
须经非实现方独立评审后合入。工程规则只在
[工程 Spec §10.1“运行形态与调度”](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#101-workload-形态)
与 [§8.3“限定访问面”](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#83-内部接口)
维护；本 ADR 只记录取舍，不单独覆盖 PRD、工程 Spec 或 HLD。

## 问题

工程 Spec §8.3 要求 Agent 级 Workload 与 Session Sandbox 的原业务、控制和就绪端口只对 Worker
开放，并以 NetworkPolicy 实现。#4351 的现场回读表明，ACK 集群的 ECS 节点只有 flannel，
没有 NetworkPolicy 执行者；运行在这些节点上的 Agent 级 Host 虽有 NetworkPolicy 对象，
同 namespace 的普通 Pod 仍能直连其正式端口。盘点与探针结果以 Issue 回执为准。

Spec 和 HLD 原先只写了策略规则，没有写“策略必须实际被执行”，也没有写 Agent 级 Workload
运行在哪里。部署预检也只检查 NetworkPolicy 对象存在。

## 决策

Agent 级 Workload 与 Session Sandbox 一样，只运行在已证实际执行 NetworkPolicy 的运行形态上；
在 ACK 上即由 Poseidon 执行策略的 ECI，ECS 只承载平台组件。调度位置是部署权威输入，由
Worker 注入并参与漂移判定，Owner 等输入不能提供调度字段。部署预检在没有当期执行证据时
fail closed。现存 Agent 只在逐 Agent 的正式 lifecycle 中采用新 placement，发布本身不触发
全量重建。完整规则见 Spec §10.1。

## 备选

- **方案 ②：为 ECS 节点换用 Terway 并启用 NetworkPolicy。** 需要改 CNI 和集群组件，由集群
  管理员操作，影响面覆盖全部 ECS 工作负载。用户未采用。
- **方案 ③：暂时接受。** 不受信用户镜像与平台端口之间只剩应用层鉴权一道防线，不满足 Spec
  §8.3。用户未采用。
- **只在 chart 准入里注入 ECI 调度，不改 Worker。** 与 Session 现有做法一致、改动小，但 Worker
  会把准入注入的调度字段当作漂移；而且准入缺失或绑定失效时，Pod 会静默落到 ECS。可以作为
  兜底，但不作为唯一权威。
- **发布后由 Worker 按漂移自动迁移全部 Host。** 实现最简单，但一次发布会同时重建全部 Host，
  无法逐个排空、核对原 PVC 与 fence，也无法控制批次。不采用。

## 后果

- 每个 Agent Host 在其正式 lifecycle 中重建一次，原 PVC 与数据保留，云盘须与 ECI 同可用区。
  涉及真实用户的 Agent 须先告知用户；顺序与窗口由迁移手册安排，手册不替代实现门槛。
- 采用前保留态的 Host 仍运行在原节点，不视为已隔离；全部采用后部署关闭保留态。
- ECI 会新增费用，估算与盘点见 #4351 回执，不是账单上限；上线前须由用户确认费用。
- 新增的 Agent 级 Host placement 不进入 Session Sandbox、reserve 与执行容量共用的资源配置
  摘要，发布它不会使这些既有批准整体失效；它的变化由 Worker 资源对象指纹与漂移判定承担。
  既有 `codexSessionExecutor.placement` 等改变 Session 实际 Pod 或授权输入的配置仍按 Spec
  §10.1.1 进入原摘要并失配重验。
- ECS 上的平台组件之间仍没有 NetworkPolicy 执行。它们不运行用户代码；对 Agent 级 Workload
  与 Session Sandbox 的阻断依赖来源 Pod 在 ECI 上执行的 egress，并保留应用层鉴权。如果以后
  平台组件需要运行不受信代码或对外暴露新端口，须另行评估执行者覆盖。
- 回退不能回到不执行 NetworkPolicy 的 ECS 继续运行不受信代码并声称安全。安全回退只能保留
  ECI，或者暂停相关 Workload。

## 增补（2026-11-22）：以行为证据和每周探针作为部署门禁

用户于 2026-11-22T12:2xZ 采纳（[#4351 评论 7079129662](https://github.com/AgoraIO-Extensions/agent-infra/issues/4351#issuecomment-7079129662)）。
原部署预检要求回读 Poseidon 配置，并要求证据的目标集合等于部署时全部 Agent 级控制器、
目标 Pod 在部署时仍存在。核实后，前一项在集群内读不到（`version` 与
`eciNetworkPolicyEnabled` 由托管侧持有，没有只读云 API 身份），后一项让每次 accept 之后都
要在部署前紧挨着重跑全量探针。

决定：门禁以每个可落 ECI 节点上的 allow、deny、recovery 与非 Worker 来源被拒为行为证据，
不回读托管侧配置；探针只在触发条件出现时重跑，其余部署只做只读静态检查，缺证据、过期或检查不符仍
fail closed。触发条件、静态检查和残余风险只在
[工程 Spec §10.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#101-workload-形态)
“部署预检”条维护，证据格式见 [ACK Runtime 隔离预检](../../deploy/ack/RUNTIME-PREFLIGHT.md#networkpolicy-执行证据门禁)。

未采纳：每 7 天由用户或管理员查看控制台回读；新建只读 RAM 身份读取配置；每次部署前重跑全量探针。
代价是托管侧 Poseidon 在两次探针之间失效时，门禁最长约 7 天发现不了，该风险由用户接受，
不在本 ADR 重复限定。

NetworkPolicy 摘要比较的是去掉 Agent 个体值（Agent 选择器值、端口、服务名）的规范化模板，部署级出站与入站来源全部纳入，而不是任一 Agent 的整份 spec：
Agent 级 NetworkPolicy 随 Agent 渲染，部署时没有可比较的现场对象，探针对象也已删除。探针对象用替换表实例化，其标签条件由 Spec 同条规定。模板的
定义只在工程 Spec 同条维护。未采纳：选一个代表 Agent 的整份 spec 作摘要，它既与探针策略不等，
也会让部署永远失败或被迫放宽比较。
