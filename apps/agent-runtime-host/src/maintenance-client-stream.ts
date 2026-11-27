import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { IPty } from "node-pty";

export function serveMaintenanceClient(
	terminal: Pick<
		IPty,
		"write" | "resize" | "kill" | "pause" | "resume" | "onData" | "onExit"
	>,
	source: Readable,
	sink: Writable,
) {
	const input = createInterface({ input: source });
	const lease = setTimeout(detach, 15_000);
	let detached = false;

	function detach() {
		if (detached) return;
		detached = true;
		clearTimeout(lease);
		terminal.kill();
	}

	input.on("line", (line) => {
		if (detached) return;
		try {
			const frame = JSON.parse(line);
			if (frame === "detach") return detach();
			lease.refresh();
			if (frame === "ping") return;
			if (typeof frame.input === "string" && frame.input.length <= 43_692)
				return terminal.write(Buffer.from(frame.input, "base64"));
			if (
				Number.isInteger(frame.cols) &&
				frame.cols >= 2 &&
				frame.cols <= 500 &&
				Number.isInteger(frame.rows) &&
				frame.rows >= 1 &&
				frame.rows <= 200
			)
				return terminal.resize(frame.cols, frame.rows);
			detach();
		} catch {
			detach();
		}
	});
	input.once("close", detach);
	sink.once("error", detach);
	terminal.onData((data) => {
		if (!sink.write(data)) terminal.pause();
	});
	sink.on("drain", () => terminal.resume());
	terminal.onExit(() => {
		detached = true;
		clearTimeout(lease);
		input.close();
		source.destroy();
	});

	return detach;
}
