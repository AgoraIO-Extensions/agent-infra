import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { openPiRpc } from "./pi-rpc.js";

const { spawnNativeProcess } = vi.hoisted(() => ({
	spawnNativeProcess: vi.fn(),
}));
vi.mock("./native-process.js", () => ({ spawnNativeProcess }));

it("releases the model transport even when owned process cleanup fails", async () => {
	const cleanupError = new Error("synthetic ownership cleanup failure");
	const ownedClose = vi.fn().mockRejectedValue(cleanupError);
	const launchClose = vi.fn().mockResolvedValue(undefined);
	const onExit = vi.fn();
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	spawnNativeProcess.mockResolvedValue({
		child: { stdin, stdout },
		close: ownedClose,
		exited: new Promise<void>(() => {}),
	});
	const rpc = await openPiRpc(
		"synthetic-directory",
		"synthetic-workspace",
		{ command: "synthetic", args: [], env: {}, close: launchClose },
		() => {},
		onExit,
	);
	const pending = expect(rpc.request("get_state")).rejects.toThrow(
		"RUNTIME_NATIVE_SESSION_UNAVAILABLE",
	);
	await expect(rpc.close()).rejects.toBe(cleanupError);
	await pending;
	await expect(rpc.close()).rejects.toBe(cleanupError);
	expect(ownedClose).toHaveBeenCalledTimes(1);
	expect(launchClose).toHaveBeenCalledTimes(1);
	expect(onExit).toHaveBeenCalledTimes(1);
	expect(rpc.reusable()).toBe(false);
	stdin.destroy();
	stdout.destroy();
});
