# 已停止 Session 的工作区回收

此入口仅供部署 owner 执行部署数据政策；产品规则见[工程 Spec §10.1](SPEC-agent-infra-M1-engineering-architecture.md#101-workload-形态)。
不是用户删除功能，不处理 Agent PVC、Postgres、平台存储或未领取 reserve。

## 先列清单

使用当前正式发布的 Worker 镜像中 `dist/sessionWorkspaceReclamation.mjs`，
提供 `PLATFORM_DATABASE_URL`、具名 `DEPLOYMENT_OWNER` 和明确的 `KUBECONFIG`。
环境文件按凭据规范保管，不把值传到 CLI、日志或回执。

部署 policy JSON 包含 `namespace`、正整数 `minimumStoppedMs`、`retainedAgentIds`、
`retainedSessionIds` 和 `retainedSandboxIds`。保留名单三个数组必须显式提供；
上线前由负责人补齐 #2857 AC-7/AC-8、#3054、#3230、#4109 当前精确样本。
内置前缀防线额外保护负责人已指出的历史 Agent/Sandbox 和 #3874 合成样本；不能靠漏填配置取消保护。

```bash
node dist/sessionWorkspaceReclamation.mjs dry-run /private/retention-policy.json
```

输出候选携带精确 Agent/Session/Sandbox、namespace、PVC name/UID/resourceVersion。
本命令不写 DB 或 Kubernetes；不列出缺少可核实 PVC 的对象。不要从空清单推断已回收。
Ho 把候选交 Kiro 确认后，逐个把获准的候选对象原样保存为受保护的 JSON 文件。

### 候选清单的排除规则

清单生成只读取当前 deployment policy、`session_sandbox_allocations`、停止审计、
成功的当前 reconciliation intent 和 PVC metadata。SQL 以当前 sandbox 的唯一最新
成功 intent 投影候选，停止资格使用不可变的 `conversation.sandbox.observed` 停止审计时间；
不能用 outbox 的 `updated_at` 作为停止时间，也不能把多条历史 intent 拼成多个候选。
每个候选仍需在同一 namespace 中匹配原 Agent、Session、Sandbox、generation、fence、
PVC name、UID 和 resourceVersion。

以下对象在本票中始终排除，且必须在 policy 的三个 retained 数组或内置保护规则中保留：

- #2857 的 AC-7/AC-8 原样本，包括 `agent_api_031fb…` 及其 `cba6a0dd`、`a8dd585a`、
  `6e5488d7` Sandbox/PVC 记录；
- #3054、#3230、#4109 当前仍在使用的样本，包括 `agent_ade388…`、
  `agent_a50d49bb…`、Sandbox `0e14bd4b` 以及 #4109 `cf533` 的原 PVC；
- #4186 选定的 c549 Agent（完整 ID 由当前 control/Issue 回读提供）及其 data PVC、
  原有 Sandbox/快照和两次 restart/recovery 历史；
- #3874 合成 Agent（包括 `agent_api_fea4…`、`agent_api_bbbe…`）及负责人确认前的
  任何合成样本。

回读只输出候选的安全 metadata；遇到保留前缀、显式 retained ID、非 Session data PVC、
缺停止审计、UID/RV 不全、同名替换或 owner/fence 不一致时直接排除并记录原因。清单为空、
读失败或存在 UNKNOWN 都交回负责人确认，不能解释成“没有可回收对象”。

## 按显式 ID 执行

```bash
node dist/sessionWorkspaceReclamation.mjs execute /private/retention-policy.json /private/confirmed-target.json
```

资格与 PVC 原始 UID 会在权威锁内重新核对，dry-run 不授予写权限。
开始审计持久化后，会话与 Sandbox 永久不可用，用户后续消息会沿既有拒绝路径返回不可用，
历史仍保留，不能静默重建工作区。此操作有数据删除风险且不能回滚；
不能将 `execute` 用作诊断。PVC DELETE 带原 UID/resourceVersion，随后 GET 确认不存在；
最终审计与存储 charge 释放在同一预算锁事务内提交。

删除被拒、仍处于 terminating、超时或未知时，保留 charge 和不可用状态；
只用原目标文件、相同 owner 和 policy 恢复，不改 UID/RV 以追随新对象。
已完成操作重复执行不再删除或重复审计；同名 PVC 再出现时拒绝。
正式只读回执（含审计、charge、会话状态和 PVC metadata/absence）：

```bash
node dist/sessionWorkspaceReclamation.mjs inspect /private/retention-policy.json /private/confirmed-target.json
```

审计来自 `platform.audit_events` 的 `conversation.workspace.reclamation.started/completed`
按 Session target 回读（仅走正式只读入口），不得手工改表。

AC-3 只由 Ho 执行：先存 dry-run 清单与负责人确认，再有限逐 ID 执行；
回读 PVC 不存在、charge released、开始/完成审计，以及保留样本完全不变。
源码测试或合入不能代签现场回收。
