import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CodexRuntimeDriverOptions,
	FakeRuntimeDriver,
} from "@agent-infra/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeAssemblyMocks = vi.hoisted(() => ({
	openCodexRuntimeDriver: vi.fn(),
	verifyCodexPilotInstallation: vi.fn(),
	assertRuntimeProcessProtection: vi.fn(),
}));

vi.mock("./process-protection.js", () => ({
	assertRuntimeProcessProtection:
		runtimeAssemblyMocks.assertRuntimeProcessProtection,
}));

vi.mock("@agent-infra/agent-runtime", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@agent-infra/agent-runtime")>();
	class MockCodexRuntimeDriver extends actual.CodexRuntimeDriver {}
	Object.defineProperty(MockCodexRuntimeDriver, "open", {
		value: runtimeAssemblyMocks.openCodexRuntimeDriver,
	});
	return {
		...actual,
		CodexRuntimeDriver: MockCodexRuntimeDriver,
		verifyCodexPilotInstallation:
			runtimeAssemblyMocks.verifyCodexPilotInstallation,
	};
});

import {
	signV3Fixture,
	submitV3Fixture,
} from "../../../packages/agent-runtime/src/grant-v2-fixture.test-support.js";
import {
	assembleRuntimeHost,
	createRuntimeHostApp,
	startRuntimeHost,
} from "./index.js";
import { createLegacyMigrationFixture } from "./legacy-migration.test-support.js";

const directories: string[] = [];
const { publicKey } = generateKeyPairSync("ed25519");

async function environment() {
	const directory = await mkdtemp(join(tmpdir(), "runtime-assembly-"));
	directories.push(directory);
	return {
		AGENT_INFRA_RUNTIME_DRIVER: "fake",
		AGENT_INFRA_RUNTIME_WORKER_ID: "synthetic-worker",
		AGENT_INFRA_RUNTIME_DATA_DIR: directory,
		AGENT_INFRA_RUNTIME_GRANT_KEY_ID: "synthetic-key",
		AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY: publicKey
			.export({ type: "spki", format: "pem" })
			.toString(),
		AGENT_INFRA_RUNTIME_GRANT_ISSUER: "synthetic-platform",
		AGENT_INFRA_RUNTIME_SERVICE_TOKEN: "synthetic-token",
	};
}

afterEach(async () => {
	runtimeAssemblyMocks.openCodexRuntimeDriver.mockReset();
	runtimeAssemblyMocks.verifyCodexPilotInstallation.mockReset();
	runtimeAssemblyMocks.assertRuntimeProcessProtection.mockReset();
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("RuntimeHost environment assembly", () => {
	it("checks process protection before reading private deployment inputs even through programmatic assembly", async () => {
		const configuration = await environment();
		configuration.AGENT_INFRA_RUNTIME_DRIVER = "codex";
		const readPrivateInput = vi.fn(() => "synthetic-private-value");
		Object.defineProperty(configuration, "AGENT_INFRA_RUNTIME_SERVICE_TOKEN", {
			get: readPrivateInput,
		});
		runtimeAssemblyMocks.assertRuntimeProcessProtection.mockImplementationOnce(
			() => {
				throw new Error("RUNTIME_PROCESS_PROTECTION_INVALID");
			},
		);
		await expect(assembleRuntimeHost(configuration)).rejects.toThrow(
			"RUNTIME_PROCESS_PROTECTION_INVALID",
		);
		expect(readPrivateInput).not.toHaveBeenCalled();
		expect(runtimeAssemblyMocks.openCodexRuntimeDriver).not.toHaveBeenCalled();
	});
	it("consumes a signed deployment migration before serving and retains the original native Session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "runtime-legacy-assembly-"));
		directories.push(directory);
		const fixture = await createLegacyMigrationFixture(directory, false);
		const runtime = await assembleRuntimeHost(fixture.environment);
		try {
			const saved = JSON.parse(await readFile(fixture.hostPath, "utf8"));
			const current = saved.sessions[fixture.manifest.hostSessionRef];
			const original = fixture.before.sessions[fixture.manifest.hostSessionRef];
			expect(current.nativeSessionRef).toBe(original.nativeSessionRef);
			expect(current.operations).toEqual(original.operations);
			expect(current.authority.principal).toEqual(fixture.manifest.principal);
			expect(current.executionAuthorities).toEqual({});
			const { input: _input, ...base } = submitV3Fixture();
			const execution = fixture.manifest.executions[0];
			if (!execution) throw new Error("Missing legacy execution");
			const recovery = signV3Fixture(
				{
					...base,
					hostSessionRef: fixture.manifest.hostSessionRef,
					originalOperationDigest: execution.originalOperationDigest,
				},
				"session.status",
				{ now: Date.now(), purpose: "control", reason: "recovery" },
			);
			await expect(
				runtime.host.recoverStatusV3(
					recovery,
					runtime.verifyGrantV2(recovery.grant),
				),
			).resolves.toMatchObject({ outcome: "found", status: "completed" });
			const wrongPrincipal = signV3Fixture(
				{
					...base,
					principal: { kind: "user" as const, id: "another-user" },
					hostSessionRef: fixture.manifest.hostSessionRef,
					originalOperationDigest: execution.originalOperationDigest,
				},
				"session.status",
				{ now: Date.now(), purpose: "control", reason: "recovery" },
			);
			await expect(
				runtime.host.recoverStatusV3(
					wrongPrincipal,
					runtime.verifyGrantV2(wrongPrincipal.grant),
				),
			).rejects.toThrow();
			expect(await fixture.driver.sideEffectCount()).toBe(1);
			expect(
				(
					await createRuntimeHostApp(runtime).request(
						"/internal/runtime/v3/migrate",
						{
							method: "POST",
							headers: {
								authorization: "Bearer fixture-service-token",
								"content-type": "application/json",
							},
							body: JSON.stringify(fixture.manifest),
						},
					)
				).status,
			).toBe(404);
		} finally {
			await runtime.close();
		}
		const reopened = await assembleRuntimeHost(fixture.environment);
		await reopened.close();
		expect(
			JSON.parse(await readFile(fixture.hostPath, "utf8")).sessions[
				fixture.manifest.hostSessionRef
			].operations,
		).toEqual(
			fixture.before.sessions[fixture.manifest.hostSessionRef].operations,
		);
	});

	it("keeps an unproven old Session fail closed when migration configuration is absent", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "runtime-unproven-assembly-"),
		);
		directories.push(directory);
		const fixture = await createLegacyMigrationFixture(directory, false);
		const {
			AGENT_INFRA_RUNTIME_LEGACY_MIGRATION_FILE: _manifest,
			AGENT_INFRA_RUNTIME_LEGACY_MIGRATION_PUBLIC_KEY_FILE: _keyFile,
			AGENT_INFRA_RUNTIME_LEGACY_MIGRATION_KEY_ID: _keyId,
			...configuration
		} = fixture.environment;
		const runtime = await assembleRuntimeHost(configuration);
		try {
			const { input: _input, ...base } = submitV3Fixture();
			const execution = fixture.manifest.executions[0];
			if (!execution) throw new Error("Missing legacy execution");
			const recovery = signV3Fixture(
				{
					...base,
					hostSessionRef: fixture.manifest.hostSessionRef,
					originalOperationDigest: execution.originalOperationDigest,
				},
				"session.status",
				{ now: Date.now(), purpose: "control", reason: "recovery" },
			);
			await expect(
				runtime.host.recoverStatusV3(
					recovery,
					runtime.verifyGrantV2(recovery.grant),
				),
			).rejects.toThrow();
			expect(
				JSON.parse(await readFile(fixture.hostPath, "utf8")).sessions[
					fixture.manifest.hostSessionRef
				],
			).not.toHaveProperty("authority");
			expect(await fixture.driver.sideEffectCount()).toBe(1);
		} finally {
			await runtime.close();
		}
	});

	it("rejects invalid signed migration before Driver or listener activation", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "runtime-invalid-migration-"),
		);
		directories.push(directory);
		const fixture = await createLegacyMigrationFixture(directory, false);
		await writeFile(fixture.manifestPath, JSON.stringify(fixture.manifest));
		await expect(assembleRuntimeHost(fixture.environment)).rejects.toThrow(
			/^RUNTIME_LEGACY_MIGRATION_INVALID$/,
		);
		expect(JSON.parse(await readFile(fixture.hostPath, "utf8"))).toEqual(
			fixture.before,
		);
		expect(await fixture.driver.sideEffectCount()).toBe(1);
	});

	it.each([
		"claude",
		"pi",
		...(process.env.OPENCODE_EXECUTABLE ? ["acp"] : []),
	])(
		"assembles the fixed %s Driver with per-option V3 configuration and closes it",
		async (driver) => {
			const runtime = await assembleRuntimeHost({
				...(await environment()),
				AGENT_INFRA_RUNTIME_DRIVER: driver,
				AGENT_INFRA_OPENCODE_EXECUTABLE: process.env.OPENCODE_EXECUTABLE,
				AGENT_INFRA_RUNTIME_AGENT_ID: "synthetic-agent",
				AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_PRIMARY: "synthetic-credential",
				AGENT_INFRA_RUNTIME_MODEL_CONFIG: JSON.stringify({
					schemaVersion: 3,
					configVersion: "claude-active-17",
					defaultModelOptionId: "primary",
					defaultReasoningLevel: "high",
					modelOptions: [
						{
							modelOptionId: "primary",
							protocol: "anthropic-messages-v1",
							authentication: "bearer",
							model: "claude-opus-5",
							endpoint: "https://models.example.test",
							reasoningLevels: ["high"],
							credentialEnvironmentVariable:
								"AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_PRIMARY",
						},
					],
				}),
			});
			try {
				expect(runtime.configVersion).toBe("claude-active-17");
				expect(
					(await createRuntimeHostApp(runtime).request("/healthz")).status,
				).toBe(200);
				expect(
					runtimeAssemblyMocks.openCodexRuntimeDriver,
				).not.toHaveBeenCalled();
			} finally {
				await runtime.close();
			}
		},
	);
	it("reports the consumed configuration revision in readiness metadata", async () => {
		const runtime = await assembleRuntimeHost(await environment());
		const ready = Promise.withResolvers<string>();
		const server = startRuntimeHost({
			...runtime,
			port: 0,
			configVersion: "active-revision-17",
			log: ready.resolve,
		});
		try {
			expect(JSON.parse(await ready.promise)).toMatchObject({
				status: "ready",
				configVersion: "active-revision-17",
			});
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			await runtime.close();
		}
	});

	it("keeps Fake independently usable without Codex model configuration", async () => {
		const runtime = await assembleRuntimeHost(await environment());
		const response = await createRuntimeHostApp(runtime).request("/healthz");
		expect(response.status).toBe(200);
		await runtime.close();
	});

	it.each([false, true])(
		"passes configuration without mutating PATH, failure=%s",
		async (failure) => {
			const values = await environment();
			const dataDirectory = values.AGENT_INFRA_RUNTIME_DATA_DIR;
			const originalPath = process.env.PATH;
			let openedWith: CodexRuntimeDriverOptions | undefined;
			runtimeAssemblyMocks.verifyCodexPilotInstallation.mockResolvedValue({
				protocolVersion: 2,
				codexVersion: "synthetic-codex",
				upstreamTag: "synthetic-tag",
				upstreamCommit: "synthetic-commit",
				schemaSha256: "synthetic-schema-sha256",
			});
			runtimeAssemblyMocks.openCodexRuntimeDriver.mockImplementation(
				async (options: CodexRuntimeDriverOptions) => {
					openedWith = options;
					expect(process.env.PATH).toBe(originalPath);
					if (failure) throw new Error("synthetic driver open failure");
					return FakeRuntimeDriver.open(
						join(dataDirectory, "codex-assembly-test.json"),
					);
				},
			);
			let runtime: Awaited<ReturnType<typeof assembleRuntimeHost>> | undefined;
			try {
				const assembling = assembleRuntimeHost({
					...values,
					AGENT_INFRA_RUNTIME_DRIVER: "codex",
					AGENT_INFRA_RUNTIME_AGENT_ID: "synthetic-agent",
					AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_PRIMARY: "synthetic-credential",
					AGENT_INFRA_RUNTIME_MODEL_CONFIG: JSON.stringify({
						schemaVersion: 2,
						configVersion: "active-revision-17",
						defaultModelOptionId: "model-option-primary",
						defaultReasoningLevel: "high",
						modelOptions: [
							{
								modelOptionId: "model-option-primary",
								endpoint: "https://models.example.test/v1",
								model: "gpt-5.3-codex",
								reasoningLevels: ["high"],
								credentialEnvironmentVariable:
									"AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_PRIMARY",
							},
						],
					}),
				});
				if (failure)
					await expect(assembling).rejects.toThrow(
						"synthetic driver open failure",
					);
				else runtime = await assembling;
				expect(process.env.PATH).toBe(originalPath);
				expect(openedWith).toMatchObject({
					path: join(dataDirectory, "codex-driver.json"),
					configVersion: "active-revision-17",
					launchPath: "/opt/codex/bin:/usr/local/bin:/usr/bin:/bin",
					authorizeExternalAction: expect.any(Function),
				});
			} finally {
				await runtime?.close();
				if (originalPath === undefined) {
					delete process.env.PATH;
				} else {
					process.env.PATH = originalPath;
				}
			}
		},
	);

	it.each([
		{ AGENT_INFRA_RUNTIME_DRIVER: "plugin" },
		{ AGENT_INFRA_RUNTIME_WORKER_ID: "" },
		{ AGENT_INFRA_RUNTIME_DATA_DIR: "relative" },
		{ AGENT_INFRA_RUNTIME_DATA_DIR: "/" },
		{ AGENT_INFRA_RUNTIME_SERVICE_TOKEN: "" },
		{ AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY: "synthetic-invalid-key" },
		{ PORT: "synthetic-private-value" },
		{ AGENT_INFRA_RUNTIME_DRIVER: "codex" },
	])(
		"rejects invalid deployment assembly before opening a listener",
		async (patch) => {
			await expect(
				assembleRuntimeHost({ ...(await environment()), ...patch }),
			).rejects.toThrow(/^RUNTIME_CONFIGURATION_INVALID$/);
		},
	);
});
