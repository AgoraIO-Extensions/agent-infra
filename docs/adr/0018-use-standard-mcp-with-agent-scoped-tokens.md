# 优先用标准 MCP 和独立 Agent token 消费 Connection

## 状态

修订候选，primary 为 [#1378](https://github.com/AgoraIO-Extensions/agent-infra/issues/1378)。
两份 PRD、工程 Spec 和两份 HLD 按共同版本接受消费方与 Connection 契约原 owner 评审，
并遵守现有合入门禁；本地文档提交不批准客户端运行，也不证明部署镜像与源码已匹配。

## 决策

Platform 使用 Connection 的既有标准 MCP/OAuth 或获准 PAT，按原用户/独立应用与 Agent
隔离客户端 token、受保护保管和撤销。token/安装独立与 Grant 权限范围分别表达，不默认
为每个 Agent 创建 Consumer，也不以 token 名称推断不同权限。完整消费合同由
[Platform PRD §9](../prd/PRD-agent-platform-M1.md#9-connection-集成)、
[工程 Spec §13.5.3](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1353-secretref权威与交付边界)
及两份 HLD 定义，本 ADR 不单独覆盖上级要求。

统一要求私有 FD3、native callback 或 DPoP 会把普通客户端接入绑定到额外原生协议和安装
证明，扩大维护与兼容成本。因此优先验证固定官方 Runtime 可提供的标准客户端；sender
constraint 只约束明确选择该方案的 profile，私有 lane 只在另行批准后按
[ADR 0011](0011-require-codex-native-operation-barrier.md)验证，不因普通 token 可用豁免其屏障。
若标准客户端无法保护 token 或产生所需可信执行事实，相应能力保持未通过；不回退共享
凭据、Owner 或平台代理，也不以模型自报补造调用关联。执行前持久意图、当前授权、必要审计、
未知 WRITE 不重放、Session Sandbox 隔离及两侧独立查询权限继续有效。
