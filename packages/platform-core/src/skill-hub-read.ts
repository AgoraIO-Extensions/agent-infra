import type { SkillHubVersionV1 } from "./skill-hub.js";
import {
	parseSkillHubIdV1,
	SkillHubOperationErrorV1,
} from "./skill-hub-management.js";

type NamedVersion = SkillHubVersionV1 & { readonly name: string };

export function projectSkillHubVersionMetadataV1(version: NamedVersion) {
	if (version.state !== "published")
		throw new SkillHubOperationErrorV1("unavailable");
	return {
		schemaVersion: version.schemaVersion,
		skillId: version.skillId,
		skillVersionId: version.skillVersionId,
		name: version.name,
		visibility: version.visibility,
		provider: version.provider,
		version: version.version,
		packageDigest: version.packageDigest,
		manifestDigest: version.manifestDigest,
		signatureDigest: version.signatureDigest,
		state: version.state,
	};
}

export function pageSkillHubVersionsV1(
	versions: readonly NamedVersion[],
	query: { readonly cursor?: string; readonly limit?: number },
) {
	const limit = query.limit ?? 50;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
		throw new SkillHubOperationErrorV1("invalid_input");
	const cursor =
		query.cursor === undefined ? undefined : parseSkillHubIdV1(query.cursor);
	// ponytail: reuse the existing full authorized directory; move pagination into
	// its Store query when directory size makes the in-memory sort costly.
	const page = versions
		.filter(
			(version) => cursor === undefined || version.skillVersionId > cursor,
		)
		.toSorted((a, b) =>
			a.skillVersionId < b.skillVersionId
				? -1
				: a.skillVersionId > b.skillVersionId
					? 1
					: 0,
		)
		.slice(0, limit + 1);
	return {
		items: page.slice(0, limit).map(projectSkillHubVersionMetadataV1),
		nextCursor:
			page.length > limit ? (page[limit - 1]?.skillVersionId ?? null) : null,
	};
}
