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

export interface FakeAgentConfigurationSnapshotV1 {
	readonly configuration: AgentConfigurationRecordV1;
	readonly commitCount: number;
	readonly lastPlan: AgentConfigurationWritePlanV1 | null;
	readonly idempotencyCount: number;
}

export class FakeAgentConfigurationTransactionV1
	implements AgentConfigurationTransactionPortV1
{
	#configuration: AgentConfigurationRecordV1;
	#commitCount = 0;
	#lastPlan: AgentConfigurationWritePlanV1 | null = null;
	#failCommitAsStale = false;
	#idempotency = new Map<
		string,
		{ requestDigest: string; result: AgentConfigurationResultV1 }
	>();

	constructor(configuration: AgentConfigurationRecordV1) {
		this.#configuration = structuredClone(configuration);
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
					configuration: structuredClone(this.#configuration),
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
			plan.baseRevision !== this.#configuration.revision
		) {
			return { outcome: "stale" };
		}
		this.#configuration = structuredClone(plan.configuration);
		this.#lastPlan = structuredClone(plan);
		this.#commitCount += 1;
		this.#idempotency.set(scope, {
			requestDigest: plan.idempotency.requestDigest,
			result: structuredClone(plan.result),
		});
		return { outcome: "committed", result: structuredClone(plan.result) };
	}

	failNextCommitAsStale(): void {
		this.#failCommitAsStale = true;
	}

	snapshot(): FakeAgentConfigurationSnapshotV1 {
		return structuredClone({
			configuration: this.#configuration,
			commitCount: this.#commitCount,
			lastPlan: this.#lastPlan,
			idempotencyCount: this.#idempotency.size,
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
			? { schemaVersion: 1, status: "admitted", ...admission }
			: {
					schemaVersion: 1,
					status: "rejected",
					agentId: input.agentId,
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
					agentId: input.agentId,
					requestId: input.requestId,
					source: structuredClone(admission.source),
				}
			: {
					schemaVersion: 1,
					status: "rejected",
					agentId: input.agentId,
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
					agentId: input.agentId,
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
			agentId: input.agentId,
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
					agentId: input.agentId,
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
			agentId: input.agentId,
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
				agentId: input.agentId,
				requestId: input.requestId,
			};
		}
		return {
			schemaVersion: 1,
			status: "admitted",
			agentId: input.agentId,
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
						agentId: input.agentId,
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
			agentId: input.agentId,
			requestId: input.requestId,
			channelRevision: this.#options.channelRevision ?? "channels_1",
			channels: [...channels.values()],
		};
	}
}
