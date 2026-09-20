# Codex 原生强制回调 v1

这是固定上游补丁与 TypeScript Driver 的私有接缝。权威要求引用
[Runtime HLD 8.5.1](../../../../docs/architecture/HLD-agent-runtime-M1.md#851-codex-原生执行屏障)，
结构以 [JSON Schema](callback-v1.schema.json) 为准。不是公开 app-server API 或第二任务循环。

## 传输

Driver 启动 native 时用额外 stdio socket 将双向匿名 Unix stream 放在 child FD 3。
Native 在 CLI main 第一条部署初始化语句设置 `FD_CLOEXEC`，再检查 socket 类型和匿名地址，再用现有
Tokio 生命周期做可等待的 JSON exchange。没有 path/listener、配置命令、环境凭据或公开
capability；缺 FD、非 socket、可重开的具名 socket 均失败关闭。工具 exec 不应继承该 FD。
这项继承、`/proc` 同 UID 和 Darwin 隔离必须有真实负向测试，不能仅凭本设计声称无法伪造。

每帧为 UTF-8 JSON 加一个 LF，含 LF 最多 16,384 bytes；拒绝额外字段、非法 Unicode、
NUL、空字符串和不匹配响应。ID 字符串最多 256 个 Unicode scalar 且最多 1,024 UTF-8 bytes。
Native 同一时刻最多一个 exchange 在途，其余 callback 异步等锁；5 秒预算覆盖排队、写入
和读取。不是同步锁或业务调度循环。Driver 在独立 FD 消费 callback，不能占用 app-server
stdio reader 或持久队列等 Host 授权。Native timeout/EOF/坏响应永久毒化该连接，所有后续
attempt 关闭，不重发该动作；native 重启沿原 journal 核实，不能从新 callId 重跑。

## 操作请求与响应

请求的必填字段为 `schemaVersion: 1`、随机 UUID `requestId`、`phase`、`identity` 和毫秒
Unix 时间 `occurredAt`。`identity` 必须含原 native `sessionId`、`turnId`、`callId`、
新实际尝试的 UUID `attemptRef` 和工具 `toolName`。非空 stdin 的新 attempt 另带原 exec
`parentAttemptRef`；它的 `callId` 是本次 write_stdin call，不能拿原 exec ID 当唯一主键。
identity 不包含参数、stdin、正文、文件内容、凭据、原始错误或原生帧。
其中兼容字段 `sessionId` 承载实际 `Session.thread_id`，不能使用父子线程共享的 session ID。

响应逐字绑定 `requestId`、`phase`、完整 `identity` 和 `schemaVersion`。所有响应字段都经
严格验证，不能仅对 requestId 或一个 permit boolean。每个 requestId 只完成一次。

- `intent`：Driver 先持久 intent，再在持久锁外重验 Host 当前授权。成功响应
  `decision: permit`、UUID `permitId`、`expiresAt` 和 `sourceOwner`。期限必须晚于接收时间且不超过 5 秒；
  permit 只用于该 attempt 的一次 dispatch。拒绝响应 `decision: deny` 与 schema 列出的
  受限 reason，且 Driver 已保存该 attempt 的拒绝结果，不得仅口头拒绝。
- `started`：真实 spawn/write/client dispatch 已开始后，带相同 identity 和 `permitId`；
  Driver 持久 started 后响应 `decision: ack`。验证失败、尚未 dispatch 不产生 started。
- `outcome`：真实有限结果带 `outcome: completed|failed|unknown`、必填 permitId 和有限
  reason（completed 不带 reason，failed/unknown 必填）；Driver 持久后响应 `decision: ack`。
  known failure 是 failure；无法确认实际
  副作用才 unknown。callback 本身失败不把可能已发生动作重写成未执行。

`sourceOwner = { rootThreadId, rootTurnId }` 只标识实际 native source 所属的原始 Execution，
不授予执行许可。相同 source 的 owner 不得改变；deny、started/outcome ACK 不携带 owner。
子任务独立工具调用不携带 `parentAttemptRef`，其来源由下述 reservation 保存。

## 原生 source 交接

source 消息共用版本、requestId、phase、occurredAt。`reservation` 含稳定 UUID
`reservationId`、原始完整操作 identity `parent`、`parentPermitId`、实际 `childThreadId`
和 SessionIo 生成的实际 `submissionId`。`source = { threadId, turnId }` 必须来自实际任务，
不能把 send_input 为兼容返回而生成的 opaque ID 当作被 Steered 的 Turn。

source 响应必须回显完整原请求 `request`，并匹配顶层 requestId、phase、版本。
仅匹配 reservationId 或 owner 不足以确认回执。

- `source-reserve`：在原生输入队列接受前保存 reservation；ACK 带原操作 permit 的 owner。
  可按 schema 限定 reason 拒绝。初始 spawn 的输入继承已真实开始的 spawn attempt，
  自然 permit 到期不使已开始的 spawn 自动失去提交首个输入的资格。
- `source-bind`：`delivery: started` 在 task.run 与 start lifecycle 之前绑定实际新 source；
  ACK owner 必须不变，可以明确拒绝。`delivery: steered` 保存已经追加到同 owner 活跃
  source 的输入事实，只能 ACK，不因后续 stop/revoke 否认已经发生的投递，也不替换原始 reservation。
- `source-not-started`：记录 `not_queued`、`not_routed` 或 `gate_rejected`；stage、reason
  组合以 schema 为准，仅 gate_rejected 带实际 source。回执仅 ACK，不携带 owner 或 reason。
- `source-terminal`：原任务结束并完成可能产生动作的收尾后，用原 Started reservation 保存
  `completed|failed|cancelled`；没有 unknown terminal。回执仅 ACK，确认前保留 source 占用。

同一 child thread 的后续真实新 Turn 可以由新 reservation 绑定另一个 Execution；尚未确认
结束的不同 owner source 不能被接管。新 source 的绑定可晚于父操作 outcome，但必须有原始
reservation 和真实 parent started。close/resume/interrupt 在实际目标操作前检查已知 source
归属；队列等待后再次检查。背景进程仍按各自原 attempt 收尾，不由 source terminal 代替。

## 取消与并发

Native 在 intent 前、permit 返回后和紧邻实际 dispatch 前检查取消及期限；取消排队中的
intent 不会产生动作。已经发出的 exchange 必须在 5 秒内读完匹配响应或毒化通道，不把晚
响应错配给下次请求。取得 permit 后在 dispatch 前取消，发送 `failed` 与
`cancelled_before_dispatch` outcome，持久 ACK 后返回。

started/outcome 事实不能因已经取消而跳过确认。stop/status 继续走原 app-server stdio，
不等待取得 callback mutex。用户取消和真实停止分开；背景进程仍在运行时保持原 attempt
未决，真实退出后才提交原 attempt outcome。非空 stdin attempt 与原进程 outcome 各自
确认；空轮询不产生新 attempt。Driver 终态前需排空全部相关 callback/journal。

内部 sandbox/client retry 要在上一次 outcome ACK 后创建新 attemptRef；不复用 permit。
重复报送同一 requestId 的 Driver 处理必须幂等，但 native 不因 timeout 主动重跑业务动作。
普通 Pre/Post hooks 的允许、失败或参数改写不能获得或跳过本接缝的许可。
有真实 native run ID 与原任务 thread/Turn 上下文的任务 hook 沿同一 attempt 屏障执行，
异步 hook 从原 JoinSet 调度前开始计入原 Turn，覆盖等待 semaphore 与实际执行；终态前
仅等待该 Turn 的已调度 hook 结束或取消。取消排队 hook 不等待其他 Turn 释放容量，运行中
hook 保留真实结果或 unknown 回执。没有可信任务上下文的 session/startup hook、没有可核实
run ID 与终态的 legacy notify，以及未交接的自动子任务入口明确拒绝；具体源码覆盖与
尚未完成的真实运行验证见 [coverage](coverage-v1.json)。
