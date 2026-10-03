import type { PlatformNativeMetadataReadRequestV1 } from "@agent-infra/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { createPlatformNativeMetadataWorkerClientV1 as createClient } from "./native-metadata-client.js";

const origin = "https://worker-instance.invalid";
const endpoint = `${origin}/internal/platform-worker/v1/native-metadata/reads`;
const token = "SYNTHETIC_WORKER_SERVICE_TOKEN";
const sentinel = "SYNTHETIC_PRIVATE_RESPONSE_URL_TOKEN";
const safeError = { message: "Native metadata transport is unavailable" };
const options = {
	baseUrl: origin,
	serviceToken: token,
	apiRequestSourceRef: "api-1",
};
const signal = () => new AbortController().signal;
const clientFor = (fetch: typeof globalThis.fetch) =>
	createClient({ ...options, fetch });
function json(body: BodyInit, extra?: Record<string, string>) {
	return new Response(body, {
		headers: { "content-type": "application/json", ...extra },
	});
}
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
	const readAt = new Date(now).toISOString();
	const response = {
		...identity,
		originalHostScopeRef: "a".repeat(64),
		projection: { selector: "status", status: "idle", readAt },
	};
	return { request, response };
}
afterEach(() => vi.useRealTimers());

it("uses the fixed instance, credentials, original signal and unchanged expiry", async () => {
	const { request, response } = fixture();
	const send = vi.fn<typeof fetch>(async () => Response.json(response));
	const mutable = { ...options, fetch: send };
	const client = createClient(mutable);
	Object.assign(mutable, {
		baseUrl: sentinel,
		serviceToken: sentinel,
		apiRequestSourceRef: "api-2",
	});
	const original = signal();
	await expect(client.submit(request, original)).resolves.toEqual(response);
	expect(send).toHaveBeenCalledTimes(1);
	expect(send).toHaveBeenCalledWith(endpoint, {
		method: "POST",
		redirect: "error",
		credentials: "omit",
		cache: "no-store",
		signal: original,
		body: JSON.stringify(request),
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
			accept: "application/json",
			"x-trace-id": request.traceId,
		},
	});
});

it("rejects incorrect source, unknown URL fields, abort and expired input with zero I/O", async () => {
	const { request } = fixture();
	const send = vi.fn<typeof fetch>();
	const client = clientFor(send);
	for (const input of [
		{ ...request, apiRequestSourceRef: "api-2" },
		{ ...request, callbackUrl: sentinel },
		{ ...request, expiresAt: request.readStartedAt },
	])
		await expect(client.submit(input, signal())).rejects.toMatchObject(
			safeError,
		);
	await expect(
		client.submit(request, AbortSignal.abort(sentinel)),
	).rejects.toMatchObject(safeError);
	expect(send).not.toHaveBeenCalled();
});

it("rejects credentials, paths, query and fragments in the deployment origin", () => {
	for (const baseUrl of [
		sentinel,
		`https://${sentinel}@worker.invalid`,
		`${origin}/path`,
		`${origin}?${sentinel}`,
		`${origin}#${sentinel}`,
		"file:///private",
	])
		expect(() => createClient({ ...options, baseUrl })).toThrow(
			safeError.message,
		);
	for (const serviceToken of ["", `${sentinel}\n`])
		expect(() => createClient({ ...options, serviceToken })).toThrow(
			safeError.message,
		);
});

it("withholds redirects, foreign URLs, errors, unknown fields, invalid or oversized JSON", async () => {
	const { request, response } = fixture();
	const redirected = Response.json(response);
	Object.defineProperty(redirected, "redirected", { value: true });
	const foreign = Response.json(response);
	Object.defineProperty(foreign, "url", {
		value: `https://${sentinel}.invalid`,
	});
	for (const result of [
		redirected,
		foreign,
		new Response(sentinel, { status: 302 }),
		new Response(sentinel, { status: 503 }),
		Response.json({ ...response, privateField: sentinel }),
		json(sentinel),
		json(new Uint8Array([0xff])),
		new Response(JSON.stringify(response)),
		json("{}", { "content-length": "8388609" }),
		json(new Uint8Array(8_388_609)),
	]) {
		const pending = clientFor(async () => result).submit(request, signal());
		const error = await pending.catch((failure) => failure);
		expect(error).toMatchObject(safeError);
		expect(String(error)).not.toContain(sentinel);
		expect(error.cause).toBeUndefined();
	}
	const client = clientFor(async () => {
		throw new Error(`${sentinel} ${token} ${endpoint}`);
	});
	const pending = client.submit(request, signal());
	await expect(pending).rejects.toMatchObject(safeError);
});

it("bounds non-cooperative fetch by fixed expiry and cancels its late response", async () => {
	vi.useFakeTimers();
	const { request, response } = fixture();
	let finish: (response: Response) => void = () => {};
	const fetcher = () =>
		new Promise<Response>((resolve) => {
			finish = resolve;
		});
	const pending = clientFor(fetcher).submit(request, signal());
	const rejected = expect(pending).rejects.toMatchObject(safeError);
	await vi.advanceTimersByTimeAsync(20_001);
	await rejected;
	const late = json(JSON.stringify(response));
	const cancel = vi.spyOn(late.body as ReadableStream<Uint8Array>, "cancel");
	finish(late);
	await Promise.resolve();
	expect(cancel).toHaveBeenCalledTimes(1);
	expect(vi.getTimerCount()).toBe(0);
});

it("withholds late body bytes after abort or deadline and cancels pending reads", async () => {
	vi.useFakeTimers();
	for (const reason of ["abort", "deadline"] as const) {
		const { request } = fixture();
		const controller = new AbortController();
		let body: ReadableStreamDefaultController<Uint8Array> | undefined;
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			start: (value) => {
				body = value;
			},
			cancel,
		});
		const client = clientFor(async () => json(stream));
		const pending = client.submit(request, controller.signal);
		const rejected = expect(pending).rejects.toMatchObject(safeError);
		await vi.advanceTimersByTimeAsync(0);
		if (reason === "abort") controller.abort(sentinel);
		else await vi.advanceTimersByTimeAsync(20_001);
		await rejected;
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(() => body?.enqueue(new TextEncoder().encode("{}"))).toThrow();
		expect(vi.getTimerCount()).toBe(0);
	}
});
