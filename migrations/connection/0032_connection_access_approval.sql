ALTER TABLE connection_action_versions
  ADD CONSTRAINT connection_action_versions_id_release_key
  UNIQUE (id, provider_release_id);

ALTER TABLE connection_accounts
  ADD CONSTRAINT connection_accounts_id_owner_key
  UNIQUE (id, owner_principal_id),
  ADD CONSTRAINT connection_accounts_id_release_key
  UNIQUE (id, provider_release_id);

ALTER TABLE connection_accounts
  ADD COLUMN last_credential_version_id TEXT,
  ADD CONSTRAINT connection_accounts_last_credential_fkey
    FOREIGN KEY (last_credential_version_id, id)
    REFERENCES connection_credential_versions(id, connection_id)
    DEFERRABLE INITIALLY DEFERRED;

UPDATE connection_accounts account
SET last_credential_version_id = credential.id
FROM connection_credential_versions credential
WHERE credential.connection_id = account.id AND credential.status = 'ACTIVE';

CREATE TABLE connection_access_enforcement (
  id TEXT PRIMARY KEY CHECK (id = 'personal'),
  state TEXT NOT NULL CHECK (state IN ('PRE_LAUNCH', 'ENFORCED')),
  legacy_snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cutoff_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((state = 'ENFORCED') = (cutoff_at IS NOT NULL))
);

INSERT INTO connection_access_enforcement (id, state)
VALUES ('personal', 'PRE_LAUNCH');

CREATE TABLE connection_pre_launch_accounts (
  connection_id TEXT PRIMARY KEY REFERENCES connection_accounts(id) ON DELETE RESTRICT
);

INSERT INTO connection_pre_launch_accounts (connection_id)
SELECT id FROM connection_accounts WHERE owner_type = 'PERSONAL';

CREATE OR REPLACE FUNCTION connection_reject_pre_launch_inventory_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Pre-launch account inventory is immutable'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER connection_pre_launch_inventory_immutable
BEFORE INSERT OR UPDATE OR DELETE ON connection_pre_launch_accounts
FOR EACH ROW EXECUTE FUNCTION connection_reject_pre_launch_inventory_change();

CREATE OR REPLACE FUNCTION connection_enforce_access_cutover()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Connection access enforcement cannot be removed'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'Connection access enforcement revision must increase'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.legacy_snapshot_at IS DISTINCT FROM OLD.legacy_snapshot_at THEN
    RAISE EXCEPTION 'Pre-launch inventory snapshot cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'ENFORCED' AND (
    NEW.state <> 'ENFORCED'
    OR NEW.cutoff_at IS DISTINCT FROM OLD.cutoff_at
  ) THEN
    RAISE EXCEPTION 'Connection access enforcement cannot be rolled back'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.state = 'PRE_LAUNCH' AND NEW.state = 'ENFORCED' THEN
    IF NEW.cutoff_at > now() OR EXISTS (
      SELECT 1 FROM connection_accounts account
      WHERE account.owner_type = 'PERSONAL'
        AND account.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM connection_access_authorizations access
          WHERE access.connection_id = account.id
            AND access.principal_id = account.owner_principal_id
            AND access.provider_release_id = account.provider_release_id
            AND (access.state = 'ACTIVE' OR (
              access.state = 'REAPPROVAL_REQUIRED'
              AND access.reapproval_deadline_at > now()
            ))
            AND (access.valid_until IS NULL OR access.valid_until > now())
        )
    ) THEN
      RAISE EXCEPTION 'Personal Connections need a complete baseline before enforcement'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TABLE connection_capability_profiles (
  id TEXT PRIMARY KEY,
  provider_release_id TEXT NOT NULL REFERENCES connection_provider_releases(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  effect_ceiling TEXT NOT NULL CHECK (effect_ceiling IN ('READ', 'WRITE')),
  required_scopes JSONB NOT NULL CHECK (jsonb_typeof(required_scopes) = 'array'),
  authorization_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'REVOKED')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, provider_release_id)
);

CREATE UNIQUE INDEX connection_capability_profiles_current
  ON connection_capability_profiles (provider_release_id, name)
  WHERE status = 'PUBLISHED';

CREATE TABLE connection_capability_profile_actions (
  capability_profile_id TEXT NOT NULL,
  provider_release_id TEXT NOT NULL,
  action_version_id TEXT NOT NULL,
  PRIMARY KEY (capability_profile_id, action_version_id),
  FOREIGN KEY (capability_profile_id, provider_release_id)
    REFERENCES connection_capability_profiles(id, provider_release_id) ON DELETE RESTRICT,
  FOREIGN KEY (action_version_id, provider_release_id)
    REFERENCES connection_action_versions(id, provider_release_id) ON DELETE RESTRICT
);

CREATE TABLE connection_disclaimer_versions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('GLOBAL', 'PROVIDER', 'POLICY')),
  provider_id TEXT,
  locale TEXT NOT NULL,
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 100000),
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  owner_metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(owner_metadata) = 'object'),
  material_change BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'REVOKED')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (status = 'DRAFT' AND published_at IS NULL)
    OR (status <> 'DRAFT' AND published_at IS NOT NULL)
  ),
  CHECK (kind <> 'GLOBAL' OR provider_id IS NULL)
);

CREATE TABLE connection_access_policy_versions (
  id TEXT PRIMARY KEY,
  provider_release_id TEXT NOT NULL REFERENCES connection_provider_releases(id) ON DELETE RESTRICT,
  capability_profile_id TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 1000000),
  default_duration_days INTEGER CHECK (default_duration_days BETWEEN 1 AND 3650),
  allow_permanent BOOLEAN NOT NULL DEFAULT false,
  request_ttl_seconds INTEGER NOT NULL CHECK (request_ttl_seconds BETWEEN 60 AND 2592000),
  connect_ttl_seconds INTEGER NOT NULL CHECK (connect_ttl_seconds BETWEEN 60 AND 2592000),
  renewal_lead_seconds INTEGER NOT NULL CHECK (renewal_lead_seconds BETWEEN 0 AND 31536000),
  material_change BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'REVOKED')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_principal_id TEXT NOT NULL REFERENCES connection_principals(id) ON DELETE RESTRICT,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (capability_profile_id, provider_release_id)
    REFERENCES connection_capability_profiles(id, provider_release_id) ON DELETE RESTRICT,
  UNIQUE (id, provider_release_id),
  UNIQUE (id, provider_release_id, capability_profile_id),
  CHECK (
    (status = 'DRAFT' AND published_at IS NULL)
    OR (status <> 'DRAFT' AND published_at IS NOT NULL)
  ),
  CHECK (allow_permanent OR default_duration_days IS NOT NULL)
);

CREATE UNIQUE INDEX connection_access_policy_versions_current
  ON connection_access_policy_versions (provider_release_id, capability_profile_id)
  WHERE status = 'PUBLISHED';

CREATE TABLE connection_access_policy_durations (
  id TEXT PRIMARY KEY,
  policy_version_id TEXT NOT NULL REFERENCES connection_access_policy_versions(id) ON DELETE RESTRICT,
  duration_kind TEXT NOT NULL CHECK (duration_kind IN ('FINITE', 'PERMANENT')),
  duration_days INTEGER,
  CHECK (
    (duration_kind = 'FINITE' AND duration_days BETWEEN 1 AND 3650)
    OR (duration_kind = 'PERMANENT' AND duration_days IS NULL)
  )
);

CREATE UNIQUE INDEX connection_access_policy_finite_durations
  ON connection_access_policy_durations (policy_version_id, duration_days)
  WHERE duration_kind = 'FINITE';

CREATE UNIQUE INDEX connection_access_policy_permanent_duration
  ON connection_access_policy_durations (policy_version_id)
  WHERE duration_kind = 'PERMANENT';

CREATE TABLE connection_access_policy_disclaimers (
  policy_version_id TEXT NOT NULL REFERENCES connection_access_policy_versions(id) ON DELETE RESTRICT,
  disclaimer_version_id TEXT NOT NULL REFERENCES connection_disclaimer_versions(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  PRIMARY KEY (policy_version_id, disclaimer_version_id),
  UNIQUE (policy_version_id, ordinal)
);

CREATE TABLE connection_approval_stages (
  id TEXT PRIMARY KEY,
  policy_version_id TEXT NOT NULL REFERENCES connection_access_policy_versions(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 10),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  quorum_type TEXT NOT NULL CHECK (quorum_type IN ('ANY', 'ALL', 'AT_LEAST_N')),
  quorum_count INTEGER,
  timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds BETWEEN 60 AND 2592000),
  UNIQUE (id, policy_version_id),
  UNIQUE (policy_version_id, ordinal),
  CHECK (
    (quorum_type = 'AT_LEAST_N' AND quorum_count > 0)
    OR (quorum_type IN ('ANY', 'ALL') AND quorum_count IS NULL)
  )
);

CREATE TABLE connection_approval_stage_approvers (
  policy_version_id TEXT NOT NULL REFERENCES connection_access_policy_versions(id) ON DELETE RESTRICT,
  stage_id TEXT NOT NULL,
  approver_principal_id TEXT NOT NULL REFERENCES connection_principals(id) ON DELETE RESTRICT,
  display_snapshot JSONB NOT NULL CHECK (jsonb_typeof(display_snapshot) = 'object'),
  PRIMARY KEY (stage_id, approver_principal_id),
  UNIQUE (policy_version_id, approver_principal_id),
  FOREIGN KEY (stage_id, policy_version_id)
    REFERENCES connection_approval_stages(id, policy_version_id) ON DELETE RESTRICT
);

CREATE TABLE connection_approval_delegations (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES connection_principals(id) ON DELETE RESTRICT,
  delegate_principal_id TEXT NOT NULL REFERENCES connection_principals(id) ON DELETE RESTRICT,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  created_by_principal_id TEXT NOT NULL REFERENCES connection_principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (principal_id <> delegate_principal_id),
  CHECK (starts_at < ends_at)
);

CREATE TABLE connection_employee_candidates (
  id TEXT PRIMARY KEY,
  requested_by_principal_id TEXT NOT NULL REFERENCES connection_principals(id) ON DELETE RESTRICT,
  identity_issuer TEXT NOT NULL,
  identity_subject_hash TEXT NOT NULL,
  legacy_identity_subject_hash TEXT NOT NULL,
  identity_reference TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT,
  alias TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX connection_employee_candidates_owner_expiry
  ON connection_employee_candidates (requested_by_principal_id, expires_at);

CREATE TABLE connection_access_requests (
  id TEXT PRIMARY KEY,
  applicant_principal_id TEXT NOT NULL REFERENCES connection_principals(id) ON DELETE RESTRICT,
  provider_release_id TEXT NOT NULL REFERENCES connection_provider_releases(id) ON DELETE RESTRICT,
  capability_profile_id TEXT NOT NULL REFERENCES connection_capability_profiles(id) ON DELETE RESTRICT,
  policy_version_id TEXT NOT NULL REFERENCES connection_access_policy_versions(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK (length(purpose) BETWEEN 1 AND 2000),
  duration_kind TEXT NOT NULL CHECK (duration_kind IN ('FINITE', 'PERMANENT')),
  duration_days INTEGER,
  state TEXT NOT NULL CHECK (state IN (
    'SUBMITTED', 'IN_REVIEW', 'ROUTING_BLOCKED', 'APPROVED_PENDING_CONNECTION',
    'CONSUMED', 'REJECTED', 'CANCELED', 'EXPIRED'
  )),
  current_stage_ordinal INTEGER CHECK (current_stage_ordinal BETWEEN 1 AND 10),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  routing_revision BIGINT NOT NULL DEFAULT 1 CHECK (routing_revision > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  connect_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (capability_profile_id, provider_release_id)
    REFERENCES connection_capability_profiles(id, provider_release_id) ON DELETE RESTRICT,
  FOREIGN KEY (policy_version_id, provider_release_id, capability_profile_id)
    REFERENCES connection_access_policy_versions
      (id, provider_release_id, capability_profile_id) ON DELETE RESTRICT,
  UNIQUE (id, policy_version_id),
  UNIQUE (
    id, applicant_principal_id, provider_release_id, capability_profile_id
  ),
  CHECK (
    (duration_kind = 'FINITE' AND duration_days BETWEEN 1 AND 3650)
    OR (duration_kind = 'PERMANENT' AND duration_days IS NULL)
  ),
  CHECK (state <> 'APPROVED_PENDING_CONNECTION' OR connect_expires_at IS NOT NULL)
);

CREATE UNIQUE INDEX connection_access_requests_one_open
  ON connection_access_requests (applicant_principal_id, provider_release_id, capability_profile_id)
  WHERE state IN ('SUBMITTED', 'IN_REVIEW', 'ROUTING_BLOCKED', 'APPROVED_PENDING_CONNECTION');

CREATE TABLE connection_disclaimer_presentations (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES connection_principals(id) ON DELETE RESTRICT,
  policy_version_id TEXT NOT NULL REFERENCES connection_access_policy_versions(id) ON DELETE RESTRICT,
  disclaimer_bundle_digest TEXT NOT NULL,
  presented_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '15 minutes'),
  consumed_request_id TEXT UNIQUE REFERENCES connection_access_requests(id) ON DELETE RESTRICT,
  consumed_at TIMESTAMPTZ,
  CHECK ((consumed_request_id IS NULL) = (consumed_at IS NULL))
);

CREATE INDEX connection_disclaimer_presentations_owner_expiry
  ON connection_disclaimer_presentations (principal_id, expires_at);

ALTER TABLE connection_oauth_transactions
  ADD COLUMN access_request_id TEXT
    REFERENCES connection_access_requests(id) ON DELETE RESTRICT,
  ADD COLUMN reconnect_connection_id TEXT
    REFERENCES connection_accounts(id) ON DELETE RESTRICT,
  ADD CONSTRAINT connection_oauth_transaction_target_check CHECK (
    (shared_scope_id IS NULL OR (access_request_id IS NULL AND reconnect_connection_id IS NULL))
    AND (access_request_id IS NULL OR reconnect_connection_id IS NULL)
  );

CREATE TABLE connection_request_stages (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES connection_access_requests(id) ON DELETE RESTRICT,
  policy_version_id TEXT NOT NULL,
  policy_stage_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 1 AND 10),
  state TEXT NOT NULL CHECK (state IN ('NOT_STARTED', 'PENDING', 'APPROVED', 'REJECTED', 'SKIPPED_BY_CANCEL')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  routing_revision BIGINT NOT NULL DEFAULT 1 CHECK (routing_revision > 0),
  opened_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (id, request_id),
  UNIQUE (request_id, ordinal),
  FOREIGN KEY (request_id, policy_version_id)
    REFERENCES connection_access_requests(id, policy_version_id) ON DELETE RESTRICT,
  FOREIGN KEY (policy_stage_id, policy_version_id)
    REFERENCES connection_approval_stages(id, policy_version_id) ON DELETE RESTRICT,
  CHECK ((state IN ('APPROVED', 'REJECTED', 'SKIPPED_BY_CANCEL')) = (completed_at IS NOT NULL))
);

CREATE TABLE connection_request_routing_revisions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES connection_access_requests(id) ON DELETE RESTRICT,
  request_stage_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  approver_principal_ids JSONB NOT NULL CHECK (jsonb_typeof(approver_principal_ids) = 'array'),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  created_by_principal_id TEXT NOT NULL REFERENCES connection_principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_stage_id, revision),
  FOREIGN KEY (request_stage_id, request_id)
    REFERENCES connection_request_stages(id, request_id) ON DELETE RESTRICT
);

CREATE TABLE connection_request_stage_approvers (
  routing_revision_id TEXT NOT NULL REFERENCES connection_request_routing_revisions(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  request_stage_id TEXT NOT NULL,
  approver_principal_id TEXT NOT NULL REFERENCES connection_principals(id) ON DELETE RESTRICT,
  display_snapshot JSONB NOT NULL CHECK (jsonb_typeof(display_snapshot) = 'object'),
  PRIMARY KEY (routing_revision_id, approver_principal_id),
  FOREIGN KEY (request_stage_id, request_id)
    REFERENCES connection_request_stages(id, request_id) ON DELETE RESTRICT
);

CREATE TABLE connection_request_disclaimer_confirmations (
  request_id TEXT NOT NULL REFERENCES connection_access_requests(id) ON DELETE RESTRICT,
  disclaimer_version_id TEXT NOT NULL REFERENCES connection_disclaimer_versions(id) ON DELETE RESTRICT,
  content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  locale TEXT NOT NULL,
  displayed_at TIMESTAMPTZ NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (request_id, disclaimer_version_id),
  CHECK (displayed_at <= confirmed_at)
);

CREATE TABLE connection_approval_decisions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES connection_access_requests(id) ON DELETE RESTRICT,
  request_stage_id TEXT NOT NULL,
  approver_principal_id TEXT NOT NULL REFERENCES connection_principals(id) ON DELETE RESTRICT,
  actor_principal_id TEXT NOT NULL REFERENCES connection_principals(id) ON DELETE RESTRICT,
  delegation_id TEXT REFERENCES connection_approval_delegations(id) ON DELETE RESTRICT,
  routing_revision BIGINT NOT NULL CHECK (routing_revision > 0),
  decision TEXT NOT NULL CHECK (decision IN ('APPROVE', 'REJECT')),
  comment TEXT CHECK (comment IS NULL OR length(comment) BETWEEN 1 AND 2000),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_stage_id, approver_principal_id),
  FOREIGN KEY (request_stage_id, request_id)
    REFERENCES connection_request_stages(id, request_id) ON DELETE RESTRICT,
  CHECK (decision <> 'REJECT' OR comment IS NOT NULL)
);

CREATE TABLE connection_connect_permits (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES connection_access_requests(id) ON DELETE RESTRICT,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  connection_id TEXT REFERENCES connection_accounts(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((consumed_at IS NULL) = (connection_id IS NULL))
);

CREATE TABLE connection_access_authorizations (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES connection_principals(id) ON DELETE RESTRICT,
  connection_id TEXT NOT NULL REFERENCES connection_accounts(id) ON DELETE RESTRICT,
  provider_release_id TEXT NOT NULL REFERENCES connection_provider_releases(id) ON DELETE RESTRICT,
  capability_profile_id TEXT NOT NULL REFERENCES connection_capability_profiles(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK (source IN ('APPROVED_REQUEST', 'PRE_LAUNCH_BASELINE')),
  source_request_id TEXT REFERENCES connection_access_requests(id) ON DELETE RESTRICT,
  external_account_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'ACTIVE', 'REAPPROVAL_REQUIRED', 'SUSPENDED', 'EXPIRED', 'DISCONNECTED', 'REVOKED'
  )),
  validity_kind TEXT NOT NULL CHECK (validity_kind IN ('FINITE', 'PERMANENT')),
  valid_until TIMESTAMPTZ,
  reapproval_deadline_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, connection_id),
  FOREIGN KEY (connection_id, principal_id)
    REFERENCES connection_accounts(id, owner_principal_id) ON DELETE RESTRICT,
  FOREIGN KEY (capability_profile_id, provider_release_id)
    REFERENCES connection_capability_profiles(id, provider_release_id) ON DELETE RESTRICT,
  FOREIGN KEY (
    source_request_id, principal_id, provider_release_id, capability_profile_id
  ) REFERENCES connection_access_requests
    (id, applicant_principal_id, provider_release_id, capability_profile_id)
    ON DELETE RESTRICT,
  CHECK ((validity_kind = 'FINITE') = (valid_until IS NOT NULL)),
  CHECK (source <> 'APPROVED_REQUEST' OR source_request_id IS NOT NULL)
);

CREATE UNIQUE INDEX connection_access_authorizations_current
  ON connection_access_authorizations (connection_id)
  WHERE state IN ('ACTIVE', 'REAPPROVAL_REQUIRED', 'SUSPENDED', 'DISCONNECTED');

CREATE TRIGGER connection_access_enforcement_monotonic
BEFORE UPDATE OR DELETE ON connection_access_enforcement
FOR EACH ROW EXECUTE FUNCTION connection_enforce_access_cutover();

CREATE TABLE connection_authorization_renewals (
  id TEXT PRIMARY KEY,
  access_authorization_id TEXT NOT NULL REFERENCES connection_access_authorizations(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL UNIQUE REFERENCES connection_access_requests(id) ON DELETE RESTRICT,
  prior_valid_until TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELED', 'EXPIRED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX connection_authorization_renewals_one_pending
  ON connection_authorization_renewals (access_authorization_id)
  WHERE status = 'PENDING';

CREATE TABLE connection_access_reapproval_campaigns (
  id TEXT PRIMARY KEY,
  provider_release_id TEXT NOT NULL REFERENCES connection_provider_releases(id) ON DELETE RESTRICT,
  capability_profile_id TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('DISCLAIMER', 'POLICY', 'PROVIDER_RELEASE')),
  trigger_version_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  deadline_at TIMESTAMPTZ NOT NULL,
  created_by_principal_id TEXT NOT NULL REFERENCES connection_principals(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (capability_profile_id, provider_release_id)
    REFERENCES connection_capability_profiles(id, provider_release_id) ON DELETE RESTRICT,
  UNIQUE (provider_release_id, capability_profile_id, trigger_kind, trigger_version_id),
  CHECK (deadline_at > created_at)
);

CREATE TABLE connection_access_reapproval_targets (
  campaign_id TEXT NOT NULL REFERENCES connection_access_reapproval_campaigns(id) ON DELETE RESTRICT,
  access_authorization_id TEXT NOT NULL REFERENCES connection_access_authorizations(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED', 'CANCELED')),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (campaign_id, access_authorization_id),
  CHECK ((status = 'PENDING') = (completed_at IS NULL))
);

CREATE TABLE connection_work_items (
  id TEXT PRIMARY KEY,
  recipient_principal_id TEXT NOT NULL REFERENCES connection_principals(id) ON DELETE RESTRICT,
  business_type TEXT NOT NULL,
  business_id TEXT NOT NULL,
  business_revision BIGINT NOT NULL CHECK (business_revision > 0),
  action_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'COMPLETED', 'CANCELED', 'EXPIRED')),
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recipient_principal_id, business_type, business_id, action_type)
);

CREATE INDEX connection_work_items_recipient_status
  ON connection_work_items (recipient_principal_id, status, due_at);

CREATE TABLE connection_notifications (
  id TEXT PRIMARY KEY,
  recipient_principal_id TEXT NOT NULL REFERENCES connection_principals(id) ON DELETE RESTRICT,
  business_type TEXT NOT NULL,
  business_id TEXT NOT NULL,
  business_revision BIGINT NOT NULL CHECK (business_revision > 0),
  event_type TEXT NOT NULL,
  reminder_sequence INTEGER NOT NULL DEFAULT 0 CHECK (reminder_sequence >= 0),
  summary JSONB NOT NULL CHECK (jsonb_typeof(summary) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (
    recipient_principal_id, business_type, business_id,
    business_revision, event_type, reminder_sequence
  ),
  UNIQUE (id, recipient_principal_id)
);

CREATE TABLE connection_notification_receipts (
  notification_id TEXT NOT NULL,
  recipient_principal_id TEXT NOT NULL REFERENCES connection_principals(id) ON DELETE RESTRICT,
  read_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  PRIMARY KEY (notification_id, recipient_principal_id),
  FOREIGN KEY (notification_id, recipient_principal_id)
    REFERENCES connection_notifications(id, recipient_principal_id) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION connection_enforce_approval_version_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_content JSONB;
  new_content JSONB;
  allowed_key TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Approval versions are append-only'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'DRAFT' AND NEW.status NOT IN ('DRAFT', 'PUBLISHED', 'REVOKED') THEN
    RAISE EXCEPTION 'Invalid approval version state transition'
      USING ERRCODE = 'check_violation';
  ELSIF OLD.status = 'PUBLISHED' AND NEW.status NOT IN ('PUBLISHED', 'SUPERSEDED', 'REVOKED') THEN
    RAISE EXCEPTION 'Invalid approval version state transition'
      USING ERRCODE = 'check_violation';
  ELSIF OLD.status = 'SUPERSEDED' AND NEW.status NOT IN ('SUPERSEDED', 'REVOKED') THEN
    RAISE EXCEPTION 'Invalid approval version state transition'
      USING ERRCODE = 'check_violation';
  ELSIF OLD.status = 'REVOKED' AND NEW.status <> 'REVOKED' THEN
    RAISE EXCEPTION 'Invalid approval version state transition'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status <> 'DRAFT' THEN
    old_content := to_jsonb(OLD);
    new_content := to_jsonb(NEW);
    FOREACH allowed_key IN ARRAY TG_ARGV LOOP
      old_content := old_content - allowed_key;
      new_content := new_content - allowed_key;
    END LOOP;
    IF old_content IS DISTINCT FROM new_content THEN
      RAISE EXCEPTION 'Published approval version content is immutable'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER connection_capability_profile_version_transition
BEFORE UPDATE OR DELETE ON connection_capability_profiles
FOR EACH ROW EXECUTE FUNCTION connection_enforce_approval_version_transition(
  'status', 'revision'
);

CREATE TRIGGER connection_disclaimer_version_transition
BEFORE UPDATE OR DELETE ON connection_disclaimer_versions
FOR EACH ROW EXECUTE FUNCTION connection_enforce_approval_version_transition(
  'status', 'revision', 'published_at'
);

CREATE TRIGGER connection_access_policy_version_transition
BEFORE UPDATE OR DELETE ON connection_access_policy_versions
FOR EACH ROW EXECUTE FUNCTION connection_enforce_approval_version_transition(
  'status', 'revision', 'published_at'
);

CREATE OR REPLACE FUNCTION connection_reject_approval_history_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Approval history is append-only'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER connection_approval_decision_append_only
BEFORE UPDATE OR DELETE ON connection_approval_decisions
FOR EACH ROW EXECUTE FUNCTION connection_reject_approval_history_mutation();

CREATE TRIGGER connection_routing_revision_append_only
BEFORE UPDATE OR DELETE ON connection_request_routing_revisions
FOR EACH ROW EXECUTE FUNCTION connection_reject_approval_history_mutation();

CREATE TRIGGER connection_request_stage_approver_append_only
BEFORE UPDATE OR DELETE ON connection_request_stage_approvers
FOR EACH ROW EXECUTE FUNCTION connection_reject_approval_history_mutation();

CREATE TRIGGER connection_disclaimer_confirmation_append_only
BEFORE UPDATE OR DELETE ON connection_request_disclaimer_confirmations
FOR EACH ROW EXECUTE FUNCTION connection_reject_approval_history_mutation();

CREATE OR REPLACE FUNCTION connection_enforce_approval_child_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_id TEXT;
  parent_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Approval version children cannot be updated'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_TABLE_NAME = 'connection_capability_profile_actions' THEN
    parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.capability_profile_id ELSE NEW.capability_profile_id END;
    SELECT status INTO parent_status FROM connection_capability_profiles WHERE id = parent_id FOR UPDATE;
  ELSE
    parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.policy_version_id ELSE NEW.policy_version_id END;
    SELECT status INTO parent_status FROM connection_access_policy_versions WHERE id = parent_id FOR UPDATE;
  END IF;
  IF parent_status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'Published approval version children are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER connection_capability_profile_actions_immutable
BEFORE INSERT OR UPDATE OR DELETE ON connection_capability_profile_actions
FOR EACH ROW EXECUTE FUNCTION connection_enforce_approval_child_mutation();

CREATE TRIGGER connection_access_policy_durations_immutable
BEFORE INSERT OR UPDATE OR DELETE ON connection_access_policy_durations
FOR EACH ROW EXECUTE FUNCTION connection_enforce_approval_child_mutation();

CREATE TRIGGER connection_access_policy_disclaimers_immutable
BEFORE INSERT OR UPDATE OR DELETE ON connection_access_policy_disclaimers
FOR EACH ROW EXECUTE FUNCTION connection_enforce_approval_child_mutation();

CREATE TRIGGER connection_approval_stages_immutable
BEFORE INSERT OR UPDATE OR DELETE ON connection_approval_stages
FOR EACH ROW EXECUTE FUNCTION connection_enforce_approval_child_mutation();

CREATE TRIGGER connection_approval_stage_approvers_immutable
BEFORE INSERT OR UPDATE OR DELETE ON connection_approval_stage_approvers
FOR EACH ROW EXECUTE FUNCTION connection_enforce_approval_child_mutation();

CREATE OR REPLACE FUNCTION connection_enforce_grant_status_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = NEW.status
    OR (OLD.status = 'ACTIVE' AND NEW.status IN (
      'PAUSED_CONNECTION', 'PAUSED_CREDENTIAL', 'REPLACED', 'REVOKED', 'TERMINATED'
    ))
    OR (OLD.status = 'PAUSED_CONNECTION' AND NEW.status IN ('REPLACED', 'TERMINATED'))
    OR (OLD.status = 'PAUSED_CREDENTIAL' AND NEW.status = 'TERMINATED') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid Connection grant status transition: % -> %', OLD.status, NEW.status
    USING ERRCODE = 'check_violation';
END;
$$;
