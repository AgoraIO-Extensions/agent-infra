import { createHash } from "node:crypto";
import type { FileLimitsV1 } from "./file-authority.js";
export interface FileLimitDeclarationsV1 {
	readonly agent: FileLimitsV1 | null;
	readonly channel: FileLimitsV1 | null;
	readonly deployment: FileLimitsV1 | null;
}
export function resolveFileLimitsV1(
	input: FileLimitDeclarationsV1,
	now: Date,
): FileLimitsV1 | null {
	const declarations = [input.agent, input.channel, input.deployment];
	if (
		declarations.some(
			(value) =>
				!value?.revision ||
				!Number.isFinite(Date.parse(value.expiresAt)) ||
				Date.parse(value.expiresAt) <= now.getTime() ||
				!Number.isSafeInteger(value.maxBytes) ||
				value.maxBytes < 1 ||
				value.mediaTypes.length === 0,
		)
	)
		return null;
	const values = declarations as FileLimitsV1[];
	const mediaTypes = [...new Set(values[0]?.mediaTypes ?? [])]
		.filter((type) => values.every((value) => value.mediaTypes.includes(type)))
		.sort();
	if (mediaTypes.length === 0) return null;
	return {
		revision: createHash("sha256")
			.update(
				JSON.stringify(
					values.map((value) => ({
						...value,
						mediaTypes: [...value.mediaTypes].sort(),
					})),
				),
			)
			.digest("hex"),
		expiresAt: new Date(
			Math.min(...values.map((value) => Date.parse(value.expiresAt))),
		).toISOString(),
		maxBytes: Math.min(...values.map((value) => value.maxBytes)),
		mediaTypes,
	};
}
