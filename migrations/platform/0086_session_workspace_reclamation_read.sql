-- Limit the operator role to workspace stop evidence. These views expose
-- neither business outbox payloads nor captured deployment/model inputs.
CREATE SCHEMA platform_reclamation_read;
--> statement-breakpoint
-- Invalid structured values must not pass through scalar evidence fields.
CREATE FUNCTION platform_reclamation_read.scalar(value jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN jsonb_typeof(value) IN ('string', 'number', 'boolean') THEN value END;
$$;
--> statement-breakpoint
CREATE FUNCTION platform_reclamation_read.identity(value jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN jsonb_typeof(value) = 'object' THEN (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
    FROM jsonb_each(CASE WHEN jsonb_typeof(value) = 'object' THEN value ELSE '{}'::jsonb END)
    WHERE key IN ('kind', 'namespace', 'name', 'uid', 'resourceVersion', 'controllerUid')
      AND jsonb_typeof(value) IN ('string', 'number', 'boolean', 'null')) ELSE 'null'::jsonb END;
$$;
--> statement-breakpoint
CREATE FUNCTION platform_reclamation_read.stop_receipt(value jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN jsonb_typeof(value) = 'object' THEN
    (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
    FROM jsonb_each(CASE WHEN jsonb_typeof(value) = 'object' THEN value ELSE '{}'::jsonb END)
    WHERE key IN ('schemaVersion', 'sandboxId', 'sessionId', 'sourceGeneration', 'sourceResourceFence', 'targetGeneration', 'targetResourceFence')
      AND jsonb_typeof(value) IN ('string', 'number', 'boolean', 'null'))
    || jsonb_build_object(
      'retainedPVC', platform_reclamation_read.identity(value->'retainedPVC'),
      'removed', CASE WHEN jsonb_typeof(value->'removed') = 'array' THEN (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
          'resource', platform_reclamation_read.identity(item->'resource'),
          'preconditions', platform_reclamation_read.identity(item->'preconditions'),
          'absence', platform_reclamation_read.identity(item->'absence')
        ) ORDER BY ord), '[]'::jsonb)
        FROM jsonb_array_elements(value->'removed') WITH ORDINALITY AS e(item, ord)
      ) ELSE 'null'::jsonb END
    )
  ELSE 'null'::jsonb END;
$$;
--> statement-breakpoint
CREATE FUNCTION platform_reclamation_read.deletion_progress(value jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN jsonb_typeof(value) = 'array' THEN (
    SELECT coalesce(jsonb_agg(
      (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
    FROM jsonb_each(CASE WHEN jsonb_typeof(item) = 'object' THEN item ELSE '{}'::jsonb END)
    WHERE key IN ('schemaVersion', 'state', 'deleteAttemptId', 'deleteAttempted', 'deleteCallResult', 'sourceGeneration', 'resourceFence', 'managementFence')
      AND jsonb_typeof(value) IN ('string', 'number', 'boolean', 'null'))
      || jsonb_build_object(
        'resource', platform_reclamation_read.identity(item->'resource'),
        'preconditions', platform_reclamation_read.identity(item->'preconditions')
      )
      || CASE WHEN item ? 'absence'
        THEN jsonb_build_object('absence', platform_reclamation_read.identity(item->'absence'))
        ELSE '{}'::jsonb END
      ORDER BY ord), '[]'::jsonb)
    FROM jsonb_array_elements(value) WITH ORDINALITY AS e(item, ord)
  ) ELSE 'null'::jsonb END;
$$;
--> statement-breakpoint
CREATE FUNCTION platform_reclamation_read.observation(value jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT
SET search_path = pg_catalog
AS $$
  SELECT CASE WHEN jsonb_typeof(value) = 'object' THEN
    (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
    FROM jsonb_each(CASE WHEN jsonb_typeof(value) = 'object' THEN value ELSE '{}'::jsonb END)
    WHERE key IN ('status', 'failureCode')
      AND jsonb_typeof(value) IN ('string', 'number', 'boolean', 'null'))
    || jsonb_build_object('resources', CASE WHEN jsonb_typeof(value->'resources') = 'array' THEN (
      SELECT coalesce(jsonb_agg(platform_reclamation_read.identity(item) ORDER BY ord), '[]'::jsonb)
      FROM jsonb_array_elements(value->'resources') WITH ORDINALITY AS e(item, ord)
    ) ELSE 'null'::jsonb END)
    || CASE WHEN value ? 'sourceStop' THEN jsonb_build_object('sourceStop', platform_reclamation_read.stop_receipt(value->'sourceStop')) ELSE '{}'::jsonb END
    || CASE WHEN value ? 'deletionProgress' THEN jsonb_build_object('deletionProgress', platform_reclamation_read.deletion_progress(value->'deletionProgress')) ELSE '{}'::jsonb END
    || CASE WHEN value ? 'workspaceSnapshot' THEN jsonb_build_object('workspaceSnapshot', (SELECT coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
    FROM jsonb_each(CASE WHEN jsonb_typeof(value->'workspaceSnapshot') = 'object' THEN value->'workspaceSnapshot' ELSE '{}'::jsonb END)
    WHERE key IN ('podUid', 'imageDigest', 'outcome', 'attempt', 'durationMs')
      AND jsonb_typeof(value) IN ('string', 'number', 'boolean', 'null'))) ELSE '{}'::jsonb END
  ELSE 'null'::jsonb END;
$$;
--> statement-breakpoint
CREATE VIEW platform_reclamation_read.allocations WITH (security_barrier = true) AS
SELECT session_generation, resource_fence, agent_id, conversation_id, sandbox_id,
       resource_name, status, desired_state,
       platform_reclamation_read.observation(resource_observation) AS resource_observation
FROM platform.session_sandbox_allocations
WHERE status = 'stopped' AND desired_state = 'stopped';
--> statement-breakpoint
CREATE VIEW platform_reclamation_read.outbox_items WITH (security_barrier = true) AS
SELECT id, scope_type, scope_id, operation, status, lease_owner, updated_at,
       jsonb_build_object('lifecycle', jsonb_build_object(
         'source', jsonb_build_object(
           'sandbox', jsonb_build_object(
             'agentId', platform_reclamation_read.scalar(payload #> '{lifecycle,source,sandbox,agentId}'),
             'sessionId', platform_reclamation_read.scalar(payload #> '{lifecycle,source,sandbox,sessionId}'),
             'sandboxId', platform_reclamation_read.scalar(payload #> '{lifecycle,source,sandbox,sandboxId}'),
             'generation', platform_reclamation_read.scalar(payload #> '{lifecycle,source,sandbox,generation}'),
             'resourceName', platform_reclamation_read.scalar(payload #> '{lifecycle,source,sandbox,resourceName}')
           ),
           'resourceFence', platform_reclamation_read.scalar(payload #> '{lifecycle,source,resourceFence}'),
           'policy', CASE WHEN nullif(payload #> '{lifecycle,source,policy}', 'null') IS NOT NULL
             THEN jsonb_build_object('namespace', platform_reclamation_read.scalar(payload #> '{lifecycle,source,policy,namespace}')) END,
           'observation', platform_reclamation_read.observation(payload #> '{lifecycle,source,observation}'),
           'deployment', CASE WHEN nullif(payload #> '{lifecycle,source,deployment}', 'null') IS NOT NULL THEN true END,
           'modelProjection', CASE WHEN nullif(payload #> '{lifecycle,source,modelProjection}', 'null') IS NOT NULL THEN true END
         ),
         'authority', jsonb_build_object('managementFence', platform_reclamation_read.scalar(payload #> '{lifecycle,authority,managementFence}')),
         'stopReceipt', CASE WHEN EXISTS (
           SELECT 1 FROM platform.session_sandbox_allocations a
           WHERE a.sandbox_id = payload #>> '{lifecycle,stopReceipt,sandboxId}'
             AND a.conversation_id = scope_id
             AND a.resource_observation->'sourceStop' = payload #> '{lifecycle,stopReceipt}'
         ) THEN platform_reclamation_read.stop_receipt(payload #> '{lifecycle,stopReceipt}') END,
         'preparation', CASE WHEN nullif(payload #> '{lifecycle,preparation}', 'null') IS NOT NULL THEN true END,
         'resumeRequested', CASE WHEN nullif(payload #> '{lifecycle,resumeRequested}', 'null') <> 'false' THEN true END
       ) || CASE WHEN (payload->'lifecycle') ? 'deletionProgress'
            THEN jsonb_build_object('deletionProgress',
              platform_reclamation_read.deletion_progress(payload #> '{lifecycle,deletionProgress}'))
            ELSE '{}'::jsonb END) AS payload
FROM platform.outbox_items
WHERE scope_type = 'conversation' AND operation = 'conversation.sandbox.reconcile.v1'
  AND status = 'succeeded' AND lease_owner IS NULL;
--> statement-breakpoint
CREATE VIEW platform_reclamation_read.stopped_audit WITH (security_barrier = true) AS
SELECT conversation_id, action, occurred_at, jsonb_build_object(
  'sandboxId', platform_reclamation_read.scalar(details->'sandboxId'), 'sessionGeneration', platform_reclamation_read.scalar(details->'sessionGeneration'),
  'resourceFence', platform_reclamation_read.scalar(details->'resourceFence'), 'status', platform_reclamation_read.scalar(details->'status')
) AS details
FROM platform.conversation_audit_events
WHERE action = 'conversation.sandbox.observed' AND details->>'status' = 'stopped';
