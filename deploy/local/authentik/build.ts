import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const destination = process.argv[2];
if (!destination) throw new Error("An output bundle path is required");
const outfile = resolve(destination);
await mkdir(dirname(outfile), { recursive: true });
await build({
	entryPoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
	outfile,
	bundle: true,
	platform: "node",
	target: "node24",
	format: "esm",
	sourcemap: false,
});
