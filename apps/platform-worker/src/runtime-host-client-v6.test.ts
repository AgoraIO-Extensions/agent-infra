import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createRuntimeExecutionGrantValidatorV6,
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
} from "@agent-infra/agent-runtime";
import {
	RuntimeBusinessGrantClaimsV6Schema,
	RuntimeNativeCapabilityRequestV6Schema,
	RuntimeNativeCapabilityTransportV6Schema,
	runtimeOperationDigestInputV6,
	runtimeOperationDigestV6,
	runtimeRequestDigestV6,
	validateRuntimeBusinessBindingV6,
} from "@agent-infra/contracts/runtime";
import { ConversationRuntimeHostError } from "@agent-infra/platform-core";
import { expect, it, vi } from "vitest";
import { createRuntimeHostApp } from "../../agent-runtime-host/src/app.js";
import { createWorkerRuntimeGrantSignerV4 } from "./runtime-grant-signer-v4.js";
import {
	createNativeCapabilityTransportV6,
	createWorkerRuntimeHostClientV6,
	type WorkerAcceptedExecutionV6,
	type WorkerRuntimeHostClientOptionsV6,
} from "./runtime-host-client.js";

const request = RuntimeNativeCapabilityRequestV6Schema.parse({
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
});

async function claims() {
	return RuntimeBusinessGrantClaimsV6Schema.parse({
		schemaVersion: 6,
		issuer: "platform-worker",
		audience: "runtime_host",
		issuedAt: 1,
		expiresAt: 2,
		grantId: "grant-1",
		workerId: "worker-1",
		principal: request.principal,
		agentId: request.agentId,
		channelId: request.channelId,
		conversationId: request.conversationId,
		executionId: request.executionId,
		turnId: request.turnId,
		sessionGeneration: request.sessionGeneration,
		traceId: request.traceId,
		hostSessionRef: request.hostSessionRef,
		executionSource: request.executionSource,
		relayKeyBinding: request.keyBinding,
		operation: request.operation,
		requestDigest: await runtimeRequestDigestV6(request),
		purpose: "business",
		authorizationRecordId: "authorization-1",
		allowedCommands: ["native-capability.invoke"],
		attachments: [],
	});
}

it("builds a V6 private transport bound to the accepted request digest", async () => {
	const acceptedClaims = await claims();
	const transport = await createNativeCapabilityTransportV6({
		request,
		claims: acceptedClaims,
		relayKey: "private-key-value-k1",
	});
	expect(transport.businessRequest).toEqual(request);
	expect(transport.privateKeyField.context.requestDigest).toBe(
		acceptedClaims.requestDigest,
	);
	expect(transport.privateKeyField.context.executionId).toBe(
		request.executionId,
	);
});

it("rejects a request paired with claims for a different frozen input", async () => {
	const acceptedClaims = await claims();
	await expect(
		createNativeCapabilityTransportV6({
			request: { ...request, configVersion: "configuration-2" },
			claims: acceptedClaims,
			relayKey: "private-key-value-k1",
		}),
	).rejects.toMatchObject({ code: "RELAY_KEY_AUTHENTICATION_FAILED" });
});

it.each(["principal", "relayKeyBinding", "operation"] as const)(
	"rejects a matching digest with mismatched %s claims",
	async (field) => {
		const acceptedClaims = await claims();
		if (field === "principal") acceptedClaims.principal.id = "bob";
		else if (field === "relayKeyBinding")
			acceptedClaims.relayKeyBinding.version++;
		else acceptedClaims.operation.deliveryFence++;
		await expect(
			createNativeCapabilityTransportV6({
				request,
				claims: acceptedClaims,
				relayKey: "private-key-value-k1",
			}),
		).rejects.toThrow();
	},
);

// These use real Ed25519 grants; the accepted Store/Key port and HTTP response are controlled.
const keys = generateKeyPairSync("ed25519");
async function senderFixture() {
	let clock = 1_800_000_000_000;
	const signer = createWorkerRuntimeGrantSignerV4({
		issuer: "platform-worker",
		workerId: "worker-1",
		keyId: "v6-signing",
		privateKey: keys.privateKey,
		now: () => clock,
	});
	const unsigned = structuredClone(request);
	const accepted: WorkerAcceptedExecutionV6 = {
		schemaVersion: 6,
		binding: runtimeOperationDigestInputV6(unsigned),
		operationDigest: await runtimeOperationDigestV6(unsigned),
		deliveryFence: unsigned.operation.deliveryFence,
		executionDeliveryFence: unsigned.operation.executionDeliveryFence,
		authorizationRecordId: "authorization-1",
		stopPending: false,
		dispatchState: "ready",
	};
	const buffers: Uint8Array[] = [];
	const executionKeys = {
		readAcceptedExecution: vi.fn(
			async () => structuredClone(accepted) as WorkerAcceptedExecutionV6 | null,
		),
		readCiphertext: vi.fn(async () => ({
			reference: "synthetic-encrypted-key",
		})),
	};
	const decryptor = {
		decrypt: vi.fn(async () => {
			const plaintext = new TextEncoder().encode("private-key-value-k1");
			buffers.push(plaintext);
			return { outcome: "decrypted" as const, plaintext };
		}),
	};
	const fetcher = vi.fn(async () =>
		Response.json({
			schemaVersion: 6,
			operationId: unsigned.executionId,
			hostSessionRef: unsigned.hostSessionRef,
			result: { outcome: "accepted", status: "running" },
		}),
	);
	const options: WorkerRuntimeHostClientOptionsV6 = {
		baseUrl: "http://runtime.test",
		serviceToken: "synthetic-service-token",
		signGrant: signer.signV6,
		verifyGrant: signer.verifyV6,
		executionKeys,
		decryptor,
		fetch: fetcher,
		assertCurrentAuthorization: vi.fn(async () => {}),
	};
	return {
		unsigned,
		accepted,
		signer,
		executionKeys,
		decryptor,
		fetcher,
		buffers,
		options,
		advance: () => {
			clock += 30_000;
		},
		client: createWorkerRuntimeHostClientV6(options),
	};
}

it("sends a signed V6 request with the original Key and validates the exact response", async () => {
	const f = await senderFixture();
	await expect(f.client.nativeCapability(f.unsigned)).resolves.toMatchObject({
		schemaVersion: 6,
		result: { outcome: "accepted", status: "running" },
	});
	expect(f.fetcher).toHaveBeenCalledOnce();
	expect(f.executionKeys.readCiphertext).toHaveBeenCalledWith({
		purpose: "personal",
		subjectId: "alice",
		keyId: "key-1",
		keyVersion: 1,
	});
	const [url, init] = f.fetcher.mock.calls[0] as unknown as [URL, RequestInit];
	expect(String(url)).toBe(
		"http://runtime.test/internal/runtime/v6/native-capability",
	);
	const transport = RuntimeNativeCapabilityTransportV6Schema.parse(
		JSON.parse(String(init.body)),
	);
	const signedClaims = f.signer.verifyV6(transport.businessRequest.grant);
	await validateRuntimeBusinessBindingV6(
		transport.businessRequest,
		signedClaims,
	);
	expect(transport.businessRequest.selection).toEqual(
		f.accepted.binding.selection,
	);
	expect(transport.privateKeyField.context.grantId).toBe(signedClaims.grantId);
	expect(transport.privateKeyField.context.requestDigest).toBe(
		signedClaims.requestDigest,
	);
	expect(transport.privateKeyField.keyDelivery.relayKey).toBe(
		"private-key-value-k1",
	);
	expect(f.buffers.every((buffer) => buffer.every((byte) => byte === 0))).toBe(
		true,
	);
	expect(f.executionKeys.readAcceptedExecution).toHaveBeenCalledTimes(3);
});

it.each([
	"principal",
	"agent",
	"conversation",
	"generation",
	"hostSession",
	"key",
	"selection",
	"config",
	"directory",
	"operation",
	"fence",
	"digest",
	"version",
])(
	"rejects an accepted %s mismatch before decrypting or sending",
	async (field) => {
		const f = await senderFixture();
		const binding = f.accepted.binding;
		if (field === "principal") binding.principal.id = "bob";
		else if (field === "agent") binding.agentId = "agent-other";
		else if (field === "conversation")
			binding.conversationId = "conversation-other";
		else if (field === "generation") binding.sessionGeneration++;
		else if (field === "hostSession") binding.hostSessionRef = "session-other";
		else if (field === "key") binding.keyBinding.version++;
		else if (field === "selection") binding.selection.reasoningLevel = "low";
		else if (field === "config") binding.configVersion = "configuration-2";
		else if (field === "directory") binding.directoryRevision = "a".repeat(64);
		else if (field === "operation") binding.operation.id = "another-operation";
		else if (field === "fence")
			Object.assign(f.accepted, { deliveryFence: 999 });
		else if (field === "digest")
			Object.assign(f.accepted, { operationDigest: "a".repeat(64) });
		else Object.assign(f.accepted, { schemaVersion: 4 });
		await expect(f.client.nativeCapability(f.unsigned)).rejects.toMatchObject({
			code: "RUNTIME_GRANT_INVALID",
		});
		expect(f.decryptor.decrypt).not.toHaveBeenCalled();
		expect(f.fetcher).not.toHaveBeenCalled();
	},
);

it.each(["missing", "stopped", "unknown", "accepted", "terminal"])(
	"does not send for %s original acceptance",
	async (state) => {
		const f = await senderFixture();
		if (state === "missing")
			f.executionKeys.readAcceptedExecution.mockResolvedValue(null);
		else if (state === "stopped")
			Object.assign(f.accepted, { stopPending: true });
		else Object.assign(f.accepted, { dispatchState: state });
		await expect(f.client.nativeCapability(f.unsigned)).rejects.toBeInstanceOf(
			ConversationRuntimeHostError,
		);
		expect(f.executionKeys.readCiphertext).not.toHaveBeenCalled();
		expect(f.fetcher).not.toHaveBeenCalled();
	},
);

it.each(["key", "fence", "revoked", "expired", "abort"])(
	"rechecks %s after Key decryption before send",
	async (change) => {
		const f = await senderFixture();
		const controller = new AbortController();
		f.decryptor.decrypt.mockImplementation(async () => {
			if (change === "key") f.accepted.binding.keyBinding.version++;
			else if (change === "fence")
				Object.assign(f.accepted, { deliveryFence: 999 });
			else if (change === "expired") f.advance();
			else if (change === "abort") controller.abort();
			else
				vi.mocked(f.options.assertCurrentAuthorization).mockRejectedValue(
					new ConversationRuntimeHostError("AUTHORIZATION_REVOKED", false),
				);
			const plaintext = new TextEncoder().encode("private-key-value-k1");
			f.buffers.push(plaintext);
			return { outcome: "decrypted", plaintext };
		});
		await expect(
			f.client.nativeCapability(f.unsigned, controller.signal),
		).rejects.toBeInstanceOf(ConversationRuntimeHostError);
		expect(f.fetcher).not.toHaveBeenCalled();
		expect(
			f.buffers.every((buffer) => buffer.every((byte) => byte === 0)),
		).toBe(true);
	},
);

it("does not resend when the acceptance response is lost", async () => {
	const f = await senderFixture();
	f.fetcher.mockRejectedValueOnce(new Error("synthetic connection lost"));
	await expect(f.client.nativeCapability(f.unsigned)).rejects.toMatchObject({
		code: "RUNTIME_UNAVAILABLE",
		retryable: true,
	});
	expect(f.fetcher).toHaveBeenCalledOnce();
	Object.assign(f.accepted, { dispatchState: "unknown" });
	await expect(f.client.nativeCapability(f.unsigned)).rejects.toMatchObject({
		code: "RUNTIME_ACCEPTANCE_UNKNOWN",
		notSent: false,
	});
	expect(f.fetcher).toHaveBeenCalledOnce();
});

it.each([
	"schema",
	"session",
	"operation",
	"body",
	"late-revocation",
	"late-fence",
])("retains unknown acceptance for %s response", async (change) => {
	const f = await senderFixture();
	f.fetcher.mockImplementation(async () => {
		if (change === "late-revocation")
			vi.mocked(f.options.assertCurrentAuthorization).mockRejectedValue(
				new Error("revoked"),
			);
		if (change === "late-fence")
			Object.assign(f.accepted, { deliveryFence: 999 });
		if (change === "body") return new Response("not-json");
		return Response.json({
			schemaVersion: change === "schema" ? 4 : 6,
			operationId: change === "operation" ? "another" : request.executionId,
			hostSessionRef: change === "session" ? "another" : request.hostSessionRef,
			result: { outcome: "accepted", status: "running" },
		});
	});
	await expect(f.client.nativeCapability(f.unsigned)).rejects.toMatchObject({
		code: "RUNTIME_ACCEPTANCE_UNKNOWN",
		retryable: true,
		notSent: false,
	});
	expect(f.fetcher).toHaveBeenCalledOnce();
});

it("rejects stale signatures and expiry without widening V4", async () => {
	const f = await senderFixture();
	const grant = await f.signer.signV6(f.unsigned, "authorization-1");
	expect(f.signer.verifyV6(grant).schemaVersion).toBe(6);
	expect(() => f.signer.verify({ ...grant, schemaVersion: 4 })).toThrow();
	const [header, payload, signature] = grant.token.split(".");
	if (!signature) throw new Error("Missing signature");
	const tampered = `${header}.${payload}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
	expect(() => f.signer.verifyV6({ ...grant, token: tampered })).toThrow();
	f.advance();
	expect(() => f.signer.verifyV6(grant)).toThrow();
});

it("uses the formal HTTP Host route with real V6 signatures and no legacy fallback", async () => {
	const f = await senderFixture();
	const directory = await mkdtemp(join(tmpdir(), "worker-v6-http-"));
	const hostPath = join(directory, "host.json");
	const store = await FileRuntimeStore.open(hostPath);
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	const validator = createRuntimeExecutionGrantValidatorV6(
		new Map([["v6-signing", keys.publicKey]]),
		{
			expectedIssuer: "platform-worker",
			expectedWorkerId: "worker-1",
			now: () => 1_800_000_000_000,
		},
	);
	const host = await RuntimeHost.open({
		store,
		driver,
		grantValidation: { expectedIssuer: "platform-worker" },
		validateGrantV6: validator,
	});
	try {
		const app = createRuntimeHostApp({
			host,
			serviceToken: "synthetic-service-token",
			runtimeWorkerId: "worker-1",
			verifyGrant: () => {
				throw new Error("Legacy grant must not be used");
			},
			verifyGrantV6: validator,
		});
		const before = await readFile(hostPath, "utf8");
		const execute = vi.spyOn(driver, "execute");
		const calls: string[] = [];
		const client = createWorkerRuntimeHostClientV6({
			...f.options,
			fetch: async (url, init) => {
				calls.push(String(url));
				return app.fetch(new Request(url, init));
			},
		});
		await expect(client.nativeCapability(f.unsigned)).rejects.toMatchObject({
			code: "RUNTIME_NATIVE_CAPABILITY_UNSUPPORTED",
			retryable: false,
		});
		expect(calls).toEqual([
			"http://runtime.test/internal/runtime/v6/native-capability",
		]);
		const signed = {
			...f.unsigned,
			grant: await f.signer.signV6(f.unsigned, "authorization-1"),
		};
		const transport = await createNativeCapabilityTransportV6({
			request: signed,
			claims: f.signer.verifyV6(signed.grant),
			relayKey: "private-key-value-k1",
		});
		for (const changed of [
			{ grantId: "another-grant" },
			{ requestDigest: "a".repeat(64) },
		]) {
			const invalid = structuredClone(transport);
			Object.assign(invalid.privateKeyField.context, changed);
			const response = await app.request(
				"http://runtime.test/internal/runtime/v6/native-capability",
				{
					method: "POST",
					headers: {
						authorization: "Bearer synthetic-service-token",
						"content-type": "application/json",
					},
					body: JSON.stringify(invalid),
				},
			);
			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				code: "RUNTIME_GRANT_INVALID",
			});
		}
		expect(execute).not.toHaveBeenCalled();
		expect(await readFile(hostPath, "utf8")).toBe(before);
	} finally {
		await host.close();
		await store.close();
		await rm(directory, { recursive: true, force: true });
	}
});

it.each(["issuer", "worker", "signature", "claims-scope", "input"])(
	"Host verifies V6 %s independently",
	async (change) => {
		const f = await senderFixture();
		const grant = await f.signer.signV6(f.unsigned, "authorization-1");
		const signed = { ...f.unsigned, grant };
		let publicKey = keys.publicKey;
		if (change === "signature")
			publicKey = generateKeyPairSync("ed25519").publicKey;
		if (change === "input")
			signed.selection = { ...signed.selection, reasoningLevel: "low" };
		if (change === "claims-scope") {
			const claims = f.signer.verifyV6(grant);
			claims.principal.id = "bob";
			const header = grant.token.split(".")[0];
			const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
			const signingInput = `${header}.${payload}`;
			signed.grant = {
				...grant,
				token: `${signingInput}.${sign(null, Buffer.from(signingInput), keys.privateKey).toString("base64url")}`,
			};
		}
		const validate = createRuntimeExecutionGrantValidatorV6(
			new Map([["v6-signing", publicKey]]),
			{
				expectedIssuer:
					change === "issuer" ? "other-issuer" : "platform-worker",
				expectedWorkerId: change === "worker" ? "other-worker" : "worker-1",
				now: () => 1_800_000_000_000,
			},
		);
		await expect(validate(signed)).rejects.toMatchObject({
			code: "RUNTIME_GRANT_INVALID",
		});
	},
);
