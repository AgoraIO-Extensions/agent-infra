import { describe, expect, it } from "vitest";
import { createRuntimeHostApp } from "../../agent-runtime-host/src/app.js";
import { createWorkerRuntimeNativeMetadataClientV1 } from "../../platform-worker/src/runtime-native-metadata-client.js";
import { createRuntimeNativeMetadataReaderV1 } from "./runtime-native-metadata-reader.js";

const identity = {
	schemaVersion: 1 as const,
	userId: "user-transport",
	displayName: "Transport User",
	accountStatus: "active" as const,
	organizationIds: ["org-transport"],
	roles: ["employee" as const],
	authorizationRevision: "auth-transport",
};

const binding = {
	schemaVersion: 1 as const,
	readId: "read-transport",
	selector: "status" as const,
	scope: {
		schemaVersion: 1 as const,
		principal: { kind: "user" as const, id: identity.userId },
		agentId: "agent-transport",
		channelId: "web",
		conversationId: "conversation-transport",
		executionId: "execution-transport",
		sessionGeneration: 2,
		authorizationRevision: identity.authorizationRevision,
	},
	readStartedAt: 2_000,
	expiresAt: 20_000,
	requestId: "request-transport",
	traceId: "trace-transport",
	originalHostScopeRef: "host-scope-transport",
};

const proof = {
	schemaVersion: 1 as const,
	format: "native-metadata-jws" as const,
	token: "transport-proof",
};

const response = {
	...binding,
	projection: {
		selector: "status" as const,
		status: "active" as const,
		readAt: "2026-10-13T00:00:00.000Z",
	},
};

function setup(
	patch: Partial<{
		serviceToken: string;
		clientServiceToken: string;
		response: typeof response;
	}> = {},
) {
	const serviceToken = patch.serviceToken ?? "runtime-transport-service";
	const app = createRuntimeHostApp({
		host: {} as never,
		serviceToken,
		verifyGrant: async () => {
			throw new Error("Unexpected Execution Grant");
		},
		nativeMetadataRead: async (request) => {
			if (request.proof.token !== proof.token)
				throw new Error("RUNTIME_NATIVE_METADATA_PROOF_INVALID");
			return patch.response ?? response;
		},
	});
	const transport = createWorkerRuntimeNativeMetadataClientV1({
		baseUrl: "http://runtime-transport",
		serviceToken: patch.clientServiceToken ?? serviceToken,
		fetch: async (input, init) => app.fetch(new Request(String(input), init)),
	});
	const reader = createRuntimeNativeMetadataReaderV1({
		resolveRequest: async () => binding,
		proofIssuer: { issue: async () => proof },
		transport,
	});
	return { app, reader };
}

describe("native metadata API → Worker → RuntimeHost transport", () => {
	it("reads a bound status projection through the authenticated internal route", async () => {
		const { reader } = setup();
		await expect(
			reader.read(
				identity,
				binding.scope.conversationId,
				binding.scope.executionId,
				"status",
			),
		).resolves.toEqual(response.projection);
	});

	it("fails closed on a wrong Worker service proof", async () => {
		const { reader } = setup({ clientServiceToken: "wrong-service" });
		await expect(
			reader.read(
				identity,
				binding.scope.conversationId,
				binding.scope.executionId,
				"status",
			),
		).resolves.toBeNull();
	});

	it("fails closed when RuntimeHost response crosses the execution binding", async () => {
		const { reader } = setup({
			response: {
				...response,
				scope: { ...response.scope, executionId: "foreign-execution" },
			},
		});
		await expect(
			reader.read(
				identity,
				binding.scope.conversationId,
				binding.scope.executionId,
				"status",
			),
		).resolves.toBeNull();
	});

	it("fails closed when RuntimeHost response crosses the principal binding", async () => {
		const { reader } = setup({
			response: {
				...response,
				scope: {
					...response.scope,
					principal: { kind: "user", id: "foreign-user" },
				},
			},
		});
		await expect(
			reader.read(
				identity,
				binding.scope.conversationId,
				binding.scope.executionId,
				"status",
			),
		).resolves.toBeNull();
	});
});
