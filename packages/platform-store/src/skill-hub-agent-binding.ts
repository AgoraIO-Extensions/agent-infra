import {
	type SkillHubAppliedReceiptV1,
	SkillHubAppliedReceiptV1Schema,
	type SkillHubSyncBindingV1,
	SkillHubSyncBindingV1Schema,
	SkillVersionRefV1Schema,
} from "@agent-infra/contracts";
import {
	canViewSkillHubVersionV1,
	isSkillHubGrantWithinBoundaryV1,
	parseSkillHubGrantV1,
	parseSkillHubRegistrationV1,
	type SkillHubAgentBindingAdmissionPortV1,
	type SkillHubAgentBindingRequestV1,
	type SkillHubAgentBindingStatusPortV1,
	type SkillHubGrantV1,
} from "@agent-infra/platform-core";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "./observed-postgres.js";
import { agentConfigurationRevisions, agents } from "./schema-agents.js";
import { idempotencyRecords } from "./schema-operations.js";
import {
	skillHubAgentBindings,
	skillHubInstallations,
	skillHubSkills,
	skillHubVersions,
} from "./schema-skill-hub.js";
import { readSkillPackagePublicationV1 } from "./skill-package-publication-reader.js";

export class SkillHubAgentBindingAdmissionErrorV1 extends Error {
	readonly code = "unavailable" as const;
	constructor() {
		super("Skill Hub binding admission unavailable");
		this.name = "SkillHubAgentBindingAdmissionErrorV1";
	}
}

export class SkillHubAppliedReceiptErrorV1 extends Error {
	readonly code:
		| "invalid_receipt"
		| "not_found"
		| "stale_revision"
		| "mismatch"
		| "invalid_state"
		| "persistence_failed";

	constructor(code: SkillHubAppliedReceiptErrorV1["code"]) {
		super("Skill Hub Applied receipt rejected");
		this.name = "SkillHubAppliedReceiptErrorV1";
		this.code = code;
	}
}

const emptyGrant: SkillHubGrantV1 = {
	schemaVersion: 1,
	tools: [],
	connections: [],
	fileRoots: [],
	networkOrigins: [],
	scripts: false,
};

type BindingReader = Pick<ReturnType<typeof drizzle>, "select">;

/**
 * Skill 绑定属于 Runtime 输入（ADR-0028）：绑定按 Runtime 修订解析，只改渠道的配置修订
 * 继续使用上一个 Runtime 修订的绑定。该子查询取 Agent 当前配置修订行的 Runtime 修订。
 */
const currentRuntimeRevision = sql<number>`coalesce((
	select cr.runtime_revision from ${agentConfigurationRevisions} cr
	where cr.agent_id = ${agents.id} and cr.revision = ${agents.currentConfigurationRevision}
), ${agents.currentConfigurationRevision})`.mapWith(Number);

type SyncBindingQueryV1 = {
	readonly agentId: string;
	readonly agentVersion: string;
	readonly configurationRevision: number;
	readonly actorId: string;
	readonly organizationIds: readonly string[];
	readonly isAdministrator: boolean;
};

/** Reads current installation, publication and package-admission facts only. */
export class PostgresSkillHubAgentBindingAdmissionV1
	implements
		SkillHubAgentBindingAdmissionPortV1,
		SkillHubAgentBindingStatusPortV1<SkillHubSyncBindingV1>
{
	readonly #client;
	readonly #database;
	readonly #resolveGrantBoundary;

	constructor(options: {
		readonly databaseUrl: string;
		/** Existing server-side capability facts; absent means deny every requested capability. */
		readonly resolveGrantBoundary?: (input: {
			readonly agentId: string;
			readonly actorId: string;
			readonly requested: readonly SkillHubAgentBindingRequestV1[];
		}) => Promise<
			readonly {
				readonly skillVersionId: string;
				readonly grant: SkillHubGrantV1;
			}[]
		>;
	}) {
		this.#client = postgres(options.databaseUrl, { max: 5 });
		this.#database = drizzle(this.#client);
		this.#resolveGrantBoundary = options.resolveGrantBoundary;
	}

	/** Full original publication facts for an already authorized immutable binding. */
	async readPublication(input: {
		readonly skillVersionId: string;
		readonly packageObjectVersion: string;
	}) {
		return this.#database.transaction(
			(transaction) => readSkillPackagePublicationV1(transaction, input),
			{ isolationLevel: "repeatable read", accessMode: "read only" },
		);
	}

	async close(): Promise<void> {
		await this.#client.end();
	}

	/** Atomically records one verified Worker materialization receipt. */
	async recordAppliedReceipt(
		input: unknown,
	): Promise<SkillHubAppliedReceiptV1> {
		let receipt: SkillHubAppliedReceiptV1;
		try {
			receipt = SkillHubAppliedReceiptV1Schema.parse(input);
		} catch {
			throw new SkillHubAppliedReceiptErrorV1("invalid_receipt");
		}
		try {
			return await this.#database.transaction(async (transaction) => {
				const [row] = await transaction
					.select({
						binding: skillHubAgentBindings,
						version: skillHubVersions,
						name: skillHubSkills.name,
						currentRuntimeRevision,
					})
					.from(skillHubAgentBindings)
					.innerJoin(
						skillHubVersions,
						eq(skillHubVersions.id, skillHubAgentBindings.skillVersionId),
					)
					.innerJoin(
						skillHubSkills,
						eq(skillHubSkills.id, skillHubVersions.skillId),
					)
					.innerJoin(agents, eq(agents.id, skillHubAgentBindings.agentId))
					.where(
						and(
							eq(skillHubAgentBindings.agentId, receipt.agentId),
							eq(skillHubAgentBindings.agentVersion, receipt.agentVersion),
							eq(
								skillHubAgentBindings.configurationRevision,
								receipt.configurationRevision,
							),
							eq(skillHubAgentBindings.skillVersionId, receipt.skillVersionId),
						),
					)
					.for("update")
					.limit(1);
				if (!row) throw new SkillHubAppliedReceiptErrorV1("not_found");

				if (
					Number(row.currentRuntimeRevision) !== receipt.configurationRevision
				)
					throw new SkillHubAppliedReceiptErrorV1("stale_revision");
				if (row.binding.syncRevision !== receipt.syncRevision)
					throw new SkillHubAppliedReceiptErrorV1("stale_revision");

				if (row.binding.state === "synced") {
					let existing: SkillHubAppliedReceiptV1;
					try {
						existing = SkillHubAppliedReceiptV1Schema.parse(
							row.binding.appliedReceipt,
						);
					} catch {
						throw new SkillHubAppliedReceiptErrorV1("invalid_state");
					}
					if (sameAppliedReceipt(existing, receipt)) return existing;
					throw new SkillHubAppliedReceiptErrorV1("mismatch");
				}
				if (row.binding.state !== "pending_sync")
					throw new SkillHubAppliedReceiptErrorV1("invalid_state");
				if (
					receipt.skillName !== row.name ||
					receipt.packageDigest !== row.version.packageDigest ||
					receipt.manifestDigest !== row.version.manifestDigest ||
					receipt.targetPath !== `.agents/skills/${row.name}`
				)
					throw new SkillHubAppliedReceiptErrorV1("mismatch");

				await transaction
					.update(skillHubAgentBindings)
					.set({
						state: "synced",
						failureReason: null,
						appliedReceipt: receipt,
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(skillHubAgentBindings.agentId, receipt.agentId),
							eq(skillHubAgentBindings.agentVersion, receipt.agentVersion),
							eq(
								skillHubAgentBindings.configurationRevision,
								receipt.configurationRevision,
							),
							eq(skillHubAgentBindings.skillVersionId, receipt.skillVersionId),
							eq(skillHubAgentBindings.syncRevision, receipt.syncRevision),
						),
					);
				return receipt;
			});
		} catch (error) {
			if (error instanceof SkillHubAppliedReceiptErrorV1) throw error;
			throw new SkillHubAppliedReceiptErrorV1("persistence_failed");
		}
	}

	/** 当前 Agent 配置修订（`agents.current_configuration_revision`）。 */
	async readCurrentConfigurationRevision(input: {
		readonly agentId: string;
	}): Promise<number> {
		try {
			const [agent] = await this.#database
				.select({
					currentConfigurationRevision: agents.currentConfigurationRevision,
				})
				.from(agents)
				.where(eq(agents.id, input.agentId))
				.limit(1);
			const revision = Number(agent?.currentConfigurationRevision);
			if (!Number.isSafeInteger(revision) || revision < 1)
				throw new SkillHubAgentBindingAdmissionErrorV1();
			return revision;
		} catch (error) {
			if (error instanceof SkillHubAgentBindingAdmissionErrorV1) throw error;
			throw new SkillHubAgentBindingAdmissionErrorV1();
		}
	}

	/**
	 * Owner 读取：在同一只读快照里取当前配置修订，再按它的 Runtime 修订解析绑定（#2903、
	 * ADR-0028）。返回的配置修订供绑定写入做 CAS；调用方不提交修订号，避免把管理修订当作
	 * 配置修订使用。
	 */
	async readCurrentBindings(
		input: Omit<SyncBindingQueryV1, "configurationRevision">,
	): Promise<{
		readonly configurationRevision: number;
		readonly bindings: readonly SkillHubSyncBindingV1[];
	}> {
		try {
			return await this.#database.transaction(
				async (transaction) => {
					const [agent] = await transaction
						.select({
							currentConfigurationRevision: agents.currentConfigurationRevision,
							currentRuntimeRevision,
						})
						.from(agents)
						.where(eq(agents.id, input.agentId))
						.limit(1);
					const configurationRevision = Number(
						agent?.currentConfigurationRevision,
					);
					const runtimeRevision = Number(agent?.currentRuntimeRevision);
					if (
						!Number.isSafeInteger(configurationRevision) ||
						configurationRevision < 1 ||
						!Number.isSafeInteger(runtimeRevision) ||
						runtimeRevision < 1 ||
						runtimeRevision > configurationRevision
					)
						throw new SkillHubAgentBindingAdmissionErrorV1();
					const bindings = await this.#resolveSyncBindings(transaction, {
						...input,
						configurationRevision: runtimeRevision,
					});
					return { configurationRevision, bindings };
				},
				{ isolationLevel: "repeatable read", accessMode: "read only" },
			);
		} catch (error) {
			if (error instanceof SkillHubAgentBindingAdmissionErrorV1) throw error;
			throw new SkillHubAgentBindingAdmissionErrorV1();
		}
	}

	/** Resolve the current binding facts for Worker materialization. */
	async resolveSyncBindings(
		input: SyncBindingQueryV1,
	): Promise<readonly SkillHubSyncBindingV1[]> {
		try {
			return await this.#resolveSyncBindings(this.#database, input);
		} catch (error) {
			if (error instanceof SkillHubAgentBindingAdmissionErrorV1) throw error;
			throw new SkillHubAgentBindingAdmissionErrorV1();
		}
	}

	async #resolveSyncBindings(
		database: BindingReader,
		input: SyncBindingQueryV1,
	): Promise<readonly SkillHubSyncBindingV1[]> {
		const [agent] = await database
			.select({ currentRuntimeRevision })
			.from(agents)
			.where(eq(agents.id, input.agentId))
			.limit(1);
		// The Worker resolves bindings for the Workload's Runtime revision.
		if (
			!agent ||
			Number(agent.currentRuntimeRevision) !== input.configurationRevision
		)
			return [];
		const rows = await database
			.select({
				binding: skillHubAgentBindings,
				version: skillHubVersions,
				name: skillHubSkills.name,
				parentStatus: skillHubSkills.status,
				organizationId: skillHubSkills.organizationId,
			})
			.from(skillHubAgentBindings)
			.innerJoin(
				skillHubVersions,
				eq(skillHubVersions.id, skillHubAgentBindings.skillVersionId),
			)
			.innerJoin(
				skillHubSkills,
				eq(skillHubSkills.id, skillHubVersions.skillId),
			)
			.where(
				and(
					eq(skillHubAgentBindings.agentId, input.agentId),
					eq(skillHubAgentBindings.agentVersion, input.agentVersion),
					eq(
						skillHubAgentBindings.configurationRevision,
						input.configurationRevision,
					),
				),
			);
		if (rows.length === 0) return [];
		const skillVersionIds = rows.map((row) => row.binding.skillVersionId);
		const admissions = await database
			.select({ scopeId: idempotencyRecords.scopeId })
			.from(idempotencyRecords)
			.where(
				and(
					eq(idempotencyRecords.scopeType, "skill_package"),
					inArray(idempotencyRecords.scopeId, skillVersionIds),
					eq(idempotencyRecords.status, "completed"),
				),
			);
		const admitted = new Set(admissions.map((row) => row.scopeId));
		const principalScope = input.organizationIds.length
			? or(
					and(
						eq(skillHubInstallations.principalType, "user"),
						eq(skillHubInstallations.principalId, input.actorId),
					),
					and(
						eq(skillHubInstallations.principalType, "organization"),
						inArray(skillHubInstallations.principalId, input.organizationIds),
					),
				)
			: and(
					eq(skillHubInstallations.principalType, "user"),
					eq(skillHubInstallations.principalId, input.actorId),
				);
		const installations = await database
			.select({ skillVersionId: skillHubInstallations.skillVersionId })
			.from(skillHubInstallations)
			.where(
				and(
					inArray(skillHubInstallations.skillVersionId, skillVersionIds),
					eq(skillHubInstallations.state, "installed"),
					principalScope,
				),
			);
		const installed = new Set(installations.map((row) => row.skillVersionId));
		const requested = rows.map((row) => ({
			skillVersionId: row.binding.skillVersionId,
			grant: parseSkillHubGrantV1(row.binding.grant),
		}));
		// 与 admit 一致：没有部署端能力事实时，边界是空 grant（拒绝一切额外能力）。
		const boundaryRows = this.#resolveGrantBoundary
			? await this.#resolveGrantBoundary({
					agentId: input.agentId,
					actorId: input.actorId,
					requested,
				})
			: requested.map((row) => ({
					skillVersionId: row.skillVersionId,
					grant: emptyGrant,
				}));
		const grants = new Map(
			boundaryRows.map((row) => [row.skillVersionId, row.grant]),
		);
		return rows.map((row) => {
			const persistedGrant = parseSkillHubGrantV1(row.binding.grant);
			const boundaryGrant = grants.get(row.binding.skillVersionId);
			const registration = parseSkillHubRegistrationV1({
				schemaVersion: 1,
				name: row.name,
				skillId: row.version.skillId,
				skillVersionId: row.version.id,
				visibility: row.version.visibility,
				provider: row.version.provider,
				version: row.version.version,
				packageObjectVersion: row.version.packageObjectVersion,
				packageDigest: row.version.packageDigest,
				manifestDigest: row.version.manifestDigest,
				signatureDigest: row.version.signatureDigest,
			});
			const visible = canViewSkillHubVersionV1(
				{
					...registration,
					ownerId: row.version.ownerId,
					state: row.version.state as never,
					needUpgrade: row.version.needUpgrade,
					reviewedBy: row.version.reviewedBy,
					reviewReason: row.version.reviewReason,
					revokedAt: row.version.revokedAt?.toISOString() ?? null,
				},
				{
					schemaVersion: 1,
					userId: input.actorId,
					accountStatus: "active",
					organizationIds: input.organizationIds,
					isAdministrator: input.isAdministrator,
				},
				row.organizationId,
				row.parentStatus,
			);
			if (
				!visible ||
				row.version.state !== "published" ||
				row.parentStatus !== "active" ||
				!admitted.has(row.binding.skillVersionId) ||
				!installed.has(row.binding.skillVersionId) ||
				boundaryGrant === undefined ||
				!isSkillHubGrantWithinBoundaryV1(persistedGrant, boundaryGrant)
			)
				throw new SkillHubAgentBindingAdmissionErrorV1();
			const appliedReceipt =
				row.binding.state === "synced"
					? SkillHubAppliedReceiptV1Schema.parse(row.binding.appliedReceipt)
					: null;
			return SkillHubSyncBindingV1Schema.parse({
				schemaVersion: 1,
				agentId: row.binding.agentId,
				agentVersion: row.binding.agentVersion,
				skillName: row.name,
				skillVersion: SkillVersionRefV1Schema.parse({
					schemaVersion: 1,
					skillId: registration.skillId,
					skillVersionId: registration.skillVersionId,
					provider: registration.provider,
					version: registration.version,
					packageObjectVersion: registration.packageObjectVersion,
					packageDigest: registration.packageDigest,
					manifestDigest: registration.manifestDigest,
					signatureDigest: registration.signatureDigest,
				}),
				grant: persistedGrant,
				configurationRevision: row.binding.configurationRevision,
				syncRevision: row.binding.syncRevision,
				state: row.binding.state,
				failureReason: row.binding.failureReason,
				appliedReceipt,
			});
		});
	}

	async admit(
		input: Parameters<SkillHubAgentBindingAdmissionPortV1["admit"]>[0],
	) {
		try {
			const boundaryRows = this.#resolveGrantBoundary
				? await this.#resolveGrantBoundary({
						agentId: input.agentId,
						actorId: input.actorId,
						requested: input.requested,
					})
				: input.requested.map((requested) => ({
						skillVersionId: requested.skillVersionId,
						grant: emptyGrant,
					}));
			const boundaryByVersion = new Map(
				boundaryRows.map((row) => [row.skillVersionId, row.grant]),
			);
			if (
				boundaryRows.length !== input.requested.length ||
				input.requested.some((requested) => {
					const allowed = boundaryByVersion.get(requested.skillVersionId);
					return (
						allowed === undefined ||
						!isSkillHubGrantWithinBoundaryV1(requested.grant, allowed)
					);
				})
			)
				return {
					schemaVersion: 1 as const,
					status: "rejected" as const,
					reason: "forbidden" as const,
				};
			return await this.#database.transaction(async (transaction) => {
				const versions = await transaction
					.select({
						version: skillHubVersions,
						name: skillHubSkills.name,
						parentStatus: skillHubSkills.status,
						organizationId: skillHubSkills.organizationId,
					})
					.from(skillHubVersions)
					.innerJoin(
						skillHubSkills,
						eq(skillHubSkills.id, skillHubVersions.skillId),
					)
					.where(
						inArray(
							skillHubVersions.id,
							input.requested.map((item) => item.skillVersionId),
						),
					)
					.for("update");
				const versionById = new Map(
					versions.map((row) => [row.version.id, row]),
				);
				const admitted: {
					readonly skillVersionId: string;
					readonly principalType: "user" | "organization";
					readonly principalId: string;
					readonly grant: SkillHubGrantV1;
				}[] = [];
				for (const requested of input.requested) {
					const row = versionById.get(requested.skillVersionId);
					if (!row)
						return {
							schemaVersion: 1 as const,
							status: "rejected" as const,
							reason: "version_unavailable" as const,
						};
					const version = parseSkillHubRegistrationV1({
						schemaVersion: 1,
						name: row.name,
						skillId: row.version.skillId,
						skillVersionId: row.version.id,
						visibility: row.version.visibility,
						provider: row.version.provider,
						version: row.version.version,
						packageObjectVersion: row.version.packageObjectVersion,
						packageDigest: row.version.packageDigest,
						manifestDigest: row.version.manifestDigest,
						signatureDigest: row.version.signatureDigest,
					});
					const visible = canViewSkillHubVersionV1(
						{
							...version,
							ownerId: row.version.ownerId,
							state: row.version.state as never,
							needUpgrade: row.version.needUpgrade,
							reviewedBy: row.version.reviewedBy,
							reviewReason: row.version.reviewReason,
							revokedAt: row.version.revokedAt?.toISOString() ?? null,
						},
						{
							schemaVersion: 1,
							userId: input.actorId,
							accountStatus: "active",
							organizationIds: input.organizationIds,
							isAdministrator: input.isAdministrator,
						},
						row.organizationId,
						row.parentStatus,
					);
					if (!visible || row.version.state !== "published")
						return {
							schemaVersion: 1 as const,
							status: "rejected" as const,
							reason: "version_unavailable" as const,
						};
					const admission = await transaction
						.select({ id: idempotencyRecords.id })
						.from(idempotencyRecords)
						.where(
							and(
								eq(idempotencyRecords.scopeType, "skill_package"),
								eq(idempotencyRecords.scopeId, requested.skillVersionId),
								eq(idempotencyRecords.status, "completed"),
							),
						)
						.limit(1);
					if (admission.length !== 1)
						return {
							schemaVersion: 1 as const,
							status: "rejected" as const,
							reason: "version_unavailable" as const,
						};
					const installations = await transaction
						.select({
							principalType: skillHubInstallations.principalType,
							principalId: skillHubInstallations.principalId,
						})
						.from(skillHubInstallations)
						.where(
							and(
								eq(
									skillHubInstallations.skillVersionId,
									requested.skillVersionId,
								),
								eq(skillHubInstallations.state, "installed"),
								or(
									and(
										eq(skillHubInstallations.principalType, "user"),
										eq(skillHubInstallations.principalId, input.actorId),
									),
									input.organizationIds.length
										? and(
												eq(skillHubInstallations.principalType, "organization"),
												inArray(
													skillHubInstallations.principalId,
													input.organizationIds,
												),
											)
										: undefined,
								),
							),
						)
						.limit(1);
					const installation = installations[0];
					if (!installation)
						return {
							schemaVersion: 1 as const,
							status: "rejected" as const,
							reason: "forbidden" as const,
						};
					admitted.push({
						skillVersionId: requested.skillVersionId,
						principalType: installation.principalType as
							| "user"
							| "organization",
						principalId: installation.principalId,
						grant: parseSkillHubGrantV1(requested.grant),
					});
				}
				return {
					schemaVersion: 1 as const,
					status: "admitted" as const,
					bindings: admitted,
				};
			});
		} catch {
			throw new SkillHubAgentBindingAdmissionErrorV1();
		}
	}
}

function sameAppliedReceipt(
	left: SkillHubAppliedReceiptV1,
	right: SkillHubAppliedReceiptV1,
): boolean {
	return (
		left.schemaVersion === right.schemaVersion &&
		left.agentId === right.agentId &&
		left.agentVersion === right.agentVersion &&
		left.skillName === right.skillName &&
		left.configurationRevision === right.configurationRevision &&
		left.syncRevision === right.syncRevision &&
		left.skillVersionId === right.skillVersionId &&
		left.generationId === right.generationId &&
		left.packageDigest === right.packageDigest &&
		left.manifestDigest === right.manifestDigest &&
		left.targetPath === right.targetPath &&
		left.readOnly === right.readOnly
	);
}
