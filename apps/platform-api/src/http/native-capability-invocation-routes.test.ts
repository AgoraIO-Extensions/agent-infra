import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import {
	type NativeCapabilityInvocationRouteDependenciesV1,
	registerNativeCapabilityInvocationRoutesV1,
} from "./native-capability-invocation-routes.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "user-native-capability",
	displayName: "Native Capability User",
	accountStatus: "active" as const,
	organizationIds: [],
	roles: ["employee" as const],
	authorizationRevision: "authorization-native-capability",
};

const body = {
	capabilityId: "a".repeat(64),
	directoryRevision: "b".repeat(64),
	parameters: "",
	idempotencyKey: "invoke-1",
	requestId: "request-native-capability",
	traceId: "trace-native-capability",
};

function app(
	overrides: Partial<NativeCapabilityInvocationRouteDependenciesV1> = {},
) {
	const dependencies: NativeCapabilityInvocationRouteDependenciesV1 = {
		identity: {
			resolve: async () => identity,
			hydrateUsers: async () => undefined,
		},
		buildRequest: async ({ conversationId }) =>
			({
				schemaVersion: 1,
				conversationId,
				capabilityId: body.capabilityId,
				directoryRevision: body.directoryRevision,
				parameters: body.parameters,
				idempotencyKey: body.idempotencyKey,
				requestId: body.requestId,
				traceId: body.traceId,
			}) as never,
		admit: async () =>
			({
				outcome: "accepted",
				result: {
					schemaVersion: 1,
					status: "submitted",
					conversationId: "conversation-native-capability",
					executionId: "execution-native-capability",
					capabilityId: body.capabilityId,
					capabilityKind: "skill",
					directoryRevision: body.directoryRevision,
				},
			}) as never,
		...overrides,
	};
	const hono = new Hono();
	registerNativeCapabilityInvocationRoutesV1(hono, dependencies);
	return hono;
}

it("resolves identity server-side and returns only the sanitized admission receipt", async () => {
	const response = await app({
		buildRequest: async (input) => {
			expect(input.identity.userId).toBe(identity.userId);
			expect(input.conversationId).toBe("conversation-native-capability");
			expect(input.body).toEqual({ ...body, schemaVersion: 1 });
			return {
				schemaVersion: 1,
				conversationId: input.conversationId,
				capabilityId: body.capabilityId,
				directoryRevision: body.directoryRevision,
				parameters: body.parameters,
				idempotencyKey: body.idempotencyKey,
				requestId: body.requestId,
				traceId: body.traceId,
			} as never;
		},
	}).request(
		"/api/v2/conversations/conversation-native-capability/native-capability/invoke",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	expect(response.status).toBe(202);
	expect(await response.json()).toEqual({
		outcome: "accepted",
		result: expect.objectContaining({ status: "submitted" }),
	});
});

it("rejects malformed input before admission", async () => {
	const admit = vi.fn();
	const response = await app({ admit }).request(
		"/api/v2/conversations/conversation/native-capability/invoke",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...body, capabilityId: "bad" }),
		},
	);
	expect(response.status).toBe(400);
	expect(admit).not.toHaveBeenCalled();
});

it("keeps invalid JSON a client error without calling admission", async () => {
	const admit = vi.fn();
	const response = await app({ admit }).request(
		"/api/v2/conversations/conversation/native-capability/invoke",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{",
		},
	);
	expect(response.status).toBe(400);
	expect(await response.json()).toEqual({ outcome: "invalid_parameters" });
	expect(admit).not.toHaveBeenCalled();
});

it.each(["admit", "admitWithIdentity"] as const)(
	"bounds ignored cancellation in %s and discards a late result",
	async (method) => {
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release!: () => void;
		const hold = new Promise<void>((resolve) => {
			release = resolve;
		});
		const admission = async () => {
			entered();
			await hold;
			return { outcome: "unavailable" as const };
		};
		const controller = new AbortController();
		const pending = app({ [method]: admission }).fetch(
			new Request(
				"http://native.invalid/api/v2/conversations/conversation/native-capability/invoke",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
					signal: controller.signal,
				},
			),
		);
		await started;
		controller.abort();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const early = await Promise.race([
			pending,
			new Promise<null>((resolve) => {
				timer = setTimeout(() => resolve(null), 200);
			}),
		]);
		if (timer) clearTimeout(timer);
		release();
		const response = early ?? (await pending);
		expect(
			early,
			"cancelled admission must not retain its original HTTP request",
		).not.toBeNull();
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ outcome: "unavailable" });
	},
);

it.each([
	["replayed", 202],
	["conflict", 409],
	["unavailable", 503],
] as const)(
	"maps %s admission outcomes to bounded HTTP responses",
	async (outcome, status) => {
		const response = await app({
			admit: async () => ({ outcome }) as never,
		}).request("/api/v2/conversations/conversation/native-capability/invoke", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({ outcome });
	},
);

it("admits Invocation V2 with the server-resolved ordered attachment ids", async () => {
	const files = ["file-native-a", "file-native-b"];
	const buildRequest = vi.fn<
		NativeCapabilityInvocationRouteDependenciesV1["buildRequest"]
	>(async ({ conversationId, body: value }) => ({
		...value,
		conversationId,
	}));
	const response = await app({
		buildRequest,
		admit: async (request) => {
			expect(request).toMatchObject({
				schemaVersion: 2,
				conversationId: "conversation-native-capability",
				attachments: files,
			});
			return { outcome: "accepted", result: {} } as never;
		},
	}).request(
		"/api/v2/conversations/conversation-native-capability/native-capability/invoke",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ ...body, schemaVersion: 2, attachments: files }),
		},
	);
	expect(response.status).toBe(202);
	expect(buildRequest).toHaveBeenCalledOnce();
});

it.each([
	["attachments without the V2 version", { ...body, attachments: ["file-a"] }],
	["an explicit V1 version", { ...body, schemaVersion: 1 }],
	[
		"more than four attachments",
		{ ...body, schemaVersion: 2, attachments: ["a", "b", "c", "d", "e"] },
	],
	["empty attachments", { ...body, schemaVersion: 2, attachments: [] }],
	[
		"duplicate attachments",
		{ ...body, schemaVersion: 2, attachments: ["file-a", "file-a"] },
	],
	[
		"an extra caller-selected authority field",
		{
			...body,
			schemaVersion: 2,
			attachments: ["file-a"],
			grantId: "caller-selected",
		},
	],
])("rejects V2 body with %s before admission", async (_label, value) => {
	const admit = vi.fn();
	const response = await app({ admit }).request(
		"/api/v2/conversations/conversation/native-capability/invoke",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(value),
		},
	);
	expect(response.status).toBe(400);
	expect(admit).not.toHaveBeenCalled();
});
