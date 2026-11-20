import { createHash } from "node:crypto";
import { NativeCapabilityInvocationResponseV1Schema } from "@agent-infra/contracts/pilot";
import type {
	createLdapIdentityDirectory,
	LdapAccount,
} from "@agent-infra/identity";
import type { OperationalEvent } from "@agent-infra/observability";
import { currentRequestMetadata } from "@agent-infra/observability/http";
import {
	migratePlatformDatabase,
	PostgresLdapSessionStoreV1,
} from "@agent-infra/platform-store";
import type postgres from "postgres";
import {
	afterAll,
	beforeAll,
	beforeEach,
	expect,
	it,
	onTestFinished,
	vi,
} from "vitest";
import { agentConfigurationConformanceRecordV1 } from "../../../packages/platform-core/src/agent-configuration.conformance.js";
import {
	openPostgresTestClient,
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { seedSessionSandboxFixture } from "../../../packages/platform-store/src/session-sandbox.fixture.js";
import { createPlatformApp } from "./app.js";
import { assemblePlatformApi, type PlatformApiAssembly } from "./assembly.js";
import type { IdentityAdapter, IdentityContext } from "./http/identity.js";
import { createLdapBrowserAdapter } from "./ldap-browser.js";

const conversationId = "v3-conversation";
const agentId = "v3-agent";
const originalExecutionId = "v3-original-execution";
const agentAuthorizationRevision = "agent-auth-1";
const identity: IdentityContext = {
	schemaVersion: 1,
	userId: "v3-owner",
	displayName: "Synthetic V3 owner",
	accountStatus: "active",
	organizationIds: [],
	roles: ["employee"],
	authorizationRevision: "browser-1",
};
const { modelConfiguration } = agentConfigurationConformanceRecordV1;
if (!modelConfiguration) throw new Error("Missing model fixture");
const configuration = {
	...agentConfigurationConformanceRecordV1,
	schemaVersion: 3,
	agentId,
	revision: 1,
	modelConfiguration: {
		...modelConfiguration,
		defaultOptionId: "model-primary",
		defaultReasoningLevel: "high",
		options: modelConfiguration.options.map(
			({ credential: _credential, ...option }) => ({
				...option,
				optionId: "model-primary",
				reasoningLevels: ["high"],
			}),
		),
	},
};
const command = {
	schemaVersion: 2,
	id: "c".repeat(64),
	kind: "command",
	name: "compact",
	description: "Compact the native session",
	source: { name: "codex", version: "0.153.0" },
	parameters: [],
	effect: "state_changing",
	availability: "available",
} as const;
const directoryRevision = "d".repeat(64);
const invocation = {
	schemaVersion: 3,
	capabilityId: command.id,
	directoryRevision,
	parameters: "",
	selection: {
		schemaVersion: 1,
		modelOptionId: "model-primary",
		reasoningLevel: "high",
	},
	idempotencyKey: "v3-key",
	requestId: "v3-request",
	traceId: "v3-trace",
};

let database: PostgresTestDatabase | undefined;
let db: postgres.Sql;
let assembly: PlatformApiAssembly;
let app: ReturnType<typeof createPlatformApp>;
let afterDirectoryRead: () => Promise<void>;
let browserSessionActive: boolean;
let browserResolutions: number;
let beforeBrowserResolve: (call: number) => Promise<void>;
let ldapIdentity: IdentityAdapter | undefined;
let browserCookie: string | undefined;
let taskIdentityTimeout: boolean;
let directoryReads: number;
let liveDirectoryRevision: string;
let legacySkill = false;
let requestMetadata: ReturnType<typeof currentRequestMetadata>;
const events: OperationalEvent[] = [];
const unused = async (): Promise<never> => {
	throw new Error("Unexpected fixture adapter call");
};

beforeAll(async () => {
	database = await startPostgresTestDatabase("native-capability-v3-api");
	await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
	db = openPostgresTestClient(database);
	assembly = assemblePlatformApi({
		databaseUrl: database.databaseUrl,
		taskAdmissionPolicy: {
			maximumWaitingTasksPerAgent: 2,
			waitingTimeoutMs: 60_000,
		},
		identity: {
			resolve: async (request) => {
				requestMetadata = currentRequestMetadata();
				await beforeBrowserResolve(++browserResolutions);
				if (ldapIdentity) return ldapIdentity.resolve(request);
				return browserSessionActive ? identity : null;
			},
			resolveUser: async (userId) => {
				if (ldapIdentity?.resolveUser) return ldapIdentity.resolveUser(userId);
				if (taskIdentityTimeout)
					throw new DOMException("private identity evidence", "TimeoutError");
				return {
					schemaVersion: 1,
					userId,
					accountStatus: "active",
					organizationIds: [],
					authorizationRevision: "directory-auth-1",
				};
			},
			hydrateUsers: async () => [],
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
		// Only the external Runtime directory is controlled. HTTP, admission and Store use default assembly.
		nativeMetadata: {
			reader: {
				read: async (
					_identity,
					conversation,
					execution,
					selector,
					_context,
					version,
				) => {
					if (legacySkill) {
						directoryReads++;
						await afterDirectoryRead();
						if (selector === "skills")
							return {
								selector: "skills",
								revision: liveDirectoryRevision,
								capabilities: [
									{
										id: command.id,
										kind: "skill",
										name: "review",
										description: "Synthetic",
										source: { name: "skillhub", version: "1" },
										availability: "discovered",
									},
								],
							};
						if (selector === "commands")
							return {
								selector: "commands",
								revision: liveDirectoryRevision,
								capabilities: [],
							};
						return null;
					}
					if (
						conversation !== conversationId ||
						execution !== originalExecutionId ||
						selector !== "commands" ||
						version !== 2
					)
						return null;
					directoryReads++;
					await afterDirectoryRead();
					return {
						schemaVersion: 1,
						projectionVersion: 2,
						selector: "commands",
						revision: liveDirectoryRevision,
						capabilities: [{ ...command, parameters: [] }],
					};
				},
			},
		},
	});
	app = createPlatformApp(assembly.dependencies, {
		record: (event) => events.push(event),
		status: () => ({
			enabled: true,
			state: "active",
			captureFailures: 0,
			exportFailures: 0,
			lastExportFailureAt: undefined,
			droppedLogs: 0,
			invalidRecords: 0,
		}),
	});
}, 120_000);

afterAll(async () => {
	await assembly?.close();
	await db?.end();
	await database?.stop();
});

beforeEach(async () => {
	legacySkill = false;
	afterDirectoryRead = async () => {};
	browserSessionActive = true;
	browserResolutions = 0;
	beforeBrowserResolve = async () => {};
	ldapIdentity = undefined;
	browserCookie = undefined;
	taskIdentityTimeout = false;
	liveDirectoryRevision = directoryRevision;
	directoryReads = 0;
	events.length = 0;
	requestMetadata = undefined;
	await db`truncate platform.agents, platform.conversations, platform.conversation_executions,
		platform.relay_key_subjects, platform.idempotency_records, platform.outbox_items,
		platform.conversation_audit_events, platform.audit_events cascade`;
	await db`insert into platform.agents(id,current_configuration_revision,authorization_revision)
		values (${agentId},1,${agentAuthorizationRevision})`;
	await db`insert into platform.agent_applications(id,agent_id,applicant_id,name,description,status,
		trace_id,request_id,submitted_at,management_revision,approval_revision,
		service_availability,desired_state,workload_revision,fence)
		values ('v3-application',${agentId},${identity.userId},'Fixture','Synthetic','available',
		'fixture-trace','fixture-request',now(),1,1,'ready','running',1,1)`;
	await db`insert into platform.agent_owners(agent_id,owner_id,created_at)
		values (${agentId},${identity.userId},now())`;
	await db`insert into platform.agent_configuration_revisions(agent_id,revision,source_reference,created_at,configuration)
		values (${agentId},1,'fixture',now(),${db.json(configuration as unknown as postgres.JSONValue)})`;
	await db`insert into platform.conversations(id,agent_id,actor_id,principal_type,channel_id,
		status,session_generation,host_session_ref,authorization_revision)
		values (${conversationId},${agentId},${identity.userId},'user','web','ready',1,'v3-host',${agentAuthorizationRevision})`;
	await db`insert into platform.relay_key_subjects(purpose,subject_id,last_version,current_version)
		values ('personal',${identity.userId},1,1)`;
	await db`insert into platform.relay_key_versions(purpose,subject_id,key_version,key_id,ciphertext)
		values ('personal',${identity.userId},1,'v3-key-ref',${db.json({ purpose: "personal", subjectId: identity.userId, keyId: "v3-key-ref", keyVersion: 1 })})`;
	await db`insert into platform.conversation_executions(execution_id,conversation_id,agent_id,
		actor_id,principal_type,channel_id,turn_id,status,session_generation,authorization_revision,
		runtime_submit_protocol,original_operation_digest,original_submit_host_session_ref,created_at,updated_at,
		execution_source,relay_key_purpose,relay_key_subject_id,relay_key_id,relay_key_version)
		values (${originalExecutionId},${conversationId},${agentId},${identity.userId},'user','web',
		'v3-original-turn','completed',1,${agentAuthorizationRevision},'v4',${"a".repeat(43)},'v3-host',now(),now(),'web','personal',${identity.userId},'v3-key-ref',1)`;
	await seedSessionSandboxFixture(db, conversationId);
});

async function invoke(body = invocation) {
	browserResolutions = 0;
	const response = await app.request(
		`https://native.invalid/api/v2/conversations/${conversationId}/native-capability/invoke`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(browserCookie
					? { cookie: browserCookie, origin: "https://native.invalid" }
					: {}),
			},
			body: JSON.stringify(body),
		},
	);
	return {
		status: response.status,
		body: NativeCapabilityInvocationResponseV1Schema.parse(
			await response.json(),
		),
	};
}

it("admits an owner's V3 command and replays only the saved Execution", async () => {
	const first = await invoke();
	expect(first).toMatchObject({
		status: 202,
		body: {
			outcome: "accepted",
			result: { conversationId, executionId: expect.any(String) },
		},
	});
	const replay = await invoke();
	expect(replay).toEqual({
		...first,
		body: { ...first.body, outcome: "replayed" },
	});
	expect(await durableCounts()).toEqual({
		executions: 1,
		outbox: 1,
		idempotency: 1,
	});
});

async function durableCounts() {
	const [counts] = await db`select
		(select count(*)::int from platform.conversation_executions where conversation_id=${conversationId} and execution_id<>${originalExecutionId}) as executions,
		(select count(*)::int from platform.outbox_items where operation='conversation.native-capability.invoke.v2') as outbox,
		(select count(*)::int from platform.idempotency_records where command_type='native-capability.invoke.v2') as idempotency`;
	return counts;
}

it("denies a grant revoked after directory discovery without reserving the operation", async () => {
	afterDirectoryRead = async () => {
		await db.begin(async (transaction) => {
			await transaction`update platform.agents set authorization_revision='agent-auth-revoked' where id=${agentId}`;
			await transaction`delete from platform.agent_owners where agent_id=${agentId}`;
		});
	};
	expect(await invoke()).toMatchObject({
		status: 403,
		body: { outcome: "denied" },
	});
	expect(await durableCounts()).toEqual({
		executions: 0,
		outbox: 0,
		idempotency: 0,
	});
});

it.each([
	["submitted", 409, "busy"],
	["waiting", 409, "busy"],
	["unknown", 503, "unknown"],
] as const)(
	"does not add an Execution or outbox item while the conversation has a %s operation",
	async (status, httpStatus, outcome) => {
		const first = await invoke();
		if (first.body.outcome !== "accepted")
			throw new Error("Missing fixture admission");
		await db`update platform.conversation_executions set status=${status},
			task_wait_order=${status === "waiting" ? 1 : null},
			task_wait_deadline=${status === "waiting" ? new Date(Date.now() + 60_000) : null}
			where execution_id=${first.body.result.executionId}`;
		expect(
			await invoke({ ...invocation, idempotencyKey: "another-key" }),
		).toEqual({
			status: httpStatus,
			body: { outcome },
		});
		if (status === "unknown") {
			expect(await invoke()).toEqual({
				...first,
				body: { ...first.body, outcome: "replayed" },
			});
		}
		expect(await durableCounts()).toEqual({
			executions: 1,
			outbox: 1,
			idempotency: 1,
		});
	},
);

it("reports a real PostgreSQL lock timeout as unavailable without exposing the error", async () => {
	const locked = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let blocker: Promise<unknown> | undefined;
	afterDirectoryRead = () => {
		blocker = db.begin(async (transaction) => {
			await transaction`select id from platform.conversations where id=${conversationId} for update`;
			locked.resolve();
			await release.promise;
		});
		return Promise.race([locked.promise, blocker.then(() => {})]);
	};
	try {
		expect(await invoke()).toEqual({
			status: 503,
			body: { outcome: "unavailable" },
		});
	} finally {
		release.resolve();
		await blocker;
	}
	expect(blocker).toBeDefined();
	expect(events).toContainEqual(
		expect.objectContaining({
			...requestMetadata,
			stage: "http",
			status: 503,
			failureStep: "store.query",
			sqlState: "55P03",
		}),
	);
	expect(await durableCounts()).toEqual({
		executions: 0,
		outbox: 0,
		idempotency: 0,
	});
}, 15_000);

it("rechecks only the original browser session before writing", async () => {
	afterDirectoryRead = async () => {
		browserSessionActive = false;
	};
	expect(await invoke()).toEqual({
		status: 503,
		body: { outcome: "unavailable" },
	});
	expect(await durableCounts()).toEqual({
		executions: 0,
		outbox: 0,
		idempotency: 0,
	});
});

async function moveRuntimeConfiguration() {
	await db.begin(async (transaction) => {
		await transaction`insert into platform.agent_configuration_revisions
			(agent_id,revision,source_reference,created_at,configuration)
			values (${agentId},2,'fixture',now(),${db.json({ ...configuration, revision: 2 } as unknown as postgres.JSONValue)})`;
		await transaction`update platform.agents set current_configuration_revision=2 where id=${agentId}`;
	});
}

it("rejects a Runtime revision change while discovering the command even when the selection still exists", async () => {
	afterDirectoryRead = moveRuntimeConfiguration;
	expect(await invoke()).toEqual({ status: 409, body: { outcome: "stale" } });
	expect(await durableCounts()).toEqual({
		executions: 0,
		outbox: 0,
		idempotency: 0,
	});
});

it.each(["directory", "key", "config"] as const)(
	"reads the saved operation before checking the current %s and preserves same-key conflicts",
	async (drift) => {
		const first = await invoke();
		expect(first.body.outcome).toBe("accepted");
		if (drift === "directory") liveDirectoryRevision = "e".repeat(64);
		if (drift === "key") {
			await db`update platform.relay_key_subjects set current_version=null where purpose='personal' and subject_id=${identity.userId}`;
		}
		if (drift === "config") await moveRuntimeConfiguration();
		const before = directoryReads;
		expect(await invoke()).toEqual({
			...first,
			body: { ...first.body, outcome: "replayed" },
		});
		expect(
			await invoke({
				...invocation,
				selection: { ...invocation.selection, reasoningLevel: "low" },
			}),
		).toEqual({
			status: 409,
			body: { outcome: "conflict", reason: "idempotency_conflict" },
		});
		expect(directoryReads).toBe(before);
		expect(await durableCounts()).toEqual({
			executions: 1,
			outbox: 1,
			idempotency: 1,
		});
	},
);

it("records an identity timeout against the original request with a safe public reply", async () => {
	afterDirectoryRead = async () => {
		taskIdentityTimeout = true;
	};
	expect(await invoke()).toEqual({
		status: 503,
		body: { outcome: "unavailable" },
	});
	expect(events).toContainEqual(
		expect.objectContaining({
			...requestMetadata,
			stage: "http",
			status: 503,
			failureStep: "identity.timeout",
		}),
	);
	expect(JSON.stringify(events)).not.toContain("private identity evidence");
	expect(await durableCounts()).toEqual({
		executions: 0,
		outbox: 0,
		idempotency: 0,
	});
});

it.each(["revoked", "expired"] as const)(
	"rejects a session %s during the last LDAP read when no renewal is possible",
	async (mode) => {
		if (!database) throw new Error("Missing PostgreSQL fixture");
		const sessions = new PostgresLdapSessionStoreV1(database.databaseUrl);
		onTestFinished(() => sessions.close());
		const token = "q".repeat(43);
		const digest = createHash("sha256").update(token).digest("hex");
		let now = Date.now();
		const absoluteExpiresAt = now + 60_000;
		await sessions.create(
			digest,
			"v3-ldap-uid",
			absoluteExpiresAt,
			absoluteExpiresAt,
		);
		const account: LdapAccount = {
			uid: "v3-ldap-uid",
			userId: identity.userId,
			email: "v3-owner@example.test",
			displayName: identity.displayName,
			accountStatus: "active",
			roles: ["employee"],
			authorizationRevision: "ldap-1",
		};
		let browserDirectoryChecks = 0;
		let armed = false;
		const directory = {
			userIdForUid: async () => identity.userId,
			current: async () => {
				if (armed && ++browserDirectoryChecks === 5) {
					if (mode === "revoked") await sessions.revoke(digest);
					else now = absoluteExpiresAt + 1;
				}
				return account;
			},
			currentByUserId: async () => account,
		} as unknown as ReturnType<typeof createLdapIdentityDirectory>;
		const adapter = createLdapBrowserAdapter({
			publicOrigin: "https://native.invalid",
			sessions,
			directory,
			isPlatformDisabled: async () => false,
			organizationIds: async () => [],
			now: () => now,
		});
		ldapIdentity = adapter.identityAdapter;
		browserCookie = `__Host-platform-session=${token}`;
		const renew = vi.spyOn(sessions, "renew");
		afterDirectoryRead = async () => {
			armed = true;
		};
		expect(await invoke()).toEqual({
			status: 503,
			body: { outcome: "unavailable" },
		});
		expect(browserDirectoryChecks).toBe(5);
		expect(renew).not.toHaveBeenCalled();
		expect(await durableCounts()).toEqual({
			executions: 0,
			outbox: 0,
			idempotency: 0,
		});
	},
);

it.each(["agent", "conversation", "generation", "host"] as const)(
	"revalidates the original %s scope before delivering an accepted replay",
	async (target) => {
		expect((await invoke()).body.outcome).toBe("accepted");
		// Change authority after Store replay commits, while the route revalidates delivery.
		beforeBrowserResolve = async (call) => {
			if (call !== 3) return;
			if (target === "agent") {
				await db`update platform.agents set authorization_revision='changed' where id=${agentId}`;
				await db`delete from platform.agent_owners where agent_id=${agentId}`;
			} else if (target === "conversation") {
				await db`update platform.conversations set authorization_revision='changed' where id=${conversationId}`;
			} else if (target === "generation") {
				await db`update platform.conversations set session_generation=session_generation+1 where id=${conversationId}`;
			} else {
				await db`update platform.conversations set host_session_ref='replacement-host' where id=${conversationId}`;
			}
		};
		const reads = directoryReads;
		expect(await invoke()).toEqual({
			status: 503,
			body: { outcome: "unavailable" },
		});
		expect(directoryReads).toBe(reads);
		expect(await durableCounts()).toEqual({
			executions: 1,
			outbox: 1,
			idempotency: 1,
		});
	},
);

it("observes the normal V1 assembly, both metadata reads and durable idempotent delivery", async () => {
	legacySkill = true;
	const payload = {
		capabilityId: command.id,
		directoryRevision,
		parameters: "PRIVATE_PARAMETER_CANARY",
		idempotencyKey: "v1-stage-key",
		requestId: "v1-request",
		traceId: "v1-trace",
	};
	const send = () =>
		app.request(
			new Request(
				`https://native.invalid/api/v2/conversations/${conversationId}/native-capability/invoke`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
				},
			),
		);
	const response = await send();
	expect(response.status).toBe(202);
	const admitted = NativeCapabilityInvocationResponseV1Schema.parse(
		await response.json(),
	);
	if (admitted.outcome !== "accepted") throw new Error("Expected admission");
	const observations = events
		.filter((e) => e.nativeAdmission)
		.map((e) => ({
			...e,
			nativeAdmission: e.nativeAdmission as {
				stage: string;
				phase: string;
				protocolVersion: number | "UNKNOWN";
			},
		}));
	const stages = observations.map((e) => e.nativeAdmission.stage);
	expect(stages).toEqual(
		expect.arrayContaining([
			"identity.initial",
			"authorization.initial",
			"store.transaction",
			"store.lock",
			"store.query",
			"metadata.first",
			"metadata.second",
			"metadata.scope",
			"metadata.commands",
			"metadata.skills",
			"precommit",
			"delivery",
		]),
	);
	const traces = new Set(observations.map((e) => e.traceId));
	expect(traces.size).toBe(1);
	expect([...traces][0]).toBeTruthy();
	expect(
		observations
			.filter((e) => e.nativeAdmission.stage === "metadata.second")
			.every((e) => e.nativeAdmission.protocolVersion === 1),
	).toBe(true);
	expect(JSON.stringify(observations)).not.toContain(
		"PRIVATE_PARAMETER_CANARY",
	);
	expect(directoryReads).toBe(4);
	const replay = await send();
	expect(replay.status).toBe(202);
	expect(await replay.json()).toMatchObject({
		outcome: "replayed",
		result: admitted.result,
	});
	const [count] =
		await db`select count(*)::int as n from platform.conversation_executions where conversation_id=${conversationId} and execution_id<>${originalExecutionId}`;
	expect(count?.n).toBe(1);
});

it("keeps the earliest real V1 Store lock SQLSTATE through the safe HTTP reply", async () => {
	legacySkill = true;
	const held = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const blocker = db.begin(async (tx) => {
		await tx`select id from platform.conversations where id=${conversationId} for update`;
		held.resolve();
		await release.promise;
	});
	await held.promise;
	try {
		const response = await app.request(
			new Request(
				`https://native.invalid/api/v2/conversations/${conversationId}/native-capability/invoke`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						capabilityId: command.id,
						directoryRevision,
						parameters: "PRIVATE_PARAMETER_CANARY",
						idempotencyKey: "v1-lock",
						requestId: "v1-lock-request",
						traceId: "v1-lock-trace",
					}),
				},
			),
		);
		expect(response.status).toBe(503);
		expect(events).toContainEqual(
			expect.objectContaining({
				stage: "http",
				nativeAdmission: expect.objectContaining({
					stage: "store.lock",
					reason: "store",
					sqlState: "55P03",
				}),
			}),
		);
		expect(JSON.stringify(events)).not.toContain("PRIVATE_PARAMETER_CANARY");
	} finally {
		release.resolve();
		await blocker;
	}
}, 15_000);
