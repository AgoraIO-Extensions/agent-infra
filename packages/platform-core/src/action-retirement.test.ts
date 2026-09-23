import { expect, it, vi } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "./agent-configuration.conformance.js";
import {
	type AgentConfigurationRecordV1,
	decodeAgentConfigurationRecordV2,
} from "./agent-configuration.js";
import {
	applicationFoundationActorContextV1,
	applicationFoundationAdmissionDependenciesV1,
	applicationFoundationCommandV1,
} from "./application-foundation.conformance.js";
import {
	type ApplicationFoundationTransactionPortV1,
	createApplicationFoundationUseCaseV1,
} from "./application-foundation.js";
import {
	applicationRevisionActorContextV1,
	applicationRevisionAdmissionsV1,
	applicationRevisionCommandV1,
} from "./application-revision.conformance.js";
import {
	type ApplicationRevisionTransactionPortV1,
	createApplicationRevisionUseCaseV1,
} from "./application-revision.js";

const historicalActions = [
	{ providerId: "github", actionId: "issues.read", actionVersion: "v3" },
];

it("strictly reads historical Action configurations without changing their data or business identity", () => {
	for (const actions of [[], historicalActions]) {
		const legacy: AgentConfigurationRecordV1 = {
			...structuredClone(agentConfigurationConformanceRecordV1),
			schemaVersion: 1,
			actions,
			actionSetRevision: "historical-policy-7",
		};
		const before = structuredClone(legacy);
		expect(decodeAgentConfigurationRecordV2(legacy)).toEqual(
			agentConfigurationConformanceRecordV1,
		);
		expect(legacy).toEqual(before);
	}
	for (const invalid of [
		null,
		{ ...agentConfigurationConformanceRecordV1, schemaVersion: 3 },
		{ ...agentConfigurationConformanceRecordV1, schemaVersion: 1 },
		{ ...agentConfigurationConformanceRecordV1, actions: [] },
		{ ...agentConfigurationConformanceRecordV1, actionSetRevision: "old" },
		{
			...agentConfigurationConformanceRecordV1,
			schemaVersion: 1,
			actions: historicalActions,
			actionSetRevision: "",
		},
		{ ...agentConfigurationConformanceRecordV1, modelConfiguration: null },
	]) {
		expect(() => decodeAgentConfigurationRecordV2(invalid)).toThrow();
	}
});

it("rejects retired fields on new application and revision requests before any persistence", async () => {
	const foundationRead = vi.fn();
	const revisionRead = vi.fn();
	const commit = vi.fn();
	const foundation = createApplicationFoundationUseCaseV1({
		...applicationFoundationAdmissionDependenciesV1(),
		transaction: { read: foundationRead, commit },
	});
	const revision = createApplicationRevisionUseCaseV1({
		...applicationRevisionAdmissionsV1(),
		transaction: { read: revisionRead, commit },
	});
	for (const actions of [[], historicalActions]) {
		await expect(
			foundation.submit(
				{ ...applicationFoundationCommandV1, actions } as never,
				applicationFoundationActorContextV1,
			),
		).rejects.toMatchObject({ code: "invalid_command" });
		await expect(
			revision.revise(
				{ ...applicationRevisionCommandV1, actions } as never,
				applicationRevisionActorContextV1,
			),
		).rejects.toMatchObject({ code: "invalid_command" });
	}
	for (const call of [foundationRead, revisionRead, commit]) {
		expect(call).not.toHaveBeenCalled();
	}
});

it("replays completed V1 applications through current authorization and never completes fresh legacy admission", async () => {
	const result = {
		schemaVersion: 1 as const,
		applicationId: applicationFoundationCommandV1.applicationId,
		agentId: applicationFoundationCommandV1.agentId,
		configurationRevision: 1 as const,
		status: "pending_approval" as const,
	};
	const dependencies = applicationFoundationAdmissionDependenciesV1();
	const authorization = vi.spyOn(
		dependencies.authorizationAdmission,
		"authorize",
	);
	const image = vi.spyOn(dependencies.imageAdmission, "admitImage");
	const commit = vi.fn();
	const read: ApplicationFoundationTransactionPortV1["read"] = async (
		input,
	) => {
		if (
			input.actorId !== applicationFoundationActorContextV1.userId ||
			input.agentId !== result.agentId ||
			input.applicationId !== result.applicationId ||
			input.idempotencyKey !== applicationFoundationCommandV1.idempotencyKey
		)
			return { outcome: "ready" };
		return input.requestDigest ===
			applicationFoundationActorContextV1.rawRequestDigest
			? { outcome: "replayed", result }
			: { outcome: "idempotency_conflict" };
	};
	const useCase = createApplicationFoundationUseCaseV1({
		...dependencies,
		transaction: { read, commit },
	});
	const command = {
		...applicationFoundationCommandV1,
		schemaVersion: 1,
		actions: historicalActions,
	};
	await expect(
		useCase.replayLegacyV1(command, applicationFoundationActorContextV1),
	).resolves.toEqual(result);
	expect(authorization).toHaveBeenCalled();
	await expect(
		useCase.replayLegacyV1(
			{ ...command, idempotencyKey: "new-key" },
			applicationFoundationActorContextV1,
		),
	).rejects.toMatchObject({ code: "invalid_command" });
	await expect(
		useCase.replayLegacyV1(command, {
			...applicationFoundationActorContextV1,
			rawRequestDigest: "c".repeat(64),
		}),
	).rejects.toMatchObject({ code: "idempotency_conflict" });
	await expect(
		useCase.submit(command as never, applicationFoundationActorContextV1),
	).rejects.toMatchObject({ code: "invalid_command" });
	expect(image).not.toHaveBeenCalled();
	expect(commit).not.toHaveBeenCalled();
	vi.spyOn(dependencies.authorizationAdmission, "authorize").mockImplementation(
		async (input) => ({
			schemaVersion: 1,
			status: "rejected",
			agentId: input.agentId,
			actorId: input.actorId,
		}),
	);
	await expect(
		useCase.replayLegacyV1(command, applicationFoundationActorContextV1),
	).rejects.toMatchObject({ code: "not_authorized" });
});

it("rechecks the current application actor on historical revision replay", async () => {
	const result = {
		schemaVersion: 1 as const,
		applicationId: "application_01",
		agentId: "agent_01",
		status: "pending_approval" as const,
		managementRevision: 4,
		configurationRevision: 8,
	};
	const dependencies = applicationRevisionAdmissionsV1();
	const commit = vi.fn();
	const read: ApplicationRevisionTransactionPortV1["read"] = async (input) =>
		input.actorId === "owner_01" &&
		input.applicationId === "application_01" &&
		input.idempotencyKey === applicationRevisionCommandV1.idempotencyKey
			? input.requestDigest ===
				applicationRevisionActorContextV1.rawRequestDigest
				? { outcome: "replayed", result }
				: { outcome: "idempotency_conflict" }
			: { outcome: "unavailable" };
	const useCase = createApplicationRevisionUseCaseV1({
		...dependencies,
		transaction: { read, commit },
	});
	const command = {
		...applicationRevisionCommandV1,
		schemaVersion: 1,
		actions: historicalActions,
	};
	await expect(
		useCase.replayLegacyV1(command, applicationRevisionActorContextV1),
	).resolves.toEqual(result);
	await expect(
		useCase.replayLegacyV1(command, {
			...applicationRevisionActorContextV1,
			userId: "other",
		}),
	).rejects.toMatchObject({ code: "not_authorized" });
	await expect(
		useCase.replayLegacyV1(command, {
			...applicationRevisionActorContextV1,
			accountStatus: "disabled",
		}),
	).rejects.toMatchObject({ code: "not_authorized" });
	await expect(
		useCase.replayLegacyV1(command, {
			...applicationRevisionActorContextV1,
			rawRequestDigest: "c".repeat(64),
		}),
	).rejects.toMatchObject({ code: "idempotency_conflict" });
	expect(commit).not.toHaveBeenCalled();
});
