import type {
	AgentManagementActorContextV1,
	AgentManagementCommandV1,
	AgentManagementInterfaceV1,
	AgentManagementStateV1,
	AgentManagementTransactionPortV1,
} from "@agent-infra/platform-core";
import {
	createAgentManagementV1,
	platformIdempotencyV1,
} from "@agent-infra/platform-core";
import postgres from "postgres";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";

import {
	type AgentManagementConformanceOptionsV1,
	agentManagementV1Conformance,
} from "../../platform-core/src/agent-management.conformance.ts";
import {
	PostgresAgentManagementQueryV1,
	PostgresAgentManagementTransactionV1,
} from "./agent-management.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import { isPostgresError } from "./postgres-error.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";

vi.setConfig({ testTimeout: 30_000 });

const applicant: AgentManagementActorContextV1 = {
	schemaVersion: 1,
	userId: "user_applicant",
	accountStatus: "active",
	organizationIds: ["org_platform"],
	isAdministrator: false,
};
const administrator: AgentManagementActorContextV1 = {
	...applicant,
	userId: "user_admin",
	isAdministrator: true,
};
let adminClient: ReturnType<typeof postgres>;
let databaseUrl = "";
let testDatabase: PostgresTestDatabase | undefined;
const adapters: { close(): Promise<void> }[] = [];
const failureFunction = "platform.inject_agent_management_failure";
const failureTrigger = "inject_agent_management_failure";

type FailurePoint =
	| "state"
	| "history"
	| "outbox"
	| "audit"
	| "idempotency"
	| "commit";

const failureTarget = {
	state: { table: "platform.agent_applications", event: "update" },
	history: { table: "platform.agent_management_history", event: "insert" },
	outbox: { table: "platform.outbox_items", event: "insert" },
	audit: { table: "platform.audit_events", event: "insert" },
	idempotency: { table: "platform.idempotency_records", event: "insert" },
	commit: { table: "platform.audit_events", event: "insert" },
} as const;

function stateFixture(
	overrides: Partial<AgentManagementStateV1> = {},
): AgentManagementStateV1 {
	const status = overrides.status ?? "available";
	const preApproval =
		status === "pending_approval" ||
		status === "rejected" ||
		status === "withdrawn";
	return {
		schemaVersion: 1,
		applicationId: "application_fixture",
		agentId: "agent_fixture",
		applicantId: applicant.userId,
		status,
		revision: 1,
		approvalRevision: preApproval ? null : 1,
		decisionReason: status === "rejected" ? "Capacity unavailable" : null,
		serviceAvailability: status === "available" ? "ready" : null,
		desiredState:
			status === "stopped" || status === "disabled" || preApproval
				? "stopped"
				: "running",
		workloadRevision: preApproval ? 0 : 1,
		fence: preApproval ? 0 : 1,
		ownerIds: [applicant.userId],
		availability: [],
		failureCode: status === "creation_failed" ? "creation_not_ready" : null,
		...overrides,
	};
}

async function clearDatabase(): Promise<void> {
	await adminClient`truncate platform.audit_events, platform.outbox_items,
		platform.idempotency_records, platform.agent_management_history,
		platform.agent_availability, platform.agent_owners,
		platform.agent_configuration_revisions, platform.agent_applications,
		platform.agents cascade`;
}

async function disarmFailure(point: FailurePoint | undefined): Promise<void> {
	if (!point) return;
	await adminClient.unsafe(
		`drop trigger if exists ${failureTrigger} on ${failureTarget[point].table}`,
	);
	await adminClient.unsafe(`drop function if exists ${failureFunction}()`);
}

async function armFailure(point: FailurePoint): Promise<void> {
	await adminClient.unsafe(`
		create function ${failureFunction}() returns trigger language plpgsql as $$
		begin
			raise exception 'injected Agent-management failure';
		end
		$$
	`);
	const target = failureTarget[point];
	const constraint = point === "commit" ? "constraint " : "";
	const timing = point === "commit" ? "after" : "before";
	const deferred = point === "commit" ? "deferrable initially deferred " : "";
	await adminClient.unsafe(
		`create ${constraint}trigger ${failureTrigger} ${timing} ${target.event} on ${target.table} ${deferred}for each row execute function ${failureFunction}()`,
	);
}

async function databaseSnapshot() {
	const [
		applications,
		owners,
		availability,
		history,
		outbox,
		audit,
		idempotency,
	] = await Promise.all([
		adminClient`
				select id, status, management_revision, approval_revision,
					decision_reason, service_availability, desired_state,
					workload_revision, fence, failure_code
				from platform.agent_applications order by id
			`,
		adminClient`
				select agent_id, owner_id, created_at
				from platform.agent_owners order by agent_id, owner_id
			`,
		adminClient`
				select agent_id, target_type, target_id
				from platform.agent_availability
				order by agent_id, target_type, target_id
			`,
		adminClient`select count(*)::int count from platform.agent_management_history`,
		adminClient`select count(*)::int count from platform.outbox_items`,
		adminClient`select count(*)::int count from platform.audit_events`,
		adminClient`select count(*)::int count from platform.idempotency_records`,
	]);
	return {
		applications,
		owners,
		availability,
		history: history[0]?.count,
		outbox: outbox[0]?.count,
		audit: audit[0]?.count,
		idempotency: idempotency[0]?.count,
	};
}

async function seedStates(states: readonly AgentManagementStateV1[]) {
	await clearDatabase();
	if (states.length === 0) return;
	const createdAt = new Date("2026-08-31T00:00:00.000Z");
	await adminClient`
		insert into platform.agents ${adminClient(
			states.map((state) => ({
				id: state.agentId,
				current_configuration_revision: 1,
				created_at: createdAt,
			})),
			"id",
			"current_configuration_revision",
			"created_at",
		)}
	`;
	await adminClient`
		insert into platform.agent_applications ${adminClient(
			states.map((state) => ({
				id: state.applicationId,
				agent_id: state.agentId,
				applicant_id: state.applicantId,
				name: `Name ${state.agentId}`,
				description: `Description ${state.agentId}`,
				status: state.status,
				management_revision: state.revision,
				approval_revision: state.approvalRevision,
				decision_reason: state.decisionReason,
				service_availability: state.serviceAvailability,
				desired_state: state.desiredState,
				workload_revision: state.workloadRevision,
				fence: state.fence,
				failure_code: state.failureCode,
				trace_id: `trace_${state.applicationId}`,
				request_id: `request_${state.applicationId}`,
				submitted_at: createdAt,
			})),
		)}
	`;
	await adminClient`
		insert into platform.agent_configuration_revisions ${adminClient(
			states.map((state) => ({
				agent_id: state.agentId,
				revision: 1,
				source_reference: `source:${state.agentId}`,
				created_at: createdAt,
			})),
			"agent_id",
			"revision",
			"source_reference",
			"created_at",
		)}
	`;
	const owners = states.flatMap((state) =>
		state.ownerIds.map((ownerId) => ({
			agent_id: state.agentId,
			owner_id: ownerId,
			created_at: createdAt,
		})),
	);
	if (owners.length > 0) {
		await adminClient`
			insert into platform.agent_owners ${adminClient(
				owners,
				"agent_id",
				"owner_id",
				"created_at",
			)}
		`;
	}
	const availability = states.flatMap((state) =>
		state.availability.map((target) => ({
			agent_id: state.agentId,
			target_type: target.kind,
			target_id: target.kind === "user" ? target.userId : target.organizationId,
		})),
	);
	if (availability.length > 0) {
		await adminClient`
			insert into platform.agent_availability ${adminClient(
				availability,
				"agent_id",
				"target_type",
				"target_id",
			)}
		`;
	}
}

async function waitForBlockedQuery(includes: readonly string[]): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const rows = await adminClient<{ query: string }[]>`
			select query from pg_stat_activity
			where datname = current_database() and wait_event_type = 'Lock'
		`;
		if (
			rows.some(({ query }) =>
				includes.every((fragment) => query.toLowerCase().includes(fragment)),
			)
		) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(
		`Timed out waiting for blocked query: ${includes.join(", ")}`,
	);
}

function command(
	name: "approve_application" | "stop_agent",
	state: AgentManagementStateV1,
	idempotencyKey: string,
): AgentManagementCommandV1 {
	const common = {
		schemaVersion: 1 as const,
		expectedRevision: state.revision,
		idempotencyKey,
		requestId: `request_${idempotencyKey}`,
		traceId: `trace_${idempotencyKey}`,
	};
	return name === "approve_application"
		? { ...common, command: name, applicationId: state.applicationId }
		: { ...common, command: name, agentId: state.agentId };
}

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("agent-management");
	databaseUrl = testDatabase.databaseUrl;
	await migratePlatformDatabase({ databaseUrl });
	adminClient = postgres(databaseUrl, { max: 1 });
}, 120_000);

afterEach(async () => {
	await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

afterAll(async () => {
	await adminClient?.end();
	await testDatabase?.stop();
});

describe("PostgreSQL Agent-management Adapter", () => {
	agentManagementV1Conformance(
		async (
			options: AgentManagementConformanceOptionsV1,
		): Promise<AgentManagementInterfaceV1> => {
			let faultyState =
				options.faultyStateOnce && structuredClone(options.faultyStateOnce);
			try {
				await seedStates(options.states ?? []);
			} catch (error) {
				if (
					faultyState ||
					options.states?.length !== 1 ||
					(!isPostgresError(error, "23514") && !isPostgresError(error, "23505"))
				) {
					throw error;
				}
				await clearDatabase();
				faultyState = structuredClone(options.states[0]);
			}
			const adapter = new PostgresAgentManagementTransactionV1({ databaseUrl });
			adapters.push(adapter);
			const takeFaultyState = () => {
				const state = faultyState;
				faultyState = undefined;
				return state;
			};
			const transaction: AgentManagementTransactionPortV1 = {
				async executeAgentManagementTransaction(request, decide) {
					if (options.failure === "transaction") {
						throw new Error("injected transaction failure");
					}
					return adapter.executeAgentManagementTransaction(request, (state) =>
						decide(takeFaultyState() ?? state),
					);
				},
				async resolveAgentAccessState(agentId) {
					if (options.failure === "access_read") {
						throw new Error("injected access read failure");
					}
					return takeFaultyState() ?? adapter.resolveAgentAccessState(agentId);
				},
			};
			return createAgentManagementV1(transaction, { now: options.now });
		},
	);

	it("allows one concurrent revision winner and commits one side-effect set", async () => {
		const state = stateFixture({
			applicationId: "application_concurrent",
			agentId: "agent_concurrent",
			status: "available",
			revision: 7,
			workloadRevision: 4,
			fence: 9,
		});
		await seedStates([state]);
		const firstAdapter = new PostgresAgentManagementTransactionV1({
			databaseUrl,
		});
		const secondAdapter = new PostgresAgentManagementTransactionV1({
			databaseUrl,
		});
		adapters.push(firstAdapter, secondAdapter);
		const first = createAgentManagementV1(firstAdapter);
		const second = createAgentManagementV1(secondAdapter);
		const decisions = await Promise.all([
			first.executeManagementCommand(
				command("stop_agent", state, "winner-a"),
				applicant,
			),
			second.executeManagementCommand(
				command("stop_agent", state, "winner-b"),
				applicant,
			),
		]);
		expect(decisions.map(({ outcome }) => outcome).sort()).toEqual([
			"accepted",
			"conflict",
		]);
		expect(
			decisions.find(({ outcome }) => outcome === "conflict"),
		).toMatchObject({ reason: "stale_revision" });
		const [counts] = await adminClient<
			{
				history: number;
				outbox: number;
				audit: number;
				idempotency: number;
			}[]
		>`
			select
				(select count(*)::int from platform.agent_management_history) history,
				(select count(*)::int from platform.outbox_items) outbox,
				(select count(*)::int from platform.audit_events) audit,
				(select count(*)::int from platform.idempotency_records) idempotency
		`;
		expect(counts).toEqual({ history: 1, outbox: 1, audit: 1, idempotency: 1 });
	});

	it("resolves authorization and readiness from one repeatable snapshot", async () => {
		const state = stateFixture({
			applicationId: "application_access_snapshot",
			agentId: "agent_access_snapshot",
			ownerIds: [applicant.userId],
			availability: [],
		});
		await seedStates([state]);
		const blocker = postgres(databaseUrl, { max: 1 });
		const updater = postgres(databaseUrl, { max: 1 });
		let releaseBlocker: (() => void) | undefined;
		const blockerReleased = new Promise<void>((resolve) => {
			releaseBlocker = resolve;
		});
		let markBlockerLocked: (() => void) | undefined;
		const blockerLocked = new Promise<void>((resolve) => {
			markBlockerLocked = resolve;
		});
		const blockerTask = Promise.resolve(
			blocker.begin(async (transaction) => {
				await transaction.unsafe(
					"lock table platform.agent_availability in access exclusive mode",
				);
				markBlockerLocked?.();
				await blockerReleased;
			}),
		);
		let updaterTask: Promise<unknown> | undefined;
		try {
			await blockerLocked;
			updaterTask = Promise.resolve(
				updater.begin(async (transaction) => {
					await transaction.unsafe(
						"lock table platform.agent_availability in access exclusive mode",
					);
					await transaction`
					insert into platform.agent_availability
						(agent_id, target_type, target_id)
					values (${state.agentId}, 'user', 'user_newly_available')
				`;
					await transaction`
					update platform.agent_applications
					set status = 'stopped', service_availability = null,
						desired_state = 'stopped'
					where id = ${state.applicationId}
				`;
				}),
			);
			await waitForBlockedQuery(["lock table", "agent_availability"]);
			const adapter = new PostgresAgentManagementTransactionV1({ databaseUrl });
			adapters.push(adapter);
			const management = createAgentManagementV1(adapter);
			const access = management.resolveAgentAccess(
				{ schemaVersion: 1, agentId: state.agentId, intent: "use" },
				{
					...applicant,
					userId: "user_newly_available",
					organizationIds: [],
				},
			);
			await waitForBlockedQuery(["select", "agent_availability"]);
			releaseBlocker?.();
			await expect(access).resolves.toEqual({ outcome: "denied" });
			await Promise.all([blockerTask, updaterTask]);
		} finally {
			releaseBlocker?.();
			await Promise.allSettled([
				blockerTask,
				...(updaterTask ? [updaterTask] : []),
			]);
			await blocker.end();
			await updater.end();
		}
	});

	it("rolls back the whole accepted plan at every write and deferred commit", async () => {
		for (const point of Object.keys(failureTarget) as FailurePoint[]) {
			const state = stateFixture({
				applicationId: `application_rollback_${point}`,
				agentId: `agent_rollback_${point}`,
				status: "pending_approval",
				revision: 3,
				availability: [{ kind: "user", userId: "user_visible" }],
			});
			await seedStates([state]);
			const before = await databaseSnapshot();
			const adapter = new PostgresAgentManagementTransactionV1({ databaseUrl });
			let armed: FailurePoint | undefined;
			try {
				armed = point;
				await armFailure(point);
				const management = createAgentManagementV1(adapter, {
					now: () => new Date("2026-08-31T08:00:00.000Z"),
				});
				await expect(
					management.executeManagementCommand(
						command("approve_application", state, `rollback-${point}`),
						administrator,
					),
				).rejects.toMatchObject({
					name: "AgentManagementError",
					code: "unavailable",
					message: "Agent management is temporarily unavailable",
				});
			} finally {
				await disarmFailure(armed);
				await adapter.close();
			}
			expect(await databaseSnapshot(), point).toEqual(before);
		}
	});

	it("persists the accepted plan and correlation without guessing actor type", async () => {
		const owner = { ...applicant, userId: "platform_worker" };
		const state = stateFixture({
			applicationId: "application_exact_plan",
			agentId: "agent_exact_plan",
			ownerIds: [owner.userId],
			availability: [{ kind: "organization", organizationId: "org_visible" }],
		});
		await seedStates([state]);
		const accessBefore = await adminClient`
			select 'owner' as kind, owner_id as target_id, xmin::text as version,
				ctid::text as tuple
			from platform.agent_owners where agent_id = ${state.agentId}
			union all
			select 'availability', target_type::text || ':' || target_id,
				xmin::text, ctid::text
			from platform.agent_availability where agent_id = ${state.agentId}
			order by kind, target_id
		`;
		const adapter = new PostgresAgentManagementTransactionV1({ databaseUrl });
		adapters.push(adapter);
		const occurredAt = new Date("2026-08-31T09:00:00.000Z");
		const management = createAgentManagementV1(adapter, {
			now: () => occurredAt,
		});
		const decision = await management.executeManagementCommand(
			command("stop_agent", state, "exact-plan"),
			owner,
		);
		expect(decision).toMatchObject({
			outcome: "accepted",
			result: { status: "stopped", revision: 2 },
		});

		const [application] = await adminClient`
			select status, management_revision, approval_revision,
				service_availability, desired_state, workload_revision, fence
			from platform.agent_applications where id = ${state.applicationId}
		`;
		expect(application).toMatchObject({
			status: "stopped",
			management_revision: "2",
			approval_revision: "1",
			service_availability: null,
			desired_state: "stopped",
			workload_revision: "2",
			fence: "2",
		});
		const [history] = await adminClient`
			select revision, subject_type, subject_id, operation, from_status,
				to_status, occurred_at
			from platform.agent_management_history where agent_id = ${state.agentId}
		`;
		expect(history).toMatchObject({
			revision: "2",
			subject_type: "agent",
			subject_id: state.agentId,
			operation: "stop_agent",
			from_status: "available",
			to_status: "stopped",
			occurred_at: occurredAt,
		});
		const [outbox] = await adminClient`
			select scope_type, scope_id, operation, payload, trace_id, request_id
			from platform.outbox_items
		`;
		expect(outbox).toMatchObject({
			scope_type: "agent",
			scope_id: state.agentId,
			operation: "agent.workload.reconcile.v1",
			payload: {
				schemaVersion: 1,
				agentId: state.agentId,
				revision: 2,
				workloadRevision: 2,
				fence: 2,
				desiredState: "stopped",
			},
			trace_id: "trace_exact-plan",
			request_id: "request_exact-plan",
		});
		const [audit] = await adminClient`
			select actor_type, actor_id, action, target_type, target_id,
				trace_id, request_id, occurred_at
			from platform.audit_events
		`;
		expect(audit).toMatchObject({
			actor_type: "user",
			actor_id: owner.userId,
			action: "agent.lifecycle.stopped",
			target_type: "agent",
			target_id: state.agentId,
			trace_id: "trace_exact-plan",
			request_id: "request_exact-plan",
			occurred_at: occurredAt,
		});
		const [idempotency] = await adminClient`
			select scope_type, scope_id, actor_id, command_type, idempotency_key,
				request_digest, status, result
			from platform.idempotency_records
		`;
		expect(idempotency).toMatchObject({
			scope_type: "agent",
			scope_id: state.agentId,
			actor_id: owner.userId,
			command_type: "agent.management.v1",
			idempotency_key: "exact-plan",
			status: "completed",
			result: {
				schemaVersion: 1,
				applicationId: state.applicationId,
				agentId: state.agentId,
				status: "stopped",
				revision: 2,
			},
		});
		expect(idempotency?.request_digest).toMatch(/^[a-f0-9]{64}$/);
		const accessAfter = await adminClient`
			select 'owner' as kind, owner_id as target_id, xmin::text as version,
				ctid::text as tuple
			from platform.agent_owners where agent_id = ${state.agentId}
			union all
			select 'availability', target_type::text || ':' || target_id,
				xmin::text, ctid::text
			from platform.agent_availability where agent_id = ${state.agentId}
			order by kind, target_id
		`;
		expect(accessAfter).toEqual(accessBefore);
	});

	it("replays before authorization and denies a fresh command after Owner removal", async () => {
		const state = stateFixture({
			applicationId: "application_removed_owner",
			agentId: "agent_removed_owner",
			ownerIds: [applicant.userId, "user_remaining"],
		});
		await seedStates([state]);
		const adapter = new PostgresAgentManagementTransactionV1({ databaseUrl });
		adapters.push(adapter);
		const management = createAgentManagementV1(adapter);
		const original = command("stop_agent", state, "removed-owner-replay");
		expect(
			await management.executeManagementCommand(original, applicant),
		).toMatchObject({ outcome: "accepted", result: { revision: 2 } });
		await adminClient`
			delete from platform.agent_owners
			where agent_id = ${state.agentId} and owner_id = ${applicant.userId}
		`;
		expect(
			await management.executeManagementCommand(original, applicant),
		).toMatchObject({ outcome: "replayed", result: { revision: 2 } });
		expect(
			await management.executeManagementCommand(
				{
					schemaVersion: 1,
					command: "restart_agent",
					agentId: state.agentId,
					expectedRevision: 2,
					idempotencyKey: "removed-owner-fresh",
					requestId: "request_removed-owner-fresh",
					traceId: "trace_removed-owner-fresh",
				},
				applicant,
			),
		).toEqual({ outcome: "denied", writePlan: null });
	});

	it("fails closed on cross-Agent and impossible idempotency results", async () => {
		const state = stateFixture({
			applicationId: "application_malicious_replay",
			agentId: "agent_malicious_replay",
		});
		const original = command("stop_agent", state, "malicious-replay");
		const requestDigest = platformIdempotencyV1.canonicalRequestDigest({
			...original,
		});
		const adapter = new PostgresAgentManagementTransactionV1({ databaseUrl });
		adapters.push(adapter);
		const management = createAgentManagementV1(adapter);
		for (const [id, result] of [
			[
				"cross-agent",
				{
					schemaVersion: 1,
					applicationId: state.applicationId,
					agentId: "agent_other",
					status: "stopped",
					revision: 2,
				},
			],
			[
				"zero-revision",
				{
					schemaVersion: 1,
					applicationId: state.applicationId,
					agentId: state.agentId,
					status: "stopped",
					revision: 0,
				},
			],
		] as const) {
			await seedStates([state]);
			await adminClient`
				insert into platform.idempotency_records
					(id, scope_type, scope_id, actor_id, command_type,
					 idempotency_key, request_digest, status, result,
					 created_at, updated_at)
				values (${id}, 'agent', ${state.agentId}, ${applicant.userId},
					'agent.management.v1', ${original.idempotencyKey}, ${requestDigest},
					'completed', ${adminClient.json(result as never)}, now(), now())
			`;
			await expect(
				management.executeManagementCommand(original, applicant),
			).rejects.toMatchObject({
				name: "AgentManagementError",
				code: "unavailable",
			});
		}
	});

	it("returns only applicant, administrator, Owner, and visible-user scoped projections", async () => {
		const ownPending = stateFixture({
			applicationId: "application_a_own",
			agentId: "agent_a_own",
			status: "pending_approval",
			applicantId: applicant.userId,
			ownerIds: [applicant.userId],
		});
		const otherPending = stateFixture({
			applicationId: "application_b_other",
			agentId: "agent_b_other",
			status: "pending_approval",
			applicantId: "user_other",
			ownerIds: ["user_other"],
		});
		const shared = stateFixture({
			applicationId: "application_c_shared",
			agentId: "agent_c_shared",
			applicantId: "user_other",
			ownerIds: ["user_owner"],
			availability: [
				{ kind: "user", userId: "user_direct" },
				{ kind: "organization", organizationId: "org_shared" },
			],
		});
		await seedStates([ownPending, otherPending, shared]);
		const query = new PostgresAgentManagementQueryV1({ databaseUrl });
		adapters.push(query);

		const applicantPage = await query.listApplications(
			{ kind: "applicant", applicantId: applicant.userId },
			{ limit: 10 },
		);
		expect(
			applicantPage.items.map(({ applicationId }) => applicationId),
		).toEqual([ownPending.applicationId]);
		expect(applicantPage.items[0]).toMatchObject({
			sourceReference: `source:${ownPending.agentId}`,
			management: { ownerIds: [applicant.userId], revision: 1 },
		});
		expect(
			await query.getApplication(
				{ kind: "applicant", applicantId: applicant.userId },
				otherPending.applicationId,
			),
		).toBeUndefined();
		expect(
			await query.getApplication(
				{ kind: "applicant", applicantId: applicant.userId },
				"application_missing",
			),
		).toBeUndefined();
		expect(
			(
				await query.listApplications({ kind: "administrator" }, { limit: 10 })
			).items.map(({ applicationId }) => applicationId),
		).toEqual([ownPending.applicationId, otherPending.applicationId]);
		expect(
			(
				await query.listAgents(
					{ kind: "owner", ownerId: applicant.userId },
					{ limit: 10 },
				)
			).items,
		).toEqual([]);

		for (const scope of [
			{ kind: "owner" as const, ownerId: "user_owner" },
			{
				kind: "user" as const,
				userId: "user_direct",
				organizationIds: [],
			},
			{
				kind: "user" as const,
				userId: "user_org",
				organizationIds: ["org_shared"],
			},
		]) {
			const page = await query.listAgents(scope, { limit: 10 });
			expect(page.items.map(({ agentId }) => agentId)).toEqual([
				shared.agentId,
			]);
			expect(page.items[0]).toMatchObject({
				sourceReference: `source:${shared.agentId}`,
				management: {
					ownerIds: ["user_owner"],
					availability: shared.availability,
				},
			});
		}
		expect(
			await query.getAgent(
				{ kind: "user", userId: "user_attacker", organizationIds: [] },
				shared.agentId,
			),
		).toBeUndefined();
		expect(
			await query.getAgent(
				{ kind: "user", userId: "user_attacker", organizationIds: [] },
				"agent_missing",
			),
		).toBeUndefined();
	});

	it("sanitizes PostgreSQL and Drizzle failures at the Store boundary", async () => {
		const adapter = new PostgresAgentManagementTransactionV1({
			databaseUrl:
				"postgres://platform_user:database-secret@127.0.0.1:1/platform",
		});
		let failure: unknown;
		try {
			await adapter.resolveAgentAccessState("agent_failure");
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({
			name: "AgentManagementError",
			code: "unavailable",
			message: "Agent management is temporarily unavailable",
		});
		expect(String(failure)).not.toMatch(
			/database-secret|127\.0\.0\.1|select|sql|drizzle/i,
		);
		await adapter.close().catch(() => {});
	});
});
