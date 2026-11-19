import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:https";
import type { AddressInfo, LookupFunction } from "node:net";
import {
	type ConnectionHostSupplyBindingV1,
	type ConnectionInstallTlsExporterV1,
	connectionInstallServerExporterV1,
	encodeConnectionHostSupplyAadV1,
	openConnectionHostSupplyV1,
} from "@agent-infra/agent-runtime";
import {
	ConnectionHostSupplyClaimsV1Schema,
	ConnectionHostSupplyRequestV1Schema,
	ConnectionInstallBeginStatusRequestV1Schema,
	ConnectionInstallCommandClaimsV1Schema,
	ConnectionInstallCommandRequestV1Schema,
	ConnectionInstallFirstBeginGrantClaimsV1Schema,
	ConnectionInstallFirstBeginRequestV1Schema,
	type ConnectionRegistrationReceiptV1,
	type ConnectionRegistrationTemplateV1,
	ConnectionRegistrationTemplateV1Schema,
	canonicalRuntimeRequestSigningPayload,
	connectionInstallExporterLabelsV1,
	connectionInstallJwsTypesV1,
	connectionInstallPathsV1,
	type RuntimeOAuthAuthorizedRequestV1,
	type RuntimeOAuthConfigurationV1,
	type RuntimeOAuthResponseV1,
	runtimeOAuthScopeV1,
} from "@agent-infra/contracts/runtime";
import {
	connectionInstallConfigurationDigestV1,
	connectionInstallRequestDigestV1,
	connectionRegistrationKeyHashV1,
	connectionRegistrationReceiptDigestV1,
	connectionRegistrationTemplateDigestV1,
} from "@agent-infra/contracts/runtime/connection-install-node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";
import { createConnectionInstallHostClientV1 } from "./connection-install-host-client.js";

const hostName = "sandbox-sbx-1.agents.svc";
const fixedNow = 1_800_000_000_000;
const registrationKey = "registration-key-0001";
/** Synthetic canary; it must never appear outside the AEAD envelope. */
const credentialText = "conn_consumer_canary-4206-host-client";
const keys = generateKeyPairSync("ed25519");
const lookup: LookupFunction = (_hostname, options, callback) => {
	if (typeof options === "object" && options?.all)
		(callback as (e: null, a: { address: string; family: number }[]) => void)(
			null,
			[{ address: "127.0.0.1", family: 4 }],
		);
	else callback(null, "127.0.0.1", 4);
};
const signal = () => AbortSignal.timeout(5_000);

let tls: Awaited<ReturnType<typeof runtimeTlsFixture>>;
let other: Awaited<ReturnType<typeof runtimeTlsFixture>>;
beforeAll(async () => {
	tls = await runtimeTlsFixture({ dnsNames: [hostName] });
	other = await runtimeTlsFixture({ dnsNames: [hostName] });
});
afterAll(async () => {
	await tls?.cleanup();
	await other?.cleanup();
});
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	await Promise.all(closers.splice(0).map((close) => close()));
});

function client(ca = tls.ca) {
	return createConnectionInstallHostClientV1({
		ca,
		signing: {
			issuer: "platform-worker",
			workerId: "worker-1",
			keyId: "worker-key-1",
			privateKey: keys.privateKey,
			now: () => fixedNow,
		},
		lookup,
	});
}

interface ReceivedV1 {
	readonly path: string;
	readonly raw: string;
	/** Exporter value of the server side of the same TLS connection. */
	readonly channel: string;
	readonly exporter: ConnectionInstallTlsExporterV1;
}
type Reply = { readonly status?: number; readonly body: unknown };

/** Minimal Session Host: real TLS 1.3, exporter recomputed on the server socket. */
async function startHost(reply: (received: ReceivedV1) => Reply) {
	const received: ReceivedV1[] = [];
	const failures: unknown[] = [];
	let connections = 0;
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
				let result: Reply;
				try {
					const exporter = connectionInstallServerExporterV1(request.socket);
					const entry = {
						path: request.url ?? "",
						raw: Buffer.concat(chunks).toString("utf8"),
						channel: exporter(
							connectionInstallExporterLabelsV1.channel,
							32,
						).toString("base64url"),
						exporter,
					};
					received.push(entry);
					result = reply(entry);
				} catch (error) {
					failures.push(error);
					result = { status: 500, body: {} };
				}
				const bytes = Buffer.from(
					typeof result.body === "string"
						? result.body
						: JSON.stringify(result.body),
				);
				response.writeHead(result.status ?? 200, {
					"content-type": "application/json",
					"content-length": String(bytes.byteLength),
				});
				response.end(bytes);
			});
		},
	);
	server.on("connection", () => {
		connections += 1;
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	closers.push(
		() =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	);
	return {
		origin: `https://${hostName}:${(server.address() as AddressInfo).port}/`,
		received,
		failures,
		connections: () => connections,
	};
}

/** Surfaces the Host-side assertion that turned into a 500, if any. */
async function settle<T>(
	host: { readonly failures: unknown[] },
	promise: Promise<T>,
): Promise<T> {
	try {
		return await promise;
	} catch (error) {
		throw host.failures[0] ?? error;
	}
}

function decodeJws(token: string, typ: string): unknown {
	const [header = "", payload = "", signature = ""] = token.split(".");
	expect(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).toEqual(
		{ alg: "EdDSA", kid: "worker-key-1", typ },
	);
	expect(
		verify(
			null,
			Buffer.from(`${header}.${payload}`, "ascii"),
			keys.publicKey,
			Buffer.from(signature, "base64url"),
		),
	).toBe(true);
	return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function expectInstallClaims(claims: unknown, received: ReceivedV1) {
	expect(claims).toMatchObject({
		schemaVersion: 1,
		audience: "runtime_connection_install",
		issuer: "platform-worker",
		workerId: "worker-1",
		issuedAt: fixedNow,
		expiresAt: fixedNow + 30_000,
		channelBinding: received.channel,
	});
}

function credentialEncodings(): string[] {
	const bytes = Buffer.from(credentialText, "utf8");
	return [
		credentialText,
		"canary-4206",
		bytes.toString("base64"),
		bytes.toString("base64url"),
		bytes.toString("hex"),
	];
}

function expectNoCredential(text: string) {
	for (const encoded of credentialEncodings())
		expect(text).not.toContain(encoded);
}

function describeError(error: unknown): string {
	const value = error as Error;
	return [
		String(error),
		value?.message,
		value?.stack,
		JSON.stringify(error),
		JSON.stringify(Object.entries(value ?? {})),
	].join("\n");
}

function templateFor(origin: string): ConnectionRegistrationTemplateV1 {
	return ConnectionRegistrationTemplateV1Schema.parse({
		schemaVersion: 1,
		principal: { kind: "user", id: "user-1" },
		reference: {
			agentId: "agent-1",
			conversationId: "conversation-1",
			executionId: "execution-1",
			sessionGeneration: 3,
		},
		authorizationId: "authorization-1",
		confirmationRevision: "confirmation-1",
		association: { connectionAgentId: "connection-agent-1", revision: 2 },
		claim: { owner: "worker-claim-owner", fence: 9 },
		target: {
			deploymentIdentity: "session-sandbox-v1/agents/worker-1",
			hostRef: "host-session-1",
			sandboxId: "sbx-1",
			podUid: "pod-uid-1",
			sessionGeneration: 3,
			resourceFence: 5,
			runtimeOrigin: origin,
		},
		systemAccess: {
			configFingerprint: "b".repeat(64),
			source: { ref: "connection-system-access", revision: "r1" },
		},
		registration: {
			endpoint:
				"https://connection.test/connection/v1/agents/connection-agent-1/oauth-clients",
			clientName: "Agent Infra",
			redirectUri: "https://platform.test/connection/oauth/callback",
			resource: "https://connection.test/mcp",
			scope: "mcp",
			source: { ref: "connection-association:agent-1", revision: "2" },
			configFingerprint: "c".repeat(64),
			registrationKeyHash: connectionRegistrationKeyHashV1(registrationKey),
		},
		supply: { ref: "connection-manual-association:agent-1", revision: "2" },
	});
}

function targetOf(template: ConnectionRegistrationTemplateV1) {
	const { runtimeOrigin: _origin, ...target } = template.target;
	return target;
}

/** The Host's own AAD tuple, built from its local facts rather than the request. */
function localBinding(
	template: ConnectionRegistrationTemplateV1,
	attemptId = "supply-attempt-1",
): ConnectionHostSupplyBindingV1 {
	return {
		...targetOf(template),
		supplyRef: template.supply.ref,
		supplyRevision: template.supply.revision,
		attemptId,
		templateDigest: connectionRegistrationTemplateDigestV1(template),
	};
}

function receiptFor(
	template: ConnectionRegistrationTemplateV1,
	key = registrationKey,
): ConnectionRegistrationReceiptV1 {
	return {
		registrationKey: key,
		clientId: "client-1",
		clientName: template.registration.clientName,
		clientStatus: "ACTIVE",
		configFingerprint: template.registration.configFingerprint,
		consumerId: "consumer-1",
		createdAt: "2026-11-01T00:00:00.000Z",
		instanceId: "instance-1",
		instanceStatus: "ACTIVE",
		principalId: null,
		redirectUri: template.registration.redirectUri,
		resource: template.registration.resource,
		scope: "mcp",
		source: template.registration.source,
		status: "ACTIVE",
	};
}

function configurationFor(
	template: ConnectionRegistrationTemplateV1,
): RuntimeOAuthConfigurationV1 {
	return {
		schemaVersion: 1,
		ref: `connection-manual-install:${template.authorizationId}`,
		revision: "d".repeat(64),
		clientId: "client-1",
		issuer: "https://connection.test/",
		authorizationEndpoint: "https://connection.test/oauth/authorize",
		tokenEndpoint: "https://connection.test/oauth/token",
		revocationEndpoint: "https://connection.test/oauth/revoke",
		callbackUrl: template.registration.redirectUri,
		runtimeOrigin: template.target.runtimeOrigin,
		resource: template.registration.resource,
		scope: "mcp",
		configFingerprint: template.registration.configFingerprint,
		source: template.registration.source,
	};
}

function beginRequestFor(
	template: ConnectionRegistrationTemplateV1,
	configuration: RuntimeOAuthConfigurationV1,
): Omit<RuntimeOAuthAuthorizedRequestV1, "grant"> {
	return {
		schemaVersion: 1,
		agentId: template.reference.agentId,
		sandboxId: template.target.sandboxId,
		podUid: template.target.podUid,
		sessionGeneration: template.target.sessionGeneration,
		configFingerprint: template.registration.configFingerprint,
		source: template.registration.source,
		oauthConfiguration: {
			ref: configuration.ref,
			revision: configuration.revision,
		},
		authorizationId: template.authorizationId,
		confirmationRevision: template.confirmationRevision,
		reference: template.reference,
		command: "begin",
	};
}

function linkFor(
	configuration: RuntimeOAuthConfigurationV1,
	overrides: Readonly<Record<string, string>> = {},
): string {
	const url = new URL(configuration.authorizationEndpoint);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: configuration.clientId,
		redirect_uri: configuration.callbackUrl,
		state: "e".repeat(64),
		scope: configuration.scope,
		resource: configuration.resource,
		code_challenge_method: "S256",
		code_challenge: "A".repeat(43),
		...overrides,
	}).toString();
	return url.href;
}

function linkResponse(
	template: ConnectionRegistrationTemplateV1,
	configuration: RuntimeOAuthConfigurationV1,
): RuntimeOAuthResponseV1 {
	return {
		schemaVersion: 1,
		authorizationId: template.authorizationId,
		phase: "awaiting_callback",
		expiresAt: fixedNow + 600_000,
		authorizationUrl: linkFor(configuration),
	};
}

const attempt = {
	commandId: "command-1",
	attemptId: "command-attempt-1",
	attemptOwner: "worker-1",
	supplyAttemptId: "supply-attempt-1",
} as const;
const expected = {
	consumerId: "consumer-1",
	clientId: "client-1",
	instanceId: "instance-1",
} as const;

describe("Connection install Host client: supply", () => {
	it("delivers the credential only as ciphertext bound to this TLS connection and the local AAD", async () => {
		let template!: ConnectionRegistrationTemplateV1;
		let opened: Buffer | undefined;
		const host = await startHost((received) => {
			expect(received.path).toBe(connectionInstallPathsV1.supply);
			const body = ConnectionHostSupplyRequestV1Schema.parse(
				JSON.parse(received.raw),
			);
			const claims = ConnectionHostSupplyClaimsV1Schema.parse(
				decodeJws(body.grant, connectionInstallJwsTypesV1.supply),
			);
			expectInstallClaims(claims, received);
			expect(claims.purpose).toBe("connection_host_supply");
			expect(claims.requestDigest).toBe(connectionInstallRequestDigestV1(body));
			expect(body.template).toEqual(template);
			const binding = localBinding(template);
			expect(claims.binding).toEqual(binding);
			const key = received.exporter(
				connectionInstallExporterLabelsV1.supplyKey,
				32,
				encodeConnectionHostSupplyAadV1(binding),
			);
			opened = openConnectionHostSupplyV1(body.envelope, key, binding);
			// Ciphertext sealed for any other Host, Pod, attempt or template never opens.
			for (const [field, value] of Object.entries({
				deploymentIdentity: "session-sandbox-v1/agents/worker-2",
				hostRef: "host-session-other",
				sandboxId: "sbx-2",
				podUid: "pod-uid-before-rebuild",
				sessionGeneration: 4,
				resourceFence: 6,
				supplyRef: "connection-manual-association:agent-2",
				supplyRevision: "3",
				attemptId: "supply-attempt-old",
				templateDigest: "f".repeat(64),
			})) {
				const changed = { ...binding, [field]: value };
				expect(() =>
					openConnectionHostSupplyV1(body.envelope, key, changed),
				).toThrow("CONNECTION_HOST_SUPPLY_UNAVAILABLE");
				const changedKey = received.exporter(
					connectionInstallExporterLabelsV1.supplyKey,
					32,
					encodeConnectionHostSupplyAadV1(changed),
				);
				expect(() =>
					openConnectionHostSupplyV1(body.envelope, changedKey, changed),
				).toThrow("CONNECTION_HOST_SUPPLY_UNAVAILABLE");
			}
			return {
				body: {
					schemaVersion: 1,
					outcome: "confirmed",
					attemptId: body.attemptId,
					templateDigest: connectionRegistrationTemplateDigestV1(body.template),
				},
			};
		});
		template = templateFor(host.origin);
		const credential = Buffer.from(credentialText, "utf8");
		await expect(
			settle(
				host,
				client().supply(
					{
						template,
						attemptId: "supply-attempt-1",
						credential,
						target: targetOf(template),
					},
					signal(),
				),
			),
		).resolves.toBeUndefined();
		expect(host.failures).toEqual([]);
		expect(opened?.equals(Buffer.from(credentialText, "utf8"))).toBe(true);
		expect(host.received).toHaveLength(1);
		const raw = host.received[0]?.raw ?? "";
		expectNoCredential(raw);
		expectNoCredential(
			JSON.stringify(
				decodeJws(
					ConnectionHostSupplyRequestV1Schema.parse(JSON.parse(raw)).grant,
					connectionInstallJwsTypesV1.supply,
				),
			),
		);
	});

	it("never sends a body to a Host outside the deployment trust", async () => {
		const host = await startHost(() => ({ body: {} }));
		const template = templateFor(host.origin);
		const error = await client(other.ca)
			.supply(
				{
					template,
					attemptId: "supply-attempt-1",
					credential: Buffer.from(credentialText, "utf8"),
					target: targetOf(template),
				},
				signal(),
			)
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({
			code: "CONNECTION_INSTALLATION_UNAVAILABLE",
			retryable: false,
		});
		expect(host.received).toHaveLength(0);
		expectNoCredential(describeError(error));
	});

	it.each([
		["another Host ref", { hostRef: "host-session-other" }],
		["a pre-rebuild Pod UID", { podUid: "pod-uid-before-rebuild" }],
		["another Sandbox", { sandboxId: "sbx-2" }],
		["another session generation", { sessionGeneration: 4 }],
		["another resource fence", { resourceFence: 6 }],
		[
			"another deployment",
			{ deploymentIdentity: "session-sandbox-v1/agents/worker-2" },
		],
		["an extra target field", { runtimeOrigin: "https://elsewhere.svc:9443/" }],
	])("rejects a target with %s before connecting", async (_name, change) => {
		const host = await startHost(() => ({ body: {} }));
		const template = templateFor(host.origin);
		const error = await client()
			.supply(
				{
					template,
					attemptId: "supply-attempt-1",
					credential: Buffer.from(credentialText, "utf8"),
					target: { ...targetOf(template), ...change },
				},
				signal(),
			)
			.catch((caught: unknown) => caught);
		expect(error).toMatchObject({
			code: "CONNECTION_INSTALLATION_UNAVAILABLE",
		});
		expectNoCredential(describeError(error));
		expect(host.connections()).toBe(0);
	});

	it("rejects a non-strict template, attempt or credential before connecting", async () => {
		const host = await startHost(() => ({ body: {} }));
		const template = templateFor(host.origin);
		const valid = {
			template,
			attemptId: "supply-attempt-1",
			credential: Buffer.from(credentialText, "utf8") as Uint8Array,
			target: targetOf(template),
		};
		for (const input of [
			{
				...valid,
				template: {
					...template,
					extra: true,
				} as unknown as ConnectionRegistrationTemplateV1,
			},
			{
				...valid,
				template: {
					...template,
					supply: { ...template.supply, ref: "" },
				},
			},
			{ ...valid, attemptId: "" },
			{ ...valid, credential: new Uint8Array(0) },
			{ ...valid, credential: new Uint8Array(8_193) },
			{ ...valid, credential: credentialText as unknown as Uint8Array },
		])
			await expect(client().supply(input, signal())).rejects.toMatchObject({
				code: "CONNECTION_INSTALLATION_UNAVAILABLE",
			});
		expect(host.connections()).toBe(0);
	});

	it("treats a failed or mismatched confirmation as unavailable without echoing the credential", async () => {
		let reply: (body: { attemptId: string }) => Reply = () => ({
			status: 503,
			body: {},
		});
		const host = await startHost((received) => reply(JSON.parse(received.raw)));
		const template = templateFor(host.origin);
		const templateDigest = connectionRegistrationTemplateDigestV1(template);
		const replies: ((body: { attemptId: string }) => Reply)[] = [
			() => ({ status: 503, body: {} }),
			() => ({ status: 403, body: { code: credentialText } }),
			() => ({
				body: {
					schemaVersion: 1,
					outcome: "confirmed",
					attemptId: "supply-attempt-old",
					templateDigest,
				},
			}),
			() => ({
				body: {
					schemaVersion: 1,
					outcome: "confirmed",
					attemptId: "supply-attempt-1",
					templateDigest: "f".repeat(64),
				},
			}),
			() => ({ body: "not json" }),
			() => ({ body: { echoed: credentialText.repeat(500) } }),
		];
		for (const next of replies) {
			reply = next;
			const error = await client()
				.supply(
					{
						template,
						attemptId: "supply-attempt-1",
						credential: Buffer.from(credentialText, "utf8"),
						target: targetOf(template),
					},
					signal(),
				)
				.catch((caught: unknown) => caught);
			expect(error).toMatchObject({
				code: "CONNECTION_INSTALLATION_UNAVAILABLE",
				retryable: false,
			});
			expectNoCredential(describeError(error));
		}
		expect(host.received).toHaveLength(replies.length);
		for (const received of host.received) expectNoCredential(received.raw);
	});
});

describe("Connection install Host client: registration commands", () => {
	it("signs prepare, status and revoke for this connection and the original key", async () => {
		let template!: ConnectionRegistrationTemplateV1;
		const grants: string[] = [];
		const host = await startHost((received) => {
			const body = ConnectionInstallCommandRequestV1Schema.parse(
				JSON.parse(received.raw),
			);
			expect(received.path).toBe(connectionInstallPathsV1[body.command]);
			expect(body.template).toEqual(template);
			expect(body.registrationKey).toBe(registrationKey);
			const claims = ConnectionInstallCommandClaimsV1Schema.parse(
				decodeJws(body.grant, connectionInstallJwsTypesV1.registration),
			);
			expectInstallClaims(claims, received);
			expect(claims).toMatchObject({
				purpose: "connection_registration",
				command: body.command,
				commandId: body.commandId,
				attemptId: body.attemptId,
				attemptOwner: body.attemptOwner,
				authorizationId: template.authorizationId,
				templateDigest: connectionRegistrationTemplateDigestV1(template),
				supplyAttemptId: body.supplyAttemptId,
				registrationKeyHash: template.registration.registrationKeyHash,
				requestDigest: connectionInstallRequestDigestV1(body),
			});
			grants.push(claims.grantId);
			if (body.command === "prepare") {
				expect(body.expected).toBeUndefined();
				return {
					body: {
						schemaVersion: 1,
						outcome: "registered",
						commandId: body.commandId,
						receipt: receiptFor(template),
					},
				};
			}
			if (body.command === "status")
				return {
					body: {
						schemaVersion: 1,
						outcome: "unknown",
						commandId: body.commandId,
					},
				};
			expect(body.expected).toEqual(expected);
			return {
				body: {
					schemaVersion: 1,
					outcome: "revoked",
					commandId: body.commandId,
				},
			};
		});
		template = templateFor(host.origin);
		const c = client();
		const base = { ...attempt, template, registrationKey };
		await expect(
			settle(host, c.command({ ...base, command: "prepare" }, signal())),
		).resolves.toEqual({
			schemaVersion: 1,
			outcome: "registered",
			commandId: attempt.commandId,
			receipt: receiptFor(template),
		});
		await expect(
			settle(
				host,
				c.command(
					{ ...base, command: "status", commandId: "command-2" },
					signal(),
				),
			),
		).resolves.toEqual({
			schemaVersion: 1,
			outcome: "unknown",
			commandId: "command-2",
		});
		await expect(
			settle(
				host,
				c.command(
					{ ...base, command: "revoke", commandId: "command-3", expected },
					signal(),
				),
			),
		).resolves.toEqual({
			schemaVersion: 1,
			outcome: "revoked",
			commandId: "command-3",
		});
		expect(host.failures).toEqual([]);
		// One fresh connection and one single-use grant per command.
		expect(new Set(grants).size).toBe(3);
		expect(new Set(host.received.map((entry) => entry.channel)).size).toBe(3);
	});

	it("rejects answers that do not match the original command or key", async () => {
		let reply: (body: { commandId: string }) => Reply = () => ({ body: {} });
		const host = await startHost((received) => reply(JSON.parse(received.raw)));
		const template = templateFor(host.origin);
		const base = { ...attempt, template, registrationKey };
		const cases: [
			"prepare" | "status" | "revoke",
			(body: { commandId: string }) => Reply,
		][] = [
			[
				"prepare",
				(body) => ({
					body: {
						schemaVersion: 1,
						outcome: "registered",
						commandId: body.commandId,
						receipt: receiptFor(template, "registration-key-0002"),
					},
				}),
			],
			[
				"status",
				(body) => ({
					body: {
						schemaVersion: 1,
						outcome: "registered",
						commandId: body.commandId,
						receipt: { ...receiptFor(template), principalId: "principal-1" },
					},
				}),
			],
			[
				"prepare",
				(body) => ({
					body: {
						schemaVersion: 1,
						outcome: "revoked",
						commandId: body.commandId,
					},
				}),
			],
			[
				"revoke",
				(body) => ({
					body: {
						schemaVersion: 1,
						outcome: "registered",
						commandId: body.commandId,
						receipt: receiptFor(template),
					},
				}),
			],
			[
				"status",
				() => ({
					body: {
						schemaVersion: 1,
						outcome: "unknown",
						commandId: "command-other",
					},
				}),
			],
			[
				"prepare",
				(body) => ({
					status: 409,
					body: {
						schemaVersion: 1,
						outcome: "rejected",
						commandId: body.commandId,
					},
				}),
			],
			["prepare", () => ({ body: { padding: "x".repeat(16_400) } })],
		];
		for (const [command, next] of cases) {
			reply = next;
			await expect(
				client().command(
					{ ...base, command, ...(command === "revoke" ? { expected } : {}) },
					signal(),
				),
			).rejects.toMatchObject({ code: "CONNECTION_INSTALLATION_UNAVAILABLE" });
		}
		expect(host.received).toHaveLength(cases.length);
	});

	it("rejects another registration key or a malformed revoke before connecting", async () => {
		const host = await startHost(() => ({ body: {} }));
		const template = templateFor(host.origin);
		const base = { ...attempt, template, registrationKey };
		for (const input of [
			{
				...base,
				command: "prepare" as const,
				registrationKey: "registration-key-0002",
			},
			{ ...base, command: "status" as const, registrationKey: "short" },
			{ ...base, command: "prepare" as const, expected },
			{ ...base, command: "revoke" as const },
			{ ...base, command: "prepare" as const, commandId: "" },
			{
				...base,
				command: "status" as const,
				template: { ...template, authorizationId: "" },
			},
		])
			await expect(client().command(input, signal())).rejects.toMatchObject({
				code: "CONNECTION_INSTALLATION_UNAVAILABLE",
			});
		expect(host.connections()).toBe(0);
	});
});

describe("Connection install Host client: first begin", () => {
	function firstBeginInput(template: ConnectionRegistrationTemplateV1) {
		const configuration = configurationFor(template);
		return {
			commandId: "begin-1",
			attemptId: "begin-attempt-1",
			attemptOwner: "worker-1",
			template,
			supplyAttemptId: "supply-attempt-1",
			receipt: receiptFor(template),
			configuration,
			request: beginRequestFor(template, configuration),
			principal: { kind: "user" as const, id: "user-1" },
		};
	}

	it("signs the installation JWS over the request and the exact first-begin body", async () => {
		let template!: ConnectionRegistrationTemplateV1;
		const host = await startHost((received) => {
			expect(received.path).toBe(connectionInstallPathsV1.begin);
			const body = ConnectionInstallFirstBeginRequestV1Schema.parse(
				JSON.parse(received.raw),
			);
			const input = firstBeginInput(template);
			expect(body).toMatchObject({
				schemaVersion: 1,
				commandId: input.commandId,
				attemptId: input.attemptId,
				attemptOwner: input.attemptOwner,
				template,
				supplyAttemptId: input.supplyAttemptId,
				receipt: input.receipt,
				configuration: input.configuration,
			});
			expect(body.request.grant.format).toBe(
				"runtime-connection-installation-jws",
			);
			const claims = ConnectionInstallFirstBeginGrantClaimsV1Schema.parse(
				decodeJws(
					body.request.grant.token,
					connectionInstallJwsTypesV1.firstBegin,
				),
			);
			expect(claims).toMatchObject({
				schemaVersion: 1,
				purpose: "connection_installation",
				audience: "runtime_connection_client",
				issuer: "platform-worker",
				workerId: "worker-1",
				principal: template.principal,
				reference: template.reference,
				command: "begin",
				authorizationId: template.authorizationId,
				confirmationRevision: template.confirmationRevision,
				issuedAt: fixedNow,
				expiresAt: fixedNow + 30_000,
				requestDigest: createHash("sha256")
					.update(canonicalRuntimeRequestSigningPayload(body.request))
					.digest("hex"),
				firstBegin: {
					commandId: input.commandId,
					attemptId: input.attemptId,
					attemptOwner: input.attemptOwner,
					templateDigest: connectionRegistrationTemplateDigestV1(template),
					supplyAttemptId: input.supplyAttemptId,
					registrationKeyHash: template.registration.registrationKeyHash,
					receiptDigest: connectionRegistrationReceiptDigestV1(body.receipt),
					configurationDigest: connectionInstallConfigurationDigestV1(
						body.configuration,
					),
					bodyDigest: connectionInstallRequestDigestV1({
						...body,
						request: { ...body.request, grant: undefined },
					}),
					channelBinding: received.channel,
				},
			});
			expect(claims.connectionPrincipalId).toBeUndefined();
			const scope = runtimeOAuthScopeV1(body.request);
			expect(runtimeOAuthScopeV1(claims)).toEqual(scope);
			expect(scope).toEqual({
				agentId: template.reference.agentId,
				sandboxId: template.target.sandboxId,
				podUid: template.target.podUid,
				sessionGeneration: template.target.sessionGeneration,
				configFingerprint: template.registration.configFingerprint,
				source: template.registration.source,
				oauthConfiguration: {
					ref: input.configuration.ref,
					revision: input.configuration.revision,
				},
			});
			return { body: linkResponse(template, input.configuration) };
		});
		template = templateFor(host.origin);
		const input = firstBeginInput(template);
		await expect(
			settle(host, client().firstBegin(input, signal())),
		).resolves.toEqual(linkResponse(template, input.configuration));
		expect(host.failures).toEqual([]);
	});

	it.each([
		[
			"another configuration runtime origin",
			(input: ReturnType<typeof firstBeginInput>) => ({
				...input,
				configuration: {
					...input.configuration,
					runtimeOrigin: "https://sandbox-sbx-2.agents.svc:9443/",
				},
			}),
		],
		[
			"another configuration revision in the request",
			(input: ReturnType<typeof firstBeginInput>) => ({
				...input,
				request: {
					...input.request,
					oauthConfiguration: {
						...input.request.oauthConfiguration,
						revision: "r2",
					},
				},
			}),
		],
		[
			"another installation authorization",
			(input: ReturnType<typeof firstBeginInput>) => ({
				...input,
				request: { ...input.request, authorizationId: "authorization-2" },
			}),
		],
		[
			"another confirmation revision",
			(input: ReturnType<typeof firstBeginInput>) => ({
				...input,
				request: { ...input.request, confirmationRevision: "confirmation-2" },
			}),
		],
		[
			"another original execution",
			(input: ReturnType<typeof firstBeginInput>) => ({
				...input,
				request: {
					...input.request,
					reference: { ...input.request.reference, executionId: "execution-2" },
				},
			}),
		],
		[
			"another user",
			(input: ReturnType<typeof firstBeginInput>) => ({
				...input,
				principal: { kind: "user" as const, id: "user-2" },
			}),
		],
		[
			"another Agent",
			(input: ReturnType<typeof firstBeginInput>) => ({
				...input,
				request: { ...input.request, agentId: "agent-2" },
			}),
		],
		[
			"another Pod",
			(input: ReturnType<typeof firstBeginInput>) => ({
				...input,
				request: { ...input.request, podUid: "pod-uid-before-rebuild" },
			}),
		],
		[
			"a receipt for another registration key",
			(input: ReturnType<typeof firstBeginInput>) => ({
				...input,
				receipt: receiptFor(input.template, "registration-key-0002"),
			}),
		],
		[
			"a configuration for another client",
			(input: ReturnType<typeof firstBeginInput>) => ({
				...input,
				configuration: { ...input.configuration, clientId: "client-2" },
			}),
		],
		[
			"a PAT binding configuration",
			(input: ReturnType<typeof firstBeginInput>) => ({
				...input,
				configuration: {
					...input.configuration,
					patBinding: {
						consumerId: "consumer-1",
						bindingEndpoint: "https://connection.test/pat-bindings",
					},
				},
			}),
		],
		[
			"a non-begin command",
			(input: ReturnType<typeof firstBeginInput>) => ({
				...input,
				request: { ...input.request, command: "confirm" as const },
			}),
		],
	])("rejects %s before connecting", async (_name, change) => {
		const host = await startHost(() => ({ body: {} }));
		const template = templateFor(host.origin);
		await expect(
			client().firstBegin(change(firstBeginInput(template)), signal()),
		).rejects.toMatchObject({ code: "CONNECTION_INSTALLATION_UNAVAILABLE" });
		expect(host.connections()).toBe(0);
	});

	it("accepts only the standard authorization link for this configuration", async () => {
		let reply: () => Reply = () => ({ body: {} });
		const host = await startHost(() => reply());
		const template = templateFor(host.origin);
		const configuration = configurationFor(template);
		const valid = linkResponse(template, configuration);
		const extra = new URL(linkFor(configuration));
		extra.searchParams.append("prompt", "none");
		const duplicate = new URL(linkFor(configuration));
		duplicate.searchParams.append("state", "e".repeat(64));
		for (const body of [
			{
				...valid,
				authorizationUrl: linkFor(configuration, { client_id: "client-2" }),
			},
			{
				...valid,
				authorizationUrl: linkFor(configuration, {
					redirect_uri: "https://evil.test/callback",
				}),
			},
			{
				...valid,
				authorizationUrl: linkFor(configuration, { state: "not-hex" }),
			},
			{
				...valid,
				authorizationUrl: linkFor(configuration, {
					code_challenge_method: "plain",
				}),
			},
			{ ...valid, authorizationUrl: extra.href },
			{ ...valid, authorizationUrl: duplicate.href },
			{
				...valid,
				authorizationUrl: linkFor(configuration).replace(
					"https://connection.test/oauth/authorize",
					"https://connection.test/oauth/other",
				),
			},
			{
				...valid,
				authorizationUrl: linkFor(configuration).replace(
					"https://connection.test/",
					"https://evil.test/",
				),
			},
			{ ...valid, callbackStateHash: "a".repeat(64) },
			{ ...valid, authorizationId: "authorization-2" },
			{ ...valid, phase: "awaiting_confirmation" },
			{
				schemaVersion: 1,
				authorizationId: template.authorizationId,
				phase: "awaiting_callback",
				expiresAt: fixedNow + 600_000,
			},
		]) {
			reply = () => ({ body });
			await expect(
				client().firstBegin(
					{
						commandId: "begin-1",
						attemptId: "begin-attempt-1",
						attemptOwner: "worker-1",
						template,
						supplyAttemptId: "supply-attempt-1",
						receipt: receiptFor(template),
						configuration,
						request: beginRequestFor(template, configuration),
						principal: { kind: "user", id: "user-1" },
					},
					signal(),
				),
			).rejects.toMatchObject({ code: "CONNECTION_INSTALLATION_UNAVAILABLE" });
		}
		expect(host.received.length).toBeGreaterThan(0);
	});
});

describe("Connection install Host client: begin status", () => {
	it("recovers the consumed first begin with a registration JWS and validates the stored link", async () => {
		let template!: ConnectionRegistrationTemplateV1;
		let stored: unknown;
		const host = await startHost((received) => {
			expect(received.path).toBe(connectionInstallPathsV1.beginStatus);
			const parsed = JSON.parse(received.raw) as Record<string, unknown>;
			// The configuration only validates the answer; it is never sent.
			expect(Object.keys(parsed)).not.toContain("configuration");
			const body = ConnectionInstallBeginStatusRequestV1Schema.parse(parsed);
			expect(body).toMatchObject({
				...attempt,
				beginCommandId: "begin-1",
				template,
				registrationKey,
			});
			const claims = ConnectionInstallCommandClaimsV1Schema.parse(
				decodeJws(body.grant, connectionInstallJwsTypesV1.registration),
			);
			expectInstallClaims(claims, received);
			expect(claims).toMatchObject({
				purpose: "connection_registration",
				command: "begin_status",
				...attempt,
				authorizationId: template.authorizationId,
				templateDigest: connectionRegistrationTemplateDigestV1(template),
				registrationKeyHash: template.registration.registrationKeyHash,
				requestDigest: connectionInstallRequestDigestV1(body),
			});
			return { body: stored };
		});
		template = templateFor(host.origin);
		const configuration = configurationFor(template);
		const input = {
			...attempt,
			beginCommandId: "begin-1",
			template,
			registrationKey,
			configuration,
		};
		stored = linkResponse(template, configuration);
		await expect(
			settle(host, client().beginStatus(input, signal())),
		).resolves.toEqual(stored);
		expect(host.failures).toEqual([]);
		stored = {
			...linkResponse(template, configuration),
			authorizationUrl: linkFor(configuration, { client_id: "client-2" }),
		};
		await expect(client().beginStatus(input, signal())).rejects.toMatchObject({
			code: "CONNECTION_INSTALLATION_UNAVAILABLE",
		});
		const connections = host.connections();
		for (const changed of [
			{ ...input, registrationKey: "registration-key-0002" },
			{
				...input,
				configuration: {
					...configuration,
					runtimeOrigin: "https://sandbox-sbx-2.agents.svc:9443/",
				},
			},
			{ ...input, beginCommandId: "" },
		])
			await expect(
				client().beginStatus(changed, signal()),
			).rejects.toMatchObject({ code: "CONNECTION_INSTALLATION_UNAVAILABLE" });
		expect(host.connections()).toBe(connections);
	});
});

describe("Connection install Host client: construction", () => {
	it("requires an Ed25519 private signing key and a CA bundle", () => {
		const signing = {
			issuer: "platform-worker",
			workerId: "worker-1",
			keyId: "worker-key-1",
			privateKey: keys.privateKey,
		};
		expect(() =>
			createConnectionInstallHostClientV1({ ca: tls.ca, signing }),
		).not.toThrow();
		for (const options of [
			{ ca: "", signing },
			{ ca: tls.ca, signing: { ...signing, privateKey: keys.publicKey } },
			{
				ca: tls.ca,
				signing: {
					...signing,
					privateKey: generateKeyPairSync("ec", { namedCurve: "P-256" })
						.privateKey,
				},
			},
			{ ca: tls.ca, signing: { ...signing, keyId: "" } },
			{ ca: tls.ca, signing: { ...signing, issuer: "" } },
		])
			expect(() => createConnectionInstallHostClientV1(options)).toThrow(
				TypeError,
			);
	});
});
