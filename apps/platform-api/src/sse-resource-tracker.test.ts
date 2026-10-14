import { describe, expect, it } from "vitest";
import { SseResourceTracker } from "./sse-resource-tracker.js";

describe("SseResourceTracker", () => {
	it("counts live streams and writes once, including duplicate cleanup", () => {
		const tracker = new SseResourceTracker();
		const connection = tracker.open();
		const first = tracker.beginPending();
		const second = tracker.beginPending();
		expect(tracker.snapshot()).toEqual({ connections: 1, pendingEvents: 2 });
		first.close();
		first.close();
		connection.close();
		connection.close();
		expect(tracker.snapshot()).toEqual({ connections: 0, pendingEvents: 1 });
		second.close();
		expect(tracker.snapshot()).toEqual({ connections: 0, pendingEvents: 0 });
	});
});
