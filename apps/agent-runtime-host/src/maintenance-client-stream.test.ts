import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { serveMaintenanceClient } from "./maintenance-client-stream.js";

function openClient() {
	const input = new PassThrough();
	const terminal = {
		write: vi.fn(),
		resize: vi.fn(),
		kill: vi.fn(),
		pause: vi.fn(),
		resume: vi.fn(),
		onData: vi.fn(),
		onExit: vi.fn(),
	};
	serveMaintenanceClient(terminal, input, new PassThrough());
	return { input, terminal };
}
afterEach(() => vi.useRealTimers());

it("detaches only the client whose gateway stopped renewing, even with stdin still open", () => {
	vi.useFakeTimers();
	const lost = openClient();
	const live = openClient();
	vi.advanceTimersByTime(10_000);
	live.input.write('"ping"\n');
	vi.advanceTimersByTime(5000);
	expect(lost.terminal.kill).toHaveBeenCalledOnce();
	expect(live.terminal.kill).not.toHaveBeenCalled();
	live.input.write('"detach"\n');
	vi.advanceTimersByTime(15_000);
	expect(live.terminal.kill).toHaveBeenCalledOnce();
});

it("passes terminal bytes and dimensions, and releases the client at EOF", async () => {
	const { input, terminal } = openClient();
	const bytes = Buffer.from([0, 3, 27, 128, 255]);
	input.write(JSON.stringify({ input: bytes.toString("base64") }));
	input.write('\n{"cols":103,"rows":36}\n');
	expect(terminal.write).toHaveBeenCalledWith(bytes);
	expect(terminal.resize).toHaveBeenCalledWith(103, 36);
	input.end();
	await new Promise<void>((resolve) => input.on("end", resolve));
	expect(terminal.kill).toHaveBeenCalledOnce();
});
