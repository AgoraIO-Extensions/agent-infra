import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = resolve(packageRoot, "../..");
const migrationsRoot = resolve(repositoryRoot, "migrations/platform");
const drizzleKit = resolve(packageRoot, "node_modules/drizzle-kit/bin.cjs");

async function snapshot(directory) {
	const files = [];
	async function visit(current) {
		for (const entry of await readdir(current, { withFileTypes: true })) {
			const path = resolve(current, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile()) files.push(path);
		}
	}
	await visit(directory);
	return Object.fromEntries(
		await Promise.all(
			files.toSorted().map(async (path) => [
				relative(directory, path),
				createHash("sha256")
					.update(await readFile(path))
					.digest("hex"),
			]),
		),
	);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "agent-infra-migrations-"));
const generatedRoot = resolve(temporaryRoot, "platform");
try {
	await cp(migrationsRoot, generatedRoot, { recursive: true });
	const before = await snapshot(generatedRoot);
	execFileSync(
		process.execPath,
		[
			drizzleKit,
			"generate",
			"--dialect=postgresql",
			"--schema=src/schema.ts",
			`--out=${generatedRoot}`,
			"--name=drift_check",
		],
		{ cwd: packageRoot, stdio: "ignore" },
	);
	const after = await snapshot(generatedRoot);
	if (JSON.stringify(after) !== JSON.stringify(before)) {
		throw new Error("Platform migrations are stale; regenerate from schema.ts");
	}
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}
