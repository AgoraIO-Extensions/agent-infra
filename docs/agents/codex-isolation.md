# Codex 原生双用户隔离验收

本入口用于 [#404](https://github.com/AgoraIO-Extensions/agent-infra/issues/404)，依据
[PRD 多用户隔离](../prd/PRD-agent-platform-M1.md#72-多用户隔离)和
[Runtime HLD](../architecture/HLD-agent-runtime-M1.md#6-数据归属与标识)。
它不批准新的隔离架构，也不替代 Pod/Pilot 验收。

## 运行

在独立测试环境使用仓库要求的 Node 24、pnpm 11，以及 Bridge 中
`CODEX_APP_SERVER_V2_PROVENANCE` 固定的原生 Codex 可执行文件。测试通过正式
`CodexRuntimeDriver.open` 和 `CodexAppServerBridge.open` 校验版本及生成的协议 Schema 摘要。
不使用个人 HOME、登录状态、API Key、真实会话或生产环境。

```bash
pnpm install --frozen-lockfile
pnpm --filter @agent-infra/contracts build
CODEX_ISOLATION_BINARY=/absolute/path/to/pinned/codex \
  pnpm --filter @agent-infra/agent-runtime exec vitest run \
  src/codex-isolation.native.test.ts
```

最终验收必须在包含 [#403](https://github.com/AgoraIO-Extensions/agent-infra/issues/403)
修复的版本运行。#403 的 source 是 `35d15abe187385672de3ac14bb2a48c37ea8e6bd`，其 squash
merge 是 `389b2b30890399270c645a32cd21ddf3a81dd41e`。入口固定核验后者可从当前 HEAD 到达，并在
报告同时记录 source 和 merge；运行时不能由环境变量替换为任意 ancestor。工作目录有已暂存、未
暂存或未跟踪改动时，总结果也保持 `unverified`。

输出 JSON 包含仓库 commit、测试源码摘要、原生版本、有效线程配置、逐场景状态及总结果。
退出码只有在所有场景通过且存在持久化版本证据时为 0。普通 `pnpm test` 未设置原生可执行
文件时会跳过该入口；跳过、模拟测试通过和普通 CI 通过均不代表隔离验收通过。

## 验证边界

- 同一 Agent 的两个合成 actor 使用独立 Conversation，经现有 Grant fixture 进入正式 Host，
  验证 Host/Driver 行为；该 fixture 只提供已验证 Grant claims，HTTP 签名验证仍由既有回归覆盖。
- 模型端是仅监听 loopback 的确定性 Responses API 替身。测试 launcher 原样转发原生协议字节，
  只通过 CLI flags 指定无凭证的本地模型 Provider，旁路观察配置和生命周期回包；不改变
  sandbox、审批、HOME、cwd、文件工具或 Bridge。模型替身不直接读写合成用户文件。
- #403 的正式装配由 `CodexRuntimeDriver.open` 从 `path` 派生 `dataDirectory: path + ".native"`，
  并传入已验证的 model、reasoning effort 和 pinned provenance。PVC 所属的 `dataDirectory/home`
  是 `CODEX_HOME`，`dataDirectory/workspace` 是 cwd；父进程 HOME 和 `TMPDIR` 仍是独立临时目录。
  关闭只清理临时 launch/probe/schema/scratch，不清理持久目录。Bridge 要求绝对规范路径、无 symlink、
  Runtime UID 私有 `0700`，拒绝与父 HOME/CODEX_HOME/cwd 重叠及持久化配置或凭证文件。
- 两个用户的文件正文使用独立随机标记，标记不进入读取请求；真实 Codex `exec_command`
  执行读取、搜索及修改。正向对照必须在工具输出与平台结果中看到本人标记；搜索使用同命令
  正向对照，修改还由测试独立回读磁盘。工具不可用或本人访问失败不能形成负向通过。
- 个人记忆保持实际配置。原生 feature 列表关闭且模型未暴露 memory 工具时，只证明该能力未
  启用。当前上下文路径另测：原 Session 历史中的本人标记、另一用户标记，以及原生 sessions
  文件通过真实文件工具进入模型输入或结果的可能性。不会为测试启用个人记忆。
- 各组双用户请求并行提交，本地模型 barrier 等待双方请求到达后才回复，防止全局串行执行
  被当成并发验收。正常关闭并重开正式 Driver/Bridge 后复用原 Host 引用和持久映射，重复场景。
- 已进入会话历史的外来标记继续算隔离失败，原因记录为 `foreign-marker-already-in-history`，
  不把它误记成当前文件操作新产生的泄漏。
- 原生观测文件仅存在于临时合成目录并在结束后清理。输出不包含 Native ID、完整协议帧、
  模型输入正文、临时目录、凭证或个人配置。

## 结果与门禁

| 状态 | 含义 | 后续 |
| --- | --- | --- |
| `pass` | 对应场景及所需正向对照通过 | 仍需检查其他场景和最终版本 |
| `fail` | 外来标记到达模型输入/结果，或他人文件被修改 | 保留 #404/#194 门禁并请求修复决策 |
| `unverified` | 未执行、前置失败、正向对照失败或证据不足 | 保留 #404/#194 门禁 |

前置 Host 正向对照失败时，报告保留后续所有场景的 `unverified`。pinned Codex `0.153.0` 在
active Turn 的 `thread/turns/list` 返回 `-32601` 是已知协议限制；#403 仅验证正常关闭后的
`thread/resume`、`thread/turns/list`、`thread/items/list` 持久化恢复，不覆盖此 active-Turn 路径。
`#404` 不得为此伪造历史回包、重发 Turn、关闭后把恢复结果当作 active status，或引入 fallback。
除非 RuntimeHost/Driver 的 fail-closed 行为获独立确认，该回包使正向控制保持 `unverified`，不
单独判定泄漏或永久缺少该接口。
脱敏报告、完整检查结果与最终 HEAD 一起放在 #404 PR/Issue，不能以“调查完成”关闭 #404。

已有回归入口为 `runtime-host.test.ts`、`runtime-driver-conformance.test.ts`、
`codex-runtime-driver.test.ts`、`codex-app-server-bridge.test.ts`，覆盖 Session 引用、Grant、
fence、事件归属、配置隔离与模拟恢复。`codex-isolation-fixture.test.ts` 只验证模型替身不会
跨 probe 注入标记且不会伪造工具输出，不能替代原生验收。

若原生历史 API 阻塞正向对照，先由维护者确认存储初始化与兼容性修复范围：在现有 pinned
版本内修正存储查询路径，或独立批准版本变更并重做 provenance、恢复和隔离验收。实际文件/上下文
失败后才讨论相应最小隔离修复。本入口不改变部署单元、Runtime Contract、进程模型或 Sandbox。
Issue #190/#322 的 Fake 交付不增加本票依赖。
