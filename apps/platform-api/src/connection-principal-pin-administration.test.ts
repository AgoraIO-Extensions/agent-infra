import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { connectionSystemAccessFingerprintV1 } from "@agent-infra/contracts/connection-consumer-profile";
import type {
	createLdapIdentityDirectory,
	LdapAccount,
} from "@agent-infra/identity";
import {
	migratePlatformDatabase,
	PostgresConnectionPrincipalPinAdministrationV1,
} from "@agent-infra/platform-store";
import { serve } from "@hono/node-server";
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
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.ts";
import { createPlatformApp } from "./app.js";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";
import { createLdapBrowserAdapter } from "./ldap-browser.js";

// §13.5.1 exception items 4 and 6: the audited operations entry for exception
// pins. Real HTTP, assembly, Core and PostgreSQL; LDAP and the session store
// are controlled ports, as in the material-grant governance test.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 120_000 });
const origin = "https://platform.example.test";
const admin: LdapAccount = {
	uid: "stable-admin",
	userId: "admin-1",
	email: "admin@example.test",
	displayName: "Admin",
	accountStatus: "active",
	roles: ["employee", "system_admin"],
	authorizationRevision: "ldap-1",
};
const system = {
	schemaVersion: 1 as const,
	publicOrigin: "https://connection.test",
	mcpPath: "/mcp",
	audience: "mcp",
	egressProfile: { ref: "egress", revision: "r1" },
	issuer: "https://connection.test/",
	oauthCallbackUrl: "https://platform.test/connection/callback",
};
const systemApproval = {
	schemaVersion: 1 as const,
	configFingerprint: connectionSystemAccessFingerprintV1(system),
	egressEnforced: true as const,
	source: { ref: "platform-deployment", revision: "r1" },
};
/** The approved §13.5.1 exception; without it the entry is never assembled. */
const policy = {
	systemAccess: system,
	approval: systemApproval,
	clientName: "Agent Infra",
	dynamic: {
		schemaVersion: 1 as const,
		principalMapping: {
			schemaVersion: 1 as const,
			kind: "consistency-exception-v1" as const,
			policy: { ref: "consistency-exception-v1", revision: "r1" },
			notAfter: "2099-01-01T00:00:00Z",
			maximumPinnedPrincipals: 2,
			verificationWindowHours: 24,
			connectionRelease: "agora-connector-2019ca07",
			systemAccessFingerprint: connectionSystemAccessFingerprintV1(system),
			approvalSource: systemApproval.source,
		},
		readbackContract: { ref: "connection-ep-1060-read", revision: "1" },
		publicationContract: { ref: "connection-mcp-publication", revision: "1" },
	},
	confirmedPrincipals: [],
};
const reference =
	"https://github.com/AgoraIO-Extensions/agent-infra/issues/4199";

let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let assembly: PlatformApiAssembly;
let server: ReturnType<typeof serve>;
let baseUrl: string;
let rules: PostgresConnectionPrincipalPinAdministrationV1;
/** The API assembled with or without the approved exception. */
let assemble: (
	manualInstallation: typeof policy | undefined,
) => PlatformApiAssembly;
let account: LdapAccount | null;
let disabled: boolean;
let sessionLive: boolean;
const currentByUserId = vi.fn(
	async (_id: string): Promise<LdapAccount | null> => account,
);

async function seedFoundation() {
	for (const agentId of ["agent-a", "agent-b"])
		await sql`insert into platform.agents(id,authorization_revision) values (${agentId},'agent-r1')`;
	await sql`insert into platform.relay_key_subjects(purpose,subject_id,last_version,current_version) values ('personal','alice',1,1)`;
	await sql`insert into platform.relay_key_versions(purpose,subject_id,key_version,key_id,ciphertext) values ('personal','alice',1,'fixture-key-alice',${sql.json({ purpose: "personal", subjectId: "alice", keyId: "fixture-key-alice", keyVersion: 1 })})`;
	await sql`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision,host_session_ref) values ('conversation-a','agent-a','alice','web','active',1,'agent-r1','host-a')`;
	await sql`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at,runtime_submit_protocol,original_operation_digest,original_submit_host_session_ref,execution_source,relay_key_purpose,relay_key_subject_id,relay_key_id,relay_key_version,delivery_fence) values ('execution-a','conversation-a','agent-a','alice','web','turn-a','processing',1,'agent-r1',now(),'v4',${"a".repeat(43)},'host-a','web','personal','alice','fixture-key-alice',1,3)`;
}

async function seedPin(id: string, userId: string, principalId: string) {
	await sql`insert into platform.connection_principal_pins
		(id, issuer, principal_id, user_id, policy_ref, policy_revision, verification_deadline)
		values (${id}, ${system.issuer}, ${principalId}, ${userId}, 'consistency-exception-v1', 'r1',
			clock_timestamp() + interval '1 day')`;
}

/** A confirmed exception installation that holds a Connection client. */
async function seedInstallation(id: string, userId: string, agentId: string) {
	await sql`insert into platform.connection_installation_authorizations
		(id, execution_id, user_id, confirmation_revision, binding, identity_revision,
		 agent_authorization_revision, status, expires_at)
		values (${id}, 'execution-a', ${userId}, 'confirmation-r1',
			${sql.json({ principal: { kind: "user", id: userId }, reference: { executionId: "execution-a" } })},
			'identity-r1', 'agent-r1', 'confirmed', clock_timestamp() + interval '1 hour')`;
	await sql`insert into platform.connection_manual_installations
		(authorization_id, agent_id, user_id, execution_id, association_revision, connection_agent_id,
		 preparation, template, template_digest, registration_key, registration_key_hash, supply_attempt_id,
		 supply_state, registration_state, receipt, consumer_id, client_id, instance_id, configuration,
		 revoke_state, descriptor, descriptor_digest)
		values (${id}, ${agentId}, ${userId}, 'execution-a', 1, ${`connection-${agentId}`},
			${sql.json({})}, ${sql.json({})}, ${randomBytes(32).toString("hex")}, ${`mi-${randomBytes(16).toString("hex")}`},
			${randomBytes(32).toString("hex")}, ${`supply-${id}`}, 'confirmed', 'registered', ${sql.json({})},
			${`consumer-${id}`}, ${`client-${id}`}, ${`instance-${id}`}, ${sql.json({})}, 'not_required',
			${sql.json({})}, ${randomBytes(32).toString("hex")})`;
}

/** The Worker's DELETE with the original key settled as given. */
async function settleRevoke(id: string, outcome: "revoked" | "unknown") {
	await sql`update platform.connection_manual_installations set revoke_state=${outcome}
		where authorization_id=${id} and revoke_state='pending'`;
	await sql`update platform.connection_installation_commands set status=${outcome === "revoked" ? "completed" : "unknown"}
		where authorization_id=${id} and command='revoke' and status='pending'`;
}

beforeAll(async () => {
	database = await startPostgresTestDatabase("principal-pin-admin-http");
	await migratePlatformDatabase(database);
	sql = postgres(database.databaseUrl, { max: 2, onnotice: () => {} });
	await seedFoundation();
	rules = new PostgresConnectionPrincipalPinAdministrationV1({
		databaseUrl: database.databaseUrl,
		policy,
	});
});

beforeEach(async () => {
	account = admin;
	disabled = false;
	sessionLive = true;
	currentByUserId.mockReset().mockImplementation(async () => account);
	await sql`delete from platform.connection_principal_pin_receipts`;
	await sql`delete from platform.connection_principal_pins`;
	await sql`delete from platform.connection_manual_installations`;
	await sql`delete from platform.connection_installation_commands`;
	await sql`delete from platform.connection_installation_authorizations`;
	await sql`truncate platform.audit_events, platform.platform_user_disables cascade`;
	await seedPin("pin-alice", "alice", "principal-a");
	await seedPin("pin-bob", "bob", "principal-b");
	await seedInstallation("alice-on-a", "alice", "agent-a");
	await seedInstallation("alice-on-b", "alice", "agent-b");
	await seedInstallation("bob-on-a", "bob", "agent-a");
	const browser = createLdapBrowserAdapter({
		publicOrigin: origin,
		directory: {
			userIdForUid: async () => admin.userId,
			current: async () => account,
			currentByUserId,
		} as unknown as ReturnType<typeof createLdapIdentityDirectory>,
		sessions: {
			find: async () =>
				sessionLive
					? {
							uid: admin.uid,
							expiresAt: Number.MAX_SAFE_INTEGER,
							absoluteExpiresAt: Number.MAX_SAFE_INTEGER,
						}
					: null,
			create: async () => {},
			renew: async () => true,
			revoke: async () => {},
			revokeUid: async () => {},
		},
		isPlatformDisabled: async () => disabled,
		organizationIds: async () => [],
	});
	const unused = async (): Promise<never> => {
		throw new Error("Unrelated adapter called");
	};
	assemble = (manualInstallation) =>
		assemblePlatformApi({
			taskAdmissionPolicy: {
				maximumWaitingTasksPerAgent: 2,
				waitingTimeoutMs: 60_000,
			},
			databaseUrl: database.databaseUrl,
			identity: browser.identityAdapter,
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
			...(manualInstallation
				? {
						connectionInstallation: {
							publicOrigin: origin,
							manualInstallation,
						},
					}
				: {}),
		});
	assembly = assemble(policy);
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
});

afterEach(async () => {
	if (server)
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	await assembly?.close();
});

afterAll(async () => {
	await rules?.close();
	await sql?.end();
	await database?.stop();
});

const base = "/internal/platform/v1/connection-principal-pins";

function call(
	path: string,
	body?: unknown,
	headers: Record<string, string> = {},
) {
	return fetch(`${baseUrl}${base}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			Cookie: `__Host-platform-session=${"a".repeat(43)}`,
			Origin: origin,
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
			...headers,
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

function release(pinId: string, expectedRuleRevision: number, extra = {}) {
	return call(`/${pinId}/release`, {
		schemaVersion: 1,
		expectedRuleRevision,
		reference,
		...extra,
	});
}

function verification(
	pinId: string,
	expectedRuleRevision: number,
	result: "consistent" | "inconsistent",
) {
	return call(`/${pinId}/verification`, {
		schemaVersion: 1,
		expectedRuleRevision,
		reference,
		result,
	});
}

async function pins(userId: string) {
	const response = await call(`?userId=${userId}`);
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	return ((await response.json()) as { pins: Record<string, unknown>[] }).pins;
}

async function state() {
	return sql`select p.id, p.rule_revision::int, p.release_requested_at is not null as releasing,
			p.released_at is not null as released, p.verification_state,
			(select string_agg(m.authorization_id || ':' || m.revoke_state, ',' order by m.authorization_id)
				from platform.connection_manual_installations m where m.user_id=p.user_id) as installations,
			(select count(*)::int from platform.audit_events e where e.target_id=p.id) as audits
		from platform.connection_principal_pins p order by p.id`;
}

describe("exception pin operations entry (§13.5.1 items 4 and 6)", () => {
	it.each([
		["without an approved exception", undefined],
		[
			"with an exception bound to another system access",
			{
				...policy,
				dynamic: {
					...policy.dynamic,
					principalMapping: {
						...policy.dynamic.principalMapping,
						systemAccessFingerprint: "0".repeat(64),
					},
				},
			},
		],
	] as const)("is not assembled %s", async (_name, manualInstallation) => {
		const closed = assemble(manualInstallation);
		try {
			const app = createPlatformApp(closed.dependencies);
			const responses = [
				await app.fetch(
					new Request(`${origin}${base}?userId=alice`, {
						headers: {
							Cookie: `__Host-platform-session=${"a".repeat(43)}`,
						},
					}),
				),
				await app.fetch(
					new Request(`${origin}${base}/pin-alice/release`, {
						method: "POST",
						headers: {
							Cookie: `__Host-platform-session=${"a".repeat(43)}`,
							Origin: origin,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							schemaVersion: 1,
							expectedRuleRevision: 1,
							reference,
						}),
					}),
				),
			];
			expect(responses.map(({ status }) => status)).toEqual([404, 404]);
		} finally {
			await closed.close();
		}
		expect(currentByUserId).not.toHaveBeenCalled();
		expect((await state())[0]).toMatchObject({ releasing: false, audits: 0 });
	});

	it("records a verification and unpins only after every revoke of the user settles", async () => {
		expect(await pins("alice")).toEqual([
			{
				pinId: "pin-alice",
				userId: "alice",
				issuer: system.issuer,
				principalId: "principal-a",
				verificationState: "pending",
				verificationDeadline: expect.any(String),
				suspended: false,
				overdue: false,
				releasing: false,
				releaseReason: null,
				released: false,
				ruleRevision: 1,
			},
		]);
		const verified = await verification("pin-alice", 1, "consistent");
		expect(verified.status).toBe(200);
		expect(await verified.json()).toEqual({
			schemaVersion: 1,
			pinId: "pin-alice",
			ruleRevision: 2,
			closedInstallations: 0,
		});
		// The record against the rule revision it was read at writes nothing.
		expect((await release("pin-alice", 1)).status).toBe(409);
		const released = await release("pin-alice", 2);
		expect(released.status).toBe(200);
		expect(await released.json()).toEqual({
			schemaVersion: 1,
			pinId: "pin-alice",
			ruleRevision: 3,
			closedInstallations: 2,
		});
		expect((await release("pin-alice", 3)).status).toBe(409);
		// Both of alice's Agents close; bob's installation on the same Agent does not.
		expect(await state()).toEqual([
			{
				id: "pin-alice",
				rule_revision: 3,
				releasing: true,
				released: false,
				verification_state: "verified",
				installations: "alice-on-a:pending,alice-on-b:pending",
				audits: 2,
			},
			{
				id: "pin-bob",
				rule_revision: 1,
				releasing: false,
				released: false,
				verification_state: "pending",
				installations: "bob-on-a:not_required",
				audits: 0,
			},
		]);
		// An unknown revoke keeps the pin; only its original key exists.
		await settleRevoke("alice-on-a", "revoked");
		await settleRevoke("alice-on-b", "unknown");
		await rules.sweep();
		expect((await pins("alice"))[0]).toMatchObject({
			releasing: true,
			released: false,
		});
		expect(
			await sql`select authorization_id, idempotency_key, status from platform.connection_installation_commands
				where command='revoke' order by authorization_id`,
		).toEqual([
			{
				authorization_id: "alice-on-a",
				idempotency_key: "manual-revoke:alice-on-a",
				status: "completed",
			},
			{
				authorization_id: "alice-on-b",
				idempotency_key: "manual-revoke:alice-on-b",
				status: "unknown",
			},
		]);
		// Verified with the original key: the release completes in the next sweep.
		await sql`update platform.connection_manual_installations set revoke_state='revoked' where authorization_id='alice-on-b'`;
		await rules.sweep();
		expect((await pins("alice"))[0]).toMatchObject({ released: true });
		expect((await release("pin-alice", 3)).status).toBe(404);
		const audits =
			await sql`select action, actor_type, actor_id, request_id, details->>'reference' as reference
				from platform.audit_events where target_id='pin-alice' order by occurred_at, action`;
		expect(audits.map(({ request_id: _id, ...row }) => row)).toEqual([
			{
				action: "connection.principal_pin.verified",
				actor_type: "user",
				actor_id: admin.userId,
				reference,
			},
			{
				action: "connection.principal_pin.release_requested",
				actor_type: "user",
				actor_id: admin.userId,
				reference,
			},
			{
				action: "connection.principal_pin.released",
				actor_type: "system",
				actor_id: "platform-worker",
				reference: null,
			},
		]);
		expect((await pins("bob"))[0]).toMatchObject({
			ruleRevision: 1,
			releasing: false,
		});
	});

	it("closes the user's installations and unpins after an inconsistent record", async () => {
		const response = await verification("pin-alice", 1, "inconsistent");
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ruleRevision: 2,
			closedInstallations: 2,
		});
		expect((await verification("pin-alice", 2, "consistent")).status).toBe(409);
		expect((await pins("alice"))[0]).toMatchObject({
			verificationState: "mismatch",
			releasing: true,
			releaseReason: "mismatch",
		});
		await settleRevoke("alice-on-a", "revoked");
		await settleRevoke("alice-on-b", "revoked");
		await rules.sweep();
		expect((await pins("alice"))[0]).toMatchObject({ released: true });
		expect((await pins("bob"))[0]).toMatchObject({ ruleRevision: 1 });
	});

	it("answers an unknown or released pin as unavailable", async () => {
		expect((await release("pin-missing", 1)).status).toBe(404);
		expect((await verification("pin-missing", 1, "consistent")).status).toBe(
			404,
		);
		expect(await pins("carol")).toEqual([]);
	});

	it.each([
		["a non-administrator", 403],
		["a Platform-disabled administrator", 401],
		["an expired or revoked session", 401],
		["an administrator removed from the directory", 401],
		["a directory failure", 503],
		["a directory identity mismatch", 503],
	] as const)(
		"fails closed for %s before reading any pin",
		async (mode, status) => {
			if (mode === "a non-administrator")
				account = { ...admin, roles: ["employee"] };
			if (mode === "a Platform-disabled administrator") disabled = true;
			if (mode === "an expired or revoked session") sessionLive = false;
			if (mode === "an administrator removed from the directory")
				currentByUserId.mockResolvedValue(null);
			if (mode === "a directory failure")
				currentByUserId.mockRejectedValue(
					new Error("private directory sentinel"),
				);
			if (mode === "a directory identity mismatch")
				currentByUserId.mockResolvedValue({ ...admin, userId: "other" });
			const before = await state();
			// Existing and missing pins and users answer alike.
			for (const response of [
				await call("?userId=alice"),
				await call("?userId=carol"),
				await release("pin-alice", 1),
				await release("pin-missing", 1),
				await verification("pin-alice", 1, "consistent"),
			]) {
				expect(response.status).toBe(status);
				const text = await response.text();
				expect(text).not.toContain("private directory sentinel");
				expect(text).not.toContain("principal-a");
			}
			expect(await state()).toEqual(before);
		},
	);

	it.each([
		"administratorId",
		"actor",
		"userId",
		"roles",
		"isSystemAdmin",
		"agentId",
	])("rejects a forged %s request field", async (field) => {
		const before = await state();
		expect((await release("pin-alice", 1, { [field]: "forged" })).status).toBe(
			400,
		);
		expect(await state()).toEqual(before);
	});

	it("takes no identity from request headers", async () => {
		account = { ...admin, roles: ["employee"] };
		const before = await state();
		const response = await call(
			"/pin-alice/release",
			{ schemaVersion: 1, expectedRuleRevision: 1, reference },
			{
				"X-User-Id": admin.userId,
				"X-Platform-Roles": "system_admin",
				"X-Forwarded-User": admin.uid,
			},
		);
		expect(response.status).toBe(403);
		expect(await state()).toEqual(before);
	});

	it("accepts only the browser session, never a bearer credential", async () => {
		const before = await state();
		const response = await call(
			"/pin-alice/release",
			{ schemaVersion: 1, expectedRuleRevision: 1, reference },
			{ Authorization: "Bearer forged" },
		);
		expect(response.status).toBe(401);
		expect(await state()).toEqual(before);
	});

	it.each(["role", "uid", "revision", "disabled"] as const)(
		"rolls back when the administrator's %s changes before the record commits",
		async (change) => {
			// The entry check and the Core pre-check see the administrator; the change
			// lands at the recheck inside the record's transaction.
			currentByUserId
				.mockResolvedValueOnce(admin)
				.mockResolvedValueOnce(admin)
				.mockResolvedValue({
					...admin,
					...(change === "role"
						? { roles: ["employee"] as const }
						: change === "uid"
							? { uid: "another-uid" }
							: change === "revision"
								? { authorizationRevision: "changed" }
								: { accountStatus: "disabled" as const }),
				});
			const before = await state();
			expect((await release("pin-alice", 1)).status).toBe(401);
			expect(currentByUserId).toHaveBeenCalledTimes(3);
			expect(await state()).toEqual(before);
			expect(
				await sql`select count(*)::int as n from platform.connection_installation_commands`,
			).toEqual([{ n: 0 }]);
		},
	);
});
