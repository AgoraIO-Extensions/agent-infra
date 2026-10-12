import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	NativeMetadataProjectionV1,
	RuntimeNativeMetadataReadRequestV1,
} from "@agent-infra/contracts/runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	FakeRuntimeDriver,
	FileRuntimeStore,
	RuntimeHost,
	type RuntimeHostNativeMetadataReadContextV1,
} from "./index.js";

const directories: string[] = [];

function request(now: number): RuntimeNativeMetadataReadRequestV1 {
	return {
		schemaVersion: 1,
		readId: "metadata-read-1",
		selector: "status",
		scope: {
			schemaVersion: 1,
			principal: { kind: "user", id: "reader-1" },
			agentId: "agent-1",
			channelId: "channel-1",
			conversationId: "conversation-1",
			executionId: "execution-1",
			sessionGeneration: 1,
			authorizationRevision: "authorization-1",
		},
		readStartedAt: now - 1_000,
		expiresAt: now + 10_000,
		requestId: "request-1",
		traceId: "trace-1",
		originalHostScopeRef: "host-scope-1",
		proof: { schemaVersion: 1, format: "native-metadata-jws", token: "proof" },
	};
}

function context(
	value: RuntimeNativeMetadataReadRequestV1,
	options: {
		readonly now?: () => number;
		readonly controller?: AbortController;
	} = {},
): RuntimeHostNativeMetadataReadContextV1 {
	const abort = options.controller ?? new AbortController();
	const authority = {
		principal: value.scope.principal,
		scope: {
			agentId: value.scope.agentId,
			conversationId: value.scope.conversationId,
			executionId: value.scope.executionId,
			sessionGeneration: value.scope.sessionGeneration,
		},
	};
	return {
		nativeSessionRef: "native-session-1",
		signal: abort.signal,
		expiresAt: value.expiresAt,
		scope: value.scope,
		originalHostScopeRef: value.originalHostScopeRef,
		assertCurrent: () => authority,
		revalidate: async () => authority,
		verifyProof: vi.fn(),
		...(options.now ? { now: options.now } : {}),
	};
}

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "native-metadata-host-"));
	directories.push(directory);
	const store = await FileRuntimeStore.open(join(directory, "host.json"));
	const driver = await FakeRuntimeDriver.open(join(directory, "driver.json"));
	const host = await RuntimeHost.open({
		store,
		driver,
		grantValidation: { expectedIssuer: "agent-platform" },
	});
	return { driver, host, request: request(Date.now()), store };
}

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true })),
	);
});

describe("RuntimeHost native metadata V1 receiver", () => {
	it("validates the current/proof context and returns a strict status response", async () => {
		const f = await fixture();
		const projection: NativeMetadataProjectionV1 = {
			selector: "status",
			status: "idle",
			readAt: new Date().toISOString(),
		};
		const readNativeMetadataV1 = vi.fn().mockResolvedValue(projection);
		Object.assign(f.driver, { readNativeMetadataV1 });
		const read = context(f.request);
		const response = await f.host.readNativeMetadataV1(f.request, read);
		expect(response).toMatchObject({
			readId: f.request.readId,
			selector: "status",
			originalHostScopeRef: f.request.originalHostScopeRef,
			projection,
		});
		expect(response).not.toHaveProperty("proof");
		expect(readNativeMetadataV1).toHaveBeenCalledWith("status", read);
		await f.host.close();
	});

	it.each([
		"cross-scope",
		"stale",
		"expired",
		"aborted",
		"selector-mismatch",
		"proof-denied",
	] as const)("rejects %s before Driver I/O", async (failure) => {
		const f = await fixture();
		const readNativeMetadataV1 = vi.fn().mockResolvedValue({
			selector: "status",
			status: "idle",
			readAt: new Date().toISOString(),
		} satisfies NativeMetadataProjectionV1);
		Object.assign(f.driver, { readNativeMetadataV1 });
		let value = f.request;
		const controller = new AbortController();
		const read = context(value, { now: () => Date.now(), controller });
		if (failure === "cross-scope") {
			value = { ...value, scope: { ...value.scope, agentId: "other-agent" } };
		} else if (failure === "stale") {
			Object.assign(read, {
				assertCurrent: () => {
					throw new Error("private stale context");
				},
			});
		} else if (failure === "expired") {
			value = { ...value, expiresAt: value.readStartedAt + 1 };
			Object.assign(read, {
				expiresAt: value.expiresAt,
				now: () => value.expiresAt,
			});
		} else if (failure === "aborted") {
			controller.abort();
		} else if (failure === "selector-mismatch") {
			value = { ...value, selector: "commands" };
		} else {
			Object.assign(read, {
				verifyProof: vi.fn().mockRejectedValue(new Error("private proof")),
			});
		}
		await expect(
			f.host.readNativeMetadataV1(value, read),
		).rejects.toMatchObject({
			code: "RUNTIME_GRANT_INVALID",
		});
		expect(readNativeMetadataV1).not.toHaveBeenCalled();
		await f.host.close();
	});

	it("rejects a Driver projection whose selector does not match", async () => {
		const f = await fixture();
		const readNativeMetadataV1 = vi.fn().mockResolvedValue({
			selector: "commands",
			revision: "a".repeat(64),
			capabilities: [],
		});
		Object.assign(f.driver, { readNativeMetadataV1 });
		await expect(
			f.host.readNativeMetadataV1(f.request, context(f.request)),
		).rejects.toMatchObject({ code: "RUNTIME_DRIVER_INVALID" });
		await f.host.close();
	});
});
