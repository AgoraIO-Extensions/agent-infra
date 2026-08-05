import { describe, expect, it } from "vitest";

import { startPlatformWorker } from "./index";

describe("platform worker lifecycle", () => {
	it("reports ready and stops idempotently", () => {
		const messages: string[] = [];
		const worker = startPlatformWorker({
			heartbeatMs: 10,
			log: (message) => messages.push(message),
		});

		worker.stop();
		worker.stop();

		expect(messages.map((message) => JSON.parse(message))).toEqual([
			{ service: "platform-worker", status: "ready" },
			{ service: "platform-worker", status: "stopped" },
		]);
	});
});
