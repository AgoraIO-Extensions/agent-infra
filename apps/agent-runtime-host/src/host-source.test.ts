import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
} from "@agent-infra/agent-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fixtureNow,
	signV3Fixture,
	submitV3Fixture,
	verifyRuntimeV2Fixture,
} from "../../../packages/agent-runtime/src/grant-v2-fixture.test-support.js";
import { createRuntimeHostApp } from "./app.js";
import {
	createRuntimeHostSourceReadV1,
	runtimeHostSourceIdentityV1,
} from "./host-source.js";

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
	const directory = await mkdtemp(join(tmpdir(), "runtime-host-source-"));
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
	const base = submitV3Fixture();
	const submit = signV3Fixture(base, "turn.submit");
	const accepted = await host.submitTurnV3(
		submit,
		verifyRuntimeV2Fixture(submit.grant),
	);
	const identity = runtimeHostSourceIdentityV1(podUid, "start-1");
	const read = vi.fn((hostSessionRef: string) =>
		host.readHostSessionBindingV1(hostSessionRef),
	);
	const source = createRuntimeHostSourceReadV1({
		podUid,
		identity,
		readHostSessionBinding: read,
	});
	const request = (change: Record<string, unknown> = {}) => ({
		schemaVersion: 1,
		podUid,
		agentId: base.agentId,
		conversationId: base.conversationId,
		hostSessionRef: accepted.hostSessionRef,
		sessionGeneration: base.sessionGeneration,
		...change,
	});
	return { host, driver, storePath, identity, read, source, request };
}

describe("Host source read (Spec §18.5.1, #4358 I3b1)", () => {
	it("answers its own instance and start only for its Pod and a committed Host Session, reading state only", async () => {
		const env = await setup();
		try {
			const execute = vi.spyOn(env.driver, "execute");
			const status = vi.spyOn(env.driver, "getStatus");
			const before = await readFile(env.storePath);
			await expect(env.source.read(env.request())).resolves.toEqual({
				...env.request(),
				host: env.identity,
			});
			for (const change of [
				{ podUid: "99999999-9b3e-4d1a-8c7f-2e6b5a4d3c21" },
				{ agentId: "agent-other" },
				{ conversationId: "conversation-other" },
				{ sessionGeneration: 2 },
				{ hostSessionRef: "host-session-other" },
			])
				await expect(
					env.source.read(env.request(change)),
				).rejects.toMatchObject({
					code: "RUNTIME_HOST_SOURCE_MISMATCH",
					httpStatus: 409,
				});
			await expect(
				env.source.read({ ...env.request(), extra: "sk-canary" }),
			).rejects.toMatchObject({ code: "RUNTIME_REQUEST_INVALID" });
			expect(execute).not.toHaveBeenCalled();
			expect(status).not.toHaveBeenCalled();
			expect(await readFile(env.storePath)).toEqual(before);
		} finally {
			await env.host.close();
		}
	});

	it("keeps the instance for the Pod and changes the start with every process start", () => {
		const first = runtimeHostSourceIdentityV1(podUid, "start-1");
		const restarted = runtimeHostSourceIdentityV1(podUid, "start-2");
		const otherPod = runtimeHostSourceIdentityV1(
			"99999999-9b3e-4d1a-8c7f-2e6b5a4d3c21",
			"start-1",
		);
		expect(restarted.instanceRef).toBe(first.instanceRef);
		expect(restarted.startRef).not.toBe(first.startRef);
		expect(otherPod.instanceRef).not.toBe(first.instanceRef);
		for (const value of [first.instanceRef, first.startRef])
			expect(value).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
		expect(JSON.stringify(first)).not.toContain(podUid);
		expect(() =>
			createRuntimeHostSourceReadV1({
				podUid: "not-a-pod-uid",
				identity: first,
				readHostSessionBinding: async () => undefined,
			}),
		).toThrow();
	});

	it("exists only when the Host knows its Pod UID and needs the service token", async () => {
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
			const path = "/internal/runtime/v1/host-source/read";
			expect(
				(await createRuntimeHostApp(options).request(path, post(env.request())))
					.status,
			).toBe(404);
			const enabled = createRuntimeHostApp({
				...options,
				hostSourceRead: env.source,
			});
			expect(
				(
					await enabled.request(path, {
						...post(env.request()),
						headers: { "content-type": "application/json" },
					})
				).status,
			).toBe(401);
			const response = await enabled.request(path, post(env.request()));
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ host: env.identity });
			expect(
				(
					await enabled.request(
						path,
						post(env.request({ sessionGeneration: 9 })),
					)
				).status,
			).toBe(409);
		} finally {
			await env.host.close();
		}
	});
});
