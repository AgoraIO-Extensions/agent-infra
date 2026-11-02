import {
	WorkspaceSnapshotErrorV1,
	workspaceSnapshotLimitsV1,
} from "./workspace-snapshot.js";

export type WorkspaceSnapshotSecurityErrorCodeV1 =
	| "invalid_provenance"
	| "unauthorized_provenance"
	| "credential_detected"
	| "invalid_archive_path"
	| "archive_entry_type_unsupported"
	| "quota_exceeded"
	| "snapshot_bound"
	| "retention_not_elapsed";

export class WorkspaceSnapshotSecurityErrorV1 extends Error {
	readonly code: WorkspaceSnapshotSecurityErrorCodeV1;
	constructor(code: WorkspaceSnapshotSecurityErrorCodeV1) {
		super(code);
		this.name = "WorkspaceSnapshotSecurityErrorV1";
		this.code = code;
	}
}

export interface WorkspaceSnapshotDirectUploadSourceV1 {
	readonly kind: "direct-upload";
}

export interface WorkspaceSnapshotBuilderSourceV1 {
	readonly kind: "builder-connection";
	readonly repository: string;
	readonly commitSha: string;
	readonly connectionCallReference: string;
}

export type WorkspaceSnapshotProvenanceSourceV1 =
	| WorkspaceSnapshotDirectUploadSourceV1
	| WorkspaceSnapshotBuilderSourceV1;

export interface WorkspaceSnapshotProvenanceInputV1 {
	readonly ownerType: "user" | "application";
	readonly ownerId: string;
	readonly source: unknown;
	/** Set only after the Connection service verified the call reference. */
	readonly connectionAuthorized?: boolean;
}

export interface WorkspaceSnapshotProvenanceV1 {
	readonly ownerType: "user" | "application";
	readonly ownerId: string;
	readonly source: WorkspaceSnapshotProvenanceSourceV1;
}

const commitSha = /^[0-9a-f]{40}$/;
const opaqueReference = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const repositoryUrl = /^https:\/\/[^/?#]+(?:\/[^?#]*)?$/;
const credentialPattern =
	/(?:-----BEGIN [^-]*PRIVATE KEY-----|(?:gh[pousr]_|xox[baprs]-|sk-[A-Za-z0-9])[A-Za-z0-9._-]{12,}|(?:AKIA|ASIA)[A-Z0-9]{16}|(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,})/i;

function exactRecord(input: unknown): Record<string, unknown> {
	if (
		typeof input !== "object" ||
		input === null ||
		Array.isArray(input) ||
		Object.getPrototypeOf(input) !== Object.prototype
	)
		throw new WorkspaceSnapshotSecurityErrorV1("invalid_provenance");
	return input as Record<string, unknown>;
}

function boundedText(value: unknown, maxBytes: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		String.prototype.isWellFormed.call(value) &&
		Buffer.byteLength(value, "utf8") <= maxBytes
	);
}

export function validateWorkspaceSnapshotProvenanceV1(
	input: WorkspaceSnapshotProvenanceInputV1,
): WorkspaceSnapshotProvenanceV1 {
	if (!boundedText(input.ownerId, 1024))
		throw new WorkspaceSnapshotSecurityErrorV1("invalid_provenance");
	const source = exactRecord(input.source);
	const kind = source.kind;
	if (kind === "direct-upload") {
		if (Object.keys(source).length !== 1)
			throw new WorkspaceSnapshotSecurityErrorV1("invalid_provenance");
		return Object.freeze({
			ownerType: input.ownerType,
			ownerId: input.ownerId,
			source: { kind: "direct-upload" as const },
		});
	}
	if (kind !== "builder-connection" || Object.keys(source).length !== 4)
		throw new WorkspaceSnapshotSecurityErrorV1("invalid_provenance");
	if (
		!boundedText(source.repository, 512) ||
		!repositoryUrl.test(source.repository) ||
		!repositoryWithoutCredentialsV1(source.repository) ||
		!commitSha.test(String(source.commitSha)) ||
		!opaqueReference.test(String(source.connectionCallReference)) ||
		input.connectionAuthorized !== true
	)
		throw new WorkspaceSnapshotSecurityErrorV1(
			input.connectionAuthorized === true
				? "invalid_provenance"
				: "unauthorized_provenance",
		);
	return Object.freeze({
		ownerType: input.ownerType,
		ownerId: input.ownerId,
		source: Object.freeze({
			kind: "builder-connection" as const,
			repository: source.repository,
			commitSha: source.commitSha as string,
			connectionCallReference: source.connectionCallReference as string,
		}),
	});
}

function repositoryWithoutCredentialsV1(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.username === "" &&
			url.password === "" &&
			url.search === "" &&
			url.hash === ""
		);
	} catch {
		return false;
	}
}

export function assertWorkspaceSnapshotArchivePathV1(path: string): string {
	if (
		!boundedText(path, workspaceSnapshotLimitsV1.maxPathBytes) ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path.split("/").some((part) => part === "" || part === "." || part === "..")
	)
		throw new WorkspaceSnapshotSecurityErrorV1("invalid_archive_path");
	return path;
}

export function assertWorkspaceSnapshotArchiveEntryTypeV1(
	type:
		| "file"
		| "directory"
		| "symlink"
		| "hardlink"
		| "device"
		| "fifo"
		| "socket",
): void {
	if (type !== "file" && type !== "directory")
		throw new WorkspaceSnapshotSecurityErrorV1(
			"archive_entry_type_unsupported",
		);
}

export function containsWorkspaceSnapshotCredentialPatternV1(
	value: string,
): boolean {
	return credentialPattern.test(value);
}

export function assertNoWorkspaceSnapshotCredentialPatternV1(
	value: string,
): void {
	if (containsWorkspaceSnapshotCredentialPatternV1(value))
		throw new WorkspaceSnapshotSecurityErrorV1("credential_detected");
}

export interface WorkspaceSnapshotQuotaInputV1 {
	readonly archiveBytes: number;
	readonly unpackedBytes: number;
	readonly ownerStoredBytes: number;
	readonly agentArchiveBytes: number;
	readonly agentUnpackedBytes: number;
	readonly agentBindingCount: number;
}

export function assertWorkspaceSnapshotQuotaV1(
	input: WorkspaceSnapshotQuotaInputV1,
): void {
	const numbers = [
		input.archiveBytes,
		input.unpackedBytes,
		input.ownerStoredBytes,
		input.agentArchiveBytes,
		input.agentUnpackedBytes,
		input.agentBindingCount,
	];
	if (numbers.some((value) => !Number.isSafeInteger(value) || value < 0))
		throw new WorkspaceSnapshotSecurityErrorV1("quota_exceeded");
	if (
		input.archiveBytes === 0 ||
		input.unpackedBytes === 0 ||
		input.archiveBytes > workspaceSnapshotLimitsV1.maxArchiveBytes ||
		input.unpackedBytes > workspaceSnapshotLimitsV1.maxUnpackedBytes ||
		input.ownerStoredBytes + input.archiveBytes >
			workspaceSnapshotLimitsV1.maxOwnerBytes ||
		input.agentBindingCount >= workspaceSnapshotLimitsV1.maxSnapshotsPerAgent ||
		input.agentArchiveBytes + input.archiveBytes >
			workspaceSnapshotLimitsV1.maxUnpackedBytes ||
		input.agentUnpackedBytes + input.unpackedBytes >
			workspaceSnapshotLimitsV1.maxUnpackedBytes
	)
		throw new WorkspaceSnapshotSecurityErrorV1("quota_exceeded");
}

export interface WorkspaceSnapshotGcCandidateV1 {
	readonly snapshotId: string;
	readonly status: "ready" | "deleting" | "deleted";
	readonly createdAt: string;
	readonly bindings: readonly unknown[];
}

export function isWorkspaceSnapshotGcEligibleV1(input: {
	readonly candidate: WorkspaceSnapshotGcCandidateV1;
	readonly now: Date;
	readonly retentionMs: number;
}): boolean {
	if (!Number.isSafeInteger(input.retentionMs) || input.retentionMs < 0)
		return false;
	if (
		input.candidate.status !== "ready" ||
		input.candidate.bindings.length !== 0
	)
		return false;
	const createdAt = Date.parse(input.candidate.createdAt);
	return (
		Number.isFinite(createdAt) &&
		input.now.getTime() - createdAt >= input.retentionMs
	);
}

export function assertWorkspaceSnapshotGcEligibleV1(input: {
	readonly candidate: WorkspaceSnapshotGcCandidateV1;
	readonly now: Date;
	readonly retentionMs: number;
}): void {
	if (!isWorkspaceSnapshotGcEligibleV1(input))
		throw new WorkspaceSnapshotSecurityErrorV1("retention_not_elapsed");
}

export function assertWorkspaceSnapshotDeleteAllowedV1(
	bindings: readonly unknown[],
): void {
	if (bindings.length > 0)
		throw new WorkspaceSnapshotSecurityErrorV1("snapshot_bound");
}

// Keep the limits/error dependency live in this module's public contract.
export { WorkspaceSnapshotErrorV1 };
