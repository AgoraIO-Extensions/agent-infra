import { validateAgentWorkloadDesiredV1 } from "@agent-infra/contracts/workload";
import {
	type AgentConfigurationAccessTargetV1,
	type AgentConfigurationRecordV2,
	type AgentManagementStateV1,
	type AgentRuntimePresentationDecisionV1,
	type AgentRuntimePresentationExpectationV1,
	type AgentRuntimePresentationFactsV1,
	decideAgentRuntimePresentationV1,
	isAgentOwnerV1,
	isAgentRuntimePresentationVisibleV1,
	snapshotAgentRuntimePresentationExpectationV1,
} from "@agent-infra/platform-core";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { default as postgres } from "postgres";
import {
	AgentConfigurationStoreError,
	canonicalSourceReference,
	maxAccessTargets,
	type PostgresAgentConfigurationOptionsV1,
	validateText,
} from "./agent-configuration.shared.js";
import { decodeAgentConfigurationRecord } from "./agent-configuration-record.js";
import { readAgentManagementState } from "./agent-management.js";
import {
	agentAvailability,
	agentConfigurationRevisions,
	agentOwners,
	agents,
	workloadReconciliations,
} from "./schema.js";
import { decodePersistedWorkloadStateV1 } from "./workload-reconciliation.js";

export type AgentConfigurationQueryIntentV1 = "discover" | "manage";

export interface AgentConfigurationQueryInputV1 {
	readonly agentId: string;
	readonly actorId: string;
	readonly organizationIds: readonly string[];
	readonly isAdministrator: boolean;
	readonly intent: AgentConfigurationQueryIntentV1;
}

export interface AgentConfigurationProjectionV1 {
	readonly agentId: string;
	readonly revision: number;
	readonly source:
		| {
				readonly kind: "standard";
				readonly templateId: string;
				readonly connectionEnabled: boolean;
		  }
		| {
				readonly kind: "custom";
				readonly interactionMode: "self-managed" | "platform-adapter";
				readonly identityResponsibility?: "self-managed" | "platform-managed";
				readonly connectionEnabled: boolean;
		  };
	readonly ownerIds: readonly string[];
	readonly availability: readonly AgentConfigurationAccessTargetV1[];
	readonly modelOptions: readonly {
		readonly optionId: string;
		readonly modelId: string;
		readonly reasoningLevels: readonly string[];
	}[];
	readonly defaultModelOptionId: string | null;
	readonly defaultReasoningLevel: string | null;
	readonly environment: AgentConfigurationRecordV2["environment"];
	readonly channelKinds: readonly ("wecom_bot" | "wecom_app")[];
	readonly secrets: readonly {
		readonly name: string;
		readonly isSet: true;
		readonly version: number;
	}[];
}

export type AgentConfigurationQueryResultV1 =
	| {
			readonly outcome: "found";
			readonly configuration: AgentConfigurationProjectionV1;
	  }
	| { readonly outcome: "unavailable" };

export type AgentConfigurationAuthorityQueryInputV1 = Omit<
	AgentConfigurationQueryInputV1,
	"intent"
>;

export type AgentConfigurationAuthorityQueryResultV1 =
	| {
			readonly outcome: "found";
			readonly configuration: AgentConfigurationRecordV2;
			readonly management: AgentManagementStateV1;
			readonly authorizationRevision: string;
	  }
	| { readonly outcome: "unavailable" };

export interface AgentRuntimePresentationQueryInputV1 {
	readonly agentId: string;
	readonly actorId: string;
	readonly organizationIds: readonly string[];
	readonly isAdministrator: boolean;
	/** Resolved by the authenticated Platform identity adapter; never inferred from ownership. */
	readonly accountStatus: "active" | "disabled" | "revoked";
	readonly expected: AgentRuntimePresentationExpectationV1;
}

export type AgentRuntimePresentationQueryResultV1 =
	AgentRuntimePresentationDecisionV1;

export class PostgresAgentConfigurationQueryV1 {
	readonly #client;
	readonly #database;

	constructor(options: PostgresAgentConfigurationOptionsV1) {
		this.#client = postgres(options.databaseUrl, { max: 10 });
		this.#database = drizzle(this.#client);
	}

	/** Bounded facts for the separate deployment release policy; grants no Owner authority. */
	async readStandardTemplateReleaseAuthority(input: {
		readonly agentId: string;
		readonly templateId: string;
	}): Promise<
		| {
				readonly outcome: "found";
				readonly authorizationRevision: string;
				readonly configurationRevision: number;
				readonly source: Extract<
					AgentConfigurationRecordV2["source"],
					{ kind: "standard" }
				>;
		  }
		| { readonly outcome: "unavailable" }
	> {
		try {
			if (!validateText(input.agentId) || !validateText(input.templateId))
				throw new AgentConfigurationStoreError();
			const [current] = await this.#database
				.select({
					configuration: agentConfigurationRevisions.configuration,
					revision: agents.currentConfigurationRevision,
					sourceReference: agentConfigurationRevisions.sourceReference,
					authorizationRevision: agents.authorizationRevision,
				})
				.from(agents)
				.innerJoin(
					agentConfigurationRevisions,
					and(
						eq(agentConfigurationRevisions.agentId, agents.id),
						eq(
							agentConfigurationRevisions.revision,
							agents.currentConfigurationRevision,
						),
					),
				)
				.where(eq(agents.id, input.agentId))
				.limit(1);
			if (!current?.configuration) return { outcome: "unavailable" };
			const configuration = decodeAgentConfigurationRecord(
				current.configuration,
			);
			if (
				configuration.agentId !== input.agentId ||
				configuration.revision !== current.revision ||
				canonicalSourceReference(configuration) !== current.sourceReference ||
				!validateText(current.authorizationRevision)
			)
				throw new AgentConfigurationStoreError();
			if (
				configuration.source.kind !== "standard" ||
				configuration.source.templateId !== input.templateId
			)
				return { outcome: "unavailable" };
			return {
				outcome: "found",
				authorizationRevision: current.authorizationRevision,
				configurationRevision: current.revision,
				source: configuration.source,
			};
		} catch {
			throw new AgentConfigurationStoreError();
		}
	}

	/** Internal admission material; an administrator role never grants Owner authority. */
	async readAuthority(
		input: AgentConfigurationAuthorityQueryInputV1,
	): Promise<AgentConfigurationAuthorityQueryResultV1> {
		try {
			if (
				!validateText(input.agentId) ||
				!validateText(input.actorId) ||
				typeof input.isAdministrator !== "boolean" ||
				!Array.isArray(input.organizationIds) ||
				input.organizationIds.length > maxAccessTargets ||
				input.organizationIds.some((id) => !validateText(id))
			)
				throw new AgentConfigurationStoreError();
			return await this.#database.transaction(
				async (transaction) => {
					const management = await readAgentManagementState(
						transaction,
						input.agentId,
					);
					if (!management || !isAgentOwnerV1(management, input.actorId))
						return { outcome: "unavailable" };
					if (
						management.agentId !== input.agentId ||
						management.ownerIds.length === 0 ||
						new Set(management.ownerIds).size !== management.ownerIds.length ||
						management.ownerIds.some((id) => !validateText(id))
					)
						throw new AgentConfigurationStoreError();
					const [current] = await transaction
						.select({
							configuration: agentConfigurationRevisions.configuration,
							revision: agents.currentConfigurationRevision,
							sourceReference: agentConfigurationRevisions.sourceReference,
							authorizationRevision: agents.authorizationRevision,
						})
						.from(agents)
						.innerJoin(
							agentConfigurationRevisions,
							and(
								eq(agentConfigurationRevisions.agentId, agents.id),
								eq(
									agentConfigurationRevisions.revision,
									agents.currentConfigurationRevision,
								),
							),
						)
						.where(eq(agents.id, input.agentId))
						.limit(1);
					if (!current?.configuration) return { outcome: "unavailable" };
					const configuration = decodeAgentConfigurationRecord(
						current.configuration,
					);
					if (
						configuration.agentId !== input.agentId ||
						configuration.revision !== current.revision ||
						canonicalSourceReference(configuration) !==
							current.sourceReference ||
						!validateText(current.authorizationRevision)
					)
						throw new AgentConfigurationStoreError();
					return {
						outcome: "found",
						configuration,
						management,
						authorizationRevision: current.authorizationRevision,
					};
				},
				{ isolationLevel: "repeatable read", accessMode: "read only" },
			);
		} catch (error) {
			if (error instanceof AgentConfigurationStoreError) throw error;
			throw new AgentConfigurationStoreError();
		}
	}

	/** Read one database snapshot; Core decides whether it matches the upstream projection. */
	async readRuntimePresentation(
		input: AgentRuntimePresentationQueryInputV1,
	): Promise<AgentRuntimePresentationQueryResultV1> {
		try {
			if (
				!validateText(input.agentId) ||
				!validateText(input.actorId) ||
				(input.accountStatus !== "active" &&
					input.accountStatus !== "disabled" &&
					input.accountStatus !== "revoked") ||
				typeof input.isAdministrator !== "boolean" ||
				!Array.isArray(input.organizationIds) ||
				input.organizationIds.length > maxAccessTargets ||
				input.organizationIds.some((id) => !validateText(id))
			)
				throw new AgentConfigurationStoreError();
			const expected = snapshotAgentRuntimePresentationExpectationV1(
				input.expected,
			);
			const actor = {
				schemaVersion: 1 as const,
				userId: input.actorId,
				accountStatus:
					input.accountStatus === "active"
						? ("active" as const)
						: ("disabled" as const),
				organizationIds: [...input.organizationIds],
				isAdministrator: input.isAdministrator,
			};
			return await this.#database.transaction(
				async (transaction) => {
					const management = await readAgentManagementState(
						transaction,
						input.agentId,
					);
					if (
						!management ||
						!isAgentRuntimePresentationVisibleV1(management, actor)
					)
						return { outcome: "unavailable" };
					const [current] = await transaction
						.select({
							configuration: agentConfigurationRevisions.configuration,
							revision: agents.currentConfigurationRevision,
							sourceReference: agentConfigurationRevisions.sourceReference,
						})
						.from(agents)
						.innerJoin(
							agentConfigurationRevisions,
							and(
								eq(agentConfigurationRevisions.agentId, agents.id),
								eq(
									agentConfigurationRevisions.revision,
									agents.currentConfigurationRevision,
								),
							),
						)
						.where(eq(agents.id, input.agentId))
						.limit(1);
					if (!current?.configuration) return { outcome: "unavailable" };
					const configuration = decodeAgentConfigurationRecord(
						current.configuration,
					);
					if (
						configuration.agentId !== input.agentId ||
						configuration.revision !== current.revision ||
						canonicalSourceReference(configuration) !== current.sourceReference
					)
						throw new AgentConfigurationStoreError();
					const [row] = await transaction
						.select({
							revision: workloadReconciliations.revision,
							state: workloadReconciliations.state,
						})
						.from(workloadReconciliations)
						.where(eq(workloadReconciliations.agentId, input.agentId))
						.limit(1);
					let runtime: AgentRuntimePresentationFactsV1["runtime"] = null;
					if (row) {
						let persisted: ReturnType<typeof decodePersistedWorkloadStateV1> =
							null;
						try {
							persisted = decodePersistedWorkloadStateV1(
								row.state,
								input.agentId,
							);
						} catch {
							/* Invalid persisted runtime data provides no verified facts. */
						}
						if (persisted && !persisted.legacy && persisted.state.verified) {
							const state = persisted.state;
							const verified = persisted.state.verified;
							const [active] = await transaction
								.select({
									configuration: agentConfigurationRevisions.configuration,
									sourceReference: agentConfigurationRevisions.sourceReference,
								})
								.from(agentConfigurationRevisions)
								.where(
									and(
										eq(agentConfigurationRevisions.agentId, input.agentId),
										eq(
											agentConfigurationRevisions.revision,
											verified.configuration.revision,
										),
									),
								)
								.limit(1);
							if (active?.configuration) {
								try {
									const verifiedConfiguration = decodeAgentConfigurationRecord(
										active.configuration,
									);
									if (
										verifiedConfiguration.agentId !== input.agentId ||
										verifiedConfiguration.revision !==
											verified.configuration.revision ||
										canonicalSourceReference(verifiedConfiguration) !==
											active.sourceReference
									)
										throw new AgentConfigurationStoreError();
									runtime = {
										revision: row.revision,
										state,
										verifiedConfiguration,
										verifiedSourceReference: active.sourceReference,
										deployment: validateAgentWorkloadDesiredV1(
											verified.deployment,
										),
									};
								} catch {
									/* Incomplete history or invalid deployment is not runtime evidence. */
								}
							}
						}
					}
					return decideAgentRuntimePresentationV1({
						agentId: input.agentId,
						actor,
						expected,
						facts: {
							management,
							configuration,
							sourceReference: current.sourceReference,
							runtime,
						},
					});
				},
				{ isolationLevel: "repeatable read", accessMode: "read only" },
			);
		} catch (error) {
			if (error instanceof AgentConfigurationStoreError) throw error;
			throw new AgentConfigurationStoreError();
		}
	}

	async read(
		input: AgentConfigurationQueryInputV1,
	): Promise<AgentConfigurationQueryResultV1> {
		try {
			if (
				!validateText(input.agentId) ||
				!validateText(input.actorId) ||
				typeof input.isAdministrator !== "boolean" ||
				(input.intent !== "discover" && input.intent !== "manage") ||
				!Array.isArray(input.organizationIds) ||
				input.organizationIds.length > maxAccessTargets ||
				input.organizationIds.some(
					(organizationId) => !validateText(organizationId),
				)
			) {
				throw new AgentConfigurationStoreError();
			}
			return await this.#database.transaction(
				async (transaction) => {
					const [current] = await transaction
						.select({
							currentConfigurationRevision: agents.currentConfigurationRevision,
							configuration: agentConfigurationRevisions.configuration,
							sourceReference: agentConfigurationRevisions.sourceReference,
						})
						.from(agents)
						.innerJoin(
							agentConfigurationRevisions,
							and(
								eq(agentConfigurationRevisions.agentId, agents.id),
								eq(
									agentConfigurationRevisions.revision,
									agents.currentConfigurationRevision,
								),
							),
						)
						.where(eq(agents.id, input.agentId))
						.limit(1);
					if (!current?.configuration) return { outcome: "unavailable" };
					const [owners, availabilityRows] = await Promise.all([
						transaction
							.select({ ownerId: agentOwners.ownerId })
							.from(agentOwners)
							.where(eq(agentOwners.agentId, input.agentId)),
						transaction
							.select({
								targetType: agentAvailability.targetType,
								targetId: agentAvailability.targetId,
							})
							.from(agentAvailability)
							.where(eq(agentAvailability.agentId, input.agentId)),
					]);
					const ownerIds = owners.map(({ ownerId }) => ownerId).toSorted();
					if (
						ownerIds.length === 0 ||
						new Set(ownerIds).size !== ownerIds.length ||
						ownerIds.some((ownerId) => !validateText(ownerId)) ||
						availabilityRows.some(
							({ targetType, targetId }) =>
								(targetType !== "user" &&
									targetType !== "organization" &&
									targetType !== "application") ||
								!validateText(targetId),
						)
					) {
						throw new AgentConfigurationStoreError();
					}
					const availability: AgentConfigurationAccessTargetV1[] =
						availabilityRows
							.map(({ targetType, targetId }) =>
								targetType === "user"
									? { kind: "user" as const, userId: targetId }
									: targetType === "organization"
										? {
												kind: "organization" as const,
												organizationId: targetId,
											}
										: {
												kind: "application" as const,
												applicationId: targetId,
											},
							)
							.toSorted((left, right) => {
								const leftKey =
									left.kind === "user"
										? `user\0${left.userId}`
										: left.kind === "organization"
											? `organization\0${left.organizationId}`
											: `application\0${left.applicationId}`;
								const rightKey =
									right.kind === "user"
										? `user\0${right.userId}`
										: right.kind === "organization"
											? `organization\0${right.organizationId}`
											: `application\0${right.applicationId}`;
								return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
							});
					const owner = ownerIds.includes(input.actorId);
					const available = availability.some((target) =>
						target.kind === "user"
							? target.userId === input.actorId
							: target.kind === "organization" &&
								input.organizationIds.includes(target.organizationId),
					);
					if (
						!input.isAdministrator &&
						!owner &&
						(input.intent === "manage" || !available)
					) {
						return { outcome: "unavailable" };
					}

					const configuration = decodeAgentConfigurationRecord(
						current.configuration,
					);
					if (
						configuration.agentId !== input.agentId ||
						configuration.revision !== current.currentConfigurationRevision ||
						current.sourceReference !== canonicalSourceReference(configuration)
					) {
						throw new AgentConfigurationStoreError();
					}
					const projectedSource =
						configuration.source.kind === "standard"
							? {
									kind: "standard" as const,
									templateId: current.sourceReference,
									connectionEnabled: configuration.source.connectionEnabled,
								}
							: {
									kind: "custom" as const,
									interactionMode: configuration.source.interactionMode,
									...(configuration.source.interactionMode === "self-managed"
										? {
												identityResponsibility:
													configuration.source.identityResponsibility,
											}
										: {}),
									connectionEnabled: configuration.source.connectionEnabled,
								};
					return {
						outcome: "found",
						configuration: {
							agentId: configuration.agentId,
							revision: configuration.revision,
							source: projectedSource,
							ownerIds,
							availability,
							modelOptions:
								configuration.modelConfiguration?.options.map((option) => ({
									optionId: option.optionId,
									modelId: option.modelId,
									reasoningLevels: option.reasoningLevels,
								})) ?? [],
							defaultModelOptionId:
								configuration.modelConfiguration?.defaultOptionId ?? null,
							defaultReasoningLevel:
								configuration.modelConfiguration?.defaultReasoningLevel ?? null,
							environment: configuration.environment,
							channelKinds: configuration.channels.map(({ kind }) => kind),
							secrets: configuration.secrets.map(({ name, version }) => ({
								name,
								isSet: true as const,
								version,
							})),
						},
					};
				},
				{ isolationLevel: "repeatable read", accessMode: "read only" },
			);
		} catch (error) {
			if (error instanceof AgentConfigurationStoreError) throw error;
			throw new AgentConfigurationStoreError();
		}
	}

	async close(): Promise<void> {
		try {
			await this.#client.end();
		} catch {
			throw new AgentConfigurationStoreError();
		}
	}
}
