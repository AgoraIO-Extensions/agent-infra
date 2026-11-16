import { createHash, generateKeyPairSync } from "node:crypto";
import {
	AgentConnectionAssociationErrorV1,
	type ConnectionAssociationVerificationV1,
	type CurrentTaskUserV1,
	connectionServiceCredentialSecretInputV1,
	createAgentConnectionAssociationUseCaseV1,
	createPersonalApiCredentialUseCaseV1,
} from "@agent-infra/platform-core";
import { createSecretEncryptorV1 } from "@agent-infra/secret-store";
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
import { agentConfigurationConformanceRecordV1 } from "../../platform-core/src/agent-configuration.conformance.ts";
import { PostgresAgentConnectionAssociationStoreV1 } from "./agent-connection-association.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import { PostgresPersonalApiCredentialStoreV1 } from "./personal-api-credentials.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });

const owner = "user_owner";
const other = "user_other";
const credentialA = "conn_service_credential_for_agent_alpha_0001";
const credentialB = "conn_service_credential_for_agent_bravo_0002";
const policy = {
	schemaVersion: 1 as const,
	sourceNamespace: "platform-association-test",
	revision: "policy-1",
	callbackUrl: "https://platform.example.test/connection/callback",
	resource: "https://connection.example.test/mcp",
	scope: "mcp:tools",
};
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
const encryptor = createSecretEncryptorV1({
	encryptionKeys: {
		schemaVersion: 1,
		activeWrappingKeyVersion: "key-1",
		keys: [
			{
				schemaVersion: 1,
				keyVersion: "key-1",
				wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
				publicKeySpkiDerBase64: publicKeyDer.toString("base64"),
				publicKeyFingerprint: createHash("sha256")
					.update(publicKeyDer)
					.digest("hex"),
				rsaModulusBits: 3072,
				status: "active",
			},
		],
	},
});
const currentUser = (userId: string): CurrentTaskUserV1 => ({
	schemaVersion: 1,
	userId,
	accountStatus: "active",
	organizationIds: ["org_1"],
	authorizationRevision: "identity_1",
});

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let store: PostgresAgentConnectionAssociationStoreV1;
let credentials: PostgresPersonalApiCredentialStoreV1;
let verification: ConnectionAssociationVerificationV1;
let verified: { connectionAgentId: string; serviceCredential: string }[];

beforeAll(async () => {
	database = await startPostgresTestDatabase("agent-connection-association");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 3, onnotice: () => {} });
	store = new PostgresAgentConnectionAssociationStoreV1({
		databaseUrl: database.databaseUrl,
		directory: { resolveUser: async (id) => currentUser(id) },
	});
	credentials = new PostgresPersonalApiCredentialStoreV1({
		databaseUrl: database.databaseUrl,
	});
});
beforeEach(async () => {
	await sql`truncate platform.agents, platform.outbox_items, platform.audit_events, platform.platform_api_credentials, platform.idempotency_records cascade`;
	await sql`truncate platform.platform_user_disables`;
	verification = "verified";
	verified = [];
	await seedAgent("agent-a");
	await seedAgent("agent-b");
});
afterAll(async () => {
	await Promise.all([store?.close(), credentials?.close(), sql?.end()]);
	await database?.stop();
});

async function seedAgent(agentId: string, ownerId = owner) {
	const record = {
		...structuredClone(agentConfigurationConformanceRecordV1),
		agentId,
	};
	await sql`insert into platform.agents(id,current_configuration_revision)
		values (${agentId},${record.revision})`;
	await sql`insert into platform.agent_applications
		(id,agent_id,applicant_id,name,description,status,trace_id,request_id,submitted_at,
		management_revision,approval_revision,service_availability,desired_state,workload_revision,fence)
		values (${`application_${agentId}`},${agentId},${ownerId},${`Agent ${agentId}`},'Description',
		'available','trace_seed','request_seed',clock_timestamp(),1,1,'ready','running',1,1)`;
	await sql`insert into platform.agent_configuration_revisions
		(agent_id,revision,source_reference,configuration,created_at)
		values (${agentId},${record.revision},${record.source.kind === "standard" ? record.source.templateId : record.source.imageDigest},${sql.json(record as never)},clock_timestamp())`;
	await sql`insert into platform.agent_owners(agent_id,owner_id,created_at) values (${agentId},${ownerId},clock_timestamp())`;
	await sql`insert into platform.agent_availability(agent_id,target_type,target_id)
		values (${agentId},'organization','org_1')`;
}

function useCase(registrationPolicy?: typeof policy) {
	return createAgentConnectionAssociationUseCaseV1({
		transaction: store,
		...(registrationPolicy ? { registrationPolicy } : {}),
		verify: async (input) => {
			verified.push(input);
			return verification;
		},
		encrypt: (binding, plaintext) =>
			encryptor.encrypt(
				connectionServiceCredentialSecretInputV1(
					binding,
					plaintext,
					new Date().toISOString(),
				),
			),
	});
}
const browser = (agentId: string, userId = owner) => ({
	entry: { kind: "browser" as const, userId },
	agentId,
	traceId: `trace-${agentId}`,
	requestId: `request-${agentId}`,
});
const manual = (
	connectionAgentId: string,
	serviceCredential: string,
	expectedRevision: number | null = null,
) => ({
	schemaVersion: 1,
	mode: "manual",
	connectionAgentId,
	serviceCredential,
	expectedRevision,
});
async function rejection(promise: Promise<unknown>) {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(AgentConnectionAssociationErrorV1);
	return (error as AgentConnectionAssociationErrorV1).code;
}
const rows = () =>
	sql`select agent_id, connection_agent_id, association_revision from platform.connection_manual_associations order by agent_id`;
async function noCredentialPersisted() {
	const dump = JSON.stringify([
		await sql`select * from platform.connection_manual_associations`,
		await sql`select * from platform.audit_events`,
	]);
	for (const secret of [credentialA, credentialB])
		expect(dump).not.toContain(secret);
}

describe("Owner manual Connection association", () => {
	it("verifies once, stores only ciphertext and projects associated", async () => {
		expect(await useCase().current(browser("agent-a"))).toEqual({
			schemaVersion: 1,
			status: "not_enabled",
			source: null,
			associationRevision: null,
			automaticRegistrationAvailable: false,
		});
		expect(
			await useCase().associate(
				browser("agent-a"),
				manual("connection-agent-a", credentialA),
			),
		).toMatchObject({
			status: "associated",
			source: "manual",
			associationRevision: 1,
		});
		expect(verified).toEqual([
			{
				connectionAgentId: "connection-agent-a",
				serviceCredential: credentialA,
			},
		]);
		expect(await rows()).toEqual([
			{
				agent_id: "agent-a",
				connection_agent_id: "connection-agent-a",
				association_revision: "1",
			},
		]);
		const [stored] =
			await sql`select credential_ciphertext from platform.connection_manual_associations`;
		expect(stored?.credential_ciphertext).toMatchObject({
			agentId: "agent-a",
			ownerId: owner,
			name: "connection-service-credential",
			secretVersion: 1,
		});
		await noCredentialPersisted();
	});

	it("replaces with a new revision, then disconnects and closes the association", async () => {
		await useCase().associate(
			browser("agent-a"),
			manual("connection-agent-a", credentialA),
		);
		expect(
			await useCase().associate(
				browser("agent-a"),
				manual("connection-agent-a", credentialB, 1),
			),
		).toMatchObject({ associationRevision: 2 });
		expect((await rows()).map((row) => row.association_revision)).toEqual([
			"2",
		]);
		expect(
			await rejection(
				useCase().disconnect(browser("agent-a"), {
					schemaVersion: 1,
					expectedRevision: 1,
				}),
			),
		).toBe("conflict");
		expect(
			await useCase().disconnect(browser("agent-a"), {
				schemaVersion: 1,
				expectedRevision: 2,
			}),
		).toMatchObject({ status: "not_enabled", source: null });
		expect(await rows()).toEqual([]);
		await noCredentialPersisted();
	});

	it("never reuses a CAS revision across disconnect and reassociation (ABA)", async () => {
		const disconnect = (expectedRevision: number) =>
			useCase().disconnect(browser("agent-a"), {
				schemaVersion: 1,
				expectedRevision,
			});
		const seen: number[] = [];
		// A at rev1, disconnect, then the same Consumer again, then B; repeated over cycles.
		for (const [cycle, connectionAgentId, serviceCredential] of [
			[0, "connection-agent-a", credentialA],
			[1, "connection-agent-a", credentialA],
			[2, "connection-agent-b", credentialB],
			[3, "connection-agent-a", credentialB],
		] as const) {
			const state = await useCase().associate(
				browser("agent-a"),
				manual(connectionAgentId, serviceCredential),
			);
			const revision = state.associationRevision;
			if (revision === null) throw new Error("Missing revision");
			expect(seen).not.toContain(revision);
			for (const stale of seen) {
				// An old revision can neither disconnect nor replace the newer association.
				expect(await rejection(disconnect(stale))).toBe("conflict");
				expect(
					await rejection(
						useCase().associate(
							browser("agent-a"),
							manual(connectionAgentId, serviceCredential, stale),
						),
					),
				).toBe("conflict");
			}
			expect(await rows()).toEqual([
				{
					agent_id: "agent-a",
					connection_agent_id: connectionAgentId,
					association_revision: String(revision),
				},
			]);
			seen.push(revision);
			if (cycle < 3) await disconnect(revision);
		}
		// Replacing the current association also advances past every earlier revision.
		const current = seen.at(-1) ?? 0;
		const replaced = await useCase().associate(
			browser("agent-a"),
			manual("connection-agent-a", credentialA, current),
		);
		expect(replaced.associationRevision).toBeGreaterThan(Math.max(...seen));
		expect(await rejection(disconnect(current))).toBe("conflict");
		const [stored] =
			await sql`select credential_ciphertext->>'secretVersion' as version from platform.connection_manual_associations`;
		expect(Number(stored?.version)).toBe(replaced.associationRevision);
		await noCredentialPersisted();
	});

	it("rejects non-Owners and cross-Agent changes before calling Connection", async () => {
		await seedAgent("agent-other", other);
		expect(
			await rejection(
				useCase().associate(
					browser("agent-a", other),
					manual("connection-agent-a", credentialA),
				),
			),
		).toBe("not_authorized");
		// The Owner of another Agent cannot reach this Agent either.
		expect(
			await rejection(
				useCase().associate(
					browser("agent-other"),
					manual("connection-agent-a", credentialA),
				),
			),
		).toBe("not_authorized");
		await sql`insert into platform.platform_user_disables(user_id) values (${owner})`;
		expect(
			await rejection(
				useCase().associate(
					browser("agent-a"),
					manual("connection-agent-a", credentialA),
				),
			),
		).toBe("not_authorized");
		expect(verified).toEqual([]);
		expect(await rows()).toEqual([]);
		const refusals =
			await sql`select action, outcome, details from platform.audit_events order by occurred_at`;
		expect(refusals.map((row) => row.outcome)).toEqual([
			"rejected",
			"rejected",
			"rejected",
		]);
		await noCredentialPersisted();
	});

	it.each([
		["credential_rejected", "credential_rejected"],
		["consumer_unavailable", "consumer_unavailable"],
		["unknown", "verification_unavailable"],
	] as const)(
		"saves nothing when Connection verification is %s",
		async (result, code) => {
			verification = result;
			expect(
				await rejection(
					useCase().associate(
						browser("agent-a"),
						manual("connection-agent-a", credentialA),
					),
				),
			).toBe(code);
			expect(await rows()).toEqual([]);
			await noCredentialPersisted();
		},
	);

	it("rejects one Connection Agent or credential for two Agents and repeated submission", async () => {
		await useCase().associate(
			browser("agent-a"),
			manual("connection-agent-a", credentialA),
		);
		expect(
			await rejection(
				useCase().associate(
					browser("agent-b"),
					manual("connection-agent-b", credentialA),
				),
			),
		).toBe("already_associated");
		expect(
			await rejection(
				useCase().associate(
					browser("agent-b"),
					manual("connection-agent-a", credentialB),
				),
			),
		).toBe("already_associated");
		// A repeated first association does not create a second row or overwrite the first.
		expect(
			await rejection(
				useCase().associate(
					browser("agent-a"),
					manual("connection-agent-a", credentialA),
				),
			),
		).toBe("conflict");
		expect(verified).toHaveLength(1);
		expect(await rows()).toEqual([
			{
				agent_id: "agent-a",
				connection_agent_id: "connection-agent-a",
				association_revision: "1",
			},
		]);
	});

	it("keeps manual and automatic associations exclusive", async () => {
		expect(
			await rejection(
				useCase().associate(browser("agent-a"), {
					schemaVersion: 1,
					mode: "automatic",
				}),
			),
		).toBe("automatic_unavailable");
		await useCase().associate(
			browser("agent-a"),
			manual("connection-agent-a", credentialA),
		);
		expect(
			await rejection(
				useCase(policy).associate(browser("agent-a"), {
					schemaVersion: 1,
					mode: "automatic",
				}),
			),
		).toBe("conflict");
		expect(
			await sql`select * from platform.connection_consumer_registrations`,
		).toEqual([]);
		expect(
			await useCase(policy).associate(browser("agent-b"), {
				schemaVersion: 1,
				mode: "automatic",
			}),
		).toMatchObject({ status: "processing", source: "automatic" });
		expect(
			await rejection(
				useCase(policy).associate(
					browser("agent-b"),
					manual("connection-agent-b", credentialB),
				),
			),
		).toBe("conflict");
	});

	it("accepts the same command from the Owner's API credential and rejects other principals", async () => {
		const governance = createPersonalApiCredentialUseCaseV1({
			transaction: credentials,
			userDirectory: { resolveUser: async (id) => currentUser(id) },
		});
		const issue = async (userId: string, key: string) => {
			const issued = await governance.issue(
				{ requestId: key, traceId: key, userId, idempotencyKey: key },
				{ scopes: ["agent:manage"], expiresAt: null },
			);
			if (!issued.credential) throw new Error("Missing material");
			return issued.credential;
		};
		const ownerMaterial = await issue(owner, "issue.owner");
		const otherMaterial = await issue(other, "issue.other");
		const api = (material: string) => ({
			entry: { kind: "api" as const, material },
			agentId: "agent-a",
			traceId: "trace-api",
			requestId: "request-api",
		});
		expect(
			await rejection(
				useCase().associate(
					api(otherMaterial),
					manual("connection-agent-a", credentialA),
				),
			),
		).toBe("not_authorized");
		expect(
			await rejection(
				useCase().associate(
					api("papi_invalidinvalidinvalidinvalidinvalidinvalid00"),
					manual("connection-agent-a", credentialA),
				),
			),
		).toBe("not_authorized");
		expect(
			await useCase().associate(
				api(ownerMaterial),
				manual("connection-agent-a", credentialA),
			),
		).toMatchObject({ status: "associated", associationRevision: 1 });
		await noCredentialPersisted();
	});
});
