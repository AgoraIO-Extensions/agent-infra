import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

// Exact OpenAPI bytes from b1049e631f9e8b6e69c8dc791867894aac779531.
// Keep this reviewed pre-analysis baseline independent of current generation and Git history.
const digests = {
	v1: "63a990405b60ed26d4ebc2fb4fdd8a3c1c70d683fce8abcf21adc81ca0e66e47",
	v2: "3d3207c181979c9a8c382d7c321ea5ed8a43854f76aee59b9a961d50028a7e7d",
} as const;

export async function readEvaluationBaseline(version: keyof typeof digests) {
	const bytes = gunzipSync(
		await readFile(
			new URL(
				`./fixtures/evaluation-baseline.${version}.openapi.json.gz`,
				import.meta.url,
			),
		),
	);
	if (createHash("sha256").update(bytes).digest("hex") !== digests[version])
		throw new Error(
			`Evaluation ${version} compatibility baseline checksum mismatch`,
		);
	return JSON.parse(bytes.toString("utf8"));
}
