# Codex 原生执行屏障补丁

这是 #508 的可复现 WIP 源码快照，**尚未通过当前原生代码编译与完整验收，不能更新 release pin**。
权威边界见 [ADR 0011](../../../../docs/adr/0011-require-codex-native-operation-barrier.md)。
协议入口为 [V1](callback-v1.md) 与 [Connection V2](callback-v2.md)。
原生 probe 的 `schemaVersion: 1` 表示 probe 自身格式；其 `callbackSchemaSha256`
指向同时包含严格 V1/V2 帧的 canonical Schema，另固定共同 corpus 和 coverage SHA。
probe 静态声明不能替代当前进程保护安装或最终镜像的负向证明。

## 固定输入

[build-input-v1.json](build-input-v1.json) 记录上游 commit、Cargo/Bazel lock、
逐文件哈希、补丁顺序和依赖 checksum。按顺序应用：

1. `patches/0001-release-lock-versions.patch`：仅把上游 release 的 149 个本仓 package
   版本从 `0.0.0` 修为 `0.153.0`，匹配 workspace version；外部依赖不变。
2. `patches/0002-native-operation-barrier.patch`：保留此前冻结的原生 FD、attempt、
   队列/source、实际执行回执和异步终态补丁。
3. `patches/0003-protected-connection-client.patch`：当前的 Linux aarch64 内存观察限制、
   私有 Connection bootstrap、独立本地 HTTP、真实 leaf descriptor、原响应回执、
   原记录核实、有时限的 metadata-only 补核实、原进程退出后的私有只读恢复，
   以及 canonical corpus 测试源码。

上游 Apache-2.0 的 [LICENSE](UPSTREAM-LICENSE) 与 [NOTICE](UPSTREAM-NOTICE) 保持不变。
没有修改共享 Cargo registry 或外部 `rmcp 3.1.3` 源码。
新增锁定的 JCS 依赖和许可证见 [JCS-NOTICE](JCS-NOTICE) 与 `licenses/`。

准备独立、干净、HEAD 精确为 manifest 所列 commit 的上游 checkout 后运行：

```bash
python3 deploy/runtime/vendor/codex/apply-source.py --source-checkout "$CODEX_SOURCE"
```

已经应用的源码可加 `--verify-existing` 只读核对。脚本不 fetch、build、install、
切换 pin 或操作集群。补丁已包含对应 probe manifest；修改 Schema/coverage/corpus
必须重新生成 manifest、捕获补丁并核对全部源码哈希。

## 验证证据

前两个冻结补丁的既有证据包括 core 与 app-server-transport 库检查、core 23 项、hook
11 项、MCP 6 项和实际 PTY 写入 1 项聚焦测试，以及相关 lint。
这些证据不覆盖第三个补丁。两项 core 队列检查曾重复执行，不增加独立测试数量。

当前第三个补丁：

- `just fmt`、`cargo metadata --no-deps --locked --offline` 和 `git diff --check` 通过。
  metadata 只验证 manifest/lock 可解析，不是 Rust 类型检查。
- `just bazel-lock-update` 通过，`MODULE.bazel.lock` 增加两个新 registry crate 条目。
- 174 个共同 frame case、3 个 framing case、34 个 RFC 8785 vector 已写入 native 测试。
  实际聚焦测试尝试在依赖编译阶段触及 2 GiB 资源保护而停止；新增 native 模块尚未编译，
  不能把 corpus 数据或 TypeScript 验证写成 native 测试通过。
- 当前源码和按序应用三份补丁的结果必须通过逐文件 SHA 核对。

## 尚未验收

当前 native 类型检查、聚焦 lint/测试和完整上游门禁仍待执行。还需最终 Linux aarch64
binary/image、真实 FD3 和同 UID 内存观察负例（包括 `perf_event_open`）、派生 CLI probe、
binary SHA、SBOM，以及 Connection 独立身份/OAuth、原响应/记录和 Provider 实际流程。
Darwin hardening-only 不启用 Connection；Linux 非 aarch64 也不允许此凭据 profile。

Connection-backed MCP hook 当前缺少固定 `connection/<tool>` 原调用 identity 映射，
会在 dispatch 前拒绝。普通原 MCP hook 路径保持原有实现。跨进程只读恢复已包含原
receipt/descriptor 的私有输入源码，仍待实际原生编译、隔离与原 outbox 恢复验证。
缺少原 journal 证据时，不能通过模型历史、nonce 查询、Provider 重发或 TS 代发 GET 补造。

剩余 native catalog、hosted MCP upload、exec-server 非空 stdin 的真实写入/重连、
Collab V1 的组合流程及完整取消/终态顺序仍以 [coverage](coverage-v1.json) 所列实际证据为准。
TurnComplete 不证明后台进程已退出；现有 list/terminate 和原 attempt outcome ACK
共同决定执行占用，不能单靠 RPC 返回的 `terminated`。

## Linux aarch64 候选构建

[独立 workflow](../../../../.github/workflows/codex-native-candidate.yml) 在 vendor 或构建入口
相关 PR 上使用标准 `ubuntu-24.04-arm`，按 PR 的确切 head 和固定 upstream SHA 构建。
它不改变现有 installer、Dockerfile 或 release pin；构建产物按下述候选验证要求交接。

[构建入口](build-linux-aarch64.sh) 先通过 `paths` 固定目录，再按
`prepare`、`musl`、`v8`、`build`、`seal`、`tests` 分步运行；
参数和专属目录由 workflow 固定。musl 和 V8 输出的 `GITHUB_ENV` 必须在后续 step 生效，
不通过 shell source 解析；V8 脚本明确使用原生 checkout，避免 workspace 根目录歧义。
构建保留 runner 默认 Cargo home，使用独立 target 目录、Rust 1.95.0、Zig 0.14.0、
单一 musl release target、两个并发任务和关闭 incremental。每个外部构建阶段周期检查
磁盘，低于 2 GiB 时终止该进程组；不清理其他目录，不自动改用付费 runner。

先编译并 strip bwrap，把最终 SHA 编入随后构建的 `codex`、`codex-code-mode-host` 和
`codex-responses-api-proxy`。候选包采用上游识别的 `bin/` 与 `codex-resources/` 布局，
包含这四个 binary；不宣称是带 rg/zsh 等全部发行资源的正式上游包。
缺少 helper、架构不符、bwrap 或其他 binary 哈希漂移，以及 source/head/lock/callback
输入漂移都会失败。

成功 artifact 用带 SHA 的 tar archive 保留 executable 权限，包内包含 `candidate.json`、
四个最终 binary、legal、Cargo.lock 和标准
CycloneDX `source.cdx.json`。manifest 绑定 PR head、run/attempt、upstream、补丁、lock、
完整补丁后 source tree、Schema/corpus/coverage、工具版本、构建命令和最终文件 SHA。
source tree 用临时 Git index 计算并在封包前复核，不改变 native checkout 的 HEAD 或 index。
包内还保留 `builder-environment.json` 的有限 runner 信息及文件 SHA。
SBOM 使用仓库固定 Trivy 安装器，只描述 Cargo.lock 源码依赖，
不证明静态链接 C/C++ 或最终 binary 依赖覆盖完整。
`nativeAcceptance: false` 保持显式；编译成功仍需原生测试、最终镜像和真实流程验收。
CLI version 和静态 native probe 也必须与固定输入匹配；这不证明进程隔离已安装。

封包上传后，固定 just 1.51.0 与 nextest 0.9.103 通过上游 `just test` 运行
`codex-rmcp-client` 的 Connection，以及 `codex-core` 的 bootstrap/barrier 库测试。
测试复用同一 release target 和 bwrap SHA，两个执行线程，保留 2 GiB 资源保护；
测试前后复核源码和候选 binary，失败会使 workflow 失败。
已上传包仍明确为未验收候选；聚焦测试记录随 diagnostics 保存，不替代完整原生矩阵。
测试依赖与 `cfg(test)` 可能增加构建空间，实际运行证据仍待 CI。

artifact 只保留一天；失败也保存限定构建日志、阶段状态、资源采样和 timing，
不上传 Cargo target、registry、全部 symbols 或环境变量。标准 runner 的磁盘是否足够、
冷构建能否在 180 分钟内完成仍待实际 CI 测量。
