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
   ACK 托管集群默认保留 30 天。部署负责人有该审计 Logstore 的只读查询权限。
   [ACK 集群审计](https://help.aliyun.com/en/ack/ack-managed-and-ack-dedicated/security-and-compliance/work-with-cluster-auditing)
2. 部署负责人有 Platform DB 的只读角色和指向新 lane 的只读 kubeconfig（下文为
   `AGENT_INFRA_KUBECONFIG`）。
3. 第 1 节的检测查询已排进巡检。Worker 当前不输出 reserve 结果不明的日志（reserve Worker 的
   `log` 选项在部署装配中未接线），告警入口以该查询为准。
4. 独立 executor 的 Codex profile：第 6 节已按实际持久字段补齐并经复审。

## 1. 触发与告警入口

任一 profile 启用期间，至少每 15 分钟只读执行一次。返回任一行即进入第 2 节。

```sql
BEGIN READ ONLY;
SELECT r.sandbox_id, r.agent_id, r.status, r.delivery_fence,
       r.lease_owner IS NOT NULL AND r.lease_expires_at > clock_timestamp() AS leased,
       r.created_at, r.updated_at, r.expires_at,
       count(o) FILTER (WHERE o->>'writeCompletion' = 'pending') AS pending_writes,
       count(o) FILTER (WHERE o->>'status' IN ('pending', 'unknown')) AS unsettled_operations,
       c.released AS charge_released
FROM platform.session_sandbox_reserves r
LEFT JOIN LATERAL jsonb_array_elements(r.operations) AS o ON true
LEFT JOIN platform.session_sandbox_resource_charges c ON c.sandbox_id = r.sandbox_id
WHERE r.retired_at IS NULL
  AND r.status IN ('unknown', 'retiring')
  AND r.updated_at < clock_timestamp() - interval '10 minutes'
GROUP BY r.sandbox_id, c.released
HAVING r.status = 'unknown'
    OR count(o) FILTER (WHERE o->>'writeCompletion' = 'pending') > 0
ORDER BY r.updated_at;
COMMIT;
```

`unknown` 表示某个 create 发出后结果不明。过期或停用会把它转成 `retiring`；`retiring` 行如果
仍有 `writeCompletion = pending` 的操作，淘汰同样停住，预算不会释放。

## 2. 冻结快照（只读）

对每个 `sandbox_id` 建一个仅本人可读的证据目录，保存以下三类输出及各自 SHA-256。不保存
Secret 的 `data`，不保存 token 或数据库连接串。

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

**Kubernetes 元数据。** 六类资源同名为 `sandbox-<sandboxId>`。只取 metadata，Secret 不输出内容。

```bash
ns=agent-infra
name="sandbox-${SANDBOX_ID}"
kc=(kubectl --kubeconfig "$AGENT_INFRA_KUBECONFIG" -n "$ns")
for kind in pod service serviceaccount persistentvolumeclaim networkpolicy secret; do
  printf '%s ' "$kind"
  "${kc[@]}" get "$kind" "$name" --ignore-not-found -o jsonpath='{.metadata}' |
    jq -c '{uid, resourceVersion, creationTimestamp, deletionTimestamp, finalizers,
      ownerReferences, labels,
      annotations: ((.annotations // {}) | with_entries(select(.key | startswith("agent-infra.agora.io/")))),
      managers: [.managedFields[]? | {manager, operation, time}]}'
  echo
done
"${kc[@]}" get secrets -l "agent-infra.agora.io/sandbox-id=${SANDBOX_ID}" \
  -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.uid}{" "}{.metadata.ownerReferences}{"\n"}{end}'
"${kc[@]}" get events --field-selector "involvedObject.name=${name}" -o json |
  jq -c '.items[] | {type, reason, involvedObject: .involvedObject.kind, uid: .involvedObject.uid,
    firstTimestamp, lastTimestamp, count}'
```

属于该 reserve 的对象须同时满足：`agent-infra.agora.io/managed=session-sandbox-v1`、
`agent-infra.agora.io/sandbox-id` 等于该 Sandbox，注解中的 `agent-id`、`session-id` 与 Store
一致，`fence` 为 `1`，managedFields 的写入方为该部署的 Worker。

**API Server 审计。** 在审计 Logstore 中，按 reserve `created_at` 到当前的时间范围筛选以下
条件，记录每条的 `auditID`、`stage`、`verb`、`objectRef.resource`、`objectRef.name`、
`user.username`、`responseStatus.code`、`requestReceivedTimestamp` 和 `stageTimestamp`。
字段名以目标 Logstore 的索引为准。

```text
objectRef.namespace: agent-infra and objectRef.name: "sandbox-<sandboxId>"
  and user.username: "system:serviceaccount:agent-infra:agent-infra-worker"
  and (verb: create or verb: delete)
```

## 3. 判定

逐条处理 `status` 为 `pending`/`unknown` 或 `writeCompletion = pending` 的操作。

| 操作 | 证据 | 判定 |
| --- | --- | --- |
| create | 对象存在，满足第 2 节的归属条件 | 已创建。同名对象存在说明原 create 已提交，该 attempt 不会再写 |
| create | 对象不存在；审计中该 attempt 时段有 `ResponseComplete`，`responseStatus.code` 为 400、403、404、422 等确定拒绝 | 确定拒绝 |
| create | 对象不存在；审计为 201 | 已创建后被删除。审计能给出原 UID 时按已创建处理，给不出时保持占用并升级 Runtime 负责人 |
| create | 409、5xx、504 超时、只有 `RequestReceived`、没有任何事件，或审计不可用 | 不能证明，保持占用 |
| DELETE | 对象不存在；同 kind 的 create 已有确定结果且记录了原 UID | 已不存在。原 DELETE 带原 UID 前置条件，迟到也只作用于原对象，不会产生新写入 |
| DELETE | 对象仍在、UID 与原记录相同、没有 `deletionTimestamp`；审计为 409、412 等确定拒绝 | 确定未删除 |
| DELETE | 对象带 `deletionTimestamp`，或审计结果不明 | 等待后重新执行第 2 节，期间保持占用 |
| 任一 | 同名不同 UID、写入方不是 Worker、归属注解不符，或出现业务绑定 | 停止，不清理，升级 Runtime 负责人 |

## 4. 核实前

- 保持原占用、原 attempt 和原 `status`，不改预算，不改 profile 的上限来“腾出”这份占用。
- 不重发 create，不手工删除或修改任何对象，不清空 `operations`，不把 reserve 标记为已结束。
- 需要恢复池容量时，只能经正常配置变更调整，且不能释放这份结果不明的占用。

## 5. 恢复

**5.1 能证明没有迟到写入**（判定为已创建、确定拒绝、已不存在或确定未删除）。由部署负责人
在批准的窗口内，用经评审的一次性 Store 修正只改原 attempt，并保存修正前的整行快照：

- 前置条件（CAS）：该行 `retired_at` 为空，`status`、`delivery_fence` 与第 2 节快照相同，没有
  有效 lease，`operations` 的 SHA-256 与快照相同，业务绑定计数仍为 0。任一不符就放弃，重做第 2 节。
- 已创建：该操作记为 `confirmed`、`writeCompletion = response`，`resource` 为本次回读的
  kind、name、namespace、UID 和 resourceVersion。确定拒绝：记为 `rejected`、`response`，
  `resource` 为空。已不存在：DELETE 记为 `confirmed`、`response`、`absent = true`，
  `resource` 保持原 UID。确定未删除：DELETE 记为 `rejected`、`response`。
- 同一事务把 `delivery_fence` 加一，使持有旧 lease 的 Worker 写入失败。

修正后由 Worker 沿原流程继续：`unknown` 行被淘汰，`retiring` 行按原 UID/resourceVersion
条件删除，全部回读不存在后才写 `retired_at` 并释放 charge。部署负责人只读回读到
`retired_at` 非空、`resource_charges.released = true`、六类对象和投影均不存在为止。

**5.2 发现迟到写入**（判定为不存在后对象又出现，或对象与已记录结果不一致）。若对象满足
第 2 节归属条件，按 5.1 的同一方式记录实际 UID/resourceVersion，由 Worker 按原条件清理。
归属不符或同名不同 UID 时不清理，保留现场并升级 Runtime 负责人。

**5.3 仍不能证明**。保持占用，按第 1 节周期复查。不以等待时长、重复 absence 或 GC 作为
结束条件；有界结束规则须另行评审写入工程 Spec 后才能使用。

## 6. 独立 executor 启动身份投影（3a/3b 合入后补齐）

投影是单独记录的临时 Secret，规则见
[Runtime HLD §10.3.1](../../docs/architecture/HLD-agent-runtime-M1.md#1031-排空通道的实例身份交付)
与 [§10.3.2](../../docs/architecture/HLD-agent-runtime-M1.md#1032-session-实例只读合同-v1)。
判定与恢复沿用第 3–5 节，另外核对：

- 原发布 attempt、目标 Pod UID、按 Pod 实例记录的投影名与启动引用、writer fence；
- 对象的 ownerReference 指向原 Pod UID，归属标签与第 2 节一致；
- Pod 已删除时，ownerReference 级联回收不能证明没有迟到的投影 create。

3a/3b 的 PR 须在本节写入投影记录的实际表、列和只读查询，并经复审；未补齐时不批准 Codex profile。

## 7. 回退

- 第 1–3 节只读，无需回退。
- 5.1/5.2 的 Store 修正：Worker 尚未推进（`delivery_fence`、`updated_at` 仍为修正后的值）时，
  可在同一窗口按修正前快照做 CAS 恢复；Worker 已删除资源或已写 `retired_at` 时不回退，
  按 5.2 处理新发现。
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
  "storeSnapshot": { "status": "...", "deliveryFence": 0, "operationsSha256": "...", "chargeReleased": false },
  "operations": [{ "attemptId": "...", "operation": "create", "kind": "Pod", "status": "unknown", "writeCompletion": "pending" }],
  "kubernetes": [{ "kind": "Pod", "uid": "...", "resourceVersion": "...", "owned": true }],
  "audit": [{ "auditID": "...", "verb": "create", "stage": "ResponseComplete", "code": 201 }],
  "decision": "created | rejected | absent | not-deleted | unprovable | escalated",
  "window": "<批准窗口引用或 null>",
  "writes": [{ "attemptId": "...", "before": "<sha256>", "after": "<sha256>" }],
  "readback": { "retiredAt": "<UTC 或 null>", "chargeReleased": true, "objectsAbsent": true },
  "evidenceSha256": { "store": "...", "kubernetes": "...", "audit": "..." }
}
```
