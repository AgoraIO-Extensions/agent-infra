# ADR-0057：官方 SDK 优先，以 Hermes 为基线统一消息渠道行为

## 状态

待文档评审，关联 [Spec #4580](https://github.com/AgoraIO-Extensions/agent-infra/issues/4580) 与
[文档任务 #4582](https://github.com/AgoraIO-Extensions/agent-infra/issues/4582)。
本 ADR 修订 [ADR-0033](0033-in-flight-messages-wecom-ordering-and-streaming-progress.md) 的企微默认模式、
附件合并窗口、`/new`、流式收口与主动最终结果取舍；既有 Web 默认、持久等待和 supplementary 幂等责任保留。

## 背景

企微已有官方 SDK，但输入合并、忙时消息与回复生命周期仍分散在平台自有逻辑中，未来渠道容易重复维护。
Hermes 提供相近的交互行为，然而其 Adapter、共享 Base、busy 与 stream consumer 依赖宿主配置及会话设施，
不能直接视为独立稳定的 TypeScript 渠道 SDK。移植行为需要持续维护，不能承诺零维护。

## 决策与权威

- 保持 TypeScript。当前企微继续精确固定 `@wecom/aibot-node-sdk@1.0.7`，连接、认证、ACK 与媒体协议优先交给官方 SDK。
  SDK 不负责平台业务授权、Conversation/Execution 和最终交付判断；不另写一套底层 WebSocket 协议。
- SDK 未覆盖的交互行为按下述固定 Hermes 源码移植到 Platform Core 的同一 Channel 内部模块。
  入口负责协议接入与装配，Store 提供用例事务，不新增空 workspace package、渠道微服务或第二套执行器。
- 企微先采用，未来获准 IM 复用共用行为并分别核查成熟 SDK 与真实能力；本次不接入新渠道。
  不引入 Python sidecar、完整 Hermes Runner、OpenClaw 宿主兼容层或其他未经确认的渠道快捷命令。

一个结论只在以下文档中完整定义，本 ADR 记录取舍和来源，不能覆盖它们：

| 权威 | 内容 |
| --- | --- |
| [平台 PRD §10.3、§10.5](../prd/PRD-agent-platform-M1.md#103-企微会话) | IM/Web/API 默认、个人当前会话模式、停旧清队、历史与用户结果去向 |
| [工程 Spec §12.5](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#125-执行中消息的补充指令与排队)、[§14.2](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#142-企微) | 策略/持久批次、跨轮次前驱、旧内容关闭、累计流、唯一最终结果及能力门禁 |
| [Runtime HLD §8.1](../architecture/HLD-agent-runtime-M1.md#81-消息与命令幂等) | 原子受理/stop、lease/fence、取消屏障、未知接受结果与真实终态 |
| [企微部署](../architecture/WECOM-text-deployment.md#共用执行与回复) | 装配、固定提示、分传输的窗口/主动能力证据和验收资源 |
| [CONTEXT](../../CONTEXT.md#渠道会话) | 渠道绑定、渠道会话、忙时模式等领域词汇 |

## 固定来源与采用范围

Hermes 基线为提交 `ccd8fab2fa1d830a46cfeefe47c155d5d6a9aeea`。下表是行为来源映射，
不是已完成移植、上游测试通过或真实企微验收的声明：

| 来源 | 采用或对照内容 |
| --- | --- |
| [wecom/adapter.py](https://github.com/NousResearch/hermes-agent/blob/ccd8fab2fa1d830a46cfeefe47c155d5d6a9aeea/plugins/platforms/wecom/adapter.py#L112) | 长片段判定、文本/附件静默默认值及合并；具体阈值统一见工程 Spec §14.2.4 |
| [platforms/base.py](https://github.com/NousResearch/hermes-agent/blob/ccd8fab2fa1d830a46cfeefe47c155d5d6a9aeea/gateway/platforms/base.py#L2419) | 共享合并、刷新定时器、flush 所有权与 dispatch 取消竞态；上游没有持续输入下的总等待保证，平台需另行固定并验证上限 |
| [session_busy_controls.py](https://github.com/NousResearch/hermes-agent/blob/ccd8fab2fa1d830a46cfeefe47c155d5d6a9aeea/gateway/session_busy_controls.py#L45)、[run_busy.py](https://github.com/NousResearch/hermes-agent/blob/ccd8fab2fa1d830a46cfeefe47c155d5d6a9aeea/gateway/run_busy.py) | interrupt/steer/queue 与 reset；平台 `/busy` 参数接口由 PRD 确定，不宣称复刻上游全部聊天命令 |
| [streaming.py](https://github.com/NousResearch/hermes-agent/blob/ccd8fab2fa1d830a46cfeefe47c155d5d6a9aeea/plugins/platforms/wecom/streaming.py#L20)、[stream_consumer_transport.py](https://github.com/NousResearch/hermes-agent/blob/ccd8fab2fa1d830a46cfeefe47c155d5d6a9aeea/gateway/stream_consumer_transport.py#L425) | 每 Turn 固定回复上下文、累计帧、pending ACK 跳帧、final 收口/取消竞态；乐观成功及异常主动回退不直接采用 |
| [send_queue.py](https://github.com/NousResearch/hermes-agent/blob/ccd8fab2fa1d830a46cfeefe47c155d5d6a9aeea/plugins/platforms/wecom/send_queue.py#L14) | 普通/控制发送预算；上游常数是实现策略，真实供应商额度须另验 |
| [官方 SDK 1.0.7 发布元数据](https://registry.npmjs.org/@wecom%2faibot-node-sdk/1.0.7)、[官方仓库](https://github.com/WecomTeam/aibot-node-sdk) | 固定 SDK 公共接口、ACK/stream/媒体能力；方法存在不证明当前目标可主动发送 |

未选用的替代方案：Chat `4.45.0` 与 `@agentor/chat-wecom@0.1.3` 在模拟协议中缺少 native stream、
最终发送 ACK 和逐消息回复上下文；修补这些缺口仍需自行维护。
其[固定源码](https://github.com/DemoMacro/agentor/blob/6248fcc6b09821cfc2fb7bc50ef16eec1526e756/packages/chat-wecom/src/adapters/bot-websocket.ts)
仅作为该版本的选型依据，不否定未来升级后的重新评估。
官方 `@wecom/wecom-openclaw-plugin@2026.10.30` 依赖 OpenClaw 宿主路由、回复与 runtime，
其[固定发布包](https://registry.npmjs.org/@wecom/wecom-openclaw-plugin/-/wecom-openclaw-plugin-2026.10.30.tgz)
不构成可直接接管本平台 Channel 的独立 SDK。

## 平台保留差异

| Hermes 基线或实现选择 | 平台取舍及原因 |
| --- | --- |
| pairing/allowlist/profile、可共享线程 | 公司身份、Agent 使用权及群/线程按发送者隔离仍由平台服务端解析；Connection 独立授权不变，见 [Connection PRD §6](../prd/PRD-connection-M1.md#6-principalconsumer-与授权) 与 [HLD](../architecture/HLD-connection-M1.md) |
| shared durable admission 与 legacy 内存 pending 并存 | 复用 Platform DB 的唯一 Execution FIFO、stop 与跨轮次前驱；不用纯内存接受替代可靠受理 |
| 本地媒体缓存与宿主凭证 | File Authority 及 Worker-only 加密凭证继续生效，不向模型或 Runtime 交付原始渠道凭证 |
| final ACK 超时/版本冲突的乐观成功，普通被动异常尝试主动发送 | 无可靠受理证据保留 unknown，不盲目重发；同一业务回复的被动/主动 final 互斥 |
| 流式安全阈值、可选 keepalive 及进程内发送预算 | 不充当官方窗口或群聊主动能力证明；窗口与业务期限分离，实际能力须绑定目标及配置修订验证 |
| 非 TUI 默认 interrupt | 仅改变企微及后续 IM 默认；Web 补充优先、API 有界等待和现有部署单元不变 |

## 验证与维护后果

按固定输入/输出 trace 对照合并、忙时控制、累计流和 final 行为；时间、随机 ID 和路径规范化，
批准的平台差异单独断言。升级同时审阅 shared Base、busy、consumer 与企微 plugin，联动修复不能只移植一半。
复制或实质移植代码时保留上游 [MIT 版权及许可](https://github.com/NousResearch/hermes-agent/blob/ccd8fab2fa1d830a46cfeefe47c155d5d6a9aeea/LICENSE)，SDK 与第三方依赖另核许可。

文档评审只解除权威冲突。后续实现需通过持久事务、崩溃恢复、跨主体负向和固定协议对照检查；
真实私聊/群聊、两类回调、主动范围、时窗及限额按部署说明独立留证。模拟通过不表示已部署或终端送达。
连接移交/回退保留原输入、前驱和发送账本，不能让旧代码清空新状态后继续处理。
