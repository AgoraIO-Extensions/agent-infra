# Session-owned Sandbox 作为 M1 P0 隔离边界

[#1248](https://github.com/AgoraIO-Extensions/agent-infra/issues/1248) 将平台会话的运行隔离
纳入 M1 P0。产品行为以 [PRD §3](../prd/PRD-agent-platform-M1.md#3-agent-运行方式)为准，
标识、资源、授权、迁移与生命周期只在
[工程 Spec §10.1.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1011-session-owned-sandbox-权威与资源绑定)
完整定义，Runtime 映射和验收由 [Runtime HLD](../architecture/HLD-agent-runtime-M1.md#6-数据归属与标识)消费。

Agent 级 Pod/PVC 加目录或原生 thread 分离，不能提供跨 Runtime、同主体不同 Session 的完整
进程、工作区和凭据隔离。采用每 Session 唯一 Sandbox，代价是每会话独立计算/存储资源及
迁移成本；继续使用现有 Platform DB、Worker 与 RuntimeHost，不增加调度服务、CRD 或资源池。
自有 Web 的会话归属不改变，不能将其应用 Session 自动解释为 Platform Session。

## 历史边界

- [#163](https://github.com/AgoraIO-Extensions/agent-infra/issues/163) 是已关闭的旧 Workload
  拓扑决策；其 Agent 级共享运行实例不再是平台会话的隔离架构。Worker 独占 namespace-scoped
  Kubernetes 权限的 [ADR 0001](0001-separate-platform-services-from-kubernetes-workload-plane.md)继续有效。
- [#404](https://github.com/AgoraIO-Extensions/agent-infra/issues/404) 与
  [ADR 0008](0008-isolate-codex-native-processes-per-conversation.md) 是已关闭的 Codex
  进程/文件隔离历史交付；保留原证据，不重开旧票，不将其通过外推为 Sandbox 完整验收。
- 原生文件/进程防护、当前授权、原执行 Key、必要审计、unknown 不重放和停止确认不因 Pod
  独立而取消。Sandbox 不成为 Connection Principal、ConsumerInstance 或 Grant 的替代品。

## 实施交接与验收

| 唯一交接 | 责任 |
| --- | --- |
| [#1250](https://github.com/AgoraIO-Extensions/agent-infra/issues/1250)，原 #482 | 在原会话/任务事务内持久分配、幂等、当前授权、原 outbox 和恢复绑定，不新建任务权威。 |
| [#1251](https://github.com/AgoraIO-Extensions/agent-infra/issues/1251)，原 #504 | 消费持久分配，按 Sandbox 调谐实际 Pod、Service、身份、卷与路由；保留 Agent 管理语义和原资源 owner。 |
| [#1252](https://github.com/AgoraIO-Extensions/agent-infra/issues/1252)，原 #508/#483/#192 | 版本化 Grant/Host/Driver 绑定及三入口消费；共享 Host 由 #508 串行接收，各 Driver 和 Web owner 保留原 AC。 |
| [#1255](https://github.com/AgoraIO-Extensions/agent-infra/issues/1255) | 按 Sandbox 落实部署批准的出站策略与真实 CNI 正负验证，消费 Spec §13.5 配置，不改 Connection 授权。 |
| [#1253](https://github.com/AgoraIO-Extensions/agent-infra/issues/1253)，原 #194 | 回读同版本真实资源、三入口、至少两个 Runtime 的正负与恢复证据；缺项保持未验收。 |

实施前各 owner 交接具体文件/符号及当前 main 差额；契约检查和架构评审不授予替其他 owner
修改共享代码的权限。Connection profile 接线仍属 #1270/#1271/#1272，受保护客户端仍属 #851。
文档通过不代表新 Schema、资源、迁移或运行隔离已实现，不关闭完整 M1/Pilot 或父票验收。
