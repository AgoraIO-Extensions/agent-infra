# ADR: Connection GZ3 控制面与 GitHub 代理出口

## 状态

已批准直接在隔离的 GZ3 production namespace 实现。LA3 Provider Egress 因当前 HCI 不提供可用的 workload mTLS 入口而延期；接入广泛生产流量前仍受 Issue #601 的国内 PostgreSQL、代理稳定性证据和 Security/SRE 评审约束。

## 决策

Connection 的唯一 control plane、PostgreSQL authority、Identity、Credential、Grant、Call/Effect 和审计部署在 GZ3。国内 Provider 从 GZ3 直连；GitHub 服务端 OAuth 与 API 请求固定通过 `103.101.125.158:28062` 代理，浏览器 authorize 页面仍由用户浏览器直接访问。该代理只用于 GitHub，不用于 GZ3 可直连的 Bitbucket、Jira、Confluence 或 Jenkins。GitHub WRITE 在请求提交后响应未知时仍进入 `UNCERTAIN`，禁止盲重试。拒绝 LA3/GZ3 双活数据库和通用多区域调度平台。

LA3 `connection-provider-egress` 的协议代码保留为未来 TODO，但不进入当前生产拓扑。只有 HCI 提供可审计的双向 workload mTLS、证书轮换、TLS passthrough 或等价可信入口，并完成 READ/WRITE crash-window 验收后，才能重新评审启用；不得以普通 HTTPS、共享 Token 或调用方可伪造的证书 Header 绕过门禁。

## 证据

- GZ3 普通 Pod 到 Jenkins 公网入口成功，P50 约 70 ms；LDAP TCP P50 38 ms。
- GZ3 到现有美国 RDS TCP P50 170 ms、最大 1173 ms，因此 GZ3 control plane 必须使用国内 PostgreSQL。
- GZ3 直连 GitHub OAuth 在 5 次探测中仅 2 次成功；经固定 proxy 的 GitHub API、authorize 和 token endpoint 探测均为 5/5 成功，P50 约 1.1 秒。
- GZ3 到 LA3 Connection health 30/30 成功，P50 983 ms、P95 1702 ms；该短测只证明部署验证可行，不替代 24 小时 SLO 证据。
