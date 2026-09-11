import assert from "node:assert/strict";
import test from "node:test";
import { runCommand } from "../deploy/release/run-command.mjs";
import { safeRuntimeProbeFailure } from "../deploy/release/runtime-probe.mjs";
import {
	ProbeStepFailure,
	probeStep,
} from "./support/runtime-probe-diagnostics.mjs";

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

test("cancellation diagnostic distinguishes order from terminal result without copying arbitrary status", () => {
	for (const stage of [
		"model-cancellation-close-before-confirmation",
		"model-cancellation-result",
	]) {
		for (const resultStatus of ["running", "completed", "failed", "cancelled"])
			assert.deepEqual(
				JSON.parse(
					safeRuntimeProbeFailure(
						JSON.stringify({ status: "failed", stage, resultStatus }),
					),
				),
				{ status: "failed", stage, resultStatus },
			);
		for (const resultStatus of [
			"synthetic-credential",
			{ body: "synthetic-credential" },
			123,
		])
			assert.deepEqual(
				JSON.parse(
					safeRuntimeProbeFailure(
						JSON.stringify({ status: "failed", stage, resultStatus }),
					),
				),
				{ status: "failed", stage },
			);
	}
});

test("foreground failure keeps its own stage and response while background steps finish", async () => {
	let release;
	const pending = new Promise((resolve) => {
		release = resolve;
	});
	const response = { status: 409, resultStatus: "failed" };
	const failed = probeStep(
		"model-stop-result",
		async () => {
			await pending;
			throw new Error("synthetic-credential-do-not-log");
		},
		() => ({
			httpStatus: response.status,
			resultStatus: response.resultStatus,
			modelRequests: 22,
		}),
	).catch((error) => error);
	await probeStep("stop-independent-submit", async () => "background success");
	release();
	const error = await failed;
	response.status = 200;
	response.resultStatus = "completed";
	await probeStep("selected-submit", async () => "later background success");
	assert.ok(error instanceof ProbeStepFailure);
	assert.deepEqual(error.diagnostic, {
		status: "failed",
		stage: "model-stop-result",
		resultStatus: "failed",
		httpStatus: 409,
		modelRequests: 22,
	});
	assert.ok(Object.isFrozen(error.diagnostic));
	assert.ok(!String(error).includes("synthetic-credential"));
	assert.ok(!JSON.stringify(error).includes("synthetic-credential"));
});
test("nested and delayed background failures preserve the originating diagnostic", async () => {
	const error = await probeStep("model-stop-result", () =>
		probeStep(
			"stop-independent-submit",
			async () => {
				throw new Error("synthetic-original-body");
			},
			() => ({ httpStatus: 200, resultStatus: "running" }),
		),
	).catch((error) => error);
	assert.equal(error.diagnostic.stage, "stop-independent-submit");
	assert.equal(error.diagnostic.resultStatus, "running");
	assert.equal(await probeStep("default-submit", async () => 42), 42);
	const noResponse = await probeStep(
		"model-cancellation-close-before-confirmation",
		async () => {
			throw new Error("synthetic-body");
		},
	).catch((error) => error);
	assert.deepEqual(noResponse.diagnostic, {
		status: "failed",
		stage: "model-cancellation-close-before-confirmation",
	});
});

test("independent failpoints preserve the exact failed assertion and only boolean authentication", async () => {
	for (const stage of [
		"model-stop-target-open",
		"model-stop-independent-open",
		"model-stop-independent-closed",
		"model-stop-independent-release",
		"model-cancellation-request-closed",
	]) {
		for (const authenticated of [true, false]) {
			const error = await probeStep(
				stage,
				() => {
					assert.fail("synthetic-original");
				},
				() => ({ authenticated }),
			).catch((error) => error);
			assert.deepEqual(error.diagnostic, {
				status: "failed",
				stage,
				authenticated,
			});
		}
		for (const authenticated of [
			"synthetic-credential",
			1,
			{ token: "synthetic-credential" },
		]) {
			assert.deepEqual(
				JSON.parse(
					safeRuntimeProbeFailure(
						JSON.stringify({ status: "failed", stage, authenticated }),
					),
				),
				{ status: "failed", stage },
			);
		}
	}
});
