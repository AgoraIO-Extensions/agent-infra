import { createHash } from "node:crypto";
import {
	nativeCapabilityAdmissionRequestDigestV6,
	nativeCapabilityOperationDigestV6,
	parseNativeCapabilityAdmissionRequestV6,
} from "@agent-infra/platform-core";
import { beforeEach, expect, it, vi } from "vitest";
import { PostgresConversationExecutionTransactionV1 } from "./conversation-execution.js";
import type { Transaction } from "./conversation-execution-common.js";

const sql = vi.hoisted(() => ({
	lockConversation: vi.fn(),
	readIdempotency: vi.fn(),
	readMessageState: vi.fn(),
}));
vi.mock("./conversation-execution-sql.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./conversation-execution-sql.js")>()),
	...sql,
}));

const request = {
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

function validPlan() {
	const parsed = parseNativeCapabilityAdmissionRequestV6(request);
	const authority = {
		agentId: "agent-1",
		actorId: "alice",
		channelId: "web",
		authorizationRevision: "auth-1",
		sessionGeneration: 1,
		hostSessionRef: "session-1",
	};
	const requestDigest = nativeCapabilityAdmissionRequestDigestV6(parsed);
	const operationDigest = nativeCapabilityOperationDigestV6(request);
	const plan = {
		schemaVersion: 2 as const,
		kind: "native-capability" as const,
		conversationId: parsed.conversationId,
		agentId: authority.agentId,
		actorId: authority.actorId,
		channelId: authority.channelId,
		executionId: parsed.idempotencyKey,
		turnId: "turn-1",
		sessionGeneration: authority.sessionGeneration,
		authorizationRevision: authority.authorizationRevision,
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
			ciphertextRef: "ciphertext-1",
			version: 1,
		},
		executionStatus: "submitted" as const,
		outbox: {
			id: `conversation:native-capability:${parsed.idempotencyKey}`,
			operation: "conversation.native-capability.invoke.v2" as const,
			payload: parsed,
		},
		requestDigest,
		operationDigest,
	};
	return {
		authority,
		plan,
		input: { request: parsed, authority, requestDigest, operationDigest },
	};
}

beforeEach(() => vi.clearAllMocks());

function replayHarness() {
	const value = validPlan();
	const saved = structuredClone(value.plan);
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
	const store = new PostgresConversationExecutionTransactionV1({
		transaction: transaction as unknown as Transaction,
	});
	return {
		saved,
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
it.each(["keyVersion", "keyReference", "turn", "operationDigest"])(
	"rejects same-key %s drift instead of returning a new plan",
	async (drift) => {
		const h = replayHarness();
		if (drift === "keyVersion") h.input.plan.keyBinding.version += 1;
		if (drift === "keyReference")
			h.input.plan.keyBinding.ciphertextRef = "different-key";
		if (drift === "turn") h.input.plan.turnId = "different-turn";
		if (drift === "operationDigest") {
			h.input.operationDigest = "f".repeat(64);
			h.input.plan.operationDigest = h.input.operationDigest;
		}
		expect(await h.store.admitNativeCapabilityV6(h.input)).toEqual({
			outcome: "conflict",
			reason: "idempotency_conflict",
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
