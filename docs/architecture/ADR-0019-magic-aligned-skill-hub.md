# Magic 对齐的 Skill Hub 与 Worker 装配

状态：accepted

Skill Hub 作为独立 P0 能力纳入 M1，按固定的 Magic Skill 语义提供 Skill project、不可变 Skill Version、四种发布范围、Provider Registry、安装/绑定、异步 materialization、按需 Runtime 加载和显式升级；本平台的规范目录为 .agents/skills，不兼容 .magic/skills。Skill Hub 由 Platform DB、版本化 S3 兼容对象存储、Platform API/Web、Platform Worker 和 Sandbox Runtime 组成，Skill Version 与 Agent Version 绑定事实由 Platform DB 保持唯一权威。

选择这一边界，是为了完整对齐 Magic 的可观察生命周期，同时保持 agent-infra 的权限和部署分层：platform-worker 只消费不可变包投影并负责 Desired/Applied、恢复和事实写回；Runtime 只在当前 Agent Version、Sandbox 和已批准 grant 的交集内发现和按需读取 Skill。Tool、Connection、文件、网络和脚本 grant 不能扩大既有授权，脚本默认关闭。外部 Provider、包路径、符号链接、发布者签名、digest、扫描和审核均由平台强制验证；Skill 不能成为新的权限主体、调度器、MCP Server 或 Agent Pod。旧 Driver/Host 缺少该契约时显式返回不支持，已有 Execution 不因 Skill 升级或重新获取目录而重放。

包字节、canonical manifest、签名/扫描准入、固定对象版本和发布重放的工程合同统一见 [工程 Spec §11.6.1–11.6.4](SPEC-agent-infra-M1-engineering-architecture.md#1161-包字节与摘要)。ADR 不重复定义证据格式；包供应实现须沿该合同交付实际字节验证和受控服务回读。

## 固定 `extraRoot` 与 Hub `.agents/skills` 共存

固定部署包与 Skill Hub 包是两个来源，不能合并成一个可写目录，也不能互相覆盖。当前 Codex 的固定验收包使用部署维护的只读 `extraRoot`（当前路径为 `/opt/codex/agent-infra-skills`）；它由镜像/部署配置固定，仍按 [Runtime HLD §5.3](HLD-agent-runtime-M1.md#53-固定官方能力矩阵) 的 provenance 和文件校验装配。它不是 Skill Hub 的 Skill Version、安装记录或 Agent Version binding，不能通过 Hub API 升级、回滚或撤销。

Hub 包只进入当前 Agent project 的规范布局：`.agents/skills/<name>/SKILL.md` 及其受控 `scripts/`、`references/`、`assets/`，索引为 `.agents/SKILLS.md`。Worker 从固定对象版本构造完整 generation，再以只读方式把该 generation 装配到 Sandbox；Runtime 只能读取当前 Agent Version、同步修订、Applied 和 grant 均已核对的 generation。`.magic/skills` 永远不是兼容路径，也不能作为迁移别名、回退来源或额外 root。

RuntimeHost 为每个 native Runtime 进程构造受控 roots 列表，并按固定顺序调用 Driver 的 root 配置接口：存在固定包时为 `[fixedExtraRoot, hubSkillsRoot]`，否则只传 `hubSkillsRoot`。其中 `fixedExtraRoot` 来自部署维护的固定 descriptor，`hubSkillsRoot` 由 Worker 的已确认装配摘要派生；两者都不是 Web、Owner、Skill 内容或 Runtime 请求可提交的路径。`.agents/SKILLS.md` 只索引 Hub generation，不把固定包的 manifest 拼入 Hub 索引。目录投影必须保留来源类别（deployment-fixed 或 skill-hub）、版本和摘要，统一经过 [Runtime HLD §5.1](HLD-agent-runtime-M1.md#51-命令与-skill-目录及调用) 的主体、Agent、Session 和 grant 检查。

两个 root 下出现相同 Skill name 时 fail closed，并记录可回读的冲突原因；不按 root 顺序选择优先级，不复制、symlink、overlay 或原地修改固定 root。这样既保留 Magic 的显式 `extraRoots` 语义，也避免固定包遮蔽 Hub 绑定版本或让 Hub 目录反向取得部署文件。固定包的内部路径和 Hub generation 的物理路径仍只留在 Host/Worker，Web/API 只接收不透明能力 ID 和版本摘要。

迁移固定包必须是一次显式的 Skill Hub 变更：先用实际 ZIP 经过 [工程 Spec §11.6.1–11.6.4](SPEC-agent-infra-M1-engineering-architecture.md#1161-包字节与摘要) 的准入生成新的 Skill Version，完成 Agent Version binding、同步、Worker Applied 和 Runtime 实际加载回执，再在新的配置修订中移除固定 descriptor。迁移期间不得同时启用同名的两个来源；任一步骤失败都保留原固定包并沿既有 configuration revision、Worker fence/CAS、outbox 和 recovery 重试。已运行 Execution 不因迁移或目录刷新改绑版本，也不使用旧 root 重新重放副作用。

物理 generation、只读装配和失败恢复由 #1545 承接；Runtime 目录、按需加载和四个 Driver 的 root 接缝由 #1547 承接，并向 #992 提供同一修订的合法目录/加载事实。三票复用现有 Agent Configuration Revision 和 Execution/Worker fence，不建立第二套 Skill 状态机或调度循环。
