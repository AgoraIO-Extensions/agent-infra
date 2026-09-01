import { describe, expect, it } from "vitest";

import {
	agentConfigurationConformanceAdmissionsV1,
	agentConfigurationConformanceRecordV1,
	agentConfigurationUseCaseConformance,
} from "./agent-configuration.conformance.ts";
import {
	AgentConfigurationError,
	type AgentConfigurationRecordV1,
	type AgentConfigurationUseCaseDependenciesV1,
	createAgentConfigurationUseCaseV1,
} from "./agent-configuration.ts";
import type { AgentManagementStateV1 } from "./agent-management.ts";
import {
	type FakeAgentConfigurationAdmissionsOptionsV1,
	FakeAgentConfigurationAdmissionsV1,
	type FakeAgentConfigurationTransactionOptionsV1,
	FakeAgentConfigurationTransactionV1,
} from "./fake-agent-configuration.ts";

const serverInstant = new Date("2026-08-31T04:00:00.000Z");
const actor = {
	schemaVersion: 1 as const,
	actorId: "owner_01",
	rawRequestDigest: "0".repeat(64),
};
const command = {
	schemaVersion: 1 as const,
	agentId: "agent_01",
	idempotencyKey: "configuration-update-01",
	requestId: "request_01",
	traceId: "trace_01",
};

const accessState: AgentManagementStateV1 = {
	schemaVersion: 1,
	applicationId: "application_01",
	agentId: "agent_01",
	applicantId: "owner_01",
	status: "available",
	revision: 11,
	approvalRevision: 1,
	decisionReason: null,
	serviceAvailability: "ready",
	desiredState: "running",
	workloadRevision: 1,
	fence: 1,
	ownerIds: ["owner_01"],
	availability: [],
	failureCode: null,
};

const accessAuthority = {
	state: accessState,
	actorContext: {
		schemaVersion: 1 as const,
		userId: "owner_01",
		accountStatus: "active" as const,
		organizationIds: ["org_platform"],
		isAdministrator: false,
	},
	authorityContext: {
		schemaVersion: 1 as const,
		users: [
			{ userId: "owner_01", accountStatus: "active" as const },
			{ userId: "owner_02", accountStatus: "active" as const },
		],
		organizationIds: ["org_platform"],
	},
};

interface HarnessOptions {
	record?: AgentConfigurationRecordV1;
	admissions?: Partial<FakeAgentConfigurationAdmissionsOptionsV1>;
	dependencies?: Partial<AgentConfigurationUseCaseDependenciesV1>;
	transactionState?: FakeAgentConfigurationTransactionOptionsV1;
}

function createHarness(options: HarnessOptions = {}) {
	const transaction = new FakeAgentConfigurationTransactionV1(
		options.record ?? agentConfigurationConformanceRecordV1,
		options.transactionState,
	);
	const admissions = new FakeAgentConfigurationAdmissionsV1({
		...agentConfigurationConformanceAdmissionsV1,
		...options.admissions,
	});
	const dependencies: AgentConfigurationUseCaseDependenciesV1 = {
		transaction,
		authorizationAdmission: admissions,
		imageAdmission: admissions,
		modelAdmission: admissions,
		secretAdmission: admissions,
		actionAdmission: admissions,
		channelAdmission: admissions,
		...options.dependencies,
	};
	return {
		transaction,
		admissions,
		useCase: createAgentConfigurationUseCaseV1(dependencies, {
			now: () => new Date(serverInstant),
		}),
		useCaseWithDependencies: (
			overrides: Partial<AgentConfigurationUseCaseDependenciesV1>,
		) =>
			createAgentConfigurationUseCaseV1(
				{ ...dependencies, ...overrides },
				{ now: () => new Date(serverInstant) },
			),
	};
}

describe("Agent configuration conformance", () => {
	agentConfigurationUseCaseConformance(async () => {
		const harness = createHarness();
		return {
			useCase: harness.useCase,
			useCaseWithDependencies: harness.useCaseWithDependencies,
			snapshot: async () => harness.transaction.snapshot(),
			failNextCommitAsStale: () => harness.transaction.failNextCommitAsStale(),
			close: async () => undefined,
		};
	});
});

describe("Agent configuration policy", () => {
	it("fails closed before policy on malformed persisted configuration and transaction envelopes", async () => {
		for (const read of [
			async () => ({
				outcome: "ready" as const,
				configuration: {
					...agentConfigurationConformanceRecordV1,
					secrets: [
						{
							name: "BOT_TOKEN",
							secretId: "secret_bot",
							version: 1,
							isSet: true as const,
							value: "plaintext",
						},
					],
				},
			}),
			async () =>
				new Proxy(
					{},
					{
						getOwnPropertyDescriptor() {
							throw new Error("proxy trap");
						},
					},
				) as never,
			async () =>
				Object.defineProperty({}, "outcome", {
					enumerable: true,
					get() {
						throw new Error("getter escaped");
					},
				}) as never,
		]) {
			let committed = false;
			const harness = createHarness({
				dependencies: {
					transaction: {
						read: read as never,
						async commit() {
							committed = true;
							return { outcome: "committed", result: {} } as never;
						},
					},
				},
			});
			await expect(
				harness.useCase.update(
					{
						...command,
						changes: {
							environment: [{ name: "LOG_LEVEL", value: "debug" }],
						},
					},
					actor,
				),
			).rejects.toEqual(
				expect.objectContaining({
					name: "AgentConfigurationError",
					code: "persistence_failed",
				}),
			);
			expect(committed).toBe(false);
		}
	});

	it("snapshots every Adapter decision before reading its discriminant", async () => {
		const malformedEnvelope = () =>
			Object.defineProperty({}, "status", {
				enumerable: true,
				get() {
					throw new Error("adapter getter escaped");
				},
			}) as never;
		const modelConfiguration = {
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
		};
		for (const [dependencies, changes] of [
			[
				{
					authorizationAdmission: {
						authorize: async () => malformedEnvelope(),
					},
				},
				{ environment: [{ name: "LOG_LEVEL", value: "debug" }] },
			],
			[
				{ imageAdmission: { admitImage: async () => malformedEnvelope() } },
				{ source: { kind: "standard", templateId: "template_01" } },
			],
			[
				{ modelAdmission: { admitModels: async () => malformedEnvelope() } },
				{ modelConfiguration },
			],
			[
				{ secretAdmission: { admitSecrets: async () => malformedEnvelope() } },
				{ secrets: [{ name: "BOT_TOKEN", replace: true }] },
			],
			[
				{ actionAdmission: { admitActions: async () => malformedEnvelope() } },
				{
					actions: [
						{
							providerId: "github",
							actionId: "issues.read",
							actionVersion: "v3",
						},
					],
				},
			],
			[
				{
					channelAdmission: { admitChannels: async () => malformedEnvelope() },
				},
				{
					channels: [
						{
							kind: "wecom_bot",
							enabled: true,
							bindingReference: "binding_01",
						},
					],
				},
			],
		] as const) {
			const harness = createHarness({ dependencies: dependencies as never });
			await expect(
				harness.useCase.update({ ...command, changes } as never, actor),
			).rejects.toEqual(
				expect.objectContaining({
					name: "AgentConfigurationError",
					code: "dependency_unavailable",
				}),
			);
			expect(harness.transaction.snapshot().commitCount).toBe(0);
		}

		const transaction = new FakeAgentConfigurationTransactionV1(
			agentConfigurationConformanceRecordV1,
		);
		const commitHarness = createHarness({
			dependencies: {
				transaction: {
					read: transaction.read.bind(transaction),
					async commit() {
						return Object.defineProperty({}, "outcome", {
							enumerable: true,
							get() {
								throw new Error("commit getter escaped");
							},
						}) as never;
					},
				},
			},
		});
		await expect(
			commitHarness.useCase.update(
				{
					...command,
					changes: { environment: [{ name: "LOG_LEVEL", value: "debug" }] },
				},
				actor,
			),
		).rejects.toEqual(expect.objectContaining({ code: "persistence_failed" }));
		expect(transaction.snapshot().commitCount).toBe(0);
	});

	it("binds write-only Secret identity through the trusted raw-request digest", async () => {
		const transaction = new FakeAgentConfigurationTransactionV1(
			agentConfigurationConformanceRecordV1,
		);
		const createWithSecretVersion = (version: number) => {
			const admissions = new FakeAgentConfigurationAdmissionsV1({
				...agentConfigurationConformanceAdmissionsV1,
				secretReplacements: [
					{
						requestId: "request_01",
						name: "BOT_TOKEN",
						secretId: `secret_bot_v${version}`,
						version,
					},
				],
			});
			return createAgentConfigurationUseCaseV1({
				transaction,
				authorizationAdmission: admissions,
				imageAdmission: admissions,
				modelAdmission: admissions,
				secretAdmission: admissions,
				actionAdmission: admissions,
				channelAdmission: admissions,
			});
		};
		const firstUseCase = createWithSecretVersion(3);
		const secondUseCase = createWithSecretVersion(4);
		const secretCommand = {
			...command,
			idempotencyKey: "secret-replacement-01",
			changes: { secrets: [{ name: "BOT_TOKEN", replace: true as const }] },
		};
		const firstActor = {
			...actor,
			rawRequestDigest: "c".repeat(64),
		};
		const first = await firstUseCase.update(secretCommand, firstActor as never);
		await expect(
			firstUseCase.update(secretCommand, firstActor as never),
		).resolves.toEqual(first);
		await expect(
			secondUseCase.update(secretCommand, {
				...actor,
				rawRequestDigest: "d".repeat(64),
			} as never),
		).rejects.toEqual(
			expect.objectContaining({ code: "idempotency_conflict" }),
		);
		const snapshot = transaction.snapshot();
		expect(snapshot).toMatchObject({
			commitCount: 1,
			idempotencyCount: 1,
			configuration: {
				secrets: [
					{
						name: "BOT_TOKEN",
						secretId: "secret_bot_v3",
						version: 3,
					},
				],
			},
		});
		expect(JSON.stringify(snapshot.lastPlan)).not.toContain("c".repeat(64));
		expect(JSON.stringify(snapshot.lastPlan)).not.toContain("d".repeat(64));
	});

	it("re-authorizes identical replays before reading persisted idempotency", async () => {
		const transaction = new FakeAgentConfigurationTransactionV1(
			agentConfigurationConformanceRecordV1,
		);
		const admissions = new FakeAgentConfigurationAdmissionsV1(
			agentConfigurationConformanceAdmissionsV1,
		);
		const createUseCase = (
			authorizationAdmission: AgentConfigurationUseCaseDependenciesV1["authorizationAdmission"],
		) =>
			createAgentConfigurationUseCaseV1({
				transaction,
				authorizationAdmission,
				imageAdmission: admissions,
				modelAdmission: admissions,
				secretAdmission: admissions,
				actionAdmission: admissions,
				channelAdmission: admissions,
			});
		const replayCommand = {
			...command,
			idempotencyKey: "authorization-before-replay",
			changes: { environment: [{ name: "LOG_LEVEL", value: "debug" }] },
		};
		await createUseCase(admissions).update(replayCommand, actor);
		const committed = transaction.snapshot();

		let revokedCalls = 0;
		await expect(
			createUseCase({
				async authorize(input) {
					revokedCalls += 1;
					return {
						schemaVersion: 1,
						status: "rejected",
						agentId: input.agentId,
						actorId: input.actorId,
					};
				},
			}).update(replayCommand, actor),
		).rejects.toEqual(expect.objectContaining({ code: "not_authorized" }));
		expect(revokedCalls).toBe(1);
		expect(transaction.snapshot()).toEqual(committed);

		let unavailableCalls = 0;
		await expect(
			createUseCase({
				async authorize() {
					unavailableCalls += 1;
					throw new Error("authorization unavailable");
				},
			}).update(replayCommand, actor),
		).rejects.toEqual(
			expect.objectContaining({ code: "dependency_unavailable" }),
		);
		expect(unavailableCalls).toBe(1);
		expect(transaction.snapshot()).toEqual(committed);
	});

	it("fails closed when commit or commit-time replay lies about the persisted result", async () => {
		for (const outcome of ["committed", "replayed"] as const) {
			const transaction = new FakeAgentConfigurationTransactionV1(
				agentConfigurationConformanceRecordV1,
			);
			const admissions = new FakeAgentConfigurationAdmissionsV1(
				agentConfigurationConformanceAdmissionsV1,
			);
			const lyingTransaction: AgentConfigurationUseCaseDependenciesV1["transaction"] =
				{
					read: transaction.read.bind(transaction),
					async commit(plan) {
						await transaction.commit(plan);
						return {
							outcome,
							result: {
								...plan.result,
								...(outcome === "committed"
									? { revision: plan.result.revision + 1 }
									: { changedFields: ["actions" as const] }),
							},
						};
					},
				};
			const dependencies = {
				transaction: lyingTransaction,
				authorizationAdmission: admissions,
				imageAdmission: admissions,
				modelAdmission: admissions,
				secretAdmission: admissions,
				actionAdmission: admissions,
				channelAdmission: admissions,
			};
			const resultCommand = {
				...command,
				idempotencyKey: `lying-${outcome}-result`,
				changes: { environment: [{ name: "LOG_LEVEL", value: "debug" }] },
			};
			await expect(
				createAgentConfigurationUseCaseV1(dependencies).update(
					resultCommand,
					actor,
				),
			).rejects.toEqual(
				expect.objectContaining({ code: "persistence_failed" }),
			);
			const committed = transaction.snapshot();
			expect(committed).toMatchObject({
				commitCount: 1,
				idempotencyCount: 1,
				outboxCount: 1,
				auditCount: 1,
				configuration: { revision: 8 },
				lastPlan: {
					result: {
						revision: 8,
						changedFields: ["environment"],
					},
				},
			});

			await expect(
				createAgentConfigurationUseCaseV1({
					...dependencies,
					transaction,
				}).update(resultCommand, actor),
			).resolves.toEqual(committed.lastPlan?.result);
			expect(transaction.snapshot()).toEqual(committed);
		}
	});

	it("rejects a 129th aggregate Secret without any effects", async () => {
		const existingSecrets = Array.from({ length: 128 }, (_, index) => ({
			name: `CUSTOM_SECRET_${String(index).padStart(3, "0")}`,
			secretId: `secret_custom_${index}`,
			version: 1,
			isSet: true as const,
		}));
		const harness = createHarness({
			record: {
				...agentConfigurationConformanceRecordV1,
				source: {
					kind: "custom",
					imageDigest: agentConfigurationConformanceRecordV1.source.imageDigest,
					admissionRevision: "image_policy_7",
					interactionMode: "platform-adapter",
					connectionEnabled: true,
				},
				modelConfiguration: null,
				secrets: existingSecrets,
			},
			admissions: {
				secretReplacements: [
					{
						requestId: "request_01",
						name: "CUSTOM_SECRET_128",
						secretId: "secret_custom_128",
						version: 1,
					},
				],
			},
		});
		await expect(
			harness.useCase.update(
				{
					...command,
					idempotencyKey: "secret-aggregate-overflow",
					changes: {
						secrets: [{ name: "CUSTOM_SECRET_128", replace: true }],
					},
				},
				actor,
			),
		).rejects.toEqual(expect.objectContaining({ code: "not_admitted" }));
		expect(harness.transaction.snapshot()).toMatchObject({
			configuration: { revision: 7, secrets: existingSecrets },
			commitCount: 0,
			idempotencyCount: 0,
			outboxCount: 0,
			auditCount: 0,
			managementState: null,
			authorizationRevision: "authorization_9",
			lastPlan: null,
		});
	});

	it("Fake commits configuration, access, authorization, audit, and outbox with one CAS", async () => {
		const createAtomic = () => {
			const transaction = new FakeAgentConfigurationTransactionV1(
				agentConfigurationConformanceRecordV1,
				{
					managementState: accessState,
					authorizationRevision: "authorization_9",
				} as never,
			);
			const admissions = new FakeAgentConfigurationAdmissionsV1({
				...agentConfigurationConformanceAdmissionsV1,
				authorizations: [
					{
						agentId: "agent_01",
						actorId: "owner_01",
						authorizationRevision: "authorization_9",
						accessAuthority,
					},
				],
			});
			return {
				transaction,
				useCase: createAgentConfigurationUseCaseV1({
					transaction,
					authorizationAdmission: admissions,
					imageAdmission: admissions,
					modelAdmission: admissions,
					secretAdmission: admissions,
					actionAdmission: admissions,
					channelAdmission: admissions,
				}),
			};
		};
		const accepted = createAtomic();
		await accepted.useCase.update(
			{
				...command,
				idempotencyKey: "atomic-access-01",
				changes: {
					ownerIds: ["owner_01", "owner_02"],
					availability: [
						{ kind: "organization", organizationId: "org_platform" },
					],
				},
			},
			actor,
		);
		expect(accepted.transaction.snapshot()).toMatchObject({
			commitCount: 1,
			idempotencyCount: 1,
			outboxCount: 1,
			auditCount: 1,
			authorizationRevision: "authorization_9",
			configuration: { revision: 8 },
			managementState: {
				revision: 12,
				ownerIds: ["owner_01", "owner_02"],
				availability: [
					{ kind: "organization", organizationId: "org_platform" },
				],
			},
		});

		const staleAccess = createAtomic();
		staleAccess.transaction.advanceAccessRevision();
		await expect(
			staleAccess.useCase.update(
				{
					...command,
					idempotencyKey: "atomic-access-stale-01",
					changes: { ownerIds: ["owner_01", "owner_02"] },
				},
				actor,
			),
		).rejects.toEqual(expect.objectContaining({ code: "stale_revision" }));
		expect(staleAccess.transaction.snapshot()).toMatchObject({
			commitCount: 0,
			idempotencyCount: 0,
			outboxCount: 0,
			auditCount: 0,
			configuration: { revision: 7 },
			managementState: { revision: 12, ownerIds: ["owner_01"] },
		});

		const staleAuthorization = createAtomic();
		staleAuthorization.transaction.setAuthorizationRevision("authorization_10");
		await expect(
			staleAuthorization.useCase.update(
				{
					...command,
					idempotencyKey: "atomic-authorization-stale-01",
					changes: {
						environment: [{ name: "LOG_LEVEL", value: "debug" }],
					},
				},
				actor,
			),
		).rejects.toEqual(expect.objectContaining({ code: "stale_revision" }));
		expect(staleAuthorization.transaction.snapshot()).toMatchObject({
			commitCount: 0,
			idempotencyCount: 0,
			outboxCount: 0,
			auditCount: 0,
			authorizationRevision: "authorization_10",
			configuration: { revision: 7 },
		});
	});

	it("commits Owner and availability changes as one atomic access fragment", async () => {
		const authorizations = [
			{
				agentId: "agent_01",
				actorId: "owner_01",
				authorizationRevision: "authorization_9",
				accessAuthority,
			},
		] as never;
		const harness = createHarness({
			admissions: { authorizations },
			transactionState: {
				managementState: accessState,
				authorizationRevision: "authorization_9",
			},
		});
		const accessCommand = {
			...command,
			changes: {
				ownerIds: ["owner_02", "owner_01"],
				availability: [
					{ kind: "organization" as const, organizationId: "org_platform" },
				],
			},
		};
		const accessResult = await harness.useCase.update(accessCommand, actor);
		expect(accessResult).toMatchObject({
			revision: 8,
			changedFields: ["availability", "owners"],
		});
		await expect(harness.useCase.update(accessCommand, actor)).resolves.toEqual(
			accessResult,
		);
		const snapshot = harness.transaction.snapshot();
		expect(snapshot.commitCount).toBe(1);
		expect(snapshot.lastPlan).toMatchObject({
			baseRevision: 7,
			nextRevision: 8,
			accessUpdate: {
				schemaVersion: 1,
				fragmentType: "agent_access",
				agentId: "agent_01",
				expectedRevision: 11,
				ownerIds: ["owner_01", "owner_02"],
				availability: [
					{ kind: "organization", organizationId: "org_platform" },
				],
			},
			auditEvent: { action: "agent.access.updated" },
			outboxIntent: {
				payload: { changedFields: ["availability", "owners"] },
			},
		});
		expect(snapshot.lastPlan?.accessUpdate).not.toHaveProperty("auditEvent");

		const combined = createHarness({
			admissions: { authorizations },
			transactionState: {
				managementState: accessState,
				authorizationRevision: "authorization_9",
			},
		});
		const combinedCommand = {
			...command,
			idempotencyKey: "configuration-access-combined-01",
			changes: {
				ownerIds: ["owner_01", "owner_02"],
				environment: [{ name: "LOG_LEVEL", value: "debug" }],
			},
		};
		const combinedResult = await combined.useCase.update(
			combinedCommand,
			actor,
		);
		await expect(
			combined.useCase.update(combinedCommand, actor),
		).resolves.toEqual(combinedResult);
		expect(combined.transaction.snapshot()).toMatchObject({
			commitCount: 1,
			lastPlan: {
				accessUpdate: { ownerIds: ["owner_01", "owner_02"] },
				auditEvent: {
					action: "agent.configuration.revised",
					changedFields: ["environment", "owners"],
				},
				idempotency: { key: "configuration-access-combined-01" },
			},
		});

		const rejected = createHarness({
			admissions: { authorizations },
			transactionState: {
				managementState: accessState,
				authorizationRevision: "authorization_9",
			},
		});
		await expect(
			rejected.useCase.update(
				{
					...command,
					changes: { ownerIds: ["owner_01"] },
					authorityContext: accessAuthority.authorityContext,
					expectedRevision: 11,
				} as never,
				actor,
			),
		).rejects.toEqual(expect.objectContaining({ code: "invalid_command" }));
		expect(rejected.transaction.snapshot().commitCount).toBe(0);

		const partial = createHarness({
			transactionState: {
				managementState: accessState,
				authorizationRevision: "authorization_9",
			},
			admissions: {
				authorizations: [
					{
						agentId: "agent_01",
						actorId: "owner_01",
						authorizationRevision: "authorization_9",
						accessAuthority: {
							...accessAuthority,
							authorityContext: {
								...accessAuthority.authorityContext,
								users: [
									...accessAuthority.authorityContext.users,
									{
										userId: "owner_revoked",
										accountStatus: "revoked",
									},
								],
							},
						},
					},
				] as never,
			},
		});
		await expect(
			partial.useCase.update(
				{
					...command,
					idempotencyKey: "configuration-access-partial-01",
					changes: {
						ownerIds: ["owner_01", "owner_revoked"],
						environment: [{ name: "LOG_LEVEL", value: "debug" }],
					},
				},
				actor,
			),
		).rejects.toEqual(expect.objectContaining({ code: "not_admitted" }));
		expect(partial.transaction.snapshot()).toMatchObject({
			commitCount: 0,
			idempotencyCount: 0,
			lastPlan: null,
		});
	});

	it("rejects malformed, removed, and unapproved model choices", async () => {
		const model = {
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
		};
		for (const [configuration, code] of [
			[
				{ ...model, options: [...model.options, model.options[0]] },
				"invalid_command",
			],
			[{ ...model, defaultOptionId: "removed" }, "invalid_command"],
			[{ ...model, defaultReasoningLevel: "unsupported" }, "invalid_command"],
			[
				{
					...model,
					options: [{ ...model.options[0], modelId: "unapproved" }],
				},
				"not_admitted",
			],
			[
				{
					...model,
					options: [{ ...model.options[0], baseUrl: "https://caller.example" }],
				},
				"invalid_command",
			],
		] as const) {
			const harness = createHarness();
			await expect(
				harness.useCase.update(
					{
						...command,
						changes: { modelConfiguration: configuration },
					} as never,
					actor,
				),
			).rejects.toEqual(expect.objectContaining({ code }));
			expect(harness.transaction.snapshot().commitCount).toBe(0);
		}
		const fallback = createHarness({
			dependencies: {
				modelAdmission: {
					async admitModels(input) {
						return {
							schemaVersion: 1,
							status: "admitted",
							agentId: input.agentId,
							requestId: input.requestId,
							configuration: {
								catalogRevision: "catalog_4",
								options: [
									{
										optionId: input.requested.options[0]?.optionId ?? "",
										endpointId: input.requested.options[0]?.endpointId ?? "",
										modelId: "silent-fallback",
										reasoningLevels:
											input.requested.options[0]?.reasoningLevels ?? [],
										credential: {
											secretId: "secret_model_primary",
											version: 2,
											isSet: true,
										},
									},
								],
								defaultOptionId: "model_primary",
								defaultReasoningLevel: "low",
							},
						};
					},
				},
			},
		});
		await expect(
			fallback.useCase.update(
				{ ...command, changes: { modelConfiguration: model } },
				actor,
			),
		).rejects.toEqual(expect.objectContaining({ code: "not_admitted" }));
		expect(fallback.transaction.snapshot().commitCount).toBe(0);
	});

	it("requires current credential identity unless replacement is explicit", async () => {
		const modelAdmission = (
			credentialFor: (optionId: string) => {
				secretId: string;
				version: number;
				isSet: true;
			},
		) => ({
			async admitModels(
				input: Parameters<
					AgentConfigurationUseCaseDependenciesV1["modelAdmission"]["admitModels"]
				>[0],
			) {
				return {
					schemaVersion: 1 as const,
					status: "admitted" as const,
					agentId: input.agentId,
					requestId: input.requestId,
					configuration: {
						catalogRevision: "catalog_4",
						options: input.requested.options.map((option) => ({
							optionId: option.optionId,
							endpointId: option.endpointId,
							modelId: option.modelId,
							reasoningLevels: option.reasoningLevels,
							credential: credentialFor(option.optionId),
						})),
						defaultOptionId: input.requested.defaultOptionId,
						defaultReasoningLevel: input.requested.defaultReasoningLevel,
					},
				};
			},
		});
		const currentCredential = {
			secretId: "secret_model_primary",
			version: 1,
			isSet: true as const,
		};
		const substitutedCredential = {
			secretId: "secret_model_substituted",
			version: 2,
			isSet: true as const,
		};
		const primary = {
			optionId: "model_primary",
			endpointId: "endpoint_01",
			modelId: "gpt-5",
			reasoningLevels: ["low"],
		};

		const substituted = createHarness({
			dependencies: {
				modelAdmission: modelAdmission(() => substitutedCredential),
			},
		});
		await expect(
			substituted.useCase.update(
				{
					...command,
					idempotencyKey: "model-credential-substitution",
					changes: {
						modelConfiguration: {
							options: [{ ...primary, replaceCredential: false }],
							defaultOptionId: primary.optionId,
							defaultReasoningLevel: "low",
						},
					},
				},
				actor,
			),
		).rejects.toEqual(expect.objectContaining({ code: "not_admitted" }));
		expect(substituted.transaction.snapshot()).toMatchObject({
			commitCount: 0,
			idempotencyCount: 0,
			outboxCount: 0,
			auditCount: 0,
			configuration: { revision: 7 },
		});

		const injected = createHarness({
			dependencies: {
				modelAdmission: modelAdmission((optionId) =>
					optionId === primary.optionId
						? currentCredential
						: substitutedCredential,
				),
			},
		});
		await expect(
			injected.useCase.update(
				{
					...command,
					idempotencyKey: "model-credential-injection",
					changes: {
						modelConfiguration: {
							options: [
								{ ...primary, replaceCredential: false },
								{
									...primary,
									optionId: "model_new",
									replaceCredential: false,
								},
							],
							defaultOptionId: primary.optionId,
							defaultReasoningLevel: "low",
						},
					},
				},
				actor,
			),
		).rejects.toEqual(expect.objectContaining({ code: "not_admitted" }));
		expect(injected.transaction.snapshot().commitCount).toBe(0);

		const replaced = createHarness({
			dependencies: {
				modelAdmission: modelAdmission(() => substitutedCredential),
			},
		});
		await expect(
			replaced.useCase.update(
				{
					...command,
					idempotencyKey: "model-credential-replacement",
					changes: {
						modelConfiguration: {
							options: [{ ...primary, replaceCredential: true }],
							defaultOptionId: primary.optionId,
							defaultReasoningLevel: "low",
						},
					},
				},
				actor,
			),
		).resolves.toMatchObject({ changedFields: ["modelConfiguration"] });
		expect(replaced.transaction.snapshot()).toMatchObject({
			commitCount: 1,
			configuration: {
				modelConfiguration: {
					options: [{ credential: substitutedCredential }],
				},
			},
		});
	});

	it("enforces standard-template keys and permits custom non-reserved K/V", async () => {
		for (const [changes, code] of [
			[
				{ environment: [{ name: "AGENT_INFRA_TOKEN", value: "x" }] },
				"invalid_command",
			],
			[{ environment: [{ name: "UNDECLARED", value: "x" }] }, "not_admitted"],
			[{ secrets: [{ name: "MODEL_API_KEY", replace: true }] }, "not_admitted"],
			[
				{ secrets: [{ name: "BOT_TOKEN", replace: true, value: "plaintext" }] },
				"invalid_command",
			],
		] as const) {
			const harness = createHarness();
			await expect(
				harness.useCase.update({ ...command, changes } as never, actor),
			).rejects.toEqual(expect.objectContaining({ code }));
			expect(harness.transaction.snapshot().commitCount).toBe(0);
		}

		const customRecord: AgentConfigurationRecordV1 = {
			...agentConfigurationConformanceRecordV1,
			source: {
				kind: "custom",
				imageDigest: agentConfigurationConformanceRecordV1.source.imageDigest,
				admissionRevision: "image_policy_7",
				interactionMode: "platform-adapter",
				connectionEnabled: true,
			},
			modelConfiguration: null,
		};
		const harness = createHarness({
			record: customRecord,
			admissions: {
				secretReplacements: [
					{
						requestId: "request_01",
						name: "CUSTOM_TOKEN",
						secretId: "secret_custom",
						version: 1,
					},
				],
			},
		});
		await expect(
			harness.useCase.update(
				{
					...command,
					changes: {
						environment: [{ name: "CUSTOM_MODE", value: "enabled" }],
						secrets: [{ name: "CUSTOM_TOKEN", replace: true }],
					},
				},
				actor,
			),
		).resolves.toMatchObject({
			changedFields: ["environment", "secrets"],
		});
	});

	it("pins admitted images and rejects caller-supplied digest selectors", async () => {
		const current: AgentConfigurationRecordV1 = {
			...agentConfigurationConformanceRecordV1,
			source: {
				kind: "custom",
				imageDigest: agentConfigurationConformanceRecordV1.source.imageDigest,
				admissionRevision: "image_policy_7",
				interactionMode: "platform-adapter",
				connectionEnabled: true,
			},
			modelConfiguration: null,
		};
		const admittedDigest = `sha256:${"b".repeat(64)}`;
		const selection = {
			kind: "custom" as const,
			imageReference: "registry.example/agent:v2",
			interactionMode: "platform-adapter" as const,
		};
		const harness = createHarness({
			record: current,
			admissions: {
				images: [
					{
						selection,
						source: {
							kind: "custom",
							imageDigest: admittedDigest,
							admissionRevision: "image_policy_8",
							interactionMode: "platform-adapter",
							connectionEnabled: true,
						},
					},
				],
			},
		});
		await expect(
			harness.useCase.update(
				{ ...command, changes: { source: selection } },
				actor,
			),
		).resolves.toMatchObject({ changedFields: ["source"] });
		expect(
			harness.transaction.snapshot().configuration.source.imageDigest,
		).toBe(admittedDigest);

		const rejected = createHarness({ record: current });
		await expect(
			rejected.useCase.update(
				{
					...command,
					changes: {
						source: { ...selection, imageDigest: admittedDigest },
					},
				} as never,
				actor,
			),
		).rejects.toEqual(expect.objectContaining({ code: "invalid_command" }));
	});

	it("fails closed for unauthorized Actions, self-managed channels, and plaintext admissions", async () => {
		const unauthorized = createHarness({ admissions: { authorizations: [] } });
		await expect(
			unauthorized.useCase.update(
				{
					...command,
					changes: { environment: [{ name: "LOG_LEVEL", value: "debug" }] },
				},
				actor,
			),
		).rejects.toEqual(expect.objectContaining({ code: "not_authorized" }));

		const action = createHarness();
		await expect(
			action.useCase.update(
				{
					...command,
					changes: {
						actions: [
							{
								providerId: "github",
								actionId: "issues.delete",
								actionVersion: "v1",
							},
						],
					},
				},
				actor,
			),
		).rejects.toEqual(expect.objectContaining({ code: "not_admitted" }));

		const selfManagedRecord: AgentConfigurationRecordV1 = {
			...agentConfigurationConformanceRecordV1,
			source: {
				kind: "custom",
				imageDigest: agentConfigurationConformanceRecordV1.source.imageDigest,
				admissionRevision: "image_policy_7",
				interactionMode: "self-managed",
				identityResponsibility: "self-managed",
				connectionEnabled: false,
			},
			modelConfiguration: null,
		};
		const channel = createHarness({ record: selfManagedRecord });
		await expect(
			channel.useCase.update(
				{
					...command,
					changes: {
						channels: [
							{
								kind: "wecom_bot",
								enabled: true,
								bindingReference: "binding_01",
							},
						],
					},
				},
				actor,
			),
		).rejects.toEqual(expect.objectContaining({ code: "not_admitted" }));

		const plaintext = createHarness({
			dependencies: {
				secretAdmission: {
					async admitSecrets(input) {
						return {
							schemaVersion: 1,
							status: "admitted",
							agentId: input.agentId,
							requestId: input.requestId,
							secrets: [
								{
									name: "BOT_TOKEN",
									secretId: "secret_bot",
									version: 2,
									isSet: true,
									value: "plaintext",
								},
							],
						} as never;
					},
				},
			},
		});
		await expect(
			plaintext.useCase.update(
				{
					...command,
					changes: { secrets: [{ name: "BOT_TOKEN", replace: true }] },
				},
				actor,
			),
		).rejects.toEqual(
			expect.objectContaining({ code: "dependency_unavailable" }),
		);

		for (const harness of [unauthorized, action, channel, plaintext]) {
			expect(harness.transaction.snapshot().commitCount).toBe(0);
		}
	});

	it("returns stable domain errors without causes", () => {
		const error = new AgentConfigurationError("not_admitted");
		expect(error).toMatchObject({
			name: "AgentConfigurationError",
			code: "not_admitted",
			message: "Agent configuration not admitted",
		});
		expect(error).not.toHaveProperty("cause");
	});

	it("keeps canonical command and plan ordering independent of localeCompare", async () => {
		const scenario = () => {
			const storedSource = agentConfigurationConformanceRecordV1.source;
			if (storedSource.kind !== "standard") {
				throw new Error("Standard conformance source is required");
			}
			const firstOption = {
				optionId: "!model-a",
				endpointId: "endpoint-a",
				modelId: "model-a",
				reasoningLevels: ["high", "low"],
				credential: {
					secretId: "secret_model_a",
					version: 1,
					isSet: true as const,
				},
			};
			const secondOption = {
				optionId: "模型-z",
				endpointId: "endpoint-z",
				modelId: "model-z",
				reasoningLevels: ["low", "high"],
				credential: {
					secretId: "secret_model_z",
					version: 1,
					isSet: true as const,
				},
			};
			const record: AgentConfigurationRecordV1 = {
				...agentConfigurationConformanceRecordV1,
				source: {
					...storedSource,
					allowedEnvironmentKeys: ["Z_KEY", "A_KEY"],
					allowedSecretKeys: [
						"Z_SECRET",
						"A_SECRET",
						"NEW_Z_SECRET",
						"NEW_A_SECRET",
					],
					platformManagedKeys: [],
				},
				modelConfiguration: {
					catalogRevision: "catalog_3",
					options: [secondOption, firstOption],
					defaultOptionId: firstOption.optionId,
					defaultReasoningLevel: "low",
				},
				actions: [
					{ providerId: "提供方-z", actionId: "!read", actionVersion: "v2" },
					{ providerId: "!provider-a", actionId: "写", actionVersion: "v1" },
				],
				environment: [
					{ name: "Z_KEY", value: "old-z" },
					{ name: "A_KEY", value: "old-a" },
				],
				secrets: [
					{
						name: "Z_SECRET",
						secretId: "secret-z",
						version: 1,
						isSet: true,
					},
					{
						name: "A_SECRET",
						secretId: "secret-a",
						version: 1,
						isSet: true,
					},
				],
				channels: [
					{ kind: "wecom_app", bindingReference: "binding-old-app" },
					{ kind: "wecom_bot", bindingReference: "binding-old-bot" },
				],
			};
			const actions = [...record.actions].reverse();
			const admissions = new FakeAgentConfigurationAdmissionsV1({
				...agentConfigurationConformanceAdmissionsV1,
				authorizations: [
					{
						agentId: "agent_01",
						actorId: "owner_01",
						authorizationRevision: "authorization_9",
						accessAuthority,
					},
				],
				models: [
					{
						endpointId: firstOption.endpointId,
						modelId: firstOption.modelId,
						reasoningLevels: ["low", "high"],
						catalogRevision: "catalog_4",
					},
					{
						endpointId: secondOption.endpointId,
						modelId: secondOption.modelId,
						reasoningLevels: ["high", "low"],
						catalogRevision: "catalog_4",
					},
				],
				secretReplacements: [
					{
						requestId: "request_01",
						name: "NEW_Z_SECRET",
						secretId: "secret-new-z",
						version: 1,
					},
					{
						requestId: "request_01",
						name: "NEW_A_SECRET",
						secretId: "secret-new-a",
						version: 1,
					},
				],
				actions,
				channelBindings: [
					{ kind: "wecom_app", bindingReference: "binding-new-app" },
					{ kind: "wecom_bot", bindingReference: "binding-new-bot" },
				],
			});
			const transaction = new FakeAgentConfigurationTransactionV1(record, {
				managementState: accessState,
				authorizationRevision: "authorization_9",
			});
			const useCase = createAgentConfigurationUseCaseV1(
				{
					transaction,
					authorizationAdmission: admissions,
					imageAdmission: admissions,
					modelAdmission: admissions,
					secretAdmission: admissions,
					actionAdmission: admissions,
					channelAdmission: admissions,
				},
				{ now: () => new Date(serverInstant) },
			);
			return {
				transaction,
				useCase,
				command: {
					...command,
					idempotencyKey: "locale-independent-canonicalization",
					changes: {
						ownerIds: ["owner_02", "owner_01"],
						availability: [
							{ kind: "user" as const, userId: "owner_02" },
							{ kind: "organization" as const, organizationId: "org_platform" },
						],
						modelConfiguration: {
							options: [secondOption, firstOption].map((option) => ({
								optionId: option.optionId,
								endpointId: option.endpointId,
								modelId: option.modelId,
								reasoningLevels: [...option.reasoningLevels].reverse(),
								replaceCredential: false,
							})),
							defaultOptionId: firstOption.optionId,
							defaultReasoningLevel: "high",
						},
						environment: [
							{ name: "Z_KEY", value: "new-z" },
							{ name: "A_KEY", value: "new-a" },
						],
						secrets: [
							{ name: "NEW_Z_SECRET", replace: true as const },
							{ name: "NEW_A_SECRET", replace: true as const },
						],
						actions,
						channels: [
							{
								kind: "wecom_app" as const,
								enabled: true as const,
								bindingReference: "binding-new-app",
							},
							{
								kind: "wecom_bot" as const,
								enabled: true as const,
								bindingReference: "binding-new-bot",
							},
						],
					},
				},
			};
		};

		const baseline = scenario();
		const baselineResult = await baseline.useCase.update(
			baseline.command,
			actor,
		);
		const baselinePlan = baseline.transaction.snapshot().lastPlan;
		const patched = scenario();
		const descriptor = Object.getOwnPropertyDescriptor(
			String.prototype,
			"localeCompare",
		);
		let patchedResult: typeof baselineResult;
		try {
			String.prototype.localeCompare = () => {
				throw new Error("localeCompare must not be used");
			};
			patchedResult = await patched.useCase.update(patched.command, actor);
		} finally {
			if (descriptor) {
				Object.defineProperty(String.prototype, "localeCompare", descriptor);
			}
		}
		expect(patchedResult).toEqual(baselineResult);
		expect(patched.transaction.snapshot().lastPlan).toEqual(baselinePlan);
	});

	it("clears Actions atomically when an admitted image removes Connection capability", async () => {
		const selection = {
			kind: "custom" as const,
			imageReference: "registry.example/agent:no-connection",
			interactionMode: "platform-adapter" as const,
		};
		const disabledSource = {
			kind: "custom" as const,
			imageDigest: `sha256:${"b".repeat(64)}`,
			admissionRevision: "image_policy_no_connection",
			interactionMode: "platform-adapter" as const,
			connectionEnabled: false,
		};
		const currentAction = {
			providerId: "github",
			actionId: "issues.read",
			actionVersion: "v3",
		};
		const currentRecord = (
			actions: AgentConfigurationRecordV1["actions"],
			connectionEnabled = true,
		): AgentConfigurationRecordV1 => ({
			...agentConfigurationConformanceRecordV1,
			source: {
				kind: "custom",
				imageDigest: connectionEnabled
					? agentConfigurationConformanceRecordV1.source.imageDigest
					: disabledSource.imageDigest,
				admissionRevision: connectionEnabled
					? "image_policy_connection"
					: "image_policy_no_connection_old",
				interactionMode: "platform-adapter",
				connectionEnabled,
			},
			modelConfiguration: null,
			actions,
			channels: [],
		});
		const createConnectionHarness = (record: AgentConfigurationRecordV1) => {
			let actionAdmissionCalls = 0;
			const harness = createHarness({
				record,
				admissions: {
					images: [{ selection, source: disabledSource }],
				},
				dependencies: {
					actionAdmission: {
						async admitActions() {
							actionAdmissionCalls += 1;
							throw new Error("Action admission must not run");
						},
					},
				},
			});
			return { ...harness, actionAdmissionCalls: () => actionAdmissionCalls };
		};

		const cleared = createConnectionHarness(currentRecord([currentAction]));
		await expect(
			cleared.useCase.update(
				{
					...command,
					idempotencyKey: "disable-connection-clear-actions",
					changes: { source: selection, actions: [] },
				},
				actor,
			),
		).resolves.toMatchObject({ changedFields: ["actions", "source"] });
		expect(cleared.actionAdmissionCalls()).toBe(0);
		expect(cleared.transaction.snapshot()).toMatchObject({
			commitCount: 1,
			configuration: { source: disabledSource, actions: [] },
		});

		for (const [idempotencyKey, actions] of [
			["disable-connection-source-only", undefined],
			["disable-connection-non-empty-actions", [currentAction]],
		] as const) {
			const rejected = createConnectionHarness(currentRecord([currentAction]));
			await expect(
				rejected.useCase.update(
					{
						...command,
						idempotencyKey,
						changes: {
							source: selection,
							...(actions === undefined ? {} : { actions }),
						},
					},
					actor,
				),
			).rejects.toEqual(expect.objectContaining({ code: "not_admitted" }));
			expect(rejected.actionAdmissionCalls()).toBe(0);
			expect(rejected.transaction.snapshot()).toMatchObject({
				commitCount: 0,
				idempotencyCount: 0,
				outboxCount: 0,
				auditCount: 0,
			});
		}

		const alreadyEmpty = createConnectionHarness(currentRecord([]));
		await expect(
			alreadyEmpty.useCase.update(
				{
					...command,
					idempotencyKey: "disable-connection-empty-actions",
					changes: { source: selection, actions: [] },
				},
				actor,
			),
		).resolves.toMatchObject({ changedFields: ["source"] });
		expect(alreadyEmpty.actionAdmissionCalls()).toBe(0);

		const noChange = createConnectionHarness(currentRecord([], false));
		await expect(
			noChange.useCase.update(
				{
					...command,
					idempotencyKey: "disable-connection-no-change",
					changes: { source: selection, actions: [] },
				},
				actor,
			),
		).rejects.toEqual(expect.objectContaining({ code: "no_change" }));
		expect(noChange.actionAdmissionCalls()).toBe(0);
	});

	it("isolates nested Adapter inputs and the transaction plan from mutation", async () => {
		const expectNoEffects = (
			transaction: FakeAgentConfigurationTransactionV1,
		) => {
			expect(transaction.snapshot()).toMatchObject({
				commitCount: 0,
				idempotencyCount: 0,
				outboxCount: 0,
				auditCount: 0,
				lastPlan: null,
			});
		};

		const imageCommand = {
			...command,
			idempotencyKey: "mutating-image-adapter",
			changes: {
				source: {
					kind: "custom" as const,
					imageReference: "registry.example/original:v1",
					interactionMode: "platform-adapter" as const,
				},
			},
		};
		const imageRecord: AgentConfigurationRecordV1 = {
			...agentConfigurationConformanceRecordV1,
			source: {
				kind: "custom",
				imageDigest: agentConfigurationConformanceRecordV1.source.imageDigest,
				admissionRevision: "image_policy_1",
				interactionMode: "platform-adapter",
				connectionEnabled: true,
			},
			modelConfiguration: null,
		};
		const image = createHarness({
			record: imageRecord,
			dependencies: {
				imageAdmission: {
					async admitImage(input) {
						(input.requested as { imageReference: string }).imageReference =
							"registry.example/mutated:v2";
						return {
							schemaVersion: 1,
							status: "admitted",
							agentId: "agent_other",
							requestId: input.requestId,
							source: {
								...imageRecord.source,
								imageDigest: `sha256:${"b".repeat(64)}`,
							},
						} as never;
					},
				},
			},
		});
		await expect(image.useCase.update(imageCommand, actor)).rejects.toEqual(
			expect.objectContaining({ code: "not_admitted" }),
		);
		expect(imageCommand.changes.source.imageReference).toBe(
			"registry.example/original:v1",
		);
		expectNoEffects(image.transaction);

		const substitutedCredential = {
			secretId: "secret_model_mutated",
			version: 2,
			isSet: true as const,
		};
		const modelCommand = {
			...command,
			idempotencyKey: "mutating-model-adapter",
			changes: {
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
			},
		};
		const model = createHarness({
			dependencies: {
				modelAdmission: {
					async admitModels(input) {
						(
							input.requested.options[0] as { replaceCredential: boolean }
						).replaceCredential = true;
						(
							input.current?.options[0] as {
								credential: typeof substitutedCredential;
							}
						).credential = substitutedCredential;
						return {
							schemaVersion: 1,
							status: "admitted",
							agentId: input.agentId,
							requestId: input.requestId,
							configuration: {
								catalogRevision: "catalog_4",
								options: [
									{
										optionId: "model_primary",
										endpointId: "endpoint_01",
										modelId: "gpt-5",
										reasoningLevels: ["low"],
										credential: substitutedCredential,
									},
								],
								defaultOptionId: "model_primary",
								defaultReasoningLevel: "low",
							},
						};
					},
				},
			},
		});
		await expect(model.useCase.update(modelCommand, actor)).rejects.toEqual(
			expect.objectContaining({ code: "not_admitted" }),
		);
		expect(
			modelCommand.changes.modelConfiguration.options[0]?.replaceCredential,
		).toBe(false);
		expectNoEffects(model.transaction);

		const secretCommand = {
			...command,
			idempotencyKey: "mutating-secret-adapter",
			changes: { secrets: [{ name: "BOT_TOKEN", replace: true as const }] },
		};
		const secret = createHarness({
			record: {
				...agentConfigurationConformanceRecordV1,
				source: {
					...agentConfigurationConformanceRecordV1.source,
					allowedSecretKeys: ["BOT_TOKEN", "OTHER_TOKEN", "MODEL_API_KEY"],
				},
				secrets: [
					{
						name: "BOT_TOKEN",
						secretId: "secret_bot_old",
						version: 1,
						isSet: true,
					},
				],
			} as AgentConfigurationRecordV1,
			dependencies: {
				secretAdmission: {
					async admitSecrets(input) {
						(input.requested[0] as { name: string }).name = "OTHER_TOKEN";
						(input.current[0] as { name: string }).name = "OTHER_TOKEN";
						return {
							schemaVersion: 1,
							status: "admitted",
							agentId: input.agentId,
							requestId: input.requestId,
							secrets: [
								{
									name: "OTHER_TOKEN",
									secretId: "secret_other",
									version: 2,
									isSet: true,
								},
							],
						};
					},
				},
			},
		});
		await expect(secret.useCase.update(secretCommand, actor)).rejects.toEqual(
			expect.objectContaining({ code: "not_admitted" }),
		);
		expect(secretCommand.changes.secrets[0]?.name).toBe("BOT_TOKEN");
		expectNoEffects(secret.transaction);

		const actionCommand = {
			...command,
			idempotencyKey: "mutating-action-adapter",
			changes: {
				actions: [
					{
						providerId: "github",
						actionId: "issues.read",
						actionVersion: "v3",
					},
				],
			},
		};
		const action = createHarness({
			dependencies: {
				actionAdmission: {
					async admitActions(input) {
						(input.requested[0] as { actionId: string }).actionId =
							"issues.mutated";
						return {
							schemaVersion: 1,
							status: "admitted",
							agentId: input.agentId,
							requestId: input.requestId,
							actionSetRevision: "actions_mutated",
							actions: input.requested,
						};
					},
				},
			},
		});
		await expect(action.useCase.update(actionCommand, actor)).rejects.toEqual(
			expect.objectContaining({ code: "not_admitted" }),
		);
		expect(actionCommand.changes.actions[0]?.actionId).toBe("issues.read");
		expectNoEffects(action.transaction);

		const channelCommand = {
			...command,
			idempotencyKey: "mutating-channel-adapter",
			changes: {
				channels: [
					{
						kind: "wecom_bot" as const,
						enabled: true as const,
						bindingReference: "binding-new",
					},
				],
			},
		};
		const channel = createHarness({
			record: {
				...agentConfigurationConformanceRecordV1,
				channels: [{ kind: "wecom_bot", bindingReference: "binding-old" }],
			},
			dependencies: {
				channelAdmission: {
					async admitChannels(input) {
						(
							input.requested[0] as { bindingReference: string }
						).bindingReference = "binding-mutated";
						(
							input.current[0] as { bindingReference: string }
						).bindingReference = "binding-current-mutated";
						return {
							schemaVersion: 1,
							status: "admitted",
							agentId: input.agentId,
							requestId: input.requestId,
							channelRevision: "channels_mutated",
							channels: [
								{ kind: "wecom_bot", bindingReference: "binding-mutated" },
							],
						};
					},
				},
			},
		});
		await expect(channel.useCase.update(channelCommand, actor)).rejects.toEqual(
			expect.objectContaining({ code: "not_admitted" }),
		);
		expect(channelCommand.changes.channels[0]?.bindingReference).toBe(
			"binding-new",
		);
		expectNoEffects(channel.transaction);

		const transaction = new FakeAgentConfigurationTransactionV1(
			agentConfigurationConformanceRecordV1,
		);
		const transactionMutation = createHarness({
			dependencies: {
				transaction: {
					read: transaction.read.bind(transaction),
					async commit(plan) {
						(plan.result as { revision: number }).revision += 1;
						return { outcome: "committed", result: plan.result };
					},
				},
			},
		});
		await expect(
			transactionMutation.useCase.update(
				{
					...command,
					idempotencyKey: "mutating-transaction-adapter",
					changes: { environment: [{ name: "LOG_LEVEL", value: "debug" }] },
				},
				actor,
			),
		).rejects.toEqual(expect.objectContaining({ code: "persistence_failed" }));
		expectNoEffects(transaction);
	});
});
