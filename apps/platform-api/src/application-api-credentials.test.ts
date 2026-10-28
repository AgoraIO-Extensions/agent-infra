import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { once } from "node:events";
import {
	AgentApiCreationResponseV1Schema,
	ApplicationApiCredentialPageV1Schema,
	ApplicationApiCredentialResponseV1Schema,
	ApplicationApiCredentialRevocationV1Schema,
	ScopedPlatformAuditPageV1Schema,
} from "@agent-infra/contracts/pilot";
import type {
	createLdapIdentityDirectory,
	LdapAccount,
} from "@agent-infra/identity";
import type { AgentDefaultRelayKeyBindingV1 } from "@agent-infra/platform-core";
import { migratePlatformDatabase } from "@agent-infra/platform-store";
import { serve } from "@hono/node-server";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { applicationFoundationAdmissionDependenciesV1 } from "../../../packages/platform-core/src/application-foundation.conformance.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";
import { createRelayKeyEncryptorV1 } from "../../../packages/secret-store/src/relay-key.ts";
import { createClient } from "../../web/src/pilot/generated/client/index.ts";
import {
	getScopedAdministratorAudit,
	listScopedAdministratorAudit,
} from "../../web/src/pilot/generated/sdk.gen.ts";
import { createPlatformApp } from "./app.js";
import {
	assemblePlatformApi,
	type PlatformApiAssembly,
	type PlatformApiAssemblyInput,
} from "./assembly.js";
import { createLdapBrowserAdapter } from "./ldap-browser.js";

// Actual TCP HTTP, current LDAP adapter and PG; controlled identity/session ports and recipient process.
// Task consumption and deployment acceptance remain separate requirements.
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let assembly: PlatformApiAssembly;
let assemblyInput: PlatformApiAssemblyInput;
let server: ReturnType<typeof serve>;
let baseUrl: string;
const materials: string[] = [];
let failDelivery = false;
const agentModelConfiguration = {
	options: [
		{
			optionId: "model",
			endpointId: "relay",
			modelId: "model-a",
			reasoningLevels: ["low"],
		},
	],
	defaultOptionId: "model",
	defaultReasoningLevel: "low",
};
const agentBody = {
	schemaVersion: 3 as const,
	name: "Issued Token Agent",
	description: "Application process management journey",
	source: { kind: "standard" as const, templateId: "template_01" },
	coOwnerIds: [],
	availability: [],
	environment: [],
	secrets: [],
	defaultRelayKey: "issued-token-default-key",
	modelConfiguration: agentModelConfiguration,
};
const applicationCredentialCommand = {
	operation: "issue" as const,
	recipient: { principalType: "application" as const, principalId: "app-1" },
	scopes: ["agent:create", "agent:manage", "agent:use", "agent:read"],
	expiresAt: null,
};
const accounts: LdapAccount[] = ["manager", "admin", "recipient"].map(
	(userId) => ({
		uid: `ldap-${userId}`,
		userId,
		displayName: userId,
		email: `${userId}@example.test`,
		accountStatus: "active",
		roles: userId === "admin" ? ["employee", "system_admin"] : ["employee"],
		authorizationRevision: "identity-v1",
	}),
);
const token = (user: string) =>
	(user === "admin" ? "b" : user === "recipient" ? "c" : "a").repeat(43);
const origin = "https://platform.example.test";
beforeAll(async () => {
	database = await startPostgresTestDatabase("issuer-http-1277");
	await migratePlatformDatabase(database);
	sql = postgres(database.databaseUrl, { max: 2 });
	await sql`insert into platform.platform_applications (id,name,responsible_user_id,authorization_revision) values ('app-1','App','manager','app-v1')`;
	const adapter = createLdapBrowserAdapter({
		publicOrigin: origin,
		directory: {
			userIdForUid: async (uid: string) =>
				accounts.find((a) => a.uid === uid)?.userId,
			current: async (uid: string) =>
				accounts.find((a) => a.uid === uid) ?? null,
			currentByUserId: async (id: string) =>
				accounts.find((a) => a.userId === id) ?? null,
		} as unknown as ReturnType<typeof createLdapIdentityDirectory>,
		sessions: {
			find: async (digest) => {
				for (const user of ["admin", "manager", "recipient"]) {
					if (createHash("sha256").update(token(user)).digest("hex") === digest)
						return {
							uid: `ldap-${user}`,
							expiresAt: Number.MAX_SAFE_INTEGER,
							absoluteExpiresAt: Number.MAX_SAFE_INTEGER,
						};
				}
				return null;
			},
			create: async () => {},
			renew: async () => true,
			revoke: async () => {},
			revokeUid: async () => {},
		},
		isPlatformDisabled: async () => false,
		organizationIds: async () => [],
	}).identityAdapter;
	const unused = async (): Promise<never> => {
		throw new Error("Unrelated adapter called");
	};
	const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
	const der = publicKey.export({ format: "der", type: "spki" });
	const encryptor = createRelayKeyEncryptorV1({
		encryptionKeys: {
			schemaVersion: 1,
			activeWrappingKeyVersion: "test-key",
			keys: [
				{
					schemaVersion: 1,
					keyVersion: "test-key",
					wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
					publicKeySpkiDerBase64: der.toString("base64"),
					publicKeyFingerprint: createHash("sha256").update(der).digest("hex"),
					rsaModulusBits: 3072,
					status: "active",
				},
			],
		},
	});
	assemblyInput = {
		taskAdmissionPolicy: {
			maximumWaitingTasksPerAgent: 2,
			waitingTimeoutMs: 60_000,
		},
		databaseUrl: database.databaseUrl,
		identity: adapter,
		agentApiCreation: {
			allowedPrincipals: [{ kind: "application", id: "app-1" }],
			loadAuthorityContext: async () => ({
				schemaVersion: 1,
				users: [
					{ userId: "manager", accountStatus: "active" },
					{ userId: "recipient", accountStatus: "active" },
				],
				organizationIds: [],
			}),
			admissions: {
				...applicationFoundationAdmissionDependenciesV1(),
				keylessModelAdmission: {
					admitModels: async ({ requested }) =>
						requested ? { ...requested, catalogRevision: "catalog-1" } : null,
				},
			},
			defaultRelayKey: {
				candidates: async () => agentModelConfiguration.options,
				verify: async () => {},
				encrypt: (binding: AgentDefaultRelayKeyBindingV1) =>
					encryptor.encrypt({
						...binding,
						plaintext: agentBody.defaultRelayKey,
					}),
			},
		},
		admissions: {
			authorizationAdmission: { authorize: unused },
			imageAdmission: { admitImage: unused },
			modelAdmission: { admitModels: unused },
			secretAdmission: { admitSecrets: unused },
			channelAdmission: { admitChannels: unused },
		},
		allocateApplicationIds: unused,
		prepareApplicationSecrets: unused,
		prepareConfigurationSecrets: unused,
		presentAgent: unused,
		applicationCredentialDelivery: {
			principalType: "application",
			principalId: "app-1",
			accept: (_attempt, material) => {
				if (failDelivery) throw new Error("PRIVATE_DELIVERY_FAILURE");
				materials.push(material);
				return true;
			},
		},
	};
	assembly = assemblePlatformApi(assemblyInput);
	server = serve({
		fetch: createPlatformApp(assembly.dependencies).fetch,
		hostname: "127.0.0.1",
		port: 0,
	});
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Missing listener");
	baseUrl = `http://127.0.0.1:${address.port}`;
}, 120_000);
afterAll(async () => {
	if (server)
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	await assembly?.close();
	await sql?.end();
	await database?.stop();
});
function post(
	path: string,
	body: unknown,
	user = "manager",
	key = "issue-http",
) {
	return fetch(`${baseUrl}${path}`, {
		method: "POST",
		headers: {
			Cookie: `__Host-platform-session=${token(user)}`,
			Origin: origin,
			"Content-Type": "application/json",
			"Idempotency-Key": key,
		},
		body: JSON.stringify(body),
	});
}
it("uses formal grant and issuer HTTP, delivers to the bound process only once, and never returns material to manager", async () => {
	const command = applicationCredentialCommand;
	const path = "/api/v2/applications/app-1/credentials";
	expect((await post(path, command)).status).toBe(403);
	expect(
		(
			await post(
				"/api/v2/applications/app-1/material-grant",
				command.recipient,
				"admin",
			)
		).status,
	).toBe(201);
	expect((await post(path, command, "admin")).status).toBe(404);
	expect(
		(
			await post(path, {
				...command,
				recipient: { principalType: "user", principalId: "manager" },
			})
		).status,
	).toBe(403);
	const first = await post(path, command);
	expect(first.status).toBe(201);
	expect(first.headers.get("Cache-Control")).toBe("no-store");
	const result = ApplicationApiCredentialResponseV1Schema.parse(
		await first.json(),
	);
	expect(result.delivery.status).toBe("accepted");
	expect(materials.length).toBe(1);
	expect(JSON.stringify(result).includes(materials[0] ?? "missing")).toBe(
		false,
	);
	const [row] =
		await sql`select principal_type, principal_id, credential_hash from platform.platform_api_credentials`;
	expect(row?.principal_type).toBe("application");
	expect(row?.principal_id).toBe("app-1");
	expect(
		row?.credential_hash ===
			createHash("sha256")
				.update(materials[0] ?? "missing")
				.digest("hex"),
	).toBe(true);
	expect((await post(path, command)).status).toBe(200);
	expect(materials.length).toBe(1);
	expect(
		(await post(path, { ...command, scopes: ["agent:read"] })).status,
	).toBe(409);
	expect(
		(
			await post(path, {
				...command,
				deliveryUrl: "https://caller.example.test",
			})
		).status,
	).toBe(400);
	const audits = JSON.stringify(
		await sql`select details from platform.audit_events`,
	);
	expect(audits.includes(materials[0] ?? "missing")).toBe(false);
});

it("uses the actually delivered application Token to create two Agents and read their state", async () => {
	if (!materials[0]) {
		const grant = await post(
			"/api/v2/applications/app-1/material-grant",
			applicationCredentialCommand.recipient,
			"admin",
		);
		expect([200, 201]).toContain(grant.status);
		expect(
			(
				await post(
					"/api/v2/applications/app-1/credentials",
					applicationCredentialCommand,
				)
			).status,
		).toBe(201);
	}
	const issued = materials[0];
	if (!issued) throw new Error("Issuer did not deliver an application Token");
	const create = async (key: string, name: string) => {
		const response = await fetch(`${baseUrl}/api/v2/agents`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${issued}`,
				"Idempotency-Key": key,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ ...agentBody, name }),
		});
		expect(response.status).toBe(201);
		return AgentApiCreationResponseV1Schema.parse(await response.json());
	};
	const first = await create("issued-agent-one", "Issued Agent One");
	const second = await create("issued-agent-two", "Issued Agent Two");
	expect(first.agentId).not.toBe(second.agentId);
	expect(materials).toHaveLength(1);
	expect(
		await sql`select creator_principal_type,creator_principal_id,creation_channel,applicant_id from platform.agent_applications order by agent_id`,
	).toEqual([
		{
			creator_principal_type: "application",
			creator_principal_id: "app-1",
			creation_channel: "api",
			applicant_id: "manager",
		},
		{
			creator_principal_type: "application",
			creator_principal_id: "app-1",
			creation_channel: "api",
			applicant_id: "manager",
		},
	]);
	expect(
		await sql`select agent_id,grant_type,principal_type,principal_id,authorization_revision from platform.agent_principal_grants order by agent_id,grant_type`,
	).toHaveLength(4);
	const grants = await sql`
		select agent_id,grant_type,principal_type,principal_id,authorization_revision
		from platform.agent_principal_grants order by agent_id,grant_type`;
	expect(
		grants.map((grant) => `${grant.agent_id}:${grant.grant_type}`),
	).toEqual([
		`${first.agentId}:manage`,
		`${first.agentId}:use`,
		`${second.agentId}:manage`,
		`${second.agentId}:use`,
	]);
	expect(
		grants.every(
			(grant) =>
				grant.principal_type === "application" &&
				grant.principal_id === "app-1",
		),
	).toBe(true);
	expect(
		new Set(grants.map((grant) => grant.authorization_revision)).size,
	).toBe(4);
	expect(
		await sql`select owner_id from platform.agent_owners order by agent_id`,
	).toEqual([{ owner_id: "manager" }, { owner_id: "manager" }]);
	const relayRows = await sql`
		select subject_id,key_version,key_id,ciphertext
		from platform.relay_key_versions where purpose='agent-default' order by subject_id`;
	expect(relayRows).toHaveLength(2);
	for (const row of relayRows) {
		expect([first.agentId, second.agentId]).toContain(row.subject_id);
		expect(row.ciphertext).toMatchObject({
			purpose: "agent-default",
			subjectId: row.subject_id,
			keyVersion: Number(row.key_version),
			keyId: row.key_id,
		});
		expect(JSON.stringify(row.ciphertext)).not.toContain(
			agentBody.defaultRelayKey,
		);
	}
	const creationAudits = await sql`
		select action,actor_type,actor_id,target_id
		from platform.audit_events
		where action in ('api.agent.create.accepted','relay_key.agent_default.replace')`;
	expect(creationAudits).toHaveLength(4);
	expect(
		creationAudits.every(
			(audit) =>
				audit.actor_type === "application" &&
				audit.actor_id === "app-1" &&
				[first.agentId, second.agentId].includes(audit.target_id),
		),
	).toBe(true);
	for (const agentId of [first.agentId, second.agentId]) {
		const state = await fetch(`${baseUrl}/api/v2/agents/${agentId}/state`, {
			headers: { Authorization: `Bearer ${issued}` },
		});
		expect(state.status).toBe(200);
		expect(await state.json()).toMatchObject({
			agentId,
			status: "creating",
			revision: 1,
		});
		const lifecycle = await fetch(
			`${baseUrl}/api/v2/agents/${agentId}/commands`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${issued}`,
					"Idempotency-Key": `creating-start-${agentId}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ schemaVersion: 1, command: "start" }),
			},
		);
		expect(lifecycle.status).toBe(409);
	}
	expect(
		await sql`select count(*)::int as count from platform.outbox_items`,
	).toEqual([{ count: 2 }]);
	const [oldCredential] =
		await sql`select id from platform.platform_api_credentials where revoked_at is null`;
	const rotated = await post(
		"/api/v2/applications/app-1/credentials",
		{
			...applicationCredentialCommand,
			operation: "rotate",
			credentialId: oldCredential?.id,
		},
		"manager",
		"rotate-issued-token",
	);
	expect(rotated.status).toBe(201);
	const replacement = materials[1];
	if (!replacement)
		throw new Error("Rotation did not deliver replacement Token");
	expect(
		(
			await fetch(`${baseUrl}/api/v2/agents/${first.agentId}/state`, {
				headers: { Authorization: `Bearer ${issued}` },
			})
		).status,
	).toBe(401);
	expect(
		(
			await fetch(`${baseUrl}/api/v2/agents/${first.agentId}/state`, {
				headers: { Authorization: `Bearer ${replacement}` },
			})
		).status,
	).toBe(200);
	const replayBeforeRevoke = await fetch(`${baseUrl}/api/v2/agents`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${replacement}`,
			"Idempotency-Key": "issued-agent-one",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ ...agentBody, name: "Issued Agent One" }),
	});
	expect(replayBeforeRevoke.status).toBe(200);
	expect(await replayBeforeRevoke.json()).toMatchObject({
		agentId: first.agentId,
		replayed: true,
	});
	const revokeManage = await fetch(
		`${baseUrl}/api/v2/agents/${first.agentId}/application-managers/app-1`,
		{
			method: "DELETE",
			headers: {
				Cookie: `__Host-platform-session=${token("manager")}`,
				Origin: origin,
				"Content-Type": "application/json",
				"Idempotency-Key": "issued-revoke-manage",
			},
			body: JSON.stringify({ schemaVersion: 1 }),
		},
	);
	expect(revokeManage.status).toBe(200);
	expect(
		(
			await fetch(`${baseUrl}/api/v2/agents/${first.agentId}/state`, {
				headers: { Authorization: `Bearer ${replacement}` },
			})
		).status,
	).toBe(200);
	const deniedLifecycle = await fetch(
		`${baseUrl}/api/v2/agents/${first.agentId}/commands`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${replacement}`,
				"Idempotency-Key": "issued-manage-revoked",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ schemaVersion: 1, command: "stop" }),
		},
	);
	expect(deniedLifecycle.status).toBe(404);
	expect(
		await sql`select count(*)::int as count from platform.outbox_items`,
	).toEqual([{ count: 2 }]);
	const otherToken = `papi_${"O".repeat(43)}`;
	await sql`insert into platform.platform_applications(id,name,responsible_user_id,authorization_revision) values('manager','Other Robot','manager','app-2')`;
	await sql`insert into platform.platform_api_credentials(id,principal_type,principal_id,credential_hash,scopes) values('app-2-credential','application','manager',${createHash("sha256").update(otherToken).digest("hex")},'["agent:read","agent:manage","agent:use"]'::jsonb)`;
	for (const path of [
		`${baseUrl}/api/v2/agents/${first.agentId}/state`,
		`${baseUrl}/api/v2/agents/${first.agentId}/commands`,
	]) {
		const response = await fetch(path, {
			method: path.endsWith("commands") ? "POST" : "GET",
			headers: {
				Authorization: `Bearer ${otherToken}`,
				...(path.endsWith("commands")
					? {
							"Idempotency-Key": "app-2-cross-subject",
							"Content-Type": "application/json",
						}
					: {}),
			},
			...(path.endsWith("commands")
				? { body: JSON.stringify({ schemaVersion: 1, command: "stop" }) }
				: {}),
		});
		expect(response.status).toBe(404);
	}
	const revokeUse = await fetch(
		`${baseUrl}/api/v2/agents/${first.agentId}/application-use-grants/app-1`,
		{
			method: "DELETE",
			headers: {
				Cookie: `__Host-platform-session=${token("manager")}`,
				Origin: origin,
				"Content-Type": "application/json",
				"Idempotency-Key": "issued-revoke-use",
			},
			body: JSON.stringify({ schemaVersion: 1 }),
		},
	);
	expect(revokeUse.status).toBe(200);
	expect(
		(
			await fetch(`${baseUrl}/api/v2/agents/${first.agentId}/state`, {
				headers: { Authorization: `Bearer ${replacement}` },
			})
		).status,
	).toBe(404);
	expect(
		(
			await fetch(`${baseUrl}/api/v2/agents/${first.agentId}/state`, {
				headers: { Authorization: `Bearer ${otherToken}` },
			})
		).status,
	).toBe(404);
	const replay = await fetch(`${baseUrl}/api/v2/agents`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${replacement}`,
			"Idempotency-Key": "issued-agent-one",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ ...agentBody, name: "Issued Agent One" }),
	});
	expect(replay.status).toBe(404);
});

it("assembly without a trusted delivery consumer fails closed without issuing", async () => {
	const without = { ...assemblyInput };
	delete without.applicationCredentialDelivery;
	const unavailable = assemblePlatformApi(without);
	try {
		const before =
			await sql`select count(*)::int as count from platform.platform_api_credentials`;
		const response = await createPlatformApp(unavailable.dependencies).request(
			"http://127.0.0.1/api/v2/applications/app-1/credentials",
			{
				method: "POST",
				headers: {
					Cookie: `__Host-platform-session=${token("manager")}`,
					Origin: origin,
					"Content-Type": "application/json",
					"Idempotency-Key": "missing-consumer",
				},
				body: JSON.stringify({
					operation: "issue",
					recipient: { principalType: "user", principalId: "recipient" },
					scopes: ["agent:use"],
					expiresAt: null,
				}),
			},
		);
		expect(response.status).toBe(503);
		expect(
			await sql`select count(*)::int as count from platform.platform_api_credentials`,
		).toEqual(before);
	} finally {
		await unavailable.close();
	}
});

it("lists and revokes with current browser authority, then rejects only that credential at real HTTP authentication", async () => {
	const applicationId = "governance-app";
	const credentialId = "governance-credential";
	const material = `papi_${randomBytes(32).toString("base64url")}`;
	const siblingMaterial = `papi_${randomBytes(32).toString("base64url")}`;
	await sql`insert into platform.platform_applications (id,name,responsible_user_id,authorization_revision) values (${applicationId}, 'Governance', 'manager', 'v1')`;
	await sql`insert into platform.platform_api_credentials (id,principal_type,principal_id,credential_hash,scopes) values (${credentialId},'application',${applicationId},${createHash("sha256").update(material).digest("hex")},'["agent:read"]'), ('governance-sibling','application',${applicationId},${createHash("sha256").update(siblingMaterial).digest("hex")},'["agent:read"]')`;
	const path = `/api/v2/applications/${applicationId}/credentials`;
	const headers = {
		Cookie: `__Host-platform-session=${token("manager")}`,
		Origin: origin,
		"Idempotency-Key": "governance-revoke",
	};
	const read = () => fetch(`${baseUrl}${path}`, { headers });
	const [agent] =
		await sql`select agent_id from platform.agent_applications order by agent_id limit 1`;
	expect(agent?.agent_id).toBeTruthy();
	await sql`insert into platform.agent_principal_grants (agent_id,principal_type,principal_id,grant_type,authorization_revision) values (${agent?.agent_id},'application',${applicationId},'manage','v1')`;
	const outboxBefore =
		await sql`select * from platform.outbox_items order by id`;
	const authenticate = (credential: string) =>
		fetch(`${baseUrl}/api/v2/agents/${agent?.agent_id}/state`, {
			headers: { Authorization: `Bearer ${credential}` },
		});
	expect((await authenticate(material)).status).toBe(200);
	expect((await authenticate(siblingMaterial)).status).toBe(200);
	const listed = await read();
	expect(listed.status).toBe(200);
	expect(listed.headers.get("Cache-Control")).toBe("no-store");
	const page = ApplicationApiCredentialPageV1Schema.parse(await listed.json());
	expect(page.items).toHaveLength(2);
	expect(JSON.stringify(page)).not.toContain(material);
	expect(JSON.stringify(page)).not.toContain("credentialHash");
	expect(
		(await fetch(`${baseUrl}${path}?principalId=app-1`, { headers })).status,
	).toBe(400);
	expect(
		(await fetch(`${baseUrl}${path}?limit=1&limit=2`, { headers })).status,
	).toBe(400);
	expect(
		(
			await fetch(`${baseUrl}${path}`, {
				headers: { ...headers, Authorization: `Bearer ${material}` },
			})
		).status,
	).toBe(401);
	expect(
		(
			await fetch(`${baseUrl}${path}`, {
				headers: { Cookie: `__Host-platform-session=${token("admin")}` },
			})
		).status,
	).toBe(404);
	const revoke = (id: string, extra: RequestInit = {}) =>
		fetch(`${baseUrl}${path}/${id}`, { method: "DELETE", headers, ...extra });
	expect((await revoke("missing")).status).toBe(404);
	expect(
		(
			await revoke(credentialId, {
				body: JSON.stringify({ userId: "manager" }),
			})
		).status,
	).toBe(400);
	const revoked = await revoke(credentialId);
	expect(revoked.status).toBe(200);
	expect(
		ApplicationApiCredentialRevocationV1Schema.parse(await revoked.json())
			.metadata.revokedAt,
	).not.toBeNull();
	expect((await revoke(credentialId)).status).toBe(200);
	expect((await authenticate(material)).status).toBe(401);
	expect((await authenticate(siblingMaterial)).status).toBe(200);
	expect(
		ApplicationApiCredentialPageV1Schema.parse(
			await (await read()).json(),
		).items.find((item) => item.credentialId === credentialId),
	).toMatchObject({ revokedAt: expect.any(String) });
	await sql`update platform.platform_applications set responsible_user_id = 'recipient' where id = ${applicationId}`;
	expect((await read()).status).toBe(404);
	expect((await revoke(credentialId)).status).toBe(404);
	expect(await sql`select * from platform.outbox_items order by id`).toEqual(
		outboxBefore,
	);
	const audit = JSON.stringify(
		await sql`select details from platform.audit_events where target_id = ${applicationId}`,
	);
	expect(audit).not.toContain(material);
	expect(audit).not.toContain(
		createHash("sha256").update(material).digest("hex"),
	);
});

it("reads real application credential producers through scoped admin audit without leaking material", async () => {
	const client = createClient({ baseUrl });
	await sql`insert into platform.platform_applications(id,name,responsible_user_id,authorization_revision) values('empty-audit-app','Empty','manager','v1')`;
	const empty = await fetch(
		`${baseUrl}/api/v2/applications/empty-audit-app/credentials`,
		{ headers: { Cookie: `__Host-platform-session=${token("manager")}` } },
	);
	expect(empty.status).toBe(200);
	expect(
		ApplicationApiCredentialPageV1Schema.parse(await empty.json()).items,
	).toEqual([]);
	const [emptyAudit] =
		await sql`select details from platform.audit_events where target_id='empty-audit-app' and action='application.credential.metadata.read'`;
	expect(emptyAudit?.details).toEqual({
		credentialIds: [],
		returnedMaterial: false,
	});
	const [active] =
		await sql`select id from platform.platform_api_credentials where principal_id='app-1' and revoked_at is null`;
	failDelivery = true;
	try {
		expect(
			(
				await post(
					"/api/v2/applications/app-1/credentials",
					{
						...applicationCredentialCommand,
						operation: "rotate",
						credentialId: active?.id,
					},
					"manager",
					"audit-unknown-delivery",
				)
			).status,
		).toBe(503);
	} finally {
		failDelivery = false;
	}

	const actions = [
		"application.credential.issued",
		"application.credential.rotated",
		"application.credential.delivery",
		"application.credential.metadata.read",
		"application.credential.revoked",
	];
	const rows = await sql<
		{ id: string; action: string; target_id: string; outcome: string }[]
	>`
		select id, action, target_id, outcome from platform.audit_events
		where action = any(${actions}) order by occurred_at desc, id desc`;
	expect(new Set(rows.map((row) => row.action))).toEqual(new Set(actions));
	const headers = { Cookie: `__Host-platform-session=${token("admin")}` };
	for (const action of actions) {
		const response = await listScopedAdministratorAudit({
			client,
			headers,
			query: { action: action as "application.credential.issued" },
		});
		expect(response.response?.status).toBe(200);
		const page = response.data;
		if (!page) throw new Error("Missing audit page");
		expect(page.items.map((item: { auditId: string }) => item.auditId)).toEqual(
			rows.filter((row) => row.action === action).map((row) => row.id),
		);
	}
	for (const row of rows) {
		const response = await getScopedAdministratorAudit({
			client,
			headers,
			path: { auditId: row.id },
		});
		expect(response.response?.status).toBe(200);
		const record = response.data;
		if (!record) throw new Error("Missing audit detail");
		expect(record).toMatchObject({
			action: row.action,
			actor: { kind: "user", actorId: "manager" },
			subject: { kind: "application", subjectId: row.target_id },
			result: row.outcome,
		});
		const encoded = JSON.stringify(record);
		for (const material of materials) {
			expect(encoded).not.toContain(material);
			expect(encoded).not.toContain(
				createHash("sha256").update(material).digest("hex"),
			);
		}
		for (const field of [
			"details",
			"credentialId",
			"attemptId",
			"grantRevision",
			"recipient",
		])
			expect(record).not.toHaveProperty(field);
		for (const ownHeaders of [
			{ Cookie: `__Host-platform-session=${token("manager")}` },
			{ Cookie: `__Host-platform-session=${token("recipient")}` },
			{ Authorization: `Bearer papi_${"O".repeat(43)}` },
		]) {
			const denied = await fetch(`${baseUrl}/api/v1/audit/${row.id}`, {
				headers: ownHeaders,
			});
			expect(denied.status).toBe(404);
			const own = await fetch(`${baseUrl}/api/v1/audit?action=${row.action}`, {
				headers: ownHeaders,
			});
			expect(own.status).toBe(200);
			expect(
				ScopedPlatformAuditPageV1Schema.parse(await own.json()).items,
			).toEqual([]);
		}
	}
	expect(
		rows.some(
			(row) =>
				row.action === "application.credential.delivery" &&
				row.outcome === "failed",
		),
	).toBe(true);
}, 30000);

it("keeps application governance pagination stable and rejects corrupted producer facts", async () => {
	const headers = { Cookie: `__Host-platform-session=${token("admin")}` };
	const action = "application.credential.delivery";
	const rows = await sql<{ id: string; details: Record<string, unknown> }[]>`
		select id,details from platform.audit_events where action=${action} order by occurred_at desc, id desc`;
	const seen: string[] = [];
	let cursor: string | null = null;
	for (let count = 0; count < 30; count++) {
		const response = await fetch(
			`${baseUrl}/api/v3/admin/audit?action=${action}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
			{ headers },
		);
		expect(response.status).toBe(200);
		const page = ScopedPlatformAuditPageV1Schema.parse(await response.json());
		seen.push(...page.items.map((item: { auditId: string }) => item.auditId));
		cursor = page.nextCursor;
		if (!cursor) break;
	}
	expect(seen).toEqual(rows.map((row) => row.id));
	const row = rows[0];
	if (!row) throw new Error("Missing real producer fact");
	for (const mutate of [
		(d: Record<string, unknown>) => ({ ...d, token: "PRIVATE_AUDIT_SENTINEL" }),
		(d: Record<string, unknown>) => ({ ...d, returnedMaterial: true }),
		(d: Record<string, unknown>) => ({
			...d,
			recipient: { principalType: "system", principalId: "recipient" },
		}),
		(d: Record<string, unknown>) => ({
			...d,
			deliveryStatus: "delivery_pending",
		}),
	]) {
		await sql`update platform.audit_events set details=${sql.json(mutate(row.details) as Parameters<typeof sql.json>[0])} where id=${row.id}`;
		try {
			for (const suffix of [`/${row.id}`, `?action=${action}`]) {
				const response = await fetch(`${baseUrl}/api/v3/admin/audit${suffix}`, {
					headers,
				});
				expect(response.status).toBe(503);
				const text = await response.text();
				expect(text).not.toContain("PRIVATE_AUDIT_SENTINEL");
				expect(text).not.toContain("details");
			}
		} finally {
			await sql`update platform.audit_events set details=${sql.json(row.details as Parameters<typeof sql.json>[0])} where id=${row.id}`;
		}
	}
	const first = await fetch(
		`${baseUrl}/api/v3/admin/audit?action=${action}&limit=1`,
		{ headers },
	);
	const firstBody = await first.json();
	expect(first.status, JSON.stringify(firstBody)).toBe(200);
	const firstPage = ScopedPlatformAuditPageV1Schema.parse(firstBody);
	expect(firstPage.nextCursor).toBeTruthy();
	if (!firstPage.nextCursor) throw new Error("Missing cursor");
	const cross = await fetch(
		`${baseUrl}/api/v1/audit?action=${action}&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
		{ headers: { Cookie: `__Host-platform-session=${token("manager")}` } },
	);
	expect([400, 404]).toContain(cross.status);
	const forged = await fetch(
		`${baseUrl}/api/v3/admin/audit?cursor=forged-cursor`,
		{ headers },
	);
	expect(forged.status).toBe(404);
	const admin = accounts.find((account) => account.userId === "admin");
	if (!admin) throw new Error("Missing admin");
	const roles = admin.roles;
	Object.assign(admin, { roles: ["employee"] });
	try {
		expect(
			(await fetch(`${baseUrl}/api/v3/admin/audit/${row.id}`, { headers }))
				.status,
		).toBe(404);
	} finally {
		Object.assign(admin, { roles });
	}
});

it("fails closed for malformed application action bindings and required query audit failure", async () => {
	const headers = { Cookie: `__Host-platform-session=${token("admin")}` };
	const actions = [
		"application.credential.issued",
		"application.credential.rotated",
		"application.credential.metadata.read",
		"application.credential.revoked",
	];
	for (const action of actions) {
		const [row] = await sql<
			{ id: string; details: Record<string, unknown> }[]
		>`select id,details from platform.audit_events where action=${action} limit 1`;
		if (!row) throw new Error("Missing producer record");
		const invalid = action.endsWith("metadata.read")
			? { ...row.details, credentialIds: ["a", "a"] }
			: action.endsWith("revoked")
				? { ...row.details, credentialIds: [] }
				: action.endsWith("rotated")
					? { ...row.details, previousCredentialId: row.details.credentialId }
					: { ...row.details, deliveryStatus: "accepted" };
		await sql`update platform.audit_events set details=${sql.json(invalid as Parameters<typeof sql.json>[0])} where id=${row.id}`;
		try {
			expect(
				(await fetch(`${baseUrl}/api/v3/admin/audit/${row.id}`, { headers }))
					.status,
			).toBe(503);
		} finally {
			await sql`update platform.audit_events set details=${sql.json(row.details as Parameters<typeof sql.json>[0])} where id=${row.id}`;
		}
		await sql`update platform.audit_events set actor_type='application' where id=${row.id}`;
		try {
			expect(
				(await fetch(`${baseUrl}/api/v3/admin/audit/${row.id}`, { headers }))
					.status,
			).toBe(503);
		} finally {
			await sql`update platform.audit_events set actor_type='user' where id=${row.id}`;
		}
	}
	await sql`create function platform.fail_application_audit_query_test() returns trigger language plpgsql as $$ begin if new.action = 'audit.query.completed' then raise exception 'PRIVATE_AUDIT_DATABASE_SENTINEL'; end if; return new; end $$`;
	await sql`create trigger fail_application_audit_query_test before insert on platform.audit_events for each row execute function platform.fail_application_audit_query_test()`;
	try {
		const response = await fetch(
			`${baseUrl}/api/v3/admin/audit?action=application.credential.issued`,
			{ headers },
		);
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain(
			"PRIVATE_AUDIT_DATABASE_SENTINEL",
		);
	} finally {
		await sql`drop trigger fail_application_audit_query_test on platform.audit_events`;
		await sql`drop function platform.fail_application_audit_query_test()`;
	}
});
