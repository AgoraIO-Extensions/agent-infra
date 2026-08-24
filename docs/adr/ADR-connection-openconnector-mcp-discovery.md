# ADR: Connection 复用 OpenConnector 通用 MCP 发现契约

## 状态

已由产品负责人批准进入实现；目标 Direct MCP Client 的 OAuth、幂等和撤销验收仍需完成。

## 背景

OpenConnector 的 MCP 接口使用固定的发现/执行工具集，而不是为每个 Provider Action 注册一个
独立 tool。Connection 之前把已授权 Action 映射成 `conn__...` 工具，导致每新增一个 Action
都要重复维护 MCP 映射，也偏离了 OpenConnector 的实际消费方式。

## 决策

1. Connection MCP 固定暴露 `list_apps`、`list_connections`、`search_actions`、
   `get_action_guide` 和 `execute_action` 五个工具。
2. `search_actions`、`get_action_guide` 和 `execute_action` 只接受服务端从当前 access token
   解析出的 Principal/Consumer/Instance 对应的已授权 Action；调用方不能提交 Connection、账号、
   Credential 或 endpoint selector。
3. `get_action_guide` 从已发布 ActionVersion 的 description、effect 和 input schema 确定性生成，
   对写 Action 补充 required `idempotencyKey`，不复制上游 Runtime 的 Markdown renderer 或 Credential 逻辑。
4. OpenConnector Kernel 的 Provider Action catalog 由 Adapter 投影到 Connection ProviderRelease /
   ActionVersion。新增 Kernel Action 不需要新增 MCP tool 或 Connection 路由；发布链仍可通过
   ProviderRelease、ActionVersion 状态和 Grant 选择限制暴露范围。
5. `execute_action` 最终调用 Connection application service，继续执行 Grant、ActionVersion、
   Credential、幂等、Effect、审计和撤销校验；OpenConnector Runtime MCP 不进入部署边界。

## 影响

- MCP 客户端只需要理解一套稳定工具契约，Action 数量变化不会改变 `tools/list` 的工具名称。
- Action catalog 的新增、effect 分类、scope 和真实 Provider 验收仍属于发布门禁，不能因为动态发现
  就自动授予未审查能力。
- 旧的 `conn__{provider}__{action}` MCP tool 名称不再作为正式 Direct MCP 契约；HTTP 管理/调试
  接口仍由 Connection application service 统一授权。

## 证据

- OpenConnector `src/mcp.ts` 的 `createMcpServer` 注册五个通用 tool。
- [Connection HLD](../architecture/HLD-connection-M1.md) 的 10.4 与 22.3。
- [OpenConnector Kernel 边界 ADR](ADR-connection-openconnector-kernel-boundary.md)。
