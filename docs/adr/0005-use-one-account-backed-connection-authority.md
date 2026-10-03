# ADR: Connection 使用单一账号级权威

## 状态

已接受，用于 Connection M1 首个受监督 GitHub Pilot。

## 背景

Connection 需要让同一员工在不同入口下使用稳定 Principal，并让 Agent Platform 代表具体 Agent Actor 调用。若本机 Runtime、Platform DB 和 Connection DB 分别保存账号、Grant 或 Credential，同一员工会形成多套身份与撤权边界，外部账号选择和审计也无法保持一致。

Connection 同时需要公司员工登录。Agent Platform 已通过部署 IdentityAdapter 获得自己的 IdentityContext，但复用 Platform 浏览器会话会让 Connection 依赖另一个产品的登录和发布周期，也无法服务独立 Connection Web。

## 决策

1. Connection 使用单一账号级 control plane 和 PostgreSQL 权威，保存 Principal、Consumer/Actor、Connection、Credential、Grant、调用和审计。
2. Connection 直接使用部署批准的公司 LDAP profile 完成员工登录，以 `issuer + uid` 映射稳定 Principal，并建立自己的 hash-only BrowserSession。
3. Agent Platform 只保存 Agent Action policy 和 Connection `callId` 引用；用户 Grant 只保存在 Connection。
4. Agent Platform 通过受信短期 assertion 代表当前 Principal 和 Agent Actor，Connection 独立验证并解析 current Grant；任何请求字段都不能指定 Principal、Connection 或 Credential。
5. `LOCAL_SINGLE_USER`、`REMOTE_SHARED`、本机 installation identity、SQLite、Runtime token 和本机 Credential store 不作为产品模式。可选本机组件只能是无状态 edge。
6. 公司 LDAP 登录参考 Rehoboam 已验证的 Service Bind 查找、稳定 `uid` 和用户 DN bind 契约，不复制其 Token、Socket 登录或 Session。LDAP transport 默认要求验证证书和主机名的 LDAPS/StartTLS；当前 LA3 受监督 Pilot 因公司 LDAP 没有可用 TLS，可以沿用 Rehoboam 固定私网 `ldap://` profile，并明确接受员工密码和 Service Bind Credential 明文传输风险；该例外禁止降级/fallback、不能跨环境复用，正式上线前必须关闭。

## 影响

- Connection 可以独立部署、登录、撤权和审计，不依赖 Platform 浏览器会话或数据库。
- Platform 和 Connection 的双层授权通过 assertion 与 `callId` 关联，不使用分布式事务或 Grant 副本。
- LDAP 可用性成为 Connection 登录和 Principal 复核依赖；当前 Pilot 只确认条目存在，正式离职状态仍是后续门禁。
- LA3 Pilot 暂时接受私网明文 LDAP 风险；网络边界、固定 endpoint 和无 fallback 只能降低暴露面，不能把该链路描述为加密传输或生产 TLS conformance。
- 历史本机 profile 代码不能整体合入，候选实现必须按新的 Implementation Issues 重新切片。

## 备选方案

- **Platform 保存用户 Connection Grant：** 会形成第二份可写授权并让 Connection 无法独立服务其他 Consumer，拒绝。
- **每台设备保存本机账号和 Credential：** 无法跨设备共享，撤权与审计割裂，拒绝。
- **Connection 复用 Platform 浏览器会话：** 让独立产品依赖 Platform 登录和发布边界，拒绝。
