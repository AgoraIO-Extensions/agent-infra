import assert from "node:assert/strict";
import test from "node:test";

import {
	assertCleanRuntimeProbeSource,
	runtimeImageFromScanBuild,
	validateRuntimeProbe,
} from "../deploy/release/runtime-probe.mjs";

const evidence = {
	schemaVersion: 1,
	status: "passed",
	codexVersion: "0.153.0",
	configurationSchemaVersion: 2,
	configVersion: "synthetic-active-v2",
	checks: [
		"configuration-fail-closed",
		"native-active-default-model",
		"native-execution-selection",
		"submit-idempotency",
		"selection-conflict",
		"grant-and-agent-binding",
		"persistent-runtime-restart",
		"http-failures-redacted",
		"stream-failures-redacted",
		"cancellation-aborts-upstream",
		"native-sandboxed-tool-execution",
		"native-sibling-conversation-denied",
		"recursive-native-storage-redacted",
		"personal-configuration-isolated",
	],
};

test("runtime image evidence requires the complete pinned native probe", () => {
	assert.deepEqual(validateRuntimeProbe(evidence), evidence);
	for (const value of [
		null,
		{},
		{ ...evidence, status: "failed" },
		{ ...evidence, codexVersion: "other" },
		{ ...evidence, configurationSchemaVersion: 1 },
		{ ...evidence, checks: ["healthz"] },
		{ ...evidence, checks: [...evidence.checks.slice(1), evidence.checks[1]] },
		{ ...evidence, rawOutput: "synthetic-private-value" },
	])
		assert.throws(() => validateRuntimeProbe(value), /evidence is invalid/);
});

test("runtime probe refuses evidence from a dirty checkout", () => {
	const commitSha = "1".repeat(40);
	assert.deepEqual(assertCleanRuntimeProbeSource("", commitSha), {
		commitSha,
		sourceDirty: false,
	});
	assert.throws(
		() =>
			assertCleanRuntimeProbeSource(
				" M packages/agent-runtime/src/index.ts",
				commitSha,
			),
		/requires a clean checkout/,
	);
	assert.throws(
		() => assertCleanRuntimeProbeSource("", "not-a-commit"),
		/source is invalid/,
	);
});

test("runtime probe selects the scanner's exact current-commit image", () => {
	const commit = "1".repeat(40);
	const image = {
		name: "agent-runtime-host",
		imageId: `sha256:${"a".repeat(64)}`,
	};
	const build = { schemaVersion: 1, source: { commit }, images: [image] };
	assert.equal(runtimeImageFromScanBuild(build, commit), image.imageId);
	for (const value of [
		null,
		{ ...build, images: {} },
		{ ...build, source: { commit: "2".repeat(40) } },
		{ ...build, images: [] },
		{ ...build, images: [image, image] },
		{ ...build, images: [{ ...image, imageId: "mutable:tag" }] },
	])
		assert.throws(
			() => runtimeImageFromScanBuild(value, commit),
			/reference is invalid/,
		);
});
