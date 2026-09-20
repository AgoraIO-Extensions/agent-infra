# Codex 原生执行屏障补丁

本目录保存 #508 原生执行屏障的可复现源码补丁和构建输入。
当前消费的派生产物由 [release pin](../../../../packages/agent-runtime/src/codex-release.json)
固定；pin 与候选构建成功均不表示完整原生验收已完成。
执行屏障边界见 [ADR 0011](../../../../docs/adr/0011-require-codex-native-operation-barrier.md)，
模型切换压缩边界见 [ADR 0013](../../../../docs/adr/0013-use-current-selection-for-codex-switch-compaction.md)。
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
4. `patches/0004-native-dependency-security-updates.patch`：升级 gix、OpenSSL、quinn-proto
   与 Rama/Hickory，适配网络代理调用端，并同步 Rust 1.96.0 和 Cargo/Bazel lock。
   保留逐地址私网检查、TLS、代理与 Connection/执行屏障边界。
5. `patches/0005-tls-error-chain-and-test-backend.patch`：修复嵌套 `io::Error` 中的 TLS
   证书错误分类；回退测试显式选择 native TLS 起始客户端，避免自定义 CA 改变测试前提。
   生产 TLS 后端选择和证书校验保持不变，新增 reqwest feature 仅用于测试。
6. `patches/0006-current-model-switch-compaction.patch`：local 模型切换前置压缩使用本次
   有效模型，覆盖 CompHashChanged 与 ModelDownshift；保留原窗口判断、历史处理和
   压缩算法，以及 remote 和 TokenBudget 路径。
7. `patches/0007-release-test-home-root.patch`：测试初始化可从显式的私有根目录创建
   CODEX_HOME，避免 release 测试在枚举阶段触发系统临时目录限制；生产 arg0 检查不变。
8. `patches/0008-native-compaction-test-fixtures.patch`：将原生压缩 Hook fixture 放入独立
   子进程，覆盖真实 FD3 准入和隔离测试，不改变生产流程。

上游 Apache-2.0 的 [LICENSE](UPSTREAM-LICENSE) 与 [NOTICE](UPSTREAM-NOTICE) 保持不变。
没有修改共享 Cargo registry 或外部 `rmcp 3.1.3` 源码。
新增锁定的 JCS 依赖和许可证见 [JCS-NOTICE](JCS-NOTICE) 与 `licenses/`。
第四个补丁的依赖许可证及逐项来源见
[dependency-updates-NOTICE](licenses/dependency-updates-NOTICE.txt)。

准备独立、干净、HEAD 精确为 manifest 所列 commit 的上游 checkout 后运行：

```bash
python3 deploy/runtime/vendor/codex/apply-source.py --source-checkout "$CODEX_SOURCE"
```

已经应用的源码可加 `--verify-existing` 只读核对。脚本不 fetch、build、install、
切换 pin 或操作集群。补丁已包含对应 probe manifest；修改 Schema/coverage/corpus
必须重新生成 manifest、捕获补丁并核对全部源码哈希。

## 验证与验收边界

必须按序应用全部八份补丁，并核对 `build-input-v1.json` 的逐文件 SHA、Cargo/Bazel
lock、Schema、corpus 和 coverage。manifest/lock 可解析、格式化通过或静态 probe
声明均不能代替原生类型检查、聚焦测试和实际进程保护验证。

候选包、类型检查、lint 和测试证据必须绑定相同的源码与构建输入。最终 Linux aarch64
binary/image 还须验证真实 FD3、同 UID 内存观察负例（包括 `perf_event_open`）、
派生 CLI probe、binary SHA 和 SBOM。Connection 独立身份/OAuth、原响应/记录和
Provider 实际流程按适用的联合验收要求完成。
Darwin hardening-only 不启用 Connection；Linux 非 aarch64 也不允许此凭据 profile。

Connection-backed MCP hook 必须具备固定 `connection/<tool>` 原调用 identity 映射，
缺少映射时在 dispatch 前拒绝。跨进程只读恢复使用原 receipt/descriptor 的私有输入，
并验证原记录、隔离和原 outbox 恢复；缺少原 journal 证据时，不能通过模型历史、nonce
查询、Provider 重发或 TypeScript 代发 GET 补造。

native catalog、hosted MCP upload、exec-server 非空 stdin 的真实写入/重连、
Collab V1 的组合流程及取消/终态顺序按 [coverage](coverage-v1.json) 核对实际证据。
TurnComplete 不证明后台进程已退出；list/terminate 和原 attempt outcome ACK
共同决定执行占用，不能单靠 RPC 返回的 `terminated`。

## Linux aarch64 派生产物

当前仓库只消费 `packages/agent-runtime/src/codex-release.json` 中已固定的
候选包。普通 PR 不再触发独立的 native candidate 编译或聚焦原生测试；CI 只回读
该固定 artifact 的来源、运行和哈希信息，并在镜像内执行已有的运行时验证。

`build-linux-aarch64.py`、固定输入清单和补丁仍作为派生产物的审计材料保留。更新
`codex-release.json` 前，必须在受控的发布操作中生成新的候选包并同步完整 provenance；
本仓库的普通 PR 流程不会自动执行该构建。
