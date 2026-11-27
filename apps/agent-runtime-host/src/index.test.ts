import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { createServer as createCollector, get as httpGet } from "node:http";
import { request as httpsRequest } from "node:https";
import {
	type AddressInfo,
	createServer as createNetServer,
	connect as netConnect,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { pathToFileURL } from "node:url";
import {
	type ClaudeRuntimeDriverOptions,
	CODEX_SESSION_EXECUTOR_ATTESTATION_ENV,
	CODEX_SESSION_EXECUTOR_BINDING_ENV,
	type CodexRuntimeDriverOptions,
	type CodexSessionExecutorAdmissionV1,
	codexSessionExecutorAttestationV1,
	codexSessionExecutorBindingDigestV1,
	createCodexSessionExecutorBindingV1,
	DynamicConnectionRefusalV1,
	executorIdentityFileRootV1,
	executorIdentityFileV1,
	FakeRuntimeDriver,
	issueExecutorStartIdentityV1,
	signExecutorControlV1,
	verifyExecutorControlV1,
	verifyExecutorStartIdentityV1,
} from "@agent-infra/agent-runtime";
import {
	connectionConsumerProfileFingerprintV1,
	connectionSystemAccessFingerprintV1,
} from "@agent-infra/contracts/connection-consumer-profile";
import {
	RuntimeNativeCapabilityRequestV6Schema,
	RuntimeSubmitTurnRequestV4Schema,
	type SessionInstanceReadRequestV1,
	sessionInstanceReadSigningPayloadV1,
} from "@agent-infra/contracts/runtime";
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
import { createNativeCapabilityAdmissionUseCaseV6 } from "../../../packages/platform-core/src/native-capability-admission-v6.js";
import { runtimeTlsFixture } from "../../../tests/runtime-tls-fixture.js";
import { sessionScopeAttestationV1 } from "../../platform-worker/src/container-boundary-attestation.js";
import { createWorkerRuntimeGrantSignerV4 } from "../../platform-worker/src/runtime-grant-signer-v4.js";
import { writeStandardMcpExport } from "./standard-mcp-installation.test-support.js";
import { assertStandardMcpProcessProtection } from "./standard-mcp-protection.js";

const executorIdentityPaths = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return {
		...fs,
		open: (
			path: Parameters<typeof fs.open>[0],
			...args: Parameters<typeof fs.open> extends [unknown, ...infer T]
				? T
				: never
		) => fs.open(executorIdentityPaths.get(String(path)) ?? path, ...args),
		lstat: (path: Parameters<typeof fs.lstat>[0]) =>
			fs.lstat(executorIdentityPaths.get(String(path)) ?? path),
		unlink: (path: Parameters<typeof fs.unlink>[0]) =>
			fs.unlink(executorIdentityPaths.get(String(path)) ?? path),
	};
});
vi.mock("./executor-identity-process.js", () => ({
	protectExecutorIdentityProcessV1: () => {},
}));

const runtimeAssemblyMocks = vi.hoisted(() => ({
	openClaudeRuntimeDriver: vi.fn(),
	openCodexRuntimeDriver: vi.fn(),
	openCodexSessionExecutorAdmission: vi.fn(),
	openPaseoCodexRuntime: vi.fn(),
	openPaseoClaudeRuntime: vi.fn(),
	openOpenCodeRuntime: vi.fn(),
	openPiRuntime: vi.fn(),
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
	assertStandardMcpOriginalSessionV1: vi.fn(),
}));

vi.mock("@agent-infra/agent-runtime", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@agent-infra/agent-runtime")>();
	class MockCodexRuntimeDriver extends actual.CodexRuntimeDriver {}
	const MockClaudeRuntimeDriver = {
		open: runtimeAssemblyMocks.openClaudeRuntimeDriver,
	} as unknown as typeof actual.ClaudeRuntimeDriver;
	Object.defineProperty(MockCodexRuntimeDriver, "open", {
		value: runtimeAssemblyMocks.openCodexRuntimeDriver,
	});
	return {
		...actual,
		ClaudeRuntimeDriver: MockClaudeRuntimeDriver,
		CodexRuntimeDriver: MockCodexRuntimeDriver,
		openCodexSessionExecutorAdmissionV1:
			runtimeAssemblyMocks.openCodexSessionExecutorAdmission,
		openPaseoCodexRuntime: runtimeAssemblyMocks.openPaseoCodexRuntime,
		openPaseoClaudeRuntime: runtimeAssemblyMocks.openPaseoClaudeRuntime,
		openOpenCodeRuntime: runtimeAssemblyMocks.openOpenCodeRuntime,
		openPiRuntime: runtimeAssemblyMocks.openPiRuntime,
		verifyCodexPilotInstallation:
			runtimeAssemblyMocks.verifyCodexPilotInstallation,
	};
});

const actualMessageRuntimes = await vi.importActual<
	typeof import("@agent-infra/agent-runtime")
>("@agent-infra/agent-runtime");
runtimeAssemblyMocks.openOpenCodeRuntime.mockImplementation(
	actualMessageRuntimes.openOpenCodeRuntime,
);
runtimeAssemblyMocks.openPiRuntime.mockImplementation(
	actualMessageRuntimes.openPiRuntime,
);
runtimeAssemblyMocks.openClaudeRuntimeDriver.mockImplementation(
	actualMessageRuntimes.ClaudeRuntimeDriver.open,
);

// 生产 Codex Driver，只有原生进程启动由测试控制：启动永不完成即 RuntimeHost 在
// 原生存储创建之前被杀（#3174）。
class PendingNativeLaunchCodexDriver extends actualMessageRuntimes.CodexRuntimeDriver {
	static openPendingLaunch(
		options: CodexRuntimeDriverOptions,
		launch: () => Promise<never>,
	) {
		return PendingNativeLaunchCodexDriver.openWithBridge(options, launch);
	}
}

import {
	assembleRuntimeHost,
	closeRuntimeHost,
	createRuntimeHostApp,
	createRuntimeNativeMetadataDeploymentAssemblyV1,
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

async function sessionExecutorFixture() {
	const base = await environment();
	const binding = createCodexSessionExecutorBindingV1({
		namespace: "runtime-test",
		podName: "sandbox-session-a",
		agentId: "agent-a",
		conversationId: "conversation-a",
		sessionGeneration: 1,
		sandboxId: "session-a",
		resourceFence: 1,
		imageDigest: `registry.example.test/runtime@sha256:${"a".repeat(64)}`,
	});
	const serviceToken = "synthetic-session-service-token";
	const values: NodeJS.ProcessEnv = {
		...base,
		AGENT_INFRA_RUNTIME_DRIVER: "codex",
		AGENT_INFRA_RUNTIME_ISOLATION_MODE: "session-executor",
		AGENT_INFRA_RUNTIME_WORKER_ID: "worker-a",
		AGENT_INFRA_RUNTIME_SERVICE_TOKEN: serviceToken,
		AGENT_INFRA_RUNTIME_AGENT_ID: binding.agentId,
		AGENT_INFRA_RUNTIME_POD_UID: "synthetic-pod-uid",
		AGENT_INFRA_RUNTIME_POD_NAME: binding.podName,
		AGENT_INFRA_RUNTIME_NAMESPACE: binding.namespace,
		[CODEX_SESSION_EXECUTOR_BINDING_ENV]: JSON.stringify(binding),
		[CODEX_SESSION_EXECUTOR_ATTESTATION_ENV]: codexSessionExecutorAttestationV1(
			binding,
			serviceToken,
		),
		AGENT_INFRA_RUNTIME_MODEL_CONFIG: JSON.stringify({
			schemaVersion: 4,
			configVersion: "session-executor-fixture",
			defaultModelOptionId: "primary",
			defaultReasoningLevel: "high",
			modelOptions: [
				{
					modelOptionId: "primary",
					protocol: "openai-responses-v1",
					authentication: "bearer",
					endpoint: "https://models.example.test/v1",
					model: "synthetic-model",
					reasoningLevels: ["high"],
				},
			],
		}),
	};
	let closed = false;
	let failed = false;
	const listeners = new Set<() => void>();
	const assertCurrent = vi.fn(async () => {
		if (closed || failed) throw new Error("CODEX_SESSION_EXECUTOR_INVALID");
	});
	const closeAdmission = vi.fn(async () => {
		closed = true;
		listeners.clear();
	});
	const admission: CodexSessionExecutorAdmissionV1 = {
		binding,
		epoch: "11111111-1111-4111-8111-111111111111",
		assertCurrent,
		onFailure(listener) {
			listeners.add(listener);
			if (failed) listener();
			return () => listeners.delete(listener);
		},
		close: closeAdmission,
	};
	runtimeAssemblyMocks.openCodexSessionExecutorAdmission.mockResolvedValue(
		admission,
	);
	const closeDriver = vi.fn(async () => undefined);
	runtimeAssemblyMocks.openCodexRuntimeDriver.mockImplementation(async () => {
		const driver = await FakeRuntimeDriver.open(
			join(base.AGENT_INFRA_RUNTIME_DATA_DIR, "executor-fixture-driver.json"),
		);
		return Object.assign(driver, { close: closeDriver });
	});
	return {
		values,
		admission,
		assertCurrent,
		closeAdmission,
		closeDriver,
		listenerCount: () => listeners.size,
		fail() {
			failed = true;
			for (const listener of [...listeners]) listener();
		},
	};
}

async function claudeAssemblyFixture(
	installation: "available" | "absent" | "unavailable",
) {
	const values: NodeJS.ProcessEnv = await environment();
	const dataDirectory = values.AGENT_INFRA_RUNTIME_DATA_DIR;
	if (!dataDirectory) throw new Error("Missing test data directory");
	const fixture = await standardMcpFixture();
	const profile = fixture.target.profile;
	const approval = {
		schemaVersion: 1 as const,
		configFingerprint: fixture.target.configFingerprint,
		source: fixture.target.source,
		egressEnforced: true as const,
	};
	const profileFile = join(dataDirectory, "consumer.json");
	await writeFile(profileFile, JSON.stringify({ profile, approval }));
	Object.assign(values, {
		AGENT_INFRA_RUNTIME_DRIVER: "claude",
		AGENT_INFRA_RUNTIME_AGENT_ID: fixture.input.scope.agentId,
		AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_PRIMARY: "synthetic-model-credential",
		AGENT_INFRA_RUNTIME_MODEL_CONFIG: JSON.stringify({
			schemaVersion: 3,
			configVersion: "claude-connection-mcp",
			defaultModelOptionId: "primary",
			defaultReasoningLevel: "high",
			modelOptions: [
				{
					modelOptionId: "primary",
					protocol: "anthropic-messages-v1",
					authentication: "bearer",
					model: "claude-opus-5",
					reasoningLevels: ["high"],
					endpoint: "https://models.example.test",
					credentialEnvironmentVariable:
						"AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_PRIMARY",
				},
			],
		}),
		AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_FILE: profileFile,
		AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_REVISION: JSON.stringify([
			approval.configFingerprint,
			approval.source.ref,
			approval.source.revision,
		]),
	});
	if (installation === "available") {
		const exportReceipt = await writeStandardMcpExport(
			dataDirectory,
			fixture.target,
			[fixture.input],
		);
		values.AGENT_INFRA_RUNTIME_CONNECTION_INSTALLATION_REVISION =
			exportReceipt.revision;
	} else if (installation === "unavailable") {
		values.AGENT_INFRA_RUNTIME_CONNECTION_INSTALLATION_REVISION =
			JSON.stringify(["missing-supply", "r1"]);
	}
	return { values, dataDirectory, fixture, approval };
}

afterEach(async () => {
	runtimeAssemblyMocks.assertRuntimeProcessProtection.mockReset();
	runtimeAssemblyMocks.openClaudeRuntimeDriver.mockClear();
	runtimeAssemblyMocks.openClaudeRuntimeDriver.mockImplementation(
		actualMessageRuntimes.ClaudeRuntimeDriver.open,
	);
	runtimeAssemblyMocks.openCodexRuntimeDriver.mockReset();
	runtimeAssemblyMocks.openPaseoCodexRuntime.mockReset();
	runtimeAssemblyMocks.openPaseoClaudeRuntime.mockReset();
	runtimeAssemblyMocks.openCodexSessionExecutorAdmission.mockReset();
	runtimeAssemblyMocks.openOpenCodeRuntime.mockClear();
	runtimeAssemblyMocks.openOpenCodeRuntime.mockImplementation(
		actualMessageRuntimes.openOpenCodeRuntime,
	);
	runtimeAssemblyMocks.openPiRuntime.mockClear();
	runtimeAssemblyMocks.openPiRuntime.mockImplementation(
		actualMessageRuntimes.openPiRuntime,
	);
	runtimeAssemblyMocks.verifyCodexPilotInstallation.mockReset();
	runtimeAssemblyMocks.readCodexInstalledSkillDeployment.mockReset();
	for (const directory of directories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
	await closeStandardMcpFixtures();
});

describe("RuntimeHost environment assembly", () => {
	it("admits only signed isolated eval on the rendered Codex template Host", async () => {
		const { renderTemplatePreflightPod } = await import(
			new URL(
				"../../../deploy/ack/template-model-preflight.mjs",
				import.meta.url,
			).href
		);
		const { values } = await sessionExecutorFixture();
		const imageDigest = "sha256:" + "a".repeat(64);
		const job = {
			schemaVersion: 1,
			scope: "isolated-template-real-model",
			templateId: "codex",
			driver: "codex",
			transport: "paseo-sdk-pod",
			protocol: "openai-responses-v1",
			namespace: "ack-community-m1-4405",
			kubeconfig: "/fixture/kubeconfig",
			worktree: "/fixture/source",
			outputDirectory: "/fixture/output",
			grantPrivateKeyFile: "/fixture/signing",
			runtimeServiceTokenFile: "/fixture/service",
			relayKeyFile: "/fixture/relay",
			operatorApprovalRef: "fixture",
			imageDigest,
			imageReference:
				"ghcr.io/agoraio-extensions/agent-infra/agent-runtime-codex@" +
				imageDigest,
			sourceCommit: "a".repeat(40),
			modelId: "synthetic-model",
			modelOptionId: "primary",
			reasoningLevel: "high",
			configurationRevision: "r1",
			runtimeConfigVersion: "session-executor-fixture",
			approvedRelayOrigin: "https://models.example.test",
			expectedResourceLimits: { cpu: "1", memory: "2Gi" },
			resourceProfileRef: "sdk",
			placement: { nodeSelector: { type: "virtual-kubelet" } },
			storageClassName: "disk",
			storageSize: "20Gi",
			modelEgress: [{ destination: { ip: "192.0.2.1" }, port: 443 }],
			dnsEgress: [{ ip: "192.0.2.2" }],
		};
		const { pod } = renderTemplatePreflightPod({
			job,
			owner: "deadbeef",
			textOnly: true,
			publicKey: values.AGENT_INFRA_RUNTIME_GRANT_PUBLIC_KEY,
			modelConfig: values.AGENT_INFRA_RUNTIME_MODEL_CONFIG,
			serviceToken: values.AGENT_INFRA_RUNTIME_SERVICE_TOKEN,
		});
		const env: NodeJS.ProcessEnv = {};
		for (const { name, value, valueFrom } of pod.spec.containers[0].env) {
			if (value !== undefined) env[name] = value;
			else if (valueFrom?.fieldRef?.fieldPath === "metadata.name")
				env[name] = pod.metadata.name;
			else if (valueFrom?.fieldRef?.fieldPath === "metadata.namespace")
				env[name] = pod.metadata.namespace;
			else if (valueFrom?.secretKeyRef?.key === "service-token")
				env[name] = values.AGENT_INFRA_RUNTIME_SERVICE_TOKEN;
			else throw new Error("Unexpected qualification Pod input");
		}
		env.AGENT_INFRA_RUNTIME_DATA_DIR = values.AGENT_INFRA_RUNTIME_DATA_DIR;
		runtimeAssemblyMocks.openPaseoCodexRuntime.mockImplementation(
			actualMessageRuntimes.openPaseoCodexRuntime,
		);
		const host = await assembleRuntimeHost(env);
		try {
			expect(host.validationPurpose).toBe("template-model");
			const signer = createWorkerRuntimeGrantSignerV4({
				issuer: "ack-template-validation",
				workerId: "ack-template-validator",
				keyId: "ack-validation-v1",
				privateKey,
			});
			const request = RuntimeSubmitTurnRequestV4Schema.parse({
				schemaVersion: 4,
				requestId: randomUUID(),
				traceId: randomUUID(),
				principal: { kind: "application", id: "qualification" },
				executionSource: "eval",
				channelId: "isolated-template-validation",
				agentId: env.AGENT_INFRA_RUNTIME_AGENT_ID,
				conversationId: "qualification",
				executionId: "eval",
				turnId: "turn",
				sessionGeneration: 1,
				hostSessionRef: null,
				operation: {
					kind: "execution",
					id: "eval",
					deliveryFence: 1,
					executionDeliveryFence: 1,
				},
				keyBinding: {
					purpose: "agent-default",
					subjectId: env.AGENT_INFRA_RUNTIME_AGENT_ID,
					ciphertextRef: "fixture",
					version: 1,
				},
				input: { text: "READY", attachments: [] },
				selection: {
					schemaVersion: 1,
					modelOptionId: "primary",
					reasoningLevel: "high",
				},
				grant: {
					schemaVersion: 4,
					format: "runtime-execution-jws",
					token: "a.b.c",
				},
			});
			const signed = (r: typeof request) => ({
				...r,
				grant: signer.sign(r, "qualification"),
			});
			expect(
				(await host.verifyGrantV4?.(signed(request)))?.claims.channelId,
			).toBe("isolated-template-validation");
			await expect(
				host.verifyGrantV4?.(signed({ ...request, channelId: "business" })),
			).rejects.toThrow();
			const app = createRuntimeHostApp(host);
			expect((await app.request("/healthz")).status).toBe(200);
			expect(
				(
					await app.request("/internal/runtime/v1/readiness", {
						method: "POST",
					})
				).status,
			).toBe(403);
			expect(
				(await app.request("/internal/runtime/v4/turns", { method: "POST" }))
					.status,
			).toBe(401);
			// Reach the real driver without opening a paid model or a companion Session.
			const submit = async (channelId: string) => {
				const businessRequest = signed({
					...request,
					channelId,
					selection: { ...request.selection, modelOptionId: "absent-option" },
				});
				const { grantId, requestDigest } = signer.verify(businessRequest.grant);
				const { schemaVersion, input, selection, grant, ...context } =
					businessRequest;
				return app.request("/internal/runtime/v4/turns", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: "Bearer " + env.AGENT_INFRA_RUNTIME_SERVICE_TOKEN,
					},
					body: JSON.stringify({
						businessRequest,
						privateKeyField: {
							schemaVersion: 1,
							context: { ...context, grantId, requestDigest },
							keyDelivery: { relayKey: "synthetic-qualification-key" },
						},
					}),
				});
			};
			expect((await submit("business")).status).toBe(403);
			const evaluation = await submit("isolated-template-validation");
			expect(await evaluation.json()).toMatchObject({
				result: {
					outcome: "rejected",
					code: "RUNTIME_MODEL_SELECTION_UNSUPPORTED",
				},
			});
		} finally {
			await host.close();
		}
		await expect(
			assembleRuntimeHost({
				...env,
				AGENT_INFRA_RUNTIME_TEMPLATE_VALIDATION_POD: undefined,
			}),
		).rejects.toThrow("RUNTIME_CONFIGURATION_INVALID");
	});

	it.each([false, true])(
		"assembles SDK Codex with ordinary Session scope (text only %s)",
		async (textOnly) => {
			const { values } = await sessionExecutorFixture();
			if (textOnly) values.AGENT_INFRA_RUNTIME_TEXT_ONLY = "true";
			delete values.AGENT_INFRA_RUNTIME_ISOLATION_MODE;
			delete values[CODEX_SESSION_EXECUTOR_BINDING_ENV];
			delete values[CODEX_SESSION_EXECUTOR_ATTESTATION_ENV];
			values.AGENT_INFRA_RUNTIME_TRANSPORT = "paseo-sdk-pod";
			values.AGENT_INFRA_RUNTIME_SESSION_SCOPE = "agent-a:conversation-a";
			values.AGENT_INFRA_RUNTIME_SESSION_SCOPE_ATTESTATION =
				sessionScopeAttestationV1(
					values.AGENT_INFRA_RUNTIME_SERVICE_TOKEN ?? "",
					"agent-a:conversation-a",
				);
			runtimeAssemblyMocks.openPaseoCodexRuntime.mockImplementation(async () =>
				FakeRuntimeDriver.open(
					join(values.AGENT_INFRA_RUNTIME_DATA_DIR ?? "", "sdk-fixture.json"),
				),
			);
			const runtime = await assembleRuntimeHost(values);
			try {
				expect(runtimeAssemblyMocks.openPaseoCodexRuntime).toHaveBeenCalledWith(
					expect.objectContaining({
						textOnly,
						modelOptions: [
							expect.objectContaining({
								modelOptionId: "primary",
								authentication: "bearer",
							}),
						],
						authorizeModelAction: expect.any(Function),
					}),
				);
				expect(
					runtimeAssemblyMocks.openCodexRuntimeDriver,
				).not.toHaveBeenCalled();
				expect(
					runtimeAssemblyMocks.openCodexSessionExecutorAdmission,
				).not.toHaveBeenCalled();
			} finally {
				await runtime.close();
			}
		},
	);

	it("rejects an unknown Harness transport instead of opening a different Driver", async () => {
		const values = await environment();
		await expect(
			assembleRuntimeHost({
				...values,
				AGENT_INFRA_RUNTIME_TRANSPORT: "misspelled",
			}),
		).rejects.toThrow("RUNTIME_CONFIGURATION_INVALID");
	});

	it("wires model transport failures to the safe production log and OTLP projection", async () => {
		const fixture = await sessionExecutorFixture();
		const exports: Buffer[] = [];
		const logs: string[] = [];
		const collector = createCollector(async (request, response) => {
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			exports.push(Buffer.concat(chunks));
			response.end();
		});
		await new Promise<void>((resolve) =>
			collector.listen(0, "127.0.0.1", resolve),
		);
		const address = collector.address();
		if (!address || typeof address === "string")
			throw new Error("missing collector");
		fixture.values.AGENT_INFRA_OBSERVABILITY_OTLP_ENDPOINT = `http://127.0.0.1:${address.port}`;
		const write = process.stdout.write;
		const output = vi.spyOn(process.stdout, "write").mockImplementation(((
			chunk: unknown,
			...args: unknown[]
		) => {
			logs.push(String(chunk));
			return Reflect.apply(write, process.stdout, [chunk, ...args]);
		}) as typeof process.stdout.write);
		const canary = "PRIVATE_MODEL_BODY_KEY_COOKIE_QUERY_ERROR";
		try {
			const runtime = await assembleRuntimeHost(fixture.values);
			try {
				const options = runtimeAssemblyMocks.openCodexRuntimeDriver.mock
					.calls[0]?.[0] as CodexRuntimeDriverOptions;
				expect(options.observeModelTransportFailure).toBeTypeOf("function");
				const event = {
					stage: "response_body" as const,
					errorClass: "connection_reset" as const,
					elapsedMs: 17,
					upstreamStatus: 200,
					agentId: "123e4567-e89b-42d3-a456-426614174001",
					conversationId: "123e4567-e89b-42d3-a456-426614174002",
					executionId: "123e4567-e89b-42d3-a456-426614174003",
					operationRef: "123e4567-e89b-42d3-a456-426614174004",
					attemptRef: "123e4567-e89b-42d3-a456-426614174005",
					message: canary,
					stack: canary,
					body: canary,
					headers: { cookie: canary },
				};
				options.observeModelTransportFailure?.(event);
			} finally {
				await runtime.close();
			}
		} finally {
			output.mockRestore();
			await new Promise<void>((resolve) => collector.close(() => resolve()));
		}
		expect(logs.join("")).toContain(
			'"modelTransportErrorClass":"connection_reset"',
		);
		expect(logs.join("")).toContain('"modelTransportHttpStatus":200');
		expect(logs.join("")).not.toContain(canary);
		const otlp = Buffer.concat(exports).toString();
		expect(otlp).toContain("modelTransportErrorClass");
		expect(otlp).toContain("123e4567-e89b-42d3-a456-426614174004");
		expect(otlp).not.toContain(canary);
	});

	it("waits for Session executor admission before opening a native Driver", async () => {
		const fixture = await sessionExecutorFixture();
		const startup = Promise.withResolvers<CodexSessionExecutorAdmissionV1>();
		runtimeAssemblyMocks.openCodexSessionExecutorAdmission.mockReturnValue(
			startup.promise,
		);
		const assembling = assembleRuntimeHost(fixture.values);
		await vi.waitFor(() =>
			expect(
				runtimeAssemblyMocks.openCodexSessionExecutorAdmission,
			).toHaveBeenCalledWith(fixture.admission.binding, "synthetic-pod-uid"),
		);
		expect(runtimeAssemblyMocks.openCodexRuntimeDriver).not.toHaveBeenCalled();
		startup.resolve(fixture.admission);
		const runtime = await assembling;
		expect(runtime.sessionInstanceRead).toBeUndefined();
		try {
			expect(
				runtimeAssemblyMocks.openCodexRuntimeDriver.mock.calls[0]?.[0],
			).not.toHaveProperty("coreConversationKey");
			expect(runtimeAssemblyMocks.openCodexRuntimeDriver).toHaveBeenCalledWith(
				expect.objectContaining({
					isolationMode: "session-executor",
					sessionExecutor: fixture.admission,
					modelOptions: [
						expect.not.objectContaining({ credential: expect.anything() }),
					],
				}),
			);
			expect(fixture.assertCurrent).toHaveBeenCalled();
			expect(fixture.listenerCount()).toBe(1);
		} finally {
			await Promise.all([runtime.close(), runtime.close()]);
		}
		expect(fixture.closeDriver).toHaveBeenCalledOnce();
		expect(fixture.closeAdmission).toHaveBeenCalledOnce();
		expect(fixture.listenerCount()).toBe(0);
	});

	it("assembles the original V1 executor after upgrade without rewriting its pin or journal", async () => {
		const fixture = await sessionExecutorFixture();
		const directory = fixture.values.AGENT_INFRA_RUNTIME_DATA_DIR as string;
		const admission = { ...fixture.admission, podUid: "synthetic-pod-uid" };
		runtimeAssemblyMocks.openCodexSessionExecutorAdmission.mockResolvedValue(
			admission,
		);
		await actualMessageRuntimes.pinCodexSessionExecutorEpochV1(
			directory,
			admission,
		);
		const pin = join(
			directory,
			`.executor-${codexSessionExecutorBindingDigestV1(admission.binding)}.json`,
		);
		const bytes = await readFile(pin);
		const executionId = "original-execution";
		const journal = join(
			directory,
			"executor-drain",
			`${createHash("sha256").update(executionId).digest("hex")}.json`,
		);
		const scope = {
			executionId,
			podUid: admission.podUid,
			epoch: admission.epoch,
			generation: admission.binding.sessionGeneration,
			resourceFence: admission.binding.resourceFence,
		};
		const original =
			await actualMessageRuntimes.CodexExecutorDrainJournalV1.open(
				journal,
				scope,
			);
		await original.bindNativeTurn("original-turn");
		await original.admit({
			protocolSession: "original-protocol",
			handle: "pending-launch",
		});
		const stop = { stopRequestId: "original-stop", stopFence: 7 };
		const seal = await original.seal(stop);
		await original.close();
		const journalBytes = await readFile(journal);
		const start = {
			podUid: admission.podUid,
			bindingDigest: codexSessionExecutorBindingDigestV1(admission.binding),
			startupRef: "original-v1-start",
			expiresAt: Date.now() + 60_000,
		};
		const material = issueExecutorStartIdentityV1(start, privateKey);
		const runner = verifyExecutorStartIdentityV1(material.runner, {
			...start,
			issuerKey: publicKey,
			now: Date.now(),
			role: "runner",
		});
		const identityPath = join(directory, "private-startup.json");
		await writeFile(identityPath, JSON.stringify(material.host), {
			mode: 0o400,
		});
		executorIdentityPaths.set(
			join(executorIdentityFileRootV1, executorIdentityFileV1),
			identityPath,
		);
		Object.assign(fixture.values, {
			AGENT_INFRA_EXECUTOR_STARTUP_REF: start.startupRef,
			AGENT_INFRA_EXECUTOR_STARTUP_DEADLINE: String(start.expiresAt),
		});
		const transport = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (url, options) => {
				const path = new URL(String(url)).pathname;
				const request = verifyExecutorControlV1(
					runner,
					path,
					JSON.parse(String(options?.body)),
				);
				if (!request) throw new Error("invalid fixture authentication");
				return Response.json(
					signExecutorControlV1(
						runner,
						`${path}/result`,
						{ epoch: admission.epoch },
						request.requestId,
						request.deadline,
					),
				);
			});
		try {
			const runtime = await assembleRuntimeHost(fixture.values);
			try {
				expect(
					runtimeAssemblyMocks.openCodexRuntimeDriver,
				).toHaveBeenCalledWith(
					expect.objectContaining({
						sessionExecutor: expect.objectContaining({
							drain: expect.any(Object),
							epoch: admission.epoch,
						}),
					}),
				);
				expect(await readFile(pin)).toEqual(bytes);
				expect(await readFile(journal)).toEqual(journalBytes);
				await expect(stat(identityPath)).rejects.toMatchObject({
					code: "ENOENT",
				});
			} finally {
				await runtime.close();
			}
			const recovered =
				await actualMessageRuntimes.CodexExecutorDrainJournalV1.open(
					journal,
					scope,
				);
			try {
				expect(await recovered.seal(stop)).toEqual(seal);
				expect(recovered.confirmed()).toBe(false);
			} finally {
				await recovered.close();
			}
		} finally {
			executorIdentityPaths.clear();
			transport.mockRestore();
		}
	});

	it("rejects a foreign Session attestation before executor or Driver startup", async () => {
		const fixture = await sessionExecutorFixture();
		fixture.values[CODEX_SESSION_EXECUTOR_ATTESTATION_ENV] =
			codexSessionExecutorAttestationV1(
				fixture.admission.binding,
				"foreign-session-service-token",
			);
		await expect(assembleRuntimeHost(fixture.values)).rejects.toThrow(
			/^RUNTIME_CONFIGURATION_INVALID$/,
		);
		expect(
			runtimeAssemblyMocks.openCodexSessionExecutorAdmission,
		).not.toHaveBeenCalled();
		expect(runtimeAssemblyMocks.openCodexRuntimeDriver).not.toHaveBeenCalled();
	});

	it("keeps the native Driver and Host store unopened when executor startup fails", async () => {
		const fixture = await sessionExecutorFixture();
		runtimeAssemblyMocks.openCodexSessionExecutorAdmission.mockRejectedValue(
			new Error("CODEX_SESSION_EXECUTOR_INVALID"),
		);
		await expect(assembleRuntimeHost(fixture.values)).rejects.toThrow(
			/^CODEX_SESSION_EXECUTOR_INVALID$/,
		);
		expect(runtimeAssemblyMocks.openCodexRuntimeDriver).not.toHaveBeenCalled();
		await expect(
			readFile(
				join(fixture.values.AGENT_INFRA_RUNTIME_DATA_DIR ?? "", "host.json"),
			),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("closes executor admission and its subscription after native startup failure", async () => {
		const fixture = await sessionExecutorFixture();
		runtimeAssemblyMocks.openCodexRuntimeDriver.mockRejectedValue(
			new Error("synthetic-native-startup-failure"),
		);
		await expect(assembleRuntimeHost(fixture.values)).rejects.toThrow(
			/^synthetic-native-startup-failure$/,
		);
		expect(fixture.closeAdmission).toHaveBeenCalledOnce();
		expect(fixture.listenerCount()).toBe(0);
	});

	it("rejects a replacement executor epoch after Host restart for the same binding", async () => {
		const fixture = await sessionExecutorFixture();
		const runtime = await assembleRuntimeHost(fixture.values);
		await runtime.close();
		runtimeAssemblyMocks.openCodexRuntimeDriver.mockClear();
		const closeReplacement = vi.fn(async () => undefined);
		runtimeAssemblyMocks.openCodexSessionExecutorAdmission.mockResolvedValue({
			...fixture.admission,
			epoch: "22222222-2222-4222-8222-222222222222",
			assertCurrent: async () => undefined,
			close: closeReplacement,
		});
		await expect(assembleRuntimeHost(fixture.values)).rejects.toThrow(
			/^CODEX_SESSION_EXECUTOR_INVALID$/,
		);
		expect(runtimeAssemblyMocks.openCodexRuntimeDriver).not.toHaveBeenCalled();
		expect(closeReplacement).toHaveBeenCalledOnce();
	});

	it("rejects admission loss during Driver startup and closes the opened Driver", async () => {
		const fixture = await sessionExecutorFixture();
		const openDriver =
			runtimeAssemblyMocks.openCodexRuntimeDriver.getMockImplementation();
		runtimeAssemblyMocks.openCodexRuntimeDriver.mockImplementation(
			async (...args) => {
				const driver = await openDriver?.(...args);
				fixture.fail();
				return driver;
			},
		);
		await expect(assembleRuntimeHost(fixture.values)).rejects.toThrow(
			/^CODEX_SESSION_EXECUTOR_INVALID$/,
		);
		expect(fixture.closeDriver).toHaveBeenCalledOnce();
		expect(fixture.closeAdmission).toHaveBeenCalled();
		expect(fixture.listenerCount()).toBe(0);
	});

	it("closes the native Driver and Host on executor epoch loss without readmitting it", async () => {
		const fixture = await sessionExecutorFixture();
		const runtime = await assembleRuntimeHost(fixture.values);
		const closeHost = vi.spyOn(runtime.host, "close");
		fixture.fail();
		await vi.waitFor(() => expect(closeHost).toHaveBeenCalledOnce());
		await runtime.close();
		expect(fixture.closeDriver).toHaveBeenCalledOnce();
		expect(fixture.listenerCount()).toBe(0);
		expect(
			runtimeAssemblyMocks.openCodexSessionExecutorAdmission,
		).toHaveBeenCalledOnce();
		await expect(
			runtime.host.readiness(
				{} as never,
				"worker-a",
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: "RUNTIME_READINESS_UNAVAILABLE" });
	});

	it("assembles the fixed Worker current client from deployment environment", async () => {
		let currentBaseUrl = "";
		let currentToken = "";
		const assembly = await createRuntimeNativeMetadataDeploymentAssemblyV1({
			environment: {
				AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_ORIGIN:
					"http://worker.internal",
				AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_SERVICE_TOKEN:
					"worker-current-token",
				AGENT_INFRA_RUNTIME_NATIVE_METADATA_DEPLOYMENT_MODULE:
					"file:///deployment/native-metadata.mjs",
			},
			host: {} as never,
			deployment: {
				createRuntimeNativeMetadataReadAssembly({ current }) {
					currentBaseUrl = "http://worker.internal";
					currentToken = "worker-current-token";
					expect(typeof current.check).toBe("function");
					return {
						resolveContext: async () => null,
					};
				},
			},
		});
		expect(assembly).toBeDefined();
		expect(currentBaseUrl).toBe("http://worker.internal");
		expect(currentToken).toBe("worker-current-token");
	});

	it("uses the deployment native metadata module on the real environment path", async () => {
		const values = await environment();
		const dataDirectory = values.AGENT_INFRA_RUNTIME_DATA_DIR;
		if (!dataDirectory) throw new Error("Missing test data directory");
		const modulePath = join(dataDirectory, "native-metadata.mjs");
		await writeFile(
			modulePath,
			"export function createRuntimeNativeMetadataReadAssembly() { return { resolveContext: async () => null }; }",
		);
		Object.assign(values, {
			AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_ORIGIN:
				"http://worker.internal",
			AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_SERVICE_TOKEN:
				"worker-current-token",
			AGENT_INFRA_RUNTIME_NATIVE_METADATA_DEPLOYMENT_MODULE:
				pathToFileURL(modulePath).href,
		});
		const runtime = await assembleRuntimeHost(values);
		try {
			expect(runtime.nativeMetadataRead).toBeTypeOf("function");
		} finally {
			await runtime.close();
		}
	});

	it("assembles the built-in proof/session resolver without a module", async () => {
		const values = await environment();
		Object.assign(values, {
			AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_ORIGIN:
				"http://worker.internal",
			AGENT_INFRA_RUNTIME_NATIVE_METADATA_WORKER_SERVICE_TOKEN:
				"worker-current-token",
			AGENT_INFRA_RUNTIME_WORKER_ID: "worker-proof",
		});
		const host = {
			resolveNativeMetadataSessionRef: vi.fn(async () => "native-session"),
		};
		const assembly = await createRuntimeNativeMetadataDeploymentAssemblyV1({
			environment: values,
			host: host as never,
		});
		expect(assembly).toBeDefined();
		expect(assembly?.resolveContext).toBeTypeOf("function");
	});
	it.each(["pi", "acp"] as const)(
		"assembles the gated Connection MCP path for %s",
		async (binding) => {
			const values: NodeJS.ProcessEnv = await environment();
			const dataDirectory = values.AGENT_INFRA_RUNTIME_DATA_DIR;
			if (!dataDirectory) throw new Error("Missing test data directory");
			const fixture = await standardMcpFixture();
			values.AGENT_INFRA_RUNTIME_DRIVER = binding;
			values[
				binding === "pi"
					? "AGENT_INFRA_RUNTIME_PI_MCP_BRIDGE"
					: "AGENT_INFRA_RUNTIME_ACP_MCP_BRIDGE"
			] = "verified-v1";
			values.AGENT_INFRA_RUNTIME_AGENT_ID = fixture.input.scope.agentId;
			values.AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_PRIMARY =
				"synthetic-model-credential";
			values.AGENT_INFRA_RUNTIME_MODEL_CONFIG = JSON.stringify({
				schemaVersion: 3,
				configVersion: "messages-configuration",
				defaultModelOptionId: "primary",
				defaultReasoningLevel: "high",
				modelOptions: [
					{
						modelOptionId: "primary",
						protocol: "anthropic-messages-v1",
						authentication: "bearer",
						model: "messages-model",
						reasoningLevels: ["high"],
						endpoint: "https://models.example.test",
						credentialEnvironmentVariable:
							"AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_PRIMARY",
					},
				],
			});
			const profile = fixture.target.profile;
			const approval = {
				schemaVersion: 1 as const,
				configFingerprint: connectionConsumerProfileFingerprintV1(profile),
				source: fixture.target.source,
				egressEnforced: true as const,
			};
			const profileFile = join(dataDirectory, "consumer.json");
			await writeFile(profileFile, JSON.stringify({ profile, approval }));
			values.AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_FILE = profileFile;
			values.AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_REVISION = JSON.stringify([
				approval.configFingerprint,
				approval.source.ref,
				approval.source.revision,
			]);
			const exportReceipt = await writeStandardMcpExport(
				dataDirectory,
				fixture.target,
				[fixture.input],
			);
			values.AGENT_INFRA_RUNTIME_CONNECTION_INSTALLATION_REVISION =
				exportReceipt.revision;
			let openedWith: Record<string, unknown> | undefined;
			const open =
				binding === "pi"
					? runtimeAssemblyMocks.openPiRuntime
					: runtimeAssemblyMocks.openOpenCodeRuntime;
			open.mockImplementation(async (options: Record<string, unknown>) => {
				openedWith = options;
				return FakeRuntimeDriver.open(
					join(dataDirectory, `${binding}-driver.json`),
				);
			});

			const runtime = await assembleRuntimeHost(values);
			try {
				expect(openedWith).toBeDefined();
				expect(openedWith).toHaveProperty("standardConnectionClient");
			} finally {
				await runtime.close();
			}
		},
	);

	it("assembles the protected Connection MCP input for Pi", async () => {
		const { values, dataDirectory, fixture } =
			await claudeAssemblyFixture("available");
		values.AGENT_INFRA_RUNTIME_DRIVER = "pi";
		values.AGENT_INFRA_RUNTIME_PI_MCP_BRIDGE = "verified-v1";
		let openedWith: Record<string, unknown> | undefined;
		runtimeAssemblyMocks.openPiRuntime.mockImplementation(
			async (options: Record<string, unknown>) => {
				openedWith = options;
				return FakeRuntimeDriver.open(join(dataDirectory, "pi-driver.json"));
			},
		);
		const runtime = await assembleRuntimeHost(values);
		try {
			expect(openedWith?.standardConnectionClient).toBeDefined();
			expect(openedWith?.standardConnectionClient).toMatchObject({
				target: { status: "available", url: fixture.target.url },
			});
		} finally {
			await runtime.close();
		}
	});

	it("rejects the Paseo Claude provider before reading private configuration", async () => {
		const values = await environment();
		const readDataDirectory = vi.fn(() => {
			throw new Error("read private data directory");
		});
		Object.assign(values, {
			AGENT_INFRA_RUNTIME_DRIVER: "claude",
			AGENT_INFRA_RUNTIME_TRANSPORT: "paseo-sdk",
		});
		Object.defineProperty(values, "AGENT_INFRA_RUNTIME_DATA_DIR", {
			get: readDataDirectory,
		});

		await expect(assembleRuntimeHost(values)).rejects.toThrow(
			"RUNTIME_CONFIGURATION_INVALID",
		);
		expect(readDataDirectory).not.toHaveBeenCalled();
		expect(runtimeAssemblyMocks.openClaudeRuntimeDriver).not.toHaveBeenCalled();
	});

	it("assembles the Claude Paseo SDK Pod runtime with the protected model authorizer", async () => {
		const { values, dataDirectory } = await claudeAssemblyFixture("available");
		values.AGENT_INFRA_RUNTIME_TRANSPORT = "paseo-sdk-pod";
		const modelConfig = JSON.parse(
			values.AGENT_INFRA_RUNTIME_MODEL_CONFIG ?? "{}",
		);
		values.AGENT_INFRA_RUNTIME_MODEL_CONFIG = JSON.stringify({
			...modelConfig,
			schemaVersion: 4,
			modelOptions: modelConfig.modelOptions.map(
				(option: Record<string, unknown>) => {
					const { credentialEnvironmentVariable: _credential, ...rest } =
						option;
					return rest;
				},
			),
		});
		let openedWith: Record<string, unknown> | undefined;
		runtimeAssemblyMocks.openPaseoClaudeRuntime.mockImplementation(
			async (options: Record<string, unknown>) => {
				openedWith = options;
				return FakeRuntimeDriver.open(
					join(dataDirectory, "claude-paseo-driver.json"),
				);
			},
		);
		const runtime = await assembleRuntimeHost(values);
		try {
			expect(openedWith).toMatchObject({ paseoCompanion: true });
			expect(openedWith?.authorizeModelAction).toBeTypeOf("function");
		} finally {
			await runtime.close();
		}
	});

	it("assembles the protected Connection MCP input for Claude", async () => {
		const { values, dataDirectory, fixture, approval } =
			await claudeAssemblyFixture("available");
		let openedWith: ClaudeRuntimeDriverOptions | undefined;
		runtimeAssemblyMocks.openClaudeRuntimeDriver.mockImplementation(
			async (options: ClaudeRuntimeDriverOptions) => {
				openedWith = options;
				return FakeRuntimeDriver.open(
					join(dataDirectory, "claude-driver.json"),
				);
			},
		);
		let runtime: Awaited<ReturnType<typeof assembleRuntimeHost>> | undefined;
		try {
			runtime = await assembleRuntimeHost(values);
			expect(runtime.connectionConsumer).toMatchObject({
				status: "available",
				configFingerprint: approval.configFingerprint,
			});
			expect(openedWith?.standardConnectionClient?.target).toMatchObject({
				status: "available",
				profile: { consumerId: fixture.target.profile.consumerId },
				url: fixture.target.url,
			});
			expect(openedWith?.standardConnectionClient?.resolveInput).toBeTypeOf(
				"function",
			);
		} finally {
			await runtime?.close();
		}
	});

	// §13.5.6 (#4349): the manual installation receiver follows the Driver that
	// consumes its reader, not only Codex.
	it("hands Claude the dynamic Connection reader of the install receiver", async () => {
		const { values, dataDirectory } = await claudeAssemblyFixture("absent");
		// A dynamic Pod carries no static consumer; the two inputs never coexist.
		delete values.AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_FILE;
		delete values.AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_REVISION;
		let openedWith: ClaudeRuntimeDriverOptions | undefined;
		runtimeAssemblyMocks.openClaudeRuntimeDriver.mockImplementation(
			async (options: ClaudeRuntimeDriverOptions) => {
				openedWith = options;
				return FakeRuntimeDriver.open(
					join(dataDirectory, "claude-driver.json"),
				);
			},
		);
		const tool = {
			name: "write_note",
			description: "Write a note",
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
		};
		const resolveTarget = vi.fn(async () => {
			throw new DynamicConnectionRefusalV1("authorization_required");
		});
		const prepare = vi.fn(async () => ({
			status: "available" as const,
			fetch: (async () => new Response(null, { status: 404 })) as never,
			key: "synthetic-key",
			cert: "synthetic-cert",
			port: 0,
			runtimeOrigin: "https://runtime.example.test",
			dynamicReader: {
				contract: {
					serviceRef: "connection-fixture",
					contract: {
						ref: "fixture-mcp-contract",
						revision: "r1",
						serverInfo: { name: "fixture", version: "1" },
						tools: [{ name: "write_note" }],
					},
					toolDeclarations: [tool],
				},
				resolveTarget,
				resolveInput: async () => undefined,
			},
			close: async () => {},
		}));
		let runtime: Awaited<ReturnType<typeof assembleRuntimeHost>> | undefined;
		try {
			runtime = await assembleRuntimeHost(values, undefined, {
				prepareConnectionInstall: prepare,
			});
			expect(prepare).toHaveBeenCalledTimes(1);
			expect(openedWith?.standardConnectionClient).toBeUndefined();
			expect(openedWith?.dynamicConnectionClient?.declared).toEqual({
				contract: { ref: "fixture-mcp-contract", revision: "r1" },
				tools: [tool],
			});
			// The reader a Claude Execution calls refuses with the platform-owned
			// fixed reason; it never reaches Connection.
			await expect(
				openedWith?.dynamicConnectionClient?.resolveTarget(
					reference,
					new AbortController().signal,
				),
			).rejects.toBeInstanceOf(DynamicConnectionRefusalV1);
		} finally {
			await runtime?.close();
		}
	});

	it("hands Pi the dynamic Connection reader of the install receiver", async () => {
		const { values, dataDirectory } = await claudeAssemblyFixture("absent");
		delete values.AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_FILE;
		delete values.AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_REVISION;
		values.AGENT_INFRA_RUNTIME_DRIVER = "pi";
		values.AGENT_INFRA_RUNTIME_PI_MCP_BRIDGE = "verified-v1";
		let openedWith: Record<string, unknown> | undefined;
		runtimeAssemblyMocks.openPiRuntime.mockImplementation(
			async (options: Record<string, unknown>) => {
				openedWith = options;
				return FakeRuntimeDriver.open(join(dataDirectory, "pi-driver.json"));
			},
		);
		const tool = {
			name: "write_note",
			description: "Write a note",
			inputSchema: {
				type: "object",
				properties: {},
				additionalProperties: false,
			},
		};
		const prepare = vi.fn(async () => ({
			status: "available" as const,
			fetch: (async () => new Response(null, { status: 404 })) as never,
			key: "synthetic-key",
			cert: "synthetic-cert",
			port: 0,
			runtimeOrigin: "https://runtime.example.test",
			dynamicReader: {
				contract: {
					serviceRef: "connection-fixture",
					contract: {
						ref: "fixture-mcp-contract",
						revision: "r1",
						serverInfo: { name: "fixture", version: "1" },
						tools: [{ name: "write_note" }],
					},
					toolDeclarations: [tool],
				},
				resolveTarget: async () => {
					throw new DynamicConnectionRefusalV1("unavailable");
				},
				resolveInput: async () => undefined,
			},
			close: async () => {},
		}));
		const runtime = await assembleRuntimeHost(values, undefined, {
			prepareConnectionInstall: prepare,
		});
		try {
			expect(prepare).toHaveBeenCalledTimes(1);
			expect(openedWith?.standardConnectionClient).toBeUndefined();
			expect(openedWith?.dynamicConnectionClient).toMatchObject({
				declared: {
					contract: { ref: "fixture-mcp-contract", revision: "r1" },
					tools: [tool],
				},
			});
		} finally {
			await runtime.close();
		}
	});

	it("does not open the install receiver for a Driver without a protected Connection transport", async () => {
		const { values, dataDirectory } = await claudeAssemblyFixture("absent");
		values.AGENT_INFRA_RUNTIME_DRIVER = "pi";
		// No `AGENT_INFRA_RUNTIME_PI_MCP_BRIDGE=verified-v1`: Pi stays without Connection.
		runtimeAssemblyMocks.openPiRuntime.mockImplementation(async () =>
			FakeRuntimeDriver.open(join(dataDirectory, "pi-driver.json")),
		);
		const prepare = vi.fn();
		const runtime = await assembleRuntimeHost(values, undefined, {
			prepareConnectionInstall: prepare as never,
		});
		try {
			expect(prepare).not.toHaveBeenCalled();
		} finally {
			await runtime.close();
		}
	});

	it.each(["absent", "unavailable"] as const)(
		"keeps Claude protected MCP fail-closed when installation is %s",
		async (installation) => {
			const { values, dataDirectory } =
				await claudeAssemblyFixture(installation);
			let openedWith: ClaudeRuntimeDriverOptions | undefined;
			runtimeAssemblyMocks.openClaudeRuntimeDriver.mockImplementation(
				async (options: ClaudeRuntimeDriverOptions) => {
					openedWith = options;
					return FakeRuntimeDriver.open(
						join(dataDirectory, "claude-driver.json"),
					);
				},
			);
			let runtime: Awaited<ReturnType<typeof assembleRuntimeHost>> | undefined;
			try {
				runtime = await assembleRuntimeHost(values);
				expect(openedWith).toBeDefined();
				if (openedWith?.standardConnectionClient) {
					await expect(
						openedWith.standardConnectionClient.resolveInput(
							reference,
							new AbortController().signal,
						),
					).rejects.toMatchObject({
						code: "CONNECTION_STANDARD_CLIENT_UNAVAILABLE",
					});
				}
			} finally {
				await runtime?.close();
			}
		},
	);

	it("passes an explicitly injected Browser context factory to RuntimeHost", async () => {
		const env = await environment();
		const factory = vi.fn();
		const runtime = await assembleRuntimeHost(env, undefined, {
			createBrowserExecutionContext: factory,
		});
		try {
			const options = (
				runtime.host as unknown as {
					options: { createBrowserExecutionContext?: unknown };
				}
			).options;
			expect(options.createBrowserExecutionContext).toBe(factory);
		} finally {
			await runtime.close();
		}
	});

	it("assembles the deployment-owned native metadata reader", async () => {
		const env = await environment();
		const resolveContext = vi.fn(async () => null);
		const runtime = await assembleRuntimeHost(env, undefined, {
			nativeMetadataRead: { resolveContext },
		});
		try {
			expect(runtime.nativeMetadataRead).toEqual(expect.any(Function));
		} finally {
			await runtime.close();
		}
	});

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
	it.each(["available", "absent", "shared"] as const)(
		"assembles, starts and closes the callback-only OAuth receiver with material=%s",
		async (material) => {
			const values = await environment();
			values.AGENT_INFRA_RUNTIME_DATA_DIR = await realpath(
				values.AGENT_INFRA_RUNTIME_DATA_DIR,
			);
			runtimeAssemblyMocks.verifyCodexPilotInstallation.mockResolvedValue({});
			runtimeAssemblyMocks.openCodexRuntimeDriver.mockImplementation(() =>
				FakeRuntimeDriver.open(
					join(values.AGENT_INFRA_RUNTIME_DATA_DIR, "oauth-driver.json"),
				),
			);
			const tls = await runtimeTlsFixture();
			directories.push(tls.directory);
			const reserve = createNetServer();
			await new Promise<void>((resolve) =>
				reserve.listen(0, "127.0.0.1", resolve),
			);
			const oauthPort = (reserve.address() as AddressInfo).port;
			await new Promise<void>((resolve) => reserve.close(() => resolve()));
			const profile = {
				schemaVersion: 1 as const,
				publicOrigin: "https://connection.example.test",
				mcpPath: "/mcp",
				consumerId: "platform",
				audience: "fixture-resource",
				egressProfile: { ref: "fixture-egress", revision: "r1" },
			};
			const approval = {
				schemaVersion: 1 as const,
				configFingerprint: connectionConsumerProfileFingerprintV1(profile),
				source: { ref: "fixture-deployment", revision: "r1" },
				egressEnforced: true as const,
			};
			const consumerFile = join(
				values.AGENT_INFRA_RUNTIME_DATA_DIR,
				"consumer.json",
			);
			await writeFile(consumerFile, JSON.stringify({ profile, approval }));
			const oauthFile = join(values.AGENT_INFRA_RUNTIME_DATA_DIR, "oauth.json");
			await writeFile(
				oauthFile,
				JSON.stringify({
					schemaVersion: 1,
					ref: "fixture-oauth",
					revision: "r1",
					clientId: "fixture-client",
					issuer: "https://connection.example.test/",
					authorizationEndpoint:
						"https://connection.example.test/oauth/authorize",
					tokenEndpoint: "https://connection.example.test/oauth/token",
					revocationEndpoint: "https://connection.example.test/oauth/revoke",
					callbackUrl: "https://platform.example.test/connection/callback",
					runtimeOrigin: `https://localhost:${oauthPort}/`,
					resource: "https://connection.example.test/mcp",
					scope: "mcp",
					configFingerprint: approval.configFingerprint,
					source: approval.source,
				}),
			);
			const tlsDirectory = join(
				values.AGENT_INFRA_RUNTIME_DATA_DIR,
				"codex-driver.json.native",
				"conversations",
				"standard-mcp-oauth",
				"tls",
			);
			await mkdir(tlsDirectory, { recursive: true, mode: 0o700 });
			await writeFile(join(tlsDirectory, "server.crt"), tls.cert, {
				mode: 0o400,
			});
			await writeFile(join(tlsDirectory, "server.key"), tls.key, {
				mode: 0o400,
			});
			const callbackToken = "synthetic-callback-material-123";
			if (material !== "absent")
				await writeFile(
					join(tlsDirectory, "callback.auth"),
					material === "shared"
						? values.AGENT_INFRA_RUNTIME_SERVICE_TOKEN
						: callbackToken,
					{ mode: 0o400 },
				);
			const runtime = await assembleRuntimeHost({
				...values,
				AGENT_INFRA_RUNTIME_DRIVER: "codex",
				AGENT_INFRA_RUNTIME_AGENT_ID: "synthetic-agent",
				AGENT_INFRA_RUNTIME_WORKER_ID: "synthetic-worker",
				AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_FILE: consumerFile,
				AGENT_INFRA_RUNTIME_CONNECTION_CONSUMER_REVISION: JSON.stringify([
					approval.configFingerprint,
					approval.source.ref,
					approval.source.revision,
				]),
				AGENT_INFRA_RUNTIME_CONNECTION_OAUTH_FILE: oauthFile,
				AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_RECEIVER: "v1",
				AGENT_INFRA_RUNTIME_SANDBOX_ID: "synthetic-sandbox",
				AGENT_INFRA_RUNTIME_POD_UID: "synthetic-pod",
				AGENT_INFRA_RUNTIME_SESSION_GENERATION: "1",
				AGENT_INFRA_RUNTIME_PRINCIPAL: JSON.stringify({
					kind: "user",
					id: "alice",
				}),
				AGENT_INFRA_RUNTIME_MODEL_CREDENTIAL_PRIMARY: "synthetic-credential",
				AGENT_INFRA_RUNTIME_MODEL_CONFIG: JSON.stringify({
					schemaVersion: 2,
					configVersion: "fixture-model",
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
			});
			const getOAuth = (path: string, token: string) =>
				new Promise<number>((resolve, reject) => {
					const request = httpsRequest(
						`https://localhost:${oauthPort}/internal/runtime/oauth/v1/${path}`,
						{
							ca: tls.ca,
							family: 4,
							agent: false,
							headers: { authorization: `Bearer ${token}` },
						},
						(response) => {
							response.resume();
							response.on("end", () => resolve(response.statusCode ?? 0));
						},
					);
					request.setTimeout(2000, () =>
						request.destroy(new Error("Test HTTPS timeout")),
					);
					request.on("error", reject);
					request.end();
				});
			try {
				expect(runtime.oauth?.status).toBe(
					material === "available" ? "available" : "unavailable",
				);
				const ready = Promise.withResolvers<string>();
				const server = startRuntimeHost({
					...runtime,
					port: 0,
					log: ready.resolve,
				});
				try {
					await ready.promise;
					const address = server.address();
					if (!address || typeof address === "string")
						throw new Error("Missing port");
					expect(
						(await fetch(`http://127.0.0.1:${address.port}/healthz`)).status,
					).toBe(200);
					const refused = await fetch(
						`http://127.0.0.1:${address.port}/internal/runtime/v1/stops`,
						{
							method: "POST",
							headers: { authorization: `Bearer ${callbackToken}` },
							body: "{}",
						},
					);
					expect(refused.status).toBe(401);
					if (material === "available") {
						// GET checks route authentication without creating an OAuth transaction.
						expect(await getOAuth("callback", callbackToken)).toBe(404);
						expect(
							await getOAuth(
								"callback",
								values.AGENT_INFRA_RUNTIME_SERVICE_TOKEN,
							),
						).toBe(503);
						expect(await getOAuth("begin", callbackToken)).toBe(503);
						expect(
							await getOAuth("begin", values.AGENT_INFRA_RUNTIME_SERVICE_TOKEN),
						).toBe(404);
					} else {
						await expect(
							getOAuth("callback", callbackToken),
						).rejects.toMatchObject({ code: "ECONNREFUSED" });
					}
				} finally {
					await closeRuntimeHost(server, runtime.close);
				}
				await expect(getOAuth("callback", callbackToken)).rejects.toMatchObject(
					{ code: "ECONNREFUSED" },
				);
				if (runtime.oauth?.status === "available")
					await expect(
						runtime.oauth.client.callback({
							schemaVersion: 1,
							state: "a".repeat(64),
							issuer: "https://connection.example.test/",
							error: "access_denied",
						}),
					).rejects.toMatchObject({ code: "CONNECTION_OAUTH_UNAVAILABLE" });
			} finally {
				await tls.cleanup();
			}
		},
	);

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
				const nativeContext = {
					schemaVersion: 6 as const,
					requestId: "compact-request",
					traceId: "compact-trace",
					principal: { kind: "user" as const, id: "synthetic-user" },
					executionSource: "web" as const,
					agentId: "synthetic-agent",
					channelId: "web",
					conversationId: "compact-conversation",
					executionId: "compact-execution",
					turnId: "compact-turn",
					sessionGeneration: 1,
					hostSessionRef: "compact-host",
					operation: {
						kind: "execution" as const,
						id: "compact-execution",
						deliveryFence: 1,
						executionDeliveryFence: 1,
					},
					keyBinding: {
						purpose: "personal" as const,
						subjectId: "synthetic-user",
						ciphertextRef: "synthetic-key-ref",
						version: 1,
					},
					capabilityId: "c".repeat(64),
					capabilityKind: "command" as const,
					directoryRevision: "d".repeat(64),
					parameters: "",
					parametersDigest: createHash("sha256").update("").digest("hex"),
					capabilitySourceVersion: "0.153.0",
					selection: {
						schemaVersion: 1 as const,
						modelOptionId: "model-option-primary",
						reasoningLevel: "high",
					},
					configVersion: "configuration-4-fingerprint",
				};
				const boundary = {
					schemaVersion: 1 as const,
					principal: nativeContext.principal,
					agentId: nativeContext.agentId,
					channelId: "web",
					agentAuthorizationRevision: "auth-4",
					identityRevision: "identity-4",
					accessSources: [{ kind: "user" as const, userId: "synthetic-user" }],
				};
				const authority = {
					conversationId: nativeContext.conversationId,
					principal: nativeContext.principal,
					executionSource: nativeContext.executionSource,
					agentId: nativeContext.agentId,
					actorId: nativeContext.principal.id,
					channelId: "web",
					authorizationRevision: "auth-4",
					sessionGeneration: 1,
					hostSessionRef: nativeContext.hostSessionRef,
				};
				const useCase = createNativeCapabilityAdmissionUseCaseV6({
					authorization: {
						authorize: async () => ({
							outcome: "allowed",
							authority,
							taskAuthority: {
								schemaVersion: 1,
								actorId: authority.actorId,
								agentId: authority.agentId,
								channelId: "web",
								authorizationRevision: "auth-4",
								supportsSupplementaryInstruction: false,
								taskBoundary: boundary,
							},
							keyBinding: nativeContext.keyBinding,
							modelConfigurationRevision: 4,
						}),
					},
					transaction: {
						admitNativeCapabilityV6: async (input) => ({
							outcome: "accepted",
							plan: input.plan,
						}),
					},
				});
				const admitted = await useCase.admit(nativeContext, {
					schemaVersion: 3,
					conversationId: nativeContext.conversationId,
					capabilityId: nativeContext.capabilityId,
					directoryRevision: nativeContext.directoryRevision,
					parameters: "",
					selection: nativeContext.selection,
					idempotencyKey: "compact-key",
					requestId: nativeContext.requestId,
					traceId: nativeContext.traceId,
				});
				if (admitted.outcome !== "accepted")
					throw new Error("expected compact plan");
				expect(admitted.plan.configVersion).toBe("configuration-4-fingerprint");
				expect(admitted.plan.modelConfigurationRevision).toBe(4);
				const native = RuntimeNativeCapabilityRequestV6Schema.parse({
					...nativeContext,
					configVersion: admitted.plan.configVersion,
					grant: {
						schemaVersion: 6,
						format: "runtime-execution-jws",
						token: "a.b.c",
					},
				});
				const signedNative = {
					...native,
					grant: await signer.signV6(native, "synthetic-authorization"),
				};
				await expect(
					runtime.verifyGrantV6?.(signedNative),
				).resolves.toMatchObject({
					request: { configVersion: "configuration-4-fingerprint" },
				});
				for (const configVersion of [
					"4",
					"configuration-3-old",
					"configuration-4-wrong",
				]) {
					const wrong = { ...native, configVersion };
					await expect(
						runtime.verifyGrantV6?.({
							...wrong,
							grant: await signer.signV6(wrong, "synthetic-authorization"),
						}),
					).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });
				}
				await expect(
					runtime.verifyGrantV6?.({
						...signedNative,
						conversationId: "other-conversation",
					}),
				).rejects.toMatchObject({ code: "RUNTIME_GRANT_INVALID" });

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
				const toolAction = {
					...action,
					kind: "tool" as const,
					toolId: "workspace.read_text_file",
				};
				const protection = vi.mocked(assertStandardMcpProcessProtection);
				const previousProtection = protection.getMockImplementation();
				protection.mockClear();
				protection.mockImplementation(() => {
					throw new Error(
						"synthetic Connection process protection unavailable",
					);
				});
				try {
					const local = await openedWith?.authorizeExternalAction?.(toolAction);
					expect(() => local?.revalidate?.()).not.toThrow();
					expect(revalidate).toHaveBeenCalledOnce();
					expect(protection).not.toHaveBeenCalled();
					const connection = await openedWith?.authorizeExternalAction?.({
						...toolAction,
						toolId: "mcp:synthetic-connection-tool",
					});
					expect(() => connection?.revalidate?.()).toThrow(
						"synthetic Connection process protection unavailable",
					);
				} finally {
					protection.mockReset();
					if (previousProtection)
						protection.mockImplementation(previousProtection);
				}
			} finally {
				await runtime.close();
			}
		},
	);

	it("restarts a Codex Host killed before native storage existed and blocks the Session", async () => {
		// #3174：首条 Turn 已在 Host 与 Driver 中持久化为 prepared，但原生进程尚未启动、
		// `codex-driver.json.native` 尚未创建时进程被杀。重启后 RuntimeHost 必须能启动，
		// 原 Execution 为 unknown，同会话的新 Turn 得到持久的 RUNTIME_SESSION_BLOCKED。
		const values = await environment();
		const killedDirectory = await realpath(values.AGENT_INFRA_RUNTIME_DATA_DIR);
		const restartedRoot = await mkdtemp(join(tmpdir(), "runtime-restarted-"));
		directories.push(restartedRoot);
		const restartedDirectory = join(await realpath(restartedRoot), "data");
		const configured = (dataDirectory: string) => ({
			...values,
			AGENT_INFRA_RUNTIME_DATA_DIR: dataDirectory,
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
		runtimeAssemblyMocks.verifyCodexPilotInstallation.mockResolvedValue({
			protocolVersion: 2,
			codexVersion: "synthetic-codex",
			upstreamTag: "synthetic-tag",
			upstreamCommit: "synthetic-commit",
			schemaSha256: "synthetic-schema-sha256",
		});
		const signer = createWorkerRuntimeGrantSignerV4({
			issuer: "synthetic-platform",
			workerId: "synthetic-worker",
			keyId: "synthetic-key",
			privateKey,
		});
		const submission = (executionId: string) => {
			const request = RuntimeSubmitTurnRequestV4Schema.parse({
				schemaVersion: 4,
				requestId: `${executionId}-request`,
				traceId: `${executionId}-trace`,
				principal: { kind: "user", id: "alice" },
				executionSource: "web",
				channelId: "web",
				agentId: "synthetic-agent",
				conversationId: "restart-conversation",
				executionId,
				turnId: `${executionId}-turn`,
				sessionGeneration: 1,
				hostSessionRef: null,
				operation: {
					kind: "execution",
					id: executionId,
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
				input: { text: "restart-input", attachments: [] },
				selection: {
					schemaVersion: 1,
					modelOptionId: "model-option-primary",
					reasoningLevel: "high",
				},
			});
			return {
				...request,
				grant: signer.sign(request, "synthetic-authorization"),
			};
		};
		const transport = async (
			runtime: Awaited<ReturnType<typeof assembleRuntimeHost>>,
			request: ReturnType<typeof submission>,
		) => {
			const verified = await runtime.verifyGrantV4?.(request);
			if (!verified) throw new Error("Missing V4 Grant verifier");
			return {
				businessRequest: request,
				privateKeyField: {
					schemaVersion: 1 as const,
					context: {
						requestId: request.requestId,
						grantId: verified.claims.grantId,
						requestDigest: verified.claims.requestDigest,
						traceId: request.traceId,
						principal: request.principal,
						executionSource: request.executionSource,
						channelId: request.channelId,
						agentId: request.agentId,
						conversationId: request.conversationId,
						executionId: request.executionId,
						turnId: request.turnId,
						sessionGeneration: request.sessionGeneration,
						hostSessionRef: request.hostSessionRef,
						operation: request.operation,
						keyBinding: request.keyBinding,
					},
					keyDelivery: { relayKey: "synthetic-relay-key" },
				},
			};
		};
		const nativeStorageAbsent = (dataDirectory: string) =>
			expect(
				stat(join(dataDirectory, "codex-driver.json.native")),
			).rejects.toMatchObject({ code: "ENOENT" });
		const first = submission("execution-before-native");

		const launch = Promise.withResolvers<never>();
		let launches = 0;
		runtimeAssemblyMocks.openCodexRuntimeDriver.mockImplementation(
			(options: CodexRuntimeDriverOptions) =>
				PendingNativeLaunchCodexDriver.openPendingLaunch(options, () => {
					launches += 1;
					return launch.promise;
				}),
		);
		const killed = await assembleRuntimeHost(configured(killedDirectory));
		try {
			const pending = killed.host
				.submitTurnV4(await transport(killed, first))
				.catch(() => undefined);
			await vi.waitFor(() => expect(launches).toBe(1));
			await nativeStorageAbsent(killedDirectory);
			// 进程被杀那一刻 PVC 上的全部文件；原进程之后的写入不可见。
			await cp(killedDirectory, restartedDirectory, { recursive: true });
			launch.reject(new Error("synthetic killed process"));
			await pending;
		} finally {
			await killed.close();
		}
		const killedHost = JSON.parse(
			await readFile(join(restartedDirectory, "host.json"), "utf8"),
		);
		const killedSessions = Object.values(killedHost.sessions) as {
			hostSessionRef: string;
			nativeSessionRef?: string;
			operations: Record<string, { state: string }>;
		}[];
		expect(killedSessions).toHaveLength(1);
		const [killedSession] = killedSessions;
		expect(killedSession?.nativeSessionRef).toBeUndefined();
		expect(killedSession?.operations["execution-before-native"]?.state).toBe(
			"prepared",
		);
		expect(
			Object.values(
				JSON.parse(
					await readFile(join(restartedDirectory, "codex-driver.json"), "utf8"),
				).operations,
			),
		).toEqual([expect.objectContaining({ state: "prepared" })]);

		runtimeAssemblyMocks.openCodexRuntimeDriver.mockImplementation(
			(options: CodexRuntimeDriverOptions) =>
				actualMessageRuntimes.CodexRuntimeDriver.open(options),
		);
		const restarted = await assembleRuntimeHost(configured(restartedDirectory));
		try {
			const hostSessionRef = killedSession?.hostSessionRef;
			expect(
				await restarted.host.submitTurnV4(await transport(restarted, first)),
			).toEqual({
				schemaVersion: 4,
				hostSessionRef,
				operationId: "execution-before-native",
				result: {
					outcome: "unknown",
					code: "RUNTIME_ACCEPTANCE_UNKNOWN",
					message: "Runtime command acceptance could not be confirmed",
				},
			});
			const next = submission("execution-after-restart");
			const blocked = {
				schemaVersion: 4,
				hostSessionRef,
				operationId: "execution-after-restart",
				result: {
					outcome: "rejected",
					code: "RUNTIME_SESSION_BLOCKED",
					message: "Runtime session is blocked by an unconfirmed turn",
					retryable: false,
				},
			};
			expect(
				await restarted.host.submitTurnV4(await transport(restarted, next)),
			).toEqual(blocked);
			expect(
				await restarted.host.submitTurnV4(await transport(restarted, next)),
			).toEqual(blocked);
			const restartedHost = JSON.parse(
				await readFile(join(restartedDirectory, "host.json"), "utf8"),
			);
			expect(
				restartedHost.sessions[hostSessionRef ?? ""]?.operations,
			).toMatchObject({
				"execution-before-native": {
					state: "resolved",
					result: { outcome: "unknown", code: "RUNTIME_ACCEPTANCE_UNKNOWN" },
				},
				"execution-after-restart": {
					state: "resolved",
					result: blocked.result,
				},
			});
			await nativeStorageAbsent(restartedDirectory);
		} finally {
			await restarted.close();
		}
	});

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

it("keeps production evidence absent and explicitly assembles it from consumed V2 identity and authenticated runner facts", async () => {
	const f = await sessionExecutorFixture();
	const directory = f.values.AGENT_INFRA_RUNTIME_DATA_DIR as string;
	const binding = f.admission.binding;
	const podUid = f.values.AGENT_INFRA_RUNTIME_POD_UID as string;
	const admission = { ...f.admission, podUid };
	runtimeAssemblyMocks.openCodexSessionExecutorAdmission.mockResolvedValue(
		admission,
	);
	const start = {
		schemaVersion: 2 as const,
		purpose: "executor-instance-startup-v2" as const,
		podUid,
		startupRef: "evidence-start",
		bindingDigest: codexSessionExecutorBindingDigestV1(binding),
		expiresAt: Date.now() + 60_000,
		instance: {
			attemptId: randomUUID(),
			recordRef: randomUUID(),
			sandboxId: binding.sandboxId,
			configurationRevision: 1,
			configurationVersion: "session-executor-fixture",
			generation: binding.sessionGeneration,
			resourceFence: binding.resourceFence,
		},
	};
	const material = issueExecutorStartIdentityV1(start, privateKey);
	const runner = verifyExecutorStartIdentityV1(material.runner, {
		...start,
		issuerKey: publicKey,
		role: "runner",
		now: Date.now(),
	});
	const identityPath = join(directory, "identity-for-evidence.json");
	await writeFile(identityPath, JSON.stringify(material.host), { mode: 0o400 });
	executorIdentityPaths.set(
		join(executorIdentityFileRootV1, executorIdentityFileV1),
		identityPath,
	);
	Object.assign(f.values, {
		AGENT_INFRA_EXECUTOR_STARTUP_REF: start.startupRef,
		AGENT_INFRA_EXECUTOR_STARTUP_DEADLINE: String(start.expiresAt),
	});
	const businessEmpty = vi.fn(() => true);
	const openDriver =
		runtimeAssemblyMocks.openCodexRuntimeDriver.getMockImplementation();
	runtimeAssemblyMocks.openCodexRuntimeDriver.mockImplementation(
		async (...args) =>
			Object.assign(await openDriver?.(...args), {
				isBusinessStateEmpty: businessEmpty,
			}),
	);
	const transport = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (url, options) => {
			const path = new URL(String(url)).pathname;
			expect(["/control/status", "/control/session-instance/read"]).toContain(
				path,
			);
			const request = verifyExecutorControlV1(
				runner,
				path,
				JSON.parse(String(options?.body)),
			);
			if (!request) throw new Error("invalid runner channel");
			return Response.json(
				signExecutorControlV1(
					runner,
					`${path}/result`,
					{
						epoch: admission.epoch,
						runnerIdentityConsumed: true,
						deliveryFilesRemoved: true,
						executorReady: true,
						emptyBusinessState: true,
					},
					request.requestId,
					request.deadline,
				),
			);
		});
	let runtime: Awaited<ReturnType<typeof assembleRuntimeHost>> | undefined;
	try {
		runtime = await assembleRuntimeHost(f.values, undefined, {
			sessionInstanceEvidence: {
				profileDigest: "b".repeat(64),
				hostKeyId: "original-host-key",
			},
		});
		expect(runtime.sessionInstanceRead).toBeTypeOf("function");
		const body: SessionInstanceReadRequestV1 = {
			schemaVersion: 1,
			requestId: randomUUID(),
			traceId: randomUUID(),
			nonce: randomUUID(),
			workerId: "worker-a",
			namespace: binding.namespace,
			agentId: binding.agentId,
			sessionId: binding.conversationId,
			sandboxId: binding.sandboxId,
			podUid,
			generation: binding.sessionGeneration,
			resourceFence: binding.resourceFence,
			startupRef: start.startupRef,
			bindingDigest: start.bindingDigest,
			profileDigest: "b".repeat(64),
			scope: {
				phase: "reserve",
				reserveRef: "reserve-original",
				reserveDeliveryFence: 1,
			},
			authorization: "e30.e30.AA",
		};
		const at = Date.now();
		const claims = {
			issuer: "synthetic-platform",
			audience: "runtime_host_session_instance",
			purpose: "session-instance-read-v1",
			workerId: "worker-a",
			issuedAt: at,
			expiresAt: at + 10_000,
			requestDigest: createHash("sha256")
				.update(
					sessionInstanceReadSigningPayloadV1(
						Object.fromEntries(
							Object.entries(body).filter(([key]) => key !== "authorization"),
						),
					),
				)
				.digest("hex"),
		};
		const bytes = [
			JSON.stringify({
				alg: "EdDSA",
				typ: "session-instance-read-v1",
				kid: "synthetic-key",
			}),
			JSON.stringify(claims),
		]
			.map((value) => Buffer.from(value).toString("base64url"))
			.join(".");
		body.authorization = `${bytes}.${sign(null, Buffer.from(bytes), privateKey).toString("base64url")}`;
		expect(await runtime.sessionInstanceRead?.(body)).toMatchObject({
			runnerEpoch: admission.epoch,
			hostKeyId: "original-host-key",
			checks: { emptyBusinessState: true },
		});
	} finally {
		await runtime?.close();
		executorIdentityPaths.clear();
		transport.mockRestore();
	}
});

describe("safety evidence window assembly (#4358 I1b, default off)", () => {
	const window = {
		schemaVersion: 1,
		windowRef: "window-1",
		opensAt: "2026-11-22T00:00:00.000Z",
		closesAt: "2026-11-22T02:00:00.000Z",
		agentIds: ["agent-1"],
		principalRefs: ["p1-principal"],
		scenarios: [
			{
				id: "u1-file",
				version: 1,
				resourceClasses: ["file"],
				actionClasses: ["read"],
			},
		],
		producers: [{ kind: "native_helper", version: "u1-helper-1" }],
	};

	it("assembles no evidence log without a window", async () => {
		const { readdir } = await import("node:fs/promises");
		const values = await environment();
		const runtime = await assembleRuntimeHost(values);
		try {
			expect(runtime.safetyEvidence).toBeUndefined();
			expect(await readdir(values.AGENT_INFRA_RUNTIME_DATA_DIR)).not.toContain(
				"safety-evidence.json",
			);
		} finally {
			await runtime.close();
		}
	});

	it("opens a separate log for a valid window and stays up with evidence off for an invalid one", async () => {
		const { readdir } = await import("node:fs/promises");
		const enabled = await environment();
		const runtime = await assembleRuntimeHost({
			...enabled,
			AGENT_INFRA_RUNTIME_SAFETY_EVIDENCE_WINDOW: JSON.stringify(window),
		});
		try {
			expect(runtime.safetyEvidence).toBeDefined();
			expect(await readdir(enabled.AGENT_INFRA_RUNTIME_DATA_DIR)).toEqual(
				expect.arrayContaining(["host.json", "safety-evidence.json"]),
			);
		} finally {
			await runtime.close();
		}
		const warnings: unknown[] = [];
		const warn = vi
			.spyOn(console, "warn")
			.mockImplementation((value) => warnings.push(value));
		try {
			const invalid = await environment();
			const degraded = await assembleRuntimeHost({
				...invalid,
				AGENT_INFRA_RUNTIME_SAFETY_EVIDENCE_WINDOW: JSON.stringify({
					...window,
					windowRef: "canary-window-ref",
					closesAt: window.opensAt,
				}),
			});
			try {
				expect(degraded.safetyEvidence).toBeUndefined();
			} finally {
				await degraded.close();
			}
		} finally {
			warn.mockRestore();
		}
		expect(warnings).toEqual([
			JSON.stringify({
				service: "agent-runtime-host",
				code: "RUNTIME_SAFETY_EVIDENCE_WINDOW_INVALID",
			}),
		]);
	});
});

// #4199: the independent executor window renders the §13.5.6 receiver into the
// same Host container (connection-install-bootstrap.ts); the Host must start in
// both executor admission modes, with or without the initializer's materials.
describe("Connection install receiver in the Session executor window", () => {
	const unavailableLine = JSON.stringify({
		service: "agent-runtime-host",
		code: "CONNECTION_INSTALL_RECEIVER_UNAVAILABLE",
	});

	async function freePort(exclude?: number) {
		for (;;) {
			const reserve = createNetServer();
			await new Promise<void>((resolve) =>
				reserve.listen(0, "127.0.0.1", resolve),
			);
			const { port } = reserve.address() as AddressInfo;
			await new Promise<void>((resolve) => reserve.close(() => resolve()));
			if (port !== exclude) return port;
		}
	}

	function portOpen(port: number) {
		return new Promise<boolean>((resolve) => {
			const socket = netConnect(port, "127.0.0.1");
			socket.once("connect", () => {
				socket.destroy();
				resolve(true);
			});
			socket.once("error", () => resolve(false));
		});
	}

	async function waitForPort(port: number) {
		for (let attempt = 0; attempt < 100; attempt++) {
			if (await portOpen(port)) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		throw new Error("install listener did not start");
	}

	function healthz(port: number) {
		return new Promise<number>((resolve, reject) => {
			httpGet(
				{ host: "127.0.0.1", port, path: "/healthz", agent: false },
				(response) => {
					response.resume();
					response.on("end", () => resolve(response.statusCode ?? 0));
				},
			).once("error", reject);
		});
	}

	/** TLS 1.3 handshake that verifies the deployment certificate for the Sandbox Service name. */
	function handshake(port: number, servername: string, ca: string) {
		return new Promise<boolean>((resolve) => {
			const socket = tlsConnect(
				{ host: "127.0.0.1", port, servername, ca, minVersion: "TLSv1.3" },
				() => {
					const authorized = socket.authorized;
					socket.destroy();
					resolve(authorized);
				},
			);
			socket.once("error", () => resolve(false));
		});
	}

	async function executorWindow(identity: "admission" | "startup-v2") {
		const f = await sessionExecutorFixture();
		// Protected Host files require a canonical data directory (macOS tmpdir is a symlink).
		const directory = await realpath(
			f.values.AGENT_INFRA_RUNTIME_DATA_DIR as string,
		);
		f.values.AGENT_INFRA_RUNTIME_DATA_DIR = directory;
		const binding = f.admission.binding;
		const podUid = f.values.AGENT_INFRA_RUNTIME_POD_UID as string;
		const admission = { ...f.admission, podUid };
		runtimeAssemblyMocks.openCodexSessionExecutorAdmission.mockResolvedValue(
			admission,
		);
		let restore = () => {};
		if (identity === "startup-v2") {
			const start = {
				schemaVersion: 2 as const,
				purpose: "executor-instance-startup-v2" as const,
				podUid,
				startupRef: "receiver-window-start",
				bindingDigest: codexSessionExecutorBindingDigestV1(binding),
				expiresAt: Date.now() + 60_000,
				instance: {
					attemptId: randomUUID(),
					recordRef: randomUUID(),
					sandboxId: binding.sandboxId,
					configurationRevision: 1,
					configurationVersion: "session-executor-fixture",
					generation: binding.sessionGeneration,
					resourceFence: binding.resourceFence,
				},
			};
			const material = issueExecutorStartIdentityV1(start, privateKey);
			const runner = verifyExecutorStartIdentityV1(material.runner, {
				...start,
				issuerKey: publicKey,
				role: "runner",
				now: Date.now(),
			});
			const identityPath = join(directory, "receiver-window-startup.json");
			await writeFile(identityPath, JSON.stringify(material.host), {
				mode: 0o400,
			});
			executorIdentityPaths.set(
				join(executorIdentityFileRootV1, executorIdentityFileV1),
				identityPath,
			);
			Object.assign(f.values, {
				AGENT_INFRA_EXECUTOR_STARTUP_REF: start.startupRef,
				AGENT_INFRA_EXECUTOR_STARTUP_DEADLINE: String(start.expiresAt),
			});
			const transport = vi
				.spyOn(globalThis, "fetch")
				.mockImplementation(async (url, options) => {
					const path = new URL(String(url)).pathname;
					const request = verifyExecutorControlV1(
						runner,
						path,
						JSON.parse(String(options?.body)),
					);
					if (!request) throw new Error("invalid runner channel");
					return Response.json(
						signExecutorControlV1(
							runner,
							`${path}/result`,
							{
								epoch: admission.epoch,
								runnerIdentityConsumed: true,
								deliveryFilesRemoved: true,
								executorReady: true,
								emptyBusinessState: true,
							},
							request.requestId,
							request.deadline,
						),
					);
				});
			restore = () => {
				executorIdentityPaths.clear();
				transport.mockRestore();
			};
		}
		return { f, directory, binding, admission, restore };
	}

	/** The Worker-rendered receiver input for this Sandbox (connection-install-bootstrap.ts). */
	function receiverEnvironment(
		binding: { podName: string; namespace: string; sandboxId: string } & {
			sessionGeneration: number;
			resourceFence: number;
		},
		port: number,
		mainPort: number,
	) {
		const system = {
			schemaVersion: 1 as const,
			publicOrigin: "https://connection.example.test",
			mcpPath: "/mcp/agents",
			audience: "connection-mcp",
			egressProfile: { ref: "connection-egress", revision: "r1" },
			issuer: "https://connection.example.test/",
			oauthCallbackUrl:
				"https://platform.example.test/api/v1/connection/oauth/callback",
		};
		return {
			PORT: String(mainPort),
			AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_RECEIVER: "v1",
			AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_ORIGIN: `https://${binding.podName}.${binding.namespace}.svc:${port}/`,
			AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_WORKER_ORIGIN: `https://platform-worker.${binding.namespace}.svc:8443/`,
			AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_SYSTEM_ACCESS:
				JSON.stringify(system),
			AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_SYSTEM_ACCESS_APPROVAL:
				JSON.stringify({
					schemaVersion: 1,
					configFingerprint: connectionSystemAccessFingerprintV1(system),
					egressEnforced: true,
					source: { ref: "connection-system-access", revision: "r1" },
				}),
			AGENT_INFRA_RUNTIME_CONNECTION_INSTALL_CLIENT_NAME: "Agent Infra",
			AGENT_INFRA_RUNTIME_SANDBOX_ID: binding.sandboxId,
			AGENT_INFRA_RUNTIME_SESSION_GENERATION: String(binding.sessionGeneration),
			AGENT_INFRA_RUNTIME_RESOURCE_FENCE: String(binding.resourceFence),
		};
	}

	it.each([
		["executor admission", "complete", "admission"],
		["a V2 startup identity", "complete", "startup-v2"],
		["executor admission", "missing", "admission"],
		["a V2 startup identity", "missing", "startup-v2"],
	] as const)(
		"starts the runtime container with %s and %s receiver materials",
		async (_name, materials, identity) => {
			const window = await executorWindow(identity);
			const { f, directory, binding, admission } = window;
			const serviceName = `${binding.podName}.${binding.namespace}.svc`;
			const tls = await runtimeTlsFixture({ dnsNames: [serviceName] });
			const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
			try {
				const port = await freePort();
				const mainPort = await freePort(port);
				const tlsDirectory = join(
					directory,
					"codex-driver.json.native",
					"conversations",
					"standard-mcp-oauth",
					"tls",
				);
				if (materials === "complete") {
					await mkdir(tlsDirectory, { recursive: true, mode: 0o700 });
					for (const [name, text] of Object.entries({
						"server.crt": tls.cert,
						"server.key": tls.key,
						"callback.auth": "synthetic-window-callback-token-0001",
						"install.auth": "synthetic-window-install-token-0001-abcdef",
						"worker-ca.crt": tls.ca,
					}))
						await writeFile(join(tlsDirectory, name), text, { mode: 0o600 });
				} else {
					// The initializer reported RUNTIME_OAUTH_PROVISIONING_UNAVAILABLE and
					// wrote nothing; the Host only sees the bare mount point.
					await mkdir(tlsDirectory, { recursive: true, mode: 0o755 });
				}
				Object.assign(f.values, receiverEnvironment(binding, port, mainPort));
				const ready: string[] = [];
				// Production composition: the same call startFromEnvironment() makes.
				const runtime = await assembleRuntimeHost(f.values);
				const server = startRuntimeHost({
					...runtime,
					log: (line) => ready.push(line),
				});
				try {
					if (!server.listening) await once(server, "listening");
					expect(
						runtimeAssemblyMocks.openCodexRuntimeDriver,
					).toHaveBeenCalledWith(
						expect.objectContaining({
							sessionExecutor: expect.objectContaining({
								epoch: admission.epoch,
							}),
						}),
					);
					expect(f.assertCurrent).toHaveBeenCalled();
					expect(await healthz(mainPort)).toBe(200);
					const receiverLines = warning.mock.calls
						.map(([line]) => String(line))
						.filter((line) => line.includes("CONNECTION_INSTALL_RECEIVER"));
					if (materials === "complete") {
						expect(runtime.connectionInstall?.status).toBe("available");
						await waitForPort(port);
						expect(await handshake(port, serviceName, tls.ca)).toBe(true);
						expect(ready).toContain(
							JSON.stringify({
								service: "agent-runtime-host",
								code: "CONNECTION_INSTALL_RECEIVER_LISTENING",
								port,
							}),
						);
						expect(receiverLines).toEqual([]);
					} else {
						expect(runtime.connectionInstall?.status).toBe("unavailable");
						expect(receiverLines).toEqual([unavailableLine]);
						expect(await portOpen(port)).toBe(false);
					}
				} finally {
					await closeRuntimeHost(server, runtime.close);
				}
				expect(f.closeAdmission).toHaveBeenCalled();
				expect(await portOpen(port)).toBe(false);
			} finally {
				warning.mockRestore();
				window.restore();
				await tls.cleanup();
			}
		},
		30_000,
	);
});
