-- Install as the dedicated owner in this environment's dashboard database.
BEGIN;
CREATE SCHEMA IF NOT EXISTS platform_ops_dashboard;
REVOKE ALL ON SCHEMA platform_ops_dashboard FROM PUBLIC;
CREATE TABLE IF NOT EXISTS platform_ops_dashboard.ack_query_status (
    source_uid text NOT NULL, cluster_id text NOT NULL, namespace text NOT NULL,
    checked_at timestamptz NOT NULL,
    result text NOT NULL CHECK (result IN ('samples','empty','failed')),
    last_sample timestamptz, failed_at timestamptz, recovered_at timestamptz,
    PRIMARY KEY (source_uid, cluster_id, namespace)
);
REVOKE ALL ON platform_ops_dashboard.ack_query_status FROM PUBLIC;
CREATE OR REPLACE FUNCTION platform_ops_dashboard.record_ack_query(
    source_uid text, cluster_id text, namespace text, checked_at timestamptz,
    result text, sample_at timestamptz
) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
    INSERT INTO platform_ops_dashboard.ack_query_status AS s
    VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $5='failed' THEN $4 END,NULL)
    ON CONFLICT ON CONSTRAINT ack_query_status_pkey DO UPDATE SET
        checked_at=excluded.checked_at, result=excluded.result,
        last_sample=greatest(s.last_sample,excluded.last_sample),
        failed_at=CASE WHEN excluded.result='failed' AND s.result<>'failed'
            THEN excluded.checked_at ELSE s.failed_at END,
        recovered_at=CASE WHEN excluded.result='failed' THEN NULL WHEN s.result='failed'
            THEN excluded.checked_at ELSE s.recovered_at END
    WHERE excluded.checked_at > s.checked_at;
$$;
REVOKE ALL ON FUNCTION platform_ops_dashboard.record_ack_query(text,text,text,timestamptz,text,timestamptz) FROM PUBLIC;
COMMIT;
