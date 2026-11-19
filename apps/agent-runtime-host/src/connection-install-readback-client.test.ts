import { once } from "node:events";
import { createServer } from "node:https";
import type { AddressInfo, LookupFunction } from "node:net";
import { connectionInstallServerExporterV1 } from "@agent-infra/agent-runtime";
import {
	ConnectionInstallReadbackRequestV1Schema,
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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";
import {
	type ConnectionInstallReadbackInputV1,
	createConnectionInstallReadbackClientV1,
} from "./connection-install-readback-client.js";

const workerHost = "platform-worker.agents.svc";
const installToken = "synthetic-session-install-token-0001-abcdef";
const lookup: LookupFunction = (_hostname, options, callback) => {
	if (typeof options === "object" && options?.all)
		(callback as (e: null, a: { address: string; family: number }[]) => void)(
			null,
			[{ address: "127.0.0.1", family: 4 }],
		);
	else callback(null, "127.0.0.1", 4);
};
const input: ConnectionInstallReadbackInputV1 = {
	purpose: "command",
	target: {
		deploymentIdentity: "session-sandbox-v1/agents/worker-a",
		hostRef: "host-ref-a",
		sandboxId: "s1",
		podUid: "pod-uid-1",
		sessionGeneration: 3,
		resourceFence: 7,
		runtimeOrigin: "https://sandbox-s1.agents.svc:8443/",
	},
	principal: { kind: "user", id: "alice" },
	reference: {
		agentId: "agent-a",
		conversationId: "conversation-a",
		executionId: "execution-a",
		sessionGeneration: 3,
	},
	authorizationId: "authorization-a",
	confirmationRevision: "confirmation-r1",
	templateDigest: "a".repeat(64),
	supply: {
		ref: "connection-manual-association:agent-a",
		revision: "2",
		attemptId: "supply-attempt-1",
	},
	command: {
		commandId: "prepare-1",
		attemptId: "command-attempt-1",
		attemptOwner: "worker-a:command-owner",
		command: "prepare",
		requestDigest: "b".repeat(64),
		registrationKeyHash: "c".repeat(64),
	},
};

type Behavior =
	| "allowed"
	| "denied"
	| "unavailable"
	| "status-403"
	| "status-503"
	| "request-proof"
	| "missing-proof"
	| "foreign-nonce"
	| "foreign-digest"
	| "unknown-field"
	| "oversized";

let tls: Awaited<ReturnType<typeof runtimeTlsFixture>>;
let foreign: Awaited<ReturnType<typeof runtimeTlsFixture>>;
const closes: (() => Promise<void>)[] = [];
beforeAll(async () => {
	tls = await runtimeTlsFixture({ dnsNames: [workerHost] });
	foreign = await runtimeTlsFixture({ dnsNames: [workerHost] });
});
afterAll(async () => {
	await tls?.cleanup();
	await foreign?.cleanup();
});
afterEach(async () => {
	for (const close of closes.splice(0).reverse()) await close();
});

/** Controlled Worker readback endpoint; it verifies the proof on its own TLS socket. */
async function worker(behavior: Behavior) {
	const key = connectionInstallReadbackKeyV1(installToken);
	const seen: {
		method: string | undefined;
		path: string | undefined;
		authorization: string;
		body: string;
		verified: boolean;
	}[] = [];
	const server = createServer(
		{
			key: tls.key,
			cert: tls.cert,
			minVersion: "TLSv1.3",
			maxVersion: "TLSv1.3",
		},
		(request, response) => {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const body = Buffer.concat(chunks);
				const channel = connectionInstallServerExporterV1(request.socket)(
					connectionInstallExporterLabelsV1.readback,
					32,
				).toString("base64url");
				const authorization = request.headers.authorization ?? "";
				const [scheme, mac = ""] = authorization.split(" ");
				const verified =
					scheme === connectionInstallReadbackAuthSchemeV1 &&
					verifyConnectionInstallReadbackMacV1(
						key,
						"request",
						channel,
						connectionInstallBodyDigestV1(body),
						mac,
					);
				seen.push({
					method: request.method,
					path: request.url,
					authorization,
					body: body.toString("utf8"),
					verified,
				});
				if (!verified || behavior === "status-403") {
					response.writeHead(403, { "content-type": "application/json" });
					response.end("{}");
					return;
				}
				if (behavior === "status-503") {
					response.writeHead(503, { "content-type": "application/json" });
					response.end("{}");
					return;
				}
				const received = JSON.parse(body.toString("utf8"));
				const bytes = Buffer.from(
					JSON.stringify({
						schemaVersion: 1,
						outcome:
							behavior === "denied" || behavior === "unavailable"
								? behavior
								: "allowed",
						nonce:
							behavior === "foreign-nonce" ? "A".repeat(43) : received.nonce,
						requestDigest:
							behavior === "foreign-digest"
								? "0".repeat(64)
								: connectionInstallBodyDigestV1(body),
						...(behavior === "unknown-field" ? { extra: true } : {}),
						...(behavior === "oversized" ? { padding: "x".repeat(8192) } : {}),
					}),
				);
				const proof = connectionInstallReadbackMacV1(
					key,
					behavior === "request-proof" ? "request" : "response",
					channel,
					connectionInstallBodyDigestV1(bytes),
				);
				response.writeHead(200, {
					"content-type": "application/json",
					...(behavior === "missing-proof"
						? {}
						: { [connectionInstallReadbackResponseHeaderV1]: proof }),
				});
				response.end(bytes);
			});
		},
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	closes.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return {
		seen,
		origin: `https://${workerHost}:${(server.address() as AddressInfo).port}/`,
	};
}

describe("Connection install readback client", () => {
	it("binds each readback to a fresh nonce and its own TLS channel", async () => {
		const endpoint = await worker("allowed");
		let clock = 1_700_000_000_000;
		const client = createConnectionInstallReadbackClientV1({
			origin: endpoint.origin,
			ca: tls.ca,
			installToken,
			lookup,
			now: () => clock,
		});
		expect(await client.readback(input, new AbortController().signal)).toBe(
			"allowed",
		);
		clock += 1;
		expect(await client.readback(input, new AbortController().signal)).toBe(
			"allowed",
		);
		expect(endpoint.seen).toHaveLength(2);
		const [first, second] = endpoint.seen.map((request) =>
			ConnectionInstallReadbackRequestV1Schema.parse(JSON.parse(request.body)),
		);
		for (const request of endpoint.seen) {
			expect(request).toMatchObject({
				method: "POST",
				path: connectionInstallPathsV1.readback,
				verified: true,
			});
			expect(request.authorization).not.toContain(installToken);
			expect(request.body).not.toContain(installToken);
		}
		expect(first).toEqual({
			...input,
			schemaVersion: 1,
			nonce: first?.nonce,
			issuedAt: 1_700_000_000_000,
			expiresAt: 1_700_000_030_000,
		});
		expect(first?.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(second?.nonce).not.toBe(first?.nonce);
		expect(endpoint.seen[0]?.authorization).not.toBe(
			endpoint.seen[1]?.authorization,
		);
	});

	it.each(["allowed", "denied", "unavailable"] as const)(
		"returns the authenticated %s outcome",
		async (outcome) => {
			const endpoint = await worker(outcome);
			const client = createConnectionInstallReadbackClientV1({
				origin: endpoint.origin,
				ca: tls.ca,
				installToken,
				lookup,
			});
			expect(await client.readback(input, new AbortController().signal)).toBe(
				outcome,
			);
		},
	);

	it.each([
		["status-403", "unavailable"],
		["status-503", "unavailable"],
		["request-proof", "unavailable"],
		["missing-proof", "unavailable"],
		["foreign-nonce", "unavailable"],
		["foreign-digest", "unavailable"],
		["unknown-field", "unavailable"],
		["oversized", "unavailable"],
	] as const)(
		"maps a %s response to %s without retrying",
		async (behavior, expected) => {
			const endpoint = await worker(behavior);
			const client = createConnectionInstallReadbackClientV1({
				origin: endpoint.origin,
				ca: tls.ca,
				installToken,
				lookup,
			});
			expect(await client.readback(input, new AbortController().signal)).toBe(
				expected,
			);
			expect(endpoint.seen).toHaveLength(1);
		},
	);

	it("rejects a proof keyed by another Sandbox install token", async () => {
		const endpoint = await worker("allowed");
		const client = createConnectionInstallReadbackClientV1({
			origin: endpoint.origin,
			ca: tls.ca,
			installToken: "synthetic-session-install-token-0002-other",
			lookup,
		});
		expect(await client.readback(input, new AbortController().signal)).toBe(
			"unavailable",
		);
		expect(endpoint.seen).toEqual([
			expect.objectContaining({ verified: false }),
		]);
	});

	it("sends nothing to a Worker certificate outside the pinned CA", async () => {
		const endpoint = await worker("allowed");
		const client = createConnectionInstallReadbackClientV1({
			origin: endpoint.origin,
			ca: foreign.ca,
			installToken,
			lookup,
		});
		expect(await client.readback(input, new AbortController().signal)).toBe(
			"unavailable",
		);
		expect(endpoint.seen).toHaveLength(0);
	});

	it("never sends a request that is not a strict readback", async () => {
		const endpoint = await worker("allowed");
		const client = createConnectionInstallReadbackClientV1({
			origin: endpoint.origin,
			ca: tls.ca,
			installToken,
			lookup,
		});
		for (const invalid of [
			{ ...input, target: { ...input.target, sessionGeneration: 0 } },
			{ ...input, extra: "field" } as ConnectionInstallReadbackInputV1,
		])
			expect(await client.readback(invalid, new AbortController().signal)).toBe(
				"unavailable",
			);
		const aborted = new AbortController();
		aborted.abort();
		expect(await client.readback(input, aborted.signal)).toBe("unavailable");
		expect(endpoint.seen).toHaveLength(0);
	});

	it.each([
		["plaintext", "http://platform-worker.agents.svc:8443/", installToken],
		["implicit port", "https://platform-worker.agents.svc/", installToken],
		["path", "https://platform-worker.agents.svc:8443/readback", installToken],
		["query", "https://platform-worker.agents.svc:8443/?a=1", installToken],
		["userinfo", "https://u:p@platform-worker.agents.svc:8443/", installToken],
		["non-canonical", "https://platform-worker.agents.svc:8443", installToken],
		["short token", "https://platform-worker.agents.svc:8443/", "too-short"],
	])("rejects a %s configuration at construction", (_name, origin, token) => {
		expect(() =>
			createConnectionInstallReadbackClientV1({
				origin,
				ca: tls.ca,
				installToken: token,
			}),
		).toThrow();
	});

	it("rejects a CA bundle without a certificate at construction", () => {
		expect(() =>
			createConnectionInstallReadbackClientV1({
				origin: "https://platform-worker.agents.svc:8443/",
				ca: "not a certificate",
				installToken,
			}),
		).toThrow();
	});
});
