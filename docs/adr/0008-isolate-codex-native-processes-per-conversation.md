# 按 Conversation 隔离 Codex 原生进程与文件边界

[#404](https://github.com/AgoraIO-Extensions/agent-infra/issues/404) 的真实 pinned Codex 双用户复现表明，
同一 Agent 的两个用户共用一个原生进程时，双向都能读到对方的合成私有文件。原生 read-only 沙箱允许
全盘读取，同一 `CODEX_HOME` 也让历史彼此可见，因此仅靠 Session 绑定、不同 `threadId` 或平台能力开关
都不能形成隔离。采用每个 Conversation 代次一个原生进程、一套持久目录，并由 pinned Codex 自身的权限
profile 施加文件边界；具体约束由
[工程 Spec §10.9](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#109-codex-原生-conversation-隔离边界)定义。

进程边界是必需的：文件权限对同一运行身份无效，而 Landlock 与 Seatbelt 都按进程施加。存储键由服务端
从可信 `agentId`/`conversationId`/`sessionGeneration` 派生，使路径不能被 wire 字段选择或穿越，并让恢复
后的会话回到同一目录。

边界的施加方式按平台不同，这不是偏好而是两个实测约束的结果。

Darwin 上不能用外层 `sandbox-exec`：pinned 版本在 macOS 通过 `/usr/bin/sandbox-exec` 执行工具，实测只要
外层 profile 含任何具有约束力的规则，内层 `sandbox_apply` 即失败；那会让工具普遍不可用，正好构成本票
禁止的假通过。因此 Darwin 采用 pinned Codex 自身的权限 profile，以 session flag 注入而不落盘：持久
`CODEX_HOME` 中出现配置或凭证文件仍然拒绝启动，配置来源也继续限定为 session flag。

Linux 上不能用该权限 profile：pinned 版本明确拒绝把需要直接运行时强制的权限 profile 与
`--use-legacy-landlock` 同时使用，`thread/start` 直接 fail closed。本仓库固定 legacy Landlock 后端并以
`setpriv` ABI V5 探针做启动准入，因此改由该可信 `setpriv` 对整个原生进程施加 Landlock 边界，这也是本票
最初为 Linux 授权的做法。Landlock 规则只能增加访问、深层规则无法收窄父规则，实测确认无法“只拒绝某个
子树”，所以边界必须是 allowlist；兄弟 Conversation 目录只要不出现在 allowlist 中即不可达。Landlock
规则集可叠加，pinned Codex 仍对工具子进程施加自身策略，与 Darwin 的 Seatbelt 无法嵌套不同。

Landlock 规则路径必须是绝对路径：该 helper 在原生进程的工作目录下解析规则路径，相对条目会让启动失败
或指向另一个目录。工具运行器可能向 `PATH` 注入相对条目，因此边界只接受绝对且规范的目录。

Darwin 的 profile 使本人 `workspace` 可写、`home` 只读；Linux 保持 pinned 版本原有的原生 sandbox 模式，
不改为需要 namespace 沙箱的更宽模式——部署镜像不提供该沙箱，改宽会让工具执行失败。跨 Conversation
边界在两侧都成立，本 Conversation 内的写入能力按平台不同。无法施加边界的平台拒绝启动原生进程，
不存在无边界回退。

准入改为按进程执行：每个原生进程独立验证 provenance 与受限配置，Driver 打开时不再预启动进程。代价是
部署配置错误在首个 Turn 才暴露，收益是任一进程都不能借另一进程的准入结果获得信任。

不改变部署单元、Runtime Contract、Grant 校验与 §10.8 的模型传输边界，也不引入平台统一 Sandbox。隔离
门禁只能由包含本修复的版本在真实 pinned Codex 上跑出的验收证据解除。
