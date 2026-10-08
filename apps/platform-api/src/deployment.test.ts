import { createHash, generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import {
	AgentApiCreationResponseV1Schema,
	AgentApplicationProjectionV2Schema,
	AgentProjectionV2Schema,
} from "@agent-infra/contracts/pilot";
import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import {
	migratePlatformDatabase,
	PostgresAgentConfigurationQueryV1,
} from "@agent-infra/platform-store";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { setProductionDeploymentInput } from "../../../tests/fixtures/platform-api-production-deployment.js";
import {
	createClient,
	createConfig,
} from "../../web/src/pilot/generated-v2/client/index.js";
import { createAgentApiV1 } from "../../web/src/pilot/generated-v2/sdk.gen.js";
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
	schemaVersion: 2,
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
		// Controlled fixture policy; not a production default.
		taskAdmissionPolicy: {
			maximumWaitingTasksPerAgent: 2,
			waitingTimeoutMs: 60_000,
		},
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
				: path === "/api/v2/agent-applications" || path.endsWith("/decision")
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
	if (running?.server.listening) await createPlatformApiShutdown(running)();
	await reader?.end();
	await database?.stop();
});
// Identity/registry/catalog are controlled deployment inputs. Core, Store, loader and HTTP are real.
describe("production API lifecycle over HTTP and PostgreSQL", () => {
	it("creates, approves and configures an Agent without pretending its Workload is ready", async () => {
		const empty = await snapshot();
		expect(empty.agents).toEqual([]);
		const path = "/api/v2/agent-applications";
		const created = AgentApplicationProjectionV2Schema.parse(
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
		const decisionPath = `/api/v2/admin/agent-applications/${created.applicationId}/decision`;
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
		const approved = AgentApplicationProjectionV2Schema.parse(
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
		const agentPath = `/api/v2/agents/${created.agentId}`;
		const beforeRuntime = AgentProjectionV2Schema.parse(
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
			schemaVersion: 2,
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
				`/api/v2/agents/${created.agentId}/configuration`,
				"alice",
				{ schemaVersion: 2, coOwnerIds: ["bob"] },
				"grant-owner",
			),
			200,
		);
		await json(
			await request(
				configurationPath,
				"bob",
				{
					schemaVersion: 2,
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
				{ schemaVersion: 2, coOwnerIds: [] },
				"revoke-owner",
			),
			200,
		);
		const revoked = await snapshot();
		await json(
			await request(
				configurationPath,
				"bob",
				{ schemaVersion: 2, environment: [] },
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
				"/api/v2/agent-applications",
				"alice",
				applicationBody,
				"concurrent",
			);
			await waiting;
			const bob = AgentApplicationProjectionV2Schema.parse(
				await json(
					await request(
						"/api/v2/agent-applications",
						"bob",
						applicationBody,
						"concurrent",
					),
					201,
				),
			);
			release();
			const a = AgentApplicationProjectionV2Schema.parse(
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
				const response = await fetch(`${origin}/api/v2/agent-applications`, {
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
				"/api/v2/agent-applications",
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
						"/api/v2/agent-applications",
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
		const created = AgentApplicationProjectionV2Schema.parse(
			await json(
				await request(
					"/api/v2/agent-applications",
					"alice",
					applicationBody,
					"stale-projection",
				),
				201,
			),
		);
		await json(
			await request(
				`/api/v2/admin/agent-applications/${created.applicationId}/decision`,
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
			const stale = request(`/api/v2/agents/${created.agentId}`, "alice");
			await waiting;
			await json(
				await request(
					`/api/v2/agents/${created.agentId}/configuration`,
					"alice",
					{
						schemaVersion: 2,
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
	it("binds the production Connection capability to the approved deployment snapshot", () => {
		const profile = {
			schemaVersion: 1,
			publicOrigin: "https://connection.example.test",
			mcpPath: "/mcp",
			consumerId: "platform-web",
			audience: "connection-api",
			egressProfile: { ref: "egress-platform", revision: "r1" },
		};
		const approval = {
			schemaVersion: 1,
			configFingerprint:
				"7821b88d0acd40836eed51877a2e959774434f72cc4672475f7da41c89359331",
			source: { ref: "platform-deployment", revision: "r1" },
			egressEnforced: true,
		};
		const build = (
			connectionConsumerProfile: unknown,
			connectionConsumerProfileApproval: unknown,
		) =>
			createProductionPlatformApiAssemblyInputV1({
				...fixture.input,
				connectionConsumerProfile,
				connectionConsumerProfileApproval,
			}).connectionCapability;
		expect(build(profile, approval)).toEqual({
			status: "available",
			schemaVersion: 1,
			publicOrigin: profile.publicOrigin,
			mcpPath: profile.mcpPath,
			configFingerprint: approval.configFingerprint,
		});
		expect(
			build({ ...profile, consumerId: "another-consumer" }, approval),
		).toMatchObject({ status: "unavailable", reason: "invalid" });
		expect(build(profile, undefined)).toMatchObject({
			status: "unavailable",
			reason: "unapproved",
		});
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
	it.each([
		undefined,
		null,
		{},
		{ maximumWaitingTasksPerAgent: 0, waitingTimeoutMs: 60_000 },
		{ maximumWaitingTasksPerAgent: 2, waitingTimeoutMs: 0 },
		{ maximumWaitingTasksPerAgent: 1.5, waitingTimeoutMs: 60_000 },
		{ maximumWaitingTasksPerAgent: 2, waitingTimeoutMs: 1.5 },
		{
			maximumWaitingTasksPerAgent: Number.MAX_SAFE_INTEGER + 1,
			waitingTimeoutMs: 60_000,
		},
		{
			maximumWaitingTasksPerAgent: 2,
			waitingTimeoutMs: Number.POSITIVE_INFINITY,
		},
		{
			maximumWaitingTasksPerAgent: "private-policy-sentinel",
			waitingTimeoutMs: 60_000,
		},
	])("rejects missing or invalid Task admission policy %#", (policy) => {
		const invalid = {
			...fixture.input,
			taskAdmissionPolicy: policy,
		} as unknown as ProductionPlatformApiInputV1;
		expect(() => createProductionPlatformApiAssemblyInputV1(invalid)).toThrow(
			"PLATFORM_DEPLOYMENT_CONFIGURATION_INVALID",
		);
	});
	it("preserves the explicitly supplied Task admission limits", () => {
		const taskAdmissionPolicy = {
			maximumWaitingTasksPerAgent: 3,
			waitingTimeoutMs: 45_000,
		};
		const input = createProductionPlatformApiAssemblyInputV1({
			...fixture.input,
			taskAdmissionPolicy,
		});
		expect(input.taskAdmissionPolicy).toEqual(taskAdmissionPolicy);
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
		const created = AgentApplicationProjectionV2Schema.parse(
			await json(
				await request(
					"/api/v2/agent-applications",
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
		const revised = AgentApplicationProjectionV2Schema.parse(
			await json(
				await request(
					`/api/v2/agent-applications/${created.applicationId}`,
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
				`/api/v2/agents/${created.agentId}/configuration`,
				"bob",
				{ schemaVersion: 2, environment: [] },
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
				const created = AgentApplicationProjectionV2Schema.parse(
					await json(
						await request(
							"/api/v2/agent-applications",
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
						`/api/v2/admin/agent-applications/${created.applicationId}/decision`,
						"admin",
						{ schemaVersion: 1, decision: "approve" },
						`approve-${mode}`,
					),
					200,
				);
				const detail = AgentProjectionV2Schema.parse(
					await json(
						await request(`/api/v2/agents/${created.agentId}`, "alice"),
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

const apiTokens = {
	application: `papi_${"A".repeat(43)}`,
	user: `papi_${"U".repeat(43)}`,
};
const apiModel = {
	options: [
		{
			optionId: "option-a",
			endpointId: "endpoint-a",
			modelId: "model-a",
			reasoningLevels: ["medium"],
		},
	],
	defaultOptionId: "option-a",
	defaultReasoningLevel: "medium",
};
const apiBody = {
	schemaVersion: 3 as const,
	name: "Production API Agent",
	description: "Controlled production creation",
	source: { kind: "standard" as const, templateId: "codex" },
	coOwnerIds: [],
	availability: [],
	environment: [],
	secrets: [{ name: "BOT_TOKEN", value: "controlled-api-private-secret" }],
	modelConfiguration: apiModel,
	defaultRelayKey: "controlled-api-private-default-key",
};

// These exercise the real production factory, loader, API/Store and Registry adapter.
// Registry transport and standard model providers are controlled test inputs.
describe("production API creation with user and application Tokens", () => {
	const browserResolve = vi.fn<IdentityAdapter["resolve"]>();
	const candidates =
		vi.fn<
			NonNullable<
				NonNullable<
					ProductionPlatformApiInputV1["agentApiCreation"]
				>["candidates"]
			>
		>();
	let currentOwnerStatus: "active" | "disabled";
	beforeEach(async () => {
		if (running.server.listening) await createPlatformApiShutdown(running)();
		await reader.unsafe(
			"truncate platform.agents,platform.platform_applications,platform.platform_api_credentials,platform.platform_user_disables,platform.relay_key_subjects,platform.relay_key_versions,platform.audit_events,platform.outbox_items,platform.idempotency_records cascade",
		);
		fixture = deploymentInput(database.databaseUrl);
		browserResolve
			.mockReset()
			.mockRejectedValue(
				new Error("Browser identity must not be used by API creation"),
			);
		currentOwnerStatus = "active";
		fixture.input = {
			...fixture.input,
			identity: {
				...identity,
				resolve: browserResolve,
				resolveUser: async (userId) => ({
					schemaVersion: 1,
					userId,
					accountStatus: currentOwnerStatus,
					organizationIds: [],
					authorizationRevision: "current-api-user",
				}),
			},
		};
		candidates.mockReset().mockResolvedValue(apiModel.options);
		fixture.input = {
			...fixture.input,
			agentApiCreation: {
				allowedPrincipals: [
					{ kind: "application", id: "alice" },
					{ kind: "user", id: "alice" },
				],
				keylessModelAdmission: {
					admitModels: async ({ requested }) =>
						requested ? { ...requested, catalogRevision: "catalog-a" } : null,
				},
				candidates,
			},
		};
		await reader.unsafe(
			"insert into platform.platform_applications(id,name,responsible_user_id,authorization_revision) values('alice','Robot application','alice','app-revision')",
		);
		for (const [kind, material] of Object.entries(apiTokens))
			await reader.unsafe(
				'insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes) values($1,$2,\'alice\',$3,\'["agent:create","agent:manage","agent:read"]\'::jsonb)',
				[kind, kind, sha256(material)],
			);
		await openApi();
	});
	function create(
		token = apiTokens.application,
		key = "api-create",
		body: unknown = apiBody,
	) {
		return fetch(`${origin}/api/v2/agents`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Idempotency-Key": key,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});
	}
	async function effects() {
		return reader.unsafe(
			"select (select count(*)::int from platform.agents) agents,(select count(*)::int from platform.agent_principal_grants) grants,(select count(*)::int from platform.secret_records) secrets,(select count(*)::int from platform.relay_key_versions) keys,(select count(*)::int from platform.outbox_items) outbox",
		);
	}
	it("creates through the generated Client and encrypts the default Key and ordinary Secret without a browser identity", async () => {
		const client = createClient(
			createConfig({ baseUrl: origin, auth: apiTokens.application }),
		);
		const response = await createAgentApiV1({
			client,
			body: apiBody,
			headers: { "Idempotency-Key": "generated-api" },
		});
		expect(response.response?.status).toBe(201);
		const result = AgentApiCreationResponseV1Schema.parse(response.data);
		expect(result).toMatchObject({ status: "creating", replayed: false });
		expect(await effects()).toEqual([
			{ agents: 1, grants: 2, secrets: 1, keys: 1, outbox: 1 },
		]);
		expect(
			await reader.unsafe(
				"select creator_principal_type,creator_principal_id,applicant_id,creation_channel,approval_revision from platform.agent_applications",
			),
		).toEqual([
			{
				creator_principal_type: "application",
				creator_principal_id: "alice",
				applicant_id: "alice",
				creation_channel: "api",
				approval_revision: null,
			},
		]);
		expect(fixture.authorize.mock.calls[0]?.[0].subjectRef).toBe(
			`api-subject-${sha256(JSON.stringify({ kind: "application", id: "alice" }))}`,
		);
		expect(browserResolve).not.toHaveBeenCalled();
		const records = await reader.unsafe(
			"select record from platform.secret_records",
		);
		expect(validatePlatformSecretRecordV1(records[0]?.record)).toMatchObject({
			agentId: result.agentId,
			ownerId: "alice",
			name: "BOT_TOKEN",
			lifecycleState: "pending",
		});
		for (const rows of [
			await reader.unsafe("select * from platform.secret_records"),
			await reader.unsafe("select * from platform.relay_key_versions"),
			await reader.unsafe("select * from platform.audit_events"),
			response.data,
		]) {
			expect(JSON.stringify(rows)).not.toContain(apiBody.defaultRelayKey);
			expect(JSON.stringify(rows)).not.toContain(apiBody.secrets[0]?.value);
			expect(JSON.stringify(rows)).not.toContain(apiTokens.application);
		}
	});
	it("keeps concurrent user and application Registry subjects separate for the same bare ID", async () => {
		const responses = await Promise.all([create(), create(apiTokens.user)]);
		for (const response of responses) expect(response.status).toBe(201);
		expect(
			fixture.authorize.mock.calls
				.map(([request]) => request.subjectRef)
				.toSorted(),
		).toEqual(
			["user", "application"]
				.map(
					(kind) =>
						`api-subject-${sha256(JSON.stringify({ kind, id: "alice" }))}`,
				)
				.toSorted(),
		);
		expect(browserResolve).not.toHaveBeenCalled();
		expect(await effects()).toEqual([
			{ agents: 2, grants: 4, secrets: 2, keys: 2, outbox: 2 },
		]);
	});
	it("denies creation when no deployment principal is explicitly allowed", async () => {
		await createPlatformApiShutdown(running)();
		fixture.input = { ...fixture.input, agentApiCreation: undefined };
		await openApi();
		expect((await create()).status).toBe(403);
		expect(fixture.authorize).not.toHaveBeenCalled();
		expect(await effects()).toEqual([
			{ agents: 0, grants: 0, secrets: 0, keys: 0, outbox: 0 },
		]);
	});
	it.each(["missing-model", "missing-key", "rejected-key", "failed-key"])(
		"fails closed with %s provider",
		async (failure) => {
			await createPlatformApiShutdown(running)();
			const configured = fixture.input.agentApiCreation;
			if (!configured) throw new Error("Missing controlled configuration");
			fixture.input = {
				...fixture.input,
				agentApiCreation: {
					...configured,
					...(failure === "missing-model"
						? { keylessModelAdmission: undefined }
						: {}),
					...(failure === "missing-key" ? { candidates: undefined } : {}),
				},
			};
			if (failure === "rejected-key") candidates.mockResolvedValue([]);
			if (failure === "failed-key")
				candidates.mockRejectedValue(new Error(apiBody.defaultRelayKey));
			await openApi();
			const response = await create();
			expect(response.status).toBeGreaterThanOrEqual(400);
			expect(await response.text()).not.toContain(apiBody.defaultRelayKey);
			expect(await effects()).toEqual([
				{ agents: 0, grants: 0, secrets: 0, keys: 0, outbox: 0 },
			]);
		},
	);
	it("rechecks current Owner validity after Registry admission and rolls back", async () => {
		fixture.authorize.mockImplementationOnce(async () => {
			currentOwnerStatus = "disabled";
			return {
				status: "admitted",
				decisionRef: "current-api",
				evaluatedAt: "2026-10-08T00:00:00Z",
			};
		});
		expect((await create()).status).toBe(403);
		expect(browserResolve).not.toHaveBeenCalled();
		expect(await effects()).toEqual([
			{ agents: 0, grants: 0, secrets: 0, keys: 0, outbox: 0 },
		]);
	});
	it("supports custom API creation without model or default-Key providers", async () => {
		const response = await create(apiTokens.application, "custom-api", {
			schemaVersion: 2,
			name: apiBody.name,
			description: apiBody.description,
			source: {
				kind: "custom",
				imageReference: `registry.example.test/agents/codex@${fixture.imageDigest}`,
				interactionMode: "platform-adapter",
			},
			coOwnerIds: [],
			availability: [],
			environment: [],
			secrets: apiBody.secrets,
		});
		expect(response.status).toBe(201);
		expect(await effects()).toEqual([
			{ agents: 1, grants: 2, secrets: 1, keys: 0, outbox: 1 },
		]);
		expect(candidates).not.toHaveBeenCalled();
		expect(browserResolve).not.toHaveBeenCalled();
	});
});
