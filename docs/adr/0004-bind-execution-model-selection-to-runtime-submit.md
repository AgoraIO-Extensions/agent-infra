# 将 Execution 有效模型选择绑定到 Runtime submit

Platform 在接受消息时固化该 Execution 的有效 `modelOptionId` 和 `reasoningLevel`。RuntimeHost submit V2 把版本化选择作为 `RuntimeInputV1` 之外的必填对象传给 Host 和 Driver；Host 将其纳入请求摘要，但不查询 ModelCatalog 或解析 Platform 默认值。Driver 只按 Agent Pod 已装配的 active Runtime 配置映射并在原生执行入口显式应用选择；无法映射或原生 Runtime 明确拒绝时返回稳定、脱敏的 unsupported 结果，不能静默回退。

原 submit V1 在兼容期保持可执行和可恢复。由于原生 per-turn override 可能影响后续 Turn，V1 Driver 每次提交都显式应用已配置的默认模型和 reasoning。新接受的 Execution 使用 V2；V1 的退役由后续 breaking-change 决策处理。

## Considered Options

- 在 V1 增加可选 selection：拒绝，因为可选字段不能保证新 Execution 携带已固化选择，且会保留静默默认路径。
- 把 selection 放入消息 input：拒绝，因为模型选择不是用户内容，不能进入消息正文、附件或 Runtime prompt。
- 由 RuntimeHost 查询 ModelCatalog 或 Platform 默认项：拒绝，因为这会反转依赖方向，并使重试结果随 Platform 当前状态漂移。

## Consequences

V1 Contract 和产物保持不变；V2 submit、Driver command、JSON Schema 和 OpenAPI 独立发布并进入漂移与兼容检查。Host 的幂等记录绑定完整选择；相同 Execution 的选择变化返回冲突。各 Driver 必须提供 active option 到原生模型的封闭映射、验证 reasoning，并用 conformance 证明转发、重放、冲突、不支持和相邻 Execution 隔离。
