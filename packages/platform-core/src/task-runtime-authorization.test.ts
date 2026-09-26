import { describe, expect, it, vi } from "vitest";
import type { AgentConfigurationRecordV2 } from "./agent-configuration.js";
import type { AgentManagementStateV1 } from "./agent-management.js";
import type { ConversationDispatchClaimV1 } from "./conversation-dispatch.js";
import type {
	CurrentTaskUserV1,
	TaskAuthorizationBoundaryV1,
} from "./task-authorization.js";
import {
	createTaskRuntimeAuthorizationUseCaseV1,
	isPlatformConversationChannelCurrentV1,
	type LegacyTaskControlRecoveryV1,
	type TaskRuntimeAuthorizationContextV1,
	type TaskRuntimeRecoveryStateV1,
} from "./task-runtime-authorization.js";
import type { WorkloadReconciliationStateV1 } from "./workload-reconciliation.js";

function harness() {
	const claim: ConversationDispatchClaimV1 = {
		schemaVersion: 1,
		itemId: "item",
		leaseOwner: "instance",
		operation: "conversation.turn.submit.v1",
		requestId: "request",
		traceId: "trace",
		agentId: "agent",
		actorId: "user",
		channelId: "web",
		conversationId: "conversation",
		executionId: "execution",
		turnId: "turn",
		messageId: "message",
		stopRequestId: null,
		sessionGeneration: 1,
		deliveryFence: 2,
		executionDeliveryFence: 2,
		authorizationRevision: "agent-7",
		modelConfigurationRevision: 1,
		modelOptionId: "option",
		reasoningLevel: "high",
		hostSessionRef: "host",
		runtimeCursor: null,
		input: { text: "original accepted input", attachments: [] },
		executionStatus: "processing",
		stopPending: false,
	};
	const agent: AgentManagementStateV1 = {
		schemaVersion: 1,
		applicationId: "application",
		agentId: "agent",
		applicantId: "owner",
		status: "available",
		revision: 1,
		approvalRevision: 1,
		decisionReason: null,
		serviceAvailability: "ready",
		desiredState: "running",
		workloadRevision: 1,
		fence: 1,
		ownerIds: ["owner"],
		availability: [{ kind: "organization", organizationId: "team" }],
		failureCode: null,
	};
	const boundary: TaskAuthorizationBoundaryV1 = {
		schemaVersion: 1,
		principal: { kind: "user", id: "user" },
		agentId: "agent",
		channelId: "web",
		identityRevision: "identity-7",
		agentAuthorizationRevision: "agent-7",
		accessSources: [{ kind: "organization", organizationId: "team" }],
	};
	const state: TaskRuntimeRecoveryStateV1 = {
		hostSessionRef: "host",
		runtimeCursor: null,
		originalOperationDigest: "a".repeat(43),
		executionStatus: "processing",
		stopPending: false,
	};
	let user: CurrentTaskUserV1 | null = {
		schemaVersion: 1,
		userId: "user",
		accountStatus: "active",
		organizationIds: ["team"],
		authorizationRevision: "identity-8",
	};
	const configuration = {
		schemaVersion: 2,
		agentId: "agent",
		revision: 1,
		source: { kind: "standard" },
	} as AgentConfigurationRecordV2;
	const workload: WorkloadReconciliationStateV1 = {
		schemaVersion: 1,
		agentId: "agent",
		sourceConfigurationRevision: 1,
		sourceLifecycleRevision: 1,
		revision: 3,
		fence: 1,
		phase: "ready",
		candidate: { configuration, deployment: {} },
		verified: { configuration, deployment: {} },
		verifiedRevision: 3,
		identity: { uid: "pod", generation: 1 },
		rollback: false,
		failureCode: null,
		attempts: 0,
	};
	let record: {
		authorizationRecordId: string;
		executionId: string;
		boundary: TaskAuthorizationBoundaryV1;
		revokedAt: Date | null;
		agent: AgentManagementStateV1;
		configurationRevision: number;
		workload: WorkloadReconciliationStateV1 | null;
	} | null = {
		authorizationRecordId: "original-authorization",
		executionId: "execution",
		boundary,
		revokedAt: null,
		agent,
		configurationRevision: 1,
		workload,
	};

	const ports = {
		workerId: "instance",
		readRuntimeState: vi.fn(async () => state),
		readAuthorization: vi.fn(async () => record),
		resolveCurrentUser: vi.fn(async () => user),
		recordControl: vi.fn(async (input: { reason: string }) => ({
			controlRecordId: `control-${input.reason}`,
		})),
		readLegacyRecovery: vi.fn(
			async (): Promise<LegacyTaskControlRecoveryV1 | null> => null,
		),
	};
	const context: TaskRuntimeAuthorizationContextV1 = {
		kind: "business",
		claim,
		principal: boundary.principal,
		authorizationRecordId: "original-authorization",
	};
	return {
		claim,
		state,
		context,
		ports,
		boundary,
		user,
		record,
		workload,
		agent,
		useCase: createTaskRuntimeAuthorizationUseCaseV1(ports),
		setUser(value: CurrentTaskUserV1 | null) {
			user = value;
		},
		setRecord(value: typeof record) {
			record = value;
		},
	};
}
const signal = () => new AbortController().signal;

describe("task Runtime authorization Core use case", () => {
	it("uses recovery control from the first unknown API task query even when ready", async () => {
		const h = harness();
		Object.assign(h.state, { taskWaitOrder: 1, executionStatus: "unknown" });
		Object.assign(h.claim, { taskWaitOrder: 1, executionStatus: "unknown" });
		expect(await h.useCase.authorizeClaim(h.claim, signal())).toMatchObject({
			outcome: "allowed",
		});
		const state = {
			...h.state,
			taskWaitOrder: 1,
			executionStatus: "unknown" as const,
		};
		for (const command of [
			"session.status",
			"events.persist",
			"events.ack",
		] as const) {
			const result = await h.useCase.current(
				h.context,
				state,
				command,
				signal(),
			);
			expect(result.authority).toEqual({
				purpose: "control",
				reason: "recovery",
				controlRecordId: "control-recovery",
			});
		}
		expect(h.ports.recordControl).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "recovery" }),
			expect.any(AbortSignal),
		);
		for (const unchanged of [
			{
				...h.state,
				taskWaitOrder: undefined,
				executionStatus: "unknown" as const,
			},
			{ ...h.state, taskWaitOrder: 1, executionStatus: "waiting" as const },
		])
			expect(
				(
					await h.useCase.current(
						h.context,
						unchanged,
						"session.status",
						signal(),
					)
				).authority.purpose,
			).toBe("business");
		expect(
			(
				await h.useCase.current(
					h.context,
					{ ...state, executionStatus: "processing" },
					"session.status",
					signal(),
				)
			).authority.purpose,
		).toBe("control");
		expect(
			(
				await h.useCase.current(
					h.context,
					{ ...state, executionStatus: "processing" },
					"events.persist",
					signal(),
				)
			).authority.purpose,
		).toBe("business");
		// Initial dispatch already reserves unknown in Store; it still requires fresh business authority.
		expect(
			(await h.useCase.current(h.context, state, "turn.submit", signal()))
				.authority.purpose,
		).toBe("business");
	});

	it("intersects current organization membership with the original task without copying a new role", async () => {
		const h = harness();
		expect(
			(await h.useCase.current(h.context, h.state, "turn.submit", signal()))
				.authority.purpose,
		).toBe("business");
		h.setUser({ ...h.user, organizationIds: ["new-team"] });
		h.setRecord({
			...h.record,
			agent: {
				...h.agent,
				ownerIds: ["user"],
				availability: [{ kind: "organization", organizationId: "new-team" }],
			},
		});
		const result = await h.useCase.current(
			h.context,
			h.state,
			"turn.submit",
			signal(),
		);
		expect(result.authority).toMatchObject({
			purpose: "control",
			reason: "authorization_revoked",
			controlRecordId: "control-authorization_revoked",
		});
		expect(h.boundary.accessSources).toEqual([
			{ kind: "organization", organizationId: "team" },
		]);
	});
	it("uses already persisted revocation without requiring a current directory response", async () => {
		const h = harness();
		h.setRecord({ ...h.record, revokedAt: new Date(1) });
		h.ports.resolveCurrentUser.mockRejectedValue(
			new Error("directory unavailable"),
		);
		const result = await h.useCase.current(
			h.context,
			h.state,
			"events.persist",
			signal(),
		);
		expect(result.authority).toMatchObject({
			purpose: "control",
			reason: "authorization_revoked",
		});
		expect(h.ports.resolveCurrentUser).not.toHaveBeenCalled();
	});
	it("rechecks the stored boundary after the directory await before allowing business work", async () => {
		const h = harness();
		h.ports.resolveCurrentUser.mockImplementation(async () => {
			h.setRecord({ ...h.record, revokedAt: new Date(1) });
			return h.user;
		});
		const result = await h.useCase.current(
			h.context,
			h.state,
			"turn.submit",
			signal(),
		);
		expect(result.authority).toMatchObject({
			purpose: "control",
			reason: "authorization_revoked",
		});
		expect(h.ports.readAuthorization).toHaveBeenCalledTimes(2);
	});
	it("keeps dependency failure unavailable without inventing revocation", async () => {
		const h = harness();
		h.ports.resolveCurrentUser.mockRejectedValue(
			new Error("directory unavailable"),
		);
		expect(await h.useCase.authorizeClaim(h.claim, signal())).toEqual({
			outcome: "unavailable",
		});
		expect(h.ports.recordControl).not.toHaveBeenCalled();
	});
	it("allows control-only recovery of proven history and rejects its business use", async () => {
		const h = harness();
		h.setRecord(null);
		h.ports.resolveCurrentUser.mockRejectedValue(
			new Error("directory unavailable"),
		);
		h.ports.readLegacyRecovery.mockResolvedValue({
			...h.claim,
			migrationRecordId: "migration",
			originalPrincipal: h.context.principal,
			hostSessionRef: "host",
			originalOperationDigest: h.state.originalOperationDigest,
			deliveryFence: h.claim.executionDeliveryFence,
			configurationRevision: 1,
			workload: h.workload,
		});
		const decision = await h.useCase.authorizeClaim(h.claim, signal());
		expect(decision.outcome).toBe("allowed");
		if (decision.outcome !== "allowed")
			throw new Error("Expected original control authority");
		expect(decision.context.kind).toBe("legacy-control");
		await expect(
			h.useCase.current(decision.context, h.state, "turn.submit", signal()),
		).rejects.toMatchObject({ code: "TASK_AUTHORIZATION_CONTROL_ONLY" });
		expect(h.ports.resolveCurrentUser).not.toHaveBeenCalled();
		expect(h.ports.recordControl).not.toHaveBeenCalled();
	});
	it.each(["actorId", "agentId", "channelId"] as const)(
		"rejects another task %s before resolving its directory",
		async (key) => {
			const h = harness();
			expect(
				await h.useCase.authorizeClaim(
					{ ...h.claim, [key]: "other" },
					signal(),
				),
			).toEqual({ outcome: "denied" });
			expect(h.ports.resolveCurrentUser).not.toHaveBeenCalled();
			expect(h.ports.recordControl).not.toHaveBeenCalled();
		},
	);
	it("rejects a business record with a different authorization revision", async () => {
		const h = harness();
		h.setRecord({
			...h.record,
			boundary: { ...h.boundary, agentAuthorizationRevision: "agent-8" },
		});
		expect(await h.useCase.authorizeClaim(h.claim, signal())).toEqual({
			outcome: "denied",
		});
		expect(h.ports.resolveCurrentUser).not.toHaveBeenCalled();
	});
});

describe("terminal task event recovery authority", () => {
	it.each(["healthy", "revoked", "directory-unavailable"])(
		"permits only original queries and ACK for %s terminal history",
		async (condition) => {
			const h = harness();
			Object.assign(h.state, { executionStatus: "completed" });
			if (condition === "revoked") {
				if (!h.record) throw new Error("Missing record");
				h.setRecord({ ...h.record, revokedAt: new Date(1) });
			}
			if (condition === "directory-unavailable")
				h.ports.resolveCurrentUser.mockRejectedValue(
					new Error("directory unavailable"),
				);
			const decision = await h.useCase.authorizeClaim(
				{ ...h.claim, executionStatus: "completed" },
				signal(),
			);
			expect(decision.outcome).toBe("allowed");
			if (decision.outcome !== "allowed")
				throw new Error("Expected original recovery");
			for (const command of [
				"session.status",
				"events.persist",
				"events.ack",
			] as const)
				expect(
					(
						await h.useCase.current(
							decision.context,
							h.state,
							command,
							signal(),
						)
					).authority,
				).toMatchObject({ purpose: "control", reason: "recovery" });
			for (const command of ["turn.submit", "execution.renew"] as const)
				await expect(
					h.useCase.current(decision.context, h.state, command, signal()),
				).rejects.toMatchObject({ code: "TASK_AUTHORIZATION_CONTROL_ONLY" });
			expect(h.ports.resolveCurrentUser).not.toHaveBeenCalled();
		},
	);
});

describe("explicit historical metadata recovery authority", () => {
	it("archives a stopped, revoked terminal task without its old user or business permissions", async () => {
		const h = harness();
		const marker = {
			id: "history-pass",
			requestedAt: 1_800_000_000_000,
			originalStatus: "failed" as const,
		};
		const claim = {
			...h.claim,
			executionStatus: "failed" as const,
			runtimeCursor: "terminal",
			stopPending: true,
			metadataRecovery: marker,
		};
		Object.assign(h.state, {
			executionStatus: "failed",
			runtimeCursor: "terminal",
			stopPending: true,
			metadataRecovery: marker,
		});
		h.setUser(null);
		Object.assign(h.record, { revokedAt: new Date() });
		Object.assign(h.agent, { desiredState: "stopped" });
		const decision = await h.useCase.authorizeClaim(claim, signal());
		expect(decision.outcome).toBe("allowed");
		if (decision.outcome !== "allowed")
			throw new Error("metadata claim denied");
		for (const command of [
			"session.status",
			"events.persist",
			"events.ack",
		] as const) {
			expect(
				(await h.useCase.current(decision.context, h.state, command, signal()))
					.authority,
			).toMatchObject({ purpose: "control", reason: "recovery" });
		}
		for (const command of [
			"turn.submit",
			"turn.supplement",
			"turn.stop",
			"execution.renew",
			"generation.cancel",
		] as const) {
			await expect(
				h.useCase.current(decision.context, h.state, command, signal()),
			).rejects.toMatchObject({ code: "TASK_AUTHORIZATION_CONTROL_ONLY" });
		}
		expect(h.ports.resolveCurrentUser).not.toHaveBeenCalled();
		Object.assign(h.state, { metadataRecovery: { ...marker, id: "new-pass" } });
		await expect(
			h.useCase.readRuntimeState(decision.context, signal()),
		).rejects.toMatchObject({ code: "RUNTIME_FENCE_STALE" });
	});
});

it("channel revocation persists shared system control instead of dropping a running task", async () => {
	const h = harness();
	const channelAuthorizationCurrent = vi.fn(async () => false);
	const useCase = createTaskRuntimeAuthorizationUseCaseV1({
		...h.ports,
		channelAuthorizationCurrent,
	});
	const result = await useCase.current(
		h.context,
		h.state,
		"execution.renew",
		signal(),
	);
	expect(result.authority).toMatchObject({
		purpose: "control",
		reason: "authorization_revoked",
	});
	expect(h.ports.recordControl).toHaveBeenCalledWith(
		expect.objectContaining({
			executionId: h.claim.executionId,
			reason: "authorization_revoked",
		}),
		expect.any(AbortSignal),
	);
});

it.each([
	["standard", 1, "business"],
	["standard", null, "unavailable"],
	["standard", 2, "unavailable"],
	["custom", null, "business"],
	["custom", 1, "unavailable"],
	["unknown", null, "unavailable"],
] as const)(
	"requires %s task model revision %s",
	async (kind, revision, expected) => {
		const h = harness();
		Object.assign(h.workload.candidate.configuration, { source: { kind } });
		Object.assign(h.claim, { modelConfigurationRevision: revision });
		if (expected === "business")
			expect(
				(await h.useCase.current(h.context, h.state, "turn.submit", signal()))
					.authority.purpose,
			).toBe("business");
		else
			await expect(
				h.useCase.current(h.context, h.state, "turn.submit", signal()),
			).rejects.toMatchObject({ code: "RUNTIME_WORKLOAD_UNAVAILABLE" });
	},
);

it("keeps original custom execution controls during an unverified platform adapter upgrade", async () => {
	const h = harness();
	Object.assign(h.claim, { modelConfigurationRevision: null });
	const configuration = {
		...h.workload.candidate.configuration,
		source: {
			kind: "custom",
			interactionMode: "platform-adapter",
			imageDigest: "previous",
		},
	} as AgentConfigurationRecordV2;
	const workload = {
		...h.workload,
		phase: "observing" as const,
		sourceConfigurationRevision: 2,
		candidate: {
			...h.workload.candidate,
			configuration: {
				...configuration,
				revision: 2,
				source: { ...configuration.source, imageDigest: "candidate" },
			},
		},
		verified: { ...h.workload.candidate, configuration },
		capabilities: { supplementaryInstruction: true },
	};
	if (!h.record) throw Error();
	h.setRecord({ ...h.record, configurationRevision: 2, workload });
	const useCase = createTaskRuntimeAuthorizationUseCaseV1({
		...h.ports,
		channelAuthorizationCurrent: async (record) =>
			isPlatformConversationChannelCurrentV1(record),
	});
	for (const command of [
		"turn.stop",
		"session.status",
		"events.persist",
	] as const) {
		const result = await useCase.current(h.context, h.state, command, signal());
		expect(result.authority).toMatchObject({
			purpose: "control",
			reason: command === "turn.stop" ? "stop" : "recovery",
		});
	}
	await expect(
		useCase.current(h.context, h.state, "turn.submit", signal()),
	).rejects.toMatchObject({ code: "RUNTIME_WORKLOAD_UNAVAILABLE" });
	expect(
		h.ports.recordControl.mock.calls.every(
			([call]) => call.reason !== "authorization_revoked",
		),
	).toBe(true);
});
