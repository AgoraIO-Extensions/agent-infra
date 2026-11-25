import assert from "node:assert/strict";
import test from "node:test";
import { validateNativeCommandReadback } from "../deploy/ack/native-command-readback.mjs";

test("accepts one 202 invocation followed by terminal and reconnect readback", () => {
	assert.deepEqual(validateNativeCommandReadback({
		httpStatus: 202,
		executionId: "execution-1",
		terminalStatus: "failed",
		reconnected: true,
		initialRequestCount: 1,
	}), { status: "passed" });
});

test("blocks missing terminal, reconnect, or duplicate-submit evidence", () => {
	const result = validateNativeCommandReadback({
		httpStatus: 202,
		executionId: "execution-1",
		terminalStatus: "unknown",
		reconnected: false,
		initialRequestCount: 2,
	});
	assert.deepEqual(result, { status: "blocked", reasons: [
		"readback:terminal-status", "readback:reconnect", "readback:duplicate-submit",
	] });
});
