import { sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeRuntimeDriver } from "./fake-runtime-driver.js";
import { FileRuntimeStore, requestDigest } from "./file-runtime-store.js";
import {
	fixtureNow,
	runtimeV2Keys,
	signV3Fixture,
	submitV3Fixture,
	verifyRuntimeV2Fixture,
} from "./grant-v2-fixture.test-support.js";
import { createWorkloadReadinessVerifierV1 } from "./readiness.js";
import { RuntimeHost } from "./runtime-host.js";

const directories: string[] = [];
afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "runtime-lifecycle-"));
	directories.push(directory);
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	const store = await FileRuntimeStore.open(join(directory, "host.json"));
	const binding = {
		workerId: "worker-fixture",
		agentId: "agent-fixture",
		workloadRevision: 1,
		fence: 1,
		imageDigest: `sha256:${"a".repeat(64)}`,
	};
	const request = {
		schemaVersion: 1 as const,
		...binding,
		requestId: "readiness-fixture",
		traceId: "trace-fixture",
	};
	const prefix = [
		{ alg: "EdDSA", kid: "fixture", typ: "workload-readiness+jws" },
		{
			...request,
			issuer: "platform-fixture",
			audience: "runtime_host_readiness",
			purpose: "readiness.read",
			grantId: "readiness-grant-fixture",
			issuedAt: fixtureNow,
			expiresAt: fixtureNow + 30_000,
		},
	]
		.map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
		.join(".");
	const readinessRequest = {
		...request,
		grant: {
			schemaVersion: 1 as const,
			format: "workload-readiness-jws" as const,
			token: `${prefix}.${sign(null, Buffer.from(prefix), runtimeV2Keys.privateKey).toString("base64url")}`,
		},
	};
	const host = await RuntimeHost.open({
		driver,
		store,
		grantValidation: { expectedIssuer: "platform-fixture" },
		grantValidationV2: {
			expectedIssuer: "platform-fixture",
			expectedWorkerId: binding.workerId,
			now: () => fixtureNow,
		},
		readinessVerifier: createWorkloadReadinessVerifierV1({
			binding,
			publicKeys: new Map([["fixture", runtimeV2Keys.publicKey]]),
			expectedIssuer: "platform-fixture",
			now: () => fixtureNow,
		}),
	});
	return { driver, store, host, readinessRequest };
}

describe("RuntimeHost shutdown drains admitted work", () => {
	it("retains an aborted readiness probe until the Driver settles", async () => {
		const env = await setup();
		const entered = deferred();
		const release = deferred();
		Object.assign(env.driver, {
			probeReadiness: async () => {
				entered.resolve();
				await release.promise;
				return env.driver.getCapabilities();
			},
		});
		const controller = new AbortController();
		const reading = env.host
			.readiness(env.readinessRequest, "worker-fixture", controller.signal)
			.catch((error: unknown) => error);
		try {
			await entered.promise;
			controller.abort();
			expect(await reading).toMatchObject({
				code: "RUNTIME_READINESS_UNAVAILABLE",
			});
			let closed = false;
			const closing = env.host.close().then(() => {
				closed = true;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(closed).toBe(false);
			release.resolve();
			await closing;
			expect(closed).toBe(true);
		} finally {
			release.resolve();
			await reading;
			await env.host.close();
		}
	});

	it("bounds readiness shutdown drain when a Driver ignores abort", async () => {
		const env = await setup();
		const entered = deferred();
		const release = deferred();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		Object.assign(env.driver, {
			probeReadiness: async () => {
				entered.resolve();
				await release.promise;
				return env.driver.getCapabilities();
			},
		});
		const controller = new AbortController();
		const reading = env.host
			.readiness(env.readinessRequest, "worker-fixture", controller.signal)
			.catch((error: unknown) => error);
		try {
			await entered.promise;
			controller.abort();
			expect(await reading).toMatchObject({
				code: "RUNTIME_READINESS_UNAVAILABLE",
			});
			let closed = false;
			const closing = env.host.close().then(() => {
				closed = true;
			});
			await vi.advanceTimersByTimeAsync(9_999);
			expect(closed).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await closing;
			expect(closed).toBe(true);
		} finally {
			release.resolve();
			await reading;
			await env.host.close();
		}
	});

	it("drains an admitted status dispatch before close returns", async () => {
		const env = await setup();
		const submit = signV3Fixture(submitV3Fixture(), "turn.submit");
		const accepted = await env.host.submitTurnV3(
			submit,
			verifyRuntimeV2Fixture(submit.grant),
		);
		const { input, ...base } = submitV3Fixture();
		const query = signV3Fixture(
			{
				...base,
				hostSessionRef: accepted.hostSessionRef,
				originalOperationDigest: requestDigest({
					kind: "submit-turn",
					agentId: base.agentId,
					conversationId: base.conversationId,
					executionId: base.executionId,
					turnId: base.turnId,
					sessionGeneration: base.sessionGeneration,
					input,
				}),
			},
			"session.status",
			{ purpose: "control", reason: "recovery" },
		);
		const entered = deferred();
		const release = deferred();
		env.driver.getStatus = async () => {
			entered.resolve();
			await release.promise;
			return "completed";
		};
		const write = vi.spyOn(env.store, "resolveOperation");
		const querying = env.host
			.recoverStatusV3(query, verifyRuntimeV2Fixture(query.grant))
			.catch((error: unknown) => error);
		try {
			await entered.promise;
			let closed = false;
			const closing = env.host.close().then(() => {
				closed = true;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(closed).toBe(false);
			expect(write).not.toHaveBeenCalled();
			release.resolve();
			await closing;
			const writesAtClose = write.mock.calls.length;
			await querying;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(write.mock.calls.length).toBe(writesAtClose);
			expect(writesAtClose).toBe(1);
		} finally {
			release.resolve();
			await querying;
			await env.host.close();
		}
	});
});
