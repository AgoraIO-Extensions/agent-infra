# Platform collector 局部验收

本目录消费 #441 的既有遥测接口，仅用于受控本地验收。生产告警规则及完整 AC-1–AC-9 仍待接收方验收，不能据此关闭 Issue。

## 入口和归属

- `collector.ts:startCollector`：复用本地官方 OTel Collector 镜像，绑定回环端口；提供 Prometheus 文本查询及 OTLP JSON 文件回读。容器限制 192 MiB，采集文件轮转限制 2 MiB / 1 个备份。没有外部 exporter。
- `collector.test.ts`：调用正式 `startPlatformApiFromDeployment`、`startPlatformWorkerFromDeploymentV2`；API 使用真实 HTTP/PostgreSQL，Worker 使用既有 `createObservedConversationEvents` 与 `PostgresConversationEventTransactionV1`。事件保存和重放仍由原事务判断。
- `deployment.ts`：仅提供受控数据库和合成身份。未使用的 admission 拒绝调用，不证明真实身份系统验收。
- `alerts.ts:evaluateAlerts`：有限采样的受控告警规则，阈值由调用方传入；没有定时调度或第二套业务事实。输出由验收写入本地证据文件，不是生产通知通道。

不修改 API/Worker 装配、Host/Driver、Task/Store、共享环境或公共依赖。完整 Worker dispatch、Runtime、模型/工具、Connection、SSE 及四模板验收均未覆盖。积压来自可抛弃数据库中的合成 outbox 行；采样直接读取该表，不表示生产进程已装配周期采样器。

## 运行

要求 Node 24、已安装 workspace 依赖、已构建应用，以及现有 Colima Docker 环境。显式设置 `DOCKER_HOST` 指向获准环境、`COLIMA_PROFILE` 为相应 profile、`AO_SESSION_ID` 为本次唯一标识，`OBSERVABILITY_EVIDENCE` 为仓库外证据文件绝对路径。不得指向生产数据库或外部 OTLP。

运行前确认所选 Docker 与 Colima profile 匹配，使用 `colima ssh --profile "$COLIMA_PROFILE" -- df -Pk /var/lib/docker` 验证 Available 至少 5242880 KiB；总内存不代表磁盘余量。空间不足时停止容器验证，不自动清理其他资源。

```sh
pnpm exec tsc -p tests/observability/tsconfig.json --noEmit
pnpm exec vitest run tests/observability/alerts.test.ts
pnpm exec vitest run tests/observability/collector.test.ts --maxWorkers=1
```

Collector 固定使用已有官方 `otel/opentelemetry-collector-contrib:0.133.0`，以本地 image ID 启动并记录；`--pull=never`，不构建镜像。PostgreSQL 复用仓库既有 digest 固定的测试入口。仅移除本次创建且验收独占的容器，不处理共享进程或业务卷。

## 证据和限制

验收查询 `agent_platform_operations_total` 和 `agent_platform_resource_count`，按固定 service/stage/outcome/kind 筛选。Trace 文件核对合成 Execution 关联；正文和 cursor 哨兵不得出现在日志、Trace 或指标中。计数核对持久事件数量，并确认重放不增计数。

服务关闭/恢复、数据库查询失败/恢复、持续 outbox 积压/清空分别触发并恢复受控告警。错误恢复使用观测计数的窗口差值，不能把累计错误计数永久判为故障。Collector 停止期间验证真实 API 查询和事件事务仍成功，exportFailures 单独增加；恢复后回读采集计数。缺失指标不补成零积压。

这些证据仅证明此受控集成范围，不证明真实 Provider/Connection、生产容量阈值、必要审计失败语义、慢消费者/队列满或完整进程调度路径。告警投递到真实运维后端仍需部署方明确配置授权与回读。
