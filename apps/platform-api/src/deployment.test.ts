import { createHash, generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";

import {
	AgentApplicationProjectionV2Schema,
	AgentProjectionV2Schema,
} from "@agent-infra/contracts/pilot";
import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import {
	migratePlatformDatabase,
	PostgresAgentConfigurationQueryV1,
} from "@agent-infra/platform-store";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { createPlatformApp } from "./app.js";
import { assemblePlatformApi } from "./assembly.js";
import {
	createProductionPlatformApiAssemblyInputV1,
	type ProductionPlatformApiInputV1,
} from "./deployment.js";
import type { IdentityAdapter, IdentityContext } from "./http/identity.js";

type DatabaseRows = Record<string, unknown>[];
interface DatabaseReader {
	unsafe(query: string): Promise<DatabaseRows>;
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
const sessions = new Map<string, IdentityContext>([
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
	async resolveUser(userId) {
		const user = Object.values(identities).find((u) => u.userId === userId);
		return user
			? {
					schemaVersion: 1,
					userId: user.userId,
					accountStatus: user.accountStatus,
					organizationIds: [...user.organizationIds],
					authorizationRevision: user.authorizationRevision,
				}
			: null;
	},
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

function deploymentInput(databaseUrl: string) {
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
					interactionMode: "platform-adapter",
					protocol: "acp",
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

let database: PostgresTestDatabase | undefined;
let reader: DatabaseReader;
let fixture: ReturnType<typeof deploymentInput>;
let assembly: ReturnType<typeof assemblePlatformApi> | undefined;
let app: ReturnType<typeof createPlatformApp>;

function openApi() {
	const input = createProductionPlatformApiAssemblyInputV1(fixture.input);
	expect(input.wecomCredentialEncryptionKeys).toBe(
		fixture.input.encryptionKeys,
	);
	assembly = assemblePlatformApi(input);
	expect(assembly.dependencies.wecomSetup).toBeDefined();
	app = createPlatformApp(assembly.dependencies);
}

function request(path: string, user: User, body?: unknown, key?: string) {
	return app.request(path, {
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

async function readDatabase() {
	const tables = await reader.unsafe(
		"select tablename from pg_catalog.pg_tables where schemaname = 'platform' order by tablename",
	);
	const snapshot: Record<string, DatabaseRows> = {};
	for (const { tablename } of tables) {
		if (typeof tablename !== "string" || !/^[a-z_]+$/.test(tablename))
			throw new Error("Unexpected test schema table");
		snapshot[tablename] = await reader.unsafe(
			`select * from platform."${tablename}" as row order by to_jsonb(row)::text`,
		);
	}
	return snapshot;
}

function expectNoPlaintext(value: unknown) {
	for (const sentinel of Object.values(plaintext))
		expect(JSON.stringify(value)).not.toContain(sentinel);
}

async function json(response: Response, status: number) {
	const body: unknown = await response.json();
	expectNoPlaintext(body);
	expect(response.status, JSON.stringify(body)).toBe(status);
	return body;
}

beforeAll(async () => {
	database = await startPostgresTestDatabase("production-api-assembly");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	reader = connectDatabase(database.databaseUrl, { max: 1 });
	fixture = deploymentInput(database.databaseUrl);
	openApi();
}, 120_000);

afterAll(async () => {
	await assembly?.close();
	await reader?.end();
	await database?.stop();
});

describe("production Platform API assembly with PostgreSQL", () => {
	it("persists the admitted application, current Owner changes and encrypted Secrets across API reopening", async () => {
		const empty = await readDatabase();
		const path = "/api/v2/agent-applications";
		await json(
			await app.request(path, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"Idempotency-Key": "create-forged",
					"x-user-id": "alice",
					"x-role": "system_admin",
				},
				body: JSON.stringify(applicationBody),
			}),
			401,
		);
		expect(await readDatabase()).toEqual(empty);
		expect(fixture.fetch).not.toHaveBeenCalled();

		const created = AgentApplicationProjectionV2Schema.parse(
			await json(
				await request(path, "alice", applicationBody, "create-a"),
				201,
			),
		);
		expect(created).toMatchObject({
			status: "pending_approval",
			source: { kind: "standard", templateId: "codex" },
			configuration: {
				owners: [{ userId: "alice" }],
				defaultModelOptionId: "option-a",
				secrets: [{ name: "BOT_TOKEN", isSet: true, version: 1 }],
			},
		});
		expect(created.configuration).not.toHaveProperty("actions");
		expect(fixture.fetch).toHaveBeenCalledTimes(2);
		expect(fixture.authorize).toHaveBeenCalledWith(
			expect.objectContaining({
				subjectRef: "alice",
				immutableDigest: fixture.imageDigest,
				usage: "standard-template",
			}),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		const submitted = await readDatabase();
		expect(submitted.agents).toHaveLength(1);
		expect(submitted.agent_applications).toHaveLength(1);
		expect(submitted.agent_configuration_revisions).toHaveLength(1);
		expect(submitted.secret_records).toHaveLength(2);
		expectNoPlaintext(submitted);
		for (const row of submitted.secret_records ?? []) {
			const record = validatePlatformSecretRecordV1(row.record);
			expect(record).toMatchObject({
				ownerId: "alice",
				configRevision: 1,
				lifecycleState: "pending",
			});
		}
		for (const retry of await Promise.all([
			request(path, "alice", applicationBody, "create-a"),
			request(path, "alice", applicationBody, "create-a"),
		]))
			expect(await json(retry, 201)).toEqual(created);
		expect(await readDatabase()).toEqual(submitted);
		await json(
			await request(
				path,
				"alice",
				{ ...applicationBody, name: "Conflicting request" },
				"create-a",
			),
			409,
		);
		expect(await readDatabase()).toEqual(submitted);

		const applicationPath = `${path}/${created.applicationId}`;
		const decisionPath = `/api/v2/admin/agent-applications/${created.applicationId}/decision`;
		const approve = { schemaVersion: 1, decision: "approve" };
		await json(await request(applicationPath, "bob"), 404);
		await json(
			await request(decisionPath, "bob", approve, "approve-denied"),
			403,
		);
		const approved = AgentApplicationProjectionV2Schema.parse(
			await json(
				await request(decisionPath, "admin", approve, "approve-a"),
				200,
			),
		);
		expect(approved.status).toBe("creating");
		expect(approved.agentId).toEqual(expect.any(String));
		const agentPath = `/api/v2/agents/${approved.agentId}`;
		const configurationPath = `${agentPath}/configuration`;
		const beforeRuntime = AgentProjectionV2Schema.parse(
			await json(await request(agentPath, "alice"), 200),
		);
		expect(beforeRuntime).toMatchObject({
			managementStatus: "creating",
			capabilities: {
				modelSelection: false,
				attachments: false,
				resultFiles: false,
				connection: false,
				supplementaryInstruction: false,
			},
			interactionUrl: null,
		});
		expect(beforeRuntime.serviceAvailability).not.toBe("ready");
		await json(await request(agentPath, "bob"), 404);
		const update = {
			schemaVersion: 2,
			environment: [{ name: "LANG", value: "C.UTF-8" }],
			modelConfiguration: modelConfiguration(plaintext.replacementModel),
			secrets: [{ name: "BOT_TOKEN", value: plaintext.replacementSecret }],
		};
		await json(
			await request(configurationPath, "bob", update, "update-denied-bob"),
			404,
		);
		await json(
			await request(configurationPath, "admin", update, "update-denied-admin"),
			404,
		);
		const updated = await json(
			await request(configurationPath, "alice", update, "update-owner"),
			200,
		);
		expect(updated).toMatchObject({
			configuration: {
				environment: update.environment,
				secrets: [{ name: "BOT_TOKEN", isSet: true, version: 2 }],
			},
		});
		const configured = await readDatabase();
		expect(configured.agent_configuration_revisions).toHaveLength(2);
		expect(configured.secret_records).toHaveLength(4);
		expectNoPlaintext(configured);
		expect(
			await json(
				await request(configurationPath, "alice", update, "update-owner"),
				200,
			),
		).toEqual(updated);
		expect(await readDatabase()).toEqual(configured);

		await json(
			await request(
				configurationPath,
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
				"co-owner-update",
			),
			200,
		);
		await json(
			await request(
				configurationPath,
				"alice",
				{ schemaVersion: 2, coOwnerIds: [] },
				"remove-owner",
			),
			200,
		);
		const revoked = await readDatabase();
		await json(
			await request(
				configurationPath,
				"bob",
				{ schemaVersion: 2, environment: [] },
				"revoked-owner-update",
			),
			404,
		);
		expect(await readDatabase()).toEqual(revoked);

		const finalAgent = await json(await request(agentPath, "alice"), 200);
		const finalApplication = await json(
			await request(applicationPath, "alice"),
			200,
		);
		await assembly?.close();
		assembly = undefined;
		openApi();
		expect(await json(await request(agentPath, "alice"), 200)).toEqual(
			finalAgent,
		);
		expect(await json(await request(applicationPath, "alice"), 200)).toEqual(
			finalApplication,
		);
		expect(
			await json(
				await request(path, "alice", applicationBody, "create-a"),
				201,
			),
		).toEqual(finalApplication);
		expect(await readDatabase()).toEqual(revoked);
		expectNoPlaintext(revoked);
		for (const row of revoked.agent_configuration_revisions ?? []) {
			expect(row.configuration).toMatchObject({ schemaVersion: 2 });
			expect(row.configuration).not.toHaveProperty("actions");
		}
		// Pause after configuration N was read, commit N+1 through the real API,
		// then ensure the first response cannot combine these two snapshots.
		let entered!: () => void;
		let resume!: () => void;
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const release = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const prototype = PostgresAgentConfigurationQueryV1.prototype;
		const original = prototype.readRuntimePresentation;
		const paused = vi
			.spyOn(prototype, "readRuntimePresentation")
			.mockImplementationOnce(async function (
				this: PostgresAgentConfigurationQueryV1,
				input,
			) {
				entered();
				await release;
				return original.call(this, input);
			});
		try {
			const oldRead = Promise.resolve(request(agentPath, "alice"));
			await Promise.race([
				waiting,
				oldRead.then(() => {
					throw new Error("Projection did not reach the revision barrier");
				}),
			]);
			const change = {
				schemaVersion: 2,
				environment: [{ name: "LANG", value: "en_US.UTF-8" }],
			};
			await json(
				await request(
					configurationPath,
					"alice",
					change,
					"concurrent-projection-update",
				),
				200,
			);
			resume();
			const stale = await json(await oldRead, 503);
			expect(stale).toMatchObject({
				code: "DEPENDENCY_UNAVAILABLE",
				retryable: true,
			});
			expect(stale).not.toHaveProperty("configuration");
			expect(await json(await request(agentPath, "alice"), 200)).toMatchObject({
				configuration: { environment: change.environment },
			});
		} finally {
			resume();
			paused.mockRestore();
		}
		const afterConcurrentUpdate = await readDatabase();
		sessions.delete(sessionKeys.alice);
		await json(await request(agentPath, "alice"), 401);
		expect(await readDatabase()).toEqual(afterConcurrentUpdate);
	}, 60_000);
});
