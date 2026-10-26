import assert from "node:assert/strict";
import { test } from "node:test";

import {
	parseWorkerOperations,
	summarizeStageLatency,
} from "./stage-latency.mjs";

const execution = "123e4567-e89b-42d3-a456-426614174001";
const log = (fields) =>
	JSON.stringify({ msg: "operation", service: "platform-worker", ...fields });

test("summarizes per-execution stages from Worker operations and database facts", () => {
	const operations = parseWorkerOperations(
		[
			log({
				executionId: execution,
				stage: "authorization",
				operationRef: "drain.authorization",
				durationMs: 100,
				time: "2026-10-19T00:00:02.100Z",
			}),
			// 重试的第二次授权只计入耗时，认领时间取首次开始。
			log({
				executionId: execution,
				stage: "authorization",
				operationRef: "drain.authorization",
				durationMs: 50,
				time: "2026-10-19T00:00:09.000Z",
			}),
			log({
				executionId: execution,
				stage: "worker",
				operationRef: "drain.prepare",
				durationMs: 300,
				time: "2026-10-19T00:00:02.400Z",
			}),
			log({
				executionId: execution,
				stage: "runtime",
				durationMs: 400,
				time: "2026-10-19T00:00:02.800Z",
			}),
			log({
				executionId: execution,
				stage: "result_persist",
				operationRef: "drain.persist_batch",
				durationMs: 20,
				time: "2026-10-19T00:00:04.000Z",
			}),
			// 非阶段日志、无执行标识与非 JSON 行都被忽略。
			log({
				stage: "task_wait",
				operationRef: "conversation.queue.find",
				durationMs: 5,
			}),
			log({
				executionId: execution,
				stage: "model",
				operationRef: "model-1",
				durationMs: 9,
			}),
			"not json",
		].join("\n"),
	);
	const result = summarizeStageLatency(operations, [
		{
			executionId: execution,
			channelId: "web",
			acceptedAt: "2026-10-19T00:00:00.000Z",
			firstTextAt: "2026-10-19T00:00:03.000Z",
			terminalOccurredAt: "2026-10-19T00:00:04.000Z",
			terminalPersistedAt: "2026-10-19T00:00:04.500Z",
			deliveredAt: null,
		},
	]);
	assert.deepEqual(result.stages.accepted_to_claim, {
		n: 1,
		p50Ms: 2000,
		p90Ms: 2000,
		maxMs: 2000,
	});
	assert.equal(result.stages["drain.authorization"].n, 2);
	assert.equal(result.stages["runtime.submit"].p50Ms, 400);
	assert.equal(result.stages["drain.persist_batch"].p50Ms, 20);
	assert.equal(result.stages.accepted_to_first_text.p50Ms, 3000);
	assert.equal(result.stages.terminal_persist_lag.p50Ms, 500);
	assert.equal(result.stages.terminal_to_delivered, undefined);
	assert.deepEqual(result.executions, [
		{
			executionId: execution,
			"drain.authorization": 150,
			"drain.prepare": 300,
			"runtime.submit": 400,
			"drain.persist_batch": 20,
			channelId: "web",
			accepted_to_claim: 2000,
			accepted_to_first_text: 3000,
			accepted_to_terminal: 4500,
			terminal_persist_lag: 500,
		},
	]);
});

test("returns no stages without observations", () => {
	assert.deepEqual(summarizeStageLatency(parseWorkerOperations(""), []), {
		stages: {},
		executions: [],
	});
});
