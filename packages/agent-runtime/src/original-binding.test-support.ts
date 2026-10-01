import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimePinnedExecutionKeyScopeV4Schema } from "@agent-infra/contracts/runtime";
import { FakeRuntimeDriver } from "./fake-runtime-driver.js";
import { FileRuntimeStore, requestDigest } from "./file-runtime-store.js";
import { validateRuntimeExecutionGrantV2 } from "./grant-v2.js";
import {
	fixtureNow,
	signV3Fixture,
	submitV3Fixture,
	verifyRuntimeV2Fixture,
} from "./grant-v2-fixture.test-support.js";
import { RuntimeHost } from "./runtime-host.js";

type BindingFixtureState =
	| "accepted"
	| "absent"
	| "prepared"
	| "unknown"
	| "legacy"
	| "no-native";

/** Synthetic accepted facts for Host protocol tests; no native acceptance claim. */
export async function seedOriginalBinding(
	store: FileRuntimeStore,
	original = submitV3Fixture(),
	state: BindingFixtureState = "accepted",
) {
	const grantValidation = {
		expectedIssuer: "platform-fixture",
		expectedWorkerId: "worker-fixture",
		now: () => fixtureNow,
	};
	const signed = signV3Fixture(original, "turn.submit");
	const claims = validateRuntimeExecutionGrantV2(
		signed,
		"turn.submit",
		verifyRuntimeV2Fixture(signed.grant),
		grantValidation,
	);
	const digest = requestDigest({ kind: "submit-turn", ...original });
	let hostSessionRef: string | null = null;
	if (state !== "absent") {
		const prepared = await store.prepareOperation({
			binding: original,
			authorization: claims,
			now: () => fixtureNow,
			operationId: original.executionId,
			kind: "submit-turn",
			scope: `execution:${original.executionId}`,
			deliveryFence: 1,
			requestDigest: digest,
			...(state === "legacy"
				? {}
				: {
						keyScopeV4: RuntimePinnedExecutionKeyScopeV4Schema.parse({
							principal: original.principal,
							channelId: original.channelId,
							agentId: original.agentId,
							conversationId: original.conversationId,
							executionId: original.executionId,
							turnId: original.turnId,
							sessionGeneration: original.sessionGeneration,
							hostSessionRef: original.hostSessionRef,
							executionSource: "web",
							keyBinding: {
								purpose: "personal",
								subjectId: original.principal.id,
								ciphertextRef: "ciphertext-fixture",
								version: 7,
							},
						}),
					}),
			command: () => ({
				schemaVersion: 1,
				kind: "submit-turn",
				operationId: original.executionId,
				agentId: original.agentId,
				conversationId: original.conversationId,
				executionId: original.executionId,
				turnId: original.turnId,
				sessionGeneration: 1,
				input: original.input,
			}),
		});
		hostSessionRef = prepared.session.hostSessionRef;
		if (state !== "prepared")
			await store.resolveOperation(
				hostSessionRef,
				original.executionId,
				state === "unknown"
					? {
							outcome: "unknown",
							code: "RUNTIME_ACCEPTANCE_UNKNOWN",
							message: "Runtime command acceptance could not be confirmed",
						}
					: { outcome: "accepted", status: "running" },
				state === "no-native" ? undefined : "123456",
			);
	}
	const { input: _input, ...base } = original;
	const query = {
		...base,
		requestId: "binding-query",
		originalOperationDigest: digest,
		operation: {
			...base.operation,
			deliveryFence: 3,
			executionDeliveryFence: 3,
		},
	};
	return { query, hostSessionRef };
}

export async function originalBindingFixture(
	state: BindingFixtureState = "accepted",
	runtime = { FileRuntimeStore, FakeRuntimeDriver, RuntimeHost },
) {
	const directory = await mkdtemp(join(tmpdir(), "runtime-original-binding-"));
	const path = join(directory, "host.json");
	const clock = { now: fixtureNow };
	const grantValidation = {
		expectedIssuer: "platform-fixture",
		expectedWorkerId: "worker-fixture",
		now: () => clock.now,
	};
	let store = await runtime.FileRuntimeStore.open(path);
	const seeded = await seedOriginalBinding(store, submitV3Fixture(), state);
	await store.close();
	store = await runtime.FileRuntimeStore.open(path);
	const driver = await runtime.FakeRuntimeDriver.open(
		join(directory, "driver.json"),
	);
	// A scoped startup lookup failure preserves the seeded receipt for this
	// control-read test; it does not claim native startup recovery acceptance.
	await driver.failLookupFor(seeded.query.executionId);
	const host = await runtime.RuntimeHost.open({
		store,
		driver,
		grantValidationV2: grantValidation,
		grantValidation: { expectedIssuer: "agent-platform" },
	});
	return {
		path,
		store,
		host,
		driver,
		clock,
		...seeded,
		async close() {
			await host.close();
			await store.close();
			await rm(directory, { recursive: true, force: true });
		},
	};
}
