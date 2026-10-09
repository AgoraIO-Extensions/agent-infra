# ADR: Connection 上海单主与 GitHub 出口

## 状态

上海单主迁移已按 #1276 的批准边界完成，常规发布入口由 #1625 迁入上海；下文 GZ3 决策保留为
历史基线。LA3 Provider Egress 仍因 HCI 不提供可用的 workload mTLS 入口而延期；广泛生产的
代理稳定性、Security/SRE 与 HA/PITR 门禁仍独立验收。

Issue [#1276](https://github.com/AgoraIO-Extensions/agent-infra/issues/1276) 的上海分阶段迁移方案
已由迁移 Owner 确认，替代下述 GZ3 目标地域。服务和数据库切换已分别取得执行授权并完成，
GZ3 release 已退役；这不意味着 Security/SRE 或业务 WRITE 的全部门禁已经通过。

## 上海分阶段迁移

目标控制面为上海 `hcicore-acs-sh-prod01` 的 `agent-connector` namespace，公开 origin 为
`https://agent-connector.agoralab.co`。已先迁 API/Web，再在停写与最终备份核对后迁入上海
PostgreSQL 17，权威数据库保持唯一，不双写。旧库保留为备份来源，不能直接恢复为写入主库。
当前发布、TLS 与回退操作以[生产部署说明](../architecture/connection-production.md)为准，
不得把迁移验收视为跨境数据或广泛生产合规批准。

切换时先冻结入口并处理在途 Call/Effect，关闭 GZ3 全部 API 和后台写入角色，再启动上海单主。
回退时先关闭上海写入，再恢复 GZ3；同库阶段不恢复旧备份或覆盖已提交的数据。身份 realm、
身份与凭证加密密钥、业务 IDs 和授权数据保持不变。DNS/TLS、新 issuer/resource、Provider OAuth
回调及客户端重新登录须验收；namespace 不替代 RBAC、资源配额、出口隔离或 Secret 分发门禁。

上海 GitHub 先使用直连，保留配置切换代理的能力：

- 不配置 `GITHUB_EGRESS_PROXY_URL` 时使用直连；配置有效代理地址时使用代理。
- 修改配置后重启 API 生效，不是热切换；新出口先验证连通性、TLS、真实 OAuth 和适用的
  Provider 验收，不自动沿用 GZ3 pilot 的出口风险接受。
- `GITHUB_READ_FALLBACK_PROXY_URL` 只能随主代理配置，用于既有只读回退契约，
  不表示 WRITE 或 OAuth code 可以自动跨路径重试。
- 无论直连或代理，已提交而响应未知的 WRITE 仍进入 `UNCERTAIN`；消费状态未知的 OAuth
  code 不换路径重放。出口与凭据保护、审计及恢复门禁不变。

生产切换、Secret 传输、正式镜像发布和外部配置修改按独立执行授权办理。常规上海发布只修改
已存在的 Deployment 镜像并保留数据库/CA/身份配置；旧 GZ3 命令拒绝部署，防止无意恢复旧控制面。

## 决策

以下为已被上海迁移替代的 GZ3 历史基线，不能用作当前部署目标。

Connection 的唯一 control plane、PostgreSQL authority、Identity、Credential、Grant、Call/Effect 和审计部署在 GZ3。国内 Provider 从 GZ3 直连；GitHub 服务端请求默认通过 `103.101.125.158:28062` 代理，GZ3 pilot 的首次 OAuth code exchange 适用下述直连回退，浏览器 authorize 页面仍由用户浏览器直接访问。该代理只用于 GitHub，不用于 GZ3 可直连的 Bitbucket、Jira、Confluence 或 Jenkins。GitHub WRITE 在请求提交后响应未知时仍进入 `UNCERTAIN`，禁止盲重试。拒绝 LA3/GZ3 双活数据库和通用多区域调度平台。

LA3 `connection-provider-egress` 的协议代码保留为未来 TODO，但不进入当前生产拓扑。只有 HCI 提供可审计的双向 workload mTLS、证书轮换、TLS passthrough 或等价可信入口，并完成 READ/WRITE crash-window 验收后，才能重新评审启用；不得以普通 HTTPS、共享 Token 或调用方可伪造的证书 Header 绕过门禁。

## GZ3 pilot：GitHub OAuth 出口回退

当前固定代理在 GZ3 返回 HTTP CONNECT 200 后重置 TLS 隧道；同一 Pod 的无凭证直连探测可到达 GitHub。这只证明直连传输在短测中可用，不证明真实 OAuth 成功或长期稳定。GZ3 pilot 操作负责人批准先发布并验证首次 OAuth 直连回退，不再以独立 Security/SRE NetworkPolicy 签收作为此次 pilot 的发布前置；广泛生产支持仍受 Issue #601 的 Security/SRE 和稳定性门禁约束。

- 仅 GitHub OAuth code exchange 可在提交 code 前，用不带 code、client secret 或用户 Token 的固定目标探测代理隧道。只有探测在业务请求发出前因传输失败，才为本次 exchange 选择受控直连；探测成功则继续走代理。
- 应用仅允许直连 HTTPS `github.com` 的 token endpoint 和 `api.github.com` 的账号身份读取，校验公网 DNS/IP 和 TLS 证书，拒绝 redirect；不得把本次回退用于其他 Provider、任意 URL 或 GitHub WRITE。应用限制不等于网络层出口隔离。
- code POST 一旦开始，任何 timeout、connection reset 或未知响应都不得换路径重放；提示用户重新发起 OAuth。直连 token exchange 成功后，同一次身份读取使用相同的受控出口；身份读取是 READ，但不能泄露 Token 或扩大 scope。
- 出口选择、探测失败类型和阶段只记录脱敏元数据，分别度量代理与直连的成功率、延迟和连续失败窗口。限时验证真实 OAuth、撤销与异常路径，并提供关闭直连的回滚手段；不得在日志、指标或错误中记录 code、Token、client secret、完整请求 URL。
- 当前操作者无权读取生产 NetworkPolicy，而同一 Pod 无凭证直连 `example.com` 成功，故不能声称直连出口已在网络层限于 GitHub。直连 fetch 在校验 DNS 后由 HTTP client 独立建连，尚不能证明连接固定到已校验 IP。GZ3 pilot 明确接受这些未核实的出口风险以先验证 OAuth；后续 Security/SRE 仍需解决广泛生产的网络策略与稳定性证据，不得把此次 pilot 当作该门禁已关闭。

## 证据

- GZ3 普通 Pod 到 Jenkins 公网入口成功，P50 约 70 ms；LDAP TCP P50 38 ms。
- GZ3 到现有美国 RDS TCP P50 170 ms、最大 1173 ms，因此 GZ3 control plane 必须使用国内 PostgreSQL。
- GZ3 直连 GitHub OAuth 在 5 次探测中仅 2 次成功；经固定 proxy 的 GitHub API、authorize 和 token endpoint 探测均为 5/5 成功，P50 约 1.1 秒。
- GZ3 到 LA3 Connection health 30/30 成功，P50 983 ms、P95 1702 ms；该短测只证明部署验证可行，不替代 24 小时 SLO 证据。
