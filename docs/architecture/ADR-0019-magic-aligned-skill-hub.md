# Magic 对齐的 Skill Hub 与 Worker 装配

状态：accepted

Skill Hub 作为独立 P0 能力纳入 M1，按固定的 Magic Skill 语义提供 Skill project、不可变 Skill Version、四种发布范围、Provider Registry、安装/绑定、异步 materialization、按需 Runtime 加载和显式升级；本平台的规范目录为 .agents/skills，不兼容 .magic/skills。Skill Hub 由 Platform DB、版本化 S3 兼容对象存储、Platform API/Web、Platform Worker 和 Sandbox Runtime 组成，Skill Version 与 Agent Version 绑定事实由 Platform DB 保持唯一权威。

选择这一边界，是为了完整对齐 Magic 的可观察生命周期，同时保持 agent-infra 的权限和部署分层：platform-worker 只消费不可变包投影并负责 Desired/Applied、恢复和事实写回；Runtime 只在当前 Agent Version、Sandbox 和已批准 grant 的交集内发现和按需读取 Skill。Tool、Connection、文件、网络和脚本 grant 不能扩大既有授权，脚本默认关闭。外部 Provider、包路径、符号链接、发布者签名、digest、扫描和审核均由平台强制验证；Skill 不能成为新的权限主体、调度器、MCP Server 或 Agent Pod。旧 Driver/Host 缺少该契约时显式返回不支持，已有 Execution 不因 Skill 升级或重新获取目录而重放。

包字节、canonical manifest、签名/扫描准入、固定对象版本和发布重放的工程合同统一见 [工程 Spec §11.6.1–11.6.4](SPEC-agent-infra-M1-engineering-architecture.md#1161-包字节与摘要)。ADR 不重复定义证据格式；包供应实现须沿该合同交付实际字节验证和受控服务回读。
