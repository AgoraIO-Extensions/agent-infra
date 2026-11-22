# ADR-0051：Connection 标准客户端的内存访问保护接受 Yama 2/3 或凭据持有进程 non-dumpable

## 状态

提案，归属 [#4199](https://github.com/AgoraIO-Extensions/agent-infra/issues/4199)，同属
[#4157](https://github.com/AgoraIO-Extensions/agent-infra/issues/4157) 与
[#4155](https://github.com/AgoraIO-Extensions/agent-infra/issues/4155) 的交付线。用户于
2026-11-22T09:3xZ 选定（[#4199 评论 7077345348](https://github.com/AgoraIO-Extensions/agent-infra/issues/4199#issuecomment-7077345348)）。
须经非实现方独立评审后合入。完整条件只在
[工程 Spec §13.5.4“初始受保护 Host profile”](../architecture/SPEC-agent-infra-M1-engineering-architecture.md#1354-runtime-driver-直接消费标准-mcp)
维护；本 ADR 只记录取舍、等价性依据和残余风险，不单独覆盖两份 PRD、工程 Spec 或 HLD。
它增补 [ADR-0019](0019-run-standard-mcp-in-protected-runtime-driver.md) 的初始 Linux 内存准入，
不改变 ADR-0019 的其他决定。

## 问题

工程 Spec §13.5.4 原先要求可信内核 Yama `ptrace_scope=2` 或 `3`，用来阻止同 UID 工具对
凭据持有进程的 attach-mode 内存访问及 `pidfd_getfd`。生产 Session 运行在 ACK ECI
（[ADR-0049](0049-run-agent-workloads-where-networkpolicy-is-enforced.md)），其内核
`5.10.134-18.0.13.lifsea8` 没有 Yama（`/proc/sys/kernel/yama` 不存在，见 #4199 决定），也不能
创建 Landlock 规则集（`landlock_create_ruleset` 返回 `Function not implemented`，见
[#3054 评论 6358405895](https://github.com/AgoraIO-Extensions/agent-infra/issues/3054#issuecomment-6358405895)）。
Host 因此按原规则 fail closed，ECI Session 上的 Connection 安装与调用都不可用。

## 决策

内存访问保护改为二选一：

1. 可信内核 Yama `ptrace_scope` 为 `2` 或 `3`；
2. 凭据持有进程（Runtime Host 与安装供应 initializer）在读取任何受保护材料、创建任何子进程
   之前设为 non-dumpable，并在每次读取前回读。

第 2 项另有三个前提：`fs.suid_dumpable` 不为 `1`；进程不改变自身凭据；进程不运行在由工具
UID 创建的 user namespace 中。第 2 项只在 Pod 只属于一个 Session 时适用。两项都不成立时，
仍按原规则 fail closed。无论选哪一项，最终镜像都须在目标放置上逐项通过负例。

独立 executor 的工具启动隔离（工程 Spec §11.2.1）不在本决定范围内。它要保护的 upstream
`exec-server` 由 execve 启动，启动后恢复 dumpable，Host 设置的 non-dumpable 管不到它。该路径
仍要求 Yama `1`、`2` 或 `3`，M1 不启用，现场项见
[#4374](https://github.com/AgoraIO-Extensions/agent-infra/issues/4374)。

## 等价性依据

依据是 upstream stable `v5.10.134` 源码。ECI 是厂商内核，行号和行为可能不同，以目标放置上
的负例为准。

- 公共判定是 `__ptrace_may_access`（[kernel/ptrace.c L291–362](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/kernel/ptrace.c?h=v5.10.134#n291)）。
  同 UID 调用方先通过 uid/gid 检查（[L332–338](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/kernel/ptrace.c?h=v5.10.134#n332)）。
  随后，如果目标的 mm 不是 `SUID_DUMP_USER`，且调用方在 `mm->user_ns` 中没有
  `CAP_SYS_PTRACE`，判定返回 `-EPERM`（[L354–359](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/kernel/ptrace.c?h=v5.10.134#n354)）。
  没有 Yama 时，这是唯一的拒绝点，ATTACH 与 READ 两种 mode 都受它约束。
- 因此，对 non-dumpable 的凭据持有进程，下列访问都会被拒绝：
  - `ptrace(PTRACE_ATTACH/SEIZE)`：`ptrace_attach` 以 `PTRACE_MODE_ATTACH_REALCREDS` 调用该判定（[kernel/ptrace.c L437](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/kernel/ptrace.c?h=v5.10.134#n437)）。
  - `process_vm_readv/writev`：经 `mm_access`（[mm/process_vm_access.c L203](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/mm/process_vm_access.c?h=v5.10.134#n203)、[kernel/fork.c L1239–1242](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/kernel/fork.c?h=v5.10.134#n1239)）。
  - `/proc/<pid>/mem`：在 open 时由 `proc_mem_open` 检查（[fs/proc/base.c L800](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/fs/proc/base.c?h=v5.10.134#n800)）。
    检查只发生在 open 时，之前打开的 FD 仍然有效，所以设置必须早于任何不受信同 UID 进程出现。
  - `pidfd_getfd`：`__pidfd_fget`（[kernel/pid.c L635–638](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/kernel/pid.c?h=v5.10.134#n635)）。
  - `/proc/<pid>/fd` 链接与 `environ`：二者使用 READ mode（[fs/proc/base.c L672–686](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/fs/proc/base.c?h=v5.10.134#n672)、[L934](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/fs/proc/base.c?h=v5.10.134#n934)）。
    另外，`fd`/`fdinfo` 目录的属主变为 root（`task_dump_owner`，[L1813–1869](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/fs/proc/base.c?h=v5.10.134#n1813)）。
    Yama 只限制 ATTACH mode（[security/yama/yama_lsm.c L360](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/security/yama/yama_lsm.c?h=v5.10.134#n360)），
    所以这几项比 Yama 2 更严。
- 工具在自建的 user namespace 中取得的能力，对 Host 所在的上层 namespace 无效
  （[security/commoncap.c L83–84](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/security/commoncap.c?h=v5.10.134#n83)）。
  唯一的例外是目标 namespace 由调用方 euid 创建（[L90–91](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/security/commoncap.c?h=v5.10.134#n90)），
  所以前提要求 Host 不运行在由工具 UID 创建的 user namespace 中。
- 会恢复 dumpable 的情况：
  - execve 只影响新映像（[fs/exec.c L1336–1346](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/fs/exec.c?h=v5.10.134#n1336)），Host 不 exec 自身；
  - 凭据变化时，状态被设为 `suid_dumpable`（[kernel/cred.c L456–463](https://git.kernel.org/pub/scm/linux/kernel/git/stable/linux.git/tree/kernel/cred.c?h=v5.10.134#n456)），
    所以前提要求 `fs.suid_dumpable` 不为 `1`，且进程不改变凭据。

  dumpable 状态保存在同一进程全部线程共享的 mm 中，Node worker 线程不会改变它。

## 备选

- **只认 Yama 2/3。** ECI 上 Connection 一直不可用，要靠阿里云工单或专用节点池取得 Yama，
  时间与费用都不可控。未采用。
- **换到带 Yama 或 Landlock 的放置。** 同样依赖云厂商或专用节点池，还要重新满足 ADR-0049 的
  NetworkPolicy 执行要求。这一项作为 executor 路径的选项留在 #4374。
- **由 Runtime 修改 sysctl 开启 Yama。** 工程 Spec §13.5.4 禁止 Runtime 修改节点 sysctl 或提升
  权限。未采用。
- **让 non-dumpable 同时覆盖 app-server。** app-server 是 upstream Codex 二进制，由 execve 启动
  后恢复 dumpable。要覆盖它，需要走工程 Spec §10.11 的 upstream 原生补丁受控例外，或让二进制
  对执行者不可读，两者都需另行设计。本决定不包含这一项。

## 后果

- Host 与 initializer 要在启动时设为 non-dumpable、每次读取受保护材料前回读，并核对前提；
  `standard-mcp-protection.ts` 的判定改为二选一。这些由独立的实现 PR 完成，本文档 PR 先合入。
- 回归测试用真实的同 UID 攻击子进程做负例。ECI 负例在目标放置上逐项验证工程 Spec §13.5.4
  列出的访问，并回读 `fs.suid_dumpable`、`/sys/kernel/security/lsm`、Seccomp 状态，以及
  unprivileged user namespace 能否创建。
- **残余风险（用户已知并接受）：** 第 2 项只保护凭据持有进程本身。`container-boundary` 模式下，
  同一 Session 的工具能读取 app-server 的内存，取得本次执行的本地 bearer 与模型 loopback token。
  影响限于同一用户、同一会话。在 Yama `2` 或 `3` 的内核上没有这一风险。
- 第 2 项只用于只属于一个 Session 的 Pod，使上面的风险不超出同一用户、同一会话；其他 Pod 形态
  仍须 Yama `2` 或 `3`。
- 回退方式是重新只认 Yama。代价是 ECI 上的 Connection 再次不可用。已安装的材料按原有的
  fail closed 规则处理，不需要数据迁移。
