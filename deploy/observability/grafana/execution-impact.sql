-- Install in a Platform database dedicated to the displayed environment.
-- Run as the deployment-owned role with SELECT on the referenced columns.
BEGIN;
CREATE SCHEMA IF NOT EXISTS platform_ops_dashboard;
REVOKE ALL ON SCHEMA platform_ops_dashboard FROM PUBLIC;

CREATE OR REPLACE FUNCTION platform_ops_dashboard.execution_impact(
    window_start timestamptz, window_end timestamptz, breakdown text
)
RETURNS TABLE (
    bucket timestamptz, agent text, submissions bigint, failed bigint,
    completed bigint, cancelled bigint, unknown_now bigint,
    failed_users bigint, failed_applications bigint, terminal_time_missing bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
    IF window_start IS NULL OR window_end IS NULL OR NOT isfinite(window_start)
       OR NOT isfinite(window_end) OR window_end <= window_start
       OR window_end - window_start > interval '24 hours'
       OR breakdown IS NULL OR breakdown NOT IN ('total', 'trend', 'agent') THEN
        RAISE EXCEPTION 'Invalid dashboard window or grouping' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH facts AS (
        SELECT created_at AS at, agent_id, actor_id, principal_type, 'submitted' AS fact,
               status = 'unknown' AS unresolved,
               status IN ('completed','failed','cancelled') AND terminal_observed_at IS NULL AS missing
        FROM platform.conversation_executions
        WHERE created_at >= window_start AND created_at < window_end
        UNION ALL
        SELECT terminal_observed_at, agent_id, actor_id, principal_type, status::text, false, false
        FROM platform.conversation_executions
        WHERE terminal_observed_at >= window_start AND terminal_observed_at < window_end
          AND status IN ('completed','failed','cancelled')
    ), grouped AS (
        SELECT CASE WHEN breakdown = 'trend' THEN date_bin(interval '5 minutes', at, window_start)
                    ELSE window_start END AS t,
               CASE WHEN breakdown = 'agent' THEN agent_id END AS a,
               count(*) FILTER (WHERE fact = 'submitted') AS submitted_count,
               count(*) FILTER (WHERE fact = 'failed') AS failure_count,
               count(*) FILTER (WHERE fact = 'completed') AS success_count,
               count(*) FILTER (WHERE fact = 'cancelled') AS cancel_count,
               count(*) FILTER (WHERE unresolved) AS unknown_count,
               count(DISTINCT actor_id) FILTER (WHERE fact = 'failed' AND principal_type = 'user') AS users,
               count(DISTINCT actor_id) FILTER (WHERE fact = 'failed' AND principal_type = 'application') AS applications,
               count(*) FILTER (WHERE missing) AS missing_count
        FROM facts GROUP BY 1, 2
    )
    SELECT * FROM grouped
    UNION ALL
    SELECT window_start, NULL::text, 0::bigint, 0, 0, 0, 0, 0, 0, 0
    WHERE breakdown = 'total' AND NOT EXISTS (SELECT FROM grouped);
END
$$;
REVOKE ALL ON FUNCTION platform_ops_dashboard.execution_impact(timestamptz,timestamptz,text) FROM PUBLIC;
-- Only metadata from executions and persisted text.delta events enters this projection.
CREATE OR REPLACE FUNCTION platform_ops_dashboard.first_output(
    window_start timestamptz, window_end timestamptz
)
RETURNS TABLE (channel text, waiting_users bigint, longest_wait_seconds double precision,
    replied bigint, median_first_output_seconds double precision,
    cancelled_before_output bigint, median_cancel_wait_seconds double precision)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
    IF window_start IS NULL OR window_end IS NULL OR NOT isfinite(window_start)
       OR NOT isfinite(window_end) OR window_end <= window_start
       OR window_end - window_start > interval '24 hours' THEN
        RAISE EXCEPTION 'Invalid dashboard window' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY
    WITH candidates AS (
        SELECT e.channel_id, e.actor_id, e.principal_type, e.status, e.created_at, e.terminal_observed_at, first_text.at
        FROM platform.conversation_executions e
        LEFT JOIN LATERAL (
            SELECT min(ev.persisted_at) AS at
            FROM platform.conversation_events ev
            WHERE ev.execution_id = e.execution_id AND ev.event_type = 'text.delta'
              AND length(ev.event_payload->>'text') > 0
        ) first_text ON true
        WHERE e.status IN ('submitted','processing','waiting','unknown')
           OR e.created_at >= window_start AND e.created_at < window_end
           OR e.terminal_observed_at >= window_start AND e.terminal_observed_at < window_end
    ), measured AS (
        SELECT CASE WHEN channel_id = 'web' THEN 'Web'
                    WHEN channel_id = 'wecom' OR starts_with(channel_id,'wecom_') THEN '企微'
                    WHEN channel_id = 'api' OR starts_with(channel_id,'api:') THEN 'API'
                    ELSE '其他' END AS source,
               actor_id, principal_type,
               status IN ('submitted','processing','waiting') AND at IS NULL AS waiting,
               extract(epoch FROM statement_timestamp()-created_at)::float8 AS age,
               CASE WHEN at >= created_at AND created_at >= window_start AND created_at < window_end
                    THEN extract(epoch FROM at-created_at)::float8 END AS first_seconds,
               CASE WHEN status = 'cancelled' AND terminal_observed_at >= window_start
                         AND terminal_observed_at < window_end AND terminal_observed_at >= created_at
                         AND (at IS NULL OR at > terminal_observed_at)
                    THEN extract(epoch FROM terminal_observed_at-created_at)::float8 END AS cancel_seconds
        FROM candidates
    )
    SELECT source, count(DISTINCT actor_id) FILTER (WHERE waiting AND principal_type='user'),
           max(age) FILTER (WHERE waiting AND principal_type='user'), count(first_seconds),
           percentile_cont(0.5) WITHIN GROUP (ORDER BY first_seconds), count(cancel_seconds),
           percentile_cont(0.5) WITHIN GROUP (ORDER BY cancel_seconds)
    FROM measured GROUP BY source;
END
$$;
REVOKE ALL ON FUNCTION platform_ops_dashboard.first_output(timestamptz,timestamptz) FROM PUBLIC;
COMMIT;
