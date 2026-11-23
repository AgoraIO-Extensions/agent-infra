# 以用途受限的服务身份续做标准模板发布

状态：工程 Spec §10.4.2 已批准；实现随本变更评审。

模板目录更新必须覆盖已有 Agent，部署进程退出也不能遗失升级进度。人工单 Agent 发布
继续遵循 [ADR-0013](0013-isolate-standard-template-release-authority.md)；自动发布的完整规则
只在[工程 Spec §10.4.2](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1042-标准模板自动发布)维护。

选择将发布授权、分页断点和逐目标结果保存于 Platform DB，由现有 Worker 消费 outbox。
真实管理员批准精确目录发布，专用部署服务身份执行；不伪造管理员会话，不向 Owner 或
Runtime 下放发布权。复用 V2 扇出及逐 Agent 配置事务，保留 CAS、幂等、审计与恢复边界。

代价是部署必须交付可撤销的服务认证和发布绑定，并在切换目录前准备、两端确认后激活。
目录激活与配置提交共用排序边界，发布 lease/fence 与目标结果在原事务中核对和保存。
停止态只推进期望，运行态验证与回滚结果另外读取；配置受理不等于 Workload 已 Ready。
