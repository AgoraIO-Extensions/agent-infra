# ADR-0035：ACK Codex 使用专属 Runtime Pod 作为容器隔离边界

## 状态

提案，依赖 #3054 的 Owner/架构评审。默认 Landlock 路径保持不变；本 ADR 只定义 ACK
节点缺少 Landlock ABI V5 时的可选部署模式。

## 背景

ACK 的 ECI 内核无法安装 `fs:ioctl-dev`，普通 ECS 节点也无法安装同一 ABI V5 规则集。
当前 Codex Bridge 因此正确地拒绝启动。Paseo 的 Docker 部署采用专属容器作为 Agent
边界，并把 Codex 的 `sandbox_mode` 留给 Provider；ACK 的每个标准 Runtime Workload 和
每个 Session Sandbox 都由 Worker 创建专属 Pod、PVC、ServiceAccount、NetworkPolicy 和
Secret，具备相同的拓扑前提。

## 决策

新增 Worker-owned standard Runtime Pod `container-boundary` isolation mode：

1. 只有部署配置显式设置 `policy.codexContainerBoundaryEnabled: true` 时，平台 Worker
   才为标准 Agent-level Workload 或业务 Session Sandbox 注入；自定义 Agent、共享 Pod、
   Owner env 和请求字段不能选择或覆盖它。Agent scope 使用 Agent ID，Session scope 使用
   可打印的 Agent/Session 组合并保持与 attestation 输入一致。
   Worker 使用本次 Runtime service token 对 Agent/Session scope 生成 HMAC attestation，Host
   必须验证该 attestation；两个普通环境变量本身不构成准入证明。
2. Bridge 不执行 Landlock `setpriv` 探针，不使用平台 Conversation allowlist；Codex
   使用 `sandbox_mode=workspace-write` 和固定的官方 lane 配置。
3. 该模式只适用于专属 Runtime Pod。Pod 必须继续满足 non-root、read-only rootfs、drop
   ALL、no-new-privileges、RuntimeDefault、独立工作区/PVC、专属 NetworkPolicy 和 Secret。
4. Relay Key、模型 loopback token、Connection/MCP/Browser 凭证仍不得进入原生工具子进程；
   `AGENT_INFRA_*` 仍由 Codex shell 环境排除。跨 Sandbox 的模型、Connection、平台文件和
   Browser 调用仍保留原有 intent/授权屏障。
5. 默认 `landlock` 模式和私有 callback/Connection lane 不变；`container-boundary` 不得
   用于私有 lane。标准 Workload 或 Session 缺少 Worker 注入、专属资源、安全上下文或
   attestation 时，Runtime 自动回到 Landlock 并在不具备 ABI V5 时 fail closed；部署验收必须
   在该模式下看到真实 Codex readiness 通过，不能用 Pod Ready 替代。

## 验收

- 在目标 ACK 节点使用与生产一致的标准 Workload Pod 安全上下文，真实 Codex app-server Turn 和
  `exec_command`/文件编辑成功。
- 同一 Pod 内工具不能读取平台服务凭证；另一 Session 的 Pod/PVC/Service/网络目标不可达。
- Web 和企微各完成一轮真实 shell 与文件编辑，多轮对话和重启恢复通过。
- Landlock 模式、私有 lane、跨 Session 负向测试仍通过；没有通过改写旧 receipt 或关闭
  NetworkPolicy 证明成功。

## 取舍

该模式把文件/进程边界的主要责任从 Runtime 内核 allowlist 转移到 Kubernetes 专属 Session Pod
边界和 Codex Provider sandbox。它适合 ACK 当前节点能力，不能推广到共享 Runtime Pod、没有
独立工作区的部署或缺少 NetworkPolicy/Secret 归属证明的环境。
