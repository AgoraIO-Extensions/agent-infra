import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CodexRuntimeDriverOptions,
	FakeRuntimeDriver,
} from "@agent-infra/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	runtimeV2Keys,
	signV3Fixture,
	submitV3Fixture,
} from "../../../packages/agent-runtime/src/grant-v2-fixture.test-support.js";

const runtimeAssemblyMocks = vi.hoisted(() => ({
	openCodexRuntimeDriver: vi.fn(),
	verifyCodexPilotInstallation: vi.fn(),
	openPiRuntime: vi.fn(),
	openOpenCodeRuntime: vi.fn(),
	openClaudeRuntimeDriver: vi.fn(),
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
	const MockClaudeRuntimeDriver = {
		open: (...args: Parameters<typeof actual.ClaudeRuntimeDriver.open>) =>
			runtimeAssemblyMocks.openClaudeRuntimeDriver.getMockImplementation()
				? runtimeAssemblyMocks.openClaudeRuntimeDriver(...args)
				: actual.ClaudeRuntimeDriver.open(...args),
	};
	return {
		...actual,
		CodexRuntimeDriver: MockCodexRuntimeDriver,
		ClaudeRuntimeDriver: MockClaudeRuntimeDriver,
		verifyCodexPilotInstallation:
			runtimeAssemblyMocks.verifyCodexPilotInstallation,
		openPiRuntime: (...args: Parameters<typeof actual.openPiRuntime>) => {
			runtimeAssemblyMocks.openPiRuntime(...args);
			return actual.openPiRuntime(...args);
		},
		openOpenCodeRuntime: (
			...args: Parameters<typeof actual.openOpenCodeRuntime>
		) =>
			runtimeAssemblyMocks.openOpenCodeRuntime.getMockImplementation()
				? runtimeAssemblyMocks.openOpenCodeRuntime(...args)
				: actual.openOpenCodeRuntime(...args),
	};
});

import {
	assembleRuntimeHost,
	createRuntimeHostApp,
	startRuntimeHost,
} from "./index.js";

import {
	createLegacyMigrationFixture,
	writeSignedLegacyManifest,
} from "./legacy-migration.test-support.js";

const directories: string[] = [];
const { publicKey } = generateKeyPairSync("ed25519");

async function environment() {
	const directory = await mkdtemp(join(tmpdir(), "runtime-assembly-"));
	directories.push(directory);
	return {
		AGENT_INFRA_RUNTIME_DRIVER: "fake",
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
	runtimeAssemblyMocks.assertRuntimeProcessProtection.mockReset();
	runtimeAssemblyMocks.openCodexRuntimeDriver.mockReset();
	runtimeAssemblyMocks.verifyCodexPilotInstallation.mockReset();
	runtimeAssemblyMocks.openPiRuntime.mockReset();
	runtimeAssemblyMocks.openOpenCodeRuntime.mockReset();
	runtimeAssemblyMocks.openClaudeRuntimeDriver.mockReset();
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("RuntimeHost environment assembly", () => {
	it.each(["codex", "claude", "acp", "pi", "fake"])(
		"checks %s process protection before reading private deployment inputs even through programmatic assembly",
		async (driver) => {
			const configuration = await environment();
			configuration.AGENT_INFRA_RUNTIME_DRIVER = driver;
			const readPrivateInput = vi.fn(() => "synthetic-private-value");
			Object.defineProperty(
				configuration,
				"AGENT_INFRA_RUNTIME_SERVICE_TOKEN",
				{
					get: readPrivateInput,
				},
			);
			runtimeAssemblyMocks.assertRuntimeProcessProtection.mockImplementationOnce(
				() => {
					throw new Error("RUNTIME_PROCESS_PROTECTION_INVALID");
				},
			);
			await expect(assembleRuntimeHost(configuration)).rejects.toThrow(
				"RUNTIME_PROCESS_PROTECTION_INVALID",
			);
			expect(readPrivateInput).not.toHaveBeenCalled();
			expect(
				runtimeAssemblyMocks.openCodexRuntimeDriver,
			).not.toHaveBeenCalled();
		},
	);
	it("consumes a signed deployment migration before serving and retains the original native Session", async () => {
		const directory = await mkdtemp(join(tmpdir(), "runtime-legacy-assembly-"));
		directories.push(directory);
		const fixture = await createLegacyMigrationFixture(directory, false);
		const runtime = await assembleRuntimeHost(
			fixture.environment,
			fixture.filesystem,
		);
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
			if (!runtime.verifyGrantV2) throw new Error("Missing Grant verifier");
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
		const reopened = await assembleRuntimeHost(
			fixture.environment,
			fixture.filesystem,
		);
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
			if (!runtime.verifyGrantV2) throw new Error("Missing Grant verifier");
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

	it("rejects an incomplete signed migration before normalizing the original journal", async () => {
		const directory = await mkdtemp(
			join(tmpdir(), "runtime-incomplete-migration-"),
		);
		directories.push(directory);
		const fixture = await createLegacyMigrationFixture(directory);
		delete fixture.before.sessionBindings;
		const before = Buffer.from(`${JSON.stringify(fixture.before)}\n`);
		await writeFile(fixture.hostPath, before);
		await writeSignedLegacyManifest(fixture.manifestPath, {
			...fixture.manifest,
			executions: fixture.manifest.executions.slice(0, 1),
		});
		await expect(
			assembleRuntimeHost(fixture.environment, fixture.filesystem),
		).rejects.toThrow(/^RUNTIME_LEGACY_MIGRATION_INVALID$/);
		expect(await readFile(fixture.hostPath)).toEqual(before);
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
				if (driver === "pi") {
					const options = runtimeAssemblyMocks.openPiRuntime.mock.calls[0]?.[0];
					expect(options?.authorizeExternalAction).toBeTypeOf("function");
					await expect(
						options.authorizeExternalAction({
							nativeSessionRef: "unbound",
							executionId: "unbound",
							runtimeOperationId: "unbound",
							operationRef: "unbound",
							attemptRef: "unbound",
							kind: "tool",
						}),
					).rejects.toThrow();
				}
			} finally {
				await runtime.close();
			}
		},
	);
	it.each(["claude", "acp"])(
		"binds the %s external-action callback to the current Host before and after startup",
		async (driver) => {
			const values = await environment();
			const unboundAction = {
				nativeSessionRef: "unbound",
				executionId: "unbound",
				runtimeOperationId: "unbound",
				operationRef: "unbound",
				attemptRef: "unbound",
				kind: "model" as const,
			};
			let authorize:
				| ((action: typeof unboundAction) => Promise<void>)
				| undefined;
			const open =
				driver === "claude"
					? runtimeAssemblyMocks.openClaudeRuntimeDriver
					: runtimeAssemblyMocks.openOpenCodeRuntime;
			open.mockImplementation(async (options) => {
				authorize = options.authorizeExternalAction;
				expect(authorize).toBeTypeOf("function");
				await expect(authorize?.(unboundAction)).rejects.toMatchObject({
					code: "RUNTIME_GRANT_INVALID",
				});
				return FakeRuntimeDriver.open(
					join(values.AGENT_INFRA_RUNTIME_DATA_DIR, "assembly-driver.json"),
				);
			});
			const runtime = await assembleRuntimeHost({
				...values,
				AGENT_INFRA_RUNTIME_DRIVER: driver,
				AGENT_INFRA_RUNTIME_AGENT_ID: "synthetic-agent",
				AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_PRIMARY: "synthetic-credential",
				AGENT_INFRA_RUNTIME_MODEL_CONFIG: JSON.stringify({
					schemaVersion: 3,
					configVersion: "messages-authority-1",
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
				const authorization = vi.spyOn(runtime.host, "authorizeExternalAction");
				await expect(authorize?.(unboundAction)).rejects.toMatchObject({
					code: "RUNTIME_GRANT_INVALID",
				});
				expect(authorization).toHaveBeenCalledWith(unboundAction);
			} finally {
				await runtime.close();
			}
			await expect(authorize?.(unboundAction)).rejects.toMatchObject({
				code: "RUNTIME_GRANT_INVALID",
			});
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

	it("binds V3 HTTP to the deployed Worker and closes its authority", async () => {
		const runtime = await assembleRuntimeHost({
			...(await environment()),
			AGENT_INFRA_RUNTIME_WORKER_ID: "worker-fixture",
			AGENT_INFRA_RUNTIME_GRANT_KEY_ID: "fixture",
			AGENT_INFRA_RUNTIME_GRANT_ISSUER: "platform-fixture",
			AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY: runtimeV2Keys.publicKey
				.export({ type: "spki", format: "pem" })
				.toString(),
		});
		const app = createRuntimeHostApp(runtime);
		const post = (workerId: string, now = Date.now()) =>
			app.request("/internal/runtime/v3/turns", {
				method: "POST",
				headers: {
					authorization: "Bearer synthetic-token",
					"content-type": "application/json",
				},
				body: JSON.stringify(
					signV3Fixture(submitV3Fixture(), "turn.submit", {
						now,
						claims: { workerId },
					}),
				),
			});
		try {
			expect((await post("foreign-worker")).status).toBe(403);
			expect((await post("worker-fixture", Date.now() - 60_000)).status).toBe(
				403,
			);
			expect((await post("worker-fixture")).status).toBe(200);
		} finally {
			await runtime.close();
		}
		expect((await post("worker-fixture")).status).toBe(403);
	});

	it.each([false, true])(
		"passes configuration without mutating PATH, failure=%s",
		async (failure) => {
			const values = await environment();
			const dataDirectory = values.AGENT_INFRA_RUNTIME_DATA_DIR;
			const originalPath = process.env.PATH;
			const unboundAction = {
				nativeSessionRef: "synthetic-unbound-session",
				executionId: "synthetic-execution",
				operationRef: "synthetic-operation",
				attemptRef: "synthetic-attempt",
				runtimeOperationId: "synthetic-runtime-operation",
				kind: "model" as const,
			};
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
					expect(options.authorizeExternalAction).toBeTypeOf("function");
					await expect(
						options.authorizeExternalAction?.(unboundAction),
					).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
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
					AGENT_INFRA_RUNTIME_WORKER_ID: "synthetic-worker",
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
				if (runtime) {
					const authorization = vi.spyOn(
						runtime.host,
						"authorizeExternalAction",
					);
					await expect(
						openedWith?.authorizeExternalAction?.(unboundAction),
					).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
					expect(authorization).toHaveBeenCalledWith(unboundAction);
				}
				expect(process.env.PATH).toBe(originalPath);
				expect(openedWith).toMatchObject({
					path: join(dataDirectory, "codex-driver.json"),
					configVersion: "active-revision-17",
					launchPath: "/opt/codex/bin:/usr/local/bin:/usr/bin:/bin",
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

	it("wires the private Connection client only into Codex", async () => {
		const values = await environment();
		const dataDirectory = values.AGENT_INFRA_RUNTIME_DATA_DIR;
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
				return FakeRuntimeDriver.open(
					join(dataDirectory, "codex-connection-test.json"),
				);
			},
		);
		const profile = {
			profileRef: "connection-fixture",
			serviceRef: "connection-service",
			issuer: "https://connection.example.test",
			resource: "https://connection.example.test/mcp",
		};
		const runtime = await assembleRuntimeHost({
			...values,
			AGENT_INFRA_RUNTIME_DRIVER: "codex",
			AGENT_INFRA_RUNTIME_WORKER_ID: "synthetic-worker",
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
			AGENT_INFRA_RUNTIME_CONNECTION_PROFILE: JSON.stringify(profile),
		});
		try {
			expect(openedWith?.connectionClient).toMatchObject({
				profile,
				authorizedService: {
					serviceRef: profile.serviceRef,
					issuer: profile.issuer,
					resource: profile.resource,
				},
				resolveOriginalClient: expect.any(Function),
				resolveReadOnlyClient: expect.any(Function),
			});
		} finally {
			await runtime.close();
		}
		await expect(
			assembleRuntimeHost({
				...(await environment()),
				AGENT_INFRA_RUNTIME_CONNECTION_PROFILE: JSON.stringify(profile),
			}),
		).rejects.toThrow(/^RUNTIME_CONFIGURATION_INVALID$/);
	});

	it.each([
		{ AGENT_INFRA_RUNTIME_DRIVER: "plugin" },
		{ AGENT_INFRA_RUNTIME_DATA_DIR: "relative" },
		{ AGENT_INFRA_RUNTIME_DATA_DIR: "/" },
		{ AGENT_INFRA_RUNTIME_SERVICE_TOKEN: "" },
		{ AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY: "synthetic-invalid-key" },
		{ PORT: "synthetic-private-value" },
		{ AGENT_INFRA_RUNTIME_DRIVER: "codex" },
		{ AGENT_INFRA_RUNTIME_DRIVER: "codex", AGENT_INFRA_RUNTIME_WORKER_ID: "" },
	])(
		"rejects invalid deployment assembly before opening a listener",
		async (patch) => {
			await expect(
				assembleRuntimeHost({ ...(await environment()), ...patch }),
			).rejects.toThrow(/^RUNTIME_CONFIGURATION_INVALID$/);
		},
	);
});
