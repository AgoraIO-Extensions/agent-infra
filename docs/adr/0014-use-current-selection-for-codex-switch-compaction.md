# ADR: Codex 模型切换压缩使用当前有效选择

## 状态

已接受工程实施范围，归属 [#508](https://github.com/AgoraIO-Extensions/agent-infra/issues/508)。
本差额已完成独立架构、安全、维护及产品一致性评审；真实模型兼容性、原生产物和
完整模型切换仍须按下述验证要求验收。

## 决策

固定 Codex 的模型切换前置压缩会选择上一模型 A，而本次 Execution 已冻结并只授权 B。
采用在原生调用点显式选择 B 的受控补丁，使模型切换所需 local pre-turn compaction 和
后续回答遵循同一本次有效选择，保留原 Session 和原生压缩算法。范围包括
CompHashChanged 与 ModelDownshift；仅处理其中一路不能算完整修复。具体契约只在
[工程 Spec 10.8](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#108-codex-原生模型传输边界)和
[Runtime HLD 8.5.2](../architecture/HLD-agent-runtime-M1.md#852-codex-模型切换前置压缩)维护。

## 取舍

该策略保持 PRD 中下一条消息应用新选择、无需新建会话及删除旧选项后使用默认选项的语义，
不增加旧 A 授权或要求旧凭据继续可用。代价是维护固定上游两类触发的调用点差额，并证明
B 能处理原 Session 历史与窗口差异。

上游特定 backend/provider 的当前模型 remote fallback 说明原生设计并非绝对依赖 A，
但不能证明本部署 local provider 接受跨模型 reasoning/加密历史。授权、协议和禁止事项
遵循[工程 Spec 10.8](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#108-codex-原生模型传输边界)，
完整验证矩阵见[Runtime HLD 第 11 节](../architecture/HLD-agent-runtime-M1.md#11-验证)。
若兼容性不足需要改变上位契约，仍须报告未决差额并重新评审。

## 维护与退出

沿 Codex Driver 与模板的现有维护归属、同一 primary Issue 和实现 PR 交付。
原生 source/patch/tree、产物、安装校验、许可与安全更新仍遵循
[工程 Spec 10.11](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1011-codex-上游原生补丁与执行屏障)。
升级时重验两类调用点、profile/窗口、历史和恢复算法及当前选择约束；上游具备满足这些
要求的路径时，以相同模型选择与故障矩阵验证替代并移除差额，不保留无必要的兼容层。
