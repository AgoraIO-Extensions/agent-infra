# 按目录协议绑定标准模板模型配置

[#437](https://github.com/AgoraIO-Extensions/agent-infra/issues/437) 引入 Claude Native，成为
共享模型配置的首个非 Responses 消费方。现有候选验证固定使用 Responses，Runtime V2
配置又不携带目录 profile；仅改 Driver 或探测 URL 无法保证预检与实际执行使用同一协议和
认证方式。

由部署目录声明模型协议与认证，Worker 在既有每选项验证、Secret 绑定和候选回滚流程中
保留这组信息，Host 消费版本化配置并校验其与固定 Driver 绑定一致。新增 profile 使用 V3，
旧 V2 保留 Codex/Responses 语义；执行命令仍只传已固化的平台模型选项及 reasoning。
字段、验证和兼容规则由[工程 Spec §10.7](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#107-标准模板模型配置)
完整定义。

这次扩展增加一个真实需要的配置版本，避免从 endpoint、模型名或 Owner 环境变量猜测协议，
也避免各 Driver 分别创建目录、凭证或回滚系统。它不引入平台模型代理、路由、供应商发现或
协议转换，也不提前定义尚无真实消费方的 profile。

Claude 使用官方 SDK，并按 [Runtime HLD 的上游复用条款](../architecture/HLD-agent-runtime-M1.md#13-上游复用与非目标)
采用已有 Query 生命周期实现。更换选项时，协议、endpoint 和 credential 的绑定与原 Session
连续性必须同时验证；SDK 的模型名切换不能替代该证明。既有身份、持久幂等、隔离和脱敏
要求不因源码复用而降低。

固定 SDK `0.3.246` / CLI `2.1.246` 的合成错误验证确认：API 错误正文会进入 SDK assistant
消息和原生会话文件，正文回显的凭证也会被保存。因此 Claude 在原生持久化前使用每 Query
绑定单一获准选项的本地传输入口，真实凭证留在 Driver 内存，原生进程只接收短期能力。
该边界也阻止原生重试盲目重复不确定调用；完整规则见
[工程 Spec §10.9](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#109-claude-原生模型传输边界)。
