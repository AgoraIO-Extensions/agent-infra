# 私有 Connection callback V2

[callback-v2.schema.json](callback-v2.schema.json) 是本版本唯一 wire Schema。
它保留 [V1](callback-v1.md) 的全部 16 个定义，增加严格的 Connection bootstrap、
operation 与 metadata-only evidence 帧；V1 帧不允许携带 V2 字段。
[共享 corpus](callback-v2-corpus.json) 同时供 TypeScript 和 native typed parser 验证。
结构有效不代表主体、权限、原请求、真实响应或隔离已经核实。

## 私有启动

Bridge 使用固定 server `connection` 和非敏感的
`--agent-infra-connection-profile` JSON 参数。profile 只含
`profileRef`、`serviceRef`、`issuer`、`resource`；普通 MCP URL、headers 或工具输入
不能安装它。私有 FD3 与实际 Linux aarch64 进程保护安装成功后，native 才接受 profile。
Darwin hardening-only 不启用 Connection 凭据。

`connection-bootstrap` 请求只含固定 profile、进程 nonce 和可选上游 thread ID。
Host 从已受理原 Execution 和匿名 socket owner 解析原主体及 scope；native 不能提交
Platform 主体或 scope 来索取 token。token 帧不进入普通 callback journal、fingerprint、
replay、日志或错误 echo，完整 UTF-8 帧含换行不超过 16 KiB。

native 向固定 HTTPS origin 的 `/api/client/identity` 核对原独立授权的
principal、Actor、Consumer、client、issuer/resource、凭据 revision 和期限，
遵循 [Connection HLD §7.1](../../../../docs/architecture/HLD-connection-M1.md#71-客户端认证与主体映射)。
响应是独立的严格对象，所有字段必填；`expiresAt` 为正整数 Unix 毫秒：

```json
{
  "principal": { "type": "user", "key": "connection-user-1" },
  "actorId": "agent-1",
  "consumerId": "agent-platform",
  "clientId": "runtime-client-1",
  "issuer": "https://connection.example.test",
  "resource": "https://connection.example.test/mcp",
  "revision": "credential-1",
  "expiresAt": 1800000060000
}
```

示例仅说明响应形状。native 将全部字段与 private slot 的身份、固定服务和凭据
metadata 精确比对，并在响应读取后重新检查期限尚未到期。缺失字段、未知字段、
类型错误、重复键和四字段旧响应均拒绝；响应不得包含 `accessToken`。
私有 `ConnectionIdentity` 仍只含 principal、Actor、Consumer 和 client 四字段。

每个新的原 root Turn 重新 bootstrap；
同 Conversation 的顺序 Execution 切换仍须 Host 确认旧执行与 source 已终止。
旧 slot 只保留去 token 的原绑定；新 dispatch 只接受当前 slot。

## 实际请求与回执

固定工具为 `list_apps`、`list_connections`、`search_actions`、`get_action_guide`、
`execute_action`。private operation identity 的工具名采用真实 native 格式
`connection/<tool>`；descriptor 使用 `<tool>`。其它 MCP 路由沿用 V1。

最终本地 HTTP dispatch 前，native 核对实际 JSON-RPC ID、method、tool、arguments、
保留 nonce metadata 和实际 auth slot。每个请求的摘要为以下对象的 RFC 8785 UTF-8
编码的 SHA-256，使用锁定的 `serde_json_canonicalizer =0.3.2`：

```json
{"version":"connection-request-v1","method":"tools/call","toolName":"execute_action","arguments":{}}
```

示例只说明摘要对象形状，不是可执行 Action。arguments 使用实际业务对象，不补默认值
或改写；`get_action_guide` 和 `execute_action` 必须携带真实 `actionId` selector。
可信 leaf 注入 `_meta["connection.clientRequest/v1"]`，模型不能覆盖。

只有 `execute_action` 产生调用关联。receipt 只从本次独立认证的实际响应
`result._meta["connection.receipt/v1"]` 或固定
`error.data._meta["connection.receipt/v1"]` 提取。私有 metadata 在模型收到结果前删除；
HTTP/parse 错误使用固定错误码，Connection JSON-RPC error 的私有 data 不外发。

核实还须由原主体当前独立 `calls:read` 权限访问固定
`/api/client/calls/{callRef}`，比对原 RPC ID、nonce、digest、principal、Actor、
ActionVersion、Consumer 与 client。原 receipt 缺失或任意错配都不能升级 verified。
verified 与工具 completed/failed/unknown 相互独立。

原 terminal 保存后，native 在返回模型、释放原 source 前最多进行一次有时限的只读
重查；核实成功使用 `connection-evidence` 补元数据，不重开 outcome、不改计数和时间，
不重发 Provider Action。当前没有跨进程恢复输入；失去原 receipt 时保留 unverified。

## 验证边界

本快照是消费方已批准契约的实现假设，不证明 Connection 服务已交付，也不证明真实
OAuth、Provider PR、最终 native binary/image 或联合 Pilot 已通过。
156 个结构 case、3 个 framing case、34 个 RFC 8785 vector 已作为共同测试输入；
本轮 native 测试在依赖编译阶段因资源保护停止，不能声称这些 native case 已通过。
