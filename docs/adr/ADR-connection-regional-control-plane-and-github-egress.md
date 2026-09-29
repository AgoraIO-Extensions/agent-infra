# ADR: Connection GZ3 控制面与 GitHub 代理出口

## 状态

已批准直接在隔离的 GZ3 production namespace 实现。LA3 Provider Egress 因当前 HCI 不提供可用的 workload mTLS 入口而延期；接入广泛生产流量前仍受 Issue #601 的国内 PostgreSQL、代理稳定性证据和 Security/SRE 评审约束。

## 决策

Connection 的唯一 control plane、PostgreSQL authority、Identity、Credential、Grant、Call/Effect 和审计部署在 GZ3。国内 Provider 从 GZ3 直连；GitHub 服务端 OAuth 与 API 请求固定通过 `103.101.125.158:28062` 代理，浏览器 authorize 页面仍由用户浏览器直接访问。该代理只用于 GitHub，不用于 GZ3 可直连的 Bitbucket、Jira、Confluence 或 Jenkins。GitHub WRITE 在请求提交后响应未知时仍进入 `UNCERTAIN`，禁止盲重试。拒绝 LA3/GZ3 双活数据库和通用多区域调度平台。

LA3 `connection-provider-egress` 的协议代码保留为未来 TODO，但不进入当前生产拓扑。只有 HCI 提供可审计的双向 workload mTLS、证书轮换、TLS passthrough 或等价可信入口，并完成 READ/WRITE crash-window 验收后，才能重新评审启用；不得以普通 HTTPS、共享 Token 或调用方可伪造的证书 Header 绕过门禁。

## 待评审变更：GitHub OAuth 出口回退

当前固定代理在 GZ3 返回 HTTP CONNECT 200 后重置 TLS 隧道；同一 Pod 的无凭证直连探测可到达 GitHub。这只证明直连传输在短测中可用，不证明真实 OAuth 成功或长期稳定。以下方案须经 Security/SRE 批准并更新 NetworkPolicy 后才生效；在此之前，服务端 OAuth 和 GitHub API 仍只使用上述固定代理。

- 仅 GitHub OAuth code exchange 可在提交 code 前，用不带 code、client secret 或用户 Token 的固定目标探测代理隧道。只有探测在业务请求发出前因传输失败，才为本次 exchange 选择受控直连；探测成功则继续走代理。
- 直连仅允许 HTTPS `github.com` 的 token endpoint 和 `api.github.com` 的账号身份读取，逐跳校验 DNS/IP、TLS 证书、原始 Host 与 redirect；不得成为其他 Provider、任意 URL 或 GitHub WRITE 的公网出口。
- code POST 一旦开始，任何 timeout、connection reset 或未知响应都不得换路径重放；提示用户重新发起 OAuth。直连 token exchange 成功后，同一次身份读取使用相同的受控出口；身份读取是 READ，但不能泄露 Token 或扩大 scope。
- 出口选择、探测失败类型和阶段只记录脱敏元数据，分别度量代理与直连的成功率、延迟和连续失败窗口。限时验证真实 OAuth、撤销与异常路径，并提供关闭直连的回滚手段；不得在日志、指标或错误中记录 code、Token、client secret、完整请求 URL。
- Security/SRE 必须审查直连目标和 egress NetworkPolicy、代理故障归因、短测之外的稳定性与回滚条件。现有 HLD 声称 NetworkPolicy 阻止 API 直连公网，而本次无凭证探测可直连；在网络策略实际状态查清前，不批准实现或发布该例外。

## 证据

- GZ3 普通 Pod 到 Jenkins 公网入口成功，P50 约 70 ms；LDAP TCP P50 38 ms。
- GZ3 到现有美国 RDS TCP P50 170 ms、最大 1173 ms，因此 GZ3 control plane 必须使用国内 PostgreSQL。
- GZ3 直连 GitHub OAuth 在 5 次探测中仅 2 次成功；经固定 proxy 的 GitHub API、authorize 和 token endpoint 探测均为 5/5 成功，P50 约 1.1 秒。
- GZ3 到 LA3 Connection health 30/30 成功，P50 983 ms、P95 1702 ms；该短测只证明部署验证可行，不替代 24 小时 SLO 证据。
