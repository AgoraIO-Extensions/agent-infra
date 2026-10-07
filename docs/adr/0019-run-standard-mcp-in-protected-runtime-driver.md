# 在受保护 Runtime Driver 中直接消费标准 MCP

## 状态

架构修订候选，primary 为 [#1415](https://github.com/AgoraIO-Extensions/agent-infra/issues/1415)，
实施沿 [#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851)。先完成架构、安全与
维护评审并按现有门禁合入，再实施生产 Driver。本文不批准客户端运行、不修改 Connection
产品或部署，也不签收 token、凭据保护、Provider 行为或完整 M1 conformance。

## 决策

选择 Runtime Driver 内的 TypeScript 标准 MCP 客户端作为实际 Connection 消费方。
它直接连接完整获准 profile 的 endpoint，token 只在所属 Sandbox 的 Host/Driver 受保护
范围内读取与使用；固定官方 Codex 通过官方工具请求/结果接缝交互。原生工具响应等待原
执行的持久确认，API/Worker/Web 不取得 token，不提供 MCP 转发服务。

完整输入、保护、执行和恢复合同只在
[工程 Spec §13.5.4](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1354-runtime-driver-直接消费标准-mcp)
维护；主体/Agent token 与 Connection 独立授权仍以
[§13.5.3](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1353-secretref权威与交付边界)
为准，本文不覆盖 PRD 或放宽 [ADR 0018](0018-use-standard-mcp-with-agent-scoped-tokens.md)。

## 固定接缝与取舍

当前官方 release 由本仓 [Codex 声明](../../packages/agent-runtime/src/codex-release.json)固定。
其固定 source 已声明
[`thread/start.dynamicTools`](https://github.com/openai/codex/blob/41e22fee981a63b3698df7ed36bad393cda24715/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L135-L141)
与 [`item/tool/call`](https://github.com/openai/codex/blob/41e22fee981a63b3698df7ed36bad393cda24715/codex-rs/app-server-protocol/src/protocol/common.rs#L1652-L1656)。
动态工具字段是 experimental API，需要固定 schema 并显式 opt-in；
[工具响应处理](https://github.com/openai/codex/blob/41e22fee981a63b3698df7ed36bad393cda24715/codex-rs/app-server/src/dynamic_tools.rs#L15-L52)
等待客户端结果，再提交原生工具响应。这是可消费的官方协议事实，不证明 token 保护、
Host 持久屏障或真实运行；缺失实现与故障验证时能力保持不可用。

直接由原生 MCP 客户端保管 token 仍需证明当前 keyring/安装选择与工具文件、内存隔离；
普通 native Header、env 或 home 文件不能提供该证明。Driver 执行路径让原生不持有 MCP
token，并把实际发送与结果交付留在已有持久层可等待的边界。代价是固定官方工具接口的
版本维护、标准 MCP SDK 的供应链维护，以及 Host 秘密保护的最终产物验证；实现复用
已有标准 SDK、原 Driver/journal/授权与停止流程，不增加通用工具平台或推理循环。

初始 Linux profile 的内存准入采用实际内核
[Yama ptrace_scope](https://www.kernel.org/doc/html/latest/admin-guide/LSM/Yama.html)
限制及无特权进程约束，具体条件只由工程 Spec 定义。Host 不更改节点政策；数值或文件权限
不足以签收保护，最终工具读取、FD、诊断与故障负例必须实际通过。

本路径不声明 Codex 原生 MCP 或全部 built-in 通过
[ADR 0011](0011-require-codex-native-operation-barrier.md) 的 native barrier；
它的覆盖只属于由受保护 Driver 实际执行的标准 MCP 操作。原生断连可能得到 fallback
响应，结果保存失败或 unknown WRITE 即使已保存，均须先封闭原执行并沿原停止/隔离流程
处理，不能回复普通错误后继续。

## 实施边界

- Host 只做受保护输入、进程准入及装配；SDK、原执行映射和工具请求处理留在 Runtime Driver。
- 不升级 Codex pin、不引入 native/vendor 补丁、私有 FD3、token helper 或网络代理。
- Provider、Grant、token 签发及实际 binder/query 合同仍由独立 Connection 供应，平台只消费已发布合同；不改其代码、部署或 tickets。
- 实施源码与真实启用分开；通过
  [Runtime HLD §11.2](../architecture/HLD-agent-runtime-M1.md#112-codex-与-connection-接缝验收)
  前不启用实际用户 token，受控 fixture 不替代双系统证据。
