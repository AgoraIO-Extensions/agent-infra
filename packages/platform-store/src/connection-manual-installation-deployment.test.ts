import { randomBytes } from "node:crypto";
import { connectionSystemAccessFingerprintV1 } from "@agent-infra/contracts/connection-consumer-profile";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	connectionManualPublicationContractV1,
	connectionManualReadbackContractV1,
	decideConnectionManualInstallationDeploymentV1,
	readConnectionConfirmedPrincipalsV1,
	readConnectionManualInstallationEnvironmentV1,
	resolveConnectionManualInstallationDeploymentV1,
} from "./connection-manual-installation-deployment.js";
import { captureConnectionManualInstallationPolicyV1 } from "./connection-manual-installations.js";
import { migratePlatformDatabase } from "./migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";

const system = {
	schemaVersion: 1 as const,
	publicOrigin: "https://connection.test",
	mcpPath: "/mcp",
	audience: "mcp",
	egressProfile: { ref: "egress", revision: "r1" },
	issuer: "https://connection.test/",
	oauthCallbackUrl: "https://platform.test/connection/callback",
};
const approval = {
	schemaVersion: 1 as const,
	configFingerprint: connectionSystemAccessFingerprintV1(system),
	egressEnforced: true as const,
	source: { ref: "user-authorized-2026-11-18T08:37Z", revision: "1" },
};
/** The shape of the U2 approval record, bound to this fixture's system access. */
const exceptionApproval = {
	schemaVersion: 1,
	kind: "consistency-exception-v1",
	policy: { ref: "consistency-exception-v1", revision: "1" },
	notAfter: "2099-01-01T00:00:00Z",
	maximumPinnedPrincipals: 2,
	verificationWindowHours: 24,
	connectionRelease: "agora-connector-734dafc9",
	systemAccessFingerprint: connectionSystemAccessFingerprintV1(system),
	approvalSource: approval.source,
};
const complete = { status: "complete", principals: [] } as const;

function resolve(overrides: Record<string, unknown> = {}) {
	return resolveConnectionManualInstallationDeploymentV1({
		systemAccess: system,
		approval,
		exceptionApproval,
		confirmedPrincipals: complete,
		callbackDelivery: "ready",
		...overrides,
	} as Parameters<typeof resolveConnectionManualInstallationDeploymentV1>[0]);
}

describe("#4199 C2 exception route deployment gate (§13.5.1)", () => {
	it("enables only an approved, bound, live exception with a complete Principal set", () => {
		const result = resolve();
		if (result.status !== "enabled") throw new Error(result.reason);
		expect(result.policy).toEqual({
			systemAccess: system,
			approval,
			clientName: "Agent Infra",
			dynamic: {
				schemaVersion: 1,
				principalMapping: exceptionApproval,
				readbackContract: connectionManualReadbackContractV1,
				publicationContract: connectionManualPublicationContractV1,
			},
			confirmedPrincipals: [],
		});
		expect(() =>
			captureConnectionManualInstallationPolicyV1(result.policy),
		).not.toThrow();
		expect(result.receipt).toEqual({
			principalMapping: "consistency-exception-v1",
			policy: exceptionApproval.policy,
			notAfter: exceptionApproval.notAfter,
			maximumPinnedPrincipals: 2,
			verificationWindowHours: 24,
			connectionRelease: "agora-connector-734dafc9",
			systemAccessFingerprint: approval.configFingerprint,
			approvalSource: approval.source,
			readbackContract: { ref: "connection-ep-1060-read", revision: "1" },
			publicationContract: {
				ref: "connection-mcp-publication",
				revision: "1",
			},
			clientName: "Agent Infra",
		});
		expect(resolve({ clientName: "Agent Infra Pilot" })).toMatchObject({
			status: "enabled",
			policy: { clientName: "Agent Infra Pilot" },
		});
	});

	const otherSystem = { ...system, audience: "other" };
	it.each([
		[
			"no approval record",
			{ exceptionApproval: undefined },
			"exception_approval_missing",
		],
		[
			"an unreadable record",
			{ exceptionApproval: "unparsable" },
			"exception_approval_invalid",
		],
		[
			"an unknown field",
			{ exceptionApproval: { ...exceptionApproval, extra: true } },
			"exception_approval_invalid",
		],
		[
			"a window above 24 hours",
			{
				exceptionApproval: {
					...exceptionApproval,
					verificationWindowHours: 25,
				},
			},
			"exception_approval_invalid",
		],
		[
			"another exception kind",
			{
				exceptionApproval: { ...exceptionApproval, kind: "principal_mapping" },
			},
			"exception_approval_invalid",
		],
		[
			"no Connection release",
			{
				exceptionApproval: Object.fromEntries(
					Object.entries(exceptionApproval).filter(
						([key]) => key !== "connectionRelease",
					),
				),
			},
			"connection_release_missing",
		],
		[
			"an empty Connection release",
			{ exceptionApproval: { ...exceptionApproval, connectionRelease: " " } },
			"connection_release_missing",
		],
		[
			"a passed notAfter",
			{
				exceptionApproval: {
					...exceptionApproval,
					notAfter: "2026-01-01T00:00:00Z",
				},
			},
			"exception_expired",
		],
		[
			"no system access",
			{ systemAccess: undefined },
			"system_access_unavailable",
		],
		[
			"an unapproved system access",
			{ systemAccess: otherSystem },
			"system_access_unavailable",
		],
		[
			"an approval bound to another system access",
			{
				exceptionApproval: {
					...exceptionApproval,
					systemAccessFingerprint:
						connectionSystemAccessFingerprintV1(otherSystem),
				},
			},
			"system_access_fingerprint_mismatch",
		],
		[
			"an approval from another approval source",
			{
				exceptionApproval: {
					...exceptionApproval,
					approvalSource: {
						ref: "user-authorized-2026-11-18T08:37Z",
						revision: "2",
					},
				},
			},
			"approval_source_mismatch",
		],
		[
			"a non-ASCII client name",
			{ clientName: "Agent 平台" },
			"client_name_invalid",
		],
		[
			"a padded client name",
			{ clientName: " Agent Infra" },
			"client_name_invalid",
		],
		[
			"a client name above 100",
			{ clientName: "a".repeat(101) },
			"client_name_invalid",
		],
		[
			"an unresolvable Principal set",
			{ confirmedPrincipals: { status: "unresolvable" } },
			"confirmed_principals_unresolvable",
		],
		// #4327 MUST 1 (§13.5.6): no protected callback delivery to the Host.
		[
			"an unavailable callback delivery",
			{ callbackDelivery: "unavailable" },
			"callback_delivery_unavailable",
		],
		[
			"an unstated callback delivery",
			{ callbackDelivery: undefined },
			"callback_delivery_unavailable",
		],
	] as const)("stays dormant for %s", (_name, overrides, reason) => {
		expect(resolve(overrides)).toEqual({ status: "dormant", reason });
	});

	it("reads the projected record and client name, never treating an unreadable one as absent", () => {
		expect(readConnectionManualInstallationEnvironmentV1({})).toEqual({
			exceptionApproval: undefined,
		});
		expect(
			readConnectionManualInstallationEnvironmentV1({
				AGENT_INFRA_CONNECTION_EXCEPTION_APPROVAL:
					JSON.stringify(exceptionApproval),
				AGENT_INFRA_CONNECTION_MANUAL_CLIENT_NAME: "Agent Infra Pilot",
			}),
		).toEqual({ exceptionApproval, clientName: "Agent Infra Pilot" });
		const unreadable = readConnectionManualInstallationEnvironmentV1({
			AGENT_INFRA_CONNECTION_EXCEPTION_APPROVAL: "{",
		});
		expect(resolve(unreadable)).toEqual({
			status: "dormant",
			reason: "exception_approval_invalid",
		});
	});
});

describe("one gate decision for the API and the Worker (#4199 C2)", () => {
	// The DB is never read before these: an unreachable URL proves it.
	const databaseUrl = "postgres://user:never@127.0.0.1:1/platform";
	it.each([
		[
			"no approval record",
			{ exceptionApproval: undefined },
			"exception_approval_missing",
		],
		[
			"a static or standard installation input",
			{ standardInstallationConfigured: true },
			"standard_installation_configured",
		],
		[
			"no projected system access",
			{ systemAccess: undefined },
			"system_access_unavailable",
		],
		["an unreadable Platform DB", {}, "confirmed_principals_unresolvable"],
	] as const)("stays dormant for %s", async (_name, overrides, reason) => {
		expect(
			await decideConnectionManualInstallationDeploymentV1({
				exceptionApproval,
				standardInstallationConfigured: false,
				systemAccess: { system, approval },
				callbackDelivery: "ready",
				databaseUrl,
				...overrides,
			}),
		).toEqual({ status: "dormant", reason });
	});
});

describe("Principals confirmed outside the exception, from the Platform DB (§13.5.1 item 3)", () => {
	let database: PostgresTestDatabase;
	let client: ReturnType<typeof postgres>;

	beforeAll(async () => {
		database = await startPostgresTestDatabase("manual-deployment-principals");
		client = postgres(database.databaseUrl, { onnotice: () => {} });
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		for (const agentId of ["agent-a", "agent-b"])
			await client`insert into platform.agents(id,authorization_revision) values (${agentId},'agent-r1')`;
		await client`insert into platform.relay_key_subjects(purpose,subject_id,last_version,current_version) values ('personal','alice',1,1)`;
		await client`insert into platform.relay_key_versions(purpose,subject_id,key_version,key_id,ciphertext) values ('personal','alice',1,'fixture-key-alice',${client.json({ purpose: "personal", subjectId: "alice", keyId: "fixture-key-alice", keyVersion: 1 })})`;
		await client`insert into platform.conversations(id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision,host_session_ref) values ('conversation-a','agent-a','alice','web','active',1,'agent-r1','host-a')`;
		await client`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,authorization_revision,created_at,runtime_submit_protocol,original_operation_digest,original_submit_host_session_ref,execution_source,relay_key_purpose,relay_key_subject_id,relay_key_id,relay_key_version,delivery_fence) values ('execution-a','conversation-a','agent-a','alice','web','turn-a','processing',1,'agent-r1',now(),'v4',${"a".repeat(43)},'host-a','web','personal','alice','fixture-key-alice',1,3)`;
	}, 180_000);

	afterAll(async () => {
		await client?.end();
		await database?.stop();
	});

	beforeEach(async () => {
		await client`delete from platform.connection_manual_installations`;
		await client`delete from platform.connection_installation_commands`;
		await client`delete from platform.connection_installation_authorizations`;
	});

	async function authorization(id: string, userId: string, status: string) {
		await client`insert into platform.connection_installation_authorizations
			(id, execution_id, user_id, confirmation_revision, binding, identity_revision,
			 agent_authorization_revision, status, expires_at)
			values (${id}, 'execution-a', ${userId}, 'confirmation-r1',
				${client.json({ principal: { kind: "user", id: userId }, reference: { executionId: "execution-a" } })},
				'identity-r1', 'agent-r1', ${status}, clock_timestamp() + interval '1 hour')`;
	}

	async function manual(id: string, userId: string, agentId: string) {
		await authorization(id, userId, "confirmed");
		await client`insert into platform.connection_manual_installations
			(authorization_id, agent_id, user_id, execution_id, association_revision, connection_agent_id, preparation)
			values (${id}, ${agentId}, ${userId}, 'execution-a', 1, ${`connection-${agentId}`}, ${client.json({})})`;
	}

	it("is the complete empty set with no standard installation, whatever the exception holds", async () => {
		expect(
			await readConnectionConfirmedPrincipalsV1(database.databaseUrl),
		).toEqual({
			status: "complete",
			principals: [],
		});
		// Exception installations of other users and Agents are the store's own check.
		await manual("manual-alice-a", "alice", "agent-a");
		await manual("manual-bob-b", "bob", "agent-b");
		await authorization("standard-closed", "carol", "revoked");
		await authorization("standard-waiting", "carol", "awaiting_confirmation");
		expect(
			await readConnectionConfirmedPrincipalsV1(database.databaseUrl),
		).toEqual({
			status: "complete",
			principals: [],
		});
	});

	it.each(["confirmed", "unknown"])(
		"is unresolvable once any user's standard installation is %s",
		async (status) => {
			await manual("manual-alice-a", "alice", "agent-a");
			await authorization(`standard-bob-${status}`, "bob", status);
			expect(
				await readConnectionConfirmedPrincipalsV1(database.databaseUrl),
			).toEqual({ status: "unresolvable" });
		},
	);

	it("is unresolvable when the Platform DB cannot be read, without echoing the URL", async () => {
		const secret = randomBytes(8).toString("hex");
		const result = await readConnectionConfirmedPrincipalsV1(
			`postgres://user:${secret}@127.0.0.1:1/platform`,
		);
		expect(result).toEqual({ status: "unresolvable" });
		expect(JSON.stringify(result)).not.toContain(secret);
	});
});
