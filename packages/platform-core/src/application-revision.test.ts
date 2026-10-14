import { describe, expect, it, vi } from "vitest";
import {
	applicationRevisionActorContextV1,
	applicationRevisionAdmissionsV1,
	applicationRevisionCommandV1,
	applicationRevisionStateV1,
	applicationRevisionTransactionConformance,
} from "./application-revision.conformance.ts";
import {
	ApplicationRevisionError,
	type ApplicationRevisionReadStateV1,
	type ApplicationRevisionTransactionPortV1,
	type ApplicationRevisionWritePlanV1,
	createApplicationRevisionUseCaseV1,
	snapshotApplicationRevisionWritePlanV1,
} from "./application-revision.ts";
import { FakeApplicationRevisionTransactionV1 } from "./fake-application-revision.ts";
import { pendingSecretRecordAttachmentFixtureV1 } from "./secret-record-attachment.fixture.ts";

function createUseCase(transaction: ApplicationRevisionTransactionPortV1) {
	return createApplicationRevisionUseCaseV1(
		{ transaction, ...applicationRevisionAdmissionsV1() },
		{ now: () => new Date("2026-09-02T04:00:00.000Z") },
	);
}

describe("Application revision transaction conformance", () => {
	applicationRevisionTransactionConformance(async (state) => {
		const transaction = new FakeApplicationRevisionTransactionV1(
			state ?? applicationRevisionStateV1,
		);
		return {
			transaction,
			snapshot: async () => transaction.snapshot(),
			failNextBefore: (point) => transaction.failNextBefore(point),
			advanceManagementRevision: () => transaction.advanceManagementRevision(),
			advanceConfigurationRevision: () =>
				transaction.advanceConfigurationRevision(),
			setAuthorizationRevision: (revision) =>
				transaction.setAuthorizationRevision(revision),
			close: async () => {},
		};
	});
});

describe("Application revision input and plan boundary", () => {
	it("fails closed before persistence when a Secret sidecar is missing", async () => {
		let commits = 0;
		const revision = createUseCase({
			async read() {
				return {
					outcome: "ready",
					state: structuredClone(applicationRevisionStateV1),
				};
			},
			async commit(plan) {
				commits += 1;
				return { outcome: "committed", result: plan.result };
			},
		});

		await expect(
			revision.revise(
				{
					...applicationRevisionCommandV1,
					secrets: [{ name: "BOT_TOKEN", replace: true }],
				},
				applicationRevisionActorContextV1,
			),
		).rejects.toMatchObject({ code: "dependency_unavailable" });
		expect(commits).toBe(0);
	});

	it("passes final encrypted records beside the revision plan", async () => {
		let attachments: unknown;
		const resolve = vi.fn().mockResolvedValue([{ encrypted: "ciphertext" }]);
		const revision = createUseCase({
			async read() {
				return {
					outcome: "ready",
					state: structuredClone(applicationRevisionStateV1),
				};
			},
			async commit(plan, nextAttachments) {
				attachments = nextAttachments;
				return { outcome: "committed", result: plan.result };
			},
		});
		await revision.revise(
			{
				...applicationRevisionCommandV1,
				secrets: [{ name: "BOT_TOKEN", replace: true }],
			},
			applicationRevisionActorContextV1,
			{ resolve },
		);

		expect(resolve).toHaveBeenCalledOnce();
		expect(attachments).toMatchObject({
			expected: [
				expect.objectContaining({
					name: "BOT_TOKEN",
					configurationRevision: 8,
				}),
			],
			encryptedRecords: [{ encrypted: "ciphertext" }],
		});
	});

	it("retains an applicant who also has administrator authority", async () => {
		const transaction = new FakeApplicationRevisionTransactionV1(
			applicationRevisionStateV1,
		);
		const dependencies = applicationRevisionAdmissionsV1();
		const authorizationAdmission = dependencies.authorizationAdmission;
		const revision = createApplicationRevisionUseCaseV1(
			{
				transaction,
				...dependencies,
				authorizationAdmission: {
					async authorize(input) {
						const decision = await authorizationAdmission.authorize(input);
						if (decision.status !== "admitted" || !decision.accessAuthority) {
							return decision;
						}
						return {
							...decision,
							accessAuthority: {
								...decision.accessAuthority,
								actorContext: {
									...decision.accessAuthority.actorContext,
									isAdministrator: true,
								},
							},
						};
					},
				},
			},
			{ now: () => new Date("2026-09-02T04:00:00.000Z") },
		);

		await revision.revise(applicationRevisionCommandV1, {
			...applicationRevisionActorContextV1,
			isAdministrator: true,
		});

		expect(transaction.snapshot().state.management.ownerIds).toEqual([
			"owner_01",
			"owner_02",
		]);
	});

	it("rejects command and actor accessors without reading them", async () => {
		for (const target of ["command", "actor"] as const) {
			let getterReads = 0;
			let reads = 0;
			let commits = 0;
			const transaction: ApplicationRevisionTransactionPortV1 = {
				async read() {
					reads += 1;
					return { outcome: "unavailable" };
				},
				async commit() {
					commits += 1;
					throw new Error("must not commit");
				},
			};
			const command = { ...applicationRevisionCommandV1 };
			const actor = { ...applicationRevisionActorContextV1 };
			Object.defineProperty(
				target === "command" ? command : actor,
				"requestId",
				{
					enumerable: true,
					get() {
						getterReads += 1;
						return "sensitive-staged-request";
					},
				},
			);
			if (target === "actor") {
				Object.defineProperty(actor, "userId", {
					enumerable: true,
					get() {
						getterReads += 1;
						return "sensitive-staged-user";
					},
				});
			}
			await expect(
				createUseCase(transaction).revise(command, actor as never),
			).rejects.toMatchObject({ code: "invalid_command" });
			expect(getterReads).toBe(0);
			expect(reads).toBe(0);
			expect(commits).toBe(0);
		}
	});

	it("sanitizes Proxy input before the transaction Port", async () => {
		let trapCalls = 0;
		let reads = 0;
		const command = new Proxy(applicationRevisionCommandV1, {
			ownKeys() {
				trapCalls += 1;
				throw new Error("sensitive proxy trap");
			},
		});
		await expect(
			createUseCase({
				async read() {
					reads += 1;
					return { outcome: "unavailable" };
				},
				async commit() {
					throw new Error("must not commit");
				},
			}).revise(command, applicationRevisionActorContextV1),
		).rejects.toMatchObject({ code: "invalid_command" });
		expect(trapCalls).toBe(0);
		expect(reads).toBe(0);
	});

	it("rejects present undefined optional revision fields before reading Store", async () => {
		for (const field of ["secrets", "channels"] as const) {
			let reads = 0;
			await expect(
				createUseCase({
					async read() {
						reads += 1;
						return { outcome: "unavailable" };
					},
					async commit() {
						throw new Error("must not commit");
					},
				}).revise(
					{ ...applicationRevisionCommandV1, [field]: undefined } as never,
					applicationRevisionActorContextV1,
				),
			).rejects.toMatchObject({ code: "invalid_command" });
			expect(reads).toBe(0);
		}
	});

	it("snapshots nested command data before the first async boundary", async () => {
		const transaction = new FakeApplicationRevisionTransactionV1(
			applicationRevisionStateV1,
		);
		const channels = [{ kind: "wecom_bot" as const, enabled: false as const }];
		const command = {
			...structuredClone(applicationRevisionCommandV1),
			secrets: [{ name: "BOT_TOKEN", replace: true as const }],
			channels,
		};
		const originalEnvironment = structuredClone(command.environment);
		const revision = createUseCase({
			async read(input) {
				const decision = await transaction.read(input);
				const [environment] = command.environment as {
					name: string;
					value: string;
				}[];
				if (!environment) throw new Error("Expected environment fixture");
				environment.value = "mutated_after_read";
				const [secret] = command.secrets;
				if (!secret) throw new Error("Expected Secret fixture");
				secret.name = "MUTATED_TOKEN";
				const [channel] = command.channels;
				if (!channel) throw new Error("Expected channel fixture");
				(
					channel as unknown as {
						bindingReference?: string;
					}
				).bindingReference = "mutated_binding";
				return decision;
			},
			async commit(plan) {
				return transaction.commit(plan);
			},
		});

		await revision.revise(
			command,
			applicationRevisionActorContextV1,
			pendingSecretRecordAttachmentFixtureV1(),
		);

		expect(command.environment[0]?.value).toBe("mutated_after_read");
		expect(
			transaction.snapshot().lastPlan?.configuration?.configuration.environment,
		).toEqual(originalEnvironment);
		expect(
			transaction.snapshot().lastPlan?.configuration?.configuration.secrets,
		).toEqual([
			{
				name: "BOT_TOKEN",
				secretId: "secret_bot_token",
				version: 2,
				isSet: true,
			},
		]);
		expect(
			transaction.snapshot().lastPlan?.configuration?.configuration.channels,
		).toEqual([]);
	});

	it("rejects malicious Store state without calling admissions or commit", async () => {
		let getterReads = 0;
		let commits = 0;
		const state = {
			...applicationRevisionStateV1,
			application: Object.defineProperty(
				{ ...applicationRevisionStateV1.application },
				"agentId",
				{
					enumerable: true,
					get() {
						getterReads += 1;
						return "staged-agent";
					},
				},
			),
		};
		await expect(
			createUseCase({
				async read() {
					return { outcome: "ready", state } as never;
				},
				async commit() {
					commits += 1;
					throw new Error("must not commit");
				},
			}).revise(
				applicationRevisionCommandV1,
				applicationRevisionActorContextV1,
			),
		).rejects.toMatchObject({ code: "persistence_failed" });
		expect(getterReads).toBe(0);
		expect(commits).toBe(0);
	});

	it("rejects an empty pending edit without a commit", async () => {
		const transaction = new FakeApplicationRevisionTransactionV1(
			applicationRevisionStateV1,
		);
		await expect(
			createUseCase(transaction).revise(
				{
					...applicationRevisionCommandV1,
					name: applicationRevisionStateV1.application.name,
					description: applicationRevisionStateV1.application.description,
					environment: applicationRevisionStateV1.configuration.environment,
				},
				applicationRevisionActorContextV1,
			),
		).rejects.toMatchObject({ code: "no_change" });
		expect(transaction.snapshot().commitCount).toBe(0);
	});

	it("snapshots a write plan without invoking malicious accessors or Proxy traps", async () => {
		const transaction = new FakeApplicationRevisionTransactionV1(
			applicationRevisionStateV1,
		);
		await createUseCase(transaction).revise(
			applicationRevisionCommandV1,
			applicationRevisionActorContextV1,
		);
		const valid = transaction.snapshot().lastPlan;
		if (!valid) throw new Error("Expected a captured write plan");

		let getterReads = 0;
		const application = Object.defineProperty(
			{ ...valid.application },
			"name",
			{
				enumerable: true,
				get() {
					getterReads += 1;
					return "sensitive staged name";
				},
			},
		);
		expect(() =>
			snapshotApplicationRevisionWritePlanV1({ ...valid, application }),
		).toThrow(ApplicationRevisionError);
		expect(getterReads).toBe(0);

		const ownerIds = ["owner_02"];
		expect(() =>
			snapshotApplicationRevisionWritePlanV1({
				...valid,
				management: {
					...valid.management,
					state: { ...valid.management.state, ownerIds },
				},
				configuration: valid.configuration && {
					...valid.configuration,
					accessUpdate: valid.configuration.accessUpdate && {
						...valid.configuration.accessUpdate,
						ownerIds,
					},
				},
			}),
		).toThrow(ApplicationRevisionError);

		let trapCalls = 0;
		const proxy = new Proxy(valid, {
			ownKeys() {
				trapCalls += 1;
				throw new Error("sensitive plan trap");
			},
		});
		expect(() =>
			snapshotApplicationRevisionWritePlanV1(
				proxy as ApplicationRevisionWritePlanV1,
			),
		).toThrow(ApplicationRevisionError);
		expect(trapCalls).toBe(0);
	});
});

describe("Application revision with a re-submitted default Key (#2421)", () => {
	// 带默认 Key 的标准申请持久化为 V3：模型选项不含凭证。
	const keylessState = (() => {
		const base = structuredClone(applicationRevisionStateV1);
		const model = base.configuration.modelConfiguration;
		if (!model) throw new Error("fixture model missing");
		return {
			...base,
			configuration: {
				...base.configuration,
				schemaVersion: 3,
				modelConfiguration: {
					...model,
					options: model.options.map((option) => {
						const { credential: _credential, ...rest } = option as Record<
							string,
							unknown
						>;
						return rest;
					}),
				},
			},
		} as unknown as ApplicationRevisionReadStateV1;
	})();
	const plaintextKey = "SYNTHETIC_REVISION_KEY_00001";
	const { replaceCredential: _replace, ...keylessOption } =
		applicationRevisionCommandV1.modelConfiguration?.options[0] ?? {
			optionId: "model_primary",
			endpointId: "endpoint_01",
			modelId: "gpt-5",
			reasoningLevels: ["low"],
		};
	const keyedCommand = {
		...applicationRevisionCommandV1,
		schemaVersion: 3,
		defaultRelayKey: plaintextKey,
		expectedConfigurationRevision: keylessState.configuration.revision,
		expectedKeyVersion: 1,
		modelConfiguration: {
			options: [keylessOption],
			defaultOptionId: "model_primary",
			defaultReasoningLevel: "low",
		},
	} as never;
	function createKeyed(transaction: ApplicationRevisionTransactionPortV1) {
		return createApplicationRevisionUseCaseV1(
			{
				transaction,
				...applicationRevisionAdmissionsV1(keylessState),
				keylessModelAdmission: {
					admitModels: async ({ requested }) =>
						({ catalogRevision: "catalog_3", ...requested }) as never,
				},
				defaultRelayKey: {
					currentIdentity: async () => ({
						userId: keylessState.application.applicantId,
						accountStatus: "active",
						authorizationRevision: "authorization_10",
					}),
					candidates: async () => [
						{
							endpointId: "endpoint_01",
							modelId: "gpt-5",
							reasoningLevels: ["low"],
						},
					],
					encrypt: () => ({ ciphertext: "opaque" }),
				},
			},
			{ now: () => new Date("2026-09-02T04:00:00.000Z") },
		);
	}
	const transactionReturning = (
		decision: Awaited<
			ReturnType<ApplicationRevisionTransactionPortV1["commit"]>
		>,
		seen?: { attachment?: unknown },
	): ApplicationRevisionTransactionPortV1 => ({
		async read() {
			return { outcome: "ready", state: structuredClone(keylessState) };
		},
		async commit(_plan, _attachments, key) {
			if (seen) seen.attachment = key;
			return decision;
		},
	});

	it("hands the Key attachment and the expected version to the commit boundary", async () => {
		const seen: { attachment?: unknown } = {};
		const revision = createKeyed(
			transactionReturning(
				{
					outcome: "committed",
					result: {
						schemaVersion: 1,
						applicationId: "application_01",
						agentId: "agent_01",
						status: "pending_approval",
						managementRevision: 4,
						configurationRevision: 8,
					},
				},
				seen,
			),
		);
		await revision.revise(keyedCommand, applicationRevisionActorContextV1);
		expect(seen.attachment).toMatchObject({ expectedVersion: 1 });
		expect(JSON.stringify(seen.attachment)).not.toContain(plaintextKey);
	});

	it.each([
		["stale_key_version", "key_version_conflict"],
		["stale_configuration", "stale_revision"],
	] as const)("maps the %s conflict to %s", async (reason, code) => {
		const revision = createKeyed(
			transactionReturning({ outcome: "conflict", reason }),
		);
		await expect(
			revision.revise(keyedCommand, applicationRevisionActorContextV1),
		).rejects.toMatchObject({ code });
	});
});
