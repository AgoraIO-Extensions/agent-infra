import {
	createHash,
	generateKeyPairSync,
	randomBytes,
	randomUUID,
} from "node:crypto";
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
import { request as httpsRequest, type Server } from "node:https";
import { createServer as createNetServer, type LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionSystemAccessFingerprintV1 } from "@agent-infra/contracts/connection-consumer-profile";
import {
	type ConnectionInstallReadbackRequestV1,
	connectionHostDeploymentIdentityV1,
} from "@agent-infra/contracts/runtime";
import {
	connectionServiceCredentialFingerprintV1,
	connectionServiceCredentialSecretInputV1,
	createConnectionInstallationAuthorizationV1,
} from "@agent-infra/platform-core";
import {
	PostgresAgentConnectionAssociationStoreV1,
	PostgresConnectionInstallationAuthorizationTransactionV1,
	PostgresConnectionManualInstallationStoreV1,
} from "@agent-infra/platform-store";
import { createSecretEncryptorV1 } from "@agent-infra/secret-store";
import { createWorkloadSecretKeyringDecryptorV1 } from "@agent-infra/secret-store/worker";
import postgres from "postgres";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { seedSessionSandboxFixture } from "../../../packages/platform-store/src/session-sandbox.fixture.js";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";
import { createConnectionInstallReadbackClientV1 } from "../../agent-runtime-host/src/connection-install-readback-client.js";
import {
	type ConnectionInstallReceiverAssemblyV1,
	prepareConnectionInstallReceiverV1,
	startConnectionInstallReceiverServerV1,
} from "../../agent-runtime-host/src/connection-install-receiver.js";
import { createConnectionInstallHostClientV1 } from "./connection-install-host-client.js";
import {
	createConnectionInstallReadbackServerV1,
	sessionSandboxConnectionInstallTokenV1,
} from "./connection-install-readback-server.js";
import { createConnectionManualInstallationDrainV1 } from "./connection-manual-installation-drain.js";

// Real TLS, Postgres, keyring and private files; Linux process protection is
// acceptance-only and is exercised by the Host's own image tests.
vi.mock("../../agent-runtime-host/src/standard-mcp-protection.js", () => ({
	assertStandardMcpProcessProtection: () => {},
}));

const namespace = "fixture-sandboxes";
const workerService = `platform-worker-connection-install.${namespace}.svc`;
const lookup: LookupFunction = (_host, options, done) => {
	if (typeof options === "object" && options?.all)
		(done as (e: null, a: { address: string; family: number }[]) => void)(
			null,
			[{ address: "127.0.0.1", family: 4 }],
		);
	else done(null, "127.0.0.1", 4);
};
const system = {
	schemaVersion: 1 as const,
	publicOrigin: "https://connection.test",
	mcpPath: "/mcp",
	audience: "mcp",
	egressProfile: { ref: "egress", revision: "r1" },
	issuer: "https://connection.test/",
	oauthCallbackUrl: "https://platform.test/connection/callback",
};
const approval = {
	schemaVersion: 1 as const,
	configFingerprint: connectionSystemAccessFingerprintV1(system),
	egressEnforced: true as const,
	source: { ref: "platform-deployment", revision: "r1" },
};
/** §13.5.1 exception approval bound to the same system access and approval source. */
const dynamic = {
	schemaVersion: 1 as const,
	principalMapping: {
		schemaVersion: 1 as const,
		kind: "consistency-exception-v1" as const,
		policy: { ref: "consistency-exception-v1", revision: "r1" },
		notAfter: "2099-01-01T00:00:00Z",
		maximumPinnedPrincipals: 2,
		verificationWindowHours: 24,
		connectionRelease: "agora-connector-2019ca07",
		systemAccessFingerprint: connectionSystemAccessFingerprintV1(system),
		approvalSource: approval.source,
	},
	readbackContract: { ref: "connection-ep-1060-read", revision: "1" },
	publicationContract: { ref: "connection-mcp-publication", revision: "1" },
};
const policy = {
	systemAccess: system,
	approval,
	clientName: "Agent Infra",
	dynamic,
	// The server-resolved set: no Principal confirmed outside the exception.
	confirmedPrincipals: [],
};
const directory = {
	resolveUser: async (userId: string) => ({
		schemaVersion: 1 as const,
		userId,
		accountStatus: "active" as const,
		organizationIds: ["eng"],
		authorizationRevision: "identity-r1",
	}),
};
/** Synthetic Consumer service credential; it may appear only on the Connection request. */
const credential = `conn_consumer_${randomBytes(24).toString("base64url")}`;
const deploymentServiceToken = randomBytes(32).toString("base64url");
const grant = generateKeyPairSync("ed25519");
const signing = {
	issuer: "platform-worker",
	workerId: "worker-a",
	keyId: "grant-key-1",
	privateKey: grant.privateKey,
};
const rsa = generateKeyPairSync("rsa", { modulusLength: 3072 });
const rsaPublic = rsa.publicKey.export({ format: "der", type: "spki" });
const rsaPrivate = rsa.privateKey.export({ format: "der", type: "pkcs8" });
const encryptor = createSecretEncryptorV1({
	encryptionKeys: {
		schemaVersion: 1,
		activeWrappingKeyVersion: "key-1",
		keys: [
			{
				schemaVersion: 1,
				keyVersion: "key-1",
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
				publicKeySpkiDerBase64: rsaPublic.toString("base64"),
				publicKeyFingerprint: createHash("sha256")
					.update(rsaPublic)
					.digest("hex"),
				rsaModulusBits: 3072,
				status: "active",
			},
		],
	},
});
const decryptor = createWorkloadSecretKeyringDecryptorV1({
	keys: [
		{
			keyVersion: "key-1",
			privateKeyPkcs8DerBase64: rsaPrivate.toString("base64"),
		},
	],
});

/** Local Connection EP-1060 fake: records every request; never a live network. */
const connection = {
	requests: [] as {
		method: string;
		path: string;
		key?: string;
		bearer?: string;
	}[],
	receipts: new Map<string, Record<string, unknown>>(),
	losePost: false,
	loseGet: false,
	/** Codes the fake token endpoint accepts exactly once (PKCE checked by S256). */
	codes: new Map<string, string>(),
};
async function connectionFetch(
	input: string | URL | Request,
	init?: RequestInit,
) {
	const url = new URL(String(input));
	const headers = new Headers(init?.headers);
	const method = init?.method ?? "GET";
	if (method === "POST" && url.pathname === "/oauth/token") {
		const form = new URLSearchParams(String(init?.body));
		connection.requests.push({ method, path: url.pathname });
		const challenge = connection.codes.get(form.get("code") ?? "");
		connection.codes.delete(form.get("code") ?? "");
		if (
			form.get("grant_type") !== "authorization_code" ||
			!challenge ||
			createHash("sha256")
				.update(form.get("code_verifier") ?? "")
				.digest("base64url") !== challenge
		)
			return Response.json({ error: "invalid_grant" }, { status: 400 });
		return Response.json({
			access_token: `synthetic-access-${randomBytes(16).toString("hex")}`,
			token_type: "Bearer",
			expires_in: 3600,
		});
	}
	const key = headers.get("idempotency-key") ?? undefined;
	connection.requests.push({
		method,
		path: url.pathname,
		...(key ? { key } : {}),
		bearer: headers.get("authorization") ?? "",
	});
	if (headers.get("authorization") !== `Bearer ${credential}`)
		return new Response(null, { status: 401 });
	if (method === "POST" && key) {
		const body = JSON.parse(String(init?.body));
		const receipt = {
			registrationKey: key,
			clientId: `client-${randomBytes(6).toString("hex")}`,
			clientName: body.clientName,
			clientStatus: "ACTIVE",
			configFingerprint: body.configFingerprint,
			consumerId: "consumer-internal-a",
			createdAt: new Date().toISOString(),
			instanceId: `instance-${randomBytes(6).toString("hex")}`,
			instanceStatus: "ACTIVE",
			principalId: null,
			redirectUri: body.redirectUri,
			resource: body.resource,
			scope: body.scope,
			source: body.source,
			status: "ACTIVE",
		};
		connection.receipts.set(key, receipt);
		if (connection.losePost) throw new TypeError("connection reset");
		return Response.json({
			registrationVersion: 1,
			outcome: "KNOWN",
			registration: receipt,
		});
	}
	const registrationKey = decodeURIComponent(
		url.pathname.split("/").at(-1) ?? "",
	);
	const known = connection.receipts.get(registrationKey);
	if (method === "GET" && connection.loseGet)
		throw new TypeError("connection reset");
	if (method === "GET")
		return Response.json(
			known
				? { registrationVersion: 1, outcome: "KNOWN", registration: known }
				: { registrationVersion: 1, outcome: "UNKNOWN", registration: null },
		);
	if (method === "DELETE" && known) {
		const revoked = {
			...known,
			status: "REVOKED",
			clientStatus: "REVOKED",
			instanceStatus: "REVOKED",
		};
		connection.receipts.set(registrationKey, revoked);
		return Response.json({
			registrationVersion: 1,
			outcome: "KNOWN",
			registration: revoked,
		});
	}
	return new Response(null, { status: 405 });
}

let database: PostgresTestDatabase;
let client: ReturnType<typeof postgres>;
let installations: PostgresConnectionInstallationAuthorizationTransactionV1;
let manual: PostgresConnectionManualInstallationStoreV1;
let associations: PostgresAgentConnectionAssociationStoreV1;
let use: ReturnType<typeof createConnectionInstallationAuthorizationV1>;
let hostTls: Awaited<ReturnType<typeof runtimeTlsFixture>>;
let workerTls: Awaited<ReturnType<typeof runtimeTlsFixture>>;
let readbackServer: ReturnType<typeof createConnectionInstallReadbackServerV1>;
let hostServer: Server | undefined;
let receiver: ConnectionInstallReceiverAssemblyV1 | undefined;
let dataDirectory: string;
/** Starts the Host receiver on the same port and private data directory. */
let startHost: () => Promise<void>;
let hostOrigin: string;
let callbackAuth: string;
let drain: ReturnType<typeof createConnectionManualInstallationDrainV1>;
let sandboxId: string;
type HostReference = {
	agentId: string;
	conversationId: string;
	executionId: string;
	sessionGeneration: number;
};
let readbackHook:
	| ((request: ConnectionInstallReadbackRequestV1) => Promise<void>)
	| undefined;
const readbacks: string[] = [];
let loseSupply: "before_host" | "after_host" | undefined;
let supplyCalls = 0;
let decryptCalls = 0;

async function freePort() {
	const server = createNetServer();
	// The receiver listens on every interface, so reserve the port the same way.
	server.listen(0);
	await once(server, "listening");
	const address = server.address();
	server.close();
	await once(server, "close");
	if (!address || typeof address === "string") throw new Error("port");
	return address.port;
}

async function seedAgent(agentId: string) {
	await client`insert into platform.agents(id,authorization_revision) values (${agentId},'agent-r1')`;
	await client`insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence) values (${`application-${agentId}`},${agentId},'owner','Agent','test','available','trace','request',now(),1,1,'ready','running',1,1)`;
	await client`insert into platform.agent_owners(agent_id,owner_id,created_at) values (${agentId},'owner',now())`;
}

async function seedExecution(user: string, suffix: string, worker: string) {
	await client`insert into platform.relay_key_subjects(purpose,subject_id,last_version,current_version) values ('personal',${user},1,1) on conflict do nothing`;
	await client`insert into platform.relay_key_versions(purpose,subject_id,key_version,key_id,ciphertext) values ('personal',${user},1,${`key-${user}`},${client.json({ purpose: "personal", subjectId: user, keyId: `key-${user}`, keyVersion: 1 })}) on conflict do nothing`;
	await client`insert into platform.agent_availability(agent_id,target_type,target_id) values ('agent-a','user',${user}) on conflict do nothing`;
	await client`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision,host_session_ref) values (${`conversation-${suffix}`},'agent-a',${user},'web','active',1,'agent-r1',${`host-${suffix}`})`;
	await client`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at,runtime_submit_protocol,original_operation_digest,original_submit_host_session_ref,execution_source,relay_key_purpose,relay_key_subject_id,relay_key_id,relay_key_version,delivery_fence) values (${`execution-${suffix}`},${`conversation-${suffix}`},'agent-a',${user},'web',${`turn-${suffix}`},'processing',1,'agent-r1',now(),'v4',${"a".repeat(43)},${`host-${suffix}`},'web','personal',${user},${`key-${user}`},1,3)`;
	await client`insert into platform.task_authorization_records(id,execution_id,boundary) values (${`task-${suffix}`},${`execution-${suffix}`},${client.json({ schemaVersion: 1, principal: { kind: "user", id: user }, agentId: "agent-a", channelId: "web", identityRevision: "identity-r1", agentAuthorizationRevision: "agent-r1", accessSources: [{ kind: "user", userId: user }] })})`;
	await seedSessionSandboxFixture(client, `conversation-${suffix}`);
	// A live claim carries the same delivery fence on the outbox item and the Execution.
	await client`insert into platform.outbox_items(id,scope_type,scope_id,operation,payload,status,lease_owner,lease_expires_at,delivery_fence,trace_id) values (${`item-${suffix}`},'conversation',${`conversation-${suffix}`},'conversation.turn.submit.v1',${client.json({ executionId: `execution-${suffix}` })},'processing',${worker},now()+interval '1 hour',3,'trace')`;
}

async function associate(revision: number) {
	await client`insert into platform.connection_association_generations(agent_id,last_revision) values ('agent-a',${revision}) on conflict (agent_id) do update set last_revision=excluded.last_revision`;
	await client`delete from platform.connection_manual_associations where agent_id='agent-a'`;
	const ciphertext = encryptor.encrypt(
		connectionServiceCredentialSecretInputV1(
			{ agentId: "agent-a", ownerId: "owner", associationRevision: revision },
			credential,
			new Date().toISOString(),
		),
	);
	await client`insert into platform.connection_manual_associations(agent_id,connection_agent_id,credential_fingerprint,association_revision,owner_id,credential_ciphertext,verified_at) values ('agent-a','connection-agent-a',${connectionServiceCredentialFingerprintV1(credential)},${revision},'owner',${client.json(ciphertext as never)},now())`;
}

async function writePrivate(directory: string, name: string, value: string) {
	await writeFile(join(directory, name), value, { mode: 0o600 });
}

beforeAll(async () => {
	database = await startPostgresTestDatabase("4206-manual-install-e2e");
	client = postgres(database.databaseUrl, { onnotice: () => {} });
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	await seedAgent("agent-a");
	await seedExecution("alice", "a", "worker-a");
	await seedExecution("bob", "bob", "worker-b");
	const [allocation] =
		await client`select sandbox_id from platform.session_sandbox_allocations where conversation_id='conversation-a'`;
	sandboxId = allocation?.sandbox_id as string;
	installations = new PostgresConnectionInstallationAuthorizationTransactionV1({
		databaseUrl: database.databaseUrl,
		directory,
		manualInstallation: policy,
	});
	manual = new PostgresConnectionManualInstallationStoreV1({
		databaseUrl: database.databaseUrl,
		directory,
		policy,
	});
	associations = new PostgresAgentConnectionAssociationStoreV1({
		databaseUrl: database.databaseUrl,
	});
	use = createConnectionInstallationAuthorizationV1({ store: installations });

	hostTls = await runtimeTlsFixture({
		dnsNames: [`sandbox-${sandboxId}.${namespace}.svc`],
	});
	workerTls = await runtimeTlsFixture({ dnsNames: [workerService] });
	const deploymentIdentity = connectionHostDeploymentIdentityV1({
		namespace,
		workerId: "worker-a",
	});
	readbackServer = createConnectionInstallReadbackServerV1({
		key: workerTls.key,
		cert: workerTls.cert,
		port: 0,
		host: "127.0.0.1",
		deploymentServiceToken,
		namespace,
		deploymentIdentity,
		readback: async (request) => {
			readbacks.push(
				`${request.purpose}:${request.command?.command ?? "supply"}`,
			);
			await readbackHook?.(request);
			return manual.readback(request);
		},
	});
	const workerPort = await readbackServer.listen();
	const hostPort = await freePort();
	hostOrigin = `https://sandbox-${sandboxId}.${namespace}.svc:${hostPort}/`;

	dataDirectory = await realpath(
		await mkdtemp(join(tmpdir(), "manual-install-host-")),
	);
	let path = dataDirectory;
	for (const part of [
		"codex-driver.json.native",
		"conversations",
		"standard-mcp-oauth",
		"tls",
	]) {
		path = join(path, part);
		await mkdir(path, { mode: 0o700 });
	}
	const installToken = sessionSandboxConnectionInstallTokenV1(
		deploymentServiceToken,
		namespace,
		sandboxId,
	);
	await writePrivate(path, "server.crt", hostTls.cert);
	await writePrivate(path, "server.key", hostTls.key);
	callbackAuth = randomBytes(32).toString("base64url");
	await writePrivate(path, "callback.auth", callbackAuth);
	await writePrivate(path, "install.auth", installToken);
	await writePrivate(path, "worker-ca.crt", workerTls.ca);
	const [pod] =
		await client`select resource_observation from platform.session_sandbox_allocations where sandbox_id=${sandboxId}`;
	const podUid = (
		(pod as { resource_observation: unknown }).resource_observation as {
			resources: { kind: string; uid: string }[];
		}
	).resources.find((resource) => resource.kind === "Pod")?.uid as string;
	startHost = async () => {
		receiver = await prepareConnectionInstallReceiverV1({
			environment: {
				AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_RECEIVER: "v1",
				AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_ORIGIN: `https://sandbox-${sandboxId}.${namespace}.svc:${hostPort}/`,
				AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_WORKER_ORIGIN: `https://${workerService}:${workerPort}/`,
				AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_SYSTEM_ACCESS:
					JSON.stringify(system),
				AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_SYSTEM_ACCESS_APPROVAL:
					JSON.stringify(approval),
				AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_CLIENT_NAME: "Agent Infra",
				AGENT_INFRA_RUNTIME_NAMESPACE: namespace,
				AGENT_INFRA_RUNTIME_POD_NAME: `sandbox-${sandboxId}`,
				AGENT_INFRA_RUNTIME_POD_UID: podUid,
				AGENT_INFRA_RUNTIME_RESOURCE_FENCE: "1",
				AGENT_INFRA_RUNTIME_SANDBOX_ID: sandboxId,
				AGENT_INFRA_RUNTIME_SESSION_GENERATION: "1",
				PORT: "3003",
			},
			dataDirectory,
			agentId: "agent-a",
			workerId: "worker-a",
			key: grant.publicKey,
			keyId: signing.keyId,
			issuer: signing.issuer,
			serviceToken: randomBytes(32).toString("base64url"),
			// The Host journal holds alice's original Execution on host-a.
			store: {
				resolveOriginalExecutionBinding: async (reference: HostReference) => {
					if (reference.executionId !== "execution-a")
						throw new Error("denied");
					return {
						principal: { kind: "user", id: "alice" },
						scope: {
							agentId: reference.agentId,
							conversationId: reference.conversationId,
							sessionGeneration: reference.sessionGeneration,
							executionId: reference.executionId,
						},
					};
				},
				assertOriginalExecutionBindingCurrent: (reference: HostReference) => {
					if (reference.executionId !== "execution-a")
						throw new Error("denied");
				},
				resolveOriginalExecutionHostSessionRef: async (
					reference: HostReference,
				) => {
					if (reference.executionId !== "execution-a")
						throw new Error("denied");
					return "host-a";
				},
			} as never,
			fetch: connectionFetch as never,
			readback: createConnectionInstallReadbackClientV1({
				origin: `https://${workerService}:${workerPort}/`,
				ca: workerTls.ca,
				installToken,
				lookup,
			}),
		});
		if (receiver?.status !== "available")
			throw new Error("receiver unavailable");
		hostServer = startConnectionInstallReceiverServerV1(receiver);
		await once(hostServer, "listening");
	};
	await startHost();
	const host = createConnectionInstallHostClientV1({
		ca: hostTls.ca,
		signing,
		lookup,
	});
	drain = createConnectionManualInstallationDrainV1({
		store: manual,
		decryptor: {
			decrypt(input) {
				decryptCalls++;
				return decryptor.decrypt(input);
			},
		},
		host: {
			...host,
			async supply(input, signal) {
				supplyCalls++;
				if (loseSupply === "before_host") throw new Error("delivery lost");
				await host.supply(input, signal);
				if (loseSupply === "after_host") throw new Error("confirmation lost");
			},
		},
		systemAccess: system,
		approval,
		clientName: "Agent Infra",
		namespace,
		receiverPort: hostPort,
		deploymentWorkerId: "worker-a",
		attemptOwner: "worker-a",
	});
}, 240_000);

afterAll(async () => {
	hostServer?.close();
	if (receiver?.status === "available") await receiver.close();
	await readbackServer?.close();
	await manual?.close();
	await installations?.close();
	await associations?.close();
	await client?.end();
	await database?.stop();
	await hostTls?.cleanup();
	await workerTls?.cleanup();
	if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
});

beforeEach(async () => {
	await client`delete from platform.connection_manual_install_permits`;
	await client`delete from platform.connection_principal_pin_receipts`;
	await client`delete from platform.connection_principal_pins`;
	await client`delete from platform.connection_manual_installations`;
	await client`delete from platform.connection_installation_commands`;
	await client`delete from platform.connection_installation_authorizations`;
	await client`delete from platform.idempotency_records where scope_type='connection_installation'`;
	await client`update platform.conversation_executions set delivery_fence=3 where execution_id='execution-a'`;
	await associate(1);
	connection.requests.length = 0;
	connection.losePost = false;
	connection.loseGet = false;
	connection.codes.clear();
	readbacks.length = 0;
	readbackHook = undefined;
	loseSupply = undefined;
	supplyCalls = 0;
	decryptCalls = 0;
	// Each case starts without the previous case's pending OAuth transaction for the
	// same user and Agent; the Host serializes one pending installation per pair.
	const records = join(
		dataDirectory,
		"codex-driver.json.native",
		"conversations",
		"standard-mcp-oauth",
		"records",
	);
	for (const name of await readdir(records).catch(() => [] as string[]))
		if (name.startsWith("current-"))
			await rm(join(records, name), { force: true });
});

async function begin(user = "alice", suffix = "a") {
	return use.executeInstallation({
		userId: user,
		identityRevision: "identity-r1",
		command: "begin",
		executionId: `execution-${suffix}`,
		idempotencyKey: randomUUID(),
		requestId: "request",
		traceId: "trace",
	});
}
async function status(authorizationId: string) {
	return use.executeInstallation({
		userId: "alice",
		identityRevision: "identity-r1",
		command: "status",
		authorizationId,
		requestId: "request",
		traceId: "trace",
	});
}
const tick = (executions = ["execution-a"]) =>
	drain.drain(executions, new AbortController().signal);

async function noCredentialStored() {
	const rows = await client`
		select row_to_json(t)::text as value from (
			select * from platform.connection_manual_installations) t
		union all select row_to_json(t)::text from (select * from platform.connection_installation_commands) t
		union all select row_to_json(t)::text from (select * from platform.connection_installation_authorizations) t
		union all select row_to_json(t)::text from (select * from platform.audit_events) t`;
	expect(JSON.stringify(rows)).not.toContain(credential);
	expect(JSON.stringify(rows)).not.toContain(
		credential.slice("conn_consumer_".length),
	);
}

/** Runs the first begin while the callback mapping CAS is rejected: begin stays unknown. */
async function firstBeginWithoutMapping() {
	await client`
		create function platform.test_reject_first_connection_mapping()
		returns trigger language plpgsql as $$
		begin
			return null;
		end
		$$`;
	try {
		await client`
			create trigger test_reject_first_connection_mapping
			before update on platform.connection_installation_authorizations
			for each row when (old.binding->'callback' is null and new.binding->'callback' is not null)
			execute function platform.test_reject_first_connection_mapping()`;
		expect(await tick()).toBe(1);
	} finally {
		await client`drop trigger if exists test_reject_first_connection_mapping on platform.connection_installation_authorizations`;
		await client`drop function platform.test_reject_first_connection_mapping()`;
	}
}

/** Stops the Host process state: its in-memory supply slots are gone; the private volume stays. */
async function restartHost() {
	const server = hostServer;
	if (server) {
		server.closeAllConnections();
		server.close();
		await once(server, "close");
	}
	if (receiver?.status === "available") await receiver.close();
	await startHost();
}

describe("first manual Owner EP-1060 install over real TLS, Store and Host (§13.5.5–§13.5.7)", () => {
	it("supplies, prepares once, CASes the receipt and fixes the configuration in the first begin", async () => {
		const projection = await begin();
		expect(await tick()).toBe(1);
		expect(connection.requests).toHaveLength(1);
		const [row] =
			await client`select registration_key, registration_state, supply_state, client_id from platform.connection_manual_installations where authorization_id=${projection.authorizationId}`;
		expect(connection.requests[0]).toEqual({
			method: "POST",
			path: "/connection/v1/agents/connection-agent-a/oauth-clients",
			key: row?.registration_key,
			bearer: `Bearer ${credential}`,
		});
		expect(row).toMatchObject({
			registration_state: "registered",
			supply_state: "confirmed",
		});
		// The Host checked the supply record before decrypting and the command before sending.
		expect(readbacks.slice(0, 3)).toEqual([
			"supply_delivery:supply",
			"command:prepare",
			"command:prepare",
		]);
		expect(await tick()).toBe(1);
		// The first begin never contacts Connection; it only fixes the configuration and link.
		expect(connection.requests).toHaveLength(1);
		const bound = await status(projection.authorizationId);
		const link = new URL(
			(bound as { authorizationUrl?: string }).authorizationUrl ?? "",
		);
		expect(link.origin + link.pathname).toBe(
			"https://connection.test/oauth/authorize",
		);
		expect(link.searchParams.get("client_id")).toBe(row?.client_id);
		expect(link.searchParams.get("redirect_uri")).toBe(system.oauthCallbackUrl);
		// §13.5.6: the Host fixed the same descriptor the Store bound at the receipt CAS.
		const [fixed] = await client`
			select descriptor, descriptor_digest, consumer_id, instance_id from platform.connection_manual_installations
			where authorization_id=${projection.authorizationId}`;
		expect(fixed?.descriptor).toMatchObject({
			registrationKey: row?.registration_key,
			clientId: row?.client_id,
			consumerId: fixed?.consumer_id,
			instanceId: fixed?.instance_id,
			principalMapping: {
				kind: "consistency-exception-v1",
				policy: dynamic.principalMapping.policy,
				pinnedPrincipalId: null,
			},
			readbackContract: dynamic.readbackContract,
			publicationContract: dynamic.publicationContract,
		});
		const consumption = JSON.parse(
			await readFile(
				join(
					dataDirectory,
					"codex-driver.json.native",
					"conversations",
					"standard-mcp-oauth",
					"records",
					`install-first-begin-${createHash("sha256").update(projection.authorizationId).digest("hex")}.json`,
				),
				"utf8",
			),
		);
		expect(consumption.descriptor).toEqual(fixed?.descriptor);
		expect(consumption.descriptorDigest).toBe(fixed?.descriptor_digest);
		// Duplicate drains find nothing to resend.
		expect(await tick()).toBe(0);
		expect(connection.requests).toHaveLength(1);
		await noCredentialStored();
	});

	/** The API's callback delivery to the original Host (code + state; PKCE checked by the fake). */
	async function deliverHostCallback(authorizationUrl: string) {
		const link = new URL(authorizationUrl);
		const code = `synthetic-code-${randomBytes(12).toString("hex")}`;
		connection.codes.set(code, link.searchParams.get("code_challenge") ?? "");
		const body = JSON.stringify({
			schemaVersion: 1,
			state: link.searchParams.get("state"),
			issuer: system.issuer,
			code,
		});
		return new Promise<number>((resolve, reject) => {
			const sent = httpsRequest(
				new URL("/internal/runtime/oauth/v1/callback", hostOrigin),
				{
					method: "POST",
					ca: hostTls.ca,
					lookup,
					headers: {
						authorization: `Bearer ${callbackAuth}`,
						"content-type": "application/json",
						"content-length": Buffer.byteLength(body),
					},
				},
				(response) => {
					response.resume();
					response.on("end", () => resolve(response.statusCode ?? 0));
				},
			);
			sent.on("error", reject);
			sent.end(body);
		});
	}

	/** First begin, consumed callback and the original user's explicit confirm. */
	async function confirmedInstall() {
		const projection = await begin();
		expect(await tick()).toBe(1);
		expect(await tick()).toBe(1);
		const bound = await status(projection.authorizationId);
		expect(
			await deliverHostCallback(
				(bound as { authorizationUrl?: string }).authorizationUrl ?? "",
			),
		).toBe(200);
		const [mapped] =
			await client`select binding->'callback'->>'stateHash' as hash from platform.connection_installation_authorizations where id=${projection.authorizationId}`;
		const stateHash = mapped?.hash as string;
		const claimed = await use.callback.claim({ stateHash, now: Date.now() });
		expect(
			await use.callback.settle({
				stateHash,
				attemptId: claimed?.attemptId as string,
				now: Date.now(),
				status: "delivered",
			}),
		).toBe(true);
		expect(
			await use.executeInstallation({
				userId: "alice",
				identityRevision: "identity-r1",
				command: "confirm",
				authorizationId: projection.authorizationId,
				idempotencyKey: randomUUID(),
				requestId: "request",
				traceId: "trace",
			}),
		).toMatchObject({ status: "confirmed" });
		const [row] =
			await client`select registration_key from platform.connection_manual_installations where authorization_id=${projection.authorizationId}`;
		return { projection, registrationKey: row?.registration_key as string };
	}
	const confirmState = (authorizationId: string) => client`
		select
			(select count(*)::int from platform.connection_principal_pins) as pins,
			(select count(*)::int from platform.connection_principal_pin_receipts where authorization_id=${authorizationId}) as receipts,
			(select a.status from platform.connection_installation_authorizations a where a.id=${authorizationId}) as status,
			(select string_agg(command || ':' || status, ',' order by created_at, command)
				from platform.connection_installation_commands
				where authorization_id=${authorizationId} and (command like 'confirm%' or command='revoke')) as commands`;
	// Begin, callback, confirm and the phase run over real TLS in one test; the
	// default 5 s is too tight when the whole package runs in parallel.
	const confirmTimeout = 20_000;

	// §13.5.6 exception confirm, phase 1 over the real Store, Worker and Host.
	it(
		"reads the binding back, pins, and exchanges the original code once in phase 2",
		async () => {
			const { projection, registrationKey } = await confirmedInstall();
			// The user approved the installation in Connection: the instance now names a Principal.
			const known = connection.receipts.get(registrationKey) as Record<
				string,
				unknown
			>;
			connection.receipts.set(registrationKey, {
				...known,
				principalId: "principal-a",
			});
			readbacks.length = 0;
			expect(await tick()).toBe(1);
			// Phase 2 completed; the logical confirm stays open for the publication
			// permit, so MCP remains closed.
			expect(await confirmState(projection.authorizationId)).toEqual([
				{
					pins: 1,
					receipts: 1,
					status: "confirmed",
					commands:
						"confirm:sending,confirm_binding_readback:completed,confirm_exchange:completed",
				},
			]);
			const [pin] =
				await client`select issuer, principal_id, user_id from platform.connection_principal_pins`;
			expect(pin).toEqual({
				issuer: system.issuer,
				principal_id: "principal-a",
				user_id: "alice",
			});
			// Phase 1 checked its command around its GET; phase 2 checked the receipt,
			// the fixed transaction's supply, the receipt after its GET and after its
			// private record, then exchanged once.
			expect(readbacks).toEqual([
				"command:confirm_binding_readback",
				"command:confirm_binding_readback",
				"command:confirm_exchange",
				"supply:supply",
				"command:confirm_exchange",
				"command:confirm_exchange",
			]);
			expect(
				connection.requests.map(({ method, path }) => `${method} ${path}`),
			).toEqual([
				"POST /connection/v1/agents/connection-agent-a/oauth-clients",
				`GET /connection/v1/agents/connection-agent-a/oauth-clients/${registrationKey}`,
				`GET /connection/v1/agents/connection-agent-a/oauth-clients/${registrationKey}`,
				"POST /oauth/token",
			]);
			// The code was used once; the next tick sends nothing and resends nothing.
			expect(connection.codes.size).toBe(0);
			expect(await tick()).toBe(0);
			expect(connection.requests).toHaveLength(4);
			await noCredentialStored();
		},
		confirmTimeout,
	);

	/** Confirmed install whose Connection instance now names principal-a. */
	async function approvedInstall() {
		const installed = await confirmedInstall();
		const known = connection.receipts.get(installed.registrationKey) as Record<
			string,
			unknown
		>;
		connection.receipts.set(installed.registrationKey, {
			...known,
			principalId: "principal-a",
		});
		return installed;
	}
	const exchangedNothing = () =>
		expect(
			connection.requests.filter(({ path }) => path === "/oauth/token"),
		).toEqual([]);

	it(
		"closes an exchanged install without a permit and deletes its original key at Connection",
		async () => {
			const { projection, registrationKey } = await approvedInstall();
			expect(await tick()).toBe(1);
			// No publication evidence yet, so no permit: the attempt lapses.
			await client`update platform.connection_installation_commands set attempt_expires_at=clock_timestamp()-interval '1 second'
				where authorization_id=${projection.authorizationId} and status='sending'`;
			expect(await tick()).toBe(1);
			const [row] =
				await client`select revoke_state from platform.connection_manual_installations where authorization_id=${projection.authorizationId}`;
			expect(row?.revoke_state).toBe("revoked");
			expect(
				connection.requests.map(({ method, path }) => `${method} ${path}`),
			).toEqual([
				"POST /connection/v1/agents/connection-agent-a/oauth-clients",
				`GET /connection/v1/agents/connection-agent-a/oauth-clients/${registrationKey}`,
				`GET /connection/v1/agents/connection-agent-a/oauth-clients/${registrationKey}`,
				"POST /oauth/token",
				`DELETE /connection/v1/agents/connection-agent-a/oauth-clients/${encodeURIComponent(registrationKey)}`,
			]);
			expect(
				(connection.receipts.get(registrationKey) as { status?: string })
					.status,
			).toBe("REVOKED");
			await noCredentialStored();
		},
		confirmTimeout,
	);

	it(
		"refuses phase 2 and revokes when the binding drifted after the pin",
		async () => {
			const { projection, registrationKey } = await approvedInstall();
			readbackHook = async (request) => {
				if (request.command?.command !== "confirm_exchange") return;
				readbackHook = undefined;
				const known = connection.receipts.get(registrationKey) as Record<
					string,
					unknown
				>;
				connection.receipts.set(registrationKey, {
					...known,
					principalId: "principal-b",
				});
			};
			expect(await tick()).toBe(1);
			// The pin stays (exception item 6); nothing re-pins to the new value.
			expect(await confirmState(projection.authorizationId)).toEqual([
				{
					pins: 1,
					receipts: 1,
					status: "revoked",
					commands:
						"confirm:rejected,confirm_binding_readback:completed,confirm_exchange:rejected,revoke:pending",
				},
			]);
			exchangedNothing();
			expect(connection.codes.size).toBe(1);
		},
		confirmTimeout,
	);

	it.each([
		[
			"the original fence moved",
			() =>
				client`update platform.conversation_executions set delivery_fence=4 where execution_id='execution-a'`,
		],
		[
			"the pin was released",
			// An item 6 release: the request facts the release CHECK requires.
			() =>
				client`update platform.connection_principal_pins set released_at=now(),
					release_requested_at=now(), release_reason='administrator',
					release_actor_id='admin-1', release_reference='https://example.test/unpin'`,
		],
		[
			"the first-pin receipt expired",
			() =>
				client`update platform.connection_principal_pin_receipts set expires_at=now()-interval '1 second'`,
		],
	])(
		"reads nothing back and exchanges nothing in phase 2 once %s",
		async (_name, change) => {
			const { projection } = await approvedInstall();
			// The change itself must apply; a fixture refused by the schema would
			// fail the readback for another reason and prove nothing.
			let applied = false;
			readbackHook = async (request) => {
				if (request.command?.command !== "confirm_exchange") return;
				readbackHook = undefined;
				await change();
				applied = true;
			};
			await tick();
			expect(applied).toBe(true);
			const getCount = connection.requests.filter(
				({ method }) => method === "GET",
			).length;
			expect(getCount).toBe(1);
			exchangedNothing();
			const [state] = await confirmState(projection.authorizationId);
			expect(state?.commands).toMatch(/confirm_exchange:(unknown|sending)/);
			expect(state?.commands).not.toContain("confirm_exchange:completed");
		},
		confirmTimeout,
	);

	it(
		"sends no EP-1060 readback and pins nothing once the original claim changes",
		async () => {
			const { projection, registrationKey } = await confirmedInstall();
			const known = connection.receipts.get(registrationKey) as Record<
				string,
				unknown
			>;
			connection.receipts.set(registrationKey, {
				...known,
				principalId: "principal-a",
			});
			readbackHook = async (request) => {
				if (request.command?.command === "confirm_binding_readback")
					await client`update platform.conversation_executions set delivery_fence=4 where execution_id='execution-a'`;
			};
			readbacks.length = 0;
			await tick();
			expect(readbacks).toEqual(["command:confirm_binding_readback"]);
			expect(connection.requests.map(({ method }) => method)).toEqual(["POST"]);
			const [state] = await confirmState(projection.authorizationId);
			expect(state).toMatchObject({ pins: 0, receipts: 0 });
			expect(state?.commands).not.toContain(
				"confirm_binding_readback:completed",
			);
			await noCredentialStored();
		},
		confirmTimeout,
	);

	it(
		"revokes the original key when the binding readback names no Principal",
		async () => {
			const { projection } = await confirmedInstall();
			expect(await tick()).toBe(1);
			expect(await confirmState(projection.authorizationId)).toEqual([
				{
					pins: 0,
					receipts: 0,
					status: "revoked",
					commands:
						"confirm:rejected,confirm_binding_readback:rejected,revoke:pending",
				},
			]);
			expect(connection.requests.map(({ method }) => method)).toEqual([
				"POST",
				"GET",
			]);
		},
		confirmTimeout,
	);

	// #4309 S1: Connection's explicit UNKNOWN is a non-KNOWN answer (§13.5.1
	// item 2) and is refused; a failed read is no answer and stays unknown.
	it(
		"revokes the original key when Connection answers UNKNOWN for it",
		async () => {
			const { projection, registrationKey } = await confirmedInstall();
			connection.receipts.delete(registrationKey);
			expect(await tick()).toBe(1);
			expect(await confirmState(projection.authorizationId)).toEqual([
				{
					pins: 0,
					receipts: 0,
					status: "revoked",
					commands:
						"confirm:rejected,confirm_binding_readback:rejected,revoke:pending",
				},
			]);
			expect(connection.requests.map(({ method }) => method)).toEqual([
				"POST",
				"GET",
			]);
		},
		confirmTimeout,
	);

	it(
		"keeps the phase unknown without a revoke when the EP-1060 read fails",
		async () => {
			const { projection, registrationKey } = await confirmedInstall();
			const known = connection.receipts.get(registrationKey) as Record<
				string,
				unknown
			>;
			connection.receipts.set(registrationKey, {
				...known,
				principalId: "principal-a",
			});
			connection.loseGet = true;
			expect(await tick()).toBe(1);
			expect(await confirmState(projection.authorizationId)).toEqual([
				{
					pins: 0,
					receipts: 0,
					status: "confirmed",
					commands: "confirm:unknown,confirm_binding_readback:unknown",
				},
			]);
			expect(connection.requests.map(({ method }) => method)).toEqual([
				"POST",
				"GET",
			]);
		},
		confirmTimeout,
	);

	it(
		"keeps a would-be reject unknown when the claim changes during the EP-1060 read",
		async () => {
			const { projection } = await confirmedInstall();
			let phaseReadbacks = 0;
			readbackHook = async (request) => {
				if (
					request.command?.command === "confirm_binding_readback" &&
					++phaseReadbacks === 2
				)
					await client`update platform.conversation_executions set delivery_fence=4 where execution_id='execution-a'`;
			};
			await tick();
			expect(phaseReadbacks).toBe(2);
			expect(await confirmState(projection.authorizationId)).toEqual([
				{
					pins: 0,
					receipts: 0,
					status: "confirmed",
					commands: "confirm:unknown,confirm_binding_readback:unknown",
				},
			]);
			// No compensation was queued from a read the claim no longer held.
			expect(connection.requests.map(({ method }) => method)).toEqual([
				"POST",
				"GET",
			]);
		},
		confirmTimeout,
	);

	it("recovers the original consumed begin after the callback mapping CAS fails", async () => {
		const projection = await begin();
		expect(await tick()).toBe(1);
		await firstBeginWithoutMapping();
		const [unmapped] = await client`
			select a.binding->'callback' as callback, c.status from platform.connection_installation_authorizations a
			join platform.connection_installation_commands c on c.authorization_id=a.id
			where a.id=${projection.authorizationId} and c.command='begin'`;
		expect(unmapped).toMatchObject({ callback: null, status: "unknown" });
		expect(await status(projection.authorizationId)).not.toHaveProperty(
			"authorizationUrl",
		);
		expect(await tick()).toBe(1);
		const recovered = await status(projection.authorizationId);
		expect(recovered).toHaveProperty(
			"authorizationUrl",
			expect.stringMatching(/^https:\/\/connection\.test\/oauth\/authorize\?/),
		);
		const [mapped] = await client`
			select a.binding->'callback' as callback, c.status from platform.connection_installation_authorizations a
			join platform.connection_installation_commands c on c.authorization_id=a.id
			where a.id=${projection.authorizationId} and c.command='begin'`;
		expect(mapped).toMatchObject({
			callback: { stateHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
			status: "completed",
		});
		expect(readbacks).toContain("command:begin_status");
		expect(supplyCalls).toBe(1);
		expect(decryptCalls).toBe(1);
		expect(connection.requests.map(({ method }) => method)).toEqual(["POST"]);
		expect(await tick()).toBe(0);
	});

	// PR-Agent on #4206: after a Host restart the in-memory supply slot is gone, so
	// begin_status could only answer conflict for a consumed first begin.
	it("recovers the original consumed begin read-only after the Host restarts", async () => {
		const projection = await begin();
		expect(await tick()).toBe(1);
		await firstBeginWithoutMapping();
		const [lost] = await client`
			select a.binding->'callback' as callback, c.status from platform.connection_installation_authorizations a
			join platform.connection_installation_commands c on c.authorization_id=a.id
			where a.id=${projection.authorizationId} and c.command='begin'`;
		expect(lost).toMatchObject({ callback: null, status: "unknown" });
		await restartHost();
		expect(await status(projection.authorizationId)).not.toHaveProperty(
			"authorizationUrl",
		);
		readbacks.length = 0;
		expect(await tick()).toBe(1);
		const recovered = await status(projection.authorizationId);
		expect(recovered).toHaveProperty(
			"authorizationUrl",
			expect.stringMatching(/^https:\/\/connection\.test\/oauth\/authorize\?/),
		);
		const [mapped] = await client`
			select c.status, (select status from platform.connection_installation_commands
				where authorization_id=a.id and command='begin_status') as begin_status
			from platform.connection_installation_authorizations a
			join platform.connection_installation_commands c on c.authorization_id=a.id
			where a.id=${projection.authorizationId} and c.command='begin'`;
		expect(mapped).toEqual({ status: "completed", begin_status: "completed" });
		// Read-only: the restarted Host checked the original supply and the command, and
		// neither the supply nor Connection was contacted again.
		expect(readbacks).toEqual(["supply:supply", "command:begin_status"]);
		expect(supplyCalls).toBe(1);
		expect(decryptCalls).toBe(1);
		expect(connection.requests.map(({ method }) => method)).toEqual(["POST"]);
		expect(await tick()).toBe(0);
	});

	it("keeps the link closed after a Host restart once the original supply no longer holds", async () => {
		const projection = await begin();
		expect(await tick()).toBe(1);
		await firstBeginWithoutMapping();
		await restartHost();
		expect(await status(projection.authorizationId)).not.toHaveProperty(
			"authorizationUrl",
		);
		// The original supply attempt stops being confirmable while the restarted Host
		// reads it back; the begin_status command itself was signed and sent.
		readbackHook = async (request) => {
			if (request.purpose === "supply")
				await client`update platform.connection_manual_installations set supply_state='unknown'
					where authorization_id=${projection.authorizationId}`;
		};
		readbacks.length = 0;
		await tick();
		expect(readbacks).toEqual(["supply:supply"]);
		// The install is closed for its user; no link is returned or mapped.
		await expect(status(projection.authorizationId)).rejects.toMatchObject({
			code: "denied",
		});
		const [row] = await client`
			select a.binding->'callback' as callback, c.status from platform.connection_installation_authorizations a
			join platform.connection_installation_commands c on c.authorization_id=a.id
			where a.id=${projection.authorizationId} and c.command='begin'`;
		expect(row).toMatchObject({ callback: null, status: "unknown" });
		expect(supplyCalls).toBe(1);
		expect(connection.requests.map(({ method }) => method)).toEqual(["POST"]);
	});

	it.each(["after_host", "before_host"] as const)(
		"checks only the original supply metadata when delivery confirmation is lost %s",
		async (failure) => {
			loseSupply = failure;
			const projection = await begin();
			expect(await tick()).toBe(1);
			const [original] = await client`
				select m.supply_state, m.registration_state, m.supply_attempt_id, m.registration_key,
					c.id as prepare_id, c.status, c.delivery_digest
				from platform.connection_manual_installations m
				join platform.connection_installation_commands c using (authorization_id)
				where authorization_id=${projection.authorizationId} and c.command='prepare'`;
			expect(original).toMatchObject({
				supply_state: "unknown",
				registration_state: "pending",
				status: "unknown",
				delivery_digest: null,
			});
			expect(await tick()).toBe(0);
			expect(supplyCalls).toBe(1);
			expect(decryptCalls).toBe(1);
			expect(connection.requests).toEqual([]);

			loseSupply = undefined;
			expect(await status(projection.authorizationId)).toMatchObject({
				status: "unknown",
			});
			expect(await tick()).toBe(1);
			expect(readbacks).toContain("command:supply_status");
			expect(supplyCalls).toBe(1);
			expect(decryptCalls).toBe(1);
			expect(connection.requests).toEqual([]);
			const [checked] = await client`
				select m.supply_state, m.registration_state, m.supply_attempt_id, m.registration_key,
					c.id as prepare_id, c.status
				from platform.connection_manual_installations m
				join platform.connection_installation_commands c using (authorization_id)
				where authorization_id=${projection.authorizationId} and c.command='prepare'`;
			expect(checked).toMatchObject({
				supply_state: failure === "after_host" ? "confirmed" : "unknown",
				registration_state: "pending",
				supply_attempt_id: original?.supply_attempt_id,
				registration_key: original?.registration_key,
				prepare_id: original?.prepare_id,
				status: failure === "after_host" ? "pending" : "unknown",
			});
			expect(await tick()).toBe(failure === "after_host" ? 1 : 0);
			expect(connection.requests.map(({ method }) => method)).toEqual(
				failure === "after_host" ? ["POST"] : [],
			);
			if (failure === "after_host")
				expect(connection.requests[0]?.key).toBe(original?.registration_key);
			expect(supplyCalls).toBe(1);
			expect(decryptCalls).toBe(1);
			await noCredentialStored();
		},
	);

	it("keeps a lost POST unknown and verifies only by GET of the original key", async () => {
		connection.losePost = true;
		const projection = await begin();
		await tick();
		expect(connection.requests.map((request) => request.method)).toEqual([
			"POST",
		]);
		const [lost] =
			await client`select registration_state, registration_key from platform.connection_manual_installations where authorization_id=${projection.authorizationId}`;
		expect(lost?.registration_state).toBe("unknown");
		expect(await status(projection.authorizationId)).toMatchObject({
			status: "unknown",
		});
		connection.losePost = false;
		await tick();
		expect(connection.requests.map((request) => request.method)).toEqual([
			"POST",
			"GET",
		]);
		expect(connection.requests[1]?.path).toBe(
			`/connection/v1/agents/connection-agent-a/oauth-clients/${encodeURIComponent(lost?.registration_key as string)}`,
		);
		const [row] =
			await client`select registration_state from platform.connection_manual_installations where authorization_id=${projection.authorizationId}`;
		expect(row?.registration_state).toBe("registered");
		expect(supplyCalls).toBe(1);
		expect(decryptCalls).toBe(1);
		await noCredentialStored();
	});

	it("never acts for another user's Execution held by another Worker", async () => {
		await begin("bob", "bob");
		expect(await tick(["execution-bob"])).toBe(0);
		expect(connection.requests).toEqual([]);
		const [command] =
			await client`select status from platform.connection_installation_commands`;
		expect(command?.status).toBe("rejected");
	});

	it("rejects the supply when the original claim changes after the template is fixed", async () => {
		const projection = await begin();
		readbackHook = async (request) => {
			if (request.purpose === "supply_delivery")
				await client`update platform.conversation_executions set delivery_fence=4 where execution_id='execution-a'`;
		};
		await tick();
		expect(connection.requests).toEqual([]);
		const [row] =
			await client`select registration_state, supply_state, configuration from platform.connection_manual_installations where authorization_id=${projection.authorizationId}`;
		expect(row).toMatchObject({
			registration_state: "pending",
			configuration: null,
		});
		expect(row?.supply_state).not.toBe("confirmed");
	});

	it("compensates only the originating attempt with DELETE of its original key", async () => {
		// Another installation already pinned a different actual Consumer for this association.
		const other = await begin();
		await client`update platform.connection_manual_installations set consumer_id='consumer-other' where authorization_id=${other.authorizationId}`;
		await client`update platform.connection_installation_commands set status='rejected' where authorization_id=${other.authorizationId}`;
		const projection = await begin();
		await tick();
		const [registered] =
			await client`select registration_key, registration_state, revoke_state from platform.connection_manual_installations where authorization_id=${projection.authorizationId}`;
		expect(registered).toMatchObject({
			registration_state: "closed",
			revoke_state: "pending",
		});
		await tick();
		expect(connection.requests.map((request) => request.method)).toEqual([
			"POST",
			"DELETE",
		]);
		expect(connection.requests[1]?.path).toBe(
			`/connection/v1/agents/connection-agent-a/oauth-clients/${encodeURIComponent(registered?.registration_key as string)}`,
		);
		const [row] =
			await client`select a.status, a.binding, m.revoke_state, m.supply_state from platform.connection_installation_authorizations a join platform.connection_manual_installations m on m.authorization_id=a.id where a.id=${projection.authorizationId}`;
		expect(row).toMatchObject({
			status: "revoked",
			revoke_state: "revoked",
			supply_state: "closed",
		});
		expect(
			((row as { binding: unknown }).binding as { authorizationUrl?: string })
				.authorizationUrl,
		).toBeUndefined();
		// Nothing is retried after the compensation.
		expect(await tick()).toBe(0);
		expect(connection.requests).toHaveLength(2);
		await noCredentialStored();
	});

	it.each(["unbind", "replace"] as const)(
		"commits %s before first supply without rolling back unrelated writes",
		async (operation) => {
			const projection = await begin();
			const otherAgent = `unrelated-${operation}`;
			await seedAgent(otherAgent);
			const otherCredential = `conn_consumer_${randomBytes(24).toString("base64url")}`;
			const save = (
				agentId: string,
				serviceCredential: string,
				expectedRevision: number | null,
			) => ({
				agentId,
				ownerId: "owner",
				connectionAgentId: `connection-${agentId}`,
				credentialFingerprint:
					connectionServiceCredentialFingerprintV1(serviceCredential),
				expectedRevision,
				encrypt: (
					binding: Parameters<
						typeof connectionServiceCredentialSecretInputV1
					>[0],
				) =>
					encryptor.encrypt(
						connectionServiceCredentialSecretInputV1(
							binding,
							serviceCredential,
							new Date().toISOString(),
						),
					),
			});
			const changed = await associations.execute(async (tx) => {
				await tx.saveManual(save(otherAgent, otherCredential, null));
				return operation === "unbind"
					? tx.deleteManual("agent-a", 1)
					: tx.saveManual(save("agent-a", credential, 1));
			});
			expect(changed).toBe(operation === "unbind" ? true : 2);
			const [old] = await client`
				select a.status, m.template, m.registration_state, m.revoke_state
				from platform.connection_installation_authorizations a
				join platform.connection_manual_installations m on m.authorization_id=a.id
				where a.id=${projection.authorizationId}`;
			expect(old).toMatchObject({
				status: "revoked",
				template: null,
				registration_state: "closed",
				revoke_state: "not_required",
			});
			await expect(
				associations.execute((tx) => tx.current("agent-a")),
			).resolves.toEqual(
				operation === "unbind"
					? null
					: { source: "manual", associationRevision: 2 },
			);
			await expect(
				associations.execute((tx) => tx.current(otherAgent)),
			).resolves.toEqual({
				source: "manual",
				associationRevision: 1,
			});
			expect(await tick()).toBe(0);
			expect(connection.requests).toEqual([]);
			expect(decryptCalls).toBe(0);
		},
	);

	it("fences installs on unbind so no begin or link is produced afterwards", async () => {
		const projection = await begin();
		await tick();
		expect(connection.requests).toHaveLength(1);
		expect(
			await associations.execute((transaction) =>
				transaction.deleteManual("agent-a", 1),
			),
		).toBe(true);
		await tick();
		const [row] =
			await client`select a.status, a.binding, m.supply_state, m.revoke_state from platform.connection_installation_authorizations a join platform.connection_manual_installations m on m.authorization_id=a.id where a.id=${projection.authorizationId}`;
		expect(row).toMatchObject({
			status: "revoked",
			supply_state: "closed",
			revoke_state: "unknown",
		});
		expect(
			((row as { binding: unknown }).binding as { authorizationUrl?: string })
				.authorizationUrl,
		).toBeUndefined();
		// No DELETE without the retired credential: the original key stays for the owner.
		expect(connection.requests.map((request) => request.method)).toEqual([
			"POST",
		]);
	});
});
