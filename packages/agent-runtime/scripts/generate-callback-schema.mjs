import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const source = new URL(
	"../../../deploy/runtime/vendor/codex/callback-v2.schema.json",
	import.meta.url,
);
const target = new URL(
	"../src/codex-callback-schema.generated.ts",
	import.meta.url,
);
const bytes = await readFile(source);
const schema = JSON.parse(bytes.toString("utf8"));
const hash = createHash("sha256").update(bytes).digest("hex");
const output = `// biome-ignore-all lint/suspicious/noThenProperty: JSON Schema conditionals are data, not thenable objects.\n// Generated from vendor/codex/callback-v2.schema.json. Do not edit.\n// Source SHA-256: ${hash}\n// biome-ignore format: Keep the canonical JSON literal mechanically generated.\nexport const codexCallbackSchema = ${JSON.stringify(schema, null, 2)} as const;\n`;
if (process.argv.includes("--check")) {
	if ((await readFile(target, "utf8")) !== output)
		throw new Error("CODEX_CALLBACK_SCHEMA_GENERATION_STALE");
} else {
	await writeFile(target, output);
}
