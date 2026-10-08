import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	createSkillHubVersionV1,
	PersonalApiCredentialErrorV1,
	parseSkillHubIdempotencyKeyV1,
	parseSkillHubIdentitySnapshotV1,
	parseSkillHubIdV1,
	parseSkillHubRegistrationV1,
	parseSkillHubRequestV1,
	parseSkillHubReviewV1,
	platformIdempotencyV1,
	requirePersonalApiUserEnabledV1,
	requireSkillHubIndependentReviewerV1,
	requireSkillHubRegistrationParentV1,
	requireSkillHubReviewerV1,
	requireSkillHubVersionAccessV1,
	reviewSkillHubVersionV1,
	revokeSkillHubVersionV1,
	SkillHubLifecycleErrorV1,
	SkillHubOperationErrorV1,
	type SkillHubRequestV1,
	type SkillHubVersionV1,
	skillHubVersionStatesV1,
	skillHubVisibilityV1,
} from "@agent-infra/platform-core";
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
	auditEvents,
	idempotencyRecords,
	platformUserDisables,
} from "./schema.js";
import { skillHubSkills, skillHubVersions } from "./schema-skill-hub.js";

type Transaction = Parameters<
	Parameters<ReturnType<typeof drizzle>["transaction"]>[0]
>[0];
type Action = "register" | "review" | "revoke";
type VersionRow = typeof skillHubVersions.$inferSelect;
const skillParent = alias(skillHubSkills, "skill_parent");

function decode(row: VersionRow, name: string): SkillHubVersionV1 {
	try {
		const ref = parseSkillHubRegistrationV1({
			schemaVersion: 1,
			name,
			skillId: row.skillId,
			skillVersionId: row.id,
			visibility: row.visibility,
			provider: row.provider,
			version: row.version,
			packageObjectVersion: row.packageObjectVersion,
			packageDigest: row.packageDigest,
			manifestDigest: row.manifestDigest,
			signatureDigest: row.signatureDigest,
		});
		if (
			!skillHubVersionStatesV1.some((item) => item === row.state) ||
			!skillHubVisibilityV1.some((item) => item === row.visibility)
		)
			throw new Error();
		return Object.freeze({
			schemaVersion: 1,
			skillId: ref.skillId,
			skillVersionId: ref.skillVersionId,
			ownerId: row.ownerId,
			visibility: ref.visibility,
			provider: ref.provider,
			version: ref.version,
			packageObjectVersion: ref.packageObjectVersion,
			packageDigest: ref.packageDigest,
			manifestDigest: ref.manifestDigest,
			signatureDigest: ref.signatureDigest,
			state: row.state as SkillHubVersionV1["state"],
			needUpgrade: row.needUpgrade,
			reviewedBy: row.reviewedBy,
			reviewReason: row.reviewReason,
			revokedAt: row.revokedAt?.toISOString() ?? null,
		});
	} catch {
		throw new SkillHubOperationErrorV1("unavailable");
	}
}

function idempotencyWhere(
	request: SkillHubRequestV1,
	versionId: string,
	action: Action,
	key: string,
) {
	return and(
		eq(idempotencyRecords.scopeType, "skill_version"),
		eq(idempotencyRecords.scopeId, versionId),
		eq(idempotencyRecords.actorId, request.userId),
		eq(idempotencyRecords.commandType, `skill.version.${action}.v1`),
		eq(idempotencyRecords.idempotencyKey, key),
	);
}

async function audit(
	transaction: Pick<Transaction, "insert">,
	request: SkillHubRequestV1,
	action: string,
	versionId: string,
	outcome: "succeeded" | "rejected" | "failed",
	details: Record<string, unknown>,
) {
	await transaction.insert(auditEvents).values({
		id: randomUUID(),
		requestId: request.requestId,
		traceId: request.traceId,
		actorType: "user",
		actorId: request.userId,
		action,
		targetType: "unknown",
		targetId: versionId,
		outcome,
		details,
	});
}

/** Internal persistence boundary. Package verification/admission belongs to the package supplier. */
export class PostgresSkillHubLifecycleV1 {
	readonly #client;
	readonly #database;
	readonly #resolveIdentity;
	constructor(options: {
		readonly databaseUrl: string;
		/** Current existing IdentityAdapter actor/roles plus its authorization revision. */
		readonly resolveIdentity: (userId: string) => Promise<unknown>;
	}) {
		this.#client = postgres(options.databaseUrl, { max: 1 });
		this.#database = drizzle(this.#client);
		this.#resolveIdentity = options.resolveIdentity;
	}
	async close() {
		await this.#client.end();
	}

	async #transaction<T>(
		context: SkillHubRequestV1,
		work: (
			transaction: Transaction,
			request: SkillHubRequestV1,
			identity: ReturnType<typeof parseSkillHubIdentitySnapshotV1>,
		) => Promise<T>,
	): Promise<T> {
		const request = parseSkillHubRequestV1(context);
		const identity = async () => {
			const result = await this.#resolveIdentity(request.userId);
			if (result === null) throw new SkillHubOperationErrorV1("forbidden");
			return parseSkillHubIdentitySnapshotV1(result, request.userId);
		};
		try {
			return await this.#database.transaction(async (transaction) => {
				// Protect the missing disable row as in existing application governance.
				await transaction.execute(
					sql`lock table platform.platform_user_disables in share mode`,
				);
				const disabled = await transaction
					.select()
					.from(platformUserDisables)
					.where(eq(platformUserDisables.userId, request.userId));
				requirePersonalApiUserEnabledV1(disabled.length !== 0);
				const first = await identity();
				const result = await work(transaction, request, first);
				const current = await identity();
				if (!isDeepStrictEqual(first, current))
					throw new SkillHubOperationErrorV1("unavailable");
				return result;
			});
		} catch (error) {
			const failure =
				error instanceof SkillHubOperationErrorV1
					? error
					: error instanceof SkillHubLifecycleErrorV1
						? new SkillHubOperationErrorV1(error.code)
						: error instanceof PersonalApiCredentialErrorV1 &&
								error.code === "forbidden"
							? new SkillHubOperationErrorV1("forbidden")
							: new SkillHubOperationErrorV1("unavailable");
			try {
				await audit(
					this.#database,
					request,
					"skill.version.refused",
					"unknown",
					failure.code === "unavailable" ? "failed" : "rejected",
					{ reason: failure.code },
				);
			} catch {
				/* Failed audit cannot convert refusal into success. */
			}
			throw failure;
		}
	}

	async #version(transaction: Transaction, id: string) {
		// Keep parent -> version lock order identical to registration, including replay.
		const [parent] = await transaction
			.select({ id: skillParent.id, name: skillParent.name })
			.from(skillHubVersions)
			.innerJoin(skillParent, eq(skillParent.id, skillHubVersions.skillId))
			.where(eq(skillHubVersions.id, id))
			.for("update", { of: skillParent });
		if (!parent) throw new SkillHubOperationErrorV1("not_found");
		const [row] = await transaction
			.select()
			.from(skillHubVersions)
			.where(
				and(
					eq(skillHubVersions.id, id),
					eq(skillHubVersions.skillId, parent.id),
				),
			)
			.for("update");
		if (!row) throw new SkillHubOperationErrorV1("not_found");
		return decode(row, parent.name);
	}

	async #mutation(
		transaction: Transaction,
		request: SkillHubRequestV1,
		id: string,
		action: Action,
		keyInput: string,
		input: Parameters<typeof platformIdempotencyV1.canonicalRequestDigest>[0],
		work: (replayed: boolean) => Promise<SkillHubVersionV1>,
	) {
		const key = parseSkillHubIdempotencyKeyV1(keyInput);
		const digest = platformIdempotencyV1.canonicalRequestDigest(input);
		await transaction.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["skill_version", id, request.userId, action, key])}, 0))`,
		);
		const [prior] = await transaction
			.select()
			.from(idempotencyRecords)
			.where(idempotencyWhere(request, id, action, key));
		if (prior && prior.requestDigest !== digest)
			throw new SkillHubOperationErrorV1("idempotency_conflict");
		if (
			prior &&
			(prior.status !== "completed" ||
				prior.result?.skillVersionId !== id ||
				typeof prior.result?.versionIdentityDigest !== "string" ||
				!/^[a-f0-9]{64}$/.test(prior.result.versionIdentityDigest) ||
				Object.keys(prior.result).length !== 2)
		)
			throw new SkillHubOperationErrorV1("unavailable");
		const version = await work(prior !== undefined);
		const [stored] = await transaction
			.select({ createdAt: skillHubVersions.createdAt })
			.from(skillHubVersions)
			.where(eq(skillHubVersions.id, id));
		if (!stored) throw new SkillHubOperationErrorV1("unavailable");
		const versionIdentityDigest = platformIdempotencyV1.canonicalRequestDigest({
			skillId: version.skillId,
			skillVersionId: version.skillVersionId,
			ownerId: version.ownerId,
			visibility: version.visibility,
			provider: version.provider,
			version: version.version,
			packageObjectVersion: version.packageObjectVersion,
			packageDigest: version.packageDigest,
			manifestDigest: version.manifestDigest,
			signatureDigest: version.signatureDigest,
			createdAt: stored.createdAt.toISOString(),
		});
		if (prior && prior.result?.versionIdentityDigest !== versionIdentityDigest)
			throw new SkillHubOperationErrorV1("unavailable");
		if (!prior) {
			await transaction.insert(idempotencyRecords).values({
				id: randomUUID(),
				scopeType: "skill_version",
				scopeId: id,
				actorId: request.userId,
				commandType: `skill.version.${action}.v1`,
				idempotencyKey: key,
				requestDigest: digest,
				status: "completed",
				result: { skillVersionId: id, versionIdentityDigest },
			});
		}
		await audit(
			transaction,
			request,
			`skill.version.${action}`,
			id,
			"succeeded",
			{ state: version.state, replayed: prior !== undefined },
		);
		return { version, replayed: prior !== undefined };
	}

	async registerVersion(
		context: SkillHubRequestV1,
		key: string,
		input: unknown,
	) {
		return this.#transaction(
			context,
			async (transaction, request, identity) => {
				const command = parseSkillHubRegistrationV1(input);
				return this.#mutation(
					transaction,
					request,
					command.skillVersionId,
					"register",
					key,
					{ ...command },
					async (replayed) => {
						// Serialize the owner's name and the supplied aggregate id before its first insert.
						await transaction.execute(
							sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["skill_hub_owner_name", request.userId, command.name])}, 0))`,
						);
						await transaction.execute(
							sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["skill_hub_skill", command.skillId])}, 0))`,
						);
						const [parent] = await transaction
							.select()
							.from(skillHubSkills)
							.where(eq(skillHubSkills.id, command.skillId))
							.for("update");
						if (parent)
							requireSkillHubRegistrationParentV1(
								parent,
								command,
								request.userId,
							);
						if (replayed) {
							const version = await this.#version(
								transaction,
								command.skillVersionId,
							);
							requireSkillHubVersionAccessV1(version, identity.actor);
							if (
								version.ownerId !== request.userId ||
								version.skillId !== command.skillId
							)
								throw new SkillHubOperationErrorV1("unavailable");
							return version;
						}
						if (!parent) {
							const [sameName] = await transaction
								.select()
								.from(skillHubSkills)
								.where(
									and(
										eq(skillHubSkills.ownerId, request.userId),
										eq(skillHubSkills.name, command.name),
									),
								);
							if (sameName)
								throw new SkillHubOperationErrorV1("version_conflict");
							await transaction.insert(skillHubSkills).values({
								id: command.skillId,
								name: command.name,
								ownerId: request.userId,
								createdAt: new Date(),
								updatedAt: new Date(),
							});
						}
						const existing = await transaction
							.select()
							.from(skillHubVersions)
							.where(eq(skillHubVersions.id, command.skillVersionId));
						const sameVersion = await transaction
							.select()
							.from(skillHubVersions)
							.where(
								and(
									eq(skillHubVersions.skillId, command.skillId),
									eq(skillHubVersions.version, command.version),
								),
							);
						if (existing.length || sameVersion.length)
							throw new SkillHubOperationErrorV1("version_conflict");
						const {
							name: _name,
							schemaVersion: _schema,
							...reference
						} = command;
						const version = createSkillHubVersionV1({
							...reference,
							ownerId: request.userId,
						});
						await transaction.insert(skillHubVersions).values({
							id: version.skillVersionId,
							skillId: version.skillId,
							ownerId: version.ownerId,
							version: version.version,
							provider: version.provider,
							visibility: version.visibility,
							state: version.state,
							packageObjectVersion: version.packageObjectVersion,
							packageDigest: version.packageDigest,
							manifestDigest: version.manifestDigest,
							signatureDigest: version.signatureDigest,
							reviewedBy: version.reviewedBy,
							createdAt: new Date(),
						});
						return this.#version(transaction, version.skillVersionId);
					},
				);
			},
		);
	}

	async reviewVersion(
		context: SkillHubRequestV1,
		versionId: string,
		key: string,
		input: unknown,
	) {
		return this.#transaction(
			context,
			async (transaction, request, identity) => {
				requireSkillHubReviewerV1(identity.actor);
				const id = parseSkillHubIdV1(versionId);
				const review = parseSkillHubReviewV1(input);
				return this.#mutation(
					transaction,
					request,
					id,
					"review",
					key,
					{ ...review },
					async (replayed) => {
						const version = await this.#version(transaction, id);
						requireSkillHubIndependentReviewerV1(version, identity.actor);
						if (replayed) return version;
						const next = reviewSkillHubVersionV1(version, {
							...review,
							reviewerId: request.userId,
						});
						const updated = await transaction
							.update(skillHubVersions)
							.set({
								state: next.state,
								reviewedBy: next.reviewedBy,
								reviewReason: next.reviewReason,
							})
							.where(
								and(
									eq(skillHubVersions.id, id),
									eq(skillHubVersions.state, version.state),
								),
							)
							.returning({ id: skillHubVersions.id });
						if (updated.length !== 1)
							throw new SkillHubOperationErrorV1("unavailable");
						return this.#version(transaction, id);
					},
				);
			},
		);
	}

	async revokeVersion(
		context: SkillHubRequestV1,
		versionId: string,
		key: string,
	) {
		return this.#transaction(
			context,
			async (transaction, request, identity) => {
				const id = parseSkillHubIdV1(versionId);
				return this.#mutation(
					transaction,
					request,
					id,
					"revoke",
					key,
					{},
					async (replayed) => {
						const version = await this.#version(transaction, id);
						requireSkillHubVersionAccessV1(version, identity.actor);
						if (replayed) return version;
						const next = revokeSkillHubVersionV1(
							version,
							new Date().toISOString(),
						);
						const updated = await transaction
							.update(skillHubVersions)
							.set({
								state: next.state,
								revokedAt: new Date(next.revokedAt ?? ""),
							})
							.where(
								and(
									eq(skillHubVersions.id, id),
									eq(skillHubVersions.state, version.state),
								),
							)
							.returning({ id: skillHubVersions.id });
						if (updated.length !== 1)
							throw new SkillHubOperationErrorV1("unavailable");
						return this.#version(transaction, id);
					},
				);
			},
		);
	}

	async readVersion(context: SkillHubRequestV1, versionId: string) {
		return this.#transaction(
			context,
			async (transaction, request, identity) => {
				const version = await this.#version(
					transaction,
					parseSkillHubIdV1(versionId),
				);
				requireSkillHubVersionAccessV1(version, identity.actor);
				await audit(
					transaction,
					request,
					"skill.version.read",
					version.skillVersionId,
					"succeeded",
					{ state: version.state, replayed: false },
				);
				return version;
			},
		);
	}
}
