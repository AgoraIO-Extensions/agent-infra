# Platform 运行观测边界

`startObservability` 输出 Pino JSON 日志；配置 OTLP/HTTP 地址后，同时导出 OpenTelemetry Trace 和 Metric。未配置地址时，导出明确禁用，运行日志仍可用。输入只接受固定的阶段、结果和故障代码，以及受限关联元数据；正文、附件、思考、凭证和原始错误不属于输入契约。

每次启动持有独立的 Trace 与 Metric provider；并发实例和关闭后重启分别导出到各自配置的 OTLP 地址，不注册进程全局 provider。`status().enabled` 只表示本实例已配置并创建导出器，不代表 collector 已收到数据；`status().state` 区分 `active`、`closing` 和 `closed`。关闭开始后新 `record` 不再读取输入或调用 provider，并计入 `droppedLogs`；导出失败由 `exportFailures` 单独报告。

| 指标 | 单位 | 标签 | 计数边界 |
| --- | --- | --- | --- |
| `agent_platform_operations_total` | 次 | `service`、`stage`、`outcome` | 阶段拥有者确认结果后调用一次 `record`；重放消费者须先按持久操作、尝试和事件标识去重。 |
| `agent_platform_operation_duration` | ms | `service`、`stage`、`outcome` | 阶段拥有者提供一次已确认耗时；缺失时不记录。 |
| `agent_platform_resource_count` | `1`，当前数量 | `service`、`kind` | 阶段拥有者从权威运行状态采样后调用 `observeResource`；同种类只保留最新值，不按事件增量累加。 |

`observeResource` 只接受非负安全整数和固定 `kind`：`sse_connections`、`sse_pending_events`、`task_waiting`、`outbox_pending`、`postgres_pool_active`、`postgres_pool_idle`、`postgres_pool_waiting`。未收到快照的种类不会输出零值；收到明确的零值才输出零。每个实例最多保留上述七种最新值，样本超过三个 Metric 导出间隔后停止观测，下一次可信采样才恢复。该 Gauge 使用 delta 聚合以避免 SDK 在无新观测时继续导出过期值；现有阶段计数器保持原聚合方式。真实 API/Worker 必须定期从各自权威状态采样，包内不读取 Store、SSE 或 PostgreSQL。过期停止输出只表示本进程没有新样本，不能证明下游查询后端已经删除旧时间序列。

`service`、`stage` 和 `outcome` 均为封闭集合。请求、Trace、Agent、Conversation、Execution、操作和尝试引用只进入受控日志与 Trace，不作为指标标签。请求、Trace、Agent、Conversation 和 Execution ID 仅接受平台生成的 UUID；操作与尝试引用须来自可信持久事实，包内仅接受 1-128 字符、字母或数字开头且其余为字母、数字、`.`、`_`、`:`、`-` 的值。格式校验不证明引用来源可信；外部请求头和任意文本不得作为观测关联值。不符合格式的关联值会被省略，非法阶段、结果或耗时会被丢弃并计入 `status().invalidRecords`。

`record` 只记录调用方已确认的阶段结果。`durationMs` 进入耗时直方图；当前 Span 在采集时创建并结束，其自身时长不是该阶段的实际耗时。业务 `traceId` 只是受控关联属性，尚未恢复持久工作项的 OpenTelemetry 上下文或建立跨进程 Span link。真实 API/Worker 装配、持久重放去重和全链路关联仍由 #441 交付。

## HTTP 与已持久事件 Adapter

`@agent-infra/observability/http` 的 `createHttpObservability(telemetry)` 是 Hono middleware，须在路由前注册。每个请求生成独立的 UUID `requestId`、`traceId`；`currentRequestMetadata()` 在该请求的 await 链内返回同一只读上下文，请求结束后及其后续异步任务返回 `undefined`。接入方的 `requestMetadata` 须消费该上下文，不能另行生成或采信外部 header。

HTTP 只记录一次响应头建立阶段的结果与实测耗时：2xx/3xx 为 `completed`，4xx 为 `rejected`，5xx 或未被应用处理的异常为 `failed`。不读取 URL、header、body 或原始 error。流式响应返回后的传输耗时、连接数、积压与断流须由实际流入口另行采样；本 middleware 不声称这些数据已获得。

`@agent-infra/observability/worker` 的 `createObservedConversationEvents({ transaction, telemetry }, options)` 保持 Core `ConversationEventUseCaseV1` 的输入、决定和错误契约。它复用原事务 Port，由 Core 校验输入、既有事实及持久返回值后才观测。每个 `accepted` 记录一次 `result_persist/completed`，只表示事件保存已确认，不表示任务业务成功；`replayed`、`stale` 不重复记录。保存或持久返回值确认失败记录受限 `PERSISTENCE_UNAVAILABLE`，再抛出原 Core 错误；采集失败不改变原决定、事务或 cursor ACK。

模型/工具只记录同一事务历史中该 operation/attempt 的首个持久 `completed`、`failed` 或 `unknown`，不在内存中新增去重权威。恢复确认未知结果、Connection 元数据修订及同事件重放不再计数；合法新 attempt 单独计数。`intent`、`started` 不冒充终态，耗时只使用事实中已提供的值；未获得的时间、原始故障、工具/模型名与 Connection 内容均不补值或进入观测输出；模型用量仅按下列指标约定消费。

`recordModelUsage` 导出 `agent_platform_model_tokens_total`，仅使用 `service` 和固定 `kind=input/output/cached_input` label；缓存输入是输入的子集，不能将三种值相加为总 Token。模型/工具名、主体、操作引用与正文不进入该指标或新增日志/Trace。只读取提供的非负安全整数，缺失字段不补零，已知零可观测。

原事件消费者在同一锁定事实历史中按 operation/attempt/usage 字段判断首次出现，事务确认后才调用该方法。重放、stale 和持久失败不新增；未知恢复可补首次获得的字段，已观测字段和原终态不重计。新 attempt 单独统计，消费者重建仍从原历史去重，不维护额外缓存。指标表示首次持久确认的已知字段观测，不作账单权威；进程退出与 exporter 故障可能丢失遥测，不能宣称跨进程 exactly-once 导出。旧仅提供 `record` 的调用方保持兼容，完整正式进程 telemetry 对象直接支持用量消费。

Issue #962 提供基础消费者 Adapter。实际进程装配、collector、四模板及 Connection 验收、跨进程 Span link、SSE/资源采样、查询与告警继续按 #441 各自实际证据验收；用量消费不证明真实 Codex 或 Connection 全链通过。

Trace 队列最多保留 512 个 Span，每批最多导出 32 个；Trace 和 Metric 各最多并发一个 OTLP 请求，导出超时为两秒，`close()` 最多等待五秒。关闭超时后不再发起新的导出，状态保持 `closing`，直到 SDK shutdown 真正结束才变为 `closed`；此前已发出的请求仍受各自的导出超时约束。日志目的地阻塞或报错时，后续日志会丢弃并计入 `status().droppedLogs`。同步采集异常计入 `status().captureFailures`，导出回调只记录失败次数和时间，不记录原始错误。故障计数需要独立的进程健康入口；故障中的 exporter 无法可靠导出自己的故障指标。
