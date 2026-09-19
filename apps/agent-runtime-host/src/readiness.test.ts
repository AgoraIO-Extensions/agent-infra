import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeDriver } from "@agent-infra/agent-runtime";
import {
	createExecutionGrantVerifier,
	createWorkloadReadinessVerifierV1,
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
} from "@agent-infra/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeHostApp } from "./app.js";
import { readWorkloadReadinessBindingV1 } from "./configuration.js";

const keys = generateKeyPairSync("ed25519");
const binding = {
	workerId: "worker-a",
	agentId: "agent-a",
	workloadRevision: 2,
	fence: 4,
	imageDigest: `sha256:${"a".repeat(64)}`,
};
const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(
		dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })),
	);
});
function request() {
	const fields = {
		schemaVersion: 1,
		...binding,
		requestId: "request-a",
		traceId: "trace-a",
	};
	const now = Date.now();
	const claims = {
		...fields,
		issuer: "platform",
		purpose: "readiness.read",
		audience: "runtime_host_readiness",
		grantId: "grant-a",
		issuedAt: now,
		expiresAt: now + 30_000,
	};
	const prefix = [
		{ alg: "EdDSA", kid: "key-a", typ: "workload-readiness+jws" },
		claims,
	]
		.map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
		.join(".");
	return {
		...fields,
		grant: {
			schemaVersion: 1,
			format: "workload-readiness-jws",
			token: `${prefix}.${sign(null, Buffer.from(prefix), keys.privateKey).toString("base64url")}`,
		},
	};
}
async function harness(
	probe?: (signal: AbortSignal) => ReturnType<RuntimeDriver["getCapabilities"]>,
	now?: () => number,
) {
	const dir = await mkdtemp(join(tmpdir(), "readiness-host-"));
	dirs.push(dir);
	const driver = await FakeRuntimeDriver.open(join(dir, "driver.json"));
	const execute = vi.spyOn(driver, "execute");
	const lookup = vi.spyOn(driver, "lookupOperation");
	const store = await FileRuntimeStore.open(join(dir, "host.json"));
	const host = await RuntimeHost.open({
		store,
		driver: Object.assign(driver, probe ? { probeReadiness: probe } : {}),
		grantValidation: { expectedIssuer: "platform" },
		readinessVerifier: createWorkloadReadinessVerifierV1({
			binding,
			expectedIssuer: "platform",
			publicKeys: new Map([["key-a", keys.publicKey]]),
			...(now ? { now } : {}),
		}),
	});
	const app = createRuntimeHostApp({
		host,
		serviceToken: "transport-a",
		readinessWorkerId: "worker-a",
		verifyGrant: createExecutionGrantVerifier(
			new Map([["key-a", keys.publicKey]]),
		),
	});
	const snapshot = async () =>
		Promise.all(
			["driver.json", "host.json"].map((name) =>
				readFile(join(dir, name), "utf8"),
			),
		);
	return { app, driver, execute, lookup, snapshot };
}
const caps = {
	modelSelection: true,
	attachments: false,
	resultFiles: false,
	connection: false,
	supplementaryInstruction: false,
};
const post = (body: unknown, token = "transport-a") => ({
	method: "POST",
	headers: {
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
	},
	body: JSON.stringify(body),
});

describe("HTTP Workload readiness", () => {
	it("calls only the dedicated probe and leaves durable business state unchanged", async () => {
		const probe = vi.fn(async () => caps);
		const h = await harness(probe);
		const before = await h.snapshot();
		const body = request();
		const response = await h.app.request(
			"/internal/runtime/v1/readiness",
			post(body),
		);
		expect(response.status).toBe(200);
		const { grant: _grant, ...fields } = body;
		expect(await response.json()).toEqual({
			...fields,
			core: "passed",
			capabilities: caps,
		});
		expect(probe).toHaveBeenCalledOnce();
		expect(h.execute).not.toHaveBeenCalled();
		expect(h.lookup).not.toHaveBeenCalled();
		expect(await h.snapshot()).toEqual(before);
	});
	it("rejects static-only capability availability without a real protocol probe", async () => {
		const h = await harness();
		expect(
			(await h.app.request("/internal/runtime/v1/readiness", post(request())))
				.status,
		).toBe(503);
	});
	it("rejects a proof that expires during the native handshake", async () => {
		const body = request();
		let now = Date.now();
		const probe = vi.fn(async () => {
			now += 30_000;
			return caps;
		});
		const h = await harness(probe, () => now);
		const before = await h.snapshot();
		const response = await h.app.request(
			"/internal/runtime/v1/readiness",
			post(body),
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			code: "RUNTIME_READINESS_GRANT_INVALID",
		});
		expect(probe).toHaveBeenCalledOnce();
		expect(h.execute).not.toHaveBeenCalled();
		expect(await h.snapshot()).toEqual(before);
	});
	it("fails transport and target checks before native access, and rejects proof at every business endpoint", async () => {
		const probe = vi.fn(async () => caps);
		const h = await harness(probe);
		expect(
			(
				await h.app.request(
					"/internal/runtime/v1/readiness",
					post(request(), "wrong"),
				)
			).status,
		).toBe(401);
		expect(
			(
				await h.app.request(
					"/internal/runtime/v1/readiness",
					post({ ...request(), agentId: "agent-b" }),
				)
			).status,
		).toBe(403);
		for (const path of [
			"v1/turns",
			"v2/turns",
			"v1/instructions",
			"v1/stops",
			"v1/status",
			"v2/status",
			"v1/capabilities",
			"v1/events/replay",
			"v1/events/stream",
			"v1/generations/cancel",
		])
			expect(
				(await h.app.request(`/internal/runtime/${path}`, post(request())))
					.status,
			).toBe(400);
		expect(probe).not.toHaveBeenCalled();
		expect(h.execute).not.toHaveBeenCalled();
	});
	it("passes cancellation to the native probe and never returns successful readiness", async () => {
		let aborted = false;
		const started = Promise.withResolvers<void>();
		const h = await harness(
			(signal) =>
				new Promise((_resolve, reject) => {
					started.resolve();
					signal.addEventListener(
						"abort",
						() => {
							aborted = true;
							reject(new Error("probe cancelled"));
						},
						{ once: true },
					);
				}),
		);
		const controller = new AbortController();
		const pending = h.app.request("/internal/runtime/v1/readiness", {
			...post(request()),
			signal: controller.signal,
		});
		await started.promise;
		controller.abort();
		expect((await pending).status).toBe(503);
		expect(aborted).toBe(true);
	});
	it("reads only trusted matching deployment binding and fails malformed configuration", () => {
		const env = {
			AGENT_INFRA_RUNTIME_AGENT_ID: binding.agentId,
			AGENT_INFRA_RUNTIME_READINESS_BINDING: JSON.stringify(binding),
		};
		expect(readWorkloadReadinessBindingV1(env)).toEqual(binding);
		expect(readWorkloadReadinessBindingV1({})).toBeUndefined();
		for (const value of [
			"invalid",
			JSON.stringify({ ...binding, agentId: "other" }),
			JSON.stringify({ ...binding, conversationId: "forged" }),
		])
			expect(() =>
				readWorkloadReadinessBindingV1({
					...env,
					AGENT_INFRA_RUNTIME_READINESS_BINDING: value,
				}),
			).toThrow("RUNTIME_CONFIGURATION_INVALID");
	});
});
