# ADR-0039：原生命令目录与 Goal 生命周期接入

## 状态

提案，归属 [#4045](https://github.com/AgoraIO-Extensions/agent-infra/issues/4045)。
本提案需要负责人评审，采纳后先同步受影响的 PRD、工程 Spec 和 Runtime HLD，再实施新增合同。
提案不代表 `/compact` 或 `/goal` 已在真实 Web 会话中可用。

## 问题

会话页此前只能调用旧版只读命令与 Skill；本次实现补齐 Codex 有状态命令的 compact 消费链，仍保留
Goal 生命周期缺口：

- Codex Driver 的 `readNativeMetadataV2` 提供 `compact`、副作用与参数声明；公开目录读取已增加
  显式 `projectionVersion=2` 读取并传递该投影。
- 默认 Platform API assembly 已接入 Invocation V3：服务端复核目录、原 Session、配置、Key 引用与
  有效选择，再通过 Core/Store V6、Worker、Host 和 Driver 交付；旧 V1/V2 仍保持原义。
- Web 的命令模型按 effect/parameters 展示有状态命令，并在模型选择已保存时准备 V3 请求。
- `/goal` 所需的目标管理与自主后续 Turn 尚无平台生命周期合同。

现有依据为[平台 PRD §11.3](../prd/PRD-agent-platform-M1.md#113-原生命令与已安装-skill)、
[工程 Spec §11.4](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#114-原生命令与已安装-skill-边界)
及 [Runtime HLD §5](../architecture/HLD-agent-runtime-M1.md#51-命令与-skill-目录及调用)。

## 固定版本依据

Codex `0.153.0`，官方 commit `41e22fee981a63b3698df7ed36bad393cda24715` 的
[app-server 合同](https://github.com/openai/codex/blob/41e22fee981a63b3698df7ed36bad393cda24715/codex-rs/app-server/README.md)
提供 `thread/compact/start`、`thread/goal/set`、`thread/goal/get`、`thread/goal/clear` 以及目标更新通知。
Goal 是线程持久状态，原生运行可以继续产生 Turn；设置目标的 RPC ACK 不能表示目标已经完成。

Paseo `01888dc5deb7c964491f784f260cb64378a7c4ed` 的
[Codex Provider](https://github.com/getpaseo/paseo/blob/01888dc5deb7c964491f784f260cb64378a7c4ed/packages/server/src/server/agent/providers/codex-app-server-agent.ts)
将 `compact` 与 `goal` 注册为命令，并将 `goal` 的目标文字、`pause`、`resume`、`clear` 分别映射到
上述 RPC。它的最低版本探测和 `--enable goals` 是该 Provider 的兼容策略，不能直接当成本仓固定
版本的启用合同。Paseo 的 out-of-band 调用也不能替代本平台的持久受理和当前业务授权。

## 建议决策

### 一、接通已有 compact 合同

1. 保留 V1 目录和严格解析。显式协商的 commands V2 读取已贯通公开入口、生成 Client、API、Worker
   和 Host；旧 admission 仍明确拒绝它。版本纳入读取请求、签名与响应核对，不能把
   `state_changing` 投影成 V1 的 `read_only`。
2. 沿用原 `native_metadata_read` 的主体、Agent、Conversation、原 Execution、generation、原 Host
   配置和请求期限。读取 V2 不恢复会话、不创建 Turn、不安装业务 Key；各 await 边界继续当前授权复核。
3. 默认 API assembly 新增 V3 admission adapter：由服务端解析当前目录项、原 Session、配置、Key 引用
   与有效选择，并复用既有 Core/Store V6 事务和 outbox。调用方只提交能力身份、目录修订、参数和明确的
   模型选择；不能提交 effect、native ID、Key 或 Grant。旧 V1/V2 请求保持原义。
4. Web 按真实 effect 和参数声明显示选项及确认内容；有状态命令准备 V3，冻结当前有效 modelOptionId
   和 reasoningLevel，模型选择尚未保存时不可提交。参数、附件与版本缺失分别拒绝，不转成普通消息。
5. `compact` 以同一原操作的 contextCompaction item 和 Turn 终态完成，继续使用现有停止、租约、事件
   游标及 unknown 核实路径。重复提交、刷新、断连和进程重启均不再次发出压缩 RPC。

这部分是现有有状态命令合同的消费者交付，可以先于 Goal 完成；真实浏览器发现与压缩终态仍需独立验收。

### 二、明确 Goal 的产品状态与执行边界

建议保留用户可见的 `/goal <目标>`、`/goal pause`、`/goal resume`、`/goal clear`，使用真实原生接口。
目标文字、状态、预算及使用量按会话正文的同一权限读取；平台保存已受理目标及操作事实，原生 Goal 状态
作为运行事实回读。状态变化和后续 Turn 必须关联同一原主体、Agent、Conversation、generation 和 Goal 操作。

建议将一次活跃 Goal 作为一个持续运行的父 Execution，其原生后续 Turn 按序持久关联到该 Execution。
每次模型和工具 I/O 继续使用该 Execution 的当前授权屏障、冻结模型/Key、文件与 Connection 边界。
任一普通 Turn 完成不释放父 Execution 的会话占用；只有可靠 Goal 终态、确认暂停/停止或其他既定终态
才能收敛。原生事件无法唯一关联到父 Execution 时保持待核实，不接收未受理的自主工作。

启动或恢复前须明确有效 token 预算和部署上限，回读原生的预算限制、使用量限制与 blocked 状态。
更改目标、模型、Key 或预算走独立持久操作，不能在后续 Turn 中静默继承当前页面的新选择。

### 三、Goal 控制和恢复

- 活跃 Goal 的 `pause`、`clear` 与现有停止入口需要独立控制合同，绑定原父 Execution。先抑制后续
  原生续跑，再核实在途 Turn 是否结束；暂停 ACK 不等于已经没有在途副作用。普通新命令与排队消息的
  原规则保持，Goal 控制例外须先写入 PRD 和工程 Spec。
- `resume` 需要当前新业务授权，并使用已确认暂停的原 Goal。恢复读取与事件核实不授予业务续跑权限。
- `goal/get` 和原事件只读取当前状态及原操作事实。响应丢失后，当前目标文字相同或 `updatedAt` 接近
  不能证明原调用成功；缺少可靠关联时保持 unknown，不盲重放 `goal/set` 或 `goal/clear`。
- Worker/Host/原生进程重启后先恢复原 Goal、父 Execution、子 Turn 和操作关联；不能创建替代线程，
  也不能因原生 Goal 仍 active 就跳过平台当前授权。现有共享消息队列和 outbox 继续是唯一调度路径。

## 实施与验收顺序

1. 输入框先修正斜杠名称、参数保留和无法确认命令时的误发行为；路径文本继续走普通消息。
2. commands V2 端到端读取、默认 V3 admission、V6 Host/Driver 交付与 Web 调用已完成代码装配；真实
   Runtime 和浏览器正向/负向验收仍按下表独立执行。
3. 负责人确认 Goal 的父 Execution、预算和活跃控制语义，更新正式文档后再实现 Goal 合同。
4. 分别验证真实 Runtime 与同一浏览器页的发现、选择、确认、原生终态和刷新恢复；覆盖过期/撤权、
   跨主体/会话、stale 目录、模型/Key 变化、重复提交、断连、重启与 unknown 不重放。

单元测试、受控浏览器 fixture、固定官方二进制和真实部署分别保留证据；接口存在、菜单可见或普通模型
回答不签署原生压缩、Goal 自主续跑或完整四模板验收。
