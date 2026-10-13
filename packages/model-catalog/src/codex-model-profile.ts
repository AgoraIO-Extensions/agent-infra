import { z } from "zod";
import {
	ModelConfigurationErrorV1,
	modelIdentifier,
	reasoningLevel,
} from "./catalog.js";

const profileSchema = z.strictObject({
	model: modelIdentifier,
	reasoningLevels: z
		.array(reasoningLevel)
		.min(1)
		.max(32)
		.refine((values) => new Set(values).size === values.length),
});

const profilesSchema = z
	.array(profileSchema)
	.min(1)
	.max(1024)
	.refine(
		(values) =>
			new Set(values.map(({ model }) => model)).size === values.length,
	);

export interface CodexModelProfileV1 {
	readonly model: string;
	readonly reasoningLevels: readonly string[];
}

/**
 * Deployment-owned capability metadata returned by the fixed Codex image.
 * It intentionally contains no endpoint, credential, or applicant material.
 */
export function validateCodexModelProfilesV1(
	value: unknown,
): readonly CodexModelProfileV1[] {
	try {
		return Object.freeze(
			profilesSchema.parse(value).map((profile) =>
				Object.freeze({
					model: profile.model,
					reasoningLevels: Object.freeze([...profile.reasoningLevels]),
				}),
			),
		);
	} catch {
		throw new ModelConfigurationErrorV1();
	}
}

function profileForModel(
	profiles: readonly CodexModelProfileV1[],
	model: string,
) {
	return profiles.reduce<CodexModelProfileV1 | undefined>(
		(best, candidate) =>
			(model === candidate.model || model.startsWith(`${candidate.model}-`)) &&
			(!best || candidate.model.length > best.model.length)
				? candidate
				: best,
		undefined,
	);
}

/** Match the same exact or hyphen-separated longest profile as Runtime readiness. */
export function assertCodexModelProfilesV1(input: {
	readonly profiles: unknown;
	readonly options: readonly {
		readonly modelId: string;
		readonly reasoningLevels: readonly string[];
	}[];
}): void {
	const profiles = validateCodexModelProfilesV1(input.profiles);
	for (const option of input.options) {
		const profile = profileForModel(profiles, option.modelId);
		if (
			!profile ||
			option.reasoningLevels.some(
				(level) => !profile.reasoningLevels.includes(level),
			)
		)
			throw new ModelConfigurationErrorV1(
				false,
				"codex_model_profile_unsupported",
			);
	}
}
