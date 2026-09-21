# Codex vendor metadata

本目录记录 #508 原生执行屏障交付所需的冻结 vendor 元数据。本次切片只包含
上游许可证、NOTICE 和仓库属性；源码补丁、构建输入、loader、probe manifest
及验证入口会在后续有序切片中加入。

当前仓库消费的派生产物由 [release pin](../../../../packages/agent-runtime/src/codex-release.json)
固定。这个 pin 以及本目录的元数据都不代表原生构建或最终运行时验收已经完成。
执行屏障边界见 [ADR 0011](../../../../docs/adr/0011-require-codex-native-operation-barrier.md)，
模型切换压缩边界见 [ADR 0014](../../../../docs/adr/0014-use-current-selection-for-codex-switch-compaction.md)。

## 许可证和 NOTICE

- 上游 Apache-2.0：[UPSTREAM-LICENSE](UPSTREAM-LICENSE)
- 上游 NOTICE：[UPSTREAM-NOTICE](UPSTREAM-NOTICE)
- 第三方许可证：`licenses/` 目录中的原始文件

许可证文件保持上游原始字节，不修改共享 Cargo registry 或外部 `rmcp 3.1.3`
源码。后续切片加入的 patch、构建输入和验证材料会在其自身落地后再由完整消费
文档引用，避免中间提交产生失效链接。
