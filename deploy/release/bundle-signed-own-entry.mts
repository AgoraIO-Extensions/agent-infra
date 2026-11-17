import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** Bundle the pinned pure-JS WebSocket dependency; the final image keeps its entrypoint. */
export async function bundleSignedOwnEntry(output: string) {
	const result = await build({
		absWorkingDir: root,
		entryPoints: ["tests/fixtures/custom-agent-web/signed-server.ts"],
		outfile: resolve(output),
		bundle: true,
		platform: "node",
		target: "node24",
		format: "cjs",
		write: false,
		logLevel: "silent",
		define: { "import.meta.url": "__signedEntryModuleUrl" },
		banner: {
			js: 'const __signedEntryModuleUrl = require("node:url").pathToFileURL(__filename).href;',
		},
	});
	const file = result.outputFiles[0];
	if (result.outputFiles.length !== 1 || !file)
		throw new Error("SIGNED_ENTRY_BUNDLE_INVALID");
	await mkdir(dirname(resolve(output)), { recursive: true });
	await writeFile(resolve(output), file.contents, { flag: "wx", mode: 0o644 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const [output, ...extra] = process.argv.slice(2);
		if (!output || extra.length) throw new Error();
		await bundleSignedOwnEntry(output);
	} catch {
		process.stderr.write("SIGNED_ENTRY_BUNDLE_FAILED\n");
		process.exitCode = 1;
	}
}
