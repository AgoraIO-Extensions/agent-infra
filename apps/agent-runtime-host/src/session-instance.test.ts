import {
	createHash,
	createPublicKey,
	generateKeyPairSync,
	randomUUID,
	sign,
	verify,
} from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	codexSessionExecutorBindingDigestV1,
	createCodexSessionExecutorBindingV1,
	issueExecutorStartIdentityV1,
	verifyExecutorStartIdentityV1,
} from "@agent-infra/agent-runtime";
import {
	SessionInstanceEvidenceClaimsV1Schema,
	SessionInstanceEvidenceV1Schema,
	type SessionInstanceReadRequestV1,
	sessionInstanceReadPathV1,
	sessionInstanceRequestSigningPayloadV1,
} from "@agent-infra/contracts/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { consumeExecutorIdentityV1 } from "./executor-identity-startup.js";
import {
	createSessionInstanceReaderV1,
	readSessionInstanceBodyV1,
	type SessionInstancePreparationFactsV1,
} from "./session-instance.js";

// Only the OS boundary is mapped; issue, signature verification, unlink and read use real code/files.
const delivery = vi.hoisted(() => ({ path: "" }));
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	const mapped = (path: unknown) =>
		String(path) === "/var/run/agent-infra/executor-identity/startup.json"
			? delivery.path
			: path;
	return {
		...fs,
		open: (
			path: Parameters<typeof fs.open>[0],
			...args: Parameters<typeof fs.open> extends [unknown, ...infer T]
				? T
				: never
		) => fs.open(mapped(path) as typeof path, ...args),
		unlink: (path: Parameters<typeof fs.unlink>[0]) =>
			fs.unlink(mapped(path) as typeof path),
		lstat: (path: Parameters<typeof fs.lstat>[0]) =>
			fs.lstat(mapped(path) as typeof path),
	};
});
vi.mock("./executor-identity-process.js", () => ({
	protectExecutorIdentityProcessV1: () => {},
}));
vi.mock("./process-protection.js", () => ({
	assertRuntimeProcessProtection: () => {},
}));
const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "session-instance-"));
	directories.push(directory);
	delivery.path = join(directory, "startup.json");
	const issuer = generateKeyPairSync("ed25519");
	const binding = createCodexSessionExecutorBindingV1({
		namespace: "instance-evidence",
		podName: "sandbox-original",
		sandboxId: "original",
		agentId: "agent-original",
		conversationId: "session-original",
		sessionGeneration: 2,
		resourceFence: 3,
		imageDigest: `registry.example/runtime@sha256:${"a".repeat(64)}`,
	});
	const start = {
		schemaVersion: 2 as const,
		purpose: "executor-instance-startup-v2" as const,
		podUid: "pod-original",
		bindingDigest: codexSessionExecutorBindingDigestV1(binding),
		startupRef: "startup-original",
		expiresAt: Date.now() + 60_000,
		instance: {
			attemptId: randomUUID(),
			recordRef: randomUUID(),
			sandboxId: binding.sandboxId,
			configurationRevision: 1,
			configurationVersion: "config-original",
			generation: 2,
			resourceFence: 3,
		},
	};
	const material = issueExecutorStartIdentityV1(start, issuer.privateKey);
	await writeFile(delivery.path, JSON.stringify(material.host), {
		mode: 0o400,
	});
	const identity = await consumeExecutorIdentityV1("host", binding, {
		AGENT_INFRA_RUNTIME_POD_UID: start.podUid,
		AGENT_INFRA_EXECUTOR_STARTUP_REF: start.startupRef,
		AGENT_INFRA_EXECUTOR_STARTUP_DEADLINE: String(start.expiresAt),
		AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY: issuer.publicKey
			.export({ type: "spki", format: "pem" })
			.toString(),
	});
	const worker = generateKeyPairSync("ed25519");
	const at = { now: Date.now() };
	const facts: SessionInstancePreparationFactsV1 = {
		runnerEpoch: "runner-original",
		runnerIdentityConsumed: true,
		deliveryFilesRemoved: true,
		executorReady: true,
		emptyBusinessState: true,
	};
	const readPreparation = vi.fn(async (_signal: AbortSignal) => facts);
	const isBusinessStateEmpty = vi.fn(() => true);
	const options = {
		identity,
		binding,
		podUid: start.podUid,
		runnerEpoch: facts.runnerEpoch,
		profileDigest: "b".repeat(64),
		hostKeyId: "host-original",
		worker: {
			issuer: "platform",
			workerId: "worker-original",
			keyId: "worker-key",
			publicKey: worker.publicKey,
		},
		readPreparation,
		isBusinessStateEmpty,
		now: () => at.now,
	};
	const read = createSessionInstanceReaderV1(options);
	const request = (
		changes: Partial<SessionInstanceReadRequestV1> = {},
		claimChanges: Record<string, unknown> = {},
		signingKey = worker.privateKey,
		headerChanges: Record<string, unknown> = {},
	) => {
		const body: SessionInstanceReadRequestV1 = {
			schemaVersion: 1,
			requestId: randomUUID(),
			traceId: randomUUID(),
			nonce: randomUUID(),
			workerId: "worker-original",
			namespace: binding.namespace,
			agentId: binding.agentId,
			sessionId: binding.conversationId,
			sandboxId: binding.sandboxId,
			podUid: start.podUid,
			generation: 2,
			resourceFence: 3,
			startupRef: start.startupRef,
			bindingDigest: start.bindingDigest,
			profileDigest: options.profileDigest,
			scope: {
				phase: "reserve",
				reserveRef: "reserve-original",
				reserveDeliveryFence: 7,
			},
			authorization: "not-signed",
			...changes,
		};
		const claims = {
			issuer: "platform",
			audience: "runtime_host_session_instance",
			purpose: "session-instance-read-v1",
			workerId: "worker-original",
			issuedAt: at.now,
			expiresAt: at.now + 10_000,
			requestDigest: createHash("sha256")
				.update(sessionInstanceRequestSigningPayloadV1(body))
				.digest("hex"),
			...claimChanges,
		};
		const input = [
			JSON.stringify({
				alg: "EdDSA",
				kid: "worker-key",
				typ: "session-instance-read-v1",
				...headerChanges,
			}),
			JSON.stringify(claims),
		]
			.map((value) => Buffer.from(value).toString("base64url"))
			.join(".");
		body.authorization = `${input}.${sign(null, Buffer.from(input), signingKey).toString("base64url")}`;
		return body;
	};
	return {
		read,
		request,
		at,
		facts,
		readPreparation,
		isBusinessStateEmpty,
		options,
		material,
		issuer,
		start,
	};
}

it.each(["reserve", "claimed"] as const)(
	"signs current %s evidence with only the consumed Host key",
	async (phase) => {
		const f = await fixture();
		const request = f.request(
			phase === "claimed"
				? {
						scope: {
							phase,
							claimRef: "claim-original",
							allocationRef: "allocation-original",
						},
					}
				: {},
		);
		const result = await f.read(request);
		expect(SessionInstanceEvidenceV1Schema.parse(result)).toEqual(result);
		const [header, payload, signature] = result.signature.split(".") as [
			string,
			string,
			string,
		];
		expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
			alg: "EdDSA",
			typ: "session-instance-evidence-v1",
			kid: "host-original",
		});
		const claims = SessionInstanceEvidenceClaimsV1Schema.parse(
			JSON.parse(Buffer.from(payload, "base64url").toString()),
		);
		expect(claims).toEqual({
			...Object.fromEntries(
				Object.entries(result).filter(([key]) => key !== "signature"),
			),
			audience: "worker-original",
			purpose: "session-instance-evidence-v1",
		});
		const publicKey = createPublicKey({
			key: Buffer.from(f.material.host.statement.publicKey, "base64url"),
			type: "spki",
			format: "der",
		});
		const runnerKey = createPublicKey({
			key: Buffer.from(f.material.runner.statement.publicKey, "base64url"),
			type: "spki",
			format: "der",
		});
		expect(
			verify(
				null,
				Buffer.from(`${header}.${payload}`),
				publicKey,
				Buffer.from(signature, "base64url"),
			),
		).toBe(true);
		expect(
			verify(
				null,
				Buffer.from(`${header}.${payload}`),
				runnerKey,
				Buffer.from(signature, "base64url"),
			),
		).toBe(false);
		expect(result.scope).toEqual(request.scope);
		expect(result.observedAt).toBe(f.at.now);
		expect(result.expiresAt).toBe(f.at.now + 10_000);
		const bytes = JSON.stringify(result);
		for (const key of ["authorization", "privateKey", "logs", "userContent"])
			expect(result).not.toHaveProperty(key);
		for (const secret of [
			f.material.host.privateKey,
			f.material.runner.privateKey,
			f.options.binding.workspaceRoot,
		])
			expect(bytes).not.toContain(secret);
		await expect(f.read(request)).rejects.toMatchObject({
			code: "RUNTIME_SESSION_INSTANCE_DENIED",
		});
	},
);

it.each([
	"workerId",
	"namespace",
	"agentId",
	"sessionId",
	"sandboxId",
	"podUid",
	"generation",
	"resourceFence",
	"startupRef",
	"bindingDigest",
	"profileDigest",
] as const)(
	"rejects signed cross-instance %s before touching the runner",
	async (field) => {
		const f = await fixture();
		const value = f.request()[field];
		const request = f.request({
			[field]:
				typeof value === "number"
					? value + 1
					: field.endsWith("Digest")
						? "c".repeat(64)
						: "foreign",
		});
		await expect(f.read(request)).rejects.toMatchObject({
			code: "RUNTIME_SESSION_INSTANCE_DENIED",
		});
		expect(f.readPreparation).not.toHaveBeenCalled();
	},
);

it.each([
	{ issuer: "foreign" },
	{ workerId: "foreign" },
	{ audience: "runtime_host" },
	{ purpose: "runtime-readiness" },
	{ expiresAt: 1 },
	{ issuedAt: Number.MAX_SAFE_INTEGER },
	{ expiresAt: Number.MAX_SAFE_INTEGER },
	{ requestDigest: "c".repeat(64) },
	{ extra: "not-allowed" },
])("rejects invalid signed authorization %j", async (claims) => {
	const f = await fixture();
	await expect(f.read(f.request({}, claims))).rejects.toMatchObject({
		code: "RUNTIME_SESSION_INSTANCE_DENIED",
	});
	expect(f.readPreparation).not.toHaveBeenCalled();
});

it("rejects unsigned, wrong-key and tampered requests, including before an async concurrent nonce can replay", async () => {
	const f = await fixture();
	await expect(
		f.read({ ...f.request(), authorization: "unsigned" }),
	).rejects.toMatchObject({ code: "RUNTIME_SESSION_INSTANCE_DENIED" });
	await expect(
		f.read(f.request({}, {}, generateKeyPairSync("ed25519").privateKey)),
	).rejects.toMatchObject({ code: "RUNTIME_SESSION_INSTANCE_DENIED" });
	const tampered = f.request();
	tampered.scope = {
		phase: "claimed",
		claimRef: "other",
		allocationRef: "other",
	};
	await expect(f.read(tampered)).rejects.toMatchObject({
		code: "RUNTIME_SESSION_INSTANCE_DENIED",
	});
	const pending = Promise.withResolvers<SessionInstancePreparationFactsV1>();
	f.readPreparation.mockReturnValueOnce(pending.promise);
	const request = f.request();
	const first = f.read(request);
	await expect(f.read(request)).rejects.toMatchObject({
		code: "RUNTIME_SESSION_INSTANCE_DENIED",
	});
	pending.resolve(f.facts);
	await first;
	expect(f.readPreparation).toHaveBeenCalledOnce();
});

it.each([
	"runnerIdentityConsumed",
	"deliveryFilesRemoved",
	"executorReady",
	"emptyBusinessState",
] as const)("refuses missing runner fact %s", async (field) => {
	const f = await fixture();
	f.readPreparation.mockResolvedValue({ ...f.facts, [field]: false });
	await expect(f.read(f.request())).rejects.toMatchObject({
		code: "RUNTIME_SESSION_INSTANCE_UNAVAILABLE",
	});
});

it("requires local empty persistence, delivery removal and the original runner epoch", async () => {
	const f = await fixture();
	f.isBusinessStateEmpty.mockReturnValue(false);
	await expect(f.read(f.request())).rejects.toMatchObject({
		code: "RUNTIME_SESSION_INSTANCE_UNAVAILABLE",
	});
	f.isBusinessStateEmpty.mockReturnValue(true);
	await writeFile(delivery.path, "unexpected late delivery", { mode: 0o400 });
	await expect(f.read(f.request())).rejects.toMatchObject({
		code: "RUNTIME_SESSION_INSTANCE_UNAVAILABLE",
	});
	await rm(delivery.path);
	f.readPreparation.mockResolvedValue({
		...f.facts,
		runnerEpoch: "replacement",
	});
	await expect(f.read(f.request())).rejects.toMatchObject({
		code: "RUNTIME_SESSION_INSTANCE_DENIED",
	});
});

it("rechecks time after runner I/O and gives stalled or cancelled I/O a bounded failure", async () => {
	const f = await fixture();
	const request = f.request();
	f.readPreparation.mockImplementationOnce(async () => {
		f.at.now += 10_000;
		return f.facts;
	});
	await expect(f.read(request)).rejects.toMatchObject({
		code: "RUNTIME_SESSION_INSTANCE_DENIED",
	});
	const abort = new AbortController();
	f.readPreparation.mockImplementationOnce(async () => new Promise(() => {}));
	const pending = f.read(f.request(), abort.signal);
	abort.abort();
	await expect(pending).rejects.toMatchObject({
		code: "RUNTIME_SESSION_INSTANCE_UNAVAILABLE",
	});
	f.readPreparation.mockImplementationOnce(async () => {
		throw new Error("private-canary /private/path token=not-a-real-token");
	});
	await expect(f.read(f.request())).rejects.toMatchObject({
		message: "Session instance evidence is unavailable",
	});
});

it("does not accept a verified but unconsumed identity, a runner key or a serialized lookalike", async () => {
	const f = await fixture();
	const expected = {
		...f.start,
		now: Date.now(),
		issuerKey: f.issuer.publicKey,
	};
	const unconsumed = verifyExecutorStartIdentityV1(f.material.host, {
		...expected,
		role: "host",
	});
	expect(() =>
		createSessionInstanceReaderV1({ ...f.options, identity: unconsumed }),
	).toThrow("unavailable");
	const runner = verifyExecutorStartIdentityV1(f.material.runner, {
		...expected,
		role: "runner",
	});
	expect(() =>
		createSessionInstanceReaderV1({ ...f.options, identity: runner }),
	).toThrow("not authorized");
	expect(() =>
		createSessionInstanceReaderV1({
			...f.options,
			identity: { ...f.options.identity },
		}),
	).toThrow();
});

it.each([
	'{"schemaVersion":1,"schemaVersion":1}',
	'{"schemaVersion":1,"schemaVersion":2}',
	'{"scope":{"phase":"reserve","ph\\u0061se":"reserve"}}',
	'{"schemaVersion":1,"unknown":"canary"}',
	'{"schemaVersion":1.1}',
	"null",
	"[1]",
	"{",
	" ".repeat(65_537),
])("rejects malformed, duplicate, unknown or oversized JSON", async (raw) => {
	await expect(
		readSessionInstanceBodyV1(
			new Request(`http://runtime${sessionInstanceReadPathV1}`, {
				method: "POST",
				body: raw,
			}),
		),
	).rejects.toMatchObject({ code: "RUNTIME_REQUEST_INVALID" });
});

it("does not turn truthy malformed readiness into a signed success", async () => {
	const f = await fixture();
	f.readPreparation.mockResolvedValue({
		...f.facts,
		executorReady: "true",
	} as unknown as SessionInstancePreparationFactsV1);
	await expect(f.read(f.request())).rejects.toMatchObject({
		code: "RUNTIME_SESSION_INSTANCE_UNAVAILABLE",
	});
});

it("serves signed evidence through the authenticated HTTP route without touching business state", async () => {
	const f = await fixture();
	const { FakeRuntimeDriver, FileRuntimeStore, RuntimeHost } = await import(
		"@agent-infra/agent-runtime"
	);
	const { createRuntimeHostApp } = await import("./app.js");
	const directory = await mkdtemp(join(tmpdir(), "session-instance-http-"));
	directories.push(directory);
	const host = await RuntimeHost.open({
		store: await FileRuntimeStore.open(join(directory, "host.json")),
		driver: await FakeRuntimeDriver.open(join(directory, "driver.json")),
		grantValidation: { expectedIssuer: "platform" },
	});
	const app = createRuntimeHostApp({
		host,
		serviceToken: "synthetic-internal-service-token",
		verifyGrant: () => {
			throw new Error("business grant must not be used");
		},
		sessionInstanceRead: f.read,
	});
	const request = f.request();
	const issue = (body: unknown, token = "synthetic-internal-service-token") =>
		app.request(sessionInstanceReadPathV1, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
	try {
		expect((await issue(request, "wrong")).status).toBe(401);
		const result = await issue(request);
		expect(result.status).toBe(200);
		expect(
			SessionInstanceEvidenceV1Schema.parse(await result.json()).requestId,
		).toBe(request.requestId);
		expect((await issue(request)).status).toBe(403);
		expect(
			(await issue({ ...f.request(), extra: "PRIVATE_BODY_CANARY" })).status,
		).toBe(400);
		f.readPreparation.mockRejectedValueOnce(
			new Error("PRIVATE_ERROR_CANARY /private/path"),
		);
		const unavailable = await issue(f.request());
		expect(unavailable.status).toBe(503);
		const error = await unavailable.text();
		expect(error).toContain("RUNTIME_SESSION_INSTANCE_UNAVAILABLE");
		expect(error).not.toContain("PRIVATE_ERROR_CANARY");
		expect(error).not.toContain("/private/path");
	} finally {
		await host.close();
	}
});

it.each([
	{ alg: "none" },
	{ kid: "foreign" },
	{ typ: "workload-readiness-v1" },
	{ extra: true },
])("rejects wrong or extended JWS header %j", async (header) => {
	const f = await fixture();
	await expect(
		f.read(f.request({}, {}, undefined, header)),
	).rejects.toMatchObject({ code: "RUNTIME_SESSION_INSTANCE_DENIED" });
	expect(f.readPreparation).not.toHaveBeenCalled();
});
it("keeps the consumed original instance readable after its one-time startup deadline", async () => {
	const f = await fixture();
	f.at.now = f.start.expiresAt + 1;
	expect((await f.read(f.request())).checks.hostIdentityConsumed).toBe(true);
});
