-- A catalog exception is tied to the one configuration committed by the named release.
CREATE FUNCTION platform.permits_template_publication_source(candidate_agent text, candidate_revision bigint, candidate_config jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,platform AS $$
DECLARE current_publication text;
DECLARE current_revision bigint;
DECLARE catalog_digest text;
BEGIN
  SELECT c.publication_id,c.revision,p.binding->>'targetImageDigest' INTO current_publication,current_revision,catalog_digest
  FROM platform.template_publication_catalog c JOIN platform.template_publications p ON p.id=c.publication_id
  WHERE c.template_id=candidate_config->'source'->>'templateId';
  IF NOT FOUND OR catalog_digest=candidate_config->'source'->>'imageDigest' THEN RETURN true; END IF;
  RETURN EXISTS (
      SELECT FROM platform.template_publications p JOIN platform.template_publication_targets t ON t.publication_id=p.id
      JOIN platform.agents a ON a.id=t.agent_id
      JOIN platform.agent_configuration_revisions prev ON prev.agent_id=a.id AND prev.revision=a.current_configuration_revision
      WHERE p.template_id=candidate_config->'source'->>'templateId' AND p.binding->>'scope'='single-agent' AND p.worker_ready
      AND p.binding->'candidate'->'catalogPublication'=jsonb_build_object('publicationId',current_publication,'revision',current_revision)
      AND t.status='applied' AND t.attempt=1 AND t.agent_id=candidate_agent AND p.binding->'target'->>'agentId'=candidate_agent
      AND p.binding->'target'->>'releaseId'=p.id AND p.binding->'target'->>'templateId'=p.template_id
      AND t.target->'source'=candidate_config->'source' AND candidate_config->'source'->>'imageDigest'=p.binding->'target'->>'targetImageDigest'
      AND candidate_revision=a.current_configuration_revision+1
      AND t.configuration_revision=(p.binding->'target'->>'expectedConfigurationRevision')::bigint+1
      AND (
        (candidate_revision=t.configuration_revision AND p.status='prepared'
         AND p.approved_by=p.binding->>'operatorId'
         AND prev.configuration->'source'->>'imageDigest'=p.binding->'target'->>'expectedImageDigest'
         AND t.target->>'configurationHash'=encode(sha256(convert_to(candidate_config::text,'UTF8')),'hex')
         AND (NOT (p.binding ? 'expiresAtMs') OR to_timestamp((p.binding->>'expiresAtMs')::double precision/1000)>clock_timestamp()))
        OR
        (candidate_revision>t.configuration_revision AND prev.configuration->'source'=candidate_config->'source'
         AND EXISTS (SELECT FROM platform.agent_configuration_revisions issued WHERE issued.agent_id=candidate_agent
          AND issued.revision=t.configuration_revision AND t.target->>'configurationHash'=encode(sha256(convert_to(issued.configuration::text,'UTF8')),'hex')))
      )
  );
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION platform.guard_template_publication_source()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,platform AS $$
BEGIN
  IF NEW.configuration IS NULL OR NEW.configuration->'source'->>'kind' IS DISTINCT FROM 'standard' OR NEW.runtime_revision <> NEW.revision THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('template-publication:' || (NEW.configuration->'source'->>'templateId'),0));
  IF NOT platform.permits_template_publication_source(NEW.agent_id,NEW.revision,NEW.configuration) THEN
    RAISE EXCEPTION 'TEMPLATE_CATALOG_REVISION_CONFLICT' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
