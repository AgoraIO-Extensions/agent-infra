import { createHash, generateKeyPairSync } from "node:crypto";

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
	return {
		openActivation: vi.fn(() => activationStore),
		openRotation: vi.fn(() => rotationStore),
		activationStore,
		rotationStore,
	};
});

vi.mock("@agent-infra/platform-store", () => ({
	openPostgresSecretActivationStoreV1: storeMocks.openActivation,
	openPostgresSecretKeyRotationStoreV1: storeMocks.openRotation,
}));

import {
	createPlatformSecretActivationWorkerV1,
	createPlatformSecretRotationWorkerV1,
	startPlatformWorker,
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
});
