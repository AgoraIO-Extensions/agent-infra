# Session reserve 结果不明的人工核实与恢复

本手册处理未领取 Session reserve 的资源写入结果不明：create 或 DELETE 发出后没有拿到原响应，
Store 保留原 attempt 和占用，Worker 不会自行收口。规则以
[工程 Spec §10.1.1“新会话预留实例”](../../docs/architecture/SPEC-agent-infra-M1-engineering-architecture.md#新会话预留实例)
为准：一次 GET absence、lease 失效、凭证过期，以及请求超时后再读到一次 absence，都不能证明
没有迟到写入；核实前继续保留占用。启用任何独立 executor 的 Codex profile 前，本手册须经评审
就位，第 6 节须按 3a/3b 合入后的实际字段补齐。

全部步骤由部署负责人 sess_fccff4b2 执行。只读步骤可随时执行；写入步骤只由部署负责人在批准
的窗口内执行。已领取或已有业务绑定的 reserve 不在本手册范围内，按原 Session 恢复处理。

## 0. 启用前检查

批准任何 reserve profile 前确认以下各项，缺一项不批准：

1. 目标 ACK 集群已开启 API Server 审计并投递到 SLS，保留期覆盖 reserve TTL 加最长核实周期。
   ACK 托管集群默认保留 30 天。审计策略对六类资源的 create 和 delete 至少记录 Metadata 级的
   `ResponseComplete` 阶段。部署负责人有该审计 Logstore 的只读查询权限。
   [ACK 集群审计](https://help.aliyun.com/en/ack/ack-managed-and-ack-dedicated/security-and-compliance/work-with-cluster-auditing)
2. 部署负责人有 Platform DB 的只读角色和指向新 lane 的只读 kubeconfig（下文为
   `AGENT_INFRA_KUBECONFIG`）。
3. 第 1 节的检测查询已排进巡检，每次结果按第 1 节保存，并已在非生产库验证：一直被 claim 的卡住
   操作每次仍会返回。Worker 当前不输出 reserve 结果不明的日志（reserve Worker 的 `log` 选项在
   部署装配中未接线），告警入口以该查询为准。
4. 独立 executor 的 Codex profile：第 6 节已按实际持久字段补齐并经复审。

## 1. 触发与告警入口

任一 profile 启用期间，至少每 15 分钟只读执行一次。每行是一个未收口的操作；reserve 为
`unknown` 但没有未收口操作时，以 `ordinal` 为空的一行返回。

```sql
BEGIN READ ONLY;
SELECT r.sandbox_id, r.agent_id, r.namespace, r.status AS reserve_status, r.delivery_fence,
       r.lease_owner IS NOT NULL AND r.lease_expires_at > clock_timestamp() AS leased,
       r.created_at, r.expires_at,
       t.n AS ordinal, t.o->>'attemptId' AS attempt_id, t.o->>'operation' AS operation,
       t.o->>'kind' AS kind, t.o->>'status' AS operation_status,
       t.o->>'writeCompletion' AS write_completion,
       c.released AS charge_released,
       r.status = 'unknown' OR t.o->>'status' = 'unknown' AS immediate
FROM platform.session_sandbox_reserves r
LEFT JOIN LATERAL jsonb_array_elements(r.operations) WITH ORDINALITY AS t(o, n)
  ON t.o->>'writeCompletion' = 'pending' OR t.o->>'status' IN ('pending', 'unknown')
LEFT JOIN platform.session_sandbox_resource_charges c ON c.sandbox_id = r.sandbox_id
WHERE r.retired_at IS NULL
  AND r.status IN ('preparing', 'unknown', 'retiring')
  AND (r.status = 'unknown' OR t.o IS NOT NULL)
ORDER BY r.created_at, r.sandbox_id, t.n;
COMMIT;
```

查询不按 `updated_at` 或 lease 过滤。Worker 每次 claim 都会刷新 `updated_at` 和
`delivery_fence`，按这两列算未决时长会漏掉一直被 claim 的卡住操作。`attemptId` 在写入发出前
持久化，之后不变。

- `immediate` 为 true 的行（reserve 或该操作为 `unknown`）：立即进入第 2 节。
- 其余行是仍为 `pending` 的写入，可能正在正常进行。把本次结果的 `sandbox_id` 与 `attempt_id`
  存入巡检记录；下一次执行仍出现同一组值时进入第 2 节。正常的写入在一次 API 请求内结束并回写
  原响应，不会连续两次巡检仍为 `pending`。

`unknown` 表示某个写入发出后结果不明。过期或停用会把未领取项转成 `retiring`；任一操作仍为
`writeCompletion = pending` 时，准备和淘汰都停住，预算不会释放。

## 2. 冻结快照（只读）

对每个 `sandbox_id` 建一个仅本人可读的证据目录（下文为 `EVIDENCE_DIR`），保存以下三类输出及
各自 SHA-256。不保存 Secret 的 `data`，不保存 token 或数据库连接串。

**Store。**

```bash
psql -X -v ON_ERROR_STOP=1 -v sandbox_id="$SANDBOX_ID" <<'SQL'
BEGIN READ ONLY;
SELECT sandbox_id, session_id, agent_id, namespace, status, profile_digest, delivery_fence,
       lease_owner, lease_expires_at, created_at, updated_at, expires_at, ready_at,
       claimed_at, retired_at,
       encode(sha256(convert_to(operations::text, 'UTF8')), 'hex') AS operations_sha256
FROM platform.session_sandbox_reserves WHERE sandbox_id = :'sandbox_id';
SELECT t.n AS ordinal, t.o->>'attemptId' AS attempt_id, t.o->>'operation' AS operation,
       t.o->>'kind' AS kind, t.o->>'name' AS name, t.o->>'status' AS status,
       t.o->>'writeCompletion' AS write_completion, t.o->>'absent' AS absent,
       t.o->'resource'->>'uid' AS uid, t.o->'resource'->>'resourceVersion' AS resource_version,
       t.o->'writer'->>'owner' AS writer_owner, t.o->'writer'->>'fence' AS writer_fence
FROM platform.session_sandbox_reserves r
CROSS JOIN LATERAL jsonb_array_elements(r.operations) WITH ORDINALITY AS t(o, n)
WHERE r.sandbox_id = :'sandbox_id' ORDER BY t.n;
SELECT sandbox_id, namespace, resources, compute_released, released
FROM platform.session_sandbox_resource_charges WHERE sandbox_id = :'sandbox_id';
SELECT 'conversation' AS binding, count(*) FROM platform.conversations c
JOIN platform.session_sandbox_reserves r ON c.id = r.session_id
WHERE r.sandbox_id = :'sandbox_id'
UNION ALL
SELECT 'allocation', count(*) FROM platform.session_sandbox_allocations
WHERE sandbox_id = :'sandbox_id';
COMMIT;
SQL
```

`claimed_at` 非空、`status = 'claimed'`，或任一业务绑定计数不为 0 时停止，转原 Session 恢复。
Store 的 `namespace` 须等于批准 lane 的 namespace `agent-infra`，否则停止并升级 Runtime 负责人。
下文的 Kubernetes 与审计查询都使用这个值（`STORE_NAMESPACE`）。

**Kubernetes 元数据。** 六类资源同名为 `sandbox-<sandboxId>`。只取 metadata。每类资源分别记为
`present`（读取成功且对象存在）、`not-found`（读取成功且对象不存在）或 `read-failed`
（kubectl 失败、输出无法解析，或返回的名称与 namespace 不符）。

```bash
set -u
ns="$STORE_NAMESPACE"
name="sandbox-${SANDBOX_ID}"
out="$EVIDENCE_DIR/kubernetes"
mkdir -p "$out"
kc=(kubectl --kubeconfig "$AGENT_INFRA_KUBECONFIG" -n "$ns")
: >"$out/objects.jsonl"
for kind in pod service serviceaccount persistentvolumeclaim networkpolicy secret; do
  metadata=null
  if json=$("${kc[@]}" get "$kind" "$name" --ignore-not-found \
      -o jsonpath='{.metadata}' 2>"$out/$kind.err"); then
    if [ -z "$json" ]; then
      result=not-found
    elif metadata=$(printf '%s' "$json" | jq -ce --arg ns "$ns" --arg name "$name" '
        select(.namespace == $ns and .name == $name and (.uid | type) == "string")
        | {uid, resourceVersion, creationTimestamp, deletionTimestamp, finalizers,
           ownerReferences, labels,
           annotations: ((.annotations // {})
             | with_entries(select(.key | startswith("agent-infra.agora.io/")))),
           managers: [.managedFields[]? | {manager, operation, time}]}' 2>>"$out/$kind.err"); then
      result=present
    else
      result=read-failed
      metadata=null
    fi
  else
    result=read-failed
  fi
  jq -cn --arg kind "$kind" --arg result "$result" --argjson metadata "$metadata" \
    '{kind: $kind, result: $result, metadata: $metadata}' >>"$out/objects.jsonl"
done
if list=$("${kc[@]}" get secrets -l "agent-infra.agora.io/sandbox-id=${SANDBOX_ID}" \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.uid}{"\n"}{end}' \
    2>"$out/secrets.err"); then
  printf '%s\n' "$list" >"$out/secrets-by-label.txt"
else
  echo read-failed >"$out/secrets-by-label.txt"
fi
if json=$("${kc[@]}" get events --field-selector "involvedObject.name=${name}" -o json \
    2>"$out/events.err") &&
  printf '%s' "$json" | jq -c '.items[] | {type, reason, involvedObject: .involvedObject.kind,
    uid: .involvedObject.uid, firstTimestamp, lastTimestamp, count}' \
    >"$out/events.jsonl" 2>>"$out/events.err"; then
  :
else
  echo read-failed >"$out/events.jsonl"
fi
```

任一类资源为 `read-failed` 时，本次快照不能作为不存在的证据：不做第 3 节中依赖 `not-found`
的判定，排除原因后重做本节。`not-found` 只是一次成功读取的观测，同样不能单独证明没有迟到写入。

对象属于该 reserve 须满足 Worker 回读时的同一组条件：

- 名称为 `sandbox-<sandboxId>`，namespace 为 `STORE_NAMESPACE`；
- 标签 `agent-infra.agora.io/sandbox-id` 等于该 Sandbox，`agent-infra.agora.io/generation` 为
  `1`，`agent-infra.agora.io/agent-ref` 为 `agent-` 加 `agentId` 的 SHA-256 十六进制前 32 位，
  `agent-infra.agora.io/session-ref` 为 `session-` 加 `sessionId` 的同样摘要
  （`printf '%s' "$AGENT_ID" | shasum -a 256 | cut -c1-32`）；`agent-infra.agora.io/managed`
  标签存在时为 `session-sandbox-v1`；
- 注解 `agent-infra.agora.io/agent-id`、`agent-infra.agora.io/session-id` 与 Store 一致，
  `agent-infra.agora.io/managed` 为 `session-sandbox-v1`，`agent-infra.agora.io/fence` 为 `1`；
- Store 已记录该类资源 create 的 UID 时，UID 相同。

`managedFields` 的 `manager` 只作参考，不代表认证主体；写入方以审计的 `user.username` 为准。

**API Server 审计。** 在审计 Logstore 中，时间范围从 reserve `created_at` 前 5 分钟到当前，取该
名称的全部 create 与 delete 事件，不限用户。起点提前是为了覆盖 Platform DB 与 API Server 的时钟
偏差；名称含不复用的 `sandboxId`，放宽起点不会混入其他 reserve 的事件。记录每条的 `auditID`、
`stage`、`verb`、`objectRef.resource`、`objectRef.name`、`objectRef.namespace`、`user.username`、
`responseStatus.code`、`requestReceivedTimestamp` 和 `stageTimestamp`。字段名以目标 Logstore 的
索引为准。

```text
objectRef.namespace: "<STORE_NAMESPACE>" and objectRef.name: "sandbox-<sandboxId>"
  and (verb: create or verb: delete)
```

按 `objectRef.resource` 与 `verb` 分组，`auditID` 去重后按 `requestReceivedTimestamp` 排序。
Worker 的身份为 `system:serviceaccount:agent-infra:agent-infra-worker`。只有满足以下条件，审计
事件才算与 Store 中的原请求唯一关联：

- 该名称上没有其他用户的 create 或 delete；
- 该类资源 Worker 的 create `auditID` 恰好一个，delete `auditID` 的数量等于 Store 中该类资源的
  delete 操作数量；
- create：Store 对每类资源只接受一次 create 意图，名称中的 `sandboxId` 不复用，所以这一条就是
  原 create，须有 `ResponseComplete`；
- DELETE：Store 只在此前同类 DELETE 均为 `rejected` 且已有原响应时才接受新的 DELETE 意图。delete
  操作按数组顺序与 Worker 的 delete `auditID` 按时间顺序一一对应；此前各次的状态码为 409，与
  Store 已记录的 `rejected` 一致；最后一条对应待核实的 DELETE，须有 `ResponseComplete`。

不满足时没有原请求的响应，包括原请求没有到达 API Server 的情况。审计不可用时同样处理。

## 3. 判定

逐条处理 `status` 为 `pending`/`unknown` 或 `writeCompletion = pending` 的操作。
`writeCompletion = response` 表示原 create 或 DELETE 调用的终态响应，只能来自第 2 节唯一关联的
原请求 `ResponseComplete`。对象 `present` 或 `not-found` 都只是观测：用来排除矛盾，不能代替原
请求的响应。

| 操作 | 原请求的响应（审计） | 本次观测 | 判定 |
| --- | --- | --- | --- |
| create | 201 | `present`，满足归属条件，`creationTimestamp` 与该请求的时间按秒相符（见下） | 已创建 |
| create | 400、403、404、405、413、415、422 | `not-found` | 确定拒绝 |
| create | 201 | `not-found` | 保持占用，升级 Runtime 负责人（见下） |
| create | 401、409、5xx、504，只有 `RequestReceived`，或没有唯一关联 | 任意 | 不能证明，保持占用 |
| DELETE | 200 或 202 | `not-found`，或 `present` 且 UID 与原记录相同并带 `deletionTimestamp` | 已受理 |
| DELETE | 404 | `not-found` | 原响应为不存在 |
| DELETE | 409 | `present`，UID 与原记录相同，没有 `deletionTimestamp` | 确定未删除 |
| DELETE | 5xx、504，只有 `RequestReceived`，或没有唯一关联 | 任意 | 不能证明，保持占用；对象带 `deletionTimestamp` 时等待后重做第 2 节 |
| 任一 | 其他用户对该名称的 create 或 delete | 任意 | 停止，不清理，升级 Runtime 负责人 |
| 任一 | 任意 | 同名不同 UID、归属不符，或出现业务绑定 | 停止，不清理，升级 Runtime 负责人 |

表中没有的组合视为矛盾，按最后两行处理。401 的请求没有认证用户，无法与 Worker 的原请求关联。

**时间按秒比较。** 对象的 `creationTimestamp` 序列化为整秒（小数部分截断），审计的
`requestReceivedTimestamp` 与 `stageTimestamp` 精确到微秒。比较时先把两个审计时间截断到秒，
满足“截断后的接收秒 ≤ `creationTimestamp` ≤ 截断后的完成秒”即相符，等价于对象所在的这一秒与
请求的接收到完成区间有交集。时间只作佐证：它不能代替唯一关联和归属核对，也不能单独证明已创建；
只有确实不相交时才视为矛盾。

- 同秒：请求 `07:00:00.100000Z`–`07:00:00.200000Z`，对象 `07:00:00Z`，相符。
- 跨秒：请求 `07:00:00.900000Z`–`07:00:01.050000Z`，对象 `07:00:00Z` 或 `07:00:01Z`，都相符。
- 不相交：请求 `07:00:00.100000Z`–`07:00:00.200000Z`，对象 `07:00:01Z` 或 `06:59:59Z`，不相符，
  按矛盾处理。

表中其他行只比较状态码、UID 与 `deletionTimestamp` 是否存在，不比较时间。

create 为 201 而对象已不存在时，这一分支保持占用。Store 记录已创建须有原 create 响应的 UID 与
resourceVersion（`recordCreateResponse`），对象已不存在时没有可信来源：Metadata 级审计不含
响应对象，事件 `involvedObject` 的版本不是 create 响应的版本，不能编造，也不能借用其他实例的值。
Worker 在 create 收口前不发 DELETE，所以删除来自其他写入方，本身就需要升级。

## 4. 核实前

- 保持原占用、原 attempt 和原 `status`，不改预算，不改 profile 的上限来“腾出”这份占用。
- 不重发 create，不手工删除或修改任何对象，不清空 `operations`，不把 reserve 标记为已结束。
- 需要恢复池容量时，只能经正常配置变更调整，且不能释放这份结果不明的占用。

## 5. 恢复

**5.1 有原请求的响应**（判定为已创建、确定拒绝、已受理、原响应为不存在或确定未删除）。由
部署负责人在批准的窗口内，用经评审的一次性 Store 修正只改该 attempt，写入原 writer 收到同一响应
时 Store 会写的结果，并保存修正前的整行快照：

- 前置条件（CAS）：该行 `retired_at` 为空，`namespace` 为 `agent-infra`，`status`、
  `delivery_fence` 与第 2 节快照相同，没有有效 lease，`operations` 的 SHA-256 与快照相同，业务
  绑定计数仍为 0。任一不符就放弃，重做第 2 节。
- 写入内容与 `recordCreateResponse`、`recordDeleteResponse` 相同，`attemptId` 和 `writer` 不变：
  - 已创建：`confirmed`、`writeCompletion = response`，`resource` 为本次 `present` 回读的
    kind、name、namespace、UID 和 resourceVersion（同一 UID 的当前版本，与 Worker 记录观测时
    相同）。
  - 确定拒绝：`rejected`、`response`，`resource` 为空。
  - DELETE 已受理：`confirmed`、`response`、`absent = false`，`resource` 保持原值。对象是否已不
    存在由 Worker 回读后经 Store 记录。
  - DELETE 原响应为不存在：`confirmed`、`response`、`absent = true`，`resource` 保持原值。
  - DELETE 确定未删除：`rejected`、`response`，`resource` 保持原值。
  - create 修正后全部操作都有原响应、且该行为 `unknown` 时，`status` 改为 `preparing`；其他情况
    `status` 不变。
- 同一事务清空 `lease_owner` 与 `lease_expires_at`，`delivery_fence` 加一。修正前取得的 lease
  之后不能再推进该行。原 writer 迟到的响应回写由 Store 按该 attempt 的 writer 和
  `writeCompletion = pending` 核验，修正后同样被拒绝。

修正后由 Worker 沿原流程继续：`preparing` 行继续准备，过期或失去资格时被淘汰；`retiring` 行按
Store 记录的 UID/resourceVersion 条件删除，回读不存在时由 Store 记录 absence，全部完成后才写
`retired_at` 并释放 charge。部署负责人只读回读到 `retired_at` 非空、
`resource_charges.released = true`、六类对象和投影均为 `not-found` 为止，或回读到该项按原流程
`ready`。

**5.2 观测与已记录结果矛盾**（例如确定拒绝后对象出现，或已创建的对象 UID 改变）。停止，保留现场
并升级 Runtime 负责人。迟到出现的对象只由 Worker 按原流程记录观测，Store 保留原
`writeCompletion`；部署负责人不按观测改写 Store。

**5.3 仍不能证明**。保持占用，按第 1 节周期复查。不以等待时长、重复 absence 或 GC 作为结束条件。
对象存在但没有唯一关联的原请求响应、create 为 201 而对象已不存在、DELETE 结果不明而对象已不存在，
这几种情况在现有 Store 合同下都不能收口。要收口须先评审合同变更（例如新增人工核实状态）并写入
工程 Spec，本手册不提供替代写法。

## 6. 独立 executor 启动身份投影（3a/3b 合入后补齐）

投影是单独记录的临时 Secret，规则见
[Runtime HLD §10.3.1](../../docs/architecture/HLD-agent-runtime-M1.md#1031-排空通道的实例身份交付)
与 [§10.3.2](../../docs/architecture/HLD-agent-runtime-M1.md#1032-session-实例只读合同-v1)。
判定与恢复沿用第 3–5 节，另外核对：

- 原发布 attempt、目标 Pod UID、按 Pod 实例记录的投影名与启动引用、writer fence；
- 对象的 ownerReference 指向原 Pod UID，归属标签与第 2 节一致；
- Pod 已删除时，ownerReference 级联回收不能证明没有迟到的投影 create。

投影记录保存在 `platform.session_sandbox_reserves.executor_startup`（jsonb，单容器 reserve 为空），
与六类资源的 `operations` 分开。只读查询：

```sql
BEGIN READ ONLY;
SELECT r.sandbox_id, r.status, r.delivery_fence,
       r.executor_startup->>'startupRef' AS startup_ref,
       (r.executor_startup->>'deadlineMs')::bigint AS deadline_ms,
       r.executor_startup->'projection'->>'podUid' AS pod_uid,
       r.executor_startup->'projection'->>'hostKeyId' AS host_key_id,
       r.executor_startup->'projection'->'create' AS projection_create,
       r.executor_startup->'projection'->'deletes' AS projection_deletes,
       r.executor_startup->'consumption' AS consumption
FROM platform.session_sandbox_reserves r
WHERE r.sandbox_id = :'sandbox_id';
COMMIT;
```

`projection_create` 与 `projection_deletes` 的每一项有 `attemptId`、`status`、`writeCompletion`、
`absent`、`resource`（UID/resourceVersion）和 `writer`（owner/fence），语义与第 3 节的 create 和
DELETE 相同；投影 Secret 名称等于 `startup_ref`。判定沿用第 3 节；第 5.1 节的 Store 修正对投影
写入只改 `executor_startup` 中对应的那一项，CAS 前置条件另加 `executor_startup` 的 SHA-256。
领取后，原启动事实写入 `conversation_audit_events`（`details.checkpoint = 'executor-startup'`、
`details.source = 'reserve'`），业务晋升回执在 `platform.session_sandbox_executor_promotions`。

Worker 与 Host 的取证步骤由 3b 写入本节并经复审；未补齐时不批准 Codex profile。

## 7. 回退

- 第 1–3 节只读，无需回退。
- 5.1 的 Store 修正只在同一窗口、Worker 尚未推进时回退。前置条件：`retired_at` 为空，
  `operations` 的 SHA-256 和 `delivery_fence` 与修正后相同，没有有效 lease。只把该 attempt 的
  操作和 `status` 恢复为修正前的值，`delivery_fence` 再加一，`lease_owner` 与
  `lease_expires_at` 保持为空；不按整行快照恢复 fence 或其他列。
- Worker 已推进（`operations` 或 `delivery_fence` 已变化）时不回退，重做第 2 节并按第 3 节处理。
- 任一步结果不明时，先只读回读当前行和对象，不重复执行写入。

## 8. 记录格式

每个 `sandbox_id` 一份 JSON，放在部署负责人的私有回执目录，并在对应 Issue 留不含秘密的摘要：

```json
{
  "schemaVersion": 1,
  "sandboxId": "<sandboxId>",
  "agentId": "<agentId>",
  "detectedAt": "<UTC>",
  "operator": "sess_fccff4b2",
  "storeSnapshot": { "status": "...", "namespace": "agent-infra", "deliveryFence": 0, "operationsSha256": "...", "chargeReleased": false },
  "operations": [{ "attemptId": "...", "operation": "create", "kind": "Pod", "status": "unknown", "writeCompletion": "pending" }],
  "kubernetes": [{ "kind": "Pod", "result": "present | not-found | read-failed", "uid": "...", "resourceVersion": "...", "owned": true }],
  "audit": [{ "auditID": "...", "verb": "create", "user": "...", "stage": "ResponseComplete", "code": 201, "attemptId": "<唯一关联的 attempt 或 null>" }],
  "decision": "created | rejected | delete-acknowledged | delete-absent | not-deleted | unprovable | escalated",
  "window": "<批准窗口引用或 null>",
  "writes": [{ "attemptId": "...", "before": "<sha256>", "after": "<sha256>", "deliveryFence": 0 }],
  "readback": { "retiredAt": "<UTC 或 null>", "chargeReleased": true, "objectsAbsent": true },
  "evidenceSha256": { "store": "...", "kubernetes": "...", "audit": "..." }
}
```
