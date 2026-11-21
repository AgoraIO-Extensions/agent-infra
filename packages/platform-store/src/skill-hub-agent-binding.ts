import { randomUUID } from "node:crypto";
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
	type SkillSyncAttemptV1,
	SkillSyncErrorV1,
	type SkillSyncFailureV1,
	skillSyncFailureCodeV1,
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

export class SkillHubAgentBindingAdmissionErrorV1 extends SkillSyncErrorV1 {
	readonly code = "unavailable" as const;
	constructor(
		reason: "dependency_unavailable" | "denied" = "dependency_unavailable",
	) {
		super({
			stage: "binding_admission",
			reason,
			retryable: reason === "dependency_unavailable",
		});
		this.name = "SkillHubAgentBindingAdmissionErrorV1";
	}
}

export class SkillHubAppliedReceiptErrorV1 extends SkillSyncErrorV1 {
	readonly code:
		| "invalid_receipt"
		| "not_found"
		| "stale_revision"
		| "mismatch"
		| "invalid_state"
		| "persistence_failed";

	constructor(code: SkillHubAppliedReceiptErrorV1["code"]) {
		super({
			stage: "applied_persistence",
			reason:
				code === "persistence_failed"
					? "dependency_unavailable"
					: code === "stale_revision" ||
							code === "invalid_state" ||
							code === "not_found"
						? "stale_binding"
						: "invalid_binding",
			retryable: code === "persistence_failed",
		});
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

	async captureSyncAttempt(
		input: Omit<SkillSyncAttemptV1, "bindings">,
	): Promise<SkillSyncAttemptV1 | null> {
		const rows = await this.#client<
			{ skill_version_id: string; sync_revision: number }[]
		>`
		 select b.skill_version_id,b.sync_revision::text from platform.agents a
		 join platform.agent_configuration_revisions cr on cr.agent_id=a.id and cr.revision=a.current_configuration_revision
		 join platform.agent_applications m on m.agent_id=a.id
		 join platform.workload_reconciliations w on w.agent_id=a.id
		 join platform.skill_hub_agent_bindings b on b.agent_id=a.id and b.configuration_revision=coalesce(cr.runtime_revision,a.current_configuration_revision)
		 where a.id=${input.agentId} and b.agent_version=${input.agentVersion} and b.configuration_revision=${input.configurationRevision}
		 and w.revision=${input.workloadRevision} and w.state->>'fence'=${String(input.fence)} and w.state->>'phase'='preflight' and w.state->>'sourceConfigurationRevision'=${String(input.configurationRevision)}
		 and m.fence=${input.fence} and m.desired_state='running'
		 and ( ${input.isAdministrator} or exists(select 1 from platform.agent_owners ao where ao.agent_id=a.id and ao.owner_id=${input.actorId}))
		 and b.state='pending_sync' order by b.skill_version_id limit 33`;
		if (!rows.length || rows.length > 32) return null;
		return {
			...input,
			bindings: rows.map((r) => ({
				skillVersionId: r.skill_version_id,
				syncRevision: Number(r.sync_revision),
			})),
		};
	}
	async recordSyncFailure(input: {
		attempt: SkillSyncAttemptV1;
		failure: SkillSyncFailureV1;
	}): Promise<boolean> {
		const code = skillSyncFailureCodeV1(input.failure);
		const a = input.attempt;
		if (
			!a.bindings.length ||
			a.bindings.length > 32 ||
			new Set(a.bindings.map((b) => b.skillVersionId)).size !==
				a.bindings.length ||
			![
				a.configurationRevision,
				a.workloadRevision,
				a.fence,
				...a.bindings.map((b) => b.syncRevision),
			].every((n) => Number.isSafeInteger(n) && n > 0)
		)
			return false;
		return this.#client.begin(async (tx) => {
			const [agent] =
				await tx`select id from platform.agents where id=${a.agentId} for update`;
			if (!agent) return false;
			await tx`select agent_id from platform.agent_applications where agent_id=${a.agentId} for update`;
			const [work] =
				await tx`select w.agent_id from platform.workload_reconciliations w join platform.agent_applications m on m.agent_id=w.agent_id join platform.agents ag on ag.id=w.agent_id join platform.agent_configuration_revisions cr on cr.agent_id=ag.id and cr.revision=ag.current_configuration_revision
		 where w.agent_id=${a.agentId} and w.revision=${a.workloadRevision} and w.state->>'fence'=${String(a.fence)} and w.state->>'phase'='preflight' and w.state->>'sourceConfigurationRevision'=${String(a.configurationRevision)} and m.fence=${a.fence} and m.desired_state='running' and coalesce(cr.runtime_revision,ag.current_configuration_revision)=${a.configurationRevision}
		 and (${a.isAdministrator} or exists(select 1 from platform.agent_owners ao where ao.agent_id=w.agent_id and ao.owner_id=${a.actorId})) for update of w`;
			if (!work) return false;
			const pending: (typeof a.bindings)[number][] = [];
			for (const b of a.bindings) {
				const [row] =
					await tx`select skill_version_id,state,applied_receipt is not null as applied from platform.skill_hub_agent_bindings where agent_id=${a.agentId} and agent_version=${a.agentVersion} and configuration_revision=${a.configurationRevision} and skill_version_id=${b.skillVersionId} and sync_revision=${b.syncRevision} and state in ('pending_sync','synced') for update`;
				if (!row) return false;
				if (row.state === "synced") {
					if (!row.applied) return false;
				} else pending.push(b);
			}
			for (const b of pending) {
				if (!input.failure.retryable)
					await tx`update platform.skill_hub_agent_bindings set state='failed',failure_reason=${code},updated_at=clock_timestamp() where agent_id=${a.agentId} and agent_version=${a.agentVersion} and configuration_revision=${a.configurationRevision} and skill_version_id=${b.skillVersionId} and sync_revision=${b.syncRevision} and state='pending_sync'`;
				await tx`insert into platform.audit_events(id,trace_id,actor_type,actor_id,action,target_type,target_id,agent_id,outcome,details) values(${randomUUID()},${`skill-sync:${a.agentId}:${a.configurationRevision}:${a.agentVersion}:${b.skillVersionId}:${b.syncRevision}`},'system','platform-worker','skill.binding.sync.failed','skill_binding',${b.skillVersionId},${a.agentId},'failed',${JSON.stringify({ schemaVersion: 1, agentVersion: a.agentVersion, configurationRevision: a.configurationRevision, syncRevision: b.syncRevision, workloadRevision: a.workloadRevision, fence: a.fence, stage: input.failure.stage, reason: input.failure.reason, retryable: input.failure.retryable, code })}::jsonb)`;
			}
			return true;
		});
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
				await transaction.execute(
					sql`select id from platform.agents where id=${receipt.agentId} for update`,
				);
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
					const projected = await Promise.all(
						bindings.map(async (binding) => {
							if (binding.state !== "pending_sync") return binding;
							const latest = await transaction.execute(
								sql`select details from platform.audit_events where trace_id=${`skill-sync:${input.agentId}:${runtimeRevision}:${input.agentVersion}:${binding.skillVersion.skillVersionId}:${binding.syncRevision}`} and agent_id=${input.agentId} and target_id=${binding.skillVersion.skillVersionId} and action='skill.binding.sync.failed' order by occurred_at desc,id desc limit 1`,
							);
							const failure = latest[0]?.details as
								| (SkillSyncFailureV1 & { code: string })
								| undefined;
							if (!failure) return binding;
							const code = skillSyncFailureCodeV1(failure);
							if (code !== failure.code) return binding;
							return SkillHubSyncBindingV1Schema.parse({
								...binding,
								state: "failed",
								failureReason: code,
							});
						}),
					);
					return { configurationRevision, bindings: projected };
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
			if (
				error instanceof SkillHubAgentBindingAdmissionErrorV1 ||
				error instanceof SkillSyncErrorV1
			)
				throw error;
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
				throw new SkillHubAgentBindingAdmissionErrorV1("denied");
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
