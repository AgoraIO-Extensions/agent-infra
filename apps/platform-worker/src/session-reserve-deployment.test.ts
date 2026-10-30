import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	start: vi.fn(),
	stop: vi.fn(async () => {}),
}));
vi.mock("./session-reserve-worker.js", () => ({
	createPlatformSessionReserveWorkerV1: mocks.create,
}));

import { startPlatformSessionReserveWorkerFromDeploymentV1 as start } from "./session-reserve-deployment.js";

const moduleSource = (code: string) =>
	`data:text/javascript,${encodeURIComponent(code)}`;
afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});
it("leaves existing deployment modules without a reserve factory unchanged", async () => {
	expect(
		await start(moduleSource("export const oldDeployment = true")),
	).toBeUndefined();
	expect(mocks.create).not.toHaveBeenCalled();
});
it("does not create a Store when the trusted factory has no reserve configuration", async () => {
	expect(
		await start(
			moduleSource(
				"export function createPlatformSessionReserveWorkerOptionsV1() { return undefined }",
			),
		),
	).toBeUndefined();
	expect(mocks.create).not.toHaveBeenCalled();
});
it("passes the deployment options and process signal and starts exactly once", async () => {
	const options = {
		databaseUrl: "postgres://fixture",
		configuration: { enabled: false },
	};
	vi.stubGlobal("reserve3778Options", options);
	const controller = new AbortController();
	const worker = { start: mocks.start, stop: mocks.stop };
	mocks.create.mockReturnValue(worker);
	expect(
		await start(
			moduleSource(
				"export function createPlatformSessionReserveWorkerOptionsV1() { return globalThis.reserve3778Options }",
			),
			controller.signal,
		),
	).toBe(worker);
	expect(mocks.create).toHaveBeenCalledWith({
		...options,
		signal: controller.signal,
	});
	expect(mocks.start).toHaveBeenCalledOnce();
});
it("does not start a loop when shutdown interrupts asynchronous assembly", async () => {
	const controller = new AbortController();
	vi.stubGlobal("reserve3778Abort", () => controller.abort());
	await expect(
		start(
			moduleSource(
				"export async function createPlatformSessionReserveWorkerOptionsV1() { globalThis.reserve3778Abort(); return { databaseUrl:'fixture' } }",
			),
			controller.signal,
		),
	).rejects.toThrow();
	expect(mocks.create).not.toHaveBeenCalled();
});
it("redacts trusted module errors instead of logging private configuration contents", async () => {
	const secret = "private-configuration-sentinel";
	await expect(
		start(
			moduleSource(
				`export function createPlatformSessionReserveWorkerOptionsV1() { throw new Error('${secret}') }`,
			),
		),
	).rejects.toThrow("SESSION_RESERVE_DEPLOYMENT_UNAVAILABLE");
});
it("rejects an invalid factory instead of silently disabling a requested reserve loop", async () => {
	await expect(
		start(
			moduleSource(
				"export const createPlatformSessionReserveWorkerOptionsV1 = false",
			),
		),
	).rejects.toThrow("SESSION_RESERVE_DEPLOYMENT_UNAVAILABLE");
});
