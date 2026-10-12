# ADR: Agent Consumer 使用独立 Connection PAT Binding

Connection 管理员在 Connection Web 注册任意 Agent Consumer 的稳定 ID、名称和固定 HTTPS
callback；服务凭据明文只显示一次，Connection DB 只保存 hash。每个 Agent Consumer 再为当前用户
的独立实例创建 TOKEN ConsumerInstance 和 PAT；用户在 Connection 的已认证页面确认后，PAT 由
固定 callback 通过短期、不可重放的服务端单次领取取得。一个 PAT 可使用该 Principal 已分别连接并
授权给该 Consumer 的多个 Provider，撤销一枚 PAT 不影响其他用户、实例或 Consumer。

Agent Consumer 可在已认证服务请求中携带当前登录名提示；提供时 Connection 只保存其 hash，
并要求它匹配确认页面的当前 browser Principal profile。省略时允许用户显式关联当前 Connection
账号，不证明它与业务系统账号属于同一员工。两种方式均须展示当前账号并由用户确认；最终身份
只来自 Connection browser session。单次服务端领取同时返回该 PAT 所属账号的稳定标识、
当前邮箱及显示名，不通过 callback URL 传递。Consumer 后端须将 bindingId 关联原发起用户/会话，
并按业务用户选择独立 PAT，不能将回调随意绑定到当前业务会话或在不同用户间共享 Token。RehoboamAI
只是首个使用该通用协议的 Agent Consumer，Connection 的代码和部署配置不得包含其专属 callback
或服务凭据。

选择 PAT 是为了支持不能使用完整 OAuth client profile 的 Agent；代价是 Bearer PAT 本身不能证明
实际调用进程，隔离依赖独立签发、Consumer 服务端选择、最小授权和快速撤销。任意 callback、浏览器
或聊天中转明文，以及通过扩大部署 allowlist 共享 PAT，均被拒绝。
