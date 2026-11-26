import assert from "node:assert/strict";
import test from "node:test";
import { compareChartManifestsV1 } from "../deploy/ack/compare-chart.ts";

const secret = (data: string) =>
	JSON.stringify({
		apiVersion: "v1",
		kind: "Secret",
		metadata: { name: "fixture" },
		data: { token: data },
	});

test("comparison ignores YAML key/resource order but compares all Secret bytes and hooks", () => {
	const hook = {
		apiVersion: "batch/v1",
		kind: "Job",
		metadata: {
			name: "migration",
			annotations: { "helm.sh/hook": "pre-upgrade" },
		},
	};
	assert.deepEqual(
		compareChartManifestsV1(
			`${secret("YQ==")}\n---\n${JSON.stringify(hook)}`,
			`${JSON.stringify(hook)}\n---\n${secret("YQ==")}`,
		),
		{ baselineResources: 2, candidateResources: 2, changed: [] },
	);
	const changed = compareChartManifestsV1(
		`${secret("YQ==")}\n---\n${JSON.stringify(hook)}`,
		secret("Yg=="),
	);
	assert.equal(changed.changed.length, 2);
	assert.doesNotMatch(JSON.stringify(changed), /YQ==|Yg==/);
	assert.throws(
		() => compareChartManifestsV1(`${secret("a")}\n---\n${secret("b")}`, ""),
		/DUPLICATE/,
	);
	assert.throws(() => compareChartManifestsV1("data: [", ""), /INVALID/);
});
