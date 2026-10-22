# 受控部署环境中的 Connection profile 投影

## 状态

已接受；实现沿 [#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851)
交付。Connection 服务端、Provider、Grant 和原生 tickets 仍由 Connection 负责。

## 问题

第一方本地 Compose API 没有 Helm Pod 的 ConfigMap 挂载，但 Web 的 Connection 入口仍必须
消费同一份部署批准的 profile。让 Web 自己拼接 endpoint 会绕过服务端 capability 校验；让 API
模块逐字段补值又会把完整快照拆开。

## 决策

允许部署启动器把完整的非敏感 Connection profile 通过 `AGENT_INFRA_CONNECTION_*` 环境投影
传给 Platform API。投影必须来自同一份已批准快照，并同时携带 profile、`1-<fingerprint>`、
fingerprint 和 approval source ref/revision。API 只在部署模块没有导出 profile 和 approval 时
整体读取这组值；不与模块导出逐字段合并。模块导出优先，profile、版本、指纹或 source 不匹配
时保持 Connection capability 不可用。

环境投影只传输 `publicOrigin`、`mcpPath`、`consumerId`、`audience`、egress 引用和批准来源。
OAuth token、PAT、Cookie、SecretRef 内容及 Provider 凭证不进入环境、前端 bundle、日志或
Platform DB。Web 继续只使用 API 返回的 server-resolved capability；每个 Agent 的 OAuth
client/Consumer binding 继续由 Worker 的既有 per-Agent resolver 处理。

## 取舍

该接缝让本地 Compose 与 Helm 使用同一份 profile 语义，但环境投影本身不证明 egress 内容或
Connection 授权；这些事实仍由部署批准来源和 Connection 自身校验。任意请求、Agent 配置或
前端常量都不能覆盖投影，新增字段必须先升级 profile schema。

## 验证

- profile、版本、指纹和 source 完整匹配时，API capability 可用。
- 缺少字段、版本/指纹不匹配或非法 profile 时，capability 保持不可用。
- deployment module 导出存在时，环境投影不覆盖它。
- focused Platform API tests、typecheck、Biome 和 diff checks 通过。
