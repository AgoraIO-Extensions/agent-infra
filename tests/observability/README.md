# Platform collector 局部验收

本目录消费 #441 的既有遥测接口，仅用于受控本地或 hosted Linux 验收。生产告警规则及完整 AC-1–AC-9 仍待接收方验收，不能据此关闭 Issue。

## 入口和归属

- `collector.ts:startCollector`：复用本地官方 OTel Collector 镜像，绑定回环端口；提供 Prometheus 文本查询及 OTLP JSON 文件回读。容器限制 192 MiB，采集文件轮转限制 2 MiB / 1 个备份。没有外部 exporter。
- `collector.test.ts`：调用正式 `startPlatformApiFromDeployment`、`startPlatformWorkerFromDeploymentV2`；API 使用真实 HTTP/PostgreSQL，并从正式进程 sampler 回读 `task_waiting`/`outbox_pending`，Worker 使用既有 `createObservedConversationEvents` 与 `PostgresConversationEventTransactionV1`。事件保存和重放仍由原事务判断；同一次事务的 `execution.operation.observed` 记录再由正式 `PostgresScopedPlatformAuditQueryV1` 查询，核对同一 Execution 下的 operationRef/attemptRef，空 Execution 查询与跨主体查询作为负向路径。该查询证据仍是受控本地 PostgreSQL，不是生产审计或 Connection receipt。
- `deployment.ts`：仅提供受控数据库和合成身份。未使用的 admission 拒绝调用，不证明真实身份系统验收。
- `alerts.ts:evaluateAlerts`：有限采样的受控告警规则，阈值由调用方传入；没有定时调度或第二套业务事实。输出由验收写入本地证据文件，不是生产通知通道。

不修改 API/Worker 装配、Host/Driver、Task/Store、共享环境或公共依赖。完整 Worker dispatch、Runtime、模型/工具、Connection、SSE 及四模板验收均未覆盖。积压基准来自可抛弃数据库中的合成 outbox 行；API 的两个资源 gauge 由正式 API sampler 读取，Worker 周期资源 sampler 尚未由本验收接入。

## 运行

要求 Node 24、已安装 workspace 依赖和已构建应用。受控本地运行显式设置 `DOCKER_HOST` 指向获准 Colima、`COLIMA_PROFILE` 为相应 profile；hosted Linux 运行设置 `OBSERVABILITY_DOCKER_MODE=hosted-linux`，由 harness 校验 GitHub Linux runner、`unix:///var/run/docker.sock`、真实 Docker daemon 的 `DockerRootDir` 和文件系统余量。两种路径都要求 `AO_SESSION_ID` 为本次唯一标识，`OBSERVABILITY_EVIDENCE` 为仓库外证据文件绝对路径；不得指向生产数据库或外部 OTLP。

本地运行前确认所选 Docker 与 Colima profile 匹配，使用 `colima ssh --profile "$COLIMA_PROFILE" -- df -Pk /var/lib/docker` 验证 Available 至少 5242880 KiB；hosted Linux 路径由 harness 对实际 daemon `DockerRootDir` 执行相同阈值检查。总内存不代表磁盘余量。空间不足时停止容器验证，不自动清理其他资源。

```sh
pnpm exec tsc -p tests/observability/tsconfig.json --noEmit
pnpm exec vitest run tests/observability/alerts.test.ts
pnpm exec vitest run tests/observability/collector.test.ts --maxWorkers=1
```

Collector 固定使用已有官方 `otel/opentelemetry-collector-contrib:0.133.0`，以本地 image ID 启动并记录；`--pull=never`，不构建镜像。PostgreSQL 复用仓库既有 digest 固定的测试入口。仅移除本次创建且验收独占的容器，不处理共享进程或业务卷。

## 证据和限制

验收查询 `agent_platform_operations_total` 和 `agent_platform_resource_count`，按固定 service/stage/outcome/kind 筛选。Trace 文件核对合成 Execution 关联；正文和 cursor 哨兵不得出现在日志、Trace 或指标中。计数核对持久事件数量，并确认重放不增计数。

同一验收还在 exporter 断线期间通过原真实事件/审计事务提交受控模型事实，恢复后查询 `agent_platform_model_tokens_total`。input/output/cached_input 分别回读为 9/4/1；已知零可查询，缺失字段保持没有样本。重复事件和 unknown 恢复不重计已知字段或原终态，新 attempt 独立统计。模型名哨兵不进入日志/Trace/指标。这些事实由测试输入，未执行 Runtime/native Codex，不替代原 Execution 的真实模型/工具与 ACK 验收；缓存输入是输入子集，不相加作总量。

服务关闭/恢复、数据库查询失败/恢复、持续 outbox 积压/清空分别触发并恢复受控告警。错误恢复使用观测计数的窗口差值，不能把累计错误计数永久判为故障。Collector 停止期间验证真实 API 查询和事件事务仍成功，exportFailures 单独增加；恢复后回读采集计数。缺失指标不补成零积压。

生产容量阈值、必要审计失败语义、慢消费者/队列满或完整进程调度路径仍不在此范围。告警投递到真实运维后端仍需部署方明确配置授权与回读。

## 受控告警后端与出口

`alert-backend.ts` 在同一次 Collector 验收中启动未修改的官方 Prometheus v3.15.0、Alertmanager v0.34.1 和仓库固定 Node 24 镜像；内部网络无外部 exporter，不发布告警后端宿主端口。查询由已有官方 Node 接收容器读取同网 Prometheus HTTP API，通知回读使用该容器内回环 HTTP 地址；单次 HTTP 超时 2 秒、Docker exec 超时 3 秒，stdout 限制 512 KiB。复用已有镜像，仅隔离 hosted Linux runner 可 provision 缺少的固定镜像；本地不自动 pull。镜像 ID/RepoDigest、实际配置、查询路径、PromQL 结果与通知保存在 `collector.json` 的 `alertBackend`，精确资源清理写入相邻 `.alerts-cleanup.json`。

正式 API 的 outbox gauge 与受控真实 HTTP 查询失败 counter 分别触发持续积压和错误窗口；Collector 停止触发采集服务不可用。三者均由真实规则求值和 Alertmanager 投递 firing/resolved，接收器只保留固定 alertname/kind/status 与 payload hash，输出有界。采集服务告警不能据此判定 API/Runtime/Connection 的业务可用性。测试等待包含初次镜像准备，原业务与脱敏断言仍全部保留。

阈值只来自本次 disposable backlog/error fixture；此后端不是生产部署选择、容量配置或真实运维通知验收。#441 AC1–9、真实 Codex 全链、四模板与其他 owner 的原义务继续开放。
