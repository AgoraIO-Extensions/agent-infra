import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	ExecutionGrantClaimsV1,
	RuntimeSubmitTurnRequestV1,
} from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it } from "vitest";

import { FakeRuntimeDriver, FileRuntimeStore, RuntimeHost } from "./index.js";

const directories: string[] = [];
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

async function directory() {
	const value = await mkdtemp(join(tmpdir(), "agent-runtime-crash-"));
	directories.push(value);
	return value;
}

function request(): RuntimeSubmitTurnRequestV1 {
	const claims: ExecutionGrantClaimsV1 = {
		schemaVersion: 1,
		issuer: "agent-platform",
		audience: ["agent-runtime-host"],
		issuedAt: "2026-08-28T09:59:00Z",
		expiresAt: "2026-08-28T10:01:00Z",
		grantId: "grant-crash",
		actorId: "actor-crash",
		channelId: "web",
		agentId: "agent-crash",
		conversationId: "conversation-crash",
		executionId: "execution-crash",
		turnId: "turn-crash",
		sessionGeneration: 1,
		operations: ["turn.submit"],
		attachments: [],
		actionSetVersion: "actions-crash",
	};
	const payload = Buffer.from(JSON.stringify(claims));
	return {
		schemaVersion: 1,
		requestId: "request-crash",
		agentId: claims.agentId,
		conversationId: claims.conversationId,
		executionId: claims.executionId,
		turnId: claims.turnId,
		sessionGeneration: claims.sessionGeneration,
		deliveryFence: 1,
		grant: {
			schemaVersion: 1,
			algorithm: "Ed25519",
			keyId: "key-crash",
			payload: payload.toString("base64url"),
			signature: sign(null, payload, privateKey).toString("base64url"),
		},
		input: { text: "synthetic-crash-input", attachments: [] },
	};
}

function host(
	store: FileRuntimeStore,
	driver: FakeRuntimeDriver,
	hooks: {
		afterOperationPrepared?: () => void;
		afterDriverResult?: () => void;
	} = {},
) {
	return new RuntimeHost({
		store,
		driver,
		grantVerifier: {
			expectedIssuer: "agent-platform",
			expectedAudience: "agent-runtime-host",
			publicKeys: new Map([["key-crash", publicKey]]),
			now: () => new Date("2026-08-28T10:00:00Z"),
		},
		...hooks,
	});
}

afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((value) => rm(value, { recursive: true })),
	);
});

describe("RuntimeHost crash-window recovery", () => {
	it("recovers a prepared operation that crashed before the Driver call", async () => {
		const root = await directory();
		const hostPath = join(root, "host.json");
		const driverPath = join(root, "driver.json");
		const driver = await FakeRuntimeDriver.open(driverPath);
		const crashingHost = host(await FileRuntimeStore.open(hostPath), driver, {
			afterOperationPrepared: () => {
				throw new Error("simulated process exit after durable prepare");
			},
		});

		await expect(crashingHost.submitTurn(request())).rejects.toThrow(
			"simulated process exit",
		);
		expect(await driver.sideEffectCount()).toBe(0);

		const restartedDriver = await FakeRuntimeDriver.open(driverPath);
		const recovered = await host(
			await FileRuntimeStore.open(hostPath),
			restartedDriver,
		).submitTurn(request());
		expect(recovered.result).toEqual({
			outcome: "accepted",
			status: "running",
		});
		expect(await restartedDriver.sideEffectCount()).toBe(1);
	});

	it("recovers the accepted result after a crash before Host persistence", async () => {
		const root = await directory();
		const hostPath = join(root, "host.json");
		const driverPath = join(root, "driver.json");
		const driver = await FakeRuntimeDriver.open(driverPath);
		const crashingHost = host(await FileRuntimeStore.open(hostPath), driver, {
			afterDriverResult: () => {
				throw new Error("simulated process exit after Driver acceptance");
			},
		});

		await expect(crashingHost.submitTurn(request())).rejects.toThrow(
			"simulated process exit",
		);
		expect(await driver.sideEffectCount()).toBe(1);

		const recovered = await host(
			await FileRuntimeStore.open(hostPath),
			await FakeRuntimeDriver.open(driverPath),
		).submitTurn(request());
		expect(recovered.result).toEqual({
			outcome: "accepted",
			status: "running",
		});
		expect(await driver.sideEffectCount()).toBe(1);
	});

	it("persists unknown instead of repeating an unqueryable Driver side effect", async () => {
		const root = await directory();
		const hostPath = join(root, "host.json");
		const driverPath = join(root, "driver.json");
		const driver = await FakeRuntimeDriver.open(driverPath);
		const crashingHost = host(await FileRuntimeStore.open(hostPath), driver, {
			afterDriverResult: () => {
				throw new Error("simulated lost Driver response");
			},
		});

		await expect(crashingHost.submitTurn(request())).rejects.toThrow(
			"simulated lost Driver response",
		);
		await driver.makeOperationUnknown("execution-crash");

		const recoveredHost = host(
			await FileRuntimeStore.open(hostPath),
			await FakeRuntimeDriver.open(driverPath),
		);
		const recovered = await recoveredHost.submitTurn(request());
		expect(recovered.result).toMatchObject({
			outcome: "unknown",
			code: "RUNTIME_ACCEPTANCE_UNKNOWN",
		});
		expect((await recoveredHost.submitTurn(request())).result).toEqual(
			recovered.result,
		);
		expect(await driver.sideEffectCount()).toBe(1);
	});

	it("fails closed when durable Host state is corrupted", async () => {
		const root = await directory();
		const hostPath = join(root, "host.json");
		await writeFile(hostPath, "{incomplete", "utf8");

		await expect(FileRuntimeStore.open(hostPath)).rejects.toMatchObject({
			code: "RUNTIME_STORE_CORRUPTED",
		});
	});
});
