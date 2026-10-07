import { generateKeyPairSync } from "node:crypto";
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CodexRuntimeDriverOptions,
	FakeRuntimeDriver,
} from "@agent-infra/agent-runtime";
import { connectionConsumerProfileFingerprintV1 } from "@agent-infra/contracts/connection-consumer-profile";
import { RuntimeSubmitTurnRequestV4Schema } from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requestDigest } from "../../../packages/agent-runtime/src/file-runtime-store.js";
import {
	runtimeV2Keys,
	signV3Fixture,
	submitV3Fixture,
} from "../../../packages/agent-runtime/src/grant-v2-fixture.test-support.js";
import {
	closeStandardMcpFixtures,
	reference,
	standardMcpFixture,
	token,
} from "../../../packages/agent-runtime/src/standard-mcp.fixture.js";
import { createWorkerRuntimeGrantSignerV4 } from "../../platform-worker/src/runtime-grant-signer-v4.js";
import { writeStandardMcpExport } from "./standard-mcp-installation.test-support.js";

const runtimeAssemblyMocks = vi.hoisted(() => ({
	openCodexRuntimeDriver: vi.fn(),
	verifyCodexPilotInstallation: vi.fn(),
	assertRuntimeProcessProtection: vi.fn(),
	readCodexInstalledSkillDeployment: vi.fn(),
}));

vi.mock("./installed-skill.js", () => ({
	readCodexInstalledSkillDeployment:
		runtimeAssemblyMocks.readCodexInstalledSkillDeployment,
}));

vi.mock("./process-protection.js", () => ({
	assertRuntimeProcessProtection:
		runtimeAssemblyMocks.assertRuntimeProcessProtection,
}));

// Assembly tests exercise real private file reception, not Linux acceptance.
vi.mock("./standard-mcp-protection.js", () => ({
	assertStandardMcpProcessProtection: vi.fn(),
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
	assembleRuntimeHost,
	closeRuntimeHost,
	createRuntimeHostApp,
	startRuntimeHost,
} from "./index.js";

import {
	createLegacyMigrationFixture,
	writeSignedLegacyManifest,
} from "./legacy-migration.test-support.js";

const directories: string[] = [];
const { publicKey, privateKey } = generateKeyPairSync("ed25519");

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
	runtimeAssemblyMocks.readCodexInstalledSkillDeployment.mockReset();
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
	await closeStandardMcpFixtures();
});

describe("RuntimeHost environment assembly", () => {
	async function retainSignedControl(failure: string) {
		const values = await environment();
		values.AGENT_INFRA_RUNTIME_DATA_DIR = await realpath(
			values.AGENT_INFRA_RUNTIME_DATA_DIR,
		);
		const directory = values.AGENT_INFRA_RUNTIME_DATA_DIR;
		const profile = {
			schemaVersion: 1 as const,
			publicOrigin: "https://connection.example.test",
			mcpPath: "/mcp",
			consumerId: "platform",
			audience: "fixture-resource",
			egressProfile: { ref: "fixture-egress", revision: "r1" },
		};
		const approval = {
			schemaVersion: 1,
			configFingerprint: connectionConsumerProfileFingerprintV1(profile),
			source: { ref: "fixture-deployment", revision: "r1" },
			egressEnforced: true,
		};
		const file = join(directory, "consumer.json");
		await writeFile(file, JSON.stringify({ profile, approval }));
		const configured = {
			...values,
			AGENT_INFRA_RUNTIME_DRIVER: "codex",
			AGENT_INFRA_RUNTIME_AGENT_ID: "agent-fixture",
			AGENT_INFRA_RUNTIME_GRANT_KEY_ID: "fixture",
			AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY: runtimeV2Keys.publicKey
				.export({ type: "spki", format: "pem" })
				.toString(),
			AGENT_INFRA_RUNTIME_GRANT_ISSUER: "platform-fixture",
			AGENT_INFRA_RUNTIME_WORKER_ID: "worker-fixture",
			AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_FILE: file,
			AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_REVISION: JSON.stringify([
				approval.configFingerprint,
				approval.source.ref,
				approval.source.revision,
			]),
			AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_PRIMARY:
				"synthetic-model-credential",
			AGENT_INFRA_RUNTIME_MODEL_CONFIG: JSON.stringify({
				schemaVersion: 2,
				configVersion: "fixture-model-config",
				defaultModelOptionId: "fixture-option",
				defaultReasoningLevel: "high",
				modelOptions: [
					{
						modelOptionId: "fixture-option",
						model: "fixture-model",
						reasoningLevels: ["high"],
						endpoint: "https://models.example.test",
						credentialEnvironmentVariable:
							"AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_PRIMARY",
					},
				],
			}),
		};
		runtimeAssemblyMocks.verifyCodexPilotInstallation.mockResolvedValue({
			protocolVersion: 2,
			codexVersion: "synthetic-codex",
			upstreamTag: "synthetic-tag",
			upstreamCommit: "synthetic-commit",
			schemaSha256: "synthetic-schema",
		});
		let selected: CodexRuntimeDriverOptions | undefined;
		runtimeAssemblyMocks.openCodexRuntimeDriver.mockImplementation(
			async (options: CodexRuntimeDriverOptions) => {
				selected = options;
				return FakeRuntimeDriver.open(join(directory, "control-driver.json"));
			},
		);
		const unsigned = {
			...submitV3Fixture(),
			selection: {
				schemaVersion: 1 as const,
				modelOptionId: "fixture-option",
				reasoningLevel: "high" as const,
			},
		};
		const submitted = signV3Fixture(unsigned, "turn.submit", {
			now: Date.now(),
		});
		const before = await assembleRuntimeHost(configured);
		if (!before.verifyGrantV2) throw new Error("Missing fixture verifier");
		const accepted = await before.host.submitTurnV3(
			submitted,
			before.verifyGrantV2(submitted.grant),
		);
		const original = JSON.parse(
			await readFile(join(directory, "host.json"), "utf8"),
		).sessions[accepted.hostSessionRef];
		await before.close();
		await mkdir(
			join(
				directory,
				"codex-driver.json.native",
				"conversations",
				"standard-mcp-input",
			),
			{ recursive: true, mode: 0o755 },
		);
		const restored = await assembleRuntimeHost({
			...configured,
			...(failure === "missing export"
				? {
						AGENT_INFRA_RUNTIME_CONNECTION_INSTALLATION_REVISION:
							JSON.stringify(["fixture-protected-supply", "r1"]),
					}
				: {}),
		});
		try {
			expect(selected?.standardConnectionClient).toBeDefined();
			await expect(
				selected?.standardConnectionClient?.resolveInput(
					{
						agentId: unsigned.agentId,
						conversationId: unsigned.conversationId,
						executionId: unsigned.executionId,
						sessionGeneration: unsigned.sessionGeneration,
					},
					new AbortController().signal,
				),
			).rejects.toMatchObject({
				code: "CONNECTION_STANDARD_CLIENT_UNAVAILABLE",
			});
			if (!restored.verifyGrantV2) throw new Error("Missing fixture verifier");
			const { input: _input, selection: _selection, ...base } = unsigned;
			const query = signV3Fixture(
				{
					...base,
					hostSessionRef: accepted.hostSessionRef,
					originalOperationDigest: requestDigest({
						kind: "submit-turn",
						agentId: unsigned.agentId,
						conversationId: unsigned.conversationId,
						executionId: unsigned.executionId,
						turnId: unsigned.turnId,
						sessionGeneration: unsigned.sessionGeneration,
						input: unsigned.input,
						selection: unsigned.selection,
					}),
				},
				"session.status",
				{ now: Date.now(), purpose: "control", reason: "recovery" },
			);
			await expect(
				restored.host.recoverStatusV3(
					query,
					restored.verifyGrantV2(query.grant),
				),
			).resolves.toMatchObject({ outcome: "found", status: "unknown" });
			const stop = signV3Fixture(
				{
					...base,
					hostSessionRef: accepted.hostSessionRef,
					operation: {
						kind: "stop" as const,
						id: "control-stop",
						deliveryFence: 2,
						executionDeliveryFence: 1,
					},
				},
				"turn.stop",
				{
					now: Date.now(),
					purpose: "control",
					reason: "stop",
					claims: { controlRecordId: "control-stop-fixture" },
				},
			);
			await expect(
				restored.host.stopV3(stop, restored.verifyGrantV2(stop.grant)),
			).resolves.toMatchObject({
				result: { outcome: "accepted", status: "idle" },
			});
			const saved = JSON.parse(
				await readFile(join(directory, "host.json"), "utf8"),
			);
			expect(saved.sessions[accepted.hostSessionRef].nativeSessionRef).toBe(
				original.nativeSessionRef,
			);
			expect(original.operations[unsigned.executionId].requestDigest).toBe(
				query.originalOperationDigest,
			);
			expect(
				saved.sessions[accepted.hostSessionRef].operations[
					unsigned.executionId
				],
			).toMatchObject({
				requestDigest: original.operations[unsigned.executionId].requestDigest,
				command: original.operations[unsigned.executionId].command,
			});
		} finally {
			await restored.close();
		}
	}
	it.each(["invalid namespace", "missing export"])(
		"retains signed control and original facts after %s",
		retainSignedControl,
	);

	it("receives the selected private export before the actual Driver assembly", async () => {
		const values = await environment();
		values.AGENT_INFRA_RUNTIME_DATA_DIR = await realpath(
			values.AGENT_INFRA_RUNTIME_DATA_DIR,
		);
		const fixture = await standardMcpFixture();
		const source = await writeStandardMcpExport(
			values.AGENT_INFRA_RUNTIME_DATA_DIR,
			fixture.target,
			[fixture.input],
		);
		const approval = {
			schemaVersion: 1,
			configFingerprint: fixture.target.configFingerprint,
			source: fixture.target.source,
			egressEnforced: true,
		};
		const file = join(values.AGENT_INFRA_RUNTIME_DATA_DIR, "consumer.json");
		await writeFile(
			file,
			JSON.stringify({ profile: fixture.target.profile, approval }),
		);
		let selected: CodexRuntimeDriverOptions | undefined;
		runtimeAssemblyMocks.verifyCodexPilotInstallation.mockResolvedValue({});
		runtimeAssemblyMocks.openCodexRuntimeDriver.mockImplementation(
			async (options: CodexRuntimeDriverOptions) => {
				selected = options;
				// The receiver must already have published the existing reader layout.
				expect(
					await readFile(
						join(
							source.inputDirectory,
							"materials",
							`${source.record.material}.token`,
						),
						"utf8",
					),
				).toBe(token);
				return FakeRuntimeDriver.open(
					join(values.AGENT_INFRA_RUNTIME_DATA_DIR, "fixture-driver.json"),
				);
			},
		);
		const runtime = await assembleRuntimeHost({
			...values,
			AGENT_INFRA_RUNTIME_DRIVER: "codex",
			AGENT_INFRA_RUNTIME_AGENT_ID: reference.agentId,
			AGENT_INFRA_RUNTIME_WORKER_ID: "fixture-worker",
			AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_FILE: file,
			AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_REVISION: JSON.stringify([
				approval.configFingerprint,
				approval.source.ref,
				approval.source.revision,
			]),
			AGENT_INFRA_RUNTIME_CONNECTION_INSTALLATION_REVISION: source.revision,
			AGENT_INFRA_RUNTIME_MODEL_CONFIG: JSON.stringify({
				schemaVersion: 4,
				configVersion: "fixture-v4",
				defaultModelOptionId: "primary",
				defaultReasoningLevel: "high",
				modelOptions: [
					{
						modelOptionId: "primary",
						protocol: "openai-responses-v1",
						authentication: "bearer",
						endpoint: "https://models.example.test/v1",
						model: "fixture-model",
						reasoningLevels: ["high"],
					},
				],
			}),
		});
		try {
			expect(selected?.standardConnectionClient?.target).toEqual(
				fixture.target,
			);
		} finally {
			await runtime.close();
		}
	});
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
				expect(runtime.verifyGrantV4).toBeUndefined();
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
			const address = server.address();
			if (!address || typeof address === "string")
				throw new Error("Missing test port");
			const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
			expect(response.status).toBe(200);
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

	it("keeps service token and signed Worker authorization independent over in-cluster HTTP", async () => {
		const runtime = await assembleRuntimeHost({
			...(await environment()),
			AGENT_INFRA_RUNTIME_WORKER_ID: "worker-fixture",
			AGENT_INFRA_RUNTIME_GRANT_KEY_ID: "fixture",
			AGENT_INFRA_RUNTIME_GRANT_ISSUER: "platform-fixture",
			AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY: runtimeV2Keys.publicKey
				.export({ type: "spki", format: "pem" })
				.toString(),
		});
		const ready = Promise.withResolvers<string>();
		const server = startRuntimeHost({
			...runtime,
			port: 0,
			log: ready.resolve,
		});
		await ready.promise;
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("Missing test port");
		const post = (
			workerId: string,
			now = Date.now(),
			token = "synthetic-token",
		) =>
			fetch(`http://127.0.0.1:${address.port}/internal/runtime/v3/turns`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
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
			try {
				expect(
					(await post("worker-fixture", Date.now(), "invalid-token")).status,
				).toBe(401);
				expect((await post("foreign-worker")).status).toBe(403);
				expect((await post("worker-fixture", Date.now() - 60_000)).status).toBe(
					403,
				);
				expect((await post("worker-fixture")).status).toBe(200);
			} finally {
				await runtime.close();
			}
			expect((await post("worker-fixture")).status).toBe(403);
		} finally {
			await closeRuntimeHost(server, async () => {});
		}
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
	it.each(["absent", "available", "invalid"] as const)(
		"assembles V4 with a routing snapshot and installed input=%s",
		async (installed) => {
			const values = await environment();
			values.AGENT_INFRA_RUNTIME_DATA_DIR = await realpath(
				values.AGENT_INFRA_RUNTIME_DATA_DIR,
			);
			if (installed !== "absent")
				await mkdir(
					join(
						values.AGENT_INFRA_RUNTIME_DATA_DIR,
						"codex-driver.json.native",
						"conversations",
						"standard-mcp-input",
					),
					{ recursive: true, mode: installed === "invalid" ? 0o755 : 0o700 },
				);
			const profile = {
				schemaVersion: 1 as const,
				publicOrigin: "https://connection.example.test",
				mcpPath: "/mcp",
				consumerId: "platform",
				audience: "fixture-resource",
				egressProfile: { ref: "fixture-egress", revision: "r1" },
			};
			const approval = {
				schemaVersion: 1,
				configFingerprint: connectionConsumerProfileFingerprintV1(profile),
				source: { ref: "fixture-deployment", revision: "r1" },
				egressEnforced: true,
			};
			const file = join(values.AGENT_INFRA_RUNTIME_DATA_DIR, "consumer.json");
			await writeFile(file, JSON.stringify({ profile, approval }));
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
						join(values.AGENT_INFRA_RUNTIME_DATA_DIR, "v4-driver.json"),
					);
				},
			);
			const runtime = await assembleRuntimeHost({
				...values,
				AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_FILE: file,
				AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_REVISION: JSON.stringify([
					approval.configFingerprint,
					approval.source.ref,
					approval.source.revision,
				]),
				AGENT_INFRA_RUNTIME_DRIVER: "codex",
				AGENT_INFRA_RUNTIME_WORKER_ID: "synthetic-worker",
				AGENT_INFRA_RUNTIME_AGENT_ID: "synthetic-agent",
				AGENT_INFRA_RUNTIME_MODEL_CONFIG: JSON.stringify({
					schemaVersion: 4,
					configVersion: "configuration-4-fingerprint",
					defaultModelOptionId: "model-option-primary",
					defaultReasoningLevel: "high",
					modelOptions: [
						{
							modelOptionId: "model-option-primary",
							protocol: "openai-responses-v1",
							authentication: "bearer",
							endpoint: "https://models.example.test/v1",
							model: "gpt-5.3-codex",
							reasoningLevels: ["high"],
						},
					],
				}),
			});
			try {
				expect(runtime.verifyGrantV4).toBeTypeOf("function");
				expect(runtime.connectionConsumer).toMatchObject({
					status: "available",
					configFingerprint: approval.configFingerprint,
				});
				if (installed !== "absent") {
					expect(openedWith?.standardConnectionClient?.target).toMatchObject({
						status: "available",
						configFingerprint: approval.configFingerprint,
						source: approval.source,
						url: profile.publicOrigin + profile.mcpPath,
					});
					expect(openedWith?.standardConnectionClient?.resolveInput).toBeTypeOf(
						"function",
					);
				} else
					expect(openedWith).not.toHaveProperty("standardConnectionClient");
				if (installed === "invalid") {
					await expect(
						openedWith?.standardConnectionClient?.resolveInput(
							{
								agentId: "synthetic-agent",
								conversationId: "control-conversation",
								executionId: "control-execution",
								sessionGeneration: 1,
							},
							new AbortController().signal,
						),
					).rejects.toMatchObject({
						code: "CONNECTION_STANDARD_CLIENT_UNAVAILABLE",
					});
					expect(
						(await createRuntimeHostApp(runtime).request("/healthz")).status,
					).toBe(200);
				}
				expect(openedWith?.connectionClient).toBeUndefined();
				const invalidGrantRequest = RuntimeSubmitTurnRequestV4Schema.parse({
					schemaVersion: 4,
					requestId: "assembly-request",
					traceId: "assembly-trace",
					principal: { kind: "user", id: "alice" },
					executionSource: "web",
					channelId: "web",
					agentId: "synthetic-agent",
					conversationId: "assembly-conversation",
					executionId: "assembly-execution",
					turnId: "assembly-turn",
					sessionGeneration: 1,
					hostSessionRef: null,
					operation: {
						kind: "execution",
						id: "assembly-execution",
						deliveryFence: 1,
						executionDeliveryFence: 1,
					},
					grant: {
						schemaVersion: 4,
						format: "runtime-execution-jws",
						token: "a.b.c",
					},
					keyBinding: {
						purpose: "personal",
						subjectId: "alice",
						ciphertextRef: "key-1",
						version: 1,
					},
					input: { text: "assembly-input", attachments: [] },
					selection: {
						schemaVersion: 1,
						modelOptionId: "model-option-primary",
						reasoningLevel: "high",
					},
				});
				await expect(
					runtime.verifyGrantV4?.(invalidGrantRequest),
				).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
				const signer = createWorkerRuntimeGrantSignerV4({
					issuer: "synthetic-platform",
					workerId: "synthetic-worker",
					keyId: "synthetic-key",
					privateKey,
				});
				const signed = (request: typeof invalidGrantRequest) => ({
					...request,
					grant: signer.sign(request, "synthetic-authorization"),
				});
				await expect(
					runtime.verifyGrantV4?.(signed(invalidGrantRequest)),
				).resolves.toMatchObject({ claims: { agentId: "synthetic-agent" } });
				await expect(
					runtime.verifyGrantV4?.(
						signed({ ...invalidGrantRequest, agentId: "another-agent" }),
					),
				).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
				expect(openedWith).toMatchObject({
					configVersion: "configuration-4-fingerprint",
					modelOptions: [
						{
							modelOptionId: "model-option-primary",
							endpoint: "https://models.example.test/v1",
							model: "gpt-5.3-codex",
							reasoningLevels: ["high"],
						},
					],
				});
				expect(openedWith?.modelOptions[0]).not.toHaveProperty("credential");
				const action = {
					nativeSessionRef: "synthetic-native-session",
					executionId: "synthetic-execution",
					operationRef: "synthetic-operation",
					attemptRef: "synthetic-attempt",
					runtimeOperationId: "synthetic-runtime-operation",
					kind: "model" as const,
				};
				const revalidate = vi.fn();
				const authorization = vi
					.spyOn(runtime.host, "authorizeExternalAction")
					.mockResolvedValue({ relayKey: "synthetic-relay-key", revalidate });
				const delivered = await openedWith?.authorizeExternalAction?.(action);
				expect(delivered).toEqual({
					relayKey: "synthetic-relay-key",
					revalidate,
				});
				expect(authorization).toHaveBeenCalledWith(action);
			} finally {
				await runtime.close();
			}
		},
	);

	it.each([false, true])(
		"consumes fixed installed Skill deployment before Driver activation, invalid=%s",
		async (invalid) => {
			const values = await environment();
			const configVersion = "installed-skill-config-7";
			const manifestBytes = await readFile(
				new URL(
					"../../../deploy/runtime/skills/workspace-summary.manifest.json",
					import.meta.url,
				),
			);
			const descriptor: NonNullable<
				CodexRuntimeDriverOptions["installedSkill"]
			> = {
				schemaVersion: 1,
				manifestSha256:
					"9bbef33672b700f43a6e700263a51fef1a0d534d44bf9d4940af84006f37c2d0",
				manifest: JSON.parse(manifestBytes.toString()),
				deployment: {
					configVersion,
					imageSourceRevision: "e4c78883b38e3c59ae4a696ab60f78afc649759f",
				},
			};
			const env = {
				...values,
				AGENT_INFRA_RUNTIME_DRIVER: "codex",
				AGENT_INFRA_RUNTIME_INSTALLED_SKILL: "workspace-summary-v1",
				AGENT_INFRA_RUNTIME_WORKER_ID: "fixture-worker",
				AGENT_INFRA_RUNTIME_AGENT_ID: "fixture-agent",
				AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_PRIMARY: "fixture-credential",
				AGENT_INFRA_RUNTIME_MODEL_CONFIG: JSON.stringify({
					schemaVersion: 2,
					configVersion,
					defaultModelOptionId: "primary",
					defaultReasoningLevel: "high",
					modelOptions: [
						{
							modelOptionId: "primary",
							endpoint: "https://models.example.test/v1",
							model: "fixture-model",
							reasoningLevels: ["high"],
							credentialEnvironmentVariable:
								"AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_PRIMARY",
						},
					],
				}),
			};
			if (invalid)
				runtimeAssemblyMocks.readCodexInstalledSkillDeployment.mockRejectedValue(
					new Error("RUNTIME_INSTALLED_SKILL_INVALID"),
				);
			else
				runtimeAssemblyMocks.readCodexInstalledSkillDeployment.mockResolvedValue(
					descriptor,
				);
			runtimeAssemblyMocks.openCodexRuntimeDriver.mockImplementation(
				async (options: CodexRuntimeDriverOptions) => {
					expect(options.installedSkill).toBe(descriptor);
					expect(options.configVersion).toBe(configVersion);
					return FakeRuntimeDriver.open(
						join(values.AGENT_INFRA_RUNTIME_DATA_DIR, "fixture-driver.json"),
					);
				},
			);
			if (invalid) {
				await expect(assembleRuntimeHost(env)).rejects.toThrow(
					/^RUNTIME_INSTALLED_SKILL_INVALID$/,
				);
				expect(
					runtimeAssemblyMocks.openCodexRuntimeDriver,
				).not.toHaveBeenCalled();
				await expect(
					readFile(join(values.AGENT_INFRA_RUNTIME_DATA_DIR, "host.json")),
				).rejects.toMatchObject({ code: "ENOENT" });
			} else {
				const runtime = await assembleRuntimeHost(env);
				await runtime.close();
				expect(
					runtimeAssemblyMocks.openCodexRuntimeDriver,
				).toHaveBeenCalledOnce();
			}
			expect(
				runtimeAssemblyMocks.readCodexInstalledSkillDeployment,
			).toHaveBeenCalledWith(env, configVersion);
			expect(
				runtimeAssemblyMocks.verifyCodexPilotInstallation,
			).not.toHaveBeenCalled();
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
			expect(runtime.verifyGrantV4).toBeUndefined();
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
