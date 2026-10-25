# ACK Runtime 隔离预检

Worker 可运行在 ECI。Runtime 的系统要求按 Driver 单独确认；Codex 默认需要镜像中包含新版
`setpriv`，并由目标内核实际安装 Landlock ABI 5 的 `ioctl-dev` 规则。容器镜像不能补齐
宿主内核缺失的能力。经 ADR-0035 评审的标准 Runtime Pod 可使用 Worker-owned
`container-boundary` 模式，由专属 Pod/PVC/NetworkPolicy 和 Codex `workspace-write` 承担
边界；该模式必须单独做 Pod 安全上下文、跨 Session 负例和真实工具验收，不能用 Landlock
预检结果冒充。Pi 等 Messages Driver 不能替 Codex 通过任一检查。

镜像使用正式 `deploy/release/build-images.mjs` 或 `publish-images` workflow 的产物，
从发布 receipt 选择节点架构对应的 OCI image manifest Digest。不要使用 tag、multi-arch
index 或临时简化的 Dockerfile。每个模板仍需同一 image/Driver/configurationRevision 的真实
模型验证记录；模型端点和 Key 通过已有私有配置及 Secret 交付。

在仓库外的环境文件设置 `ACK_KUBECONFIG`、`ACK_RUNTIME_IMAGE`（完整 `repository@sha256:…`）
与 `ACK_NAMESPACE`。私有镜像可设置 `ACK_IMAGE_PULL_SECRET`。需要指定节点时，设置
`ACK_RUNTIME_PLACEMENT_FILE` 指向仓库外 JSON；它只接受 `labels`、`annotations`、
`nodeSelector`、`tolerations`，内容须与待部署 Runtime 的实际调度条件一致。

```bash
ACK_RUNTIME_DRIVER=codex node deploy/ack/runtime-isolation-preflight.mjs
```

脚本创建唯一命名的无凭证 Pod，按 non-root、read-only rootfs、禁提权、drop ALL 和
RuntimeDefault seccomp 执行真实规则安装。调度、拉取、工具或内核失败均返回非零；结束前
核对 ownership 再清理。namespace 应预留 1 CPU / 2 GiB limits 配额。它只验证该目标的
Codex 隔离能力，不验证网络、模型或用户业务流程。

ECI 的 NetworkPolicy 需要 ACK 的 Poseidon 支持，ECS 的 Terway 配置不能替 ECI 生效。
部署方须按[阿里云 ECI NetworkPolicy 文档](https://www.alibabacloud.com/help/en/ack/serverless-kubernetes/user-guide/using-the-network-policy-networkpolicy)
启用组件，并实际验证已知可达目标在 deny-all 后不可达、放行后恢复。仅创建 NetworkPolicy
对象不能证明隔离成立。ESSD 持久卷还须满足 StorageClass 最小容量及 namespace quota。

完整验收顺序：目标节点隔离与网络检查、同一不可变镜像的真实模型验证、浏览器申请/审批、
Worker 创建 Session Pod/PVC、实际回复和 SSE 回读。组件 readiness 与受控 fixture 均不能
替代后续步骤。
