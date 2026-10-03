import { sign } from "node:crypto";
import { mkdir, readFile, rename } from "node:fs/promises";
import * as runtime from "@agent-infra/agent-runtime";
import { RuntimeControlGrantClaimsV2Schema } from "@agent-infra/contracts/runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	fixtureNow,
	runtimeV2Keys,
	signV3Fixture,
} from "../../../packages/agent-runtime/src/grant-v2-fixture.test-support.js";
import { originalBindingFixture } from "../../../packages/agent-runtime/src/original-binding.test-support.js";
import { createRuntimeHostApp } from "./app.js";

const route = "/internal/runtime/v3/original-binding";
const fixtures: Awaited<ReturnType<typeof originalBindingFixture>>[] = [];
beforeEach(() => vi.setSystemTime(fixtureNow));
afterEach(async () => {
	for (const f of fixtures.splice(0)) await f.close();
	vi.useRealTimers();
});
async function fixture(state?: Parameters<typeof originalBindingFixture>[0]) {
	const f = await originalBindingFixture(state, runtime);
	fixtures.push(f);
	const app = createRuntimeHostApp({
		host: f.host,
		runtimeWorkerId: "worker-fixture",
		serviceToken: "synthetic-service-token",
		verifyGrant: () => {
			throw new Error("No legacy verifier");
		},
		verifyGrantV2: runtime.createRuntimeExecutionGrantVerifierV2(
			new Map([["fixture", runtimeV2Keys.publicKey]]),
		),
	});
	const request = signV3Fixture(f.query, "session.status", {
		purpose: "control",
		reason: "recovery",
	});
	return { ...f, app, request };
}
function post(body: unknown, serviceToken = "synthetic-service-token") {
	return {
		method: "POST",
		headers: {
			authorization: `Bearer ${serviceToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	};
}
function resign(
	request: Awaited<ReturnType<typeof fixture>>["request"],
	mutate: (
		claims: Record<string, unknown>,
		header: Record<string, unknown>,
	) => void,
) {
	const [h, p] = request.grant.token.split(".");
	const header = JSON.parse(Buffer.from(h ?? "", "base64url").toString());
	const claims = JSON.parse(Buffer.from(p ?? "", "base64url").toString());
	mutate(claims, header);
	const encoded = [header, claims]
		.map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
		.join(".");
	return {
		...request,
		grant: {
			...request.grant,
			token: `${encoded}.${sign(null, Buffer.from(encoded), runtimeV2Keys.privateKey).toString("base64url")}`,
		},
	};
}

it("returns the durable original ref through real service authentication and JWS without Driver or journal writes", async () => {
	const f = await fixture();
	const before = await readFile(f.path);
	const execute = vi.spyOn(f.driver, "execute");
	const lookup = vi.spyOn(f.driver, "lookupOperation");
	const status = vi.spyOn(f.driver, "getStatus");
	const response = await f.app.request(route, post(f.request));
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({
		schemaVersion: 3,
		outcome: "binding_found",
		executionId: f.query.executionId,
		hostSessionRef: f.hostSessionRef,
	});
	expect(await readFile(f.path)).toEqual(before);
	for (const spy of [execute, lookup, status])
		expect(spy).not.toHaveBeenCalled();
});

it("rejects another service before reading Host state", async () => {
	const f = await fixture();
	const read = vi.spyOn(f.store, "readAcceptedOriginalBindingV4");
	const response = await f.app.request(route, post(f.request, "other-service"));
	expect(response.status).toBe(401);
	expect(read).not.toHaveBeenCalled();
});

it.each([
	"unknown-key",
	"signature",
	"issuer",
	"audience",
	"worker",
	"expired",
	"future",
	"business",
	"commands",
] as const)("rejects %s authorization before Store read", async (change) => {
	const f = await fixture();
	const before = await readFile(f.path);
	const read = vi.spyOn(f.store, "readAcceptedOriginalBindingV4");
	let request = resign(f.request, (claims, header) => {
		if (change === "unknown-key") header.kid = "unknown";
		else if (change === "issuer") claims.issuer = "other-issuer";
		else if (change === "audience") claims.audience = "platform_api";
		else if (change === "worker") claims.workerId = "other-worker";
		else if (change === "expired") {
			claims.issuedAt = fixtureNow - 60_000;
			claims.expiresAt = fixtureNow;
		} else if (change === "future") {
			claims.issuedAt = fixtureNow + 60_000;
			claims.expiresAt = fixtureNow + 90_000;
		} else if (change === "commands")
			claims.allowedCommands = ["session.status", "events.persist"];
	});
	if (change === "signature")
		request.grant.token = `${request.grant.token.slice(0, -8)}AAAAAAAA`;
	if (change === "business") request = signV3Fixture(f.query, "session.status");
	const response = await f.app.request(route, post(request));
	expect(response.status).toBeGreaterThanOrEqual(400);
	expect(response.status).toBeLessThan(500);
	expect(read).not.toHaveBeenCalled();
	expect(await readFile(f.path)).toEqual(before);
});

it.each([
	"principal",
	"channelId",
	"agentId",
	"conversationId",
	"executionId",
	"turnId",
	"sessionGeneration",
	"traceId",
	"hostSessionRef",
	"digest",
	"operation",
	"fence",
] as const)(
	"rejects a changed raw %s without reusing the original signature",
	async (field) => {
		const f = await fixture();
		const request = structuredClone(f.request);
		const read = vi.spyOn(f.store, "readAcceptedOriginalBindingV4");
		if (field === "principal") request.principal.id = "other-user";
		else if (field === "sessionGeneration") request.sessionGeneration = 2;
		else if (field === "digest")
			request.originalOperationDigest = "a".repeat(64);
		else if (field === "operation") request.operation.id = "other-execution";
		else if (field === "fence")
			request.operation.deliveryFence =
				request.operation.executionDeliveryFence = 4;
		else request[field] = "other-object";
		const response = await f.app.request(route, post(request));
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(response.status).toBeLessThan(500);
		expect(read).not.toHaveBeenCalled();
	},
);

it.each(["absent", "prepared", "unknown", "legacy", "no-native"] as const)(
	"returns bounded retryable acceptance unknown for %s without a status or private data",
	async (state) => {
		const f = await fixture(state);
		const before = await readFile(f.path);
		const response = await f.app.request(route, post(f.request));
		expect(response.status).toBe(503);
		const body = await response.json();
		expect(body).toMatchObject({
			schemaVersion: 1,
			code: "RUNTIME_ACCEPTANCE_UNKNOWN",
			retryable: true,
		});
		expect(JSON.stringify(body)).not.toMatch(
			/binding_found|not_found|running|native-session|synthetic input|ciphertext|\/Users\//,
		);
		expect(await readFile(f.path)).toEqual(before);
	},
);

it("keeps an unreadable durable Store as acceptance unknown", async () => {
	const f = await fixture();
	const before = await readFile(f.path);
	const savedPath = `${f.path}.before-failure`;
	await rename(f.path, savedPath);
	await mkdir(f.path);
	// A real rename-to-directory failure makes DurableJsonFile reads unavailable.
	await expect(
		f.store.recoverOperationV3(
			RuntimeControlGrantClaimsV2Schema.parse(
				JSON.parse(
					Buffer.from(
						f.request.grant.token.split(".")[1] ?? "",
						"base64url",
					).toString(),
				),
			),
			f.query.originalOperationDigest,
			fixtureNow,
		),
	).rejects.toThrow();
	const response = await f.app.request(route, post(f.request));
	expect(response.status).toBe(503);
	expect(await response.json()).toMatchObject({
		code: "RUNTIME_ACCEPTANCE_UNKNOWN",
		retryable: true,
	});
	expect(await readFile(savedPath)).toEqual(before);
});

it.each(["fence", "control-record", "control-reason"] as const)(
	"rejects a signed query against another persisted %s without changing its authority",
	async (change) => {
		const f = await fixture();
		const control = signV3Fixture(
			{ ...f.query, hostSessionRef: f.hostSessionRef },
			"session.status",
			{ purpose: "control", reason: "recovery" },
		);
		const claims = RuntimeControlGrantClaimsV2Schema.parse(
			JSON.parse(
				Buffer.from(
					control.grant.token.split(".")[1] ?? "",
					"base64url",
				).toString(),
			),
		);
		await f.store.recoverOperationV3(
			claims,
			f.query.originalOperationDigest,
			fixtureNow,
		);
		const before = await readFile(f.path);
		const request = signV3Fixture(
			{
				...f.query,
				operation: {
					...f.query.operation,
					deliveryFence: change === "fence" ? 2 : 3,
					executionDeliveryFence: change === "fence" ? 2 : 3,
				},
			},
			"session.status",
			{
				purpose: "control",
				reason: change === "control-reason" ? "stop" : "recovery",
				claims:
					change === "control-record"
						? { controlRecordId: "other-control" }
						: {},
			},
		);
		const response = await f.app.request(route, post(request));
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			code: "RUNTIME_ACCEPTANCE_UNKNOWN",
			retryable: true,
		});
		expect(await readFile(f.path)).toEqual(before);
	},
);

it("rejects readiness credentials before the original-binding handler", async () => {
	const f = await fixture();
	const read = vi.spyOn(f.store, "readAcceptedOriginalBindingV4");
	const request = {
		...f.request,
		grant: { schemaVersion: 1, token: "synthetic-readiness-token" },
	};
	const response = await f.app.request(route, post(request));
	expect(response.status).toBe(400);
	expect(read).not.toHaveBeenCalled();
});
