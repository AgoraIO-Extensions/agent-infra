import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@hey-api/openapi-ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const manifest = JSON.parse(
	await readFile(resolve(packageRoot, "package.json"), "utf8"),
);

if (
	JSON.stringify(manifest.exports).includes("test") ||
	manifest.files.includes("test")
) {
	throw new Error("Test-only client paths must not be published");
}

const temporaryRoot = await mkdtemp(
	resolve(packageRoot, "node_modules/.agent-infra-client-smoke-"),
);
try {
	const generatedDirectory = resolve(temporaryRoot, "generated");

	await createClient({
		input: resolve(packageRoot, "test/client/openapi-smoke.json"),
		output: generatedDirectory,
		plugins: ["@hey-api/client-fetch", "@hey-api/typescript"],
	});
	await writeFile(
		resolve(temporaryRoot, "consumer.ts"),
		'import { client } from "./generated/client.gen.js";\nimport type { ProtocolErrorV1 } from "./generated/types.gen.js";\n\nclient.setConfig({ baseUrl: "https://example.invalid" });\nexport const isRetryable = (error: ProtocolErrorV1): boolean => error.retryable;\n',
		"utf8",
	);
	await writeFile(
		resolve(temporaryRoot, "tsconfig.json"),
		`${JSON.stringify(
			{
				compilerOptions: {
					lib: ["ESNext", "DOM"],
					module: "ESNext",
					moduleResolution: "Bundler",
					noEmit: true,
					skipLibCheck: true,
					strict: true,
					target: "ESNext",
				},
				include: ["consumer.ts", "generated/**/*.ts"],
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	execFileSync(
		resolve(repositoryRoot, "node_modules/.bin/tsc"),
		["--project", resolve(temporaryRoot, "tsconfig.json")],
		{ stdio: "pipe" },
	);

	const generatedFiles = (await readdir(generatedDirectory)).sort();
	if (!generatedFiles.includes("client.gen.ts")) {
		throw new Error("OpenAPI smoke did not generate a fetch client");
	}
	const generatedSource = await Promise.all(
		generatedFiles
			.filter((path) => path.endsWith(".ts"))
			.map((path) => readFile(resolve(generatedDirectory, path), "utf8")),
	);
	if (
		generatedSource.some((source) =>
			/["'](?:zod|hono|drizzle(?:-orm)?|@kubernetes\/|@agent-infra\/)/.test(
				source,
			),
		)
	) {
		throw new Error("Generated browser client imports forbidden server types");
	}
	process.stdout.write(`${generatedFiles.join("\n")}\n`);
} finally {
	await rm(temporaryRoot, { recursive: true });
}
