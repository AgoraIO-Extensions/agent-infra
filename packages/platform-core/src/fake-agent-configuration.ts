import type {
	AgentConfigurationAccessAuthorityV1,
	AgentConfigurationActionAdmissionPortV1,
	AgentConfigurationAuthorizationAdmissionPortV1,
	AgentConfigurationChannelAdmissionPortV1,
	AgentConfigurationImageAdmissionPortV1,
	AgentConfigurationModelAdmissionPortV1,
	AgentConfigurationRecordV1,
	AgentConfigurationResultV1,
	AgentConfigurationSecretAdmissionPortV1,
	AgentConfigurationTransactionPortV1,
	AgentConfigurationWritePlanV1,
} from "./agent-configuration.ts";
import type { AgentManagementStateV1 } from "./agent-management.ts";

export interface FakeAgentConfigurationSnapshotV1 {
	readonly configuration: AgentConfigurationRecordV1;
	readonly commitCount: number;
	readonly lastPlan: AgentConfigurationWritePlanV1 | null;
	readonly idempotencyCount: number;
	readonly managementState: AgentManagementStateV1 | null;
	readonly authorizationRevision: string;
	readonly outboxCount: number;
	readonly auditCount: number;
}

export interface FakeAgentConfigurationTransactionOptionsV1 {
	readonly managementState?: AgentManagementStateV1;
	readonly authorizationRevision?: string;
}

export class FakeAgentConfigurationTransactionV1
	implements AgentConfigurationTransactionPortV1
{
	#configuration: AgentConfigurationRecordV1;
	#commitCount = 0;
	#lastPlan: AgentConfigurationWritePlanV1 | null = null;
	#failCommitAsStale = false;
	#managementState: AgentManagementStateV1 | null;
	#authorizationRevision: string;
	#outboxCount = 0;
	#auditCount = 0;
	#idempotency = new Map<
		string,
		{ requestDigest: string; result: AgentConfigurationResultV1 }
	>();

	constructor(
		configuration: AgentConfigurationRecordV1,
		options: FakeAgentConfigurationTransactionOptionsV1 = {},
	) {
		this.#configuration = structuredClone(configuration);
		this.#managementState = options.managementState
			? structuredClone(options.managementState)
			: null;
		this.#authorizationRevision =
			options.authorizationRevision ?? "authorization_9";
	}

	async read(
		input: Parameters<AgentConfigurationTransactionPortV1["read"]>[0],
	): ReturnType<AgentConfigurationTransactionPortV1["read"]> {
		const scope = this.#idempotencyScope(
			input.agentId,
			input.actorId,
			input.idempotencyKey,
		);
		const existing = this.#idempotency.get(scope);
		if (existing) {
			return existing.requestDigest === input.requestDigest
				? { outcome: "replayed", result: structuredClone(existing.result) }
				: { outcome: "idempotency_conflict" };
		}
		return this.#configuration.agentId === input.agentId
			? {
					outcome: "ready",
					record: {
						schemaVersion: 1,
						configuration: structuredClone(this.#configuration),
						authorizationRevision: this.#authorizationRevision,
					},
				}
			: { outcome: "missing" };
	}

	async commit(
		plan: AgentConfigurationWritePlanV1,
	): ReturnType<AgentConfigurationTransactionPortV1["commit"]> {
		const scope = this.#idempotencyScope(
			plan.agentId,
			plan.auditEvent.actorId,
			plan.idempotency.key,
		);
		const existing = this.#idempotency.get(scope);
		if (existing) {
			return existing.requestDigest === plan.idempotency.requestDigest
				? { outcome: "replayed", result: structuredClone(existing.result) }
				: { outcome: "idempotency_conflict" };
		}
		if (this.#failCommitAsStale) {
			this.#failCommitAsStale = false;
			return { outcome: "stale" };
		}
		if (
			plan.agentId !== this.#configuration.agentId ||
			plan.baseRevision !== this.#configuration.revision ||
			plan.expectedAuthorizationRevision !== this.#authorizationRevision ||
			(plan.accessUpdate !== null &&
				(this.#managementState === null ||
					this.#managementState.agentId !== plan.agentId ||
					this.#managementState.revision !==
						plan.accessUpdate.expectedRevision))
		) {
			return { outcome: "stale" };
		}
		const configuration = structuredClone(plan.configuration);
		const lastPlan = structuredClone(plan);
		const managementState = plan.accessUpdate
			? {
					...(this.#managementState as AgentManagementStateV1),
					revision: plan.accessUpdate.expectedRevision + 1,
					ownerIds: structuredClone(plan.accessUpdate.ownerIds),
					availability: structuredClone(plan.accessUpdate.availability),
				}
			: this.#managementState;
		if (
			managementState !== null &&
			!Number.isSafeInteger(managementState.revision)
		) {
			return { outcome: "stale" };
		}
		const idempotency = new Map(this.#idempotency);
		idempotency.set(scope, {
			requestDigest: plan.idempotency.requestDigest,
			result: structuredClone(plan.result),
		});
		this.#configuration = configuration;
		this.#managementState = managementState;
		this.#authorizationRevision = plan.nextAuthorizationRevision;
		this.#lastPlan = lastPlan;
		this.#idempotency = idempotency;
		this.#commitCount += 1;
		this.#outboxCount += 1;
		this.#auditCount += 1;
		return { outcome: "committed", result: structuredClone(plan.result) };
	}

	failNextCommitAsStale(): void {
		this.#failCommitAsStale = true;
	}

	advanceAccessRevision(): void {
		if (!this.#managementState)
			throw new Error("No management state configured");
		this.#managementState = {
			...this.#managementState,
			revision: this.#managementState.revision + 1,
		};
	}

	setAuthorizationRevision(revision: string): void {
		this.#authorizationRevision = revision;
	}

	snapshot(): FakeAgentConfigurationSnapshotV1 {
		return structuredClone({
			configuration: this.#configuration,
			commitCount: this.#commitCount,
			lastPlan: this.#lastPlan,
			idempotencyCount: this.#idempotency.size,
			managementState: this.#managementState,
			authorizationRevision: this.#authorizationRevision,
			outboxCount: this.#outboxCount,
			auditCount: this.#auditCount,
		});
	}

	#idempotencyScope(agentId: string, actorId: string, key: string): string {
		return `${agentId}\0${actorId}\0${key}`;
	}
}

export interface FakeAgentConfigurationAdmissionsOptionsV1 {
	readonly authorizations: readonly {
		readonly agentId: string;
		readonly actorId: string;
		readonly authorizationRevision: string;
		readonly accessAuthority?: AgentConfigurationAccessAuthorityV1;
	}[];
	readonly models: readonly {
		readonly endpointId: string;
		readonly modelId: string;
		readonly reasoningLevels: readonly string[];
		readonly catalogRevision: string;
	}[];
	readonly modelCredentials: readonly {
		readonly requestId: string;
		readonly optionId: string;
		readonly secretId: string;
		readonly version: number;
	}[];
	readonly secretReplacements?: readonly {
		readonly requestId: string;
		readonly name: string;
		readonly secretId: string;
		readonly version: number;
	}[];
	readonly actions?: readonly {
		readonly providerId: string;
		readonly actionId: string;
		readonly actionVersion: string;
	}[];
	readonly actionSetRevision?: string;
	readonly channelBindings?: readonly {
		readonly kind: "wecom_bot" | "wecom_app";
		readonly bindingReference: string;
	}[];
	readonly channelRevision?: string;
	readonly images?: readonly {
		readonly selection: Parameters<
			AgentConfigurationImageAdmissionPortV1["admitImage"]
		>[0]["requested"];
		readonly source: AgentConfigurationRecordV1["source"];
	}[];
	readonly mismatchedAdmission?:
		| "authorization"
		| "image"
		| "model"
		| "secret"
		| "action"
		| "channel";
	readonly mismatchedAgentId?: string;
}

export class FakeAgentConfigurationAdmissionsV1
	implements
		AgentConfigurationAuthorizationAdmissionPortV1,
		AgentConfigurationImageAdmissionPortV1,
		AgentConfigurationModelAdmissionPortV1,
		AgentConfigurationSecretAdmissionPortV1,
		AgentConfigurationActionAdmissionPortV1,
		AgentConfigurationChannelAdmissionPortV1
{
	readonly #options: FakeAgentConfigurationAdmissionsOptionsV1;

	constructor(options: FakeAgentConfigurationAdmissionsOptionsV1) {
		this.#options = structuredClone(options);
	}

	async authorize(
		input: Parameters<
			AgentConfigurationAuthorizationAdmissionPortV1["authorize"]
		>[0],
	): ReturnType<AgentConfigurationAuthorizationAdmissionPortV1["authorize"]> {
		const admission = this.#options.authorizations.find(
			({ agentId, actorId }) =>
				agentId === input.agentId && actorId === input.actorId,
		);
		return admission
			? {
					schemaVersion: 1,
					status: "admitted",
					...admission,
					agentId: this.#resultAgentId("authorization", input.agentId),
				}
			: {
					schemaVersion: 1,
					status: "rejected",
					agentId: this.#resultAgentId("authorization", input.agentId),
					actorId: input.actorId,
				};
	}

	async admitImage(
		input: Parameters<AgentConfigurationImageAdmissionPortV1["admitImage"]>[0],
	): ReturnType<AgentConfigurationImageAdmissionPortV1["admitImage"]> {
		const admission = this.#options.images?.find(
			({ selection }) =>
				JSON.stringify(selection) === JSON.stringify(input.requested),
		);
		return admission
			? {
					schemaVersion: 1,
					status: "admitted",
					agentId: this.#resultAgentId("image", input.agentId),
					requestId: input.requestId,
					source: structuredClone(admission.source),
				}
			: {
					schemaVersion: 1,
					status: "rejected",
					agentId: this.#resultAgentId("image", input.agentId),
					requestId: input.requestId,
				};
	}

	async admitModels(
		input: Parameters<AgentConfigurationModelAdmissionPortV1["admitModels"]>[0],
	): ReturnType<AgentConfigurationModelAdmissionPortV1["admitModels"]> {
		const options = [];
		let catalogRevision: string | undefined;
		for (const requested of input.requested.options) {
			const model = this.#options.models.find(
				(candidate) =>
					candidate.endpointId === requested.endpointId &&
					candidate.modelId === requested.modelId &&
					requested.reasoningLevels.every((level) =>
						candidate.reasoningLevels.includes(level),
					),
			);
			const previous = input.current?.options.find(
				({ optionId }) => optionId === requested.optionId,
			);
			const replacement = this.#options.modelCredentials.find(
				({ requestId, optionId }) =>
					requestId === input.requestId && optionId === requested.optionId,
			);
			const credential = requested.replaceCredential
				? replacement
				: previous?.credential;
			if (
				!model ||
				!credential ||
				(catalogRevision !== undefined &&
					catalogRevision !== model.catalogRevision)
			) {
				return {
					schemaVersion: 1,
					status: "rejected",
					agentId: this.#resultAgentId("model", input.agentId),
					requestId: input.requestId,
				};
			}
			catalogRevision = model.catalogRevision;
			options.push({
				optionId: requested.optionId,
				endpointId: requested.endpointId,
				modelId: requested.modelId,
				reasoningLevels: [...requested.reasoningLevels],
				credential: {
					secretId: credential.secretId,
					version: credential.version,
					isSet: true as const,
				},
			});
		}
		return {
			schemaVersion: 1,
			status: "admitted",
			agentId: this.#resultAgentId("model", input.agentId),
			requestId: input.requestId,
			configuration: {
				catalogRevision: catalogRevision ?? "",
				options,
				defaultOptionId: input.requested.defaultOptionId,
				defaultReasoningLevel: input.requested.defaultReasoningLevel,
			},
		};
	}

	async admitSecrets(
		input: Parameters<
			AgentConfigurationSecretAdmissionPortV1["admitSecrets"]
		>[0],
	): ReturnType<AgentConfigurationSecretAdmissionPortV1["admitSecrets"]> {
		const secrets = [];
		for (const requested of input.requested) {
			const replacement = this.#options.secretReplacements?.find(
				({ requestId, name }) =>
					requestId === input.requestId && name === requested.name,
			);
			if (!replacement) {
				return {
					schemaVersion: 1,
					status: "rejected",
					agentId: this.#resultAgentId("secret", input.agentId),
					requestId: input.requestId,
				};
			}
			secrets.push({
				name: replacement.name,
				secretId: replacement.secretId,
				version: replacement.version,
				isSet: true as const,
			});
		}
		return {
			schemaVersion: 1,
			status: "admitted",
			agentId: this.#resultAgentId("secret", input.agentId),
			requestId: input.requestId,
			secrets,
		};
	}

	async admitActions(
		input: Parameters<
			AgentConfigurationActionAdmissionPortV1["admitActions"]
		>[0],
	): ReturnType<AgentConfigurationActionAdmissionPortV1["admitActions"]> {
		const allowed = this.#options.actions ?? [];
		if (
			input.requested.some(
				(requested) =>
					!allowed.some(
						(candidate) =>
							candidate.providerId === requested.providerId &&
							candidate.actionId === requested.actionId &&
							candidate.actionVersion === requested.actionVersion,
					),
			)
		) {
			return {
				schemaVersion: 1,
				status: "rejected",
				agentId: this.#resultAgentId("action", input.agentId),
				requestId: input.requestId,
			};
		}
		return {
			schemaVersion: 1,
			status: "admitted",
			agentId: this.#resultAgentId("action", input.agentId),
			requestId: input.requestId,
			actionSetRevision: this.#options.actionSetRevision ?? "actions_1",
			actions: structuredClone(input.requested),
		};
	}

	async admitChannels(
		input: Parameters<
			AgentConfigurationChannelAdmissionPortV1["admitChannels"]
		>[0],
	): ReturnType<AgentConfigurationChannelAdmissionPortV1["admitChannels"]> {
		const allowed = this.#options.channelBindings ?? [];
		const channels = new Map(
			input.current.map((binding) => [binding.kind, binding]),
		);
		for (const requested of input.requested) {
			if (requested.enabled) {
				const admitted = allowed.some(
					(binding) =>
						binding.kind === requested.kind &&
						binding.bindingReference === requested.bindingReference,
				);
				if (!admitted) {
					return {
						schemaVersion: 1,
						status: "rejected",
						agentId: this.#resultAgentId("channel", input.agentId),
						requestId: input.requestId,
					};
				}
				channels.set(requested.kind, {
					kind: requested.kind,
					bindingReference: requested.bindingReference,
				});
			} else {
				channels.delete(requested.kind);
			}
		}
		return {
			schemaVersion: 1,
			status: "admitted",
			agentId: this.#resultAgentId("channel", input.agentId),
			requestId: input.requestId,
			channelRevision: this.#options.channelRevision ?? "channels_1",
			channels: [...channels.values()],
		};
	}

	#resultAgentId(
		kind: NonNullable<
			FakeAgentConfigurationAdmissionsOptionsV1["mismatchedAdmission"]
		>,
		requestedAgentId: string,
	): string {
		return this.#options.mismatchedAdmission === kind
			? (this.#options.mismatchedAgentId ?? "agent_other")
			: requestedAgentId;
	}
}
