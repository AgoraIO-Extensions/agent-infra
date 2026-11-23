import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";

function record(input: unknown, fields: string[]): Record<string, unknown> {
	if (!input || typeof input !== "object" || Array.isArray(input) ||
		Object.keys(input).sort().join(",") !== fields.sort().join(","))
		throw new Error("Invalid platform alert scope");
	return input as Record<string, unknown>;
}
function label(input: unknown): string {
	if (typeof input !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input))
		throw new Error("Invalid platform alert scope");
	return input;
}
function positive(input: unknown, maximum: number): number {
	if (typeof input !== "number" || !Number.isFinite(input) || input <= 0 || input > maximum)
		throw new Error("Invalid platform alert scope");
	return input;
}

/** Existing rule names and telemetry; deployment labels identify bounded scope and shared DB facts. */
export function platformAlertRules(input: unknown) {
	const config = record(input, ["schemaVersion", "scope", "databaseSources", "thresholds"]);
	if (config.schemaVersion !== 1) throw new Error("Invalid platform alert scope");
	const scope = record(config.scope, ["cluster", "namespace"]);
	const cluster = label(scope.cluster);
	const namespace = label(scope.namespace);
	if (!Array.isArray(config.databaseSources) || config.databaseSources.length < 1 || config.databaseSources.length > 32)
		throw new Error("Invalid platform alert scope");
	const sources = config.databaseSources.map(label);
	if (new Set(sources).size !== sources.length) throw new Error("Invalid platform alert scope");
	const limits = record(config.thresholds, ["outboxPending", "httpErrorsPerSecond", "forSeconds"]);
	const pending = positive(limits.outboxPending, 1_000_000_000);
	const errors = positive(limits.httpErrorsPerSecond, 1_000_000);
	const seconds = positive(limits.forSeconds, 86_400);
	if (!Number.isSafeInteger(pending) || !Number.isSafeInteger(seconds)) throw new Error("Invalid platform alert scope");
	const selector = `cluster=${JSON.stringify(cluster)},namespace=${JSON.stringify(namespace)}`;
	const sourceSelector = sources
		.map((source) =>
			source
				.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
				.replaceAll("\\", "\\\\"),
		)
		.join("|");
	const gauge = (source?: string) =>
		`agent_platform_resource_count{${selector},kind="outbox_pending"${source ? `,database_source=${JSON.stringify(source)}` : `,database_source=~"^(${sourceSelector})$"`}}`;
	const expected = `sum(max by (database_source) (${gauge()}))`;
	const missing = sources
		.map((source) => `label_replace(absent(${gauge(source)}), "database_source", ${JSON.stringify(source)}, "", "")`)
		.join(" or ");
	const rule = (alert: string, expr: string, kind: string, summary: string) => ({
		alert, expr, for: `${seconds}s`,
		labels: { severity: "warning", kind, cluster, namespace },
		annotations: { summary },
	});
	return { groups: [{ name: "agent-infra-platform-scoped", interval: "30s", rules: [
		// A source is the same durable database/shard, not an exporter or a service replica.
		rule("AgentPlatformOutboxBacklog", `(${expected}) >= ${pending}`, "backlog", "Platform outbox backlog is sustained"),
		rule("AgentPlatformHttpErrors", `sum(rate(agent_platform_operations_total{${selector},stage="http",outcome="failed"}[5m])) >= ${errors}`, "errors", "Platform HTTP errors are sustained"),
		rule("AgentPlatformTelemetryMissing", missing, "telemetry", "Platform telemetry is missing"),
	] }] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		if (process.argv.length !== 3) throw new Error();
		process.stdout.write(stringify(platformAlertRules(JSON.parse(readFileSync(process.argv[2], "utf8")))));
	} catch {
		process.stderr.write("Invalid platform alert scope\n");
		process.exitCode = 1;
	}
}
