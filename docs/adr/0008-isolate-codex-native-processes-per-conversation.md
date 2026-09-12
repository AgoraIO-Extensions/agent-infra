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

Darwin 上不采用外层 `sandbox-exec`。pinned 版本在 macOS 通过 `/usr/bin/sandbox-exec` 执行工具，实测只要
外层 profile 含任何具有约束力的规则，内层 `sandbox_apply` 即失败；那会让工具普遍不可用，正好构成本票
禁止的假通过。改用原生权限 profile 后，Linux 经 Landlock、Darwin 经 Seatbelt 由同一份配置生效，边界与
工具可用性同时成立，Linux 的 `setpriv` 启动准入探针保留不变。

profile 以 session flag 注入而不落盘：持久 `CODEX_HOME` 中出现配置或凭证文件仍然拒绝启动，配置来源也
继续限定为 session flag。Conversation 根 `deny`、本 Conversation `home` 只读、`workspace` 可写，使模型工具
既保有本人读写，又不能写入原生配置、skills 与历史。

准入改为按进程执行：每个原生进程独立验证 provenance 与受限配置，Driver 打开时不再预启动进程。代价是
部署配置错误在首个 Turn 才暴露，收益是任一进程都不能借另一进程的准入结果获得信任。

不改变部署单元、Runtime Contract、Grant 校验与 §10.8 的模型传输边界，也不引入平台统一 Sandbox。隔离
门禁只能由包含本修复的版本在真实 pinned Codex 上跑出的验收证据解除。
