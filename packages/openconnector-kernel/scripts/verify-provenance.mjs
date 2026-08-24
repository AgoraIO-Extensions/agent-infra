import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const provenance = JSON.parse(
	await readFile(resolve(packageRoot, "PROVENANCE.json"), "utf8"),
);
const digest = createHash("sha256");
for (const file of provenance.copiedFiles) {
	digest.update(`${file}\0`);
	digest.update(await readFile(resolve(packageRoot, file)));
}
const actual = digest.digest("hex");
if (actual !== provenance.source.copiedFilesSha256) {
	throw new Error(
		`OpenConnector copied-file digest mismatch: expected ${provenance.source.copiedFilesSha256}, got ${actual}`,
	);
}
