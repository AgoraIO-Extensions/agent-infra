import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CodexRuntimeDriverOptions,
	FakeRuntimeDriver,
} from "@agent-infra/agent-runtime";
import {
	RuntimeBusinessGrantClaimsV4Schema,
	RuntimeSubmitTurnRequestV4Schema,
	runtimeRequestSigningPayloadV4,
} from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	runtimeV2Keys,
	signV3Fixture,
	submitV3Fixture,
} from "../../../packages/agent-runtime/src/grant-v2-fixture.test-support.js";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";

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
	runtimeAssemblyMocks.readCodexInstalledSkillDeployment.mockReset();
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
				AGENT_INFRA_RUNTIME_WORKER_ID: "synthetic-worker",
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
		const material = await runtimeTlsFixture();
		const ready = Promise.withResolvers<string>();
		const server = startRuntimeHost({
			...runtime,
			tls: { ...material, serviceDnsNames: ["localhost"] },
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
			const status = await new Promise<number | undefined>(
				(resolve, reject) => {
					httpsGet(
						`https://localhost:${address.port}/healthz`,
						{ ca: material.ca },
						(response) => {
							response.resume();
							response.once("end", () => resolve(response.statusCode));
						},
					).once("error", reject);
				},
			);
			expect(status).toBe(200);
		} finally {
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			await runtime.close();
			await material.cleanup();
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
	it.each([2, 3, 4])(
		"assembles Codex model schema V%s with V4-only business admission",
		async (schemaVersion) => {
			const values = await environment();
			values.AGENT_INFRA_RUNTIME_GRANT_KEY_ID = "fixture";
			values.AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY = runtimeV2Keys.publicKey
				.export({ type: "spki", format: "pem" })
				.toString();
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
				AGENT_INFRA_RUNTIME_DRIVER: "codex",
				AGENT_INFRA_RUNTIME_WORKER_ID: "synthetic-worker",
				AGENT_INFRA_RUNTIME_AGENT_ID: "synthetic-agent",
				...(schemaVersion < 4
					? {
							AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_PRIMARY:
								"synthetic-static-key",
						}
					: {}),
				AGENT_INFRA_RUNTIME_MODEL_CONFIG: JSON.stringify({
					schemaVersion,
					configVersion: "configuration-4-fingerprint",
					defaultModelOptionId: "model-option-primary",
					defaultReasoningLevel: "high",
					modelOptions: [
						{
							modelOptionId: "model-option-primary",
							...(schemaVersion >= 3
								? { protocol: "openai-responses-v1", authentication: "bearer" }
								: {}),
							...(schemaVersion < 4
								? {
										credentialEnvironmentVariable:
											"AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_PRIMARY",
									}
								: {}),
							endpoint: "https://models.example.test/v1",
							model: "gpt-5.3-codex",
							reasoningLevels: ["high"],
						},
					],
				}),
			});
			try {
				expect(runtime.verifyGrantV4).toBeTypeOf("function");
				const legacySubmit = signV3Fixture(
					{ ...submitV3Fixture(), agentId: "synthetic-agent" },
					"turn.submit",
					{
						now: Date.now(),
						claims: {
							issuer: values.AGENT_INFRA_RUNTIME_GRANT_ISSUER,
							workerId: "synthetic-worker",
						},
					},
				);
				const verifiedLegacyGrant = runtime.verifyGrantV2?.(legacySubmit.grant);
				expect(verifiedLegacyGrant).toBeDefined();
				const storePath = join(
					values.AGENT_INFRA_RUNTIME_DATA_DIR,
					"host.json",
				);
				const beforeLegacySubmit = await readFile(storePath, "utf8");
				expect(() =>
					runtime.host.submitTurnV3(legacySubmit, verifiedLegacyGrant),
				).toThrow(
					"Runtime authorization is unavailable or does not authorize this operation",
				);
				expect(await readFile(storePath, "utf8")).toBe(beforeLegacySubmit);
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
				for (const targetAgent of ["synthetic-agent", "foreign-agent"]) {
					const request = { ...invalidGrantRequest, agentId: targetAgent };
					const {
						grant,
						input: _input,
						selection: _selection,
						requestId,
						keyBinding,
						...scope
					} = request;
					const now = Date.now();
					const claims = RuntimeBusinessGrantClaimsV4Schema.parse({
						...scope,
						issuer: values.AGENT_INFRA_RUNTIME_GRANT_ISSUER,
						audience: "runtime_host",
						workerId: "synthetic-worker",
						issuedAt: now,
						expiresAt: now + 30_000,
						grantId: requestId,
						relayKeyBinding: keyBinding,
						requestDigest: createHash("sha256")
							.update(runtimeRequestSigningPayloadV4(request))
							.digest("hex"),
						purpose: "business",
						authorizationRecordId: "assembly-authorization",
						allowedCommands: ["turn.submit"],
						attachments: [],
					});
					const header = Buffer.from(
						JSON.stringify({
							alg: "EdDSA",
							kid: "fixture",
							typ: "runtime-execution+jws",
						}),
					).toString("base64url");
					const payload = Buffer.from(JSON.stringify(claims)).toString(
						"base64url",
					);
					const signature = sign(
						null,
						Buffer.from(`${header}.${payload}`),
						runtimeV2Keys.privateKey,
					).toString("base64url");
					const signed = {
						...request,
						grant: { ...grant, token: `${header}.${payload}.${signature}` },
					};
					if (targetAgent === "synthetic-agent")
						await expect(
							runtime.verifyGrantV4?.(signed),
						).resolves.toMatchObject({ claims: { agentId: targetAgent } });
					else
						await expect(runtime.verifyGrantV4?.(signed)).rejects.toMatchObject(
							{ code: "RUNTIME_GRANT_INVALID" },
						);
					expect(await readFile(storePath, "utf8")).toBe(beforeLegacySubmit);
				}
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
				if (schemaVersion === 4)
					expect(openedWith?.modelOptions[0]).not.toHaveProperty("credential");
				else
					expect(openedWith?.modelOptions[0]).toHaveProperty(
						"credential",
						"synthetic-static-key",
					);
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
