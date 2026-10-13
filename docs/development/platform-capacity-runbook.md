# Platform 容量负载探针

`tests/platform-capacity-load.mjs` 是 #446 的受控 Platform 负载入口。它只调用正式
Platform API 的健康检查、任务提交、任务查询和可选 SSE 事件流，不绕过鉴权写数据库，
也不创建或修改部署资源。工具用于一次有界的组合测量，不能把一次运行外推为某个固定
并发承诺或 Connection/模型端点容量结论。

## 运行前检查

执行者必须先确认本次测试环境、Agent、服务身份、Runtime/Platform 镜像 digest、模型
profile 和证据路径都属于已分配的 disposable 或获准验收范围。探针要求显式设置
`PLATFORM_LOAD_CONFIRM=I_HAVE_AUTHORIZED_PLATFORM_TARGET`，健康检查失败时不会发送任务。
不要把生产凭证写在命令行；用当前用户可读的 token 文件（权限建议 `0600`）。多用户
负载使用一个 token 文件的逐行格式，每行一个服务身份凭证，行数必须等于 `--users`。

工具需要 Node 24 和已构建的 Platform API。证据文件应写到仓库外的绝对路径；输出只含
状态、延迟、计数、脱敏的任务引用 hash 和版本元数据，不写入 token、任务正文、响应正文
或 SSE 内容。

## 受控运行

```sh
export PLATFORM_LOAD_BASE_URL="https://platform-api.example.test"
export PLATFORM_LOAD_AGENT_ID="agent-under-test"
export PLATFORM_LOAD_ENVIRONMENT="platform-staging-2026-10-13"
export PLATFORM_LOAD_MODEL="approved-model-profile"
export PLATFORM_LOAD_IMAGE_DIGEST="sha256:<platform-and-runtime-digest>"
export PLATFORM_LOAD_SOURCE_SHA="<deployed-source-sha>"
export PLATFORM_LOAD_TOKEN_FILE="/secure/test-scope/platform-token"
export PLATFORM_LOAD_CONFIRM="I_HAVE_AUTHORIZED_PLATFORM_TARGET"

node tests/platform-capacity-load.mjs \
  --users 1 \
  --conversations 2 \
  --tasks 2 \
  --concurrency 2 \
  --sse \
  --output "/tmp/platform-capacity-${PLATFORM_LOAD_SOURCE_SHA}.json"
```

默认计划只有一个用户、一个 Conversation 和一个任务。`--users`、`--conversations` 和
`--tasks` 最大分别为 50、100、100，Conversation 总数不超过 500，并发最多 50；每个
HTTP 请求和 SSE 读取都有上限。逐步增加参数并在每个阶段保存独立证据，发现错误率、
`BUSY`、延迟或积压超过本环境的停止阈值时立即停止。阈值由环境负责人随报告记录，
探针不会假设或生成生产 SLO。

同一 Conversation 的后续任务使用首个受理结果返回的 `conversationId`；每个受理任务
随后通过正式查询端点回读。`--sse` 会为受理任务读取最多一个事件帧，然后主动关闭连接，
用于检测入口和断连路径，不会把 SSE 正文写入证据。

## 证据回读

JSON 证据中的 `result.summary` 按阶段记录 HTTP 状态、网络/超时结果和延迟分位数；
`acceptedTasks`、`duplicateExecutions` 与 `readbackReferences` 用于对照 Platform durable
Message/Execution 和任务查询结果。`readbackReferences` 只有 Conversation/Execution 的
短 hash 及当前状态，不能单独证明结果正文或模型执行成功。

报告还必须人工补充本次实际资源 profile、outbox/SSE/数据库指标、镜像与迁移记录、故障
注入和恢复时间。API/Worker/Pod 重启、数据库或对象存储恢复、回滚及备份演练需要具名
环境负责人按部署方流程执行；本探针不创建云资源、不重选存储、不停止共享服务，也不清理
无归属数据。凭证失效、主体撤权、unknown 和跨用户隔离属于对应 Issue 的组合验收，不能
由本地 fixture 或一次成功的探针运行代替。

## 复核命令

先执行无网络的脚本测试，再把脱敏 JSON 与部署记录一起归档：

```sh
node --test tests/platform-capacity-load.test.mjs
node tests/platform-capacity-load.mjs --help
```

`--help` 不读取凭证，也不触发网络请求。运行失败时保留 JSON 中的失败阶段、HTTP 状态、
超时和版本元数据；不要把 token、普通会话正文、原始错误响应或 SSE 内容复制到 Issue、
日志或共享聊天。
