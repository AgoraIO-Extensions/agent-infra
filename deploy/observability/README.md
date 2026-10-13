# Platform 观测告警规则

`prometheus-rules.yaml` 提供 Platform API/Worker 共用的 Prometheus 告警规则。部署方将它挂载到 Prometheus 的 `rule_files`，并按实际容量调整规则中的默认阈值；仓库不预设生产并发或值班策略。

规则只使用 `@agent-infra/observability` 输出的固定 stage/outcome/kind 标签：

- `AgentPlatformOutboxBacklog`：持久 outbox 持续积压。
- `AgentPlatformHttpErrors`：HTTP 失败率持续异常。
- `AgentPlatformTelemetryMissing`：连续五分钟没有收到 outbox 资源样本。

告警标签只有 `severity` 和 `kind`，不会把用户、Agent、Conversation、Execution 或任意文本放进 Prometheus label。通知地址、认证信息和容量阈值由部署配置提供，不能写入仓库。

受控验证入口见 [`tests/observability/README.md`](../../tests/observability/README.md)。它使用固定 Prometheus/Alertmanager 镜像，验证规则实际求值、firing/resolved 通知和故障时业务结果保持不变；受控验证不替代生产容量验收。
