# ADR: Connection GZ3 控制面与 LA3 GitHub Egress

## 状态

已批准直接在隔离的 GZ3 production namespace 实现；接入生产流量前仍受 Issue #601 的国内 PostgreSQL、24 小时网络证据和 Security/SRE 评审约束。

## 决策

Connection 的唯一 control plane、PostgreSQL authority、Identity、Credential、Grant、Call/Effect 和审计迁移到 GZ3。LA3 只部署无状态 `connection-provider-egress`，首期仅允许审核后的 GitHub ProviderRelease 和固定 GitHub origin，不提供用户入口、数据库、长期 Credential 或任意代理能力。GZ3 通过 workload mTLS、短期 bound dispatch assertion 和 take-once admission 调用 LA3；GitHub READ 只有在可证明 pre-submit 失败时允许走 GZ3 固定 proxy fallback，WRITE 在提交状态未知时进入 `UNCERTAIN`，禁止跨路径盲重试。拒绝 LA3/GZ3 双活数据库和通用多区域调度平台，因为多数公司 Provider 位于国内，而授权权威双写与跨路径写重试会扩大一致性和重复副作用风险。

## 证据

- GZ3 普通 Pod 到 Jenkins 公网入口成功，P50 约 70 ms；LDAP TCP P50 38 ms。
- GZ3 到现有美国 RDS TCP P50 170 ms、最大 1173 ms，因此 GZ3 control plane 必须使用国内 PostgreSQL。
- GZ3 直连 GitHub OAuth 在 5 次探测中仅 2 次成功；经固定 proxy 的 GitHub API、authorize 和 token endpoint 探测均为 5/5 成功，P50 约 1.1 秒。
- GZ3 到 LA3 Connection health 30/30 成功，P50 983 ms、P95 1702 ms；该短测只证明部署验证可行，不替代 24 小时 SLO 证据。
