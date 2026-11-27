import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { TemplatePublicationStatusV1Schema } from "@agent-infra/contracts/pilot";
import { adoptTemplateValidationV2 } from "@agent-infra/model-catalog";
import { createTemplatePublicationServiceTransportV1 } from "@agent-infra/platform-core";
import {
	createPostgresOutboxStore,
	migratePlatformDatabase,
	PostgresAgentConfigurationQueryV1,
} from "@agent-infra/platform-store";
import { serve } from "@hono/node-server";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../../packages/platform-core/src/agent-configuration.conformance.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";
import {
	fakeKubernetesApi,
	workloadRegistryFixture,
	workloadTestPolicy,
} from "../../platform-worker/src/kubernetes.fixture.js";
import { createPlatformWorkloadWorkerV1 } from "../../platform-worker/src/workload-worker.js";
import { readTemplateReadiness } from "./deployment-admissions.js";
import type { IdentityContext } from "./http/identity.js";
import type { AutomaticTemplatePublicationInputV1 } from "./template-publication.js";
import {
	createProductionSingleAgentTemplateReleaseAppV1,
	type ProductionSingleAgentTemplateReleaseInputV1,
} from "./template-release.js";

interface DatabaseReader {
	begin<T>(
		body: (transaction: Pick<DatabaseReader, "unsafe">) => Promise<T>,
	): Promise<T>;
	unsafe(
		query: string,
		parameters?: readonly unknown[],
	): Promise<Record<string, unknown>[]>;
	end(): Promise<void>;
}
const connectDatabase = createRequire(
	import.meta.resolve("@agent-infra/platform-store"),
)("postgres") as (url: string, options: { max: number }) => DatabaseReader;
const original = {
	...structuredClone(agentConfigurationConformanceRecordV1),
	secrets: [
		{
			name: "BOT_TOKEN",
			secretId: "existing_bot_secret",
			version: 4,
			isSet: true as const,
		},
	],
	channels: [
		{ kind: "wecom_bot" as const, bindingReference: "existing_binding" },
	],
};
const digest = (value: string) =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;
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
				capabilities: { modelSelection: true, connection: true },
			}),
		},
	},
});
const configDigest = digest(config);
const manifest = JSON.stringify({
	schemaVersion: 2,
	mediaType: "application/vnd.oci.image.manifest.v1+json",
	config: {
		mediaType: "application/vnd.oci.image.config.v1+json",
		digest: configDigest,
		size: Buffer.byteLength(config),
	},
	layers: [],
});
const target = {
	schemaVersion: 1 as const,
	releaseId: "release_01",
	agentId: original.agentId,
	templateId: "template_01",
	expectedConfigurationRevision: 7,
	expectedImageDigest: original.source.imageDigest,
	targetImageDigest: digest(manifest),
};
const administrator: IdentityContext = {
	schemaVersion: 1,
	userId: "administrator",
	displayName: "Test operator",
	accountStatus: "active",
	organizationIds: [],
	roles: ["system_admin"],
	authorizationRevision: "identity_1",
};
let actor:
	| (Omit<IdentityContext, "accountStatus"> & {
			accountStatus: "active" | "disabled";
	  })
	| null = administrator;
let operators: readonly string[] = [administrator.userId];
let bindingTarget = target;
let releaseExpiresAt: string | undefined;
let registryHook: () => Promise<void> = async () => {};
let registryMode: "normal" | "unavailable" | "wrong_manifest" | "denied" =
	"normal";
let db: DatabaseReader;
let testDatabase: PostgresTestDatabase;
let input: ProductionSingleAgentTemplateReleaseInputV1;
let running: ReturnType<typeof createProductionSingleAgentTemplateReleaseAppV1>;
let server: ReturnType<typeof serve>;
let origin: string;
const seenRequests: Request[] = [];
async function start(
	override: Partial<ProductionSingleAgentTemplateReleaseInputV1> = {},
) {
	running = createProductionSingleAgentTemplateReleaseAppV1({
		...input,
		...override,
	});
	server = serve({ fetch: running.app.fetch, hostname: "127.0.0.1", port: 0 });
	await new Promise<void>((resolve) => server.once("listening", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function stop() {
	await new Promise<void>((resolve, reject) =>
		server.close((error) => (error ? reject(error) : resolve())),
	);
	await running.close();
}
async function apply(
	body: unknown = { schemaVersion: 1 },
	key = "release_key",
	path = `/internal/ops/standard-template-releases/${target.releaseId}/apply`,
) {
	return fetch(`${origin}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json", "Idempotency-Key": key },
		body: JSON.stringify(body),
	});
}
async function snapshot() {
	const [agent] = await db.unsafe(
		"select current_configuration_revision, authorization_revision from platform.agents where id=$1",
		[original.agentId],
	);
	const revisions = await db.unsafe(
		"select configuration from platform.agent_configuration_revisions order by revision",
	);
	const outbox = await db.unsafe(
		"select operation,payload from platform.outbox_items",
	);
	const audit = await db.unsafe(
		"select actor_id,action,details from platform.audit_events",
	);
	const keys = await db.unsafe(
		"select actor_id,request_digest,result from platform.idempotency_records",
	);
	const owners = await db.unsafe(
		"select owner_id from platform.agent_owners order by owner_id",
	);
	return { agent, revisions, outbox, audit, keys, owners };
}

const automaticPublicationId = "automatic-release-01";
let automaticExpiresAt = "";
let automaticApprover: IdentityContext | null;
let automaticTemplate: (typeof input.templates)[number];
let automaticValidationRef = "";
function automaticInput() {
	return {
		loadBinding: async () => ({
			schemaVersion: 1 as const,
			publicationId: automaticPublicationId,
			deploymentRef: "deployment-test",
			catalogRevision: "catalog-2",
			templateId: target.templateId,
			targetImageDigest: target.targetImageDigest,
			validationRef: automaticValidationRef,
			servicePrincipalRef: "template-publisher",
			authorizationRevision: "permit-1",
			expiresAt: automaticExpiresAt,
			expectedPreviousPublicationId: null,
			operatorIds: [...operators],
		}),
		resolveAdministrator: async () => automaticApprover,
		isServiceCurrent: async () => true,
		resolveService: async (request: Request) => {
			if (request.headers.get("x-test-publication-service") !== "valid")
				return null;
			const operation = new URL(request.url).pathname.split("/").at(-1);
			return {
				schemaVersion: 1 as const,
				principalRef: "template-publisher",
				deploymentRef: "deployment-test",
				publicationId: automaticPublicationId,
				issuer: "test-issuer",
				keyVersion: "test-key-1",
				audience: "platform.template-publication.v1" as const,
				purpose: (operation === "worker-ready"
					? "ready"
					: operation === "activate-automatic"
						? "activate"
						: operation === "run-automatic"
							? "run"
							: "read") as "ready" | "activate" | "run" | "read",
				requestRef: `request-${Date.now()}`,
				issuedAt: new Date().toISOString(),
				expiresAt: new Date(Date.now() + 30_000).toISOString(),
			};
		},
	};
}
function automaticApp() {
	return createProductionSingleAgentTemplateReleaseAppV1({
		...input,
		templates: input.templates.map(
			() => automaticTemplate as NonNullable<typeof automaticTemplate>,
		),
		...{
			automaticPublication:
				automaticInput() as AutomaticTemplatePublicationInputV1,
		},
	});
}
function automaticRequest(
	app: ReturnType<typeof automaticApp>,
	command: string,
	body: unknown = { schemaVersion: 1 },
): Promise<Response> {
	return Promise.resolve(
		app.app.request(
			`/internal/ops/standard-template-releases/${automaticPublicationId}/${command}`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"Idempotency-Key": `auto-${command}`,
					"x-test-publication-service": "valid",
				},
				body: JSON.stringify(body),
			},
		),
	);
}

// Controlled identity and Registry transport qualify production assembly behavior, not real account acceptance.
describe("production single-Agent template release over real HTTP and PostgreSQL", () => {
	beforeAll(async () => {
		testDatabase = await startPostgresTestDatabase("template-release-536");
		await migratePlatformDatabase({ databaseUrl: testDatabase.databaseUrl });
		db = connectDatabase(testDatabase.databaseUrl, { max: 2 });
		input = {
			databaseUrl: testDatabase.databaseUrl,
			imageRepository: "registry.example.test/agents/codex",
			identity: {
				async resolve(request) {
					seenRequests.push(request);
					return actor;
				},
				async hydrateUsers() {
					return [];
				},
			},
			target,
			loadReleaseBinding: async () => ({
				schemaVersion: 1,
				revision: "deployment_1",
				target: bindingTarget,
				operatorIds: [...operators],
				...(releaseExpiresAt === undefined
					? {}
					: { expiresAt: releaseExpiresAt }),
			}),
			templateUpgrade: {
				releaseId: target.releaseId,
				templateId: target.templateId,
				expectedImageDigest: target.expectedImageDigest,
				targetImageDigest: target.targetImageDigest,
				loadReleaseBinding: async () => ({
					schemaVersion: 2,
					revision: "deployment_1",
					releaseId: target.releaseId,
					templateId: target.templateId,
					expectedImageDigest: target.expectedImageDigest,
					targetImageDigest: target.targetImageDigest,
					operatorIds: [...operators],
				}),
			},
			loadAuthorityContext: async () => ({
				schemaVersion: 1,
				users: [],
				organizationIds: [],
			}),
			registry: {
				endpoint: "https://registry.example.test",
				imageReferencePrefix: "registry.example.test/agents",
				admissionPolicyRef: "policy_1",
				fetch: async (request) => {
					await registryHook();
					if (registryMode === "unavailable")
						throw new Error("synthetic registry unavailable");
					const url = new URL(
						request instanceof Request ? request.url : request.toString(),
					);
					if (
						decodeURIComponent(url.pathname) ===
						`/v2/codex/manifests/${target.targetImageDigest}`
					)
						return new Response(
							registryMode === "wrong_manifest" ? "{}" : manifest,
							{
								headers: {
									"content-type": "application/vnd.oci.image.manifest.v1+json",
									"docker-content-digest": target.targetImageDigest,
								},
							},
						);
					if (
						decodeURIComponent(url.pathname) ===
						`/v2/codex/blobs/${configDigest}`
					)
						return new Response(config, {
							headers: {
								"content-type": "application/vnd.oci.image.config.v1+json",
							},
						});
					return new Response(null, { status: 404 });
				},
				policy: {
					authorize: async () =>
						registryMode === "denied"
							? ({ status: "rejected", reason: "policy_denied" } as never)
							: {
									status: "admitted",
									decisionRef: "decision_1",
									evaluatedAt: "2026-09-15T00:00:00Z",
								},
				},
			},
			templates: [
				{
					allowedEnvironmentKeys: ["LOG_LEVEL"],
					allowedSecretKeys: ["BOT_TOKEN", "MODEL_API_KEY"],
					platformManagedKeys: ["MODEL_API_KEY"],
					connectionEnabled: true,
					templateId: target.templateId,
					imageDigest: target.targetImageDigest,
					imageReference: `registry.example.test/agents/codex@${target.targetImageDigest}`,
				},
			],
			modelCatalog: {
				revision: "catalog_1",
				load: async () => {
					throw new Error("Publication must not resolve models");
				},
			},
			channelPolicy: { revision: "channels_1", bindings: [] },
		};
		await start();
	}, 60_000);
	beforeEach(async () => {
		actor = administrator;
		automaticApprover = administrator;
		automaticExpiresAt = new Date(Date.now() + 600_000).toISOString();
		const context = {
			sourceCommit: "a".repeat(40),
			clusterUid: "cluster-test",
			namespace: "agent-infra",
			namespaceUid: "namespace-test",
			installationId: "deployment-test",
		};
		const now = Date.now();
		const adopted = adoptTemplateValidationV2({
			candidate: {
				schemaVersion: 1,
				templateId: target.templateId,
				sourceCommit: context.sourceCommit,
				imageDigest: target.targetImageDigest,
				driver: "codex",
				configurationRevision: "catalog-2",
				status: "passed",
				evidenceKind: "real-runtime-model",
				executionId: "synthetic-validation-execution",
				modelId: "synthetic-model",
				validatedAt: now - 1_000,
				validUntil: now + 600_000,
			},
			context,
			adoptedAt: now,
			candidateFileSha256: "b".repeat(64),
			preflightFileSha256: "c".repeat(64),
		});
		const baseTemplate = input.templates.find(
			(template) => template.templateId === target.templateId,
		);
		if (!baseTemplate) throw new Error("standard fixture expected");
		automaticTemplate = {
			...baseTemplate,
			configurationRevision: "catalog-2",
			modelBinding: {
				templateId: target.templateId,
				imageDigest: target.targetImageDigest,
				driver: "codex",
				protocol: "openai-responses-v1",
			},
			validationContext: context,
			loadValidation: async () => adopted,
		};
		const readiness = await readTemplateReadiness(automaticTemplate);
		if (readiness.state !== "ready" || !readiness.revision)
			throw new Error("synthetic adoption fixture invalid");
		automaticValidationRef = readiness.revision;

		await db.unsafe("truncate platform.template_publications cascade");
		operators = [administrator.userId];
		bindingTarget = target;
		releaseExpiresAt = undefined;
		registryHook = async () => {};
		registryMode = "normal";
		seenRequests.length = 0;
		await db.unsafe(
			"truncate platform.audit_events,platform.outbox_items,platform.idempotency_records,platform.agent_management_history,platform.agent_availability,platform.agent_owners,platform.agent_configuration_revisions,platform.agent_applications,platform.agents cascade",
		);
		await db.unsafe(
			"insert into platform.agents(id,current_configuration_revision,authorization_revision,created_at) values($1,7,'authorization_9',now())",
			[original.agentId],
		);
		await db.unsafe(
			"insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,service_availability,desired_state,workload_revision,fence) values('application_01',$1,'owner_01','Agent','Synthetic publication test','available','trace_seed','request_seed',now(),11,1,'ready','running',1,1)",
			[original.agentId],
		);
		await db.unsafe(
			"insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,created_at,configuration) values($1,7,$2,now(),$3::text::jsonb)",
			[original.agentId, target.templateId, JSON.stringify(original)],
		);
		await db.unsafe(
			"insert into platform.agent_owners(agent_id,owner_id,created_at) values($1,'owner_01',now())",
			[original.agentId],
		);
	});
	afterAll(async () => {
		if (server) await stop();
		await db?.end();
		await testDatabase?.stop();
	});
	it.each([
		"2000-01-01T00:00:00Z",
		"9999-02-31T12:00:00Z",
		"2099-12-01T12:00:00",
	])(
		"rejects a closed or invalid deployment window %s without writing",
		async (deadline) => {
			releaseExpiresAt = deadline;
			const before = await snapshot();
			expect((await apply()).status).toBe(404);
			expect(await snapshot()).toEqual(before);
		},
	);
	it("rejects a deployment window removed during Registry admission", async () => {
		releaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
		registryHook = async () => {
			releaseExpiresAt = undefined;
		};
		const before = await snapshot();
		expect((await apply()).status).toBe(404);
		expect(await snapshot()).toEqual(before);
	});
	it("checks the current window when reading the original idempotent result", async () => {
		releaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
		expect((await apply()).status).toBe(202);
		const committed = await snapshot();
		expect((await apply()).status).toBe(202);
		releaseExpiresAt = "2000-01-01T00:00:00Z";
		expect((await apply()).status).toBe(404);
		expect(await snapshot()).toEqual(committed);
	});
	it("uses database time for a committed result when the API clock lags", async () => {
		releaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
		expect((await apply()).status).toBe(202);
		const before = await snapshot();
		const [row] = await db.unsafe(
			"select clock_timestamp() - interval '2 minutes' as deadline",
		);
		if (!(row?.deadline instanceof Date))
			throw new Error("expected PostgreSQL time");
		releaseExpiresAt = row.deadline.toISOString();
		// Simulate an application clock behind the database. Both Date.now() and new Date() use this instant.
		vi.useFakeTimers({
			toFake: ["Date"],
			now: row.deadline.getTime() - 60_000,
		});
		try {
			expect((await apply()).status).toBe(404);
		} finally {
			vi.useRealTimers();
		}
		expect(await snapshot()).toEqual(before);
	});
	it("enforces a deadline exposed by a deployment adapter getter", async () => {
		const app = createProductionSingleAgentTemplateReleaseAppV1({
			...input,
			loadReleaseBinding: async () =>
				Object.assign(
					Object.create({
						get expiresAt() {
							return "2000-01-01T00:00:00Z";
						},
					}),
					await input.loadReleaseBinding(),
				),
		});
		try {
			const result = await app.app.request(
				`/internal/ops/standard-template-releases/${target.releaseId}/apply`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"Idempotency-Key": "adapter-getter",
					},
					body: JSON.stringify({ schemaVersion: 1 }),
				},
			);
			expect(result.status).toBe(404);
		} finally {
			await app.close();
		}
	});
	it.each(["expired", "revoked", "shortened", "superseded"])(
		"rolls back all writes when the deployment approval is %s while the Agent is locked",
		async (change) => {
			const before = await snapshot();
			let pending: Promise<Response> | undefined;
			let restoreClock: (() => void) | undefined;
			try {
				await db.begin(async (transaction) => {
					const [lock] = await transaction.unsafe(
						"select pg_backend_pid() as pid from platform.agents where id=$1 for update",
						[original.agentId],
					);
					const [window] = await transaction.unsafe(
						"select clock_timestamp() + make_interval(secs => $1::int) as deadline",
						[change === "expired" ? 5 : 60],
					);
					if (
						!(window?.deadline instanceof Date) ||
						typeof lock?.pid !== "number"
					)
						throw new Error("expected PostgreSQL deadline and lock owner");
					releaseExpiresAt = window.deadline.toISOString();
					pending = apply();
					await vi.waitFor(
						async () => {
							const blocked = await db.unsafe(
								"select 1 from pg_stat_activity where $1::int = any(pg_blocking_pids(pid))",
								[lock.pid],
							);
							expect(blocked.length).toBeGreaterThan(0);
						},
						{ timeout: 4_000, interval: 25 },
					);
					switch (change) {
						case "expired": {
							// Keep the deployment reader's clock inside the window to exercise the independent database deadline.
							const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
							restoreClock = () => clock.mockRestore();
							await transaction.unsafe(
								"select pg_sleep(greatest(0, extract(epoch from ($1::timestamptz - clock_timestamp()))))",
								[releaseExpiresAt],
							);
							break;
						}
						case "revoked":
							operators = [];
							break;
						case "shortened":
							releaseExpiresAt = new Date(
								window.deadline.getTime() - 10_000,
							).toISOString();
							break;
						case "superseded":
							bindingTarget = { ...target, releaseId: "successor" };
							break;
					}
				});
				expect((await pending)?.status).toBe(404);
				expect(await snapshot()).toEqual(before);
			} finally {
				restoreClock?.();
				await pending;
			}
		},
		15_000,
	);
	it("prepares a durable automatic publication through the existing protected release namespace", async () => {
		const app = automaticApp();
		try {
			const response = await automaticRequest(app, "prepare-automatic");
			expect(response.status).toBe(202);
			expect(await response.json()).toMatchObject({
				schemaVersion: 1,
				publicationId: automaticPublicationId,
				status: "prepared",
			});
		} finally {
			await app.close();
		}
	});
	it("activates the original publication only after the Worker confirms the target catalog", async () => {
		const app = automaticApp();
		try {
			expect((await automaticRequest(app, "prepare-automatic")).status).toBe(
				202,
			);
			expect((await automaticRequest(app, "activate-automatic")).status).toBe(
				409,
			);
			expect(
				(
					await automaticRequest(app, "worker-ready", {
						schemaVersion: 1,
						catalogRevision: "catalog-2",
						templateId: target.templateId,
						targetImageDigest: target.targetImageDigest,
					})
				).status,
			).toBe(202);
			const activated = await automaticRequest(app, "activate-automatic");
			expect(activated.status).toBe(202);
			expect(await activated.json()).toMatchObject({ status: "active" });
			expect((await automaticRequest(app, "activate-automatic")).status).toBe(
				202,
			);
			const jobs = await db.unsafe(
				"select operation from platform.outbox_items where scope_type='template_publication'",
			);
			expect(jobs).toEqual([{ operation: "standard_template.publish.v1" }]);
		} finally {
			await app.close();
		}
	});
	it("automatically commits the new desired digest for a stopped Agent without impersonating the approver", async () => {
		await db.unsafe(
			"update platform.agent_applications set status='stopped',desired_state='stopped',service_availability=null where agent_id=$1",
			[original.agentId],
		);
		const app = automaticApp();
		const outbox = createPostgresOutboxStore({
			databaseUrl: testDatabase.databaseUrl,
		});
		try {
			expect((await automaticRequest(app, "prepare-automatic")).status).toBe(
				202,
			);
			expect(
				(
					await automaticRequest(app, "worker-ready", {
						schemaVersion: 1,
						catalogRevision: "catalog-2",
						templateId: target.templateId,
						targetImageDigest: target.targetImageDigest,
					})
				).status,
			).toBe(202);
			expect((await automaticRequest(app, "activate-automatic")).status).toBe(
				202,
			);
			const claim = await outbox.claim({
				itemId: `publication-${automaticPublicationId}`,
				leaseOwner: "publisher-test",
				leaseDurationMs: 60_000,
			});
			expect(claim).not.toBeNull();
			const response = await automaticRequest(app, "run-automatic", {
				schemaVersion: 1,
				itemId: claim?.itemId,
				leaseOwner: claim?.leaseOwner,
				deliveryFence: String(claim?.deliveryFence),
			});
			expect(response.status).toBe(202);
			expect(await response.json()).toMatchObject({
				counts: { applied: 1, rejected: 0 },
			});
			const result = await snapshot();
			expect(result.agent?.current_configuration_revision).toBe("8");
			const committed = result.revisions.at(-1)?.configuration as
				| typeof original
				| undefined;
			expect(committed?.source.imageDigest).toBe(target.targetImageDigest);
			expect({
				...committed,
				source: original.source,
				revision: original.revision,
			}).toEqual(original);
			expect(result.owners).toEqual([{ owner_id: "owner_01" }]);
			const [management] = await db.unsafe(
				"select status,desired_state,management_revision,fence from platform.agent_applications where agent_id=$1",
				[original.agentId],
			);
			expect(management).toEqual({
				status: "stopped",
				desired_state: "stopped",
				management_revision: "11",
				fence: "1",
			});
			const [audit] = await db.unsafe(
				"select actor_type,actor_id,details from platform.audit_events where agent_id=$1",
				[original.agentId],
			);
			expect(audit).toMatchObject({
				actor_type: "service",
				actor_id: "template-publisher",
				details: {
					approvedBy: administrator.userId,
					publicationId: automaticPublicationId,
				},
			});
		} finally {
			await app.close();
			await outbox.close();
		}
	});
	it("skips a previously released Agent while publishing to all 258 peers on other digests", async () => {
		// The operator switches this Agent through the manual V1 entry point before the catalog publishes the same image.
		expect((await apply()).status).toBe(202);
		const afterManualRelease = await snapshot();
		const records = Array.from({ length: 258 }, (_, i) => ({
			id: `auto-agent-${String(i).padStart(4, "0")}`,
			configuration: {
				...structuredClone(original),
				agentId: `auto-agent-${String(i).padStart(4, "0")}`,
				source: {
					...original.source,
					imageDigest:
						i % 2 === 0
							? original.source.imageDigest
							: `sha256:${"b".repeat(64)}`,
				},
			},
		}));
		await db.unsafe(
			"insert into platform.agents(id,current_configuration_revision,authorization_revision) select x->>'id',7,'authorization_9' from jsonb_array_elements($1::text::jsonb) x",
			[JSON.stringify(records)],
		);
		await db.unsafe(
			"insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,configuration,created_at) select x->>'id',7,$2,x->'configuration',now() from jsonb_array_elements($1::text::jsonb) x",
			[JSON.stringify(records), target.templateId],
		);
		await db.unsafe(
			"insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,management_revision,approval_revision,desired_state,workload_revision,fence) select 'app-'||(x->>'id'),x->>'id','owner_01','Synthetic Agent','Synthetic publication batch','stopped','trace-seed','request-seed',now(),11,1,'stopped',1,1 from jsonb_array_elements($1::text::jsonb) x",
			[JSON.stringify(records)],
		);
		await db.unsafe(
			"insert into platform.agent_owners(agent_id,owner_id,created_at) select x->>'id','owner_01',now() from jsonb_array_elements($1::text::jsonb) x",
			[JSON.stringify(records)],
		);
		const app = automaticApp();
		const outbox = createPostgresOutboxStore({
			databaseUrl: testDatabase.databaseUrl,
		});
		try {
			expect((await automaticRequest(app, "prepare-automatic")).status).toBe(
				202,
			);
			expect(
				(
					await automaticRequest(app, "worker-ready", {
						schemaVersion: 1,
						catalogRevision: "catalog-2",
						templateId: target.templateId,
						targetImageDigest: target.targetImageDigest,
					})
				).status,
			).toBe(202);
			expect((await automaticRequest(app, "activate-automatic")).status).toBe(
				202,
			);
			const lease = await outbox.claim({
				itemId: `publication-${automaticPublicationId}`,
				leaseOwner: "publisher-test",
				leaseDurationMs: 60_000,
			});
			expect(lease).not.toBeNull();
			let previous = 0;
			let finished = false;
			for (let i = 0; i < 5; i++) {
				const response = await automaticRequest(app, "run-automatic", {
					schemaVersion: 1,
					itemId: lease?.itemId,
					leaseOwner: lease?.leaseOwner,
					deliveryFence: String(lease?.deliveryFence),
				});
				expect(response.status).toBe(202);
				const result = TemplatePublicationStatusV1Schema.parse(
					await response.json(),
				);
				expect(result.counts.applied - previous).toBeLessThanOrEqual(256);
				previous = result.counts.applied;
				if (result.status === "completed") {
					finished = true;
					break;
				}
			}
			expect(finished).toBe(true);
			expect(previous).toBe(258);
			const afterCatalog = await snapshot();
			expect(afterCatalog.agent).toEqual(afterManualRelease.agent);
			expect(
				await db.unsafe(
					"select id from platform.template_publication_targets where publication_id=$1 and agent_id=$2",
					[automaticPublicationId, original.agentId],
				),
			).toEqual([]);
			expect(
				await db.unsafe(
					"select revision from platform.agent_configuration_revisions where agent_id=$1 order by revision",
					[original.agentId],
				),
			).toEqual([{ revision: "7" }, { revision: "8" }]);
			const [totals] = await db.unsafe(
				"select count(*)::int as count from platform.agents a join platform.agent_configuration_revisions c on c.agent_id=a.id and c.revision=a.current_configuration_revision where c.configuration->'source'->>'imageDigest'=$1",
				[target.targetImageDigest],
			);
			expect(totals?.count).toBe(259);
		} finally {
			await app.close();
			await outbox.close();
		}
	}, 30_000);
	it("preserves the original per-Agent result after losing the response and reclaiming the outbox", async () => {
		let app = automaticApp();
		const outbox = createPostgresOutboxStore({
			databaseUrl: testDatabase.databaseUrl,
		});
		try {
			await automaticRequest(app, "prepare-automatic");
			await automaticRequest(app, "worker-ready", {
				schemaVersion: 1,
				catalogRevision: "catalog-2",
				templateId: target.templateId,
				targetImageDigest: target.targetImageDigest,
			});
			await automaticRequest(app, "activate-automatic");
			const first = await outbox.claim({
				itemId: `publication-${automaticPublicationId}`,
				leaseOwner: "publisher-original",
				leaseDurationMs: 60_000,
			});
			expect(first).not.toBeNull();
			await automaticRequest(app, "run-automatic", {
				schemaVersion: 1,
				itemId: first?.itemId,
				leaseOwner: first?.leaseOwner,
				deliveryFence: String(first?.deliveryFence),
			});
			const before = await db.unsafe(
				"select actor_id,idempotency_key,request_digest,result from platform.idempotency_records order by id",
			);
			await app.close();
			app = automaticApp();
			await db.unsafe(
				"update platform.outbox_items set lease_expires_at=clock_timestamp()-interval '1 second' where scope_type='template_publication'",
			);
			const recovered = await outbox.claim({
				itemId: `publication-${automaticPublicationId}`,
				leaseOwner: "publisher-recovery",
				leaseDurationMs: 60_000,
			});
			expect(recovered?.deliveryFence).toBe(2n);
			const response = await automaticRequest(app, "run-automatic", {
				schemaVersion: 1,
				itemId: recovered?.itemId,
				leaseOwner: recovered?.leaseOwner,
				deliveryFence: String(recovered?.deliveryFence),
			});
			expect(response.status).toBe(202);
			expect(await response.json()).toMatchObject({
				status: "completed",
				counts: { applied: 1 },
			});
			expect(
				await db.unsafe(
					"select actor_id,idempotency_key,request_digest,result from platform.idempotency_records order by id",
				),
			).toEqual(before);
			expect((await snapshot()).agent?.current_configuration_revision).toBe(
				"8",
			);
		} finally {
			await app.close();
			await outbox.close();
		}
	});
	it("rejects lost operator qualification after Registry admission without publishing any new configuration", async () => {
		const app = automaticApp();
		const outbox = createPostgresOutboxStore({
			databaseUrl: testDatabase.databaseUrl,
		});
		try {
			await automaticRequest(app, "prepare-automatic");
			await automaticRequest(app, "worker-ready", {
				schemaVersion: 1,
				catalogRevision: "catalog-2",
				templateId: target.templateId,
				targetImageDigest: target.targetImageDigest,
			});
			await automaticRequest(app, "activate-automatic");
			const lease = await outbox.claim({
				itemId: `publication-${automaticPublicationId}`,
				leaseOwner: "publisher-test",
				leaseDurationMs: 60_000,
			});
			expect(lease).not.toBeNull();
			registryHook = async () => {
				operators = [];
			};
			const response = await automaticRequest(app, "run-automatic", {
				schemaVersion: 1,
				itemId: lease?.itemId,
				leaseOwner: lease?.leaseOwner,
				deliveryFence: String(lease?.deliveryFence),
			});
			expect(response.status).toBe(403);
			expect((await snapshot()).agent?.current_configuration_revision).toBe(
				"7",
			);
			expect((await snapshot()).keys).toHaveLength(0);
			const [saved] = await db.unsafe(
				"select status,target from platform.template_publication_targets",
			);
			expect(saved?.status).toBe("unknown");
		} finally {
			await app.close();
			await outbox.close();
		}
	});
	it("runs the persisted publication from the actual Worker with deployment-bound template configuration", async () => {
		await db.unsafe(
			"update platform.agent_applications set status='stopped',desired_state='stopped',service_availability=null where agent_id=$1",
			[original.agentId],
		);
		const app = automaticApp();
		const worker = createPlatformWorkloadWorkerV1({
			databaseUrl: testDatabase.databaseUrl,
			workerId: "publisher-workload",
			client: fakeKubernetesApi().client,
			policy: workloadTestPolicy,
			templateModelBindings: [
				{
					templateId: target.templateId,
					imageDigest: target.targetImageDigest,
					driver: "codex",
					protocol: "openai-responses-v1",
				},
			],
			registry: workloadRegistryFixture(),
			admissionPolicyRef: "policy-a",
			registrySubjectRef: "subject-a",
			decryptor: {
				decrypt: async () => ({
					outcome: "failed" as const,
					code: "SECRET_KEY_UNAVAILABLE" as const,
				}),
			},
			probeRuntime: async () => ({ core: "passed" as const, capabilities: {} }),
			pollIntervalMs: 20,
			log: () => {},
			...{
				automaticTemplatePublications: [
					{
						publicationId: automaticPublicationId,
						catalogRevision: "catalog-2",
						templateId: target.templateId,
						targetImageDigest: target.targetImageDigest,
						origin: "https://publication.test",
						request: async (request: Request) => {
							const headers = new Headers(request.headers);
							headers.set("x-test-publication-service", "valid");
							return app.app.fetch(new Request(request, { headers }));
						},
					},
				],
			},
		});
		try {
			expect((await automaticRequest(app, "prepare-automatic")).status).toBe(
				202,
			);
			worker.start();
			let activated = false;
			for (let i = 0; i < 40; i++) {
				const r = await automaticRequest(app, "activate-automatic");
				if (r.status === 202) {
					activated = true;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			expect(activated).toBe(true);
			let completed = false;
			for (let i = 0; i < 60; i++) {
				const r = await automaticRequest(app, "activate-automatic");
				if (
					r.status === 202 &&
					TemplatePublicationStatusV1Schema.parse(await r.json()).status ===
						"completed"
				) {
					completed = true;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			expect(completed).toBe(true);
			expect((await snapshot()).agent?.current_configuration_revision).toBe(
				"8",
			);
		} finally {
			await worker.stop();
			await app.close();
		}
	}, 15_000);
	it("rebases a determinate configuration CAS refusal while retaining the original target history", async () => {
		const app = automaticApp();
		const outbox = createPostgresOutboxStore({
			databaseUrl: testDatabase.databaseUrl,
		});
		try {
			await automaticRequest(app, "prepare-automatic");
			await automaticRequest(app, "worker-ready", {
				schemaVersion: 1,
				catalogRevision: "catalog-2",
				templateId: target.templateId,
				targetImageDigest: target.targetImageDigest,
			});
			await automaticRequest(app, "activate-automatic");
			const lease = await outbox.claim({
				itemId: `publication-${automaticPublicationId}`,
				leaseOwner: "publisher-test",
				leaseDurationMs: 60_000,
			});
			expect(lease).not.toBeNull();
			let competing = true;
			registryHook = async () => {
				if (competing) {
					competing = false;
					const changed = {
						...structuredClone(original),
						revision: 8,
						channels: [],
						channelRevision: "channels_2",
					};
					await db.unsafe(
						"insert into platform.agent_configuration_revisions(agent_id,revision,runtime_revision,source_reference,configuration,created_at) values($1,8,7,$2,$3::text::jsonb,now())",
						[original.agentId, target.templateId, JSON.stringify(changed)],
					);
					await db.unsafe(
						"update platform.agents set current_configuration_revision=8 where id=$1",
						[original.agentId],
					);
				}
			};
			const request = {
				schemaVersion: 1,
				itemId: lease?.itemId,
				leaseOwner: lease?.leaseOwner,
				deliveryFence: String(lease?.deliveryFence),
			};
			const refused = await automaticRequest(app, "run-automatic", request);
			expect(refused.status).toBe(202);
			expect(await refused.json()).toMatchObject({
				status: "partial",
				counts: { rejected: 1 },
			});
			const resumed = await automaticRequest(app, "run-automatic", request);
			expect(resumed.status).toBe(202);
			expect(await resumed.json()).toMatchObject({
				status: "completed",
				counts: { applied: 1, rejected: 0 },
			});
			const attempts = await db.unsafe(
				"select attempt,status from platform.template_publication_targets order by attempt",
			);
			expect(attempts).toEqual([
				{ attempt: 1, status: "rejected" },
				{ attempt: 2, status: "applied" },
			]);
			const current = (await snapshot()).revisions.at(-1)
				?.configuration as typeof original;
			expect(current.revision).toBe(9);
			expect(current.channels).toEqual([]);
		} finally {
			await app.close();
			await outbox.close();
		}
	});
	it("contains one Agent policy refusal without rolling back another Agent", async () => {
		const blocked = {
			...structuredClone(original),
			agentId: "blocked-agent",
			source: {
				...original.source,
				allowedEnvironmentKeys: ["LOG_LEVEL", "OLD_SWITCH"],
			},
		};
		await db.unsafe(
			"insert into platform.agents(id,current_configuration_revision,authorization_revision) values('blocked-agent',7,'authorization_9')",
		);
		await db.unsafe(
			"insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,configuration,created_at) values('blocked-agent',7,$1,$2::text::jsonb,now())",
			[target.templateId, JSON.stringify(blocked)],
		);
		const app = automaticApp();
		const outbox = createPostgresOutboxStore({
			databaseUrl: testDatabase.databaseUrl,
		});
		try {
			await automaticRequest(app, "prepare-automatic");
			await automaticRequest(app, "worker-ready", {
				schemaVersion: 1,
				catalogRevision: "catalog-2",
				templateId: target.templateId,
				targetImageDigest: target.targetImageDigest,
			});
			await automaticRequest(app, "activate-automatic");
			const lease = await outbox.claim({
				itemId: `publication-${automaticPublicationId}`,
				leaseOwner: "publisher-test",
				leaseDurationMs: 60_000,
			});
			const response = await automaticRequest(app, "run-automatic", {
				schemaVersion: 1,
				itemId: lease?.itemId,
				leaseOwner: lease?.leaseOwner,
				deliveryFence: String(lease?.deliveryFence),
			});
			expect(response.status).toBe(202);
			expect(await response.json()).toMatchObject({
				status: "partial",
				counts: { applied: 1, rejected: 1 },
			});
			const result = await db.unsafe(
				"select id,current_configuration_revision from platform.agents order by id",
			);
			expect(result).toEqual([
				{ id: original.agentId, current_configuration_revision: "8" },
				{ id: "blocked-agent", current_configuration_revision: "7" },
			]);
		} finally {
			await app.close();
			await outbox.close();
		}
	});
	it("authenticates the actual signed service request and rejects nonce replay or body tampering", async () => {
		const material = {
			issuer: "test-publisher-issuer",
			keyVersion: "key-1",
			principalRef: "template-publisher",
			deploymentRef: "deployment-test",
			publicationId: automaticPublicationId,
			key: randomBytes(32),
		};
		const app = createProductionSingleAgentTemplateReleaseAppV1({
			...input,
			templates: input.templates.map(
				() => automaticTemplate as NonNullable<typeof automaticTemplate>,
			),
			automaticPublication: {
				loadBinding: automaticInput().loadBinding,
				resolveAdministrator: automaticInput().resolveAdministrator,
				serviceAuthentication: { currentKey: async () => material },
			},
		});
		let saved: Request | undefined;
		const transport = createTemplatePublicationServiceTransportV1({
			currentKey: async () => material,
			fetch: async (request) => {
				saved = (request as Request).clone();
				return app.app.fetch(request as Request);
			},
		});
		try {
			expect((await automaticRequest(app, "prepare-automatic")).status).toBe(
				202,
			);
			const ready = new Request(
				`https://publication.test/internal/ops/standard-template-releases/${automaticPublicationId}/worker-ready`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						schemaVersion: 1,
						catalogRevision: "catalog-2",
						templateId: target.templateId,
						targetImageDigest: target.targetImageDigest,
					}),
				},
			);
			expect((await transport.request(ready)).status).toBe(202);
			expect(saved).toBeDefined();
			if (!saved) throw new Error("signed request was not captured");
			const replay = await app.app.fetch(saved.clone());
			expect(replay.status).toBe(403);
			const tampered = new Request(saved.url, {
				method: "POST",
				headers: saved.headers,
				body: JSON.stringify({
					schemaVersion: 1,
					privateCanary: "synthetic-private-body-canary",
				}),
			});
			const denied = await app.app.fetch(tampered);
			expect(denied.status).toBe(403);
			expect(await denied.text()).not.toContain(
				"synthetic-private-body-canary",
			);
			const [nonces] = await db.unsafe(
				"select count(*)::int as count from platform.template_publication_nonces",
			);
			expect(nonces?.count).toBe(1);
		} finally {
			await app.close();
		}
	});
	it("closes a revoked publication before dispatch and keeps the original target untouched", async () => {
		const app = automaticApp();
		const outbox = createPostgresOutboxStore({
			databaseUrl: testDatabase.databaseUrl,
		});
		try {
			await automaticRequest(app, "prepare-automatic");
			await automaticRequest(app, "worker-ready", {
				schemaVersion: 1,
				catalogRevision: "catalog-2",
				templateId: target.templateId,
				targetImageDigest: target.targetImageDigest,
			});
			await automaticRequest(app, "activate-automatic");
			const lease = await outbox.claim({
				itemId: `publication-${automaticPublicationId}`,
				leaseOwner: "publisher-test",
				leaseDurationMs: 60_000,
			});
			expect((await automaticRequest(app, "revoke-automatic")).status).toBe(
				202,
			);
			const response = await automaticRequest(app, "run-automatic", {
				schemaVersion: 1,
				itemId: lease?.itemId,
				leaseOwner: lease?.leaseOwner,
				deliveryFence: String(lease?.deliveryFence),
			});
			expect(response.status).toBe(403);
			expect((await snapshot()).agent?.current_configuration_revision).toBe(
				"7",
			);
			expect((await snapshot()).keys).toHaveLength(0);
		} finally {
			await app.close();
			await outbox.close();
		}
	});
	it("fences an older writer that tries to commit an old digest after catalog activation", async () => {
		const app = automaticApp();
		try {
			await automaticRequest(app, "prepare-automatic");
			await automaticRequest(app, "worker-ready", {
				schemaVersion: 1,
				catalogRevision: "catalog-2",
				templateId: target.templateId,
				targetImageDigest: target.targetImageDigest,
			});
			await automaticRequest(app, "activate-automatic");
			const legacy = { ...structuredClone(original), revision: 8 };
			await expect(
				db.unsafe(
					"insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,configuration,created_at) values($1,8,$2,$3::text::jsonb,now())",
					[original.agentId, target.templateId, JSON.stringify(legacy)],
				),
			).rejects.toMatchObject({ code: "23514" });
			expect((await snapshot()).agent?.current_configuration_revision).toBe(
				"7",
			);
		} finally {
			await app.close();
		}
	});
	it.each(["principalRef", "deploymentRef", "keyVersion"] as const)(
		"rejects a signed request with the wrong %s",
		async (field) => {
			const material = {
				issuer: "test-issuer",
				keyVersion: "key-1",
				principalRef: "template-publisher",
				deploymentRef: "deployment-test",
				publicationId: automaticPublicationId,
				key: randomBytes(32),
			};
			const app = createProductionSingleAgentTemplateReleaseAppV1({
				...input,
				templates: input.templates.map(
					() => automaticTemplate as NonNullable<typeof automaticTemplate>,
				),
				automaticPublication: {
					loadBinding: automaticInput().loadBinding,
					resolveAdministrator: automaticInput().resolveAdministrator,
					serviceAuthentication: { currentKey: async () => material },
				},
			});
			const transport = createTemplatePublicationServiceTransportV1({
				currentKey: async () => ({ ...material, [field]: "wrong-binding" }),
				fetch: async (request) => app.app.fetch(request as Request),
			});
			try {
				await automaticRequest(app, "prepare-automatic");
				const response = await transport.request(
					new Request(
						`https://publication.test/internal/ops/standard-template-releases/${automaticPublicationId}/worker-ready`,
						{
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({
								schemaVersion: 1,
								catalogRevision: "catalog-2",
								templateId: target.templateId,
								targetImageDigest: target.targetImageDigest,
							}),
						},
					),
				);
				expect(response.status).toBe(403);
				expect(await response.json()).toEqual({
					schemaVersion: 1,
					code: "TEMPLATE_PUBLICATION_UNAVAILABLE",
				});
				expect((await snapshot()).agent?.current_configuration_revision).toBe(
					"7",
				);
			} finally {
				await app.close();
			}
		},
	);
	it("publishes as a bound non-Owner admin and replays once after closing all assembly clients", async () => {
		const response = await apply();
		expect(response.status).toBe(202);
		const accepted = await response.json();
		expect(accepted).toEqual({
			schemaVersion: 1,
			agentId: original.agentId,
			configurationRevision: 8,
			changedFields: ["source"],
		});
		expect(seenRequests.length).toBeGreaterThanOrEqual(4);
		expect(new Set(seenRequests).size).toBe(1);
		const result = await snapshot();
		expect(result.agent).toEqual({
			current_configuration_revision: "8",
			authorization_revision: "authorization_9",
		});
		expect(result.revisions).toHaveLength(2);
		expect(result.outbox).toHaveLength(1);
		expect(result.audit).toHaveLength(1);
		expect(result.keys).toHaveLength(1);
		expect(result.owners).toEqual([{ owner_id: "owner_01" }]);
		expect(result.audit[0]).toMatchObject({
			actor_id: administrator.userId,
			action: "agent.configuration.revised",
		});
		const next = result.revisions[1]?.configuration as typeof original;
		expect({
			...next,
			source: original.source,
			revision: original.revision,
		}).toEqual(original);
		expect(next.source.imageDigest).toBe(target.targetImageDigest);
		await stop();
		await start();
		expect(await (await apply()).json()).toEqual(accepted);
		expect(await snapshot()).toEqual(result);
		operators = [];
		expect((await apply()).status).toBe(404);
		expect(await snapshot()).toEqual(result);
	});
	it("exposes additive V2 fan-out results while preserving the V1 route", async () => {
		const response = await fetch(
			`${origin}/internal/ops/standard-template-releases/${target.releaseId}/apply-all`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"Idempotency-Key": "upgrade_all_key",
				},
				body: JSON.stringify({ schemaVersion: 2 }),
			},
		);
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			schemaVersion: 2,
			releaseId: target.releaseId,
			templateId: target.templateId,
			status: "completed",
			targets: [
				{
					agentId: target.agentId,
					status: "applied",
					configurationRevision: 8,
					errorCode: null,
					compatibility: {
						status: "unknown",
						agentId: target.agentId,
						configurationRevision: 8,
						targetImageDigest: target.targetImageDigest,
						reasonCode: "target_metadata_missing",
					},
				},
			],
		});
		expect((await apply()).status).toBe(409);
	});
	it.each(["anonymous", "disabled", "employee", "owner", "unbound_admin"])(
		"rejects %s before writing",
		async (mode) => {
			actor =
				mode === "anonymous"
					? null
					: mode === "disabled"
						? { ...administrator, accountStatus: "disabled" }
						: mode === "employee" || mode === "owner"
							? {
									...administrator,
									userId: mode === "owner" ? "owner_01" : "employee",
									roles: ["employee"],
								}
							: administrator;
			if (mode === "unbound_admin") operators = [];
			expect((await apply()).status).toBe(
				mode === "anonymous" ? 401 : mode === "disabled" ? 403 : 404,
			);
			const result = await snapshot();
			expect(result.revisions).toHaveLength(1);
			expect(result.outbox).toHaveLength(0);
		},
	);
	it.each([
		{ actorId: "administrator" },
		{ role: "system_admin" },
		{ agentId: "other" },
		{ source: { kind: "standard" } },
		{ modelConfiguration: {} },
		{ environment: [] },
		{ secrets: [] },
		{ coOwnerIds: [] },
		{ intent: "standard_template.release_to_agent" },
	])("rejects extra caller-controlled fields %j", async (extra) => {
		expect((await apply({ schemaVersion: 1, ...extra })).status).toBe(400);
		expect((await snapshot()).revisions).toHaveLength(1);
	});
	it("rejects unknown release, target drift and ordinary route access", async () => {
		expect(
			(
				await apply(
					{ schemaVersion: 1 },
					"key",
					"/internal/ops/standard-template-releases/other/apply",
				)
			).status,
		).toBe(404);
		bindingTarget = { ...target, agentId: "other" };
		expect((await apply()).status).toBe(404);
		expect(
			(
				await fetch(
					`${origin}/api/v2/agents/${original.agentId}/configuration`,
					{ method: "PUT" },
				)
			).status,
		).toBe(404);
	});
	it.each(["revoked", "disabled", "identity_revision"])(
		"rejects %s while waiting for Registry",
		async (mode) => {
			registryHook = async () => {
				if (mode === "revoked") operators = [];
				else
					actor = {
						...administrator,
						...(mode === "disabled"
							? { accountStatus: "disabled" as const }
							: { authorizationRevision: "identity_2" }),
					};
			};
			expect((await apply()).status).toBe(404);
			expect((await snapshot()).revisions).toHaveLength(1);
		},
	);
	it.each(["unavailable", "wrong_manifest", "denied"] as const)(
		"rejects Registry %s",
		async (mode) => {
			registryMode = mode;
			expect([409, 503]).toContain((await apply()).status);
			expect((await snapshot()).outbox).toHaveLength(0);
		},
	);
	it("rejects different deployment release content with the same actor/key after restart", async () => {
		expect((await apply()).status).toBe(202);
		const prior = await snapshot();
		const changed = { ...target, releaseId: "release_other" };
		await stop();
		bindingTarget = changed;
		await start({ target: changed });
		try {
			expect(
				(
					await apply(
						{ schemaVersion: 1 },
						"release_key",
						"/internal/ops/standard-template-releases/release_other/apply",
					)
				).status,
			).toBe(409);
			expect(await snapshot()).toEqual(prior);
		} finally {
			await stop();
			bindingTarget = target;
			await start();
		}
	});
	it("does not expose another operator's replay or create a second revision with a fresh key", async () => {
		expect((await apply()).status).toBe(202);
		const previous = await snapshot();
		expect((await apply({ schemaVersion: 1 }, "different_key")).status).toBe(
			409,
		);
		actor = { ...administrator, userId: "second_operator" };
		operators = [administrator.userId, "second_operator"];
		expect((await apply()).status).toBe(409);
		expect(await snapshot()).toEqual(previous);
	});
	it("rejects malformed JSON, wrong version and query-supplied targeting", async () => {
		const malformed = await fetch(
			`${origin}/internal/ops/standard-template-releases/${target.releaseId}/apply`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"Idempotency-Key": "malformed",
				},
				body: "{",
			},
		);
		expect(malformed.status).toBe(400);
		expect((await apply({ schemaVersion: 2 })).status).toBe(400);
		expect(
			(
				await apply(
					{ schemaVersion: 1 },
					"query",
					`/internal/ops/standard-template-releases/${target.releaseId}/apply?agentId=other`,
				)
			).status,
		).toBe(400);
		expect((await snapshot()).keys).toHaveLength(0);
	});
	it("rejects Agent authorization competition before commit", async () => {
		registryHook = async () => {
			registryHook = async () => {};
			await db.unsafe(
				"update platform.agents set authorization_revision='authorization_10' where id=$1",
				[original.agentId],
			);
		};
		expect((await apply()).status).toBe(409);
		expect((await snapshot()).keys).toHaveLength(0);
	});
	it("detects config competition with Store CAS after Registry waits", async () => {
		registryHook = async () => {
			registryHook = async () => {};
			await db.unsafe(
				"insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,created_at,configuration) values($1,8,$2,now(),$3::text::jsonb)",
				[
					original.agentId,
					target.templateId,
					JSON.stringify({ ...original, revision: 8 }),
				],
			);
			await db.unsafe(
				"update platform.agents set current_configuration_revision=8 where id=$1",
				[original.agentId],
			);
		};
		expect((await apply()).status).toBe(409);
		const result = await snapshot();
		expect(result.revisions).toHaveLength(2);
		expect(result.keys).toHaveLength(0);
		expect(result.outbox).toHaveLength(0);
	});
	it("rolls back configuration, idempotency, audit and outbox together on failure", async () => {
		await db.unsafe(
			"create function platform.fail_release_outbox() returns trigger language plpgsql as $$ begin raise exception 'injected release failure'; end $$",
		);
		await db.unsafe(
			"create trigger fail_release_outbox before insert on platform.outbox_items for each row execute function platform.fail_release_outbox()",
		);
		try {
			expect((await apply()).status).toBe(503);
			const result = await snapshot();
			expect(result.revisions).toHaveLength(1);
			expect(result.keys).toHaveLength(0);
			expect(result.audit).toHaveLength(0);
			expect(result.outbox).toHaveLength(0);
		} finally {
			await db.unsafe(
				"drop trigger fail_release_outbox on platform.outbox_items",
			);
			await db.unsafe("drop function platform.fail_release_outbox()");
		}
	});
	it("keeps ordinary persisted Owner authority unavailable to non-Owner administrators", async () => {
		const query = new PostgresAgentConfigurationQueryV1({
			databaseUrl: testDatabase.databaseUrl,
		});
		try {
			expect(
				await query.readAuthority({
					agentId: original.agentId,
					actorId: administrator.userId,
					organizationIds: [],
					isAdministrator: true,
				}),
			).toEqual({ outcome: "unavailable" });
			expect(
				await query.readStandardTemplateReleaseAuthority({
					agentId: original.agentId,
					templateId: "wrong",
				}),
			).toEqual({ outcome: "unavailable" });
		} finally {
			await query.close();
		}
	});
});
vi.setConfig({ testTimeout: 30_000 });
