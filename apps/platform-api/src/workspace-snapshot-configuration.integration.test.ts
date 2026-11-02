import { createHash, randomUUID } from "node:crypto";
import {
	AgentApplicationProjectionV2Schema,
	AgentProjectionV2Schema,
} from "@agent-infra/contracts/pilot";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { createPlatformHealthApp } from "./app.js";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";
import { registerV2ConfigurationRoutes } from "./http/v2-configuration-routes.js";
import { registerV2ManagementRoutes } from "./http/v2-management-routes.js";

let database: PostgresTestDatabase;
let db: ReturnType<typeof postgres>;
let assembly: PlatformApiAssembly;
const app = createPlatformHealthApp();
const ownerId = randomUUID();
const identity = {
	schemaVersion: 1 as const,
	userId: ownerId,
	displayName: "Synthetic owner",
	accountStatus: "active" as const,
	organizationIds: [],
	roles: ["employee" as const],
	authorizationRevision: "auth-1",
};
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const source = (snapshotId: string) => ({
	kind: "custom" as const,
	imageReference: "registry.test/custom:v1",
	interactionMode: "self-managed" as const,
	identityResponsibility: "self-managed" as const,
	workspaceSnapshots: [{ snapshotId, name: "repo" }],
});
beforeAll(async () => {
	const url = process.env.WORKSPACE_SNAPSHOT_TEST_DATABASE_URL;
	if (url) {
		const parsed = new URL(url);
		if (
			parsed.hostname !== "127.0.0.1" ||
			!/^\/snapshot_test_[a-z0-9_]+$/.test(parsed.pathname)
		)
			throw new Error("Expected isolated snapshot test database");
		database = {
			databaseUrl: url,
			containerName: "local-snapshot-test",
			stop: async () => {},
		};
	} else
		database = await startPostgresTestDatabase(
			"snapshot-configuration-http-3871",
		);
	await migratePlatformDatabase(database);
	db = postgres(database.databaseUrl, { max: 4 });
	const unused = async () => {
		throw new Error("Unrelated adapter unexpectedly called");
	};
	assembly = assemblePlatformApi({
		databaseUrl: database.databaseUrl,
		taskAdmissionPolicy: {
			maximumWaitingTasksPerAgent: 2,
			waitingTimeoutMs: 60_000,
		},
		identity: {
			resolve: async () => identity,
			hydrateUsers: async (ids) =>
				ids.map((userId) => ({
					userId,
					displayName: "Synthetic",
					roles: ["employee" as const],
				})),
			resolveUser: async (userId) => ({
				schemaVersion: 1,
				userId,
				accountStatus: "active",
				organizationIds: [],
				authorizationRevision: "auth-1",
			}),
		},
		admissions: {
			authorizationAdmission: {
				async authorize(input) {
					const [agent] =
						await db`select authorization_revision from platform.agents where id=${input.agentId}`;
					return {
						schemaVersion: 1,
						status: "admitted",
						agentId: input.agentId,
						actorId: input.actorId,
						authorizationRevision: agent?.authorization_revision ?? "auth-1",
						authorityContext: {
							schemaVersion: 1,
							users: [{ userId: ownerId, accountStatus: "active" }],
							organizationIds: [],
						},
					};
				},
			},
			imageAdmission: {
				async admitImage(input) {
					if (
						input.requested.kind !== "custom" ||
						"manifest" in input.requested
					)
						throw new Error("Expected custom image");
					return {
						schemaVersion: 1,
						status: "admitted",
						agentId: input.agentId,
						requestId: input.requestId,
						source: {
							kind: "custom",
							interactionMode: "self-managed",
							identityResponsibility: "self-managed",
							imageDigest: `sha256:${hash(input.requested.imageReference)}`,
							admissionRevision: "image-1",
							connectionEnabled: false,
							...(input.requested.workspaceSnapshots === undefined
								? {}
								: { workspaceSnapshots: input.requested.workspaceSnapshots }),
						},
					};
				},
			},
			modelAdmission: { admitModels: unused },
			secretAdmission: {
				async admitSecrets(input) {
					return {
						schemaVersion: 1,
						status: "admitted",
						agentId: input.agentId,
						requestId: input.requestId,
						secrets: [],
					};
				},
			},
			channelAdmission: {
				async admitChannels(input) {
					return {
						schemaVersion: 1,
						status: "admitted",
						agentId: input.agentId,
						requestId: input.requestId,
						channels: [],
						channelRevision: "channel-1",
					};
				},
			},
		},
		allocateApplicationIds: unused,
		prepareApplicationSecrets: unused,
		prepareConfigurationSecrets: unused,
		presentAgent: async ({ configuration }) => ({
			source: {
				kind: "custom",
				imageReference: "registry.test/custom:v1",
				interactionMode: "self-managed",
				identityResponsibility: "self-managed",
				...(configuration.source.kind === "custom" &&
				configuration.source.workspaceSnapshots !== undefined
					? { workspaceSnapshots: [...configuration.source.workspaceSnapshots] }
					: {}),
			},
			resourceProfile: {
				profileId: "small",
				displayName: "Small",
				estimatedResources: {
					cpuMillicores: 100,
					memoryMiB: 128,
					storageGiB: 1,
				},
			},
			modelOptions: [],
			channels: [{ kind: "web", status: "available" }],
			capabilities: {
				modelSelection: false,
				attachments: false,
				resultFiles: false,
				connection: false,
				supplementaryInstruction: false,
			},
			interactionUrl: null,
		}),
	});
	registerV2ConfigurationRoutes(app, assembly.dependencies.configuration);
	registerV2ManagementRoutes(app, assembly.dependencies.management);
}, 120_000);
afterAll(async () => {
	await assembly?.close();
	await db?.end();
	await database?.stop();
});

async function snapshot(userId: string) {
	const id = randomUUID();
	await db`insert into platform.workspace_snapshots(id,owner_type,owner_id,digest,size_bytes,unpacked_size_bytes,file_count,media_type,source,object_ref,object_version,status)
	values(${id},'user',${userId},${`sha256:${hash(id)}`},8,8,1,'application/x-tar+gzip','{"kind":"direct-upload"}',${randomUUID()},'1','ready')`;
	return id;
}
async function createAgent(snapshotId: string) {
	const agentId = randomUUID();
	const applicationId = randomUUID();
	const metadata = {
		idempotencyKey: randomUUID(),
		requestId: randomUUID(),
		traceId: randomUUID(),
	};
	await assembly.dependencies.management.foundation.submit(
		{
			schemaVersion: 2,
			agentId,
			applicationId,
			name: "Snapshot Agent",
			description: "Synthetic",
			source: source(snapshotId),
			coOwnerIds: [],
			availability: [],
			environment: [],
			secrets: [],
			channels: [],
			...metadata,
		},
		{ schemaVersion: 1, userId: ownerId, rawRequestDigest: hash(agentId) },
	);
	// The config endpoint manages admitted Agents; approval itself is outside this test.
	const applicationRead = await app.request(
		`/api/v2/agent-applications/${applicationId}`,
	);
	expect(applicationRead.status, await applicationRead.clone().text()).toBe(
		200,
	);
	expect(
		AgentApplicationProjectionV2Schema.parse(await applicationRead.json())
			.source,
	).toMatchObject({
		workspaceSnapshots: [{ snapshotId, name: "repo" }],
	});
	await db`update platform.agent_applications set status='creating', approval_revision=1, management_revision=1,
		desired_state='running', workload_revision=1, fence=1 where agent_id=${agentId}`;
	return agentId;
}
function update(
	agentId: string,
	bindings: { snapshotId: string; name: string }[],
) {
	return app.request(`/api/v2/agents/${agentId}/configuration`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": randomUUID(),
			Cookie: "synthetic-session",
		},
		body: JSON.stringify({
			schemaVersion: 2,
			source: { ...source("unused"), workspaceSnapshots: bindings },
		}),
	});
}

it("uses the assembled V2 reader and real configuration transaction for attach, replace and unbind", async () => {
	const first = await snapshot(ownerId);
	const next = await snapshot(ownerId);
	const agentId = await createAgent(first);
	const response = await update(agentId, [
		{ snapshotId: next, name: "source" },
	]);
	expect(response.status, await response.clone().text()).toBe(200);
	const projected = AgentProjectionV2Schema.parse(await response.json());
	expect(projected.source).toMatchObject({
		workspaceSnapshots: [{ snapshotId: next, name: "source" }],
	});
	const read = await app.request(`/api/v2/agents/${agentId}`);
	expect(read.status, await read.clone().text()).toBe(200);
	expect(AgentProjectionV2Schema.parse(await read.json())).toMatchObject({
		source: { workspaceSnapshots: [{ snapshotId: next, name: "source" }] },
		managementRevision: 1,
	});
	const [row] =
		await db`select configuration from platform.agent_configuration_revisions where agent_id=${agentId} and revision=2`;
	expect(row?.configuration.source.workspaceSnapshots).toEqual([
		{ snapshotId: next, name: "source" },
	]);
	expect(
		await db`select snapshot_id from platform.workspace_snapshot_bindings where agent_id=${agentId} and configuration_revision=2`,
	).toEqual([{ snapshot_id: next }]);
	const unbound = await update(agentId, []);
	expect(unbound.status, await unbound.clone().text()).toBe(200);
	expect(
		AgentProjectionV2Schema.parse(await unbound.json()).source,
	).toMatchObject({ workspaceSnapshots: [] });
	expect(
		await db`select snapshot_id from platform.workspace_snapshot_bindings where agent_id=${agentId} and configuration_revision=3`,
	).toEqual([]);
});
it("rejects a foreign snapshot without advancing or partially binding the Agent", async () => {
	const agentId = await createAgent(await snapshot(ownerId));
	const foreign = await snapshot(randomUUID());
	const refused = await update(agentId, [
		{ snapshotId: foreign, name: "foreign" },
	]);
	expect(refused.status).toBeGreaterThanOrEqual(400);
	expect(await refused.text()).not.toContain(foreign);
	const [agent] =
		await db`select current_configuration_revision from platform.agents where id=${agentId}`;
	expect(Number(agent?.current_configuration_revision)).toBe(1);
	expect(
		await db`select snapshot_id from platform.workspace_snapshot_bindings where agent_id=${agentId} and configuration_revision=2`,
	).toEqual([]);
});
