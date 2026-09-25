# Codex upstream metadata

本目录仅保留固定官方 Codex release provenance 所需的上游许可证、NOTICE 和仓库
属性。M1 使用经过验证的官方 upstream release；不维护第三方源码补丁、构建输入、
loader、派生二进制或下载编译流程，也不会在后续切片加入这些内容。

当前 Runtime 使用的官方 release 由 [release pin](../../../../packages/agent-runtime/src/codex-release.json)
固定。这个 pin 以及本目录的元数据都不代表原生运行时验收已经完成。
执行屏障边界见 [ADR 0011](../../../../docs/adr/0011-require-codex-native-operation-barrier.md)，
模型切换压缩边界见 [ADR 0014](../../../../docs/adr/0014-use-current-selection-for-codex-switch-compaction.md)。

## 许可证和 NOTICE

- 上游 Apache-2.0：[UPSTREAM-LICENSE](UPSTREAM-LICENSE)
- 上游 NOTICE：[UPSTREAM-NOTICE](UPSTREAM-NOTICE)
- 第三方许可证：`licenses/` 目录中的原始文件

许可证文件保持上游原始字节，不修改共享 Cargo registry 或外部 `rmcp 3.1.3`
源码。原生能力缺口按 ADR 0011 走 upstream contribution 或单独架构决策，不在
本目录恢复 vendor builder 或派生构建路径。
