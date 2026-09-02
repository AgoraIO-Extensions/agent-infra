import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@hey-api/openapi-ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const clients = [
	{
		input: resolve(
			packageRoot,
			"artifacts/openapi/pilot-browser.v1.openapi.json",
		),
		output: resolve(repositoryRoot, "apps/web/src/pilot/generated"),
	},
	{
		input: resolve(
			packageRoot,
			"artifacts/openapi/pilot-browser.v2.openapi.json",
		),
		output: resolve(repositoryRoot, "apps/web/src/pilot/generated-v2"),
	},
];
const command = process.argv[2];

async function generate(input, directory) {
	await createClient({
		input,
		output: directory,
		plugins: ["@hey-api/client-fetch", "@hey-api/typescript", "@hey-api/sdk"],
	});
}

async function snapshot(directory) {
	const entries = await readdir(directory, {
		recursive: true,
		withFileTypes: true,
	});
	const files = entries
		.filter((entry) => entry.isFile())
		.map((entry) => resolve(entry.parentPath, entry.name))
		.sort();
	return Object.fromEntries(
		await Promise.all(
			files.map(async (path) => [
				relative(directory, path),
				await readFile(path, "utf8"),
			]),
		),
	);
}

const temporaryRoot = await mkdtemp(
	resolve(tmpdir(), "agent-infra-pilot-client-"),
);
try {
	for (const [index, client] of clients.entries()) {
		const generated = resolve(temporaryRoot, String(index));
		await generate(client.input, generated);
		if (command === "--write") {
			await rm(client.output, { recursive: true, force: true });
			await cp(generated, client.output, { recursive: true });
		} else if (command === "--check") {
			const expected = await snapshot(generated);
			const actual = await snapshot(client.output).catch(() => undefined);
			if (JSON.stringify(actual) !== JSON.stringify(expected)) {
				throw new Error("Generated Pilot browser client is stale");
			}
		} else {
			throw new Error("Usage: pilot-client.mjs (--write | --check)");
		}
	}
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
