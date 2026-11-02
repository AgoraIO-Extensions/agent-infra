import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";

// Reviewed OpenAPI bytes kept independent of current generation and Git history.
const digests = {
	v1: "5ca6d9634fcbf128989ee0d6d34399d2a8d344d1d60d6d01eea9550ddb165641",
	v2: "2b906986128f0f45f042ffbc0683ab5077677d4a9025f7f92d85be645e35767a",
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
