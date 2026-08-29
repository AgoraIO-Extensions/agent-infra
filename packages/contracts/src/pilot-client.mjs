import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@hey-api/openapi-ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const input = resolve(
	packageRoot,
	"artifacts/openapi/pilot-browser.v1.openapi.json",
);
const output = resolve(repositoryRoot, "apps/web/src/pilot/generated");
const command = process.argv[2];

async function generate(directory) {
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
	await generate(temporaryRoot);
	if (command === "--write") {
		await rm(output, { recursive: true, force: true });
		await cp(temporaryRoot, output, { recursive: true });
	} else if (command === "--check") {
		const expected = await snapshot(temporaryRoot);
		const actual = await snapshot(output).catch(() => undefined);
		if (JSON.stringify(actual) !== JSON.stringify(expected)) {
			throw new Error("Generated Pilot browser client is stale");
		}
	} else {
		throw new Error("Usage: pilot-client.mjs (--write | --check)");
	}
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
