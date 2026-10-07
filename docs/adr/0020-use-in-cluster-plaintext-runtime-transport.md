# Worker 到 RuntimeHost 使用集群内明文 HTTP

## 状态

已接受，归属 [#1420](https://github.com/AgoraIO-Extensions/agent-infra/issues/1420)。取代 [#1164](https://github.com/AgoraIO-Extensions/agent-infra/issues/1164) 采用、[#1326](https://github.com/AgoraIO-Extensions/agent-infra/issues/1326) 实现的 Runtime server TLS 契约。

## 背景

server TLS 契约要求部署为每个 Agent 级 Workload 和每个 Session Sandbox 签发、发布和轮换独立 server leaf，并让 Worker 信任对应 CA。仓库和 Helm 都没有生产签发来源，Session Sandbox 按会话动态分配，leaf 无法预先交付。结果是 Web 会话的 Sandbox 领取始终失败，消息无法到达 Runtime。

[Magic sandbox-gateway](https://github.com/dtyq/magic/blob/f9973c5cfe5d668867b1a8dc5c50e4be5081ee56/backend/sandbox-components/pkg/sandbox-gateway/services/util/helper.go) 在同一位置按话题动态创建 `sandbox-<id>` Pod 和同名 Service，并通过集群内 `http://sandbox-<id>.<ns>:<port>` 转发请求。

## 决策

1. Worker 到 RuntimeHost 的 business、verified control、readiness 和 Session Sandbox 调用都使用集群内明文 HTTP。
2. 只连接服务端解析出的精确 origin `http://<Service>.<namespace>.svc:<port>`。拒绝其他 scheme、userinfo、query、hash 和 redirect，调用方不能覆盖 origin。
3. 执行授权不变：Host 继续校验部署 service token，并按 [Spec §9.3](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#93-服务端授权上下文) 校验 signed readiness 和业务/控制 Grant 的签名、对象、用途、时间、幂等和 fence。
4. Runtime Pod 的 NetworkPolicy ingress 只放行 Worker；Agent 级 Workload 和 Session Sandbox 都适用。
5. 不签发 Runtime CA 或 server leaf，不挂载 `runtime-tls` Secret，kubelet readiness 使用 HTTP。

## 风险与边界

- 接受的风险：能观察集群 Pod 网络的节点、CNI 或特权组件可以看到 service token、Grant、会话正文和执行期交付的模型 Key。捕获的 Grant 仍受用途、对象、有效期、持久幂等和 fence 约束；service token 泄露时，部署须在两端撤旧并受控重载。
- 适用边界：仅限同一 Kubernetes 集群内的 Pod 网络。跨集群、跨 VPC 或经过公网的 Runtime 访问必须使用 TLS，并重新评审，不能沿用本决策。
- 不变部分：浏览器到 Web/API 入口、workload route Ingress、目录 LDAPS、Registry、模型端点和 Connection profile 的 TLS 校验均不变。Worker 的 `trustedCaSecretRef` 继续服务这些依赖。

## 迁移

旧 TLS Pod 在新的期望 Pod 规格下判定为 drift，由既有 fenced 调谐替换，不保留双栈或 HTTPS 兼容层。替换期间仍沿原持久流程停止新准入、核实原执行；旧控制不可达时保持 pending/unknown，不重放副作用。

## 备选方案

- **保留 server TLS 并为每个 Session 动态签发 leaf：** Worker 须持有 CA 私钥，或新增签发服务；会扩大 Worker 权限和部署单元，当前无生产签发来源，拒绝。
- **mTLS：** 在 server TLS 成本上再增加 client leaf 供应和双向轮换，拒绝。
- **集群内模型网关替换 Sandbox 出站：** 属于新增部署单元，不在本决策范围；出站仍按 [Spec §10.1.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1011-session-owned-sandbox-权威与资源绑定) 的精确出站策略执行。
