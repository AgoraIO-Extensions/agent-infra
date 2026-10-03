import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	serve: vi.fn(),
	close: vi.fn(),
	createReads: vi.fn(),
	createApp: vi.fn(),
}));
vi.mock("@hono/node-server", () => ({ serve: mocks.serve }));
vi.mock("./native-metadata-runtime.js", () => ({
	createPlatformNativeMetadataReadWorkerV1: mocks.createReads,
}));
vi.mock("./native-metadata-app.js", () => ({
	createPlatformNativeMetadataAppV1: mocks.createApp,
}));

import {
	type PlatformNativeMetadataWorkerOptionsV1,
	startPlatformNativeMetadataWorkerV1,
} from "./native-metadata-deployment.js";

const options: PlatformNativeMetadataWorkerOptionsV1 = {
	hostname: "127.0.0.1",
	port: 8088,
	apiSources: new Map([["api-1", "api-secret"]]),
	hosts: new Map([["host-1", "host-secret"]]),
	runtime: {
		maxActiveReads: 2,
		current: async () => ({ outcome: "unavailable" }),
		resolveHost: async () => {
			throw new Error("No runtime input in lifecycle fixture");
		},
		signProof: () => {
			throw new Error("No runtime input in lifecycle fixture");
		},
	},
};
function serverFixture() {
	const server = Object.assign(new EventEmitter(), {
		closeAllConnections: vi.fn(),
		close: vi.fn((callback: (error?: Error) => void) => {
			queueMicrotask(() => {
				server.emit("close");
				callback();
			});
		}),
	});
	return server;
}
beforeEach(() => {
	vi.resetAllMocks();
	mocks.createReads.mockReturnValue({ close: mocks.close });
	mocks.createApp.mockReturnValue({ fetch: () => new Response() });
});

it("starts at the explicit deployment address and closes reads/connections once on repeated stop", async () => {
	const server = serverFixture();
	mocks.serve.mockImplementation((_input: unknown, listening: () => void) => {
		queueMicrotask(() => {
			server.emit("listening");
			listening();
		});
		return server;
	});
	const abort = new AbortController();
	const remove = vi.spyOn(abort.signal, "removeEventListener");
	const worker = await startPlatformNativeMetadataWorkerV1(
		options,
		abort.signal,
	);
	expect(mocks.serve).toHaveBeenCalledWith(
		{
			fetch: expect.any(Function),
			hostname: "127.0.0.1",
			port: 8088,
		},
		expect.any(Function),
	);
	const stopping = worker.stop();
	expect(worker.stop()).toBe(stopping);
	await stopping;
	abort.abort();
	expect(mocks.close).toHaveBeenCalledOnce();
	expect(server.closeAllConnections).toHaveBeenCalledOnce();
	expect(server.close).toHaveBeenCalledOnce();
	expect(remove.mock.calls.filter(([event]) => event === "abort")).toHaveLength(
		2,
	);
});

it("fails closed on bind error and removes its startup Abort listener", async () => {
	const server = serverFixture();
	mocks.serve.mockImplementation(() => {
		queueMicrotask(() => server.emit("error", new Error("private-bind-error")));
		return server;
	});
	const abort = new AbortController();
	const remove = vi.spyOn(abort.signal, "removeEventListener");
	await expect(
		startPlatformNativeMetadataWorkerV1(options, abort.signal),
	).rejects.toThrow("Metadata listener is unavailable");
	expect(mocks.close).toHaveBeenCalled();
	expect(server.close).toHaveBeenCalledOnce();
	expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
});

it("cancels an unready listener and invalidates reads before closing active connections", async () => {
	const server = serverFixture();
	mocks.serve.mockReturnValue(server);
	const abort = new AbortController();
	const starting = startPlatformNativeMetadataWorkerV1(options, abort.signal);
	const rejected = expect(starting).rejects.toThrow(
		"Metadata startup interrupted",
	);
	abort.abort();
	await rejected;
	expect(mocks.close.mock.invocationCallOrder[0]).toBeLessThan(
		server.closeAllConnections.mock.invocationCallOrder[0] ?? 0,
	);
	expect(server.close).toHaveBeenCalledOnce();
});

it("does not allocate reads/listener when deployment is invalid or process already stopped", async () => {
	const abort = new AbortController();
	for (const invalid of [
		{ ...options, port: 0 },
		{ ...options, port: 65536 },
		{ ...options, hostname: "" },
	])
		await expect(
			startPlatformNativeMetadataWorkerV1(invalid, abort.signal),
		).rejects.toThrow();
	abort.abort();
	await expect(
		startPlatformNativeMetadataWorkerV1(options, abort.signal),
	).rejects.toThrow();
	expect(mocks.createReads).not.toHaveBeenCalled();
	expect(mocks.serve).not.toHaveBeenCalled();
});
