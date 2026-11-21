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
开放，并以 NetworkPolicy 实现。2026-11-21 生产新 lane 的只读回读和受限探针表明：

- ACK 集群的 ECS 节点只有 flannel，没有 NetworkPolicy 执行者。
- 同 namespace 的普通 Pod 能直连 self-managed 样本 P 的正式 Service 端口，并拿到 HTTP 200。

当时 15 个 Agent 级 Host Pod 都在 ECS 上，包括运行用户镜像的 P 和 M。NetworkPolicy 对象
都存在，但这些 Pod 上没有生效。

Spec 和 HLD 原先只写了策略规则，没有写“策略必须实际被执行”，也没有写 Agent 级 Workload
运行在哪里。部署文档只要求按会话创建的 Session Pod 使用 ECI（由 chart 准入注入），Agent
级 Workload 默认落在普通节点。部署预检也只检查 NetworkPolicy 对象存在。

## 决策

1. **运行形态门槛。** Worker 为 Agent 创建的全部 Pod，以及 Session Sandbox，只运行在已证实际
   执行 NetworkPolicy 的运行形态上。全部 Pod 指单服务、多服务、发布前迁移 Job、init 与快照
   准备 Pod。没有满足条件的运行形态时不创建、不准入，不回退到其他节点。
2. **部署权威 placement。** 调度位置由受信部署配置给出，Worker 统一注入并纳入期望规格、漂移、
   恢复与资源配置摘要。Owner、Manifest、多服务资源描述和模型都不能提供或覆盖调度字段，
   非部署注入的调度字段按漂移处理。
3. **预检 fail closed。** 正式部署入口只读回读已批准的当期执行证据，缺失、过期或不完整时拒绝
   发布，不在生产自动造探针。
4. **ACK 取值。** Agent 级 Workload 与 Session Sandbox 都使用由 ACK Poseidon 执行
   NetworkPolicy 的 ECI，ECS 节点只承载平台组件。

## 备选

- **方案 ②：为 ECS 节点换用 Terway 并启用 NetworkPolicy。** 需要改 CNI 和集群组件，由集群
  管理员操作，影响面覆盖全部 ECS 工作负载。用户未采用。
- **方案 ③：暂时接受。** 不受信用户镜像与平台端口之间只剩应用层鉴权一道防线，不满足 Spec
  §8.3。用户未采用。
- **只在 chart 准入里注入 ECI 调度，不改 Worker。** 与 Session 现有做法一致、改动小，但 Worker
  会把准入注入的调度字段当作漂移；而且准入缺失或绑定失效时，Pod 会静默落到 ECS。可以作为
  兜底，但不作为唯一权威。

## 后果

- 迁移时每个 Agent Host 重启一次，原 PVC 与数据保留，云盘须与 ECI 同可用区。涉及真实用户
  的 Agent，迁移前先列出并告知用户；迁移手册另行编写。
- ECI 计费会新增费用。Ops4178 按官方单价估算：15 个 Pod 的计算费每月新增约 ¥2,414.87–3,219.83，
  加上手工缓存盘后合计约 ¥2,874.77–3,909.68/月，不是账单上限。上线前须由用户确认费用。
- placement 进入资源配置摘要后，依赖原摘要的已采用证据（例如执行容量 profile、reserve 批准）
  按现有规则重新采用，不沿用旧摘要。
- ECS 上的平台组件之间仍没有 NetworkPolicy 执行。它们不运行用户代码；对 Agent 级 Workload
  与 Session Sandbox 的阻断依赖来源 Pod 在 ECI 上执行的 egress，并保留应用层鉴权。如果以后
  平台组件需要运行不受信代码或对外暴露新端口，须另行评估执行者覆盖。
- 回退不能回到不执行 NetworkPolicy 的 ECS 继续运行不受信代码并声称安全。安全回退只能保留
  ECI，或者暂停相关 Workload。
