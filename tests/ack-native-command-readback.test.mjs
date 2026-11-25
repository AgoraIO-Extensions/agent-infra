import assert from "node:assert/strict";
import test from "node:test";
import {
	readNativeCommandTerminal,
	reviewReadbackPassed,
} from "../deploy/ack/native-command-readback.mjs";

for (const status of ["completed", "failed", "cancelled"]) {
	test(`polls only the original execution through unknown to ${status} and rereads after reconnect`, async () => {
		const calls = [];
		const statuses = ["unknown", status, status];
		const readDetail = async () => {
			calls.push("read");
			const event = {
				executionId: "original",
				type: "execution.status",
				payload: { status: statuses.shift() },
			};
			return {
				events: [
					event,
					{ ...event, executionId: "other", payload: { status: "completed" } },
				],
			};
		};
		const result = await readNativeCommandTerminal({
			executionId: "original",
			readDetail,
			reconnect: () => calls.push("reload"),
			intervalMs: 1,
		});
		assert.deepEqual(result, {
			terminalStatus: status,
			reconnectedStatus: status,
		});
		assert.deepEqual(calls, ["read", "read", "reload", "read"]);
	});
}
test("unknown at the deadline stays unresolved even if a later reload sees completion", async () => {
	let status = "unknown";
	const result = await readNativeCommandTerminal({
		executionId: "original",
		timeoutMs: 0,
		reconnect() {
			status = "completed";
		},
		readDetail: async () => ({
			events: [
				{
					executionId: "original",
					type: "execution.status",
					payload: { status },
				},
			],
		}),
	});
	assert.deepEqual(result, {
		terminalStatus: "unknown",
		reconnectedStatus: "completed",
	});
});

test("only one completed review in both snapshots passes the ACK gate", () => {
	const receipt = {
		command: "/review",
		invocationCount: 1,
		httpStatus: 202,
		executionHash: "1".repeat(64),
		terminalStatus: "completed",
		reconnectedStatus: "completed",
	};
	assert.equal(reviewReadbackPassed(receipt), true);
	for (const change of [
		{ terminalStatus: "failed" },
		{ reconnectedStatus: "unknown" },
		{ invocationCount: 2 },
		{ executionHash: "" },
		{ httpStatus: 200 },
		{ command: "/other" },
	]) {
		assert.equal(reviewReadbackPassed({ ...receipt, ...change }), false);
	}
});
