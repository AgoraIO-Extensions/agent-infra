const digestPattern = /^sha256:[a-f0-9]{64}$/;
const platformPattern = /^linux\/(?:amd64|arm64)$/;

/**
 * Select the architecture-specific manifest digest from an index publication
 * receipt. The index digest is retained as publication metadata and can never
 * be used as the runtime binding.
 */
export function selectArchitectureManifestDigest(publication, platform) {
	if (!publication || typeof publication !== "object")
		throw new Error("image publication metadata is invalid");
	if (!platformPattern.test(platform))
		throw new Error("image publication platform is invalid");
	if (!digestPattern.test(publication.indexDigest))
		throw new Error("image publication index digest is invalid");
	const digest = publication.platformDigests?.[platform];
	if (!digestPattern.test(digest))
		throw new Error(`image publication has no ${platform} manifest digest`);
	if (digest === publication.indexDigest)
		throw new Error("runtime binding must use an architecture manifest digest, not the index digest");
	return digest;
}

/** Reject a deployment binding that points at the multi-architecture index. */
export function assertArchitectureManifestDigest(publication, platform, digest) {
	const selected = selectArchitectureManifestDigest(publication, platform);
	if (digest !== selected)
		throw new Error(`runtime binding must use the ${platform} architecture manifest digest`);
	return digest;
}
