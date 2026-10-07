# 在 Runtime 秘密边界交付 Connection 安装输入

## 状态

架构修订候选，primary 为 [#1442](https://github.com/AgoraIO-Extensions/agent-infra/issues/1442)，
客户端与真实安装验证沿 [#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851)。
先评审并合入正式合同，再实现实际接收者。本决策不批准真实 Token 启用，不修改独立
Connection 的签发、产品、部署或 tickets，不签收真实保护或 Provider conformance。

## 决策

初始交付采用部署批准的 Runtime 私有文件 SecretRef export，在 Host 的受保护边界消费。
接收器发布到现有客户端 reader 的专用布局，复用安装和凭据修订引用；API/Worker/Web
不读取、解密或转发 Token，原生只消费原官方工具接缝。

完整信任、输入、发布、失败和启用合同仅在工程 Spec
[§13.5.5](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1355-受保护安装交付)
维护，身份与凭据权威仍以
[§13.5.3](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1353-secretref权威与交付边界)
为准。metadata、文件名、目录存在或 Token 名称不能替代 Connection 的独立确认与当前授权。

## 接缝与取舍

当前消费接缝为 `createProtectedStandardMcpInput`、`assembleRuntimeHost` 和
`StandardMcpClient`；现有 reader 只有获准输入才实例化实际客户端。后续实施必须固定真实
供应引用及 Host 内安装调用入口，使用同一版本的 schema，不生成空 helper 或平行目录。
只支持现有 reader 的私有文件格式，避免先把 Token 放进 generic Kubernetes Secret、Worker
解密流程或普通配置后再补保护；供应来源的实际交付仍须单独确认。

material 持久确认先于 metadata 原子切换，代价是失败时可能保留未被引用的材料；接收器
不能通过清理或重发业务操作隐藏不确定性。已配置但异常时保留不可用的选中状态，原控制
和事实读取继续可用。原生/工具的文件、内存与 FD 保护沿
[§13.5.4](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1354-runtime-driver-直接消费标准-mcp)
在最终产物验证，文件权限或引用释放不能代签。

已部署 Connection 的 MCP/OAuth、合法领取、刷新、撤销与结果/query 合同仍由服务供应。
本方案不猜注册、claim 或回查路径，不恢复已停止的 private FD3、DPoP、vendor/probe 或
Token helper 变体。真实输入不足时能力关闭，受控源码开发与真实启用分别推进。

## 验证分层

| 验证 | 必须证明的行为 | 证据边界 |
| --- | --- | --- |
| 受控源码 | 原主体/Agent/profile/source 匹配；拒绝未知字段、别名、链接、错误权限及不一致修订；material 先持久确认，metadata 后切换；切换后不确定先核实，故障保留原控制 | 不能证明供应身份、合法领取或隔离 |
| 部署接线 | 固定获准供应引用/修订；真实 Host 接收调用消费相同格式；API/Worker/Web 不取得秘密 | 不能证明 Connection 远端确认或撤销 |
| 最终运行 | 两主体/两 Agent 独立凭据，真实文件/内存/FD 保护、Connection/Provider 调用与撤销，unknown 保持原占用且不重发 | 沿 #851 保留真实合同与最终产物证据 |
