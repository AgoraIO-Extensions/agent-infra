# Platform 数据库收回函数的 PUBLIC 执行权

本手册用于部署负责人在用户批准的独立窗口收回 `agent_infra_platform` 库内 11 个函数签名的
`PUBLIC EXECUTE`。这是一次独立的数据库运维变更。应用迁移以应用角色运行，函数由
`agent_infra_admin` 拥有。把这次变更放在管理员手册里，可以单独安排实施、观察和回退窗口。
参见 [#4239](https://github.com/AgoraIO-Extensions/agent-infra/issues/4239)。

## 窗口前检查

1. 非实现 lane 复审本手册、隔离 PostgreSQL 16 演练结果及最新的 ACL 回读。用户批准实施和回退窗口
   后，由部署负责人操作。读取最新 Directory 快照的 revision 和 `validUntil`，按当前调度计算
   下一次自然同步的计划开始时间，当前版本为 `validUntil - 4 小时`。选择能在计划同步前完成提交的窗口，
   并留出至少 30 分钟观察、同步完成和回退所需时间。登记获准的最晚回退时间，并在它之前留足执行及核验
   回退的时间，确定观察截止时间。实施前若计划同步已经开始或改期到窗口外，重新选窗。
   等在途应用发布、迁移和 #4173 的 dry-run Job 及临时角色清理结束。观察期内暂停其他发布、权限变更和回收。
2. 确认已连接 ACK 新 lane 的 Platform 主库。用只读回读记录 App source、PostgreSQL 主版本、
   当前数据库、实例逻辑槽数和 11 个签名的 ACL。逻辑槽应延续 AC-1 基线为零，签名、owner、原始
   ACL 或已知调用方如有变化，先重审差异。Directory 和其他库保持各自的 ACL。
3. 确认 Platform API、Worker、Directory 同步及两套迁移的现有错误日志可查询。记录变更前
   30 分钟的权限错误基线，确认能按 UTC、部署单元及数据库角色定位记录。备好恢复授权的同一管理员
   入口和下方回退 SQL。

## ACL 回读

在独立核对时用 `BEGIN READ ONLY` 和 `COMMIT` 包住以下查询。在实施和回退事务内直接重跑查询。
用受限位置保存原始与展开 ACL。生产基线的 11 行原始 ACL 均为 NULL，展开后每行有 owner 和
`PUBLIC` 各一条 EXECUTE，grantor 都是 `agent_infra_admin`，均无 grant option。对照
[AC-1 回读](https://github.com/AgoraIO-Extensions/agent-infra/issues/4239#issuecomment-7025794749)。

```sql
SELECT current_database(), pg_catalog.pg_is_in_recovery(),
       current_setting('server_version_num') AS server_version;
SELECT count(*) AS logical_slots
FROM pg_catalog.pg_replication_slots
WHERE slot_type = 'logical';
SELECT count(*) AS reclamation_roles
FROM pg_catalog.pg_roles
WHERE rolname = 'agent_infra_reclamation_ro';

SELECT p.oid, p.oid::regprocedure AS signature, p.proowner::regrole AS owner,
       p.proacl AS raw_acl, a.grantor::regrole AS grantor,
       CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END AS grantee,
       a.privilege_type, a.is_grantable
FROM pg_catalog.pg_proc p
CROSS JOIN LATERAL pg_catalog.aclexplode(
  coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
) AS a
WHERE p.pronamespace = 'pg_catalog'::regnamespace
  AND p.oid IN (957, 715, 3457, 952, 3460, 1004, 3172, 964, 955, 3577, 3578)
ORDER BY p.oid, a.grantor, a.grantee, a.privilege_type, a.is_grantable;
```

已知调用方的直接授权清单为空。Platform API、Worker、迁移共用 `agent_infra_platform` 角色。
Directory 同步和迁移有各自的数据库角色，均连 Directory DB。静态核对未发现这些路径需要
这 11 个签名，其中包括锁定版本的驱动和下一次待发布源码。如果复审发现合法依赖，先在本手册
逐项登记角色、签名、旧 ACL、所需直接授权及对应回退，再提交复审。

## 实施

用现有管理员入口打开交互式 `psql -X -v ON_ERROR_STOP=1`，在同一会话运行下方事务起始语句。
核对数据库、主库和实际 grantor，把锁等待限制为 5 秒，将单条语句限制为 30 秒。
这些设置只用于该事务。实施和回退均使用相同的事务起始语句。

```sql
BEGIN;
SET LOCAL ROLE agent_infra_admin;
SET LOCAL search_path = pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '5min';
DO $$
BEGIN
  IF current_database() <> 'agent_infra_platform'
     OR pg_catalog.pg_is_in_recovery()
     OR current_setting('server_version_num')::integer / 10000 <> 16 THEN
    RAISE EXCEPTION 'Expected PostgreSQL 16 Platform primary';
  END IF;
END
$$;
```

在事务内回读 ACL 并核对基线，确认逻辑槽和临时角色计数均为零，然后执行撤权。

```sql
REVOKE EXECUTE ON FUNCTION
  pg_catalog.lo_creat(integer),
  pg_catalog.lo_create(oid),
  pg_catalog.lo_from_bytea(oid, bytea),
  pg_catalog.lo_open(oid, integer),
  pg_catalog.lo_put(oid, bigint, bytea),
  pg_catalog.lo_truncate(integer, integer),
  pg_catalog.lo_truncate64(integer, bigint),
  pg_catalog.lo_unlink(oid),
  pg_catalog.lowrite(integer, bytea),
  pg_catalog.pg_logical_emit_message(boolean, text, text),
  pg_catalog.pg_logical_emit_message(boolean, text, bytea)
FROM PUBLIC GRANTED BY agent_infra_admin RESTRICT;
```

在同一事务再回读。11 个签名应各有一条 owner EXECUTE 且无 PUBLIC 或其他 grantee，其他范围应
与变更前相符。任一语句失败、告警或结果偏离时执行 `ROLLBACK`。全部相符才执行
`COMMIT` 并记录 UTC 时间及本次移除的精确授权项。用新开的只读会话再次回读，确认已生效。
参见 [PostgreSQL 16 REVOKE](https://www.postgresql.org/docs/16/sql-revoke.html)。

## 观察和回退

从提交开始观察至少 30 分钟。通过须同时满足正常 Platform 读写、相关权限错误观察通过，以及一轮在提交后
开始并成功发布的自然 Directory 同步。记录新 `snapshot_published` 日志的 revision 与 UTC 时间，
并回读最新快照的 revision。按日志时间减去 `durationMs` 核对同步开始时间晚于提交。
如果时间精度或时钟差异使先后无法确认，等待下一条可核实的发布。只收到 `snapshot_superseded`、
仅回读到旧 revision，或收到提交前已开始的同步结果，均不能满足此项。
用已有 PostgreSQL 和 Platform API、Worker、Directory、迁移 hook 日志，检查新出现的
`permission denied` 或 SQLSTATE `42501`（日志提供该字段时）。按时间、角色和函数名对照
变更前基线，同时回读应用健康、同步成功时间、迁移 Job 状态。回执只写来源、时间、计数和错误分类。
生产迁移没有自然运行时，记录未覆盖，使用隔离回归证据，等下一次正常发布再补现场观察。
参见 [PostgreSQL 16 日志文档](https://www.postgresql.org/docs/16/runtime-config-logging.html)。

发现新增且与本次撤权相关的权限错误、业务或同步回归，或无法确认新错误无关时，立即回退。
观察信号中断且窗口内无法恢复时也回退。到观察截止时间仍缺少合格的新同步证据、未满 30 分钟
或缺其他通过证据时，记录「未通过」并立即回退，在获准的最晚回退时间前验证恢复。

回退时使用相同的事务起始语句和 ACL 回读，记录回退前的当前 ACL，核对目标 OID、签名、owner
及原 grantor。若目标身份、原 grantor 或待恢复的原授权语义出现漂移，停止并报告。根据撤权事务
的回执，只补回本次移除且当前缺失的 PUBLIC EXECUTE，使用原 grantor，保持无 grant option。
全部仍缺失时用下方完整语句。部分已经恢复时，从函数列表删去已有同一授权的签名。

```sql
GRANT EXECUTE ON FUNCTION
  pg_catalog.lo_creat(integer),
  pg_catalog.lo_create(oid),
  pg_catalog.lo_from_bytea(oid, bytea),
  pg_catalog.lo_open(oid, integer),
  pg_catalog.lo_put(oid, bigint, bytea),
  pg_catalog.lo_truncate(integer, integer),
  pg_catalog.lo_truncate64(integer, bigint),
  pg_catalog.lo_unlink(oid),
  pg_catalog.lowrite(integer, bytea),
  pg_catalog.pg_logical_emit_message(boolean, text, text),
  pg_catalog.pg_logical_emit_message(boolean, text, bytea)
TO PUBLIC GRANTED BY agent_infra_admin;
```

将回退后的展开 ACL 与「回退前的当前 ACL + 本次精确恢复项」逐条比较。按目标 OID 核对 grantor、
grantee、权限和 grant option。无关授权保留并报告，原始基线只用于说明漂移。目录原值可从 NULL
变成等效的显式 ACL。符合该预期再 `COMMIT`，否则 `ROLLBACK` 并报告差异。提交后用新会话
验证权限与受影响路径恢复。
参见 [PostgreSQL 16 GRANT](https://www.postgresql.org/docs/16/sql-grant.html)。

## AC-3 验证

- 在隔离 PostgreSQL 16 的 Platform 库执行迁移至 `0088_session_workspace_reclamation_read`，
  演练撤权后用[正式建角色脚本](../../deploy/ack/operator/session-workspace-reclamation-db-ro.sql)
  创建 `agent_infra_reclamation_ro`。按[生产 dry-run 数据库身份](SESSION-workspace-reclamation-deployment.md#生产-dry-run-数据库身份)
  启用临时登录。以实际登录确认默认只读、三个批准的视图和指定列可读，原始 payload、资源观测、
  审计明细、消息和凭据列受限。逐一核对 Platform 库对 11 个签名的
  `has_function_privilege(..., 'EXECUTE')` 均为 false。
- 在隔离库用合成输入验证 11 个函数调用、创建持久表及写入业务表，共 13 项。每项使用独立的
  `BEGIN READ WRITE` 事务并回滚，或每项建立 savepoint、记录结果后回滚到该 savepoint。
  每项都应单独得到 SQLSTATE `42501`。遇到 `25P02` 时该项缺少有效证据，须另开事务重验。
  从管理员会话验证没有新增持久表或大对象。参见 [PostgreSQL 16 事务与保存点](https://www.postgresql.org/docs/16/tutorial-transactions.html)。
- 关闭试验连接，按正式流程将角色设为 `NOLOGIN`，核对无活动连接后执行
  [正式清理脚本](../../deploy/ack/operator/session-workspace-reclamation-db-ro-drop.sql)。
  回读 `role_removed=true`，确认角色和两项授权回执对象均已清理。在隔离库演练恢复授权，
  回读展开 ACL 与有效权限，并核对期间新增的无关直接授权得以保留。
- 在隔离环境运行现有 Platform API、Worker、Directory 同步回归。用各自的真实角色运行
  Platform 与 Directory 的空库迁移和上一版升级迁移。保留回归及授予矩阵结果。
- 生产窗口仅用目录与服务读回确认 11 条 ACL、应用健康、同步及迁移结果。按现有手册核对
  `agent_infra_reclamation_ro` 的连接权、允许读取的列和视图、写入限制，以及逻辑槽前置条件、
  NOLOGIN 和清理回执。若临时角色尚未创建，登记待下次 #4173 Job 窗口回读有效权限。
  参见[生产 dry-run 数据库身份](SESSION-workspace-reclamation-deployment.md#生产-dry-run-数据库身份)。
- `postgres`、`template1` 的 PUBLIC CONNECT 继续使用已批准的短期登录例外。AC-3 的函数
  撤权验证限定在 Platform 库。跨库防护及专用 HBA 规则单独评审和验收。
  参见[已批准的连接例外](SESSION-workspace-reclamation-deployment.md#已批准的连接例外)。
