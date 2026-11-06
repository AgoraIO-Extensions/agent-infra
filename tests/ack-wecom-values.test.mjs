import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { parseAllDocuments } from "yaml";

test("ACK enables the WeCom worker only when explicitly selected", () => {
	for (const enabled of [false, true]) {
		const rendered = execFileSync(
			"helm",
			[
				"template",
				"ack-wecom-test",
				"deploy/ack/chart",
				...(enabled ? ["--set", "wecom.enabled=true"] : []),
			],
			{ encoding: "utf8" },
		);
		const worker = parseAllDocuments(rendered)
			.map((document) => document.toJSON())
			.find(
				(document) =>
					document?.kind === "Deployment" &&
					document.metadata.name === "agent-infra-worker",
			);
		const flags = worker.spec.template.spec.containers[0].env.filter(
			(entry) => entry.name === "PLATFORM_WORKER_WECOM_ENABLED",
		);
		assert.deepEqual(flags, [
			{ name: "PLATFORM_WORKER_WECOM_ENABLED", value: String(enabled) },
		]);
	}
});

test("ACK rejects a string in place of the WeCom boolean", () => {
	const result = spawnSync(
		"helm",
		[
			"template",
			"ack-wecom-test",
			"deploy/ack/chart",
			"--set-string",
			"wecom.enabled=true",
		],
		{ encoding: "utf8" },
	);
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /wecom|enabled/);
});
