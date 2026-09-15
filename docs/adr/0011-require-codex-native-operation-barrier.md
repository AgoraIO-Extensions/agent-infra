# ADR: Codex 原生操作必须经过持久执行屏障

## 状态

已完成独立架构评审，用于 [#508](https://github.com/AgoraIO-Extensions/agent-infra/issues/508)
的实现；补丁、产物与合入遵循仓库当前提交的审查门禁。

## 背景

PRD 要求实际外部操作前持久保存意图，并区分真实结果与 unknown。固定 Codex 的
PreToolUse 在命令失败时可能继续工具；一次 hook 还不能覆盖原生内部 retry、非空 stdin
及后台完成。普通审批和单向开始通知无法承担全部实际尝试的业务授权与持久确认。

## 决策

按工程 Spec 的
[Codex 上游原生补丁与执行屏障](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1011-codex-上游原生补丁与执行屏障)
采用固定上游源码的受控 vendor patch，在原生真实执行边界增加必须等待的 Driver permit
和结果持久确认。原工具实现、推理循环与文件隔离继续由同一 native 进程承担，TypeScript
Driver 保存意图/结果并消费既有 Host 授权；协议与恢复由
[Runtime HLD 8.5.1](../architecture/HLD-agent-runtime-M1.md#851-codex-原生执行屏障)定义。

## 取舍

保留原生能力与原 Session 的代价是维护小范围上游 Rust 补丁、派生 artifact 的供应链，以及
每次上游更新的路径覆盖和兼容验证。原生构建不能继承官方 binary 的签名或验收；增加的
持久确认延迟由性能基线测量。候选失败仍自动以旧 Digest 新建期望修订并实际调谐、验证；
只有旧修订实际恢复也失败后才关闭路由并保留原数据，不能预先跳过恢复尝试，也不能以
放宽业务屏障使缺少该能力的旧 binary 通过准入。

仅修 hook 失败处理仍漏实际尝试；更改 namespaced dynamic tool 会改变 catalog、交互和旧
Session 语义；移除 built-ins 不满足现有正向 conformance，因此都不作为本方案的替代。

## 维护与退出

Codex Driver 与模板的现有维护归属同时负责 patch、构建 provenance、coverage、原生回归及
安全更新。正式上游出现等价的强制每 attempt 接口后，以独立升级评审和相同故障矩阵验证
替代，移除已无必要的 patch；不长期复制完整上游产品或建立通用 Fork 平台。
