import { generateKeyPairSync } from "node:crypto";
import {
	chmod,
	copyFile,
	link,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileRuntimeStore } from "@agent-infra/agent-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readRuntimeLegacyMigrationV1 } from "./legacy-migration.js";
import {
	createLegacyMigrationFixture,
	legacyBodySentinel,
	migrationBinding,
	writeSignedLegacyManifest,
} from "./legacy-migration.test-support.js";

const directories: string[] = [];
beforeEach(() => {
	// Fixtures are created by the test process; model the separately-owned
	// deployment mounts that production requires.
	vi.spyOn(process, "getuid").mockReturnValue(65534);
});
afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "legacy-migration-"));
	directories.push(directory);
	return createLegacyMigrationFixture(directory);
}
function load(
	input: Awaited<ReturnType<typeof fixture>>,
	environment = input.environment,
) {
	return readRuntimeLegacyMigrationV1({
		environment,
		expectedIssuer: "platform-fixture",
		binding: migrationBinding,
		dataDirectory: input.dataDirectory,
	});
}

describe("deployment-signed Host legacy principal migration", () => {
	it("atomically preserves old completed/pending operations, native Session, selection, digest and result across replay", async () => {
		const env = await fixture();
		const proof = await load(env);
		if (!proof) throw new Error("Expected verified proof");
		expect(await readFile(env.manifestPath, "utf8")).not.toContain(
			legacyBodySentinel,
		);
		await proof.apply(env.store);
		const saved = JSON.parse(await readFile(env.hostPath, "utf8"));
		const current = saved.sessions[env.manifest.hostSessionRef];
		expect(current.authority).toMatchObject({
			principal: env.manifest.principal,
			channelId: "web",
			migrationId: expect.stringMatching(/^legacy-principal-v1:[a-f0-9]{64}$/),
		});
		expect(current.executionAuthorities).toEqual({});
		const {
			authority: _authority,
			executionAuthorities: _executionAuthorities,
			...original
		} = current;
		expect(original).toEqual(env.before.sessions[env.manifest.hostSessionRef]);
		expect(saved.sessionBindings).toEqual(env.before.sessionBindings);
		expect(current.operations["execution-fixture"].result).toEqual({
			outcome: "accepted",
			status: "completed",
		});
		expect(current.operations["execution-pending"].state).toBe("prepared");
		expect(current.operations["execution-pending"]).not.toHaveProperty(
			"result",
		);
		const reopened = await FileRuntimeStore.open(env.hostPath);
		await (await load(env))?.apply(reopened);
		expect(JSON.parse(await readFile(env.hostPath, "utf8"))).toEqual(saved);
		expect(await env.driver.sideEffectCount()).toBe(1);
	});

	it("rejects unsigned, tampered or differently signed artifacts before Store mutation", async () => {
		for (const kind of ["bare", "payload", "key", "extra"]) {
			const env = await fixture();
			if (kind === "bare")
				await writeFile(env.manifestPath, JSON.stringify(env.manifest));
			if (kind === "payload") {
				const envelope = JSON.parse(await readFile(env.manifestPath, "utf8"));
				envelope.payload = Buffer.from(
					JSON.stringify({
						...env.manifest,
						principal: { kind: "user", id: "other-user" },
					}),
				).toString("base64url");
				await writeFile(env.manifestPath, JSON.stringify(envelope));
			}
			if (kind === "key")
				await writeFile(
					env.publicKeyPath,
					generateKeyPairSync("ed25519").publicKey.export({
						type: "spki",
						format: "pem",
					}),
				);
			if (kind === "extra")
				await writeSignedLegacyManifest(env.manifestPath, {
					...env.manifest,
					input: { text: legacyBodySentinel },
				});
			await expect(load(env)).rejects.toThrow(
				/^RUNTIME_LEGACY_MIGRATION_INVALID$/,
			);
			expect(JSON.parse(await readFile(env.hostPath, "utf8"))).toEqual(
				env.before,
			);
		}
	});

	it("binds issuer, audience, key, every readiness field and supported principal type", async () => {
		const patches = [
			{ issuer: "another-platform" },
			{ audience: "runtime_host" },
			{ keyId: "another-key" },
			{ principal: { kind: "application", id: "user-fixture" } },
			...Object.entries({
				workerId: "other-worker",
				agentId: "other-agent",
				workloadRevision: 8,
				fence: 4,
				imageDigest: `sha256:${"c".repeat(64)}`,
			}).map(([key, value]) => ({
				deployment: { ...migrationBinding, [key]: value },
			})),
		];
		for (const patch of patches) {
			const env = await fixture();
			await writeSignedLegacyManifest(env.manifestPath, {
				...env.manifest,
				...patch,
			});
			await expect(load(env)).rejects.toThrow(
				/^RUNTIME_LEGACY_MIGRATION_INVALID$/,
			);
			expect(JSON.parse(await readFile(env.hostPath, "utf8"))).toEqual(
				env.before,
			);
		}
	});

	it("requires the complete exact old submit set and original object bindings before the durable update", async () => {
		for (const kind of [
			"missing",
			"extra",
			"digest",
			"turn",
			"host",
			"conversation",
			"generation",
		]) {
			const env = await fixture();
			const manifest = structuredClone(env.manifest);
			const first = manifest.executions[0];
			if (!first) throw new Error("Missing execution fixture");
			if (kind === "missing") manifest.executions.pop();
			if (kind === "extra")
				manifest.executions.push({
					...first,
					executionId: "unrelated",
					migrationRecordId: "unrelated-record",
				});
			if (kind === "digest") first.originalOperationDigest = "c".repeat(43);
			if (kind === "turn") first.turnId = "other-turn";
			if (kind === "host") manifest.hostSessionRef = "other-host";
			if (kind === "conversation")
				manifest.conversationId = "other-conversation";
			if (kind === "generation") manifest.sessionGeneration = 2;
			await writeSignedLegacyManifest(env.manifestPath, manifest);
			const proof = await load(env);
			if (!proof)
				throw new Error("Expected authenticated but mismatched evidence");
			await expect(proof.apply(env.store)).rejects.toThrow(
				/^RUNTIME_LEGACY_MIGRATION_INVALID$/,
			);
			expect(JSON.parse(await readFile(env.hostPath, "utf8"))).toEqual(
				env.before,
			);
		}
	});

	it("rejects duplicate execution or Platform migration provenance and replacement contents on replay", async () => {
		const env = await fixture();
		for (const field of ["executionId", "migrationRecordId"] as const) {
			const manifest = structuredClone(env.manifest);
			const [first, second] = manifest.executions;
			if (!first || !second) throw new Error("Missing execution fixtures");
			second[field] = first[field];
			await writeSignedLegacyManifest(env.manifestPath, manifest);
			await expect(load(env)).rejects.toThrow(
				/^RUNTIME_LEGACY_MIGRATION_INVALID$/,
			);
		}
		await writeSignedLegacyManifest(env.manifestPath, env.manifest);
		await (await load(env))?.apply(env.store);
		const beforeReplay = await readFile(env.hostPath, "utf8");
		await writeSignedLegacyManifest(env.manifestPath, {
			...env.manifest,
			executions: env.manifest.executions.map((item) => ({
				...item,
				producerRevision: "changed-producer",
			})),
		});
		const replacement = await load(env);
		if (!replacement) throw new Error("Expected signed replacement");
		await expect(replacement.apply(env.store)).rejects.toThrow(
			/^RUNTIME_LEGACY_MIGRATION_INVALID$/,
		);
		expect(await readFile(env.hostPath, "utf8")).toBe(beforeReplay);
	});

	it("requires independent mounted trust files and refuses unsafe paths, modes and oversize input", async () => {
		const env = await fixture();
		const dataManifest = join(env.dataDirectory, "untrusted.json");
		await copyFile(env.manifestPath, dataManifest);
		await expect(
			load(env, {
				...env.environment,
				AGENT_INFRA_RUNTIME_LEGACY_MIGRATION_FILE: dataManifest,
			}),
		).rejects.toThrow(/^RUNTIME_LEGACY_MIGRATION_INVALID$/);
		const linked = `${env.manifestPath}.link`;
		await symlink(env.manifestPath, linked);
		await expect(
			load(env, {
				...env.environment,
				AGENT_INFRA_RUNTIME_LEGACY_MIGRATION_FILE: linked,
			}),
		).rejects.toThrow(/^RUNTIME_LEGACY_MIGRATION_INVALID$/);
		const hardlink = `${env.manifestPath}.hardlink`;
		await link(env.manifestPath, hardlink);
		await expect(
			load(env, {
				...env.environment,
				AGENT_INFRA_RUNTIME_LEGACY_MIGRATION_FILE: hardlink,
			}),
		).rejects.toThrow(/^RUNTIME_LEGACY_MIGRATION_INVALID$/);
		await chmod(env.publicKeyPath, 0o666);
		await expect(load(env)).rejects.toThrow(
			/^RUNTIME_LEGACY_MIGRATION_INVALID$/,
		);
		await chmod(env.publicKeyPath, 0o600);
		await writeFile(env.manifestPath, "x".repeat(256_001));
		await expect(load(env)).rejects.toThrow(
			/^RUNTIME_LEGACY_MIGRATION_INVALID$/,
		);
		expect(JSON.parse(await readFile(env.hostPath, "utf8"))).toEqual(
			env.before,
		);
	});

	it("is absent by default and requires all trust configuration without a fallback verifier", async () => {
		const env = await fixture();
		expect(
			await readRuntimeLegacyMigrationV1({
				environment: {},
				expectedIssuer: "platform-fixture",
				binding: undefined,
				dataDirectory: env.dataDirectory,
			}),
		).toBeUndefined();
		await expect(
			readRuntimeLegacyMigrationV1({
				environment: env.environment,
				expectedIssuer: "platform-fixture",
				binding: undefined,
				dataDirectory: env.dataDirectory,
			}),
		).rejects.toThrow(/^RUNTIME_LEGACY_MIGRATION_INVALID$/);
		await expect(
			load(env, {
				...env.environment,
				AGENT_INFRA_RUNTIME_LEGACY_MIGRATION_PUBLIC_KEY_FILE: "",
			}),
		).rejects.toThrow(/^RUNTIME_LEGACY_MIGRATION_INVALID$/);
	});
});
