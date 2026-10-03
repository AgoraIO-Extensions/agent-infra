# 按 Execution 绑定标准模板 Relay Key

## 状态

已确认产品与工程契约，归属 [#886](https://github.com/AgoraIO-Extensions/agent-infra/issues/886)。实现和真实链路验收尚未完成。

## 决策

标准模板保留既有 ModelCatalog、固定 Driver、模型选项和单一任务循环，但不再把每个选项的 Key 注入长期 Agent Pod。Agent 默认 Key 用于所有 Platform API 与 Eval 调用；Web/企微使用实际发送者在 Agent Infra 接入的个人 Key。受理时把 Key 用途、密文引用和版本与 Execution 一起固定，Worker 在当前授权下解密并按执行交付 Host。当前 Key 替换不改写旧执行，不能自动回退到另一主体的 Key。

产品规则以 [Platform PRD 第 8 节](../prd/PRD-agent-platform-M1.md#8-标准模板的模型配置)为准；版本、交付、恢复与旧 V2/V3 配置迁移以[工程 Spec §10.7](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#107-标准模板模型配置)和[Runtime HLD §5](../architecture/HLD-agent-runtime-M1.md#5-platform-conversation-contract)为准。

## 取舍与兼容

个人 Key 使同一 Agent 的 Web/企微调用按实际发送者在 Relay 的权限与额度执行；代价是执行期交付与旧版本密文保留。沿用旧 Pod 静态 Key 会把不同使用者的调用归到同一付费主体，且无法保证替换后旧任务固定 K1。只把个人 Key 存入 Agent env 也不能满足隔离或重启恢复。

此前 [ADR 0009](0009-bind-model-profiles-to-runtime-configuration.md) 中的每选项 Secret 绑定仅记录旧 V2/V3 实现；其目录 profile、固定 Driver 和不可猜测协议的决策继续适用。本决策替换静态凭证交付部分，不重写历史配置或把旧版本默认为新格式。四模板逐项真实验证后才能开放申请，Relay 模型列表可见不等于一次实际调用成功。

## 维护与退出

优先在现有 Store/Worker/Host/Driver 边界与版本化 Contract 中实施，复用原有授权、调谐、幂等和停止屏障。Key 交付、恢复和隔离须有跨用户、Agent、Execution、渠道及版本的负向证据；完成迁移前旧配置不接纳新业务执行。若 Relay 将来提供受限令牌交换，须另行评审后才能移除个人 Key 存储，不预先建立第二套代理或 Agent Group 权威。
