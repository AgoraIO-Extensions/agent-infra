import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

test("restore a dedicated Grafana workspace from the shipped dashboard and an external read-only datasource", (t) => {
	const root = mkdtempSync(join(tmpdir(), "grafana-ops-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const output = join(root, "bundle");
	const run = () =>
		execFileSync(
			process.execPath,
			[
				"deploy/observability/grafana/provision.mts",
				output,
				"https://platform.example.test/ops",
			],
			{ stdio: "pipe" },
		);
	run();
	const data = parse(
		readFileSync(
			join(output, "provisioning/datasources/platform.yaml"),
			"utf8",
		),
	).datasources[0];
	assert.equal(data.jsonData.sslmode, "verify-full");
	assert.equal(data.secureJsonData.password, "$OPS_PG_PASSWORD");
	assert.equal(data.editable, false);
	const panel = JSON.parse(
		readFileSync(join(output, "dashboards/execution-impact.json"), "utf8"),
	);
	assert.equal(panel.time.from, "now-1h");
	for (const { targets } of panel.panels)
		for (const target of targets) assert.equal(target.datasource.uid, data.uid);
	assert.ok(
		JSON.stringify(panel).includes(
			"https://platform.example.test/ops?agentId=",
		),
	);
	assert.throws(run); // Existing output belongs to its caller.
});

test("requires an HTTPS /ops destination before publishing any bundle", () => {
	for (const entry of [
		"http://platform.example.test/ops",
		"https://user@platform.example.test/ops",
		"https://platform.example.test/ops?key=x",
	]) {
		assert.throws(
			() =>
				execFileSync(
					process.execPath,
					[
						"deploy/observability/grafana/provision.mts",
						"/does-not-exist/invalid",
						entry,
					],
					{ stdio: "pipe" },
				),
			/Expected the platform HTTPS/,
		);
	}
});
