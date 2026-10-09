import {
	canViewSkillHubVersionV1,
	parseSkillHubGrantV1,
	parseSkillHubRegistrationV1,
	type SkillHubAgentBindingAdmissionPortV1,
	type SkillHubGrantV1,
} from "@agent-infra/platform-core";
import { and, eq, inArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { idempotencyRecords } from "./schema-operations.js";
import {
	skillHubInstallations,
	skillHubSkills,
	skillHubVersions,
} from "./schema-skill-hub.js";

export class SkillHubAgentBindingAdmissionErrorV1 extends Error {
	readonly code = "unavailable" as const;
	constructor() {
		super("Skill Hub binding admission unavailable");
		this.name = "SkillHubAgentBindingAdmissionErrorV1";
	}
}

/** Reads current installation, publication and package-admission facts only. */
export class PostgresSkillHubAgentBindingAdmissionV1
	implements SkillHubAgentBindingAdmissionPortV1
{
	readonly #client;
	readonly #database;

	constructor(options: { readonly databaseUrl: string }) {
		this.#client = postgres(options.databaseUrl, { max: 5 });
		this.#database = drizzle(this.#client);
	}

	async close(): Promise<void> {
		await this.#client.end();
	}

	async admit(
		input: Parameters<SkillHubAgentBindingAdmissionPortV1["admit"]>[0],
	) {
		try {
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
