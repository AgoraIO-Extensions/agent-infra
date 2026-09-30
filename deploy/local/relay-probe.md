# 受控 Relay A/B 网络探针

此入口为 #504 的隔离测试准备两个 HTTPS Pod 和 Service：A 代表 Catalog 批准的地址，
B 代表格式合法但未获批准的地址。A 收到 `?redirect=b` 时返回指向 B 的 307。
服务只返回合成 JSON；它不会调用模型 Provider、Connection 或真实 Relay。
计数回执只包含请求数、携带 Authorization 的请求数和重定向数，不记录头部值、正文或 Key。

先在有 CNI 的隔离 kind 中创建与实际 Agent Pod 相同的 namespace。复制
[输入模板](relay-probe.env.example)到仓库外并填写绝对路径；使用独立于其他业务的
空状态目录。命令要求显式 kubeconfig、`kind-*` context、namespace 和 Digest 固定镜像，
并拒绝非 loopback Kubernetes API。它只创建带随机 probe ID 的 ConfigMap、TLS/CA Secret、
两个 Deployment 和 Service；不创建或放宽 NetworkPolicy。

```bash
source /absolute/private/path/relay-probe.env
node deploy/local/relay-probe.mjs up
node deploy/local/relay-probe.mjs status
node deploy/local/relay-probe.mjs reset
# 在相同源码、镜像、Profile 和 NetworkPolicy 下运行 #508 的同链测试。
node deploy/local/relay-probe.mjs receipt
node deploy/local/relay-probe.mjs stop
```

`up` 输出 A/B 的集群内 HTTPS 地址、公开 CA 文件和合成 Key 文件的私有路径。
合成 Key 在本地以 `0600` 保存，只把其路径交给测试，不把值写入回执。
`<probe-name>-ca` Secret 只含 `ca.crt`，可用于 Worker
`platformWorker.trustedCaSecretRef`；Agent Pod 执行期 CA 信任须在自己的实际请求中
另行验证。服务证书同时包含 A/B Service DNS SAN，避免关闭 TLS 校验。

测试的唯一允许模型目标应为 A：在部署拥有的 `modelEgress` 中指定当前 namespace、
Pod 标签 `agent-infra.agora.io/probe-id=<probe-name>` 与
`agent-infra.agora.io/probe-endpoint=a`、TCP 8443；DNS 使用既有受限
`dnsEgress`。不要给 B、整个 namespace 或所有 IP 加允许规则。
在正式 candidate/preflight 之前拒绝合法但未批准的 B，随后验证 A 的直接请求；
再让 A 重定向到 B，要求 B 请求数与携带 Authorization 的请求数均为零。
`reset` 只清理计数，`receipt` 写入私有状态目录；每个步骤单独取回执。
Worker 预检与 Agent Pod 模型请求分别取证，不能用组件测试替代同一 Pod 的网络结果。

此环境只证明受控目标的网络、TLS 和授权传播行为。真实模型协议、Provider Key scope、
真实 LDAP、申请审批、Pod/PVC 和业务重启仍按 #504 验收。`stop` 只删除本次标记的探针对象
及本地临时私钥，保留公开 CA 和脱敏回执；不清理 Agent PVC、业务卷或运行服务。
