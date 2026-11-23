import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { stringify } from "yaml";
import { platformAlertRules } from "../../deploy/observability/platform-alert-rules.ts";

const configuration = {
	schemaVersion: 1,
	scope: { cluster: "approved-cluster", namespace: "ack-community-m1-4403" },
	databaseSources: ["platform-main"],
	thresholds: { outboxPending: 100, httpErrorsPerSecond: 0.1, forSeconds: 300 },
};
const labels =
	'{cluster="approved-cluster",namespace="ack-community-m1-4403",kind="outbox_pending",database_source="platform-main"';
const sample = (replica: string, count: number) => ({
	series: `agent_platform_resource_count${labels},instance="${replica}"}`,
	values: `${count}+0x25`,
});

it("evaluates the five shared-backend scenarios and recovery with the real rule engine (#4403)", () => {
	const directory = mkdtempSync(join(tmpdir(), "platform-alert-rules-"));
	try {
		const rules = join(directory, "scoped.yaml");
		writeFileSync(rules, stringify(platformAlertRules(configuration)));
		const baseline = join(directory, "baseline.yaml");
		writeFileSync(
			baseline,
			readFileSync("deploy/observability/prometheus-rules.yaml"),
		);
		const neighbor = sample("neighbor", 120);
		neighbor.series = neighbor.series.replace(
			"ack-community-m1-4403",
			"neighbor",
		);
		const scenarios = [
			{
				name: "healthy zero is not missing",
				series: [sample("a", 0)],
				backlog: false,
				missing: false,
				oldBacklog: false,
				oldMissing: false,
			},
			{
				name: "real sustained backlog",
				series: [sample("a", 120)],
				backlog: true,
				missing: false,
				oldBacklog: true,
				oldMissing: false,
			},
			{
				name: "two replicas report one database",
				series: [sample("a", 70), sample("b", 70)],
				backlog: false,
				missing: false,
				oldBacklog: true,
				oldMissing: false,
			},
			{
				name: "neighbor backlog does not enter target",
				series: [sample("a", 0), neighbor],
				backlog: false,
				missing: false,
				oldBacklog: true,
				oldMissing: false,
			},
			{
				name: "neighbor cannot mask target absence",
				series: [neighbor],
				backlog: false,
				missing: true,
				oldBacklog: true,
				oldMissing: false,
			},
		];
		const expected = (
			alertname: string,
			kind: string,
			enabled: boolean,
			scoped: boolean,
		) => ({
			alertname,
			eval_time: "6m",
			exp_alerts: enabled
				? [
						{
							exp_labels: {
								severity: "warning",
								kind,
								...(scoped ? configuration.scope : {}),
								...(kind === "telemetry" && scoped
									? { database_source: "platform-main" }
									: {}),
							},
							exp_annotations: scoped
								? {
										summary:
											kind === "backlog"
												? "Platform outbox backlog is sustained"
												: "Platform telemetry is missing",
									}
								: kind === "backlog"
									? {
											summary: "Platform outbox backlog is sustained",
											description:
												"The durable outbox has been at or above the configured default threshold for five minutes.",
										}
									: {},
						},
					]
				: [],
		});
		for (const scoped of [false, true]) {
			const file = join(
				directory,
				`${scoped ? "scoped" : "baseline"}-tests.yaml`,
			);
			writeFileSync(
				file,
				stringify({
					rule_files: [scoped ? rules : baseline],
					evaluation_interval: "30s",
					tests: scenarios.map((scenario) => ({
						name: scenario.name,
						interval: "30s",
						input_series: scenario.series,
						alert_rule_test: [
							expected(
								"AgentPlatformOutboxBacklog",
								"backlog",
								scoped ? scenario.backlog : scenario.oldBacklog,
								scoped,
							),
							expected(
								"AgentPlatformTelemetryMissing",
								"telemetry",
								scoped ? scenario.missing : scenario.oldMissing,
								scoped,
							),
						],
					})),
				}),
			);
			execFileSync(
				process.env.PROMTOOL_PATH ?? "promtool",
				["test", "rules", file],
				{ stdio: "pipe", timeout: 30_000 },
			);
		}
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

it("rejects absent topology, duplicate shards and arbitrary labels before generating rules", () => {
	for (const invalid of [
		{ ...configuration, databaseSources: [] },
		{ ...configuration, databaseSources: ["same", "same"] },
		{ ...configuration, databaseSources: ["private\nquery"] },
		{ ...configuration, token: "synthetic-not-a-token" },
		{ ...configuration, scope: { ...configuration.scope, userId: "other" } },
		{
			...configuration,
			thresholds: { ...configuration.thresholds, forSeconds: 0 },
		},
	])
		expect(() => platformAlertRules(invalid)).toThrow(
			"Invalid platform alert scope",
		);
});
