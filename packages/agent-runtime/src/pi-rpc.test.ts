import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { openPiRpc } from "./pi-rpc.js";

const { spawnNativeProcess } = vi.hoisted(() => ({
	spawnNativeProcess: vi.fn(),
}));
vi.mock("./native-process.js", () => ({ spawnNativeProcess }));

it.each([false, true])(
	"keeps ordinary request failures separate from invalid correlation (mismatch: %s)",
	async (mismatch) => {
		const stdin = new PassThrough();
		const stdout = new PassThrough();
		const ownedClose = vi.fn().mockResolvedValue(undefined);
		const onExit = vi.fn();
		spawnNativeProcess.mockResolvedValue({
			child: { stdin, stdout },
			close: ownedClose,
			exited: new Promise<void>(() => {}),
		});
		const rpc = await openPiRpc(
			"synthetic-directory",
			"synthetic-workspace",
			{ command: "synthetic", args: [], env: {} },
			() => {},
			onExit,
		);
		try {
			const first = expect(rpc.request("get_state")).rejects.toThrow(
				"RUNTIME_NATIVE_SESSION_UNAVAILABLE",
			);
			const request = JSON.parse(stdin.read().toString());
			const other = rpc.request("get_messages");
			const otherRequest = JSON.parse(stdin.read().toString());
			const otherResult = mismatch
				? expect(other).rejects.toThrow("RUNTIME_NATIVE_SESSION_UNAVAILABLE")
				: expect(other).resolves.toEqual({ messages: [] });
			stdout.write(
				`${JSON.stringify({ type: "response", id: request.id, command: mismatch ? "abort" : "get_state", success: false })}\n`,
			);
			await first;
			expect(rpc.reusable()).toBe(!mismatch);
			stdout.write(
				`${JSON.stringify({ type: "response", id: otherRequest.id, command: "get_messages", success: true, data: { messages: [] } })}\n`,
			);
			await otherResult;
			expect(onExit).toHaveBeenCalledTimes(mismatch ? 1 : 0);
			expect(ownedClose).toHaveBeenCalledTimes(mismatch ? 1 : 0);
		} finally {
			await rpc.close();
			stdin.destroy();
			stdout.destroy();
		}
	},
);

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
