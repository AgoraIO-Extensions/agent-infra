import { generateKeyPairSync } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => {
	const store = {
		claimCandidate: vi.fn(),
		close: vi.fn<() => Promise<void>>(),
		commitTransition: vi.fn(),
		recordAudit: vi.fn(),
	};
	return {
		open: vi.fn(() => store),
		store,
	};
});

vi.mock("@agent-infra/platform-store", () => ({
	openPostgresSecretActivationStoreV1: storeMocks.open,
}));

import {
	createPlatformSecretActivationWorkerV1,
	startPlatformWorker,
} from "./index";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
const validKeys = [
	{
		keyVersion: "key_01",
		privateKeyPkcs8DerBase64: privateKey
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
		storeMocks.open.mockClear();
		storeMocks.store.close.mockReset();
		storeMocks.store.close.mockResolvedValue();
	});

	it.each([
		["keyring", [], 30_000, "Worker Secret keyring is invalid"],
		["lease", validKeys, 0, "Invalid Secret activation command"],
	] as const)(
		"closes the Store when %s validation fails after opening it",
		(_failure, keys, leaseMs, expectedMessage) => {
			storeMocks.store.close.mockRejectedValueOnce(
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
			expect(storeMocks.open).toHaveBeenCalledOnce();
			expect(storeMocks.store.close).toHaveBeenCalledOnce();
		},
	);

	it("returns the normal closable worker after successful assembly", async () => {
		const worker = createPlatformSecretActivationWorkerV1({
			databaseUrl: "postgres://test",
			kubernetesClient,
			keys: validKeys,
		});

		await worker.close();

		expect(storeMocks.store.close).toHaveBeenCalledOnce();
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
