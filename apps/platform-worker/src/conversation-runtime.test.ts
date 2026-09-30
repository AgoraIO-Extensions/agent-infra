import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createRuntimeExecutionGrantValidatorV4,
	createRuntimeExecutionGrantVerifierV2,
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
} from "@agent-infra/agent-runtime";
import {
	RuntimeOperationResponseV4Schema,
	runtimeOperationDigestInputV4,
} from "@agent-infra/contracts/runtime";
import {
	type AgentConfigurationRecordV2,
	type AgentManagementStateV1,
	type ConversationDispatchClaimV1,
	type ConversationDispatchStorePortV1,
	type CurrentTaskUserV1,
	createConversationDispatchUseCaseV1 as createPublishedConversationDispatchUseCaseV1,
	type TaskAuthorizationBoundaryV1,
	type TaskRuntimeAuthorizationRecordV1,
	type WorkloadReconciliationStateV1,
} from "@agent-infra/platform-core";
import {
	migratePlatformDatabase,
	PostgresConversationEventTransactionV1,
	PostgresTaskAuthorizationStoreV1,
} from "@agent-infra/platform-store";
import type { RelayKeyWorkerDecryptorV1 } from "@agent-infra/secret-store/worker";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { requestDigest } from "../../../packages/agent-runtime/src/file-runtime-store.js";
import { createConversationDispatchUseCaseV1 } from "../../../packages/platform-core/src/conversation-dispatch.js";
import { normalizedEvent } from "../../../packages/platform-core/src/conversation-dispatch-transition.js";
import { createConversationEventUseCaseV1 } from "../../../packages/platform-core/src/conversation-events.js";
import { startPostgresTestDatabase } from "../../../packages/platform-store/src/postgres-test.js";
import { createRuntimeHostApp } from "../../agent-runtime-host/src/app.js";
import {
	type ConversationLegacyControlRecoveryV2,
	type ConversationRuntimeOptionsV2,
	type ConversationRuntimeStateV2,
	createConversationRuntimeV2,
} from "./conversation-runtime.js";
import { createWorkerRuntimeGrantSignerV2 } from "./runtime-grant-signer.js";

const keys = generateKeyPairSync("ed25519");
const verify = createRuntimeExecutionGrantVerifierV2(
	new Map([["signing", keys.publicKey]]),
);
const now = 1_800_000_000_000;
type AcceptedExecutionKey = NonNullable<
	Awaited<
		ReturnType<
			NonNullable<
				ConversationRuntimeOptionsV2["executionKeys"]
			>["readAcceptedExecution"]
		>
	>
>;
function harness(
	reconnectDelayMs = 1,
	channelAuthorizationCurrent:
		| ConversationRuntimeOptionsV2["channelAuthorizationCurrent"]
		| null = async (record) => record.boundary.channelId === "web",
	keyed = false,
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
	if (keyed) {
		Object.assign(claim, {
			executionSource: "web",
			relayKeyBinding: {
				purpose: "personal",
				subjectId: "user",
				keyId: "key-1",
				keyVersion: 1,
			},
		});
	}
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
	if (keyed) Object.assign(state, { runtimeSubmitProtocol: "v4" });
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
	let record: TaskRuntimeAuthorizationRecordV1 | null = {
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
			async (
				_input: Parameters<
					ConversationRuntimeOptionsV2["dispatchStore"]["readRuntimeState"]
				>[0],
			) => state as ConversationRuntimeStateV2 | null,
		),
	};
	const authorizationStore = {
		readExecution: vi.fn(async () => record),
		recordControl: vi.fn(
			async (
				input: Parameters<
					ConversationRuntimeOptionsV2["taskAuthorizationStore"]["recordControl"]
				>[0],
			) => {
				if (input.reason === "recovery" && record)
					record = { ...record, recoveryControlRecordId: "control-recovery" };
				if (input.reason === "authorization_revoked" && record) {
					record = { ...record, revokedAt: new Date(now) };
					Object.assign(state, { stopPending: true });
				}
				return {
					controlRecordId: `control-${input.reason}`,
					reason: input.reason,
				};
			},
		),
	};
	let legacyRecord: ConversationLegacyControlRecoveryV2 | null = null;
	const legacyStore = {
		readLegacyControlRecovery: vi.fn(async () => legacyRecord),
	};
	const executionKeys = {
		readAcceptedExecution: vi.fn(
			async (): Promise<AcceptedExecutionKey> => ({
				scope: {
					principal: { kind: "user" as const, id: "user" },
					executionSource: "web" as const,
					channelId: "web",
					agentId: "agent",
					conversationId: "conversation",
					executionId: "execution",
					turnId: "turn",
					sessionGeneration: 1,
					hostSessionRef: "host",
					keyBinding: {
						purpose: "personal" as const,
						subjectId: "user",
						ciphertextRef: "key-1",
						version: 1,
					},
				},
				trustedHostSessionRef: "host",
			}),
		),
		readCiphertext: vi.fn(
			async (): Promise<unknown | null> => ({ ciphertext: "synthetic" }),
		),
	};
	const relayKeyDecryptor = {
		decrypt: vi.fn<RelayKeyWorkerDecryptorV1["decrypt"]>(async () => ({
			outcome: "decrypted" as const,
			plaintext: new TextEncoder().encode("synthetic-relay-key-k1"),
		})),
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
		if (path.endsWith("/v4/events/read"))
			return new Response(
				JSON.stringify({
					schemaVersion: 4,
					hostSessionRef: "host",
					executionId: "execution",
					events: [
						{
							schemaVersion: 1,
							adapterEventKey: "event-1",
							executionId: "execution",
							cursor: "cursor-1",
							occurredAt: "2026-09-29T00:00:00.000Z",
							type: "status",
							payload: { status: "running" },
						},
					],
				}),
			);
		if (path.endsWith("/v4/events/ack"))
			return new Response(
				JSON.stringify({
					schemaVersion: 4,
					executionId: "execution",
					confirmedCursor: state.runtimeCursor,
				}),
			);
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
					schemaVersion: path.includes("/v4/") ? 4 : 3,
					hostSessionRef: "host",
					operationId: "execution",
					result: { outcome: "accepted", status: "running" },
				}),
			);
		if (path.endsWith("/events/stream"))
			return new Response("", {
				headers: { "content-type": "text/event-stream" },
			});
		throw new Error(`Unexpected runtime request: ${path}`);
	});
	const resolver = vi.fn(
		async (
			_input: Parameters<ConversationRuntimeOptionsV2["resolveRuntimeHost"]>[0],
		) => ({
			baseUrl: keyed ? "https://runtime.test" : "http://runtime.test",
			serviceToken: "synthetic-transport-proof",
			workerId: "transport",
		}),
	);
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
		...(keyed ? { executionKeys, relayKeyDecryptor } : {}),
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
		executionKeys,
		relayKeyDecryptor,
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
	it.each([
		"event response lost",
		"status not delivered",
		"ACK response lost",
	] as const)(
		"reaches original V4 journal after lost submit/status with %s through actual Host",
		async (loss) => {
			const h = harness(1, undefined, true);
			const directory = await mkdtemp(join(tmpdir(), "original-control-loss-"));
			const driver = await FakeRuntimeDriver.open(
				join(directory, "driver.json"),
				[{ schemaVersion: 1, modelOptionId: "option", reasoningLevel: "high" }],
			);
			const hostStore = await FileRuntimeStore.open(
				join(directory, "host.json"),
			);
			const host = await RuntimeHost.open({
				driver,
				store: hostStore,
				grantValidation: { expectedIssuer: "unused" },
				grantValidationV2: {
					expectedIssuer: "platform",
					expectedWorkerId: "transport",
					now: () => now,
				},
				validateGrantV4: createRuntimeExecutionGrantValidatorV4(
					new Map([["signing", keys.publicKey]]),
					{
						expectedIssuer: "platform",
						expectedWorkerId: "transport",
						now: () => now,
					},
				),
			});
			const app = createRuntimeHostApp({
				host,
				runtimeWorkerId: "transport",
				serviceToken: "synthetic-transport-proof",
				verifyGrant: () => {
					throw new Error("V1 disabled");
				},
				verifyGrantV2: verify,
			});
			Object.assign(h.claim, { hostSessionRef: null });
			Object.assign(h.state, { hostSessionRef: null });
			const keyScope = await h.executionKeys.readAcceptedExecution();
			h.executionKeys.readAcceptedExecution.mockImplementation(async () => ({
				...keyScope,
				scope: { ...keyScope.scope, hostSessionRef: null },
				trustedHostSessionRef: h.state.hostSessionRef,
			}));
			let trueRef: string | undefined;
			let owned = true;
			let commits = 0;
			h.fetcher.mockImplementation(async (url, init) => {
				const path = String(url);
				if (path.endsWith("/status") && loss === "status not delivered")
					throw new Error("Status never reached Host");
				const response = await app.request(path, init);
				if (path.endsWith("/turns")) {
					trueRef = RuntimeOperationResponseV4Schema.parse(
						await response.clone().json(),
					).hostSessionRef;
					Object.assign(h.state, {
						originalOperationDigest: requestDigest(
							runtimeOperationDigestInputV4(
								JSON.parse(String(init?.body)).businessRequest,
							),
						),
					});
					throw new Error("Accepted submit response lost");
				}
				if (
					path.endsWith("/status") ||
					(path.endsWith("/events/read") && loss === "event response lost") ||
					(path.endsWith("/events/ack") && loss === "ACK response lost")
				)
					throw new Error("Control response lost");
				return response;
			});
			const dispatchStore: ConversationDispatchStorePortV1 = {
				async claim() {
					owned = true;
					Object.assign(h.claim, {
						deliveryFence: h.claim.deliveryFence + 1,
						executionDeliveryFence: h.claim.deliveryFence + 1,
					});
					return {
						outcome: "claimed",
						claim: {
							...h.claim,
							hostSessionRef: h.state.hostSessionRef,
							runtimeCursor: h.state.runtimeCursor,
						},
					};
				},
				async renew() {
					return owned;
				},
				async prepareRuntimeDispatch() {
					return owned;
				},
				async terminalizeStoppedUnsentTurn() {
					throw new Error("Already uncertain");
				},
				async cancelUnaccepted() {
					throw new Error("Accepted original must remain occupied");
				},
				async recordRuntimeResponse(input) {
					if (
						!owned ||
						(h.state.hostSessionRef !== null &&
							h.state.hostSessionRef !== input.hostSessionRef)
					)
						return false;
					Object.assign(h.state, { hostSessionRef: input.hostSessionRef });
					return true;
				},
				async retry() {
					owned = false;
					return true;
				},
				async finish() {
					throw new Error("No reliable terminal event");
				},
			};
			try {
				const reference = await h.authorize();
				await expect(
					h.runtime.runtimeHost.dispatch({
						...h.request(reference),
						hostSessionRef: undefined,
					}),
				).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
				expect(trueRef).toBeTruthy();
				Object.assign(h.claim, {
					executionStatus: "unknown",
					taskWaitOrder: 1,
				});
				Object.assign(h.state, {
					executionStatus: "unknown",
					taskWaitOrder: 1,
				});
				const useCase = createPublishedConversationDispatchUseCaseV1(
					{
						store: dispatchStore,
						authorization: h.runtime.authorization,
						runtimeHost: h.runtime.runtimeHost,
						events: {
							async persist(command) {
								commits += 1;
								expect(command).not.toHaveProperty("transition");
								Object.assign(h.state, {
									runtimeCursor: command.runtimeCursor,
								});
								return {
									outcome: "accepted",
									event: {
										schemaVersion: 1,
										eventId: command.adapterEventKey,
										conversationId: command.conversationId,
										executionId: command.executionId,
										sequence: 1,
										conversationCursor: 1,
										occurredAt: command.occurredAt,
										event: command.event,
									},
								};
							},
						},
					},
					{ retryDelayMs: 0 },
				);
				const command = {
					schemaVersion: 1 as const,
					itemId: "item",
					workerId: "instance",
				};
				await expect(useCase.dispatch(command)).resolves.toMatchObject({
					outcome: "unknown",
				});
				expect(h.state.hostSessionRef).toBe(trueRef);
				await expect(useCase.dispatch(command)).resolves.toMatchObject({
					outcome: "retry",
				});
				const paths = h.fetcher.mock.calls.map(([url]) => String(url));
				expect(paths.filter((path) => path.endsWith("/turns"))).toHaveLength(1);
				expect(paths.some((path) => path.endsWith("/original-binding"))).toBe(
					true,
				);
				expect(paths).toContain(
					"https://runtime.test/internal/runtime/v4/events/read",
				);
				expect(commits).toBe(loss === "ACK response lost" ? 1 : 0);
				expect(h.state.executionStatus).toBe("unknown");
				expect(await driver.sideEffectCount()).toBe(1);
				if (loss === "ACK response lost")
					expect(h.state.runtimeCursor).not.toBeNull();
			} finally {
				h.runtime.close();
				await host.close();
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
	it("continues original V4 event read and ACK after a real Host recovery control latch", async () => {
		const h = harness(1, undefined, true);
		const directory = await mkdtemp(join(tmpdir(), "keyless-host-control-"));
		const driver = await FakeRuntimeDriver.open(
			join(directory, "driver.json"),
			[{ schemaVersion: 1, modelOptionId: "option", reasoningLevel: "high" }],
		);
		const store = await FileRuntimeStore.open(join(directory, "host.json"));
		const host = await RuntimeHost.open({
			driver,
			store,
			grantValidation: { expectedIssuer: "unused" },
			grantValidationV2: {
				expectedIssuer: "platform",
				expectedWorkerId: "transport",
				now: () => now,
			},
			validateGrantV4: createRuntimeExecutionGrantValidatorV4(
				new Map([["signing", keys.publicKey]]),
				{
					expectedIssuer: "platform",
					expectedWorkerId: "transport",
					now: () => now,
				},
			),
		});
		const app = createRuntimeHostApp({
			host,
			runtimeWorkerId: "transport",
			serviceToken: "synthetic-transport-proof",
			verifyGrant: () => {
				throw new Error("V1 disabled");
			},
			verifyGrantV2: verify,
		});
		h.fetcher.mockImplementation(async (url, init) =>
			app.request(String(url), init),
		);
		Object.assign(h.claim, { hostSessionRef: null });
		Object.assign(h.state, { hostSessionRef: null });
		const keyScope = await h.executionKeys.readAcceptedExecution();
		h.executionKeys.readAcceptedExecution.mockImplementation(async () => ({
			...keyScope,
			scope: { ...keyScope.scope, hostSessionRef: null },
			trustedHostSessionRef: h.state.hostSessionRef,
		}));
		try {
			const reference = await h.authorize();
			const accepted = await h.runtime.runtimeHost.dispatch({
				...h.request(reference),
				hostSessionRef: undefined,
			});
			Object.assign(h.state, {
				hostSessionRef: accepted.hostSessionRef,
				originalOperationDigest: requestDigest(
					runtimeOperationDigestInputV4(
						JSON.parse(String(h.fetcher.mock.calls[0]?.[1]?.body))
							.businessRequest,
					),
				),
			});
			const action = {
				nativeSessionRef: store.nativeSessionRef(
					accepted.hostSessionRef,
				) as string,
				executionId: "execution",
				runtimeOperationId: "execution",
				operationRef: "model-operation",
				attemptRef: "model-attempt",
				kind: "model" as const,
			};
			await expect(host.authorizeExternalAction(action)).resolves.toEqual({
				relayKey: "synthetic-relay-key-k1",
			});
			const originalCiphertext = await h.executionKeys.readCiphertext();
			h.executionKeys.readCiphertext.mockResolvedValue(null);
			const request = {
				...h.events(reference),
				hostSessionRef: accepted.hostSessionRef,
			};
			await expect(
				h.runtime.runtimeHost.recoverOriginalStatus?.({
					...request,
					schemaVersion: 2,
				}),
			).resolves.toMatchObject({
				outcome: "found",
				hostSessionRef: accepted.hostSessionRef,
			});
			expect(h.record()?.recoveryControlRecordId).toBe("control-recovery");
			await expect(
				h.runtime.runtimeHost.renewAuthorization?.(request),
			).rejects.toMatchObject({ code: "TASK_AUTHORIZATION_CONTROL_ONLY" });
			expect(
				h.fetcher.mock.calls.some(([url]) =>
					String(url).endsWith("/authorizations/renew"),
				),
			).toBe(false);
			expect(
				JSON.parse(await readFile(join(directory, "host.json"), "utf8"))
					.sessions[accepted.hostSessionRef].executionAuthorities.execution
					.control,
			).toEqual({ controlRecordId: "control-recovery", reason: "recovery" });
			await expect(host.authorizeExternalAction(action)).rejects.toMatchObject({
				code: "RUNTIME_GRANT_INVALID",
			});
			// A transient read failure must not prevent renewal once the same
			// original pinned Key is available; renewal never carries a new Key.
			h.executionKeys.readCiphertext.mockResolvedValue(originalCiphertext);
			await h.runtime.runtimeHost.renewAuthorization?.(request);
			await expect(host.authorizeExternalAction(action)).resolves.toEqual({
				relayKey: "synthetic-relay-key-k1",
			});
			const renewal = h.fetcher.mock.calls.find(([url]) =>
				String(url).endsWith("/authorizations/renew"),
			);
			expect(JSON.parse(String(renewal?.[1]?.body))).not.toHaveProperty(
				"privateKeyField",
			);
			h.executionKeys.readCiphertext.mockResolvedValue(null);
			await h.runtime.runtimeHost.recoverOriginalStatus?.({
				...request,
				schemaVersion: 2,
			});
			await expect(host.authorizeExternalAction(action)).rejects.toMatchObject({
				code: "RUNTIME_GRANT_INVALID",
			});
			const iterator = h.runtime.runtimeHost
				.events(request)
				[Symbol.asyncIterator]();
			const event = await iterator.next();
			if (event.done) throw new Error("Missing original event");
			await iterator.return?.();
			Object.assign(h.state, { runtimeCursor: event.value.cursor });
			await h.runtime.runtimeHost.acknowledge?.({
				...request,
				confirmedCursor: event.value.cursor,
			});
			for (const [url, init] of h.fetcher.mock.calls.filter(([url]) =>
				String(url).includes("/events/"),
			)) {
				expect(
					verify(JSON.parse(String(init?.body)).grant).claims,
				).toMatchObject({
					purpose: "control",
					reason: "recovery",
					controlRecordId: "control-recovery",
				});
				expect(String(url)).toContain("/v4/events/");
			}
			expect(await driver.sideEffectCount()).toBe(1);
		} finally {
			h.runtime.close();
			await host.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it.each(["missing", "metadata", "authentication"] as const)(
		"does not renew cached business authority after original Key %s failure",
		async (failure) => {
			const h = harness(1, undefined, true);
			if (failure === "missing")
				h.executionKeys.readCiphertext.mockResolvedValue(null);
			else
				h.relayKeyDecryptor.decrypt.mockResolvedValue({
					outcome: "failed",
					code:
						failure === "metadata"
							? "RELAY_KEY_METADATA_INVALID"
							: "RELAY_KEY_AUTHENTICATION_FAILED",
				});
			try {
				const reference = await h.authorize();
				await expect(
					h.runtime.runtimeHost.renewAuthorization?.(h.events(reference)),
				).rejects.toMatchObject({ code: "TASK_AUTHORIZATION_CONTROL_ONLY" });
				expect(h.fetcher).toHaveBeenCalledOnce();
				expect(h.sent().url).toBe(
					"https://runtime.test/internal/runtime/v3/status",
				);
				expect(h.sent().claims).toMatchObject({
					purpose: "control",
					reason: "recovery",
					allowedCommands: ["session.status"],
				});
				expect(h.sent().body).not.toHaveProperty("input");
			} finally {
				h.runtime.close();
			}
		},
	);
	it("does not renew if the original lease is lost while checking its Key", async () => {
		const h = harness(1, undefined, true);
		const plaintext = new TextEncoder().encode("synthetic-relay-key-k1");
		h.relayKeyDecryptor.decrypt.mockImplementationOnce(async () => {
			h.store.readRuntimeState.mockResolvedValue(null);
			return { outcome: "decrypted", plaintext };
		});
		try {
			const reference = await h.authorize();
			await expect(
				h.runtime.runtimeHost.renewAuthorization?.(h.events(reference)),
			).rejects.toMatchObject({ code: "RUNTIME_FENCE_STALE" });
			expect(h.fetcher).not.toHaveBeenCalled();
			expect(plaintext.every((byte) => byte === 0)).toBe(true);
		} finally {
			h.runtime.close();
		}
	});
	it("marks keyed recovery reads as V4", async () => {
		const h = harness(1, undefined, true);
		await h.authorize();
		expect(
			h.store.readRuntimeState.mock.calls.some(
				([input]) => input.runtimeSubmitProtocol === "v4",
			),
		).toBe(true);
	});

	it("reads and acknowledges a keyed Execution on the V4 event route", async () => {
		const h = harness(1, undefined, true);
		try {
			const reference = await h.authorize();
			const stream = h.runtime.runtimeHost.events(h.events(reference));
			const iterator = stream[Symbol.asyncIterator]();
			await expect(iterator.next()).resolves.toMatchObject({
				value: { executionId: "execution", cursor: "cursor-1" },
			});
			await iterator.return?.();
			Object.assign(h.state, { runtimeCursor: "cursor-1" });
			if (!h.runtime.runtimeHost.acknowledge)
				throw new Error("Runtime ACK is unavailable");
			await h.runtime.runtimeHost.acknowledge({
				...h.events(reference),
				confirmedCursor: "cursor-1",
			});
			const paths = h.fetcher.mock.calls.map(([url]) => String(url));
			expect(paths).toEqual([
				"https://runtime.test/internal/runtime/v4/events/read",
				"https://runtime.test/internal/runtime/v4/events/ack",
			]);
			for (const [, init] of h.fetcher.mock.calls) {
				const body = JSON.parse(String(init?.body));
				expect(body.keyBinding).toEqual({
					purpose: "personal",
					subjectId: "user",
					ciphertextRef: "key-1",
					version: 1,
				});
				expect(verify(body.grant).claims.requestDigest).toMatch(
					/^[0-9a-f]{64}$/,
				);
				expect(JSON.stringify(body)).not.toContain("synthetic-relay-key-k1");
			}
		} finally {
			h.runtime.close();
		}
	});

	it("routes a keyed Execution through V4 with the original Key version", async () => {
		const h = harness(1, undefined, true);
		try {
			const reference = await h.authorize();
			const result = await h.runtime.runtimeHost.dispatch(h.request(reference));
			expect(result).toMatchObject({ schemaVersion: 2 });
			const [url, init] = h.fetcher.mock.calls[0] ?? [];
			expect(String(url)).toBe(
				"https://runtime.test/internal/runtime/v4/turns",
			);
			const transport = JSON.parse(String(init?.body));
			expect(transport.businessRequest).toMatchObject({
				executionSource: "web",
				keyBinding: {
					purpose: "personal",
					subjectId: "user",
					ciphertextRef: "key-1",
					version: 1,
				},
			});
			expect(transport.businessRequest.selection.modelOptionId).toBe("option");
			expect(transport.privateKeyField.keyDelivery.relayKey).toBe(
				"synthetic-relay-key-k1",
			);
			expect(h.executionKeys.readCiphertext).toHaveBeenCalledWith({
				purpose: "personal",
				subjectId: "user",
				keyId: "key-1",
				keyVersion: 1,
			});
		} finally {
			h.runtime.close();
		}
	});
	it("keeps a custom task without model selection on the V2 route", async () => {
		const h = harness(1, undefined, true);
		Object.assign(h.claim, { modelOptionId: null, reasoningLevel: null });
		try {
			const reference = await h.authorize();
			await expect(
				h.runtime.runtimeHost.dispatch(h.request(reference)),
			).resolves.toMatchObject({ schemaVersion: 1 });
			expect(h.store.readRuntimeState.mock.calls[0]?.[0]).not.toHaveProperty(
				"runtimeSubmitProtocol",
			);
			const [url, init] = h.fetcher.mock.calls[0] ?? [];
			expect(String(url)).toBe(
				"https://runtime.test/internal/runtime/v3/turns",
			);
			const body = JSON.parse(String(init?.body));
			expect(body).not.toHaveProperty("keyBinding");
			expect(body).not.toHaveProperty("privateKeyField");
		} finally {
			h.runtime.close();
		}
	});
	it("does not re-submit a V2-pinned Execution through V4 after Key upgrade", async () => {
		const h = harness(1, undefined, true);
		Object.assign(h.state, { runtimeSubmitProtocol: "v2" });
		try {
			const reference = await h.authorize();
			await expect(
				h.runtime.runtimeHost.dispatch(h.request(reference)),
			).rejects.toMatchObject({ code: "RUNTIME_ACCEPTANCE_UNKNOWN" });
			expect(h.fetcher).not.toHaveBeenCalled();
		} finally {
			h.runtime.close();
		}
	});
	it("keeps pinned V2 event recovery on the V3 read and ACK routes", async () => {
		const h = harness(1, undefined, true);
		Object.assign(h.state, {
			runtimeSubmitProtocol: "v2",
			runtimeCursor: "cursor-1",
		});
		try {
			const reference = await h.authorize();
			const controller = new AbortController();
			const stream = h.runtime.runtimeHost.events(
				h.events(reference),
				controller.signal,
			);
			const iterator = stream[Symbol.asyncIterator]();
			const pendingRead = iterator.next();
			const abortTimer = setTimeout(() => controller.abort(), 20);
			await expect(pendingRead).rejects.toMatchObject({
				code: "RUNTIME_INTERRUPTED",
			});
			clearTimeout(abortTimer);
			if (!h.runtime.runtimeHost.acknowledge)
				throw new Error("Runtime ACK is unavailable");
			await h.runtime.runtimeHost.acknowledge({
				...h.events(reference),
				confirmedCursor: "cursor-1",
			});
			const paths = h.fetcher.mock.calls.map(([url]) => String(url));
			expect(paths[0]).toBe(
				"https://runtime.test/internal/runtime/v3/events/stream",
			);
			expect(paths.at(-1)).toBe(
				"https://runtime.test/internal/runtime/v3/events/ack",
			);
			expect(paths).not.toContain(
				"https://runtime.test/internal/runtime/v4/events/read",
			);
			expect(paths).not.toContain(
				"https://runtime.test/internal/runtime/v4/events/ack",
			);
		} finally {
			h.runtime.close();
		}
	});
	it.each(["unknown", "processing"] as const)(
		"keeps keyed %s recovery control on original status without business submit",
		async (executionStatus) => {
			const h = harness(1, undefined, true);
			Object.assign(h.claim, { executionStatus });
			Object.assign(h.state, { executionStatus });
			h.setRecord({
				...h.record()!,
				recoveryControlRecordId: "control-recovery",
			});
			try {
				const reference = await h.authorize();
				await expect(
					h.runtime.runtimeHost.recoverOriginalStatus?.({
						...h.events(reference),
						schemaVersion: 2,
					}),
				).resolves.toMatchObject({ outcome: "found", hostSessionRef: "host" });
				expect(h.fetcher.mock.calls.map(([url]) => String(url))).toEqual([
					"https://runtime.test/internal/runtime/v3/status",
				]);
				expect(h.sent().body).toMatchObject({
					hostSessionRef: "host",
					originalOperationDigest: h.state.originalOperationDigest,
				});
				expect(h.sent().body).not.toHaveProperty("input");
				expect(h.sent().body).not.toHaveProperty("selection");
				expect(h.executionKeys.readCiphertext).not.toHaveBeenCalled();
				expect(h.relayKeyDecryptor.decrypt).not.toHaveBeenCalled();
			} finally {
				h.runtime.close();
			}
		},
	);
	it("recovers a keyed Execution through the idempotent V4 submit", async () => {
		const h = harness(1, undefined, true);
		Object.assign(h.claim, { executionStatus: "unknown" });
		Object.assign(h.state, {
			executionStatus: "unknown",
			runtimeSubmitProtocol: "v4",
		});
		try {
			const reference = await h.authorize();
			await expect(
				h.runtime.runtimeHost.recoverOriginalStatus?.({
					...h.events(reference),
					schemaVersion: 2,
					hostSessionRef: "host",
				}),
			).resolves.toEqual({
				schemaVersion: 2,
				hostSessionRef: "host",
				executionId: "execution",
				outcome: "found",
				status: "running",
			});
			expect(h.fetcher.mock.calls.map(([url]) => String(url))).toEqual([
				"https://runtime.test/internal/runtime/v4/turns",
			]);
			const body = JSON.parse(String(h.fetcher.mock.calls[0]?.[1]?.body));
			expect(body.businessRequest).toMatchObject({
				hostSessionRef: null,
				input: { text: "original accepted input", attachments: [] },
				selection: {
					modelOptionId: "option",
					reasoningLevel: "high",
				},
			});
		} finally {
			h.runtime.close();
		}
	});
	it.each([
		["missing", "unknown"],
		["metadata", "processing"],
		["authentication", "unknown"],
	] as const)(
		"reads body-free original V4 status with %s Key and %s occupancy",
		async (failure, status) => {
			const h = harness(1, undefined, true);
			Object.assign(h.claim, { executionStatus: status });
			Object.assign(h.state, { executionStatus: status });
			if (failure === "missing")
				h.executionKeys.readCiphertext.mockResolvedValue(null);
			else
				h.relayKeyDecryptor.decrypt.mockResolvedValue({
					outcome: "failed",
					code:
						failure === "metadata"
							? "RELAY_KEY_METADATA_INVALID"
							: "RELAY_KEY_AUTHENTICATION_FAILED",
				});
			const original = structuredClone({ claim: h.claim, state: h.state });
			try {
				const reference = await h.authorize();
				await expect(
					h.runtime.runtimeHost.recoverOriginalStatus?.({
						...h.events(reference),
						schemaVersion: 2,
					}),
				).resolves.toMatchObject({
					outcome: "found",
					executionId: "execution",
					hostSessionRef: "host",
					status: "running",
				});
				expect(h.fetcher.mock.calls.map(([url]) => String(url))).toEqual([
					"https://runtime.test/internal/runtime/v3/status",
				]);
				const { body, claims } = h.sent();
				expect(claims).toMatchObject({
					purpose: "control",
					reason: "recovery",
					allowedCommands: ["session.status"],
				});
				expect(body).toMatchObject({
					hostSessionRef: "host",
					executionId: "execution",
					turnId: "turn",
					originalOperationDigest: original.state.originalOperationDigest,
					operation: { deliveryFence: 2, executionDeliveryFence: 2 },
				});
				expect(body).not.toHaveProperty("input");
				expect(body).not.toHaveProperty("privateKeyField");
				expect({ claim: h.claim, state: h.state }).toEqual(original);
				expect(h.record()?.revokedAt).toBeNull();
				// Event persistence and ACK do not need to reinstall or decrypt a Key.
				const decryptions = h.relayKeyDecryptor.decrypt.mock.calls.length;
				const stream = h.runtime.runtimeHost
					.events(h.events(reference))
					[Symbol.asyncIterator]();
				expect(await stream.next()).toMatchObject({
					value: { cursor: "cursor-1" },
				});
				await stream.return?.();
				Object.assign(h.state, { runtimeCursor: "cursor-1" });
				await h.runtime.runtimeHost.acknowledge?.({
					...h.events(reference),
					confirmedCursor: "cursor-1",
				});
				expect(
					h.fetcher.mock.calls.slice(1).map(([url]) => String(url)),
				).toEqual([
					"https://runtime.test/internal/runtime/v4/events/read",
					"https://runtime.test/internal/runtime/v4/events/ack",
				]);
				expect(h.relayKeyDecryptor.decrypt).toHaveBeenCalledTimes(decryptions);
			} finally {
				h.runtime.close();
			}
		},
	);
	it("reads the original binding when its V4 Key and Core ref are both missing", async () => {
		const h = harness(1, undefined, true);
		Object.assign(h.claim, {
			executionStatus: "unknown",
			hostSessionRef: null,
		});
		Object.assign(h.state, {
			executionStatus: "unknown",
			hostSessionRef: null,
		});
		const accepted = await h.executionKeys.readAcceptedExecution();
		h.executionKeys.readAcceptedExecution.mockResolvedValue({
			...accepted,
			scope: { ...accepted.scope, hostSessionRef: null },
			trustedHostSessionRef: null,
		});
		h.executionKeys.readCiphertext.mockResolvedValue(null);
		h.fetcher.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					schemaVersion: 3,
					outcome: "binding_found",
					executionId: "execution",
					hostSessionRef: "host",
				}),
			),
		);
		try {
			const reference = await h.authorize();
			await expect(
				h.runtime.runtimeHost.recoverOriginalStatus?.({
					...h.events(reference),
					schemaVersion: 2,
					hostSessionRef: null,
				}),
			).resolves.toMatchObject({
				outcome: "binding_found",
				hostSessionRef: "host",
			});
			expect(h.sent().url).toBe(
				"https://runtime.test/internal/runtime/v3/original-binding",
			);
			expect(h.sent().claims).toMatchObject({
				purpose: "control",
				reason: "recovery",
				allowedCommands: ["session.status"],
			});
			expect(h.state).toMatchObject({
				hostSessionRef: null,
				executionStatus: "unknown",
			});
			expect(h.fetcher).toHaveBeenCalledOnce();
		} finally {
			h.runtime.close();
		}
	});
	it("rechecks the original binding and route after the Key disappears immediately before delivery", async () => {
		const h = harness(1, undefined, true);
		const accepted = await h.executionKeys.readAcceptedExecution();
		h.executionKeys.readAcceptedExecution.mockImplementationOnce(async () => {
			h.executionKeys.readCiphertext.mockResolvedValue(null);
			return accepted;
		});
		try {
			const reference = await h.authorize();
			await expect(
				h.runtime.runtimeHost.recoverOriginalStatus?.({
					...h.events(reference),
					schemaVersion: 2,
				}),
			).resolves.toMatchObject({ outcome: "found", hostSessionRef: "host" });
			expect(h.sent().url).toBe(
				"https://runtime.test/internal/runtime/v3/status",
			);
			expect(h.sent().claims).toMatchObject({
				purpose: "control",
				reason: "recovery",
			});
			expect(
				h.resolver.mock.calls.some(([input]) => input.purpose === "control"),
			).toBe(true);
			expect(h.fetcher).toHaveBeenCalledOnce();
		} finally {
			h.runtime.close();
		}
	});
	it.each(["RELAY_KEY_UNAVAILABLE", "RUNTIME_GRANT_INVALID"])(
		"does not treat remote %s as local Key failure",
		async (code) => {
			const h = harness(1, undefined, true);
			h.fetcher.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						schemaVersion: 1,
						code,
						message: "Synthetic remote error",
						retryable: false,
						traceId: "trace",
					}),
					{ status: 503 },
				),
			);
			try {
				const reference = await h.authorize();
				await expect(
					h.runtime.runtimeHost.recoverOriginalStatus?.({
						...h.events(reference),
						schemaVersion: 2,
					}),
				).rejects.toMatchObject({ code });
				expect(h.fetcher).toHaveBeenCalledOnce();
				expect(h.authorizationStore.recordControl).not.toHaveBeenCalled();
			} finally {
				h.runtime.close();
			}
		},
	);
	it.each(["lease", "revoked", "stop"] as const)(
		"rechecks %s during local Key failure before control recovery",
		async (race) => {
			const h = harness(1, undefined, true);
			h.executionKeys.readCiphertext.mockImplementationOnce(async () => {
				if (race === "lease") h.store.readRuntimeState.mockResolvedValue(null);
				else if (race === "revoked") h.setUser(null);
				else Object.assign(h.state, { stopPending: true });
				return null;
			});
			try {
				const reference = await h.authorize();
				const recovery = h.runtime.runtimeHost.recoverOriginalStatus?.({
					...h.events(reference),
					schemaVersion: 2,
				});
				if (race === "lease") {
					await expect(recovery).rejects.toMatchObject({
						code: "RUNTIME_FENCE_STALE",
					});
					expect(h.fetcher).not.toHaveBeenCalled();
				} else {
					await expect(recovery).resolves.toMatchObject({ outcome: "found" });
					expect(h.sent().claims).toMatchObject({
						purpose: "control",
						reason: race === "stop" ? "stop" : "authorization_revoked",
					});
					expect(h.fetcher).toHaveBeenCalledOnce();
				}
			} finally {
				h.runtime.close();
			}
		},
	);
	it("reads a V2-pinned original status without V4 business replay", async () => {
		const h = harness(1, undefined, true);
		Object.assign(h.claim, { executionStatus: "unknown" });
		Object.assign(h.state, {
			executionStatus: "unknown",
			runtimeSubmitProtocol: "v2",
		});
		try {
			const reference = await h.authorize();
			await expect(
				h.runtime.runtimeHost.recoverOriginalStatus?.({
					...h.events(reference),
					schemaVersion: 2,
				}),
			).resolves.toMatchObject({
				schemaVersion: 2,
				outcome: "found",
				executionId: "execution",
				hostSessionRef: "host",
			});
			expect(h.fetcher.mock.calls.map(([url]) => String(url))).toEqual([
				"https://runtime.test/internal/runtime/v3/status",
			]);
		} finally {
			h.runtime.close();
		}
	});
	it("reads a lost V4 Session binding under persisted recovery control", async () => {
		const h = harness(1, undefined, true);
		Object.assign(h.claim, {
			executionStatus: "unknown",
			hostSessionRef: null,
			stopPending: true,
		});
		Object.assign(h.state, {
			executionStatus: "unknown",
			hostSessionRef: null,
			stopPending: true,
		});
		h.fetcher.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					schemaVersion: 3,
					outcome: "binding_found",
					executionId: "execution",
					hostSessionRef: "host",
				}),
			),
		);
		try {
			const reference = await h.authorize();
			await expect(
				h.runtime.runtimeHost.recoverOriginalStatus?.({
					...h.events(reference),
					schemaVersion: 2,
					hostSessionRef: null,
				}),
			).resolves.toEqual({
				schemaVersion: 2,
				outcome: "binding_found",
				executionId: "execution",
				hostSessionRef: "host",
			});
			const sent = h.sent();
			expect(sent.url).toBe(
				"https://runtime.test/internal/runtime/v3/original-binding",
			);
			expect(sent.claims).toMatchObject({
				purpose: "control",
				reason: "recovery",
				allowedCommands: ["session.status"],
			});
			expect(sent.body).toMatchObject({
				originalOperationDigest: h.state.originalOperationDigest,
				hostSessionRef: null,
				operation: {
					kind: "execution",
					id: "execution",
				},
			});
			expect(sent.body).not.toHaveProperty("input");
			expect(sent.body).not.toHaveProperty("keyBinding");
			expect(h.fetcher).toHaveBeenCalledOnce();
		} finally {
			h.runtime.close();
		}
	});
	it("keeps an explicitly pinned non-null submit Session compatible", async () => {
		const h = harness(1, undefined, true);
		Object.assign(h.claim, { executionStatus: "unknown" });
		Object.assign(h.state, {
			executionStatus: "unknown",
			runtimeSubmitProtocol: "v4",
			originalSubmitHostSessionRef: "original-host",
			hostSessionRef: "assigned-host",
		});
		h.executionKeys.readAcceptedExecution.mockResolvedValue({
			scope: {
				principal: { kind: "user", id: "user" },
				executionSource: "web",
				channelId: "web",
				agentId: "agent",
				conversationId: "conversation",
				executionId: "execution",
				turnId: "turn",
				sessionGeneration: 1,
				hostSessionRef: "original-host",
				keyBinding: {
					purpose: "personal",
					subjectId: "user",
					ciphertextRef: "key-1",
					version: 1,
				},
			},
			trustedHostSessionRef: "original-host",
		});
		try {
			const reference = await h.authorize();
			await expect(
				h.runtime.runtimeHost.recoverOriginalStatus?.({
					...h.events(reference),
					schemaVersion: 2,
					hostSessionRef: "assigned-host",
				}),
			).resolves.toMatchObject({ outcome: "found" });
			const body = JSON.parse(String(h.fetcher.mock.calls[0]?.[1]?.body));
			expect(body.businessRequest.hostSessionRef).toBe("original-host");
		} finally {
			h.runtime.close();
		}
	});

	it("withholds the decrypted Key when current access is revoked during decryption", async () => {
		const h = harness(1, undefined, true);
		h.relayKeyDecryptor.decrypt.mockImplementationOnce(async () => {
			h.setUser(null);
			return {
				outcome: "decrypted" as const,
				plaintext: new TextEncoder().encode("synthetic-relay-key-k1"),
			};
		});
		try {
			const reference = await h.authorize();
			await expect(
				h.runtime.runtimeHost.dispatch(h.request(reference)),
			).rejects.toMatchObject({ code: "AUTHORIZATION_REVOKED" });
			expect(h.authorizationStore.recordControl).toHaveBeenCalledWith(
				expect.objectContaining({ reason: "authorization_revoked" }),
			);
			expect(h.fetcher).not.toHaveBeenCalled();
		} finally {
			h.runtime.close();
		}
	});

	it("withholds the decrypted Key when the Workload route changes during decryption", async () => {
		const h = harness(1, undefined, true);
		h.relayKeyDecryptor.decrypt.mockImplementationOnce(async () => {
			const original = h.record();
			if (!original?.workload) throw new Error("Expected Workload");
			h.setRecord({
				...original,
				agent: { ...original.agent, fence: 2 },
				workload: { ...original.workload, fence: 2 },
			});
			return {
				outcome: "decrypted" as const,
				plaintext: new TextEncoder().encode("synthetic-relay-key-k1"),
			};
		});
		try {
			const reference = await h.authorize();
			await expect(
				h.runtime.runtimeHost.dispatch(h.request(reference)),
			).rejects.toMatchObject({ code: "RUNTIME_ROUTE_STALE" });
			expect(h.fetcher).not.toHaveBeenCalled();
		} finally {
			h.runtime.close();
		}
	});

	it.each(["cancel", "subject-disabled", "already-revoked"] as const)(
		"recovers the lost original Session before stopping %s without restoring business authority",
		async (reason) => {
			const h = harness();
			Object.assign(h.claim, {
				taskWaitOrder: 1,
				executionStatus: "unknown",
				hostSessionRef: null,
				stopPending: reason === "cancel",
			});
			Object.assign(h.state, {
				taskWaitOrder: 1,
				executionStatus: "unknown",
				hostSessionRef: null,
				stopPending: reason === "cancel",
			});
			if (reason === "subject-disabled") h.setUser(null);
			if (reason === "already-revoked") {
				const record = h.record();
				if (!record) throw new Error("missing authorization");
				h.setRecord({ ...record, revokedAt: new Date(now) });
			}
			try {
				const reference = await h.authorize();
				await h.runtime.runtimeHost.recoverOriginalStatus?.({
					...h.events(reference),
					schemaVersion: 2,
					hostSessionRef: null,
				});
				expect(h.sent().claims).toMatchObject({
					purpose: "control",
					reason: "recovery",
					allowedCommands: ["session.status"],
					hostSessionRef: null,
				});
				expect(h.sent().body).not.toHaveProperty("input");
				expect(h.authorizationStore.recordControl).toHaveBeenCalledWith(
					expect.objectContaining({
						reason: reason === "cancel" ? "stop" : "authorization_revoked",
					}),
				);
				if (reason !== "cancel") expect(h.record()?.revokedAt).not.toBeNull();
				expect(h.state.stopPending).toBe(true);
				await expect(
					h.runtime.runtimeHost.dispatch(h.request(reference)),
				).rejects.toMatchObject({ code: "AUTHORIZATION_REVOKED" });
				expect(
					h.fetcher.mock.calls.some(([url]) => String(url).endsWith("/turns")),
				).toBe(false);
				Object.assign(h.state, {
					hostSessionRef: "host",
					executionStatus: "processing",
				});
				Object.assign(h.claim, {
					hostSessionRef: "host",
					executionStatus: "processing",
					operation: "conversation.turn.stop.v1",
					stopRequestId: "original-stop",
					stopPending: true,
				});
				const stopReference = await h.authorize();
				h.fetcher.mockClear();
				await h.runtime.runtimeHost.dispatch({
					...h.events(stopReference),
					operation: "turn.stop",
					stopRequestId: "original-stop",
				});
				expect(h.sent().claims).toMatchObject({
					purpose: "control",
					reason: reason === "cancel" ? "stop" : "authorization_revoked",
					allowedCommands: ["turn.stop"],
					hostSessionRef: "host",
				});
			} finally {
				h.runtime.close();
			}
		},
	);
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
			return { controlRecordId: "control-stop", reason: "stop" };
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
			reason: "recovery",
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
				async terminalizeStoppedUnsentTurn() {
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
				// Exercise a mismatched persisted principal at runtime.
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

it.each(["stop", "authorization_revoked"] as const)(
	"preserves persisted control continuity for %s across terminal lease takeover",
	async (reason) => {
		const database = await startPostgresTestDatabase("control-continuity");
		const sql = postgres(database.databaseUrl, { max: 1 });
		const taskStore = new PostgresTaskAuthorizationStoreV1({
			databaseUrl: database.databaseUrl,
		});
		const eventTransaction = new PostgresConversationEventTransactionV1({
			databaseUrl: database.databaseUrl,
		});
		const directory = await mkdtemp(join(tmpdir(), "control-continuity-"));
		const h = harness();
		let host: RuntimeHost | undefined;
		try {
			await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
			const record = h.record();
			if (!record) throw new Error("Missing original authority");
			await sql`insert into platform.conversations (id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision) values ('conversation','agent','user','web','active',1,'agent-7')`;
			await sql`insert into platform.conversation_executions (execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,delivery_fence,authorization_revision,created_at) values ('execution','conversation','agent','user','web','turn','processing',1,1,'agent-7',now())`;
			await sql`insert into platform.task_authorization_records (id,execution_id,boundary) values ('original-authorization','execution',${sql.json(JSON.parse(JSON.stringify(record.boundary)))})`;
			h.authorizationStore.recordControl.mockImplementation((input) =>
				taskStore.recordControl(input),
			);
			const controlRequest = {
				executionId: "execution",
				authorizationRecordId: "original-authorization",
				workerId: "instance",
				traceId: "trace",
				requestId: "recovery-request",
			};
			const initialRecovery = await taskStore.recordControl({
				...controlRequest,
				reason: "recovery",
			});
			expect(
				await sql`select reason from platform.task_control_records where id=${initialRecovery.controlRecordId}`,
			).toEqual([{ reason: "recovery" }]);
			expect(await sql`select * from platform.conversation_stops`).toHaveLength(
				0,
			);
			h.store.readRuntimeState.mockImplementation(async () => {
				const [state] = await sql<
					{
						status: ConversationRuntimeStateV2["executionStatus"];
						last_runtime_cursor: string | null;
					}[]
				>`select status,last_runtime_cursor from platform.conversation_executions where execution_id='execution'`;
				if (!state) throw new Error("Missing original execution");
				return {
					...h.state,
					executionStatus: state.status,
					runtimeCursor: state.last_runtime_cursor,
				};
			});
			const driver = await FakeRuntimeDriver.open(
				join(directory, "driver.json"),
				[{ schemaVersion: 1, modelOptionId: "option", reasoningLevel: "high" }],
			);
			const storePath = join(directory, "host.json");
			host = await RuntimeHost.open({
				driver,
				store: await FileRuntimeStore.open(storePath),
				grantValidation: { expectedIssuer: "unused-v1" },
				grantValidationV2: {
					expectedIssuer: "platform",
					expectedWorkerId: "transport",
					now: () => now,
				},
			});
			const app = createRuntimeHostApp({
				host,
				runtimeWorkerId: "transport",
				serviceToken: "synthetic-transport-proof",
				verifyGrant: () => {
					throw new Error("V1 disabled");
				},
				verifyGrantV2: verify,
			});
			h.fetcher.mockImplementation(async (url, init) =>
				app.request(String(url), init),
			);
			Object.assign(h.claim, {
				deliveryFence: 1,
				executionDeliveryFence: 1,
				hostSessionRef: null,
			});
			Object.assign(h.state, { hostSessionRef: null });
			const context = await h.authorize();
			const accepted = await h.runtime.runtimeHost.dispatch({
				...h.request(context),
				deliveryFence: 1,
				executionDeliveryFence: 1,
			});
			Object.assign(h.state, { hostSessionRef: accepted.hostSessionRef });
			const stream = h.runtime.runtimeHost
				.events(h.events(context))
				[Symbol.asyncIterator]();
			const first = await stream.next();
			if (first.done) throw new Error("Expected original status event");
			const events = createConversationEventUseCaseV1({
				transaction: eventTransaction,
			});
			const persist = (event: typeof first.value) =>
				events.persist({
					schemaVersion: 1,
					conversationId: "conversation",
					executionId: "execution",
					sessionGeneration: 1,
					deliveryFence: 1,
					adapterEventKey: event.adapterEventKey,
					runtimeCursor: event.cursor,
					occurredAt: event.occurredAt,
					event: normalizedEvent(event),
				});
			expect(await persist(first.value)).toMatchObject({ outcome: "accepted" });
			await h.runtime.runtimeHost.acknowledge?.({
				...h.events(context),
				confirmedCursor: first.value.cursor,
			});
			await stream.return?.();
			const originalControl = await taskStore.recordControl({
				executionId: "execution",
				authorizationRecordId: "original-authorization",
				reason,
				workerId: "instance",
				traceId: "trace",
				requestId: "stop-request",
			});
			const sign = createWorkerRuntimeGrantSignerV2({
				issuer: "platform",
				workerId: "transport",
				keyId: "signing",
				privateKey: keys.privateKey,
				now: () => now,
			});
			const stop = {
				schemaVersion: 3 as const,
				requestId: "stop-request",
				traceId: "trace",
				principal: { kind: "user" as const, id: "user" },
				channelId: "web",
				agentId: "agent",
				conversationId: "conversation",
				executionId: "execution",
				turnId: "turn",
				sessionGeneration: 1,
				hostSessionRef: accepted.hostSessionRef,
				operation: {
					kind: "stop" as const,
					id: "stop-request",
					deliveryFence: 1,
					executionDeliveryFence: 1,
				},
			};
			const grant = sign(
				stop,
				{
					purpose: "control",
					reason,
					controlRecordId: originalControl.controlRecordId,
				},
				"turn.stop",
			);
			expect(
				await host.stopV3({ ...stop, grant }, verify(grant)),
			).toMatchObject({ result: { status: "cancelled" } });
			await sql`update platform.conversation_executions set status='cancelled' where execution_id='execution'`;
			Object.assign(h.claim, {
				deliveryFence: 2,
				executionStatus: "cancelled",
			});
			h.directory.resolveUser.mockRejectedValue(
				new Error("Original user unavailable"),
			);
			const recovery = await h.authorize();
			const drain = h.runtime.runtimeHost
				.events(h.events(recovery))
				[Symbol.asyncIterator]();
			const delivery = await drain.next().then(
				(value) => ({ value }),
				(error) => ({
					failure: { code: error.code, retryable: error.retryable },
				}),
			);
			expect(delivery).toMatchObject({ value: { done: false } });
			if (!("value" in delivery) || delivery.value.done)
				throw new Error("Expected durable terminal event");
			const terminal = delivery.value;
			expect(terminal.value).toMatchObject({
				type: "completed",
				payload: { status: "cancelled" },
			});
			const ackCount = () =>
				h.fetcher.mock.calls.filter(([url]) =>
					String(url).endsWith("/events/ack"),
				).length;
			const beforeCommit = ackCount();
			await h.runtime.runtimeHost.acknowledge?.({
				...h.events(recovery),
				confirmedCursor: terminal.value.cursor,
			});
			expect(ackCount()).toBe(beforeCommit);
			expect(await persist(terminal.value)).toMatchObject({
				outcome: "accepted",
			});
			await h.runtime.runtimeHost.acknowledge?.({
				...h.events(recovery),
				confirmedCursor: terminal.value.cursor,
			});
			// FakeRuntimeDriver tails even a completed journal; close this fixture
			// subscription after verifying delivery and the durable acknowledgement.
			await drain.return?.();
			const controlQueries = h.fetcher.mock.calls.filter(([url, init]) => {
				if (
					!String(url).endsWith("/events/stream") &&
					!String(url).endsWith("/events/ack")
				)
					return false;
				return (
					verify(JSON.parse(init?.body as string).grant).claims.purpose ===
					"control"
				);
			});
			expect(controlQueries).toHaveLength(2);
			for (const [, init] of controlQueries)
				expect(
					verify(JSON.parse(init?.body as string).grant).claims,
				).toMatchObject({
					purpose: "control",
					reason,
					controlRecordId: originalControl.controlRecordId,
					operation: { deliveryFence: 1, executionDeliveryFence: 1 },
				});
			const saved = JSON.parse(await readFile(storePath, "utf8")).sessions[
				accepted.hostSessionRef
			];
			expect(saved.executionAuthorities.execution).toMatchObject({
				stopped: true,
				control: { reason, controlRecordId: originalControl.controlRecordId },
				confirmedCursor: terminal.value.cursor,
			});
			expect(
				await sql`select reason from platform.task_control_records order by reason`,
			).toEqual(
				[{ reason: "recovery" }, { reason }].sort((a, b) =>
					a.reason.localeCompare(b.reason),
				),
			);
			expect(await driver.sideEffectCount()).toBe(2);
			const beforeDenied = h.fetcher.mock.calls.length;
			await expect(
				h.runtime.runtimeHost.renewAuthorization?.(h.events(recovery)),
			).rejects.toMatchObject({ code: "TASK_AUTHORIZATION_CONTROL_ONLY" });
			await expect(
				h.runtime.runtimeHost.dispatch({
					...h.request(recovery),
					deliveryFence: 2,
					executionDeliveryFence: 1,
				}),
			).rejects.toMatchObject({ code: "TASK_AUTHORIZATION_CONTROL_ONLY" });
			expect(h.fetcher).toHaveBeenCalledTimes(beforeDenied);
			const continued = await taskStore.recordControl({
				...controlRequest,
				reason: reason === "stop" ? "authorization_revoked" : "stop",
			});
			expect(continued).toEqual(originalControl);
			const controls =
				await sql`select id,reason from platform.task_control_records order by reason`;
			expect(controls).toHaveLength(2);
			expect(
				await taskStore.recordControl({
					...controlRequest,
					reason: "recovery",
				}),
			).toEqual(originalControl);
			expect(
				(
					await sql`select revoked_at from platform.task_authorization_records where id='original-authorization'`
				)[0]?.revoked_at,
			).toBeInstanceOf(Date);
			expect(
				await sql`select action from platform.audit_events where action='task.control.promoted'`,
			).toHaveLength(reason === "stop" ? 1 : 0);
			const promoted = await h.authorize();
			await h.runtime.runtimeHost.acknowledge?.({
				...h.events(promoted),
				confirmedCursor: terminal.value.cursor,
			});
			expect(
				JSON.parse(await readFile(storePath, "utf8")).sessions[
					accepted.hostSessionRef
				].executionAuthorities.execution.control,
			).toEqual({
				controlRecordId: originalControl.controlRecordId,
				reason,
			});
			expect(
				await sql`select id,reason from platform.task_control_records order by reason`,
			).toEqual(controls);
			await expect(
				taskStore.recordControl({
					...controlRequest,
					executionId: "other-execution",
					reason: "recovery",
				}),
			).rejects.toThrow("Task authorization persistence is unavailable");
		} finally {
			h.runtime.close();
			await host?.close();
			await eventTransaction.close();
			await taskStore.close();
			await sql.end();
			await database.stop();
			await rm(directory, { recursive: true, force: true });
		}
	},
	120_000,
);
