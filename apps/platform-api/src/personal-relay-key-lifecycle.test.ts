import { createHash, generateKeyPairSync } from "node:crypto";
import { PassThrough } from "node:stream";
import {
	ScopedPlatformAuditPageV1Schema,
	ScopedPlatformAuditProjectionV1Schema,
} from "@agent-infra/contracts/pilot";
import { createRelayKeyWorkerDecryptorV1 } from "@agent-infra/secret-store/worker";
import postgres from "postgres";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";
import {
	type RelayKeyVersionBindingV1,
	readRelayKeyVersionInTransaction,
} from "../../../packages/platform-store/src/relay-key-versions.ts";
import { setProductionDeploymentInput } from "../../../tests/fixtures/platform-api-production-deployment.ts";
import { createClient } from "../../web/src/pilot/generated-v2/client/index.ts";
import {
	getPersonalRelayKeyV2,
	replacePersonalRelayKeyV2,
	revokePersonalRelayKeyV2,
} from "../../web/src/pilot/generated-v2/sdk.gen.ts";
import type { ProductionPlatformApiInputV1 } from "./deployment.ts";
import {
	createPlatformApiShutdown,
	startPlatformApiFromDeployment,
} from "./index.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
const moduleSpecifier = new URL(
	"../../../tests/fixtures/platform-api-production-deployment.ts",
	import.meta.url,
).href;
const key = "SYNTHETIC_PERSONAL_RELAY_KEY_SENTINEL";
const key2 = "SYNTHETIC_PERSONAL_REPLACEMENT_SENTINEL";
const billingUrl = "https://sub2api.la3.agoralab.co/v1/sub2api/billing";
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
	modulusLength: 3072,
});
const publicDer = publicKey.export({ format: "der", type: "spki" });
const encryptionKeys = {
	schemaVersion: 1,
	activeWrappingKeyVersion: "test-public-1",
	keys: [
		{
			schemaVersion: 1,
			keyVersion: "test-public-1",
			wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
			publicKeySpkiDerBase64: publicDer.toString("base64"),
			publicKeyFingerprint: createHash("sha256")
				.update(publicDer)
				.digest("hex"),
			rsaModulusBits: 3072,
			status: "active",
		},
	],
};
const workerDecryptor = createRelayKeyWorkerDecryptorV1({
	keys: [
		{
			keyVersion: "test-public-1",
			privateKeyPkcs8DerBase64: privateKey
				.export({ format: "der", type: "pkcs8" })
				.toString("base64"),
		},
	],
});
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let mode:
	| "active"
	| "disabled"
	| "final_disabled"
	| "final_other"
	| "final_missing"
	| "final_revision"
	| "final_error"
	| "error" = "active";
let identityCalls = 0;
let billingStatus = 200;
let billingWork: (() => Promise<void>) | undefined;
const logs: string[] = [];
const shutdowns: (() => Promise<void>)[] = [];
const fetchBilling = vi.fn<typeof fetch>(async (url, init) => {
	expect(url).toBe(billingUrl);
	expect(init?.method).toBe("GET");
	expect(init?.redirect).toBe("error");
	await billingWork?.();
	return Response.json(
		{
			object: "sub2api.key_billing",
			schema_version: 1,
			billing_scope: "token",
		},
		{ status: billingStatus },
	);
});

function deploymentInput(): ProductionPlatformApiInputV1 {
	const unused = async (): Promise<never> => {
		throw new Error("Unused controlled dependency");
	};
	return {
		databaseUrl: database.databaseUrl,
		imageRepository: "registry.example.test/agents/codex",
		encryptionKeys,
		identity: {
			async resolve(request) {
				identityCalls++;
				const cookie = request.headers.get("Cookie");
				let userId =
					cookie === "__Host-platform-session=session_alice"
						? "user_alice"
						: cookie === "__Host-platform-session=session_bob"
							? "user_bob"
							: cookie === "__Host-platform-session=session_admin"
								? "user_admin"
								: null;
				if (userId === null || (mode === "final_missing" && identityCalls >= 3))
					return null;
				if (mode === "error" || (mode === "final_error" && identityCalls >= 3))
					throw new Error("PRIVATE_IDENTITY_SENTINEL");
				if (mode === "final_other" && identityCalls >= 3) userId = "user_bob";
				return {
					schemaVersion: 1,
					userId,
					displayName: userId,
					accountStatus:
						mode === "disabled" ||
						(mode === "final_disabled" && identityCalls >= 3)
							? "disabled"
							: "active",
					organizationIds: ["org_1"],
					roles: userId === "user_admin" ? ["system_admin"] : ["employee"],
					authorizationRevision:
						mode === "final_revision" && identityCalls >= 3 ? "r2" : "r1",
				};
			},
			hydrateUsers: unused,
		},
		loadAuthorityContext: async () => ({
			schemaVersion: 1,
			users: [{ userId: "user_alice", accountStatus: "active" }],
			organizationIds: ["org_1"],
		}),
		registry: {
			endpoint: "https://registry.example.test",
			imageReferencePrefix: "registry.example.test/agents",
			admissionPolicyRef: "controlled",
			fetch: unused,
			policy: { authorize: unused },
		},
		templates: [],
		modelCatalog: { revision: "controlled", load: unused },
		channelPolicy: { revision: "controlled", bindings: [] },
		resourceProfile: {
			profileId: "controlled",
			displayName: "Controlled",
			estimatedResources: {
				cpuMillicores: 1000,
				memoryMiB: 1024,
				storageGiB: 1,
			},
		},
		personalRelayKeyValidation: {
			profile: "sub2api-key-billing-v1",
			billingUrl,
			fetch: fetchBilling,
		},
	};
}

async function withHttpResponse<T extends { readonly response?: Response }>(
	pending: Promise<T>,
) {
	const result = await pending;
	if (result.response === undefined)
		throw new Error("Generated client did not receive an HTTP response");
	return { ...result, response: result.response };
}

async function start() {
	setProductionDeploymentInput(deploymentInput());
	const output = new PassThrough();
	output.on("data", (chunk) => logs.push(String(chunk)));
	const running = await startPlatformApiFromDeployment({
		moduleSpecifier,
		port: 0,
		log: (line) => logs.push(line),
		observabilityOptions: { output },
	});
	const shutdown = createPlatformApiShutdown(running);
	shutdowns.push(shutdown);
	const address = running.server.address();
	if (!address || typeof address === "string")
		throw new Error("Test API did not bind");
	const origin = `http://127.0.0.1:${address.port}`;
	const client = createClient({ baseUrl: origin });
	return { client, origin };
}
function replace(
	client: ReturnType<typeof createClient>,
	expectedVersion: number | null,
	keyValue = key,
	auth = "session_alice",
) {
	return withHttpResponse(
		replacePersonalRelayKeyV2({
			client,
			auth,
			body: { expectedVersion, keyValue },
		}),
	);
}
async function counts() {
	const [row] =
		await sql`select (select count(*)::int from platform.relay_key_versions) as versions,
		(select count(*)::int from platform.relay_key_subjects where current_version is not null) as current,
		(select count(*)::int from platform.audit_events where action like 'relay_key.personal.%' and outcome='succeeded') as succeeded`;
	return row;
}
async function auditFailure(deferred: boolean) {
	await sql`create function platform.fail_relay_audit() returns trigger language plpgsql as $$ begin raise exception 'PRIVATE_SQL_SENTINEL'; end $$`;
	await sql.unsafe(
		deferred
			? "create constraint trigger fail_relay_audit after insert on platform.audit_events deferrable initially deferred for each row execute function platform.fail_relay_audit()"
			: "create trigger fail_relay_audit before insert on platform.audit_events for each row execute function platform.fail_relay_audit()",
	);
}
beforeAll(async () => {
	database = await startPostgresTestDatabase("personal-relay-key-http");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 4 });
});
beforeEach(async () => {
	mode = "active";
	identityCalls = 0;
	billingStatus = 200;
	billingWork = undefined;
	logs.length = 0;
	fetchBilling.mockClear();
	await sql`truncate platform.relay_key_versions, platform.relay_key_subjects, platform.platform_user_disables, platform.audit_events cascade`;
	vi.spyOn(console, "error").mockImplementation((...args) =>
		logs.push(JSON.stringify(args)),
	);
});
afterEach(async () => {
	for (const shutdown of shutdowns.splice(0).reverse()) await shutdown();
	await sql`drop trigger if exists fail_relay_audit on platform.audit_events`;
	await sql`drop function if exists platform.fail_relay_audit()`;
	for (const sentinel of [
		key,
		key2,
		"PRIVATE_SQL_SENTINEL",
		"PRIVATE_IDENTITY_SENTINEL",
	])
		expect(logs.join("\n")).not.toContain(sentinel);
	vi.restoreAllMocks();
});
afterAll(async () => {
	await sql?.end();
	await database?.stop();
});

describe("real PostgreSQL personal Relay Key through production HTTP assembly and generated client", () => {
	it("bounds anonymous refusal audit while an independent transaction holds the audit table lock", async () => {
		const { origin } = await start();
		const blocker = postgres(database.databaseUrl, { max: 1 });
		let locked!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			locked = resolve;
		});
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const holding = blocker.begin(async (transaction) => {
			await transaction.unsafe(
				"lock table platform.audit_events in access exclusive mode",
			);
			locked();
			await released;
		});
		try {
			await entered;
			// The blocker remains held until after the HTTP result: no guessed elapsed threshold.
			const response = await fetch(origin.concat("/api/v2/me/relay-key"));
			expect(response.status).toBe(503);
			expect(JSON.stringify(await response.json())).not.toContain(key);
		} finally {
			release();
			await holding;
			await blocker.end();
		}
		expect(await counts()).toEqual({ versions: 0, current: 0, succeeded: 0 });
	});
	it("projects all three actions and anonymous refusals through the public scoped admin audit HTTP API", async () => {
		const { client, origin } = await start();
		await withHttpResponse(
			getPersonalRelayKeyV2({ client, auth: "session_alice" }),
		);
		expect((await replace(client, null)).response.status).toBe(200);
		expect((await replace(client, null)).response.status).toBe(409);
		expect(
			(
				await withHttpResponse(
					revokePersonalRelayKeyV2({
						client,
						auth: "session_alice",
						body: { expectedVersion: 1 },
					}),
				)
			).response.status,
		).toBe(200);
		expect((await fetch(origin.concat("/api/v2/me/relay-key"))).status).toBe(
			401,
		);
		const adminHeaders = { Cookie: "__Host-platform-session=session_admin" };
		const response = await fetch(origin.concat("/api/v3/admin/audit"), {
			headers: adminHeaders,
		});
		expect(response.status).toBe(200);
		const page = ScopedPlatformAuditPageV1Schema.parse(await response.json());
		const personal = page.items.filter((item) =>
			item.action.startsWith("relay_key.personal."),
		);
		expect(personal).toHaveLength(5);
		for (const action of [
			"relay_key.personal.read",
			"relay_key.personal.replace",
			"relay_key.personal.revoke",
		])
			expect(personal).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						action,
						result: "succeeded",
						actor: { kind: "user", actorId: "user_alice" },
						subject: { kind: "secret", subjectId: "user_alice" },
						summary: action,
					}),
				]),
			);
		const refusal = personal.find((item) => item.actor.kind === "unknown");
		expect(refusal).toMatchObject({
			action: "relay_key.personal.read",
			result: "rejected",
			actor: { kind: "unknown", actorId: "unknown" },
			subject: { kind: "secret", subjectId: "unknown" },
		});
		expect(personal).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					action: "relay_key.personal.replace",
					result: "rejected",
					summary: "relay_key.personal.replace",
				}),
			]),
		);
		for (const item of personal) {
			expect(item).not.toHaveProperty("details");
			expect(item.taskApi).toBeNull();
			expect(item.operation).toBeNull();
			expect(item.originalPrincipal).toBeNull();
			const detail = await fetch(
				origin.concat("/api/v3/admin/audit/", item.auditId),
				{ headers: adminHeaders },
			);
			expect(detail.status).toBe(200);
			expect(
				ScopedPlatformAuditProjectionV1Schema.parse(await detail.json()),
			).toEqual(item);
		}
		expect(refusal).toBeDefined();
		if (!refusal) throw new Error("Anonymous refusal audit missing");
		expect(
			(
				await fetch(origin.concat("/api/v3/admin/audit/", refusal.auditId), {
					headers: { Cookie: "__Host-platform-session=session_alice" },
				})
			).status,
		).toBe(404);
		expect(
			(
				await fetch(origin.concat("/api/v3/admin/audit"), {
					headers: { Cookie: "__Host-platform-session=session_bob" },
				})
			).status,
		).toBe(404);
		expect((await fetch(origin.concat("/api/v3/admin/audit"))).status).toBe(
			401,
		);
		const versions = await sql.unsafe(
			"select key_id, ciphertext from platform.relay_key_versions",
		);
		const publicJson = JSON.stringify(page);
		for (const sentinel of [
			key,
			key2,
			"PRIVATE_SQL_SENTINEL",
			"PRIVATE_IDENTITY_SENTINEL",
		])
			expect(publicJson).not.toContain(sentinel);
		for (const row of versions) {
			expect(publicJson).not.toContain(row.key_id);
			expect(publicJson).not.toContain(JSON.stringify(row.ciphertext));
		}
	});
	it("runs submit/read/replace/stale/revoke/re-add with monotonic versions and no Key responses", async () => {
		const { client } = await start();
		const initial = await withHttpResponse(
			getPersonalRelayKeyV2({
				client,
				auth: "session_alice",
			}),
		);
		expect(initial.data).toEqual({
			schemaVersion: 1,
			isSet: false,
			keyVersion: null,
		});
		const first = await replace(client, null);
		expect(first.data).toEqual({
			schemaVersion: 1,
			isSet: true,
			keyVersion: 1,
		});
		expect(first.response.headers.get("Cache-Control")).toBe("no-store");
		expect(first.response.headers.get("Referrer-Policy")).toBe("no-referrer");
		const [versionRow] =
			await sql`select key_id, ciphertext from platform.relay_key_versions where purpose='personal' and subject_id='user_alice' and key_version=1`;
		const original: RelayKeyVersionBindingV1 = {
			purpose: "personal",
			subjectId: "user_alice",
			keyId: versionRow?.key_id,
			keyVersion: 1,
		};
		expect((await replace(client, 1, key2)).data?.keyVersion).toBe(2);
		expect((await replace(client, 1)).response.status).toBe(409);
		expect(
			(
				await withHttpResponse(
					revokePersonalRelayKeyV2({
						client,
						auth: "session_alice",
						body: { expectedVersion: 2 },
					}),
				)
			).data,
		).toEqual({ schemaVersion: 1, isSet: false, keyVersion: null });
		expect((await replace(client, null)).data?.keyVersion).toBe(3);
		const encryptedRecord = await sql.begin((tx) =>
			readRelayKeyVersionInTransaction(tx, original),
		);
		const decrypted = await workerDecryptor.decrypt({
			encryptedRecord,
			expectedBinding: original,
		});
		expect(decrypted.outcome).toBe("decrypted");
		if (decrypted.outcome === "decrypted") {
			expect(Buffer.from(decrypted.plaintext).toString()).toBe(key);
			decrypted.plaintext.fill(0);
		}
		const crossSubject = await workerDecryptor.decrypt({
			encryptedRecord,
			expectedBinding: { ...original, subjectId: "user_bob" },
		});
		expect(crossSubject.outcome).toBe("failed");
		const persisted =
			await sql`select ciphertext from platform.relay_key_versions`;
		const audit =
			await sql`select actor_id, details, outcome from platform.audit_events`;
		for (const value of [initial.data, first.data, persisted, audit])
			expect(JSON.stringify(value)).not.toContain(key);
		expect(audit).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					actor_id: "user_alice",
					outcome: "rejected",
					details: { reason: "conflict" },
				}),
			]),
		);
	});
	it("isolates two concurrent browser sessions and admits one concurrent CAS winner", async () => {
		const { client } = await start();
		const pair = await Promise.all([
			replace(client, null),
			replace(client, null, key2, "session_bob"),
		]);
		expect(pair.map((r) => r.response.status)).toEqual([200, 200]);
		const cas = await Promise.all([
			replace(client, 1),
			replace(client, 1, key2),
		]);
		expect(cas.map((r) => r.response.status).sort()).toEqual([200, 409]);
		expect(
			(
				await withHttpResponse(
					getPersonalRelayKeyV2({ client, auth: "session_bob" }),
				)
			).data?.keyVersion,
		).toBe(1);
		expect(await counts()).toMatchObject({ versions: 3, current: 2 });
	});
	it.each([
		"final_disabled",
		"final_other",
		"final_missing",
		"final_revision",
		"final_error",
	] as const)(
		"rolls back mutation and success audit on %s",
		async (finalMode) => {
			const { client } = await start();
			mode = finalMode;
			const result = await replace(client, null);
			expect(result.response.status).toBe(
				finalMode === "final_missing"
					? 401
					: finalMode === "final_revision" || finalMode === "final_error"
						? 503
						: 403,
			);
			expect(await counts()).toEqual({ versions: 0, current: 0, succeeded: 0 });
			expect(JSON.stringify(result.error)).not.toContain(key);
		},
	);
	it.each([false, true])(
		"rolls back on immediate/deferred audit failure (deferred=%s)",
		async (deferred) => {
			const { client } = await start();
			await auditFailure(deferred);
			const result = await replace(client, null);
			expect(result.response.status).toBe(503);
			expect(await counts()).toEqual({ versions: 0, current: 0, succeeded: 0 });
			expect(JSON.stringify(result.error)).not.toMatch(
				/PRIVATE_SQL_SENTINEL|SYNTHETIC_PERSONAL/,
			);
		},
	);
	it.each([401, 503])(
		"does not mutate on billing status %i",
		async (status) => {
			const { client } = await start();
			billingStatus = status;
			expect((await replace(client, null)).response.status).toBe(
				status === 401 ? 400 : 503,
			);
			expect(await counts()).toEqual({ versions: 0, current: 0, succeeded: 0 });
		},
	);
	it("rejects caller selectors/Bearer/malformed values before billing, and Platform disable before commit", async () => {
		const { client, origin } = await start();
		const headers = {
			Cookie: "__Host-platform-session=session_alice",
			"Content-Type": "application/json",
		};
		for (const body of [
			{ expectedVersion: null, keyValue: key, userId: "user_bob" },
			{ expectedVersion: 0, keyValue: key },
			{ expectedVersion: null, keyValue: "bad\nkey" },
		]) {
			const response = await fetch(`${origin}/api/v2/me/relay-key`, {
				method: "PUT",
				headers,
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(400);
			expect(response.headers.get("Cache-Control")).toBe("no-store");
		}
		expect(
			(
				await fetch(`${origin}/api/v2/me/relay-key?userId=user_bob`, {
					headers,
				})
			).status,
		).toBe(400);
		expect(
			(
				await fetch(`${origin}/api/v2/me/relay-key`, {
					headers: {
						...headers,
						Authorization: "Bearer SYNTHETIC_CALLER_SENTINEL",
					},
				})
			).status,
		).toBe(401);
		await sql`insert into platform.platform_user_disables (user_id) values ('user_alice')`;
		expect((await replace(client, null)).response.status).toBe(403);
		expect(fetchBilling).not.toHaveBeenCalled();
		expect(await counts()).toEqual({ versions: 0, current: 0, succeeded: 0 });
	});
	it("orders a new disable INSERT after the Key transaction's missing-row D lock", async () => {
		const { client } = await start();
		let enter!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolve) => {
			enter = resolve;
		});
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		billingWork = async () => {
			enter();
			await released;
		};
		const pending = replace(client, null);
		await entered;
		let disabled = false;
		const blocker = postgres(database.databaseUrl, { max: 1 });
		try {
			const [pid] = await blocker`select pg_backend_pid() as pid`;
			const disabling =
				blocker`insert into platform.platform_user_disables (user_id) values ('user_alice')`.then(
					() => {
						disabled = true;
					},
				);
			let waited = false;
			for (let attempt = 0; attempt < 100; attempt++) {
				const [row] =
					await sql`select wait_event_type from pg_stat_activity where pid=${pid?.pid}`;
				if (row?.wait_event_type === "Lock") {
					waited = true;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(waited).toBe(true);
			expect(disabled).toBe(false);
			release();
			expect((await pending).response.status).toBe(200);
			await disabling;
			billingWork = undefined;
			expect((await replace(client, 1)).response.status).toBe(403);
		} finally {
			release();
			await pending;
			await blocker.end();
		}
	});
});
