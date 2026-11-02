import { createHash, randomUUID } from "node:crypto";
import type { ObjectStorageDataV1 } from "@agent-infra/object-storage";
import {
	assertWorkspaceSnapshotQuotaV1,
	validateWorkspaceSnapshotArchiveV1,
	validateWorkspaceSnapshotProvenanceV1,
	type WorkspaceSnapshotArchiveDescriptorV1,
	WorkspaceSnapshotErrorV1,
	type WorkspaceSnapshotProvenanceV1,
	type WorkspaceSnapshotRecordV1,
	WorkspaceSnapshotSecurityErrorV1,
} from "@agent-infra/platform-core";

export interface WorkspaceSnapshotPrincipalV1 {
	readonly kind: "user" | "application";
	readonly id: string;
	readonly scopes: readonly string[];
}
export interface WorkspaceSnapshotCredentialResolverV1 {
	resolve(material: string): Promise<WorkspaceSnapshotPrincipalV1 | null>;
}
export interface WorkspaceSnapshotSpoolV1 {
	spool(
		body: ReadableStream<Uint8Array>,
		maxBytes: number,
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
	readonly spool: WorkspaceSnapshotSpoolV1;
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

function requireOwnerScope(
	principal: WorkspaceSnapshotPrincipalV1,
	scope: string,
) {
	if (!principal.scopes.includes(scope))
		throw new WorkspaceSnapshotServiceErrorV1("forbidden");
}
function requestDigest(digest: string, source: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify([digest, source]))
		.digest("hex");
}
function errorCode(error: unknown): WorkspaceSnapshotServiceErrorV1["code"] {
	if (error instanceof WorkspaceSnapshotServiceErrorV1) return error.code;
	if (error instanceof WorkspaceSnapshotErrorV1)
		return error.code === "bound" ? "conflict" : "invalid_archive";
	if (error instanceof WorkspaceSnapshotSecurityErrorV1)
		return error.code === "quota_exceeded"
			? "quota_exceeded"
			: "invalid_archive";
	return "unavailable";
}

export function createWorkspaceSnapshotServiceV1(
	options: WorkspaceSnapshotServiceOptionsV1,
) {
	const now = options.now ?? (() => new Date());
	return {
		async upload(input: {
			material: string;
			idempotencyKey: string;
			digest: string;
			source: unknown;
			body: ReadableStream<Uint8Array>;
		}) {
			const principal = await options.credentials.resolve(input.material);
			if (!principal)
				throw new WorkspaceSnapshotServiceErrorV1("authentication_required");
			requireOwnerScope(principal, "agent:create");
			let provenance: WorkspaceSnapshotProvenanceV1;
			try {
				provenance = validateWorkspaceSnapshotProvenanceV1({
					ownerType: principal.kind,
					ownerId: principal.id,
					source: input.source,
					connectionAuthorized: await options.authorizeBuilderSource?.(
						principal,
						input.source,
					),
				});
			} catch (error) {
				throw new WorkspaceSnapshotServiceErrorV1(errorCode(error));
			}
			const digestValue = input.digest;
			const reqDigest = requestDigest(digestValue, provenance.source);
			const existing = await options.store.findIdempotency(
				principal,
				input.idempotencyKey,
			);
			if (existing) {
				if (existing.requestDigest !== reqDigest)
					throw new WorkspaceSnapshotServiceErrorV1("conflict");
				return { record: existing.record, replayed: true };
			}
			let spool:
				| Awaited<ReturnType<WorkspaceSnapshotSpoolV1["spool"]>>
				| undefined;
			let objectRef: string | undefined;
			let objectVersion: string | undefined;
			try {
				spool = await options.spool.spool(input.body, 2 * 1024 ** 3);
				const archive: WorkspaceSnapshotArchiveDescriptorV1 =
					await validateWorkspaceSnapshotArchiveV1(spool.replay(), digestValue);
				const quota = await options.quota.read(principal);
				assertWorkspaceSnapshotQuotaV1({
					...quota,
					archiveBytes: archive.sizeBytes,
					unpackedBytes: archive.unpackedSizeBytes,
				});
				objectRef = `workspace-snapshot/${principal.kind}/${principal.id}/${randomUUID()}`;
				const stored = await options.storage.upload({
					objectRef,
					descriptor: {
						name: "workspace-snapshot.tar.gz",
						mediaType: archive.mediaType,
						sizeBytes: archive.sizeBytes,
						sha256: archive.digest.slice("sha256:".length),
					},
					expiresAt: new Date(now().getTime() + 5 * 60_000).toISOString(),
					body: spool.replay(),
				});
				objectVersion = stored.version;
				const record: WorkspaceSnapshotRecordV1 = {
					snapshotId: `snapshot_${randomUUID()}`,
					ownerType: principal.kind,
					ownerId: principal.id,
					digest: archive.digest,
					sizeBytes: archive.sizeBytes,
					unpackedSizeBytes: archive.unpackedSizeBytes,
					fileCount: archive.fileCount,
					mediaType: archive.mediaType,
					source: { ...provenance.source },
					objectRef,
					objectVersion: stored.version,
					status: "ready",
					createdAt: now().toISOString(),
					bindings: [],
				};
				const saved = await options.store.create(
					record,
					principal,
					input.idempotencyKey,
					reqDigest,
				);
				return { record: saved, replayed: false };
			} catch (error) {
				if (objectRef) {
					try {
						await options.storage.remove(objectRef, objectVersion ?? "");
					} catch {}
				}
				throw new WorkspaceSnapshotServiceErrorV1(errorCode(error));
			} finally {
				await spool?.dispose();
			}
		},
		async list(material: string) {
			const principal = await options.credentials.resolve(material);
			if (!principal)
				throw new WorkspaceSnapshotServiceErrorV1("authentication_required");
			requireOwnerScope(principal, "agent:read");
			return options.store.list(principal);
		},
		async get(material: string, snapshotId: string) {
			const principal = await options.credentials.resolve(material);
			if (!principal)
				throw new WorkspaceSnapshotServiceErrorV1("authentication_required");
			requireOwnerScope(principal, "agent:read");
			return options.store.get(principal, snapshotId);
		},
		async remove(material: string, snapshotId: string) {
			const principal = await options.credentials.resolve(material);
			if (!principal)
				throw new WorkspaceSnapshotServiceErrorV1("authentication_required");
			requireOwnerScope(principal, "agent:manage");
			return options.store.remove(principal, snapshotId);
		},
	};
}
