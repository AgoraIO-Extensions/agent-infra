# Platform observability boundary

`startObservability` emits Pino JSON lines and, when an OTLP/HTTP endpoint is configured, OpenTelemetry traces and metrics. With no endpoint, export is explicitly disabled; operational logs remain available. The API accepts only fixed stage, outcome and failure code values plus bounded metadata. It never accepts message text, attachments, model thoughts, credentials, or raw errors.

| Metric | Unit | Labels | Count boundary |
| --- | --- | --- | --- |
| `agent_platform_operations_total` | 1 | `service`, `stage`, `outcome` | One call to `record` after the owning stage reaches a known outcome; a replay consumer must deduplicate by the durable operation/attempt/event identity before calling it. |
| `agent_platform_operation_duration` | ms | `service`, `stage`, `outcome` | One confirmed duration from the stage owner; absent duration is omitted. |

`service` is a fixed process name. `stage` and `outcome` are closed sets in the package. Request, trace, Execution, operation and attempt references are allowed only in controlled logs and traces, never metric labels. Invalid record inputs are dropped and counted in `status().invalidRecords`.

Trace batches are capped at 512 spans and 32 spans per export. Trace and metric requests use one concurrent OTLP request per signal and a two-second maximum export timeout. Shutdown waits at most five seconds for the SDK. A stalled log destination drops later lines until `drain` and increments `status().droppedLogs`. Export callbacks increment `status().exportFailures` and record only their time, never the raw error or request. These local health counters need an independently monitored process health path; a failed exporter cannot deliver its own failure metric.
