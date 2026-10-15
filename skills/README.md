# Skill Hub project sources

这里保存可提交到 Skill Hub 的项目快照源。它们不是固定 Runtime `extraRoot` 包；发布必须通过已授权的 Skill Hub 项目快照流程，生成不可变 ZIP、manifest、来源证明、扫描回执和签名。

- [`agent-builder`](agent-builder/README.md)：从 Compose 或授权代码仓库生成 Dockerfile 与受限 multi-service YAML，并经 Pull Request、镜像 Digest 和平台 API 创建或升级 Agent。
