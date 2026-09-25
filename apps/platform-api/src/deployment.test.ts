import { createHash, generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import {
	AgentApplicationProjectionV1Schema,
	AgentProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import {
	migratePlatformDatabase,
	PostgresAgentConfigurationQueryV1,
} from "@agent-infra/platform-store";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../../packages/platform-core/src/agent-configuration.conformance.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { setProductionDeploymentInput } from "../../../tests/fixtures/platform-api-production-deployment.js";
import {
	createProductionPlatformApiAssemblyInputV1,
	type ProductionPlatformApiInputV1,
} from "./deployment.js";
import type { IdentityAdapter, IdentityContext } from "./http/identity.js";
import {
	createPlatformApiShutdown,
	startPlatformApiFromDeployment,
} from "./index.js";

type DatabaseRows = Record<string, unknown>[];
interface DatabaseReader {
	unsafe(query: string, parameters?: readonly unknown[]): Promise<DatabaseRows>;
	end(): Promise<void>;
}

// Inspect the isolated database with the Store's existing driver dependency.
const connectDatabase = createRequire(
	import.meta.resolve("@agent-infra/platform-store"),
)("postgres") as (
	databaseUrl: string,
	options: { max: number },
) => DatabaseReader;

const identities = {
	alice: {
		schemaVersion: 1,
		userId: "alice",
		displayName: "Alice",
		accountStatus: "active",
		organizationIds: ["org-a"],
		roles: ["employee"],
		authorizationRevision: "identity-a",
	},
	bob: {
		schemaVersion: 1,
		userId: "bob",
		displayName: "Bob",
		accountStatus: "active",
		organizationIds: ["org-b"],
		roles: ["employee"],
		authorizationRevision: "identity-b",
	},
	admin: {
		schemaVersion: 1,
		userId: "administrator",
		displayName: "Administrator",
		accountStatus: "active",
		organizationIds: ["org-admin"],
		roles: ["employee", "system_admin"],
		authorizationRevision: "identity-admin",
	},
} as const satisfies Record<string, IdentityContext>;
type User = keyof typeof identities;
const sessions = new Map<string, unknown>([
	["synthetic-session-a", identities.alice],
	["synthetic-session-b", identities.bob],
	["synthetic-session-admin", identities.admin],
]);
const sessionKeys: Record<User, string> = {
	alice: "synthetic-session-a",
	bob: "synthetic-session-b",
	admin: "synthetic-session-admin",
};
const identity: IdentityAdapter = {
	async resolve(request) {
		return sessions.get(request.headers.get("authorization") ?? "") ?? null;
	},
	async hydrateUsers(userIds) {
		return userIds.map((userId) => {
			const user = Object.values(identities).find((u) => u.userId === userId);
			if (!user) throw new Error("Unknown synthetic directory subject");
			return { userId, displayName: user.displayName, roles: [...user.roles] };
		});
	},
};
const plaintext = {
	model: "synthetic-initial-model-credential",
	secret: "synthetic-initial-bot-secret",
	replacementModel: "synthetic-replacement-model-credential",
	replacementSecret: "synthetic-replacement-bot-secret",
};
const modelConfiguration = (credentialValue: string) => ({
	options: [
		{
			optionId: "option-a",
			endpointId: "endpoint-a",
			modelId: "model-a",
			reasoningLevels: ["medium", "high"],
			credentialValue,
		},
	],
	defaultOptionId: "option-a",
	defaultReasoningLevel: "medium",
});
const applicationBody = {
	schemaVersion: 1,
	actions: [],
	name: "Production assembly test",
	description: "Synthetic persistent lifecycle",
	source: { kind: "standard", templateId: "codex" },
	coOwnerIds: [],
	availability: [{ kind: "organization", organizationId: "org-a" }],
	modelConfiguration: modelConfiguration(plaintext.model),
	environment: [{ name: "LANG", value: "en_US.UTF-8" }],
	secrets: [{ name: "BOT_TOKEN", value: plaintext.secret }],
};

const sha256 = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");

function deploymentInput(
	databaseUrl: string,
	mode: "platform-adapter" | "self-managed" = "platform-adapter",
) {
	const config = JSON.stringify({
		os: "linux",
		architecture: "amd64",
		config: {
			Entrypoint: ["node"],
			Cmd: ["host.mjs"],
			WorkingDir: "/workspace",
			User: "10001",
			Env: [],
			Labels: {
				"io.agora.agent.runtime.manifest": JSON.stringify({
					schemaVersion: 1,
					interactionMode: mode,
					...(mode === "platform-adapter" ? { protocol: "acp" } : {}),
					service: { port: 8080 },
					health: { path: "/healthz" },
					capabilities: { modelSelection: true, connection: false },
				}),
			},
		},
	});
	const configDigest = `sha256:${sha256(config)}`;
	const manifestMediaType = "application/vnd.oci.image.manifest.v1+json";
	const configMediaType = "application/vnd.oci.image.config.v1+json";
	const manifest = JSON.stringify({
		schemaVersion: 2,
		mediaType: manifestMediaType,
		config: {
			mediaType: configMediaType,
			digest: configDigest,
			size: Buffer.byteLength(config),
		},
		layers: [],
	});
	const imageDigest = `sha256:${sha256(manifest)}`;
	const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
		const url = new URL(
			request instanceof Request ? request.url : request.toString(),
		);
		const path = decodeURIComponent(url.pathname);
		if (path === `/v2/codex/manifests/${imageDigest}`)
			return new Response(manifest, {
				headers: {
					"content-type": manifestMediaType,
					"docker-content-digest": imageDigest,
				},
			});
		if (path === `/v2/codex/blobs/${configDigest}`)
			return new Response(config, {
				headers: { "content-type": configMediaType },
			});
		return new Response(null, { status: 404 });
	});
	const authorize = vi.fn<
		ProductionPlatformApiInputV1["registry"]["policy"]["authorize"]
	>(async () => ({
		status: "admitted",
		decisionRef: "decision-a",
		evaluatedAt: "2026-09-14T00:00:00Z",
	}));
	const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
	const der = publicKey.export({ format: "der", type: "spki" });
	const input: ProductionPlatformApiInputV1 = {
		databaseUrl,
		imageRepository: "registry.example.test/agents/codex",
		identity,
		loadAuthorityContext: async () => ({
			schemaVersion: 1,
			users: Object.values(identities).map(({ userId, accountStatus }) => ({
				userId,
				accountStatus,
			})),
			organizationIds: ["org-a", "org-b", "org-admin"],
		}),
		registry: {
			endpoint: "https://registry.example.test",
			imageReferencePrefix: "registry.example.test/agents",
			admissionPolicyRef: "policy-a",
			fetch,
			policy: { authorize },
		},
		templates: [
			{
				templateId: "codex",
				imageDigest,
				imageReference: `registry.example.test/agents/codex@${imageDigest}`,
				allowedEnvironmentKeys: ["LANG"],
				allowedSecretKeys: ["BOT_TOKEN"],
				platformManagedKeys: ["PORT"],
				connectionEnabled: false,
			},
		],
		modelCatalog: {
			revision: "catalog-a",
			load: async () => ({
				schemaVersion: 1,
				revision: "catalog-a",
				validUntil: Date.now() + 60_000,
				endpoints: [
					{
						endpointId: "endpoint-a",
						baseUrl: "https://models.example.test/v1",
						origin: "https://models.example.test",
						protocol: "openai-responses-v1",
						security: { tls: "verify-peer", redirects: "reject" },
						capabilities: {
							streaming: true,
							tools: true,
							reasoningLevels: ["medium", "high"],
						},
						allowedModels: ["model-a"],
						available: true,
					},
				],
			}),
		},
		channelPolicy: { revision: "channels-a", bindings: [] },
		encryptionKeys: {
			schemaVersion: 1,
			activeWrappingKeyVersion: "key_01",
			keys: [
				{
					schemaVersion: 1,
					keyVersion: "key_01",
					wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
					publicKeySpkiDerBase64: der.toString("base64"),
					publicKeyFingerprint: sha256(der),
					rsaModulusBits: 3072,
					status: "active",
				},
			],
		},
		resourceProfile: {
			profileId: "standard-medium",
			displayName: "Standard medium",
			estimatedResources: {
				cpuMillicores: 2000,
				memoryMiB: 4096,
				storageGiB: 20,
			},
		},
	};
	return { input, fetch, authorize, imageDigest };
}

let database: PostgresTestDatabase;
let reader: DatabaseReader;
let fixture: ReturnType<typeof deploymentInput>;
let running: Awaited<ReturnType<typeof startPlatformApiFromDeployment>>;
let origin: string;
async function openApi() {
	setProductionDeploymentInput(fixture.input);
	running = await startPlatformApiFromDeployment({
		moduleSpecifier: new URL(
			"../../../tests/fixtures/platform-api-production-deployment.ts",
			import.meta.url,
		).href,
		port: 0,
		log: () => {},
	});
	origin = `http://127.0.0.1:${(running.server.address() as AddressInfo).port}`;
}
function request(path: string, user: User, body?: unknown, key?: string) {
	return fetch(`${origin}${path}`, {
		method:
			body === undefined
				? "GET"
				: path === "/api/v1/agent-applications" || path.endsWith("/decision")
					? "POST"
					: "PUT",
		headers: {
			authorization: sessionKeys[user],
			"content-type": "application/json",
			...(key ? { "Idempotency-Key": key } : {}),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}
async function snapshot() {
	const result: Record<string, DatabaseRows> = {};
	for (const name of [
		"agents",
		"agent_applications",
		"agent_configuration_revisions",
		"secret_records",
		"outbox_items",
		"audit_events",
		"idempotency_records",
	])
		result[name] = await reader.unsafe(
			`select * from platform.${name} as row order by to_jsonb(row)::text`,
		);
	return result;
}
function expectNoPlaintext(value: unknown) {
	for (const sentinel of Object.values(plaintext))
		expect(JSON.stringify(value)).not.toContain(sentinel);
}
async function json(response: Response, status: number) {
	const body = await response.json();
	expectNoPlaintext(body);
	expect(response.status, JSON.stringify(body)).toBe(status);
	return body;
}
beforeAll(async () => {
	database = await startPostgresTestDatabase("production-api-assembly");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	reader = connectDatabase(database.databaseUrl, { max: 1 });
	fixture = deploymentInput(database.databaseUrl);
	await openApi();
}, 60_000);
afterAll(async () => {
	if (running) await createPlatformApiShutdown(running)();
	await reader?.end();
	await database?.stop();
});
// Identity/registry/catalog are controlled deployment inputs. Core, Store, loader and HTTP are real.
describe("production API lifecycle over HTTP and PostgreSQL", () => {
	it("creates, approves and configures an Agent without pretending its Workload is ready", async () => {
		const empty = await snapshot();
		expect(empty.agents).toEqual([]);
		const path = "/api/v1/agent-applications";
		const created = AgentApplicationProjectionV1Schema.parse(
			await json(
				await request(path, "alice", applicationBody, "create-a"),
				201,
			),
		);
		expect(created).toMatchObject({
			status: "pending_approval",
			configuration: {
				owners: [{ userId: "alice" }],
				defaultModelOptionId: "option-a",
				secrets: [{ name: "BOT_TOKEN", isSet: true, version: 1 }],
			},
		});
		const submitted = await snapshot();
		expect(submitted.secret_records).toHaveLength(2);
		expectNoPlaintext(submitted);
		for (const row of submitted.secret_records ?? [])
			expect(validatePlatformSecretRecordV1(row.record)).toMatchObject({
				agentId: created.agentId,
				lifecycleState: "pending",
			});
		expect(
			await json(
				await request(path, "alice", applicationBody, "create-a"),
				201,
			),
		).toEqual(created);
		expect(await snapshot()).toEqual(submitted);
		const applicationPath = `${path}/${created.applicationId}`;
		await json(await request(applicationPath, "bob"), 404);
		const decisionPath = `/api/v1/admin/agent-applications/${created.applicationId}/decision`;
		await json(
			await request(
				decisionPath,
				"bob",
				{ schemaVersion: 1, decision: "approve" },
				"approve-denied",
			),
			403,
		);
		expect(await snapshot()).toEqual(submitted);
		const approved = AgentApplicationProjectionV1Schema.parse(
			await json(
				await request(
					decisionPath,
					"admin",
					{ schemaVersion: 1, decision: "approve" },
					"approve-a",
				),
				200,
			),
		);
		expect(approved.status).toBe("creating");
		const agentPath = `/api/v1/agents/${created.agentId}`;
		const beforeRuntime = AgentProjectionV1Schema.parse(
			await json(await request(agentPath, "alice"), 200),
		);
		expect(beforeRuntime).toMatchObject({
			managementStatus: "creating",
			interactionUrl: null,
			capabilities: {
				modelSelection: false,
				attachments: false,
				resultFiles: false,
				connection: false,
				supplementaryInstruction: false,
			},
		});
		const update = {
			schemaVersion: 1,
			environment: [{ name: "LANG", value: "zh_CN.UTF-8" }],
			modelConfiguration: modelConfiguration(plaintext.replacementModel),
			secrets: [{ name: "BOT_TOKEN", value: plaintext.replacementSecret }],
		};
		const configurationPath = `${agentPath}/configuration`;
		await json(
			await request(configurationPath, "bob", update, "update-denied"),
			404,
		);
		await json(
			await request(configurationPath, "admin", update, "update-admin-denied"),
			404,
		);
		const updated = await json(
			await request(configurationPath, "alice", update, "update-a"),
			200,
		);
		expect(updated).toMatchObject({
			configuration: {
				environment: update.environment,
				secrets: [{ name: "BOT_TOKEN", isSet: true, version: 2 }],
			},
		});
		const configured = await snapshot();
		expect(configured.agent_configuration_revisions).toHaveLength(2);
		expect(configured.secret_records).toHaveLength(4);
		expectNoPlaintext(configured);
		expect(
			await json(
				await request(configurationPath, "alice", update, "update-a"),
				200,
			),
		).toEqual(updated);
		expect(await snapshot()).toEqual(configured);
		await createPlatformApiShutdown(running)();
		await openApi();
		expect(
			await json(
				await request(configurationPath, "alice", update, "update-a"),
				200,
			),
		).toEqual(updated);
		expect(await snapshot()).toEqual(configured);
		await json(
			await request(
				`/api/v1/agents/${created.agentId}/configuration`,
				"alice",
				{ schemaVersion: 1, coOwnerIds: ["bob"] },
				"grant-owner",
			),
			200,
		);
		await json(
			await request(
				configurationPath,
				"bob",
				{
					schemaVersion: 1,
					environment: [{ name: "LANG", value: "en_GB.UTF-8" }],
				},
				"coowner-change",
			),
			200,
		);
		await json(
			await request(
				configurationPath,
				"alice",
				{ schemaVersion: 1, coOwnerIds: [] },
				"revoke-owner",
			),
			200,
		);
		const revoked = await snapshot();
		await json(
			await request(
				configurationPath,
				"bob",
				{ schemaVersion: 1, environment: [] },
				"revoked-change",
			),
			404,
		);
		expect(await snapshot()).toEqual(revoked);
	});
	it("isolates two concurrent subjects while their real admissions await registry IO", async () => {
		let entered!: () => void;
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const resume = new Promise<void>((resolve) => {
			release = resolve;
		});
		const original = fixture.authorize.getMockImplementation();
		fixture.authorize.mockImplementation(async (input) => {
			if (input.subjectRef === "alice") {
				entered();
				await resume;
			}
			return {
				status: "admitted",
				decisionRef: "concurrent",
				evaluatedAt: "2026-09-14T00:00:00Z",
			};
		});
		try {
			const alice = request(
				"/api/v1/agent-applications",
				"alice",
				applicationBody,
				"concurrent",
			);
			await waiting;
			const bob = AgentApplicationProjectionV1Schema.parse(
				await json(
					await request(
						"/api/v1/agent-applications",
						"bob",
						applicationBody,
						"concurrent",
					),
					201,
				),
			);
			release();
			const a = AgentApplicationProjectionV1Schema.parse(
				await json(await alice, 201),
			);
			expect(a.agentId).not.toBe(bob.agentId);
			expect(a.configuration.owners.map(({ userId }) => userId)).toEqual([
				"alice",
			]);
			expect(bob.configuration.owners.map(({ userId }) => userId)).toEqual([
				"bob",
			]);
			const rows = await reader.unsafe(
				"select agent_id,owner_id from platform.secret_records where agent_id in ($1,$2)",
				[a.agentId, bob.agentId],
			);
			expect(rows).toHaveLength(4);
			for (const row of rows)
				expect(row.owner_id).toBe(row.agent_id === a.agentId ? "alice" : "bob");
		} finally {
			release();
			if (original) fixture.authorize.mockImplementation(original);
		}
	});
	it.each(["anonymous", "forged", "disabled", "directory_failure"] as const)(
		"rejects %s before writing application data",
		async (mode) => {
			const before = await snapshot();
			const original = identity.resolve;
			try {
				if (mode === "disabled")
					sessions.set(sessionKeys.alice, {
						...identities.alice,
						accountStatus: "disabled",
					});
				if (mode === "directory_failure")
					identity.resolve = async () => {
						throw new Error("private directory sentinel");
					};
				const response = await fetch(`${origin}/api/v1/agent-applications`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"Idempotency-Key": `rejected-${mode}`,
						...(mode === "anonymous" || mode === "forged"
							? {}
							: { authorization: sessionKeys.alice }),
						"X-User-Id": "administrator",
						"X-Role": "system_admin",
					},
					body: JSON.stringify(applicationBody),
				});
				const body = await json(
					response,
					mode === "directory_failure" ? 503 : mode === "disabled" ? 403 : 401,
				);
				expect(JSON.stringify(body)).not.toContain(
					"private directory sentinel",
				);
				expect(await snapshot()).toEqual(before);
			} finally {
				sessions.set(sessionKeys.alice, identities.alice);
				identity.resolve = original;
			}
		},
	);
	it("rejects revocation after route authentication but before admission", async () => {
		const before = await snapshot();
		const original = identity.resolve;
		let reads = 0;
		identity.resolve = async (request) =>
			++reads === 1
				? original(request)
				: { ...identities.alice, accountStatus: "disabled" };
		try {
			const response = await request(
				"/api/v1/agent-applications",
				"alice",
				applicationBody,
				"mid-admission-revoked",
			);
			await json(response, 503);
			expect(reads).toBeGreaterThan(1);
			expect(await snapshot()).toEqual(before);
		} finally {
			identity.resolve = original;
		}
	});
	it.each(["secret_records", "outbox_items"] as const)(
		"rolls application and Secret effects back when %s persistence fails",
		async (table) => {
			const before = await snapshot();
			await reader.unsafe(
				"create function platform.reject_production_test_write() returns trigger as $$ begin raise exception 'controlled persistence failure'; end; $$ language plpgsql",
			);
			await reader.unsafe(
				`create trigger reject_production_test_write before insert on platform.${table} for each row execute function platform.reject_production_test_write()`,
			);
			try {
				await json(
					await request(
						"/api/v1/agent-applications",
						"alice",
						applicationBody,
						`rollback-${table}`,
					),
					503,
				);
				expect(await snapshot()).toEqual(before);
			} finally {
				await reader.unsafe(
					`drop trigger reject_production_test_write on platform.${table}`,
				);
				await reader.unsafe(
					"drop function platform.reject_production_test_write()",
				);
			}
		},
	);
	it("does not combine a stale configuration with newer runtime presentation facts", async () => {
		const created = AgentApplicationProjectionV1Schema.parse(
			await json(
				await request(
					"/api/v1/agent-applications",
					"alice",
					applicationBody,
					"stale-projection",
				),
				201,
			),
		);
		await json(
			await request(
				`/api/v1/admin/agent-applications/${created.applicationId}/decision`,
				"admin",
				{ schemaVersion: 1, decision: "approve" },
				"approve-stale",
			),
			200,
		);
		let entered!: () => void;
		let release!: () => void;
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const resume = new Promise<void>((resolve) => {
			release = resolve;
		});
		const read =
			PostgresAgentConfigurationQueryV1.prototype.readRuntimePresentation;
		let first = true;
		const spy = vi
			.spyOn(
				PostgresAgentConfigurationQueryV1.prototype,
				"readRuntimePresentation",
			)
			.mockImplementation(async function (
				this: PostgresAgentConfigurationQueryV1,
				input,
			) {
				expect(input.accountStatus).toBe("active");
				if (first) {
					first = false;
					entered();
					await resume;
				}
				return read.call(this, input);
			});
		try {
			const stale = request(`/api/v1/agents/${created.agentId}`, "alice");
			await waiting;
			await json(
				await request(
					`/api/v1/agents/${created.agentId}/configuration`,
					"alice",
					{
						schemaVersion: 1,
						environment: [{ name: "LANG", value: "en_GB.UTF-8" }],
					},
					"changed-projection",
				),
				200,
			);
			release();
			await json(await stale, 503);
		} finally {
			release();
			spy.mockRestore();
		}
	});
	it("fails closed without a request scope and closes its owned query once", async () => {
		const input = createProductionPlatformApiAssemblyInputV1(fixture.input);
		const read = vi.fn();
		if (typeof input.admissions !== "function")
			throw new Error("Expected production admissions");
		const admissions = input.admissions({
			configurationQuery: {
				readAuthority: read,
			} as unknown as PostgresAgentConfigurationQueryV1,
		});
		await expect(
			admissions.authorizationAdmission.authorize({
				schemaVersion: 1,
				actorId: "alice",
				agentId: "other-agent",
				requestId: "request",
				traceId: "trace",
			}),
		).rejects.toThrow("scope");
		expect(read).not.toHaveBeenCalled();
		const close = vi.spyOn(
			PostgresAgentConfigurationQueryV1.prototype,
			"close",
		);
		await createPlatformApiShutdown(running)();
		expect(close).toHaveBeenCalledTimes(1);
		close.mockRestore();
		await openApi();
	});
	it("admits two current users' Conversation tasks and rejects revoked access in production assembly", async () => {
		const agentId = "agent_production_task";
		const configuration = {
			...agentConfigurationConformanceRecordV1,
			agentId,
		};
		const currentUsers = new Map<string, unknown>([
			[
				"alice",
				{
					schemaVersion: 1,
					userId: "alice",
					accountStatus: "active",
					organizationIds: ["org-a"],
					authorizationRevision: "directory-a",
				},
			],
			[
				"bob",
				{
					schemaVersion: 1,
					userId: "bob",
					accountStatus: "active",
					organizationIds: ["org-b"],
					authorizationRevision: "directory-b",
				},
			],
		]);
		const previousResolveUser = identity.resolveUser;
		identity.resolveUser = async (userId) => currentUsers.get(userId) ?? null;
		const post = (path: string, user: User, body: unknown, key: string) =>
			fetch(`${origin}/api/v1${path}`, {
				method: "POST",
				headers: {
					authorization: sessionKeys[user],
					"content-type": "application/json",
					"Idempotency-Key": key,
				},
				body: JSON.stringify(body),
			});
		const taskSnapshot = async () => {
			const result = await snapshot();
			for (const name of [
				"conversations",
				"conversation_messages",
				"conversation_executions",
				"conversation_audit_events",
				"conversation_events",
				"task_authorization_records",
				"task_control_records",
			])
				result[name] = await reader.unsafe(
					`select * from platform.${name} as row order by to_jsonb(row)::text`,
				);
			return result;
		};
		try {
			// Only the already-ready Agent prerequisite is seeded; task admission uses the production HTTP/Store assembly.
			await reader.unsafe(
				"insert into platform.agents(id,current_configuration_revision,authorization_revision) values($1,7,'agent-authorization')",
				[agentId],
			);
			await reader.unsafe(
				"insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence) values('production-task-application',$1,'administrator','Agent','Controlled production task prerequisite','available','trace-seed','request-seed',now(),11,1,'ready','running',1,1)",
				[agentId],
			);
			await reader.unsafe(
				"insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,created_at,configuration) values($1,7,'template_01',now(),$2::text::jsonb)",
				[agentId, JSON.stringify(configuration)],
			);
			await reader.unsafe(
				"insert into platform.agent_owners(agent_id,owner_id,created_at) values($1,'administrator',now())",
				[agentId],
			);
			await reader.unsafe(
				"insert into platform.agent_availability(agent_id,target_type,target_id) values($1,'organization','org-a'),($1,'organization','org-b')",
				[agentId],
			);
			const accepted: {
				user: "alice" | "bob";
				conversationId: string;
				executionId: string;
			}[] = [];
			for (const user of ["alice", "bob"] as const) {
				const conversation = (await json(
					await post(
						`/agents/${agentId}/conversations`,
						user,
						{ schemaVersion: 1 },
						`create-${user}`,
					),
					201,
				)) as { conversationId: string };
				const task = (await json(
					await post(
						`/conversations/${conversation.conversationId}/messages`,
						user,
						{ schemaVersion: 1, text: `controlled ${user} task` },
						`message-${user}`,
					),
					202,
				)) as { executionId: string };
				accepted.push({
					user,
					conversationId: conversation.conversationId,
					executionId: task.executionId,
				});
			}
			const records = await reader.unsafe(
				"select execution_id,boundary from platform.task_authorization_records where execution_id in ($1,$2) order by execution_id",
				accepted.map(({ executionId }) => executionId),
			);
			expect(records).toHaveLength(2);
			for (const { user, executionId } of accepted)
				expect(records).toContainEqual({
					execution_id: executionId,
					boundary: {
						schemaVersion: 1,
						principal: { kind: "user", id: user },
						agentId,
						channelId: "web",
						identityRevision: `directory-${user === "alice" ? "a" : "b"}`,
						agentAuthorizationRevision: "agent-authorization",
						accessSources: [
							{
								kind: "organization",
								organizationId: user === "alice" ? "org-a" : "org-b",
							},
						],
					},
				});
			const audits = await reader.unsafe(
				"select actor_id,target_id,details from platform.audit_events where action='task.authorization.accepted' and target_id in ($1,$2)",
				accepted.map(({ executionId }) => executionId),
			);
			expect(audits).toHaveLength(2);
			for (const { user, executionId } of accepted)
				expect(audits).toContainEqual({
					actor_id: user,
					target_id: executionId,
					details: expect.objectContaining({
						identityRevision: `directory-${user === "alice" ? "a" : "b"}`,
						agentAuthorizationRevision: "agent-authorization",
					}),
				});
			const beforeRevocation = await taskSnapshot();
			for (const [user, conversationId] of [
				["alice", accepted[1]?.conversationId],
				["bob", accepted[0]?.conversationId],
			] as const) {
				await json(
					await post(
						`/conversations/${conversationId}/messages`,
						user,
						{ schemaVersion: 1, text: "cross-user task" },
						`cross-user-${user}`,
					),
					404,
				);
				expect(await taskSnapshot()).toEqual(beforeRevocation);
			}
			identity.resolveUser = async () => {
				throw new Error("Synthetic current-directory outage");
			};
			await json(
				await post(
					`/conversations/${accepted[0]?.conversationId}/messages`,
					"alice",
					{ schemaVersion: 1, text: "directory unavailable" },
					"directory-outage",
				),
				503,
			);
			expect(await taskSnapshot()).toEqual(beforeRevocation);
			identity.resolveUser = async (userId) => currentUsers.get(userId) ?? null;
			currentUsers.set("bob", {
				schemaVersion: 1,
				userId: "bob",
				accountStatus: "active",
				organizationIds: [],
				authorizationRevision: "directory-b-revoked",
			});
			await json(
				await post(
					`/conversations/${accepted[1]?.conversationId}/messages`,
					"bob",
					{ schemaVersion: 1, text: "revoked bob task" },
					"bob-revoked",
				),
				404,
			);
			expect(await taskSnapshot()).toEqual(beforeRevocation);
			currentUsers.set("bob", {
				schemaVersion: 1,
				userId: "bob",
				accountStatus: "disabled",
				organizationIds: ["org-b"],
				authorizationRevision: "directory-b-disabled",
			});
			await json(
				await post(
					`/conversations/${accepted[1]?.conversationId}/messages`,
					"bob",
					{ schemaVersion: 1, text: "disabled bob task" },
					"bob-disabled",
				),
				403,
			);
			expect(await taskSnapshot()).toEqual(beforeRevocation);
			await json(
				await request(
					`/api/v1/agents/${agentId}/configuration`,
					"admin",
					{
						schemaVersion: 1,
						availability: [{ kind: "organization", organizationId: "org-b" }],
					},
					"revoke-alice-access",
				),
				200,
			);
			expect(
				await reader.unsafe(
					"select target_id from platform.agent_availability where agent_id=$1",
					[agentId],
				),
			).toEqual([{ target_id: "org-b" }]);
			const afterAvailabilityRevocation = await taskSnapshot();
			await json(
				await post(
					`/conversations/${accepted[0]?.conversationId}/messages`,
					"alice",
					{ schemaVersion: 1, text: "revoked alice task" },
					"alice-revoked",
				),
				404,
			);
			const afterDenied = await taskSnapshot();
			expect(afterDenied).toEqual(afterAvailabilityRevocation);
			expect(JSON.stringify(afterDenied)).not.toMatch(/synthetic-session-[ab]/);
		} finally {
			identity.resolveUser = previousResolveUser;
		}
	});
	it.each([
		"databaseUrl",
		"imageRepository",
		"identity",
		"loadAuthorityContext",
		"resourceProfile",
		"encryptionKeys",
		"registry",
		"modelCatalog",
	] as const)(
		"rejects invalid deployment %s without disclosing its value",
		(key) => {
			const invalid = {
				...fixture.input,
				[key]: "private invalid input sentinel",
			} as unknown as ProductionPlatformApiInputV1;
			expect(() =>
				createProductionPlatformApiAssemblyInputV1(invalid),
			).toThrow();
			try {
				createProductionPlatformApiAssemblyInputV1(invalid);
			} catch (error) {
				expect(String(error)).not.toContain("private invalid input sentinel");
			}
		},
	);
	it("revises the original pending application and encrypts replacement credentials", async () => {
		const before = await snapshot();
		const created = AgentApplicationProjectionV1Schema.parse(
			await json(
				await request(
					"/api/v1/agent-applications",
					"alice",
					applicationBody,
					"revise-application",
				),
				201,
			),
		);
		const changed = {
			...applicationBody,
			name: "Revised application",
			modelConfiguration: modelConfiguration(plaintext.replacementModel),
			secrets: [{ name: "BOT_TOKEN", value: plaintext.replacementSecret }],
		};
		const revised = AgentApplicationProjectionV1Schema.parse(
			await json(
				await request(
					`/api/v1/agent-applications/${created.applicationId}`,
					"alice",
					changed,
					"revise-pending",
				),
				200,
			),
		);
		expect(revised).toMatchObject({
			applicationId: created.applicationId,
			agentId: created.agentId,
			status: "pending_approval",
			name: changed.name,
			configuration: { secrets: [{ name: "BOT_TOKEN", version: 2 }] },
		});
		const after = await snapshot();
		expect(after.agents?.length).toBe((before.agents?.length ?? 0) + 1);
		expect(after.secret_records?.length).toBe(
			(before.secret_records?.length ?? 0) + 4,
		);
		expectNoPlaintext(after);
		await json(
			await request(
				`/api/v1/agents/${created.agentId}/configuration`,
				"bob",
				{ schemaVersion: 1, environment: [] },
				"foreign-agent",
			),
			404,
		);
		expect(await snapshot()).toEqual(after);
	});
	it.each(["platform-adapter", "self-managed"] as const)(
		"preserves custom %s source without publishing unverified runtime capabilities",
		async (mode) => {
			const previous = fixture;
			await createPlatformApiShutdown(running)();
			fixture = deploymentInput(database.databaseUrl, mode);
			await openApi();
			try {
				const imageReference = `registry.example.test/agents/codex@${fixture.imageDigest}`;
				const created = AgentApplicationProjectionV1Schema.parse(
					await json(
						await request(
							"/api/v1/agent-applications",
							"alice",
							{
								...applicationBody,
								modelConfiguration: undefined,
								secrets: [],
								source: {
									kind: "custom",
									imageReference,
									interactionMode: mode,
									...(mode === "self-managed"
										? { identityResponsibility: "self-managed" }
										: {}),
								},
							},
							`custom-${mode}`,
						),
						201,
					),
				);
				expect(created.source).toMatchObject({
					kind: "custom",
					imageReference,
					interactionMode: mode,
				});
				await json(
					await request(
						`/api/v1/admin/agent-applications/${created.applicationId}/decision`,
						"admin",
						{ schemaVersion: 1, decision: "approve" },
						`approve-${mode}`,
					),
					200,
				);
				const detail = AgentProjectionV1Schema.parse(
					await json(
						await request(`/api/v1/agents/${created.agentId}`, "alice"),
						200,
					),
				);
				expect(detail).toMatchObject({
					interactionUrl: null,
					capabilities: {
						modelSelection: false,
						attachments: false,
						resultFiles: false,
						connection: false,
						supplementaryInstruction: false,
					},
				});
			} finally {
				await createPlatformApiShutdown(running)();
				fixture = previous;
				await openApi();
			}
		},
	);
});
