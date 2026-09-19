import { describe, expect, it, vi } from "vitest";
import {
	agentConfigurationConformanceAdmissionsV1,
	agentConfigurationConformanceRecordV1,
} from "./agent-configuration.conformance.ts";
import {
	type AgentConfigurationUseCaseDependenciesV1,
	createAgentConfigurationUseCaseV1,
	type ReleaseStandardTemplateCommandV1,
	type StandardTemplateReleaseAuthorizationV1,
} from "./agent-configuration.ts";
import {
	FakeAgentConfigurationAdmissionsV1,
	FakeAgentConfigurationTransactionV1,
} from "./fake-agent-configuration.ts";

const target = {
	schemaVersion: 1 as const,
	releaseId: "release_01",
	agentId: "agent_01",
	templateId: "template_01",
	expectedConfigurationRevision: 7,
	expectedImageDigest: `sha256:${"a".repeat(64)}`,
	targetImageDigest: `sha256:${"b".repeat(64)}`,
};
const command: ReleaseStandardTemplateCommandV1 = {
	schemaVersion: 1,
	target,
	idempotencyKey: "release_key",
	requestId: "request_01",
	traceId: "trace_01",
};
const actor = {
	schemaVersion: 1 as const,
	actorId: "administrator",
	rawRequestDigest: "0".repeat(64),
};
function harness() {
	const transaction = new FakeAgentConfigurationTransactionV1(
		agentConfigurationConformanceRecordV1,
	);
	const admissions = new FakeAgentConfigurationAdmissionsV1({
		...agentConfigurationConformanceAdmissionsV1,
		images: [
			{
				selection: { kind: "standard", templateId: target.templateId },
				source: {
					...agentConfigurationConformanceRecordV1.source,
					imageDigest: target.targetImageDigest,
					admissionRevision: "image_new",
				},
			},
		],
	});
	let authority:
		| StandardTemplateReleaseAuthorizationV1
		| { schemaVersion: 1; status: "rejected" } = {
		schemaVersion: 1,
		status: "admitted",
		intent: "standard_template.release_to_agent",
		target,
		actorId: actor.actorId,
		accountStatus: "active",
		isAdministrator: true,
		identityRevision: "identity_1",
		deploymentRevision: "deployment_1",
		authorizationRevision: "authorization_9",
	};
	const authorize = vi.fn(async () => authority);
	const deps: AgentConfigurationUseCaseDependenciesV1 = {
		transaction,
		authorizationAdmission: admissions,
		standardTemplateReleaseAuthorization: { authorize },
		imageAdmission: admissions,
		modelAdmission: admissions,
		secretAdmission: admissions,
		channelAdmission: admissions,
	};
	return {
		transaction,
		admissions,
		deps,
		authorize,
		setAuthority(value: typeof authority) {
			authority = value;
		},
		create() {
			return createAgentConfigurationUseCaseV1(deps);
		},
	};
}

describe("bounded standard template publication", () => {
	it("publishes only source with actual non-Owner actor and preserves full existing configuration", async () => {
		const h = harness();
		const result = await h.create().releaseStandardTemplate(command, actor);
		expect(result).toEqual({
			schemaVersion: 1,
			agentId: target.agentId,
			revision: 8,
			changedFields: ["source"],
		});
		const snapshot = h.transaction.snapshot();
		expect(snapshot.configuration).toEqual({
			...agentConfigurationConformanceRecordV1,
			revision: 8,
			source: {
				...agentConfigurationConformanceRecordV1.source,
				imageDigest: target.targetImageDigest,
				admissionRevision: "image_new",
			},
		});
		expect(snapshot.lastPlan).toMatchObject({
			accessUpdate: null,
			expectedAuthorizationRevision: "authorization_9",
			nextAuthorizationRevision: "authorization_9",
			auditEvent: { actorId: actor.actorId, changedFields: ["source"] },
		});
		expect(h.authorize).toHaveBeenCalledTimes(2);
	});
	it("reauthorizes before exact persisted replay after restarting the use case", async () => {
		const h = harness();
		const original = await h.create().releaseStandardTemplate(command, actor);
		expect(
			await h.create().releaseStandardTemplate(
				{
					...command,
					requestId: "restart_request",
					traceId: "restart_trace",
				},
				actor,
			),
		).toEqual(original);
		expect(h.transaction.snapshot()).toMatchObject({
			commitCount: 1,
			idempotencyCount: 1,
			outboxCount: 1,
			auditCount: 1,
		});
		h.setAuthority({ schemaVersion: 1, status: "rejected" });
		await expect(
			h.create().releaseStandardTemplate(command, actor),
		).rejects.toMatchObject({ code: "not_authorized" });
	});
	it.each([
		"releaseId",
		"expectedConfigurationRevision",
		"expectedImageDigest",
		"targetImageDigest",
	] as const)("binds %s in canonical replay identity", async (field) => {
		const h = harness();
		await h.create().releaseStandardTemplate(command, actor);
		const changed = {
			...target,
			[field]:
				field === "expectedConfigurationRevision"
					? 8
					: field === "releaseId"
						? "release_other"
						: `sha256:${"c".repeat(64)}`,
		};
		h.authorize.mockResolvedValue({
			...(await h.authorize()),
			target: changed,
		} as StandardTemplateReleaseAuthorizationV1);
		await expect(
			h
				.create()
				.releaseStandardTemplate({ ...command, target: changed }, actor),
		).rejects.toMatchObject({ code: "idempotency_conflict" });
	});
	it.each([
		{ expectedConfigurationRevision: 6 },
		{ expectedImageDigest: `sha256:${"c".repeat(64)}` },
	])("checks the actual persisted baseline %j", async (change) => {
		const h = harness();
		const changed = { ...target, ...change };
		h.authorize.mockResolvedValue({
			...(await h.authorize()),
			target: changed,
		} as StandardTemplateReleaseAuthorizationV1);
		await expect(
			h
				.create()
				.releaseStandardTemplate({ ...command, target: changed }, actor),
		).rejects.toMatchObject({ code: "stale_revision" });
		expect(h.transaction.snapshot().commitCount).toBe(0);
	});
	it.each([
		{ actorId: "owner_01" },
		{ accountStatus: "disabled" },
		{ isAdministrator: false },
		{ intent: "configuration.update" },
		{ target: { ...target, agentId: "other" } },
		{ authorizationRevision: "identity_not_agent_revision" },
	])("rejects mismatched authorization facts %j", async (change) => {
		const h = harness();
		h.authorize.mockResolvedValue({
			...(await h.authorize()),
			...change,
		} as StandardTemplateReleaseAuthorizationV1);
		await expect(
			h.create().releaseStandardTemplate(command, actor),
		).rejects.toMatchObject({
			code: change.authorizationRevision ? "stale_revision" : "not_authorized",
		});
		expect(h.transaction.snapshot().commitCount).toBe(0);
	});
	it.each([
		{ allowedEnvironmentKeys: [] },
		{ allowedSecretKeys: [] },
		{ platformManagedKeys: [] },
		{ connectionEnabled: false },
		{ imageDigest: `sha256:${"c".repeat(64)}` },
	])("rejects admitted source policy or digest drift %j", async (change) => {
		const h = harness();
		h.deps.imageAdmission.admitImage = async (input) => ({
			schemaVersion: 1,
			status: "admitted",
			agentId: input.agentId,
			requestId: input.requestId,
			source: {
				...agentConfigurationConformanceRecordV1.source,
				imageDigest: target.targetImageDigest,
				...change,
			},
		});
		await expect(
			h.create().releaseStandardTemplate(command, actor),
		).rejects.toMatchObject({ code: "not_admitted" });
		expect(h.transaction.snapshot().commitCount).toBe(0);
	});
	it.each(["revoked", "identity_changed", "binding_changed", "agent_changed"])(
		"rejects %s while Registry is pending",
		async (mode) => {
			const h = harness();
			const prior = await h.authorize();
			const original = h.admissions.admitImage.bind(h.admissions);
			h.deps.imageAdmission.admitImage = async (input) => {
				h.setAuthority(
					mode === "revoked"
						? { schemaVersion: 1, status: "rejected" }
						: ({
								...prior,
								[mode === "identity_changed"
									? "identityRevision"
									: mode === "binding_changed"
										? "deploymentRevision"
										: "authorizationRevision"]: "changed",
							} as StandardTemplateReleaseAuthorizationV1),
				);
				return original(input);
			};
			await expect(
				h.create().releaseStandardTemplate(command, actor),
			).rejects.toMatchObject({
				code: mode === "agent_changed" ? "stale_revision" : "not_authorized",
			});
			expect(h.transaction.snapshot().commitCount).toBe(0);
		},
	);
	it("preserves the Owner-only update and rejects caller-selected operation or extra payload", async () => {
		const h = harness();
		await expect(
			h.create().update(
				{
					schemaVersion: 2,
					agentId: target.agentId,
					idempotencyKey: "ordinary",
					requestId: "r",
					traceId: "t",
					changes: {
						source: { kind: "standard", templateId: target.templateId },
					},
				},
				actor,
			),
		).rejects.toMatchObject({ code: "not_authorized" });
		for (const extra of [
			{ actorId: actor.actorId },
			{ changes: { modelConfiguration: {} } },
			{ intent: "standard_template.release_to_agent" },
		])
			await expect(
				h.create().releaseStandardTemplate({ ...command, ...extra }, actor),
			).rejects.toMatchObject({ code: "invalid_command" });
		expect(h.authorize).not.toHaveBeenCalled();
	});
	it("does not accept a deployment intent through ordinary update authority", async () => {
		const h = harness();
		h.deps.authorizationAdmission.authorize = async () =>
			(await h.authorize()) as never;
		await expect(
			h.create().update(
				{
					schemaVersion: 2,
					agentId: target.agentId,
					idempotencyKey: "ordinary",
					requestId: "r",
					traceId: "t",
					changes: { environment: [] },
				},
				actor,
			),
		).rejects.toMatchObject({ code: "dependency_unavailable" });
	});
	it("honors transaction revision CAS", async () => {
		const h = harness();
		h.transaction.failNextCommitAsStale();
		await expect(
			h.create().releaseStandardTemplate(command, actor),
		).rejects.toMatchObject({ code: "stale_revision" });
		expect(h.transaction.snapshot().commitCount).toBe(0);
	});
});
