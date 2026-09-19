import { createHash } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createLegacyMigrationFixture,
	legacyBodySentinel,
	writeSignedLegacyManifest,
} from "./legacy-migration.test-support.js";
import { runRuntimeLegacyMigrationCli } from "./legacy-migration-cli.js";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "legacy-cli-"));
	directories.push(directory);
	const legacy = await createLegacyMigrationFixture(directory);
	const output = join(directory, "candidate");
	await mkdir(output, { mode: 0o700 });
	return {
		...legacy,
		candidatePath: join(output, "host.json"),
		environment: {
			...legacy.environment,
			AGENT_INFRA_RUNTIME_LEGACY_CANDIDATE_FILE: join(output, "host.json"),
		},
	};
}

describe("offline Host migration candidate CLI", () => {
	it("commits only in explicit offline mode, preserves history and replays the exact same proof", async () => {
		const env = await fixture();
		const environment = {
			...env.environment,
			AGENT_INFRA_RUNTIME_LEGACY_BOOTSTRAP_MODE: "offline-commit",
		};
		const result = await runRuntimeLegacyMigrationCli(environment);
		expect(result).toMatchObject({ status: "applied", commitPerformed: true });
		expect(await readFile(env.hostPath)).toEqual(
			await readFile(env.candidatePath),
		);
		expect(await readdir(env.dataDirectory)).not.toContain(
			".legacy-migration-bootstrap-lock",
		);
		const committed = await readFile(env.hostPath);
		await rm(env.candidatePath);
		expect(await runRuntimeLegacyMigrationCli(environment)).toMatchObject({
			status: "replayed",
			commitPerformed: false,
		});
		expect(await readFile(env.hostPath)).toEqual(committed);
	});

	it("refuses an existing maintenance lock without removing it or changing the journal", async () => {
		const env = await fixture();
		const lock = join(env.dataDirectory, ".legacy-migration-bootstrap-lock");
		await mkdir(lock);
		await writeFile(join(lock, "owner"), "another-bootstrap");
		const original = await readFile(env.hostPath);
		await expect(
			runRuntimeLegacyMigrationCli({
				...env.environment,
				AGENT_INFRA_RUNTIME_LEGACY_BOOTSTRAP_MODE: "offline-commit",
			}),
		).rejects.toThrow(/^RUNTIME_LEGACY_MIGRATION_INVALID$/);
		expect(await readFile(env.hostPath)).toEqual(original);
		expect(await readFile(join(lock, "owner"), "utf8")).toBe(
			"another-bootstrap",
		);
	});

	it("serializes candidate mode with the same maintenance lock", async () => {
		const env = await fixture();
		const lock = join(env.dataDirectory, ".legacy-migration-bootstrap-lock");
		await mkdir(lock);
		await expect(runRuntimeLegacyMigrationCli(env.environment)).rejects.toThrow(
			/^RUNTIME_LEGACY_MIGRATION_INVALID$/,
		);
		await rm(lock, { recursive: true });
		await expect(runRuntimeLegacyMigrationCli(env.environment)).resolves.toMatchObject(
			{ status: "verified_candidate" },
		);
	});

	it("validates via the existing loader/Store without altering the original journal or opening a Driver/listener", async () => {
		const env = await fixture();
		const original = await readFile(env.hostPath);
		const sideEffects = await env.driver.sideEffectCount();
		// No Runtime transport token, model configuration or private signing key is needed.
		const { AGENT_INFRA_RUNTIME_SERVICE_TOKEN: _token, ...environment } =
			env.environment;
		const result = await runRuntimeLegacyMigrationCli(environment);
		expect(result).toMatchObject({
			status: "verified_candidate",
			commitPerformed: false,
			wouldChange: true,
			driverOpened: false,
			listenerOpened: false,
		});
		expect(JSON.stringify(result)).not.toContain(legacyBodySentinel);
		expect(await readFile(env.hostPath)).toEqual(original);
		const candidate = await readFile(env.candidatePath);
		expect(result.candidateSha256).toBe(
			createHash("sha256").update(candidate).digest("hex"),
		);
		const after = JSON.parse(candidate.toString("utf8"));
		const target = after.sessions[env.manifest.hostSessionRef];
		expect(target.authority.principal).toEqual(env.manifest.principal);
		expect(target.executionAuthorities).toEqual({});
		const {
			authority: _authority,
			executionAuthorities: _executions,
			...old
		} = target;
		expect(old).toEqual(env.before.sessions[env.manifest.hostSessionRef]);
		expect(await env.driver.sideEffectCount()).toBe(sideEffects);
		expect(await readdir(env.dataDirectory)).toEqual([
			"fake-driver.json",
			"host.json",
		]);
	});

	it("does not overwrite existing candidate files or manufacture a missing original journal", async () => {
		const env = await fixture();
		const original = await readFile(env.hostPath);
		await writeFile(env.candidatePath, "existing output", { mode: 0o600 });
		await expect(runRuntimeLegacyMigrationCli(env.environment)).rejects.toThrow(
			/^RUNTIME_LEGACY_MIGRATION_INVALID$/,
		);
		expect(await readFile(env.candidatePath, "utf8")).toBe("existing output");
		expect(await readFile(env.hostPath)).toEqual(original);
		await rm(env.hostPath);
		await expect(runRuntimeLegacyMigrationCli(env.environment)).rejects.toThrow(
			/^RUNTIME_LEGACY_MIGRATION_INVALID$/,
		);
		await expect(readFile(env.hostPath)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("rejects mismatched complete sets, principal rebinding and a changed deployment before writing candidate or original", async () => {
		for (const failure of ["coverage", "principal", "binding"]) {
			const env = await fixture();
			const original = await readFile(env.hostPath);
			const manifest = structuredClone(env.manifest);
			if (failure === "coverage") manifest.executions.pop();
			if (failure === "binding") manifest.deployment.fence++;
			if (failure === "principal") {
				// First generate and explicitly install a prior candidate in the test fixture.
				await runRuntimeLegacyMigrationCli(env.environment);
				await writeFile(env.hostPath, await readFile(env.candidatePath));
				await rm(env.candidatePath);
				manifest.principal.id = "another-user";
			}
			const beforeAttempt = await readFile(env.hostPath);
			await writeSignedLegacyManifest(env.manifestPath, manifest);
			await expect(
				runRuntimeLegacyMigrationCli(env.environment),
			).rejects.toThrow(/^RUNTIME_LEGACY_MIGRATION_INVALID$/);
			expect(await readFile(env.hostPath)).toEqual(beforeAttempt);
			if (failure !== "principal") expect(beforeAttempt).toEqual(original);
			await expect(readFile(env.candidatePath)).rejects.toMatchObject({
				code: "ENOENT",
			});
		}
	});

	it("refuses Store normalization or quarantine of another Session instead of changing unrelated data", async () => {
		const env = await fixture();
		const before = structuredClone(env.before);
		before.sessions["unrelated-corrupt"] = { unreadable: "private-sentinel" };
		await writeFile(env.hostPath, JSON.stringify(before));
		const original = await readFile(env.hostPath);
		await expect(runRuntimeLegacyMigrationCli(env.environment)).rejects.toThrow(
			/^RUNTIME_LEGACY_MIGRATION_INVALID$/,
		);
		expect(await readFile(env.hostPath)).toEqual(original);
		await expect(readFile(env.candidatePath)).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	it("rejects writable-data candidate paths and symlinked original state", async () => {
		const env = await fixture();
		await expect(
			runRuntimeLegacyMigrationCli({
				...env.environment,
				AGENT_INFRA_RUNTIME_LEGACY_CANDIDATE_FILE: join(
					env.dataDirectory,
					"candidate.json",
				),
			}),
		).rejects.toThrow(/^RUNTIME_LEGACY_MIGRATION_INVALID$/);
		const original = await readFile(env.hostPath);
		const linkedTarget = join(env.dataDirectory, "original.json");
		await writeFile(linkedTarget, original);
		await rm(env.hostPath);
		await symlink(linkedTarget, env.hostPath);
		await expect(runRuntimeLegacyMigrationCli(env.environment)).rejects.toThrow(
			/^RUNTIME_LEGACY_MIGRATION_INVALID$/,
		);
		expect(await readFile(linkedTarget)).toEqual(original);
	});
});
