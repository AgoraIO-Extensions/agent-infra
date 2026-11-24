# ADR-0055：M1 采用 Paseo SDK 与 Magic 风格 Sandbox

## 状态

已接受，关联 [#4456](https://github.com/AgoraIO-Extensions/agent-infra/issues/4456)。

## 背景

现有 Driver 路径同时维护 Provider 生命周期、原生命令、工具权限、进程边界和 Sandbox 资源。现有环境缺少 ECI 上完整的 Landlock ABI 5 通过回执。集群普通 ECS 的 Flannel 路径也缺少 NetworkPolicy 执行保障。继续把这些能力作为四个 Harness 主链路的前置条件，会把 SDK 接入和业务验收一起阻塞。

同一 ACK 集群的 Magic 部署配置为使用 `sandbox-gateway` 动态创建独立 ECI Sandbox Pod，配置独立 Agent 镜像、OSS CSI 工作区和 Pod 回收。它的功能运行回执不能签署 agent-infra 的完整安全加固，但可以作为 M1 Sandbox 生命周期的采用基线。

## 决策

- RuntimeHost 使用固定版本的 `@getpaseo/client` 调度 Codex、Claude、Pi 和 Generic ACP/OpenCode。RuntimeHost 维护 Platform Conversation 与 Paseo Agent 的绑定，Platform DB 仍保存消息、Execution、事件和回执。
- Sandbox 生命周期采用 Magic 风格的独立 Pod、独立工作区、动态创建、Ready 等待、重建和回收。Paseo daemon 只作为 Sandbox 内的 Harness 调度器，Paseo Agent ID、Timeline 和 daemon API 不进入 Platform 公共合同。
- SDK 只接收非敏感的 Harness 配置。模型凭据按 Execution 交付给受保护的 Runtime 路径，不写入 Paseo 持久配置、普通事件或日志。
- M1 主验收覆盖 create、prompt、stream、completion、restart、recovery、原生命令发现与调用、重复提交、跨 Conversation 隔离和凭据隔离。`/compact` 与 `/goal` 按各 Harness 的真实目录和支持状态验收。
- Shell、Landlock 和 NetworkPolicy 分别记录探针状态。原生文件和终端工具在所属 Sandbox 的工作区及权限内执行。探针失败时显示不可用，不能伪造为通过，也不阻塞不依赖这些能力的 Harness 主链路。
- Paseo SDK 路径逐模板通过真实 Web 验收后，退役对应的自研 Driver。未通过的模板继续使用旧 Driver 作为回退。

## 备选

- 把 ABI 5 节点和 NetworkPolicy 作为四个模板的共同前置条件。未采用，因为当前集群能力不足会阻塞 SDK、会话和原生命令的业务验证。
- 继续为每个 Harness 维护完整自研 Driver。未采用，因为与“使用上游 Harness 生命周期”目标重复。
- 直接复制 Magic 的所有 Sandbox 与凭据设计。当前决定覆盖 Sandbox Pod 生命周期和工作区装配。具体组件选型由实现工单记录。

## 后果

M1 更快获得四个 Harness 的可用性和用户体验证据，并减少重复 Provider 生命周期代码。Shell 和网络隔离状态需要单独跟踪，不能由业务链路结果推断。后续启用完整工具能力前，仍需完成 [ADR-0053](0053-restore-native-shell-on-landlock-capable-nodes.md)、NetworkPolicy 执行验证和相应的费用与节点准入评审。

## 验收

- 同一 ACK Web 入口完成四个 Harness 的真实对话和原生命令验收。
- 刷新、Runtime 重启和 Sandbox 重建后，原 Conversation 能回读同一结果且不重复副作用。
- 两个主体不能读取或调用另一个主体的 Conversation、Sandbox、凭据和 Paseo Agent。
- 每个 capability 记录 `available`、`unavailable` 或 `unknown` 及探针来源。
