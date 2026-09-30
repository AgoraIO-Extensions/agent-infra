import {
	AgentApplicationProjectionV2Schema,
	AgentProjectionV2Schema,
	BrowserSessionProjectionV1Schema,
	CommandAcceptedProjectionV1Schema,
	ConversationDetailProjectionV1Schema,
	ConversationDetailProjectionV2Schema,
	ConversationProjectionV1Schema,
	ExecutionDetailProjectionV2Schema,
	PlatformAuditProjectionV1Schema,
	PlatformAuditProjectionV2Schema,
} from "@agent-infra/contracts/pilot";
import {
	createAgentConfigurationUseCaseV1,
	createAgentManagementV1,
	createApplicationFoundationUseCaseV1,
	createApplicationRevisionUseCaseV1,
	createConversationEventUseCaseV1,
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
	PostgresConversationEventTransactionV1,
	PostgresConversationExecutionTransactionV1,
	PostgresConversationQueryV1,
	PostgresPlatformAuditQueryV1,
} from "@agent-infra/platform-store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { PostgresRelayKeyVersionStoreV1 } from "../../../packages/platform-store/src/relay-key-versions.js";
import { createPlatformApp } from "./app.js";
import type { IdentityAdapter, IdentityContext } from "./http/identity.js";
import { createPlatformProjectionReaders } from "./projection.js";

const generatedClientV2 = await import(
	new URL("../../web/src/pilot/generated-v2/client/index.ts", import.meta.url)
		.href
);
const generatedSdkV2 = await import(
	new URL("../../web/src/pilot/generated-v2/index.ts", import.meta.url).href
);
const { createClient: createClientV2 } = generatedClientV2;
const { getConversationV2, getExecutionDetailV2, streamConversationEventsV2 } =
	generatedSdkV2;

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
	const relayKeys = new PostgresRelayKeyVersionStoreV1({ databaseUrl });
	try {
		const result = await relayKeys.replace({
			purpose: "personal",
			subjectId: identities.owner.userId,
			expectedCurrentVersion: null,
			encrypt: (binding) => ({
				schemaVersion: 1,
				...binding,
				crypto: {
					schemaVersion: 1,
					algorithmVersion: "aes-256-gcm:v1",
					wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
					wrappingKeyVersion: "test-wrapping-key",
					aadVersion: "relay-key-aad:v1",
					dekFingerprint: "a".repeat(64),
					nonce: Buffer.alloc(12).toString("base64"),
					ciphertext: Buffer.alloc(16).toString("base64"),
					authenticationTag: Buffer.alloc(16).toString("base64"),
					wrappedDek: Buffer.alloc(384).toString("base64"),
				},
			}),
		});
		expect(result.outcome).toBe("replaced");
	} finally {
		await relayKeys.close();
	}
	const foundationTransaction = new PostgresApplicationFoundationTransactionV1({
		databaseUrl,
	});
	const revisionTransaction = new PostgresApplicationRevisionTransactionV1({
		databaseUrl,
	});
	const managementTransaction = new PostgresAgentManagementTransactionV1({
		databaseUrl,
	});
	const managementQuery = new PostgresAgentManagementQueryV1({ databaseUrl });
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
		authorizations: ["agent-run", "agent-withdraw", "agent-v2"].map(
			(agentId) => ({
				agentId,
				actorId: identities.owner.userId,
				authorizationRevision: "authorization-1",
				authorityContext: {
					schemaVersion: 1 as const,
					users: [
						{
							userId: identities.owner.userId,
							accountStatus: "active" as const,
						},
					],
					organizationIds: ["org-1"],
				},
			}),
		),
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
	const managementUseCase = createAgentManagementV1(managementTransaction);
	const configurationUseCase = createAgentConfigurationUseCaseV1({
		transaction: configurationTransaction,
		...sharedAdmissions,
	});

	const identityAdapter: IdentityAdapter = {
		async resolve(request) {
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
			allocateApplicationIds: async ({ idempotencyKey }) =>
				idempotencyKey === "create-withdraw"
					? { applicationId: "application-withdraw", agentId: "agent-withdraw" }
					: idempotencyKey === "create-v2"
						? { applicationId: "application-v2", agentId: "agent-v2" }
						: { applicationId: "application-run", agentId: "agent-run" },
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
		const sentMessage = await app.request(
			`/api/v1/conversations/${conversation.conversationId}/messages`,
			{
				method: "POST",
				headers: {
					...requestHeaders("owner", "conversation-message-1"),
					"content-type": "application/json",
				},
				body: JSON.stringify({ schemaVersion: 1, text: "Run it" }),
			},
		);
		expect(sentMessage.status).toBe(202);
		const accepted = CommandAcceptedProjectionV1Schema.parse(
			await sentMessage.json(),
		);
		if (!accepted.executionId) throw new Error("Expected execution ID");
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
		if (!testDatabase) throw new Error("Expected PostgreSQL test database");
		const eventTransaction = new PostgresConversationEventTransactionV1({
			databaseUrl: testDatabase.databaseUrl,
		});
		try {
			const events = createConversationEventUseCaseV1({
				transaction: eventTransaction,
			});
			for (const [index, text] of ["First", "Second"].entries()) {
				const result = await events.persist({
					schemaVersion: 1,
					conversationId: conversation.conversationId,
					executionId: accepted.executionId,
					sessionGeneration: 1,
					deliveryFence: 0,
					adapterEventKey: `http-event-${index}`,
					runtimeCursor: `http-runtime-${index}`,
					occurredAt: new Date().toISOString(),
					event: { type: "text.delta", text },
				});
				expect(result.outcome).toBe("accepted");
			}
		} finally {
			await eventTransaction.close();
		}
		const clientV2 = createClientV2({
			baseUrl: "https://platform.example.test",
			fetch: async (input: string | URL | Request, init?: RequestInit) =>
				app.fetch(input instanceof Request ? input : new Request(input, init)),
		});
		const v2Detail = await getConversationV2({
			client: clientV2,
			path: { conversationId: conversation.conversationId },
			headers: requestHeaders("owner"),
		});
		expect(v2Detail.response.status).toBe(200);
		const v2Conversation = ConversationDetailProjectionV2Schema.parse(
			v2Detail.data,
		);
		expect(v2Conversation.messages).toEqual([
			expect.objectContaining({ role: "user", text: "Run it" }),
			expect.objectContaining({ role: "assistant", text: "FirstSecond" }),
		]);
		expect(v2Conversation.events).toHaveLength(2);
		const firstEvent = v2Conversation.events[0];
		if (!firstEvent) throw new Error("Expected persisted event");
		expect(firstEvent).toMatchObject({
			schemaVersion: 1,
			type: "text.delta",
		});
		const v2Execution = await getExecutionDetailV2({
			client: clientV2,
			path: {
				conversationId: conversation.conversationId,
				executionId: accepted.executionId,
			},
			headers: requestHeaders("owner"),
		});
		expect(v2Execution.response.status).toBe(200);
		expect(
			ExecutionDetailProjectionV2Schema.parse(v2Execution.data).events,
		).toEqual(v2Conversation.events);
		const secondEvent = v2Conversation.events[1];
		if (!secondEvent) throw new Error("Expected second persisted event");
		const abort = new AbortController();
		const { stream } = await streamConversationEventsV2({
			client: clientV2,
			path: { conversationId: conversation.conversationId },
			query: { cursor: firstEvent.conversationCursor },
			headers: requestHeaders("owner"),
			signal: abort.signal,
		});
		try {
			expect((await stream.next()).value).toMatchObject({
				eventId: secondEvent.eventId,
				schemaVersion: 1,
				type: "text.delta",
				payload: { text: "Second" },
			});
		} finally {
			abort.abort();
		}
		const continuedTransaction = new PostgresConversationEventTransactionV1({
			databaseUrl: testDatabase.databaseUrl,
		});
		try {
			const result = await createConversationEventUseCaseV1({
				transaction: continuedTransaction,
			}).persist({
				schemaVersion: 1,
				conversationId: conversation.conversationId,
				executionId: accepted.executionId,
				sessionGeneration: 1,
				deliveryFence: 0,
				adapterEventKey: "http-event-2",
				runtimeCursor: "http-runtime-2",
				occurredAt: new Date().toISOString(),
				event: { type: "text.delta", text: "Third" },
			});
			expect(result.outcome).toBe("accepted");
		} finally {
			await continuedTransaction.close();
		}
		const reconnectAbort = new AbortController();
		const { stream: resumed } = await streamConversationEventsV2({
			client: clientV2,
			path: { conversationId: conversation.conversationId },
			headers: {
				...requestHeaders("owner"),
				"Last-Event-ID": secondEvent.eventId,
			},
			signal: reconnectAbort.signal,
		});
		try {
			expect((await resumed.next()).value).toMatchObject({
				schemaVersion: 1,
				type: "text.delta",
				payload: { text: "Third" },
			});
		} finally {
			reconnectAbort.abort();
		}
		const refreshed = await getConversationV2({
			client: clientV2,
			path: { conversationId: conversation.conversationId },
			headers: requestHeaders("owner"),
		});
		expect(refreshed.response.status).toBe(200);
		expect(
			ConversationDetailProjectionV2Schema.parse(refreshed.data),
		).toMatchObject({
			messages: [
				{ role: "user", text: "Run it" },
				{ role: "assistant", text: "FirstSecondThird" },
			],
		});
		for (const path of [
			`/api/v1/conversations/${conversation.conversationId}`,
			`/api/v2/conversations/${conversation.conversationId}`,
			`/api/v2/conversations/${conversation.conversationId}/executions/${accepted.executionId}`,
			`/api/v2/conversations/${conversation.conversationId}/events?cursor=${encodeURIComponent(firstEvent.conversationCursor)}`,
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
});
