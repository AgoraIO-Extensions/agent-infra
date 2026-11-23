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
	databaseSources: ["platform-a", "platform-b"],
	thresholds: { outboxPending: 100, httpErrorsPerSecond: 0.1, forSeconds: 300 },
};
const labels = (source: string) =>
	`{cluster="approved-cluster",namespace="ack-community-m1-4403",kind="outbox_pending",database_source="${source}"`;
const sample = (replica: string, count: number) => ({
	series: `agent_platform_resource_count${labels("platform-a")},instance="${replica}"}`,
	values: `${count}+0x25`,
});
const sourceSample = (source: string, replica: string, count: number) => ({
	series: `agent_platform_resource_count${labels(source)},instance="${replica}"}`,
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
		const neighbor = sourceSample("platform-a", "neighbor", 120);
		neighbor.series = neighbor.series.replace(
			"ack-community-m1-4403",
			"neighbor",
		);
		const scenarios = [
			{
				name: "healthy zero is not missing",
				series: [sample("a", 0), sourceSample("platform-b", "b", 0)],
				backlog: false,
				missing: false,
				oldBacklog: false,
				oldMissing: false,
			},
			{
				name: "unconfigured source does not enter the configured aggregate",
				series: [
					sample("a", 0),
					sourceSample("platform-b", "b", 0),
					sourceSample("platform-c", "c", 120),
				],
				backlog: false,
				missing: false,
				oldBacklog: true,
				oldMissing: false,
			},
			{
				name: "real sustained backlog",
				series: [sample("a", 120), sourceSample("platform-b", "b", 0)],
				backlog: true,
				missing: false,
				oldBacklog: true,
				oldMissing: false,
			},
			{
				name: "two replicas report one database",
				series: [
					sample("a", 70),
					sample("b", 70),
					sourceSample("platform-b", "b", 0),
				],
				backlog: false,
				missing: false,
				oldBacklog: true,
				oldMissing: false,
			},
			{
				name: "neighbor backlog does not enter target",
				series: [sample("a", 0), sourceSample("platform-b", "b", 0), neighbor],
				backlog: false,
				missing: false,
				oldBacklog: true,
				oldMissing: false,
			},
			{
				name: "neighbor cannot mask target absence",
				series: [sample("a", 0), neighbor],
				backlog: false,
				missing: true,
				oldBacklog: true,
				oldMissing: false,
			},
			{
				name: "known shard backlog and missing shard fire together",
				series: [sourceSample("platform-a", "a", 120)],
				backlog: true,
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
									? { database_source: "platform-b" }
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

it("fires both alerts and resolves them on the same recovered sequence", () => {
	const directory = mkdtempSync(join(tmpdir(), "platform-alert-recovery-"));
	try {
		const rules = join(directory, "scoped.yaml");
		writeFileSync(
			rules,
			stringify(
				platformAlertRules({
					...configuration,
					thresholds: { ...configuration.thresholds, forSeconds: 120 },
				}),
			),
		);
		const testFile = join(directory, "recovery-tests.yaml");
		writeFileSync(
			testFile,
			stringify({
				rule_files: [rules],
				evaluation_interval: "30s",
				tests: [
					{
						name: "both fire",
						interval: "30s",
						input_series: [
							{
								series: `agent_platform_resource_count${labels("platform-a")},instance="a"}`,
								values: "120+0x10 0+0x15",
							},
							{
								series: `agent_platform_resource_count${labels("platform-b")},instance="b"}`,
								values: "_x10 0+0x15",
							},
						],
						alert_rule_test: [
							{
								eval_time: "2m30s",
								alertname: "AgentPlatformOutboxBacklog",
								exp_alerts: [
									{
										exp_labels: {
											severity: "warning",
											kind: "backlog",
											...configuration.scope,
										},
										exp_annotations: {
											summary: "Platform outbox backlog is sustained",
										},
									},
								],
							},
							{
								eval_time: "2m30s",
								alertname: "AgentPlatformTelemetryMissing",
								exp_alerts: [
									{
										exp_labels: {
											severity: "warning",
											kind: "telemetry",
											...configuration.scope,
											database_source: "platform-b",
										},
										exp_annotations: {
											summary: "Platform telemetry is missing",
										},
									},
								],
							},
						],
					},
					{
						name: "both resolve",
						interval: "30s",
						input_series: [
							{
								series: `agent_platform_resource_count${labels("platform-a")},instance="a"}`,
								values: "120+0x10 0+0x15",
							},
							{
								series: `agent_platform_resource_count${labels("platform-b")},instance="b"}`,
								values: "_x10 0+0x15",
							},
						],
						alert_rule_test: [
							{
								eval_time: "6m30s",
								alertname: "AgentPlatformOutboxBacklog",
								exp_alerts: [],
							},
							{
								eval_time: "6m30s",
								alertname: "AgentPlatformTelemetryMissing",
								exp_alerts: [],
							},
						],
					},
				],
			}),
		);
		execFileSync(
			process.env.PROMTOOL_PATH ?? "promtool",
			["test", "rules", testFile],
			{ stdio: "pipe", timeout: 30_000 },
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

it("sums independent sources after deduplicating replicas by source", () => {
	const directory = mkdtempSync(join(tmpdir(), "platform-alert-shards-"));
	try {
		const rules = join(directory, "scoped.yaml");
		writeFileSync(
			rules,
			stringify(
				platformAlertRules({
					...configuration,
					thresholds: { ...configuration.thresholds, forSeconds: 180 },
				}),
			),
		);
		const testFile = join(directory, "shard-tests.yaml");
		writeFileSync(
			testFile,
			stringify({
				rule_files: [rules],
				evaluation_interval: "30s",
				tests: [
					{
						name: "60 plus 60 fires at the fourth minute",
						interval: "30s",
						input_series: [
							sourceSample("platform-a", "replica-a", 60),
							sourceSample("platform-a", "replica-b", 60),
							sourceSample("platform-b", "replica-b", 60),
						],
						alert_rule_test: [
							{
								eval_time: "4m",
								alertname: "AgentPlatformOutboxBacklog",
								exp_alerts: [
									{
										exp_labels: {
											severity: "warning",
											kind: "backlog",
											...configuration.scope,
										},
										exp_annotations: {
											summary: "Platform outbox backlog is sustained",
										},
									},
								],
							},
						],
					},
				],
			}),
		);
		execFileSync(
			process.env.PROMTOOL_PATH ?? "promtool",
			["test", "rules", testFile],
			{ stdio: "pipe", timeout: 30_000 },
		);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
