import type {
	NativeMetadataCurrentRequestV1,
	NativeMetadataCurrentResponseV1,
	PlatformNativeMetadataReadRequestV1,
} from "@agent-infra/contracts";
import { ConversationRuntimeHostError } from "@agent-infra/platform-core";
import { expect, it, vi } from "vitest";
import { createPlatformNativeMetadataAppV1 } from "./native-metadata-app.js";

const readPath = "/internal/platform-worker/v1/native-metadata/reads";
const currentPath = `${readPath}/read-1/current`;
function fixture() {
	const now = Date.now();
	const request: PlatformNativeMetadataReadRequestV1 = {
		schemaVersion: 1,
		readId: "read-1",
		selector: "status",
		scope: {
			schemaVersion: 1,
			principal: { kind: "user", id: "alice" },
			agentId: "agent",
			channelId: "web",
			conversationId: "conversation",
			executionId: "execution",
			sessionGeneration: 1,
			authorizationRevision: "original-revision",
		},
		readStartedAt: now,
		expiresAt: now + 20_000,
		requestId: "request",
		traceId: "trace",
		apiRequestSourceRef: "api-1",
	};
	const { apiRequestSourceRef: _source, ...identity } = request;
	const response = {
		...identity,
		originalHostScopeRef: "a".repeat(64),
		projection: {
			selector: "status" as const,
			status: "idle" as const,
			readAt: new Date().toISOString(),
		},
	};
	const current: NativeMetadataCurrentRequestV1 = {
		...identity,
		phase: "resolve_original_binding",
		originalHostScopeRef: null,
	};
	const reads = {
		read: vi.fn(async () => response),
		current: vi.fn<
			(
				_request: NativeMetadataCurrentRequestV1,
				_host: string,
				_signal: AbortSignal,
			) => Promise<NativeMetadataCurrentResponseV1>
		>(async () => ({
			outcome: "allowed" as const,
			request: current,
		})),
	};
	const apiSources = new Map([["api-1", "api-secret"]]);
	const hosts = new Map([["host-1", "host-secret"]]);
	return {
		request,
		current,
		response,
		reads,
		apiSources,
		hosts,
		app: createPlatformNativeMetadataAppV1({ reads, apiSources, hosts }),
	};
}
function post(
	path: string,
	body: unknown,
	token: string,
	signal?: AbortSignal,
) {
	return new Request(`http://worker${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
		signal,
	});
}

it("authenticates exact API and Host roles before parsing any wire", async () => {
	const { app, request, current, reads } = fixture();
	for (const [path, body, token] of [
		[readPath, request, "host-secret"],
		[currentPath, current, "api-secret"],
		[readPath, { invalid: "wire" }, "unknown-secret"],
	] as const) {
		const response = await app.request(post(path, body, token));
		expect(response.status).toBe(401);
	}
	expect(reads.read).not.toHaveBeenCalled();
	expect(reads.current).not.toHaveBeenCalled();
});

it("passes trusted instance identity and request AbortSignal to the actual producer", async () => {
	const { app, request, current, response, reads } = fixture();
	const read = post(readPath, request, "api-secret");
	expect(await (await app.request(read)).json()).toEqual(response);
	expect(reads.read).toHaveBeenCalledWith(request, "api-1", read.signal);
	const confirmation = post(currentPath, current, "host-secret");
	expect(await (await app.request(confirmation)).json()).toEqual({
		outcome: "allowed",
		request: current,
	});
	expect(reads.current).toHaveBeenCalledWith(
		current,
		"host-1",
		confirmation.signal,
	);
});

it("rejects unknown fields, extra query, invalid JSON, oversize and path/body readId mismatch before producer", async () => {
	const { app, request, current, reads } = fixture();
	const invalid = [
		post(readPath, { ...request, workerId: "self-claimed" }, "api-secret"),
		post(`${readPath}?selector=status`, request, "api-secret"),
		post(currentPath, { ...current, readId: "another-read" }, "host-secret"),
		post(
			currentPath,
			{ ...current, nativeSessionId: "private" },
			"host-secret",
		),
		post(readPath, { padding: "x".repeat(65_536) }, "api-secret"),
		new Request(`http://worker${readPath}`, {
			method: "POST",
			headers: { authorization: "Bearer api-secret" },
			body: "not-json",
		}),
	];
	for (const bad of invalid) expect((await app.request(bad)).status).toBe(400);
	expect(reads.read).not.toHaveBeenCalled();
	expect(reads.current).not.toHaveBeenCalled();
});

it("keeps trusted service mappings fixed after caller mutates its deployment maps", async () => {
	const { app, request, apiSources } = fixture();
	apiSources.set("api-1", "replacement-secret");
	apiSources.set("evil-api", "evil-secret");
	expect(
		(await app.request(post(readPath, request, "api-secret"))).status,
	).toBe(200);
	expect(
		(await app.request(post(readPath, request, "replacement-secret"))).status,
	).toBe(401);
	expect(
		(await app.request(post(readPath, request, "evil-secret"))).status,
	).toBe(401);
});

it("rejects credential reuse across service identities and roles at startup", () => {
	const { reads } = fixture();
	for (const apiSources of [
		new Map([
			["api-1", "shared-secret"],
			["api-2", "shared-secret"],
		]),
		new Map([["api-1", "host-secret"]]),
		new Map([["api-1", "invalid token"]]),
		new Map<string, string>(),
	]) {
		expect(() =>
			createPlatformNativeMetadataAppV1({
				reads,
				apiSources,
				hosts: new Map([["host-1", "host-secret"]]),
			}),
		).toThrow();
	}
});

it("withholds late successful bytes after cancellation and redacts producer failures", async () => {
	const { app, request, response, reads } = fixture();
	const abort = new AbortController();
	reads.read.mockImplementationOnce(async () => {
		abort.abort();
		return response;
	});
	const late = await app.request(
		post(readPath, request, "api-secret", abort.signal),
	);
	expect(late.status).toBe(503);
	expect(await late.text()).not.toContain("originalHostScopeRef");
	for (const [error, status] of [
		[new ConversationRuntimeHostError("NATIVE_METADATA_DENIED", false), 403],
		[new Error("private-native-path-and-credential-sentinel"), 503],
	] as const) {
		reads.read.mockRejectedValueOnce(error);
		const failed = await app.request(post(readPath, request, "api-secret"));
		expect(failed.status).toBe(status);
		expect(await failed.text()).not.toContain(
			"private-native-path-and-credential-sentinel",
		);
	}
});

it("maps current confirmation outcomes to exact HTTP states without treating denial as availability", async () => {
	const { app, current, reads } = fixture();
	for (const [outcome, status] of [
		["denied", 403],
		["unavailable", 503],
	] as const) {
		reads.current.mockResolvedValueOnce({ outcome });
		const response = await app.request(
			post(currentPath, current, "host-secret"),
		);
		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({ outcome });
	}
});
