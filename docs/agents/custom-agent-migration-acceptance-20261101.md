# API 迁入验收报告（2026-11-01）

## 结论与范围

两个 custom ACP Runtime（R2、R3）已经通过 API 注册到平台，并完成真实模型首任务、同会话续接、任务 SSE、取消和跨主体隔离验收。单服务和多服务 `self-managed` 参考入口另已通过 API 创建及应用自身的 HTTP/browser 验收。关联的 session-owned Issue [#3747][acceptance]、[#3786][sse]、[#3854][cancel]、[#3837][own] 已关闭。

本报告固化已有验收结果，编写时没有重新运行环境或模型。它证明冻结组合下的参考 Runtime 迁入，不代表用户尚未指定的工程、业务数据库、应用记忆或原生历史会话已经迁移。

## 冻结版本与环境 tuple

验收日期为 2026-11-01，本文时间均为 UTC；独立复核时间为 `14:37:41.950Z`。后续环境重建、配置或镜像变化不沿用本报告的通过结论。R2/R3 是同一 custom child 的两个实例，不是两种不同 Runtime 实现。

| 项目 | 本次绑定 |
| --- | --- |
| 应用和平台 source | `99971f2222ed23f30418255a03838023cb154388` |
| 官方发布 | [workflow run 41288875902](https://github.com/AgoraIO-Extensions/agent-infra/actions/runs/41288875902) |
| API image | `ghcr.io/agoraio-extensions/agent-infra/platform-api@sha256:da16b73c26af93c72710d58b7ac96562e620ea8f7c39347d2a65e752dfdb868c` |
| Worker image | `ghcr.io/agoraio-extensions/agent-infra/platform-worker@sha256:f05baa58e52283995c6b0fdbb786a2c52097ea9528cbd0d36dc53136e5341881` |
| 官方 RuntimeHost 父镜像 | `ghcr.io/agoraio-extensions/agent-infra/agent-runtime-host@sha256:3f0a2386193107ee69d6c4b353da6afab8059bcdd44fa367958500cc80721ee2` |
| Custom child image | `ghcr.io/agoraio-extensions/agent-infra/custom-agent-base@sha256:c9b77061d6116cd6b0abbbe17dddde7db95243184717a164a24be67f3d1caf28` |
| Self-managed child image | `ghcr.io/agoraio-extensions/agent-infra/custom-agent-base@sha256:d316e49145b306a49ecebe25bb502be1da9727d8324c0a40c35fbe0271c2032b` |
| Runtime protocol | ACP，HTTP V3，Runtime Grant V2 |
| 容量批准 | `ack-small`；requests `100m / 128Mi`，limits `1 CPU / 2Gi`，最大并发 1 |
| 模型配置 | `custom-owner-static-v3` / `owner-deepseek` / `anthropic_deepseek-flash` / `high` |
| 业务身份 | Bearer API credential；主体由服务端解析；Conversation channel 为 `api` |
| 环境 | ACK `agent-infra`；独立容量 Pod 使用 amd64 ECI |
| TLS | API 显式 CA 信任；self-managed 浏览器使用受控 leaf SPKI pin，未证明普通 Chrome/public CA 信任 |

registry 回读核对了唯一 amd64 child、config、配方文件摘要和官方父镜像内容层。健康检查、Pod Ready 和镜像 Label 单独不能证明业务通过。

## 能力矩阵

| 能力 | 分类 | 验收方式与结论 |
| --- | --- | --- |
| 镜像与 Runtime 接入 | 实测可用 | 获准不可变 child digest、RuntimeHost/ACP、`ack-small` 容量和真实模型执行均通过。 [创建/容量证据][acceptance] |
| API 创建与就绪 | 实测可用 | 两个 Agent 首次创建返回 201，随后 `available / ready`。 [创建/容量证据][acceptance] |
| 创建幂等重放 | 实测可用 | 原请求和原 `Idempotency-Key` 再 POST 返回 200、`replayed=true`、Agent ID 不变。 [创建/容量证据][acceptance] |
| 真实首任务 | 实测可用 | R2、R3 各有一次 completed 首任务，真实模型事实为单一 operation/attempt；合成发票预期与输出均为 `TOTAL=498.42`。 [任务证据][sse] |
| 同会话续接 | 实测可用 | 使用原 `conversationId`、新任务幂等键，两个 Agent 均 completed；续接问题不包含答案，返回上一轮总额。 [任务证据][sse] |
| 短任务 SSE | 实测可用 | 首任务和续接的事件顺序、event hash、正文与 GET/Store 投影一致。 [任务证据][sse] |
| Last-Event-ID 重放 | 实测可用 | 原游标重放的事件后缀与 GET 投影逐条一致。 [任务证据][sse] |
| 运行中取消 | 实测可用 | 两个 Agent 都在 model started 后取消；最终 Runtime/DB 为 cancelled，stop completed，turn/stop outbox succeeded，四个 lease 字段清空。 [取消证据][cancel] |
| 跨主体隔离 | 实测可用 | 同 Agent use grant 下，另一主体对原 Task GET、SSE、cancel 均被拒绝；临时 credential/grant 撤销后原权限恢复。 [任务证据][sse] |
| 长取消 SSE 恢复 | 产品边界 | 超过 replay window 时按协议返回 `timeline.reload/cursor_expired`；先 GET 完整快照并校验已收 SSE 重叠，再以快照补齐。补读不是原 SSE 全量。 |
| self-managed 单/多服务入口 | 实测可用 | 两种入口 API ready；多服务 web/api、Ingress、后端转发和签名登录已通过受控 HTTP/browser 验收。 [自有入口证据][own] |
| 本地目录、Git URL、外部 Agent URL、原生历史导入 | 产品边界 | 当前创建契约没有这些字段；源码/依赖进入镜像，业务数据由应用自己的存储方案迁移。 |
| 文件任务、单次指定模型 | 产品边界 / 未测 | 当前 Token Task 请求体只有 `text` 和可选 `conversationId`；能力投影不能替代文件任务或单次模型参数验收。 |
| 环境/Secret 修改、镜像升级、Skill 管理 | 产品边界 / 未测 | 这些是 Owner/浏览器或 Skill Hub 入口，与 Token Task API 分开。 |
| API channel 会话由 Web channel 页面读取 | 产品边界 | API 会话与 Web 会话隔离；页面 404 不代表 API Task 迁入失败。 |
| start/stop/restart、持久性及升级回滚 | 未测 | 管理命令契约存在，本冻结组合本轮未验证这些动作；见[操作入口](custom-agent-migration.md#执行业务重启与更新)。 |
| 普通 Chrome/public CA、全量 ACK 重建、并发大于 1、性能 SLA | 未测 | 本次不签收这些范围。 |
| pull-secret 原型比较振荡 | 实现缺陷（已修复） | [#3839](https://github.com/AgoraIO-Extensions/agent-infra/pull/3839) 改为按契约字段比较 SDK 对象；新多服务入口已 ready 并独立复验。 |
| model fact `startedAt`、SSE 读取预算、控制 readiness 重复成本 | 实现缺陷（已修复） | [#3784](https://github.com/AgoraIO-Extensions/agent-infra/pull/3784)、[#3852](https://github.com/AgoraIO-Extensions/agent-infra/pull/3852)、[#3856](https://github.com/AgoraIO-Extensions/agent-infra/pull/3856) 已合入；本报告只引用冻结版本的真实结果。 |
| ECI 首次冷拉取 | 环境阻塞（已保留） | 首次容量 Pod 600 秒超时；确认原 UID 删除后一次 1800 秒重试通过。重试启动等待约 22 分 35 秒，不能全部称为纯下载时间。Runtime 提交至观测终态 16.790 秒，model fact 耗时 6.254 秒。 |
| R3 一次上游 502 | 环境阻塞（已保留） | 受保护 diagnostic 为 `upstream_http / 502 / sent=true`；原失败未改写，后续一次新的有界任务链通过。 |

## SSE、取消和数据库边界

取消 202 只代表受理。GET 行先变 cancelled 时，原 Runtime journal 可能尚在排空，因此仍须核对可信 Runtime terminal、原执行身份及队列/lease。R2 的 model start、stop 记录、model RPC 结束时间为 `14:11:11.280Z`、`14:11:16.809Z`、`14:11:25.713Z`；R3 为 `14:28:15.399Z`、`14:28:20.336Z`、`14:28:30.203Z`。两次最终均为可信 cancelled，且队列已排空。

正常 ACP 取消可能保留 model `completed` fact，因为 prompt RPC 返回 stop reason 后 Runtime 再映射为 cancelled；不能单凭 model fact 判定执行完成或取消成功。outbox 重领次数也不能当成模型重试次数。

冻结版本默认 SSE replay window 为 100 条 / 5 分钟，部署可配置，计数可能包含 Task 投影过滤的 reasoning。R2/R3 长取消原 SSE 分别收到 91/113 个事件，GET 快照分别有 1157/979 个事件。快照补读逐条核对原 SSE 重叠并与 Store/PG 投影一致；报告不把补读声明为原 SSE 全量。

## API 复现步骤

以下命令供后续获授权环境复现；本报告编写时未重新执行。私有输入目录应为 0700，输入文件为 0600，模型 Secret 不写入命令输出。

```bash
umask 077
curl --silent --show-error --fail-with-body \
  -H "Authorization: Bearer $PLATFORM_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $CREATE_KEY" \
  --data-binary @agent-create.json \
  "$PLATFORM_ORIGIN/api/v2/agents" > "$OUTPUT_DIR/create.json"
```

`agent-create.json` 的请求体、Bearer 范围和获准镜像要求见[创建与幂等重放](custom-agent-migration.md#创建与幂等重放)。使用部署 CA 信任配置或 curl `--cacert`，不得加 `-k` 跳过校验。

首次预期 201；使用同身份、原 body 和原 key 重放预期 200、`replayed=true`、同一 Agent ID。随后 GET 状态直到 `available/ready`。

```bash
curl --silent --show-error --fail-with-body \
  -H "Authorization: Bearer $PLATFORM_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $TASK_KEY" \
  --data '{"schemaVersion":1,"text":"<已定义的合成业务输入>"}' \
  "$PLATFORM_ORIGIN/api/v1/agents/$AGENT_ID/tasks" > "$OUTPUT_DIR/task.json"
```

续接在提交体加入 `conversationId` 并使用新任务 key。GET 同一 Task 验证输出和终态；SSE 只把实际收到的事件记为 SSE。收到 `timeline.reload` 时 GET 快照，不重提原模型任务。收到 model started 后，用独立取消 key POST `/cancel`，再按 Runtime terminal、DB Execution、stop/turn outbox 和 lease 判据确认。

跨主体负例需要有权管理者临时授予同 Agent use grant；验证另一主体对原 Task GET/SSE/cancel 均拒绝，随后撤销临时 grant 和 credential，回读原权限集合。不要把管理 Cookie 当 API Token，也不要直写数据库补齐接口缺口。

### SSE 和取消请求

```bash
curl --no-buffer --silent --show-error \
  -H "Authorization: Bearer $PLATFORM_API_TOKEN" \
  -H 'Accept: text/event-stream' -H "Last-Event-ID: $LAST_EVENT_ID" \
  "$PLATFORM_ORIGIN/api/v1/conversations/$CONVERSATION_ID/tasks/$EXECUTION_ID/events" \
  > "$OUTPUT_DIR/events.sse"

curl --silent --show-error --fail-with-body \
  -H "Authorization: Bearer $PLATFORM_API_TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $CANCEL_KEY" \
  --data '{"schemaVersion":1}' \
  "$PLATFORM_ORIGIN/api/v1/conversations/$CONVERSATION_ID/tasks/$EXECUTION_ID/cancel" \
  > "$OUTPUT_DIR/cancel.json"
```

首次订阅不带 `Last-Event-ID`；续读只使用已经确认的 ID。上述输出写入私有目录，不提交到仓库。

## 证据索引

原始回执保存在受控私有目录，以下只列文件名和摘要，不公开凭据、会话正文、真实用户 ID 或完整环境配置。复核者需向验收 owner 取得原始字节，校验 SHA-256 后核对身份、配置和资源绑定；摘要不能代替原始证据。没有私有材料时不能宣称重新执行或完整复核了现场。

| 证据 | SHA-256 | 公开入口 |
| --- | --- | --- |
| `runtime-capacity.receipt.json` | `c5d050c85d83476573eaa16cf3dc89eaad90a62659f68464d6c13c3f3181ab97` | [#3747 验收评论][acceptance] |
| `final-custom-api-create-replay.receipt.json` | `0626a5b9739da74ddcf1d7d3870c7fbf2692c1ab3b71b9edc088a989eea82f50` | [#3747 验收评论][acceptance] |
| R2 `api-db-sse-recovery.receipt.json` | `0322c0b549cb0472d5e94178b7bf3857780fbb3ebf146723728493811fd40cb5` | [#3786 收口评论][sse] |
| R3 `api-db-sse-recovery.receipt.json` | `a09a3dcc56cb2495af8be688f5e206e16be229c50210beaa877b625dfbea598f` | [#3854 收口评论][cancel] |
| R2 隔离回执 | `88bf6879a03b38123c399cd77382b44af546c9d11fb8d4384f5f3a6c0f55d74d` | [#3786 收口评论][sse] |
| R3 隔离回执 | `4ff48cf3f4b6fa8316a3b5c42e478e90d7a7ca68ff9cdec0795c07d7a242a5aa` | [#3854 收口评论][cancel] |
| 独立复核回执 | `276642b6bba2655187e73ff0f3d35588e69953fe0a8926bac411904690e4a756` | [#3747 验收评论][acceptance] |
| self-managed 入口交接 | `81b094b8123ed3d59e72b22d07a33d683e277be14111c86ffbfda2ab0d0fc95b` | [#3837 收口评论][own] |

独立复核重新读取两个 Agent 的 API 与镜像。R2 取得了新的只读 PG 快照；R3 的独立 PG exec 两次 connection reset 后停止，使用本轮原始 source-bound PG 快照与重新读取的 API 完整比较。隔离复核审计了已有真实负例与权限恢复回执，没有重复变更 Grant。27 份原始证据哈希未变。

后续分工：应用 Owner 准备自己的镜像、模型配置和数据迁移；平台 API owner 维护创建/任务契约；部署 owner 维护 Registry、容量批准和环境就绪。文件、Skill、升级、证书及完整环境重建按各自既有范围处理，不是本报告新增任务。

[acceptance]: https://github.com/AgoraIO-Extensions/agent-infra/issues/3747#issuecomment-6559419404
[sse]: https://github.com/AgoraIO-Extensions/agent-infra/issues/3786#issuecomment-6559420536
[cancel]: https://github.com/AgoraIO-Extensions/agent-infra/issues/3854#issuecomment-6559421852
[own]: https://github.com/AgoraIO-Extensions/agent-infra/issues/3837#issuecomment-6557583559
