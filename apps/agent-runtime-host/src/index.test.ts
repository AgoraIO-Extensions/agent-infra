import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
	runtimeAssemblyMocks.openCodexRuntimeDriver.mockReset();
	runtimeAssemblyMocks.verifyCodexPilotInstallation.mockReset();
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("RuntimeHost environment assembly", () => {
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
