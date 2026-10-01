import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	fixtureNow,
	signV3Fixture,
	submitV3Fixture,
	verifyRuntimeV2Fixture,
} from "./grant-v2-fixture.test-support.js";
import {
	originalBindingFixture,
	seedOriginalBinding,
} from "./original-binding.test-support.js";
import { RuntimeHostV3 } from "./runtime-host-v3.js";

const fixtures: Awaited<ReturnType<typeof originalBindingFixture>>[] = [];
beforeEach(() => vi.setSystemTime(fixtureNow));
afterEach(async () => {
	for (const f of fixtures.splice(0)) await f.close();
	vi.useRealTimers();
});
async function fixture(state?: Parameters<typeof originalBindingFixture>[0]) {
	const f = await originalBindingFixture(state);
	fixtures.push(f);
	return f;
}
function signed(f: Awaited<ReturnType<typeof fixture>>) {
	return signV3Fixture(f.query, "session.status", {
		purpose: "control",
		reason: "recovery",
	});
}

it("reads the original numeric native binding after reopen without changing facts or invoking the Driver", async () => {
	const f = await fixture();
	const before = await readFile(f.path);
	const driver = new Proxy(f.driver, {
		get() {
			throw new Error("Driver must not be accessed by a binding read");
		},
	});
	const storeWrites = [
		"prepareOperation",
		"recoverOperationV3",
		"authorizeRequestV3",
	] as const;
	const spies = storeWrites.map((name) => vi.spyOn(f.store, name));
	const host = new RuntimeHostV3({
		store: f.store,
		driver,
		grantValidation: {
			expectedIssuer: "platform-fixture",
			expectedWorkerId: "worker-fixture",
			now: () => f.clock.now,
		},
		serialize: async (_key, work) => work(),
		dispatch: async () => {
			throw new Error("No dispatch");
		},
	});
	const request = signed(f);
	const response = await host.readOriginalBinding(
		request,
		verifyRuntimeV2Fixture(request.grant),
	);
	expect(response).toEqual({
		schemaVersion: 3,
		outcome: "binding_found",
		executionId: f.query.executionId,
		hostSessionRef: f.hostSessionRef,
	});
	expect(await readFile(f.path)).toEqual(before);
	for (const spy of spies) expect(spy).not.toHaveBeenCalled();
	await host.close();
});

it.each(["absent", "prepared", "unknown", "legacy", "no-native"] as const)(
	"keeps %s acceptance unknown and durable bytes intact",
	async (state) => {
		const f = await fixture(state);
		const before = await readFile(f.path);
		const request = signed(f);
		await expect(
			f.host.readOriginalBinding(
				request,
				verifyRuntimeV2Fixture(request.grant),
			),
		).rejects.toMatchObject({
			code: "RUNTIME_ACCEPTANCE_UNKNOWN",
			httpStatus: 503,
			retryable: true,
		});
		expect(await readFile(f.path)).toEqual(before);
	},
);

it.each(["expired", "closed"] as const)(
	"revalidates %s after waiting in the original Session queue",
	async (change) => {
		const f = await fixture();
		const request = signed(f);
		const read = vi.spyOn(f.store, "readAcceptedOriginalBindingV4");
		let queued!: () => void;
		const entered = new Promise<void>((resolve) => {
			queued = resolve;
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const host = new RuntimeHostV3({
			store: f.store,
			driver: f.driver,
			grantValidation: {
				expectedIssuer: "platform-fixture",
				expectedWorkerId: "worker-fixture",
				now: () => f.clock.now,
			},
			serialize: async (_key, work) => {
				queued();
				await gate;
				return work();
			},
			dispatch: async () => {
				throw new Error("No dispatch");
			},
		});
		const waiting = host.readOriginalBinding(
			request,
			verifyRuntimeV2Fixture(request.grant),
		);
		const outcome = expect(waiting).rejects.toMatchObject({
			code:
				change === "expired"
					? "RUNTIME_GRANT_INVALID"
					: "RUNTIME_SESSION_UNAVAILABLE",
		});
		await entered;
		if (change === "expired") f.clock.now += 30_000;
		else await host.close();
		release();
		await outcome;
		expect(read).not.toHaveBeenCalled();
		await host.close();
	},
);

it("allows another Session while the original Session queue is waiting", async () => {
	const f = await fixture();
	const request = signed(f);
	const original = submitV3Fixture();
	const second = await seedOriginalBinding(f.store, {
		...original,
		conversationId: "other-conversation",
		executionId: "other-execution",
		turnId: "other-turn",
		operation: { ...original.operation, id: "other-execution" },
	});
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered!: () => void;
	const queued = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const key = f.store.sessionQueueKey(request);
	const host = new RuntimeHostV3({
		store: f.store,
		driver: f.driver,
		grantValidation: {
			expectedIssuer: "platform-fixture",
			expectedWorkerId: "worker-fixture",
			now: () => f.clock.now,
		},
		serialize: async (sessionKey, work) => {
			if (sessionKey === key) {
				entered();
				await gate;
			}
			return work();
		},
		dispatch: async () => {
			throw new Error("No dispatch");
		},
	});
	const waiting = host.readOriginalBinding(
		request,
		verifyRuntimeV2Fixture(request.grant),
	);
	await queued;
	const other = signV3Fixture(second.query, "session.status", {
		purpose: "control",
	});
	await expect(
		host.readOriginalBinding(other, verifyRuntimeV2Fixture(other.grant)),
	).resolves.toMatchObject({
		hostSessionRef: second.hostSessionRef,
		executionId: "other-execution",
	});
	release();
	await expect(waiting).resolves.toMatchObject({
		hostSessionRef: f.hostSessionRef,
	});
	await host.close();
});
