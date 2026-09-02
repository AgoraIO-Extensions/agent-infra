import { expect, it } from "vitest";

import type {
	AgentConfigurationRecordV1,
	AgentConfigurationSourceSelectionV1,
	AgentConfigurationUseCaseDependenciesV1,
	AgentConfigurationUseCaseV1,
	AgentConfigurationWritePlanV1,
} from "./agent-configuration.ts";
import { FakeAgentConfigurationAdmissionsV1 } from "./fake-agent-configuration.ts";

const imageDigest = `sha256:${"a".repeat(64)}`;

export const agentConfigurationConformanceRecordV1: AgentConfigurationRecordV1 =
	{
		schemaVersion: 1,
		agentId: "agent_01",
		revision: 7,
		source: {
			kind: "standard",
			templateId: "template_01",
			imageDigest,
			admissionRevision: "image_policy_7",
			allowedEnvironmentKeys: ["LOG_LEVEL"],
			allowedSecretKeys: ["BOT_TOKEN", "MODEL_API_KEY"],
			platformManagedKeys: ["MODEL_API_KEY"],
			connectionEnabled: true,
		},
		modelConfiguration: {
			catalogRevision: "catalog_3",
			options: [
				{
					optionId: "model_primary",
					endpointId: "endpoint_01",
					modelId: "gpt-5",
					reasoningLevels: ["low"],
					credential: {
						secretId: "secret_model_primary",
						version: 1,
						isSet: true,
					},
				},
			],
			defaultOptionId: "model_primary",
			defaultReasoningLevel: "low",
		},
		actions: [],
		actionSetRevision: "actions_1",
		environment: [{ name: "LOG_LEVEL", value: "info" }],
		secrets: [],
		channels: [],
		channelRevision: "channels_1",
	};

export const agentConfigurationConformanceAdmissionsV1 = {
	authorizations: [
		{
			agentId: "agent_01",
			actorId: "owner_01",
			authorizationRevision: "authorization_9",
		},
	],
	models: [
		{
			endpointId: "endpoint_01",
			modelId: "gpt-5",
			reasoningLevels: ["low", "medium"],
			catalogRevision: "catalog_4",
		},
	],
	modelCredentials: [
		{
			requestId: "request_01",
			optionId: "model_primary",
			secretId: "secret_model_primary",
			version: 2,
		},
	],
	images: [
		{
			selection: { kind: "standard" as const, templateId: "template_01" },
			source: agentConfigurationConformanceRecordV1.source,
		},
	],
	secretReplacements: [
		{
			requestId: "request_01",
			name: "BOT_TOKEN",
			secretId: "secret_bot_token",
			version: 3,
		},
	],
	actions: [
		{
			providerId: "github",
			actionId: "issues.read",
			actionVersion: "v3",
		},
	],
	actionSetRevision: "actions_2",
	channelBindings: [
		{ kind: "wecom_bot" as const, bindingReference: "binding_01" },
	],
	channelRevision: "channels_2",
};

export interface AgentConfigurationConformanceSnapshotV1 {
	readonly configuration: AgentConfigurationRecordV1;
	readonly authorizationRevision: string;
	readonly commitCount: number;
	readonly lastPlan: AgentConfigurationWritePlanV1 | null;
	readonly idempotencyCount: number;
	readonly outboxCount: number;
	readonly auditCount: number;
}

export interface AgentConfigurationConformanceHarnessV1 {
	readonly useCase: AgentConfigurationUseCaseV1;
	useCaseWithDependencies(
		overrides: Partial<AgentConfigurationUseCaseDependenciesV1>,
	): AgentConfigurationUseCaseV1;
	snapshot(): Promise<AgentConfigurationConformanceSnapshotV1>;
	failNextCommitAsStale(): Promise<void> | void;
	close(): Promise<void>;
}

export interface AgentConfigurationCustomImageUpgradeHarnessV1
	extends AgentConfigurationConformanceHarnessV1 {
	failNextCommit(): Promise<void> | void;
}

type CustomImageSourceV1 = Extract<
	AgentConfigurationRecordV1["source"],
	{ kind: "custom" }
>;
type CustomImageSelectionV1 = Extract<
	AgentConfigurationSourceSelectionV1,
	{ kind: "custom" }
>;

const agentConfigurationCustomImageSourceV1: CustomImageSourceV1 = {
	kind: "custom",
	imageDigest: `sha256:${"b".repeat(64)}`,
	admissionRevision: "image_policy_custom_1",
	interactionMode: "self-managed",
	identityResponsibility: "platform-managed",
	connectionEnabled: false,
};

export const agentConfigurationCustomImageRecordV1: AgentConfigurationRecordV1 =
	{
		...agentConfigurationConformanceRecordV1,
		source: agentConfigurationCustomImageSourceV1,
		modelConfiguration: null,
	};

const upgradedImageDigest = `sha256:${"c".repeat(64)}`;

export function agentConfigurationCustomImageUpgradeConformance(
	createHarness: (input: {
		record: AgentConfigurationRecordV1;
		selection: CustomImageSelectionV1;
		source: CustomImageSourceV1;
	}) => Promise<AgentConfigurationCustomImageUpgradeHarnessV1>,
): void {
	const upgrade = {
		schemaVersion: 1 as const,
		agentId: "agent_01",
		imageReference: "registry.example/agent:v2",
		idempotencyKey: "custom-image-upgrade-01",
		requestId: "request_image_upgrade_01",
		traceId: "trace_image_upgrade_01",
	};

	const customSource = agentConfigurationCustomImageSourceV1;
	for (const currentSource of [
		customSource,
		{
			kind: "custom" as const,
			imageDigest: customSource.imageDigest,
			admissionRevision: customSource.admissionRevision,
			interactionMode: "platform-adapter" as const,
			connectionEnabled: customSource.connectionEnabled,
		},
	]) {
		it(`upgrades only the admitted image and preserves ${currentSource.interactionMode} mode`, async () => {
			const selection: CustomImageSelectionV1 =
				currentSource.interactionMode === "self-managed"
					? {
							kind: "custom",
							imageReference: upgrade.imageReference,
							interactionMode: "self-managed",
							identityResponsibility:
								currentSource.identityResponsibility ?? "self-managed",
						}
					: {
							kind: "custom",
							imageReference: upgrade.imageReference,
							interactionMode: "platform-adapter",
						};
			const source = {
				...currentSource,
				imageDigest: upgradedImageDigest,
				admissionRevision: "image_policy_custom_2",
			};
			const harness = await createHarness({
				record: {
					...agentConfigurationCustomImageRecordV1,
					source: currentSource,
				},
				selection,
				source,
			});
			try {
				const first = await harness.useCase.upgradeCustomImage(upgrade, actor);
				expect(first).toEqual({
					schemaVersion: 1,
					agentId: "agent_01",
					revision: 8,
					changedFields: ["source"],
				});
				expect(await harness.snapshot()).toMatchObject({
					configuration: { revision: 8, source },
					commitCount: 1,
					idempotencyCount: 1,
					outboxCount: 1,
					auditCount: 1,
					lastPlan: {
						baseRevision: 7,
						nextRevision: 8,
						result: first,
					},
				});
				await expect(
					harness.useCase.upgradeCustomImage(upgrade, actor),
				).resolves.toEqual(first);
				expect(await harness.snapshot()).toMatchObject({ commitCount: 1 });
			} finally {
				await harness.close();
			}
		});
	}

	it("rejects standard Agents, unchanged images, and stale commits without effects", async () => {
		for (const scenario of ["standard", "unchanged", "stale"] as const) {
			const currentSource =
				scenario === "standard"
					? agentConfigurationConformanceRecordV1.source
					: agentConfigurationCustomImageSourceV1;
			const selection = {
				kind: "custom" as const,
				imageReference: upgrade.imageReference,
				interactionMode: "self-managed" as const,
				identityResponsibility: "platform-managed" as const,
			};
			const source = {
				...agentConfigurationCustomImageSourceV1,
				...(scenario === "unchanged"
					? {}
					: {
							imageDigest: upgradedImageDigest,
							admissionRevision: "image_policy_custom_2",
						}),
			};
			const harness = await createHarness({
				record: {
					...(scenario === "standard"
						? agentConfigurationConformanceRecordV1
						: agentConfigurationCustomImageRecordV1),
					source: currentSource,
				},
				selection,
				source,
			});
			try {
				if (scenario === "stale") await harness.failNextCommitAsStale();
				await expect(
					harness.useCase.upgradeCustomImage(
						{ ...upgrade, idempotencyKey: `custom-image-${scenario}` },
						actor,
					),
				).rejects.toMatchObject({
					code:
						scenario === "standard"
							? "not_admitted"
							: scenario === "unchanged"
								? "no_change"
								: "stale_revision",
				});
				expect(await harness.snapshot()).toMatchObject({
					commitCount: 0,
					idempotencyCount: 0,
					outboxCount: 0,
					auditCount: 0,
					lastPlan: null,
				});
			} finally {
				await harness.close();
			}
		}
	});

	it("reauthorizes before interpreting the current source", async () => {
		const selection = {
			kind: "custom" as const,
			imageReference: upgrade.imageReference,
			interactionMode: "self-managed" as const,
			identityResponsibility: "platform-managed" as const,
		};
		const harness = await createHarness({
			record: agentConfigurationConformanceRecordV1,
			selection,
			source: {
				...agentConfigurationCustomImageSourceV1,
				imageDigest: upgradedImageDigest,
				admissionRevision: "image_policy_custom_2",
			},
		});
		let authorizationCalls = 0;
		let imageAdmissionCalls = 0;
		const useCase = harness.useCaseWithDependencies({
			authorizationAdmission: {
				async authorize(input) {
					authorizationCalls += 1;
					return authorizationCalls === 1
						? {
								schemaVersion: 1 as const,
								status: "admitted" as const,
								agentId: input.agentId,
								actorId: input.actorId,
								authorizationRevision: "authorization_10",
							}
						: {
								schemaVersion: 1 as const,
								status: "rejected" as const,
								agentId: input.agentId,
								actorId: input.actorId,
							};
				},
			},
			imageAdmission: {
				async admitImage() {
					imageAdmissionCalls += 1;
					throw new Error("must not admit after revocation");
				},
			},
		});
		try {
			await expect(
				useCase.upgradeCustomImage(upgrade, actor),
			).rejects.toMatchObject({ code: "not_authorized" });
			expect(authorizationCalls).toBe(2);
			expect(imageAdmissionCalls).toBe(0);
			expect(await harness.snapshot()).toMatchObject({
				commitCount: 0,
				idempotencyCount: 0,
				outboxCount: 0,
				auditCount: 0,
				lastPlan: null,
			});
		} finally {
			await harness.close();
		}
	});

	it("rejects image admissions that change non-image source policy", async () => {
		const selection = {
			kind: "custom" as const,
			imageReference: upgrade.imageReference,
			interactionMode: "self-managed" as const,
			identityResponsibility: "platform-managed" as const,
		};
		const source = {
			...agentConfigurationCustomImageSourceV1,
			imageDigest: upgradedImageDigest,
			admissionRevision: "image_policy_custom_2",
		};
		const harness = await createHarness({
			record: agentConfigurationCustomImageRecordV1,
			selection,
			source,
		});
		const useCase = harness.useCaseWithDependencies({
			imageAdmission: {
				async admitImage(input) {
					return {
						schemaVersion: 1 as const,
						status: "admitted" as const,
						agentId: input.agentId,
						requestId: input.requestId,
						source: { ...source, connectionEnabled: true },
					};
				},
			},
		});
		try {
			await expect(
				useCase.upgradeCustomImage(upgrade, actor),
			).rejects.toMatchObject({ code: "not_admitted" });
			expect(await harness.snapshot()).toMatchObject({
				commitCount: 0,
				idempotencyCount: 0,
				outboxCount: 0,
				auditCount: 0,
				lastPlan: null,
			});
		} finally {
			await harness.close();
		}
	});

	it("hides missing and unauthorized Agents and rolls back dependency failures", async () => {
		const selection = {
			kind: "custom" as const,
			imageReference: upgrade.imageReference,
			interactionMode: "self-managed" as const,
			identityResponsibility: "platform-managed" as const,
		};
		const source = {
			...agentConfigurationCustomImageSourceV1,
			imageDigest: upgradedImageDigest,
			admissionRevision: "image_policy_custom_2",
		};
		const harness = await createHarness({
			record: agentConfigurationCustomImageRecordV1,
			selection,
			source,
		});
		try {
			const missing = harness.useCaseWithDependencies({
				transaction: {
					async read() {
						return { outcome: "missing" };
					},
					async commit() {
						throw new Error("must not commit");
					},
				},
			});
			const unauthorized = harness.useCaseWithDependencies({
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
			});
			for (const useCase of [missing, unauthorized]) {
				await expect(
					useCase.upgradeCustomImage(upgrade, actor),
				).rejects.toMatchObject({ code: "not_authorized" });
			}

			await harness.failNextCommit();
			await expect(
				harness.useCase.upgradeCustomImage(
					{ ...upgrade, idempotencyKey: "custom-image-rollback" },
					actor,
				),
			).rejects.toMatchObject({ code: "persistence_failed" });
			expect(await harness.snapshot()).toMatchObject({
				commitCount: 0,
				idempotencyCount: 0,
				outboxCount: 0,
				auditCount: 0,
				lastPlan: null,
			});
		} finally {
			await harness.close();
		}
	});

	it("conflicts when one image-upgrade key is reused for another request", async () => {
		const selection = {
			kind: "custom" as const,
			imageReference: upgrade.imageReference,
			interactionMode: "self-managed" as const,
			identityResponsibility: "platform-managed" as const,
		};
		const harness = await createHarness({
			record: agentConfigurationCustomImageRecordV1,
			selection,
			source: {
				...agentConfigurationCustomImageSourceV1,
				imageDigest: upgradedImageDigest,
				admissionRevision: "image_policy_custom_2",
			},
		});
		try {
			await harness.useCase.upgradeCustomImage(upgrade, actor);
			await expect(
				harness.useCase.upgradeCustomImage(
					{ ...upgrade, imageReference: "registry.example/agent:v3" },
					actor,
				),
			).rejects.toMatchObject({ code: "idempotency_conflict" });
			expect(await harness.snapshot()).toMatchObject({
				commitCount: 1,
				idempotencyCount: 1,
				outboxCount: 1,
				auditCount: 1,
			});
		} finally {
			await harness.close();
		}
	});
}

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

export function agentConfigurationUseCaseConformance(
	createHarness: () => Promise<AgentConfigurationConformanceHarnessV1>,
): void {
	it("commits one canonical, sanitized configuration revision", async () => {
		const harness = await createHarness();
		try {
			await expect(
				harness.useCase.update(
					{
						...command,
						changes: {
							modelConfiguration: {
								options: [
									{
										optionId: "model_primary",
										endpointId: "endpoint_01",
										modelId: "gpt-5",
										reasoningLevels: ["medium", "low"],
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
						},
					},
					actor,
				),
			).resolves.toEqual({
				schemaVersion: 1,
				agentId: "agent_01",
				revision: 8,
				changedFields: [
					"actions",
					"channels",
					"environment",
					"modelConfiguration",
					"secrets",
				],
			});
			const snapshot = await harness.snapshot();
			expect(snapshot.commitCount).toBe(1);
			expect(snapshot.configuration).toMatchObject({
				revision: 8,
				environment: [{ name: "LOG_LEVEL", value: "debug" }],
				secrets: [{ name: "BOT_TOKEN", isSet: true, version: 3 }],
				actionSetRevision: "actions_2",
				channelRevision: "channels_2",
				modelConfiguration: {
					catalogRevision: "catalog_4",
					defaultReasoningLevel: "medium",
					options: [{ reasoningLevels: ["low", "medium"] }],
				},
			});
			expect(snapshot.lastPlan).toMatchObject({
				baseRevision: 7,
				nextRevision: 8,
				expectedAuthorizationRevision: "authorization_9",
				nextAuthorizationRevision: "authorization_9",
				outboxIntent: {
					payload: {
						agentId: "agent_01",
						configurationRevision: 8,
					},
				},
				auditEvent: {
					actorId: "owner_01",
					action: "agent.configuration.revised",
				},
			});
			expect(snapshot.lastPlan?.outboxIntent).not.toHaveProperty("secrets");
			expect(snapshot.lastPlan?.auditEvent).not.toHaveProperty("secrets");
		} finally {
			await harness.close();
		}
	});

	it("advances authorization with fresh writes and preserves earlier replays", async () => {
		const harness = await createHarness();
		try {
			const authorizationAt = (authorizationRevision: string) =>
				new FakeAgentConfigurationAdmissionsV1({
					...agentConfigurationConformanceAdmissionsV1,
					authorizations: [
						{
							agentId: "agent_01",
							actorId: "owner_01",
							authorizationRevision,
						},
					],
				});
			const firstCommand = {
				...command,
				idempotencyKey: "authorization-advance-10",
				changes: { environment: [{ name: "LOG_LEVEL", value: "debug" }] },
			};
			const firstUseCase = harness.useCaseWithDependencies({
				authorizationAdmission: authorizationAt("authorization_10"),
			});
			const first = await firstUseCase.update(firstCommand, actor);
			expect(await harness.snapshot()).toMatchObject({
				authorizationRevision: "authorization_10",
				commitCount: 1,
				lastPlan: {
					expectedAuthorizationRevision: "authorization_9",
					nextAuthorizationRevision: "authorization_10",
				},
			});

			const currentAuthorization = authorizationAt("authorization_11");
			await harness
				.useCaseWithDependencies({
					authorizationAdmission: currentAuthorization,
				})
				.update(
					{
						...command,
						idempotencyKey: "authorization-advance-11",
						changes: { environment: [{ name: "LOG_LEVEL", value: "warn" }] },
					},
					actor,
				);
			const later = await harness.snapshot();
			expect(later).toMatchObject({
				authorizationRevision: "authorization_11",
				commitCount: 2,
				idempotencyCount: 2,
				outboxCount: 2,
				auditCount: 2,
			});
			await expect(
				harness
					.useCaseWithDependencies({
						authorizationAdmission: currentAuthorization,
					})
					.update(firstCommand, actor),
			).resolves.toEqual(first);
			expect(await harness.snapshot()).toEqual(later);

			await expect(
				harness
					.useCaseWithDependencies({
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
					})
					.update(firstCommand, actor),
			).rejects.toEqual(expect.objectContaining({ code: "not_authorized" }));
			expect(await harness.snapshot()).toEqual(later);
		} finally {
			await harness.close();
		}
	});

	it("creates no effects for empty, equivalent, malformed, or partial updates", async () => {
		const harness = await createHarness();
		try {
			for (const changes of [
				{},
				{ environment: [{ name: "LOG_LEVEL", value: "info" }] },
				{
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
				{
					environment: [{ name: "LOG_LEVEL", value: "debug" }],
					secrets: [{ name: "UNDECLARED_TOKEN", replace: true as const }],
				},
			]) {
				await expect(
					harness.useCase.update({ ...command, changes }, actor),
				).rejects.toEqual(
					expect.objectContaining({
						code: "secrets" in changes ? "not_admitted" : "no_change",
					}),
				);
			}
			await expect(
				harness.useCase.update(
					{ ...command, changes: {}, baseRevision: 7 } as never,
					actor,
				),
			).rejects.toEqual(expect.objectContaining({ code: "invalid_command" }));
			await expect(
				harness.useCase.update(
					{
						...command,
						authorizationRevision: "caller_revision",
						changes: { environment: [{ name: "LOG_LEVEL", value: "debug" }] },
					} as never,
					actor,
				),
			).rejects.toEqual(expect.objectContaining({ code: "invalid_command" }));
			const snapshot = await harness.snapshot();
			expect(snapshot.commitCount).toBe(0);
			expect(snapshot.idempotencyCount).toBe(0);
			expect(snapshot.lastPlan).toBeNull();
		} finally {
			await harness.close();
		}
	});

	it("rejects a stale base revision when conditional commit sees newer state", async () => {
		const harness = await createHarness();
		try {
			await harness.failNextCommitAsStale();
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
			).rejects.toEqual(expect.objectContaining({ code: "stale_revision" }));
			const snapshot = await harness.snapshot();
			expect(snapshot.commitCount).toBe(0);
			expect(snapshot.idempotencyCount).toBe(0);
			expect(snapshot.lastPlan).toBeNull();
		} finally {
			await harness.close();
		}
	});

	it("replays one Agent-actor-key digest and rejects conflicting reuse", async () => {
		const harness = await createHarness();
		try {
			const idempotent = {
				...command,
				idempotencyKey: "configuration-update-01",
				changes: {
					environment: [{ name: "LOG_LEVEL", value: "debug" }],
				},
			};
			const first = await harness.useCase.update(idempotent, actor);
			await expect(harness.useCase.update(idempotent, actor)).resolves.toEqual(
				first,
			);
			let snapshot = await harness.snapshot();
			expect(snapshot.commitCount).toBe(1);
			expect(snapshot.idempotencyCount).toBe(1);
			expect(snapshot.lastPlan).toMatchObject({
				idempotency: {
					key: "configuration-update-01",
					requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
				},
				result: first,
			});

			await expect(
				harness.useCase.update(
					{
						...idempotent,
						changes: {
							environment: [{ name: "LOG_LEVEL", value: "warn" }],
						},
					} as never,
					actor,
				),
			).rejects.toEqual(
				expect.objectContaining({ code: "idempotency_conflict" }),
			);
			snapshot = await harness.snapshot();
			expect(snapshot.commitCount).toBe(1);
			await expect(
				harness.useCase.update(idempotent, {
					schemaVersion: 1,
					actorId: "other_owner",
					rawRequestDigest: "0".repeat(64),
				}),
			).rejects.toEqual(expect.objectContaining({ code: "not_authorized" }));
			expect((await harness.snapshot()).commitCount).toBe(1);
		} finally {
			await harness.close();
		}
	});

	it("denies cross-Agent state and rejects mismatched admission envelopes without effects", async () => {
		const harness = await createHarness();
		try {
			await expect(
				harness.useCase.update(
					{
						...command,
						agentId: "agent_other",
						changes: {
							environment: [{ name: "LOG_LEVEL", value: "debug" }],
						},
					},
					actor,
				),
			).rejects.toEqual(expect.objectContaining({ code: "not_authorized" }));

			const model = agentConfigurationConformanceRecordV1.modelConfiguration;
			if (!model) throw new Error("Conformance model fixture is required");
			const admittedImage = new FakeAgentConfigurationAdmissionsV1(
				agentConfigurationConformanceAdmissionsV1,
			);
			await expect(
				harness
					.useCaseWithDependencies({ imageAdmission: admittedImage })
					.update(
						{
							...command,
							idempotencyKey: "admitted-image-correlation-control",
							changes: {
								source: { kind: "standard", templateId: "template_01" },
							},
						},
						actor,
					),
			).rejects.toEqual(expect.objectContaining({ code: "no_change" }));
			const attacks = [
				[
					"authorization",
					{ environment: [{ name: "LOG_LEVEL", value: "debug" }] },
					"not_authorized",
				],
				[
					"image",
					{ source: { kind: "standard", templateId: "template_01" } },
					"not_admitted",
				],
				[
					"model",
					{
						modelConfiguration: {
							options: model.options.map((option) => ({
								optionId: option.optionId,
								endpointId: option.endpointId,
								modelId: option.modelId,
								reasoningLevels: option.reasoningLevels,
								replaceCredential: false,
							})),
							defaultOptionId: model.defaultOptionId,
							defaultReasoningLevel: model.defaultReasoningLevel,
						},
					},
					"not_admitted",
				],
				[
					"secret",
					{ secrets: [{ name: "BOT_TOKEN", replace: true }] },
					"not_admitted",
				],
				[
					"action",
					{ actions: agentConfigurationConformanceAdmissionsV1.actions },
					"not_admitted",
				],
				[
					"channel",
					{
						channels: [
							{
								kind: "wecom_bot",
								enabled: true,
								bindingReference: "binding_01",
							},
						],
					},
					"not_admitted",
				],
			] as const;
			for (const [index, [kind, changes, code]] of attacks.entries()) {
				const admissions = new FakeAgentConfigurationAdmissionsV1({
					...agentConfigurationConformanceAdmissionsV1,
					mismatchedAdmission: kind,
				});
				const key =
					kind === "authorization"
						? "authorizationAdmission"
						: `${kind}Admission`;
				const useCase = harness.useCaseWithDependencies({
					[key]: admissions,
				} as never);
				await expect(
					useCase.update(
						{
							...command,
							idempotencyKey: `wrong-admission-${index}`,
							changes: changes as never,
						},
						actor,
					),
				).rejects.toEqual(expect.objectContaining({ code }));
			}

			let wrongStateCommitted = false;
			const wrongState = harness.useCaseWithDependencies({
				transaction: {
					read: async () => ({
						outcome: "ready",
						record: {
							schemaVersion: 1,
							authorizationRevision: "authorization_9",
							configuration: {
								...agentConfigurationConformanceRecordV1,
								agentId: "agent_other",
							},
						},
					}),
					commit: async () => {
						wrongStateCommitted = true;
						return { outcome: "stale" };
					},
				},
			});
			await expect(
				wrongState.update(
					{
						...command,
						idempotencyKey: "wrong-state-agent",
						changes: {
							environment: [{ name: "LOG_LEVEL", value: "debug" }],
						},
					},
					actor,
				),
			).rejects.toEqual(expect.objectContaining({ code: "not_authorized" }));
			expect(wrongStateCommitted).toBe(false);
			const snapshot = await harness.snapshot();
			expect(snapshot).toMatchObject({
				commitCount: 0,
				idempotencyCount: 0,
				outboxCount: 0,
				auditCount: 0,
				lastPlan: null,
			});
		} finally {
			await harness.close();
		}
	});
}
