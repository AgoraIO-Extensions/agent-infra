export const MagicSkillProviderOrderV1 = [
	"system",
	"my_library",
	"market",
	"clawhub",
	"skillhub",
	"npx",
	"github",
] as const;

export type SkillProviderIdV1 = (typeof MagicSkillProviderOrderV1)[number];

export type SkillPackageEntryV1 = Readonly<{
	path: string;
	kind: "file" | "directory" | "symlink";
	sizeBytes: number;
}>;

export type SkillPackageValidationV1 = Readonly<{
	fileCount: number;
	totalBytes: number;
}>;

export class SkillPackageValidationErrorV1 extends Error {
	readonly code:
		| "invalid_path"
		| "symlink"
		| "missing_entry"
		| "duplicate_path"
		| "file_limit"
		| "size_limit"
		| "invalid_size";

	constructor(code: SkillPackageValidationErrorV1["code"]) {
		super("Skill package validation failed");
		this.name = "SkillPackageValidationErrorV1";
		this.code = code;
	}
}

const safePath = (path: string) => {
	if (
		path.length === 0 ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path.includes("\0")
	)
		return false;
	const parts = path.split("/");
	return parts.every(
		(part) => part.length > 0 && part !== "." && part !== "..",
	);
};

export function validateSkillPackageEntriesV1(
	entries: readonly SkillPackageEntryV1[],
	options: Readonly<{
		maxFiles?: number;
		maxBytes?: number;
	}> = {},
): SkillPackageValidationV1 {
	const maxFiles = options.maxFiles ?? 2_000;
	const maxBytes = options.maxBytes ?? 50_000_000;
	const paths = new Set<string>();
	let fileCount = 0;
	let totalBytes = 0;
	for (const entry of entries) {
		if (!safePath(entry.path)) {
			throw new SkillPackageValidationErrorV1("invalid_path");
		}
		if (paths.has(entry.path)) {
			throw new SkillPackageValidationErrorV1("duplicate_path");
		}
		paths.add(entry.path);
		if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
			throw new SkillPackageValidationErrorV1("invalid_size");
		}
		if (entry.kind === "symlink") {
			throw new SkillPackageValidationErrorV1("symlink");
		}
		if (entry.kind !== "file") continue;
		fileCount += 1;
		totalBytes += entry.sizeBytes;
		if (fileCount > maxFiles) {
			throw new SkillPackageValidationErrorV1("file_limit");
		}
		if (totalBytes > maxBytes) {
			throw new SkillPackageValidationErrorV1("size_limit");
		}
	}
	if (
		!entries.some((entry) => entry.path === "SKILL.md" && entry.kind === "file")
	) {
		throw new SkillPackageValidationErrorV1("missing_entry");
	}
	return { fileCount, totalBytes };
}

export const skillHubVisibilityV1 = [
	"PRIVATE",
	"MEMBER",
	"ORGANIZATION",
	"MARKET",
] as const;
export type SkillHubVisibilityV1 = (typeof skillHubVisibilityV1)[number];

export type SkillHubVersionStateV1 =
	| "published"
	| "pending_review"
	| "rejected"
	| "revoked";

export type SkillHubReviewDecisionV1 = "approve" | "reject";

export type SkillHubVersionV1 = Readonly<{
	schemaVersion: 1;
	skillId: string;
	skillVersionId: string;
	ownerId: string;
	visibility: SkillHubVisibilityV1;
	provider: SkillProviderIdV1;
	version: string;
	packageObjectVersion: string;
	packageDigest: string;
	manifestDigest: string;
	state: SkillHubVersionStateV1;
	needUpgrade: boolean;
	reviewedBy: string | null;
	reviewReason: string | null;
	revokedAt: string | null;
}>;

export type SkillHubVersionCreateInputV1 = Readonly<{
	skillId: string;
	skillVersionId: string;
	ownerId: string;
	visibility: SkillHubVisibilityV1;
	provider: SkillProviderIdV1;
	version: string;
	packageObjectVersion: string;
	packageDigest: string;
	manifestDigest: string;
}>;

export class SkillHubLifecycleErrorV1 extends Error {
	readonly code:
		| "invalid_transition"
		| "owner_cannot_review"
		| "version_unavailable";

	constructor(code: SkillHubLifecycleErrorV1["code"]) {
		super("Skill Hub lifecycle transition rejected");
		this.name = "SkillHubLifecycleErrorV1";
		this.code = code;
	}
}

export function createSkillHubVersionV1(
	input: SkillHubVersionCreateInputV1,
): SkillHubVersionV1 {
	const requiresReview = input.visibility !== "PRIVATE";
	return Object.freeze({
		schemaVersion: 1,
		...input,
		state: requiresReview ? "pending_review" : "published",
		needUpgrade: false,
		reviewedBy: requiresReview ? null : input.ownerId,
		reviewReason: null,
		revokedAt: null,
	});
}

export function reviewSkillHubVersionV1(
	version: SkillHubVersionV1,
	input: Readonly<{
		reviewerId: string;
		decision: SkillHubReviewDecisionV1;
		reason?: string;
	}>,
): SkillHubVersionV1 {
	if (version.state !== "pending_review" || version.visibility === "PRIVATE") {
		throw new SkillHubLifecycleErrorV1("invalid_transition");
	}
	if (input.reviewerId === version.ownerId) {
		throw new SkillHubLifecycleErrorV1("owner_cannot_review");
	}
	if (input.decision === "reject" && !input.reason) {
		throw new SkillHubLifecycleErrorV1("invalid_transition");
	}
	return Object.freeze({
		...version,
		state: input.decision === "approve" ? "published" : "rejected",
		reviewedBy: input.reviewerId,
		reviewReason: input.reason ?? null,
	});
}

export function revokeSkillHubVersionV1(
	version: SkillHubVersionV1,
	revokedAt: string,
): SkillHubVersionV1 {
	if (version.state !== "published") {
		throw new SkillHubLifecycleErrorV1("invalid_transition");
	}
	return Object.freeze({ ...version, state: "revoked", revokedAt });
}

export function markSkillHubUpgradeV1(
	current: SkillHubVersionV1,
	latest: SkillHubVersionV1,
): SkillHubVersionV1 {
	if (
		current.skillId !== latest.skillId ||
		current.state === "revoked" ||
		latest.state !== "published" ||
		current.skillVersionId === latest.skillVersionId
	) {
		throw new SkillHubLifecycleErrorV1("version_unavailable");
	}
	return Object.freeze({ ...current, needUpgrade: true });
}

export type SkillHubAgentVersionBindingV1 = Readonly<{
	schemaVersion: 1;
	agentId: string;
	agentVersion: string;
	skillVersionId: string;
	syncRevision: number;
	state: "pending_sync";
}>;

export function bindSkillHubVersionToAgentVersionV1(
	version: SkillHubVersionV1,
	input: Readonly<{ agentId: string; agentVersion: string }>,
): SkillHubAgentVersionBindingV1 {
	if (version.state !== "published") {
		throw new SkillHubLifecycleErrorV1("version_unavailable");
	}
	return Object.freeze({
		schemaVersion: 1,
		agentId: input.agentId,
		agentVersion: input.agentVersion,
		skillVersionId: version.skillVersionId,
		syncRevision: 1,
		state: "pending_sync",
	});
}
