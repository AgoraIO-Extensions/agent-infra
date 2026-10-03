import { execFile as callback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertDockerCapacity } from "./collector.js";

const execFile = promisify(callback);
const references = {
	prometheus: "prom/prometheus:v3.15.0",
	alertmanager: "prom/alertmanager:v0.34.1",
	receiver:
		"node:24-alpine@sha256:50c8e8ca1d27439048670df5883f32d57cf81cff6233222c893fd0d9884cbd81",
};
const kinds = {
	PlatformPersistentBacklog: "backlog",
	PlatformHttpErrors: "errors",
	PlatformCollectorUnavailable: "service",
} as const;
export type BackendAlert = keyof typeof kinds;
type AlertReceipt = {
	alertname: BackendAlert;
	status: "firing" | "resolved";
	kind: (typeof kinds)[BackendAlert];
	payloadSha256: string;
};
type VectorResponse = {
	status: "success";
	data: {
		resultType: "vector";
		result: { metric: Record<string, string>; value: [number, string] }[];
	};
};
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isVectorResponse(value: unknown): value is VectorResponse {
	return (
		isRecord(value) &&
		value.status === "success" &&
		isRecord(value.data) &&
		value.data.resultType === "vector" &&
		Array.isArray(value.data.result) &&
		value.data.result.every(
			(sample: unknown) =>
				isRecord(sample) &&
				isRecord(sample.metric) &&
				Object.values(sample.metric).every(
					(label) => typeof label === "string",
				) &&
				Array.isArray(sample.value) &&
				sample.value.length === 2 &&
				typeof sample.value[0] === "number" &&
				Number.isFinite(sample.value[0]) &&
				typeof sample.value[1] === "string",
		)
	);
}
function isAlertReceipt(value: unknown): value is AlertReceipt {
	return (
		isRecord(value) &&
		Object.entries(kinds).some(
			([name, kind]) => value.alertname === name && value.kind === kind,
		) &&
		(value.status === "firing" || value.status === "resolved") &&
		typeof value.payloadSha256 === "string" &&
		/^[a-f0-9]{64}$/.test(value.payloadSha256) &&
		Object.keys(value).every((key) =>
			["alertname", "status", "kind", "payloadSha256"].includes(key),
		)
	);
}

/** Disposable backend; only consumes the existing Collector's metrics. */
export async function startAlertBackend(
	collector: string,
	thresholds: { pending: number; errors: number; sustainMs: number },
	cleanupEvidencePath: string,
) {
	if (
		!Object.values(thresholds).every(
			(value) => Number.isSafeInteger(value) && value > 0,
		)
	)
		throw new Error("Positive controlled thresholds are required");
	const capacity = await assertDockerCapacity();
	const network = `alerts-1140-${randomUUID()}`;
	const folder = await mkdtemp(join(tmpdir(), "alerts-1140-"));
	const docker = (...args: string[]) =>
		execFile("docker", args, { timeout: 60_000, maxBuffer: 512 * 1024 });
	const created: string[] = [];
	let networkCreated = false;
	let collectorConnected = false;
	const images: Record<
		string,
		{ reference: string; id: string; repoDigests: string[] }
	> = {};
	const configurations = {
		prometheus: `global:
  scrape_interval: 1s
  scrape_timeout: 500ms
  evaluation_interval: 1s
rule_files: [/rules.yml]
scrape_configs:
  - job_name: platform
    static_configs:
      - targets: [collector:9464]
alerting:
  alertmanagers:
    - static_configs:
        - targets: [alertmanager:9093]
`,
		rules: `groups:
  - name: controlled-platform
    rules:
      - alert: PlatformPersistentBacklog
        expr: sum(agent_platform_resource_count{service="platform-api",kind="outbox_pending"}) >= ${thresholds.pending}
        for: ${thresholds.sustainMs}ms
        labels: {severity: warning, kind: backlog}
      - alert: PlatformHttpErrors
        expr: sum(increase(agent_platform_operations_total{service="platform-api",stage="http",outcome="failed"}[5s])) >= ${thresholds.errors}
        for: ${thresholds.sustainMs}ms
        labels: {severity: warning, kind: errors}
      - alert: PlatformCollectorUnavailable
        expr: max(up{job="platform"}) == 0
        for: ${thresholds.sustainMs}ms
        labels: {severity: warning, kind: service}
`,
		alertmanager: `route:
  receiver: controlled
  group_by: [alertname]
  group_wait: 0s
  group_interval: 1s
  repeat_interval: 1h
receivers:
  - name: controlled
    webhook_configs:
      - url: http://receiver:9411/alerts
        send_resolved: true
        timeout: 2s
`,
	};
	const stop = async () => {
		const errors: unknown[] = [];
		for (const name of [...created].reverse()) {
			try {
				await docker("rm", "--force", "--volumes", name);
			} catch (error) {
				errors.push(error);
			}
		}
		if (collectorConnected) {
			try {
				await docker("network", "disconnect", network, collector);
			} catch (error) {
				errors.push(error);
			}
		}
		if (networkCreated) {
			try {
				await docker("network", "rm", network);
			} catch (error) {
				errors.push(error);
			}
		}
		try {
			await rm(folder, { recursive: true, force: true });
		} catch (error) {
			errors.push(error);
		}
		let remainingContainers: string[] | null = null;
		let remainingNetworks: string[] | null = null;
		try {
			remainingContainers = (
				await docker(
					"container",
					"ls",
					"--all",
					"--filter",
					`label=ao.session=${capacity.session}`,
					"--format",
					"{{.Names}}",
				)
			).stdout
				.split("\n")
				.filter((name) => created.includes(name));
		} catch (error) {
			errors.push(error);
		}
		try {
			remainingNetworks = (
				await docker(
					"network",
					"ls",
					"--filter",
					`label=ao.session=${capacity.session}`,
					"--format",
					"{{.Name}}",
				)
			).stdout
				.split("\n")
				.filter((name) => name === network);
		} catch (error) {
			errors.push(error);
		}
		if (remainingContainers?.length || remainingNetworks?.length)
			errors.push(new Error("Alert backend resources remain"));
		const receipt = {
			session: capacity.session,
			containersCreated: created,
			networkCreated,
			remainingContainers,
			remainingNetworks,
			cleanupErrorCount: errors.length,
		};
		await writeFile(cleanupEvidencePath, JSON.stringify(receipt, null, 2));
		if (errors.length)
			throw new AggregateError(errors, "Alert backend cleanup failed");
		return receipt;
	};
	try {
		for (const [kind, reference] of Object.entries(references)) {
			const inspect = () =>
				docker("image", "inspect", reference, "--format", "{{json .}}");
			let inspection: Awaited<ReturnType<typeof inspect>>;
			try {
				inspection = await inspect();
			} catch (error) {
				if (capacity.mode !== "hosted-linux") throw error;
				await docker("pull", reference);
				inspection = await inspect();
			}
			const image = JSON.parse(inspection.stdout);
			if (!/^sha256:[a-f0-9]{64}$/.test(image.Id))
				throw new Error("Missing image ID");
			images[kind] = {
				reference,
				id: image.Id,
				repoDigests: image.RepoDigests ?? [],
			};
		}
		await assertDockerCapacity();
		await docker(
			"network",
			"create",
			"--internal",
			"--label",
			`ao.session=${capacity.session}`,
			network,
		);
		networkCreated = true;
		await docker(
			"network",
			"connect",
			"--alias",
			"collector",
			network,
			collector,
		);
		collectorConnected = true;
		for (const [kind, memory, args] of [
			["receiver", "64m", ["node", "/receiver.ts"]],
			[
				"alertmanager",
				"96m",
				[
					"--config.file=/acceptance.yml",
					"--cluster.listen-address=",
					"--storage.path=/alertmanager",
				],
			],
			[
				"prometheus",
				"256m",
				[
					"--config.file=/acceptance.yml",
					"--storage.tsdb.path=/prometheus",
					"--storage.tsdb.retention.time=1h",
					"--storage.tsdb.retention.size=32MB",
				],
			],
		] as const) {
			const name = `${network}-${kind}`;
			const image = images[kind];
			if (!image) throw new Error("Missing backend image");
			await docker(
				"create",
				"--pull=never",
				"--name",
				name,
				"--label",
				`ao.session=${capacity.session}`,
				"--network",
				network,
				"--network-alias",
				kind,
				"--memory",
				memory,
				"--cpus",
				"0.5",
				"--tmpfs",
				"/prometheus:rw,size=64m,mode=777",
				"--tmpfs",
				"/alertmanager:rw,size=16m,mode=777",
				image.id,
				...args,
			);
			created.push(name);
			if (kind === "receiver") {
				await docker(
					"cp",
					fileURLToPath(new URL("./alert-receiver.ts", import.meta.url)),
					`${name}:/receiver.ts`,
				);
			} else {
				const config = join(folder, `${kind}.yml`);
				await writeFile(config, configurations[kind]);
				await docker("cp", config, `${name}:/acceptance.yml`);
				if (kind === "prometheus") {
					const rules = join(folder, "rules.yml");
					await writeFile(rules, configurations.rules);
					await docker("cp", rules, `${name}:/rules.yml`);
				}
			}
			await docker("start", name);
		}
		// An internal bridge has no external route. Read official HTTP endpoints
		// from the existing Node container without publishing backend host ports.
		const read = async (url: string) => {
			const { stdout } = await execFile(
				"docker",
				[
					"exec",
					`${network}-receiver`,
					"node",
					"--input-type=module",
					"--eval",
					`const response = await fetch(process.argv[1], {signal: AbortSignal.timeout(2000)});
if (!response.ok) throw new Error("Alert backend query failed");
process.stdout.write(await response.text());`,
					url,
				],
				{ timeout: 3000, maxBuffer: 512 * 1024 },
			);
			return stdout;
		};
		const prometheus = "http://prometheus:9090";
		const receiver = "http://127.0.0.1:9411";
		for (const url of [`${prometheus}/-/ready`, `${receiver}/receipts`]) {
			let ready = false;
			for (let attempt = 0; attempt < 60; attempt++) {
				ready = await read(url).then(
					() => true,
					() => false,
				);
				if (ready) break;
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			if (!ready) throw new Error("Alert backend startup failed");
		}
		const readReceipts = async () => {
			const result: unknown = JSON.parse(await read(`${receiver}/receipts`));
			if (
				!Array.isArray(result) ||
				result.length > 128 ||
				!result.every(isAlertReceipt)
			)
				throw new Error("Invalid controlled alert receipts");
			return result;
		};
		const queries: { expression: string; result: unknown }[] = [];
		return {
			images,
			configurations,
			thresholds,
			stop,
			async query(expression: string) {
				const result: unknown = JSON.parse(
					await read(
						`${prometheus}/api/v1/query?query=${encodeURIComponent(expression)}`,
					),
				);
				if (!isVectorResponse(result))
					throw new Error("Invalid Prometheus vector response");
				queries.push({ expression, result });
				return result;
			},
			async mark() {
				return (await readReceipts()).length;
			},
			async waitFor(
				alert: BackendAlert,
				status: "firing" | "resolved",
				after: number,
			) {
				for (let attempt = 0; attempt < 60; attempt++) {
					const receipts = await readReceipts();
					const matched = receipts.findIndex(
						(receipt, index) =>
							index >= after &&
							receipt.alertname === alert &&
							receipt.status === status,
					);
					if (matched !== -1) return matched + 1;
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
				throw new Error(`No ${status} notification for ${alert}`);
			},
			async evidence() {
				return {
					images,
					configurations,
					thresholds,
					queryAccess: {
						prometheus,
						receiver,
						transport: "docker-exec-node-http",
					},
					queries,
					receipts: await readReceipts(),
				};
			},
		};
	} catch (error) {
		try {
			await stop();
		} catch (cleanup) {
			throw new AggregateError(
				[error, cleanup],
				"Alert backend startup/cleanup failed",
			);
		}
		throw error;
	}
}
