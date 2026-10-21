import { createHash, generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import {
	AgentApiCreationResponseV1Schema,
	AgentApplicationProjectionV2Schema,
	AgentCreationFailureProjectionV1Schema,
	AgentDetailProjectionV1Schema,
	AgentProjectionV2Schema,
} from "@agent-infra/contracts/pilot";
import { validatePlatformSecretRecordV1 } from "@agent-infra/contracts/workload";
import { standardTemplateReadinessV1 } from "@agent-infra/model-catalog";
import { FakeObjectStorageV1 } from "@agent-infra/object-storage";
import {
	migratePlatformDatabase,
	PostgresAgentConfigurationQueryV1,
	PostgresPlatformUserDisablesV1,
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
import { decideAgentAccessUpdatePolicy } from "../../../packages/platform-core/src/agent-management-access-policy.ts";
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
	inspectProductionRelayKeyPolicyV1,
	mergeProductionPlatformApiDeploymentPortsV1,
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

describe("explicit custom Agent deployment ports", () => {
	it("inspects missing Relay Key policies without retaining policy values", () => {
		const agentDefaultRelayKeyPolicy = {
			templateBindings: [],
			relayEndpointId: "endpoint-private-sentinel",
			relayBaseUrl: "https://relay.private.invalid/v1",
		};
		const personalRelayKeyValidation = {
			profile: "sub2api-key-billing-v1" as const,
			billingUrl: "https://sub2api.la3.agoralab.co/v1/sub2api/billing",
		};
		expect(
			inspectProductionRelayKeyPolicyV1({
				agentDefaultRelayKeyPolicy,
			}),
		).toEqual({ missing: ["personalRelayKeyValidation"] });
		expect(inspectProductionRelayKeyPolicyV1({})).toEqual({
			missing: ["agentDefaultRelayKeyPolicy", "personalRelayKeyValidation"],
		});
		expect(
			inspectProductionRelayKeyPolicyV1({
				personalRelayKeyValidation,
				agentDefaultRelayKeyPolicy,
			}),
		).toEqual({ missing: [] });
		expect(JSON.stringify(inspectProductionRelayKeyPolicyV1({}))).not.toContain(
			"https://",
		);
	});

	it("merges Gateway, model and native metadata reader exports outside apiInput", () => {
		const customAgentGateway =
			{} as ProductionPlatformApiInputV1["customAgentGateway"];
		const modelSelection = {} as ProductionPlatformApiInputV1["modelSelection"];
		const modelDirectory = {
			baseUrl: "http://platform-worker.local",
			serviceToken: "worker-token",
		} satisfies NonNullable<ProductionPlatformApiInputV1["modelDirectory"]>;
		const nativeMetadata = {} as ProductionPlatformApiInputV1["nativeMetadata"];
		const nativeMetadataWorker = {
			baseUrl: "http://platform-worker.local",
			serviceToken: "worker-token",
		} satisfies NonNullable<
			ProductionPlatformApiInputV1["nativeMetadataWorker"]
		>;
		const nativeMetadataCurrent =
			{} as ProductionPlatformApiInputV1["nativeMetadataCurrent"];
		const nativeCapabilityMetadata =
			{} as ProductionPlatformApiInputV1["nativeCapabilityMetadata"];
		const files = {} as ProductionPlatformApiInputV1["files"];
		const apiInput = {} as ProductionPlatformApiInputV1;

		expect(
			mergeProductionPlatformApiDeploymentPortsV1({
				apiInput,
				customAgentGateway,
				modelSelection,
				modelDirectory,
				nativeMetadata,
				nativeMetadataWorker,
				nativeMetadataCurrent,
				nativeCapabilityMetadata,
				files,
			}),
		).toMatchObject({
			customAgentGateway,
			modelSelection,
			modelDirectory,
			nativeMetadata,
			nativeMetadataWorker,
			nativeMetadataCurrent,
			nativeCapabilityMetadata,
			files,
		});
	});

	it("rejects a duplicate file data plane authority", () => {
		const files = {} as ProductionPlatformApiInputV1["files"];
		expect(() =>
			mergeProductionPlatformApiDeploymentPortsV1({
				apiInput: { files } as ProductionPlatformApiInputV1,
				files,
			}),
		).toThrow("PLATFORM_FILES_DUPLICATE");
	});

	it("preserves Relay Key policy fields supplied through apiInput", () => {
		const apiInput = {
			agentDefaultRelayKeyPolicy: { relayEndpointId: "endpoint-a" },
			personalRelayKeyValidation: {
				billingUrl: "https://billing.example.test",
			},
		} as unknown as ProductionPlatformApiInputV1;
		expect(
			mergeProductionPlatformApiDeploymentPortsV1({ apiInput }),
		).toMatchObject({
			agentDefaultRelayKeyPolicy: apiInput.agentDefaultRelayKeyPolicy,
			personalRelayKeyValidation: apiInput.personalRelayKeyValidation,
		});
	});

	it.each([
		["Gateway", "customAgentGateway"],
		["model reader", "modelSelection"],
		["model directory transport", "modelDirectory"],
		["native metadata reader", "nativeMetadata"],
		["native metadata Worker", "nativeMetadataWorker"],
		["native metadata current route", "nativeMetadataCurrent"],
		["native capability metadata", "nativeCapabilityMetadata"],
	] as const)("rejects duplicate %s authorities", (_label, field) => {
		const value = {};
		const apiInput = {
			[field]: value,
		} as unknown as ProductionPlatformApiInputV1;
		expect(() =>
			mergeProductionPlatformApiDeploymentPortsV1({
				apiInput,
				[field]: value,
			} as Parameters<typeof mergeProductionPlatformApiDeploymentPortsV1>[0]),
		).toThrow(
			field === "customAgentGateway"
				? "PLATFORM_CUSTOM_AGENT_GATEWAY_DUPLICATE"
				: field === "modelSelection"
					? "PLATFORM_MODEL_SELECTION_DUPLICATE"
					: field === "modelDirectory"
						? "PLATFORM_MODEL_DIRECTORY_DUPLICATE"
						: field === "nativeMetadata"
							? "PLATFORM_NATIVE_METADATA_DUPLICATE"
							: field === "nativeMetadataWorker"
								? "PLATFORM_NATIVE_METADATA_WORKER_DUPLICATE"
								: field === "nativeMetadataCurrent"
									? "PLATFORM_NATIVE_METADATA_CURRENT_DUPLICATE"
									: "PLATFORM_NATIVE_CAPABILITY_METADATA_DUPLICATE",
		);
	});
});

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
		// 浏览器专用入口（如 Agent 详情）不接受 Authorization，改用同一合成会话的 Cookie。
		const cookie = /(?:^|;\s*)synthetic-session=([^;]+)/.exec(
			request.headers.get("cookie") ?? "",
		)?.[1];
		return (
			sessions.get(request.headers.get("authorization") ?? cookie ?? "") ?? null
		);
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
	source: {
		kind: "standard",
		templateId: "codex",
		templateRevision: "",
	},
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
	const modelBinding = {
		templateId: "codex",
		imageDigest,
		driver: "codex" as const,
		protocol: "openai-responses-v1" as const,
	};
	const validation = {
		schemaVersion: 1 as const,
		templateId: "codex",
		imageDigest,
		driver: "codex" as const,
		configurationRevision: "configuration-a",
		status: "passed" as const,
		evidenceKind: "real-runtime-model" as const,
		executionId: "fixture-execution",
		modelId: "model-a",
		validatedAt: Date.now() - 1_000,
		validUntil: Date.now() + 60_000,
	};
	const readiness = standardTemplateReadinessV1({
		templateId: "codex",
		imageDigest,
		binding: modelBinding,
		configurationRevision: "configuration-a",
		validation,
		now: Date.now(),
	});
	if (readiness.state !== "ready") throw new Error("fixture readiness failed");
	const templateRevision = `template-${sha256(
		JSON.stringify({
			registration: {
				templateId: "codex",
				imageDigest,
				modelBinding,
				configurationRevision: "configuration-a",
			},
			validation: readiness.revision,
		}),
	)}`;
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
				modelBinding,
				// ADR-0029 之前要求的模型画像：仍可出现在部署配置里，但被忽略。
				codexModelProfiles: [
					{ model: "model-a", reasoningLevels: ["medium", "high"] },
				],
				configurationRevision: "configuration-a",
				loadValidation: async () => validation,
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
	return { input, fetch, authorize, imageDigest, templateRevision };
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
	applicationBody.source.templateRevision = fixture.templateRevision;
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
			// 读取期间配置已变：不把旧配置和新的运行时事实拼在一起；详情读取用同一个查询重读，
			// 整体返回新快照（#2661，之前是 503）。
			const current = AgentProjectionV2Schema.parse(
				await json(await stale, 200),
			);
			expect(current.configuration.environment).toEqual([
				{ name: "LANG", value: "en_GB.UTF-8" },
			]);
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
	it("resolves historical model names within the original production request scope", async () => {
		expect(
			createProductionPlatformApiAssemblyInputV1(fixture.input)
				.readRequestedModelDisplayName,
		).toBeUndefined();
		const load = vi.fn(async (_signal: AbortSignal) =>
			fixture.input.modelCatalog.load(_signal),
		);
		const input = createProductionPlatformApiAssemblyInputV1({
			...fixture.input,
			modelCatalog: { ...fixture.input.modelCatalog, load },
			modelDisplayMetadata: {
				schemaVersion: 1,
				models: [
					{
						endpointId: "endpoint-a",
						modelId: "model-a",
						displayName: "Workspace model",
					},
				],
			},
		});
		const resolveName = input.readRequestedModelDisplayName;
		const scope = input.requestScope;
		if (!resolveName || !scope)
			throw new Error("Expected scoped name resolver");
		const model = { endpointId: "endpoint-a", modelId: "model-a" };
		await expect(resolveName(model)).rejects.toThrow("scope");
		expect(load).not.toHaveBeenCalled();
		const controller = new AbortController();
		const request = new Request("https://platform.example.test/commands", {
			signal: controller.signal,
		});
		let name: string | null = null;
		await scope(request, async () => {
			name = await resolveName(model);
			return new Response(null);
		});
		expect(name).toBe("Workspace model");
		expect(load).toHaveBeenCalledExactlyOnceWith(request.signal);
		controller.abort();
		await expect(
			scope(request, async () => {
				await resolveName(model);
				return new Response(null);
			}),
		).rejects.toThrow();
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("passes the deployment-owned file adapter into the API assembly", () => {
		const files = {
			storage: new FakeObjectStorageV1(),
			issuer: "platform-files",
			keyVersion: "key-v1",
			privateKey: generateKeyPairSync("ed25519").privateKey,
			publicKeys: new Map(),
			runtimeIssuer: "platform-runtime",
			runtimeWorkerId: "runtime-worker",
			runtimePublicKeys: new Map(),
			intentTtlMs: 60_000,
			accessTtlMs: 60_000,
			maxConcurrentTransfers: 1,
			services: [],
			resolveActor: async () => null,
			readLimits: async () => ({
				configurationRevision: 1,
				declarations: {
					agent: {
						revision: "agent",
						expiresAt: "2099-01-01T00:00:00Z",
						mediaTypes: ["text/plain"],
						maxBytes: 1024,
					},
					channel: {
						revision: "channel",
						expiresAt: "2099-01-01T00:00:00Z",
						mediaTypes: ["text/plain"],
						maxBytes: 1024,
					},
					deployment: {
						revision: "deployment",
						expiresAt: "2099-01-01T00:00:00Z",
						mediaTypes: ["text/plain"],
						maxBytes: 1024,
					},
				},
			}),
		} satisfies NonNullable<ProductionPlatformApiInputV1["files"]>;
		const input = createProductionPlatformApiAssemblyInputV1({
			...fixture.input,
			files,
		});
		expect(input.files).toBe(files);
	});
	it("passes the deployment-owned application credential delivery into the API assembly", () => {
		const applicationCredentialDelivery = {
			principalType: "application" as const,
			principalId: "application-process",
			accept() {
				return true;
			},
		} satisfies NonNullable<
			ProductionPlatformApiInputV1["applicationCredentialDelivery"]
		>;
		const input = createProductionPlatformApiAssemblyInputV1({
			...fixture.input,
			applicationCredentialDelivery,
		});
		expect(input.applicationCredentialDelivery).toBe(
			applicationCredentialDelivery,
		);
	});
	it("passes the deployment Agent Version and rejects values the binding path cannot carry (#2903)", () => {
		expect(
			createProductionPlatformApiAssemblyInputV1({
				...fixture.input,
				agentVersion: "agent-version-1",
			}).agentVersion,
		).toBe("agent-version-1");
		// 未配置时不注入：Skill 绑定读写保持不可用。
		expect(
			createProductionPlatformApiAssemblyInputV1(fixture.input),
		).not.toHaveProperty("agentVersion");
		for (const agentVersion of [
			"",
			"agent/version",
			"private agent version sentinel",
		]) {
			expect(() =>
				createProductionPlatformApiAssemblyInputV1({
					...fixture.input,
					agentVersion,
				}),
			).toThrow("PLATFORM_DEPLOYMENT_CONFIGURATION_INVALID");
			try {
				createProductionPlatformApiAssemblyInputV1({
					...fixture.input,
					agentVersion,
				});
			} catch (error) {
				expect(String(error)).not.toContain("private agent version sentinel");
			}
		}
	});
	it("passes the deployment-approved WeCom QR authorization source into the API assembly (#2894)", () => {
		const wecomBotQr = {
			source: "agent-infra-deployment",
			authOrigin: "https://work.weixin.qq.com",
			authorizationEndpoint: "https://work.weixin.qq.com/ai/qc/gen",
		} satisfies NonNullable<ProductionPlatformApiInputV1["wecomBotQr"]>;
		const input = createProductionPlatformApiAssemblyInputV1({
			...fixture.input,
			wecomBotQr,
		});
		expect(input.wecomBotQr).toBe(wecomBotQr);
		expect(
			createProductionPlatformApiAssemblyInputV1(fixture.input),
		).not.toHaveProperty("wecomBotQr");
	});
	it("merges Platform-only user disables into the authority context", async () => {
		const userGovernance = new PostgresPlatformUserDisablesV1(
			database.databaseUrl,
			async () => null,
		);
		await reader.unsafe(
			"insert into platform.platform_user_disables(user_id) values ('alice')",
		);
		try {
			const input = createProductionPlatformApiAssemblyInputV1({
				...fixture.input,
				userGovernance,
			});
			const loadAuthorityContext = input.agentApiCreation?.loadAuthorityContext;
			if (!loadAuthorityContext)
				throw new Error("Missing API authority loader");
			const authority = await loadAuthorityContext();
			expect(authority.users).toEqual(
				expect.arrayContaining([
					{ userId: "alice", accountStatus: "disabled" },
					{ userId: "bob", accountStatus: "active" },
				]),
			);
			const state = {
				schemaVersion: 1 as const,
				applicationId: "application_owner_policy",
				agentId: "agent_owner_policy",
				applicantId: "alice",
				status: "available" as const,
				revision: 1,
				approvalRevision: 1,
				decisionReason: null,
				serviceAvailability: "ready" as const,
				desiredState: "running" as const,
				workloadRevision: 1,
				fence: 1,
				ownerIds: ["alice"],
				availability: [],
				failureCode: null,
			};
			const command = {
				schemaVersion: 1 as const,
				agentId: state.agentId,
				expectedRevision: state.revision,
				desiredOwnerIds: ["bob"],
				desiredAvailability: [],
				requestId: "request_owner_policy",
				traceId: "trace_owner_policy",
			};
			const policyAuthority = {
				schemaVersion: 1 as const,
				users: authority.users,
				organizationIds: authority.organizationIds,
			};
			expect(
				decideAgentAccessUpdatePolicy(
					command,
					state,
					{
						schemaVersion: 1,
						userId: "alice",
						accountStatus: "disabled",
						organizationIds: [],
						isAdministrator: false,
					},
					policyAuthority,
				),
			).toEqual({ outcome: "denied", planFragment: null });
			expect(
				decideAgentAccessUpdatePolicy(
					command,
					state,
					{
						schemaVersion: 1,
						userId: "administrator",
						accountStatus: "active",
						organizationIds: ["org-admin"],
						isAdministrator: true,
					},
					policyAuthority,
				),
			).toMatchObject({
				outcome: "accepted",
				planFragment: { ownerIds: ["bob"] },
			});
			expect(
				decideAgentAccessUpdatePolicy(
					{ ...command, desiredOwnerIds: ["alice"] },
					state,
					{
						schemaVersion: 1,
						userId: "administrator",
						accountStatus: "active",
						organizationIds: ["org-admin"],
						isAdministrator: true,
					},
					policyAuthority,
				),
			).toMatchObject({
				outcome: "conflict",
				reason: "last_valid_owner_required",
			});
		} finally {
			await reader.unsafe(
				"delete from platform.platform_user_disables where user_id='alice'",
			);
			await userGovernance.close();
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
	// #3034：平台身份入口是部署能力。未装配 Auth Gateway 时，「自有交互入口 + 平台校验」在镜像准入前
	// 被明确拒绝，不创建申请，也不进入审批队列；装配后（AC-3）照常受理。
	it("rejects a platform identity entry application without an Auth Gateway and accepts it with one", async () => {
		const previous = fixture;
		await createPlatformApiShutdown(running)();
		fixture = deploymentInput(database.databaseUrl, "self-managed");
		await openApi();
		const imageReference = `registry.example.test/agents/codex@${fixture.imageDigest}`;
		const body = {
			...applicationBody,
			modelConfiguration: undefined,
			secrets: [],
			source: {
				kind: "custom",
				imageReference,
				interactionMode: "self-managed",
				identityResponsibility: "platform-managed",
			},
		};
		try {
			const before = await snapshot();
			const rejected = await request(
				"/api/v2/agent-applications",
				"alice",
				body,
				"platform-identity-unavailable",
			);
			expect(rejected.status).toBe(409);
			expect(await rejected.json()).toMatchObject({
				schemaVersion: 1,
				code: "ACTION_UNAVAILABLE",
				retryable: false,
			});
			expect(fixture.fetch).not.toHaveBeenCalled();
			expect(fixture.authorize).not.toHaveBeenCalled();
			expect(await snapshot()).toEqual(before);
			const pending = await json(
				await request("/api/v2/admin/agent-applications", "admin"),
				200,
			);
			expect(JSON.stringify(pending)).not.toContain("platform-managed");

			await createPlatformApiShutdown(running)();
			fixture = {
				...fixture,
				input: {
					...fixture.input,
					customAgentGateway: {
						path: "/custom-agents/*",
						resolveDeployment: vi.fn(async () => null),
						issuer: "platform-api",
						keyVersion: "test-key-v1",
						privateKey: generateKeyPairSync("ed25519").privateKey,
					},
				},
			};
			await openApi();
			const created = AgentApplicationProjectionV2Schema.parse(
				await json(
					await request(
						"/api/v2/agent-applications",
						"alice",
						body,
						"platform-identity-available",
					),
					201,
				),
			);
			expect(created).toMatchObject({
				status: "pending_approval",
				source: {
					kind: "custom",
					interactionMode: "self-managed",
					identityResponsibility: "platform-managed",
				},
			});
		} finally {
			await createPlatformApiShutdown(running)();
			fixture = previous;
			await openApi();
		}
	});
	// #2910：渠道状态来自本 Agent 当前绑定引用的连接事实；同一引用下其他 Agent 的连接不泄露。
	it("projects real WeCom bot status per Agent without leaking another Agent's connection", async () => {
		const createApproved = async (user: User, key: string) => {
			const created = AgentApplicationProjectionV2Schema.parse(
				await json(
					await request(
						"/api/v2/agent-applications",
						user,
						applicationBody,
						key,
					),
					201,
				),
			);
			await json(
				await request(
					`/api/v2/admin/agent-applications/${created.applicationId}/decision`,
					"admin",
					{ schemaVersion: 1, decision: "approve" },
					`${key}-approve`,
				),
				200,
			);
			if (!created.agentId) throw new Error("Expected an approved Agent");
			return created.agentId;
		};
		const bound = await createApproved("alice", "wecom-status-alice");
		const pending = await createApproved("bob", "wecom-status-bob");
		const browser = (path: string, user: User) =>
			fetch(`${origin}${path}`, {
				headers: { cookie: `synthetic-session=${sessionKeys[user]}` },
			});
		const channels = [{ kind: "wecom_bot", bindingReference: "shared_ref" }];
		for (const agentId of [bound, pending])
			await reader.unsafe(
				`update platform.agent_configuration_revisions c
				set configuration = jsonb_set(c.configuration, '{channels}', $2::text::jsonb)
				from platform.agents a
				where a.id = $1 and c.agent_id = a.id and c.revision = a.current_configuration_revision`,
				[agentId, JSON.stringify(channels)],
			);
		await reader.unsafe(
			`insert into platform.wecom_connections (bot_id,agent_id,binding_reference,holder_id,fence,lease_until,status)
			values ('bot_status_alice',$1,'shared_ref','worker',1,clock_timestamp() + interval '1 minute','connected')`,
			[bound],
		);
		const detail = async (agentId: string, user: User) =>
			AgentDetailProjectionV1Schema.parse(
				await json(
					await browser(`/api/v2/agents/${agentId}/detail`, user),
					200,
				),
			).configuration.channels;
		await expect(detail(bound, "alice")).resolves.toEqual([
			{ kind: "web", status: "available" },
			{ kind: "wecom_bot", status: "bound" },
		]);
		await expect(detail(pending, "bob")).resolves.toEqual([
			{ kind: "web", status: "available" },
			{ kind: "wecom_bot", status: "binding" },
		]);
		// 旧版 strict reader 继续接受同一枚举内的真实状态。
		expect(
			AgentProjectionV2Schema.parse(
				await json(await request(`/api/v2/agents/${bound}`, "alice"), 200),
			).configuration.channels,
		).toEqual([
			{ kind: "web", status: "available" },
			{ kind: "wecom_bot", status: "bound" },
		]);
		const denied = await json(
			await browser(`/api/v2/agents/${bound}/detail`, "bob"),
			404,
		);
		expect(JSON.stringify(denied)).not.toMatch(/wecom|bound|bot_status/);
		await reader.unsafe(
			`update platform.wecom_connections set lease_until = clock_timestamp() - interval '1 second' where bot_id = 'bot_status_alice'`,
		);
		await expect(detail(bound, "alice")).resolves.toEqual([
			{ kind: "web", status: "available" },
			{ kind: "wecom_bot", status: "failed" },
		]);
	});
	// #3034：创建失败类别经真实装配、Store 与 PostgreSQL 读取。只有当前 Owner 与系统管理员能读到，
	// 其他用户（含其他组织）、其他 Agent 的 Owner 与未处于创建失败的 Agent 一律 404。
	it("serves the creation failure category only to the Owner and an administrator", async () => {
		const createApproved = async (user: User, key: string) => {
			const created = AgentApplicationProjectionV2Schema.parse(
				await json(
					await request(
						"/api/v2/agent-applications",
						user,
						applicationBody,
						key,
					),
					201,
				),
			);
			await json(
				await request(
					`/api/v2/admin/agent-applications/${created.applicationId}/decision`,
					"admin",
					{ schemaVersion: 1, decision: "approve" },
					`${key}-approve`,
				),
				200,
			);
			if (!created.agentId) throw new Error("Expected an approved Agent");
			return created.agentId;
		};
		const failed = await createApproved("alice", "creation-failure-alice");
		const creating = await createApproved("bob", "creation-failure-bob");
		const read = (agentId: string, user: User) =>
			fetch(`${origin}/api/v2/agents/${agentId}/creation-failure`, {
				headers: { cookie: `synthetic-session=${sessionKeys[user]}` },
			});
		const unavailable = async (agentId: string, user: User) => {
			const body = await json(await read(agentId, user), 404);
			expect(body).toMatchObject({ code: "RESOURCE_UNAVAILABLE" });
			expect(JSON.stringify(body)).not.toMatch(/kubernetes|policy|attempt/);
		};
		// 仍在创建中：Owner 与管理员都读不到。
		await unavailable(failed, "alice");
		await unavailable(failed, "admin");
		await reader.unsafe(
			`update platform.agent_applications set status = 'creation_failed', failure_code = 'reconciliation_failed' where agent_id = $1`,
			[failed],
		);
		await reader.unsafe(
			`insert into platform.workload_reconciliations (agent_id, revision, state)
			values ($1, 1, $2::text::jsonb)
			on conflict (agent_id) do update set state = excluded.state`,
			[
				failed,
				JSON.stringify({
					schemaVersion: 1,
					agentId: failed,
					revision: 1,
					lastFailure: {
						schemaVersion: 1,
						reason: "kubernetes_policy",
						attempts: 1,
					},
				}),
			],
		);
		for (const user of ["alice", "admin"] as const) {
			const response = await read(failed, user);
			expect(response.headers.get("cache-control")).toBe("no-store");
			const body = await json(response, 200);
			expect(AgentCreationFailureProjectionV1Schema.parse(body)).toEqual({
				schemaVersion: 1,
				agentId: failed,
				category: "configuration_rejected",
			});
			expect(JSON.stringify(body)).not.toMatch(/kubernetes|policy|attempt/);
		}
		// bob 属于另一个组织，也是另一个 Agent 的 Owner：读不到 alice 的 Agent，自己的 Agent 未失败也读不到。
		await unavailable(failed, "bob");
		await unavailable(creating, "bob");
		await unavailable(creating, "admin");
		await unavailable("agent_missing_creation_failure", "alice");
		// 只接受浏览器会话：同一主体改用 Authorization 也被拒绝。
		expect(
			(await request(`/api/v2/agents/${failed}/creation-failure`, "alice"))
				.status,
		).toBe(401);
	});
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
	source: {
		kind: "standard" as const,
		templateId: "codex",
	},
	coOwnerIds: [],
	availability: [],
	environment: [],
	secrets: [{ name: "BOT_TOKEN", value: "controlled-api-private-secret" }],
	modelConfiguration: apiModel,
	defaultRelayKey: "controlled-api-private-default-key",
};

/** web + worker 两个服务与一个迁移 Job；默认档位每个工作负载 100m，共 300m。 */
function multiServiceApiManifest(image: string) {
	const workload = (name: string) => ({
		apiVersion: "apps/v1",
		kind: "Deployment",
		metadata: { name },
		spec: {
			replicas: 1,
			selector: { matchLabels: { app: name } },
			template: {
				metadata: { labels: { app: name } },
				spec: {
					containers: [
						{
							name,
							image,
							ports: [{ name: "http", port: 8080, targetPort: 8080 }],
						},
					],
				},
			},
		},
	});
	const service = (name: string) => ({
		apiVersion: "v1",
		kind: "Service",
		metadata: {
			name,
			annotations:
				name === "web" ? { "agent-infra.agora.io/entry": "true" } : {},
		},
		spec: {
			type: "ClusterIP",
			selector: { app: name },
			ports: [{ name: "http", port: 8080, targetPort: 8080 }],
		},
	});
	return JSON.stringify({
		schemaVersion: 1,
		entryServiceName: "web",
		resources: [
			workload("web"),
			workload("worker"),
			service("web"),
			service("worker"),
			{
				apiVersion: "batch/v1",
				kind: "Job",
				metadata: { name: "migrate" },
				spec: {
					backoffLimit: 1,
					template: {
						metadata: { labels: { app: "migration" } },
						spec: {
							restartPolicy: "Never",
							containers: [{ name: "migrate", image }],
						},
					},
				},
			},
		],
	});
}
const smallMultiServiceCap = {
	cpuMillicores: 250,
	memoryMiB: 4_096,
	storageGiB: 20,
} as const;

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
	const verify =
		vi.fn<
			NonNullable<
				NonNullable<ProductionPlatformApiInputV1["agentApiCreation"]>["verify"]
			>
		>();
	let currentOwnerStatus: "active" | "disabled";
	beforeEach(async () => {
		if (running.server.listening) await createPlatformApiShutdown(running)();
		await reader.unsafe(
			"truncate platform.agents,platform.platform_applications,platform.platform_api_credentials,platform.platform_user_disables,platform.relay_key_subjects,platform.relay_key_versions,platform.audit_events,platform.outbox_items,platform.idempotency_records cascade",
		);
		fixture = deploymentInput(database.databaseUrl);
		applicationBody.source.templateRevision = fixture.templateRevision;
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
		verify.mockReset().mockResolvedValue(undefined);
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
				verify,
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
		// 保存前用提交的默认 Key 对所选模型与档位做一次真实验证（ADR-0029）。
		expect(verify).toHaveBeenCalledExactlyOnceWith(
			apiBody.defaultRelayKey,
			expect.objectContaining({ source: expect.anything() }),
			[
				{
					endpointId: "endpoint-a",
					modelId: "model-a",
					reasoningLevel: "medium",
				},
			],
		);
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
	it("retains startup admission policy after caller aliases are modified", async () => {
		Object.assign(fixture.input, {
			imageRepository: "registry.example.test/other/repository",
			templates: [],
			registry: {
				...fixture.input.registry,
				policy: { authorize: async () => ({ status: "rejected" }) },
			},
			channelPolicy: { revision: "mutated", bindings: [] },
		});
		expect((await create()).status).toBe(201);
		expect(fixture.authorize).toHaveBeenCalledOnce();
		expect(await effects()).toEqual([
			{ agents: 1, grants: 2, secrets: 1, keys: 1, outbox: 1 },
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
	it.each([
		"missing-key",
		"missing-verification",
		"rejected-key",
		"failed-key",
		"failed-verification",
	])("fails closed with %s provider", async (failure) => {
		await createPlatformApiShutdown(running)();
		const configured = fixture.input.agentApiCreation;
		if (!configured) throw new Error("Missing controlled configuration");
		fixture.input = {
			...fixture.input,
			agentApiCreation: {
				...configured,
				...(failure === "missing-key" ? { candidates: undefined } : {}),
				// 只给 candidates 不给验证：不装配默认 Key，标准模板创建失败关闭（ADR-0029）。
				...(failure === "missing-verification" ? { verify: undefined } : {}),
			},
		};
		if (failure === "rejected-key") candidates.mockResolvedValue([]);
		if (failure === "failed-key")
			candidates.mockRejectedValue(new Error(apiBody.defaultRelayKey));
		if (failure === "failed-verification")
			verify.mockRejectedValue(new Error(apiBody.defaultRelayKey));
		await openApi();
		const response = await create();
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(await response.text()).not.toContain(apiBody.defaultRelayKey);
		expect(await effects()).toEqual([
			{ agents: 0, grants: 0, secrets: 0, keys: 0, outbox: 0 },
		]);
	});
	describe("without a separate API candidates adapter (#2759)", () => {
		// 只换掉 candidates：部署提供与 Web 申请相同的默认 Relay Key 策略（受控 billing 与模型列表）。
		async function openWithDeploymentPolicy(
			billingStatus: number,
			explicit?: typeof candidates,
			probeStatus = 200,
		) {
			await createPlatformApiShutdown(running)();
			const configured = fixture.input.agentApiCreation;
			if (!configured) throw new Error("Missing controlled configuration");
			const relayFetch = vi.fn<typeof fetch>(async (url, init) => {
				expect(init?.redirect).toBe("error");
				if (String(url).endsWith("/billing"))
					return Response.json(
						{
							object: "sub2api.key_billing",
							schema_version: 1,
							billing_scope: "token",
						},
						{ status: billingStatus },
					);
				// 保存前对所选模型与档位做一次真实验证请求（ADR-0029）。
				if (String(url).endsWith("/responses") && probeStatus !== 200)
					return Response.json({}, { status: probeStatus });
				if (String(url).endsWith("/responses"))
					return new Response(
						`data: ${JSON.stringify({
							type: "response.completed",
							response: {
								output: [
									{
										type: "function_call",
										name: "agent_infra_conformance",
										arguments: "{}",
										status: "completed",
									},
								],
							},
						})}\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					);
				return Response.json({ data: [{ id: "model-a" }] });
			});
			const binding = fixture.input.templates[0]?.modelBinding;
			if (!binding) throw new Error("Missing controlled template binding");
			fixture.input = {
				...fixture.input,
				agentApiCreation: { ...configured, candidates: explicit },
				agentDefaultRelayKeyPolicy: {
					templateBindings: [{ ...binding, reasoningLevels: ["medium"] }],
					relayEndpointId: "endpoint-a",
					relayBaseUrl: "https://relay.example.test/v1",
				},
				personalRelayKeyValidation: {
					profile: "sub2api-key-billing-v1",
					billingUrl: "https://sub2api.la3.agoralab.co/v1/sub2api/billing",
					fetch: relayFetch,
				},
				modelCatalog: {
					...fixture.input.modelCatalog,
					load: async () => ({
						schemaVersion: 1,
						revision: fixture.input.modelCatalog.revision,
						validUntil: Date.now() + 60_000,
						endpoints: [
							{
								endpointId: "endpoint-a",
								baseUrl: "https://relay.example.test/v1",
								origin: "https://relay.example.test",
								protocol: binding.protocol,
								authentication: "bearer",
								security: { tls: "verify-peer", redirects: "reject" },
								capabilities: {
									streaming: true,
									tools: true,
									reasoningLevels: ["medium"],
								},
								allowedModels: ["model-a"],
								available: true,
							},
						],
					}),
				},
			};
			await openApi();
			return relayFetch;
		}
		it("uses the deployment default Relay Key policy shared with browser creation", async () => {
			const relayFetch = await openWithDeploymentPolicy(200);
			const response = await create();
			expect(response.status).toBe(201);
			expect(await effects()).toEqual([
				{ agents: 1, grants: 2, secrets: 1, keys: 1, outbox: 1 },
			]);
			// 提交的 Key 只发给固定的 billing、模型目录与验证请求路由。
			expect(
				relayFetch.mock.calls.map(([url]) => String(url)).toSorted(),
			).toEqual([
				"https://relay.example.test/v1/models",
				"https://relay.example.test/v1/responses",
				"https://sub2api.la3.agoralab.co/v1/sub2api/billing",
			]);
			expect(candidates).not.toHaveBeenCalled();
		});
		it("keeps an explicit API candidates adapter ahead of the shared policy", async () => {
			candidates.mockResolvedValue([]);
			const relayFetch = await openWithDeploymentPolicy(200, candidates);
			expect((await create()).status).toBe(400);
			expect(candidates).toHaveBeenCalledOnce();
			expect(relayFetch).not.toHaveBeenCalled();
		});
		it.each([
			[401, 400, "INVALID_REQUEST"],
			[503, 503, "DEPENDENCY_UNAVAILABLE"],
		] as const)(
			"classifies billing status %i as HTTP %i without effects",
			async (billingStatus, status, code) => {
				await openWithDeploymentPolicy(billingStatus);
				const response = await create();
				expect(response.status).toBe(status);
				const text = await response.text();
				expect(JSON.parse(text)).toMatchObject({ code });
				expect(text).not.toContain(apiBody.defaultRelayKey);
				expect(await effects()).toEqual([
					{ agents: 0, grants: 0, secrets: 0, keys: 0, outbox: 0 },
				]);
			},
		);
		it.each([
			[400, 409, "MODEL_SELECTION_INVALID"],
			[401, 400, "INVALID_REQUEST"],
			[503, 503, "DEPENDENCY_UNAVAILABLE"],
		] as const)(
			"classifies verification status %i as HTTP %i without effects",
			async (probeStatus, status, code) => {
				await openWithDeploymentPolicy(200, undefined, probeStatus);
				const response = await create();
				expect(response.status).toBe(status);
				const text = await response.text();
				expect(JSON.parse(text)).toMatchObject({ code });
				expect(text).not.toContain(apiBody.defaultRelayKey);
				expect(await effects()).toEqual([
					{ agents: 0, grants: 0, secrets: 0, keys: 0, outbox: 0 },
				]);
			},
		);
	});
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
	it("applies the deployment multi-service resource cap to API Token admissions", async () => {
		const manifest = multiServiceApiManifest(fixture.imageDigest);
		const admitWith = (input: ProductionPlatformApiInputV1) => {
			const admissions =
				createProductionPlatformApiAssemblyInputV1(input).agentApiCreation
					?.admissions;
			if (typeof admissions !== "function")
				throw new Error("Missing API Token admissions");
			return admissions({
				principal: { kind: "application", id: "alice" },
				ownerId: "alice",
				agentId: "agent-api-cap",
				applicationId: "application-api-cap",
				authorizationRevision: "authorization-api-cap",
				authorizationAdmission: { authorize: vi.fn() },
			}).imageAdmission.admitImage({
				schemaVersion: 1,
				agentId: "agent-api-cap",
				requestId: "request-api-cap",
				traceId: "trace-api-cap",
				requested: {
					kind: "custom",
					interactionMode: "self-managed",
					identityResponsibility: "self-managed",
					manifest,
				},
			});
		};
		const cap = { ...smallMultiServiceCap };
		const capped = admitWith({
			...fixture.input,
			multiServiceResourceCap: cap,
		});
		// 装配时已捕获启动期策略；之后修改调用方对象不会放宽上限。
		Object.assign(cap, { cpuMillicores: 100_000 });
		await expect(capped).resolves.toEqual({
			schemaVersion: 1,
			agentId: "agent-api-cap",
			requestId: "request-api-cap",
			status: "rejected",
			reason: "multi_service_resource_cap_exceeded",
		});
		expect(fixture.fetch).not.toHaveBeenCalled();
		expect(fixture.authorize).not.toHaveBeenCalled();

		// 对照：部署未配置上限时，同一清单在 API Token 路径按默认上限准入。
		await expect(admitWith(fixture.input)).resolves.toMatchObject({
			status: "admitted",
			source: { kind: "custom", interactionMode: "self-managed" },
		});
		expect(fixture.fetch).toHaveBeenCalled();
	});
	it("returns the resource cap error for an over-cap API Token creation without effects", async () => {
		await createPlatformApiShutdown(running)();
		fixture.input = {
			...fixture.input,
			multiServiceResourceCap: smallMultiServiceCap,
		};
		await openApi();
		const response = await create(apiTokens.application, "multi-service-cap", {
			schemaVersion: 2,
			name: apiBody.name,
			description: apiBody.description,
			source: {
				kind: "custom",
				interactionMode: "self-managed",
				identityResponsibility: "self-managed",
				manifest: multiServiceApiManifest(fixture.imageDigest),
			},
			coOwnerIds: [],
			availability: [],
			environment: [],
			secrets: [],
		});
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			code: "MULTI_SERVICE_RESOURCE_CAP_EXCEEDED",
			retryable: false,
		});
		expect(fixture.fetch).not.toHaveBeenCalled();
		expect(await effects()).toEqual([
			{ agents: 0, grants: 0, secrets: 0, keys: 0, outbox: 0 },
		]);
	});
	// #3034：API Token 创建与浏览器申请使用同一个平台身份入口事实。
	it("rejects a platform identity entry API Token creation without an Auth Gateway and without effects", async () => {
		const response = await create(
			apiTokens.application,
			"platform-identity-unavailable",
			{
				schemaVersion: 2,
				name: apiBody.name,
				description: apiBody.description,
				source: {
					kind: "custom",
					imageReference: `registry.example.test/agents/codex@${fixture.imageDigest}`,
					interactionMode: "self-managed",
					identityResponsibility: "platform-managed",
				},
				coOwnerIds: [],
				availability: [],
				environment: [],
				secrets: [],
			},
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			code: "ACTION_UNAVAILABLE",
			retryable: false,
		});
		expect(fixture.fetch).not.toHaveBeenCalled();
		expect(await effects()).toEqual([
			{ agents: 0, grants: 0, secrets: 0, keys: 0, outbox: 0 },
		]);
	});
	it("passes the Auth Gateway capability to API Token admissions", async () => {
		const admitWith = (input: ProductionPlatformApiInputV1) => {
			const admissions =
				createProductionPlatformApiAssemblyInputV1(input).agentApiCreation
					?.admissions;
			if (typeof admissions !== "function")
				throw new Error("Missing API Token admissions");
			return admissions({
				principal: { kind: "application", id: "alice" },
				ownerId: "alice",
				agentId: "agent-api-identity",
				applicationId: "application-api-identity",
				authorizationRevision: "authorization-api-identity",
				authorizationAdmission: { authorize: vi.fn() },
			}).imageAdmission.admitImage({
				schemaVersion: 1,
				agentId: "agent-api-identity",
				requestId: "request-api-identity",
				traceId: "trace-api-identity",
				requested: {
					kind: "custom",
					imageReference: `registry.example.test/agents/codex@${fixture.imageDigest}`,
					interactionMode: "self-managed",
					identityResponsibility: "platform-managed",
				},
			});
		};
		await expect(admitWith(fixture.input)).resolves.toEqual({
			schemaVersion: 1,
			agentId: "agent-api-identity",
			requestId: "request-api-identity",
			status: "rejected",
			reason: "platform_identity_entry_unavailable",
		});
		expect(fixture.fetch).not.toHaveBeenCalled();
		// 对照：装配 Auth Gateway 后，同一请求继续走 Registry 准入（此镜像声明平台交互入口，因而按
		// 交互入口不一致拒绝，且不再带平台身份入口原因）。
		const admitted = await admitWith({
			...fixture.input,
			customAgentGateway: {
				path: "/custom-agents/*",
				resolveDeployment: vi.fn(async () => null),
				issuer: "platform-api",
				keyVersion: "test-key-v1",
				privateKey: generateKeyPairSync("ed25519").privateKey,
			},
		});
		expect(admitted).toEqual({
			schemaVersion: 1,
			agentId: "agent-api-identity",
			requestId: "request-api-identity",
			status: "rejected",
		});
		expect(fixture.fetch).toHaveBeenCalled();
	});
});
