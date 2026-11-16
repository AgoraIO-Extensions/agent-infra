import {
	createAgentConnectionAssociationUseCaseV1,
	createAgentManagementV1,
	createApplicationFoundationUseCaseV1,
	planConnectionConsumerDisableV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import {
	applicationFoundationActorContextV1,
	applicationFoundationAdmissionDependenciesV1,
	applicationFoundationCommandV1,
} from "../../platform-core/src/application-foundation.conformance.js";
import { PostgresAgentConfigurationQueryV1 } from "./agent-configuration.query.js";
import { PostgresAgentConnectionAssociationStoreV1 } from "./agent-connection-association.js";
import { PostgresAgentManagementTransactionV1 } from "./agent-management.js";
import { PostgresApplicationFoundationTransactionV1 } from "./application-foundation.js";
import { PostgresConnectionConsumerDisableStoreV1 } from "./connection-consumer-disable.js";
import { PostgresConnectionConsumerRegistrationStoreV1 } from "./connection-consumer-registration.js";
import { migratePlatformDatabase } from "./migrate.js";
import { createPostgresOutboxStore } from "./outbox.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.js";
import { createSecretRecordFixtureResolver } from "./secret-record-fixture.js";

const policy = {
	schemaVersion: 1 as const,
	sourceNamespace: "platform-disable-test",
	revision: "policy-1",
	callbackUrl: "https://platform.example.test/connection/callback",
	resource: "https://connection.example.test/mcp",
	scope: "mcp:tools",
};
const registerOperation = "agent.connection.consumer.register.v1";
const disableOperation = "agent.connection.consumer.disable.v1";
const administrator = {
	schemaVersion: 1 as const,
	userId: "administrator",
	accountStatus: "active" as const,
	isAdministrator: true,
	organizationIds: [],
};
const owner = {
	...administrator,
	userId: applicationFoundationActorContextV1.userId,
	isAdministrator: false,
};
let database: PostgresTestDatabase;
let sql: ReturnType<typeof postgres>;
let foundation: PostgresApplicationFoundationTransactionV1;
let management: PostgresAgentManagementTransactionV1;
let unconfiguredManagement: PostgresAgentManagementTransactionV1;
let registrations: PostgresConnectionConsumerRegistrationStoreV1;
let disables: PostgresConnectionConsumerDisableStoreV1;
let outbox: ReturnType<typeof createPostgresOutboxStore>;
beforeAll(async () => {
	database = await startPostgresTestDatabase("connection-consumer-disable");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	sql = postgres(database.databaseUrl, { max: 3, onnotice: () => {} });
	foundation = new PostgresApplicationFoundationTransactionV1({
		databaseUrl: database.databaseUrl,
		connectionConsumerRegistration: policy,
	});
	management = new PostgresAgentManagementTransactionV1({
		databaseUrl: database.databaseUrl,
		connectionConsumerRegistration: policy,
	});
	// The disable selection is durable: it does not depend on the API still holding the policy.
	unconfiguredManagement = new PostgresAgentManagementTransactionV1({
		databaseUrl: database.databaseUrl,
	});
	registrations = new PostgresConnectionConsumerRegistrationStoreV1({
		databaseUrl: database.databaseUrl,
		policy,
	});
	disables = new PostgresConnectionConsumerDisableStoreV1({
		databaseUrl: database.databaseUrl,
		policy,
	});
	outbox = createPostgresOutboxStore({ databaseUrl: database.databaseUrl });
}, 120_000);
beforeEach(async () => {
	await sql`truncate platform.agents, platform.outbox_items, platform.persisted_events, platform.audit_events, platform.idempotency_records cascade`;
	await sql`truncate platform.platform_user_disables`;
});
afterAll(async () => {
	await Promise.all([
		foundation?.close(),
		management?.close(),
		unconfiguredManagement?.close(),
		registrations?.close(),
		disables?.close(),
		outbox?.close(),
		sql?.end(),
	]);
	await database?.stop();
});

async function submit(id: string) {
	await createApplicationFoundationUseCaseV1({
		transaction: foundation,
		...applicationFoundationAdmissionDependenciesV1(),
	}).submit(
		{
			...applicationFoundationCommandV1,
			agentId: id,
			applicationId: `application-${id}`,
			idempotencyKey: `submit-${id}`,
		},
		applicationFoundationActorContextV1,
		createSecretRecordFixtureResolver(),
	);
}
async function revision(id: string) {
	const [row] =
		await sql`select management_revision from platform.agent_applications where agent_id=${id}`;
	return Number(row?.management_revision);
}
async function command(
	id: string,
	name:
		| "approve_application"
		| "disable_agent"
		| "stop_agent"
		| "restart_agent",
	transaction = management,
) {
	const actor = name === "approve_application" || name === "disable_agent";
	const result = await createAgentManagementV1(
		transaction,
	).executeManagementCommand(
		{
			schemaVersion: 1,
			command: name,
			...(name === "approve_application"
				? { applicationId: `application-${id}` }
				: { agentId: id }),
			expectedRevision: await revision(id),
			idempotencyKey: `${name}-${id}`,
			traceId: `trace-${id}`,
			requestId: `request-${id}`,
		} as Parameters<
			ReturnType<typeof createAgentManagementV1>["executeManagementCommand"]
		>[0],
		actor ? administrator : owner,
	);
	// Connection is on demand (PRD §9.1): the Owner enables it after approval.
	if (name === "approve_application" && result.outcome === "accepted") {
		const store = new PostgresAgentConnectionAssociationStoreV1({
			databaseUrl: database.databaseUrl,
		});
		try {
			await createAgentConnectionAssociationUseCaseV1({
				transaction: store,
				registrationPolicy: policy,
			}).associate(
				{
					entry: { kind: "browser", userId: owner.userId },
					agentId: id,
					traceId: `trace-enable-${id}`,
					requestId: `request-enable-${id}`,
				},
				{ schemaVersion: 1, mode: "automatic" },
			);
		} finally {
			await store.close();
		}
	}
	return result;
}
async function available(id: string) {
	await sql`update platform.agent_applications set status='available', service_availability='ready', desired_state='running' where agent_id=${id}`;
}
async function lease(operation: string, itemId?: string) {
	await sql`update platform.outbox_items set available_at=clock_timestamp()
		where operation=${operation} and status in ('pending','retry_scheduled')`;
	const ids =
		operation === disableOperation
			? await disables.pending()
			: await registrations.pending();
	const id = itemId ?? ids[0];
	expect(id).toBeTruthy();
	const claim = await outbox.claim({
		itemId: String(id),
		leaseOwner: "test-worker",
		leaseDurationMs: 30_000,
	});
	if (!claim) throw new Error("Expected owned lease");
	return claim;
}
async function retry(claim: Awaited<ReturnType<typeof lease>>) {
	await outbox.scheduleRetry({
		itemId: claim.itemId,
		leaseOwner: claim.leaseOwner,
		deliveryFence: claim.deliveryFence,
		retryDelayMs: 0,
		errorCode: "TEST_RETRY",
	});
}
async function registered(id: string) {
	await submit(id);
	expect((await command(id, "approve_application")).outcome).toBe("accepted");
	const claim = await lease(registerOperation);
	const attempt = await registrations.beginAttempt(claim, true);
	if (attempt?.outcome !== "deliver") throw new Error("Missing registration");
	const { intent } = attempt;
	const receipt = {
		schemaVersion: 1 as const,
		operationId: intent.operationId,
		sourceNamespace: intent.sourceNamespace,
		sourceKey: intent.sourceKey,
		requestDigest: intent.requestDigest,
		consumerId: `consumer-${id}`,
		consumerRevision: "7",
		registrationId: `registration-${id}`,
	};
	expect(
		await registrations.complete(claim, { outcome: "registered", receipt }),
	).toBe(true);
	await outbox.markSucceeded({
		itemId: claim.itemId,
		leaseOwner: claim.leaseOwner,
		deliveryFence: claim.deliveryFence,
	});
	return { intent, receipt };
}
const disableRows = () =>
	sql`select agent_id, status, request is null as unsent from platform.connection_consumer_disables order by agent_id`;

it("only an accepted administrator disable writes the Agent's own waiting intent and outbox", async () => {
	await registered("agent-a");
	await registered("agent-b");
	await available("agent-a");
	expect((await command("agent-a", "stop_agent")).outcome).toBe("accepted");
	expect((await command("agent-a", "restart_agent")).outcome).toBe("accepted");
	expect(await disableRows()).toEqual([]);
	expect(
		(await command("agent-a", "disable_agent", unconfiguredManagement)).outcome,
	).toBe("accepted");
	expect(
		(await command("agent-a", "disable_agent", unconfiguredManagement)).outcome,
	).toBe("replayed");
	expect(await disableRows()).toEqual([
		{ agent_id: "agent-a", status: "waiting", unsent: true },
	]);
	expect(
		await sql`select scope_id, payload->>'registrationOperationId' as registration from platform.outbox_items where operation=${disableOperation}`,
	).toEqual([
		{
			scope_id: "agent-a",
			registration: (
				await sql`select operation_id from platform.connection_consumer_registrations where agent_id='agent-a'`
			)[0]?.operation_id,
		},
	]);
});

it("Agents without a registration row, or with a confirmed failed one, write nothing", async () => {
	await submit("legacy");
	expect((await command("legacy", "approve_application")).outcome).toBe(
		"accepted",
	);
	await sql`delete from platform.outbox_items where operation=${registerOperation}`;
	await sql`delete from platform.connection_consumer_registrations`;
	expect((await command("legacy", "disable_agent")).outcome).toBe("accepted");
	await submit("rejected");
	expect((await command("rejected", "approve_application")).outcome).toBe(
		"accepted",
	);
	await sql`update platform.connection_consumer_registrations set status='failed', failure_code='CONTROLLED' where agent_id='rejected'`;
	expect((await command("rejected", "disable_agent")).outcome).toBe("accepted");
	expect(await disableRows()).toEqual([]);
	expect(
		await sql`select status from platform.agent_applications order by agent_id`,
	).toEqual([{ status: "disabled" }, { status: "disabled" }]);
});

it("captures only the same Agent's verified receipt and confirms only the exact disable receipt", async () => {
	const a = await registered("agent-a");
	await registered("agent-b");
	expect((await command("agent-a", "disable_agent")).outcome).toBe("accepted");
	const claim = await lease(disableOperation);
	expect(claim.scopeId).toBe("agent-a");
	const attempt = await disables.beginAttempt(claim, true);
	if (attempt?.outcome !== "deliver") throw new Error("Expected disable");
	expect(attempt.mode).toBe("disable");
	expect(attempt.intent).toEqual(
		planConnectionConsumerDisableV1({ policy, registration: a }),
	);
	expect(attempt.intent).toMatchObject({
		platformAgentId: "agent-a",
		consumerId: "consumer-agent-a",
		registrationId: "registration-agent-a",
		expectedRevision: "7",
		policyRevision: "policy-1",
	});
	expect(await disables.current(claim, "disable")).toBe(true);
	const receipt = {
		schemaVersion: 1 as const,
		operationId: attempt.intent.operationId,
		consumerId: attempt.intent.consumerId,
		registrationId: attempt.intent.registrationId,
		resultRevision: "8",
		requestDigest: attempt.intent.requestDigest,
	};
	await expect(
		disables.complete(claim, {
			outcome: "disabled",
			receipt: { ...receipt, consumerId: "consumer-agent-b" },
		}),
	).rejects.toThrow();
	expect(
		await disables.complete(
			{ ...claim, deliveryFence: claim.deliveryFence + 1n },
			{ outcome: "disabled", receipt },
		),
	).toBe(false);
	expect(await disables.complete(claim, { outcome: "disabled", receipt })).toBe(
		true,
	);
	expect(
		await sql`select agent_id, status, result_revision, request->>'consumerId' as consumer from platform.connection_consumer_disables`,
	).toEqual([
		{
			agent_id: "agent-a",
			status: "disabled",
			result_revision: "8",
			consumer: "consumer-agent-a",
		},
	]);
	expect(
		await sql`select agent_id, status from platform.agent_applications order by agent_id`,
	).toEqual([
		{ agent_id: "agent-a", status: "disabled" },
		{ agent_id: "agent-b", status: "creating" },
	]);
});

it("unknown results only reconcile the original command; a never-started send stays unsent", async () => {
	await registered("agent-a");
	expect((await command("agent-a", "disable_agent")).outcome).toBe("accepted");
	let claim = await lease(disableOperation);
	let attempt = await disables.beginAttempt(claim, true);
	expect(attempt).toMatchObject({ outcome: "deliver", mode: "disable" });
	expect(await disables.deferBeforeSend(claim, "disable")).toBe(true);
	expect(await disableRows()).toEqual([
		{ agent_id: "agent-a", status: "pending", unsent: true },
	]);
	await retry(claim);
	claim = await lease(disableOperation);
	attempt = await disables.beginAttempt(claim, true);
	if (attempt?.outcome !== "deliver") throw new Error("Expected disable");
	const original = attempt.intent;
	expect(
		await disables.complete(claim, {
			outcome: "unknown",
			failureCode: "CONNECTION_DISABLE_UNCONFIRMED",
		}),
	).toBe(true);
	await retry(claim);
	claim = await lease(disableOperation);
	// Even an unavailable adapter never turns an uncertain send back into a new POST.
	expect(await disables.beginAttempt(claim, false)).toEqual({
		outcome: "unknown",
	});
	await retry(claim);
	claim = await lease(disableOperation);
	expect(await disables.beginAttempt(claim, true)).toEqual({
		outcome: "deliver",
		mode: "reconcile",
		intent: original,
	});
	expect(await disables.current(claim, "disable")).toBe(false);
	expect(await disables.current(claim, "reconcile")).toBe(true);
	expect(
		await disables.complete(claim, {
			outcome: "failed",
			failureCode: "CONNECTION_DISABLE_REJECTED",
		}),
	).toBe(true);
	expect(await disableRows()).toEqual([
		{ agent_id: "agent-a", status: "failed", unsent: false },
	]);
});

it("waits for the association, then follows the registration's definitive outcome", async () => {
	await submit("agent-a");
	expect((await command("agent-a", "approve_application")).outcome).toBe(
		"accepted",
	);
	expect((await command("agent-a", "disable_agent")).outcome).toBe("accepted");
	const claim = await lease(disableOperation);
	expect(await disables.beginAttempt(claim, true)).toEqual({
		outcome: "waiting",
	});
	await retry(claim);
	// The registration worker never sends for a disabled Agent; never-sent pending is definitive.
	const registration = await lease(registerOperation);
	expect(await registrations.beginAttempt(registration, true)).toEqual({
		outcome: "failed",
	});
	expect(
		await sql`select status, failure_code from platform.connection_consumer_registrations`,
	).toEqual([
		{
			status: "failed",
			failure_code: "CONNECTION_REGISTRATION_AGENT_DISABLED",
		},
	]);
	const next = await lease(disableOperation);
	expect(await disables.beginAttempt(next, true)).toEqual({
		outcome: "not_required",
	});
	expect(await disableRows()).toEqual([
		{ agent_id: "agent-a", status: "not_required", unsent: true },
	]);
});

it("an already-sent registration is still reconciled read-only after Agent disable", async () => {
	await submit("agent-a");
	expect((await command("agent-a", "approve_application")).outcome).toBe(
		"accepted",
	);
	let registration = await lease(registerOperation);
	const sent = await registrations.beginAttempt(registration, true);
	if (sent?.outcome !== "deliver") throw new Error("Expected registration");
	expect((await command("agent-a", "disable_agent")).outcome).toBe("accepted");
	// The in-flight register result lost eligibility; it stays unknown rather than registered.
	const receipt = {
		schemaVersion: 1 as const,
		operationId: sent.intent.operationId,
		sourceNamespace: sent.intent.sourceNamespace,
		sourceKey: sent.intent.sourceKey,
		requestDigest: sent.intent.requestDigest,
		consumerId: "consumer-agent-a",
		consumerRevision: "3",
		registrationId: "registration-agent-a",
	};
	expect(
		await registrations.complete(registration, {
			outcome: "registered",
			receipt,
		}),
	).toBe(false);
	await retry(registration);
	registration = await lease(registerOperation);
	expect(await registrations.beginAttempt(registration, true)).toMatchObject({
		outcome: "deliver",
		mode: "reconcile",
	});
	expect(await registrations.current(registration)).toBe(true);
	expect(
		await registrations.complete(registration, {
			outcome: "registered",
			receipt,
		}),
	).toBe(true);
	// A registered row of a disabled Agent never becomes an installation binding.
	expect(await registrations.registered()).toEqual({});
	const claim = await lease(disableOperation);
	expect(await disables.beginAttempt(claim, true)).toMatchObject({
		outcome: "deliver",
		mode: "disable",
		intent: { consumerId: "consumer-agent-a", expectedRevision: "3" },
	});
});

it("never sends without the adapter or under another policy source", async () => {
	await registered("agent-a");
	expect((await command("agent-a", "disable_agent")).outcome).toBe("accepted");
	let claim = await lease(disableOperation);
	expect(await disables.beginAttempt(claim, false)).toEqual({
		outcome: "pending",
	});
	await retry(claim);
	const foreign = new PostgresConnectionConsumerDisableStoreV1({
		databaseUrl: database.databaseUrl,
		policy: { ...policy, sourceNamespace: "another-source" },
	});
	try {
		expect(await foreign.pending()).toEqual([]);
		claim = await lease(disableOperation);
		expect(await foreign.beginAttempt(claim, true)).toEqual({
			outcome: "pending",
		});
	} finally {
		await foreign.close();
	}
	expect(await disableRows()).toEqual([
		{ agent_id: "agent-a", status: "pending", unsent: true },
	]);
	await retry(claim);
	// A rotated approved revision regenerates the never-sent request.
	const rotated = new PostgresConnectionConsumerDisableStoreV1({
		databaseUrl: database.databaseUrl,
		policy: { ...policy, revision: "policy-2" },
	});
	try {
		claim = await lease(disableOperation);
		expect(await rotated.beginAttempt(claim, true)).toMatchObject({
			outcome: "deliver",
			intent: { policyRevision: "policy-2" },
		});
	} finally {
		await rotated.close();
	}
});

it("the disable transaction never waits on a registration row held by the registration worker", async () => {
	await registered("agent-a");
	// The registration worker locks the registration row before the Agent row (`for update of r, a`).
	const worker = await sql.reserve();
	try {
		await worker`begin`;
		await worker`select 1 from platform.connection_consumer_registrations where agent_id='agent-a' for update`;
		const disabled = command("agent-a", "disable_agent");
		const outcome = await Promise.race([
			disabled.then((result) => result.outcome),
			new Promise((resolve) => setTimeout(() => resolve("blocked"), 5_000)),
		]);
		expect(outcome).toBe("accepted");
		await worker`select 1 from platform.agent_applications where agent_id='agent-a' for update`;
		await worker`commit`;
	} finally {
		await worker`rollback`.catch(() => {});
		worker.release();
	}
	expect(await disableRows()).toEqual([
		{ agent_id: "agent-a", status: "waiting", unsent: true },
	]);
});

it("the schema rejects extra request fields and an unconfirmed disabled claim", async () => {
	await registered("agent-a");
	expect((await command("agent-a", "disable_agent")).outcome).toBe("accepted");
	await expect(
		sql`update platform.connection_consumer_disables set status='disabled'`,
	).rejects.toMatchObject({ code: "23514" });
	const claim = await lease(disableOperation);
	await disables.beginAttempt(claim, true);
	await expect(
		sql`update platform.connection_consumer_disables set request = request || '{"token":"forbidden"}'::jsonb`,
	).rejects.toMatchObject({ code: "23514" });
	await expect(
		sql`update platform.connection_consumer_disables set request = jsonb_set(request, '{platformAgentId}', '"agent-b"')`,
	).rejects.toMatchObject({ code: "23514" });
});

it("projects disabling and disabled over the association status (#851)", async () => {
	const query = new PostgresAgentConfigurationQueryV1({
		databaseUrl: database.databaseUrl,
	});
	try {
		await registered("agent-a");
		await registered("agent-b");
		await registered("agent-c");
		expect((await command("agent-a", "disable_agent")).outcome).toBe(
			"accepted",
		);
		expect((await command("agent-b", "disable_agent")).outcome).toBe(
			"accepted",
		);
		const claims = await disables.pending();
		const bId = (
			await sql`select operation_id from platform.connection_consumer_disables where agent_id='agent-b'`
		)[0]?.operation_id;
		expect(claims).toContain(bId);
		const claim = await lease(disableOperation, bId);
		const attempt = await disables.beginAttempt(claim, true);
		if (attempt?.outcome !== "deliver") throw new Error("Expected disable");
		await disables.complete(claim, {
			outcome: "disabled",
			receipt: {
				schemaVersion: 1,
				operationId: attempt.intent.operationId,
				consumerId: attempt.intent.consumerId,
				registrationId: attempt.intent.registrationId,
				resultRevision: "8",
				requestDigest: attempt.intent.requestDigest,
			},
		});
		const present = async (agentId: string) => {
			const authority = await query.readAuthority({
				agentId,
				actorId: owner.userId,
				organizationIds: [],
				isAdministrator: false,
			});
			if (authority.outcome !== "found") throw new Error("Missing authority");
			const result = await query.readRuntimePresentation({
				agentId,
				actorId: owner.userId,
				accountStatus: "active",
				organizationIds: [],
				isAdministrator: false,
				expected: {
					configurationRevision: authority.configuration.revision,
					management: authority.management,
				},
			});
			return result.outcome === "found"
				? result.connectionAssociation
				: result.outcome;
		};
		expect(
			await Promise.all(["agent-a", "agent-b", "agent-c"].map(present)),
		).toEqual([
			{ status: "disabling" },
			{ status: "disabled" },
			{ status: "associated" },
		]);
	} finally {
		await query.close();
	}
});
