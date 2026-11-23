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
-- Summary combines the current queue with window-scoped observations. Trend only
-- reads window candidates and uses separate acceptance and cancellation clocks.
CREATE OR REPLACE FUNCTION platform_ops_dashboard.reply_observations(
    window_start timestamptz, window_end timestamptz, projection text
)
RETURNS TABLE (bucket timestamptz, channel text, waiting_users bigint,
    longest_wait_seconds double precision, accepted bigint, replied bigint,
    median_first_output_seconds double precision, cancelled_before_output bigint,
    median_cancel_wait_seconds double precision, latest_first_output_at timestamptz, queued_executions bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
BEGIN
    IF window_start IS NULL OR window_end IS NULL OR NOT isfinite(window_start)
       OR NOT isfinite(window_end) OR window_end <= window_start
       OR window_end - window_start > interval '24 hours'
       OR projection IS NULL OR projection NOT IN ('summary','trend') THEN
        RAISE EXCEPTION 'Invalid reply observation window' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY
    WITH observations AS (
        SELECT CASE WHEN e.channel_id = 'web' THEN 'Web'
                    WHEN e.channel_id = 'wecom' OR starts_with(e.channel_id,'wecom_bot:')
                         OR starts_with(e.channel_id,'wecom_app:') THEN '企微'
                    WHEN e.channel_id = 'api' OR starts_with(e.channel_id,'api:') THEN 'API'
                    ELSE '其他' END AS source,
               e.actor_id, e.principal_type, e.created_at, e.status, e.terminal_observed_at, first_text.at, first_text.queued
        FROM platform.conversation_executions e
        LEFT JOIN LATERAL (
            SELECT min(ev.persisted_at) FILTER (WHERE ev.event_type='text.delta') AS at,
                   bool_or(ev.event_type='task.status' AND ev.persisted_at < window_end) AS queued
            FROM platform.conversation_events ev
            WHERE ev.execution_id = e.execution_id AND (
                (ev.event_type='text.delta' AND length(ev.event_payload->>'text') > 0)
                OR (ev.source='platform' AND ev.event_type='task.status' AND ev.event_payload->>'status'='waiting')
            )
        ) first_text ON true
        WHERE (projection = 'summary' AND e.status IN ('waiting','submitted','processing'))
           OR (e.created_at >= window_start AND e.created_at < window_end)
           OR (e.status = 'cancelled' AND e.terminal_observed_at >= window_start AND e.terminal_observed_at < window_end)
    ), facts AS (
        SELECT source, actor_id, created_at AS clock, 'accepted' AS kind,
               CASE WHEN at >= created_at AND at < window_end
                         AND (terminal_observed_at IS NULL OR at <= terminal_observed_at)
                    THEN extract(epoch FROM at-created_at)::float8 END AS seconds,
               CASE WHEN at >= created_at AND at < window_end AND (terminal_observed_at IS NULL OR at <= terminal_observed_at) THEN at END AS observed_at, queued
        FROM observations WHERE created_at >= window_start AND created_at < window_end
        UNION ALL
        SELECT source, actor_id, terminal_observed_at, 'cancelled',
               extract(epoch FROM terminal_observed_at-created_at)::float8, NULL::timestamptz, false
        FROM observations WHERE status = 'cancelled' AND terminal_observed_at >= created_at
          AND terminal_observed_at >= window_start AND terminal_observed_at < window_end
          AND (at IS NULL OR at > terminal_observed_at)
        UNION ALL
        SELECT source, actor_id, window_start, 'waiting',
               extract(epoch FROM statement_timestamp()-created_at)::float8, NULL::timestamptz, false
        FROM observations WHERE projection = 'summary' AND principal_type = 'user'
          AND status IN ('submitted','processing','waiting') AND at IS NULL
    ), aggregated AS (
        SELECT CASE WHEN projection = 'trend' THEN date_bin(interval '5 minutes',clock,window_start)
                    ELSE window_start END AS t, source,
               count(DISTINCT actor_id) FILTER (WHERE kind='waiting') AS waiting,
               max(seconds) FILTER (WHERE kind='waiting') AS longest,
               count(*) FILTER (WHERE kind='accepted') AS submissions,
               count(seconds) FILTER (WHERE kind='accepted') AS replies,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) FILTER (WHERE kind='accepted') AS reply_median,
               count(*) FILTER (WHERE kind='cancelled') AS cancellations,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) FILTER (WHERE kind='cancelled') AS cancel_median,
               max(observed_at) AS latest_reply, count(*) FILTER (WHERE queued) AS queued_count
        FROM facts GROUP BY 1,2
    ), sources AS (
        SELECT unnest(ARRAY['Web','企微','API']) AS source
        UNION SELECT a.source FROM aggregated a
    )
    SELECT t.bucket, s.source, CASE WHEN projection='summary' THEN coalesce(a.waiting,0) END, a.longest,
           coalesce(a.submissions,0), coalesce(a.replies,0), a.reply_median, coalesce(a.cancellations,0), a.cancel_median, a.latest_reply, coalesce(a.queued_count,0)
    FROM generate_series(window_start, CASE WHEN projection='summary' THEN window_start
                             ELSE window_end - interval '1 microsecond' END, interval '5 minutes') AS t(bucket)
    CROSS JOIN sources s LEFT JOIN aggregated a ON a.t=t.bucket AND a.source=s.source;
END
$$;
REVOKE ALL ON FUNCTION platform_ops_dashboard.reply_observations(timestamptz,timestamptz,text) FROM PUBLIC;

-- Preserve the original dashboard function and its existing grants.
CREATE OR REPLACE FUNCTION platform_ops_dashboard.first_output(
    window_start timestamptz, window_end timestamptz
)
RETURNS TABLE (channel text, waiting_users bigint, longest_wait_seconds double precision,
    replied bigint, median_first_output_seconds double precision,
    cancelled_before_output bigint, median_cancel_wait_seconds double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
AS $$
    SELECT channel, waiting_users, longest_wait_seconds, replied, median_first_output_seconds,
           cancelled_before_output, median_cancel_wait_seconds
    FROM platform_ops_dashboard.reply_observations(window_start,window_end,'summary')
$$;
REVOKE ALL ON FUNCTION platform_ops_dashboard.first_output(timestamptz,timestamptz) FROM PUBLIC;
COMMIT;
