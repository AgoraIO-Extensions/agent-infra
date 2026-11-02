import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ObjectStorageDataV1 } from "@agent-infra/object-storage";
import {
	PersonalApiCredentialErrorV1,
	validateWorkspaceSnapshotArchiveV1,
	validateWorkspaceSnapshotProvenanceV1,
	type WorkspaceSnapshotArchiveDescriptorV1,
	WorkspaceSnapshotErrorV1,
	type WorkspaceSnapshotRecordV1,
	WorkspaceSnapshotSecurityErrorV1,
	workspaceSnapshotLimitsV1,
} from "@agent-infra/platform-core";
import {
	createWorkspaceSnapshotFileSpoolV1,
	WorkspaceSnapshotSpoolErrorV1,
} from "./workspace-snapshot-spool.js";

export interface WorkspaceSnapshotPrincipalV1 {
	readonly kind: "user" | "application";
	readonly id: string;
	readonly scopes: readonly string[];
}
export interface WorkspaceSnapshotCredentialResolverV1 {
	resolve(
		material: string,
		requiredScope?: "agent:create" | "agent:read" | "agent:manage",
	): Promise<WorkspaceSnapshotPrincipalV1 | null>;
}
export interface WorkspaceSnapshotSpoolV1 {
	spool(
		body: ReadableStream<Uint8Array>,
		maxBytes: number,
		request?: { readonly signal?: AbortSignal },
	): Promise<{
		sizeBytes: number;
		replay(): ReadableStream<Uint8Array>;
		dispose(): Promise<void>;
	}>;
}
export interface WorkspaceSnapshotServiceStoreV1 {
	findIdempotency(
		owner: WorkspaceSnapshotPrincipalV1,
		key: string,
	): Promise<{
		readonly requestDigest: string;
		readonly record: WorkspaceSnapshotRecordV1;
	} | null>;
	create(
		record: WorkspaceSnapshotRecordV1,
		owner: WorkspaceSnapshotPrincipalV1,
		idempotencyKey: string,
		requestDigest: string,
	): Promise<WorkspaceSnapshotRecordV1>;
	list(
		owner: WorkspaceSnapshotPrincipalV1,
	): Promise<readonly WorkspaceSnapshotRecordV1[]>;
	get(
		owner: WorkspaceSnapshotPrincipalV1,
		snapshotId: string,
	): Promise<WorkspaceSnapshotRecordV1 | null>;
	remove(
		owner: WorkspaceSnapshotPrincipalV1,
		snapshotId: string,
	): Promise<WorkspaceSnapshotRecordV1>;
	finishDeletion?(
		owner: WorkspaceSnapshotPrincipalV1,
		snapshotId: string,
		objectVersion: string,
	): Promise<WorkspaceSnapshotRecordV1>;
}
export interface WorkspaceSnapshotQuotaReaderV1 {
	read(owner: WorkspaceSnapshotPrincipalV1): Promise<{
		ownerStoredBytes: number;
		agentArchiveBytes: number;
		agentUnpackedBytes: number;
		agentBindingCount: number;
	}>;
}
export interface WorkspaceSnapshotServiceOptionsV1 {
	readonly credentials: WorkspaceSnapshotCredentialResolverV1;
	readonly spool?: WorkspaceSnapshotSpoolV1;
	readonly storage: Pick<ObjectStorageDataV1, "upload" | "remove">;
	readonly store: WorkspaceSnapshotServiceStoreV1;
	readonly quota: WorkspaceSnapshotQuotaReaderV1;
	readonly now?: () => Date;
	readonly authorizeBuilderSource?: (
		owner: WorkspaceSnapshotPrincipalV1,
		source: unknown,
	) => Promise<boolean>;
}

export class WorkspaceSnapshotServiceErrorV1 extends Error {
	constructor(
		readonly code:
			| "authentication_required"
			| "forbidden"
			| "conflict"
			| "quota_exceeded"
			| "invalid_archive"
			| "unavailable",
	) {
		super(code);
		this.name = "WorkspaceSnapshotServiceErrorV1";
	}
}

function boundedError(error: unknown): WorkspaceSnapshotServiceErrorV1 {
	if (error instanceof WorkspaceSnapshotServiceErrorV1) return error;
	if (error instanceof PersonalApiCredentialErrorV1)
		return new WorkspaceSnapshotServiceErrorV1(
			error.code === "authentication_required"
				? "authentication_required"
				: error.code === "forbidden" || error.code === "not_found"
					? "forbidden"
					: "unavailable",
		);
	if (error instanceof WorkspaceSnapshotErrorV1) {
		const code: string = error.code;
		if (code === "bound" || code === "conflict")
			return new WorkspaceSnapshotServiceErrorV1("conflict");
		if (code === "quota_exceeded" || code === "snapshot_limit_exceeded")
			return new WorkspaceSnapshotServiceErrorV1("quota_exceeded");
		if (code === "not_found" || code === "forbidden")
			return new WorkspaceSnapshotServiceErrorV1("forbidden");
		return new WorkspaceSnapshotServiceErrorV1(
			code === "unavailable" ? "unavailable" : "invalid_archive",
		);
	}
	if (error instanceof WorkspaceSnapshotSecurityErrorV1) {
		return new WorkspaceSnapshotServiceErrorV1(
			error.code === "quota_exceeded"
				? "quota_exceeded"
				: error.code === "unauthorized_provenance"
					? "forbidden"
					: "invalid_archive",
		);
	}
	if (error instanceof WorkspaceSnapshotSpoolErrorV1) {
		return new WorkspaceSnapshotServiceErrorV1(
			error.code === "limit_exceeded"
				? "quota_exceeded"
				: error.code === "invalid_input"
					? "invalid_archive"
					: "unavailable",
		);
	}
	return new WorkspaceSnapshotServiceErrorV1("unavailable");
}

/** Only explicit transactional refusals prove this upload did not commit. */
function rejectedBeforeCommit(error: unknown): boolean {
	return (
		error instanceof WorkspaceSnapshotErrorV1 &&
		[
			"invalid_input",
			"conflict",
			"quota_exceeded",
			"not_found",
			"bound",
		].includes(error.code)
	);
}

function assertOwner(
	record: WorkspaceSnapshotRecordV1,
	owner: WorkspaceSnapshotPrincipalV1,
) {
	if (record.ownerType !== owner.kind || record.ownerId !== owner.id)
		throw new WorkspaceSnapshotServiceErrorV1("unavailable");
}

function validateSavedRecord(
	record: WorkspaceSnapshotRecordV1,
	owner: WorkspaceSnapshotPrincipalV1,
	archive: WorkspaceSnapshotArchiveDescriptorV1,
	source: unknown,
) {
	assertOwner(record, owner);
	if (
		!record.snapshotId ||
		!record.objectRef ||
		!record.objectVersion ||
		record.digest !== archive.digest ||
		record.sizeBytes !== archive.sizeBytes ||
		record.unpackedSizeBytes !== archive.unpackedSizeBytes ||
		record.fileCount !== archive.fileCount ||
		record.mediaType !== archive.mediaType ||
		!isDeepStrictEqual(record.source, source)
	)
		throw new WorkspaceSnapshotServiceErrorV1("unavailable");
	return record;
}

async function disposeSpool(
	spool: Awaited<ReturnType<WorkspaceSnapshotSpoolV1["spool"]>> | undefined,
) {
	try {
		await spool?.dispose();
	} catch {
		throw new WorkspaceSnapshotServiceErrorV1("unavailable");
	}
}

export function createWorkspaceSnapshotServiceV1(
	options: WorkspaceSnapshotServiceOptionsV1,
) {
	const now = options.now ?? (() => new Date());
	const spools = options.spool ?? createWorkspaceSnapshotFileSpoolV1();
	async function principalFor(
		material: string,
		scope: "agent:create" | "agent:read" | "agent:manage",
	) {
		const principal = await options.credentials.resolve(material, scope);
		if (!principal)
			throw new WorkspaceSnapshotServiceErrorV1("authentication_required");
		if (
			!["user", "application"].includes(principal.kind) ||
			!principal.id ||
			!Array.isArray(principal.scopes)
		)
			throw new WorkspaceSnapshotServiceErrorV1("unavailable");
		if (!principal.scopes.includes(scope))
			throw new WorkspaceSnapshotServiceErrorV1("forbidden");
		return { ...principal, scopes: [...principal.scopes] };
	}
	async function revalidateUploadPrincipal(
		material: string,
		previous: WorkspaceSnapshotPrincipalV1,
	) {
		const current = await principalFor(material, "agent:create");
		if (current.kind !== previous.kind || current.id !== previous.id)
			throw new WorkspaceSnapshotServiceErrorV1("forbidden");
	}
	return {
		async upload(input: {
			material: string;
			idempotencyKey: string;
			digest: string;
			source: unknown;
			body: ReadableStream<Uint8Array>;
			signal?: AbortSignal;
		}) {
			let spool:
				| Awaited<ReturnType<WorkspaceSnapshotSpoolV1["spool"]>>
				| undefined;
			let pendingObject: { ref: string; version: string } | undefined;
			let safeToRemove = true;
			async function removePendingObject() {
				if (!pendingObject) return;
				await options.storage.remove(pendingObject.ref, pendingObject.version);
				pendingObject = undefined;
			}
			try {
				input.signal?.throwIfAborted();
				if (
					!/^[A-Za-z0-9._~-]{1,128}$/.test(input.idempotencyKey) ||
					!/^sha256:[a-f0-9]{64}$/.test(input.digest)
				)
					throw new WorkspaceSnapshotServiceErrorV1("invalid_archive");
				const principal = await principalFor(input.material, "agent:create");
				const source = structuredClone(input.source);
				const isBuilder =
					typeof source === "object" &&
					source !== null &&
					"kind" in source &&
					source.kind === "builder-connection";
				const provenance = validateWorkspaceSnapshotProvenanceV1({
					ownerType: principal.kind,
					ownerId: principal.id,
					source,
					connectionAuthorized: isBuilder
						? await options.authorizeBuilderSource?.(principal, source)
						: false,
				});
				const signal = AbortSignal.any([
					AbortSignal.timeout(5 * 60_000),
					...(input.signal ? [input.signal] : []),
				]);
				spool = await spools.spool(
					input.body,
					workspaceSnapshotLimitsV1.maxArchiveBytes,
					{ signal },
				);
				const archive = await validateWorkspaceSnapshotArchiveV1(
					spool.replay(),
					input.digest,
				);
				if (archive.sizeBytes !== spool.sizeBytes)
					throw new WorkspaceSnapshotServiceErrorV1("invalid_archive");
				signal.throwIfAborted();
				await revalidateUploadPrincipal(input.material, principal);
				const reqDigest = createHash("sha256")
					.update(JSON.stringify([archive.digest, provenance.source]))
					.digest("hex");
				const existing = await options.store.findIdempotency(
					principal,
					input.idempotencyKey,
				);
				if (existing) {
					if (existing.requestDigest !== reqDigest)
						throw new WorkspaceSnapshotServiceErrorV1("conflict");
					return {
						record: validateSavedRecord(
							existing.record,
							principal,
							archive,
							provenance.source,
						),
						replayed: true,
					};
				}
				const quota = await options.quota.read(principal);
				if (
					!Number.isSafeInteger(quota.ownerStoredBytes) ||
					quota.ownerStoredBytes < 0
				)
					throw new WorkspaceSnapshotServiceErrorV1("unavailable");
				// Uploads have no target Agent; binding quota belongs to the configuration transaction.
				if (
					archive.sizeBytes >
					workspaceSnapshotLimitsV1.maxOwnerBytes - quota.ownerStoredBytes
				) {
					const raced = await options.store.findIdempotency(
						principal,
						input.idempotencyKey,
					);
					if (raced?.requestDigest === reqDigest) {
						return {
							record: validateSavedRecord(
								raced.record,
								principal,
								archive,
								provenance.source,
							),
							replayed: true,
						};
					}
					throw new WorkspaceSnapshotServiceErrorV1("quota_exceeded");
				}
				signal.throwIfAborted();
				const objectRef = randomUUID();
				const stored = await options.storage.upload({
					objectRef,
					descriptor: {
						name: "workspace-snapshot.tar.gz",
						mediaType: "application/gzip",
						sizeBytes: archive.sizeBytes,
						sha256: archive.digest.slice(7),
					},
					expiresAt: new Date(now().getTime() + 5 * 60_000).toISOString(),
					body: spool.replay(),
					signal,
				});
				if (
					typeof stored.version === "string" &&
					stored.version.length > 0 &&
					stored.version !== "null"
				)
					pendingObject = { ref: objectRef, version: stored.version };
				if (
					!pendingObject ||
					!stored.etag ||
					stored.sha256 !== archive.digest.slice(7) ||
					stored.sizeBytes !== archive.sizeBytes ||
					stored.mediaType !== "application/gzip"
				)
					throw new WorkspaceSnapshotServiceErrorV1("unavailable");
				signal.throwIfAborted();
				await revalidateUploadPrincipal(input.material, principal);
				const record: WorkspaceSnapshotRecordV1 = {
					snapshotId: `snapshot_${randomUUID()}`,
					ownerType: principal.kind,
					ownerId: principal.id,
					...archive,
					source: { ...provenance.source },
					objectRef,
					objectVersion: stored.version,
					status: "ready",
					createdAt: now().toISOString(),
					bindings: [],
				};
				let saved: WorkspaceSnapshotRecordV1;
				let reconciled = false;
				safeToRemove = false;
				try {
					saved = await options.store.create(
						record,
						principal,
						input.idempotencyKey,
						reqDigest,
					);
				} catch (error) {
					if (rejectedBeforeCommit(error)) {
						safeToRemove = true;
						throw error;
					}
					// A lost COMMIT response is not proof of rollback. Only a durable readback can settle it.
					const readback = await options.store.findIdempotency(
						principal,
						input.idempotencyKey,
					);
					if (!readback || readback.requestDigest !== reqDigest)
						throw new WorkspaceSnapshotServiceErrorV1("unavailable");
					saved = readback.record;
					reconciled = true;
				}
				validateSavedRecord(saved, principal, archive, provenance.source);
				if (saved.objectRef === objectRef) {
					if (
						saved.objectVersion !== stored.version ||
						saved.snapshotId !== record.snapshotId
					)
						throw new WorkspaceSnapshotServiceErrorV1("unavailable");
					pendingObject = undefined;
					return { record: saved, replayed: reconciled };
				}
				// Concurrent identical uploads converge on the Store's original object; remove only this loser.
				// Cleanup is attempted once; a failure must remain visible for later reconciliation.
				safeToRemove = false;
				await removePendingObject();
				return { record: saved, replayed: true };
			} catch (error) {
				if (safeToRemove && pendingObject) {
					try {
						await removePendingObject();
					} catch {
						throw new WorkspaceSnapshotServiceErrorV1("unavailable");
					}
				}
				if (!spool && !input.body.locked)
					void input.body.cancel().catch(() => undefined);
				throw boundedError(error);
			} finally {
				await disposeSpool(spool);
			}
		},
		async list(material: string) {
			try {
				const principal = await principalFor(material, "agent:read");
				const values = await options.store.list(principal);
				for (const value of values) assertOwner(value, principal);
				return values;
			} catch (error) {
				throw boundedError(error);
			}
		},
		async get(material: string, snapshotId: string) {
			try {
				const principal = await principalFor(material, "agent:read");
				const value = await options.store.get(principal, snapshotId);
				if (value) assertOwner(value, principal);
				return value;
			} catch (error) {
				throw boundedError(error);
			}
		},
		async remove(material: string, snapshotId: string) {
			try {
				const principal = await principalFor(material, "agent:manage");
				const value = await options.store.remove(principal, snapshotId);
				assertOwner(value, principal);
				if (value.status === "deleted") return value;
				if (value.status !== "deleting" || !options.store.finishDeletion)
					throw new WorkspaceSnapshotServiceErrorV1("unavailable");
				await options.storage.remove(value.objectRef, value.objectVersion);
				const removed = await options.store.finishDeletion(
					principal,
					snapshotId,
					value.objectVersion,
				);
				assertOwner(removed, principal);
				if (removed.status !== "deleted")
					throw new WorkspaceSnapshotServiceErrorV1("unavailable");
				return removed;
			} catch (error) {
				throw boundedError(error);
			}
		},
	};
}
