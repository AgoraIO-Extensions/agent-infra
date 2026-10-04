# PR-Agent plain-diff Derived Runtime

本目录保存 Issue #1304 的最小上游兼容补丁。补丁只为 `PlainDiffGitProvider` 保留已解析文件；
GitHub provider 过滤、token cap、required checks、Publisher 隔离和 Coverage 校验保持不变。

当前候选 source commit 为 `46d7ee02b77bc1f323c327e32be4ee70e4cd306a`，其三个文件内容与固定镜像
源码摘要匹配；完整 OCI provenance 尚未独立回读，因此这里不把候选提交写成已验证的镜像来源。
固定镜像 index digest 为 `sha256:548b760b81ab4b3f729182428695ccc1194bbf87528c2b1e2b2b07e5223af7b6`，其中
`language_handler.py` SHA-256 为 `37453385f735cc3e14cbe531a5768e82ad0ce9bd583e97652adbe32cb4d94637`。补丁文件
SHA-256 为 `2c0befeb4194fd4f866c1b7123cc7c66d5b81f7711d0ac9c512f7fff60895803`。

Dockerfile 会校验三个上游源码摘要，使用标准 `patch` 工具应用唯一补丁，编译被修改的 Python
模块，然后移除构建工具。镜像必须带 OCI provenance/SBOM attestation 构建；获批构建发布并回读
新的 digest 前，不在此记录伪造值。现有 workflow 继续使用官方镜像，直到 digest 和 native receipt
被接收。

补丁给语言排序增加显式 `preserve_all_files` capability，只有 `PlainDiffGitProvider` opt in；
其他 provider 继续使用默认过滤路径。该目录不包含 recorder、Publisher 或第二调度器。
