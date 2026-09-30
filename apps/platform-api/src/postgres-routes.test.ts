import { once } from "node:events";

import {
	AgentApplicationProjectionV2Schema,
	AgentProjectionV2Schema,
	BrowserSessionProjectionV1Schema,
	ConversationDetailProjectionV1Schema,
	ConversationProjectionV1Schema,
	PilotProtocolErrorV1Schema,
	PlatformAuditProjectionV1Schema,
	PlatformAuditProjectionV2Schema,
} from "@agent-infra/contracts/pilot";
import {
	createAgentConfigurationUseCaseV1,
	createAgentManagementV1,
	createApplicationFoundationUseCaseV1,
	createApplicationRevisionUseCaseV1,
	createConversationExecutionUseCaseV1,
} from "@agent-infra/platform-core";
import { FakeAgentConfigurationAdmissionsV1 } from "@agent-infra/platform-core/testing";
import {
	migratePlatformDatabase,
	PostgresAgentConfigurationQueryV1,
	PostgresAgentConfigurationTransactionV1,
	PostgresAgentManagementQueryV1,
	PostgresAgentManagementTransactionV1,
	PostgresApplicationFoundationTransactionV1,
	PostgresApplicationRevisionTransactionV1,
	PostgresConversationExecutionTransactionV1,
	PostgresConversationQueryV1,
	PostgresPlatformAuditQueryV1,
} from "@agent-infra/platform-store";
import { serve } from "@hono/node-server";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { createPlatformApp } from "./app.js";
import type { IdentityAdapter, IdentityContext } from "./http/identity.js";
import { createPlatformProjectionReaders } from "./projection.js";

const source = {
	kind: "custom" as const,
	imageDigest: `sha256:${"a".repeat(64)}`,
	admissionRevision: "image-admission-1",
	interactionMode: "platform-adapter" as const,
	connectionEnabled: false,
};
const identities = {
	owner: {
		schemaVersion: 1,
		userId: "user-owner",
		displayName: "Owner",
		accountStatus: "active",
		organizationIds: ["org-1"],
		roles: ["employee"],
		authorizationRevision: "authorization-1",
	},
	admin: {
		schemaVersion: 1,
		userId: "user-admin",
		displayName: "Administrator",
		accountStatus: "active",
		organizationIds: ["org-admin"],
		roles: ["employee", "system_admin"],
		authorizationRevision: "authorization-1",
	},
	attacker: {
		schemaVersion: 1,
		userId: "user-attacker",
		displayName: "Attacker",
		accountStatus: "active",
		organizationIds: ["org-other"],
		roles: ["employee"],
		authorizationRevision: "authorization-1",
	},
} as const satisfies Record<string, IdentityContext>;

const applicationBody = {
	schemaVersion: 2 as const,
	name: "Release assistant",
	description: "Helps the release team",
	source: {
		kind: "custom" as const,
		imageReference: "registry.example/agent:v1",
		interactionMode: "platform-adapter" as const,
	},
	coOwnerIds: [],
	availability: [{ kind: "organization" as const, organizationId: "org-1" }],
	environment: [],
	secrets: [],
};

type Closable = { close(): Promise<void> };
let testDatabase: PostgresTestDatabase | undefined;
const adapters: Closable[] = [];
let app: ReturnType<typeof createPlatformApp>;
let managementUseCase: ReturnType<typeof createAgentManagementV1>;
let managementQuery: PostgresAgentManagementQueryV1;
let currentBrowserAdmin: IdentityContext = identities.admin;
let identityDependencyFails = false;

const administratorReadFixtures = [
	{ status: "creating", owner: "owner" },
	{ status: "available", owner: "attacker" },
	{ status: "stopped", owner: "owner" },
	{ status: "creation_failed", owner: "attacker" },
	{ status: "disabled", owner: "owner" },
	{ status: "pending_approval", owner: "owner" },
	{ status: "rejected", owner: "attacker" },
] as const;
const administratorReadResources = administratorReadFixtures.map(
	(fixture, index) => ({
		...fixture,
		agentId: `zz-admin-read-${index}`,
		applicationId: `application-admin-read-${index}`,
		idempotencyKey: `admin-read-${index}`,
	}),
);

function requestHeaders(
	identity: keyof typeof identities,
	idempotencyKey?: string,
) {
	return {
		"x-test-identity": identity,
		...(idempotencyKey === undefined
			? {}
			: { "Idempotency-Key": idempotencyKey }),
	};
}

beforeAll(async () => {
	testDatabase = await startPostgresTestDatabase("platform-http-routes");
	await migratePlatformDatabase({ databaseUrl: testDatabase.databaseUrl });
	const databaseUrl = testDatabase.databaseUrl;
	const foundationTransaction = new PostgresApplicationFoundationTransactionV1({
		databaseUrl,
	});
	const revisionTransaction = new PostgresApplicationRevisionTransactionV1({
		databaseUrl,
	});
	const managementTransaction = new PostgresAgentManagementTransactionV1({
		databaseUrl,
	});
	managementQuery = new PostgresAgentManagementQueryV1({ databaseUrl });
	const configurationTransaction = new PostgresAgentConfigurationTransactionV1({
		databaseUrl,
	});
	const configurationQuery = new PostgresAgentConfigurationQueryV1({
		databaseUrl,
	});
	const auditQuery = new PostgresPlatformAuditQueryV1({ databaseUrl });
	const conversationTransaction =
		new PostgresConversationExecutionTransactionV1({
			databaseUrl,
		});
	const conversationQuery = new PostgresConversationQueryV1({ databaseUrl });
	adapters.push(
		foundationTransaction,
		revisionTransaction,
		managementTransaction,
		managementQuery,
		configurationTransaction,
		configurationQuery,
		conversationTransaction,
		conversationQuery,
		auditQuery,
	);

	const foundationAdmissions = new FakeAgentConfigurationAdmissionsV1({
		authorizations: [
			...["agent-run", "agent-withdraw", "agent-v2"].map((agentId) => ({
				agentId,
				owner: "owner" as const,
			})),
			...administratorReadResources,
		].map(({ agentId, owner }) => ({
			agentId,
			actorId: identities[owner].userId,
			authorizationRevision: "authorization-1",
			authorityContext: {
				schemaVersion: 1 as const,
				users: [
					{
						userId: identities[owner].userId,
						accountStatus: "active" as const,
					},
				],
				organizationIds: ["org-1", "org-other"],
			},
		})),
		images: [{ selection: applicationBody.source, source }],
		models: [],
		modelCredentials: [],
		channelBindings: [],
		channelRevision: "channels-1",
	});
	const configurationAdmissions = new FakeAgentConfigurationAdmissionsV1({
		authorizations: [],
		images: [{ selection: applicationBody.source, source }],
		models: [],
		modelCredentials: [],
		channelBindings: [],
		channelRevision: "channels-1",
	});
	const authorizationAdmission = {
		async authorize(input: {
			schemaVersion: 1;
			agentId: string;
			actorId: string;
			requestId: string;
			traceId: string;
		}) {
			const state = await managementTransaction.resolveAgentAccessState(
				input.agentId,
			);
			const actor: IdentityContext | undefined = (
				Object.values(identities) as IdentityContext[]
			).find((identity) => identity.userId === input.actorId);
			if (
				!state ||
				!actor ||
				(!state.ownerIds.includes(actor.userId) &&
					!actor.roles.includes("system_admin"))
			) {
				return {
					schemaVersion: 1 as const,
					status: "rejected" as const,
					agentId: input.agentId,
					actorId: input.actorId,
				};
			}
			return {
				schemaVersion: 1 as const,
				status: "admitted" as const,
				agentId: input.agentId,
				actorId: input.actorId,
				authorizationRevision: "authorization-1",
				accessAuthority: {
					state,
					actorContext: {
						schemaVersion: 1 as const,
						userId: actor.userId,
						accountStatus: "active" as const,
						organizationIds: actor.organizationIds,
						isAdministrator: actor.roles.includes("system_admin"),
					},
					authorityContext: {
						schemaVersion: 1 as const,
						users: state.ownerIds.map((userId) => ({
							userId,
							accountStatus: "active" as const,
						})),
						organizationIds: ["org-1"],
					},
				},
			};
		},
	};
	const sharedAdmissions = {
		authorizationAdmission,
		imageAdmission: configurationAdmissions,
		modelAdmission: configurationAdmissions,
		secretAdmission: configurationAdmissions,
		channelAdmission: configurationAdmissions,
	};
	const foundation = createApplicationFoundationUseCaseV1({
		transaction: foundationTransaction,
		authorizationAdmission: foundationAdmissions,
		imageAdmission: foundationAdmissions,
		modelAdmission: foundationAdmissions,
		secretAdmission: foundationAdmissions,
		channelAdmission: foundationAdmissions,
	});
	const revision = createApplicationRevisionUseCaseV1({
		transaction: revisionTransaction,
		...sharedAdmissions,
	});
	managementUseCase = createAgentManagementV1(managementTransaction);
	const configurationUseCase = createAgentConfigurationUseCaseV1({
		transaction: configurationTransaction,
		...sharedAdmissions,
	});

	const identityAdapter: IdentityAdapter = {
		async resolve(request) {
			if (identityDependencyFails)
				throw new Error("private-identity-dependency-detail");
			// Controlled browser identities; this test does not claim real directory/session acceptance.
			const cookie = request.headers.get("Cookie");
			if (cookie === "test-browser-session=admin") return currentBrowserAdmin;
			if (cookie === "test-browser-session=disabled")
				return { ...identities.admin, accountStatus: "disabled" };
			if (cookie === "test-browser-session=owner") return identities.owner;
			if (cookie === "test-browser-session=other-owner")
				return identities.attacker;
			const key = request.headers.get("x-test-identity") as
				| keyof typeof identities
				| null;
			return key ? (identities[key] ?? null) : null;
		},
		async hydrateUsers(userIds) {
			return userIds.map((userId) => {
				const identity = Object.values(identities).find(
					(candidate) => candidate.userId === userId,
				);
				if (!identity) throw new Error("unknown test identity");
				return {
					userId,
					displayName: identity.displayName,
					roles: identity.roles,
				};
			});
		},
	};
	const projectionReaders = createPlatformProjectionReaders({
		identity: identityAdapter,
		managementQuery,
		configurationQuery,
		presentAgent: async ({ configuration }) => {
			if (configuration.source.kind !== "custom") {
				throw new Error("unexpected test source");
			}
			return {
				source: {
					kind: "custom",
					imageReference: applicationBody.source.imageReference,
					interactionMode: "platform-adapter",
				},
				resourceProfile: {
					profileId: "standard-medium",
					displayName: "Standard medium",
					estimatedResources: {
						cpuMillicores: 2000,
						memoryMiB: 4096,
						storageGiB: 20,
					},
				},
				modelOptions: configuration.modelOptions.map((option) => ({
					...option,
					reasoningLevels: [...option.reasoningLevels],
					displayName: option.modelId,
				})),
				channels: [
					{ kind: "web", status: "available" },
					...configuration.channelKinds.map((kind) => ({
						kind,
						status: "bound" as const,
					})),
				],
				capabilities: {
					modelSelection: false,
					attachments: false,
					resultFiles: false,
					connection: false,
					supplementaryInstruction: false,
				},
				interactionUrl: null,
			};
		},
	});
	const conversationAuthorization = {
		async authorize(
			identity: IdentityContext,
			request: {
				readonly agentId?: string;
				readonly conversationId?: string;
			},
		) {
			let agentId = request.agentId;
			if (request.conversationId) {
				agentId = (
					await conversationQuery.getAuthorizationTarget(
						{ actorId: identity.userId, channelId: "web" },
						request.conversationId,
					)
				)?.agentId;
			}
			if (!agentId) return { outcome: "denied" as const };
			const agent = await managementQuery.getAgent(
				{
					kind: "user",
					userId: identity.userId,
					organizationIds: identity.organizationIds,
				},
				agentId,
			);
			return agent
				? {
						outcome: "allowed" as const,
						authority: {
							schemaVersion: 1 as const,
							actorId: identity.userId,
							agentId,
							channelId: "web",
							authorizationRevision: identity.authorizationRevision,
							supportsSupplementaryInstruction: false,
						},
					}
				: { outcome: "denied" as const };
		},
	};

	app = createPlatformApp({
		management: {
			identity: identityAdapter,
			foundation,
			revision,
			management: managementUseCase,
			configuration: configurationUseCase,
			query: managementQuery,
			allocateApplicationIds: async ({ idempotencyKey }) => {
				const resource = administratorReadResources.find(
					(entry) => entry.idempotencyKey === idempotencyKey,
				);
				if (resource)
					return {
						applicationId: resource.applicationId,
						agentId: resource.agentId,
					};
				return idempotencyKey === "create-withdraw"
					? { applicationId: "application-withdraw", agentId: "agent-withdraw" }
					: idempotencyKey === "create-v2"
						? { applicationId: "application-v2", agentId: "agent-v2" }
						: { applicationId: "application-run", agentId: "agent-run" };
			},
			prepareSecretReplacements: async () => ({ secrets: [] }),
			readApplicationProjection: projectionReaders.readApplicationProjection,
			readAgentProjection: projectionReaders.readManagementAgentProjection,
		},
		configuration: {
			identity: identityAdapter,
			configuration: configurationUseCase,
			configurationQuery,
			readAgentProjection: projectionReaders.readConfigurationAgentProjection,
			prepareSecretReplacements: async () => ({
				secrets: [],
				modelCredentialOptionIds: [],
			}),
		},
		conversation: {
			identity: identityAdapter,
			authorization: conversationAuthorization,
			commands: (identity) =>
				createConversationExecutionUseCaseV1({
					transaction: conversationTransaction,
					authorization: {
						authorize: (request) =>
							conversationAuthorization.authorize(identity, request),
					},
				}),
			query: conversationQuery,
		},
		sessionAudit: { identity: identityAdapter, audit: auditQuery },
	});
}, 120_000);

afterAll(async () => {
	for (const adapter of adapters.reverse()) await adapter.close();
	await testDatabase?.stop();
});

describe("PostgreSQL Platform HTTP integration", () => {
	it("serves the management journey and blocks cross-user attacks", async () => {
		const ownerHeaders = {
			...requestHeaders("owner", "create-run"),
			"content-type": "application/json",
		};
		const retired = await app.request("/api/v1/agent-applications", {
			method: "POST",
			headers: ownerHeaders,
			body: JSON.stringify({
				...applicationBody,
				schemaVersion: 1,
				actions: [],
			}),
		});
		expect(retired.status).toBe(400);
		expect(await retired.json()).toMatchObject({
			code: "INVALID_REQUEST",
			message: "This Agent management API version is retired. Use /api/v2.",
		});
		expect(
			(
				await app.request("/api/v2/agent-applications", {
					method: "POST",
					headers: ownerHeaders,
					body: JSON.stringify(applicationBody),
				})
			).status,
		).toBe(201);
		const { secrets: _secrets, ...updatedBody } = applicationBody;
		expect(
			(
				await app.request("/api/v2/agent-applications/application-run", {
					method: "PUT",
					headers: {
						...requestHeaders("owner", "update-run"),
						"content-type": "application/json",
					},
					body: JSON.stringify({
						...updatedBody,
						name: "Release assistant v2",
					}),
				})
			).status,
		).toBe(200);
		expect(
			(
				await app.request("/api/v2/agent-applications", {
					method: "POST",
					headers: {
						...requestHeaders("owner", "create-withdraw"),
						"content-type": "application/json",
					},
					body: JSON.stringify({
						...applicationBody,
						name: "Withdrawn assistant",
					}),
				})
			).status,
		).toBe(201);
		expect(
			(
				await app.request(
					"/api/v2/agent-applications/application-withdraw/withdraw",
					{
						method: "POST",
						headers: requestHeaders("owner", "withdraw-1"),
					},
				)
			).status,
		).toBe(200);
		const applications = await app.request("/api/v2/agent-applications", {
			headers: requestHeaders("owner"),
		});
		expect(applications.status).toBe(200);
		expect(
			((await applications.json()) as { items: unknown[] }).items,
		).toHaveLength(2);
		const applicationDetail = await app.request(
			"/api/v2/agent-applications/application-run",
			{ headers: requestHeaders("owner") },
		);
		expect(applicationDetail.status).toBe(200);
		expect(
			AgentApplicationProjectionV2Schema.safeParse(
				await applicationDetail.json(),
			).success,
		).toBe(true);

		const adminHeaders = requestHeaders("admin", "approve-run");
		const pending = await app.request("/api/v2/admin/agent-applications", {
			headers: requestHeaders("admin"),
		});
		expect(pending.status).toBe(200);
		expect(((await pending.json()) as { items: unknown[] }).items).toHaveLength(
			1,
		);
		expect(
			(
				await app.request(
					"/api/v2/admin/agent-applications/application-run/decision",
					{
						method: "POST",
						headers: { ...adminHeaders, "content-type": "application/json" },
						body: JSON.stringify({ schemaVersion: 1, decision: "approve" }),
					},
				)
			).status,
		).toBe(200);
		const agents = await app.request("/api/v2/agents", {
			headers: requestHeaders("owner"),
		});
		expect(agents.status).toBe(200);
		expect(((await agents.json()) as { items: unknown[] }).items).toHaveLength(
			1,
		);
		const agentDetail = await app.request("/api/v2/agents/agent-run", {
			headers: requestHeaders("owner"),
		});
		expect(agentDetail.status).toBe(200);
		expect(
			AgentProjectionV2Schema.safeParse(await agentDetail.json()).success,
		).toBe(true);
		expect(
			(
				await app.request("/api/v2/agents/agent-run/configuration", {
					method: "PUT",
					headers: {
						...requestHeaders("owner", "configuration-1"),
						"content-type": "application/json",
					},
					body: JSON.stringify({
						schemaVersion: 2,
						environment: [{ name: "LOG_LEVEL", value: "debug" }],
					}),
				})
			).status,
		).toBe(200);

		const v2Create = await app.request("/api/v2/agent-applications", {
			method: "POST",
			headers: {
				...requestHeaders("owner", "create-v2"),
				"content-type": "application/json",
			},
			body: JSON.stringify(applicationBody),
		});
		expect(v2Create.status).toBe(201);
		expect(
			AgentApplicationProjectionV2Schema.safeParse(await v2Create.json())
				.success,
		).toBe(true);

		const v2Decision = await app.request(
			"/api/v2/admin/agent-applications/application-v2/decision",
			{
				method: "POST",
				headers: {
					...requestHeaders("admin", "approve-v2"),
					"content-type": "application/json",
				},
				body: JSON.stringify({ schemaVersion: 1, decision: "approve" }),
			},
		);
		expect(v2Decision.status).toBe(200);
		expect(
			AgentApplicationProjectionV2Schema.safeParse(await v2Decision.json())
				.success,
		).toBe(true);

		const v2Configuration = await app.request(
			"/api/v2/agents/agent-v2/configuration",
			{
				method: "PUT",
				headers: {
					...requestHeaders("owner", "configuration-v2"),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					schemaVersion: 2,
					environment: [{ name: "LOG_LEVEL", value: "debug-v2" }],
				}),
			},
		);
		expect(v2Configuration.status).toBe(200);
		expect(
			AgentProjectionV2Schema.safeParse(await v2Configuration.json()).success,
		).toBe(true);
		const v2Agents = await app.request("/api/v2/agents?scope=owner", {
			headers: requestHeaders("owner"),
		});
		expect(v2Agents.status).toBe(200);
		expect(
			((await v2Agents.json()) as { items: unknown[] }).items.some(
				(item) => AgentProjectionV2Schema.safeParse(item).success,
			),
		).toBe(true);
		const attackerV2Application = await app.request(
			"/api/v2/agent-applications/application-v2",
			{ headers: requestHeaders("attacker") },
		);
		expect(attackerV2Application.status).toBe(404);
		const attackerV2Approval = await app.request(
			"/api/v2/admin/agent-applications/application-v2/decision",
			{
				method: "POST",
				headers: {
					...requestHeaders("attacker", "attacker-approve-v2"),
					"content-type": "application/json",
				},
				body: JSON.stringify({ schemaVersion: 1, decision: "approve" }),
			},
		);
		expect(attackerV2Approval.status).toBe(403);
		const attackerV2Configuration = await app.request(
			"/api/v2/agents/agent-v2/configuration",
			{
				method: "PUT",
				headers: {
					...requestHeaders("attacker", "attacker-configuration-v2"),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					schemaVersion: 2,
					environment: [{ name: "LOG_LEVEL", value: "attacker" }],
				}),
			},
		);
		expect(attackerV2Configuration.status).toBe(404);

		const createdConversation = await app.request(
			"/api/v1/agents/agent-run/conversations",
			{
				method: "POST",
				headers: {
					...requestHeaders("owner", "conversation-create-1"),
					"content-type": "application/json",
				},
				body: JSON.stringify({ schemaVersion: 1 }),
			},
		);
		expect(createdConversation.status).toBe(201);
		const conversation = ConversationProjectionV1Schema.parse(
			await createdConversation.json(),
		);
		expect(
			(
				await app.request(
					`/api/v1/conversations/${conversation.conversationId}/messages`,
					{
						method: "POST",
						headers: {
							...requestHeaders("owner", "conversation-message-1"),
							"content-type": "application/json",
						},
						body: JSON.stringify({ schemaVersion: 1, text: "Run it" }),
					},
				)
			).status,
		).toBe(202);
		const conversationList = await app.request(
			"/api/v1/agents/agent-run/conversations",
			{ headers: requestHeaders("owner") },
		);
		expect(conversationList.status).toBe(200);
		expect(
			((await conversationList.json()) as { items: unknown[] }).items,
		).toHaveLength(1);
		const conversationDetail = await app.request(
			`/api/v1/conversations/${conversation.conversationId}`,
			{ headers: requestHeaders("owner") },
		);
		expect(conversationDetail.status).toBe(200);
		expect(
			ConversationDetailProjectionV1Schema.parse(
				await conversationDetail.json(),
			).messages,
		).toEqual([expect.objectContaining({ role: "user", text: "Run it" })]);
		for (const path of [
			`/api/v1/conversations/${conversation.conversationId}`,
			`/api/v1/conversations/missing-${conversation.conversationId}`,
		]) {
			const denied = await app.request(path, {
				headers: requestHeaders("attacker"),
			});
			expect(denied.status).toBe(404);
			expect(await denied.json()).toMatchObject({
				code: "RESOURCE_UNAVAILABLE",
			});
		}
		expect(
			(
				await app.request("/api/v2/agents/agent-run/lifecycle", {
					method: "POST",
					headers: {
						...requestHeaders("admin", "disable-1"),
						"content-type": "application/json",
					},
					body: JSON.stringify({ schemaVersion: 1, command: "disable" }),
				})
			).status,
		).toBe(202);
		const session = await app.request("/api/v1/session", {
			headers: requestHeaders("owner"),
		});
		expect(session.status).toBe(200);
		expect(
			BrowserSessionProjectionV1Schema.safeParse(await session.json()).success,
		).toBe(true);
		const audit = await app.request("/api/v1/admin/audit", {
			headers: requestHeaders("admin"),
		});
		expect(audit.status).toBe(200);
		const auditItems = ((await audit.json()) as { items: unknown[] }).items;
		expect(auditItems.length).toBeGreaterThan(0);
		expect(
			auditItems.every(
				(item) => PlatformAuditProjectionV1Schema.safeParse(item).success,
			),
		).toBe(true);
		const auditV2 = await app.request("/api/v2/admin/audit", {
			headers: requestHeaders("admin"),
		});
		expect(auditV2.status).toBe(200);
		expect(
			((await auditV2.json()) as { items: unknown[] }).items.every(
				(item) => PlatformAuditProjectionV2Schema.safeParse(item).success,
			),
		).toBe(true);

		const applicationBeforeAttack = await app.request(
			"/api/v2/agent-applications/application-run",
			{ headers: requestHeaders("owner") },
		);
		const agentBeforeAttack = await app.request("/api/v2/agents/agent-run", {
			headers: requestHeaders("owner"),
		});
		const applicationSnapshot = await applicationBeforeAttack.json();
		const agentSnapshot = await agentBeforeAttack.json();
		const deniedWrites = [
			await app.request("/api/v2/agent-applications/application-run", {
				method: "PUT",
				headers: {
					...requestHeaders("attacker", "attack-update"),
					"content-type": "application/json",
				},
				body: JSON.stringify({ ...updatedBody, name: "Attacker update" }),
			}),
			await app.request("/api/v2/agent-applications/application-run/withdraw", {
				method: "POST",
				headers: requestHeaders("attacker", "attack-withdraw"),
			}),
			await app.request("/api/v2/agents/agent-run/configuration", {
				method: "PUT",
				headers: {
					...requestHeaders("attacker", "attack-configuration"),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					schemaVersion: 2,
					environment: [{ name: "ATTACKED", value: "true" }],
				}),
			}),
			await app.request("/api/v2/agents/agent-run/lifecycle", {
				method: "POST",
				headers: {
					...requestHeaders("attacker", "attack-lifecycle"),
					"content-type": "application/json",
				},
				body: JSON.stringify({ schemaVersion: 1, command: "stop" }),
			}),
			await app.request(
				"/api/v2/admin/agent-applications/application-run/decision",
				{
					method: "POST",
					headers: {
						...requestHeaders("attacker", "attack-decision"),
						"content-type": "application/json",
					},
					body: JSON.stringify({
						schemaVersion: 1,
						decision: "reject",
						reason: "attacker decision",
					}),
				},
			),
		];
		expect(deniedWrites.map(({ status }) => status)).toEqual([
			404, 404, 404, 404, 403,
		]);
		expect(
			await (
				await app.request("/api/v2/agent-applications/application-run", {
					headers: requestHeaders("owner"),
				})
			).json(),
		).toEqual(applicationSnapshot);
		expect(
			await (
				await app.request("/api/v2/agents/agent-run", {
					headers: requestHeaders("owner"),
				})
			).json(),
		).toEqual(agentSnapshot);
		const auditAfterAttacks = await app.request("/api/v1/admin/audit", {
			headers: requestHeaders("admin"),
		});
		expect(
			((await auditAfterAttacks.json()) as { items: unknown[] }).items,
		).toEqual(auditItems);

		for (const response of [
			await app.request("/api/v2/agent-applications/application-run", {
				headers: requestHeaders("attacker"),
			}),
			await app.request("/api/v2/agents/agent-run", {
				headers: requestHeaders("attacker"),
			}),
			await app.request("/api/v1/admin/audit", {
				headers: requestHeaders("attacker"),
			}),
			await app.request("/api/v2/admin/audit", {
				headers: requestHeaders("attacker"),
			}),
		]) {
			expect([403, 404]).toContain(response.status);
		}
	});

	it("reads cross-Owner administrator pages over real HTTP and the generated SDK without writes or expanded employee access", async () => {
		for (const resource of administratorReadResources) {
			const created = await app.request("/api/v2/agent-applications", {
				method: "POST",
				headers: {
					...requestHeaders(resource.owner, resource.idempotencyKey),
					"content-type": "application/json",
				},
				body: JSON.stringify({
					...applicationBody,
					name: `Read fixture ${resource.status}`,
					availability:
						resource.status === "available"
							? [{ kind: "organization", organizationId: "org-1" }]
							: [],
				}),
			});
			expect(created.status).toBe(201);
			if (resource.status === "pending_approval") continue;
			const decision = await app.request(
				`/api/v2/admin/agent-applications/${resource.applicationId}/decision`,
				{
					method: "POST",
					headers: {
						...requestHeaders("admin", `decision-${resource.idempotencyKey}`),
						"content-type": "application/json",
					},
					body: JSON.stringify(
						resource.status === "rejected"
							? {
									schemaVersion: 1,
									decision: "reject",
									reason: "Controlled fixture rejection",
								}
							: { schemaVersion: 1, decision: "approve" },
					),
				},
			);
			expect(decision.status).toBe(200);
			if (resource.status === "creating" || resource.status === "rejected")
				continue;
			const state = (
				await managementQuery.getAgent(
					{ kind: "administrator" },
					resource.agentId,
				)
			)?.management;
			expect(state).toBeDefined();
			if (!state) throw new Error("Missing fixture aggregate");
			// Controlled workload observations through real Core/Store, without a real Worker or external service.
			const observation = {
				schemaVersion: 1 as const,
				observationId: `observation-${resource.idempotencyKey}`,
				agentId: resource.agentId,
				expectedRevision: state.revision,
				workloadRevision: state.workloadRevision,
				fence: state.fence,
				requestId: `request-${resource.idempotencyKey}`,
				traceId: `trace-${resource.idempotencyKey}`,
			};
			expect(
				(
					await managementUseCase.recordWorkloadObservation(
						resource.status === "creation_failed"
							? {
									...observation,
									observation: "creation_failed",
									failureCode: "creation_not_ready",
								}
							: { ...observation, observation: "creation_succeeded" },
					)
				).outcome,
			).toBe("accepted");
			if (resource.status === "stopped" || resource.status === "disabled") {
				const response = await app.request(
					`/api/v2/agents/${resource.agentId}/lifecycle`,
					{
						method: "POST",
						headers: {
							...requestHeaders(
								resource.status === "disabled" ? "admin" : resource.owner,
								`lifecycle-${resource.idempotencyKey}`,
							),
							"content-type": "application/json",
						},
						body: JSON.stringify({
							schemaVersion: 1,
							command: resource.status === "disabled" ? "disable" : "stop",
						}),
					},
				);
				expect(response.status).toBe(202);
			}
		}

		if (!testDatabase) throw new Error("Missing PostgreSQL fixture");
		const sql = postgres(testDatabase.databaseUrl, { max: 1 });
		const snapshot = async () => {
			const tables = [
				"agents",
				"agent_applications",
				"agent_configuration_revisions",
				"agent_owners",
				"agent_availability",
				"agent_management_history",
				"outbox_items",
				"audit_events",
				"idempotency_records",
			];
			const rows = [];
			for (const table of tables)
				rows.push(
					await sql.unsafe(
						`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb) as rows from platform.${table} t`,
					),
				);
			return rows;
		};
		const before = await snapshot();
		const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
		try {
			await once(server, "listening");
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("Missing loopback listener");
			const baseUrl = `http://127.0.0.1:${address.port}`;
			const { createClient } = await import(
				new URL(
					"../../web/src/pilot/generated-v2/client/index.ts",
					import.meta.url,
				).href
			);
			const { listAdminAgentsV2, listAgentsV2 } = await import(
				new URL("../../web/src/pilot/generated-v2/index.ts", import.meta.url)
					.href
			);
			const client = createClient({
				baseUrl,
				headers: { Cookie: "test-browser-session=admin" },
			});
			const items: ReturnType<typeof AgentProjectionV2Schema.parse>[] = [];
			let cursor: string | null = "zz-admin-read-";
			const cursors: (string | null)[] = [];
			do {
				const result: {
					response: Response;
					error?: unknown;
					data?: { items: unknown[]; nextCursor: string | null };
				} = await listAdminAgentsV2({
					client,
					query: { limit: 2, cursor },
				});
				expect(result.response.status).toBe(200);
				expect(result.error).toBeUndefined();
				if (!result.data) throw new Error("Missing administrator page");
				expect(result.data.items.length).toBeLessThanOrEqual(2);
				items.push(
					...result.data.items.map((item: unknown) =>
						AgentProjectionV2Schema.parse(item),
					),
				);
				cursor = result.data.nextCursor;
				expect(cursors).not.toContain(cursor);
				cursors.push(cursor);
			} while (cursor !== null);
			expect(cursors).toEqual(["zz-admin-read-1", "zz-admin-read-3", null]);
			expect(items.map(({ agentId }) => agentId)).toEqual(
				administratorReadResources.slice(0, 5).map(({ agentId }) => agentId),
			);
			expect(new Set(items.map(({ agentId }) => agentId)).size).toBe(5);
			for (const [index, item] of items.entries()) {
				const resource = administratorReadResources[index];
				if (!resource) throw new Error("Missing expected fixture");
				expect(item).toMatchObject({
					name: `Read fixture ${resource.status}`,
					source: applicationBody.source,
					managementStatus: resource.status,
					serviceAvailability: resource.status === "available" ? "ready" : null,
					configuration: {
						owners: [
							{
								userId: identities[resource.owner].userId,
								displayName: identities[resource.owner].displayName,
								roles: identities[resource.owner].roles,
							},
						],
					},
				});
				expect(item).not.toHaveProperty("applicant");
				expect(item).not.toHaveProperty("operations");
				expect(item.configuration).not.toHaveProperty("actions");
			}
			expect(JSON.stringify(items)).not.toMatch(
				/imageDigest|admissionRevision|authorizationRevision|secretId|fixture-api-credential|private-identity-dependency-detail/,
			);

			const ownerClient = createClient({
				baseUrl,
				headers: { Cookie: "test-browser-session=owner" },
			});
			for (const [scope, expectedIds] of [
				[undefined, [0, 1, 2, 4]],
				["owner", [0, 2, 4]],
			] as const) {
				const result = await listAgentsV2({
					client: ownerClient,
					query: {
						limit: 100,
						cursor: "zz-admin-read-",
						...(scope ? { scope } : {}),
					},
				});
				expect(result.response.status).toBe(200);
				expect(
					result.data.items.map(({ agentId }: { agentId: string }) => agentId),
				).toEqual(expectedIds.map((index) => `zz-admin-read-${index}`));
			}
			const ordinaryAdmin = await listAgentsV2({
				client,
				query: { limit: 100, cursor: "zz-admin-read-" },
			});
			expect(ordinaryAdmin.response.status).toBe(200);
			expect(ordinaryAdmin.data.items).toEqual([]);
			for (const intent of ["discover", "manage", "use"] as const) {
				expect(
					await managementUseCase.resolveAgentAccess(
						{ schemaVersion: 1, agentId: "zz-admin-read-1", intent },
						{
							schemaVersion: 1,
							userId: identities.admin.userId,
							accountStatus: "active",
							organizationIds: identities.admin.organizationIds,
							isAdministrator: true,
						},
					),
				).toEqual({ outcome: "denied" });
			}

			const listQueries = vi.spyOn(managementQuery, "listAgents");
			for (const [query, headers, status, code] of [
				[
					"",
					{
						Cookie: "test-browser-session=owner",
						"x-user-id": "user-admin",
						"x-role": "system_admin",
					},
					403,
					"RESOURCE_UNAVAILABLE",
				],
				[
					"",
					{ Cookie: "test-browser-session=disabled" },
					403,
					"AUTHORIZATION_REVOKED",
				],
				["", {}, 401, "AUTHENTICATION_REQUIRED"],
				[
					"",
					{ Authorization: "Bearer fixture-api-credential" },
					401,
					"AUTHENTICATION_REQUIRED",
				],
				[
					"",
					{
						Cookie: "test-browser-session=admin",
						Authorization: "Bearer fixture-api-credential",
					},
					401,
					"AUTHENTICATION_REQUIRED",
				],
				[
					"?scope=administrator",
					{ Cookie: "test-browser-session=admin" },
					400,
					"INVALID_REQUEST",
				],
				[
					"?userId=user-admin",
					{ Cookie: "test-browser-session=admin" },
					400,
					"INVALID_REQUEST",
				],
				[
					"?role=system_admin",
					{ Cookie: "test-browser-session=admin" },
					400,
					"INVALID_REQUEST",
				],
			] as const) {
				const response = await fetch(`${baseUrl}/api/v2/admin/agents${query}`, {
					headers,
				});
				expect(response.status).toBe(status);
				expect(
					PilotProtocolErrorV1Schema.parse(await response.json()).code,
				).toBe(code);
			}
			currentBrowserAdmin = identities.owner;
			const revokedRole = await listAdminAgentsV2({ client });
			expect(revokedRole.response.status).toBe(403);
			expect(revokedRole.error.code).toBe("RESOURCE_UNAVAILABLE");
			currentBrowserAdmin = identities.admin;
			identityDependencyFails = true;
			const identityFailure = await listAdminAgentsV2({ client });
			expect(identityFailure.response.status).toBe(503);
			expect(identityFailure.error.code).toBe("DEPENDENCY_UNAVAILABLE");
			expect(JSON.stringify(identityFailure.error)).not.toContain(
				"private-identity-dependency-detail",
			);
			identityDependencyFails = false;
			expect(listQueries).not.toHaveBeenCalled();
			// Closing the real Store connection exercises a PostgreSQL dependency failure.
			await managementQuery.close();
			const queryFailure = await listAdminAgentsV2({ client });
			expect(queryFailure.response.status).toBe(503);
			expect(queryFailure.error.code).toBe("DEPENDENCY_UNAVAILABLE");
			expect(
				PilotProtocolErrorV1Schema.safeParse(queryFailure.error).success,
			).toBe(true);
			expect(JSON.stringify(queryFailure.error)).not.toMatch(
				/postgres|password|databaseUrl/,
			);
			expect(await snapshot()).toEqual(before);
		} finally {
			identityDependencyFails = false;
			currentBrowserAdmin = identities.admin;
			vi.restoreAllMocks();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			await sql.end();
		}
	}, 60_000);
});
