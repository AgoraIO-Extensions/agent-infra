import assert from "node:assert/strict";
import test from "node:test";

import {
	browserConformanceChecks,
	browserConformanceTemplates,
	runBrowserConformanceSuite,
} from "./local-real-e2e/browser-conformance-runner.mjs";

const deployment = {
	imageDigest: `sha256:${"a".repeat(64)}`,
	chromiumVersion: "140.0.7339.0",
	playwrightVersion: "1.63.0",
	capabilityRevision: 7,
};
const hash = "b".repeat(64);

function result() {
	return {
		agentHash: hash,
		sessionHash: "c".repeat(64),
		executionHash: "d".repeat(64),
		...deployment,
		checks: Object.fromEntries(
			browserConformanceChecks.map((check) => [
				check,
				{ status: "passed", evidenceHash: hash },
			]),
		),
	};
}

test("runs every Browser template in a fixed order and validates one receipt", async () => {
	const order = [];
	const output = await runBrowserConformanceSuite({
		commit: "e".repeat(40),
		deployment,
		runTemplate: async (template, input) => {
			order.push(template);
			assert.deepEqual(input.deployment, deployment);
			return result();
		},
	});
	assert.deepEqual(order, [...browserConformanceTemplates]);
	assert.equal(output.validated.status, "passed");
	assert.equal(output.receipt.templates.length, 4);
});

test("rejects unbounded template output instead of silently dropping it", async () => {
	await assert.rejects(
		runBrowserConformanceSuite({
			commit: "e".repeat(40),
			deployment,
			runTemplate: async () => ({ ...result(), pageBody: "private" }),
		}),
		/BROWSER_CONFORMANCE_CODEX_RESULT_UNBOUNDED/,
	);
});

test("rejects deployment tuple drift before producing a receipt", async () => {
	await assert.rejects(
		runBrowserConformanceSuite({
			commit: "e".repeat(40),
			deployment,
			runTemplate: async (template) =>
				template === "claude"
					? { ...result(), imageDigest: `sha256:${"f".repeat(64)}` }
					: result(),
		}),
		/BROWSER_CONFORMANCE_CLAUDE_TUPLE_DRIFT/,
	);
});

test("rejects sensitive deployment fields before invoking a template", async () => {
	let called = false;
	await assert.rejects(
		runBrowserConformanceSuite({
			commit: "e".repeat(40),
			deployment: { ...deployment, token: "secret" },
			runTemplate: async () => {
				called = true;
				return result();
			},
		}),
		/BROWSER_CONFORMANCE_DEPLOYMENT_UNBOUNDED/,
	);
	assert.equal(called, false);
});

test("stops before the next template when the runner is aborted", async () => {
	const controller = new AbortController();
	const order = [];
	await assert.rejects(
		runBrowserConformanceSuite({
			commit: "e".repeat(40),
			deployment,
			signal: controller.signal,
			runTemplate: async (template) => {
				order.push(template);
				controller.abort();
				return result();
			},
		}),
		/aborted/i,
	);
	assert.deepEqual(order, ["codex"]);
});

test("rejects cancellation after the final template callback", async () => {
	const controller = new AbortController();
	await assert.rejects(
		runBrowserConformanceSuite({
			commit: "e".repeat(40),
			deployment,
			signal: controller.signal,
			runTemplate: async (template) => {
				if (template === "pi") controller.abort();
				return result();
			},
		}),
		/aborted/i,
	);
});
