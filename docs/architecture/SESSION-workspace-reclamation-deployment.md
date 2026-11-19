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
node dist/sessionWorkspaceReclamation.mjs dry-run /private/retention-policy.json /private/approved-pvc-names.json
```

`approved-pvc-names.json` 是本次获准的精确 Sandbox PVC 名称组成的非空 JSON 字符串数组，
例如 `["sandbox-12345678-1234-1234-1234-123456789abc"]`。与 Role 的 `resourceNames`
使用同一份清单。CLI 在数据库候选筛选及 Kubernetes GET 前应用此范围。缺少或无效的清单
会使命令失败。候选仍须满足停止证据和保留政策。

输出候选携带精确 Agent/Session/Sandbox、namespace、PVC name/UID/resourceVersion。
本命令不写 DB 或 Kubernetes；不列出缺少可核实 PVC 的对象。不要从空清单推断已回收。
Ho 把候选交 Kiro 确认后，逐个把获准的候选对象原样保存为受保护的 JSON 文件。

### 生产 dry-run 数据库身份

先通过正式 App 发布执行 `0088_session_workspace_reclamation_read` 迁移，并使用包含该版本
查询的 Worker 镜像运行一次性 Job。该迁移建立只读投影视图，不创建登录账号。
查询权限如下，具体列以[角色脚本](../../deploy/ack/operator/session-workspace-reclamation-db-ro.sql)
为准。

| 对象 | 读取范围 |
| --- | --- |
| `platform_reclamation_read.allocations` | 已停止的 Sandbox 绑定及资源观测所需字段 |
| `platform_reclamation_read.outbox_items` | 已成功的 Sandbox 调谐及停止证明投影 |
| `platform_reclamation_read.stopped_audit` | Sandbox 停止时间、代次与 fence |
| `platform.conversations`、`platform.session_sandbox_resource_charges` | 会话绑定、状态与 charge 释放状态 |
| `platform.conversation_generation_tombstones`、`platform.conversation_executions` | 会话 ID 与状态 |
| `platform.outbox_items`、`platform.audit_events` | 待处理调谐和已开始回收所需的筛选列 |

1. 在获准窗口内，部署负责人使用数据库管理员入口核对目标为新 lane 的 Platform DB，
   确认迁移和三个视图已存在。先用只读查询核对逻辑复制槽，再用
   `psql -X -v ON_ERROR_STOP=1 -f` 执行角色脚本。脚本在创建角色前复查同一条件。
   新 lane 的 PostgreSQL StatefulSet 由 Helm 管理，首次初始化脚本只适用于新数据目录，
   平台迁移则使用应用角色。创建登录角色、核对有效权限及保存本次授权回执由 PostgreSQL
   管理员在同一事务内完成。回执包括对象及列地址、实际 grantor、grantee、权限和 grant option。
   回执不含凭据，保留至撤权事务成功结束。
2. 角色应为 `agent_infra_reclamation_ro`、`NOLOGIN`、默认事务只读、没有角色成员资格。
   角色脚本会对包括 `PUBLIC` 在内的有效权限进行检查，发现正文、凭据、原始 JSON、
   非授权对象、可写序列或可写函数权限即回滚，例外仅限下文列出的签名。
   管理员先为 NOLOGIN 角色用交互式 psql `\password agent_infra_reclamation_ro` 设置随机密码。
   回读目标库及下文已知连接范围，在 dry-run Job 启动前才开启登录。将 `VALID UNTIL`
   设为本次 Job 的 UTC 截止时间，Job 结束立即停用登录。
3. 部署负责人在 `agent-infra` namespace 中从权限为 `0600` 的本机文件创建临时
   Secret `agent-infra-reclamation-dry-run-db`，键为 `url`。用 `--from-file=url=<文件路径>`
   提供内容，Job 只用 `secretKeyRef` 将该键注入 `PLATFORM_DATABASE_URL`。
   禁止在 Git、Helm values、回执或共享日志记录 URL。回读 Secret 仅查名称和键名。
   Job 绑定一次性 ServiceAccount。其 Role 和 RoleBinding 只授权该 namespace 内获准候选
   PVC 的 `get`，用 `resourceNames` 限定候选名，仅使用返回的 metadata。该身份无 PVC
   `list`、`watch`、写权限或 Secret API 权限。
4. 用该连接回读 `current_user`、`current_database()` 和 `default_transaction_read_only`；
   确认用户、库名和只读参数与计划一致。从视图读取所需列，并用
   `has_column_privilege` 验证无法读取 `outbox_items.payload`、消息正文和凭据列。
   用 `has_table_privilege` 核对业务表写权限均为 false。仅在权限回读通过后执行 dry-run。
5. 结束或回滚时，停止 Job。管理员在同一 Platform DB 先执行
   `ALTER ROLE agent_infra_reclamation_ro NOLOGIN;` 并提交，再确认所有连接已退出。
   删除 Job、临时 Secret、ServiceAccount、Role 和 RoleBinding，分别 GET 确认已不存在。
   用 `psql -X -v ON_ERROR_STOP=1 -f` 执行[撤权脚本](../../deploy/ack/operator/session-workspace-reclamation-db-ro-drop.sql)。
   脚本检查 NOLOGIN、活动连接和预备事务，并用 `pg_shdepend` 回读所有数据库中的
   owner 和 ACL 依赖。它分别计数 `postgres` 和 `template1` 的依赖。发现所有权、额外授权
   或其他依赖时停止，报告计数并保留角色和对象。脚本对照实际 ACL 和回执，按原 grantor
   逐条执行对应的 `REVOKE ... RESTRICT`。同一对象上的第二个 grantor 也算额外授权。
   撤权事务末尾再次确认全实例 owner 和 ACL 均为零，才删除角色和回执并回读 `role_removed=true`。
   发现新增依赖或任一检查失败时回滚撤权，保留 NOLOGIN、原授权和对象，把状态交 DBA 处理。

#### 已批准的 PUBLIC 权限例外

用户 2026-11-19T14:20Z 批准保留生产 PUBLIC 权限并接受下列大对象函数的残余风险。
16:03Z 协调记录按同一原则批准两条 WAL 消息重载。在角色自检中只有精确函数 OID 与
PUBLIC EXECUTE 同时匹配时才应用例外。

- `lo_creat(integer)`
- `lo_create(oid)`
- `lo_from_bytea(oid,bytea)`
- `lo_open(oid,integer)`
- `lo_put(oid,bigint,bytea)`
- `lo_truncate(integer,integer)`
- `lo_truncate64(integer,bigint)`
- `lo_unlink(oid)`
- `lowrite(integer,bytea)`
- `pg_logical_emit_message(boolean,text,text)`
- `pg_logical_emit_message(boolean,text,bytea)`

建角色前以管理员入口在目标库执行只读核对，并在启用登录前复查。

```sql
BEGIN READ ONLY;
SELECT count(*) AS logical_slot_count
FROM pg_catalog.pg_replication_slots
WHERE slot_type = 'logical';
COMMIT;
```

统计整个实例的逻辑槽，包含停用和临时槽。计数非零或无法核实时，停止并报告。
角色脚本对非零计数返回 `WORKSPACE_READER_LOGICAL_SLOTS_PRESENT`。

Files 复核确认，WAL 函数写入调用者提供的消息，权限限于该函数行为。它不授予业务数据读取，
也不创建角色拥有的对象。无逻辑槽降低现有解码端消费消息的风险，WAL 和 I/O 开销仍可能发生。
一次性 Job 使用短登录窗口和最多两个连接，收尾执行 NOLOGIN 与全实例依赖回读。后续收紧范围由
[#4239](https://github.com/AgoraIO-Extensions/agent-infra/issues/4239) 跟踪。

#### 已批准的连接例外

2026-11-19T17:32Z 协调决定按同一原则接受两处额外 CONNECT。生产直连使用现有通用
密码规则，临时角色可通过 PUBLIC 连接 `postgres` 和 `template1`。这两个库没有业务数据。
Job 仍使用指向 Platform DB 的 URL，登录只在本次 Job 窗口内有效，并限制为两个连接。
`template1` 是新库的默认模板。遗留对象及其对象级授权可能随模板复制，因此收尾时单独
记录该库中的所有权和 ACL 依赖计数。后续的角色专用 HBA 规则由
[#4239](https://github.com/AgoraIO-Extensions/agent-infra/issues/4239) 跟踪。

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
