# #4109 POC 能力缺口交接

这份交接记录把 #4109 的非现场证据分为四条独立链路。它不授权修改现场部署、放宽 Runtime 隔离、复制外部凭据或代替 Connection owner 的批准。

| 缺口 | 当前证据 | 根因判断 | Owner / 下一步 |
| --- | --- | --- | --- |
| Native shell | Codex Agent 真实任务产生 5 个 `codex:commandExecution` 的 `operation_failed` 事件；Agent 报告 `bwrap: No permissions to create new namespace`，连 `pwd` 都未执行 | 运行时 Pod/节点的 user namespace / bwrap 能力不足；不是 PR 文本或命令内容问题。镜像构建只检查工具存在，不能证明运行时内核准入 | Runtime/SRE owner：在获批的 Runtime preflight 环境运行 `node deploy/runtime/native-sandbox-preflight.mjs`；`NATIVE_SANDBOX_BWRAP_NAMESPACE_DENIED` 保持失败，不能以特权或 CAP_SYS_ADMIN 绕过。 |
| Skill Hub 发布 | 草稿保存及回读通过；发布、最小包对照和重试都返回 `DEPENDENCY_UNAVAILABLE` | 现场配置同时缺少完整 scanner wiring、版本化对象存储、稳定 signer、固定 Agent Version 和 Worker materialization。历史 live 配置把 scanner 指向未挂载的 `/app/deployment/clamav-db`。已有实现入口包括 [Skill scanner wiring](https://github.com/AgoraIO-Extensions/agent-infra/pull/4024)、[source-bound delivery](https://github.com/AgoraIO-Extensions/agent-infra/pull/4003) 和 [bucket hook](https://github.com/AgoraIO-Extensions/agent-infra/pull/4019)，但本环境没有完成正式装配回读 | Platform/Helm owner：启用正式 Skill Hub values，保证 scanner 使用 `/opt/agent-infra/skill-scanner/{bin/clamscan-wrapper,db}`，提供 namespace-local object storage、稳定 signer、公钥/trust revision、Worker materialization 与同一 Agent Version；执行真实发布→安装→绑定→Runtime 加载回读。 |
| Connection | Agent 详情和 API capability 显示 `connection=false`；没有 Bitbucket Action/PR metadata/diff/comment/CI 的在线读取 | Agent 配置未启用 Connection；Connection 是独立授权权威，平台不能自行代签或把 Platform API credential 当 Connection token。平台侧消费 validator 已在 [#851 PR #4114](https://github.com/AgoraIO-Extensions/agent-infra/pull/4114)，当前真实 D1–D4 非秘密输入仍缺失 | Connection owner（#851 / Connection Identity/Security / Runtime-SRE）：注册/批准本 Consumer、创建 per-Agent installation，完成 OAuth/PAT/Grant 和 Bitbucket Action catalog；完成后回交不含凭据的 installation/Grant capability receipt。 |
| Online PR review | 固定 PR #15078 的离线初审完成，直接可证实 blocker 为 0；完整仓库、merge-base、最新 head、评论和 CI 未在线获取 | 由 shell 缺口、Connection 缺口和完整 repository context 缺口共同造成 | Review/Connection owner：先完成 #851 的批准 Consumer/Grant/Action catalog handoff，再提供固定 head 的在线 metadata/diff/comments/CI/repository read；Agent 重新读取当前 head 后再做完整审查。禁止用旧离线快照签当前 PR。固定材料可先运行 `node scripts/poc-pr-material-preflight.mjs metadata.json diff.json ci.json comments.json`，但 validator 只证明快照形状和 head 一致，不能证明 freshness 或完整性。 |

## 可复现 validator

- Native sandbox：`node deploy/runtime/native-sandbox-preflight.mjs`。它只运行 `bwrap --version`、最小 user/pid/net namespace probe 和 `setpriv` Landlock probe；失败码区分工具缺失、namespace 拒绝和 Landlock 不可用。测试覆盖了 POC 中的 bwrap 错误文本。
- Skill Hub wiring：`node deploy/ack/skill-hub-preflight.mjs <projection.json>`。输入是部署拥有的脱敏 projection，不包含 token、密码、签名私钥、Cookie 或 Provider credential；它拒绝缺少 Agent Version、namespace-local object storage、scanner mount、稳定 signer 或 Worker materialization。

运行测试：

```bash
node --test tests/runtime-native-sandbox-preflight.test.mjs tests/ack-skill-hub-preflight.test.mjs
```

当前 POC Agent、网页/API任务、刷新窗口释放和私有回执仍保留在 #4109 证据目录；这份文档只交接根因、验证器和 owner 边界。
