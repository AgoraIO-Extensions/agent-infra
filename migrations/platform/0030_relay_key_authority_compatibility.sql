-- Publish only Relay authority. Existing immutable 0027 tables are verified in
-- place; their rows, ciphertext, pointers and incoming Task references are kept.
DO $relay_authority$
DECLARE
  subject_relation oid := to_regclass('platform.relay_key_subjects');
  version_relation oid := to_regclass('platform.relay_key_versions');
  expected_subject oid;
  expected_version oid;
  original_relay_history boolean;
  catalogs jsonb;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM platform_migrations.history
    WHERE hash = 'c8c44572a4a2d9a659b302646612d6d885a320fff5ed7b8f0cd38752405c8863'
      AND created_at = 1790738152673
  ) INTO original_relay_history;
  IF (subject_relation IS NULL) <> (version_relation IS NULL)
    OR (original_relay_history AND subject_relation IS NULL) THEN
    RAISE EXCEPTION 'Incompatible Platform Relay authority';
  END IF;
  IF subject_relation IS NOT NULL AND NOT original_relay_history THEN
    RAISE EXCEPTION 'Unregistered Platform Relay authority';
  END IF;

  -- Transaction-local reference catalog uses exactly the generated domain DDL.
  CREATE TEMP TABLE "pg_temp"."relay_key_subjects" (
  	"purpose" text NOT NULL,
  	"subject_id" text NOT NULL,
  	"last_version" bigint DEFAULT 0 NOT NULL,
  	"current_version" bigint,
  	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  	CONSTRAINT "relay_key_subjects_purpose_subject_id_pk" PRIMARY KEY("purpose","subject_id"),
  	CONSTRAINT "relay_key_subject_purpose" CHECK ("pg_temp"."relay_key_subjects"."purpose" in ('personal', 'agent-default')),
  	CONSTRAINT "relay_key_subject_id" CHECK (char_length("pg_temp"."relay_key_subjects"."subject_id") between 1 and 1024),
  	CONSTRAINT "relay_key_subject_last_version" CHECK ("pg_temp"."relay_key_subjects"."last_version" between 0 and 9007199254740991),
  	CONSTRAINT "relay_key_subject_current_version" CHECK ("pg_temp"."relay_key_subjects"."current_version" is null or "pg_temp"."relay_key_subjects"."current_version" between 1 and "pg_temp"."relay_key_subjects"."last_version")
  ) ON COMMIT DROP;

  CREATE TEMP TABLE "pg_temp"."relay_key_versions" (
  	"purpose" text NOT NULL,
  	"subject_id" text NOT NULL,
  	"key_version" bigint NOT NULL,
  	"key_id" text NOT NULL,
  	"ciphertext" jsonb NOT NULL,
  	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
  	CONSTRAINT "relay_key_versions_purpose_subject_id_key_version_pk" PRIMARY KEY("purpose","subject_id","key_version"),
  	CONSTRAINT "relay_key_version_identity_unique" UNIQUE("purpose","subject_id","key_version","key_id"),
  	CONSTRAINT "relay_key_version_purpose" CHECK ("pg_temp"."relay_key_versions"."purpose" in ('personal', 'agent-default')),
  	CONSTRAINT "relay_key_version_subject_id" CHECK (char_length("pg_temp"."relay_key_versions"."subject_id") between 1 and 1024),
  	CONSTRAINT "relay_key_version_key_id" CHECK (char_length("pg_temp"."relay_key_versions"."key_id") between 1 and 1024),
  	CONSTRAINT "relay_key_version_safe" CHECK ("pg_temp"."relay_key_versions"."key_version" between 1 and 9007199254740991),
  	CONSTRAINT "relay_key_version_ciphertext_binding" CHECK (("pg_temp"."relay_key_versions"."ciphertext"->>'purpose' = "pg_temp"."relay_key_versions"."purpose"
  				and "pg_temp"."relay_key_versions"."ciphertext"->>'subjectId' = "pg_temp"."relay_key_versions"."subject_id"
  				and "pg_temp"."relay_key_versions"."ciphertext"->>'keyId' = "pg_temp"."relay_key_versions"."key_id"
  				and "pg_temp"."relay_key_versions"."ciphertext"->>'keyVersion' = "pg_temp"."relay_key_versions"."key_version"::text) is true)
  ) ON COMMIT DROP;

  ALTER TABLE "pg_temp"."relay_key_versions" ADD CONSTRAINT "relay_key_version_subject_fk" FOREIGN KEY ("purpose","subject_id") REFERENCES "pg_temp"."relay_key_subjects"("purpose","subject_id") ON DELETE no action ON UPDATE no action;
  CREATE UNIQUE INDEX "relay_key_version_key_id_unique" ON "pg_temp"."relay_key_versions" USING btree ("key_id");

  expected_subject := to_regclass('pg_temp.relay_key_subjects');
  expected_version := to_regclass('pg_temp.relay_key_versions');
  IF subject_relation IS NULL THEN
    CREATE TABLE "platform"."relay_key_subjects" (
    	"purpose" text NOT NULL,
    	"subject_id" text NOT NULL,
    	"last_version" bigint DEFAULT 0 NOT NULL,
    	"current_version" bigint,
    	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
    	CONSTRAINT "relay_key_subjects_purpose_subject_id_pk" PRIMARY KEY("purpose","subject_id"),
    	CONSTRAINT "relay_key_subject_purpose" CHECK ("platform"."relay_key_subjects"."purpose" in ('personal', 'agent-default')),
    	CONSTRAINT "relay_key_subject_id" CHECK (char_length("platform"."relay_key_subjects"."subject_id") between 1 and 1024),
    	CONSTRAINT "relay_key_subject_last_version" CHECK ("platform"."relay_key_subjects"."last_version" between 0 and 9007199254740991),
    	CONSTRAINT "relay_key_subject_current_version" CHECK ("platform"."relay_key_subjects"."current_version" is null or "platform"."relay_key_subjects"."current_version" between 1 and "platform"."relay_key_subjects"."last_version")
    );

    CREATE TABLE "platform"."relay_key_versions" (
    	"purpose" text NOT NULL,
    	"subject_id" text NOT NULL,
    	"key_version" bigint NOT NULL,
    	"key_id" text NOT NULL,
    	"ciphertext" jsonb NOT NULL,
    	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
    	CONSTRAINT "relay_key_versions_purpose_subject_id_key_version_pk" PRIMARY KEY("purpose","subject_id","key_version"),
    	CONSTRAINT "relay_key_version_identity_unique" UNIQUE("purpose","subject_id","key_version","key_id"),
    	CONSTRAINT "relay_key_version_purpose" CHECK ("platform"."relay_key_versions"."purpose" in ('personal', 'agent-default')),
    	CONSTRAINT "relay_key_version_subject_id" CHECK (char_length("platform"."relay_key_versions"."subject_id") between 1 and 1024),
    	CONSTRAINT "relay_key_version_key_id" CHECK (char_length("platform"."relay_key_versions"."key_id") between 1 and 1024),
    	CONSTRAINT "relay_key_version_safe" CHECK ("platform"."relay_key_versions"."key_version" between 1 and 9007199254740991),
    	CONSTRAINT "relay_key_version_ciphertext_binding" CHECK (("platform"."relay_key_versions"."ciphertext"->>'purpose' = "platform"."relay_key_versions"."purpose"
    				and "platform"."relay_key_versions"."ciphertext"->>'subjectId' = "platform"."relay_key_versions"."subject_id"
    				and "platform"."relay_key_versions"."ciphertext"->>'keyId' = "platform"."relay_key_versions"."key_id"
    				and "platform"."relay_key_versions"."ciphertext"->>'keyVersion' = "platform"."relay_key_versions"."key_version"::text) is true)
    );

    ALTER TABLE "platform"."relay_key_versions" ADD CONSTRAINT "relay_key_version_subject_fk" FOREIGN KEY ("purpose","subject_id") REFERENCES "platform"."relay_key_subjects"("purpose","subject_id") ON DELETE no action ON UPDATE no action;
    CREATE UNIQUE INDEX "relay_key_version_key_id_unique" ON "platform"."relay_key_versions" USING btree ("key_id");

    subject_relation := to_regclass('platform.relay_key_subjects');
    version_relation := to_regclass('platform.relay_key_versions');
  END IF;

  LOCK TABLE platform.relay_key_subjects, platform.relay_key_versions IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class relation
    WHERE relation.oid IN (subject_relation, version_relation)
      AND (relation.relkind <> 'r' OR relation.relpersistence <> 'p'
        OR relation.relrowsecurity OR relation.relforcerowsecurity
        OR relation.relispartition OR relation.reloftype <> 0)
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_inherits
    WHERE inhrelid IN (subject_relation, version_relation)
      OR inhparent IN (subject_relation, version_relation)
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger
    WHERE tgrelid IN (subject_relation, version_relation) AND NOT tgisinternal
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_rewrite
    WHERE ev_class IN (subject_relation, version_relation)
  ) THEN
    RAISE EXCEPTION 'Incompatible Platform Relay authority';
  END IF;

  -- Compare the complete authored columns/defaults, validated constraints and
  -- index semantics. Names alone, IF NOT EXISTS and a historical hash are not
  -- proof that current catalog still matches the production authority.
  SELECT jsonb_object_agg(relation.oid::text, jsonb_build_object(
    'columns', (
      SELECT jsonb_agg(jsonb_build_array(
        attribute.attnum, attribute.attname, attribute.atttypid,
        attribute.atttypmod, attribute.attnotnull, attribute.attidentity,
        attribute.attgenerated, attribute.attcollation,
        pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid)
      ) ORDER BY attribute.attnum)
      FROM pg_catalog.pg_attribute attribute
      LEFT JOIN pg_catalog.pg_attrdef default_value
        ON default_value.adrelid = attribute.attrelid
        AND default_value.adnum = attribute.attnum
      WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ),
    'constraints', (
      SELECT jsonb_agg(jsonb_build_array(
        constraint_value.conname, constraint_value.contype,
        constraint_value.conkey::text, constraint_value.confkey::text,
        CASE WHEN constraint_value.confrelid IN (subject_relation, expected_subject)
          THEN 'relay_key_subjects' ELSE constraint_value.confrelid::text END,
        constraint_value.confupdtype, constraint_value.confdeltype,
        constraint_value.confmatchtype, constraint_value.condeferrable,
        constraint_value.condeferred, constraint_value.convalidated,
        pg_catalog.pg_get_expr(constraint_value.conbin, constraint_value.conrelid)
      ) ORDER BY constraint_value.conname)
      FROM pg_catalog.pg_constraint constraint_value
      WHERE constraint_value.conrelid = relation.oid
    ),
    'indexes', (
      SELECT jsonb_agg(jsonb_build_array(
        index_relation.relname, index_relation.relam,
        index_value.indkey::text, index_value.indclass::text,
        index_value.indcollation::text, index_value.indoption::text,
        index_value.indisunique, index_value.indisprimary,
        index_value.indisvalid, index_value.indisready,
        index_value.indimmediate, index_value.indnullsnotdistinct,
        index_value.indnatts, index_value.indnkeyatts,
        pg_catalog.pg_get_expr(index_value.indexprs, index_value.indrelid),
        pg_catalog.pg_get_expr(index_value.indpred, index_value.indrelid)
      ) ORDER BY index_relation.relname)
      FROM pg_catalog.pg_index index_value
      JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_value.indexrelid
      WHERE index_value.indrelid = relation.oid
    )
  )) INTO catalogs
  FROM pg_catalog.pg_class relation
  WHERE relation.oid IN (subject_relation, version_relation, expected_subject, expected_version);

  IF (catalogs -> subject_relation::text) IS DISTINCT FROM (catalogs -> expected_subject::text)
    OR (catalogs -> version_relation::text) IS DISTINCT FROM (catalogs -> expected_version::text)
  THEN
    RAISE EXCEPTION 'Incompatible Platform Relay authority';
  END IF;
END
$relay_authority$;
