-- A stored version fixes the submitted package before review. New content uses a new version.
CREATE FUNCTION "platform"."guard_skill_version_integrity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		IF OLD."state" IN ('published', 'revoked') THEN
			RAISE EXCEPTION USING ERRCODE = '23514',
				MESSAGE = 'Published Skill Version must be retained',
				CONSTRAINT = 'skill_hub_version_retained';
		END IF;
		RETURN OLD;
	END IF;

	IF ROW(NEW."id", NEW."skill_id", NEW."owner_id", NEW."version",
		NEW."provider", NEW."visibility", NEW."package_object_version",
		NEW."package_digest", NEW."manifest_digest", NEW."signature_digest", NEW."created_at")
		IS DISTINCT FROM ROW(OLD."id", OLD."skill_id", OLD."owner_id", OLD."version",
		OLD."provider", OLD."visibility", OLD."package_object_version",
		OLD."package_digest", OLD."manifest_digest", OLD."signature_digest", OLD."created_at") THEN
		RAISE EXCEPTION USING ERRCODE = '23514',
			MESSAGE = 'Skill Version content is immutable',
			CONSTRAINT = 'skill_hub_version_immutable';
	END IF;

	IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
		(OLD."state" = 'pending_review' AND NEW."state" IN ('published', 'rejected'))
		OR (OLD."state" = 'published' AND NEW."state" = 'revoked')
	) THEN
		RAISE EXCEPTION USING ERRCODE = '23514',
			MESSAGE = 'Skill Version transition rejected',
			CONSTRAINT = 'skill_hub_version_transition';
	END IF;

	IF ROW(NEW."reviewed_by", NEW."review_reason")
		IS DISTINCT FROM ROW(OLD."reviewed_by", OLD."review_reason")
		AND NOT (OLD."state" = 'pending_review' AND NEW."state" IN ('published', 'rejected')) THEN
		RAISE EXCEPTION USING ERRCODE = '23514',
			MESSAGE = 'Skill Version review is immutable',
			CONSTRAINT = 'skill_hub_version_review_immutable';
	END IF;

	IF NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
		AND NOT (OLD."state" = 'published' AND NEW."state" = 'revoked') THEN
		RAISE EXCEPTION USING ERRCODE = '23514',
			MESSAGE = 'Skill Version revocation is immutable',
			CONSTRAINT = 'skill_hub_version_revocation_immutable';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "skill_hub_version_integrity"
BEFORE UPDATE OR DELETE ON "platform"."skill_hub_versions"
FOR EACH ROW EXECUTE FUNCTION "platform"."guard_skill_version_integrity"();
