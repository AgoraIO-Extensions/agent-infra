import type { AgentManagementActorContextV1 } from "./agent-management.js";
import {
	isAgentManagementText,
	parseAgentManagementActorContext,
	requireAgentManagementExactKeys,
	snapshotAgentManagementDataObject,
} from "./agent-management-input.js";
import {
	MagicSkillProviderOrderV1,
	type SkillHubVersionCreateInputV1,
	type SkillHubVersionV1,
	skillHubVisibilityV1,
} from "./skill-hub.js";

export const skillHubOperationCodesV1 = [
	"invalid_input",
	"forbidden",
	"not_found",
	"idempotency_conflict",
	"version_conflict",
	"invalid_transition",
	"owner_cannot_review",
	"version_unavailable",
	"unavailable",
] as const;
export type SkillHubOperationCodeV1 = (typeof skillHubOperationCodesV1)[number];
export class SkillHubOperationErrorV1 extends Error {
	constructor(readonly code: SkillHubOperationCodeV1) {
		super("Skill Hub operation rejected");
		this.name = "SkillHubOperationErrorV1";
	}
}

export interface SkillHubRequestV1 {
	/** Supplied by the existing authenticated server boundary, never the command body. */
	readonly userId: string;
	readonly requestId: string;
	readonly traceId: string;
}
export interface SkillHubIdentitySnapshotV1 {
	readonly actor: AgentManagementActorContextV1;
	readonly authorizationRevision: string;
}
/** Internal package-supplier metadata; parsing does not attest package bytes or admission. */
export type SkillHubRegistrationV1 = Omit<
	SkillHubVersionCreateInputV1,
	"ownerId"
> & {
	readonly schemaVersion: 1;
	readonly name: string;
	readonly organizationId?: string | null;
};

function invalid(): never {
	throw new SkillHubOperationErrorV1("invalid_input");
}
function text(input: unknown, maximum = 1024): string {
	if (!isAgentManagementText(input) || input.length > maximum) invalid();
	return input;
}
function object(input: unknown, keys: readonly string[]) {
	const value = snapshotAgentManagementDataObject(input);
	requireAgentManagementExactKeys(value, keys);
	return value;
}
function parsed<T>(work: () => T): T {
	try {
		return work();
	} catch {
		invalid();
	}
}

export function parseSkillHubRequestV1(input: unknown): SkillHubRequestV1 {
	return parsed(() => {
		const value = object(input, ["userId", "requestId", "traceId"]);
		return Object.freeze({
			userId: text(value.userId),
			requestId: text(value.requestId),
			traceId: text(value.traceId),
		});
	});
}

export function parseSkillHubIdentitySnapshotV1(
	input: unknown,
	userId: string,
): SkillHubIdentitySnapshotV1 {
	let result: SkillHubIdentitySnapshotV1;
	try {
		const value = object(input, ["actor", "authorizationRevision"]);
		const actor = parseAgentManagementActorContext(value.actor);
		if (actor.userId !== userId) throw new Error();
		result = Object.freeze({
			actor: Object.freeze({
				...actor,
				organizationIds: Object.freeze([...actor.organizationIds]),
			}),
			authorizationRevision: text(value.authorizationRevision),
		});
	} catch {
		throw new SkillHubOperationErrorV1("unavailable");
	}
	if (result.actor.accountStatus !== "active")
		throw new SkillHubOperationErrorV1("forbidden");
	return result;
}

export function parseSkillHubIdV1(input: unknown): string {
	if (
		typeof input !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input)
	)
		invalid();
	return input;
}
export function parseSkillHubIdempotencyKeyV1(input: unknown): string {
	if (typeof input !== "string" || !/^[A-Za-z0-9._~-]{1,128}$/.test(input))
		invalid();
	return input;
}

export function parseSkillHubObjectVersionV1(input: unknown): string {
	if (
		typeof input !== "string" ||
		input.length === 0 ||
		input === "null" ||
		!input.isWellFormed() ||
		new TextEncoder().encode(input).byteLength > 1024
	)
		invalid();
	return input;
}

export function parseSkillHubRegistrationV1(
	input: unknown,
): SkillHubRegistrationV1 {
	return parsed(() => {
		const keys = [
			"schemaVersion",
			"name",
			"skillId",
			"skillVersionId",
			"visibility",
			"provider",
			"version",
			"packageObjectVersion",
			"packageDigest",
			"manifestDigest",
			"signatureDigest",
		] as const;
		const value = object(
			input,
			Object.hasOwn((input as Record<string, unknown>) ?? {}, "organizationId")
				? [...keys, "organizationId"]
				: keys,
		);
		if (
			value.schemaVersion !== 1 ||
			typeof value.name !== "string" ||
			!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(value.name) ||
			!skillHubVisibilityV1.some((item) => item === value.visibility) ||
			!MagicSkillProviderOrderV1.some((item) => item === value.provider)
		)
			invalid();
		const digest = (input: unknown) => {
			if (typeof input !== "string" || !/^[a-f0-9]{64}$/.test(input)) invalid();
			return input;
		};
		return Object.freeze({
			schemaVersion: 1,
			name: value.name,
			skillId: parseSkillHubIdV1(value.skillId),
			skillVersionId: parseSkillHubIdV1(value.skillVersionId),
			visibility: value.visibility as SkillHubRegistrationV1["visibility"],
			provider: value.provider as SkillHubRegistrationV1["provider"],
			version: parseSkillHubIdV1(value.version),
			packageObjectVersion: parseSkillHubObjectVersionV1(
				value.packageObjectVersion,
			),
			packageDigest: digest(value.packageDigest),
			manifestDigest: digest(value.manifestDigest),
			signatureDigest: digest(value.signatureDigest),
			...(Object.hasOwn(value, "organizationId")
				? {
						organizationId:
							value.organizationId === null
								? null
								: parseSkillHubIdV1(value.organizationId),
					}
				: {}),
		});
	});
}

export function parseSkillHubReviewV1(input: unknown) {
	return parsed(() => {
		const value = snapshotAgentManagementDataObject(input);
		requireAgentManagementExactKeys(
			value,
			Object.hasOwn(value, "reason") ? ["decision", "reason"] : ["decision"],
		);
		if (value.decision !== "approve" && value.decision !== "reject") invalid();
		const reason = value.reason === undefined ? undefined : text(value.reason);
		if ((value.decision === "reject" && !reason) || reason?.trim().length === 0)
			invalid();
		return Object.freeze({
			decision: value.decision,
			...(reason === undefined ? {} : { reason }),
		});
	});
}

export function requireSkillHubReviewerV1(
	actor: AgentManagementActorContextV1,
) {
	if (actor.accountStatus !== "active" || !actor.isAdministrator)
		throw new SkillHubOperationErrorV1("forbidden");
}
export function requireSkillHubIndependentReviewerV1(
	version: SkillHubVersionV1,
	actor: AgentManagementActorContextV1,
) {
	requireSkillHubReviewerV1(actor);
	if (version.ownerId === actor.userId)
		throw new SkillHubOperationErrorV1("owner_cannot_review");
}
export function requireSkillHubVersionAccessV1(
	version: SkillHubVersionV1,
	actor: AgentManagementActorContextV1,
) {
	if (actor.accountStatus !== "active")
		throw new SkillHubOperationErrorV1("forbidden");
	if (!actor.isAdministrator && version.ownerId !== actor.userId)
		throw new SkillHubOperationErrorV1("not_found");
}

export function requireSkillHubRegistrationParentV1(
	parent: Readonly<{ ownerId: string; name: string; status: string }>,
	command: SkillHubRegistrationV1,
	userId: string,
) {
	if (parent.ownerId !== userId)
		throw new SkillHubOperationErrorV1("not_found");
	if (parent.status !== "active")
		throw new SkillHubOperationErrorV1("forbidden");
	if (parent.name !== command.name)
		throw new SkillHubOperationErrorV1("version_conflict");
}
