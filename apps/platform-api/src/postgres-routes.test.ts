import {
	BrowserSessionProjectionV1Schema,
	PlatformAuditProjectionV1Schema,
	PlatformAuditProjectionV2Schema,
} from "@agent-infra/contracts/pilot";
import {
	createAgentConfigurationUseCaseV1,
	createAgentManagementV1,
	createApplicationFoundationUseCaseV1,
	createApplicationRevisionUseCaseV1,
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
	PostgresPlatformAuditQueryV1,
} from "@agent-infra/platform-store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { createPlatformApp } from "./app.js";
import type { IdentityAdapter, IdentityContext } from "./http/identity.js";
import { createPlatformProjectionReaders } from "./projection.js";

const source = {
	kind: "standard" as const,
	templateId: "template-1",
	imageDigest: `sha256:${"a".repeat(64)}`,
	admissionRevision: "image-admission-1",
	allowedEnvironmentKeys: ["LOG_LEVEL"],
	allowedSecretKeys: [],
	platformManagedKeys: [],
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
	schemaVersion: 1 as const,
	name: "Release assistant",
	description: "Helps the release team",
	source: { kind: "standard" as const, templateId: "template-1" },
	coOwnerIds: [],
	availability: [{ kind: "organization" as const, organizationId: "org-1" }],
	actions: [],
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
	adapters.push(
		foundationTransaction,
		revisionTransaction,
		managementTransaction,
		managementQuery,
		configurationTransaction,
		configurationQuery,
		auditQuery,
	);

	const foundationAdmissions = new FakeAgentConfigurationAdmissionsV1({
		authorizations: ["agent-run", "agent-withdraw"].map((agentId) => ({
			agentId,
			actorId: identities.owner.userId,
			authorizationRevision: "authorization-1",
		})),
		images: [{ selection: applicationBody.source, source }],
		models: [],
		modelCredentials: [],
		actions: [],
		actionSetRevision: "actions-1",
		channelBindings: [],
		channelRevision: "channels-1",
	});
	const configurationAdmissions = new FakeAgentConfigurationAdmissionsV1({
		authorizations: [],
		images: [{ selection: applicationBody.source, source }],
		models: [],
		modelCredentials: [],
		actions: [],
		actionSetRevision: "actions-1",
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
		actionAdmission: configurationAdmissions,
		channelAdmission: configurationAdmissions,
	};
	const foundation = createApplicationFoundationUseCaseV1({
		transaction: foundationTransaction,
		authorizationAdmission: foundationAdmissions,
		imageAdmission: foundationAdmissions,
		modelAdmission: foundationAdmissions,
		secretAdmission: foundationAdmissions,
		actionAdmission: foundationAdmissions,
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
		presentation: {
			async present({ configuration }) {
				if (configuration.source.kind !== "standard") {
					throw new Error("unexpected test source");
				}
				return {
					source: {
						kind: "standard",
						templateId: configuration.source.templateId,
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
		},
	});

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
		expect(
			(
				await app.request("/api/v1/agent-applications", {
					method: "POST",
					headers: ownerHeaders,
					body: JSON.stringify(applicationBody),
				})
			).status,
		).toBe(201);
		const { secrets: _secrets, ...updatedBody } = applicationBody;
		expect(
			(
				await app.request("/api/v1/agent-applications/application-run", {
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
				await app.request("/api/v1/agent-applications", {
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
					"/api/v1/agent-applications/application-withdraw/withdraw",
					{
						method: "POST",
						headers: requestHeaders("owner", "withdraw-1"),
					},
				)
			).status,
		).toBe(200);
		const applications = await app.request("/api/v1/agent-applications", {
			headers: requestHeaders("owner"),
		});
		expect(applications.status).toBe(200);
		expect(
			((await applications.json()) as { items: unknown[] }).items,
		).toHaveLength(2);

		const adminHeaders = requestHeaders("admin", "approve-run");
		const pending = await app.request("/api/v1/admin/agent-applications", {
			headers: requestHeaders("admin"),
		});
		expect(pending.status).toBe(200);
		expect(((await pending.json()) as { items: unknown[] }).items).toHaveLength(
			1,
		);
		expect(
			(
				await app.request(
					"/api/v1/admin/agent-applications/application-run/decision",
					{
						method: "POST",
						headers: { ...adminHeaders, "content-type": "application/json" },
						body: JSON.stringify({ schemaVersion: 1, decision: "approve" }),
					},
				)
			).status,
		).toBe(200);
		const agents = await app.request("/api/v1/agents", {
			headers: requestHeaders("owner"),
		});
		expect(agents.status).toBe(200);
		expect(((await agents.json()) as { items: unknown[] }).items).toHaveLength(
			1,
		);
		expect(
			(
				await app.request("/api/v1/agents/agent-run/configuration", {
					method: "PUT",
					headers: {
						...requestHeaders("owner", "configuration-1"),
						"content-type": "application/json",
					},
					body: JSON.stringify({
						schemaVersion: 1,
						environment: [{ name: "LOG_LEVEL", value: "debug" }],
					}),
				})
			).status,
		).toBe(200);
		expect(
			(
				await app.request("/api/v1/agents/agent-run/lifecycle", {
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

		for (const response of [
			await app.request("/api/v1/agent-applications/application-run", {
				headers: requestHeaders("attacker"),
			}),
			await app.request("/api/v1/agents/agent-run", {
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
