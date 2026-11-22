import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
} from "@agent-infra/agent-runtime";
import type { RuntimeOriginalAdmissionScopeV1 } from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fixtureNow,
	runtimeV2Keys,
	signV3Fixture,
	submitV3Fixture,
	verifyRuntimeV2Fixture,
} from "../../../packages/agent-runtime/src/grant-v2-fixture.test-support.js";
import { createWorkerRuntimeOriginalAdmissionCheckProofIssuerV1 } from "../../platform-worker/src/runtime-original-admission-check-proof.js";
import { createRuntimeHostApp } from "./app.js";
import { createRuntimeOriginalAdmissionCheckV1 } from "./original-admission-check.js";

const podUid = "0f4a7c52-9b3e-4d1a-8c7f-2e6b5a4d3c21";
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "runtime-admission-check-"));
	directories.push(directory);
	const storePath = join(directory, "host.json");
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	const host = await RuntimeHost.open({
		driver,
		store: await FileRuntimeStore.open(storePath),
		grantValidation: {
			expectedIssuer: "agent-platform",
			now: () => "2026-08-28T10:00:00Z",
		},
		grantValidationV2: {
			expectedIssuer: "platform-fixture",
			expectedWorkerId: "worker-fixture",
			now: () => fixtureNow,
		},
	});
	const { input: _input, ...base } = submitV3Fixture();
	const submit = signV3Fixture(submitV3Fixture(), "turn.submit");
	const accepted = await host.submitTurnV3(
		submit,
		verifyRuntimeV2Fixture(submit.grant),
	);
	const check = createRuntimeOriginalAdmissionCheckV1({
		host,
		publicKey: runtimeV2Keys.publicKey,
		issuer: "platform-fixture",
		workerId: "worker-fixture",
		keyVersion: "fixture",
		podUid,
		instanceId: "instance-1",
		now: () => fixtureNow,
	});
	const issuer = createWorkerRuntimeOriginalAdmissionCheckProofIssuerV1({
		issuer: "platform-fixture",
		workerId: "worker-fixture",
		keyVersion: "fixture",
		privateKey: runtimeV2Keys.privateKey,
		now: () => fixtureNow,
	});
	const scope: RuntimeOriginalAdmissionScopeV1 = {
		principal: { kind: "user", id: "user-fixture" },
		agentId: "agent-fixture",
		conversationId: "conversation-fixture",
		executionId: "execution-fixture",
		originalOperationId: "execution-fixture",
		authorizationRecordId: "authorization-fixture",
		sessionGeneration: 1,
		executionDeliveryFence: 1,
		podUid,
	};
	let checks = 0;
	const request = (
		overrides: Partial<RuntimeOriginalAdmissionScopeV1> = {},
		platform = { sessionGeneration: 1, resourceFence: 1 },
	) =>
		issuer.issue({
			checkId: `check-${++checks}`,
			challenge: randomBytes(32).toString("base64url"),
			scope: { ...scope, ...overrides },
			platform,
		});
	const digest = async () =>
		createHash("sha256")
			.update(await readFile(storePath))
			.digest("hex");
	return {
		host,
		driver,
		check,
		request,
		digest,
		base: { ...base, hostSessionRef: accepted.hostSessionRef },
		hostSessionRef: accepted.hostSessionRef,
	};
}

describe("original admission check (#4358 I3)", () => {
	it("reports an admissible original reference without touching the Driver or Host state", async () => {
		const env = await setup();
		try {
			const execute = vi.spyOn(env.driver, "execute");
			const status = vi.spyOn(env.driver, "getStatus");
			const before = await env.digest();
			const sideEffects = await env.driver.sideEffectCount();
			const response = await env.check.check(env.request());
			expect(response).toEqual({
				schemaVersion: 1,
				checkId: "check-1",
				challenge: expect.any(String),
				decision: "admissible",
				checkedSurface: "original_call_admission_predicate",
				original: { sessionGeneration: 1, executionDeliveryFence: 1 },
				current: {
					platformSessionGeneration: 1,
					platformResourceFence: 1,
					hostBarrier: "none",
					hostExecutionFence: 1,
				},
				checkedAt: fixtureNow,
				clockId: env.check.clockId,
				dispatchAttempted: false,
			});
			expect(execute).not.toHaveBeenCalled();
			expect(status).not.toHaveBeenCalled();
			expect(await env.digest()).toBe(before);
			expect(await env.driver.sideEffectCount()).toBe(sideEffects);
			// The original control path keeps working after the check.
			const stop = signV3Fixture(
				{
					...env.base,
					operation: {
						kind: "stop",
						id: "stop-after-check",
						deliveryFence: 1,
						executionDeliveryFence: 1,
					},
				},
				"turn.stop",
			);
			await expect(
				env.host.stopV3(stop, verifyRuntimeV2Fixture(stop.grant)),
			).resolves.toMatchObject({ result: { outcome: "accepted" } });
			// A stopped original is now denied by the same predicate.
			await expect(env.check.check(env.request())).resolves.toMatchObject({
				decision: "denied",
				reason: "revoked",
			});
			// A replaced principal is not that Stop's revocation (#4363 MUST 1).
			await expect(
				env.check.check(
					env.request({ principal: { kind: "user", id: "user-other" } }),
				),
			).resolves.toMatchObject({
				decision: "denied",
				reason: "scope_mismatch",
				current: { hostBarrier: "unavailable", hostExecutionFence: null },
				dispatchAttempted: false,
			});
		} finally {
			await env.host.close();
		}
	});

	it("denies the original reference at the generation barrier after isolation", async () => {
		const env = await setup();
		try {
			const cancel = signV3Fixture(
				{
					...env.base,
					operation: {
						kind: "generation" as const,
						id: "generation:conversation-fixture:1",
						deliveryFence: 2,
						executionDeliveryFence: 2,
					},
				},
				"generation.cancel",
				{ purpose: "control", reason: "generation_isolation" },
			);
			await env.host.cancelGenerationV3(
				cancel,
				verifyRuntimeV2Fixture(cancel.grant),
			);
			const execute = vi.spyOn(env.driver, "execute");
			const before = await env.digest();
			for (const platform of [
				{ sessionGeneration: 2, resourceFence: 1 },
				{ sessionGeneration: 1, resourceFence: 1 },
			])
				await expect(
					env.check.check(env.request({}, platform)),
				).resolves.toMatchObject({
					decision: "denied",
					reason: "stale_generation",
					current: { hostBarrier: "confirmed", hostExecutionFence: 2 },
					dispatchAttempted: false,
				});
			// A replaced scope is not the original generation's barrier denial
			// and carries none of this Session's facts (#4363 MUST 1).
			for (const overrides of [
				{ principal: { kind: "user" as const, id: "user-other" } },
				{ agentId: "agent-other" },
				{ conversationId: "conversation-other" },
				{ authorizationRecordId: "authorization-other" },
				{ sessionGeneration: 2 },
			])
				await expect(
					env.check.check(
						env.request(overrides, { sessionGeneration: 2, resourceFence: 1 }),
					),
				).resolves.toMatchObject({
					decision: "denied",
					reason: "scope_mismatch",
					current: { hostBarrier: "unavailable", hostExecutionFence: null },
					dispatchAttempted: false,
				});
			expect(execute).not.toHaveBeenCalled();
			expect(await env.digest()).toBe(before);
		} finally {
			await env.host.close();
		}
	});

	it("separates a stale fence, a foreign scope and an unverifiable Host from proof", async () => {
		const env = await setup();
		try {
			const before = await env.digest();
			const cases: Array<
				[Partial<RuntimeOriginalAdmissionScopeV1>, string, string]
			> = [
				[{ executionDeliveryFence: 0 }, "denied", "stale_fence"],
				[
					{ principal: { kind: "user", id: "user-other" } },
					"denied",
					"scope_mismatch",
				],
				[{ agentId: "agent-other" }, "denied", "scope_mismatch"],
				[{ conversationId: "conversation-other" }, "denied", "scope_mismatch"],
				[
					{ authorizationRecordId: "authorization-other" },
					"denied",
					"scope_mismatch",
				],
				[
					{ executionId: "execution-other" },
					"denied",
					"original_binding_unavailable",
				],
				[
					{ originalOperationId: "operation-other" },
					"denied",
					"original_binding_unavailable",
				],
				[{ sessionGeneration: 2 }, "denied", "scope_mismatch"],
				[{ executionDeliveryFence: 2 }, "unproven", "unknown"],
			];
			for (const [overrides, decision, reason] of cases)
				await expect(
					env.check.check(env.request(overrides)),
				).resolves.toMatchObject({ decision, reason });
			// Platform says the generation moved but this Host holds no barrier.
			await expect(
				env.check.check(
					env.request({}, { sessionGeneration: 2, resourceFence: 1 }),
				),
			).resolves.toMatchObject({ decision: "unproven", reason: "unknown" });
			// A same-name replacement Pod cannot answer for the original Host.
			const read = vi.spyOn(env.host, "checkOriginalAdmissionV1");
			await expect(
				env.check.check(
					env.request({ podUid: "1f4a7c52-9b3e-4d1a-8c7f-2e6b5a4d3c21" }),
				),
			).resolves.toMatchObject({
				decision: "unproven",
				reason: "original_binding_unavailable",
				current: { hostBarrier: "unavailable", hostExecutionFence: null },
			});
			expect(read).not.toHaveBeenCalled();
			expect(await env.digest()).toBe(before);
		} finally {
			await env.host.close();
		}
	});

	it("rejects forged, foreign, expired, future and replayed proofs before reading state", async () => {
		const env = await setup();
		try {
			const read = vi.spyOn(env.host, "checkOriginalAdmissionV1");
			const valid = env.request();
			const [header, payload] = valid.proof.token.split(".");
			const rejected = async (value: unknown, code: string) =>
				expect(env.check.check(value)).rejects.toMatchObject({ code });
			await rejected(
				{
					...valid,
					proof: { ...valid.proof, token: `${header}.${payload}.AAAA` },
				},
				"RUNTIME_GRANT_INVALID",
			);
			await rejected(
				{ ...valid, scope: { ...valid.scope, executionId: "execution-other" } },
				"RUNTIME_GRANT_INVALID",
			);
			await rejected(
				{ ...valid, platform: { sessionGeneration: 9, resourceFence: 9 } },
				"RUNTIME_GRANT_INVALID",
			);
			await rejected(
				{ ...valid, prompt: "sk-canary" },
				"RUNTIME_REQUEST_INVALID",
			);
			const other = generateKeyPairSync("ed25519");
			for (const issuer of [
				createWorkerRuntimeOriginalAdmissionCheckProofIssuerV1({
					issuer: "platform-fixture",
					workerId: "worker-fixture",
					keyVersion: "fixture",
					privateKey: other.privateKey,
					now: () => fixtureNow,
				}),
				createWorkerRuntimeOriginalAdmissionCheckProofIssuerV1({
					issuer: "platform-fixture",
					workerId: "worker-other",
					keyVersion: "fixture",
					privateKey: runtimeV2Keys.privateKey,
					now: () => fixtureNow,
				}),
				createWorkerRuntimeOriginalAdmissionCheckProofIssuerV1({
					issuer: "platform-fixture",
					workerId: "worker-fixture",
					keyVersion: "fixture",
					privateKey: runtimeV2Keys.privateKey,
					now: () => fixtureNow - 60_000,
				}),
				createWorkerRuntimeOriginalAdmissionCheckProofIssuerV1({
					issuer: "platform-fixture",
					workerId: "worker-fixture",
					keyVersion: "fixture",
					privateKey: runtimeV2Keys.privateKey,
					now: () => fixtureNow + 1_000,
				}),
			])
				await rejected(
					issuer.issue({
						checkId: "check-foreign",
						challenge: randomBytes(32).toString("base64url"),
						scope: valid.scope,
						platform: valid.platform,
					}),
					"RUNTIME_GRANT_INVALID",
				);
			expect(read).not.toHaveBeenCalled();
			await expect(env.check.check(valid)).resolves.toMatchObject({
				decision: "admissible",
			});
			await rejected(valid, "RUNTIME_ADMISSION_CHECK_REPLAYED");
			expect(read).toHaveBeenCalledTimes(1);
		} finally {
			await env.host.close();
		}
	});

	it("exposes the route only when the deployment enables it", async () => {
		const env = await setup();
		try {
			const options = {
				host: env.host,
				runtimeWorkerId: "worker-fixture",
				serviceToken: "synthetic-service-token",
				verifyGrant: () => {
					throw new Error("unused");
				},
			};
			const post = (body: unknown) => ({
				method: "POST",
				headers: {
					authorization: "Bearer synthetic-service-token",
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			});
			const path = "/internal/runtime/v1/evidence/original-admission/check";
			const disabled = createRuntimeHostApp(options);
			expect((await disabled.request(path, post(env.request()))).status).toBe(
				404,
			);
			const enabled = createRuntimeHostApp({
				...options,
				originalAdmissionCheck: env.check,
			});
			const unauthenticated = await enabled.request(path, {
				...post(env.request()),
				headers: { "content-type": "application/json" },
			});
			expect(unauthenticated.status).toBe(401);
			const response = await enabled.request(path, post(env.request()));
			expect(response.status).toBe(200);
			const text = await response.text();
			expect(JSON.parse(text)).toMatchObject({
				decision: "admissible",
				dispatchAttempted: false,
			});
			expect(text).not.toContain("token");
		} finally {
			await env.host.close();
		}
	});
});
