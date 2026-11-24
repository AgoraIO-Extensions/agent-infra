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

test("ACK resource panels use the selected window and the deployment's approved datasource and scope", (t) => {
	const root = mkdtempSync(join(tmpdir(), "grafana-ack-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const output = join(root, "bundle");
	execFileSync(process.execPath, [
		"deploy/observability/grafana/provision.mts",
		output,
		"https://platform.example.test/ops",
		"approved-arms",
		"cluster_id",
		"cluster-a",
		"platform-a",
	]);
	const dashboard = JSON.parse(
		readFileSync(join(output, "dashboards/execution-impact.json"), "utf8"),
	);
	for (const [index, panel] of dashboard.panels.entries()) {
		const a = panel.gridPos;
		for (const other of dashboard.panels.slice(index + 1)) {
			const b = other.gridPos;
			assert.ok(
				a.x + a.w <= b.x ||
					b.x + b.w <= a.x ||
					a.y + a.h <= b.y ||
					b.y + b.h <= a.y,
				`overlapping panels: ${panel.title} / ${other.title}`,
			);
		}
	}
	const history = dashboard.panels.filter(
		(panel) => panel.datasource?.type === "prometheus",
	);
	assert.ok(
		history.some(
			(panel) => panel.title === "历史库存节点和 PVC · 缺少指标样本",
		),
	);
	assert.ok(history.some((panel) => panel.title === "库存无可读样本"));
	for (const panel of history) {
		assert.equal(panel.timeFrom, undefined);
		assert.equal(panel.timeShift, undefined);
		for (const target of panel.targets) {
			assert.equal(target.datasource.uid, "approved-arms");
			assert.ok(target.expr.includes('cluster_id="cluster-a"'));
			assert.ok(target.range || (panel.type === "stat" && target.instant));
			assert.doesNotMatch(target.expr, /or vector\(0\)/);
		}
	}
});

test("provisions optional ARMS credentials by runtime reference and preserves the Postgres source", (t) => {
	const root = mkdtempSync(join(tmpdir(), "grafana-arms-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const output = join(root, "bundle");
	const args = [
		"deploy/observability/grafana/provision.mts",
		output,
		"https://platform.example.test/ops",
		"approved-arms",
		"cluster_id",
		"cluster-a",
		"platform-a",
	];
	const run = (endpoint) =>
		execFileSync(process.execPath, [...args, endpoint], { stdio: "pipe" });
	assert.throws(() => run("https://example.test/api?token=test"));
	run("https://arms.example.test/prometheus");
	const [pg, arms] = parse(
		readFileSync(
			join(output, "provisioning/datasources/platform.yaml"),
			"utf8",
		),
	).datasources;
	assert.equal(pg.type, "grafana-postgresql-datasource");
	assert.equal(arms.uid, "approved-arms");
	assert.equal(arms.basicAuthUser, "$OPS_ARMS_USER");
	assert.equal(arms.secureJsonData.basicAuthPassword, "$OPS_ARMS_PASSWORD");
});
