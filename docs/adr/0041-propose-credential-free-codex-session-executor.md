# ADR-0041：Codex Session 使用无凭据的独立 executor（提案）

## 状态

提议，关联 #3054。须 Owner/架构评审；当前没有对应实现或生产启用批准。
完整执行边界以[工程 Spec §11.2.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1121-codex-session-独立-executor提案)
为准，协议接线见 [Runtime HLD §10.3](../architecture/HLD-agent-runtime-M1.md#103-codex-session-独立-executor-提案)。
本提案不修改现有模式的 Landlock、Provider sandbox 或凭据保护门禁。

## 问题

目标 ACK 环境缺少完整 Landlock ABI V5 和 Codex bwrap 所需 namespace 能力。
[ADR-0035](0035-codex-container-boundary-mode.md) 的专属 Pod 模式仍要求 Provider
`workspace-write`，因此仅有 Pod ready 不能证明原生 shell 可用。

固定 Codex `0.153.0` 的 RPC `SandboxPolicy` 支持 `externalSandbox`，与只接受三个值的
`sandbox_mode` 配置枚举不同。它只声明外部环境已提供隔离，并让 Codex 跳过自己的 sandbox
enforcement；直接给当前同容器、同 UID 的工具使用会暴露可见父进程环境和同卷 Host/native
状态。环境变量过滤、0700 目录和 attestation 均不能单独形成该进程/文件边界。

## 方案

复用现有 Session Pod 的网络、SA、专属 PVC 和生命周期，在其中增加无业务凭据的固定
`codex exec-server` 容器。控制容器保留 RuntimeHost、app-server、模型传输和授权状态；
executor 只持本 Conversation 工作区和获准工具。两个容器不共享 PID/mount 可见域，
只经同 Session 的 loopback 传递原生进程与文件 I/O。该边界由 CRI 在容器启动时提供，
不要求用户命令在容器内再创建 namespace。

固定 upstream 的 remote environment 同时提供 process 和 filesystem，模型 shell、patch
与图片读取都能使用该接缝。只采用由 Worker 绑定并核验的 remote environment；不存在
local fallback。标准 native 事件和平台授权/持久化边界保持，不新增业务工具调度器。

## 取舍

- 独立于新云节点池和 RuntimeClass，可先在现有 ACK 安全上下文内验证；实际 CRI、PID、
  `subPath`、网络与镜像能力仍须目标环境实测。
- 比直接改 RPC policy 多一个执行容器与资源额度，但凭据所在进程和文件系统不再与模型代码共置。
- 直接 loopback listener 没有独立跨 Pod 认证，故不暴露 Service，也不复用为共享 executor。
- 固定 exec-server CLI 标为 experimental，须随 pinned artifact、remote FS、取消/后台进程和
  故障恢复一起验证。模式有独立部署授权，不复用旧 `container-boundary` 的启用许可。
- 现有父进程 HOME 和完整 PVC 不可挂给 executor。工作区路径须在 Worker 侧从权威绑定确定，
  不能让 Sidecar 或模型启动时自行挑选其他目录。

## 实施与验收顺序

1. 先完成本提案与工程 Spec/HLD 的评审；仅文档合入不表示实现或业务验收通过。
2. 贯通 Worker 资源渲染/比较与容量回执、Host 绑定验证、Bridge remote-only 启动和 Driver Turn
   policy，保留默认 Landlock 与现有 `container-boundary` 路径。
3. 验证真实固定 Codex 的本人读写、shell、patch、图片与搜索；用合成 marker 证明控制侧凭据、
   文件、进程、FD、兄弟会话和路径别名不可达，并证明 executor 故障时不会本地执行。
4. 在目标 ACK 新 Session 上完成实际容器/挂载/网络/资源回读、真实模型、Web/企微、取消和
   重启恢复，以及 PNG/PDF 字节/hash 交付；#3054 的验收标准据正式已批准边界核实后再签收。

## 参考

- [OpenAI app-server command execution](https://learn.chatgpt.com/docs/app-server#command-execution)
- [Kubernetes 容器进程可见域](https://kubernetes.io/docs/tasks/configure-pod-container/share-process-namespace/#understanding-process-namespace-sharing)
- [Kubernetes subPath](https://kubernetes.io/docs/concepts/storage/volumes/#using-subpath)
