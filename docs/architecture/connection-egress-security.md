# Connection 出站安全验证

本文件说明 [Connection HLD](HLD-connection-M1.md#274-ssrf-与网络出口) 的连接级 IP pinning
和网络策略验证，不替代 G-04、区域 ADR 或广泛生产评审。实现跟踪见
[Issue #1597](https://github.com/AgoraIO-Extensions/agent-infra/issues/1597)。

## 连接级校验

正式 Node runtime 的 Provider API、OAuth token/profile 和机器 Token 服务通过
`apps/connection-api/src/provider-fetch.ts` 创建受控 Undici Agent。每次新建连接时，Agent 的
`connect.lookup` 解析并校验全部地址，只把通过校验的 IP 返回给真实连接；底层不会再次独立解析。
复用连接仍连接原已校验地址，不把 DNS 变化当作更换账号或 Credential 的依据。

请求 URL 保留原 hostname，TLS SNI、证书 hostname 校验与 HTTP Host 不替换为 IP。Transport
拒绝不在该 Provider origins 中的目标、URL Credential、fragment 和调用方 Host/Proxy Header；
IP literal 在发送凭证前单独校验。DNS 失败、空答案或包含任一不允许地址时拒绝连接，不回退原始
fetch。没有新增 WRITE 或 OAuth code 重试。

公司固定 Jenkins internal route 只允许现有静态 origin，不新增任意私网目标。现有 HTTP Provider
例外的传输机密性仍需独立评审，IP pinning 不等于 TLS。

新的 pinned runtime 拒绝配置未证明连接级 pinning 的 GitHub forward proxy；它不会通过删除
配置自动改为直连。需要代理的环境必须先评审并实现绑定目标 IP、保留原 TLS hostname 的 CONNECT
transport。既有 GitHub 代理例外、区域选择和审批不能据此隐式扩大。

## 网络策略工件

从操作员审核的依赖清单生成策略：

```bash
node deploy/connection-network-policy.mjs reviewed-dependencies.json > connection-egress.json
kubectl --context <target-context> apply --dry-run=server -f connection-egress.json
```

清单包含目标 namespace 和 `dependencies` 数组。每条依赖包含 `kind`、精确 IP `address`、
`protocol` 和 `port`；`kind` 支持 `dns`、`ldap`、`postgres`、`provider`、`proxy` 和 `directory`。
DNS 必须包含 TCP/UDP 53，其他依赖仅支持明确 TCP port。清单必须包含 DNS、LDAP、PostgreSQL
和获准 Provider/出口。策略只选择 `app.kubernetes.io/name=connection-api`，其他目的流量默认拒绝。

生成器只接受单个 IP，输出 IPv4 `/32` 或 IPv6 `/128`，不接受任意 hostname、全公网 CIDR 或
按“所有 HTTPS”开放 443。依赖必须来自正式配置、不可变 Provider catalog 和审核后的网络目标，
不能把一次 DNS 查询结果自动视为批准。DNS/数据库/Provider 地址变化需要重新审核；旧策略
fail closed，不静默扩大网段。

在正式应用前必须检查目标 Deployment label、所有选择同一 Pod 的 additive policies、Service
DNAT 和 NodeLocal DNS 的实际目的地址。允许一个 DNS Service IP 不保证该 CNI 的实际 DNS 路径
已放行；必须验证 DNS、LDAP、数据库、每个 Provider 和 OAuth 路径。

## 集群 enforcement 探针

```bash
node deploy/verify-connection-network-policy.mjs <target-context> <node-runtime-image@sha256:digest>
```

调用者明确设置 `KUBECONFIG`，镜像必须含 Node.js 且使用固定 digest。脚本只在随机的
`connection-egress-probe-*` namespace 中创建不挂载 Credential 的 non-root server/client，验证：

1. 没有策略时可以连到测试 server。
2. client 的默认拒绝策略生效后，两次原始 TCP 连接均被拒绝。
3. 精确放行 server Pod/port 后连接恢复。
4. 删除本次创建的 namespace，不修改 Connection production workload 或集群组件。

输出只包含验证状态。`enforced=false`、探针启动失败或清理失败都返回非零退出码，不能作为
生产生效证据。Flannel 本身不证明具有 NetworkPolicy enforcement；API 接受策略、Pod Ready
或 server-side dry-run 成功也不证明流量被隔离。

## 发布边界

连接级源码、策略工件、CNI enforcement 和生产生效必须分别记录。未通过隔离探针时，不对
production 应用“已生效”的默认拒绝策略，不关闭出口安全 Finding 或 G-04；先由 SRE 提供策略执行
能力或获批的受控出口架构。不得在修复过程中自动安装全局网络插件。

连接级校验至少覆盖真实本地 TLS 的 Host/SNI/CA 验证、DNS rebinding、mixed public/private
答案、DNS 故障、IP literal、跨 origin、请求 Header 和 native Request body。上线前还需真实只读
Provider/OAuth 验证，以及应用内原始 TCP/fetch 无法越过网络策略的否定证据；应用白名单不能
替代这一层。
