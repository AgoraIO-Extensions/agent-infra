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
import {
	type FakeAgentConfigurationAdmissionsOptionsV1,
	FakeAgentConfigurationAdmissionsV1,
	FakeAgentConfigurationTransactionV1,
} from "./fake-agent-configuration.ts";

const serverInstant = new Date("2026-08-31T04:00:00.000Z");
const actor = { schemaVersion: 1 as const, actorId: "owner_01" };
const command = {
	schemaVersion: 1 as const,
	agentId: "agent_01",
	requestId: "request_01",
	traceId: "trace_01",
};

interface HarnessOptions {
	record?: AgentConfigurationRecordV1;
	admissions?: Partial<FakeAgentConfigurationAdmissionsOptionsV1>;
	dependencies?: Partial<AgentConfigurationUseCaseDependenciesV1>;
}

function createHarness(options: HarnessOptions = {}) {
	const transaction = new FakeAgentConfigurationTransactionV1(
		options.record ?? agentConfigurationConformanceRecordV1,
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
	};
}

describe("Agent configuration conformance", () => {
	agentConfigurationUseCaseConformance(async () => {
		const harness = createHarness();
		return {
			useCase: harness.useCase,
			snapshot: async () => harness.transaction.snapshot(),
			failNextCommitAsStale: () => harness.transaction.failNextCommitAsStale(),
			close: async () => undefined,
		};
	});
});

describe("Agent configuration policy", () => {
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
										...input.requested.options[0],
										modelId: "silent-fallback",
										credential: {
											secretId: "secret_model_primary",
											version: 2,
											isSet: true,
											value: "plaintext",
										},
									},
								],
								defaultOptionId: "model_primary",
								defaultReasoningLevel: "low",
							},
						} as never;
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
		).rejects.toEqual(expect.objectContaining({ code: "not_admitted" }));

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
});
