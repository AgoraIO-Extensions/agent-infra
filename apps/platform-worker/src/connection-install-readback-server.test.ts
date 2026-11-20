import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { requestOverConnectionInstallTlsV1 } from "@agent-infra/agent-runtime";
import {
	type ConnectionInstallReadbackRequestV1,
	ConnectionInstallReadbackResponseV1Schema,
	connectionHostDeploymentIdentityV1,
	connectionInstallExporterLabelsV1,
	connectionInstallPathsV1,
	connectionInstallReadbackAuthSchemeV1,
	connectionInstallReadbackResponseHeaderV1,
} from "@agent-infra/contracts/runtime";
import {
	connectionInstallBodyDigestV1,
	connectionInstallReadbackKeyV1,
	connectionInstallReadbackMacV1,
	verifyConnectionInstallReadbackMacV1,
} from "@agent-infra/contracts/runtime/connection-install-node";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";
import {
	createConnectionInstallReadbackServerV1,
	sessionSandboxConnectionInstallTokenV1,
} from "./connection-install-readback-server.js";
import { WorkloadKubernetesError } from "./kubernetes-client.js";
import { sessionSandboxServiceTokenV1 } from "./session-workload-adapter.js";

const workerHost = "platform-worker-install.agent-infra.svc";
const namespace = "agent-sandboxes";
const sandboxId = "sbx-1";
const deploymentServiceToken = "synthetic-deployment-service-token";
const deploymentIdentity = connectionHostDeploymentIdentityV1({
	namespace,
	workerId: "worker-1",
});
const runtimeOrigin = `https://sandbox-${sandboxId}.${namespace}.svc:9443/`;
const sandboxToken = sessionSandboxConnectionInstallTokenV1(
	deploymentServiceToken,
	namespace,
	sandboxId,
);
const lookup: LookupFunction = (_hostname, options, callback) => {
	if (typeof options === "object" && options?.all)
		(callback as (e: null, a: { address: string; family: number }[]) => void)(
			null,
			[{ address: "127.0.0.1", family: 4 }],
		);
	else callback(null, "127.0.0.1", 4);
};
type Outcome = "allowed" | "denied" | "unavailable";
type Readback = (
	request: ConnectionInstallReadbackRequestV1,
	signal: AbortSignal,
) => Promise<Outcome>;

let tls: Awaited<ReturnType<typeof runtimeTlsFixture>>;
beforeAll(async () => {
	tls = await runtimeTlsFixture({ dnsNames: [workerHost] });
});
afterAll(async () => {
	await tls?.cleanup();
});
const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function start(
	options: {
		readonly readback?: Readback;
		readonly maxReplayEntries?: number;
	} = {},
) {
	const clock = { now: 1_800_000_000_000 };
	const readback = vi.fn<Readback>(options.readback ?? (async () => "allowed"));
	const server = createConnectionInstallReadbackServerV1({
		key: tls.key,
		cert: tls.cert,
		port: 0,
		host: "127.0.0.1",
		deploymentServiceToken,
		namespace,
		deploymentIdentity,
		readback,
		now: () => clock.now,
		...(options.maxReplayEntries
			? { maxReplayEntries: options.maxReplayEntries }
			: {}),
	});
	servers.push(server);
	const port = await server.listen();
	return { clock, readback, origin: `https://${workerHost}:${port}/` };
}

function readbackRequest(
	issuedAt: number,
	overrides: Partial<ConnectionInstallReadbackRequestV1> = {},
): ConnectionInstallReadbackRequestV1 {
	return {
		schemaVersion: 1,
		purpose: "command",
		target: {
			deploymentIdentity,
			hostRef: "host-session-1",
			sandboxId,
			podUid: "pod-uid-1",
			sessionGeneration: 3,
			resourceFence: 5,
			runtimeOrigin,
		},
		principal: { kind: "user", id: "user-1" },
		reference: {
			agentId: "agent-1",
			conversationId: "conversation-1",
			executionId: "execution-1",
			sessionGeneration: 3,
		},
		authorizationId: "authorization-1",
		confirmationRevision: "confirmation-1",
		templateDigest: "a".repeat(64),
		supply: {
			ref: "connection-manual-association:agent-1",
			revision: "2",
			attemptId: "supply-attempt-1",
		},
		command: {
			commandId: "command-1",
			attemptId: "attempt-1",
			attemptOwner: "worker-1",
			command: "prepare",
			requestDigest: "b".repeat(64),
			registrationKeyHash: "c".repeat(64),
		},
		nonce: randomBytes(32).toString("base64url"),
		issuedAt,
		expiresAt: issuedAt + 30_000,
		...overrides,
	};
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");

/** The Host side of the readback: fresh TLS 1.3, MAC over this channel and the exact bytes. */
async function post(
	origin: string,
	body: Uint8Array,
	options: { readonly token?: string; readonly channel?: string } = {},
) {
	const key = connectionInstallReadbackKeyV1(options.token ?? sandboxToken);
	let channel = "";
	const response = await requestOverConnectionInstallTlsV1({
		origin,
		path: connectionInstallPathsV1.readback,
		ca: tls.ca,
		signal: AbortSignal.timeout(5_000),
		maxResponseBytes: 4_096,
		lookup,
		prepare: (exporter) => {
			channel = exporter(
				connectionInstallExporterLabelsV1.readback,
				32,
			).toString("base64url");
			const mac = connectionInstallReadbackMacV1(
				key,
				"request",
				options.channel ?? channel,
				connectionInstallBodyDigestV1(body),
			);
			return {
				body,
				headers: {
					authorization: `${connectionInstallReadbackAuthSchemeV1} ${mac}`,
				},
			};
		},
	});
	return { ...response, channel, key };
}

/** Plain HTTPS request for the routing checks the install transport cannot express. */
function raw(
	origin: string,
	options: {
		readonly method: string;
		readonly path: string;
		readonly headers?: Readonly<Record<string, string>>;
		readonly body?: Buffer;
		readonly headersOnly?: boolean;
	},
) {
	const url = new URL(origin);
	return new Promise<{
		status: number;
		headers: IncomingHttpHeaders;
		body: string;
	}>((resolve, reject) => {
		const request = httpsRequest(
			{
				host: url.hostname,
				port: Number(url.port),
				servername: url.hostname,
				path: options.path,
				method: options.method,
				ca: tls.ca,
				lookup,
				agent: false,
				minVersion: "TLSv1.3",
				headers: {
					...(options.body
						? { "content-length": String(options.body.byteLength) }
						: {}),
					...options.headers,
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("error", reject);
				response.once("end", () => {
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					});
					request.destroy();
				});
			},
		);
		request.on("error", reject);
		if (options.headersOnly) request.flushHeaders();
		else request.end(options.body);
	});
}

function answer(response: { readonly body: Buffer }) {
	return ConnectionInstallReadbackResponseV1Schema.parse(
		JSON.parse(response.body.toString("utf8")),
	);
}

function proofVerifies(response: {
	readonly body: Buffer;
	readonly headers: IncomingHttpHeaders;
	readonly key: Buffer;
	readonly channel: string;
}) {
	const proof = response.headers[connectionInstallReadbackResponseHeaderV1];
	return (
		typeof proof === "string" &&
		verifyConnectionInstallReadbackMacV1(
			response.key,
			"response",
			response.channel,
			connectionInstallBodyDigestV1(response.body),
			proof,
		)
	);
}

describe("Connection install readback server", () => {
	it("answers an authenticated readback bound to the exact request and this TLS channel", async () => {
		const f = await start();
		const request = readbackRequest(f.clock.now);
		const body = encode(request);
		const response = await post(f.origin, body);
		expect(response.status).toBe(200);
		expect(response.headers["cache-control"]).toBe("no-store");
		expect(answer(response)).toEqual({
			schemaVersion: 1,
			outcome: "allowed",
			nonce: request.nonce,
			requestDigest: connectionInstallBodyDigestV1(body),
		});
		expect(proofVerifies(response)).toBe(true);
		// The response proof is purpose- and channel-separated.
		const proof = String(
			response.headers[connectionInstallReadbackResponseHeaderV1],
		);
		const digest = connectionInstallBodyDigestV1(response.body);
		expect(
			verifyConnectionInstallReadbackMacV1(
				response.key,
				"request",
				response.channel,
				digest,
				proof,
			),
		).toBe(false);
		expect(
			verifyConnectionInstallReadbackMacV1(
				response.key,
				"response",
				randomBytes(32).toString("base64url"),
				digest,
				proof,
			),
		).toBe(false);
		expect(f.readback).toHaveBeenCalledOnce();
		const [received, signal] = f.readback.mock.calls[0] ?? [];
		expect(received).toEqual(request);
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal?.aborted).toBe(false);
	});

	it("passes a denied outcome through as an authenticated answer", async () => {
		const f = await start({ readback: async () => "denied" });
		const request = readbackRequest(f.clock.now, { purpose: "supply" });
		const response = await post(f.origin, encode(request));
		expect(response.status).toBe(200);
		expect(answer(response)).toMatchObject({
			outcome: "denied",
			nonce: request.nonce,
		});
		expect(proofVerifies(response)).toBe(true);
	});

	it("reports unavailable with a valid proof when the Store readback throws", async () => {
		const f = await start({
			readback: async () => {
				throw new Error("synthetic store failure");
			},
		});
		const request = readbackRequest(f.clock.now);
		const response = await post(f.origin, encode(request));
		expect(response.status).toBe(200);
		expect(answer(response)).toMatchObject({
			outcome: "unavailable",
			nonce: request.nonce,
		});
		expect(proofVerifies(response)).toBe(true);
		expect(response.body.toString("utf8")).not.toContain("synthetic");
	});

	it("rejects a proof keyed for another Sandbox, deployment or purpose", async () => {
		const f = await start();
		for (const token of [
			sessionSandboxConnectionInstallTokenV1(
				deploymentServiceToken,
				namespace,
				"sbx-2",
			),
			sessionSandboxConnectionInstallTokenV1(
				"another-deployment-service-token",
				namespace,
				sandboxId,
			),
			// The business transport token of the same Sandbox is not an install proof.
			sessionSandboxServiceTokenV1(
				deploymentServiceToken,
				namespace,
				sandboxId,
			),
		]) {
			const response = await post(
				f.origin,
				encode(readbackRequest(f.clock.now)),
				{ token },
			);
			expect(response.status).toBe(403);
			expect(response.body.toString("utf8")).toBe("{}");
			expect(
				response.headers[connectionInstallReadbackResponseHeaderV1],
			).toBeUndefined();
		}
		expect(f.readback).not.toHaveBeenCalled();
	});

	it("accepts each nonce once", async () => {
		const f = await start();
		const body = encode(readbackRequest(f.clock.now));
		expect((await post(f.origin, body)).status).toBe(200);
		// A new TLS connection and a fresh MAC do not make a used nonce valid.
		expect((await post(f.origin, body)).status).toBe(403);
		expect(f.readback).toHaveBeenCalledOnce();
	});

	it("rejects expired, future-dated and overlong proofs", async () => {
		const f = await start();
		const now = f.clock.now;
		for (const request of [
			readbackRequest(now - 31_000),
			readbackRequest(now - 30_000),
			readbackRequest(now + 1_001),
			readbackRequest(now, { expiresAt: now + 30_001 }),
			readbackRequest(now, { expiresAt: now }),
		])
			expect((await post(f.origin, encode(request))).status).toBe(403);
		expect(f.readback).not.toHaveBeenCalled();
		// One second of Host clock skew is tolerated.
		expect(
			(await post(f.origin, encode(readbackRequest(now + 1_000)))).status,
		).toBe(200);
		expect(f.readback).toHaveBeenCalledOnce();
	});

	it("rejects a MAC computed for another TLS connection", async () => {
		const f = await start();
		const first = await post(f.origin, encode(readbackRequest(f.clock.now)));
		expect(first.status).toBe(200);
		const replayed = await post(
			f.origin,
			encode(readbackRequest(f.clock.now)),
			{ channel: first.channel },
		);
		expect(replayed.status).toBe(403);
		expect(replayed.channel).not.toBe(first.channel);
		expect(f.readback).toHaveBeenCalledOnce();
	});

	it("rejects another deployment identity or a Host name outside this Sandbox", async () => {
		const f = await start();
		const target = readbackRequest(f.clock.now).target;
		for (const changed of [
			{
				...target,
				deploymentIdentity: connectionHostDeploymentIdentityV1({
					namespace,
					workerId: "worker-2",
				}),
			},
			{
				...target,
				runtimeOrigin: `https://sandbox-sbx-2.${namespace}.svc:9443/`,
			},
			{
				...target,
				runtimeOrigin: `https://sandbox-${sandboxId}.other.svc:9443/`,
			},
		]) {
			const response = await post(
				f.origin,
				encode(readbackRequest(f.clock.now, { target: changed })),
			);
			expect(response.status).toBe(403);
		}
		expect(f.readback).not.toHaveBeenCalled();
	});

	it("serves only an authenticated POST on the exact readback path", async () => {
		const f = await start();
		const body = encode(readbackRequest(f.clock.now));
		const wrongMethod = await raw(f.origin, {
			method: "GET",
			path: connectionInstallPathsV1.readback,
		});
		expect(wrongMethod).toMatchObject({ status: 405, body: "{}" });
		expect(wrongMethod.headers.allow).toBe("POST");
		for (const path of [
			"/internal/platform-worker/v1/connection-install",
			`${connectionInstallPathsV1.readback}?purpose=supply`,
		])
			expect(await raw(f.origin, { method: "POST", path, body })).toMatchObject(
				{ status: 404, body: "{}" },
			);
		for (const authorization of [
			undefined,
			`Bearer ${sandboxToken}`,
			`${connectionInstallReadbackAuthSchemeV1} not-a-mac`,
		])
			expect(
				await raw(f.origin, {
					method: "POST",
					path: connectionInstallPathsV1.readback,
					body,
					...(authorization ? { headers: { authorization } } : {}),
				}),
			).toMatchObject({ status: 403, body: "{}" });
		// A valid MAC over bytes that are not the strict request is still rejected.
		const malformed = await post(f.origin, Buffer.from('{"schemaVersion":1}'));
		expect(malformed.status).toBe(403);
		expect(
			await raw(f.origin, {
				method: "POST",
				path: connectionInstallPathsV1.readback,
				headers: { "content-length": "16385" },
				headersOnly: true,
			}),
		).toMatchObject({ status: 413, body: "{}" });
		expect(f.readback).not.toHaveBeenCalled();
	});

	it("fails closed while the bounded replay window is full", async () => {
		const f = await start({ maxReplayEntries: 1 });
		expect(
			(await post(f.origin, encode(readbackRequest(f.clock.now)))).status,
		).toBe(200);
		expect(
			(await post(f.origin, encode(readbackRequest(f.clock.now)))).status,
		).toBe(503);
		f.clock.now += 30_000;
		expect(
			(await post(f.origin, encode(readbackRequest(f.clock.now)))).status,
		).toBe(200);
		expect(f.readback).toHaveBeenCalledTimes(2);
	});

	it("derives a purpose-separated install token per namespace and Sandbox", () => {
		expect(sandboxToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(
			sessionSandboxConnectionInstallTokenV1(
				deploymentServiceToken,
				namespace,
				sandboxId,
			),
		).toBe(sandboxToken);
		for (const other of [
			sessionSandboxConnectionInstallTokenV1(
				deploymentServiceToken,
				namespace,
				"sbx-2",
			),
			sessionSandboxConnectionInstallTokenV1(
				deploymentServiceToken,
				"other-sandboxes",
				sandboxId,
			),
			sessionSandboxConnectionInstallTokenV1(
				"rotated-deployment-service-token",
				namespace,
				sandboxId,
			),
			sessionSandboxServiceTokenV1(
				deploymentServiceToken,
				namespace,
				sandboxId,
			),
			deploymentServiceToken,
		])
			expect(other).not.toBe(sandboxToken);
		for (const [token, ns, id] of [
			["", namespace, sandboxId],
			[deploymentServiceToken, "Agent_Sandboxes", sandboxId],
			[deploymentServiceToken, namespace, ""],
			[deploymentServiceToken, namespace, "sbx 1"],
			[deploymentServiceToken, namespace, "sbx\u00001"],
		] as const)
			expect(() =>
				sessionSandboxConnectionInstallTokenV1(token, ns, id),
			).toThrow(WorkloadKubernetesError);
	});
});
