# Trusted chunk coverage shadow

本包是工作流 Spec §7.3.1 的 TypeScript、job-local recorder 与 shadow verifier 边界。

`buildGitInventory` 在不 checkout、不执行 PR 代码且不加载配置、attributes 或 external diff 的条件下读取不可变的
`merge-base..head`。生产 `JobLocalRecorder` 只接受当前部署的 Responses JSON 或 Responses SSE，
从实际输入中提取 unified diff，逐文件、逐 hunk 核对后原样转发；同一 logical chunk 共用 retry 预算，
并在等待网络前预留最多三个 chunk。官方响应必须完成，并且能解析为唯一顶层 `review` 的 YAML/JSON Schema。
`serializeMetadata` 只输出有界 metadata；源码、prompt、凭证和 runtime repository path 不会持久化。

`verifyShadowMetadata` 校验同一 run/attempt、repository、head、inventory、互补 file/hunk coverage、请求和响应摘要、
合并输出摘要以及 runtime identity。它只是 shadow consumer，不发布或替代现有 required Coverage check。
共享 workflow 的 producer/job output 与最终接线由 #1304 串行接收；默认分支 hosted 正负验证完成前不会启用分块判据。
