import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
	agentApplications,
	agentAvailability,
	agentConfigurationRevisions,
	agentManagementHistory,
	agents,
	auditEvents,
	platformInfrastructureTables,
	platformSecretRecords,
	platformStatusValues,
	retiredSecretWrappingKeys,
	secretKeyRotations,
} from "./schema.ts";

function columnNames(table: Parameters<typeof getTableConfig>[0]): string[] {
	return getTableConfig(table).columns.map((column) => column.name);
}

describe("Agent persistence schema contract", () => {
	it("exports the bounded management values", () => {
		expect(platformStatusValues).toMatchObject({
			agentManagementStatus: [
				"pending_approval",
				"withdrawn",
				"rejected",
				"creating",
				"available",
				"stopped",
				"creation_failed",
				"disabled",
			],
			agentServiceAvailability: [
				"ready",
				"starting",
				"updating",
				"unavailable",
			],
			agentDesiredState: ["running", "stopped"],
			agentFailureCode: [
				"creation_not_ready",
				"health_check_failed",
				"workload_unavailable",
				"reconciliation_failed",
			],
			agentAvailabilityTargetType: ["user", "organization"],
			agentManagementSubjectType: ["agent_application", "agent"],
			secretKeyRotationState: [
				"pending",
				"rewrapping",
				"verifying",
				"completed",
				"failed",
			],
		});
	});

	it("exposes one management aggregate and canonical configuration revisions", () => {
		expect(columnNames(agents)).toEqual([
			"id",
			"current_configuration_revision",
			"created_at",
			"authorization_revision",
			"secret_activation_fence",
			"secret_activation_owner",
			"secret_activation_lease_expires_at",
		]);
		expect(columnNames(agentApplications)).toEqual([
			"id",
			"agent_id",
			"applicant_id",
			"name",
			"description",
			"status",
			"trace_id",
			"request_id",
			"submitted_at",
			"management_revision",
			"approval_revision",
			"decision_reason",
			"service_availability",
			"desired_state",
			"workload_revision",
			"fence",
			"failure_code",
		]);
		expect(columnNames(agentConfigurationRevisions)).toEqual([
			"agent_id",
			"revision",
			"source_reference",
			"created_at",
			"configuration",
		]);
		expect(columnNames(platformSecretRecords)).toEqual([
			"agent_id",
			"secret_id",
			"secret_version",
			"configuration_revision",
			"owner_type",
			"owner_id",
			"name",
			"lifecycle_state",
			"dek_fingerprint",
			"record",
			"created_at",
			"updated_at",
		]);
		expect(
			getTableConfig(platformSecretRecords).indexes.map(
				(index) => index.config.name,
			),
		).toEqual(
			expect.arrayContaining([
				"secret_record_dek_fingerprint_unique",
				"secret_record_agent_secret_version_unique",
			]),
		);
		expect(columnNames(agentAvailability)).toEqual([
			"agent_id",
			"target_type",
			"target_id",
		]);
		expect(columnNames(agentManagementHistory)).toEqual([
			"agent_id",
			"revision",
			"application_id",
			"subject_type",
			"subject_id",
			"operation",
			"from_status",
			"to_status",
			"occurred_at",
		]);
		expect(columnNames(secretKeyRotations)).toEqual([
			"rotation_id",
			"source_key_versions",
			"target_key_version",
			"state",
			"processed_secrets",
			"remaining_secrets",
			"created_at",
			"updated_at",
		]);
		expect(columnNames(retiredSecretWrappingKeys)).toEqual([
			"key_version",
			"retired_at",
		]);
		expect(columnNames(auditEvents)).toContain("details");
		expect(platformInfrastructureTables).toContain(agentAvailability);
		expect(platformInfrastructureTables).toContain(agentManagementHistory);
		expect(platformInfrastructureTables).toContain(platformSecretRecords);
		expect(platformInfrastructureTables).toContain(secretKeyRotations);
		expect(platformInfrastructureTables).toContain(retiredSecretWrappingKeys);
	});
});
