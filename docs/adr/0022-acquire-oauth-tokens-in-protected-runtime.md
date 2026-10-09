# 由受保护 Runtime 直接领取标准 OAuth Token

## 状态

平台消费方设计候选，primary 为
[#1536](https://github.com/AgoraIO-Extensions/agent-infra/issues/1536)。
设计评审合入后才实现，生产供应及真实验证继续沿
[#851](https://github.com/AgoraIO-Extensions/agent-infra/issues/851)。
本决策不批准 Consumer 登记或真实 Token 启用，不修改 Connection 原生实现、部署和 tickets。

## 问题

当前 Host 已有私有 export 接收器，Driver 已能直接消费标准 MCP，但生产供应尚未落地。
公开标准 OAuth 可以证明授权码领取来源；Browser Token CRUD 和本机 CLI 登录既不提供
Runtime 安装供应，也不替代原主体/Agent 映射。直接复制 PAT、让 Worker 领取 Token 或
将 Token 放入原生配置会绕开已合入秘密边界。

## 决策

新增供应优先复用标准 Authorization Code + PKCE，由受保护 Runtime 客户端直接兑换、
保存及刷新/撤销。平台控制面只固定自身主体/Agent 的安装授权并传递登录入口与受限状态；
固定 HTTP callback 只允许瞬时转交一次性授权码，不传 Token、verifier 或 Consumer secret。
凭据仍通过现有私有 export/接收器发布，保留固定安装快照和受控重新装配。

完整边界只在工程 Spec
[§13.5.6](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1356-标准-oauth-安装供应)
维护；原身份、当前授权、Linux 保护和发布规则继续引用 §13.5.3–§13.5.5。
获准 PAT 仍可沿原路线供应，不自动选用已有 Portable PAT 或其他产品 Consumer。

## 取舍

授权码转交通道需要共同评审 Platform 与 Runtime 接缝，并排除访问日志、持久队列和
自动重试；它让 access/refresh Token 的领取完全留在原 Runtime 秘密边界，避免建立另一个
Token 服务或将 PKCE verifier 放进控制面。该通道尚未实现，部署回跳地址也须明确批准。

平台侧确认生产者与 callback 接收的具名合同由
[#1589](https://github.com/AgoraIO-Extensions/agent-infra/issues/1589) 细化，仍以工程 Spec
§13.5.6 为唯一边界。Platform DB 只保存自身非敏感确认和命令交付事实，Worker 复用原
claim 与现有循环；不新建 Turn 或第二个任务调度器。固定 callback 瞬时直达原 Runtime，
使用与 Worker 分离的 callback-only 服务认证，不能凭该认证发起或确认安装。这个认证
变化须先评审合同再改 Host；丢响应保留 unknown，不重新转交授权码。

PKCE/state 不解决跨系统主体映射；没有部署匹配的原主体/实例来源，即使 OAuth 成功也
不发布可用安装。客户端不会为补齐 metadata 自造 identity 路由、解析未发布 JWT 或用
本地 ID 冒充 Connection 实例。最小实际输入是实现接收合同，未来整票验收不是设计前置。

初版保持已有重新装配与不可变修订，避免把登录引入热更新、后台同步或新的恢复真值。
代价是新安装不能即时改变已有 Thread，轮换不确定也不能自动重试；原 unknown 事实和
会话占用仍按既有停止/恢复规则处理。当地文件删除不代表远端撤销。

## 验证

实施验证绑定固定官方产物、获准 Consumer/client/callback、OAuth/MCP 合同与配置修订；
覆盖原主体/Agent、state/PKCE/issuer/resource、回跳重放、旧代次、轮换丢响应、远端撤销及
两主体/两 Agent 隔离。受控代码验证与真实 Linux、Connection/Provider 证据分开，任何缺少
合法映射或保护的场景保持不可用，不以文档或 fixture 签收 #851。
