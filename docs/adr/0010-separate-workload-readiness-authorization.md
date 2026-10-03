# ADR: 独立的 Workload 就绪授权

## 状态

已完成独立架构评审，用于 [#504](https://github.com/AgoraIO-Extensions/agent-infra/issues/504)
的实现；合入遵循仓库当前提交的审查门禁。

## 背景

Worker 在申请审批后的候选 Workload 上验证协议与能力，此时没有业务 Conversation 或
Execution。既有业务 Grant 需要这些绑定，旧版本还携带 delegated Action 字段；为探测
虚构业务 ID 或 Action revision 会混淆授权来源。

## 决策

按工程 Spec 的[服务端授权上下文](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#93-服务端授权上下文)
使用独立 Workload Readiness Grant 和只读 Host 入口。业务与控制 Grant、Connection 身份及
外部授权沿各自接口处理。Wire Schema、Host 校验、Worker 签发和候选结果验证一起交付。

## 影响

- 新增一种受限的内部证明，不新增服务、用户身份或授权数据权威。
- Host 部署必须注入本机 Agent、Workload revision、fence、镜像 Digest 和验签公钥；
  Worker 持有签名能力，Agent 只获得公钥。
- 旧业务 Grant 与客户端契约保持原有语义；就绪证明不能在业务接口使用。
- 测试覆盖签名、有效期、目标与版本错配、跨用途拒绝，以及无 Session、模型和工具副作用。

## 备选方案

复用业务 Grant 需要尚不存在的业务上下文；只使用健康检查不能证明实际协议与能力。
两者均不满足候选激活的现有要求。
