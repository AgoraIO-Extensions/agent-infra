# 区分 Direct PAT 客户端安装引用与服务端实例

## 状态

正式消费合同修订候选，primary 为
[#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851)。
须经 Platform API/Web、Runtime 与 Connection 契约原 owner 共同评审，按既有门禁合入后再实施。
本决策不批准真实 Token 启用，不改 Connection 服务端、Provider、Grant 或资源保护要求。

## 问题

Connection 已发布的 USER/PAT binding claim 返回实际 account、Consumer、tokenId 和期限，
不返回内部 ConsumerInstance ID 或完整 Runtime descriptor。工程 Spec 将服务端实例映射
解释为所有客户端发布前必须读取的 metadata，使现有 Direct 路线在合法领取后仍无法交付 reader。
产品要求独立 Token、原主体选择和 Connection 逐次验证，不要求客户端知道服务端内部实例 ID。

## 决策

保留现有版本 `1` reader 的字段及不可变材料机制；新的 Host PAT 生产者使用明确命名空间的
客户端安装引用、真实 tokenId 和 Host 本地材料修订，服务端实例未知时保持未知。完整字段来源、
claim 核对、发布与兼容边界只在工程 Spec
[§13.5.5](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1355-受保护安装交付)
维护，不由本 ADR 单独覆盖。原主体批准映射仍独立于 claim；安装确认不签发 Connection 权限。

PAT 领取后的 export 仍在原 Host 秘密边界交给既有接收器，经受控重新装配进入 reader；
不新增身份服务、Token 代理或远端实例查询前置。MCP 兼容合同由消费方根据固定服务来源评审维护，
当前 Token/实例、Grant 和撤销仍由 Connection 在每次请求中校验。

## 取舍与验证

本地安装引用可用于安装选择和原操作记录，不能证明远端实例、调用关联或外部效果。
不重写旧 export 或历史 journal，不把原始 binding ID 投射到平台事实，不改变原生协议的同名字段。
固定 PAT callback 只瞬时转交原 binding ID，持久定位保留 hash，完整窄通道规则仍在工程 Spec 维护。
后续实现须消除代码中把本地引用描述为已独立核实 ConsumerInstance 的表述，并验证真实生产
claim→export→接收器→reader；缺映射、错 Consumer、旧修订、崩溃及丢响应保持拒绝或 unknown。
真实 Linux 文件/内存/FD、双主体/Agent、MCP/Provider、撤销及未知 WRITE 验收继续沿 #851；
文档和受控测试不代签这些结果。
