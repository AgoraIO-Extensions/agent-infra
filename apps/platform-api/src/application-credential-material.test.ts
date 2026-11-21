import { once } from "node:events";
import { Server } from "node:http";
import {
	ApplicationCredentialMaterialMetadataV1Schema,
	ApplicationCredentialMaterialResponseV1Schema,
	ApplicationMaterialGrantResponseV1Schema,
} from "@agent-infra/contracts/pilot";
import { migratePlatformDatabase } from "@agent-infra/platform-store";
import { serve } from "@hono/node-server";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";
import { createPlatformApp } from "./app.js";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";
import { startPlatformApi } from "./index.js";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let assembly: PlatformApiAssembly;
let assemblyInput: Parameters<typeof assemblePlatformApi>[0];
let server: ReturnType<typeof serve>;
let origin: string;
const publicOrigin = "https://platform.example.test";
const path = "/api/v2/applications/app-1/credential-material-deliveries";
const command = {
	schemaVersion: 1,
	operation: "issue",
	recipient: { principalType: "user", principalId: "recipient" },
	scopes: ["agent:read"],
	expiresAt: null,
};
const disabled = new Set<string>();
const revisions = new Map<string, string>();
const current = (userId: string) => ({
	schemaVersion: 1 as const,
	userId,
	accountStatus: disabled.has(userId)
		? ("disabled" as const)
		: ("active" as const),
	organizationIds: [],
	authorizationRevision: revisions.get(userId) ?? "identity-1",
});
const unused = async (): Promise<never> => {
	throw new Error("Unrelated adapter called");
};

beforeAll(async () => {
	database = await startPostgresTestDatabase("material-delivery-4264");
	await migratePlatformDatabase(database);
	sql = postgres(database.databaseUrl, { max: 4 });
	assemblyInput = {
		databaseUrl: database.databaseUrl,
		taskAdmissionPolicy: {
			maximumWaitingTasksPerAgent: 2,
			waitingTimeoutMs: 60_000,
		},
		identity: {
			resolve: async (request) => {
				const userId = request.headers
					.get("cookie")
					?.match(/^fixture=(manager|recipient|other|admin)$/)?.[1];
				return userId
					? {
							...current(userId),
							displayName: userId,
							roles:
								userId === "admin"
									? ["employee", "system_admin"]
									: ["employee"],
						}
					: null;
			},
			hydrateUsers: async () => ({ schemaVersion: 1, users: [] }),
			resolveUser: async (userId) => current(userId),
			resolveMaterialGrantActor: async (userId) => ({
				userId,
				accountStatus: current(userId).accountStatus,
				authorizationRevision: current(userId).authorizationRevision,
				isSystemAdmin: userId === "admin",
				ldapStableUid: `ldap-${userId}`,
				ldapAdministratorConfigured: userId === "admin",
			}),
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
		...{
			applicationCredentialMaterialDelivery: {
				schemaVersion: 1,
				enabled: true,
				publicOrigin,
				recipients: [
					{
						applicationId: "app-1",
						principalType: "user",
						principalId: "recipient",
					},
				],
			},
		},
	};
	assembly = assemblePlatformApi(assemblyInput);
	server = startPlatformApi({
		dependencies: assembly.dependencies,
		port: 0,
		log: () => {},
	});
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Listener unavailable");
	origin = `http://127.0.0.1:${address.port}`;
}, 120_000);

beforeEach(async () => {
	disabled.clear();
	revisions.clear();
	await sql`truncate platform.platform_applications, platform.platform_api_credentials, platform.idempotency_records, platform.audit_events, platform.platform_user_disables cascade`;
	await sql`insert into platform.platform_applications (id,name,responsible_user_id,authorization_revision) values ('app-1','Test application','manager','app-1')`;
	expect(
		(
			await post(
				"/api/v2/applications/app-1/material-grant",
				command.recipient,
				"admin",
			)
		).status,
	).toBe(201);
});
afterAll(async () => {
	if (server instanceof Server) server.closeAllConnections();
	if (server)
		await new Promise<void>((resolve) => server.close(() => resolve()));
	await assembly?.close();
	await sql?.end();
	await database?.stop();
});
function post(
	target: string,
	body: unknown,
	user = "manager",
	key = "intent-1",
) {
	return fetch(`${origin}${target}`, {
		method: "POST",
		headers: {
			Cookie: `fixture=${user}`,
			Origin: publicOrigin,
			"Content-Type": "application/json",
			"Idempotency-Key": key,
		},
		body: JSON.stringify(body),
	});
}

it("registers a grant-bound intent through the default assembly without creating material or a credential", async () => {
	const response = await post(path, command);
	expect(response.status).toBe(201);
	const intent = ApplicationCredentialMaterialMetadataV1Schema.parse(
		await response.json(),
	);
	expect(intent).toMatchObject({
		schemaVersion: 1,
		applicationId: "app-1",
		status: "delivery_pending",
		phase: "pending",
		recipient: command.recipient,
		replayed: false,
	});
	expect(intent).not.toHaveProperty("material");
	expect(
		await sql`select id from platform.platform_api_credentials`,
	).toHaveLength(0);
	const replay = await post(path, command);
	expect(replay.status).toBe(200);
	expect(await replay.json()).toMatchObject({
		attemptId: intent.attemptId,
		replayed: true,
	});
	expect(
		(await post(path, { ...command, scopes: ["agent:manage"] })).status,
	).toBe(409);
});

it("carries the authorized material response through the production Node listener", async () => {
	const intent = ApplicationCredentialMaterialMetadataV1Schema.parse(
		await (await post(path, command)).json(),
	);
	const response = await post(
		`${path}/${intent.attemptId}/receive`,
		{ schemaVersion: 1 },
		"recipient",
	);
	expect(response.status).toBe(200);
	const body = ApplicationCredentialMaterialResponseV1Schema.parse(
		await response.json(),
	);
	expect(body.kind).toBe("material");
	expect(
		await sql`select id from platform.platform_api_credentials`,
	).toHaveLength(1);
});

it("sends material only to the authenticated grantee once, then requires a separate confirmation", async () => {
	const intent = ApplicationCredentialMaterialMetadataV1Schema.parse(
		await (await post(path, command)).json(),
	);
	const target = `${path}/${intent.attemptId}`;
	expect(
		(await post(`${target}/receive`, { schemaVersion: 1 }, "manager")).status,
	).toBe(404);
	const received = await post(
		`${target}/receive`,
		{ schemaVersion: 1 },
		"recipient",
	);
	expect(received.status).toBe(200);
	const secretResponse = ApplicationCredentialMaterialResponseV1Schema.parse(
		await received.json(),
	);
	expect(secretResponse.kind).toBe("material");
	if (secretResponse.kind !== "material")
		throw new Error("Material response absent");
	const material = secretResponse.material;
	expect(
		typeof material === "string" && /^papi_[A-Za-z0-9_-]{43}$/.test(material),
	).toBe(true);
	const pending = await fetch(`${origin}${target}`, {
		headers: { Cookie: "fixture=recipient" },
	});
	const metadata = ApplicationCredentialMaterialMetadataV1Schema.parse(
		await pending.json(),
	);
	expect(metadata).toMatchObject({
		phase: "transmitted",
		status: "delivery_in_flight",
	});
	expect(JSON.stringify(metadata).includes(material)).toBe(false);
	const replay = ApplicationCredentialMaterialResponseV1Schema.parse(
		await (
			await post(`${target}/receive`, { schemaVersion: 1 }, "recipient")
		).json(),
	);
	expect(replay.kind).toBe("metadata");
	expect(JSON.stringify(replay).includes(material)).toBe(false);
	const confirmed = await post(
		`${target}/confirm`,
		{
			schemaVersion: 1,
			credentialId: intent.credentialId,
			fence: secretResponse.delivery.fence,
		},
		"recipient",
	);
	expect(confirmed.status).toBe(200);
	expect(await confirmed.json()).toMatchObject({
		status: "accepted",
		phase: "accepted",
	});
	const audits = await sql`select details from platform.audit_events`;
	const receipts = await sql`select result from platform.idempotency_records`;
	expect(JSON.stringify({ audits, receipts }).includes(material)).toBe(false);
});

it("rejects ungranted or changed identities, cross-application access and caller-selected destinations", async () => {
	const intent = ApplicationCredentialMaterialMetadataV1Schema.parse(
		await (await post(path, command)).json(),
	);
	for (const user of ["manager", "admin", "other"])
		expect(
			(
				await post(
					`${path}/${intent.attemptId}/receive`,
					{ schemaVersion: 1 },
					user,
				)
			).status,
		).toBe(404);
	expect(
		(
			await post(
				`${path}/${intent.attemptId}/receive`,
				{ schemaVersion: 1, recipient: command.recipient },
				"recipient",
			)
		).status,
	).toBe(400);
	revisions.set("recipient", "identity-2");
	expect(
		(
			await post(
				`${path}/${intent.attemptId}/receive`,
				{ schemaVersion: 1 },
				"recipient",
			)
		).status,
	).toBe(403);
	expect(
		(
			await post(path, {
				...command,
				callbackUrl: "https://other.example.test",
			})
		).status,
	).toBe(400);
	expect(
		(
			await post(
				`/api/v2/applications/other/credential-material-deliveries/${intent.attemptId}/receive`,
				{ schemaVersion: 1 },
				"recipient",
			)
		).status,
	).toBe(404);
	expect(
		await sql`select id from platform.platform_api_credentials`,
	).toHaveLength(0);
});
it("refuses receiving after formal grant revocation", async () => {
	const intent = ApplicationCredentialMaterialMetadataV1Schema.parse(
		await (await post(path, command)).json(),
	);
	const grant = ApplicationMaterialGrantResponseV1Schema.parse(
		await (
			await fetch(
				`${origin}/api/v2/applications/app-1/material-grant/user/recipient`,
				{ headers: { Cookie: "fixture=admin" } },
			)
		).json(),
	);
	const revoked = await fetch(
		`${origin}/api/v2/applications/app-1/material-grant/user/recipient`,
		{
			method: "PATCH",
			headers: {
				Cookie: "fixture=admin",
				Origin: publicOrigin,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				status: "revoked",
				expectedRevision: grant.metadata.authorizationRevision,
			}),
		},
	);
	expect(revoked.status).toBe(200);
	expect(
		(
			await post(
				`${path}/${intent.attemptId}/receive`,
				{ schemaVersion: 1 },
				"recipient",
			)
		).status,
	).toBe(403);
	expect(
		await sql`select id from platform.platform_api_credentials`,
	).toHaveLength(0);
});
it("expires the original intent without generating or refreshing its deadline", async () => {
	const intent = ApplicationCredentialMaterialMetadataV1Schema.parse(
		await (await post(path, command)).json(),
	);
	await sql`update platform.idempotency_records set result=jsonb_set(result,'{expiresAt}',to_jsonb('2000-01-01T00:00:00.000Z'::text)) where command_type='application.credential.material.v1'`;
	const response = await (
		await post(
			`${path}/${intent.attemptId}/receive`,
			{ schemaVersion: 1 },
			"recipient",
		)
	).json();
	expect(response).toMatchObject({
		kind: "metadata",
		delivery: { status: "failed", expiresAt: "2000-01-01T00:00:00.000Z" },
	});
	expect(
		await sql`select id from platform.platform_api_credentials`,
	).toHaveLength(0);
});
it("preserves unknown after transmission audit fails and never resends the material", async () => {
	await sql`create function platform.material_audit_failure() returns trigger language plpgsql as $$ begin if NEW.action='application.credential.material.transmitted' then raise exception 'controlled audit failure'; end if; return NEW; end $$`;
	await sql`create trigger material_audit_failure before insert on platform.audit_events for each row execute function platform.material_audit_failure()`;
	try {
		const intent = ApplicationCredentialMaterialMetadataV1Schema.parse(
			await (await post(path, command)).json(),
		);
		const target = `${path}/${intent.attemptId}`;
		const first = ApplicationCredentialMaterialResponseV1Schema.parse(
			await (
				await post(`${target}/receive`, { schemaVersion: 1 }, "recipient")
			).json(),
		);
		if (first.kind !== "material") throw new Error("Material response absent");
		expect(first.kind).toBe("material");
		const replay = ApplicationCredentialMaterialResponseV1Schema.parse(
			await (
				await post(`${target}/receive`, { schemaVersion: 1 }, "recipient")
			).json(),
		);
		expect(replay.kind).toBe("metadata");
		await vi.waitFor(async () => {
			const metadata = ApplicationCredentialMaterialMetadataV1Schema.parse(
				await (
					await fetch(`${origin}${target}`, {
						headers: { Cookie: "fixture=recipient" },
					})
				).json(),
			);
			expect(metadata.status).toBe("unknown");
		});
		expect(JSON.stringify(replay).includes(first.material)).toBe(false);
		expect(
			(
				await post(
					`${target}/confirm`,
					{
						schemaVersion: 1,
						credentialId: intent.credentialId,
						fence: first.delivery.fence,
					},
					"recipient",
				)
			).status,
		).toBe(503);
	} finally {
		await sql`drop trigger material_audit_failure on platform.audit_events`;
		await sql`drop function platform.material_audit_failure()`;
	}
});
it("uses the same PostgreSQL claim across independent API replicas", async () => {
	const replica = assemblePlatformApi(assemblyInput);
	const listener = serve({
		fetch: createPlatformApp(replica.dependencies).fetch,
		hostname: "127.0.0.1",
		port: 0,
	});
	await once(listener, "listening");
	try {
		const address = listener.address();
		if (!address || typeof address === "string")
			throw new Error("Listener unavailable");
		const intent = ApplicationCredentialMaterialMetadataV1Schema.parse(
			await (await post(path, command)).json(),
		);
		const target = `${path}/${intent.attemptId}/receive`;
		const responses = await Promise.all([
			post(target, { schemaVersion: 1 }, "recipient"),
			fetch(`http://127.0.0.1:${address.port}${target}`, {
				method: "POST",
				headers: {
					Cookie: "fixture=recipient",
					Origin: publicOrigin,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ schemaVersion: 1 }),
			}),
		]);
		const bodies = await Promise.all(
			responses.map(async (r) =>
				ApplicationCredentialMaterialResponseV1Schema.parse(await r.json()),
			),
		);
		expect(bodies.filter((b) => b.kind === "material").length).toBe(1);
		expect(bodies.filter((b) => b.kind === "metadata").length).toBe(1);
		expect(
			await sql`select id from platform.platform_api_credentials`,
		).toHaveLength(1);
	} finally {
		if (listener instanceof Server) listener.closeAllConnections();
		await new Promise<void>((resolve) => listener.close(() => resolve()));
		await replica.close();
	}
});
it("keeps an unconfigured production assembly closed", async () => {
	const replica = assemblePlatformApi({
		...assemblyInput,
		applicationCredentialMaterialDelivery: undefined,
	});
	try {
		const response = await createPlatformApp(replica.dependencies).request(
			path,
			{
				method: "POST",
				headers: {
					Cookie: "fixture=manager",
					Origin: publicOrigin,
					"Content-Type": "application/json",
					"Idempotency-Key": "closed",
				},
				body: JSON.stringify(command),
			},
		);
		expect(response.status).toBe(503);
		expect(
			await sql`select id from platform.platform_api_credentials`,
		).toHaveLength(0);
	} finally {
		await replica.close();
	}
});

it("exposes only allowlisted material audit metadata to administrators and never logs or lists the value", async () => {
	const logged: unknown[] = [];
	const capture = vi.spyOn(console, "error").mockImplementation((...args) => {
		logged.push(args);
	});
	try {
		const intent = ApplicationCredentialMaterialMetadataV1Schema.parse(
			await (await post(path, command)).json(),
		);
		const received = ApplicationCredentialMaterialResponseV1Schema.parse(
			await (
				await post(
					`${path}/${intent.attemptId}/receive`,
					{ schemaVersion: 1 },
					"recipient",
				)
			).json(),
		);
		if (received.kind !== "material")
			throw new Error("Material response absent");
		const listed = await (
			await fetch(`${origin}/api/v2/applications/app-1/credentials`, {
				headers: { Cookie: "fixture=manager" },
			})
		).json();
		expect(JSON.stringify(listed).includes(received.material)).toBe(false);
		expect(JSON.stringify(logged).includes(received.material)).toBe(false);
		const audit = await fetch(
			`${origin}/api/v3/admin/audit?action=application.credential.material.transmitted`,
			{ headers: { Cookie: "fixture=admin" } },
		);
		expect(audit.status).toBe(200);
		const page = await audit.json();
		expect(JSON.stringify(page).includes(received.material)).toBe(false);
		expect(
			(
				await fetch(
					`${origin}/api/v3/admin/audit?action=application.credential.material.transmitted`,
					{ headers: { Cookie: "fixture=manager" } },
				)
			).status,
		).toBe(404);
	} finally {
		capture.mockRestore();
	}
});

it("keeps authorized history readable on a disabled replica without reopening admission", async () => {
	const intent = ApplicationCredentialMaterialMetadataV1Schema.parse(
		await (await post(path, command)).json(),
	);
	await (
		await post(
			`${path}/${intent.attemptId}/receive`,
			{ schemaVersion: 1 },
			"recipient",
		)
	).arrayBuffer();
	const replica = assemblePlatformApi({
		...assemblyInput,
		applicationCredentialMaterialDelivery: { schemaVersion: 1, enabled: false },
	});
	const listener = serve({
		fetch: createPlatformApp(replica.dependencies).fetch,
		hostname: "127.0.0.1",
		port: 0,
	});
	await once(listener, "listening");
	const address = listener.address();
	if (!address || typeof address === "string")
		throw new Error("Listener absent");
	const app = {
		request: (path: string, init?: RequestInit) =>
			fetch(`http://127.0.0.1:${address.port}${path}`, init),
	};
	try {
		for (const user of ["manager", "recipient"]) {
			const response = await app.request(`${path}/${intent.attemptId}`, {
				headers: { Cookie: `fixture=${user}` },
			});
			expect(response.status).toBe(200);
			expect(
				Object.hasOwn(
					ApplicationCredentialMaterialMetadataV1Schema.parse(
						await response.json(),
					),
					"material",
				),
			).toBe(false);
		}
		expect(
			(
				await app.request(`${path}/${intent.attemptId}`, {
					headers: { Cookie: "fixture=other" },
				})
			).status,
		).toBe(404);
		for (const target of [path, `${path}/${intent.attemptId}/receive`])
			expect(
				(
					await app.request(target, {
						method: "POST",
						headers: {
							Cookie: "fixture=recipient",
							Origin: publicOrigin,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({ schemaVersion: 1 }),
					})
				).status,
			).toBe(503);
	} finally {
		if (listener instanceof Server) listener.closeAllConnections();
		await new Promise<void>((resolve) => listener.close(() => resolve()));
		await replica.close();
	}
});
