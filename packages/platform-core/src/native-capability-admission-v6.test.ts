import { createHash } from "node:crypto";
import {
	type RuntimeNativeCapabilityRequestV6,
	runtimeOperationDigestV6,
} from "@agent-infra/contracts/runtime";

import { expect, it, vi } from "vitest";

import {
	createNativeCapabilityAdmissionUseCaseV6,
	type NativeCapabilityAdmissionTransactionPortV6,
	type NativeCapabilityAdmissionV6AuthorityBinding,
	type NativeCapabilityAdmissionV6KeyBinding,
	nativeCapabilityAdmissionRequestDigestV6,
	nativeCapabilityOperationDigestV6,
	parseNativeCapabilityAdmissionRequestV6 as parseProjection,
	validateNativeCapabilityInvocationPlanV6,
} from "./native-capability-admission-v6.js";

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

it("projects V6 request into a Store admission input with frozen selection/config", () => {
	const parsed = parseNativeCapabilityAdmissionRequestV6(request);
	expect(parsed).toMatchObject({
		schemaVersion: 6,
		modelOptionId: "model-option-primary",
		reasoningLevel: "high",
		configVersion: "configuration-1",
	});
	expect(nativeCapabilityAdmissionRequestDigestV6(parsed)).toBe(
		nativeCapabilityAdmissionRequestDigestV6(parsed),
	);
});

it.each([
	"selection",
	"configVersion",
	"capabilityId",
	"directoryRevision",
	"parametersDigest",
	"parameters",
])("rejects a V6 request missing %s before Store admission", (field) => {
	const value = { ...request } as Record<string, unknown>;
	delete value[field];
	expect(() => parseNativeCapabilityAdmissionRequestV6(value)).toThrow();
});

it("rejects a valid-looking but incorrect parameters digest", () => {
	const value = { ...request, parametersDigest: "a".repeat(64) };
	expect(() => parseNativeCapabilityAdmissionRequestV6(value)).toThrow();
});

it("changes operation identity when frozen selection or Key binding changes", () => {
	const first = nativeCapabilityOperationDigestV6(request);
	expect(
		nativeCapabilityOperationDigestV6({
			...request,
			selection: { ...request.selection, reasoningLevel: "low" },
		}),
	).not.toBe(first);
	expect(
		nativeCapabilityOperationDigestV6({
			...request,
			keyBinding: { ...request.keyBinding, version: 2 },
		}),
	).not.toBe(first);
});

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
	const runtimeRequest: RuntimeNativeCapabilityRequestV6 =
		structuredClone(request);
	const parsed = parseNativeCapabilityAdmissionRequestV6(request);
	const authority = {
		conversationId: request.conversationId,
		principal: { ...request.principal, id: String(request.principal.id) },
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

it("accepts a fully frozen V6 plan at the Store seam", () => {
	const value = validPlan();
	expect(() =>
		validateNativeCapabilityInvocationPlanV6(value.plan, value.input),
	).not.toThrow();
});

it.each(["selection", "configVersion", "keyBinding", "authority", "outbox"])(
	"rejects V6 plan drift in %s before persistence",
	(field) => {
		const value = validPlan();
		const changed = structuredClone(value.plan) as typeof value.plan;
		if (field === "selection") changed.modelOptionId = "model-option-other";
		if (field === "configVersion")
			changed.configVersion = "configuration-other";
		if (field === "keyBinding") changed.keyBinding.version = 2;
		if (field === "authority") changed.actorId = "bob";
		if (field === "outbox")
			changed.outbox.payload = {
				...changed.outbox.payload,
				parameters: "drift",
			};
		expect(() =>
			validateNativeCapabilityInvocationPlanV6(changed, value.input),
		).toThrow("Native V6 admission plan is invalid");
	},
);

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function admissionHarness() {
	const authority: Mutable<NativeCapabilityAdmissionV6AuthorityBinding> = {
		...validPlan().authority,
		conversationId: request.conversationId,
		principal: { ...request.principal },
		executionSource: request.executionSource,
	};
	const keyBinding: Mutable<NativeCapabilityAdmissionV6KeyBinding> = {
		...request.keyBinding,
		version: Number(request.keyBinding.version),
	};
	const transaction = {
		admitNativeCapabilityV6: vi.fn<
			NativeCapabilityAdmissionTransactionPortV6["admitNativeCapabilityV6"]
		>(async () => ({ outcome: "busy" as const })),
	};
	const taskAuthority = validPlan().input.taskAuthority;
	const authorization = {
		authorize: vi.fn(async () => ({
			outcome: "allowed" as const,
			taskAuthority,
			authority,
			keyBinding,
		})),
	};
	const internal = createNativeCapabilityAdmissionUseCaseV6({
		authorization,
		transaction,
	});
	return {
		authority,
		keyBinding,
		transaction,
		taskAuthority,
		authorization,
		useCase: {
			admit: (value: unknown, invocation = publicInvocation(value)) =>
				internal.admit(value, invocation),
		},
	};
}
it.each([
	"principal",
	"agentId",
	"channelId",
	"hostSessionRef",
	"keyReference",
	"keyVersion",
	"executionSource",
])("refuses %s request drift before calling the transaction", async (field) => {
	const h = admissionHarness();
	const changed = structuredClone(request) as Record<string, unknown>;
	if (field === "principal") changed.principal = { kind: "user", id: "bob" };
	else if (field === "keyReference")
		changed.keyBinding = { ...request.keyBinding, ciphertextRef: "other-key" };
	else if (field === "keyVersion")
		changed.keyBinding = { ...request.keyBinding, version: 2 };
	else if (field === "executionSource") changed.executionSource = "eval";
	else changed[field] = "different-scope";
	expect(await h.useCase.admit(changed)).toEqual({
		outcome: "denied",
		reason: "authorization_lost",
	});
	expect(h.transaction.admitNativeCapabilityV6).not.toHaveBeenCalled();
});
it("does not share mutable authorization Key objects with the transaction plan", async () => {
	const h = admissionHarness();
	await h.useCase.admit(request);
	const sent = h.transaction.admitNativeCapabilityV6.mock.calls[0]?.[0];
	expect(sent).toBeDefined();
	h.keyBinding.version = 2;
	expect(sent?.plan.keyBinding.version).toBe(1);
	expect(Object.isFrozen(sent?.plan.keyBinding)).toBe(true);
});

it.each(["requestDigest", "operationDigest"] as const)(
	"recomputes %s rather than trusting matching caller strings",
	(field) => {
		const h = validPlan();
		h.plan[field] = "f".repeat(64);
		h.input[field] = h.plan[field];
		h.plan.outbox.payload[field] = h.plan[field];
		expect(() =>
			validateNativeCapabilityInvocationPlanV6(h.plan, h.input),
		).toThrow();
	},
);
it("stores every frozen binding in the outbox without the transport Grant", async () => {
	const h = admissionHarness();
	await h.useCase.admit(request);
	const sent = h.transaction.admitNativeCapabilityV6.mock.calls[0]?.[0];
	if (!sent) throw new Error("missing transaction input");
	const { outbox, ...binding } = sent.plan;
	expect(outbox.payload).toEqual({
		...binding,
		requestId: request.requestId,
		traceId: request.traceId,
		idempotencyKey: publicInvocation().idempotencyKey,
	});
	expect(outbox.payload).toMatchObject({
		principal: request.principal,
		executionSource: "web",
		operation: request.operation,
		keyBinding: request.keyBinding,
		turnId: request.turnId,
		hostSessionRef: request.hostSessionRef,
	});
	expect(outbox.payload).not.toHaveProperty("grant");
	expect(JSON.stringify(outbox.payload)).not.toContain(request.grant.token);
	expect(Object.isFrozen(outbox.payload)).toBe(true);
});

it("denies a source inconsistent with the authorized channel even when the request agrees", async () => {
	const h = admissionHarness();
	h.authority.executionSource = "eval";
	expect(
		await h.useCase.admit({ ...request, executionSource: "eval" }),
	).toEqual({ outcome: "denied", reason: "authorization_lost" });
	expect(h.transaction.admitNativeCapabilityV6).not.toHaveBeenCalled();
});
it("does not charge a Web command to the Agent default Key", async () => {
	const h = admissionHarness();
	h.keyBinding.purpose = "agent-default";
	h.keyBinding.subjectId = request.agentId;
	expect(
		await h.useCase.admit({ ...request, keyBinding: h.keyBinding }),
	).toEqual({ outcome: "denied", reason: "authorization_lost" });
	expect(h.transaction.admitNativeCapabilityV6).not.toHaveBeenCalled();
});

it("keeps V6 idempotency stable when only request/trace IDs change", () => {
	const first = parseNativeCapabilityAdmissionRequestV6(request);
	const retry = parseNativeCapabilityAdmissionRequestV6({
		...request,
		requestId: "retry-request",
		traceId: "retry-trace",
	});
	expect(nativeCapabilityAdmissionRequestDigestV6(retry)).toBe(
		nativeCapabilityAdmissionRequestDigestV6(first),
	);
});
it.each(["agentId", "principal", "sessionGeneration"])(
	"binds %s to the admission digest",
	(field) => {
		const changed = {
			...request,
			[field]:
				field === "principal"
					? { kind: "user", id: "bob" }
					: field === "sessionGeneration"
						? 2
						: "other-agent",
		};
		expect(
			nativeCapabilityAdmissionRequestDigestV6(
				parseNativeCapabilityAdmissionRequestV6(changed),
			),
		).not.toBe(
			nativeCapabilityAdmissionRequestDigestV6(
				parseNativeCapabilityAdmissionRequestV6(request),
			),
		);
	},
);

it("rejects undeclared plan fields even when duplicated into the outbox", () => {
	const h = validPlan();
	const injected = {
		...h.plan,
		grant: { token: "unwanted-transport-token" },
		outbox: {
			...h.plan.outbox,
			payload: {
				...h.plan.outbox.payload,
				grant: { token: "unwanted-transport-token" },
			},
		},
	};
	expect(() =>
		validateNativeCapabilityInvocationPlanV6(injected, h.input),
	).toThrow();
});

it("binds admission to public input instead of newly allocated operation or resolved config", () => {
	const retry = {
		...request,
		executionId: "retry-execution",
		turnId: "retry-turn",
		operation: { ...request.operation, id: "retry-execution" },
		configVersion: "configuration-2",
		capabilitySourceVersion: "0.154.0",
		keyBinding: { ...request.keyBinding, version: 2 },
	};
	expect(
		nativeCapabilityAdmissionRequestDigestV6(
			parseNativeCapabilityAdmissionRequestV6(retry),
		),
	).toBe(
		nativeCapabilityAdmissionRequestDigestV6(
			parseNativeCapabilityAdmissionRequestV6(request),
		),
	);
	expect(nativeCapabilityOperationDigestV6(retry)).not.toBe(
		nativeCapabilityOperationDigestV6(request),
	);
});

it.each([
	{ conversationId: "other-conversation" },
	{ capabilityId: "a".repeat(64) },
	{ directoryRevision: "a".repeat(64) },
	{ parameters: "different" },
	{ selection: { ...request.selection, reasoningLevel: "low" } },
	{ executionId: "caller-execution" },
])(
	"rejects public input that differs from the prepared binding %j",
	async (change) => {
		const h = admissionHarness();
		await expect(
			h.useCase.admit(request, { ...publicInvocation(), ...change }),
		).rejects.toThrow();
		expect(h.transaction.admitNativeCapabilityV6).not.toHaveBeenCalled();
	},
);

it("prepares an unsigned plan whose operation digest matches the signed Runtime V6 contract", async () => {
	const { grant: _grant, ...unsigned } = request;
	const h = admissionHarness();
	await h.useCase.admit(unsigned);
	const sent = h.transaction.admitNativeCapabilityV6.mock.calls[0]?.[0];
	expect(sent?.runtimeRequest).not.toHaveProperty("grant");
	expect(sent?.plan.operationDigest).toBe(
		await runtimeOperationDigestV6(request),
	);
});

it("requires an explicit public invocation instead of deriving its idempotency key from an Execution", () => {
	expect(() => parseProjection(request, undefined)).toThrow();
});

it("denies V6 admission without a typed Task authorization boundary", async () => {
	const h = admissionHarness();
	Reflect.deleteProperty(h.taskAuthority, "taskBoundary");
	expect(await h.useCase.admit(request)).toEqual({
		outcome: "denied",
		reason: "authorization_lost",
	});
	expect(h.transaction.admitNativeCapabilityV6).not.toHaveBeenCalled();
});

it("denies a valid Task authority for another principal before transaction access", async () => {
	const h = admissionHarness();
	h.taskAuthority.actorId = "other-user";
	h.taskAuthority.taskBoundary.principal.id = "other-user";
	h.taskAuthority.taskBoundary.accessSources = [
		{ kind: "user", userId: "other-user" },
	];
	expect(await h.useCase.admit(request)).toEqual({
		outcome: "denied",
		reason: "authorization_lost",
	});
	expect(h.transaction.admitNativeCapabilityV6).not.toHaveBeenCalled();
});

it("freezes the accepted Task boundary and revalidates current authority inside the Store callback", async () => {
	const h = admissionHarness();
	await h.useCase.admit(request);
	const [sent, isAuthorized] =
		h.transaction.admitNativeCapabilityV6.mock.calls[0] ?? [];
	if (!sent || !isAuthorized)
		throw new Error("missing transaction authorization");
	expect(await isAuthorized()).toBe(true);
	h.taskAuthority.taskBoundary.identityRevision = "revoked";
	expect(await isAuthorized()).toBe(false);
	expect(sent.plan.taskBoundary.identityRevision).toBe("identity-1");
	expect(Object.isFrozen(sent.plan.taskBoundary)).toBe(true);
	h.authorization.authorize.mockRejectedValueOnce(
		new Error("authority unavailable"),
	);
	expect(await isAuthorized()).toBe(false);
});
