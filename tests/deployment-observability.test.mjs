import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "yaml";

const rulesPath = new URL(
	"../deploy/observability/prometheus-rules.yaml",
	import.meta.url,
);

test("deployment observability rules stay bounded and use published metrics", async () => {
	const document = parse(await readFile(rulesPath, "utf8"));
	assert.equal(document.groups?.length, 1);
	const rules = document.groups[0]?.rules ?? [];
	assert.deepEqual(
		rules.map((rule) => rule.alert),
		[
			"AgentPlatformOutboxBacklog",
			"AgentPlatformHttpErrors",
			"AgentPlatformTelemetryMissing",
		],
	);
	for (const rule of rules) {
		assert.equal(rule.for, "5m");
		assert.deepEqual(Object.keys(rule.labels).sort(), ["kind", "severity"]);
		assert.match(rule.expr, /agent_platform_(resource_count|operations_total)/);
		assert.doesNotMatch(
			rule.expr,
			/requestId|conversationId|executionId|agentId/,
		);
	}
});
