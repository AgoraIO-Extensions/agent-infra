import { createHash } from "node:crypto";

import type { FileLimitsV1 } from "./file-authority.js";
import type { FileLimitDeclarationsV1 } from "./file-limits.js";

export const fileLimitDeclarationScopesV1 = [
	"deployment",
	"agent",
	"channel",
] as const;
export type FileLimitDeclarationScopeV1 =
	(typeof fileLimitDeclarationScopesV1)[number];

export type FileLimitDeclarationSubjectV1 =
	| { readonly scope: "deployment" }
	| { readonly scope: "agent"; readonly agentId: string }
	| {
			readonly scope: "channel";
			readonly agentId: string;
			readonly channelId: string;
	  };

export interface FileLimitDeclarationInputV1 {
	readonly expiresAt: string;
	readonly mediaTypes: readonly string[];
	readonly maxBytes: number;
}

export interface FileLimitDeclarationRecordV1
	extends FileLimitDeclarationInputV1 {
	readonly scope: FileLimitDeclarationScopeV1;
	readonly agentId: string;
	readonly channelId: string | null;
	readonly revision: number;
	readonly updatedAt: string;
	readonly updatedBy: string;
}

export interface FileLimitDeclarationWriteRequestV1 {
	readonly subject: FileLimitDeclarationSubjectV1;
	readonly declaration: FileLimitDeclarationInputV1;
	/** `null` starts a new declaration; otherwise compare-and-swap on this revision. */
	readonly expectedRevision: number | null;
	readonly idempotencyKey: string;
	readonly requestDigest: string;
	readonly actorId: string;
	readonly now: Date;
}

export interface FileLimitDeclarationStoreV1 {
	read(
		subject: FileLimitDeclarationSubjectV1,
	): Promise<FileLimitDeclarationRecordV1 | null>;
	/** Current persisted Agent configuration revision, or `null` when it does not exist. */
	readAgentConfigurationRevision(agentId: string): Promise<number | null>;
	write(
		input: FileLimitDeclarationWriteRequestV1,
	): Promise<FileLimitDeclarationRecordV1>;
}

export interface FileLimitDeclarationReaderInputV1 {
	readonly agentId: string;
	readonly channelId: string;
	readonly configurationRevision: number;
	readonly kind: "attachment" | "result";
}

export interface FileLimitDeclarationReaderResultV1 {
	readonly configurationRevision: number;
	readonly declarations: FileLimitDeclarationsV1;
}

export type FileLimitDeclarationErrorCodeV1 =
	| "invalid_input"
	| "forbidden"
	| "conflict"
	| "unavailable";

export class FileLimitDeclarationErrorV1 extends Error {
	readonly code: FileLimitDeclarationErrorCodeV1;

	constructor(code: FileLimitDeclarationErrorCodeV1) {
		super("File limit declaration rejected");
		this.name = "FileLimitDeclarationErrorV1";
		this.code = code;
	}
}

const mediaTypePattern = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const maxMediaTypes = 128;

function validIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 255 &&
		!/\p{Cc}/u.test(value)
	);
}

function validSubject(subject: FileLimitDeclarationSubjectV1): boolean {
	switch (subject.scope) {
		case "deployment":
			return true;
		case "agent":
			return validIdentifier(subject.agentId);
		case "channel":
			return (
				validIdentifier(subject.agentId) && validIdentifier(subject.channelId)
			);
	}
}

/** Validates a caller-supplied declaration and returns its canonical form. */
export function normalizeFileLimitDeclarationV1(
	input: unknown,
	now: Date,
): FileLimitDeclarationInputV1 {
	if (typeof input !== "object" || input === null)
		throw new FileLimitDeclarationErrorV1("invalid_input");
	const candidate = input as {
		readonly expiresAt?: unknown;
		readonly mediaTypes?: unknown;
		readonly maxBytes?: unknown;
	};
	const { expiresAt, mediaTypes, maxBytes } = candidate;
	if (typeof expiresAt !== "string")
		throw new FileLimitDeclarationErrorV1("invalid_input");
	const expiresAtMs = Date.parse(expiresAt);
	if (
		!Number.isFinite(expiresAtMs) ||
		!Number.isFinite(now.getTime()) ||
		expiresAtMs <= now.getTime()
	)
		throw new FileLimitDeclarationErrorV1("invalid_input");
	if (!Number.isSafeInteger(maxBytes) || (maxBytes as number) < 1)
		throw new FileLimitDeclarationErrorV1("invalid_input");
	if (
		!Array.isArray(mediaTypes) ||
		mediaTypes.length === 0 ||
		mediaTypes.length > maxMediaTypes
	)
		throw new FileLimitDeclarationErrorV1("invalid_input");
	const normalizedMediaTypes: string[] = [];
	for (const value of mediaTypes) {
		if (typeof value !== "string")
			throw new FileLimitDeclarationErrorV1("invalid_input");
		const mediaType = value.toLowerCase();
		if (mediaType.length > 127 || !mediaTypePattern.test(mediaType))
			throw new FileLimitDeclarationErrorV1("invalid_input");
		if (!normalizedMediaTypes.includes(mediaType))
			normalizedMediaTypes.push(mediaType);
	}
	normalizedMediaTypes.sort();
	if (normalizedMediaTypes.length === 0)
		throw new FileLimitDeclarationErrorV1("invalid_input");
	return {
		expiresAt: new Date(expiresAtMs).toISOString(),
		mediaTypes: normalizedMediaTypes,
		maxBytes: maxBytes as number,
	};
}

/** Maps a persisted declaration onto the contract consumed by `resolveFileLimitsV1`. */
export function fileLimitDeclarationToLimitsV1(
	record: FileLimitDeclarationRecordV1,
): FileLimitsV1 {
	return {
		revision: String(record.revision),
		expiresAt: record.expiresAt,
		mediaTypes: record.mediaTypes,
		maxBytes: record.maxBytes,
	};
}

export async function readFileLimitDeclarationV1(input: {
	readonly store: Pick<FileLimitDeclarationStoreV1, "read">;
	readonly subject: FileLimitDeclarationSubjectV1;
	readonly authorize: () => Promise<boolean>;
}): Promise<FileLimitDeclarationRecordV1 | null> {
	if (!(await input.authorize()))
		throw new FileLimitDeclarationErrorV1("forbidden");
	return input.store.read(input.subject);
}

export async function writeFileLimitDeclarationV1(input: {
	readonly store: FileLimitDeclarationStoreV1;
	readonly subject: FileLimitDeclarationSubjectV1;
	readonly declaration: unknown;
	readonly expectedRevision: number | null;
	readonly idempotencyKey: string;
	readonly actorId: string;
	readonly now: Date;
	readonly authorize: () => Promise<boolean>;
}): Promise<FileLimitDeclarationRecordV1> {
	if (!validSubject(input.subject))
		throw new FileLimitDeclarationErrorV1("invalid_input");
	// Authorize before validating the body so a non-owner cannot probe it.
	if (!(await input.authorize()))
		throw new FileLimitDeclarationErrorV1("forbidden");
	if (
		input.expectedRevision !== null &&
		(!Number.isSafeInteger(input.expectedRevision) ||
			input.expectedRevision < 1)
	)
		throw new FileLimitDeclarationErrorV1("invalid_input");
	if (!validIdentifier(input.actorId) || !validIdentifier(input.idempotencyKey))
		throw new FileLimitDeclarationErrorV1("invalid_input");
	const declaration = normalizeFileLimitDeclarationV1(
		input.declaration,
		input.now,
	);
	const requestDigest = createHash("sha256")
		.update(
			JSON.stringify({
				subject: input.subject,
				declaration,
				expectedRevision: input.expectedRevision,
			}),
		)
		.digest("hex");
	return input.store.write({
		subject: input.subject,
		declaration,
		expectedRevision: input.expectedRevision,
		idempotencyKey: input.idempotencyKey,
		requestDigest,
		actorId: input.actorId,
		now: input.now,
	});
}

/**
 * Production reader for `PlatformFileDeploymentV1.readLimits`.
 *
 * The caller passes the Agent configuration revision it already validated; a
 * mismatch is reported as-is so the assembly rejects a stale snapshot instead of
 * silently resolving limits for a different configuration.
 */
export function createFileLimitDeclarationReaderV1(options: {
	readonly store: Pick<
		FileLimitDeclarationStoreV1,
		"read" | "readAgentConfigurationRevision"
	>;
}): (
	input: FileLimitDeclarationReaderInputV1,
) => Promise<FileLimitDeclarationReaderResultV1> {
	return async (input) => {
		const [deployment, agent, channel, currentConfigurationRevision] =
			await Promise.all([
				options.store.read({ scope: "deployment" }),
				options.store.read({ scope: "agent", agentId: input.agentId }),
				options.store.read({
					scope: "channel",
					agentId: input.agentId,
					channelId: input.channelId,
				}),
				options.store.readAgentConfigurationRevision(input.agentId),
			]);
		return {
			configurationRevision: currentConfigurationRevision ?? -1,
			declarations: {
				deployment: deployment
					? fileLimitDeclarationToLimitsV1(deployment)
					: null,
				agent: agent ? fileLimitDeclarationToLimitsV1(agent) : null,
				channel: channel ? fileLimitDeclarationToLimitsV1(channel) : null,
			},
		};
	};
}
