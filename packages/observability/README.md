# Platform 运行观测边界

`startObservability` 输出 Pino JSON 日志；配置 OTLP/HTTP 地址后，同时导出 OpenTelemetry Trace 和 Metric。未配置地址时，导出明确禁用，运行日志仍可用。输入只接受固定的阶段、结果和故障代码，以及受限关联元数据；正文、附件、思考、凭证和原始错误不属于输入契约。

| 指标 | 单位 | 标签 | 计数边界 |
| --- | --- | --- | --- |
| `agent_platform_operations_total` | 次 | `service`、`stage`、`outcome` | 阶段拥有者确认结果后调用一次 `record`；重放消费者须先按持久操作、尝试和事件标识去重。 |
| `agent_platform_operation_duration` | ms | `service`、`stage`、`outcome` | 阶段拥有者提供一次已确认耗时；缺失时不记录。 |

`service`、`stage` 和 `outcome` 均为封闭集合。请求、Trace、Agent、Conversation、Execution、操作和尝试引用只进入受控日志与 Trace，不作为指标标签。调用方必须提供平台生成的关联 ID，包内仅校验 UUID 格式；外部请求头和任意文本不得作为观测关联值。不符合格式的关联值会被省略，非法阶段、结果或耗时会被丢弃并计入 `status().invalidRecords`。

Trace 队列最多保留 512 个 Span，每批最多导出 32 个；Trace 和 Metric 各最多并发一个 OTLP 请求，导出超时为两秒，关闭最多等待五秒。日志目的地阻塞或报错时，后续日志会丢弃并计入 `status().droppedLogs`。导出回调只记录失败次数和时间，不记录原始错误。故障计数需要独立的进程健康入口；故障中的 exporter 无法可靠导出自己的故障指标。
