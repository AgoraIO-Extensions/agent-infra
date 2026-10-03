import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "runtime-http-v3-"));
	directories.push(directory);
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	const host = await RuntimeHost.open({
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
