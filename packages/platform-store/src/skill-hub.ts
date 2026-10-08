import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
	canInstallSkillHubVersionV1,
	canViewSkillHubVersionV1,
	createSkillHubVersionV1,
	PersonalApiCredentialErrorV1,
	parseSkillHubIdempotencyKeyV1,
	parseSkillHubIdentitySnapshotV1,
	parseSkillHubIdV1,
	parseSkillHubInstallationCommandV1,
	parseSkillHubRegistrationV1,
	parseSkillHubRequestV1,
	parseSkillHubReviewV1,
	parseSkillPackagePublicationSelectionV1,
	parseSkillPackagePublicationStateV1,
	platformIdempotencyV1,
	requirePersonalApiUserEnabledV1,
	requireSkillHubIndependentReviewerV1,
	requireSkillHubRegistrationParentV1,
	requireSkillHubReviewerV1,
	requireSkillHubVersionAccessV1,
	reviewSkillHubVersionV1,
	revokeSkillHubVersionV1,
	type SkillHubInstallationCommandV1,
	type SkillHubInstallationV1,
	SkillHubLifecycleErrorV1,
	SkillHubOperationErrorV1,
	type SkillHubRegistrationV1,
	type SkillHubRequestV1,
	type SkillHubVersionV1,
	type SkillPackagePublicationContextV1,
	type SkillPackagePublicationStateV1,
	skillHubVersionStatesV1,
	skillHubVisibilityV1,
	skillPackagePublicationStagesV1,
	uninstallSkillHubInstallationV1,
} from "@agent-infra/platform-core";
import { and, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createPostgresOutboxStore } from "./outbox.js";
import {
	auditEvents,
	idempotencyRecords,
	outboxItems,
	persistedEvents,
	platformUserDisables,
} from "./schema.js";
import {
	skillHubInstallations,
	skillHubSkills,
	skillHubVersions,
} from "./schema-skill-hub.js";

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

function installationScope(command: SkillHubInstallationCommandV1) {
	return `${command.principalType}:${command.principalId}:${command.skillVersionId}`;
}

function decodeInstallation(
	row: typeof skillHubInstallations.$inferSelect,
): SkillHubInstallationV1 {
	if (
		!(["user", "organization"] as const).includes(
			row.principalType as "user" | "organization",
		) ||
		!(["installed", "uninstalled", "failed"] as const).includes(
			row.state as "installed" | "uninstalled" | "failed",
		)
	)
		throw new SkillHubOperationErrorV1("unavailable");
	return Object.freeze({
		schemaVersion: 1,
		installationId: row.id,
		principalType: row.principalType as "user" | "organization",
		principalId: row.principalId,
		skillVersionId: row.skillVersionId,
		state: row.state as "installed" | "uninstalled" | "failed",
		needUpgrade: row.needUpgrade,
		installedAt: row.installedAt.toISOString(),
		updatedAt: row.updatedAt.toISOString(),
	});
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
	readonly #outbox;
	constructor(options: {
		readonly databaseUrl: string;
		/** Current existing IdentityAdapter actor/roles plus its authorization revision. */
		readonly resolveIdentity: (userId: string) => Promise<unknown>;
	}) {
		this.#client = postgres(options.databaseUrl, { max: 1 });
		this.#database = drizzle(this.#client);
		this.#outbox = createPostgresOutboxStore({
			databaseUrl: options.databaseUrl,
		});
		this.#resolveIdentity = options.resolveIdentity;
	}
	async close() {
		await this.#client.end();
		await this.#outbox.close();
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
		return this.#transaction(context, (transaction, request, identity) =>
			this.#register(transaction, request, identity, key, input),
		);
	}
	async #register(
		transaction: Transaction,
		request: SkillHubRequestV1,
		identity: ReturnType<typeof parseSkillHubIdentitySnapshotV1>,
		key: string,
		input: unknown,
	) {
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
					requireSkillHubRegistrationParentV1(parent, command, request.userId);
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
					if (sameName) throw new SkillHubOperationErrorV1("version_conflict");
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
				const { name: _name, schemaVersion: _schema, ...reference } = command;
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
	}
	/** Internal supplier boundary: durable intent and checkpoints in the original outbox. */
	async publishPackage(
		context: SkillHubRequestV1,
		keyInput: string,
		input: unknown,
		work: (
			context: SkillPackagePublicationContextV1,
		) => Promise<SkillHubRegistrationV1>,
		revalidate: () => Promise<void>,
	) {
		const selection = parseSkillPackagePublicationSelectionV1(input);
		const key = parseSkillHubIdempotencyKeyV1(keyInput);
		const digest = platformIdempotencyV1.canonicalRequestDigest({
			...selection,
		});
		const reserved = await this.#transaction(
			context,
			async (tx, request, identity) => {
				await tx.execute(
					sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["skill_package", selection.skillVersionId])}, 0))`,
				);
				const prior = await tx
					.select()
					.from(idempotencyRecords)
					.where(
						and(
							eq(idempotencyRecords.scopeType, "skill_package"),
							eq(idempotencyRecords.scopeId, selection.skillVersionId),
						),
					);
				const original = prior.find(
					(row) =>
						row.actorId === request.userId &&
						row.idempotencyKey === key &&
						row.commandType === "skill.package.publish.v1",
				);
				const priorOutbox = await tx
					.select({ id: outboxItems.id, status: outboxItems.status })
					.from(outboxItems)
					.where(
						and(
							eq(outboxItems.scopeType, "skill_package"),
							eq(outboxItems.scopeId, selection.skillVersionId),
						),
					);
				if (
					prior.length &&
					!original &&
					(priorOutbox.length !== prior.length ||
						priorOutbox.some((row) => row.status !== "failed"))
				)
					throw new SkillHubOperationErrorV1("version_conflict");
				if (original && original.requestDigest !== digest)
					throw new SkillHubOperationErrorV1("idempotency_conflict");
				const [parent] = await tx
					.select()
					.from(skillHubSkills)
					.where(eq(skillHubSkills.id, selection.skillId));
				if (
					parent &&
					(parent.ownerId !== request.userId ||
						parent.name !== selection.name ||
						parent.status !== "active")
				)
					throw new SkillHubOperationErrorV1("forbidden");
				if (!original) {
					const [existing] = await tx
						.select()
						.from(skillHubVersions)
						.where(eq(skillHubVersions.id, selection.skillVersionId));
					if (existing) throw new SkillHubOperationErrorV1("version_conflict");
					const operationId = randomUUID();
					const state = parseSkillPackagePublicationStateV1({
						schemaVersion: 1,
						operationId,
						ownerId: request.userId,
						selection,
						intents: {},
						objects: {},
					});
					await tx.insert(idempotencyRecords).values({
						id: operationId,
						scopeType: "skill_package",
						scopeId: selection.skillVersionId,
						actorId: request.userId,
						commandType: "skill.package.publish.v1",
						idempotencyKey: key,
						requestDigest: digest,
						status: "reserved",
					});
					await tx.insert(outboxItems).values({
						id: operationId,
						scopeType: "skill_package",
						scopeId: selection.skillVersionId,
						operation: "skill.package.publish.v1",
						payload: { ...state },
						traceId: request.traceId,
						requestId: request.requestId,
					});
					return { state, identity, completed: false };
				}
				const [item] = await tx
					.select()
					.from(outboxItems)
					.where(eq(outboxItems.id, original.id));
				if (
					item?.scopeType !== "skill_package" ||
					item.scopeId !== selection.skillVersionId ||
					item.operation !== "skill.package.publish.v1"
				)
					throw new SkillHubOperationErrorV1("unavailable");
				const state = parseSkillPackagePublicationStateV1(item.payload);
				if (
					state.operationId !== original.id ||
					state.ownerId !== request.userId ||
					!isDeepStrictEqual(state.selection, selection) ||
					(original.status === "completed") !== (item.status === "succeeded") ||
					(original.status === "completed" &&
						!isDeepStrictEqual(original.result, {
							operationId: original.id,
							skillVersionId: selection.skillVersionId,
						}))
				)
					throw new SkillHubOperationErrorV1("unavailable");
				return { state, identity, completed: original.status === "completed" };
			},
		);
		let state = reserved.state;
		const leaseOwner = randomUUID();
		const claim = reserved.completed
			? null
			: await this.#outbox.claim({
					itemId: state.operationId,
					leaseOwner,
					leaseDurationMs: 300_000,
				});
		if (!reserved.completed && !claim)
			throw new SkillHubOperationErrorV1("unavailable");
		const lease = claim && {
			itemId: state.operationId,
			leaseOwner,
			deliveryFence: claim.deliveryFence,
		};
		if (claim) {
			const claimed = parseSkillPackagePublicationStateV1(claim.payload);
			if (
				claimed.operationId !== state.operationId ||
				claimed.ownerId !== state.ownerId ||
				!isDeepStrictEqual(claimed.selection, state.selection)
			)
				throw new SkillHubOperationErrorV1("unavailable");
			state = claimed;
		}
		const checkIdentity = (
			identity: ReturnType<typeof parseSkillHubIdentitySnapshotV1>,
		) => {
			if (!isDeepStrictEqual(identity, reserved.identity))
				throw new SkillHubOperationErrorV1("forbidden");
		};
		const guard = async () => {
			await this.#transaction(context, async (_tx, _request, identity) => {
				checkIdentity(identity);
			});
			if (
				lease &&
				!(await this.#outbox.renew({ ...lease, leaseDurationMs: 300_000 }))
			)
				throw new SkillHubOperationErrorV1("unavailable");
		};
		const checkpoint = async (next: SkillPackagePublicationStateV1) => {
			if (!lease) throw new SkillHubOperationErrorV1("unavailable");
			const parsed = parseSkillPackagePublicationStateV1(next);
			await this.#transaction(context, async (tx, _request, identity) => {
				checkIdentity(identity);
				const rows = await tx
					.update(outboxItems)
					.set({ payload: { ...parsed }, updatedAt: new Date() })
					.where(
						and(
							eq(outboxItems.id, lease.itemId),
							eq(outboxItems.status, "processing"),
							eq(outboxItems.leaseOwner, lease.leaseOwner),
							eq(outboxItems.deliveryFence, lease.deliveryFence),
							sql`${outboxItems.leaseExpiresAt} > clock_timestamp()`,
							sql`${outboxItems.payload} = ${JSON.stringify(state)}::jsonb`,
						),
					)
					.returning({ id: outboxItems.id });
				if (rows.length !== 1)
					throw new SkillHubOperationErrorV1("unavailable");
			});
			state = parsed;
		};
		try {
			const publication: SkillPackagePublicationContextV1 = {
				replayed: reserved.completed,
				get state() {
					return state;
				},
				guard,
				intend: async (stage, intent) => {
					const prior = state.intents[stage];
					if (prior && !isDeepStrictEqual(prior, intent))
						throw new SkillHubOperationErrorV1("idempotency_conflict");
					if (!prior)
						await checkpoint({
							...state,
							intents: { ...state.intents, [stage]: intent },
						});
				},
				save: async (stage, object) => {
					const prior = state.objects[stage];
					if (prior && !isDeepStrictEqual(prior, object))
						throw new SkillHubOperationErrorV1("unavailable");
					if (!prior)
						await checkpoint({
							...state,
							objects: { ...state.objects, [stage]: object },
						});
				},
			};
			await guard();
			const registration = parseSkillHubRegistrationV1(await work(publication));
			await guard();
			const zip = state.objects.zip;
			const manifest = state.objects.manifest;
			const signature = state.objects.signature;
			if (
				!zip ||
				!manifest ||
				!signature ||
				!skillPackagePublicationStagesV1.every(
					(stage) => state.objects[stage],
				) ||
				registration.packageObjectVersion !== zip.version ||
				registration.packageDigest !== selection.archiveDigest ||
				registration.manifestDigest !== manifest.sha256 ||
				registration.signatureDigest !== signature.sha256
			)
				throw new SkillHubOperationErrorV1("unavailable");
			for (const field of [
				"name",
				"skillId",
				"skillVersionId",
				"visibility",
				"provider",
				"version",
			] as const)
				if (registration[field] !== selection[field])
					throw new SkillHubOperationErrorV1("unavailable");
			const result = await this.#transaction(
				context,
				async (tx, request, identity) => {
					checkIdentity(identity);
					await revalidate();
					const registered = await this.#register(
						tx,
						request,
						identity,
						`package-${state.operationId}`,
						registration,
					);
					if (lease) {
						const rows = await tx
							.update(outboxItems)
							.set({
								status: "succeeded",
								leaseOwner: null,
								leaseExpiresAt: null,
								updatedAt: new Date(),
							})
							.where(
								and(
									eq(outboxItems.id, lease.itemId),
									eq(outboxItems.status, "processing"),
									eq(outboxItems.leaseOwner, lease.leaseOwner),
									eq(outboxItems.deliveryFence, lease.deliveryFence),
									sql`${outboxItems.leaseExpiresAt} > clock_timestamp()`,
									sql`${outboxItems.payload} = ${JSON.stringify(state)}::jsonb`,
								),
							)
							.returning({
								id: outboxItems.id,
								attemptCount: outboxItems.attemptCount,
								updatedAt: outboxItems.updatedAt,
								traceId: outboxItems.traceId,
							});
						if (rows.length !== 1)
							throw new SkillHubOperationErrorV1("unavailable");
						const completedItem = rows[0];
						if (!completedItem)
							throw new SkillHubOperationErrorV1("unavailable");
						await tx.insert(persistedEvents).values({
							eventId: `outbox:${lease.itemId}:${lease.deliveryFence}`,
							streamId: `outbox:${lease.itemId}`,
							sequence: lease.deliveryFence,
							streamCursor: lease.deliveryFence,
							eventType: "outbox.succeeded",
							payload: {
								attemptCount: completedItem.attemptCount,
								deliveryFence: lease.deliveryFence.toString(),
							},
							traceId: completedItem.traceId,
							occurredAt: completedItem.updatedAt,
						});
						const completed = await tx
							.update(idempotencyRecords)
							.set({
								status: "completed",
								result: {
									operationId: state.operationId,
									skillVersionId: selection.skillVersionId,
								},
								updatedAt: new Date(),
							})
							.where(
								and(
									eq(idempotencyRecords.id, state.operationId),
									eq(idempotencyRecords.status, "reserved"),
									eq(idempotencyRecords.requestDigest, digest),
								),
							)
							.returning({ id: idempotencyRecords.id });
						if (completed.length !== 1)
							throw new SkillHubOperationErrorV1("unavailable");
					}
					await revalidate();
					return {
						replayed: reserved.completed,
						version: registered.version,
						artifacts: state.objects,
					};
				},
			);
			return Object.freeze(result);
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? (error as { code?: unknown }).code
					: undefined;
			const permanent =
				error instanceof SkillHubOperationErrorV1
					? error.code !== "unavailable"
					: typeof code === "string" &&
						[
							"invalid_archive",
							"archive_limit",
							"invalid_path",
							"duplicate_path",
							"path_conflict",
							"symlink",
							"missing_entry",
							"digest_mismatch",
							"source_untrusted",
							"scan_rejected",
							"signature_invalid",
						].includes(code);
			if (permanent) {
				if (lease)
					await this.#outbox
						.markFailed({
							...lease,
							errorCode: "SKILL_PACKAGE_REJECTED",
						})
						.catch(() => null);
				throw error;
			}
			if (lease)
				await this.#outbox
					.scheduleRetry({
						...lease,
						retryDelayMs: 0,
						errorCode: "SKILL_PACKAGE_UNAVAILABLE",
					})
					.catch(() => null);
			throw new SkillHubOperationErrorV1("unavailable");
		}
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

	async listVisibleVersions(context: SkillHubRequestV1) {
		return this.#transaction(
			context,
			async (transaction, request, identity) => {
				const rows = await transaction
					.select({ version: skillHubVersions, name: skillHubSkills.name })
					.from(skillHubVersions)
					.innerJoin(
						skillHubSkills,
						eq(skillHubSkills.id, skillHubVersions.skillId),
					)
					.where(eq(skillHubVersions.state, "published"));
				const versions = rows.flatMap(({ version, name }) => {
					const decoded = decode(version, name);
					return canViewSkillHubVersionV1(decoded, identity.actor)
						? [{ ...decoded, name }]
						: [];
				});
				await audit(
					transaction,
					request,
					"skill.directory.read",
					"directory",
					"succeeded",
					{ count: versions.length },
				);
				return Object.freeze(versions);
			},
		);
	}

	async installVersion(
		context: SkillHubRequestV1,
		keyInput: string,
		input: unknown,
	) {
		return this.#transaction(
			context,
			async (transaction, request, identity) => {
				const command = parseSkillHubInstallationCommandV1(input);
				const key = parseSkillHubIdempotencyKeyV1(keyInput);
				const scopeId = installationScope(command);
				const digest = platformIdempotencyV1.canonicalRequestDigest({
					...command,
				});
				await transaction.execute(
					sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["skill_install", scopeId, request.userId, key])}, 0))`,
				);
				const [prior] = await transaction
					.select()
					.from(idempotencyRecords)
					.where(
						and(
							eq(idempotencyRecords.scopeType, "skill_installation"),
							eq(idempotencyRecords.scopeId, scopeId),
							eq(idempotencyRecords.actorId, request.userId),
							eq(idempotencyRecords.commandType, "skill.install.v1"),
							eq(idempotencyRecords.idempotencyKey, key),
						),
					);
				if (
					prior?.requestDigest !== undefined &&
					prior.requestDigest !== digest
				)
					throw new SkillHubOperationErrorV1("idempotency_conflict");
				if (prior?.status === "completed") {
					const installationId = prior.result?.installationId;
					if (typeof installationId !== "string")
						throw new SkillHubOperationErrorV1("unavailable");
					const [row] = await transaction
						.select()
						.from(skillHubInstallations)
						.where(eq(skillHubInstallations.id, installationId));
					if (!row) throw new SkillHubOperationErrorV1("unavailable");
					return { replayed: true, installation: decodeInstallation(row) };
				}
				const [row] = await transaction
					.select({ version: skillHubVersions, name: skillHubSkills.name })
					.from(skillHubVersions)
					.innerJoin(
						skillHubSkills,
						eq(skillHubSkills.id, skillHubVersions.skillId),
					)
					.where(eq(skillHubVersions.id, command.skillVersionId))
					.for("update");
				if (!row) throw new SkillHubOperationErrorV1("not_found");
				const version = decode(row.version, row.name);
				if (!canInstallSkillHubVersionV1(version, command, identity.actor))
					throw new SkillHubOperationErrorV1(
						version.state === "published" ? "not_found" : "version_unavailable",
					);
				const now = new Date();
				const [existing] = await transaction
					.select()
					.from(skillHubInstallations)
					.where(
						and(
							eq(skillHubInstallations.principalType, command.principalType),
							eq(skillHubInstallations.principalId, command.principalId),
							eq(skillHubInstallations.skillVersionId, command.skillVersionId),
						),
					)
					.for("update");
				if (existing?.state === "installed" && !existing.needUpgrade)
					throw new SkillHubOperationErrorV1("version_conflict");
				const installationId = existing?.id ?? randomUUID();
				if (existing) {
					await transaction
						.update(skillHubInstallations)
						.set({ state: "installed", needUpgrade: false, updatedAt: now })
						.where(eq(skillHubInstallations.id, installationId));
				} else {
					await transaction.insert(skillHubInstallations).values({
						id: installationId,
						principalType: command.principalType,
						principalId: command.principalId,
						skillVersionId: command.skillVersionId,
						state: "installed",
						needUpgrade: false,
						installedAt: now,
						updatedAt: now,
					});
				}
				await transaction.execute(sql`
					update platform.skill_hub_installations
					set need_upgrade = true, updated_at = ${now.toISOString()}
					where principal_type = ${command.principalType}
					  and principal_id = ${command.principalId}
					  and state = 'installed'
					  and skill_version_id <> ${command.skillVersionId}
					  and skill_version_id in (
						select id from platform.skill_hub_versions where skill_id = ${version.skillId}
					  )
				`);
				const [stored] = await transaction
					.select()
					.from(skillHubInstallations)
					.where(eq(skillHubInstallations.id, installationId));
				if (!stored) throw new SkillHubOperationErrorV1("unavailable");
				await transaction.insert(idempotencyRecords).values({
					id: randomUUID(),
					scopeType: "skill_installation",
					scopeId: scopeId,
					actorId: request.userId,
					commandType: "skill.install.v1",
					idempotencyKey: key,
					requestDigest: digest,
					status: "completed",
					result: { installationId, skillVersionId: command.skillVersionId },
				});
				await audit(
					transaction,
					request,
					"skill.install",
					installationId,
					"succeeded",
					{ skillVersionId: command.skillVersionId, replayed: false },
				);
				return { replayed: false, installation: decodeInstallation(stored) };
			},
		);
	}

	async uninstallInstallation(
		context: SkillHubRequestV1,
		installationIdInput: string,
		keyInput: string,
	) {
		return this.#transaction(
			context,
			async (transaction, request, identity) => {
				const installationId = parseSkillHubIdV1(installationIdInput);
				const key = parseSkillHubIdempotencyKeyV1(keyInput);
				await transaction.execute(
					sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["skill_uninstall", installationId, request.userId, key])}, 0))`,
				);
				const [row] = await transaction
					.select()
					.from(skillHubInstallations)
					.where(eq(skillHubInstallations.id, installationId))
					.for("update");
				if (!row) throw new SkillHubOperationErrorV1("not_found");
				if (
					(row.principalType === "user" &&
						row.principalId !== request.userId) ||
					(row.principalType === "organization" &&
						!identity.actor.isAdministrator &&
						!identity.actor.organizationIds.includes(row.principalId))
				)
					throw new SkillHubOperationErrorV1("not_found");
				const digest = platformIdempotencyV1.canonicalRequestDigest({
					installationId,
				});
				const [prior] = await transaction
					.select()
					.from(idempotencyRecords)
					.where(
						and(
							eq(idempotencyRecords.scopeType, "skill_installation"),
							eq(idempotencyRecords.scopeId, installationId),
							eq(idempotencyRecords.actorId, request.userId),
							eq(idempotencyRecords.commandType, "skill.uninstall.v1"),
							eq(idempotencyRecords.idempotencyKey, key),
						),
					);
				if (prior && prior.requestDigest !== digest)
					throw new SkillHubOperationErrorV1("idempotency_conflict");
				if (prior?.status === "completed")
					return { replayed: true, installation: decodeInstallation(row) };
				const next = uninstallSkillHubInstallationV1(
					decodeInstallation(row),
					new Date().toISOString(),
				);
				await transaction
					.update(skillHubInstallations)
					.set({ state: next.state, updatedAt: new Date(next.updatedAt) })
					.where(eq(skillHubInstallations.id, installationId));
				await transaction.insert(idempotencyRecords).values({
					id: randomUUID(),
					scopeType: "skill_installation",
					scopeId: installationId,
					actorId: request.userId,
					commandType: "skill.uninstall.v1",
					idempotencyKey: key,
					requestDigest: digest,
					status: "completed",
					result: { installationId },
				});
				await audit(
					transaction,
					request,
					"skill.uninstall",
					installationId,
					"succeeded",
					{ replayed: false },
				);
				return { replayed: false, installation: next };
			},
		);
	}
}
