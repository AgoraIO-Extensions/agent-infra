# Codex upstream metadata

本目录保留固定官方 Codex release 的上游许可证、NOTICE、仓库属性和历史协议资料。
原生能力缺口的处理以[工程 Spec §10.11](../../../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#1011-codex-上游原生补丁与执行屏障)为准。
旧的 [callback V1](callback-v1.md) 和 [callback V2](callback-v2.md) 属于历史协议记录。

当前 Runtime 使用的官方 release 由 [release pin](../../../../packages/agent-runtime/src/codex-release.json)
固定。这个 pin 以及本目录的元数据都不代表原生运行时验收已经完成。
执行屏障边界见 [ADR 0011](../../../../docs/adr/0011-require-codex-native-operation-barrier.md)，
模型切换压缩边界见 [ADR 0014](../../../../docs/adr/0014-use-current-selection-for-codex-switch-compaction.md)。

## 许可证和 NOTICE

- 上游 Apache-2.0：[UPSTREAM-LICENSE](UPSTREAM-LICENSE)
- 上游 NOTICE：[UPSTREAM-NOTICE](UPSTREAM-NOTICE)
- 第三方许可证：`licenses/` 目录中的原始文件

许可证文件保持上游原始字节，不修改共享 Cargo registry 或外部 `rmcp 3.1.3`
源码。
