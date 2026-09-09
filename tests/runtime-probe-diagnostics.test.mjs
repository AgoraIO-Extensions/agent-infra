import assert from "node:assert/strict";
import test from "node:test";
import { runCommand } from "../deploy/release/run-command.mjs";
import { safeRuntimeProbeFailure } from "../deploy/release/runtime-probe.mjs";

test("probe diagnostic only retains bounded permitted fields", () => {
	assert.deepEqual(
		JSON.parse(
			safeRuntimeProbeFailure(
				JSON.stringify({
					status: "failed",
					stage: "model-stop-request",
					startupCode: "synthetic-credential",
					responseCode: "RUNTIME_GENERATION_CANCELLED",
					httpStatus: 409,
					modelRequests: 21,
					isolationFileKind: "native-database",
				}),
			),
		),
		{
			status: "failed",
			stage: "model-stop-request",
			responseCode: "RUNTIME_GENERATION_CANCELLED",
			httpStatus: 409,
			modelRequests: 21,
			isolationFileKind: "native-database",
		},
	);
	assert.equal(
		safeRuntimeProbeFailure(
			JSON.stringify({
				status: "failed",
				stage: "synthetic-credential",
				startupCode: "RUNTIME_SYNTHETIC_SECRET",
				responseCode: "synthetic-credential",
				httpStatus: 999,
				modelRequests: 1001,
				isolationFileKind: "/private/synthetic",
			}),
		),
		'{"status":"failed"}',
	);
});
test("probe diagnostic rejects malformed, multiple, oversized or extended records", () => {
	for (const text of [
		"synthetic-credential",
		'{"status":"failed"}\n{"status":"failed"}',
		JSON.stringify({ status: "failed", body: "synthetic-credential" }),
		JSON.stringify({ status: "passed" }),
		"[]",
		"null",
		" ".repeat(4097),
	])
		assert.equal(safeRuntimeProbeFailure(text), undefined);
	for (const count of [-1, 1.5, Number.MAX_SAFE_INTEGER])
		assert.equal(
			safeRuntimeProbeFailure(
				JSON.stringify({ status: "failed", modelRequests: count }),
			),
			'{"status":"failed"}',
		);
});
test("ordinary command failures never expose stderr and successful output is unchanged", () => {
	assert.throws(
		() =>
			runCommand(
				process.execPath,
				["-e", 'console.error("synthetic-credential");process.exit(1)'],
				{ name: "Test command", timeoutMs: 1000 },
			),
		(error) =>
			error.message === "Test command failed with exit status 1" &&
			!JSON.stringify(error).includes("synthetic-credential"),
	);
	assert.equal(
		runCommand(process.execPath, ["-e", 'console.log("success")'], {
			name: "Test command",
			timeoutMs: 1000,
			onFailure: () => assert.fail("success called failure handler"),
		}),
		"success",
	);
});
