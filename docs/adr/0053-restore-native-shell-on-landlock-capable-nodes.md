# ADR-0053：在支持 Landlock 的节点恢复非 Codex 原生 shell

## 状态与选择

Refs #4481。待独立复审；本 ADR 不声明生产能力已通过，也不授权创建节点池或部署。
选择方向 **(b)：Claude、OpenCode、Pi 的 Session 使用支持完整 Landlock ABI 5 的专用节点池**。
执行边界、部署前提与验收只在[工程 Spec §10.14.1](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#10141-非-codex-模板的-landlock-节点准入)
完整维护；PRD 的完整原生工具要求保持，不用削减 shell 换取隔离结案。

## 问题与源码依据

[native-shell](../../packages/agent-runtime/src/native-shell.ts) 的 `probe` 实际运行
setpriv 的 `fs:ioctl-dev` 规则安装，随后 `nativeShellPlan` 为命令限制 cwd、环境、可读写根与 FD。
[native-shell-admission](../../packages/agent-runtime/src/native-shell-admission.ts) 用固定 launcher
执行真实 `true`，失败返回不可用；不能只检查可执行文件存在。
[CLAUDE shell](../../packages/agent-runtime/src/claude-shell.ts) 通过 `-c -l true` 核验同一入口。
[Pi bootstrap](../../packages/agent-runtime/src/pi-bootstrap.ts) 与
[OpenCode bootstrap](../../packages/agent-runtime/src/opencode-bootstrap.ts) 在不可用时过滤或拒绝 shell。
因此缺内核能力会造成工具能力缺失，不是模型自行选择不调用。

可回查的接缝：`native-shell.ts:63–86,119–172`、`native-shell-admission.ts:14–40`、
`claude-shell.ts:7–11,15–40`、`pi-shell.ts:10–32`、`pi-bootstrap.ts:148–155`、
`opencode-bootstrap.ts:319–323,459–466`。版本按仓库 release 声明和 lockfile 固定：
OpenCode native 1.19.0、Claude SDK 0.3.246、Pi 0.99.0；不从其他版本文档推断此版本能力。

现场依据是 #4349 的生产写入方只读报告：Helm 104 / App d21c956ba 中镜像已有 launcher 和
setpriv 2.42.3，但历史 ECI 内核为 5.10.134-lifsea8，无完整 Landlock；本次未执行 ECI syscall
探针，当前 ABI 仍须按 Spec 的计划实测。实现差额也已确认：`apps/platform-worker/src/agent-workload-placement.ts` 目前只接受 ECI
virtual-kubelet 形状，`session-workload-adapter.ts:1372` 消费已验证的 placement；因此新池需要
App 的模板级 placement/严格 Schema 与准入规则配套变更，不能直接改 Helm env 偷渡 ECS。
部署限制另见
[Runtime 预检](../../deploy/ack/RUNTIME-PREFLIGHT.md)及
[ADR-0041](0041-propose-credential-free-codex-session-executor.md)。

## 两个方向的比较

| 维度 | (a) 原生 shell 接到独立 executor | (b) 支持 ABI 5 的节点池（选定） |
| --- | --- | --- |
| Claude | 已有 `CLAUDE_CODE_SHELL=/opt/agent-infra/native-bash.mjs`；可将自有 launcher 改为远程桥，但须证明 pinned harness 无本地 fallback | 原入口不变，完整规则实际安装后使用原 Bash |
| OpenCode | bootstrap 可写 `shell=/opt/agent-infra/native-shell.mjs`，execute 权限继续原生映射；远程桥须支持其 cwd/流/终止协议 | 原 shell 配置与 execute 接缝不变，按原版本重新准入 |
| Pi | [pi-shell](../../packages/agent-runtime/src/pi-shell.ts) 已用 `createBashToolDefinition` 的 `shellPath`、`spawnHook`；可将自有 launcher 转桥，不修改上游包 | 原 tool factory、输出和取消保留，恢复原生 shell 目录 |
| 文件和上下文 | 三者均无已证的 Codex remote process + filesystem 统一协议；单换 shell 不能代替文件工具或证明取消/后台回收 | 保留现有文件策略及 Landlock；仍须实测 /proc、FD、凭据和网络负例 |
| 部署 | 每 Session 增加无凭据 executor、受认证私有通道和资源额度；不能把工作区路径/env 当可信身份 | 增加受控内核节点池、调度与网络准入；ECI 不能通过换容器镜像升级宿主内核 |
| 当前阻断 | #4374 表明 ECI 的 executor launch isolation 也缺内核/见证前提；不能用双容器数量直接宣称隔离等价 | OS/内核/CRI 支持、实际 ABI、NetworkPolicy 执行者、报价尚待部署方确认 |

(a) 的表中是自有 wrapper 的候选接线，不是现成可用的远程执行实现。命令不能携带控制侧环境，
远程桥须保持 native item/operation、stdin/out、exit、取消和原会话绑定，无 executor 时拒绝，
并完成同 UID、防重放及所有凭据负例。直接使用 Codex exec-server 为通用远程 shell 后端需要
新协议适配，当前未证明；不 patch Claude/OpenCode/Pi 上游，也不扩用 Codex §10.11 的例外。

(b) 复用已存在的 launcher 强制点和原生工具，不增加远程工具协议。代价是改变三个模板的
Session 放置；它不是“现有 ECI 一定能支持”的承诺。若厂商不能提供受支持内核且实际执行
NetworkPolicy 的目标，该方案保持阻塞，回到架构评审，不降级安全或静默转 (a)。

## 内核、节点池与成本依据

[Linux 官方 Landlock 文档](https://docs.kernel.org/userspace-api/landlock.html)定义 ABI 5 的
`LANDLOCK_ACCESS_FS_IOCTL_DEV`；[Linux man-pages](https://www.kernel.org/pub/linux/docs/man-pages/book/man-pages-6.10.pdf)
列出主线 6.10 引入 ABI 5，要求按 ABI 而非版本号判断。建议候选使用厂商支持的 6.12 LTS
或有完整回移的受支持镜像，仍以实际 syscall/规则安装为准，不能仅凭这个建议选 OS。
[阿里云 Linux 版本说明](https://www.alibabacloud.com/help/en/alinux/product-overview/features-and-advantages)
列出 Linux 3/4 基于 5.10/6.6，本身不证明 ABI 5。[ACK 自定义镜像约束](https://www.alibabacloud.com/help/en/ack/ack-managed-and-ack-dedicated/user-guide/create-a-node-pool)
要求基于受支持 OS 且预先验证，不能在生产节点临时换内核。

[ACK NetworkPolicy 文档](https://www.alibabacloud.com/help/en/ack/ack-managed-and-ack-dedicated/user-guide/use-network-policies)
限制普通 ECS 的 Terway/ENI 模式；当前 flannel ECS 不合格。若本集群不能交付受支持网络执行者，
必须先有 Workload Plane 变更设计；不修改平台 CNI 来冒充一次普通节点扩容。

[ACK 计费](https://www.alibabacloud.com/help/en/ack/ack-managed-and-ack-dedicated/product-overview/billing-of-cloud-services)
将 worker ECS、磁盘、网络等分别计费；[ECI 计费](https://www.alibabacloud.com/help/en/eci/product-overview/elastic-container-instances)
按 CPU/内存和时间收费。专用池有节点空闲保有成本；选 (a) 则增加每个活跃 Session 的 executor
CPU/内存成本。两者均保留原 Session PVC，不能把双容器额外成本或 ECS 空闲费算成零。

部署前按同 region/zone、计费方式、架构和实际 Node Allocatable 给出报价：
`节点数 × ECS 单价 × 时长 + 系统/数据盘 + 网络/CNI/安全组件 + 原 PVC`；节点数取 CPU、内存、
Pod 配额、ENI/IP 与磁盘挂载容量的最大约束，扣除 DaemonSet 和系统预留。起步可评估两节点
故障余量，但并非已批准规格或资源请求；单节点只用于合成验证，不能代签可用性。
本设计没有云账号报价权限、型号/折扣及实际目标节点，不填写虚构金额；精确 SKU、月度上限、
可支持 Session 数和相对 ECI 增量必须随默认关闭的 Helm/部署 PR 评审，获批后才开资源。

## 与既有决定的关系

ADR-0041 是 Codex executor 的原提案，本 ADR 不推广其当前实现，也不把 Codex 的 M1 限定
暴露例外给其他模板。#4374 的 Post-M1 launch/内核和叶子见证仍独立，不自动解锁。
本票是用户新要求的三模板 shell 恢复；上线后四模板分别验命令和隔离，不用 Codex 成功代签。
