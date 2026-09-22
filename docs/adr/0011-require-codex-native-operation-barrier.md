# ADR: Codex 原生操作必须经过持久执行屏障

## 状态

已接受；执行前持久意图、当前授权和可靠结果确认的要求继续有效。M1 使用固定官方 upstream release
与 Native Driver/Adapter；本 ADR 原先选择的本仓 vendor patch 和派生构建交付方式由
[工程 Spec §10.11](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1011-codex-上游原生补丁与执行屏障)
替代，不构成继续维护第三方源码补丁或 vendor builder 的批准。

## 背景

PRD 要求实际外部操作前持久保存意图，并区分真实结果与 unknown。普通审批和单向开始通知
不能证明全部原生尝试已在执行前通过当前授权；一次 hook 也不能证明覆盖内部 retry、非空
stdin 及后台完成。固定官方 release 的协议可用不等于存在私有 callback 或完整的屏障能力。

## 决策

标准路径固定官方发行物的 provenance、协议/Schema 和精确产物，由 TypeScript Native
Driver/Adapter 消费上游接口，保留原推理循环、工具与文件隔离。普通官方路径不探测或宣称
不存在的私有 barrier；缺少可靠执行前控制边界的操作不得准入，也不能宣称通过相应 conformance。

明确启用私有 FD callback、Connection bootstrap/recovery 或等价 native lane 时，必须先验证
该 target 的 provenance、协议/Schema、工具覆盖和不可由模型/Owner 关闭的 native barrier。
每次实际尝试先等待 Driver 持久 intent 和当前 Host 授权，结果或 unknown 可靠保存后才交付；
缺失或无法验证时 fail closed。状态、恢复和测试要求以
[Runtime HLD §8.5.1](../architecture/HLD-agent-runtime-M1.md#851-codex-原生执行屏障) 与
[§11.2](../architecture/HLD-agent-runtime-M1.md#112-codex-与-connection-接缝验收) 为准。

## 取舍

官方 release 路径免除本仓维护第三方原生源码与构建链的负担，但上游能力缺口必须如实记录。
普通 approval、许可缓存、非强制 hook 或移除 built-ins 不能代替所需执行边界，也不能缩减
PRD 的正向能力和真实事实要求。官方路径与私有 lane 的验证证据不能互相转移。

候选失败仍自动以旧 Digest 新建期望修订并实际调谐、验证；只有旧修订实际恢复也失败后才
关闭路由并保留原数据。原执行要求的屏障、状态兼容或隔离不满足时，禁止降级或重新发起
副作用；已持久终态仍可按原授权读取。

## 维护与退出

缺少上游接缝时优先提交 upstream contribution。任何 derived/private artifact 的引入必须先
完成独立架构、安全、供应链和维护评审，明确来源、产物证明、维护责任与退出路径；本 ADR
不授权恢复第三方源码补丁、vendor builder 或下载编译流程。正式上游具备等价能力后，按
同一故障矩阵验证并更新 pin，不长期复制上游产品或建立通用 Fork 平台。
