import { createHash } from "node:crypto";
import {
	nativeCapabilityAdmissionRequestDigestV6,
	nativeCapabilityOperationDigestV6,
	parseNativeCapabilityAdmissionRequestV6 as parseProjection,
} from "@agent-infra/platform-core";
import { beforeEach, expect, it, vi } from "vitest";
import type { RuntimeNativeCapabilityRequestV6 } from "../../contracts/src/runtime/host-v6.js";
import { RuntimeNativeCapabilityRequestV6Schema } from "../../contracts/src/runtime/host-v6.js";
import { PostgresConversationExecutionTransactionV1 } from "./conversation-execution.js";
import type { Transaction } from "./conversation-execution-common.js";

const sql = vi.hoisted(() => ({
	lockConversation: vi.fn(),
	lockAgentConfiguration: vi.fn(),
	readIdempotency: vi.fn(),
	readMessageState: vi.fn(),
}));
vi.mock("./conversation-execution-sql.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./conversation-execution-sql.js")>()),
	...sql,
}));

const signedRequest = {
	schemaVersion: 6,
	requestId: "request-1",
	traceId: "trace-1",
	principal: { kind: "user", id: "alice" },
	executionSource: "web",
	channelId: "web",
	agentId: "agent-1",
	conversationId: "conversation-1",
	executionId: "execution-1",
	turnId: "turn-1",
	sessionGeneration: 1,
	hostSessionRef: "session-1",
	operation: {
		kind: "execution",
		id: "execution-1",
		deliveryFence: 2,
		executionDeliveryFence: 2,
	},
	grant: { schemaVersion: 6, format: "runtime-execution-jws", token: "a.b.c" },
	keyBinding: {
		purpose: "personal",
		subjectId: "alice",
		ciphertextRef: "key-1",
		version: 1,
	},
	capabilityId: "c".repeat(64),
	capabilityKind: "command",
	directoryRevision: "d".repeat(64),
	parameters: "compact",
	parametersDigest: createHash("sha256").update("compact").digest("hex"),
	capabilitySourceVersion: "0.153.0",
	selection: {
		schemaVersion: 1,
		modelOptionId: "model-option-primary",
		reasoningLevel: "high",
	},
	configVersion: "configuration-1",
} as const;

RuntimeNativeCapabilityRequestV6Schema.parse(signedRequest);
const { grant: _grant, ...unsignedRequest } = signedRequest;
const request = unsignedRequest as any;

function publicInvocation(
	input: unknown = request,
	idempotencyKey = "public-invocation-1",
) {
	const value = input as RuntimeNativeCapabilityRequestV6;
	return {
		schemaVersion: 3 as const,
		conversationId: value.conversationId,
		capabilityId: value.capabilityId,
		directoryRevision: value.directoryRevision,
		parameters: value.parameters,
		selection: value.selection,
		idempotencyKey,
		requestId: value.requestId,
		traceId: value.traceId,
	};
}
function parseNativeCapabilityAdmissionRequestV6(input: unknown) {
	return parseProjection(input, publicInvocation(input));
}

function validPlan() {
	const runtimeRequest = structuredClone(request);
	const parsed = parseNativeCapabilityAdmissionRequestV6(request);
	const authority = {
		conversationId: request.conversationId,
		principal: { ...request.principal },
		executionSource: request.executionSource,
		agentId: "agent-1",
		actorId: "alice",
		channelId: "web",
		authorizationRevision: "auth-1",
		sessionGeneration: 1,
		hostSessionRef: "session-1",
	};
	const taskAuthority = {
		schemaVersion: 1 as const,
		actorId: authority.actorId,
		agentId: authority.agentId,
		channelId: authority.channelId,
		authorizationRevision: authority.authorizationRevision,
		supportsSupplementaryInstruction: false,
		taskBoundary: {
			schemaVersion: 1 as const,
			principal: authority.principal,
			agentId: authority.agentId,
			channelId: authority.channelId,
			identityRevision: "identity-1",
			agentAuthorizationRevision: authority.authorizationRevision,
			accessSources: [{ kind: "user" as const, userId: authority.actorId }],
		},
	};
	const requestDigest = nativeCapabilityAdmissionRequestDigestV6(parsed);
	const operationDigest = nativeCapabilityOperationDigestV6(request);
	const binding = {
		schemaVersion: 2 as const,
		kind: "native-capability" as const,
		conversationId: parsed.conversationId,
		agentId: authority.agentId,
		actorId: authority.actorId,
		principal: { ...request.principal },
		executionSource: request.executionSource,
		operation: { ...request.operation },
		channelId: authority.channelId,
		executionId: runtimeRequest.executionId,
		turnId: "turn-1",
		sessionGeneration: authority.sessionGeneration,
		authorizationRevision: authority.authorizationRevision,
		taskBoundary: taskAuthority.taskBoundary,
		hostSessionRef: authority.hostSessionRef,
		capabilityId: parsed.capabilityId,
		directoryRevision: parsed.directoryRevision,
		capabilitySourceVersion: parsed.capabilitySourceVersion,
		parameters: parsed.parameters,
		parametersDigest: parsed.parametersDigest,
		modelOptionId: parsed.modelOptionId,
		reasoningLevel: parsed.reasoningLevel,
		configVersion: parsed.configVersion,
		keyBinding: {
			purpose: "personal" as const,
			subjectId: authority.actorId,
			ciphertextRef: request.keyBinding.ciphertextRef as string,
			version: 1,
		},
		modelConfigurationRevision: 1,
		executionStatus: "submitted" as const,
		requestDigest,
		operationDigest,
	};
	const plan = {
		...binding,
		outbox: {
			id: `conversation:native-capability:${runtimeRequest.executionId}`,
			operation: "conversation.native-capability.invoke.v2" as const,
			payload: {
				...binding,
				requestId: parsed.requestId,
				traceId: parsed.traceId,
				idempotencyKey: parsed.idempotencyKey,
			},
		},
	};
	return {
		authority,
		plan,
		input: {
			modelConfigurationRevision: 1,
			taskAuthority,
			invocation: publicInvocation(runtimeRequest),
			runtimeRequest,
			keyBinding: structuredClone(binding.keyBinding),
			request: parsed,
			authority,
			requestDigest,
			operationDigest,
		},
	};
}

beforeEach(() => vi.clearAllMocks());

function replayHarness() {
	const value = validPlan();
	const saved = structuredClone(value.plan);
	sql.lockAgentConfiguration.mockResolvedValue({
		authorizationRevision: value.authority.authorizationRevision,
	});
	sql.lockConversation.mockResolvedValue({
		...value.authority,
		conversationId: value.plan.conversationId,
	});
	sql.readIdempotency.mockResolvedValue({
		request_digest: saved.requestDigest,
		status: "completed",
		result: { plan: saved },
	});
	const transaction = vi.fn(async () => {
		throw new Error("unexpected SQL mutation");
	});
	const internalStore = new PostgresConversationExecutionTransactionV1({
		transaction: transaction as unknown as Transaction,
	});
	const authorize = vi.fn(async () => true);
	const store = {
		admitNativeCapabilityV6: (
			input: Parameters<
				PostgresConversationExecutionTransactionV1["admitNativeCapabilityV6"]
			>[0],
		) => internalStore.admitNativeCapabilityV6(input, authorize),
	};
	return {
		saved,
		authorize,
		store,
		transaction,
		input: {
			...value.input,
			plan: value.plan,
			keyBinding: value.plan.keyBinding,
		},
	};
}

it("returns the saved plan as an independent copy on a same-key replay", async () => {
	const h = replayHarness();
	const result = await h.store.admitNativeCapabilityV6(h.input);
	expect(result).toEqual({ outcome: "replayed", plan: h.saved });
	if (result.outcome !== "replayed") throw new Error("replay expected");
	expect(result.plan).not.toBe(h.input.plan);
	expect(result.plan).not.toBe(h.saved);
	expect(h.transaction).not.toHaveBeenCalled();
	expect(sql.readMessageState).not.toHaveBeenCalled();
});

it("denies replay when the in-transaction authorization recheck is revoked", async () => {
	const h = replayHarness();
	h.authorize.mockResolvedValue(false);
	expect(await h.store.admitNativeCapabilityV6(h.input)).toEqual({
		outcome: "denied",
		reason: "authorization_lost",
	});
	expect(sql.readIdempotency).not.toHaveBeenCalled();
	expect(h.transaction).not.toHaveBeenCalled();
});
it.each(["keyVersion", "keyReference", "turn"])(
	"replays the saved binding when a new candidate changes %s",
	async (drift) => {
		const h = replayHarness();
		if (drift === "keyVersion") {
			h.input.plan.keyBinding.version += 1;
			h.input.runtimeRequest = {
				...request,
				keyBinding: h.input.plan.keyBinding,
			};
		}
		if (drift === "keyReference") {
			h.input.plan.keyBinding.ciphertextRef = "different-key";
			h.input.runtimeRequest = {
				...request,
				keyBinding: h.input.plan.keyBinding,
			};
		}
		if (drift === "turn") {
			h.input.plan.turnId = "different-turn";
			h.input.runtimeRequest = {
				...request,
				turnId: "different-turn",
			};
		}
		h.input.operationDigest = nativeCapabilityOperationDigestV6(
			h.input.runtimeRequest,
		);
		h.input.plan.operationDigest = h.input.operationDigest;
		h.input.plan.outbox.payload = {
			...h.input.plan.outbox.payload,
			keyBinding: h.input.plan.keyBinding,
			turnId: h.input.plan.turnId,
			operationDigest: h.input.operationDigest,
		};
		expect(await h.store.admitNativeCapabilityV6(h.input)).toEqual({
			outcome: "replayed",
			plan: h.saved,
		});
		expect(h.transaction).not.toHaveBeenCalled();
	},
);
it("does not synthesize a replay when the saved envelope is missing its plan", async () => {
	const h = replayHarness();
	sql.readIdempotency.mockResolvedValue({
		request_digest: h.saved.requestDigest,
		status: "completed",
		result: {},
	});
	await expect(h.store.admitNativeCapabilityV6(h.input)).rejects.toThrow();
});

it.each([
	"actorId",
	"agentId",
	"channelId",
	"sessionGeneration",
	"hostSessionRef",
	"authorizationRevision",
])("denies replay when the locked Conversation changes %s", async (field) => {
	const h = replayHarness();
	sql.lockConversation.mockResolvedValue({
		...h.input.authority,
		conversationId: h.input.request.conversationId,
		[field]: field === "sessionGeneration" ? 2 : "different-scope",
	});
	expect(await h.store.admitNativeCapabilityV6(h.input)).toEqual({
		outcome: "denied",
		reason: "authorization_lost",
	});
	expect(sql.readIdempotency).not.toHaveBeenCalled();
	expect(h.transaction).not.toHaveBeenCalled();
});

it("keeps an unfinished reservation unavailable without writing or creating a plan", async () => {
	const h = replayHarness();
	sql.readIdempotency.mockResolvedValue({
		request_digest: h.saved.requestDigest,
		status: "reserved",
		result: null,
	});
	expect(await h.store.admitNativeCapabilityV6(h.input)).toEqual({
		outcome: "unavailable",
		reason: "idempotency_in_progress",
	});
	expect(h.transaction).not.toHaveBeenCalled();
});

it("rejects a forged operation digest before reading or mutating the database", async () => {
	const h = replayHarness();
	h.input.operationDigest = "f".repeat(64);
	h.input.plan.operationDigest = h.input.operationDigest;
	h.input.plan.outbox.payload.operationDigest = h.input.operationDigest;
	await expect(h.store.admitNativeCapabilityV6(h.input)).rejects.toThrow();
	expect(sql.lockConversation).not.toHaveBeenCalled();
	expect(h.transaction).not.toHaveBeenCalled();
});
it("snapshots the plan before the Conversation lock awaits", async () => {
	const h = replayHarness();
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	sql.lockConversation.mockImplementation(async () => {
		await gate;
		return { ...h.input.authority, conversationId: h.saved.conversationId };
	});
	const pending = h.store.admitNativeCapabilityV6(h.input);
	h.input.plan.keyBinding.version = 3;
	release();
	expect(await pending).toEqual({ outcome: "replayed", plan: h.saved });
	expect(h.transaction).not.toHaveBeenCalled();
});

it("replays the original correlation IDs for a retry with fresh request and trace IDs", async () => {
	const h = replayHarness();
	const runtimeRequest = {
		...request,
		requestId: "retry-request",
		traceId: "retry-trace",
	};
	const parsed = parseNativeCapabilityAdmissionRequestV6(runtimeRequest);
	const requestDigest = nativeCapabilityAdmissionRequestDigestV6(parsed);
	const input = {
		...h.input,
		invocation: publicInvocation(runtimeRequest),
		runtimeRequest,
		request: parsed,
		requestDigest,
		plan: {
			...h.input.plan,
			requestDigest,
			outbox: {
				...h.input.plan.outbox,
				payload: {
					...h.input.plan.outbox.payload,
					requestDigest,
					requestId: parsed.requestId,
					traceId: parsed.traceId,
				},
			},
		},
	};
	expect(await h.store.admitNativeCapabilityV6(input)).toEqual({
		outcome: "replayed",
		plan: h.saved,
	});
	expect(h.transaction).not.toHaveBeenCalled();
});
