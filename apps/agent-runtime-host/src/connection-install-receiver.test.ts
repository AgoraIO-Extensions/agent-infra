import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import type { Server } from "node:https";
import {
	type AddressInfo,
	connect,
	createServer as createNetServer,
	type LookupFunction,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import { isDeepStrictEqual } from "node:util";
import {
	type ConnectionInstallTlsExporterV1,
	encodeConnectionHostSupplyAadV1,
	RuntimeHostError,
	requestOverConnectionInstallTlsV1,
	sealConnectionHostSupplyV1,
} from "@agent-infra/agent-runtime";
import {
	connectionSystemAccessFingerprintV1,
	resolveApprovedConnectionSystemAccessV1,
} from "@agent-infra/contracts/connection-consumer-profile";
import {
	type ConnectionRegistrationReceiptV1,
	type ConnectionRegistrationTemplateV1,
	canonicalRuntimeRequestSigningPayload,
	connectionHostDeploymentIdentityV1,
	connectionInstallExporterLabelsV1,
	connectionInstallJwsTypesV1,
	connectionInstallPathsV1,
	connectionManualSupplyReferenceV1,
	type RuntimeOAuthConfigurationV1,
} from "@agent-infra/contracts/runtime";
import {
	connectionInstallConfigurationDigestV1,
	connectionInstallRequestDigestV1,
	connectionMachineRegistrationEndpointV1,
	connectionManualConsumerTargetV1,
	connectionManualInstallConfigurationV1,
	connectionRegistrationKeyHashV1,
	connectionRegistrationReceiptDigestV1,
	connectionRegistrationTemplateDigestV1,
} from "@agent-infra/contracts/runtime/connection-install-node";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";
import {
	createConnectionInstallReadbackServerV1,
	sessionSandboxConnectionInstallTokenV1,
} from "../../platform-worker/src/connection-install-readback-server.js";
import {
	type ConnectionInstallReadbackClientV1,
	type ConnectionInstallReadbackInputV1,
	type ConnectionInstallReadbackOutcomeV1,
	createConnectionInstallReadbackClientV1,
} from "./connection-install-readback-client.js";
import {
	prepareConnectionInstallReceiverV1,
	startConnectionInstallReceiverServerV1,
} from "./connection-install-receiver.js";
import {
	assembleRuntimeHost,
	closeRuntimeHost,
	startRuntimeHost,
} from "./index.js";

const protection = vi.hoisted(() => ({ check: vi.fn() }));
// Receiver tests exercise real private files and TLS, not Linux acceptance.
vi.mock("./process-protection.js", () => ({
	assertRuntimeProcessProtection: vi.fn(),
}));

vi.mock("./standard-mcp-protection.js", () => ({
	assertStandardMcpProcessProtection: protection.check,
}));
const decryption = vi.hoisted(() => ({
	opened: 0,
	capture: undefined as Buffer[] | undefined,
}));
vi.mock("@agent-infra/agent-runtime", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@agent-infra/agent-runtime")>();
	return {
		...actual,
		openConnectionHostSupplyV1: (
			...args: Parameters<typeof actual.openConnectionHostSupplyV1>
		) => {
			decryption.opened++;
			const material = actual.openConnectionHostSupplyV1(...args);
			decryption.capture?.push(material);
			return material;
		},
	};
});

const namespace = "agents";
const sandboxId = "s1";
const podUid = "pod-uid-1";
const sessionGeneration = 3;
const resourceFence = 7;
const host = `sandbox-${sandboxId}.${namespace}.svc`;
const deploymentIdentity = connectionHostDeploymentIdentityV1({
	namespace,
	workerId: "worker-a",
});
/** Synthetic Consumer service credential; it must never leave the Connection request. */
const credential = "conn_consumer_synthetic-service-material-0123456789";
const serviceToken = "synthetic-worker-service-token-0001";
const callbackToken = "synthetic-callback-only-token-0001";
const installToken = "synthetic-session-install-token-0001-abcdef";
const registrationKey = "install-key-0001-alpha";
const clientName = "Agent Infra";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const lookup: LookupFunction = (_hostname, options, callback) => {
	if (typeof options === "object" && options?.all)
		(callback as (e: null, a: { address: string; family: number }[]) => void)(
			null,
			[{ address: "127.0.0.1", family: 4 }],
		);
	else callback(null, "127.0.0.1", 4);
};
const system = {
	schemaVersion: 1 as const,
	publicOrigin: "https://connection.example.test",
	mcpPath: "/mcp/agents",
	audience: "connection-mcp",
	egressProfile: { ref: "connection-egress", revision: "r1" },
	issuer: "https://connection.example.test/",
	oauthCallbackUrl:
		"https://platform.example.test/api/v1/connection/oauth/callback",
};
const approval = {
	schemaVersion: 1 as const,
	configFingerprint: connectionSystemAccessFingerprintV1(system),
	egressEnforced: true as const,
	source: { ref: "connection-system-access", revision: "r1" },
};
const resolved = resolveApprovedConnectionSystemAccessV1(system, approval);
if (resolved.status !== "available")
	throw Error("Invalid controlled system access");
const access = resolved;
const consumer = connectionManualConsumerTargetV1(access, {
	agentId: "agent-a",
	connectionAgentId: "conn-agent-a",
	associationRevision: 2,
});
const reference = {
	agentId: "agent-a",
	conversationId: "conversation-a",
	executionId: "execution-a",
	sessionGeneration,
};
const receipt: ConnectionRegistrationReceiptV1 = {
	registrationKey,
	clientId: "client-1",
	clientName,
	clientStatus: "ACTIVE",
	configFingerprint: consumer.configFingerprint,
	consumerId: "consumer-1",
	createdAt: "2026-11-19T00:00:00.000Z",
	instanceId: "instance-1",
	instanceStatus: "ACTIVE",
	principalId: null,
	redirectUri: system.oauthCallbackUrl,
	resource: consumer.url,
	scope: "mcp",
	source: { ref: consumer.source.ref, revision: consumer.source.revision },
	status: "ACTIVE",
};

let tls: Awaited<ReturnType<typeof runtimeTlsFixture>>;
let otherService: Awaited<ReturnType<typeof runtimeTlsFixture>>;
beforeAll(async () => {
	tls = await runtimeTlsFixture({ dnsNames: [host] });
	otherService = await runtimeTlsFixture({
		dnsNames: ["sandbox-s2.agents.svc"],
	});
});
afterAll(async () => {
	await tls?.cleanup();
	await otherService?.cleanup();
});

const cleanups: (() => Promise<void>)[] = [];
const responses: string[] = [];
const logged: string[] = [];
beforeEach(() => {
	decryption.opened = 0;
	for (const method of ["debug", "error", "info", "log", "warn"] as const)
		vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		});
});
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	const bodies = responses.splice(0).join("\n");
	const lines = logged.splice(0);
	protection.check.mockReset();
	vi.restoreAllMocks();
	// The service credential never reaches a response, an error or a log line.
	expect(bodies).not.toContain(credential);
	expect(lines).toEqual([]);
});

function denial() {
	return new RuntimeHostError(
		"RUNTIME_GRANT_INVALID",
		"Runtime authorization is unavailable",
		403,
		false,
	);
}

function createStore() {
	const additional = new Map<
		string,
		{ principal: { kind: "user"; id: string }; reference: typeof reference }
	>();
	const state = {
		hostRef: "host-ref-a",
		principal: { kind: "user" as const, id: "alice" },
		reference: { ...reference },
		revoked: false,
	};
	const resolve = (value: typeof reference) =>
		additional.get(value.executionId) ?? state;
	return {
		state,
		addInstallation(template: ConnectionRegistrationTemplateV1) {
			additional.set(template.reference.executionId, template);
		},
		async resolveOriginalExecutionBinding(value: typeof reference) {
			const binding = resolve(value);
			if (state.revoked || !isDeepStrictEqual(value, binding.reference))
				throw denial();
			return {
				principal: { ...binding.principal },
				scope: { ...binding.reference },
			};
		},
		assertOriginalExecutionBindingCurrent(
			value: typeof reference,
			principal: { kind: string; id: string },
		) {
			const binding = resolve(value);
			if (
				state.revoked ||
				!isDeepStrictEqual(value, binding.reference) ||
				principal.kind !== binding.principal.kind ||
				principal.id !== binding.principal.id
			)
				throw denial();
		},
		async resolveOriginalExecutionHostSessionRef(value: typeof reference) {
			const binding = resolve(value);
			if (state.revoked || !isDeepStrictEqual(value, binding.reference))
				throw denial();
			return state.hostRef;
		},
	};
}

function createReadback() {
	const calls: ConnectionInstallReadbackInputV1[] = [];
	const queued: ConnectionInstallReadbackOutcomeV1[] = [];
	const invalid = new Set<string>();
	return {
		calls,
		invalid,
		queue: (...outcomes: ConnectionInstallReadbackOutcomeV1[]) => {
			queued.push(...outcomes);
		},
		async readback(input: ConnectionInstallReadbackInputV1) {
			calls.push(structuredClone(input));
			return (
				queued.shift() ??
				(invalid.has(input.authorizationId) ? "denied" : "allowed")
			);
		},
	};
}

/** Controlled EP-1060 endpoint; it records the exact method, URL and headers. */
function createConnection() {
	const calls: {
		method: string;
		url: string;
		headers: Record<string, string>;
		body?: string;
	}[] = [];
	let loseNextPost = false;
	const fetch = async (url: string | URL, init?: RequestInit) => {
		const method = init?.method ?? "GET";
		calls.push({
			method,
			url: String(url),
			headers: Object.fromEntries(new Headers(init?.headers).entries()),
			...(typeof init?.body === "string" ? { body: init.body } : {}),
		});
		if (method === "POST" && loseNextPost) {
			loseNextPost = false;
			throw new TypeError("fetch failed");
		}
		const registration =
			method === "DELETE"
				? {
						...receipt,
						status: "REVOKED",
						clientStatus: "REVOKED",
						instanceStatus: "REVOKED",
					}
				: receipt;
		return new Response(
			JSON.stringify({
				registrationVersion: 1,
				outcome: "KNOWN",
				registration,
			}),
			{
				status: method === "POST" ? 201 : 200,
				headers: { "content-type": "application/json" },
			},
		);
	};
	return {
		calls,
		fetch,
		loseNextPost: () => {
			loseNextPost = true;
		},
	};
}

function templateFor(
	runtimeOrigin: string,
	patch: Partial<ConnectionRegistrationTemplateV1> = {},
): ConnectionRegistrationTemplateV1 {
	return {
		schemaVersion: 1,
		principal: { kind: "user", id: "alice" },
		reference: { ...reference },
		authorizationId: "authorization-a",
		confirmationRevision: "confirmation-r1",
		association: { connectionAgentId: "conn-agent-a", revision: 2 },
		claim: { owner: "worker-a:claim", fence: 11 },
		target: {
			deploymentIdentity,
			hostRef: "host-ref-a",
			sandboxId,
			podUid,
			sessionGeneration,
			resourceFence,
			runtimeOrigin,
		},
		systemAccess: {
			configFingerprint: access.configFingerprint,
			source: { ...access.source },
		},
		registration: {
			endpoint: connectionMachineRegistrationEndpointV1(access, "conn-agent-a"),
			clientName,
			redirectUri: system.oauthCallbackUrl,
			resource: consumer.url,
			scope: "mcp",
			source: { ...consumer.source },
			configFingerprint: consumer.configFingerprint,
			registrationKeyHash: connectionRegistrationKeyHashV1(registrationKey),
		},
		supply: connectionManualSupplyReferenceV1({
			agentId: "agent-a",
			associationRevision: 2,
		}),
		...patch,
	};
}

function environmentFor(
	runtimeOrigin: string,
	patch: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
	return {
		PORT: "3003",
		AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_RECEIVER: "v1",
		AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_ORIGIN: runtimeOrigin,
		AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_WORKER_ORIGIN:
			"https://platform-worker.agents.svc:8443/",
		AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_SYSTEM_ACCESS:
			JSON.stringify(system),
		AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_SYSTEM_ACCESS_APPROVAL:
			JSON.stringify(approval),
		AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_CLIENT_NAME: clientName,
		AGENT_INFRA_RUNTIME_NAMESPACE: namespace,
		AGENT_INFRA_RUNTIME_POD_NAME: `sandbox-${sandboxId}`,
		AGENT_INFRA_RUNTIME_POD_UID: podUid,
		AGENT_INFRA_RUNTIME_RESOURCE_FENCE: String(resourceFence),
		AGENT_INFRA_RUNTIME_SANDBOX_ID: sandboxId,
		AGENT_INFRA_RUNTIME_SESSION_GENERATION: String(sessionGeneration),
		...patch,
	};
}

async function freePort() {
	const reserve = createNetServer();
	await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
	const { port } = reserve.address() as AddressInfo;
	await new Promise<void>((resolve) => reserve.close(() => resolve()));
	return port;
}

async function waitForPort(port: number) {
	for (let attempt = 0; attempt < 100; attempt++) {
		const open = await new Promise<boolean>((resolve) => {
			const socket = connect(port, "127.0.0.1");
			socket.once("connect", () => {
				socket.destroy();
				resolve(true);
			});
			socket.once("error", () => resolve(false));
		});
		if (open) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw Error("install listener did not start");
}

/** Minimal HTTP/1.1 reader for one keep-alive response framed by Content-Length. */
function readHttpResponse(socket: TLSSocket) {
	return new Promise<{ status: number; body: string }>((resolve, reject) => {
		let buffer = Buffer.alloc(0);
		const cleanup = () => {
			socket.off("data", onData);
			socket.off("error", onError);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onData = (chunk: Buffer) => {
			buffer = Buffer.concat([buffer, chunk]);
			const end = buffer.indexOf("\r\n\r\n");
			if (end < 0) return;
			const head = buffer.subarray(0, end).toString("latin1");
			const length = Number(/\r\ncontent-length:\s*(\d+)/i.exec(head)?.[1]);
			if (!Number.isSafeInteger(length)) {
				cleanup();
				reject(Error("unframed response"));
				return;
			}
			if (buffer.length < end + 4 + length) return;
			cleanup();
			resolve({
				status: Number(head.slice(9, 12)),
				body: buffer.subarray(end + 4, end + 4 + length).toString("utf8"),
			});
		};
		socket.on("data", onData);
		socket.once("error", onError);
	});
}

async function privateDirectory(
	files: Record<string, string | undefined> = {},
) {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), "connection-install-")),
	);
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	const tlsDirectory = join(
		directory,
		"codex-driver.json.native",
		"conversations",
		"standard-mcp-oauth",
		"tls",
	);
	await mkdir(tlsDirectory, { recursive: true, mode: 0o700 });
	const contents: Record<string, string | undefined> = {
		"server.crt": tls.cert,
		"server.key": tls.key,
		"callback.auth": callbackToken,
		"install.auth": installToken,
		"worker-ca.crt": tls.ca,
		...files,
	};
	for (const [name, text] of Object.entries(contents))
		if (text !== undefined)
			await writeFile(join(tlsDirectory, name), text, { mode: 0o600 });
	return directory;
}

async function receiver(
	options: {
		directory?: string;
		port?: number;
		environment?: Record<string, string | undefined>;
		listen?: boolean;
		store?: ReturnType<typeof createStore>;
		readback?: ReturnType<typeof createReadback>;
		transportReadback?: ConnectionInstallReadbackClientV1;
		now?: () => number;
	} = {},
) {
	const directory = options.directory ?? (await privateDirectory());
	const port = options.port ?? (await freePort());
	const runtimeOrigin = `https://${host}:${port}/`;
	const store = options.store ?? createStore();
	const readback = options.readback ?? createReadback();
	const connection = createConnection();
	const assembly = await prepareConnectionInstallReceiverV1({
		environment: environmentFor(runtimeOrigin, options.environment),
		dataDirectory: directory,
		agentId: "agent-a",
		workerId: "worker-a",
		key: publicKey,
		keyId: "worker-key",
		issuer: "platform",
		serviceToken,
		store,
		fetch: connection.fetch,
		readback: options.transportReadback ?? readback,
		now: options.now,
	});
	if (assembly?.status !== "available") throw Error("receiver unavailable");
	let server: Server | undefined;
	if (options.listen !== false) {
		server = startConnectionInstallReceiverServerV1(assembly);
		if (!server.listening) await once(server, "listening");
	}
	let stopped: Promise<void> | undefined;
	/** Stops this Host process; the private data directory stays for a restart. */
	const stop = () => {
		stopped ??= (async () => {
			if (server) {
				server.closeAllConnections();
				const listening = server;
				await new Promise<void>((resolve) => listening.close(() => resolve()));
			}
			await assembly.close();
		})();
		return stopped;
	};
	cleanups.push(stop);
	return {
		assembly,
		directory,
		port,
		runtimeOrigin,
		store,
		readback,
		connection,
		stop,
		template: templateFor(runtimeOrigin),
		records: join(
			directory,
			"codex-driver.json.native",
			"conversations",
			"standard-mcp-oauth",
			"records",
		),
	};
}
type Receiver = Awaited<ReturnType<typeof receiver>>;

function sha256(value: string) {
	return createHash("sha256").update(value).digest("hex");
}

function jws(typ: string, claims: unknown) {
	const header = Buffer.from(
		JSON.stringify({ alg: "EdDSA", kid: "worker-key", typ }),
	).toString("base64url");
	const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
	const input = `${header}.${payload}`;
	return `${input}.${sign(null, Buffer.from(input, "ascii"), privateKey).toString("base64url")}`;
}

function workerClaims(channel: string, requestDigest: string) {
	const issuedAt = Date.now();
	return {
		schemaVersion: 1,
		audience: "runtime_connection_install",
		issuer: "platform",
		workerId: "worker-a",
		grantId: randomUUID(),
		issuedAt,
		expiresAt: issuedAt + 30_000,
		channelBinding: channel,
		requestDigest,
	};
}

/** One fresh TLS 1.3 exchange; everything bound to the channel is built inside it. */
async function exchange(
	f: Receiver,
	path: string,
	build: (exporter: ConnectionInstallTlsExporterV1, channel: string) => unknown,
	headers: Record<string, string> = {},
) {
	const response = await requestOverConnectionInstallTlsV1({
		origin: f.runtimeOrigin,
		path,
		ca: tls.ca,
		signal: AbortSignal.timeout(10_000),
		maxResponseBytes: 65_536,
		lookup,
		prepare: (exporter) => {
			const channel = exporter(
				connectionInstallExporterLabelsV1.channel,
				32,
			).toString("base64url");
			const value = build(exporter, channel);
			return {
				body: Buffer.from(
					typeof value === "string" ? value : JSON.stringify(value),
				),
				headers,
			};
		},
	});
	const text = response.body.toString("utf8");
	responses.push(text);
	return {
		status: response.status,
		headers: response.headers,
		body: JSON.parse(text) as Record<string, unknown>,
	};
}

interface SupplyOptions {
	readonly template?: ConnectionRegistrationTemplateV1;
	readonly attemptId?: string;
	/** AAD fields used to seal the ciphertext instead of this Host's binding. */
	readonly sealedFor?: Record<string, unknown>;
	/** Binding fields the signed claims name instead of this Host's binding. */
	readonly claimedFor?: Record<string, unknown>;
	readonly material?: string;
}
function supplyBody(
	f: Receiver,
	exporter: ConnectionInstallTlsExporterV1,
	channel: string,
	options: SupplyOptions = {},
) {
	const template = options.template ?? f.template;
	const attemptId = options.attemptId ?? "supply-attempt-1";
	const binding = {
		deploymentIdentity: template.target.deploymentIdentity,
		hostRef: template.target.hostRef,
		sandboxId: template.target.sandboxId,
		podUid: template.target.podUid,
		sessionGeneration: template.target.sessionGeneration,
		resourceFence: template.target.resourceFence,
		supplyRef: template.supply.ref,
		supplyRevision: template.supply.revision,
		attemptId,
		templateDigest: connectionRegistrationTemplateDigestV1(template),
	};
	const sealed = { ...binding, ...options.sealedFor };
	const key = exporter(
		connectionInstallExporterLabelsV1.supplyKey,
		32,
		encodeConnectionHostSupplyAadV1(sealed),
	);
	const material = Buffer.from(options.material ?? credential, "utf8");
	const envelope = sealConnectionHostSupplyV1(material, key, sealed);
	key.fill(0);
	material.fill(0);
	const unsigned = { schemaVersion: 1, template, attemptId, envelope };
	return {
		...unsigned,
		grant: jws(connectionInstallJwsTypesV1.supply, {
			...workerClaims(channel, connectionInstallRequestDigestV1(unsigned)),
			purpose: "connection_host_supply",
			binding: { ...binding, ...options.claimedFor },
		}),
	};
}
function supply(f: Receiver, options?: SupplyOptions) {
	return exchange(f, connectionInstallPathsV1.supply, (exporter, channel) =>
		supplyBody(f, exporter, channel, options),
	);
}

type CommandName = "prepare" | "status" | "revoke";
interface CommandOptions {
	readonly commandId?: string;
	readonly template?: ConnectionRegistrationTemplateV1;
	readonly supplyAttemptId?: string;
	readonly expected?: {
		consumerId: string;
		clientId: string;
		instanceId: string;
	} | null;
}
function commandBody(
	f: Receiver,
	channel: string,
	command: CommandName,
	options: CommandOptions = {},
) {
	const template = options.template ?? f.template;
	const expected =
		options.expected === undefined
			? command === "revoke"
				? {
						consumerId: receipt.consumerId,
						clientId: receipt.clientId,
						instanceId: receipt.instanceId,
					}
				: undefined
			: (options.expected ?? undefined);
	const unsigned = {
		schemaVersion: 1,
		command,
		commandId: options.commandId ?? `${command}-1`,
		attemptId: "command-attempt-1",
		attemptOwner: "worker-a:command-owner",
		template,
		supplyAttemptId: options.supplyAttemptId ?? "supply-attempt-1",
		registrationKey,
		...(expected ? { expected } : {}),
	};
	return {
		...unsigned,
		grant: jws(connectionInstallJwsTypesV1.registration, {
			...workerClaims(channel, connectionInstallRequestDigestV1(unsigned)),
			purpose: "connection_registration",
			command,
			commandId: unsigned.commandId,
			attemptId: unsigned.attemptId,
			attemptOwner: unsigned.attemptOwner,
			authorizationId: template.authorizationId,
			templateDigest: connectionRegistrationTemplateDigestV1(template),
			supplyAttemptId: unsigned.supplyAttemptId,
			registrationKeyHash: connectionRegistrationKeyHashV1(registrationKey),
		}),
	};
}
function command(f: Receiver, name: CommandName, options?: CommandOptions) {
	return exchange(f, connectionInstallPathsV1[name], (_exporter, channel) =>
		commandBody(f, channel, name, options),
	);
}

function installScope(f: Receiver, configuration: RuntimeOAuthConfigurationV1) {
	return {
		agentId: f.template.reference.agentId,
		sandboxId,
		podUid,
		sessionGeneration,
		configFingerprint: f.template.registration.configFingerprint,
		source: { ...f.template.registration.source },
		oauthConfiguration: {
			ref: configuration.ref,
			revision: configuration.revision,
		},
	};
}

interface BeginOptions {
	readonly commandId?: string;
	readonly supplyAttemptId?: string;
	readonly receipt?: ConnectionRegistrationReceiptV1;
	readonly configuration?: (
		derived: RuntimeOAuthConfigurationV1,
	) => RuntimeOAuthConfigurationV1;
	readonly scope?: Record<string, unknown>;
}
function firstBeginBody(
	f: Receiver,
	channel: string,
	options: BeginOptions = {},
) {
	const template = f.template;
	const actualReceipt = options.receipt ?? receipt;
	const derived = connectionManualInstallConfigurationV1({
		access,
		template,
		receipt: actualReceipt,
	});
	const configuration = options.configuration?.(derived) ?? derived;
	const scope = { ...installScope(f, configuration), ...options.scope };
	const request = {
		schemaVersion: 1,
		...scope,
		authorizationId: template.authorizationId,
		confirmationRevision: template.confirmationRevision,
		reference: template.reference,
		command: "begin",
	};
	const outer = {
		schemaVersion: 1,
		commandId: options.commandId ?? "begin-1",
		attemptId: "begin-attempt-1",
		attemptOwner: "worker-a:begin-owner",
		template,
		supplyAttemptId: options.supplyAttemptId ?? "supply-attempt-1",
		receipt: actualReceipt,
		configuration,
	};
	const issuedAt = Date.now();
	const token = jws(connectionInstallJwsTypesV1.firstBegin, {
		...scope,
		schemaVersion: 1,
		reference: template.reference,
		purpose: "connection_installation",
		audience: "runtime_connection_client",
		issuer: "platform",
		workerId: "worker-a",
		principal: template.principal,
		command: "begin",
		authorizationId: template.authorizationId,
		confirmationRevision: template.confirmationRevision,
		grantId: randomUUID(),
		issuedAt,
		expiresAt: issuedAt + 30_000,
		requestDigest: sha256(
			canonicalRuntimeRequestSigningPayload({ ...request, grant: undefined }),
		),
		firstBegin: {
			commandId: outer.commandId,
			attemptId: outer.attemptId,
			attemptOwner: outer.attemptOwner,
			templateDigest: connectionRegistrationTemplateDigestV1(template),
			supplyAttemptId: outer.supplyAttemptId,
			registrationKeyHash: template.registration.registrationKeyHash,
			receiptDigest: connectionRegistrationReceiptDigestV1(actualReceipt),
			configurationDigest:
				connectionInstallConfigurationDigestV1(configuration),
			bodyDigest: connectionInstallRequestDigestV1({ ...outer, request }),
			channelBinding: channel,
		},
	});
	return {
		...outer,
		request: {
			...request,
			grant: {
				schemaVersion: 1,
				format: "runtime-connection-installation-jws",
				token,
			},
		},
	};
}
function firstBegin(f: Receiver, options?: BeginOptions) {
	return exchange(f, connectionInstallPathsV1.begin, (_exporter, channel) =>
		firstBeginBody(f, channel, options),
	);
}

function beginStatus(
	f: Receiver,
	options: { beginCommandId?: string; supplyAttemptId?: string } = {},
) {
	return exchange(
		f,
		connectionInstallPathsV1.beginStatus,
		(_exporter, channel) => {
			const unsigned = {
				schemaVersion: 1,
				commandId: `begin-status-${randomUUID()}`,
				attemptId: "status-attempt-1",
				attemptOwner: "worker-a:status-owner",
				beginCommandId: options.beginCommandId ?? "begin-1",
				template: f.template,
				supplyAttemptId: options.supplyAttemptId ?? "supply-attempt-1",
				registrationKey,
			};
			return {
				...unsigned,
				grant: jws(connectionInstallJwsTypesV1.registration, {
					...workerClaims(channel, connectionInstallRequestDigestV1(unsigned)),
					purpose: "connection_registration",
					command: "begin_status",
					commandId: unsigned.commandId,
					attemptId: unsigned.attemptId,
					attemptOwner: unsigned.attemptOwner,
					authorizationId: f.template.authorizationId,
					templateDigest: connectionRegistrationTemplateDigestV1(f.template),
					supplyAttemptId: unsigned.supplyAttemptId,
					registrationKeyHash: connectionRegistrationKeyHashV1(registrationKey),
				}),
			};
		},
	);
}

/** Existing post-begin installation JWS (runtime-oauth-request.ts shape). */
function standardRequest(f: Receiver, name: "confirm" | "status" | "refresh") {
	const configuration = connectionManualInstallConfigurationV1({
		access,
		template: f.template,
		receipt,
	});
	const scope = installScope(f, configuration);
	const request = {
		schemaVersion: 1,
		...scope,
		authorizationId: f.template.authorizationId,
		confirmationRevision: f.template.confirmationRevision,
		reference: f.template.reference,
		command: name,
	};
	const issuedAt = Date.now();
	return {
		...request,
		grant: {
			schemaVersion: 1,
			format: "runtime-connection-installation-jws",
			token: jws(connectionInstallJwsTypesV1.firstBegin, {
				...scope,
				schemaVersion: 1,
				reference: f.template.reference,
				purpose: "connection_installation",
				audience: "runtime_connection_client",
				issuer: "platform",
				workerId: "worker-a",
				principal: f.template.principal,
				command: name,
				authorizationId: f.template.authorizationId,
				confirmationRevision: f.template.confirmationRevision,
				grantId: randomUUID(),
				issuedAt,
				expiresAt: issuedAt + 30_000,
				requestDigest: sha256(
					canonicalRuntimeRequestSigningPayload({
						...request,
						grant: undefined,
					}),
				),
			}),
		},
	};
}

async function recordNames(f: Receiver) {
	return (await readdir(f.records)).sort();
}

async function supplied(f: Receiver) {
	const response = await supply(f);
	expect(response.status).toBe(200);
	return response;
}

async function registered(f: Receiver) {
	await supplied(f);
	const response = await command(f, "prepare");
	expect(response.body.outcome).toBe("registered");
	return response;
}

describe("Connection install receiver assembly", () => {
	it("stays absent without the rollout input", async () => {
		expect(
			await prepareConnectionInstallReceiverV1({
				environment: environmentFor("https://sandbox-s1.agents.svc:9443/", {
					AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_RECEIVER: undefined,
				}),
				dataDirectory: await privateDirectory(),
				agentId: "agent-a",
				workerId: "worker-a",
				key: publicKey,
				keyId: "worker-key",
				issuer: "platform",
				serviceToken,
				store: createStore(),
			}),
		).toBeUndefined();
		expect(protection.check).not.toHaveBeenCalled();
	});

	it.each([
		[
			"an unsupported version",
			{ AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_RECEIVER: "v2" },
			{},
		],
		[
			"pre-registered OAuth provisioning",
			{ AGENT_INFRA_RUNTIME_CONNECTION_OAUTH_FILE: "/oauth.json" },
			{},
		],
		[
			"provisioned OAuth",
			{ AGENT_INFRA_RUNTIME_CONNECTION_OAUTH_PROVISIONED: "true" },
			{},
		],
		[
			"a Pod name outside the Sandbox",
			{ AGENT_INFRA_RUNTIME_POD_NAME: "sandbox-s2" },
			{},
		],
		[
			"a generation with a leading zero",
			{ AGENT_INFRA_RUNTIME_SESSION_GENERATION: "03" },
			{},
		],
		["a non-positive fence", { AGENT_INFRA_RUNTIME_RESOURCE_FENCE: "0" }, {}],
		["a missing Pod UID", { AGENT_INFRA_RUNTIME_POD_UID: undefined }, {}],
		[
			"a plaintext Worker origin",
			{
				AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_WORKER_ORIGIN:
					"http://platform-worker.agents.svc:8443/",
			},
			{},
		],
		[
			"unapproved system access",
			{
				AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_SYSTEM_ACCESS_APPROVAL:
					JSON.stringify({ ...approval, configFingerprint: "0".repeat(64) }),
			},
			{},
		],
		[
			"a missing client name",
			{ AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_CLIENT_NAME: undefined },
			{},
		],
		[
			"an install token shared with the Worker",
			{},
			{ "install.auth": serviceToken },
		],
		["a short install token", {}, { "install.auth": "short-install-token" }],
		[
			"a callback token shared with the install token",
			{},
			{ "callback.auth": installToken },
		],
		[
			"a Worker CA without a certificate",
			{},
			{ "worker-ca.crt": "not a certificate" },
		],
		[
			"a certificate for another Service",
			{},
			{ "server.crt": "other", "server.key": "other" },
		],
		["missing install token", {}, { "install.auth": undefined }],
	] as const)(
		"closes only the receiver for %s",
		async (_name, environment, files) => {
			const resolvedFiles: Record<string, string | undefined> = { ...files };
			if (resolvedFiles["server.crt"] === "other") {
				resolvedFiles["server.crt"] = otherService.cert;
				resolvedFiles["server.key"] = otherService.key;
			}
			const port = await freePort();
			expect(
				await prepareConnectionInstallReceiverV1({
					environment: environmentFor(`https://${host}:${port}/`, environment),
					dataDirectory: await privateDirectory(resolvedFiles),
					agentId: "agent-a",
					workerId: "worker-a",
					key: publicKey,
					keyId: "worker-key",
					issuer: "platform",
					serviceToken,
					store: createStore(),
					readback: createReadback(),
				}),
			).toEqual({ status: "unavailable" });
		},
	);

	it.each([
		["the Host port", (port: number) => ({ PORT: String(port) })],
		[
			"another Service",
			(port: number) => ({
				AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_ORIGIN: `https://sandbox-s2.agents.svc:${port}/`,
			}),
		],
		[
			"a privileged port",
			() => ({
				AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_ORIGIN: `https://${host}:443/`,
			}),
		],
	])("rejects an install origin on %s", async (_name, patch) => {
		const port = await freePort();
		expect(
			await prepareConnectionInstallReceiverV1({
				environment: environmentFor(`https://${host}:${port}/`, patch(port)),
				dataDirectory: await privateDirectory(),
				agentId: "agent-a",
				workerId: "worker-a",
				key: publicKey,
				keyId: "worker-key",
				issuer: "platform",
				serviceToken,
				store: createStore(),
				readback: createReadback(),
			}),
		).toEqual({ status: "unavailable" });
	});

	it("checks real process protection before reading private files", async () => {
		protection.check.mockImplementation(() => {
			throw new Error("protection unavailable");
		});
		const port = await freePort();
		expect(
			await prepareConnectionInstallReceiverV1({
				environment: environmentFor(`https://${host}:${port}/`),
				dataDirectory: await privateDirectory({ "server.crt": undefined }),
				agentId: "agent-a",
				workerId: "worker-a",
				key: publicKey,
				keyId: "worker-key",
				issuer: "platform",
				serviceToken,
				store: createStore(),
			}),
		).toEqual({ status: "unavailable" });
		expect(protection.check).toHaveBeenCalledTimes(1);
	});
});

describe("Connection Host supply", () => {
	it("confirms the original target and idempotently confirms the same attempt", async () => {
		const f = await receiver();
		const first = await supply(f);
		expect(first).toMatchObject({
			status: 200,
			body: {
				schemaVersion: 1,
				outcome: "confirmed",
				attemptId: "supply-attempt-1",
				templateDigest: connectionRegistrationTemplateDigestV1(f.template),
			},
		});
		expect(first.headers["cache-control"]).toBe("no-store");
		expect(first.headers["referrer-policy"]).toBe("no-referrer");
		expect(f.readback.calls[0]).toEqual({
			purpose: "supply_delivery",
			target: f.template.target,
			principal: f.template.principal,
			reference: f.template.reference,
			authorizationId: "authorization-a",
			confirmationRevision: "confirmation-r1",
			templateDigest: connectionRegistrationTemplateDigestV1(f.template),
			supply: {
				ref: f.template.supply.ref,
				revision: f.template.supply.revision,
				attemptId: "supply-attempt-1",
			},
		});
		const again = await supply(f);
		expect(again.status).toBe(200);
		expect(again.body.outcome).toBe("confirmed");
		// Another attempt or different material for the same installation never replaces it.
		expect((await supply(f, { attemptId: "supply-attempt-2" })).status).toBe(
			409,
		);
		expect(
			(await supply(f, { material: "conn_consumer_other-service-material" }))
				.status,
		).toBe(409);
		expect(f.connection.calls).toHaveLength(0);
		expect((await command(f, "prepare")).body.outcome).toBe("registered");
	});

	it.each([
		["another Host", { hostRef: "host-ref-b" }],
		["a pre-rebuild Pod", { podUid: "pod-uid-0" }],
		["an old attempt", { attemptId: "supply-attempt-0" }],
		[
			"another template",
			{
				templateDigest: connectionRegistrationTemplateDigestV1(
					templateFor("https://sandbox-s1.agents.svc:9443/", {
						authorizationId: "authorization-b",
					}),
				),
			},
		],
	])(
		"rejects ciphertext sealed for %s without a slot or Connection request",
		async (_name, sealedFor) => {
			const f = await receiver();
			const response = await supply(f, { sealedFor });
			expect(response.status).toBe(403);
			expect(response.body).toEqual({
				schemaVersion: 1,
				code: "RUNTIME_GRANT_INVALID",
				message: "Connection installation is unavailable",
				retryable: false,
			});
			expect(decryption.opened).toBe(1);
			expect((await command(f, "prepare")).body.outcome).toBe("rejected");
			expect(f.connection.calls).toHaveLength(0);
			// The intact original delivery still succeeds afterwards.
			expect((await supply(f)).status).toBe(200);
		},
	);

	it("rejects a delivery addressed to a Host session it does not own", async () => {
		const f = await receiver();
		const elsewhere = templateFor(f.runtimeOrigin, {
			target: { ...f.template.target, hostRef: "host-ref-b" },
		});
		expect((await supply(f, { template: elsewhere })).status).toBe(403);
		f.store.state.hostRef = "host-ref-c";
		expect((await supply(f)).status).toBe(403);
		expect(decryption.opened).toBe(0);
		expect(f.readback.calls).toHaveLength(0);
	});

	it("rejects decrypted material that is not a Consumer service credential", async () => {
		const f = await receiver();
		expect(
			(await supply(f, { material: "not-a-consumer-service-credential" }))
				.status,
		).toBe(403);
		expect((await command(f, "prepare")).body.outcome).toBe("rejected");
		expect(f.connection.calls).toHaveLength(0);
	});

	it("rejects a signed request replayed on another TLS connection", async () => {
		const f = await receiver();
		let captured: unknown;
		// Connection A: build a valid signed body but send something else.
		const first = await exchange(
			f,
			connectionInstallPathsV1.supply,
			(exporter, channel) => {
				captured = supplyBody(f, exporter, channel);
				return {};
			},
		);
		expect(first.status).toBe(403);
		// Connection B: the body signed for A is refused before any decrypt.
		const replay = await exchange(
			f,
			connectionInstallPathsV1.supply,
			() => captured,
		);
		expect(replay.status).toBe(403);
		expect(decryption.opened).toBe(0);
		expect(f.readback.calls).toHaveLength(0);
		await supplied(f);
		let prepare: unknown;
		await exchange(
			f,
			connectionInstallPathsV1.prepare,
			(_exporter, channel) => {
				prepare = commandBody(f, channel, "prepare");
				return {};
			},
		);
		expect(
			(await exchange(f, connectionInstallPathsV1.prepare, () => prepare))
				.status,
		).toBe(403);
		expect(f.connection.calls).toHaveLength(0);
	});

	it("rejects a grant replayed on the same TLS connection", async () => {
		const f = await receiver();
		const socket = tlsConnect({
			host: "127.0.0.1",
			port: f.port,
			servername: host,
			ca: tls.ca,
			minVersion: "TLSv1.3",
			maxVersion: "TLSv1.3",
		});
		cleanups.push(async () => {
			socket.destroy();
		});
		await once(socket, "secureConnect");
		const exporter: ConnectionInstallTlsExporterV1 = (label, length, context) =>
			socket.exportKeyingMaterial(length, label, Buffer.from(context ?? []));
		const channel = exporter(
			connectionInstallExporterLabelsV1.channel,
			32,
		).toString("base64url");
		const body = JSON.stringify(supplyBody(f, exporter, channel));
		const statuses: number[] = [];
		for (let attempt = 0; attempt < 2; attempt++) {
			socket.write(
				`POST ${connectionInstallPathsV1.supply} HTTP/1.1\r\nhost: ${host}:${f.port}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
			);
			const response = await readHttpResponse(socket);
			responses.push(response.body);
			statuses.push(response.status);
		}
		// The keep-alive connection shares one channel; only grantId use stops the replay.
		expect(statuses).toEqual([200, 403]);
		expect(decryption.opened).toBe(1);
	});

	it("rejects claims that name another delivery than this Host's binding", async () => {
		const f = await receiver();
		for (const claimedFor of [
			{ hostRef: "host-ref-b" },
			{ podUid: "pod-uid-0" },
			{ attemptId: "supply-attempt-0" },
		])
			expect((await supply(f, { claimedFor })).status).toBe(403);
		expect(decryption.opened).toBe(0);
		expect(f.readback.calls).toHaveLength(0);
	});

	it.each([
		["denied", 403],
		["unavailable", 503],
	] as const)(
		"never decrypts or confirms when the readback is %s",
		async (outcome, status) => {
			const f = await receiver();
			f.readback.queue(outcome);
			expect((await supply(f)).status).toBe(status);
			expect(decryption.opened).toBe(0);
			expect((await command(f, "prepare")).body.outcome).toBe("rejected");
			expect(f.connection.calls).toHaveLength(0);
		},
	);

	it("rejects cross-user, cross-Agent and foreign installation templates", async () => {
		const f = await receiver();
		const otherUser = templateFor(f.runtimeOrigin, {
			principal: { kind: "user", id: "bob" },
		});
		expect((await supply(f, { template: otherUser })).status).toBe(403);
		const otherAgent = templateFor(f.runtimeOrigin, {
			reference: { ...reference, agentId: "agent-b" },
			supply: connectionManualSupplyReferenceV1({
				agentId: "agent-b",
				associationRevision: 2,
			}),
		});
		expect((await supply(f, { template: otherAgent })).status).toBe(403);
		expect(decryption.opened).toBe(0);
		await supplied(f);
		const otherInstallation = templateFor(f.runtimeOrigin, {
			authorizationId: "authorization-b",
		});
		for (const template of [otherInstallation, otherUser, otherAgent])
			expect((await command(f, "prepare", { template })).body.outcome).toBe(
				"rejected",
			);
		expect(f.connection.calls).toHaveLength(0);
	});

	it("rejects a template for another Agent even when the Store binding matches it", async () => {
		const f = await receiver();
		const otherReference = { ...reference, agentId: "agent-b" };
		f.store.state.reference = otherReference;
		const otherConsumer = connectionManualConsumerTargetV1(access, {
			agentId: "agent-b",
			connectionAgentId: "conn-agent-a",
			associationRevision: 2,
		});
		// A template that is valid for agent-b; only this Host's Agent can stop it.
		const otherAgent = templateFor(f.runtimeOrigin, {
			reference: otherReference,
			registration: {
				...f.template.registration,
				source: { ...otherConsumer.source },
			},
			supply: connectionManualSupplyReferenceV1({
				agentId: "agent-b",
				associationRevision: 2,
			}),
		});
		expect((await supply(f, { template: otherAgent })).status).toBe(403);
		expect(f.readback.calls).toHaveLength(0);
		expect(decryption.opened).toBe(0);
	});

	it("closes and zeroes the supply when the original authorization is revoked", async () => {
		const f = await receiver();
		await supplied(f);
		f.store.state.revoked = true;
		expect((await command(f, "prepare")).body.outcome).toBe("rejected");
		f.store.state.revoked = false;
		// A closed supply never reopens, even for the same attempt.
		expect((await supply(f)).status).toBe(409);
		expect((await command(f, "prepare")).body.outcome).toBe("rejected");
		expect(f.connection.calls).toHaveLength(0);
	});
});

describe("Connection machine registration commands", () => {
	it("rejects prepare before supply without contacting Connection", async () => {
		const f = await receiver();
		const response = await command(f, "prepare");
		expect(response).toMatchObject({
			status: 200,
			body: { schemaVersion: 1, outcome: "rejected", commandId: "prepare-1" },
		});
		expect(f.connection.calls).toHaveLength(0);
		expect(f.readback.calls).toHaveLength(0);
	});

	it("sends exactly one prepare POST with the original Idempotency-Key", async () => {
		const f = await receiver();
		await supplied(f);
		const response = await command(f, "prepare");
		expect(response).toMatchObject({
			status: 200,
			body: { outcome: "registered", commandId: "prepare-1", receipt },
		});
		expect(f.connection.calls).toEqual([
			{
				method: "POST",
				url: f.template.registration.endpoint,
				headers: expect.objectContaining({
					authorization: `Bearer ${credential}`,
					"idempotency-key": registrationKey,
				}),
				body: JSON.stringify({
					clientName,
					redirectUri: system.oauthCallbackUrl,
					resource: consumer.url,
					scope: "mcp",
					source: consumer.source,
					configFingerprint: consumer.configFingerprint,
				}),
			},
		]);
		const readbacks = f.readback.calls.filter(
			(call) => call.purpose === "command",
		);
		expect(readbacks).toHaveLength(2);
		expect(readbacks[0]?.command).toMatchObject({
			command: "prepare",
			commandId: "prepare-1",
			registrationKeyHash: connectionRegistrationKeyHashV1(registrationKey),
		});
		// The same command is answered locally; a new prepare never resends.
		expect((await command(f, "prepare")).body).toMatchObject({
			outcome: "registered",
			receipt,
		});
		expect(
			(await command(f, "prepare", { commandId: "prepare-2" })).body.outcome,
		).toBe("rejected");
		expect((await command(f, "status")).body).toMatchObject({
			outcome: "registered",
			receipt,
		});
		expect(f.connection.calls).toHaveLength(1);
	});

	it("keeps a lost prepare response unknown and recovers only by GET of the original key", async () => {
		const f = await receiver();
		await supplied(f);
		f.connection.loseNextPost();
		expect((await command(f, "prepare")).body.outcome).toBe("unknown");
		expect((await command(f, "prepare")).body.outcome).toBe("unknown");
		expect(
			(await command(f, "prepare", { commandId: "prepare-2" })).body.outcome,
		).toBe("rejected");
		const status = await command(f, "status");
		expect(status.body).toMatchObject({ outcome: "registered", receipt });
		expect(
			f.connection.calls.map(({ method, url }) => ({ method, url })),
		).toEqual([
			{ method: "POST", url: f.template.registration.endpoint },
			{
				method: "GET",
				url: `${f.template.registration.endpoint}/${registrationKey}`,
			},
		]);
	});

	it("answers status by GET only and never POSTs", async () => {
		const f = await receiver();
		await supplied(f);
		expect((await command(f, "status")).body).toMatchObject({
			outcome: "registered",
			receipt,
		});
		expect(f.connection.calls.map(({ method }) => method)).toEqual(["GET"]);
		expect((await command(f, "prepare")).body.outcome).toBe("rejected");
		expect(f.connection.calls.map(({ method }) => method)).toEqual(["GET"]);
	});

	it("revokes with DELETE of the original key only and then closes the supply", async () => {
		const f = await receiver();
		await registered(f);
		expect((await command(f, "revoke", { expected: null })).body.outcome).toBe(
			"rejected",
		);
		expect(
			(
				await command(f, "revoke", {
					expected: {
						consumerId: "consumer-1",
						clientId: "client-other",
						instanceId: "instance-1",
					},
				})
			).body.outcome,
		).toBe("rejected");
		expect((await command(f, "revoke")).body).toEqual({
			schemaVersion: 1,
			outcome: "revoked",
			commandId: "revoke-1",
		});
		expect((await command(f, "revoke")).body.outcome).toBe("revoked");
		expect(
			(await command(f, "status", { commandId: "status-2" })).body.outcome,
		).toBe("rejected");
		expect(
			f.connection.calls.map(({ method, url }) => ({ method, url })),
		).toEqual([
			{ method: "POST", url: f.template.registration.endpoint },
			{
				method: "DELETE",
				url: `${f.template.registration.endpoint}/${registrationKey}`,
			},
		]);
		expect((await supply(f)).status).toBe(409);
	});

	it("reports unknown when the readback after Connection no longer allows the command", async () => {
		const f = await receiver();
		await supplied(f);
		f.readback.queue("allowed", "denied");
		expect((await command(f, "prepare")).body.outcome).toBe("unknown");
		// The local ledger keeps the verified receipt without another request.
		expect((await command(f, "status")).body).toMatchObject({
			outcome: "registered",
			receipt,
		});
		expect(f.connection.calls).toHaveLength(1);
	});

	it("rejects a command whose readback is not allowed before any Connection request", async () => {
		const f = await receiver();
		await supplied(f);
		f.readback.queue("unavailable");
		expect((await command(f, "prepare")).body.outcome).toBe("rejected");
		expect(f.connection.calls).toHaveLength(0);
		expect((await command(f, "prepare")).body.outcome).toBe("registered");
	});
});

describe("Connection first begin", () => {
	it("fixes the configuration and creates the link exactly once", async () => {
		const f = await receiver();
		await registered(f);
		const response = await firstBegin(f);
		expect(response.status).toBe(200);
		const configuration = connectionManualInstallConfigurationV1({
			access,
			template: f.template,
			receipt,
		});
		expect(response.body).toMatchObject({
			schemaVersion: 1,
			authorizationId: "authorization-a",
			phase: "awaiting_callback",
		});
		const url = new URL(String(response.body.authorizationUrl));
		expect(`${url.origin}${url.pathname}`).toBe(
			configuration.authorizationEndpoint,
		);
		expect(url.searchParams.get("client_id")).toBe(receipt.clientId);
		expect(url.searchParams.get("redirect_uri")).toBe(system.oauthCallbackUrl);
		expect(url.searchParams.get("resource")).toBe(consumer.url);
		const beginReadback = f.readback.calls.at(-1);
		expect(beginReadback?.command).toMatchObject({
			command: "begin",
			commandId: "begin-1",
			configurationDigest:
				connectionInstallConfigurationDigestV1(configuration),
			receiptDigest: connectionRegistrationReceiptDigestV1(receipt),
		});
		const names = await recordNames(f);
		const key = sha256("authorization-a");
		expect(names).toEqual(
			expect.arrayContaining([
				`install-first-begin-${key}.json`,
				`install-first-begin-result-${key}.json`,
			]),
		);
		expect(names.filter((name) => name.startsWith("state-"))).toHaveLength(1);
		// Duplicate, replayed or late begin: definite rejection and no new state.
		expect((await firstBegin(f)).status).toBe(409);
		expect((await firstBegin(f, { commandId: "begin-2" })).status).toBe(409);
		expect(await recordNames(f)).toEqual(names);
		// begin-status replays the stored result read-only.
		const status = await beginStatus(f);
		expect(status.status).toBe(200);
		expect(status.body).toEqual(response.body);
		expect((await beginStatus(f, { beginCommandId: "begin-2" })).status).toBe(
			409,
		);
		expect(await recordNames(f)).toEqual(names);
		expect(f.connection.calls.map(({ method }) => method)).toEqual(["POST"]);
		const stored = await Promise.all(
			names.map((name) => readFile(join(f.records, name), "utf8")),
		);
		expect(stored.join("\n")).not.toContain(credential);
	}, 20_000);

	it.each([
		[
			"configuration",
			{
				configuration: (c: RuntimeOAuthConfigurationV1) => ({
					...c,
					clientId: "client-other",
				}),
			},
		],
		[
			"receipt instance",
			{ receipt: { ...receipt, instanceId: "instance-other" } },
		],
		[
			"receipt principal",
			{ receipt: { ...receipt, principalId: "principal-x" } },
		],
		["scope", { scope: { podUid: "pod-uid-0" } }],
	] as const)(
		"rejects a %s mismatch before consumption",
		async (_name, options) => {
			const f = await receiver();
			await registered(f);
			const before = await recordNames(f);
			const response = await firstBegin(f, options);
			expect(response.status).toBe(409);
			expect(response.body.authorizationUrl).toBeUndefined();
			expect(await recordNames(f)).toEqual(before);
			expect(
				f.readback.calls.some((call) => call.command?.command === "begin"),
			).toBe(false);
			// Nothing was consumed: the correct first begin still succeeds.
			expect((await firstBegin(f)).status).toBe(200);
		},
		20_000,
	);

	it("rejects a first begin before the receipt-confirmed supply or with a denied readback", async () => {
		const f = await receiver();
		expect((await firstBegin(f)).status).toBe(409);
		await registered(f);
		f.readback.queue("denied");
		expect((await firstBegin(f)).status).toBe(403);
		expect(
			(await recordNames(f)).filter((name) => name.startsWith("install-")),
		).toEqual([]);
		expect((await firstBegin(f)).status).toBe(200);
	}, 20_000);

	it("delegates post-begin routes only to the fixed client with dedicated credentials", async () => {
		const f = await receiver();
		const closedStatus = await exchange(
			f,
			"/internal/runtime/oauth/v1/status",
			() => standardRequest(f, "status"),
			{ authorization: `Bearer ${serviceToken}` },
		);
		expect(closedStatus.status).toBe(503);
		await registered(f);
		const begun = await firstBegin(f);
		const state = new URL(String(begun.body.authorizationUrl)).searchParams.get(
			"state",
		);
		const callback = {
			schemaVersion: 1,
			state,
			issuer: system.issuer,
			code: "synthetic-authorization-code",
		};
		expect(
			(
				await exchange(
					f,
					"/internal/runtime/oauth/v1/callback",
					() => callback,
					{
						authorization: `Bearer ${serviceToken}`,
					},
				)
			).status,
		).toBe(403);
		const received = await exchange(
			f,
			"/internal/runtime/oauth/v1/callback",
			() => callback,
			{ authorization: `Bearer ${callbackToken}` },
		);
		expect(received).toMatchObject({
			status: 200,
			body: { phase: "awaiting_confirmation" },
		});
		expect(
			(
				await exchange(
					f,
					"/internal/runtime/oauth/v1/status",
					() => standardRequest(f, "status"),
					{ authorization: `Bearer ${callbackToken}` },
				)
			).status,
		).toBe(403);
		const status = await exchange(
			f,
			"/internal/runtime/oauth/v1/status",
			() => standardRequest(f, "status"),
			{ authorization: `Bearer ${serviceToken}` },
		);
		expect(status).toMatchObject({
			status: 200,
			body: {
				authorizationId: "authorization-a",
				phase: "awaiting_confirmation",
			},
		});
		// The standard begin route never exists on the install listener.
		expect(
			(
				await exchange(f, "/internal/runtime/oauth/v1/begin", () => ({}), {
					authorization: `Bearer ${serviceToken}`,
				})
			).status,
		).toBe(404);
		// Even if this Host and its original execution are still present, a
		// retired Store supply cannot accept a callback or run another command.
		f.readback.queue("denied");
		expect(
			(
				await exchange(
					f,
					"/internal/runtime/oauth/v1/status",
					() => standardRequest(f, "status"),
					{ authorization: `Bearer ${serviceToken}` },
				)
			).status,
		).toBe(403);
	}, 20_000);

	it("preserves a fixed installation through a Worker proof rejection and clears it after verified revocation", async () => {
		const name = "platform-worker.agents.svc";
		const workerTls = await runtimeTlsFixture({ dnsNames: [name] });
		cleanups.push(workerTls.cleanup);
		let skew = 0;
		let authorized = true;
		let storeReads = 0;
		const worker = createConnectionInstallReadbackServerV1({
			key: workerTls.key,
			cert: workerTls.cert,
			port: 0,
			host: "127.0.0.1",
			deploymentServiceToken: serviceToken,
			deploymentIdentity,
			namespace,
			now: () => Date.now() + skew,
			readback: async () => {
				storeReads++;
				return authorized ? "allowed" : "denied";
			},
		});
		cleanups.push(() => worker.close());
		const port = await worker.listen();
		const transportReadback = createConnectionInstallReadbackClientV1({
			origin: `https://${name}:${port}/`,
			ca: workerTls.ca,
			lookup,
			installToken: sessionSandboxConnectionInstallTokenV1(
				serviceToken,
				namespace,
				sandboxId,
			),
		});
		const f = await receiver({ transportReadback });
		await supplied(f);
		expect((await firstBegin(f)).status).toBe(200);
		const statusFor = (item: Receiver) =>
			exchange(
				item,
				"/internal/runtime/oauth/v1/status",
				() => standardRequest(item, "status"),
				{ authorization: `Bearer ${serviceToken}` },
			);
		const before = storeReads;
		skew = 60_000;
		expect((await statusFor(f)).status).toBe(503);
		expect(storeReads).toBe(before);
		skew = 0;
		expect((await statusFor(f)).status).toBe(200);
		await f.stop();

		skew = 60_000;
		const restarted = await receiver({
			directory: f.directory,
			port: f.port,
			transportReadback,
		});
		expect((await statusFor(restarted)).status).toBe(503);
		skew = 0;
		expect((await statusFor(restarted)).status).toBe(200);
		authorized = false;
		expect((await statusFor(restarted)).status).toBe(403);
		authorized = true;
		expect((await statusFor(restarted)).status).toBe(503);
	}, 25_000);

	it("reclaims pre-begin supply only after authority rejects that original attempt", async () => {
		const f = await receiver();
		const withInstall = (id: number) => ({
			...f,
			template: templateFor(f.runtimeOrigin, {
				authorizationId: `pending-${id}`,
				reference: { ...reference, executionId: `pending-execution-${id}` },
			}),
		});
		const original = Array.from({ length: 8 }, (_, index) =>
			withInstall(index),
		);
		const next = withInstall(8);
		for (const item of [...original, next])
			f.store.addInstallation(item.template);
		const material: Buffer[] = [];
		decryption.capture = material;
		const originalAttempt = "first-supply-0";
		try {
			for (const [index, item] of original.entries())
				expect(
					(await supply(item, { attemptId: `first-supply-${index}` })).status,
				).toBe(200);
			expect((await supply(next)).status).toBe(503);
			expect(material).toHaveLength(8);
			expect(
				material.every((buffer) => buffer.some((value) => value !== 0)),
			).toBe(true);
			const retired = original[0];
			if (!retired) throw new Error("Missing test installation");
			f.readback.invalid.add(retired.template.authorizationId);
			f.readback.calls.length = 0;

			expect((await supply(next)).status).toBe(200);
			expect(f.readback.calls).toContainEqual(
				expect.objectContaining({
					purpose: "supply",
					authorizationId: retired.template.authorizationId,
					supply: expect.objectContaining({ attemptId: originalAttempt }),
				}),
			);
			expect(material[0]?.every((value) => value === 0)).toBe(true);
			expect(
				material
					.slice(1, 8)
					.every((buffer) => buffer.some((value) => value !== 0)),
			).toBe(true);
			expect(
				(
					await command(retired, "prepare", {
						supplyAttemptId: originalAttempt,
					})
				).body.outcome,
			).toBe("rejected");
			expect(f.connection.calls).toHaveLength(0);
		} finally {
			decryption.capture = undefined;
		}
	}, 25_000);

	it("reclaims retired Host capacity and restores the live installation after restart", async () => {
		const f = await receiver();
		const candidates = Array.from(
			{ length: 10 },
			(_, i) => `installation-${i}`,
		).sort((a, b) => sha256(a).localeCompare(sha256(b)));
		const withInstall = (receiver: Receiver, authorizationId: string) => ({
			...receiver,
			template: templateFor(receiver.runtimeOrigin, {
				authorizationId,
				reference: {
					...reference,
					executionId: `execution-${authorizationId}`,
				},
				principal: { kind: "user", id: `user-${authorizationId}` },
			}),
		});
		const statusFor = (receiver: Receiver) =>
			exchange(
				receiver,
				"/internal/runtime/oauth/v1/status",
				() => standardRequest(receiver, "status"),
				{ authorization: `Bearer ${serviceToken}` },
			);
		const original = candidates.slice(0, 8).map((id) => withInstall(f, id));
		for (const item of original) {
			f.store.addInstallation(item.template);
			await supplied(item);
			expect((await firstBegin(item)).status).toBe(200);
		}
		const live = withInstall(f, candidates[8] as string);
		f.store.addInstallation(live.template);
		expect((await supply(live)).status).toBe(503);
		for (const item of original)
			f.readback.invalid.add(item.template.authorizationId);

		expect((await supply(live)).status).toBe(200);
		expect((await firstBegin(live)).status).toBe(200);
		expect((await statusFor(live)).status).toBe(200);
		await f.stop();
		const restarted = await receiver({
			directory: f.directory,
			port: f.port,
			store: f.store,
			readback: f.readback,
		});
		expect(
			(await statusFor(withInstall(restarted, live.template.authorizationId)))
				.status,
		).toBe(200);
		expect(
			(await statusFor(withInstall(restarted, candidates[0] as string))).status,
		).toBe(503);
		const next = withInstall(restarted, candidates[9] as string);
		f.store.addInstallation(next.template);
		await supplied(next);
		expect((await firstBegin(next)).status).toBe(200);
	}, 35_000);

	it("does not load a fixed installation whose OAuth transaction expired", async () => {
		const f = await receiver();
		await registered(f);
		const begun = await firstBegin(f);
		expect(begun.status).toBe(200);
		const expiry = Number(begun.body.expiresAt);
		expect(expiry).toBeGreaterThan(Date.now());
		await f.stop();
		const restarted = await receiver({
			directory: f.directory,
			port: f.port,
			now: () => expiry,
		});
		const status = await exchange(
			restarted,
			"/internal/runtime/oauth/v1/status",
			() => standardRequest(restarted, "status"),
			{ authorization: `Bearer ${serviceToken}` },
		);
		expect(status.status).toBe(503);
		expect(restarted.readback.calls).toEqual([]);
	}, 20_000);

	it.each([-1, 0, 1])(
		"rechecks the original begin result after command readback at expiry offset %i",
		async (offset) => {
			let at = Date.now();
			vi.spyOn(Date, "now").mockImplementation(() => at);
			const first = await receiver({ now: () => at });
			await registered(first);
			const begun = await firstBegin(first);
			expect(begun.status).toBe(200);
			const expiry = Number(begun.body.expiresAt);
			const before = await recordNames(first);
			await first.stop();
			at = expiry - 1;
			const calls: ConnectionInstallReadbackInputV1[] = [];
			const restarted = await receiver({
				directory: first.directory,
				port: first.port,
				store: first.store,
				now: () => at,
				transportReadback: {
					async readback(input) {
						calls.push(structuredClone(input));
						if (input.purpose === "command") at = expiry + offset;
						return "allowed";
					},
				},
			});
			// Startup revalidates the persisted installation independently.
			calls.length = 0;
			const recovered = await beginStatus(restarted);
			expect(calls.map((call) => call.purpose)).toEqual(["supply", "command"]);
			expect(calls[1]?.command?.command).toBe("begin_status");
			// The command's fresh 30-second grant advanced by at most two milliseconds.
			expect(at - (expiry - 1)).toBeLessThan(30_000);
			if (offset < 0) {
				expect(recovered).toMatchObject({ status: 200, body: begun.body });
			} else {
				expect(recovered.status).toBe(403);
				expect(recovered.body).not.toHaveProperty("authorizationUrl");
			}
			expect(await recordNames(restarted)).toEqual(before);
			expect(restarted.connection.calls).toEqual([]);
			expect(decryption.opened).toBe(1);
		},
		20_000,
	);

	it("reloads the fixed installation after a Host restart without reopening the first begin", async () => {
		const first = await receiver();
		await registered(first);
		const begun = await firstBegin(first);
		expect(begun.status).toBe(200);
		// Stop only the first Host process; its private data directory remains.
		await first.stop();
		const f = await receiver({ directory: first.directory, port: first.port });
		const status = await exchange(
			f,
			"/internal/runtime/oauth/v1/status",
			() => standardRequest(f, "status"),
			{ authorization: `Bearer ${serviceToken}` },
		);
		expect(status).toMatchObject({
			status: 200,
			body: { authorizationId: "authorization-a", phase: "awaiting_callback" },
		});
		// Registration commands need a new supply attempt after the restart.
		expect((await supply(f, { attemptId: "supply-attempt-2" })).status).toBe(
			200,
		);
		// The persisted consumption still refuses the first begin; no new link.
		const before = await recordNames(f);
		expect(
			(await firstBegin(f, { supplyAttemptId: "supply-attempt-2" })).status,
		).toBe(409);
		expect(
			f.readback.calls.some((call) => call.command?.command === "begin"),
		).toBe(false);
		expect(await recordNames(f)).toEqual(before);
		const recovered = await beginStatus(f, {
			supplyAttemptId: "supply-attempt-2",
		});
		expect(recovered.status).toBe(200);
		expect(recovered.body).toEqual(begun.body);
		// Another Host session never reuses the fixed installation.
		f.store.state.hostRef = "host-ref-b";
		expect(
			(
				await exchange(
					f,
					"/internal/runtime/oauth/v1/status",
					() => standardRequest(f, "status"),
					{ authorization: `Bearer ${serviceToken}` },
				)
			).status,
		).toBe(403);
	}, 30_000);
});

describe("Connection install listener wiring", () => {
	it.each(["unconfigured", "manual", "full"] as const)(
		"keeps the manual receiver dormant in the Host production assembly with %s configuration",
		async (mode) => {
			const directory = await privateDirectory();
			const port = await freePort();
			const manual =
				mode === "full"
					? environmentFor(`https://${host}:${port}/`)
					: mode === "manual"
						? { AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_RECEIVER: "v1" }
						: {};
			const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				const runtime = await assembleRuntimeHost({
					...manual,
					AGENT_INFRA_RUNTIME_DRIVER: "fake",
					AGENT_INFRA_RUNTIME_DATA_DIR: directory,
					AGENT_INFRA_RUNTIME_AGENT_ID: "agent-a",
					AGENT_INFRA_RUNTIME_WORKER_ID: "worker-a",
					AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY: publicKey
						.export({ type: "spki", format: "pem" })
						.toString(),
					AGENT_INFRA_RUNTIME_GRANT_KEY_ID: "worker-key",
					AGENT_INFRA_RUNTIME_GRANT_ISSUER: "platform",
					AGENT_INFRA_RUNTIME_SERVICE_TOKEN: serviceToken,
				});
				try {
					expect(runtime).not.toHaveProperty("connectionInstall");
					expect(warning.mock.calls).toEqual(
						mode === "unconfigured"
							? []
							: [
									[
										JSON.stringify({
											service: "agent-runtime-host",
											code: "CONNECTION_MANUAL_INSTALLATION_DORMANT",
											dependency: "EP-1123",
										}),
									],
								],
					);
				} finally {
					await runtime.close();
				}
			} finally {
				warning.mockRestore();
			}
		},
	);

	it("starts and closes the install listener with the Runtime Host", async () => {
		const f = await receiver({ listen: false });
		const server = startRuntimeHost({
			connectionInstall: f.assembly,
			port: 0,
			serviceToken,
			host: {} as never,
			verifyGrant: () => {
				throw Error("Not used");
			},
			log: () => undefined,
		});
		if (!server.listening) await once(server, "listening");
		await waitForPort(f.port);
		expect((await supply(f)).status).toBe(200);
		await closeRuntimeHost(server, f.assembly.close);
		await expect(supply(f)).rejects.toThrow(
			"CONNECTION_INSTALL_TRANSPORT_UNAVAILABLE",
		);
	});
});
