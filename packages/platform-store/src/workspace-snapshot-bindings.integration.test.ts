import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	type AgentConfigurationRecord,
	type AgentConfigurationWritePlanV1,
	createAgentApiCreationV1,
	createAgentConfigurationUseCaseV1,
	createApplicationFoundationUseCaseV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAgentConfigurationQueryV1 } from "./agent-configuration.query.js";
import { PostgresAgentConfigurationTransactionV1 } from "./agent-configuration.transaction.js";
import { PostgresApplicationFoundationTransactionV1 } from "./application-foundation.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import { PostgresWorkspaceSnapshotBindingStoreV1 } from "./workspace-snapshot-bindings.js";
import { PostgresWorkspaceSnapshotStoreV1 } from "./workspace-snapshots.js";

let database: PostgresTestDatabase;
let db: ReturnType<typeof postgres>;
let foundation: PostgresApplicationFoundationTransactionV1;
let updates: PostgresAgentConfigurationTransactionV1;
let query: PostgresAgentConfigurationQueryV1;
let bindings: PostgresWorkspaceSnapshotBindingStoreV1;
let metadataStore: PostgresWorkspaceSnapshotStoreV1;
const users = ["owner", "coowner", "same-id", "app-responsible"];
const principal = { kind: "application" as const, id: "same-id" };
const authority = {
	schemaVersion: 1 as const,
	users: users.map((userId) => ({ userId, accountStatus: "active" as const })),
	organizationIds: [],
};
const directory = {
	resolveUser: async (userId: string) => ({
		schemaVersion: 1,
		userId,
		accountStatus: "active",
		organizationIds: [],
		authorizationRevision: "directory-1",
	}),
};
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const admissions: Omit<
	Parameters<typeof createApplicationFoundationUseCaseV1>[0],
	"transaction"
> = {
	authorizationAdmission: {
		async authorize(input) {
			const [agent] =
				await db`select authorization_revision from platform.agents where id=${input.agentId}`;
			return {
				schemaVersion: 1,
				status: "admitted",
				agentId: input.agentId,
				actorId: input.actorId,
				authorizationRevision: agent?.authorization_revision ?? "authority-1",
				authorityContext: authority,
			};
		},
	},
	imageAdmission: {
		async admitImage(input) {
			if (input.requested.kind !== "custom")
				throw new Error("Expected custom source");
			const requested = input.requested;
			const digest = `sha256:${hash("manifest" in requested ? requested.manifest : requested.imageReference)}`;
			const source =
				"manifest" in requested
					? {
							...requested,
							imageDigest: digest,
							admissionRevision: "image-1",
							connectionEnabled: false as const,
						}
					: {
							kind: "custom" as const,
							imageDigest: digest,
							admissionRevision: "image-1",
							interactionMode: requested.interactionMode,
							...(requested.interactionMode === "self-managed"
								? { identityResponsibility: requested.identityResponsibility }
								: {}),
							...(requested.workspaceSnapshots === undefined
								? {}
								: { workspaceSnapshots: requested.workspaceSnapshots }),
							connectionEnabled: false,
						};
			return {
				schemaVersion: 1,
				status: "admitted",
				agentId: input.agentId,
				requestId: input.requestId,
				source,
				...("manifest" in requested
					? {
							manifestBinding: {
								requestedSha256: hash(requested.manifest),
								canonicalSha256: hash(requested.manifest),
							},
						}
					: {}),
			};
		},
	},
	modelAdmission: {
		async admitModels() {
			throw new Error("Custom snapshots do not admit model credentials");
		},
	},
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
				channelRevision: "channels-1",
			};
		},
	},
};

beforeAll(async () => {
	const supplied = process.env.WORKSPACE_SNAPSHOT_TEST_DATABASE_URL;
	if (supplied) {
		const url = new URL(supplied);
		if (
			url.hostname !== "127.0.0.1" ||
			!/^\/snapshot_test_[a-z0-9_]+$/.test(url.pathname)
		)
			throw new Error("Expected isolated snapshot test database");
		const admin = postgres(supplied, { max: 1 });
		const name = `snapshot_test_bindings_${randomUUID().replaceAll("-", "")}`;
		await admin.unsafe(`create database "${name}"`);
		url.pathname = `/${name}`;
		database = {
			databaseUrl: url.href,
			containerName: name,
			stop: async () => {
				await admin.unsafe(`drop database "${name}"`);
				await admin.end();
			},
		};
	} else
		database = await startPostgresTestDatabase(
			"workspace-snapshot-bindings-3871",
		);
	await migratePlatformDatabase(database);
	db = postgres(database.databaseUrl, { max: 4 });
	foundation = new PostgresApplicationFoundationTransactionV1({
		databaseUrl: database.databaseUrl,
		userDirectory: directory,
		apiCreation: {
			allowedPrincipals: [principal],
			loadAuthorityContext: async () => authority,
		},
	});
	updates = new PostgresAgentConfigurationTransactionV1(database);
	query = new PostgresAgentConfigurationQueryV1(database);
	bindings = new PostgresWorkspaceSnapshotBindingStoreV1(database.databaseUrl);
	metadataStore = new PostgresWorkspaceSnapshotStoreV1(database.databaseUrl);
}, 120_000);
afterAll(async () => {
	await bindings?.close();
	await metadataStore?.close();
	await query?.close();
	await updates?.close();
	await foundation?.close();
	await db?.end();
	await database?.stop();
});

async function snapshot(ownerType = "user", ownerId = "owner", sizeBytes = 8) {
	const id = randomUUID();
	const digest = `sha256:${hash(id)}`;
	await db`insert into platform.workspace_snapshots (id,owner_type,owner_id,digest,size_bytes,unpacked_size_bytes,file_count,media_type,source,object_ref,object_version,status)
	values (${id},${ownerType},${ownerId},${digest},${sizeBytes},${sizeBytes},1,'application/x-tar+gzip','{"kind":"direct-upload"}',${randomUUID()},'1','ready')`;
	return { id, digest, sizeBytes };
}
function source(snapshotId: string, manifest?: string) {
	const common = {
		kind: "custom" as const,
		interactionMode: "self-managed" as const,
		identityResponsibility: "self-managed" as const,
		workspaceSnapshots: [{ snapshotId, name: "repo" }],
	};
	return manifest
		? { ...common, manifest }
		: { ...common, imageReference: "synthetic.test/custom:v1" };
}
function command(snapshotId: string, actorId = "owner", manifest?: string) {
	const agentId = randomUUID();
	return {
		schemaVersion: 2 as const,
		agentId,
		applicationId: randomUUID(),
		name: "Synthetic snapshot Agent",
		description: "Synthetic",
		source: source(snapshotId, manifest),
		coOwnerIds: ["coowner"].filter((id) => id !== actorId),
		availability: [],
		environment: [],
		secrets: [],
		channels: [],
		idempotencyKey: randomUUID(),
		requestId: randomUUID(),
		traceId: randomUUID(),
	};
}
async function create(
	snapshotId: string,
	actorId = "owner",
	manifest?: string,
) {
	const input = command(snapshotId, actorId, manifest);
	const result = await createApplicationFoundationUseCaseV1({
		transaction: foundation,
		...admissions,
	}).submit(input, {
		schemaVersion: 1,
		userId: actorId,
		rawRequestDigest: hash(input.agentId),
	});
	return { result, input };
}
async function current(agentId: string): Promise<AgentConfigurationRecord> {
	const [row] =
		await db`select c.configuration from platform.agents a join platform.agent_configuration_revisions c on c.agent_id=a.id and c.revision=a.current_configuration_revision where a.id=${agentId}`;
	if (!row?.configuration) throw new Error("Expected persisted configuration");
	return row.configuration;
}
const coreUpdates = () =>
	createAgentConfigurationUseCaseV1({ transaction: updates, ...admissions });
const actor = (actorId = "owner") => ({
	schemaVersion: 1 as const,
	actorId,
	rawRequestDigest: hash(actorId),
});
const metadata = () => ({
	idempotencyKey: randomUUID(),
	requestId: randomUUID(),
	traceId: randomUUID(),
});
async function projection(agentId: string, actorId = "owner") {
	return query.read({
		agentId,
		actorId,
		organizationIds: [],
		isAdministrator: false,
		intent: "manage",
	});
}
async function rows(agentId: string) {
	return db`select snapshot_id,configuration_revision,name,digest,size_bytes from platform.workspace_snapshot_bindings where agent_id=${agentId} order by configuration_revision,name`;
}

async function rejectBindingWrites() {
	await db.unsafe(
		"create function platform.reject_snapshot_binding() returns trigger language plpgsql as $$ begin raise exception 'synthetic binding failure'; end $$",
	);
	await db.unsafe(
		"create trigger reject_snapshot_binding before insert on platform.workspace_snapshot_bindings for each row execute function platform.reject_snapshot_binding()",
	);
	return async () => {
		await db.unsafe(
			"drop trigger reject_snapshot_binding on platform.workspace_snapshot_bindings",
		);
		await db.unsafe("drop function platform.reject_snapshot_binding()");
	};
}

describe("workspace snapshot bindings on real configuration transactions", () => {
	it("persists initial user bindings and projects them after decoding the saved configuration", async () => {
		const value = await snapshot();
		const { result } = await create(value.id);
		expect(await rows(result.agentId)).toEqual([
			{
				snapshot_id: value.id,
				configuration_revision: "1",
				name: "repo",
				digest: value.digest,
				size_bytes: "8",
			},
		]);
		expect(await projection(result.agentId)).toMatchObject({
			outcome: "found",
			configuration: {
				source: {
					workspaceSnapshots: [{ snapshotId: value.id, name: "repo" }],
				},
			},
		});
	});
	it("rolls back Agent, revision, bindings and receipt when initial attachment fails", async () => {
		const value = await snapshot();
		const input = command(value.id);
		const restore = await rejectBindingWrites();
		try {
			await expect(
				createApplicationFoundationUseCaseV1({
					transaction: foundation,
					...admissions,
				}).submit(input, {
					schemaVersion: 1,
					userId: "owner",
					rawRequestDigest: hash(input.agentId),
				}),
			).rejects.toBeDefined();
		} finally {
			await restore();
		}
		expect(
			await db`select id from platform.agents where id=${input.agentId}`,
		).toEqual([]);
		expect(await rows(input.agentId)).toEqual([]);
		expect(
			await db`select id from platform.idempotency_records where scope_id=${input.agentId}`,
		).toEqual([]);
	});
	it("rejects a same-ID application's snapshot in the user creation path", async () => {
		const value = await snapshot("application", "same-id");
		const input = command(value.id, "same-id");
		await expect(
			createApplicationFoundationUseCaseV1({
				transaction: foundation,
				...admissions,
			}).submit(input, {
				schemaVersion: 1,
				userId: "same-id",
				rawRequestDigest: hash(input.agentId),
			}),
		).rejects.toBeDefined();
		expect(
			await db`select id from platform.agents where id=${input.agentId}`,
		).toEqual([]);
		expect(await rows(input.agentId)).toEqual([]);
	});
	it("binds API application uploads to the actual application creator, never its human Owner", async () => {
		const material = `papi_${randomBytes(32).toString("base64url")}`;
		await db`insert into platform.platform_applications (id,name,responsible_user_id,status,authorization_revision) values ('same-id','Synthetic app','app-responsible','active','app-1') on conflict do nothing`;
		await db`insert into platform.platform_api_credentials (id,principal_type,principal_id,credential_hash,scopes) values (${randomUUID()},'application','same-id',${hash(material)},'["agent:create"]')`;
		const api = createAgentApiCreationV1({
			transaction: foundation,
			admissions,
		});
		const upload = await snapshot("application", "same-id");
		const body = {
			schemaVersion: 2,
			name: "Synthetic app Agent",
			description: "Synthetic",
			source: source(upload.id),
			coOwnerIds: [],
			availability: [],
			environment: [],
			secrets: [],
			...metadata(),
		};
		const created = await api.create(body, material);
		expect(await rows(created.agentId)).toMatchObject([
			{ snapshot_id: upload.id, digest: upload.digest },
		]);
		expect(
			await db`select owner_id from platform.agent_owners where agent_id=${created.agentId}`,
		).toEqual([{ owner_id: "app-responsible" }]);
		const userUpload = await snapshot("user", "same-id");
		await expect(
			api.create(
				{ ...body, source: source(userUpload.id), ...metadata() },
				material,
			),
		).rejects.toBeDefined();
		expect(
			await db`select snapshot_id from platform.workspace_snapshot_bindings where snapshot_id=${userUpload.id}`,
		).toEqual([]);
	});
	it.each([undefined, "synthetic manifest one"])(
		"preserves immutable snapshots during dedicated upgrade (%s)",
		async (manifest) => {
			const value = await snapshot();
			const { result } = await create(value.id, "owner", manifest);
			if (manifest)
				await coreUpdates().upgradeCustomManifest(
					{
						schemaVersion: 1,
						agentId: result.agentId,
						manifest: "synthetic manifest two",
						...metadata(),
					},
					actor("coowner"),
				);
			else
				await coreUpdates().upgradeCustomImage(
					{
						schemaVersion: 1,
						agentId: result.agentId,
						imageReference: "synthetic.test/custom:v2",
						...metadata(),
					},
					actor("coowner"),
				);
			expect((await current(result.agentId)).source).toMatchObject({
				workspaceSnapshots: [{ snapshotId: value.id, name: "repo" }],
			});
			expect(
				await db`select action, details from platform.audit_events where target_id=${value.id} and action='workspace.snapshot.bound'`,
			).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						action: "workspace.snapshot.bound",
						details: expect.objectContaining({
							agentId: result.agentId,
							name: "repo",
							digest: value.digest,
						}),
					}),
				]),
			);
			expect(await rows(result.agentId)).toHaveLength(2);
			expect((await rows(result.agentId)).map((row) => row.digest)).toEqual([
				value.digest,
				value.digest,
			]);
		},
	);
	it("copies bindings on unrelated revisions after owner handoff, and does not duplicate same-revision access writes", async () => {
		const value = await snapshot();
		const { result } = await create(value.id);
		await db`delete from platform.agent_owners where agent_id=${result.agentId} and owner_id='owner'`;
		await coreUpdates().update(
			{
				schemaVersion: 2,
				agentId: result.agentId,
				changes: { environment: [{ name: "MODE", value: "changed" }] },
				...metadata(),
			},
			actor("coowner"),
		);
		const configuration = await current(result.agentId);
		const [agent] =
			await db`select authorization_revision from platform.agents where id=${result.agentId}`;
		const [application] =
			await db`select management_revision from platform.agent_applications where agent_id=${result.agentId}`;
		const ids = metadata();
		const occurredAt = new Date();
		const plan: AgentConfigurationWritePlanV1 = {
			schemaVersion: 1,
			agentId: result.agentId,
			baseRevision: configuration.revision,
			nextRevision: configuration.revision,
			expectedManagementRevision: Number(application?.management_revision),
			expectedAuthorizationRevision: agent?.authorization_revision,
			nextAuthorizationRevision: randomUUID(),
			configuration,
			accessUpdate: {
				schemaVersion: 1,
				fragmentType: "agent_access",
				agentId: result.agentId,
				expectedRevision: Number(application?.management_revision),
				ownerIds: ["coowner"],
				availability: [{ kind: "user", userId: "owner" }],
			},
			result: {
				schemaVersion: 1,
				agentId: result.agentId,
				revision: configuration.revision,
				changedFields: ["availability"],
			},
			idempotency: {
				key: ids.idempotencyKey,
				requestDigest: hash(ids.requestId),
			},
			outboxIntent: null,
			auditEvent: {
				action: "agent.access.updated",
				actorId: "coowner",
				agentId: result.agentId,
				subjectType: "agent",
				subjectId: result.agentId,
				changedFields: ["availability"],
				requestId: ids.requestId,
				traceId: ids.traceId,
				occurredAt,
			},
		};
		await expect(updates.commit(plan)).resolves.toMatchObject({
			outcome: "committed",
		});
		expect(await rows(result.agentId)).toHaveLength(2);
		expect((await rows(result.agentId)).map((row) => row.digest)).toEqual([
			value.digest,
			value.digest,
		]);
	});
	it("rolls back a new configuration revision when binding persistence fails", async () => {
		const value = await snapshot();
		const { result } = await create(value.id);
		const before = await current(result.agentId);
		const restore = await rejectBindingWrites();
		try {
			await expect(
				coreUpdates().update(
					{
						schemaVersion: 2,
						agentId: result.agentId,
						changes: { environment: [{ name: "MODE", value: "fail" }] },
						...metadata(),
					},
					actor(),
				),
			).rejects.toBeDefined();
		} finally {
			await restore();
		}
		expect(await current(result.agentId)).toEqual(before);
		expect(await rows(result.agentId)).toHaveLength(1);
		expect(
			await db`select revision from platform.agent_configuration_revisions where agent_id=${result.agentId}`,
		).toHaveLength(1);
	});
	it("hides foreign binding status and prevents deletion of bound metadata", async () => {
		const value = await snapshot();
		await create(value.id);
		const foreign = { ownerType: "user" as const, ownerId: "coowner" };
		await expect(metadataStore.remove(foreign, value.id)).rejects.toMatchObject(
			{ code: "invalid_name" },
		);
		await expect(
			metadataStore.remove(foreign, randomUUID()),
		).rejects.toMatchObject({ code: "invalid_name" });
		await expect(
			metadataStore.remove({ ownerType: "user", ownerId: "owner" }, value.id),
		).rejects.toMatchObject({ code: "bound" });
		expect(
			await db`select status from platform.workspace_snapshots where id=${value.id}`,
		).toEqual([{ status: "ready" }]);
	});

	it("rejects standalone cross-owner targets and same-ID principal substitution without inserting a binding", async () => {
		const owned = await snapshot();
		const foreign = await snapshot("user", "coowner");
		const { result } = await create(foreign.id, "coowner");
		await expect(
			bindings.bind({
				ownerType: "user",
				ownerId: "owner",
				snapshotId: owned.id,
				agentId: result.agentId,
				configurationRevision: 1,
				name: "foreign",
			}),
		).rejects.toMatchObject({ code: "forbidden" });
		expect(
			await db`select snapshot_id from platform.workspace_snapshot_bindings where snapshot_id=${owned.id}`,
		).toEqual([]);
		const appOwned = await snapshot("application", "same-id");
		const userOwned = await snapshot("user", "same-id");
		const target = await create(userOwned.id, "same-id");
		await expect(
			bindings.bind({
				ownerType: "application",
				ownerId: "same-id",
				snapshotId: appOwned.id,
				agentId: target.result.agentId,
				configurationRevision: 1,
				name: "application",
			}),
		).rejects.toMatchObject({ code: "forbidden" });
		expect(
			await db`select snapshot_id from platform.workspace_snapshot_bindings where snapshot_id=${appOwned.id}`,
		).toEqual([]);
	});
});
