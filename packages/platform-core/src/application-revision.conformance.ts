import { expect, it } from "vitest";
import { agentConfigurationConformanceRecordV1 } from "./agent-configuration.conformance.ts";
import type { AgentConfigurationUseCaseDependenciesV1 } from "./agent-configuration.ts";
import {
	type ApplicationRevisionActorContextV1,
	ApplicationRevisionError,
	type ApplicationRevisionReadStateV1,
	type ApplicationRevisionTransactionPortV1,
	type ApplicationRevisionUseCaseDependenciesV1,
	createApplicationRevisionUseCaseV1,
	type ReviseApplicationCommandV1,
} from "./application-revision.ts";
import { FakeAgentConfigurationAdmissionsV1 } from "./fake-agent-configuration.ts";
import type {
	ApplicationRevisionFailurePoint,
	ApplicationRevisionFakeSnapshotV1,
} from "./fake-application-revision.ts";
import { applicationRevisionFailurePoints } from "./fake-application-revision.ts";

const serverInstant = new Date("2026-09-02T04:00:00.000Z");

export const applicationRevisionStateV1: ApplicationRevisionReadStateV1 = {
	schemaVersion: 1,
	application: {
		applicationId: "application_01",
		agentId: "agent_01",
		applicantId: "owner_01",
		name: "Operations Assistant",
		description: "Assists with operational workflows",
	},
	management: {
		schemaVersion: 1,
		applicationId: "application_01",
		agentId: "agent_01",
		applicantId: "owner_01",
		status: "pending_approval",
		revision: 3,
		approvalRevision: null,
		decisionReason: null,
		serviceAvailability: null,
		desiredState: "stopped",
		workloadRevision: 0,
		fence: 0,
		ownerIds: ["owner_01", "owner_02"],
		availability: [{ kind: "organization", organizationId: "organization_01" }],
		failureCode: null,
	},
	configuration: agentConfigurationConformanceRecordV1,
	authorizationRevision: "authorization_9",
};

export const applicationRevisionCommandV1: ReviseApplicationCommandV1 = {
	schemaVersion: 1,
	idempotencyKey: "application-revision-01",
	requestId: "request_01",
	traceId: "trace_01",
	name: "Operations Assistant v2",
	description: "Assists with operational workflows",
	coOwnerIds: ["owner_02"],
	availability: [{ kind: "organization", organizationId: "organization_01" }],
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
	environment: [{ name: "LOG_LEVEL", value: "debug" }],
	secrets: [],
	actions: [],
	channels: [],
};

export const applicationRevisionActorContextV1: ApplicationRevisionActorContextV1 =
	{
		schemaVersion: 1,
		applicationId: "application_01",
		userId: "owner_01",
		accountStatus: "active",
		organizationIds: ["organization_01"],
		isAdministrator: false,
		rawRequestDigest: "0".repeat(64),
	};

export function applicationRevisionAdmissionsV1(
	state: ApplicationRevisionReadStateV1 = applicationRevisionStateV1,
): Omit<AgentConfigurationUseCaseDependenciesV1, "transaction"> {
	const admissions = new FakeAgentConfigurationAdmissionsV1({
		authorizations: [
			{
				agentId: state.application.agentId,
				actorId: state.application.applicantId,
				authorizationRevision: "authorization_10",
				accessAuthority: {
					state: state.management,
					actorContext: {
						schemaVersion: 1,
						userId: state.application.applicantId,
						accountStatus: "active",
						organizationIds: ["organization_01"],
						isAdministrator: false,
					},
					authorityContext: {
						schemaVersion: 1,
						users: [
							{ userId: "owner_01", accountStatus: "active" },
							{ userId: "owner_02", accountStatus: "active" },
						],
						organizationIds: ["organization_01"],
					},
				},
			},
		],
		models: [
			{
				endpointId: "endpoint_01",
				modelId: "gpt-5",
				reasoningLevels: ["low"],
				catalogRevision: "catalog_3",
			},
		],
		modelCredentials: [],
		images: [
			{
				selection: { kind: "standard", templateId: "template_01" },
				source: state.configuration.source,
			},
		],
		secretReplacements: [
			{
				requestId: "request_01",
				name: "BOT_TOKEN",
				secretId: "secret_bot_token",
				version: 2,
			},
		],
		actions: [],
		actionSetRevision: "actions_1",
		channelBindings: [],
		channelRevision: "channels_1",
	});
	return {
		authorizationAdmission: admissions,
		imageAdmission: admissions,
		modelAdmission: admissions,
		secretAdmission: admissions,
		actionAdmission: admissions,
		channelAdmission: admissions,
	};
}

export interface ApplicationRevisionConformanceHarnessV1 {
	readonly transaction: ApplicationRevisionTransactionPortV1;
	snapshot(): Promise<ApplicationRevisionFakeSnapshotV1>;
	failNextBefore(point: ApplicationRevisionFailurePoint): Promise<void> | void;
	advanceManagementRevision(): Promise<void> | void;
	advanceConfigurationRevision(): Promise<void> | void;
	setAuthorizationRevision(revision: string): Promise<void> | void;
	close(): Promise<void>;
}

function useCase(
	transaction: ApplicationRevisionTransactionPortV1,
	state = applicationRevisionStateV1,
	overrides: Partial<
		Omit<ApplicationRevisionUseCaseDependenciesV1, "transaction">
	> = {},
) {
	return createApplicationRevisionUseCaseV1(
		{
			transaction,
			...applicationRevisionAdmissionsV1(state),
			...overrides,
		},
		{ now: () => new Date(serverInstant) },
	);
}

function stateWithExistingSecretAndChannel(): ApplicationRevisionReadStateV1 {
	return {
		...applicationRevisionStateV1,
		configuration: {
			...applicationRevisionStateV1.configuration,
			secrets: [
				{
					name: "BOT_TOKEN",
					secretId: "secret_existing",
					isSet: true,
					version: 2,
				},
			],
			channels: [
				{
					kind: "wecom_bot",
					bindingReference: "binding_existing",
				},
			],
			channelRevision: "channels_existing",
		},
	};
}

function commandWithoutSecretOrChannel(): ReviseApplicationCommandV1 {
	const {
		secrets: _secrets,
		channels: _channels,
		...command
	} = applicationRevisionCommandV1;
	return command;
}

export function applicationRevisionTransactionConformance(
	createHarness: (
		state?: ApplicationRevisionReadStateV1,
	) => Promise<ApplicationRevisionConformanceHarnessV1>,
): void {
	it("preserves secret metadata and channel bindings when revision fields are omitted", async () => {
		const state = stateWithExistingSecretAndChannel();
		const command = commandWithoutSecretOrChannel();
		const harness = await createHarness(state);
		try {
			await expect(
				useCase(harness.transaction, state).revise(
					command,
					applicationRevisionActorContextV1,
				),
			).resolves.toMatchObject({ configurationRevision: 8 });
			expect((await harness.snapshot()).state.configuration).toMatchObject({
				secrets: [
					{
						name: "BOT_TOKEN",
						secretId: "secret_existing",
						isSet: true,
						version: 2,
					},
				],
				channels: [
					{
						kind: "wecom_bot",
						bindingReference: "binding_existing",
					},
				],
				channelRevision: "channels_existing",
			});
		} finally {
			await harness.close();
		}
	});

	it("does not invent a configuration revision for omitted revision fields", async () => {
		const state = stateWithExistingSecretAndChannel();
		const command: ReviseApplicationCommandV1 = {
			...commandWithoutSecretOrChannel(),
			environment: state.configuration.environment,
		};
		const harness = await createHarness(state);
		try {
			await expect(
				useCase(harness.transaction, state).revise(
					command,
					applicationRevisionActorContextV1,
				),
			).resolves.toMatchObject({ configurationRevision: 7 });
			expect(await harness.snapshot()).toMatchObject({
				outboxCount: 1,
				auditCount: 1,
				lastPlan: { configuration: null },
				state: {
					configuration: {
						revision: 7,
						secrets: [
							{
								name: "BOT_TOKEN",
								secretId: "secret_existing",
								isSet: true,
								version: 2,
							},
						],
						channels: [
							{
								kind: "wecom_bot",
								bindingReference: "binding_existing",
							},
						],
						channelRevision: "channels_existing",
					},
				},
			});
		} finally {
			await harness.close();
		}
	});

	it("atomically revises application content, configuration and management", async () => {
		const harness = await createHarness();
		try {
			await expect(
				useCase(harness.transaction).revise(
					applicationRevisionCommandV1,
					applicationRevisionActorContextV1,
				),
			).resolves.toEqual({
				schemaVersion: 1,
				applicationId: "application_01",
				agentId: "agent_01",
				status: "pending_approval",
				managementRevision: 4,
				configurationRevision: 8,
			});
			const snapshot = await harness.snapshot();
			expect(snapshot).toMatchObject({
				commitCount: 1,
				idempotencyCount: 1,
				outboxCount: 2,
				auditCount: 2,
				state: {
					application: { name: "Operations Assistant v2" },
					management: { status: "pending_approval", revision: 4 },
					configuration: {
						revision: 8,
						environment: [{ name: "LOG_LEVEL", value: "debug" }],
					},
					authorizationRevision: "authorization_10",
				},
			});
			expect(snapshot.lastPlan).toMatchObject({
				expected: {
					managementRevision: 3,
					configurationRevision: 7,
					authorizationRevision: "authorization_9",
				},
				nextAuthorizationRevision: "authorization_10",
				management: {
					operation: "update_application",
					auditEvent: { action: "agent.application.updated" },
				},
				configuration: {
					auditEvent: { action: "agent.configuration.revised" },
				},
			});
		} finally {
			await harness.close();
		}
	});

	it("resubmits rejected content without inventing a configuration revision", async () => {
		const rejected: ApplicationRevisionReadStateV1 = {
			...applicationRevisionStateV1,
			management: {
				...applicationRevisionStateV1.management,
				status: "rejected",
				decisionReason: "Capacity unavailable",
			},
		};
		const harness = await createHarness(rejected);
		const unchanged = {
			...applicationRevisionCommandV1,
			name: rejected.application.name,
			environment: rejected.configuration.environment,
		};
		try {
			await expect(
				useCase(harness.transaction, rejected).revise(
					unchanged,
					applicationRevisionActorContextV1,
				),
			).resolves.toMatchObject({
				status: "pending_approval",
				managementRevision: 4,
				configurationRevision: 7,
			});
			const snapshot = await harness.snapshot();
			expect(snapshot).toMatchObject({
				outboxCount: 1,
				auditCount: 1,
				state: {
					management: {
						status: "pending_approval",
						decisionReason: null,
					},
					configuration: { revision: 7 },
					authorizationRevision: "authorization_10",
				},
				lastPlan: {
					configuration: null,
					auditEvent: { action: "agent.application.resubmitted" },
				},
			});
		} finally {
			await harness.close();
		}
	});

	it("replays exactly and conflicts on a changed digest without side effects", async () => {
		const harness = await createHarness();
		const revision = useCase(harness.transaction);
		try {
			const first = await revision.revise(
				applicationRevisionCommandV1,
				applicationRevisionActorContextV1,
			);
			const committed = await harness.snapshot();
			await expect(
				revision.revise(
					applicationRevisionCommandV1,
					applicationRevisionActorContextV1,
				),
			).resolves.toEqual(first);
			await expect(harness.snapshot()).resolves.toEqual(committed);
			await expect(
				revision.revise(applicationRevisionCommandV1, {
					...applicationRevisionActorContextV1,
					rawRequestDigest: "1".repeat(64),
				}),
			).rejects.toMatchObject({ code: "idempotency_conflict" });
			await expect(harness.snapshot()).resolves.toEqual(committed);
		} finally {
			await harness.close();
		}
	});

	it("accepts an unchanged current authorization revision", async () => {
		const harness = await createHarness();
		const base = applicationRevisionAdmissionsV1();
		try {
			await expect(
				useCase(harness.transaction, applicationRevisionStateV1, {
					...base,
					authorizationAdmission: {
						async authorize(input) {
							const decision =
								await base.authorizationAdmission.authorize(input);
							return decision.status === "admitted"
								? {
										...decision,
										authorizationRevision: "authorization_9",
									}
								: decision;
						},
					},
				}).revise(
					applicationRevisionCommandV1,
					applicationRevisionActorContextV1,
				),
			).resolves.toMatchObject({ configurationRevision: 8 });
			expect((await harness.snapshot()).state.authorizationRevision).toBe(
				"authorization_9",
			);
		} finally {
			await harness.close();
		}
	});

	it("replays across an admitted authorization revision change but denies revocation", async () => {
		const harness = await createHarness();
		try {
			const original = await useCase(harness.transaction).revise(
				applicationRevisionCommandV1,
				applicationRevisionActorContextV1,
			);
			await harness.setAuthorizationRevision("authorization_11");
			const afterDrift = await harness.snapshot();
			await expect(
				useCase(harness.transaction).revise(
					applicationRevisionCommandV1,
					applicationRevisionActorContextV1,
				),
			).resolves.toEqual(original);
			await expect(harness.snapshot()).resolves.toEqual(afterDrift);

			const base = applicationRevisionAdmissionsV1();
			await expect(
				useCase(harness.transaction, applicationRevisionStateV1, {
					...base,
					authorizationAdmission: {
						async authorize(input) {
							return {
								schemaVersion: 1,
								status: "rejected",
								agentId: input.agentId,
								actorId: input.actorId,
							};
						},
					},
				}).revise(
					applicationRevisionCommandV1,
					applicationRevisionActorContextV1,
				),
			).rejects.toMatchObject({ code: "not_authorized" });
			await expect(harness.snapshot()).resolves.toEqual(afterDrift);
		} finally {
			await harness.close();
		}
	});

	it("keeps missing, cross-user and invalid-state resources indistinguishable", async () => {
		for (const [state, context] of [
			[
				applicationRevisionStateV1,
				{ ...applicationRevisionActorContextV1, userId: "other_user" },
			],
			[
				applicationRevisionStateV1,
				{ ...applicationRevisionActorContextV1, applicationId: "missing" },
			],
			[
				{
					...applicationRevisionStateV1,
					management: {
						...applicationRevisionStateV1.management,
						status: "withdrawn" as const,
					},
				},
				applicationRevisionActorContextV1,
			],
		] as const) {
			const harness = await createHarness(state);
			try {
				await expect(
					useCase(harness.transaction, state).revise(
						applicationRevisionCommandV1,
						context,
					),
				).rejects.toMatchObject({ code: "not_authorized" });
				expect((await harness.snapshot()).commitCount).toBe(0);
			} finally {
				await harness.close();
			}
		}
	});

	it("rejects every admission denial without partial state", async () => {
		for (const kind of [
			"authorization",
			"imageAdmission",
			"modelAdmission",
			"secretAdmission",
			"actionAdmission",
			"channelAdmission",
		] as const) {
			const harness = await createHarness();
			const base = applicationRevisionAdmissionsV1();
			const rejected = {
				...base,
				...(kind === "authorization"
					? {
							authorizationAdmission: {
								authorize: async (input: {
									agentId: string;
									actorId: string;
								}) => ({
									schemaVersion: 1 as const,
									status: "rejected" as const,
									agentId: input.agentId,
									actorId: input.actorId,
								}),
							},
						}
					: {
							[kind]: {
								[kind === "imageAdmission"
									? "admitImage"
									: kind === "modelAdmission"
										? "admitModels"
										: kind === "secretAdmission"
											? "admitSecrets"
											: kind === "actionAdmission"
												? "admitActions"
												: "admitChannels"]: async (input: {
									agentId: string;
									requestId: string;
								}) => ({
									schemaVersion: 1,
									status: "rejected",
									agentId: input.agentId,
									requestId: input.requestId,
								}),
							},
						}),
			} as unknown as Omit<
				ApplicationRevisionUseCaseDependenciesV1,
				"transaction"
			>;
			const command =
				kind === "secretAdmission"
					? {
							...applicationRevisionCommandV1,
							secrets: [{ name: "BOT_TOKEN", replace: true as const }],
						}
					: applicationRevisionCommandV1;
			try {
				await expect(
					createApplicationRevisionUseCaseV1(
						{ transaction: harness.transaction, ...rejected },
						{ now: () => new Date(serverInstant) },
					).revise(command, applicationRevisionActorContextV1),
				).rejects.toEqual(expect.any(ApplicationRevisionError));
				expect((await harness.snapshot()).commitCount).toBe(0);
			} finally {
				await harness.close();
			}
		}
	});

	for (const [advance, code] of [
		["advanceManagementRevision", "stale_revision"],
		["advanceConfigurationRevision", "stale_revision"],
		["setAuthorizationRevision", "stale_revision"],
	] as const) {
		it(`rejects ${advance} between read and commit`, async () => {
			const harness = await createHarness();
			let advanced = false;
			const transaction: ApplicationRevisionTransactionPortV1 = {
				read: (input) => harness.transaction.read(input),
				async commit(plan) {
					if (!advanced) {
						advanced = true;
						if (advance === "setAuthorizationRevision") {
							await harness.setAuthorizationRevision(
								"authorization_concurrent",
							);
						} else {
							await harness[advance]();
						}
					}
					return harness.transaction.commit(plan);
				},
			};
			try {
				await expect(
					useCase(transaction).revise(
						applicationRevisionCommandV1,
						applicationRevisionActorContextV1,
					),
				).rejects.toMatchObject({ code });
				expect((await harness.snapshot()).commitCount).toBe(0);
			} finally {
				await harness.close();
			}
		});
	}

	for (const point of applicationRevisionFailurePoints) {
		it(`rolls back all revision writes when ${point} fails`, async () => {
			const harness = await createHarness();
			try {
				const before = await harness.snapshot();
				await harness.failNextBefore(point);
				await expect(
					useCase(harness.transaction).revise(
						applicationRevisionCommandV1,
						applicationRevisionActorContextV1,
					),
				).rejects.toMatchObject({ code: "persistence_failed" });
				await expect(harness.snapshot()).resolves.toEqual(before);
			} finally {
				await harness.close();
			}
		});
	}
}
