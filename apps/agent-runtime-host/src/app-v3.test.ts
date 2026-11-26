import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createRuntimeControlObserverV1,
	createRuntimeExecutionGrantVerifierV2,
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
	RuntimeHostError,
	requestDigest,
} from "@agent-infra/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	runtimeGrantFixture,
	verificationForRuntimeGrant,
} from "../../../packages/agent-runtime/src/grant-fixture.test-support.js";
import {
	fixtureNow,
	runtimeV2Keys,
	signV3Fixture,
	submitV3Fixture,
} from "../../../packages/agent-runtime/src/grant-v2-fixture.test-support.js";
import { createRuntimeHostApp } from "./app.js";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});
async function setup(
	logDiagnostic?: (entry: Record<string, string>) => void,
	controlObserver?: ReturnType<typeof createRuntimeControlObserverV1>,
) {
	const directory = await mkdtemp(join(tmpdir(), "runtime-http-v3-"));
	directories.push(directory);
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	const host = await RuntimeHost.open({
		...(controlObserver ? { controlObserver } : {}),
		driver,
		store: await FileRuntimeStore.open(join(directory, "host.json")),
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
	const app = createRuntimeHostApp({
		host,
		runtimeWorkerId: "worker-fixture",
		serviceToken: "synthetic-service-token",
		verifyGrant: verificationForRuntimeGrant,
		verifyGrantV2: createRuntimeExecutionGrantVerifierV2(
			new Map([["fixture", runtimeV2Keys.publicKey]]),
		),
		...(logDiagnostic ? { logDiagnostic } : {}),
	});
	return { app, host, driver };
}
function post(body: unknown, token = "synthetic-service-token") {
	return {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	};
}

describe("Runtime V3 authenticated HTTP", () => {
	it("keeps a legacy Worker recovery retryable until it advertises refusal support", async () => {
		const { app, host } = await setup();
		const { input: _input, ...base } = submitV3Fixture();
		const request = signV3Fixture(
			{
				...base,
				hostSessionRef: "host-fixture",
				operation: {
					kind: "stop" as const,
					id: "execution-fixture",
					deliveryFence: 1,
					executionDeliveryFence: 1,
				},
				originalOperationDigest: "a".repeat(43),
			},
			"session.status",
			{ purpose: "control", reason: "recovery" },
		);
		vi.spyOn(host, "recoverStatusV3").mockRejectedValue(
			new RuntimeHostError(
				"RUNTIME_NATIVE_COMMAND_NOT_SUBMITTED",
				"Native command was not submitted",
				409,
				false,
			),
		);
		const legacy = await app.request(
			"/internal/runtime/v3/status",
			post(request),
		);
		expect(legacy.status).toBe(200);
		expect(await legacy.json()).toMatchObject({
			schemaVersion: 3,
			hostSessionRef: "host-fixture",
			executionId: "execution-fixture",
			outcome: "found",
			status: "unknown",
		});
		const currentPost = post(request);
		const current = await app.request("/internal/runtime/v3/status", {
			...currentPost,
			headers: {
				...currentPost.headers,
				"x-runtime-capabilities": "native-command-refusal-v1",
			},
		});
		expect(current.status).toBe(409);
		expect(await current.json()).toMatchObject({
			code: "RUNTIME_NATIVE_COMMAND_NOT_SUBMITTED",
			retryable: false,
		});
	});

	it("recovers the original mapping after a lost receipt and reports only the authorized recovery failure", async () => {
		const { app, driver } = await setup();
		const fixture = submitV3Fixture();
		const accepted = await app.request(
			"/internal/runtime/v3/turns",
			post(signV3Fixture(fixture, "turn.submit")),
		);
		expect(accepted.status).toBe(200);
		const { hostSessionRef } = (await accepted.json()) as {
			hostSessionRef: string;
		};
		const { input, ...base } = fixture;
		const request = signV3Fixture(
			{
				...base,
				hostSessionRef: null,
				originalOperationDigest: requestDigest({
					kind: "submit-turn",
					agentId: fixture.agentId,
					conversationId: fixture.conversationId,
					executionId: fixture.executionId,
					turnId: fixture.turnId,
					sessionGeneration: fixture.sessionGeneration,
					input,
				}),
			},
			"session.status",
			{ purpose: "control", reason: "recovery" },
		);
		const getStatus = vi
			.spyOn(driver, "getStatus")
			.mockRejectedValue(
				new RuntimeHostError(
					"PRIVATE_DRIVER_ERROR",
					"sensitive synthetic diagnostic",
					503,
					true,
					"session_recovery_failed",
				),
			);
		const denied = await app.request(
			"/internal/runtime/v3/status",
			post(request, "other-service"),
		);
		expect(denied.status).toBe(401);
		expect(getStatus).not.toHaveBeenCalled();
		const status = await app.request(
			"/internal/runtime/v3/status",
			post(request),
		);
		expect(status.status).toBe(200);
		expect(await status.json()).toEqual({
			schemaVersion: 3,
			hostSessionRef,
			executionId: fixture.executionId,
			outcome: "recovery_failed",
			code: "RUNTIME_SESSION_RECOVERY_FAILED",
		});
		expect(await driver.sideEffectCount()).toBe(1);
	});

	it("accepts a signed V3 Turn and recovers through a body-free control request", async () => {
		const { app, driver } = await setup();
		const fixture = submitV3Fixture();
		const submit = signV3Fixture(fixture, "turn.submit");
		const accepted = await app.request(
			"/internal/runtime/v3/turns",
			post(submit),
		);
		expect(accepted.status).toBe(200);
		const body = (await accepted.json()) as {
			hostSessionRef: string;
			schemaVersion: number;
		};
		expect(body.schemaVersion).toBe(3);
		const { input, ...base } = fixture;
		const digest = requestDigest({
			kind: "submit-turn",
			agentId: fixture.agentId,
			conversationId: fixture.conversationId,
			executionId: fixture.executionId,
			turnId: fixture.turnId,
			sessionGeneration: fixture.sessionGeneration,
			input,
		});
		const recovery = signV3Fixture(
			{
				...base,
				hostSessionRef: body.hostSessionRef,
				originalOperationDigest: digest,
			},
			"session.status",
			{ purpose: "control", reason: "authorization_revoked" },
		);
		const status = await app.request(
			"/internal/runtime/v3/status",
			post(recovery),
		);
		expect(status.status).toBe(200);
		expect(await status.json()).toMatchObject({
			schemaVersion: 3,
			outcome: "found",
			status: "running",
		});
		expect(await driver.sideEffectCount()).toBe(1);
		const renewal = signV3Fixture(
			{ ...base, hostSessionRef: body.hostSessionRef },
			"execution.renew",
		);
		expect(
			(
				await app.request(
					"/internal/runtime/v3/authorizations/renew",
					post(renewal),
				)
			).status,
		).toBe(403);
	});
	it("rejects foreign transport/Worker identities and forged bodies before execution", async () => {
		const { app, driver } = await setup();
		const submit = signV3Fixture(submitV3Fixture(), "turn.submit");
		expect(
			(
				await app.request(
					"/internal/runtime/v3/turns",
					post(submit, "wrong-service-token"),
				)
			).status,
		).toBe(401);
		const foreign = signV3Fixture(submitV3Fixture(), "turn.submit", {
			claims: { workerId: "another-worker" },
		});
		expect(
			(await app.request("/internal/runtime/v3/turns", post(foreign))).status,
		).toBe(403);
		expect(
			(
				await app.request(
					"/internal/runtime/v3/turns",
					post({
						...submit,
						input: { text: "changed input", attachments: [] },
					}),
				)
			).status,
		).toBe(403);
		const invalid = await app.request(
			"/internal/runtime/v3/turns",
			post({ ...submit, privateCredential: "synthetic-private-canary" }),
		);
		expect(invalid.status).toBe(400);
		expect(await invalid.text()).not.toContain("synthetic-private-canary");
		expect(await driver.sideEffectCount()).toBe(0);
	});
	it("logs a fixed reason for each authorization denial without changing the response (#1888)", async () => {
		const entries: Record<string, string>[] = [];
		const { app, driver } = await setup((entry) => entries.push(entry));
		const submit = signV3Fixture(submitV3Fixture(), "turn.submit");
		const foreign = signV3Fixture(submitV3Fixture(), "turn.submit", {
			claims: { workerId: "another-worker" },
		});
		const refusals = [
			await app.request(
				"/internal/runtime/v3/turns",
				post(foreign, "synthetic-service-token"),
			),
			await app.request(
				"/internal/runtime/v3/turns",
				post({
					...submit,
					input: { text: "synthetic changed input", attachments: [] },
				}),
			),
			await app.request(
				"/internal/runtime/v3/turns",
				post({
					...submit,
					grant: { ...submit.grant, token: `${submit.grant.token}x` },
				}),
			),
		];
		const bodies = await Promise.all(
			refusals.map(async (response) => ({
				status: response.status,
				body: (await response.json()) as Record<string, unknown>,
			})),
		);
		for (const { status, body } of bodies) {
			expect(status).toBe(403);
			expect(Object.keys(body).sort()).toEqual([
				"code",
				"message",
				"retryable",
				"schemaVersion",
				"traceId",
			]);
			expect(body.code).toBe("RUNTIME_GRANT_INVALID");
		}
		expect(
			entries.map(({ reason, path, code }) => [code, path, reason]),
		).toEqual([
			[
				"RUNTIME_AUTHORIZATION_DENIED",
				"/internal/runtime/v3/turns",
				"grant-v2-worker-mismatch",
			],
			[
				"RUNTIME_AUTHORIZATION_DENIED",
				"/internal/runtime/v3/turns",
				"v3-request-mismatch",
			],
			[
				"RUNTIME_AUTHORIZATION_DENIED",
				"/internal/runtime/v3/turns",
				"grant-v2-segment-encoding",
			],
		]);
		expect(entries.map(({ traceId }) => traceId)).toEqual(
			bodies.map(({ body }) => body.traceId),
		);
		// The entry never carries the Grant, the request or its input.
		const logged = JSON.stringify(entries);
		expect(logged).not.toContain(submit.grant.token.split(".")[1]);
		expect(logged).not.toContain("synthetic changed input");
		expect(logged).not.toContain("conversation-fixture");
		expect(await driver.sideEffectCount()).toBe(0);
	});
	it("rejects historical business routes in trusted production mode without widening V1", async () => {
		const { app, driver } = await setup();
		const {
			principal,
			operation: _op,
			hostSessionRef: _ref,
			...fixture
		} = submitV3Fixture();
		const binding = { ...fixture, actorId: principal.id };
		const legacy = {
			...binding,
			schemaVersion: 1,
			deliveryFence: 1,
			grant: runtimeGrantFixture(binding, ["turn.submit"]),
		};
		const response = await app.request(
			"/internal/runtime/v1/turns",
			post(legacy),
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			code: "RUNTIME_GRANT_INVALID",
		});
		expect(await driver.sideEffectCount()).toBe(0);
	});
});

describe("Runtime V3 stop observation (#4358 I2)", () => {
	it("timestamps the stop handler entry and records an unverifiable stop without identifiers", async () => {
		const lines: string[] = [];
		const { app } = await setup(
			() => {},
			createRuntimeControlObserverV1({
				output: {
					write(line) {
						lines.push(line.trimEnd());
						return true;
					},
				},
			}),
		);
		const fixture = submitV3Fixture();
		const accepted = await app.request(
			"/internal/runtime/v3/turns",
			post(signV3Fixture(fixture, "turn.submit")),
		);
		const { hostSessionRef } = (await accepted.json()) as {
			hostSessionRef: string;
		};
		const { input: _input, ...base } = fixture;
		const stop = signV3Fixture(
			{
				...base,
				hostSessionRef,
				operation: {
					kind: "stop",
					id: "stop-http",
					deliveryFence: 1,
					executionDeliveryFence: 1,
				},
			},
			"turn.stop",
		);
		const [header, payload] = stop.grant.token.split(".");
		const forged = {
			...stop,
			grant: { ...stop.grant, token: `${header}.${payload}.AAAA` },
		};
		const denied = await app.request(
			"/internal/runtime/v3/stops",
			post(forged),
		);
		expect(denied.ok).toBe(false);
		const stopped = await app.request("/internal/runtime/v3/stops", post(stop));
		expect(stopped.status).toBe(200);
		const records = lines.map((line) => JSON.parse(line));
		expect(records[0]).toMatchObject({
			stage: "control_received",
			outcome: "rejected",
			monoSequence: 1,
		});
		expect(records[0].executionId).toBeUndefined();
		expect(records[0].stopRequestId).toBeUndefined();
		expect(records.slice(1).map((record) => record.stage)).toEqual([
			"control_received",
			"control_validated",
			"latch_commit_confirmed",
		]);
		expect(records[1]).toMatchObject({
			stopRequestId: "stop-http",
			elapsedMonoMs: 0,
		});
		expect(Date.parse(records[1].observedAtUtc)).toBeLessThanOrEqual(
			Date.parse(records[2].observedAtUtc),
		);
		expect(lines.join("\n")).not.toContain(stop.grant.token);
	});
});
