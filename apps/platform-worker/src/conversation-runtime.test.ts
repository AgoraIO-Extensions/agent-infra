import { generateKeyPairSync } from "node:crypto";
import { createRuntimeExecutionGrantVerifierV2 } from "@agent-infra/agent-runtime";
import type {
	AgentConfigurationRecordV2,
	AgentManagementStateV1,
	ConversationDispatchClaimV1,
	ConversationDispatchStorePortV1,
	CurrentTaskUserV1,
	TaskAuthorizationBoundaryV1,
	WorkloadReconciliationStateV1,
} from "@agent-infra/platform-core";
import { describe, expect, it, vi } from "vitest";
import { createConversationDispatchUseCaseV1 } from "../../../packages/platform-core/src/conversation-dispatch.js";
import {
	type ConversationLegacyControlRecoveryV2,
	type ConversationRuntimeOptionsV2,
	type ConversationRuntimeStateV2,
	createConversationRuntimeV2,
} from "./conversation-runtime.js";

const keys = generateKeyPairSync("ed25519");
const verify = createRuntimeExecutionGrantVerifierV2(
	new Map([["signing", keys.publicKey]]),
);
const now = 1_800_000_000_000;
function harness(
	reconnectDelayMs = 1,
	channelAuthorizationCurrent:
		| ConversationRuntimeOptionsV2["channelAuthorizationCurrent"]
		| null = async (record) => record.boundary.channelId === "web",
) {
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
	const state: ConversationRuntimeStateV2 = {
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
	const directory = { resolveUser: vi.fn(async () => user) };
	const store = {
		readRuntimeState: vi.fn(
			async () => state as ConversationRuntimeStateV2 | null,
		),
	};
	const authorizationStore = {
		readExecution: vi.fn(async () => record),
		recordControl: vi.fn(async (input: { reason: string }) => {
			if (input.reason === "authorization_revoked" && record) {
				record.revokedAt = new Date(now);
				Object.assign(state, { stopPending: true });
			}
			return { controlRecordId: `control-${input.reason}` };
		}),
	};
	let legacyRecord: ConversationLegacyControlRecoveryV2 | null = null;
	const legacyStore = {
		readLegacyControlRecovery: vi.fn(async () => legacyRecord),
	};
	function useLegacy() {
		record = null;
		legacyRecord = {
			migrationRecordId: "verified-migration",
			originalPrincipal: { kind: "user", id: "user" },
			agentId: claim.agentId,
			channelId: claim.channelId,
			conversationId: claim.conversationId,
			executionId: claim.executionId,
			turnId: claim.turnId,
			sessionGeneration: claim.sessionGeneration,
			hostSessionRef: "host",
			originalOperationDigest: state.originalOperationDigest,
			runtimeCursor: state.runtimeCursor,
			executionStatus: state.executionStatus,
			deliveryFence: claim.executionDeliveryFence,
			configurationRevision: 1,
			workload,
		};
		return legacyRecord;
	}
	const fetcher = vi.fn<typeof fetch>(async (url) => {
		const path = String(url);
		if (path.endsWith("/status"))
			return new Response(
				JSON.stringify({
					schemaVersion: 3,
					outcome: "found",
					hostSessionRef: "host",
					executionId: "execution",
					status: "running",
				}),
			);
		if (path.endsWith("/events/ack"))
			return new Response(
				JSON.stringify({
					schemaVersion: 3,
					executionId: "execution",
					confirmedCursor: state.runtimeCursor,
				}),
			);
		if (path.endsWith("/authorizations/renew"))
			return new Response(
				JSON.stringify({
					schemaVersion: 3,
					executionId: "execution",
					expiresAt: now + 30_000,
				}),
			);
		if (
			path.endsWith("/turns") ||
			path.endsWith("/instructions") ||
			path.endsWith("/stops") ||
			path.endsWith("/generations/cancel")
		)
			return new Response(
				JSON.stringify({
					schemaVersion: 3,
					hostSessionRef: "host",
					operationId: "execution",
					result: { outcome: "accepted", status: "running" },
				}),
			);
		if (path.endsWith("/events/stream"))
			return new Response(null, {
				headers: { "content-type": "text/event-stream" },
			});
		throw new Error(`Unexpected runtime request: ${path}`);
	});
	const resolver = vi.fn(async () => ({
		baseUrl: "http://runtime.test",
		serviceToken: "synthetic-transport-proof",
		workerId: "transport",
	}));
	const runtime = createConversationRuntimeV2({
		...(channelAuthorizationCurrent ? { channelAuthorizationCurrent } : {}),
		workerId: "instance",
		signing: {
			issuer: "platform",
			workerId: "transport",
			keyId: "signing",
			privateKey: keys.privateKey,
			now: () => now,
		},
		directory,
		taskAuthorizationStore: authorizationStore,
		legacyControlStore: legacyStore,
		dispatchStore: store,
		resolveRuntimeHost: resolver,
		fetch: fetcher,
		reconnectDelayMs,
	});
	async function authorize() {
		const decision = await runtime.authorization.authorize({ ...claim, claim });
		if (decision.outcome !== "allowed")
			throw new Error(`unexpected ${decision.outcome}`);
		return decision.authority.runtimeGrant;
	}
	const events = (runtimeGrant: unknown) => ({
		schemaVersion: 1 as const,
		requestId: claim.requestId,
		traceId: claim.traceId,
		agentId: claim.agentId,
		actorId: claim.actorId,
		channelId: claim.channelId,
		conversationId: claim.conversationId,
		executionId: claim.executionId,
		turnId: claim.turnId,
		sessionGeneration: claim.sessionGeneration,
		deliveryFence: claim.executionDeliveryFence,
		hostSessionRef: "host",
		runtimeGrant,
	});
	const request = (runtimeGrant: unknown) => ({
		...events(runtimeGrant),
		operation: "turn.submit" as const,
		input: { text: "caller input", attachments: [] },
		selection: {
			schemaVersion: 1 as const,
			modelOptionId: "caller-option",
			reasoningLevel: "low",
		},
	});
	function sent() {
		const call = fetcher.mock.calls[0];
		if (!call) throw new Error("no runtime call");
		const body = JSON.parse(call[1]?.body as string);
		return { url: String(call[0]), body, claims: verify(body.grant).claims };
	}
	return {
		runtime,
		claim,
		state,
		legacyStore,
		useLegacy,
		setLegacy: (value: ConversationLegacyControlRecoveryV2 | null) => {
			legacyRecord = value;
		},
		directory,
		store,
		authorizationStore,
		resolver,
		fetcher,
		authorize,
		request,
		events,
		sent,
		setUser: (value: CurrentTaskUserV1 | null) => {
			user = value;
		},
		setRecord: (value: typeof record) => {
			record = value;
		},
		record: () => record,
	};
}

describe("Trusted conversation Runtime adapter", () => {
	it.each(["web", "partner:channel", "wecom_bot:bot", "wecom_app:app"])(
		"does not authorize %s without a current channel authority",
		async (channelId) => {
			const h = harness(1, null);
			const record = h.record();
			if (!record) throw new Error("missing authorization");
			Object.assign(h.claim, { channelId });
			Object.assign(record.boundary, { channelId });
			expect(
				await h.runtime.authorization.authorize({ ...h.claim, claim: h.claim }),
			).toEqual({ outcome: "unavailable" });
			expect(h.authorizationStore.recordControl).not.toHaveBeenCalled();
			expect(h.record()?.revokedAt).toBeNull();
			expect(h.fetcher).not.toHaveBeenCalled();
			h.runtime.close();
		},
	);
	it("rechecks configured channel authority before issuing a business Grant", async () => {
		let current = true;
		const channelAuthorizationCurrent = vi.fn(async () => current);
		const h = harness(1, channelAuthorizationCurrent);
		const record = h.record();
		if (!record) throw new Error("missing authorization");
		Object.assign(h.claim, { channelId: "partner:channel" });
		Object.assign(record.boundary, { channelId: "partner:channel" });
		const reference = await h.authorize();
		expect(channelAuthorizationCurrent).toHaveBeenCalled();
		current = false;
		await expect(
			h.runtime.runtimeHost.dispatch(h.request(reference)),
		).rejects.toMatchObject({ code: "AUTHORIZATION_REVOKED" });
		expect(
			h.fetcher.mock.calls.some(([url]) => String(url).endsWith("/turns")),
		).toBe(false);
		expect(h.sent().claims).toMatchObject({
			purpose: "control",
			reason: "authorization_revoked",
		});
		h.runtime.close();
	});
	it("recovers principal-only history using migration control with no current identity or new boundary", async () => {
		const h = harness();
		const original = h.useLegacy();
		h.directory.resolveUser.mockRejectedValue(
			new Error("directory unavailable"),
		);
		const decision = await h.runtime.authorization.authorize({
			...h.claim,
			claim: h.claim,
		});
		expect(decision).toMatchObject({
			outcome: "allowed",
			authority: { actorId: "user", controlOnly: true },
		});
		if (decision.outcome !== "allowed")
			throw new Error("missing legacy context");
		const reference = decision.authority.runtimeGrant;
		await h.runtime.runtimeHost.recoverOriginalStatus?.({
			...h.events(reference),
			schemaVersion: 2,
			hostSessionRef: "host",
		});
		expect(h.sent().claims).toMatchObject({
			principal: { kind: "user", id: "user" },
			purpose: "control",
			controlRecordId: "verified-migration",
			reason: "recovery",
			allowedCommands: ["session.status"],
		});
		expect(h.sent().claims).not.toHaveProperty("authorizationRecordId");
		expect(h.sent().body).not.toHaveProperty("input");
		expect(h.sent().body).not.toHaveProperty("recovery");
		Object.assign(h.state, { runtimeCursor: "committed" });
		h.setLegacy({ ...original, runtimeCursor: "committed" });
		await h.runtime.runtimeHost.acknowledge?.({
			...h.events(reference),
			confirmedCursor: "committed",
		});
		expect(
			verify(JSON.parse(h.fetcher.mock.calls[1]?.[1]?.body as string).grant)
				.claims,
		).toMatchObject({
			purpose: "control",
			controlRecordId: "verified-migration",
			allowedCommands: ["events.ack"],
		});
		expect(h.directory.resolveUser).not.toHaveBeenCalled();
		expect(h.authorizationStore.recordControl).not.toHaveBeenCalled();
		expect(h.record()).toBeNull();
		h.runtime.close();
	});
	it("never upgrades a principal-only context to business after current roles or a boundary change", async () => {
		const h = harness();
		const currentRecord = h.record();
		h.useLegacy();
		const reference = await h.authorize();
		h.setRecord(currentRecord);
		await expect(
			h.runtime.runtimeHost.dispatch(h.request(reference)),
		).rejects.toMatchObject({ code: "TASK_AUTHORIZATION_CONTROL_ONLY" });
		await expect(
			h.runtime.runtimeHost.renewAuthorization?.(h.events(reference)),
		).rejects.toMatchObject({ code: "TASK_AUTHORIZATION_CONTROL_ONLY" });
		expect(h.directory.resolveUser).not.toHaveBeenCalled();
		expect(h.fetcher).not.toHaveBeenCalled();
		expect(h.authorizationStore.recordControl).not.toHaveBeenCalled();
		h.runtime.close();
	});
	it("does not dispatch principal-only submitted work or supplementary instructions", async () => {
		const h = harness();
		const original = h.useLegacy();
		Object.assign(h.state, { executionStatus: "submitted" });
		h.setLegacy({ ...original, executionStatus: "submitted" });
		expect(
			(await h.runtime.authorization.authorize({ ...h.claim, claim: h.claim }))
				.outcome,
		).toBe("unavailable");
		Object.assign(h.claim, { operation: "conversation.turn.supplement.v1" });
		expect(
			(await h.runtime.authorization.authorize({ ...h.claim, claim: h.claim }))
				.outcome,
		).toBe("denied");
		expect(h.directory.resolveUser).not.toHaveBeenCalled();
		expect(h.fetcher).not.toHaveBeenCalled();
		h.runtime.close();
	});
	it("uses only original persisted stop control for principal-only history", async () => {
		const h = harness();
		Object.assign(h.claim, {
			operation: "conversation.turn.stop.v1",
			stopRequestId: "original-stop",
			deliveryFence: 3,
		});
		Object.assign(h.state, { stopPending: true });
		h.useLegacy();
		const reference = await h.authorize();
		await h.runtime.runtimeHost.dispatch({
			...h.events(reference),
			operation: "turn.stop",
			stopRequestId: "original-stop",
			deliveryFence: 3,
			executionDeliveryFence: 2,
		});
		expect(h.sent().claims).toMatchObject({
			purpose: "control",
			controlRecordId: "verified-migration",
			reason: "recovery",
			operation: {
				kind: "stop",
				id: "original-stop",
				deliveryFence: 3,
				executionDeliveryFence: 2,
			},
		});
		expect(h.directory.resolveUser).not.toHaveBeenCalled();
		expect(h.authorizationStore.recordControl).not.toHaveBeenCalled();
		h.runtime.close();
	});
	it.each([
		"principal",
		"application",
		"agentId",
		"channelId",
		"conversationId",
		"executionId",
		"turnId",
		"sessionGeneration",
		"hostSessionRef",
		"originalOperationDigest",
		"deliveryFence",
	])(
		"rejects a legacy %s mismatch without reading current roles",
		async (field) => {
			const h = harness();
			const original = h.useLegacy();
			const changed =
				field === "principal"
					? { originalPrincipal: { kind: "user", id: "other" } }
					: field === "application"
						? { originalPrincipal: { kind: "application", id: "user" } }
						: {
								[field]:
									field === "sessionGeneration" || field === "deliveryFence"
										? 99
										: field === "originalOperationDigest"
											? "b".repeat(43)
											: "other",
							};
			h.setLegacy({
				...original,
				...changed,
			} as ConversationLegacyControlRecoveryV2);
			expect(
				(
					await h.runtime.authorization.authorize({
						...h.claim,
						claim: h.claim,
					})
				).outcome,
			).toBe("denied");
			expect(h.directory.resolveUser).not.toHaveBeenCalled();
			expect(h.fetcher).not.toHaveBeenCalled();
			h.runtime.close();
		},
	);
	it("fails closed when migration evidence disappears or is replaced before a control send", async () => {
		const h = harness();
		const original = h.useLegacy();
		const reference = await h.authorize();
		h.setLegacy(null);
		await expect(
			h.runtime.runtimeHost.recoverOriginalStatus?.({
				...h.events(reference),
				schemaVersion: 2,
			}),
		).rejects.toMatchObject({
			code: "TASK_AUTHORIZATION_PROVENANCE_UNAVAILABLE",
		});
		h.setLegacy({ ...original, migrationRecordId: "different-migration" });
		await expect(
			h.runtime.runtimeHost.recoverOriginalStatus?.({
				...h.events(reference),
				schemaVersion: 2,
			}),
		).rejects.toMatchObject({ code: "TASK_AUTHORIZATION_BINDING_INVALID" });
		expect(h.fetcher).not.toHaveBeenCalled();
		expect(h.directory.resolveUser).not.toHaveBeenCalled();
		h.runtime.close();
	});
	it.each([
		"missing",
		"phase",
		"configuration",
		"lifecycle",
		"fence",
		"readiness",
	])("does not dispatch or renew a stale %s workload", async (change) => {
		const h = harness();
		const context = await h.authorize();
		const record = h.record();
		if (!record?.workload) throw new Error("missing fixture");
		h.setRecord({
			...record,
			...(change === "readiness"
				? { agent: { ...record.agent, serviceAvailability: "updating" } }
				: {}),
			workload:
				change === "missing"
					? null
					: {
							...record.workload,
							...(change === "phase" ? { phase: "observing" } : {}),
							...(change === "configuration"
								? { sourceConfigurationRevision: 2 }
								: {}),
							...(change === "lifecycle" ? { sourceLifecycleRevision: 2 } : {}),
							...(change === "fence" ? { fence: 2 } : {}),
						},
		});
		await expect(
			h.runtime.runtimeHost.dispatch(h.request(context)),
		).rejects.toMatchObject({ code: "RUNTIME_WORKLOAD_UNAVAILABLE" });
		await expect(
			h.runtime.runtimeHost.renewAuthorization?.(h.events(context)),
		).rejects.toMatchObject({ code: "RUNTIME_WORKLOAD_UNAVAILABLE" });
		expect(h.fetcher).not.toHaveBeenCalled();
		expect(h.authorizationStore.recordControl).not.toHaveBeenCalled();
		h.runtime.close();
	});
	it("rechecks workload authority after deployment route resolution", async () => {
		const h = harness();
		const context = await h.authorize();
		h.resolver.mockImplementation(async () => {
			const record = h.record();
			if (!record) throw new Error("missing fixture");
			h.setRecord({ ...record, configurationRevision: 2 });
			return {
				baseUrl: "http://runtime.test",
				serviceToken: "synthetic",
				workerId: "transport",
			};
		});
		await expect(
			h.runtime.runtimeHost.dispatch(h.request(context)),
		).rejects.toMatchObject({ code: "RUNTIME_WORKLOAD_UNAVAILABLE" });
		expect(h.fetcher).not.toHaveBeenCalled();
		h.runtime.close();
	});
	it("uses recovery control to confirm committed events across configuration drift", async () => {
		const h = harness();
		const context = await h.authorize();
		const record = h.record();
		if (!record) throw new Error("missing fixture");
		h.setRecord({ ...record, configurationRevision: 2 });
		Object.assign(h.state, { runtimeCursor: "committed" });
		await h.runtime.runtimeHost.acknowledge?.({
			...h.events(context),
			confirmedCursor: "committed",
		});
		expect(h.sent().claims).toMatchObject({
			purpose: "control",
			reason: "recovery",
			allowedCommands: ["events.ack"],
		});
		expect(h.record()?.revokedAt).toBeNull();
		expect(h.sent().body).not.toHaveProperty("input");
		h.runtime.close();
	});
	it("recovers terminal history with original signed fences and cursor without business authority", async () => {
		const h = harness();
		Object.assign(h.claim, {
			deliveryFence: 7,
			executionStatus: "completed",
			runtimeCursor: "committed",
			runtimeTerminalEventSeen: true,
		});
		Object.assign(h.state, {
			executionStatus: "completed",
			runtimeCursor: "committed",
		});
		const record = h.record();
		if (!record) throw new Error("missing fixture");
		h.setRecord({ ...record, revokedAt: new Date(now), workload: null });
		h.directory.resolveUser.mockRejectedValue(
			new Error("directory unavailable"),
		);
		const context = await h.authorize();
		h.fetcher.mockImplementation(async (url) =>
			String(url).endsWith("/events/ack")
				? new Response(
						JSON.stringify({
							schemaVersion: 3,
							executionId: "execution",
							confirmedCursor: "committed",
						}),
					)
				: new Response("", {
						headers: { "content-type": "text/event-stream" },
					}),
		);
		const stream = h.runtime.runtimeHost
			.events({ ...h.events(context), afterCursor: "caller-cursor" })
			[Symbol.asyncIterator]();
		expect((await stream.next()).done).toBe(true);
		await h.runtime.runtimeHost.acknowledge?.({
			...h.events(context),
			confirmedCursor: "committed",
		});
		const sent = h.fetcher.mock.calls.map((call) => {
			const body = JSON.parse(call[1]?.body as string);
			return { body, claims: verify(body.grant).claims };
		});
		expect(sent).toHaveLength(2);
		for (const { body, claims } of sent) {
			expect(claims).toMatchObject({
				purpose: "control",
				reason: "recovery",
				principal: { kind: "user", id: "user" },
				agentId: "agent",
				conversationId: "conversation",
				executionId: "execution",
				turnId: "turn",
				sessionGeneration: 1,
				hostSessionRef: "host",
				operation: {
					kind: "execution",
					id: "execution",
					deliveryFence: 2,
					executionDeliveryFence: 2,
				},
			});
			expect(body).not.toHaveProperty("input");
		}
		expect(sent[0]?.claims).toMatchObject({
			allowedCommands: ["events.persist"],
			eventAccess: { command: "events.persist", afterCursor: "committed" },
		});
		expect(sent[1]?.claims).toMatchObject({
			allowedCommands: ["events.ack"],
			eventAccess: { command: "events.ack", confirmedCursor: "committed" },
		});
		expect(sent[0]?.claims.grantId).not.toBe(sent[1]?.claims.grantId);
		await expect(
			h.runtime.runtimeHost.dispatch({
				...h.request(context),
				deliveryFence: h.claim.deliveryFence,
				executionDeliveryFence: h.claim.executionDeliveryFence,
			}),
		).rejects.toMatchObject({ code: "TASK_AUTHORIZATION_CONTROL_ONLY" });
		await expect(
			h.runtime.runtimeHost.renewAuthorization?.(h.events(context)),
		).rejects.toMatchObject({ code: "TASK_AUTHORIZATION_CONTROL_ONLY" });
		expect(h.fetcher).toHaveBeenCalledTimes(2);
		expect(h.directory.resolveUser).not.toHaveBeenCalled();
		h.runtime.close();
	});
	it("does not send control after its database lease is lost during persistence", async () => {
		const h = harness();
		const context = await h.authorize();
		Object.assign(h.state, { stopPending: true });
		h.authorizationStore.recordControl.mockImplementation(async () => {
			h.store.readRuntimeState.mockResolvedValue(null);
			return { controlRecordId: "control-stop" };
		});
		await expect(
			h.runtime.runtimeHost.recoverOriginalStatus?.({
				...h.events(context),
				schemaVersion: 2,
				hostSessionRef: null,
			}),
		).rejects.toMatchObject({ code: "RUNTIME_FENCE_STALE" });
		expect(h.fetcher).not.toHaveBeenCalled();
		h.runtime.close();
	});
	it("recovers a persisted stop without replaying an absent execution or requiring readiness", async () => {
		const h = harness();
		Object.assign(h.state, { hostSessionRef: null, stopPending: true });
		const record = h.record();
		if (!record) throw new Error("missing fixture");
		h.setRecord({ ...record, workload: null });
		const context = await h.authorize();
		h.fetcher.mockResolvedValue(
			new Response(
				JSON.stringify({
					schemaVersion: 3,
					outcome: "not_found",
					hostSessionRef: null,
					executionId: "execution",
				}),
			),
		);
		await expect(
			h.runtime.runtimeHost.recoverOriginalStatus?.({
				...h.events(context),
				schemaVersion: 2,
				hostSessionRef: null,
			}),
		).resolves.toEqual({
			schemaVersion: 2,
			outcome: "not_found",
			hostSessionRef: null,
			executionId: "execution",
		});
		expect(h.sent().claims).toMatchObject({
			purpose: "control",
			reason: "stop",
		});
		expect(h.sent().body).not.toHaveProperty("input");
		h.runtime.close();
	});
	it.each([
		"error",
		"eof",
		"grant-denied-terminal",
		"grant-denied-pending",
	] as const)(
		"recovers the original event cursor immediately after concurrent stop closes the business stream with %s",
		async (ending) => {
			vi.useFakeTimers();
			const timers = vi.spyOn(globalThis, "setTimeout");
			const h = harness(1_000);
			try {
				h.store.readRuntimeState.mockImplementation(async () =>
					structuredClone(h.state),
				);
				const grantDenied = ending.startsWith("grant-denied");
				if (grantDenied) Object.assign(h.state, { runtimeCursor: "started" });
				const context = await h.authorize();
				const started = {
					schemaVersion: 2,
					adapterEventKey: "model-started",
					cursor: "started",
					executionId: "execution",
					occurredAt: "2026-09-14T12:00:00Z",
					type: "operation",
					payload: {
						kind: "model",
						phase: "started",
						operationRef: "original-model",
						attemptRef: "original-attempt",
						model: {
							configVersion: "config-1",
							modelOptionId: "option",
							modelId: "model",
						},
					},
				};
				const interrupted = {
					...started,
					adapterEventKey: "model-interrupted",
					cursor: "interrupted",
					payload: { ...started.payload, phase: "unknown" },
				};
				const terminal = {
					schemaVersion: 1,
					adapterEventKey: "cancelled",
					cursor: "cancelled",
					executionId: "execution",
					occurredAt: "2026-09-14T12:00:01Z",
					type: "completed",
					payload: { status: "cancelled" },
				};
				const frame = (event: typeof started | typeof terminal) =>
					`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
				let oldPipe: ReadableStreamDefaultController<Uint8Array> | undefined;
				let eventRequests = 0;
				h.fetcher.mockImplementation(async (url, init) => {
					if (String(url).endsWith("/events/ack")) {
						const body = JSON.parse(init?.body as string);
						return new Response(
							JSON.stringify({
								schemaVersion: 3,
								executionId: "execution",
								confirmedCursor: body.confirmedCursor,
							}),
						);
					}
					if (!String(url).endsWith("/events/stream"))
						throw new Error("Recovery must not submit another Turn");
					eventRequests += 1;
					if (eventRequests === 1 && grantDenied) {
						Object.assign(h.state, {
							executionStatus:
								ending === "grant-denied-pending" ? "processing" : "cancelled",
							stopPending: ending === "grant-denied-pending",
						});
						return new Response(
							JSON.stringify({
								schemaVersion: 1,
								code: "RUNTIME_GRANT_INVALID",
								message: "Runtime Grant rejected",
								retryable: false,
								traceId: "trace",
							}),
							{ status: 403 },
						);
					}
					return new Response(
						eventRequests === 1
							? new ReadableStream<Uint8Array>({
									start(controller) {
										oldPipe = controller;
										controller.enqueue(
											new TextEncoder().encode(frame(started)),
										);
									},
								})
							: frame(interrupted) + frame(terminal),
						{ headers: { "content-type": "text/event-stream" } },
					);
				});
				const stream = h.runtime.runtimeHost
					.events(h.events(context))
					[Symbol.asyncIterator]();
				if (!grantDenied) {
					expect((await stream.next()).value).toEqual(started);
					Object.assign(h.state, {
						runtimeCursor: "started",
						executionStatus: "cancelled",
						stopPending: false,
					});
					if (!oldPipe) throw new Error("Expected the business event stream");
					if (ending === "error")
						oldPipe.error(new Error("old business grant stream closed"));
					else oldPipe.close();
				}
				const next = stream.next().then(
					(value) => ({ value }),
					(error: unknown) => ({ error }),
				);
				await vi.runAllTimersAsync();
				expect(await next).toEqual({
					value: { done: false, value: interrupted },
				});
				expect(timers.mock.calls.some((call) => call[1] === 1_000)).toBe(false);
				await h.runtime.runtimeHost.acknowledge?.({
					...h.events(context),
					confirmedCursor: "interrupted",
				});
				expect(h.fetcher).toHaveBeenCalledTimes(2);
				Object.assign(h.state, { runtimeCursor: "interrupted" });
				await h.runtime.runtimeHost.acknowledge?.({
					...h.events(context),
					confirmedCursor: "interrupted",
				});
				expect((await stream.next()).value).toEqual(terminal);
				Object.assign(h.state, {
					runtimeCursor: "cancelled",
					executionStatus: "cancelled",
					stopPending: false,
				});
				await h.runtime.runtimeHost.acknowledge?.({
					...h.events(context),
					confirmedCursor: "cancelled",
				});
				expect((await stream.next()).done).toBe(true);
				const bodies = h.fetcher.mock.calls.map((call) =>
					JSON.parse(call[1]?.body as string),
				);
				expect(
					bodies.map(
						(body) => body.afterCursor ?? body.confirmedCursor ?? null,
					),
				).toEqual([
					grantDenied ? "started" : null,
					"started",
					"interrupted",
					"cancelled",
				]);
				expect(verify(bodies[0].grant).claims.purpose).toBe("business");
				for (const body of bodies.slice(1)) {
					const reason =
						ending === "grant-denied-pending" &&
						body.confirmedCursor !== "cancelled"
							? "stop"
							: "recovery";
					expect(verify(body.grant).claims).toMatchObject({
						purpose: "control",
						reason,
						controlRecordId: `control-${reason}`,
						executionId: "execution",
						turnId: "turn",
						sessionGeneration: 1,
					});
					expect(body.operation.executionDeliveryFence).toBe(2);
				}
				expect(
					new Set(bodies.map((body) => verify(body.grant).claims.grantId)).size,
				).toBe(4);
			} finally {
				h.runtime.close();
				timers.mockRestore();
				vi.useRealTimers();
			}
		},
	);

	it.each([
		["RUNTIME_GRANT_INVALID", "none", 1],
		["RUNTIME_SERVICE_UNAUTHORIZED", "concurrent", 1],
		["RUNTIME_GRANT_INVALID", "existing", 1],
		["RUNTIME_GRANT_INVALID", "concurrent", 2],
	] as const)(
		"rejects fatal %s with %s stop after %i event requests",
		async (code, stop, expectedRequests) => {
			const h = harness();
			try {
				h.store.readRuntimeState.mockImplementation(async () =>
					structuredClone(h.state),
				);
				if (stop === "existing") Object.assign(h.state, { stopPending: true });
				const context = await h.authorize();
				h.fetcher.mockImplementation(async () => {
					if (stop === "concurrent")
						Object.assign(h.state, { stopPending: true });
					if (h.fetcher.mock.calls.length > expectedRequests)
						throw new Error("Fatal stream must not be retried");
					return new Response(
						JSON.stringify({
							schemaVersion: 1,
							code,
							message: "Runtime request rejected",
							retryable: false,
							traceId: "trace",
						}),
						{ status: 403 },
					);
				});
				const stream = h.runtime.runtimeHost.events(h.events(context));
				await expect(
					stream[Symbol.asyncIterator]().next(),
				).rejects.toMatchObject({
					code,
					retryable: false,
				});
				expect(h.fetcher).toHaveBeenCalledTimes(expectedRequests);
				const purposes = h.fetcher.mock.calls.map((call) => {
					const body = JSON.parse(call[1]?.body as string);
					return verify(body.grant).claims.purpose;
				});
				expect(purposes).toEqual(
					expectedRequests === 2
						? ["business", "control"]
						: [stop === "existing" ? "control" : "business"],
				);
			} finally {
				h.runtime.close();
			}
		},
	);

	it.each([
		["cancelled", "stream"],
		["pending", "stream"],
		["cancelled", "ack"],
		["pending", "ack"],
		["cancelled", "lost lease"],
	] as const)(
		"releases an owned %s control drain interrupted by the heartbeat during %s",
		async (stop, pause) => {
			vi.useFakeTimers();
			vi.setSystemTime(now);
			const h = harness(1_000);
			let owned = false;
			let leaseExpiresAt: number | null = null;
			let status = "pending";
			let attempts = 0;
			const renewAuthorization = vi.spyOn(
				h.runtime.runtimeHost,
				"renewAuthorization",
			);
			const persisted: string[] = [];
			const acknowledged: string[] = [];
			const reachedControl = Promise.withResolvers<void>();
			const store: ConversationDispatchStorePortV1 = {
				async claim() {
					owned = true;
					status = "processing";
					leaseExpiresAt = Date.now() + 30_000;
					attempts += 1;
					return {
						outcome: "claimed",
						claim: {
							...h.claim,
							deliveryFence: h.claim.deliveryFence + attempts - 1,
							executionStatus: h.state.executionStatus,
							stopPending: h.state.stopPending,
							runtimeCursor: h.state.runtimeCursor,
						},
					};
				},
				renew: vi.fn(async () => {
					if (!owned) return false;
					leaseExpiresAt = Date.now() + 30_000;
					return true;
				}),
				async prepareRuntimeDispatch() {
					return owned;
				},
				async cancelUnaccepted() {
					throw new Error("The original Turn was accepted");
				},
				async recordRuntimeResponse() {
					return owned;
				},
				retry: vi.fn(async () => {
					if (!owned || leaseExpiresAt === null || leaseExpiresAt <= Date.now())
						return false;
					owned = false;
					leaseExpiresAt = null;
					status = "retry_scheduled";
					return true;
				}),
				async finish() {
					if (!owned) return false;
					owned = false;
					leaseExpiresAt = null;
					status = "succeeded";
					return true;
				},
			};
			h.store.readRuntimeState.mockImplementation(async () =>
				owned ? structuredClone(h.state) : null,
			);
			const started = {
				schemaVersion: 2,
				adapterEventKey: "model-started",
				cursor: "started",
				executionId: "execution",
				occurredAt: "2026-09-14T12:00:00Z",
				type: "operation",
				payload: {
					kind: "model",
					phase: "started",
					operationRef: "original-model",
					attemptRef: "original-attempt",
					model: {
						configVersion: "config-1",
						modelOptionId: "option",
						modelId: "model",
					},
				},
			};
			const interrupted = {
				...started,
				adapterEventKey: "model-interrupted",
				cursor: "interrupted",
				payload: { ...started.payload, phase: "unknown" },
			};
			const terminal = {
				schemaVersion: 1,
				adapterEventKey: "cancelled",
				cursor: "cancelled",
				executionId: "execution",
				occurredAt: "2026-09-14T12:00:01Z",
				type: "completed",
				payload: { status: "cancelled" },
			};
			const frame = (event: typeof started | typeof terminal) =>
				`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
			h.fetcher.mockImplementation(async (url, init) => {
				const body = JSON.parse(init?.body as string);
				if (String(url).endsWith("/status"))
					return new Response(
						JSON.stringify({
							schemaVersion: 3,
							outcome: "found",
							hostSessionRef: "host",
							executionId: "execution",
							status: "running",
						}),
					);
				if (String(url).endsWith("/events/ack")) {
					if (
						pause === "ack" &&
						attempts === 1 &&
						body.confirmedCursor === "interrupted"
					) {
						reachedControl.resolve();
						await new Promise<never>((_resolve, reject) =>
							init?.signal?.addEventListener(
								"abort",
								() => reject(new Error("ACK aborted")),
								{ once: true },
							),
						);
					}
					acknowledged.push(body.confirmedCursor);
					return new Response(
						JSON.stringify({
							schemaVersion: 3,
							executionId: "execution",
							confirmedCursor: body.confirmedCursor,
						}),
					);
				}
				if (!String(url).endsWith("/events/stream"))
					throw new Error("No new business operation may be dispatched");
				if (body.afterCursor === null) {
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								controller.enqueue(new TextEncoder().encode(frame(started)));
								Object.assign(h.state, {
									executionStatus:
										stop === "cancelled" ? "cancelled" : "processing",
									stopPending: stop === "pending",
								});
								controller.close();
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				}
				if (attempts === 1 && pause !== "ack") {
					reachedControl.resolve();
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								init?.signal?.addEventListener(
									"abort",
									() => controller.error(new Error("stream aborted")),
									{ once: true },
								);
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				}
				return new Response(
					(body.afterCursor === "started" ? frame(interrupted) : "") +
						frame(terminal),
					{ headers: { "content-type": "text/event-stream" } },
				);
			});
			const useCase = createConversationDispatchUseCaseV1(
				{
					store,
					authorization: h.runtime.authorization,
					runtimeHost: h.runtime.runtimeHost,
					events: {
						async persist(command) {
							if (!owned) return { outcome: "stale" };
							if (!persisted.includes(command.runtimeCursor))
								persisted.push(command.runtimeCursor);
							Object.assign(h.state, {
								runtimeCursor: command.runtimeCursor,
								...(command.transition
									? { executionStatus: command.transition.executionStatus }
									: {}),
							});
							return {
								outcome: "accepted",
								event: {
									schemaVersion: 1,
									eventId: command.adapterEventKey,
									conversationId: command.conversationId,
									executionId: command.executionId,
									sequence: persisted.length,
									conversationCursor: persisted.length,
									occurredAt: command.occurredAt,
									event: command.event,
								},
							};
						},
					},
				},
				{ leaseDurationMs: 30_000, retryDelayMs: 0 },
			);
			try {
				const command = {
					schemaVersion: 1 as const,
					itemId: h.claim.itemId,
					workerId: h.claim.leaseOwner,
				};
				const dispatch = useCase.dispatch(command);
				await reachedControl.promise;
				if (pause === "lost lease") owned = false;
				await vi.advanceTimersByTimeAsync(10_000);
				expect(await dispatch).toMatchObject(
					pause === "lost lease"
						? { outcome: "stale" }
						: { outcome: "retry", retryScheduled: true },
				);
				expect(store.renew).toHaveBeenCalledTimes(1);
				expect(store.retry).toHaveBeenCalledTimes(1);
				expect(store.retry).toHaveBeenCalledWith(
					expect.objectContaining({ transition: {} }),
				);
				expect(Date.now()).toBe(now + 10_000);
				if (pause === "lost lease") {
					expect(renewAuthorization).not.toHaveBeenCalled();
					expect(status).toBe("processing");
					return;
				}
				expect(renewAuthorization).toHaveBeenCalledTimes(1);
				expect(status).toBe("retry_scheduled");
				expect(leaseExpiresAt).toBeNull();
				expect(h.state.runtimeCursor).toBe(
					pause === "ack" ? "interrupted" : "started",
				);
				Object.assign(h.state, {
					executionStatus: "cancelled",
					stopPending: false,
				});
				expect(await useCase.dispatch(command)).toMatchObject({
					outcome: "accepted",
				});
				expect(persisted).toEqual(["started", "interrupted", "cancelled"]);
				expect(acknowledged).toEqual(
					pause === "ack"
						? ["started", "interrupted", "cancelled"]
						: ["started", "started", "interrupted", "cancelled"],
				);
				expect(status).toBe("succeeded");
				const calls = h.fetcher.mock.calls.map((call) => ({
					url: String(call[0]),
					body: JSON.parse(call[1]?.body as string),
				}));
				expect(
					calls.every(
						(call) =>
							!call.url.endsWith("/authorizations/renew") &&
							!call.url.endsWith("/turns"),
					),
				).toBe(true);
				for (const { body } of calls
					.filter((call) => call.url.endsWith("/events/stream"))
					.slice(1)) {
					expect(verify(body.grant).claims.purpose).toBe("control");
					expect(body.operation.executionDeliveryFence).toBe(
						h.claim.executionDeliveryFence,
					);
				}
			} finally {
				h.runtime.close();
				renewAuthorization.mockRestore();
				vi.useRealTimers();
			}
		},
	);

	it.each(["business", "control", "lost lease"] as const)(
		"leaves a failed %s stream to the dispatcher when no owned business-to-control transition can recover it",
		async (state) => {
			const h = harness(1_000);
			try {
				if (state === "control")
					Object.assign(h.state, { executionStatus: "cancelled" });
				const context = await h.authorize();
				h.fetcher.mockImplementation(async () => {
					if (state === "lost lease")
						h.store.readRuntimeState.mockResolvedValue(null);
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.error(new Error("transport interrupted"));
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				});
				await expect(
					h.runtime.runtimeHost
						.events(h.events(context))
						[Symbol.asyncIterator]()
						.next(),
				).rejects.toMatchObject({
					code:
						state === "lost lease"
							? "RUNTIME_FENCE_STALE"
							: "RUNTIME_UNAVAILABLE",
				});
				expect(h.fetcher).toHaveBeenCalledTimes(1);
			} finally {
				h.runtime.close();
			}
		},
	);

	it("reconnects with a fresh grant from the Platform committed cursor and preserves operation facts", async () => {
		const h = harness();
		const context = await h.authorize();
		const first = {
			schemaVersion: 2,
			adapterEventKey: "model-fact",
			cursor: "first",
			executionId: "execution",
			occurredAt: "2026-09-14T12:00:00Z",
			type: "operation",
			payload: {
				kind: "model",
				phase: "started",
				operationRef: "model-operation",
				attemptRef: "attempt",
				model: {
					configVersion: "config-1",
					modelOptionId: "option",
					modelId: "model",
				},
			},
		};
		const terminal = {
			schemaVersion: 1,
			adapterEventKey: "completed-fact",
			cursor: "last",
			executionId: "execution",
			occurredAt: "2026-09-14T12:00:01Z",
			type: "completed",
			payload: { status: "completed" },
		};
		h.fetcher.mockImplementation(async (_url, init) => {
			const body = JSON.parse(init?.body as string);
			const event = body.afterCursor === "first" ? terminal : first;
			return new Response(
				`id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		});
		const stream = h.runtime.runtimeHost
			.events(h.events(context))
			[Symbol.asyncIterator]();
		expect((await stream.next()).value).toEqual(first);
		Object.assign(h.state, { runtimeCursor: "first" });
		expect((await stream.next()).value).toEqual(terminal);
		expect((await stream.next()).done).toBe(true);
		const bodies = h.fetcher.mock.calls.map((call) =>
			JSON.parse(call[1]?.body as string),
		);
		expect(bodies.map((body) => body.afterCursor)).toEqual([null, "first"]);
		expect(verify(bodies[0].grant).claims.grantId).not.toBe(
			verify(bodies[1].grant).claims.grantId,
		);
		h.runtime.close();
	});
	it("signs the original principal/input/selection after a fresh directory check", async () => {
		const h = harness();
		const context = await h.authorize();
		const before = h.directory.resolveUser.mock.calls.length;
		await h.runtime.runtimeHost.dispatch(h.request(context));
		expect(h.directory.resolveUser.mock.calls.length).toBeGreaterThan(before);
		expect(h.sent().url).toContain("/v3/turns");
		expect(h.sent().body).toMatchObject({
			principal: { kind: "user", id: "user" },
			input: { text: "original accepted input" },
			selection: { modelOptionId: "option", reasoningLevel: "high" },
		});
		expect(h.sent().claims).toMatchObject({
			purpose: "business",
			authorizationRecordId: "original-authorization",
			workerId: "transport",
		});
		expect(h.sent().body).not.toHaveProperty("actorId");
		h.runtime.close();
	});
	it("rechecks authorization immediately before signing the runtime grant", async () => {
		const h = harness();
		const context = await h.authorize();
		let reads = 0;
		h.store.readRuntimeState.mockImplementation(async () => {
			reads += 1;
			if (reads === 3) h.setUser(null);
			return h.state;
		});
		await expect(
			h.runtime.runtimeHost.dispatch(h.request(context)),
		).rejects.toMatchObject({ code: "RUNTIME_ROUTE_STALE" });
		expect(h.fetcher).not.toHaveBeenCalled();
		expect(h.authorizationStore.recordControl).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "authorization_revoked" }),
		);
		h.runtime.close();
	});
	it("turns post-authorization revocation into body-free persisted control", async () => {
		const h = harness();
		const context = await h.authorize();
		h.setUser(null);
		await expect(
			h.runtime.runtimeHost.dispatch(h.request(context)),
		).rejects.toThrow();
		expect(h.authorizationStore.recordControl).toHaveBeenCalledWith(
			expect.objectContaining({
				authorizationRecordId: "original-authorization",
				reason: "authorization_revoked",
				workerId: "instance",
			}),
		);
		expect(h.sent().url).toContain("/v3/status");
		expect(h.sent().body).not.toHaveProperty("input");
		expect(h.sent().claims).toMatchObject({
			purpose: "control",
			controlRecordId: "control-authorization_revoked",
		});
		expect(h.fetcher).toHaveBeenCalledTimes(1);
		h.runtime.close();
	});
	it("denies absent provenance and an application sharing the user's ID", async () => {
		const h = harness();
		const record = h.record();
		h.setRecord(null);
		expect(
			(await h.runtime.authorization.authorize({ ...h.claim, claim: h.claim }))
				.outcome,
		).toBe("denied");
		if (!record) throw new Error("missing fixture");
		h.setRecord({
			...record,
			boundary: {
				...record.boundary,
				// @ts-expect-error Exercise an unsupported persisted principal at runtime.
				principal: { kind: "application", id: "user" },
			},
		});
		expect(
			(await h.runtime.authorization.authorize({ ...h.claim, claim: h.claim }))
				.outcome,
		).toBe("denied");
		expect(h.fetcher).not.toHaveBeenCalled();
		h.runtime.close();
	});
	it("does not renew on identity unavailability or invent a revocation", async () => {
		const h = harness();
		const context = await h.authorize();
		h.directory.resolveUser.mockRejectedValue(
			new Error("synthetic-sensitive-error"),
		);
		await expect(
			h.runtime.runtimeHost.renewAuthorization?.(h.events(context)),
		).rejects.toThrow("TASK_IDENTITY_UNAVAILABLE");
		expect(h.fetcher).not.toHaveBeenCalled();
		expect(h.authorizationStore.recordControl).not.toHaveBeenCalled();
		h.runtime.close();
	});
	it("keeps a user stop pending when the current identity cannot be resolved", async () => {
		const h = harness();
		Object.assign(h.claim, {
			operation: "conversation.turn.stop.v1",
			stopRequestId: "stop",
		});
		Object.assign(h.state, { stopPending: true, hostSessionRef: "host" });
		h.directory.resolveUser.mockRejectedValue(new Error("directory down"));
		expect(
			await h.runtime.authorization.authorize({ ...h.claim, claim: h.claim }),
		).toEqual({ outcome: "unavailable" });
		expect(h.authorizationStore.recordControl).not.toHaveBeenCalled();
		expect(h.fetcher).not.toHaveBeenCalled();
		h.runtime.close();
	});
	it("rechecks identity before sending a previously authorized user stop", async () => {
		const h = harness();
		Object.assign(h.claim, {
			operation: "conversation.turn.stop.v1",
			stopRequestId: "stop",
		});
		Object.assign(h.state, { stopPending: true, hostSessionRef: "host" });
		const context = await h.authorize();
		h.authorizationStore.recordControl.mockClear();
		h.directory.resolveUser.mockRejectedValue(new Error("directory down"));
		await expect(
			h.runtime.runtimeHost.dispatch({
				...h.request(context),
				operation: "turn.stop",
				stopRequestId: "stop",
			}),
		).rejects.toThrow("TASK_IDENTITY_UNAVAILABLE");
		expect(h.authorizationStore.recordControl).not.toHaveBeenCalled();
		expect(h.fetcher).not.toHaveBeenCalled();
		h.runtime.close();
	});
	it("uses persisted control after revocation without depending on the user's directory", async () => {
		const h = harness();
		const context = await h.authorize();
		const record = h.record();
		if (!record) throw new Error("missing fixture");
		h.setRecord({ ...record, revokedAt: new Date(now) });
		h.directory.resolveUser.mockRejectedValue(new Error("directory down"));
		await expect(
			h.runtime.runtimeHost.recoverOriginalStatus?.({
				...h.events(context),
				schemaVersion: 2,
				hostSessionRef: null,
			}),
		).resolves.toMatchObject({ outcome: "found" });
		expect(h.sent().claims.purpose).toBe("control");
		expect(h.sent().body).not.toHaveProperty("recovery");
		h.runtime.close();
	});
	it("signs ACK only for the Platform committed cursor", async () => {
		const h = harness();
		const context = await h.authorize();
		Object.assign(h.state, { runtimeCursor: "committed" });
		await h.runtime.runtimeHost.acknowledge?.({
			...h.events(context),
			confirmedCursor: "uncommitted",
		});
		expect(h.fetcher).not.toHaveBeenCalled();
		await h.runtime.runtimeHost.acknowledge?.({
			...h.events(context),
			confirmedCursor: "committed",
		});
		expect(h.sent().claims).toMatchObject({
			allowedCommands: ["events.ack"],
			eventAccess: {
				command: "events.ack",
				consumer: "platform_worker_persistence",
				confirmedCursor: "committed",
			},
		});
		h.runtime.close();
	});
	it("rejects copied authorization references and stale leases", async () => {
		const h = harness();
		const context = await h.authorize();
		await expect(
			h.runtime.runtimeHost.dispatch(h.request({ ...(context as object) })),
		).rejects.toThrow();
		h.store.readRuntimeState.mockResolvedValue(null);
		await expect(
			h.runtime.runtimeHost.dispatch(h.request(context)),
		).rejects.toThrow();
		expect(h.fetcher).not.toHaveBeenCalled();
		h.runtime.close();
	});
	it("does not persist stop control for a caller-replaced operation", async () => {
		const h = harness();
		const context = await h.authorize();
		await expect(
			h.runtime.runtimeHost.dispatch({
				...h.request(context),
				operation: "turn.stop",
				stopRequestId: "forged-stop",
			}),
		).rejects.toMatchObject({ code: "RUNTIME_FENCE_STALE" });
		expect(h.authorizationStore.recordControl).not.toHaveBeenCalled();
		expect(h.fetcher).not.toHaveBeenCalled();
		h.runtime.close();
	});
	it("does not send if the lease expires during route resolution", async () => {
		const h = harness();
		const context = await h.authorize();
		h.resolver.mockImplementation(async () => {
			h.store.readRuntimeState.mockResolvedValue(null);
			return {
				baseUrl: "http://runtime.test",
				serviceToken: "synthetic",
				workerId: "transport",
			};
		});
		await expect(
			h.runtime.runtimeHost.dispatch(h.request(context)),
		).rejects.toThrow();
		expect(h.fetcher).not.toHaveBeenCalled();
		h.runtime.close();
	});
	it("aborts outstanding dependency waits on close", async () => {
		const h = harness();
		const context = await h.authorize();
		h.resolver.mockImplementation(() => new Promise(() => {}));
		const pending = expect(
			h.runtime.runtimeHost.dispatch(h.request(context)),
		).rejects.toThrow();
		await vi.waitFor(() => expect(h.resolver).toHaveBeenCalled());
		h.runtime.close();
		await pending;
		expect(h.fetcher).not.toHaveBeenCalled();
	});
});

describe("durable generation isolation Worker wiring", () => {
	it.each(["accepted-task", "legacy-control"] as const)(
		"signs cancellation from the original %s control proof without directory authority",
		async (source) => {
			const h = harness();
			if (source === "legacy-control") h.useLegacy();
			Object.assign(h.state, {
				generationIsolation: {
					operationId: "generation:conversation:1",
					controlRecordId: "persisted-isolation-control",
					originalPrincipal: { kind: "user", id: "user" },
				},
			});
			h.directory.resolveUser.mockRejectedValue(
				new Error("Directory is unavailable after original user revocation"),
			);
			h.fetcher.mockImplementation(async (_url, init) => {
				const request = JSON.parse(init?.body as string);
				return new Response(
					JSON.stringify({
						schemaVersion: 3,
						hostSessionRef: "host",
						operationId: request.operation.id,
						result: { outcome: "accepted", status: "cancelled" },
					}),
				);
			});
			try {
				const grant = await h.authorize();
				const response = await h.runtime.runtimeHost.cancelGeneration?.(
					h.events(grant),
				);
				expect(response).toMatchObject({
					operationId: "generation:conversation:1",
					result: { outcome: "accepted", status: "cancelled" },
				});
				expect(h.sent()).toMatchObject({
					url: "http://runtime.test/internal/runtime/v3/generations/cancel",
					claims: {
						principal: { kind: "user", id: "user" },
						purpose: "control",
						reason: "generation_isolation",
						controlRecordId: "persisted-isolation-control",
						allowedCommands: ["generation.cancel"],
						operation: { kind: "generation", id: "generation:conversation:1" },
					},
				});
				expect(h.directory.resolveUser).not.toHaveBeenCalled();
				expect(h.authorizationStore.recordControl).not.toHaveBeenCalled();
			} finally {
				h.runtime.close();
			}
		},
	);

	it("drains one persisted event snapshot during isolation without a reconnect loop", async () => {
		const h = harness();
		Object.assign(h.state, {
			generationIsolation: {
				operationId: "generation:conversation:1",
				controlRecordId: "isolation",
				originalPrincipal: { kind: "user", id: "user" },
			},
		});
		h.fetcher.mockResolvedValue(
			new Response("", { headers: { "content-type": "text/event-stream" } }),
		);
		try {
			const grant = await h.authorize();
			const stream = h.runtime.runtimeHost.drainGenerationEvents?.(
				h.events(grant),
			);
			if (!stream) throw new Error("Missing generation event drain");
			const items = [];
			for await (const event of stream) items.push(event);
			expect(items).toEqual([]);
			expect(h.fetcher).toHaveBeenCalledTimes(1);
			expect(h.sent().claims).toMatchObject({
				purpose: "control",
				reason: "generation_isolation",
				allowedCommands: ["events.persist"],
			});
		} finally {
			h.runtime.close();
		}
	});
});

describe("explicit historical metadata delivery", () => {
	it.each([false, true])(
		"signs one marker for query, replay and ACK with archive-only authority (isolation=%s)",
		async (isolating) => {
			const h = harness();
			const marker = {
				id: "history-pass",
				requestedAt: now,
				originalStatus: "failed" as const,
			};
			Object.assign(h.claim, {
				metadataRecovery: marker,
				executionStatus: "completed",
				runtimeCursor: "committed",
				deliveryFence: 9,
				stopPending: true,
			});
			Object.assign(h.state, {
				metadataRecovery: marker,
				executionStatus: "completed",
				runtimeCursor: "committed",
				stopPending: true,
				...(isolating
					? {
							generationIsolation: {
								operationId: "generation:conversation:1",
								controlRecordId: "other-execution-isolation",
								originalPrincipal: { kind: "user", id: "user" },
							},
						}
					: {}),
			});
			h.directory.resolveUser.mockRejectedValue(new Error("unavailable"));
			const context = await h.authorize();
			h.fetcher.mockImplementation(async (url) =>
				String(url).endsWith("/events/ack")
					? new Response(
							JSON.stringify({
								schemaVersion: 3,
								executionId: "execution",
								confirmedCursor: "committed",
							}),
						)
					: String(url).endsWith("/status")
						? new Response(
								JSON.stringify({
									schemaVersion: 3,
									executionId: "execution",
									hostSessionRef: "host",
									outcome: "found",
									status: "completed",
								}),
							)
						: new Response("", {
								headers: { "content-type": "text/event-stream" },
							}),
			);
			await h.runtime.runtimeHost.recoverOriginalStatus?.({
				...h.events(context),
				schemaVersion: 2,
			});
			for await (const _event of h.runtime.runtimeHost.events(
				h.events(context),
			)) {
				throw new Error("unexpected event");
			}
			await h.runtime.runtimeHost.acknowledge?.({
				...h.events(context),
				confirmedCursor: "committed",
			});
			for (const [, init] of h.fetcher.mock.calls) {
				const body = JSON.parse(init?.body as string);
				expect(body.requestId).toBe("history-pass");
				expect(body).not.toHaveProperty("input");
				expect(verify(body.grant).claims).toMatchObject({
					purpose: "control",
					reason: isolating ? "generation_isolation" : "recovery",
					operation: { deliveryFence: 2, executionDeliveryFence: 2 },
				});
			}
			expect(h.fetcher).toHaveBeenCalledTimes(3);
			expect(h.directory.resolveUser).not.toHaveBeenCalled();
			await expect(
				h.runtime.runtimeHost.renewAuthorization?.(h.events(context)),
			).rejects.toMatchObject({ code: "TASK_AUTHORIZATION_CONTROL_ONLY" });
			Object.assign(h.state, {
				metadataRecovery: { ...marker, id: "next-pass" },
			});
			await expect(
				h.runtime.runtimeHost.acknowledge?.({
					...h.events(context),
					confirmedCursor: "committed",
				}),
			).rejects.toMatchObject({ code: "RUNTIME_FENCE_STALE" });
			h.runtime.close();
		},
	);
});
