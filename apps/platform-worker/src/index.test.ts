import { createHash, generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => {
	const activationStore = {
		claimCandidate: vi.fn(),
		close: vi.fn<() => Promise<void>>(),
		commitTransition: vi.fn(),
		recordAudit: vi.fn(),
	};
	const rotationStore = {
		nextCandidate: vi.fn(),
		close: vi.fn<() => Promise<void>>(),
		commitReencryption: vi.fn(),
		recordRejection: vi.fn(),
		retireKey: vi.fn(),
	};
	const dispatchStore = {
		claim: vi.fn(),
		close: vi.fn<() => Promise<void>>(),
		finish: vi.fn(),
		recordRuntimeResponse: vi.fn(),
		renew: vi.fn(),
		retry: vi.fn(),
	};
	const eventTransaction = {
		close: vi.fn<() => Promise<void>>(),
		persistEvent: vi.fn(),
	};
	return {
		openActivation: vi.fn(() => activationStore),
		openDispatch: vi.fn(() => dispatchStore),
		openEvents: vi.fn(
			class {
				readonly close = eventTransaction.close;
				readonly persistEvent = eventTransaction.persistEvent;
			},
		),
		openRotation: vi.fn(() => rotationStore),
		activationStore,
		dispatchStore,
		eventTransaction,
		rotationStore,
	};
});

vi.mock("@agent-infra/platform-store", () => ({
	openPostgresConversationDispatchStoreV1: storeMocks.openDispatch,
	openPostgresSecretActivationStoreV1: storeMocks.openActivation,
	openPostgresSecretKeyRotationStoreV1: storeMocks.openRotation,
	PostgresConversationEventTransactionV1: storeMocks.openEvents,
}));

import {
	createPlatformConversationDispatchWorkerV1,
	createPlatformSecretActivationWorkerV1,
	createPlatformSecretRotationWorkerV1,
	startPlatformWorker,
	startPlatformWorkerFromDeploymentV1,
} from "./index";

const sourceKeyPair = generateKeyPairSync("rsa", { modulusLength: 3072 });
const sourcePublicKey = sourceKeyPair.publicKey.export({
	format: "der",
	type: "spki",
});
const targetKeyPair = generateKeyPairSync("rsa", { modulusLength: 3072 });
const targetPublicKey = targetKeyPair.publicKey.export({
	format: "der",
	type: "spki",
});
const validKeys = [
	{
		keyVersion: "key_01",
		privateKeyPkcs8DerBase64: sourceKeyPair.privateKey
			.export({ format: "der", type: "pkcs8" })
			.toString("base64"),
	},
] as const;
const validRotationKeys = [
	...validKeys,
	{
		keyVersion: "key_02",
		privateKeyPkcs8DerBase64: targetKeyPair.privateKey
			.export({ format: "der", type: "pkcs8" })
			.toString("base64"),
	},
] as const;
const kubernetesClient = {
	async applyCandidateWorkload() {
		return { workloadUid: "workload_01", workloadGeneration: 1 };
	},
	async applyImmutableSecret() {
		return "created" as const;
	},
	async observeCandidateWorkload() {
		return null;
	},
};

const dispatchAuthorization = {
	async authorize() {
		return { outcome: "denied" as const };
	},
};

describe("Conversation dispatch worker assembly", () => {
	beforeEach(() => {
		storeMocks.openDispatch.mockClear();
		storeMocks.openEvents.mockClear();
		storeMocks.dispatchStore.close.mockReset();
		storeMocks.dispatchStore.close.mockResolvedValue();
		storeMocks.eventTransaction.close.mockReset();
		storeMocks.eventTransaction.close.mockResolvedValue();
	});

	it("returns one closable dispatch entrypoint", async () => {
		const worker = createPlatformConversationDispatchWorkerV1({
			databaseUrl: "postgres://test",
			authorization: dispatchAuthorization,
			runtimeHost: {
				baseUrl: "https://runtime.internal",
				serviceToken: "synthetic-service-token",
				fetch: vi.fn<typeof fetch>(),
			},
		});

		expect(Object.keys(worker).toSorted()).toEqual(["close", "dispatch"]);
		await worker.close();
		expect(storeMocks.dispatchStore.close).toHaveBeenCalledOnce();
		expect(storeMocks.eventTransaction.close).toHaveBeenCalledOnce();
	});

	it("closes both Stores when RuntimeHost client validation fails", () => {
		expect(() =>
			createPlatformConversationDispatchWorkerV1({
				databaseUrl: "postgres://test",
				authorization: dispatchAuthorization,
				runtimeHost: {
					baseUrl: "ftp://runtime.invalid",
					serviceToken: "synthetic-service-token",
				},
			}),
		).toThrow("RuntimeHost base URL is invalid");
		expect(storeMocks.dispatchStore.close).toHaveBeenCalledOnce();
		expect(storeMocks.eventTransaction.close).toHaveBeenCalledOnce();
	});
});

describe("Secret activation worker assembly", () => {
	beforeEach(() => {
		storeMocks.openActivation.mockClear();
		storeMocks.activationStore.close.mockReset();
		storeMocks.activationStore.close.mockResolvedValue();
	});

	it.each([
		["keyring", [], 30_000, "Secret keyring is invalid"],
		["lease", validKeys, 0, "Invalid Secret activation command"],
	] as const)(
		"closes the Store when %s validation fails after opening it",
		(_failure, keys, leaseMs, expectedMessage) => {
			storeMocks.activationStore.close.mockRejectedValueOnce(
				new Error("cleanup failure must not replace startup failure"),
			);

			expect(() =>
				createPlatformSecretActivationWorkerV1({
					databaseUrl: "postgres://test",
					kubernetesClient,
					keys,
					leaseMs,
				}),
			).toThrowError(expectedMessage);
			expect(storeMocks.openActivation).toHaveBeenCalledOnce();
			expect(storeMocks.activationStore.close).toHaveBeenCalledOnce();
		},
	);

	it("returns the normal closable worker after successful assembly", async () => {
		const worker = createPlatformSecretActivationWorkerV1({
			databaseUrl: "postgres://test",
			kubernetesClient,
			keys: validKeys,
		});

		await worker.close();

		expect(storeMocks.activationStore.close).toHaveBeenCalledOnce();
	});
});

describe("Secret rotation worker assembly", () => {
	beforeEach(() => {
		storeMocks.openRotation.mockClear();
		storeMocks.rotationStore.close.mockReset();
		storeMocks.rotationStore.close.mockResolvedValue();
	});

	it("returns a closable rotate/retire worker with Worker-only key material", async () => {
		const worker = createPlatformSecretRotationWorkerV1({
			databaseUrl: "postgres://test",
			keys: validRotationKeys,
			encryptionKeys: {
				schemaVersion: 1,
				activeWrappingKeyVersion: "key_02",
				keys: [
					{
						schemaVersion: 1,
						keyVersion: "key_01",
						wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
						publicKeySpkiDerBase64: sourcePublicKey.toString("base64"),
						publicKeyFingerprint: createHash("sha256")
							.update(sourcePublicKey)
							.digest("hex"),
						rsaModulusBits: 3072,
						status: "retiring",
					},
					{
						schemaVersion: 1,
						keyVersion: "key_02",
						wrappingAlgorithmVersion: "rsa-oaep-sha256:v1",
						publicKeySpkiDerBase64: targetPublicKey.toString("base64"),
						publicKeyFingerprint: createHash("sha256")
							.update(targetPublicKey)
							.digest("hex"),
						rsaModulusBits: 3072,
						status: "active",
					},
				],
			},
		});

		expect(Object.keys(worker).toSorted()).toEqual([
			"close",
			"retire",
			"rotate",
		]);
		await worker.close();
		expect(storeMocks.rotationStore.close).toHaveBeenCalledOnce();
		expect(JSON.stringify(worker)).not.toContain("privateKeyPkcs8DerBase64");
	});

	it("closes the Store when rotation key validation fails", () => {
		expect(() =>
			createPlatformSecretRotationWorkerV1({
				databaseUrl: "postgres://test",
				keys: validRotationKeys,
				encryptionKeys: { schemaVersion: 1, keys: [] },
			}),
		).toThrow("Secret rotation keys are invalid");
		expect(storeMocks.rotationStore.close).toHaveBeenCalledOnce();
	});
});

describe("platform worker lifecycle", () => {
	it("reports ready and stops idempotently", () => {
		const messages: string[] = [];
		const worker = startPlatformWorker({
			heartbeatMs: 10,
			log: (message) => messages.push(message),
		});

		worker.stop();
		worker.stop();

		expect(messages.map((message) => JSON.parse(message))).toEqual([
			{ service: "platform-worker", status: "ready" },
			{ service: "platform-worker", status: "stopped" },
		]);
	});

	it("starts and stops the existing and workload loops together", async () => {
		const primary = { stop: vi.fn() };
		const workload = { stop: vi.fn(async () => undefined) };
		const startPrimary = vi.fn(() => primary);
		const startWorkload = vi.fn(async () => workload);

		const worker = await startPlatformWorkerFromDeploymentV1({
			startPrimary,
			startWorkload,
		});
		expect(startPrimary).toHaveBeenCalledOnce();
		expect(startWorkload).toHaveBeenCalledOnce();
		const stopping = worker.stop();
		expect(worker.stop()).toBe(stopping);
		await stopping;
		expect(primary.stop).toHaveBeenCalledOnce();
		expect(workload.stop).toHaveBeenCalledOnce();
	});
	it("still stops the workload loop when the existing loop throws synchronously", async () => {
		const primary = {
			stop: vi.fn(() => {
				throw new Error("primary shutdown failed");
			}),
		};
		const workload = { stop: vi.fn(async () => undefined) };
		const worker = await startPlatformWorkerFromDeploymentV1({
			startPrimary: () => primary,
			startWorkload: async () => workload,
		});

		await expect(worker.stop()).rejects.toThrow("primary shutdown failed");
		expect(primary.stop).toHaveBeenCalledOnce();
		expect(workload.stop).toHaveBeenCalledOnce();
	});

	it("waits for workload shutdown to drain before surfacing a primary failure", async () => {
		const primary = {
			stop: vi.fn(() => {
				throw new Error("primary shutdown failed");
			}),
		};
		let finishWorkloadStop: (() => void) | undefined;
		const workload = {
			stop: vi.fn(
				() =>
					new Promise<void>((resolve) => {
						finishWorkloadStop = resolve;
					}),
			),
		};
		const worker = await startPlatformWorkerFromDeploymentV1({
			startPrimary: () => primary,
			startWorkload: async () => workload,
		});

		let settled = false;
		const stopping = worker.stop().finally(() => {
			settled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(primary.stop).toHaveBeenCalledOnce();
		expect(workload.stop).toHaveBeenCalledOnce();
		expect(settled).toBe(false);
		finishWorkloadStop?.();
		await expect(stopping).rejects.toThrow("primary shutdown failed");
	});

	it("stops the existing loop when workload assembly fails", async () => {
		const primary = { stop: vi.fn() };
		await expect(
			startPlatformWorkerFromDeploymentV1({
				startPrimary: () => primary,
				startWorkload: async () => {
					throw new Error("deployment unavailable");
				},
			}),
		).rejects.toThrow("deployment unavailable");
		expect(primary.stop).toHaveBeenCalledOnce();
	});
	it("preserves the workload assembly failure when primary cleanup also fails", async () => {
		const deploymentFailure = new Error("deployment unavailable");
		const primary = {
			stop: vi.fn(() => {
				throw new Error("primary shutdown failed");
			}),
		};
		await expect(
			startPlatformWorkerFromDeploymentV1({
				startPrimary: () => primary,
				startWorkload: async () => {
					throw deploymentFailure;
				},
			}),
		).rejects.toBe(deploymentFailure);
		expect(primary.stop).toHaveBeenCalledOnce();
	});

	it("handles a rejecting workload shutdown from SIGTERM", async () => {
		const originalArgv = process.argv[1];
		const originalExitCode = process.exitCode;
		const workload = {
			stop: vi.fn(async () => {
				throw new Error("synthetic shutdown failure");
			}),
		};
		const startWorkload = vi.fn(async () => workload);
		const unhandled: unknown[] = [];
		const onUnhandled = (error: unknown) => unhandled.push(error);
		const once = vi.spyOn(process, "once");
		const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
		const error = vi
			.spyOn(console, "error")
			.mockImplementation(() => undefined);
		try {
			vi.resetModules();
			vi.doMock("./workload-worker.js", () => ({
				startPlatformWorkloadWorkerFromDeploymentV1: startWorkload,
			}));
			process.argv[1] = fileURLToPath(new URL("./index.ts", import.meta.url));
			process.exitCode = undefined;
			process.on("unhandledRejection", onUnhandled);

			await import("./index.js");
			process.emit("SIGTERM");
			await new Promise<void>((resolve) => setImmediate(resolve));

			expect(startWorkload).toHaveBeenCalledOnce();
			expect(workload.stop).toHaveBeenCalledOnce();
			expect(process.exitCode).toBe(1);
			expect(unhandled).toEqual([]);
			expect(
				info.mock.calls.map(([message]) => JSON.parse(String(message))),
			).toEqual([
				{ service: "platform-worker", status: "ready" },
				{ service: "platform-worker", status: "stopped" },
			]);
			expect(error).not.toHaveBeenCalled();
		} finally {
			process.off("unhandledRejection", onUnhandled);
			for (const [signal, listener] of once.mock.calls)
				if (signal === "SIGINT" || signal === "SIGTERM")
					process.off(signal, listener);
			if (originalArgv === undefined) process.argv.splice(1, 1);
			else process.argv[1] = originalArgv;
			process.exitCode = originalExitCode;
			vi.doUnmock("./workload-worker.js");
			once.mockRestore();
			info.mockRestore();
			error.mockRestore();
		}
	});
});
