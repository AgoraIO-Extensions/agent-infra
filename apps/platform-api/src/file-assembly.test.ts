import { generateKeyPairSync, sign } from "node:crypto";
import { FakeObjectStorageV1 } from "@agent-infra/object-storage";
import { sessionSandboxFileExchangeTokenV1 } from "@agent-infra/platform-core";
import { expect, it } from "vitest";
import { assemblePlatformFilesV1 } from "./file-assembly.ts";
import { verifyRuntimeExecutionGrantForFilesV4 } from "./file-grants.ts";

function createAssemblyFixture() {
	const keys = generateKeyPairSync("ed25519");
	const actor = {
		schemaVersion: 1 as const,
		userId: "alice",
		displayName: "Alice",
		accountStatus: "active" as const,
		organizationIds: ["org"],
		roles: ["employee" as const],
		authorizationRevision: "auth-1",
	};
	const limits = {
		revision: "limits",
		expiresAt: "2099-01-01T00:00:00Z",
		maxBytes: 100,
		mediaTypes: ["text/plain"],
	};
	const state = {
		revoked: false,
		channelId: "web",
		/** 会话实际所在渠道；未设置时不按渠道区分（#3432）。 */
		conversationChannelId: undefined as string | undefined,
		limitsUnavailable: false,
		// #3276：执行当前的 Sandbox 分配；null 表示 Agent 级执行。
		sandbox: null as
			| null
			| "missing"
			| "unavailable"
			| {
					sandboxId: string;
					namespace: string;
					generation: number;
					resourceFence: number;
			  },
	};
	const mapping = {
		token: "synthetic-service-token-442-123456789",
		agentIds: ["agent"],
	};
	// 另一部署登记的服务身份，只映射到别的 Agent。
	const otherMapping = {
		token: "synthetic-other-service-token-3276-1234",
		agentIds: ["other-agent"],
	};
	const credentialReads: unknown[] = [];
	const authorizedChannels: string[] = [];
	const assembled = assemblePlatformFilesV1({
		databaseUrl: "postgres://unused:unused@127.0.0.1:1/unused",
		sandboxCredentials: {
			async readRuntimeFileExchangeCredentialScopeV1(request) {
				credentialReads.push(request);
				if (state.sandbox === "unavailable") throw new Error("unavailable");
				if (state.sandbox === "missing") return undefined;
				return { sandbox: state.sandbox };
			},
		},
		identity: { resolve: async () => actor, hydrateUsers: async () => [] },
		deployment: {
			storage: new FakeObjectStorageV1(),
			issuer: "platform-files",
			keyVersion: "file-key",
			...keys,
			publicKeys: new Map([["file-key", keys.publicKey]]),
			runtimeIssuer: "platform-runtime",
			runtimeWorkerId: "runtime-worker",
			runtimePublicKeys: new Map([["runtime-key", keys.publicKey]]),
			intentTtlMs: 60000,
			accessTtlMs: 10000,
			maxConcurrentTransfers: 2,
			services: [mapping, otherMapping],
			resolveActor: async () => (state.revoked ? null : actor),
			readLimits: async () => ({
				configurationRevision: 1,
				declarations: { agent: limits, channel: limits, deployment: limits },
			}),
		},
		readCurrentLimits: async () => {
			if (state.limitsUnavailable) throw new Error("unavailable");
			return { agent: limits, channel: limits, deployment: limits };
		},
		conversationAuthorization: {
			// 与生产装配一致：按调用方给出的渠道查找会话；渠道不符时找不到会话（#3432）。
			authorize: async (identity, _request, channelId = "web") => {
				authorizedChannels.push(channelId);
				if (
					state.conversationChannelId !== undefined &&
					channelId !== state.conversationChannelId
				)
					return { outcome: "denied" };
				return {
					outcome: "allowed",
					authority: {
						schemaVersion: 1,
						actorId: identity.userId,
						agentId: "agent",
						channelId: state.channelId,
						authorizationRevision: "auth-1",
						supportsSupplementaryInstruction: false,
					},
				};
			},
		},
	});
	return {
		assembled,
		keys,
		mapping,
		otherMapping,
		state,
		credentialReads,
		authorizedChannels,
	};
}

/** Legacy V1 Execution Grant used by `/internal/v1/files/exchange`. */
function v1Grant(
	keys: ReturnType<typeof createAssemblyFixture>["keys"],
	channelId = "web",
) {
	const claims = {
		schemaVersion: 1,
		issuer: "platform-runtime",
		audience: ["runtime_host"],
		issuedAt: new Date(Date.now() - 1000).toISOString(),
		expiresAt: new Date(Date.now() + 60000).toISOString(),
		grantId: "grant",
		actorId: "alice",
		agentId: "agent",
		channelId,
		conversationId: "conversation",
		executionId: "execution",
		turnId: "turn",
		sessionGeneration: 1,
		allowedCommands: ["turn.submit"],
		attachments: [{ attachmentId: "file-input", operations: ["read"] }],
		actionSetVersion: "none",
		actionIds: [],
		traceId: "trace",
	};
	const data = `${Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "runtime-key" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
	return {
		schemaVersion: 1 as const,
		format: "compact-jws" as const,
		token: `${data}.${sign(null, Buffer.from(data), keys.privateKey).toString("base64url")}`,
	};
}

const bearer = (token: string) =>
	new Request("http://platform/internal/v1/files/exchange", {
		headers: { Authorization: `Bearer ${token}` },
	});

it("accepts only this Sandbox's derived token for a Sandbox-bound execution (#3276)", async () => {
	const { assembled, keys, mapping, otherMapping, state, credentialReads } =
		createAssemblyFixture();
	const allocation = {
		sandboxId: "sandbox-a",
		namespace: "agent-workloads",
		generation: 1,
		resourceFence: 4,
	};
	state.sandbox = allocation;
	const derived = (token: string, value: Partial<typeof allocation> = {}) =>
		sessionSandboxFileExchangeTokenV1(token, { ...allocation, ...value });
	const grant = v1Grant(keys);
	try {
		const exchange = assembled.dependencies.exchange;
		if (!exchange) throw new Error("Exchange missing");
		const accepted = await exchange.authenticate(
			bearer(derived(mapping.token)),
			grant,
		);
		expect(
			await accepted.authorization.authorize("conversation", "read"),
		).toMatchObject({ execution: { executionId: "execution" } });
		// 分配按已验证 Grant 的绑定重新读取，不取自请求。
		expect(credentialReads.at(-1)).toMatchObject({
			agentId: "agent",
			actorId: "alice",
			channelId: "web",
			conversationId: "conversation",
			executionId: "execution",
			sessionGeneration: 1,
		});
		// AC-5：部署 token 本身、另一 Sandbox、另一 namespace、旧代次、旧 fence，以及
		// 未映射该 Agent 的服务身份所派生的值，一律拒绝。
		for (const token of [
			mapping.token,
			derived(mapping.token, { sandboxId: "sandbox-b" }),
			derived(mapping.token, { namespace: "other-namespace" }),
			derived(mapping.token, { generation: 2 }),
			derived(mapping.token, { resourceFence: 3 }),
			derived(otherMapping.token),
			derived(`${mapping.token}-rotated`),
		])
			await expect(exchange.authenticate(bearer(token), grant)).rejects.toThrow(
				"File exchange denied",
			);
		// 同一请求后续的授权检查重新读取分配：fence 前进后旧派生值立即失效。
		state.sandbox = { ...allocation, resourceFence: 5 };
		expect(
			await accepted.authorization.authorize("conversation", "read"),
		).toBeNull();
		// 没有就绪分配或分配读取不可用时，任何凭据都不放行。
		for (const unavailable of ["missing", "unavailable"] as const) {
			state.sandbox = unavailable;
			for (const token of [mapping.token, derived(mapping.token)])
				await expect(
					exchange.authenticate(bearer(token), grant),
				).rejects.toThrow("File exchange denied");
		}
	} finally {
		await assembled.close();
	}
});

it("authorizes execution-bound access in the execution's own channel and browser access only in Web (#3432)", async () => {
	const { assembled, keys, mapping, state, authorizedChannels } =
		createAssemblyFixture();
	state.sandbox = null;
	const wecom = "wecom_bot:bot";
	try {
		const exchange = assembled.dependencies.exchange;
		if (!exchange) throw new Error("Exchange missing");
		// 企微会话的执行按企微渠道核对，读取本执行允许的附件。
		state.channelId = wecom;
		state.conversationChannelId = wecom;
		const accepted = await exchange.authenticate(
			bearer(mapping.token),
			v1Grant(keys, wecom),
		);
		expect(
			await accepted.authorization.authorize("conversation", "read"),
		).toMatchObject({
			channelId: wecom,
			execution: { executionId: "execution", channelId: wecom },
		});
		expect(authorizedChannels.at(-1)).toBe(wecom);
		// 浏览器访问不能借执行期参数进入非 Web 会话：始终按 Web 渠道查找，找不到即拒绝。
		const browser = assembled.dependencies.authorization(
			new Request("http://platform/api/v1/conversations/conversation/files"),
		);
		expect(await browser.authorize("conversation", "read")).toBeNull();
		expect(authorizedChannels.at(-1)).toBe("web");
		// 执行声称的渠道与会话实际渠道不一致时拒绝。
		state.conversationChannelId = "web";
		const mismatched = await exchange.authenticate(
			bearer(mapping.token),
			v1Grant(keys, wecom),
		);
		expect(
			await mismatched.authorization.authorize("conversation", "read"),
		).toBeNull();
	} finally {
		await assembled.close();
	}
});

it("keeps the registered service token for Agent-level executions only (#3276)", async () => {
	const { assembled, keys, mapping, state } = createAssemblyFixture();
	state.sandbox = null;
	const grant = v1Grant(keys);
	try {
		const exchange = assembled.dependencies.exchange;
		if (!exchange) throw new Error("Exchange missing");
		await expect(
			exchange.authenticate(bearer(mapping.token), grant),
		).resolves.toMatchObject({ conversationId: "conversation" });
		// 没有 Sandbox 分配时派生值不是任何登记身份。
		await expect(
			exchange.authenticate(
				bearer(
					sessionSandboxFileExchangeTokenV1(mapping.token, {
						sandboxId: "sandbox-a",
						namespace: "agent-workloads",
						generation: 1,
						resourceFence: 1,
					}),
				),
				grant,
			),
		).rejects.toThrow("File exchange denied");
	} finally {
		await assembled.close();
	}
});

it("checks the V4 runtime exchange service identity against the signed binding before any persisted read (#3276)", async () => {
	const { assembled, keys, mapping, state, credentialReads } =
		createAssemblyFixture();
	state.sandbox = {
		sandboxId: "sandbox-a",
		namespace: "agent-workloads",
		generation: 1,
		resourceFence: 4,
	};
	try {
		const runtimeExchange = assembled.dependencies.runtimeExchange;
		if (!runtimeExchange) throw new Error("Runtime exchange missing");
		await expect(
			runtimeExchange.authenticate(
				new Request("http://platform/internal/v1/files/runtime-exchange", {
					headers: { Authorization: `Bearer ${mapping.token}` },
				}),
				{
					schemaVersion: 2,
					executionGrant: v4Grant(keys, runtimeClaims()),
					operation: "read",
					fileId: "file-input",
					idempotencyKey: "runtime-3276",
				},
			),
		).rejects.toThrow("Runtime file exchange denied");
		expect(credentialReads).toEqual([
			expect.objectContaining({
				agentId: "agent",
				actorId: "alice",
				channelId: "web",
				conversationId: "conversation",
				executionId: "execution",
				sessionGeneration: 1,
			}),
		]);
	} finally {
		await assembled.close();
	}
});

it("requires both a signed execution delegation and a mapped service, then rechecks its actor", async () => {
	const { assembled, keys, mapping, state } = createAssemblyFixture();
	const claims = {
		schemaVersion: 1,
		issuer: "platform-runtime",
		audience: ["runtime_host"],
		issuedAt: new Date(Date.now() - 1000).toISOString(),
		expiresAt: new Date(Date.now() + 60000).toISOString(),
		grantId: "grant",
		actorId: "alice",
		agentId: "agent",
		channelId: "web",
		conversationId: "conversation",
		executionId: "execution",
		turnId: "turn",
		sessionGeneration: 1,
		allowedCommands: ["turn.submit"],
		attachments: [{ attachmentId: "file-input", operations: ["read"] }],
		actionSetVersion: "none",
		actionIds: [],
		traceId: "trace",
	};
	const data = `${Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "runtime-key" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}`;
	const grant = {
		schemaVersion: 1 as const,
		format: "compact-jws" as const,
		token: `${data}.${sign(null, Buffer.from(data), keys.privateKey).toString("base64url")}`,
	};
	const request = (token: string) =>
		new Request("http://platform/internal/v1/files/exchange", {
			headers: { Authorization: `Bearer ${token}` },
		});
	try {
		const exchange = assembled.dependencies.exchange;
		if (!exchange) throw new Error("Exchange missing");
		await expect(
			exchange.authenticate(
				request("unmapped-service-token-123456789012"),
				grant,
			),
		).rejects.toThrow();
		await expect(
			exchange.authenticate(request(mapping.token), {
				...grant,
				token: "a.b.c",
			}),
		).rejects.toThrow();
		const accepted = await exchange.authenticate(request(mapping.token), grant);
		expect(
			await accepted.authorization.authorize("conversation", "read"),
		).toMatchObject({
			actorId: "alice",
			execution: { executionId: "execution", attachments: ["file-input"] },
		});
		state.channelId = "other";
		expect(
			await accepted.authorization.authorize("conversation", "read"),
		).toBeNull();
		state.channelId = "web";
		state.revoked = true;
		await expect(
			accepted.authorization.authorize("conversation", "read"),
		).rejects.toThrow();
		state.revoked = false;
		state.limitsUnavailable = true;
		expect(
			await accepted.authorization.authorize("conversation", "read"),
		).toBeNull();
	} finally {
		await assembled.close();
	}
});

function runtimeClaims() {
	const issuedAt = Date.now() - 1000;
	return {
		schemaVersion: 4,
		issuer: "platform-runtime",
		audience: "runtime_host",
		issuedAt,
		expiresAt: issuedAt + 30_000,
		grantId: "grant-1",
		workerId: "runtime-worker",
		principal: { kind: "user", id: "alice" },
		executionSource: "web",
		relayKeyBinding: {
			purpose: "personal",
			subjectId: "alice",
			ciphertextRef: "key-1",
			version: 1,
		},
		agentId: "agent",
		channelId: "web",
		conversationId: "conversation",
		executionId: "execution",
		turnId: "turn",
		sessionGeneration: 1,
		traceId: "trace",
		hostSessionRef: null,
		operation: {
			kind: "execution",
			id: "execution",
			deliveryFence: 1,
			executionDeliveryFence: 1,
		},
		allowedCommands: ["turn.submit"],
		purpose: "business",
		authorizationRecordId: "authorization-1",
		attachments: [{ attachmentId: "file-input", operations: ["read"] }],
		requestDigest: "a".repeat(64),
	};
}

function v4Grant(
	keys: ReturnType<typeof createAssemblyFixture>["keys"],
	claims: Record<string, unknown>,
) {
	const header = Buffer.from(
		JSON.stringify({
			alg: "EdDSA",
			kid: "runtime-key",
			typ: "runtime-execution+jws",
		}),
	).toString("base64url");
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	const content = `${header}.${payload}`;
	return {
		schemaVersion: 4 as const,
		format: "runtime-execution-jws" as const,
		token: `${content}.${sign(null, Buffer.from(content), keys.privateKey).toString("base64url")}`,
	};
}

it("verifies a signed V4 business grant as a delegation-scope proof", () => {
	const { keys } = createAssemblyFixture();
	const options = {
		issuer: "platform-runtime",
		workerId: "runtime-worker",
		publicKeys: new Map([["runtime-key", keys.publicKey]]),
	};
	const claims = verifyRuntimeExecutionGrantForFilesV4(
		v4Grant(keys, runtimeClaims()),
		options,
	);
	// Only the signed attachment allowlist is available to the exchange.
	expect(claims.attachments).toEqual([
		{ attachmentId: "file-input", operations: ["read"] },
	]);
	// The proof is a delegation scope, not continuous authority: a Grant whose
	// signed 30 s window already lapsed still verifies, while persisted rows
	// decide current authorization (OQ-1 in #2968).
	const lapsed = runtimeClaims();
	lapsed.issuedAt = Date.now() - 120_000;
	lapsed.expiresAt = lapsed.issuedAt + 30_000;
	expect(
		verifyRuntimeExecutionGrantForFilesV4(v4Grant(keys, lapsed), options),
	).toMatchObject({ authorizationRecordId: "authorization-1" });
	for (const mutate of [
		(claims: ReturnType<typeof runtimeClaims>) => {
			claims.issuer = "foreign-runtime";
		},
		(claims: ReturnType<typeof runtimeClaims>) => {
			claims.workerId = "foreign-worker";
		},
		(claims: ReturnType<typeof runtimeClaims>) => {
			claims.allowedCommands = ["native-capability.invoke"];
		},
		(claims: ReturnType<typeof runtimeClaims>) => {
			claims.allowedCommands = ["turn.submit", "native-capability.invoke"];
		},
		(claims: ReturnType<typeof runtimeClaims>) => {
			claims.purpose = "control";
		},
		(claims: ReturnType<typeof runtimeClaims>) => {
			claims.expiresAt = claims.issuedAt + 31_000;
		},
		(claims: ReturnType<typeof runtimeClaims>) => {
			claims.operation.deliveryFence = 2;
		},
		(claims: ReturnType<typeof runtimeClaims>) => {
			claims.audience = "platform_files";
		},
	]) {
		const altered = runtimeClaims();
		mutate(altered);
		expect(() =>
			verifyRuntimeExecutionGrantForFilesV4(v4Grant(keys, altered), options),
		).toThrow();
	}
	// A valid grant for a different deployment still fails when the Worker is
	// unknown, and a tampered token never verifies.
	expect(() =>
		verifyRuntimeExecutionGrantForFilesV4(v4Grant(keys, runtimeClaims()), {
			...options,
			workerId: "other-worker",
		}),
	).toThrow();
	const tampered = v4Grant(keys, runtimeClaims());
	expect(() =>
		verifyRuntimeExecutionGrantForFilesV4(
			{ ...tampered, token: `${tampered.token.slice(0, -2)}xx` },
			options,
		),
	).toThrow();
});

it("denies a V4 exchange whose service identity is not mapped to the Agent", async () => {
	const { assembled, keys } = createAssemblyFixture();
	const request = new Request(
		"http://platform/internal/v1/files/runtime-exchange",
		{ headers: { Authorization: "Bearer unmapped-service-token-123456789" } },
	);
	const grant = v4Grant(keys, runtimeClaims());
	try {
		const runtimeExchange = assembled.dependencies.runtimeExchange;
		if (!runtimeExchange) throw new Error("Runtime exchange missing");
		await expect(
			runtimeExchange.authenticate(request, {
				schemaVersion: 2,
				executionGrant: grant,
				operation: "read",
				fileId: "file-input",
				idempotencyKey: "runtime-1",
			}),
		).rejects.toThrow();
	} finally {
		await assembled.close();
	}
});

it("fails closed when files are configured without a runtime Worker identity", () => {
	expect(() =>
		assemblePlatformFilesV1({
			databaseUrl: "postgres://unused:unused@127.0.0.1:1/unused",
			identity: { resolve: async () => null, hydrateUsers: async () => [] },
			deployment: {
				storage: new FakeObjectStorageV1(),
				issuer: "platform-files",
				keyVersion: "file-key",
				...generateKeyPairSync("ed25519"),
				publicKeys: new Map(),
				runtimeIssuer: "platform-runtime",
				runtimeWorkerId: "",
				runtimePublicKeys: new Map(),
				intentTtlMs: 60000,
				accessTtlMs: 10000,
				maxConcurrentTransfers: 2,
				services: [],
				resolveActor: async () => null,
				readLimits: async () => {
					throw new Error("unused");
				},
			},
			readCurrentLimits: async () => null,
			conversationAuthorization: {
				authorize: async () => ({ outcome: "denied" as const }),
			},
		}),
	).toThrow("runtime worker identity");
});
