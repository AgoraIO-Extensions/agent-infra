import {
	parseAdmittedModel,
	parseChannelDecision,
	parseImageDecision,
	parseModelDecision,
	parseSecretDecision,
	sameModelConfiguration,
	sameSourceConfiguration,
} from "./agent-configuration-admission.js";
import {
	admitCurrentAuthorization,
	admitStandardTemplateRelease,
	systemNow,
} from "./agent-configuration-authorization.js";
import {
	accessTargetKey,
	parseActorContext,
	parseCommand,
	parseLegacyUpdateCommand,
	parseReleaseStandardTemplateCommand,
	parseUpgradeCustomImageCommand,
} from "./agent-configuration-input.js";
import {
	customImageUpgradeRequestDigest,
	parseResult,
	parseTransactionCommitDecision,
	parseTransactionReadDecision,
	requestDigest,
	snapshotAgentConfigurationWritePlanV1,
} from "./agent-configuration-plan.js";
import { requireAdmittedConfigurationPolicy } from "./agent-configuration-record.js";
import {
	type AgentConfigurationAccessPlanV1,
	type AgentConfigurationActorContextV1,
	type AgentConfigurationChangedFieldV1,
	type AgentConfigurationChannelAdmissionPortV1,
	AgentConfigurationError,
	type AgentConfigurationImageAdmissionPortV1,
	type AgentConfigurationModelAdmissionPortV1,
	type AgentConfigurationRecordV2,
	type AgentConfigurationResultV1,
	type AgentConfigurationSecretAdmissionPortV1,
	type AgentConfigurationTransactionPortV1,
	type AgentConfigurationUseCaseDependenciesV1,
	type AgentConfigurationUseCaseOptionsV1,
	type AgentConfigurationUseCaseV1,
	type AgentConfigurationWritePlanV1,
	type StandardTemplateReleaseTargetV1,
	type UpdateAgentConfigurationCommandV2,
} from "./agent-configuration-types.js";
import {
	compareText,
	idMaxBytes,
	invalidCommand,
	isText,
	maxSecretReplacements,
	sameValue,
} from "./agent-configuration-values.js";
import { decideAgentAccessUpdatePolicy } from "./agent-management-access-policy.js";
import { platformIdempotencyV1 } from "./idempotency.js";
import {
	type PendingSecretRecordAttachmentResolverV1,
	type PendingSecretRecordAttachmentsV1,
	resolvePendingSecretRecordAttachmentsV1,
} from "./secret-record-attachments.js";

export { beginInitialAgentConfigurationAdmissionV1 } from "./agent-configuration-initial.js";
export {
	parseAgentConfigurationChangesV1,
	parseLegacyAgentConfigurationChangesV1,
	parseStandardTemplateReleaseTargetV1,
	validateLegacyInitialActionsV1,
} from "./agent-configuration-input.js";
export { snapshotAgentConfigurationWritePlanV1 } from "./agent-configuration-plan.js";
export { decodeAgentConfigurationRecordV2 } from "./agent-configuration-record.js";
export {
	type AdmittedInitialAgentConfigurationV1,
	type AgentConfigurationAccessAuthorityV1,
	type AgentConfigurationAccessPlanV1,
	type AgentConfigurationAccessTargetV1,
	type AgentConfigurationActionV1,
	type AgentConfigurationActorContextV1,
	type AgentConfigurationAuthorityContextV1,
	type AgentConfigurationAuthorizationAdmissionPortV1,
	type AgentConfigurationChangedFieldV1,
	type AgentConfigurationChannelAdmissionPortV1,
	type AgentConfigurationChannelChangeV1,
	type AgentConfigurationChannelKindV1,
	AgentConfigurationError,
	type AgentConfigurationErrorCode,
	type AgentConfigurationImageAdmissionPortV1,
	type AgentConfigurationModelAdmissionPortV1,
	type AgentConfigurationModelInputV1,
	type AgentConfigurationModelOptionInputV1,
	type AgentConfigurationModelOptionV1,
	type AgentConfigurationModelV1,
	type AgentConfigurationRecordV1,
	type AgentConfigurationRecordV2,
	type AgentConfigurationResultV1,
	type AgentConfigurationSecretAdmissionPortV1,
	type AgentConfigurationSecretMetadataV1,
	type AgentConfigurationSecretReplacementInputV1,
	type AgentConfigurationSourceSelectionV1,
	type AgentConfigurationSourceV1,
	type AgentConfigurationTransactionPortV1,
	type AgentConfigurationUseCaseDependenciesV1,
	type AgentConfigurationUseCaseOptionsV1,
	type AgentConfigurationUseCaseV1,
	type AgentConfigurationWritePlanV1,
	type InitialAgentConfigurationAdmissionDependenciesV1,
	type InitialAgentConfigurationAdmissionHandleV1,
	type InitialAgentConfigurationCommandV2,
	type ReleaseStandardTemplateCommandV1,
	type StandardTemplateReleaseAuthorizationPortV1,
	type StandardTemplateReleaseAuthorizationV1,
	type StandardTemplateReleaseTargetV1,
	type UpdateAgentConfigurationCommandV2,
	type UpgradeCustomAgentImageCommandV1,
} from "./agent-configuration-types.js";

function createAgentConfigurationUseCaseV1Internal(
	dependencies: AgentConfigurationUseCaseDependenciesV1,
	resolveSecretRecordAttachments: boolean,
	options: AgentConfigurationUseCaseOptionsV1 = {},
): AgentConfigurationUseCaseV1 {
	const now = options.now ?? systemNow;
	type ExecutionCommand = Pick<
		UpdateAgentConfigurationCommandV2,
		"agentId" | "idempotencyKey" | "requestId" | "traceId"
	>;
	const execute = async (
		command: ExecutionCommand,
		actorContext: AgentConfigurationActorContextV1,
		digest: string,
		changesFromCurrent: (
			current: AgentConfigurationRecordV2,
		) => UpdateAgentConfigurationCommandV2["changes"],
		preserveConnectionEnabled = false,
		attachment?: PendingSecretRecordAttachmentResolverV1,
		release?: StandardTemplateReleaseTargetV1,
	): Promise<AgentConfigurationResultV1> => {
		const firstReleaseAuthority = release
			? await admitStandardTemplateRelease(
					dependencies.standardTemplateReleaseAuthorization,
					release,
					{ requestId: command.requestId, traceId: command.traceId },
					actorContext,
				)
			: undefined;
		if (!release)
			await admitCurrentAuthorization(
				dependencies.authorizationAdmission,
				command,
				actorContext,
			);
		let readDecision: Awaited<
			ReturnType<AgentConfigurationTransactionPortV1["read"]>
		>;
		try {
			readDecision = parseTransactionReadDecision(
				await dependencies.transaction.read({
					schemaVersion: 1,
					agentId: command.agentId,
					actorId: actorContext.actorId,
					idempotencyKey: command.idempotencyKey,
					requestDigest: digest,
				}),
				command.agentId,
			);
		} catch {
			throw new AgentConfigurationError("persistence_failed");
		}
		if (readDecision.outcome === "replayed") {
			// A persisted idempotency result is authoritative even when the current
			// configuration revision has advanced since the original command.
			return parseResult(readDecision.result, command.agentId);
		}
		if (readDecision.outcome === "idempotency_conflict") {
			throw new AgentConfigurationError("idempotency_conflict");
		}
		if (
			readDecision.outcome === "missing" ||
			readDecision.record.configuration.agentId !== command.agentId
		) {
			throw new AgentConfigurationError("not_authorized");
		}
		const current = readDecision.record.configuration;
		const authorization = firstReleaseAuthority
			? {
					authorizationRevision: firstReleaseAuthority.authorizationRevision,
					accessAuthority: undefined,
				}
			: await admitCurrentAuthorization(
					dependencies.authorizationAdmission,
					command,
					actorContext,
				);
		if (
			release &&
			authorization.authorizationRevision !==
				readDecision.record.authorizationRevision
		)
			throw new AgentConfigurationError("stale_revision");
		const changes = changesFromCurrent(current);

		let accessUpdate: AgentConfigurationAccessPlanV1 | null = null;
		const changedFields: AgentConfigurationChangedFieldV1[] = [];
		if (
			changes.coOwnerIds !== undefined ||
			changes.availability !== undefined
		) {
			const access = authorization.accessAuthority;
			if (
				!access ||
				access.state.agentId !== command.agentId ||
				access.actorContext.userId !== actorContext.actorId
			) {
				throw new AgentConfigurationError("dependency_unavailable");
			}
			let decision: ReturnType<typeof decideAgentAccessUpdatePolicy>;
			try {
				const desiredOwnerIds =
					changes.coOwnerIds === undefined
						? access.state.ownerIds
						: access.actorContext.isAdministrator
							? changes.coOwnerIds
							: [
									...new Set([actorContext.actorId, ...changes.coOwnerIds]),
								].toSorted(compareText);
				decision = decideAgentAccessUpdatePolicy(
					{
						schemaVersion: 1,
						agentId: command.agentId,
						expectedRevision: access.state.revision,
						desiredOwnerIds,
						desiredAvailability:
							changes.availability ?? access.state.availability,
						requestId: command.requestId,
						traceId: command.traceId,
					},
					access.state,
					access.actorContext,
					access.authorityContext,
				);
			} catch {
				throw new AgentConfigurationError("dependency_unavailable");
			}
			if (decision.outcome === "denied") {
				throw new AgentConfigurationError("not_authorized");
			}
			if (decision.outcome === "conflict") {
				if (decision.reason === "stale_revision") {
					throw new AgentConfigurationError("stale_revision");
				}
				if (decision.reason !== "no_change") {
					throw new AgentConfigurationError("not_admitted");
				}
			} else {
				const fragment = decision.planFragment;
				if (
					fragment.agentId !== command.agentId ||
					fragment.expectedRevision !== access.state.revision ||
					fragment.auditEvent.actorId !== actorContext.actorId ||
					fragment.auditEvent.subjectType !== "agent" ||
					fragment.auditEvent.subjectId !== command.agentId ||
					fragment.auditEvent.requestId !== command.requestId ||
					fragment.auditEvent.traceId !== command.traceId
				) {
					throw new AgentConfigurationError("dependency_unavailable");
				}
				accessUpdate = {
					schemaVersion: 1,
					fragmentType: "agent_access",
					agentId: fragment.agentId,
					expectedRevision: fragment.expectedRevision,
					ownerIds: fragment.ownerIds,
					availability: fragment.availability,
				};
				if (!sameValue(fragment.ownerIds, [...access.state.ownerIds].sort())) {
					changedFields.push("owners");
				}
				if (
					!sameValue(
						fragment.availability.map(accessTargetKey).sort(),
						access.state.availability.map(accessTargetKey).sort(),
					)
				) {
					changedFields.push("availability");
				}
			}
		}

		let source = current.source;
		if (changes.source) {
			let admission: Awaited<
				ReturnType<AgentConfigurationImageAdmissionPortV1["admitImage"]>
			>;
			try {
				admission = parseImageDecision(
					await dependencies.imageAdmission.admitImage({
						schemaVersion: 1,
						agentId: command.agentId,
						requestId: command.requestId,
						traceId: command.traceId,
						requested: structuredClone(changes.source),
					}),
				);
			} catch {
				throw new AgentConfigurationError("dependency_unavailable");
			}
			const admittedSource =
				admission.status === "admitted" ? admission.source : current.source;
			const selectionMatches =
				changes.source.kind === admittedSource.kind &&
				(changes.source.kind === "standard"
					? admittedSource.kind === "standard" &&
						admittedSource.templateId === changes.source.templateId
					: admittedSource.kind === "custom" &&
						admittedSource.interactionMode === changes.source.interactionMode &&
						(changes.source.interactionMode === "platform-adapter" ||
							(admittedSource.interactionMode === "self-managed" &&
								admittedSource.identityResponsibility ===
									changes.source.identityResponsibility)));
			const preservesSourceKind =
				current.source.kind === admittedSource.kind &&
				(current.source.kind === "standard"
					? admittedSource.kind === "standard" &&
						current.source.templateId === admittedSource.templateId
					: admittedSource.kind === "custom" &&
						current.source.interactionMode === admittedSource.interactionMode);
			if (
				admission.status !== "admitted" ||
				admission.schemaVersion !== 1 ||
				admission.agentId !== command.agentId ||
				admission.requestId !== command.requestId ||
				!selectionMatches ||
				!preservesSourceKind ||
				(preserveConnectionEnabled &&
					admittedSource.connectionEnabled !== current.source.connectionEnabled)
			) {
				throw new AgentConfigurationError("not_admitted");
			}
			if (
				release &&
				(admittedSource.kind !== "standard" ||
					current.source.kind !== "standard" ||
					admittedSource.imageDigest !== release.targetImageDigest ||
					!sameValue(
						{
							...admittedSource,
							imageDigest: undefined,
							admissionRevision: undefined,
						},
						{
							...current.source,
							imageDigest: undefined,
							admissionRevision: undefined,
						},
					))
			)
				throw new AgentConfigurationError("not_admitted");
			if (sameSourceConfiguration(admittedSource, current.source)) {
				source = current.source;
			} else {
				source = admittedSource;
				changedFields.push("source");
			}
		}

		let modelConfiguration = current.modelConfiguration;
		if (changes.modelConfiguration) {
			if (source.kind !== "standard") {
				throw new AgentConfigurationError("not_admitted");
			}
			let admission: Awaited<
				ReturnType<AgentConfigurationModelAdmissionPortV1["admitModels"]>
			>;
			try {
				admission = parseModelDecision(
					await dependencies.modelAdmission.admitModels({
						schemaVersion: 1,
						agentId: command.agentId,
						requestId: command.requestId,
						traceId: command.traceId,
						requested: structuredClone(changes.modelConfiguration),
						current: structuredClone(current.modelConfiguration),
					}),
				);
			} catch {
				throw new AgentConfigurationError("dependency_unavailable");
			}
			if (
				admission.status !== "admitted" ||
				admission.schemaVersion !== 1 ||
				admission.agentId !== command.agentId ||
				admission.requestId !== command.requestId
			) {
				throw new AgentConfigurationError("not_admitted");
			}
			try {
				modelConfiguration = parseAdmittedModel(
					admission.configuration,
					changes.modelConfiguration,
					current.modelConfiguration,
				);
			} catch {
				throw new AgentConfigurationError("not_admitted");
			}
			if (
				sameModelConfiguration(modelConfiguration, current.modelConfiguration)
			) {
				modelConfiguration = current.modelConfiguration;
			} else {
				changedFields.push("modelConfiguration");
			}
		}

		let environment = current.environment;
		if (changes.environment) {
			if (
				source.kind === "standard" &&
				changes.environment.some(
					({ name }) =>
						!source.allowedEnvironmentKeys.includes(name) ||
						source.platformManagedKeys.includes(name),
				)
			) {
				throw new AgentConfigurationError("not_admitted");
			}
			environment = changes.environment;
			if (!sameValue(environment, current.environment)) {
				changedFields.push("environment");
			}
		}

		let secrets = current.secrets;
		if (changes.secrets) {
			if (
				source.kind === "standard" &&
				changes.secrets.some(
					({ name }) =>
						!source.allowedSecretKeys.includes(name) ||
						source.platformManagedKeys.includes(name),
				)
			) {
				throw new AgentConfigurationError("not_admitted");
			}
			if (changes.secrets.length > 0) {
				let admission: Awaited<
					ReturnType<AgentConfigurationSecretAdmissionPortV1["admitSecrets"]>
				>;
				try {
					admission = parseSecretDecision(
						await dependencies.secretAdmission.admitSecrets({
							schemaVersion: 1,
							agentId: command.agentId,
							requestId: command.requestId,
							traceId: command.traceId,
							requested: structuredClone(changes.secrets),
							current: structuredClone(current.secrets),
						}),
					);
				} catch {
					throw new AgentConfigurationError("dependency_unavailable");
				}
				if (
					admission.status !== "admitted" ||
					admission.schemaVersion !== 1 ||
					admission.agentId !== command.agentId ||
					admission.requestId !== command.requestId ||
					admission.secrets.length !== changes.secrets.length
				) {
					throw new AgentConfigurationError("not_admitted");
				}
				const requestedNames = new Set(changes.secrets.map(({ name }) => name));
				const replacements = new Map<
					string,
					AgentConfigurationRecordV2["secrets"][number]
				>();
				for (const metadata of admission.secrets) {
					if (
						!requestedNames.has(metadata.name) ||
						replacements.has(metadata.name)
					) {
						throw new AgentConfigurationError("not_admitted");
					}
					replacements.set(metadata.name, {
						name: metadata.name,
						secretId: metadata.secretId,
						version: metadata.version,
						isSet: metadata.isSet,
					});
				}
				const merged = new Map(
					current.secrets.map((metadata) => [metadata.name, metadata]),
				);
				for (const [name, metadata] of replacements) {
					merged.set(name, metadata);
				}
				if (merged.size > maxSecretReplacements) {
					throw new AgentConfigurationError("not_admitted");
				}
				secrets = [...merged.values()].toSorted((left, right) =>
					compareText(left.name, right.name),
				);
				if (!sameValue(secrets, current.secrets)) {
					changedFields.push("secrets");
				}
			}
		}

		let channels = current.channels;
		let channelRevision = current.channelRevision;
		if (changes.channels) {
			if (
				source.kind === "custom" &&
				source.interactionMode === "self-managed"
			) {
				throw new AgentConfigurationError("not_admitted");
			}
			let admission: Awaited<
				ReturnType<AgentConfigurationChannelAdmissionPortV1["admitChannels"]>
			>;
			try {
				admission = parseChannelDecision(
					await dependencies.channelAdmission.admitChannels({
						schemaVersion: 1,
						agentId: command.agentId,
						requestId: command.requestId,
						traceId: command.traceId,
						requested: structuredClone(changes.channels),
						current: structuredClone(current.channels),
					}),
				);
			} catch {
				throw new AgentConfigurationError("dependency_unavailable");
			}
			const admittedChannels =
				admission.status === "admitted" ? admission.channels : [];
			const expected = new Map(
				current.channels.map((binding) => [binding.kind, binding]),
			);
			for (const change of changes.channels) {
				if (change.enabled) {
					expected.set(change.kind, {
						kind: change.kind,
						bindingReference: change.bindingReference,
					});
				} else {
					expected.delete(change.kind);
				}
			}
			const expectedChannels = [...expected.values()].toSorted((left, right) =>
				compareText(left.kind, right.kind),
			);
			if (
				admission.status !== "admitted" ||
				admission.schemaVersion !== 1 ||
				admission.agentId !== command.agentId ||
				admission.requestId !== command.requestId ||
				!isText(admission.channelRevision, idMaxBytes) ||
				!sameValue(admittedChannels, expectedChannels)
			) {
				throw new AgentConfigurationError("not_admitted");
			}
			channels = admittedChannels;
			if (!sameValue(channels, current.channels)) {
				channelRevision = admission.channelRevision;
				changedFields.push("channels");
			}
		}

		requireAdmittedConfigurationPolicy({
			source,
			modelConfiguration,
			environment,
			secrets,
			channels,
		});

		changedFields.sort();
		if (changedFields.length === 0) {
			throw new AgentConfigurationError("no_change");
		}
		let occurredAt: Date;
		try {
			const milliseconds = Date.prototype.getTime.call(now());
			if (!Number.isFinite(milliseconds)) throw new Error();
			occurredAt = new Date(milliseconds);
		} catch {
			throw new AgentConfigurationError("persistence_failed");
		}
		const accessOnly = changedFields.every(
			(field) => field === "owners" || field === "availability",
		);
		// Owner changes must re-run preflight because active Secrets bind to Owners.
		const runtimeUnchanged = changedFields.every(
			(field) => field === "availability",
		);
		const nextRevision = current.revision + (runtimeUnchanged ? 0 : 1);
		if (!Number.isSafeInteger(nextRevision)) {
			throw new AgentConfigurationError("persistence_failed");
		}
		const configuration: AgentConfigurationRecordV2 = {
			...current,
			revision: nextRevision,
			source,
			modelConfiguration,
			environment,
			secrets,
			channels,
			channelRevision,
		};
		const result: AgentConfigurationResultV1 = {
			schemaVersion: 1,
			agentId: command.agentId,
			revision: nextRevision,
			changedFields,
		};
		const plan: AgentConfigurationWritePlanV1 = {
			schemaVersion: 1,
			agentId: command.agentId,
			baseRevision: current.revision,
			nextRevision,
			expectedManagementRevision:
				authorization.accessAuthority?.state.revision ?? null,
			expectedAuthorizationRevision: readDecision.record.authorizationRevision,
			nextAuthorizationRevision: authorization.authorizationRevision,
			configuration,
			accessUpdate,
			result,
			idempotency: {
				key: command.idempotencyKey,
				requestDigest: digest,
			},
			outboxIntent: runtimeUnchanged
				? null
				: {
						operation: "agent.configuration.revised.v1",
						payload: {
							schemaVersion: 1,
							agentId: command.agentId,
							baseRevision: current.revision,
							configurationRevision: nextRevision,
							changedFields,
						},
						traceId: command.traceId,
						requestId: command.requestId,
						occurredAt,
					},
			auditEvent: {
				action: accessOnly
					? "agent.access.updated"
					: "agent.configuration.revised",
				actorId: actorContext.actorId,
				agentId: command.agentId,
				subjectType: "agent",
				subjectId: command.agentId,
				changedFields,
				traceId: command.traceId,
				requestId: command.requestId,
				occurredAt,
			},
		};
		let attachments: PendingSecretRecordAttachmentsV1 | undefined;
		if (resolveSecretRecordAttachments) {
			try {
				attachments = await resolvePendingSecretRecordAttachmentsV1({
					attachment,
					previousConfiguration: current,
					configuration: plan.configuration,
					ownerId: actorContext.actorId,
					occurredAt,
				});
			} catch {
				throw new AgentConfigurationError("dependency_unavailable");
			}
		}
		if (release && firstReleaseAuthority) {
			const latest = await admitStandardTemplateRelease(
				dependencies.standardTemplateReleaseAuthorization,
				release,
				{ requestId: command.requestId, traceId: command.traceId },
				actorContext,
			);
			if (
				latest.identityRevision !== firstReleaseAuthority.identityRevision ||
				latest.deploymentRevision !== firstReleaseAuthority.deploymentRevision
			)
				throw new AgentConfigurationError("not_authorized");
			if (
				latest.authorizationRevision !==
				readDecision.record.authorizationRevision
			)
				throw new AgentConfigurationError("stale_revision");
		}
		let decision: Awaited<
			ReturnType<AgentConfigurationTransactionPortV1["commit"]>
		>;
		try {
			const capturedPlan = snapshotAgentConfigurationWritePlanV1(plan);
			decision = parseTransactionCommitDecision(
				await dependencies.transaction.commit(capturedPlan, attachments),
				command.agentId,
			);
		} catch {
			throw new AgentConfigurationError("persistence_failed");
		}
		if (decision.outcome === "stale") {
			throw new AgentConfigurationError("stale_revision");
		}
		if (decision.outcome === "idempotency_conflict") {
			throw new AgentConfigurationError("idempotency_conflict");
		}
		if (!sameValue(decision.result, plan.result)) {
			throw new AgentConfigurationError("persistence_failed");
		}
		return decision.result;
	};
	return {
		async releaseStandardTemplate(commandInput, actorContextInput) {
			const command = parseReleaseStandardTemplateCommand(commandInput);
			const actorContext = parseActorContext(actorContextInput);
			const digest = platformIdempotencyV1.canonicalRequestDigest({
				schemaVersion: 1,
				operation: "standard_template.release_to_agent.v1",
				target: command.target as never,
				actorId: actorContext.actorId,
				rawRequestDigest: actorContext.rawRequestDigest,
			});
			return execute(
				{ ...command, agentId: command.target.agentId },
				actorContext,
				digest,
				(current) => {
					const target = command.target;
					if (
						current.source.kind !== "standard" ||
						current.source.templateId !== target.templateId
					)
						throw new AgentConfigurationError("not_admitted");
					if (
						current.revision !== target.expectedConfigurationRevision ||
						current.source.imageDigest !== target.expectedImageDigest
					)
						throw new AgentConfigurationError("stale_revision");
					return {
						source: { kind: "standard", templateId: target.templateId },
					};
				},
				true,
				undefined,
				command.target,
			);
		},
		async update(commandInput, actorContextInput, attachment) {
			const command = parseCommand(commandInput);
			const actorContext = parseActorContext(actorContextInput);
			return await execute(
				command,
				actorContext,
				requestDigest(command, actorContext),
				() => command.changes,
				false,
				attachment,
			);
		},
		async replayLegacyV1(commandInput, actorContextInput) {
			const command = parseLegacyUpdateCommand(commandInput);
			const actorContext = parseActorContext(actorContextInput);
			return execute(
				command,
				actorContext,
				requestDigest(command, actorContext),
				() => invalidCommand(),
			);
		},

		async upgradeCustomImage(commandInput, actorContextInput) {
			const command = parseUpgradeCustomImageCommand(commandInput);
			const actorContext = parseActorContext(actorContextInput);
			return await execute(
				command,
				actorContext,
				customImageUpgradeRequestDigest(command, actorContext),
				(current) => {
					if (current.source.kind !== "custom") {
						throw new AgentConfigurationError("not_admitted");
					}
					if (current.source.interactionMode === "self-managed") {
						const identityResponsibility =
							current.source.identityResponsibility;
						if (identityResponsibility === undefined) {
							throw new AgentConfigurationError("persistence_failed");
						}
						return {
							source: {
								kind: "custom",
								imageReference: command.imageReference,
								interactionMode: "self-managed",
								identityResponsibility,
							},
						};
					}
					return {
						source: {
							kind: "custom",
							imageReference: command.imageReference,
							interactionMode: "platform-adapter",
						},
					};
				},
				true,
			);
		},
	};
}

export function createAgentConfigurationUseCaseV1(
	dependencies: AgentConfigurationUseCaseDependenciesV1,
	options: AgentConfigurationUseCaseOptionsV1 = {},
): AgentConfigurationUseCaseV1 {
	return createAgentConfigurationUseCaseV1Internal(dependencies, true, options);
}

export async function captureAgentConfigurationWritePlanV1(input: {
	readonly command: UpdateAgentConfigurationCommandV2;
	readonly actorContext: AgentConfigurationActorContextV1;
	readonly current: AgentConfigurationRecordV2;
	readonly authorizationRevision: string;
	readonly dependencies: Omit<
		AgentConfigurationUseCaseDependenciesV1,
		"transaction"
	>;
	readonly now?: () => Date;
}): Promise<AgentConfigurationWritePlanV1 | null> {
	let captured: AgentConfigurationWritePlanV1 | undefined;
	const useCase = createAgentConfigurationUseCaseV1Internal(
		{
			...input.dependencies,
			transaction: {
				async read() {
					return {
						outcome: "ready" as const,
						record: {
							schemaVersion: 1 as const,
							configuration: input.current,
							authorizationRevision: input.authorizationRevision,
						},
					};
				},
				async commit(plan) {
					captured = snapshotAgentConfigurationWritePlanV1(plan);
					return { outcome: "committed" as const, result: plan.result };
				},
			},
		},
		false,
		{ now: input.now },
	);
	try {
		await useCase.update(input.command, input.actorContext);
	} catch (error) {
		if (
			error instanceof AgentConfigurationError &&
			error.code === "no_change"
		) {
			return null;
		}
		throw error;
	}
	return captured ?? null;
}
