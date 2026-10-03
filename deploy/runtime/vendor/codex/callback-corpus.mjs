import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callbackCorpus } from "./callback-v2-corpus/index.mjs";

// The native candidate pins the serialized corpus, not its source-module layout.
export function readCallbackCorpusBytes() {
	const bytes = Buffer.from(`${JSON.stringify(callbackCorpus, null, 2)}\n`);
	const barrier = JSON.parse(
		readFileSync(new URL("./native-barrier-v1.json", import.meta.url), "utf8"),
	);
	const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	if (digest !== barrier.callbackCorpusSha256) {
		throw new Error("CODEX_CALLBACK_CORPUS_DIGEST_MISMATCH");
	}
	return bytes;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const args = process.argv.slice(2);
	if (args.length === 0) {
		process.stdout.write(readCallbackCorpusBytes());
	} else if (args.length === 2 && args[0] === "--output") {
		writeFileSync(args[1], readCallbackCorpusBytes());
	} else {
		throw new Error("Usage: node callback-corpus.mjs [--output <file>]");
	}
}
