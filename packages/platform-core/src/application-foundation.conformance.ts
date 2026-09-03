import { expect, it } from "vitest";
import {
	agentConfigurationConformanceAdmissionsV1,
	agentConfigurationConformanceRecordV1,
} from "./agent-configuration.conformance.ts";
import type {
	AgentConfigurationRecordV1,
	InitialAgentConfigurationAdmissionDependenciesV1,
} from "./agent-configuration.ts";
import {
	type ApplicationFoundationActorContextV1,
	type ApplicationFoundationTransactionPortV1,
	type ApplicationFoundationWritePlanV1,
	type CommitApplicationFoundationCommandV1,
	createApplicationFoundationUseCaseV1,
} from "./application-foundation.ts";
import type { ApplicationFoundationSnapshot } from "./fake-application-foundation.ts";
import { pendingSecretRecordAttachmentFixtureV1 } from "./secret-record-attachment.fixture.ts";

export const applicationFoundationFailurePoints = [
	"agent",
	"application",
	"configuration_revision",
	"owner",
	"availability",
	"idempotency",
	"outbox",
	"audit",
	"commit",
] as const;

export type ApplicationFoundationFailurePoint =
	(typeof applicationFoundationFailurePoints)[number];

export interface ApplicationFoundationConformanceHarness {
	transaction: ApplicationFoundationTransactionPortV1;
	failNextBefore(
		point: ApplicationFoundationFailurePoint,
	): Promise<void> | void;
	advanceConfiguration(): Promise<void> | void;
	snapshot(): Promise<ApplicationFoundationSnapshot>;
	close(): Promise<void>;
}

const agentId = "agent_01";
const applicationId = "application opaque alpha";
const serverInstant = new Date("2026-08-30T12:00:00.000Z");
const fixedNow = () => new Date(serverInstant.valueOf());

export const applicationFoundationConfigurationV1: AgentConfigurationRecordV1 =
	{
		...agentConfigurationConformanceRecordV1,
		agentId,
		revision: 1,
		modelConfiguration: {
			catalogRevision: "catalog_4",
			options: [
				{
					optionId: "model_primary",
					endpointId: "endpoint_01",
					modelId: "gpt-5",
					reasoningLevels: ["low"],
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
		actions: agentConfigurationConformanceAdmissionsV1.actions,
		actionSetRevision: "actions_2",
		environment: [{ name: "LOG_LEVEL", value: "info" }],
		secrets: [
			{
				name: "BOT_TOKEN",
				secretId: "secret_bot_token",
				version: 3,
				isSet: true,
			},
		],
		channels: [{ kind: "wecom_bot", bindingReference: "binding_01" }],
		channelRevision: "channels_2",
	};

export const applicationFoundationCommandV1: CommitApplicationFoundationCommandV1 =
	{
		schemaVersion: 1,
		applicationId,
		agentId,
		idempotencyKey: "application-submit-alpha",
		requestId: "request opaque alpha",
		name: "Operations Assistant",
		description: "Assists with operational workflows",
		coOwnerIds: ["user co-owner beta"],
		availability: [
			{ kind: "user", userId: "user available beta" },
			{ kind: "organization", organizationId: "organization alpha" },
		],
		source: { kind: "standard", templateId: "template_01" },
		modelConfiguration: {
			options: [
				{
					optionId: "model_primary",
					endpointId: "endpoint_01",
					modelId: "gpt-5",
					reasoningLevels: ["low"],
					replaceCredential: true,
				},
			],
			defaultOptionId: "model_primary",
			defaultReasoningLevel: "low",
		},
		environment: [{ name: "LOG_LEVEL", value: "info" }],
		secrets: [{ name: "BOT_TOKEN", replace: true }],
		actions: agentConfigurationConformanceAdmissionsV1.actions,
		channels: [
			{
				kind: "wecom_bot",
				enabled: true,
				bindingReference: "binding_01",
			},
		],
		traceId: "trace opaque alpha",
	};

export const applicationFoundationActorContextV1: ApplicationFoundationActorContextV1 =
	Object.freeze({
		schemaVersion: 1,
		userId: "owner_01",
		rawRequestDigest: "b".repeat(64),
	});

const supplementaryNameCharacter = "\u{1f600}";
const commandTextFields = [
	"applicationId",
	"agentId",
	"requestId",
	"name",
	"description",
	"traceId",
] as const;
const boundedCommandTextFields = [
	["applicationId", 1024],
	["agentId", 1024],
	["requestId", 1024],
	["traceId", 1024],
	["description", 65_536],
] as const;
const actorTextFields = ["userId"] as const;
const unpairedSurrogates = ["\ud800", "\udc00"] as const;

export const emptyApplicationFoundationSnapshot: ApplicationFoundationSnapshot =
	{
		agents: [],
		applications: [],
		configurationRevisions: [],
		owners: [],
		availability: [],
		idempotencyResults: [],
		outboxIntents: [],
		auditEvents: [],
	};

export function applicationFoundationAdmissionDependenciesV1(): InitialAgentConfigurationAdmissionDependenciesV1 {
	return {
		authorizationAdmission: {
			async authorize(input) {
				return {
					schemaVersion: 1,
					status: "admitted",
					agentId: input.agentId,
					actorId: input.actorId,
					authorizationRevision: "authorization_9",
					authorityContext: {
						schemaVersion: 1,
						users: [
							{ userId: input.actorId, accountStatus: "active" },
							{ userId: "user co-owner beta", accountStatus: "active" },
							{ userId: "user available beta", accountStatus: "active" },
						],
						organizationIds: ["organization alpha"],
					},
				};
			},
		},
		imageAdmission: {
			async admitImage(input) {
				return {
					schemaVersion: 1,
					status: "admitted",
					agentId: input.agentId,
					requestId: input.requestId,
					source: agentConfigurationConformanceRecordV1.source,
				};
			},
		},
		modelAdmission: {
			async admitModels(input) {
				return {
					schemaVersion: 1,
					status: "admitted",
					agentId: input.agentId,
					requestId: input.requestId,
					configuration: {
						catalogRevision: "catalog_4",
						options: input.requested.options.map((option) => ({
							optionId: option.optionId,
							endpointId: option.endpointId,
							modelId: option.modelId,
							reasoningLevels: [...option.reasoningLevels],
							credential: {
								secretId: `secret_${option.optionId}`,
								version: 2,
								isSet: true,
							},
						})),
						defaultOptionId: input.requested.defaultOptionId,
						defaultReasoningLevel: input.requested.defaultReasoningLevel,
					},
				};
			},
		},
		secretAdmission: {
			async admitSecrets(input) {
				return {
					schemaVersion: 1,
					status: "admitted",
					agentId: input.agentId,
					requestId: input.requestId,
					secrets: input.requested.map(({ name }) => ({
						name,
						secretId: `secret_${name.toLowerCase()}`,
						version: 3,
						isSet: true as const,
					})),
				};
			},
		},
		actionAdmission: {
			async admitActions(input) {
				return {
					schemaVersion: 1,
					status: "admitted",
					agentId: input.agentId,
					requestId: input.requestId,
					actionSetRevision: "actions_2",
					actions: structuredClone(input.requested),
				};
			},
		},
		channelAdmission: {
			async admitChannels(input) {
				return {
					schemaVersion: 1,
					status: "admitted",
					agentId: input.agentId,
					requestId: input.requestId,
					channelRevision: "channels_2",
					channels: input.requested
						.filter(({ enabled }) => enabled)
						.map((channel) => ({
							kind: channel.kind,
							bindingReference: channel.enabled ? channel.bindingReference : "",
						})),
				};
			},
		},
	};
}

function createUseCase(
	transaction: ApplicationFoundationTransactionPortV1,
	admissions = applicationFoundationAdmissionDependenciesV1(),
) {
	const useCase = createApplicationFoundationUseCaseV1(
		{ transaction, ...admissions },
		{ now: fixedNow },
	);
	return {
		submit(...args: Parameters<typeof useCase.submit>) {
			return useCase.submit(
				args[0],
				args[1],
				args.length === 3 ? args[2] : pendingSecretRecordAttachmentFixtureV1(),
			);
		},
	};
}

export async function captureApplicationFoundationSubmission(): Promise<{
	readonly plan: ApplicationFoundationWritePlanV1;
	readonly attachments: Parameters<
		ApplicationFoundationTransactionPortV1["commit"]
	>[1];
}> {
	let captured: ApplicationFoundationWritePlanV1 | undefined;
	let attachments: Parameters<
		ApplicationFoundationTransactionPortV1["commit"]
	>[1];
	await createUseCase({
		async read() {
			return { outcome: "ready" };
		},
		async commit(plan, nextAttachments) {
			captured = plan;
			attachments = nextAttachments;
			return { outcome: "committed", result: plan.result };
		},
	}).submit(
		applicationFoundationCommandV1,
		applicationFoundationActorContextV1,
	);
	if (!captured) throw new Error("Expected a captured Foundation write plan");
	return { plan: captured, attachments };
}

export async function captureApplicationFoundationWritePlan(): Promise<ApplicationFoundationWritePlanV1> {
	return (await captureApplicationFoundationSubmission()).plan;
}

export function applicationFoundationTransactionConformance(
	createHarness: () => Promise<ApplicationFoundationConformanceHarness>,
): void {
	it("rejects malformed identity, access and canonical revision before persistence", async () => {
		const harness = await createHarness();
		const useCase = createUseCase(harness.transaction);
		try {
			for (const invalid of [
				{ schemaVersion: 1 },
				{ ...applicationFoundationCommandV1, applicationId: "" },
				{ ...applicationFoundationCommandV1, idempotencyKey: "not valid" },
				{
					...applicationFoundationCommandV1,
					coOwnerIds: ["duplicate", "duplicate"],
				},
				{
					...applicationFoundationCommandV1,
					availability: [
						{ kind: "user", userId: "duplicate" },
						{ kind: "user", userId: "duplicate" },
					],
				},
				{
					...applicationFoundationCommandV1,
					configuration: applicationFoundationConfigurationV1,
				},
				{
					...applicationFoundationCommandV1,
					applicantId: "caller forged user",
				},
			]) {
				await expect(
					useCase.submit(
						invalid as CommitApplicationFoundationCommandV1,
						applicationFoundationActorContextV1,
					),
				).rejects.toMatchObject({
					name: "ApplicationFoundationError",
					code: "invalid_command",
				});
			}
			await expect(harness.snapshot()).resolves.toEqual(
				emptyApplicationFoundationSnapshot,
			);
		} finally {
			await harness.close();
		}
	});

	it("rejects invalid actor context before persistence", async () => {
		const harness = await createHarness();
		const useCase = createUseCase(harness.transaction);
		try {
			for (const invalid of [
				{ schemaVersion: 1 },
				{ ...applicationFoundationActorContextV1, userId: "" },
				{
					...applicationFoundationActorContextV1,
					rawRequestDigest: "not-a-digest",
				},
				{ ...applicationFoundationActorContextV1, authorizationRevision: "" },
				{
					...applicationFoundationActorContextV1,
					actorId: "caller forged user",
				},
			]) {
				await expect(
					useCase.submit(applicationFoundationCommandV1, invalid as never),
				).rejects.toMatchObject({ code: "invalid_command" });
			}
			await expect(harness.snapshot()).resolves.toEqual(
				emptyApplicationFoundationSnapshot,
			);
		} finally {
			await harness.close();
		}
	});

	it("keeps admission rejection and authorization drift outside persistence", async () => {
		const harness = await createHarness();
		try {
			for (const rejectedAuthorizationCall of [1, 2]) {
				const admissions = applicationFoundationAdmissionDependenciesV1();
				let authorizationCalls = 0;
				const useCase = createUseCase(harness.transaction, {
					...admissions,
					authorizationAdmission: {
						async authorize(input) {
							authorizationCalls += 1;
							if (authorizationCalls === rejectedAuthorizationCall) {
								return {
									schemaVersion: 1,
									status: "rejected",
									agentId: input.agentId,
									actorId: input.actorId,
								} as const;
							}
							return admissions.authorizationAdmission.authorize(input);
						},
					},
				});
				await expect(
					useCase.submit(
						applicationFoundationCommandV1,
						applicationFoundationActorContextV1,
					),
				).rejects.toMatchObject({ code: "not_authorized" });
				await expect(harness.snapshot()).resolves.toEqual(
					emptyApplicationFoundationSnapshot,
				);
			}

			const admissions = applicationFoundationAdmissionDependenciesV1();
			const useCase = createUseCase(harness.transaction, {
				...admissions,
				imageAdmission: {
					async admitImage(input) {
						return {
							schemaVersion: 1,
							status: "rejected",
							agentId: input.agentId,
							requestId: input.requestId,
						} as const;
					},
				},
			});
			await expect(
				useCase.submit(
					applicationFoundationCommandV1,
					applicationFoundationActorContextV1,
				),
			).rejects.toMatchObject({ code: "not_admitted" });
			await expect(harness.snapshot()).resolves.toEqual(
				emptyApplicationFoundationSnapshot,
			);
		} finally {
			await harness.close();
		}
	});

	it("rejects embedded NUL in every captured text value", async () => {
		const harness = await createHarness();
		const useCase = createUseCase(harness.transaction);
		try {
			for (const field of commandTextFields) {
				await expect(
					useCase.submit(
						{
							...applicationFoundationCommandV1,
							[field]: `${applicationFoundationCommandV1[field]}\0forged`,
						},
						applicationFoundationActorContextV1,
					),
				).rejects.toMatchObject({ code: "invalid_command" });
			}
			for (const field of actorTextFields) {
				await expect(
					useCase.submit(applicationFoundationCommandV1, {
						...applicationFoundationActorContextV1,
						[field]: `${applicationFoundationActorContextV1[field]}\0forged`,
					}),
				).rejects.toMatchObject({ code: "invalid_command" });
			}
			await expect(harness.snapshot()).resolves.toEqual(
				emptyApplicationFoundationSnapshot,
			);
		} finally {
			await harness.close();
		}
	});

	it("enforces UTF-8 byte limits for every bounded correlation", async () => {
		const harness = await createHarness();
		const useCase = createUseCase(harness.transaction);
		try {
			for (const [field, maximum] of boundedCommandTextFields) {
				await expect(
					useCase.submit(
						{
							...applicationFoundationCommandV1,
							[field]: `${"a".repeat(maximum - 2)}\u754c`,
						},
						applicationFoundationActorContextV1,
					),
				).rejects.toMatchObject({ code: "invalid_command" });
			}
			for (const field of actorTextFields) {
				await expect(
					useCase.submit(applicationFoundationCommandV1, {
						...applicationFoundationActorContextV1,
						[field]: `${"a".repeat(1022)}\u754c`,
					}),
				).rejects.toMatchObject({ code: "invalid_command" });
			}
			await expect(harness.snapshot()).resolves.toEqual(
				emptyApplicationFoundationSnapshot,
			);
		} finally {
			await harness.close();
		}
	});

	it("accepts captured values exactly at their UTF-8 byte limits", async () => {
		const harness = await createHarness();
		const useCase = createUseCase(harness.transaction);
		const exactAgentId = `${"g".repeat(1021)}\u754c`;
		const exactCommand: CommitApplicationFoundationCommandV1 = {
			...applicationFoundationCommandV1,
			applicationId: `${"a".repeat(1021)}\u754c`,
			agentId: exactAgentId,
			requestId: `${"r".repeat(1021)}\u754c`,
			traceId: `${"t".repeat(1021)}\u754c`,
			description: `${"d".repeat(65_533)}\u754c`,
		};
		const exactActor: ApplicationFoundationActorContextV1 = {
			...applicationFoundationActorContextV1,
			userId: `${"u".repeat(1021)}\u754c`,
		};
		try {
			await expect(
				useCase.submit(exactCommand, exactActor),
			).resolves.toMatchObject({
				applicationId: exactCommand.applicationId,
				agentId: exactAgentId,
			});
		} finally {
			await harness.close();
		}
	});

	it("rejects lone surrogates in every captured text value", async () => {
		const harness = await createHarness();
		const useCase = createUseCase(harness.transaction);
		try {
			for (const surrogate of unpairedSurrogates) {
				for (const field of commandTextFields) {
					await expect(
						useCase.submit(
							{
								...applicationFoundationCommandV1,
								[field]: `${applicationFoundationCommandV1[field]}${surrogate}`,
							},
							applicationFoundationActorContextV1,
						),
					).rejects.toMatchObject({ code: "invalid_command" });
				}
				for (const field of actorTextFields) {
					await expect(
						useCase.submit(applicationFoundationCommandV1, {
							...applicationFoundationActorContextV1,
							[field]: `${applicationFoundationActorContextV1[field]}${surrogate}`,
						}),
					).rejects.toMatchObject({ code: "invalid_command" });
				}
			}
			await expect(harness.snapshot()).resolves.toEqual(
				emptyApplicationFoundationSnapshot,
			);
		} finally {
			await harness.close();
		}
	});

	it("accepts ordinary Unicode in captured identity and correlation values", async () => {
		const harness = await createHarness();
		const useCase = createUseCase(harness.transaction);
		const unicodeAgentId = "agent-\u667a\u80fd-\u{1f680}";
		try {
			await expect(
				useCase.submit(
					{
						...applicationFoundationCommandV1,
						applicationId: "application-\u7533\u8bf7-\u{1f642}",
						agentId: unicodeAgentId,
						requestId: "request-\u8bf7\u6c42-\u03b1",
						name: "\u8fd0\u7ef4\u52a9\u624b \u{1f642}",
						description:
							"\u5904\u7406\u53ef\u89c2\u6d4b\u8fd0\u7ef4\u6d41\u7a0b",
						traceId: "trace-\u8ffd\u8e2a-\u03b3",
					},
					{
						...applicationFoundationActorContextV1,
						userId: "user-\u7528\u6237-\u{1f9d1}",
					},
				),
			).resolves.toMatchObject({ agentId: unicodeAgentId });
		} finally {
			await harness.close();
		}
	});

	it("counts supplementary Unicode code points as one name character", async () => {
		const harness = await createHarness();
		try {
			await expect(
				createUseCase(harness.transaction).submit(
					{
						...applicationFoundationCommandV1,
						name: supplementaryNameCharacter.repeat(101),
					},
					applicationFoundationActorContextV1,
				),
			).resolves.toMatchObject({ applicationId, agentId });
		} finally {
			await harness.close();
		}
	});

	it("rejects malicious write-plan identity and correlation mismatches", async () => {
		const harness = await createHarness();
		const plan = await captureApplicationFoundationWritePlan();
		const invalidPlans = [
			{
				...structuredClone(plan),
				configurationRevision: {
					...structuredClone(plan.configurationRevision),
					configuration: {
						...structuredClone(plan.configurationRevision.configuration),
						plaintext: "database-secret",
					},
				},
			},
			{
				...structuredClone(plan),
				agent: {
					...structuredClone(plan.agent),
					authorizationRevision: "",
				},
			},
			{
				...structuredClone(plan),
				configurationRevision: {
					...structuredClone(plan.configurationRevision),
					agentId: "cross agent configuration",
				},
			},
			{
				...structuredClone(plan),
				access: {
					...structuredClone(plan.access),
					ownerIds: ["user co-owner beta"],
				},
			},
			{
				...structuredClone(plan),
				outboxIntent: {
					...structuredClone(plan.outboxIntent),
					requestId: "cross request",
				},
			},
			{
				...structuredClone(plan),
				access: {
					...structuredClone(plan.access),
					createdAt: new Date("2099-01-01T00:00:00.000Z"),
				},
			},
		] as readonly ApplicationFoundationWritePlanV1[];
		try {
			for (const invalid of invalidPlans) {
				await expect(harness.transaction.commit(invalid)).rejects.toMatchObject(
					{
						name: "ApplicationFoundationError",
						code: "persistence_failed",
					},
				);
			}
			await expect(harness.snapshot()).resolves.toEqual(
				emptyApplicationFoundationSnapshot,
			);
		} finally {
			await harness.close();
		}
	});

	it("binds direct replay identity and rejects staged plan accessors", async () => {
		const harness = await createHarness();
		const { plan, attachments } =
			await captureApplicationFoundationSubmission();
		try {
			await expect(
				harness.transaction.commit(plan, attachments),
			).resolves.toMatchObject({
				outcome: "committed",
			});
			const beforeInvalidReplay = await harness.snapshot();
			const applicationId = "application replay mismatch";
			const mismatchedReplay = {
				...structuredClone(plan),
				application: {
					...structuredClone(plan.application),
					applicationId,
				},
				result: { ...structuredClone(plan.result), applicationId },
				outboxIntent: {
					...structuredClone(plan.outboxIntent),
					payload: {
						...structuredClone(plan.outboxIntent.payload),
						applicationId,
					},
				},
				auditEvent: {
					...structuredClone(plan.auditEvent),
					targetId: applicationId,
				},
			} as ApplicationFoundationWritePlanV1;
			await expect(
				harness.transaction.commit(mismatchedReplay),
			).rejects.toMatchObject({ code: "persistence_failed" });

			let getterReads = 0;
			const stagedPlan = structuredClone(plan);
			Object.defineProperty(stagedPlan.application, "applicationId", {
				enumerable: true,
				get() {
					getterReads += 1;
					return plan.application.applicationId;
				},
			});
			await expect(
				harness.transaction.commit(stagedPlan),
			).rejects.toMatchObject({ code: "persistence_failed" });
			expect(getterReads).toBe(0);
			await expect(harness.snapshot()).resolves.toEqual(beforeInvalidReplay);
		} finally {
			await harness.close();
		}
	});

	it("atomically persists the complete admitted revision-one submission", async () => {
		const harness = await createHarness();
		const useCase = createUseCase(harness.transaction);
		try {
			await expect(
				useCase.submit(
					applicationFoundationCommandV1,
					applicationFoundationActorContextV1,
				),
			).resolves.toEqual({
				schemaVersion: 1,
				applicationId,
				agentId,
				configurationRevision: 1,
				status: "pending_approval",
			});
			await expect(harness.snapshot()).resolves.toEqual({
				agents: [
					{
						agentId,
						currentConfigurationRevision: 1,
						authorizationRevision: "authorization_9",
						createdAt: serverInstant,
					},
				],
				applications: [
					{
						applicationId,
						agentId,
						applicantId: "owner_01",
						name: "Operations Assistant",
						description: "Assists with operational workflows",
						status: "pending_approval",
						traceId: "trace opaque alpha",
						requestId: "request opaque alpha",
						submittedAt: serverInstant,
					},
				],
				configurationRevisions: [
					{
						agentId,
						revision: 1,
						configuration: applicationFoundationConfigurationV1,
						createdAt: serverInstant,
					},
				],
				owners: [
					{
						agentId,
						ownerId: "owner_01",
						createdAt: serverInstant,
					},
					{
						agentId,
						ownerId: "user co-owner beta",
						createdAt: serverInstant,
					},
				],
				availability: [
					{
						agentId,
						target: {
							kind: "organization",
							organizationId: "organization alpha",
						},
					},
					{
						agentId,
						target: { kind: "user", userId: "user available beta" },
					},
				],
				idempotencyResults: [
					{
						agentId,
						actorId: "owner_01",
						key: "application-submit-alpha",
						requestDigest: "b".repeat(64),
						result: {
							schemaVersion: 1,
							applicationId,
							agentId,
							configurationRevision: 1,
							status: "pending_approval",
						},
						createdAt: serverInstant,
					},
				],
				outboxIntents: [
					{
						scopeType: "agent",
						scopeId: agentId,
						operation: "agent.application.submitted.v1",
						payload: {
							schemaVersion: 1,
							applicationId,
							agentId,
							configurationRevision: 1,
						},
						traceId: "trace opaque alpha",
						requestId: "request opaque alpha",
						availableAt: serverInstant,
					},
				],
				auditEvents: [
					{
						traceId: "trace opaque alpha",
						requestId: "request opaque alpha",
						agentId,
						actorType: "user",
						actorId: "owner_01",
						action: "agent.application.submitted",
						targetType: "agent_application",
						targetId: applicationId,
						outcome: "succeeded",
						occurredAt: serverInstant,
					},
				],
			});
		} finally {
			await harness.close();
		}
	});

	it("returns the original bounded result for an exact replay without side effects", async () => {
		const harness = await createHarness();
		const useCase = createUseCase(harness.transaction);
		try {
			const first = await useCase.submit(
				applicationFoundationCommandV1,
				applicationFoundationActorContextV1,
			);
			await harness.advanceConfiguration();
			const beforeReplay = await harness.snapshot();
			const admissions = applicationFoundationAdmissionDependenciesV1();
			const revokedUseCase = createUseCase(harness.transaction, {
				...admissions,
				authorizationAdmission: {
					async authorize(input) {
						return {
							schemaVersion: 1,
							status: "rejected",
							agentId: input.agentId,
							actorId: input.actorId,
						} as const;
					},
				},
			});
			await expect(
				revokedUseCase.submit(
					applicationFoundationCommandV1,
					applicationFoundationActorContextV1,
				),
			).rejects.toMatchObject({ code: "not_authorized" });
			await expect(harness.snapshot()).resolves.toEqual(beforeReplay);
			let mutableAdmissionCalls = 0;
			const replayUseCase = createUseCase(harness.transaction, {
				...admissions,
				imageAdmission: {
					async admitImage() {
						mutableAdmissionCalls += 1;
						throw new Error("mutable image admission drifted");
					},
				},
			});
			await expect(
				replayUseCase.submit(
					applicationFoundationCommandV1,
					applicationFoundationActorContextV1,
				),
			).resolves.toEqual(first);
			expect(mutableAdmissionCalls).toBe(0);
			await expect(harness.snapshot()).resolves.toEqual(beforeReplay);
		} finally {
			await harness.close();
		}
	});

	it("rejects a conflicting idempotency replay without side effects", async () => {
		const harness = await createHarness();
		const useCase = createUseCase(harness.transaction);
		try {
			await useCase.submit(
				applicationFoundationCommandV1,
				applicationFoundationActorContextV1,
			);
			const beforeConflict = await harness.snapshot();
			await expect(
				useCase.submit(applicationFoundationCommandV1, {
					...applicationFoundationActorContextV1,
					rawRequestDigest: "c".repeat(64),
				}),
			).rejects.toMatchObject({
				name: "ApplicationFoundationError",
				code: "idempotency_conflict",
			});
			await expect(harness.snapshot()).resolves.toEqual(beforeConflict);
		} finally {
			await harness.close();
		}
	});

	it("rejects duplicate opaque identities under another key", async () => {
		const harness = await createHarness();
		const useCase = createUseCase(harness.transaction);
		try {
			await useCase.submit(
				applicationFoundationCommandV1,
				applicationFoundationActorContextV1,
			);
			const beforeConflict = await harness.snapshot();
			await expect(
				useCase.submit(
					{
						...applicationFoundationCommandV1,
						idempotencyKey: "another-submit-key",
					},
					applicationFoundationActorContextV1,
				),
			).rejects.toMatchObject({
				name: "ApplicationFoundationError",
				code: "conflict",
			});
			await expect(harness.snapshot()).resolves.toEqual(beforeConflict);
		} finally {
			await harness.close();
		}
	});

	it.each([
		["ordinary code points", "a".repeat(201)],
		["supplementary code points", supplementaryNameCharacter.repeat(201)],
	])("rejects more than 200 %s in the name", async (_kind, name) => {
		const harness = await createHarness();
		try {
			await expect(
				createUseCase(harness.transaction).submit(
					{ ...applicationFoundationCommandV1, name },
					applicationFoundationActorContextV1,
				),
			).rejects.toMatchObject({ code: "invalid_command" });
			await expect(harness.snapshot()).resolves.toEqual(
				emptyApplicationFoundationSnapshot,
			);
		} finally {
			await harness.close();
		}
	});

	for (const point of applicationFoundationFailurePoints) {
		it(`rolls back every write when ${point} fails`, async () => {
			const harness = await createHarness();
			const useCase = createUseCase(harness.transaction);
			try {
				await harness.failNextBefore(point);
				await expect(
					useCase.submit(
						applicationFoundationCommandV1,
						applicationFoundationActorContextV1,
					),
				).rejects.toMatchObject({
					name: "ApplicationFoundationError",
					code: "persistence_failed",
					message: "Application foundation persistence failed",
				});
				await expect(harness.snapshot()).resolves.toEqual(
					emptyApplicationFoundationSnapshot,
				);
				await expect(
					useCase.submit(
						applicationFoundationCommandV1,
						applicationFoundationActorContextV1,
					),
				).resolves.toMatchObject({ applicationId, agentId });
			} finally {
				await harness.close();
			}
		});
	}
}
