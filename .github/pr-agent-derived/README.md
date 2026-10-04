# PR-Agent plain-diff Derived Runtime

本目录保存 Issue #1304 的最小上游兼容补丁。补丁只为 `PlainDiffGitProvider` 保留已解析文件；
GitHub provider 过滤、token cap、required checks、Publisher 隔离和 Coverage 校验保持不变。

补丁基于固定官方镜像实际源码 commit `46d7ee02b77bc1f323c327e32be4ee70e4cd306a`（其
`language_handler.py` SHA-256 为 `37453385f735cc3e14cbe531a5768e82ad0ce9bd583e97652adbe32cb4d94637`）
和镜像 `sha256:548b760b81ab4b3f729182428695ccc1194bbf87528c2b1e2b2b07e5223af7b6`。补丁文件
SHA-256 为 `cedefb366a7ea4dd32a7ab944eed3bd47320a9e023b46b108470ca2e7b8e8257`。

Dockerfile 会校验三个上游源码摘要，使用标准 `patch` 工具应用唯一补丁，编译被修改的 Python
模块，然后移除构建工具。镜像必须带 OCI provenance/SBOM attestation 构建；获批构建发布并回读
新的 digest 前，不在此记录伪造值。现有 workflow 继续使用官方镜像，直到 digest 和 native receipt
被接收。

补丁给语言排序增加显式 `preserve_all_files` capability，只有 `PlainDiffGitProvider` opt in；
其他 provider 继续使用默认过滤路径。该目录不包含 recorder、Publisher 或第二调度器。
