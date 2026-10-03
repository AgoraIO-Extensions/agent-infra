# 为缺失 Workload 重建 Secret 物化

StatefulSet 缺失后，已激活 Secret 的 fence 仍指向原 Workload UID，不能授权新实例。
选择在 Platform DB 的候选 Workload 中持久保存独立恢复物化，复用既有调谐、可信解密、
不可变 Secret、身份绑定和验证提升流程；完整规则只在
[工程 Spec 第 10.6 节](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#106-环境变量与-secret)
维护。

该选择保留原 Secret 密文与激活事实，使恢复运行资源可以重入；代价是 Workload 必须保留
后续配置、回滚与清理所需的物化映射。原 Secret 的 UID 门禁继续有效，不能只靠调整操作
顺序或重绑旧 fence 接纳新 StatefulSet。该变化不增加公开 API、密文格式或 Connection
凭证能力，也不改变原任务的恢复与授权规则。
