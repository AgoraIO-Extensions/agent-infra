import { createHash, generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import {
	AgentApiCreationResponseV1Schema,
	ApplicationApiCredentialResponseV1Schema,
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
const token = (user: string) => (user === "admin" ? "b" : "a").repeat(43);
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
				for (const user of ["admin", "manager"]) {
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
		await sql`select principal_type,principal_id,count(*)::int as count from platform.agent_principal_grants group by principal_type,principal_id`,
	).toEqual([
		{ principal_type: "application", principal_id: "app-1", count: 4 },
	]);
	expect(
		await sql`select owner_id from platform.agent_owners order by agent_id`,
	).toEqual([{ owner_id: "manager" }, { owner_id: "manager" }]);
	expect(
		await sql`select purpose,count(*)::int as count from platform.relay_key_versions where purpose='agent-default' group by purpose`,
	).toEqual([{ purpose: "agent-default", count: 2 }]);
	expect(
		JSON.stringify(
			await sql`select ciphertext from platform.relay_key_versions`,
		),
	).not.toContain(agentBody.defaultRelayKey);
	expect(
		await sql`select action,actor_type,actor_id from platform.audit_events where action in ('api.agent.create.accepted','relay_key.agent_default.replace')`,
	).toHaveLength(4);
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
	const replay = await fetch(`${baseUrl}/api/v2/agents`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${replacement}`,
			"Idempotency-Key": "issued-agent-one",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ ...agentBody, name: "Issued Agent One" }),
	});
	expect(replay.status).toBe(200);
	expect(await replay.json()).toMatchObject({
		agentId: first.agentId,
		replayed: true,
	});
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
