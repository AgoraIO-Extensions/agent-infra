import { generateKeyPairSync } from "node:crypto";
import type {
	AgentConfigurationRecordV2,
	AgentManagementStateV1,
	ConversationDispatchClaimV1,
	ConversationRuntimeDispatchRequestV1,
	ConversationRuntimeEventRequestV1,
	CurrentTaskUserV1,
	TaskRuntimeAuthorizationRecordV1,
	WorkloadReconciliationStateV1,
} from "@agent-infra/platform-core";
import type { RelayKeyWorkerDecryptorV1 } from "@agent-infra/secret-store/worker";
import { vi } from "vitest";
import {
	type ConversationRuntimeStateV2,
	createConversationRuntimeV2,
} from "../conversation-runtime.js";
import { createWorkerRuntimeGrantSignerV4 } from "../runtime-grant-signer-v4.js";
import type {
	WorkerAcceptedExecutionV4,
	WorkerExecutionKeyReaderV4,
} from "../runtime-host-client.js";

export const keySentinel = "synthetic-original-execution-key-v1";
export const time = 1_800_000_000_000;
export const signingKeys = generateKeyPairSync("ed25519");
export const signing = {
	issuer: "platform",
	workerId: "transport",
	keyId: "signing",
	privateKey: signingKeys.privateKey,
	now: () => time,
};
export const grantSigner = createWorkerRuntimeGrantSignerV4(signing);
export function runtimeV4Harness(
	operation: "submit" | "supplement" = "submit",
) {
	let clock = time;
	const instanceSigning = { ...signing, now: () => clock };
	const claim: ConversationDispatchClaimV1 = {
		schemaVersion: 1,
		itemId: "item",
		leaseOwner: "instance",
		operation:
			operation === "submit"
				? "conversation.turn.submit.v1"
				: "conversation.turn.supplement.v1",
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
		executionSource: "web",
		relayKeyBinding: {
			purpose: "personal",
			subjectId: "user",
			keyId: "key-original",
			keyVersion: 1,
		},
		hostSessionRef: "host",
		runtimeCursor: null,
		input: { text: "original accepted input", attachments: [] },
		executionStatus: "processing",
		stopPending: false,
	};
	const state: ConversationRuntimeStateV2 = {
		hostSessionRef: "host",
		originalSubmitHostSessionRef: null,
		runtimeSubmitProtocol: "v4",
		runtimeCursor: null,
		originalOperationDigest: "a".repeat(43),
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
	let record: TaskRuntimeAuthorizationRecordV1 = {
		authorizationRecordId: "authorization",
		executionId: "execution",
		revokedAt: null,
		boundary: {
			schemaVersion: 1,
			principal: { kind: "user", id: "user" },
			agentId: "agent",
			channelId: "web",
			identityRevision: "identity-7",
			agentAuthorizationRevision: "agent-7",
			accessSources: [{ kind: "organization", organizationId: "team" }],
		},
		agent,
		configurationRevision: 1,
		workload,
	};
	let user: CurrentTaskUserV1 | null = {
		schemaVersion: 1,
		userId: "user",
		accountStatus: "active",
		organizationIds: ["team"],
		authorizationRevision: "identity-8",
	};
	let accepted: WorkerAcceptedExecutionV4 | null = {
		scope: {
			principal: { kind: "user", id: "user" },
			executionSource: "web",
			channelId: "web",
			agentId: "agent",
			conversationId: "conversation",
			executionId: "execution",
			turnId: "turn",
			sessionGeneration: 1,
			hostSessionRef: null,
			keyBinding: {
				purpose: "personal",
				subjectId: "user",
				ciphertextRef: "key-original",
				version: 1,
			},
		},
		trustedHostSessionRef: operation === "submit" ? null : "host",
		authorizationRecordId: "authorization",
		selection: {
			schemaVersion: 1,
			modelOptionId: "option",
			reasoningLevel: "high",
		},
	};
	const directory = { resolveUser: vi.fn(async () => user) };
	const dispatchStore = {
		readRuntimeState: vi.fn(
			async () => state as ConversationRuntimeStateV2 | null,
		),
	};
	const taskAuthorizationStore = {
		readExecution: vi.fn(async () => record),
		recordControl: vi.fn(async (input: { reason: string }) => {
			if (input.reason === "authorization_revoked") {
				record = { ...record, revokedAt: new Date(time) };
				Object.assign(state, { stopPending: true });
			}
			return { controlRecordId: `control-${input.reason}` };
		}),
	};
	const executionKeys = {
		readAcceptedExecution: vi.fn<
			WorkerExecutionKeyReaderV4["readAcceptedExecution"]
		>(async () => (accepted ? structuredClone(accepted) : null)),
		readCiphertext: vi.fn<WorkerExecutionKeyReaderV4["readCiphertext"]>(
			async () => ({ opaque: "encrypted-original" }),
		),
	};
	const plaintexts: Uint8Array[] = [];
	const relayKeyDecryptor = {
		decrypt: vi.fn<RelayKeyWorkerDecryptorV1["decrypt"]>(async () => {
			const plaintext = new TextEncoder().encode(keySentinel);
			plaintexts.push(plaintext);
			return { outcome: "decrypted" as const, plaintext };
		}),
	};
	const target = {
		baseUrl: "https://runtime.test",
		serviceToken: "synthetic-service-token",
		workerId: "transport",
	};
	const resolveRuntimeHost = vi.fn(async () => ({ ...target }));
	const fetcher = vi.fn<typeof fetch>(async (url, init) => {
		const body = JSON.parse(init?.body as string);
		if (String(url).endsWith("/events/read"))
			return Response.json({
				schemaVersion: 4,
				hostSessionRef: "host",
				executionId: "execution",
				events: [],
			});
		if (String(url).endsWith("/events/ack"))
			return Response.json({
				schemaVersion: body.schemaVersion,
				executionId: "execution",
				confirmedCursor: body.confirmedCursor,
			});
		if (String(url).endsWith("/original-binding"))
			return Response.json({
				schemaVersion: 3,
				executionId: "execution",
				hostSessionRef: "host",
				outcome: "binding_found",
			});
		if (String(url).endsWith("/authorizations/renew"))
			return Response.json({
				schemaVersion: 3,
				executionId: "execution",
				expiresAt: clock + 30_000,
			});
		if (String(url).endsWith("/status"))
			return Response.json({
				schemaVersion: 3,
				executionId: "execution",
				hostSessionRef: "host",
				outcome: "found",
				status: "running",
			});
		const request = body.businessRequest ?? body;
		return Response.json({
			schemaVersion: body.businessRequest ? 4 : 3,
			hostSessionRef: "host",
			operationId: request.operation.id,
			result: { outcome: "accepted", status: "running" },
		});
	});
	const options = {
		workerId: "instance",
		signing: instanceSigning,
		directory,
		taskAuthorizationStore,
		dispatchStore,
		channelAuthorizationCurrent: async (
			value: TaskRuntimeAuthorizationRecordV1,
		) => value.boundary.channelId === "web",
		resolveRuntimeHost,
		executionKeys,
		relayKeyDecryptor,
		fetch: fetcher,
		reconnectDelayMs: 1,
	};
	const runtime = createConversationRuntimeV2(options);
	function request(
		runtimeGrant: unknown,
	): ConversationRuntimeDispatchRequestV1 {
		const base = {
			schemaVersion: 1 as const,
			requestId: "request",
			traceId: "trace",
			agentId: "agent",
			actorId: "user",
			channelId: "web",
			conversationId: "conversation",
			executionId: "execution",
			turnId: "turn",
			sessionGeneration: 1,
			deliveryFence: 2,
			runtimeGrant,
			hostSessionRef: "host",
		};
		return operation === "submit"
			? {
					...base,
					operation: "turn.submit",
					input: claim.input ?? { text: "", attachments: [] },
				}
			: {
					...base,
					operation: "turn.supplement",
					messageId: "message",
					executionDeliveryFence: 2,
					input: claim.input ?? { text: "", attachments: [] },
				};
	}
	function events(runtimeGrant: unknown): ConversationRuntimeEventRequestV1 {
		return {
			schemaVersion: 1,
			requestId: "request",
			traceId: "trace",
			agentId: "agent",
			actorId: "user",
			channelId: "web",
			conversationId: "conversation",
			executionId: "execution",
			turnId: "turn",
			sessionGeneration: 1,
			deliveryFence: 2,
			hostSessionRef: "host",
			runtimeGrant,
		};
	}
	async function authorize() {
		const decision = await runtime.authorization.authorize({ ...claim, claim });
		if (decision.outcome !== "allowed")
			throw new Error(`Fixture authorization ${decision.outcome}`);
		return decision.authority.runtimeGrant;
	}
	function sent(index = -1) {
		const [url, init] = fetcher.mock.calls.at(index) ?? [];
		return { url: String(url), init, body: JSON.parse(init?.body as string) };
	}
	return {
		claim,
		state,
		agent,
		workload,
		options,
		runtime,
		directory,
		dispatchStore,
		taskAuthorizationStore,
		executionKeys,
		relayKeyDecryptor,
		plaintexts,
		resolveRuntimeHost,
		target,
		fetcher,
		request,
		events,
		authorize,
		sent,
		setNow: (next: number) => {
			clock = next;
		},
		setUser: (next: CurrentTaskUserV1 | null) => {
			user = next;
		},
		record: () => record,
		setRecord: (next: TaskRuntimeAuthorizationRecordV1) => {
			record = next;
		},
		accepted: () => accepted,
		setAccepted: (next: WorkerAcceptedExecutionV4 | null) => {
			accepted = next;
		},
	};
}
