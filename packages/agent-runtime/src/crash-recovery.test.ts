import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

interface MutableStoredOperation {
	command?: unknown;
	kind: string;
	result?: unknown;
	state?: string;
}

interface MutableStoredSession {
	hostSessionRef: string;
	highestFences: Record<string, unknown>;
	operations: Record<string, MutableStoredOperation>;
	generationBarrier?: unknown;
}

interface MutableStoreState {
	sessions: Record<string, MutableStoredSession>;
}

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
	return RuntimeHost.open({
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
		const crashingHost = await host(
			await FileRuntimeStore.open(hostPath),
			driver,
			{
				afterOperationPrepared: () => {
					throw new Error("simulated process exit after durable prepare");
				},
			},
		);

		await expect(crashingHost.submitTurn(request())).rejects.toThrow(
			"simulated process exit",
		);
		expect(await driver.sideEffectCount()).toBe(0);

		const restartedDriver = await FakeRuntimeDriver.open(driverPath);
		const recoveredHost = await RuntimeHost.open({
			store: await FileRuntimeStore.open(hostPath),
			driver: restartedDriver,
			grantVerifier: {
				expectedIssuer: "agent-platform",
				expectedAudience: "agent-runtime-host",
				publicKeys: new Map([["key-crash", publicKey]]),
				now: () => new Date("2026-08-28T10:00:00Z"),
			},
		});
		expect(await restartedDriver.sideEffectCount()).toBe(1);
		const recoveredState = JSON.parse(
			await readFile(hostPath, "utf8"),
		) as MutableStoreState;
		expect(
			Object.values(
				Object.values(recoveredState.sessions)[0]?.operations ?? {},
			)[0],
		).toMatchObject({ state: "resolved", result: { outcome: "accepted" } });
		const recovered = await recoveredHost.submitTurn(request());
		expect(recovered.result).toEqual({
			outcome: "accepted",
			status: "running",
		});
	});

	it("recovers the accepted result after a crash before Host persistence", async () => {
		const root = await directory();
		const hostPath = join(root, "host.json");
		const driverPath = join(root, "driver.json");
		const driver = await FakeRuntimeDriver.open(driverPath);
		const crashingHost = await host(
			await FileRuntimeStore.open(hostPath),
			driver,
			{
				afterDriverResult: () => {
					throw new Error("simulated process exit after Driver acceptance");
				},
			},
		);

		await expect(crashingHost.submitTurn(request())).rejects.toThrow(
			"simulated process exit",
		);
		expect(await driver.sideEffectCount()).toBe(1);

		const restartedDriver = await FakeRuntimeDriver.open(driverPath);
		const recoveredHost = await RuntimeHost.open({
			store: await FileRuntimeStore.open(hostPath),
			driver: restartedDriver,
			grantVerifier: {
				expectedIssuer: "agent-platform",
				expectedAudience: "agent-runtime-host",
				publicKeys: new Map([["key-crash", publicKey]]),
				now: () => new Date("2026-08-28T10:00:00Z"),
			},
		});
		const recoveredState = JSON.parse(
			await readFile(hostPath, "utf8"),
		) as MutableStoreState;
		expect(
			Object.values(
				Object.values(recoveredState.sessions)[0]?.operations ?? {},
			)[0],
		).toMatchObject({ state: "resolved", result: { outcome: "accepted" } });
		const recovered = await recoveredHost.submitTurn(request());
		expect(recovered.result).toEqual({
			outcome: "accepted",
			status: "running",
		});
		expect(await driver.sideEffectCount()).toBe(1);
	});

	it("refreshes nonterminal accepted status during startup without command retry", async () => {
		const root = await directory();
		const hostPath = join(root, "host.json");
		const driverPath = join(root, "driver.json");
		const driver = await FakeRuntimeDriver.open(driverPath);
		await (
			await host(await FileRuntimeStore.open(hostPath), driver)
		).submitTurn(request());
		await driver.setOperationStatus("execution-crash", "completed");

		await RuntimeHost.open({
			store: await FileRuntimeStore.open(hostPath),
			driver: await FakeRuntimeDriver.open(driverPath),
			grantVerifier: {
				expectedIssuer: "agent-platform",
				expectedAudience: "agent-runtime-host",
				publicKeys: new Map([["key-crash", publicKey]]),
				now: () => new Date("2026-08-28T10:00:00Z"),
			},
		});
		const recoveredState = JSON.parse(
			await readFile(hostPath, "utf8"),
		) as MutableStoreState;
		expect(
			Object.values(
				Object.values(recoveredState.sessions)[0]?.operations ?? {},
			)[0],
		).toMatchObject({
			state: "resolved",
			result: { outcome: "accepted", status: "completed" },
		});
	});

	it("persists unknown instead of repeating an unqueryable Driver side effect", async () => {
		const root = await directory();
		const hostPath = join(root, "host.json");
		const driverPath = join(root, "driver.json");
		const driver = await FakeRuntimeDriver.open(driverPath);
		const crashingHost = await host(
			await FileRuntimeStore.open(hostPath),
			driver,
			{
				afterDriverResult: () => {
					throw new Error("simulated lost Driver response");
				},
			},
		);

		await expect(crashingHost.submitTurn(request())).rejects.toThrow(
			"simulated lost Driver response",
		);
		await driver.makeOperationUnknown("execution-crash");

		const recoveredHost = await RuntimeHost.open({
			store: await FileRuntimeStore.open(hostPath),
			driver: await FakeRuntimeDriver.open(driverPath),
			grantVerifier: {
				expectedIssuer: "agent-platform",
				expectedAudience: "agent-runtime-host",
				publicKeys: new Map([["key-crash", publicKey]]),
				now: () => new Date("2026-08-28T10:00:00Z"),
			},
		});
		const unknownState = JSON.parse(
			await readFile(hostPath, "utf8"),
		) as MutableStoreState;
		expect(
			Object.values(
				Object.values(unknownState.sessions)[0]?.operations ?? {},
			)[0],
		).toMatchObject({ state: "resolved", result: { outcome: "unknown" } });
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

	it.each([
		[
			"highest fence",
			(session: MutableStoredSession) => {
				session.highestFences = { "execution:execution-crash": "one" };
			},
		],
		[
			"generation barrier",
			(session: MutableStoredSession) => {
				session.generationBarrier = {
					generation: 0,
					tombstoneId: "",
					state: "confirmed",
				};
			},
		],
		[
			"operation kind",
			(session: MutableStoredSession) => {
				const operation = Object.values(session.operations)[0];
				if (operation) operation.kind = "untrusted-command";
			},
		],
		[
			"operation result",
			(session: MutableStoredSession) => {
				const operation = Object.values(session.operations)[0];
				if (operation) {
					operation.result = { outcome: "accepted", status: "not-a-status" };
				}
			},
		],
		[
			"persisted Driver command",
			(session: MutableStoredSession) => {
				const operation = Object.values(session.operations)[0];
				if (operation) operation.command = { kind: "submit-turn" };
			},
		],
	])(
		"fails closed on parseable nested %s corruption",
		async (_name, corrupt) => {
			const root = await directory();
			const hostPath = join(root, "host.json");
			const runtimeHost = await host(
				await FileRuntimeStore.open(hostPath),
				await FakeRuntimeDriver.open(join(root, "driver.json")),
			);
			await runtimeHost.submitTurn(request());
			const state = JSON.parse(
				await readFile(hostPath, "utf8"),
			) as MutableStoreState;
			const session = Object.values(state.sessions)[0];
			if (!session) throw new Error("expected durable Session fixture");
			corrupt(session);
			await writeFile(hostPath, JSON.stringify(state), "utf8");

			await expect(FileRuntimeStore.open(hostPath)).rejects.toMatchObject({
				code: "RUNTIME_STORE_CORRUPTED",
			});
		},
	);

	it("fails closed when parseable state contains two current Sessions for one Conversation", async () => {
		const root = await directory();
		const hostPath = join(root, "host.json");
		const runtimeHost = await host(
			await FileRuntimeStore.open(hostPath),
			await FakeRuntimeDriver.open(join(root, "driver.json")),
		);
		await runtimeHost.submitTurn(request());
		const state = JSON.parse(
			await readFile(hostPath, "utf8"),
		) as MutableStoreState;
		const session = Object.values(state.sessions)[0];
		if (!session) throw new Error("expected durable Session fixture");
		state.sessions["duplicate-host-session"] = {
			...structuredClone(session),
			hostSessionRef: "duplicate-host-session",
		};
		await writeFile(hostPath, JSON.stringify(state), "utf8");

		await expect(FileRuntimeStore.open(hostPath)).rejects.toMatchObject({
			code: "RUNTIME_STORE_CORRUPTED",
		});
	});
});
