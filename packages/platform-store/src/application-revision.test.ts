import type {
	AgentManagementStateV1,
	ApplicationRevisionTransactionPortV1,
	ApplicationRevisionWritePlanV1,
	ReviseApplicationCommandV1,
} from "@agent-infra/platform-core";
import { createApplicationRevisionUseCaseV1 } from "@agent-infra/platform-core";
import { FakeAgentConfigurationAdmissionsV1 } from "@agent-infra/platform-core/testing";
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
	agentConfigurationConformanceAdmissionsV1,
	agentConfigurationConformanceRecordV1,
} from "../../platform-core/src/agent-configuration.conformance.ts";
import {
	applicationRevisionStateV1,
	applicationRevisionTransactionConformance,
} from "../../platform-core/src/application-revision.conformance.ts";
import type { ApplicationRevisionReadStateV1 } from "../../platform-core/src/application-revision.ts";
import type {
	ApplicationRevisionFailurePoint,
	ApplicationRevisionFakeSnapshotV1,
} from "../../platform-core/src/fake-application-revision.ts";
import { decodeAgentConfigurationRecord } from "./agent-configuration-record.ts";
import {
	ApplicationRevisionStoreError,
	PostgresApplicationRevisionTransactionV1,
} from "./application-revision.ts";
import { migratePlatformDatabase } from "./migrate.ts";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "./postgres-test.ts";
import { createSecretRecordFixtureResolver } from "./secret-record-fixture.ts";

vi.setConfig({ testTimeout: 30_000 });

const occurredAt = new Date("2026-09-02T04:00:00.000Z");
const applicationId = "application_01";
const agentId = "agent_01";
const applicantId = "owner_01";

let adminClient: ReturnType<typeof postgres>;
let databaseUrl = "";
let testDatabase: PostgresTestDatabase | undefined;
const adapters: PostgresApplicationRevisionTransactionV1[] = [];

function managementState(
	status: "pending_approval" | "rejected" = "pending_approval",
	availability: AgentManagementStateV1["availability"] = [],
): AgentManagementStateV1 {
	return {
		schemaVersion: 1,
		applicationId,
		agentId,
		applicantId,
		status,
		revision: 3,
		approvalRevision: null,
		decisionReason: status === "rejected" ? "Insufficient detail" : null,
		serviceAvailability: null,
		desiredState: "stopped",
		workloadRevision: 0,
		fence: 0,
		ownerIds: [applicantId],
		availability,
		failureCode: null,
	};
}

function readState(
	status: "pending_approval" | "rejected" = "pending_approval",
	availability: AgentManagementStateV1["availability"] = [],
) {
	return {
		schemaVersion: 1 as const,
		application: {
			applicationId,
			agentId,
			applicantId,
			name: "Original Agent",
			description: "Original description",
		},
		management: managementState(status, availability),
		configuration: structuredClone(agentConfigurationConformanceRecordV1),
		authorizationRevision: "authorization_9",
	};
}

function actor(digest = "0".repeat(64)) {
	return {
		schemaVersion: 1 as const,
		applicationId,
		userId: applicantId,
		accountStatus: "active" as const,
		organizationIds: ["org_platform"],
		isAdministrator: false,
		rawRequestDigest: digest,
	};
}

function command(
	key = "application-revision-01",
	access = false,
): ReviseApplicationCommandV1 {
	return {
		schemaVersion: 1,
		idempotencyKey: key,
		requestId: "request_01",
		traceId: "trace_01",
		name: "Revised Agent",
		description: "Revised description",
		coOwnerIds: access ? ["owner_02"] : [],
		availability: access
			? [{ kind: "organization", organizationId: "org_platform" }]
			: [],
		source: { kind: "standard", templateId: "template_01" },
		modelConfiguration: {
			options: [
				{
					optionId: "model_primary",
					endpointId: "endpoint_01",
					modelId: "gpt-5",
					reasoningLevels: ["low", "medium"],
					replaceCredential: true,
				},
			],
			defaultOptionId: "model_primary",
			defaultReasoningLevel: "medium",
		},
		environment: [{ name: "LOG_LEVEL", value: "debug" }],
		secrets: [{ name: "BOT_TOKEN", replace: true }],
		actions: agentConfigurationConformanceAdmissionsV1.actions,
		channels: [
			{
				kind: "wecom_bot",
				enabled: true,
				bindingReference: "binding_01",
			},
		],
	};
}

function nameOnlyCommand(): ReviseApplicationCommandV1 {
	return {
		schemaVersion: 1,
		idempotencyKey: "application-name-only",
		requestId: "request_name_only",
		traceId: "trace_name_only",
		name: "Name only",
		description: "Original description",
		coOwnerIds: [],
		availability: [],
		source: { kind: "standard", templateId: "template_01" },
		modelConfiguration: {
			options: [
				{
					optionId: "model_primary",
					endpointId: "endpoint_01",
					modelId: "gpt-5",
					reasoningLevels: ["low"],
					replaceCredential: false,
				},
			],
			defaultOptionId: "model_primary",
			defaultReasoningLevel: "low",
		},
		environment: [{ name: "LOG_LEVEL", value: "info" }],
		secrets: [],
		actions: [],
		channels: [],
	};
}

function admissions(
	state = managementState(),
	nextAuthorizationRevision = "authorization_10",
	stableConfiguration = false,
) {
	const accessAuthority = {
		state,
		actorContext: {
			schemaVersion: 1 as const,
			userId: applicantId,
			accountStatus: "active" as const,
			organizationIds: ["org_platform"],
			isAdministrator: false,
		},
		authorityContext: {
			schemaVersion: 1 as const,
			users: [
				{ userId: applicantId, accountStatus: "active" as const },
				{ userId: "owner_02", accountStatus: "active" as const },
			],
			organizationIds: ["org_platform"],
		},
	};
	return new FakeAgentConfigurationAdmissionsV1({
		...agentConfigurationConformanceAdmissionsV1,
		authorizations: [
			{
				agentId,
				actorId: applicantId,
				authorizationRevision: nextAuthorizationRevision,
				accessAuthority,
			},
		],
		...(stableConfiguration
			? {
					models: agentConfigurationConformanceAdmissionsV1.models.map(
						(model) => ({ ...model, catalogRevision: "catalog_3" }),
					),
					actionSetRevision: "actions_1",
					channelRevision: "channels_1",
				}
			: {}),
	});
}

function useCase(
	transaction: ApplicationRevisionTransactionPortV1,
	state = managementState(),
	nextAuthorizationRevision = "authorization_10",
	stableConfiguration = false,
) {
	const admission = admissions(
		state,
		nextAuthorizationRevision,
		stableConfiguration,
	);
	return createApplicationRevisionUseCaseV1(
		{
			transaction,
			authorizationAdmission: admission,
			imageAdmission: admission,
			modelAdmission: admission,
			secretAdmission: admission,
			actionAdmission: admission,
			channelAdmission: admission,
		},
		{ now: () => new Date(occurredAt) },
	);
}

function openAdapter() {
	const adapter = new PostgresApplicationRevisionTransactionV1({ databaseUrl });
	adapters.push(adapter);
	return adapter;
}

async function resetDatabase(): Promise<void> {
	await adminClient`truncate platform.audit_events, platform.outbox_items,
		platform.idempotency_records, platform.agent_management_history,
		platform.agent_availability, platform.agent_owners,
		platform.agent_configuration_revisions, platform.agent_applications,
		platform.agents cascade`;
}

async function seed(
	status: "pending_approval" | "rejected" = "pending_approval",
	availability: AgentManagementStateV1["availability"] = [],
): Promise<void> {
	await seedRevisionState(readState(status, availability));
}

async function seedRevisionState(
	state: ApplicationRevisionReadStateV1,
): Promise<void> {
	const configuration = state.configuration;
	const sourceReference =
		configuration.source.kind === "standard"
			? configuration.source.templateId
			: configuration.source.imageDigest;
	await adminClient`
		insert into platform.agents
			(id, current_configuration_revision, created_at, authorization_revision)
		values (${state.application.agentId}, ${configuration.revision},
			${occurredAt}, ${state.authorizationRevision})
	`;
	await adminClient`
		insert into platform.agent_applications
			(id, agent_id, applicant_id, name, description, status, trace_id,
			 request_id, submitted_at, management_revision, approval_revision,
			 decision_reason, service_availability, desired_state,
			 workload_revision, fence, failure_code)
		values (${state.application.applicationId}, ${state.application.agentId},
			${state.application.applicantId}, ${state.application.name},
			${state.application.description}, ${state.management.status},
			'trace_seed', 'request_seed', ${occurredAt},
			${state.management.revision}, ${state.management.approvalRevision},
			${state.management.decisionReason},
			${state.management.serviceAvailability}, ${state.management.desiredState},
			${state.management.workloadRevision}, ${state.management.fence},
			${state.management.failureCode})
	`;
	await adminClient`
		insert into platform.agent_configuration_revisions
			(agent_id, revision, source_reference, created_at, configuration)
		values (${state.application.agentId}, ${configuration.revision},
			${sourceReference}, ${occurredAt},
			${adminClient.json(configuration as never)})
	`;
	for (const ownerId of state.management.ownerIds) {
		await adminClient`
			insert into platform.agent_owners (agent_id, owner_id, created_at)
			values (${state.application.agentId}, ${ownerId}, ${occurredAt})
		`;
	}
	for (const target of state.management.availability) {
		await adminClient`
			insert into platform.agent_availability
				(agent_id, target_type, target_id)
			values (${state.application.agentId}, ${target.kind},
				${target.kind === "user" ? target.userId : target.organizationId})
		`;
	}
}

async function snapshot() {
	const [agent] = await adminClient`
		select current_configuration_revision, authorization_revision
		from platform.agents where id = ${agentId}
	`;
	const [application] = await adminClient`
		select name, description, status, management_revision, decision_reason,
			trace_id, request_id
		from platform.agent_applications where id = ${applicationId}
	`;
	const [configuration] = await adminClient`
		select configuration from platform.agent_configuration_revisions
		where agent_id = ${agentId}
			and revision = ${agent?.current_configuration_revision ?? 0}
	`;
	const [counts, owners, availability] = await Promise.all([
		adminClient`
			select
				(select count(*) from platform.agent_configuration_revisions) as configurations,
				(select count(*) from platform.agent_management_history) as history,
				(select count(*) from platform.idempotency_records) as idempotency,
				(select count(*) from platform.outbox_items) as outbox,
				(select count(*) from platform.audit_events) as audit
		`,
		adminClient`
			select owner_id from platform.agent_owners
			where agent_id = ${agentId} order by owner_id
		`,
		adminClient`
			select target_type, target_id from platform.agent_availability
			where agent_id = ${agentId} order by target_type, target_id
		`,
	]);
	return {
		application,
		currentConfigurationRevision: Number(agent?.current_configuration_revision),
		authorizationRevision: String(agent?.authorization_revision),
		configuration: configuration?.configuration
			? decodeAgentConfigurationRecord(configuration.configuration)
			: null,
		owners: owners.map(({ owner_id }) => String(owner_id)),
		availability: availability.map(({ target_type, target_id }) => ({
			targetType: String(target_type),
			targetId: String(target_id),
		})),
		counts: {
			configurations: Number(counts[0]?.configurations),
			history: Number(counts[0]?.history),
			idempotency: Number(counts[0]?.idempotency),
			outbox: Number(counts[0]?.outbox),
			audit: Number(counts[0]?.audit),
		},
	};
}

async function capturePlan(
	status: "pending_approval" | "rejected" = "pending_approval",
	access = false,
	availability: AgentManagementStateV1["availability"] = [],
): Promise<{
	readonly plan: ApplicationRevisionWritePlanV1;
	readonly attachments: Parameters<
		ApplicationRevisionTransactionPortV1["commit"]
	>[1];
}> {
	const state = readState(status, availability);
	let captured: ApplicationRevisionWritePlanV1 | undefined;
	let attachments: Parameters<
		ApplicationRevisionTransactionPortV1["commit"]
	>[1];
	const transaction: ApplicationRevisionTransactionPortV1 = {
		async read() {
			return { outcome: "ready", state: structuredClone(state) };
		},
		async commit(plan, nextAttachments) {
			captured = structuredClone(plan);
			attachments = structuredClone(nextAttachments);
			return { outcome: "conflict", reason: "stale_management" };
		},
	};
	await expect(
		useCase(transaction, state.management)
			.revise(
				command("capture-plan", access),
				actor(),
				createSecretRecordFixtureResolver(),
			)
			.catch((error: unknown) => {
				throw error;
			}),
	).rejects.toMatchObject({ code: "stale_revision" });
	if (!captured) throw new Error("Expected application revision plan");
	return { plan: captured, attachments };
}

async function createConformanceHarness(
	state: ApplicationRevisionReadStateV1 = applicationRevisionStateV1,
) {
	await resetDatabase();
	await seedRevisionState(state);
	const adapter = new PostgresApplicationRevisionTransactionV1({ databaseUrl });
	let lastPlan: ApplicationRevisionWritePlanV1 | null = null;
	let armed: { readonly point: string; readonly table: string } | undefined;
	let snapshotSequence = 0;
	const transaction: ApplicationRevisionTransactionPortV1 = {
		read: adapter.read.bind(adapter),
		async commit(plan) {
			try {
				const decision = await adapter.commit(plan);
				if (decision.outcome === "committed") {
					lastPlan = structuredClone(plan);
				}
				return decision;
			} finally {
				if (armed) {
					await disarmFailure(armed.point, armed.table);
					armed = undefined;
				}
			}
		},
	};
	return {
		transaction,
		async snapshot(): Promise<ApplicationRevisionFakeSnapshotV1> {
			snapshotSequence += 1;
			const decision = await adapter.read({
				schemaVersion: 1,
				applicationId: state.application.applicationId,
				actorId: state.application.applicantId,
				idempotencyKey: `conformance-snapshot-${snapshotSequence}`,
				requestDigest: "f".repeat(64),
			});
			if (decision.outcome !== "ready") {
				throw new Error("Expected readable application revision state");
			}
			const [counts, history] = await Promise.all([
				adminClient`
					select
						(select count(*) from platform.agent_management_history) as commit_count,
						(select count(*) from platform.idempotency_records) as idempotency_count,
						(select count(*) from platform.outbox_items) as outbox_count,
						(select count(*) from platform.audit_events) as audit_count
				`,
				adminClient`
					select from_status, to_status, revision
					from platform.agent_management_history
					where agent_id = ${state.application.agentId}
					order by revision
				`,
			]);
			return {
				state: decision.state,
				commitCount: Number(counts[0]?.commit_count),
				lastPlan,
				idempotencyCount: Number(counts[0]?.idempotency_count),
				history: history.map(({ from_status, to_status, revision }) => ({
					from: String(from_status) as "pending_approval" | "rejected",
					to: String(to_status) as "pending_approval",
					revision: Number(revision),
				})),
				outboxCount: Number(counts[0]?.outbox_count),
				auditCount: Number(counts[0]?.audit_count),
			};
		},
		async failNextBefore(point: ApplicationRevisionFailurePoint) {
			const targets: Record<
				ApplicationRevisionFailurePoint,
				readonly [string, "insert" | "update", string]
			> = {
				application: ["platform.agent_applications", "update", ""],
				configuration: ["platform.agent_configuration_revisions", "insert", ""],
				access: ["platform.agent_applications", "update", ""],
				authorization: ["platform.agents", "update", ""],
				management: ["platform.agent_applications", "update", ""],
				history: ["platform.agent_management_history", "insert", ""],
				idempotency: ["platform.idempotency_records", "insert", ""],
				outbox: ["platform.outbox_items", "insert", ""],
				audit: ["platform.audit_events", "insert", ""],
				commit: ["platform.audit_events", "insert", "deferred"],
			};
			const [table, operation, condition] = targets[point];
			const triggerPoint = `conformance_${point}`;
			await armFailure(triggerPoint, table, operation, condition);
			armed = { point: triggerPoint, table };
		},
		async advanceManagementRevision() {
			await adminClient`
				update platform.agent_applications
				set management_revision = management_revision + 1
				where id = ${state.application.applicationId}
			`;
		},
		async advanceConfigurationRevision() {
			const [current] = await adminClient`
				select a.current_configuration_revision, c.configuration,
					c.source_reference
				from platform.agents a
				join platform.agent_configuration_revisions c
					on c.agent_id = a.id
					and c.revision = a.current_configuration_revision
				where a.id = ${state.application.agentId}
			`;
			const configuration = decodeAgentConfigurationRecord(
				current?.configuration,
			);
			const revision = Number(current?.current_configuration_revision) + 1;
			await adminClient.begin(async (sql) => {
				await sql`
					insert into platform.agent_configuration_revisions
						(agent_id, revision, source_reference, created_at, configuration)
					values (${state.application.agentId}, ${revision},
						${String(current?.source_reference)}, ${occurredAt},
						${sql.json({ ...configuration, revision } as never)})
				`;
				await sql`
					update platform.agents
					set current_configuration_revision = ${revision}
					where id = ${state.application.agentId}
				`;
			});
		},
		async setAuthorizationRevision(revision: string) {
			await adminClient`
				update platform.agents set authorization_revision = ${revision}
				where id = ${state.application.agentId}
			`;
		},
		async close() {
			if (armed) await disarmFailure(armed.point, armed.table);
			await adapter.close();
		},
	};
}

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("application-revision");
	databaseUrl = testDatabase.databaseUrl;
	await migratePlatformDatabase({ databaseUrl });
	adminClient = postgres(databaseUrl, { max: 4 });
}, 120_000);

afterEach(async () => {
	await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
});

afterAll(async () => {
	await adminClient?.end();
	await testDatabase?.stop();
});

describe("PostgreSQL application revision transaction", () => {
	applicationRevisionTransactionConformance(createConformanceHarness);

	it("atomically persists revision Secret ciphertext records", async () => {
		await resetDatabase();
		await seed("rejected");
		const adapter = openAdapter();
		const revision = useCase(adapter, managementState("rejected"));
		await revision.revise(
			command("revision-secret-sidecar"),
			actor(),
			createSecretRecordFixtureResolver(),
		);
		const records = await adminClient`
			select agent_id, secret_id, secret_version, configuration_revision,
				owner_id, lifecycle_state, record
			from platform.secret_records
			order by secret_id
		`;
		expect(records).toHaveLength(2);
		expect(records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					agent_id: agentId,
					configuration_revision: "8",
					owner_id: applicantId,
					lifecycle_state: "pending",
				}),
			]),
		);
		expect(JSON.stringify(records)).not.toContain("fixture:");
	});

	it("returns only the applicant-scoped complete revision state", async () => {
		await resetDatabase();
		await seed();
		const adapter = openAdapter();
		await expect(
			adapter.read({
				schemaVersion: 1,
				applicationId,
				actorId: applicantId,
				idempotencyKey: "read-revision",
				requestDigest: "0".repeat(64),
			}),
		).resolves.toMatchObject({
			outcome: "ready",
			state: {
				application: { applicationId, agentId, applicantId },
				management: { status: "pending_approval", revision: 3 },
				configuration: { agentId, revision: 7 },
				authorizationRevision: "authorization_9",
			},
		});
		await expect(
			adapter.read({
				schemaVersion: 1,
				applicationId,
				actorId: "user_other",
				idempotencyKey: "read-cross-user",
				requestDigest: "0".repeat(64),
			}),
		).resolves.toEqual({ outcome: "unavailable" });
		await expect(
			adapter.read({
				schemaVersion: 1,
				applicationId: "application_missing",
				actorId: applicantId,
				idempotencyKey: "read-missing",
				requestDigest: "0".repeat(64),
			}),
		).resolves.toEqual({ outcome: "unavailable" });
	});

	it("atomically revises content, configuration, access, management, and bounded effects", async () => {
		await resetDatabase();
		await seed("rejected");
		const state = managementState("rejected");
		const adapter = openAdapter();
		const revision = useCase(adapter, state);
		const input = command("revise-rejected", true);
		const first = await revision.revise(
			input,
			actor(),
			createSecretRecordFixtureResolver(),
		);
		expect(first).toEqual({
			schemaVersion: 1,
			applicationId,
			agentId,
			status: "pending_approval",
			managementRevision: 4,
			configurationRevision: 8,
		});
		await expect(revision.revise(input, actor())).resolves.toEqual(first);
		const stored = await snapshot();
		expect(stored).toMatchObject({
			application: {
				name: "Revised Agent",
				description: "Revised description",
				status: "pending_approval",
				management_revision: "4",
				decision_reason: null,
				trace_id: "trace_01",
				request_id: "request_01",
			},
			currentConfigurationRevision: 8,
			authorizationRevision: "authorization_10",
			owners: [applicantId, "owner_02"],
			availability: [{ targetType: "organization", targetId: "org_platform" }],
			counts: {
				configurations: 2,
				history: 1,
				idempotency: 1,
				outbox: 2,
				audit: 2,
			},
		});
		expect(stored.configuration).toMatchObject({
			revision: 8,
			environment: [{ name: "LOG_LEVEL", value: "debug" }],
			secrets: [{ name: "BOT_TOKEN", isSet: true, version: 3 }],
		});
		const effects = await adminClient`
			select 'outbox' as kind, operation as value from platform.outbox_items
			union all
			select 'audit', action from platform.audit_events
			order by kind, value
		`;
		expect(effects).toEqual([
			expect.objectContaining({
				kind: "audit",
				value: "agent.application.resubmitted",
			}),
			expect.objectContaining({
				kind: "audit",
				value: "agent.configuration.revised",
			}),
			expect.objectContaining({
				kind: "outbox",
				value: "agent.application.revised.v1",
			}),
			expect.objectContaining({
				kind: "outbox",
				value: "agent.configuration.revised.v1",
			}),
		]);
	});

	it("commits a name-only revision without inventing a configuration revision", async () => {
		await resetDatabase();
		await seed();
		const state = managementState();
		const adapter = openAdapter();
		await expect(
			useCase(adapter, state, "authorization_9", true).revise(
				nameOnlyCommand(),
				actor(),
			),
		).resolves.toMatchObject({
			managementRevision: 4,
			configurationRevision: 7,
		});
		expect(await snapshot()).toMatchObject({
			application: { name: "Name only", management_revision: "4" },
			currentConfigurationRevision: 7,
			authorizationRevision: "authorization_9",
			counts: {
				configurations: 1,
				history: 1,
				idempotency: 1,
				outbox: 1,
				audit: 1,
			},
		});
	});

	it("serializes exact and competing concurrent revisions", async () => {
		await resetDatabase();
		await seed();
		const { plan, attachments } = await capturePlan();
		const first = openAdapter();
		const second = openAdapter();
		const exact = await Promise.all([
			first.commit(structuredClone(plan), structuredClone(attachments)),
			second.commit(structuredClone(plan), structuredClone(attachments)),
		]);
		expect(exact.map(({ outcome }) => outcome).sort()).toEqual([
			"committed",
			"replayed",
		]);
		expect((await snapshot()).counts).toEqual({
			configurations: 2,
			history: 1,
			idempotency: 1,
			outbox: 2,
			audit: 2,
		});

		await resetDatabase();
		await seed();
		const competing: ApplicationRevisionWritePlanV1 = {
			...structuredClone(plan),
			idempotency: {
				key: "competing-revision",
				requestDigest: "1".repeat(64),
			},
			management: {
				...structuredClone(plan.management),
				idempotency: {
					...structuredClone(plan.management.idempotency),
					key: "competing-revision",
				},
			},
			configuration: plan.configuration
				? {
						...structuredClone(plan.configuration),
						idempotency: {
							...structuredClone(plan.configuration.idempotency),
							key: "competing-revision",
						},
					}
				: null,
		};
		const outcomes = await Promise.all([
			first.commit(structuredClone(plan), structuredClone(attachments)),
			second.commit(competing, structuredClone(attachments)),
		]);
		expect(outcomes.map(({ outcome }) => outcome).sort()).toEqual([
			"committed",
			"conflict",
		]);
		expect((await snapshot()).counts.idempotency).toBe(1);
	});

	it("snapshots hostile plans without invoking accessors and persists nothing", async () => {
		await resetDatabase();
		await seed();
		const { plan, attachments } = await capturePlan();
		const hostile = structuredClone(plan);
		let reads = 0;
		Object.defineProperty(hostile.application, "name", {
			enumerable: true,
			get() {
				reads += 1;
				return "Hostile";
			},
		});
		const adapter = openAdapter();
		await expect(
			adapter.commit(hostile, structuredClone(attachments)),
		).rejects.toMatchObject({
			name: "ApplicationRevisionStoreError",
			code: "unavailable",
		});
		expect(reads).toBe(0);
		const malformed = {
			...structuredClone(plan),
			configuration: plan.configuration
				? {
						...structuredClone(plan.configuration),
						outboxIntent: {
							...structuredClone(plan.configuration.outboxIntent),
							payload: {
								...structuredClone(plan.configuration.outboxIntent.payload),
								plaintext: "database-secret",
							},
						},
					}
				: null,
		} as ApplicationRevisionWritePlanV1;
		await expect(
			adapter.commit(malformed, structuredClone(attachments)),
		).rejects.toMatchObject({
			name: "ApplicationRevisionStoreError",
			code: "unavailable",
		});
		expect((await snapshot()).counts).toEqual({
			configurations: 1,
			history: 0,
			idempotency: 0,
			outbox: 0,
			audit: 0,
		});
	});

	it("rolls back every combined write and the deferred commit boundary", async () => {
		const oldAvailability = [
			{ kind: "user" as const, userId: "user_previous" },
		];
		const { plan, attachments } = await capturePlan(
			"pending_approval",
			true,
			oldAvailability,
		);
		const points = [
			["configuration", "platform.agent_configuration_revisions", "insert", ""],
			["authorization", "platform.agents", "update", ""],
			["application", "platform.agent_applications", "update", ""],
			["owners_delete", "platform.agent_owners", "delete", ""],
			["owners", "platform.agent_owners", "insert", ""],
			["availability_delete", "platform.agent_availability", "delete", ""],
			["availability", "platform.agent_availability", "insert", ""],
			["history", "platform.agent_management_history", "insert", ""],
			["idempotency", "platform.idempotency_records", "insert", ""],
			[
				"configuration_outbox",
				"platform.outbox_items",
				"insert",
				"new.operation = 'agent.configuration.revised.v1'",
			],
			[
				"configuration_audit",
				"platform.audit_events",
				"insert",
				"new.action = 'agent.configuration.revised'",
			],
			[
				"application_outbox",
				"platform.outbox_items",
				"insert",
				"new.operation = 'agent.application.revised.v1'",
			],
			[
				"application_audit",
				"platform.audit_events",
				"insert",
				"new.action = 'agent.application.updated'",
			],
			["commit", "platform.audit_events", "insert", "deferred"],
		] as const;
		for (const [point, table, operation, condition] of points) {
			await resetDatabase();
			await seed("pending_approval", oldAvailability);
			await armFailure(point, table, operation, condition);
			try {
				await expect(
					openAdapter().commit(plan, structuredClone(attachments)),
				).rejects.toEqual(
					expect.objectContaining({
						name: "ApplicationRevisionStoreError",
						code: "unavailable",
					}),
				);
			} finally {
				await disarmFailure(point, table);
			}
			expect(await snapshot()).toMatchObject({
				application: {
					name: "Original Agent",
					status: "pending_approval",
					management_revision: "3",
				},
				currentConfigurationRevision: 7,
				authorizationRevision: "authorization_9",
				owners: [applicantId],
				availability: [{ targetType: "user", targetId: "user_previous" }],
				counts: {
					configurations: 1,
					history: 0,
					idempotency: 0,
					outbox: 0,
					audit: 0,
				},
			});
		}
	});

	it("contains PostgreSQL and credential details in one stable Store error", async () => {
		const adapter = new PostgresApplicationRevisionTransactionV1({
			databaseUrl:
				"postgres://platform_user:database-secret@127.0.0.1:1/platform",
		});
		let failure: unknown;
		try {
			await adapter.read({
				schemaVersion: 1,
				applicationId,
				actorId: applicantId,
				idempotencyKey: "unavailable-read",
				requestDigest: "0".repeat(64),
			});
		} catch (error) {
			failure = error;
		}
		expect(failure).toEqual(new ApplicationRevisionStoreError());
		expect(String(failure)).not.toMatch(
			/database-secret|127\.0\.0\.1|select|sql/i,
		);
		await adapter.close().catch(() => {});
	});
});

async function armFailure(
	point: string,
	table: string,
	operation: "delete" | "insert" | "update",
	condition: string,
): Promise<void> {
	const functionName = `platform.application_revision_fail_${point}`;
	const triggerName = `application_revision_fail_${point}`;
	await adminClient.unsafe(`
		create function ${functionName}() returns trigger language plpgsql as $$
		begin
			raise exception 'injected application revision failure';
		end
		$$
	`);
	if (condition === "deferred") {
		await adminClient.unsafe(`
			create constraint trigger ${triggerName} after ${operation} on ${table}
			deferrable initially deferred for each row
			execute function ${functionName}()
		`);
		return;
	}
	await adminClient.unsafe(`
		create trigger ${triggerName} before ${operation} on ${table}
		for each row ${condition ? `when (${condition})` : ""}
		execute function ${functionName}()
	`);
}

async function disarmFailure(point: string, table: string): Promise<void> {
	await adminClient.unsafe(
		`drop trigger if exists application_revision_fail_${point} on ${table}`,
	);
	await adminClient.unsafe(
		`drop function if exists platform.application_revision_fail_${point}()`,
	);
}
