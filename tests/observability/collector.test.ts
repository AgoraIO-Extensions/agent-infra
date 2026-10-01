import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import {
	createPlatformApiShutdown,
	startPlatformApiFromDeployment,
} from "../../apps/platform-api/src/index.js";
import { startPlatformWorkerFromDeploymentV2 } from "../../apps/platform-worker/src/index.js";
import type { startObservability } from "../../packages/observability/src/index.js";
import { createObservedConversationEvents } from "../../packages/observability/src/worker.js";
import { PostgresConversationEventTransactionV1 } from "../../packages/platform-store/src/conversation-events.js";
import { migratePlatformDatabase } from "../../packages/platform-store/src/migrate.js";
import { startPostgresTestDatabase } from "../../packages/platform-store/src/postgres-test.js";
import { evaluateAlerts } from "./alerts.js";
import {
	assertDockerCapacity,
	collectorImage,
	metricValue,
	startCollector,
} from "./collector.js";
import { configureDatabase } from "./deployment.js";

const requireStore = createRequire(
	new URL("../../packages/platform-store/package.json", import.meta.url),
);
const postgres = requireStore(
	"postgres",
) as typeof import("../../packages/platform-store/node_modules/postgres");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>) {
	for (let attempt = 0; attempt < 60; attempt++) {
		if (await check()) return;
		await wait(250);
	}
	throw new Error("Timed out waiting for collected evidence");
}

it("collects API and durable event telemetry, queries alerts and preserves results during export failure", async () => {
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone evidence output, never a cached task
	const evidencePath = process.env.OBSERVABILITY_EVIDENCE;
	if (!evidencePath) throw new Error("OBSERVABILITY_EVIDENCE is required");
	const sourceFiles = await readdir(new URL("./", import.meta.url));
	const sourceHashes = Object.fromEntries(
		await Promise.all(
			sourceFiles
				.filter((name) => /\.(ts|json|yaml|md)$/.test(name))
				.map(async (name) => [
					name,
					createHash("sha256")
						.update(await readFile(new URL(name, import.meta.url)))
						.digest("hex"),
				]),
		),
	);
	const collector = await startCollector();
	const db = await assertDockerCapacity()
		.then(() => startPostgresTestDatabase("441-collector"))
		.catch(async (error) => {
			await collector.stop();
			throw error;
		});
	const sql = postgres(db.databaseUrl);
	const transaction = new PostgresConversationEventTransactionV1({
		databaseUrl: db.databaseUrl,
	});
	const output = new PassThrough();
	let logs = "";
	output.on("data", (chunk) => {
		logs += String(chunk);
	});
	const options = {
		otlpEndpoint: collector.otlpEndpoint,
		metricIntervalMs: 1000,
		output,
	};
	let api:
		| Awaited<ReturnType<typeof startPlatformApiFromDeployment>>
		| undefined;
	let worker:
		| Awaited<ReturnType<typeof startPlatformWorkerFromDeploymentV2>>
		| undefined;
	let telemetry: ReturnType<typeof startObservability> | undefined;
	const thresholds = { pending: 1, errors: 1, sustainMs: 1000 };
	const samples: Parameters<typeof evaluateAlerts>[0][number][] = [];
	const alerts: { phase: string; state: ReturnType<typeof evaluateAlerts> }[] =
		[];
	const failures: unknown[] = [];
	try {
		await migratePlatformDatabase(db);
		configureDatabase(db.databaseUrl);
		const startApi = () =>
			startPlatformApiFromDeployment({
				moduleSpecifier: new URL("./deployment.ts", import.meta.url).href,
				port: 0,
				log: () => {},
				observabilityOptions: options,
			});
		api = await startApi();
		worker = await startPlatformWorkerFromDeploymentV2({
			observabilityOptions: options,
			startWorkload: async () => ({ stop: async () => {} }),
			// No Runtime dispatch is exercised. Consume the production transaction below.
			startConversation: async (value) => {
				telemetry = value;
				return { stop: async () => {} };
			},
		});
		if (!telemetry) throw new Error("Worker telemetry missing");
		const observation = telemetry;
		const origin = () => {
			const address = api?.server.address();
			if (!address || typeof address === "string")
				throw new Error("API address missing");
			return `http://127.0.0.1:${address.port}`;
		};
		const response = await fetch(`${origin()}/api/v2/agent-applications`);
		expect(response.status).toBe(200);
		const before = await response.json();
		const conversationId = randomUUID();
		const executionId = randomUUID();
		await sql`insert into platform.conversations (id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision) values (${conversationId},'agent','actor','web','active',3,'auth')`;
		await sql`insert into platform.conversation_executions (execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,delivery_fence,authorization_revision,created_at,updated_at) values (${executionId},${conversationId},'agent','actor','web','turn','unknown',3,5,'auth',now(),now())`;
		const events = createObservedConversationEvents({
			transaction,
			telemetry: observation,
		});
		const command = {
			schemaVersion: 1 as const,
			conversationId,
			executionId,
			sessionGeneration: 3,
			deliveryFence: 5,
			adapterEventKey: "collector-event-1",
			runtimeCursor: "PRIVATE_CURSOR_SENTINEL",
			occurredAt: new Date().toISOString(),
			event: { type: "text.delta" as const, text: "PRIVATE_BODY_SENTINEL" },
		};
		expect((await events.persist(command)).outcome).toBe("accepted");
		expect((await events.persist(command)).outcome).toBe("replayed");
		const count = (text: string) =>
			metricValue(text, "agent_platform_operations_total", {
				service: "platform-worker",
				stage: "result_persist",
				outcome: "completed",
			});
		await until(async () => count(await collector.query()) === 1);
		let traces = "";
		await until(async () => {
			traces = await collector.read();
			return traces.includes(executionId);
		});
		expect(traces).toContain('"http"');
		for (const text of [traces, logs, await collector.query()]) {
			expect(text).not.toContain("PRIVATE_BODY_SENTINEL");
			expect(text).not.toContain("PRIVATE_CURSOR_SENTINEL");
		}
		const apiResourceValue = async (kind: "task_waiting" | "outbox_pending") =>
			metricValue(await collector.query(), "agent_platform_resource_count", {
				service: "platform-api",
				kind,
			});
		const readPending = async () => {
			const rows =
				await sql`select count(*)::int as count from platform.outbox_items where status in ('pending', 'retry_scheduled')`;
			return Number(rows[0]?.count);
		};
		// The formal API process owns this sampler. Read the same authoritative
		// Store, then wait for its process-owned gauge; do not inject a fixture.
		const samplePending = async () => {
			const value = await readPending();
			await until(
				async () => (await apiResourceValue("outbox_pending")) === value,
			);
			return apiResourceValue("outbox_pending");
		};
		const waitForApiResources = async (pending: number) => {
			await until(
				async () =>
					(await apiResourceValue("task_waiting")) === 0 &&
					(await apiResourceValue("outbox_pending")) === pending,
			);
		};
		const initialPending = await readPending();
		await waitForApiResources(initialPending);
		const record = async (
			phase: string,
			serviceAvailable: boolean,
			errors: number,
			pendingOverride?: number,
		) => {
			samples.push({
				at: Date.now(),
				pending: pendingOverride ?? (await samplePending()),
				serviceAvailable,
				errors,
			});
			const state = evaluateAlerts(samples, thresholds);
			alerts.push({ phase, state });
			return state;
		};
		expect(await record("healthy", true, 0)).toEqual({
			serviceUnavailable: false,
			persistentBacklog: false,
			abnormalErrors: false,
		});
		await sql`insert into platform.outbox_items (id,scope_type,scope_id,operation,payload,trace_id) values ('collector-backlog','acceptance','collector','acceptance.no-dispatch','{}',${randomUUID()})`;
		await record("backlog-start", true, 0);
		await wait(1100);
		expect((await record("backlog-firing", true, 0)).persistentBacklog).toBe(
			true,
		);
		await sql`delete from platform.outbox_items where id = 'collector-backlog'`;
		expect((await record("backlog-recovered", true, 0)).persistentBacklog).toBe(
			false,
		);
		// Force an actual HTTP query failure in this disposable database only.
		await sql`alter table platform.agent_applications rename to collector_applications`;
		try {
			expect(
				(await fetch(`${origin()}/api/v2/agent-applications`)).status,
			).toBeGreaterThanOrEqual(500);
			await until(
				async () =>
					(metricValue(
						await collector.query(),
						"agent_platform_operations_total",
						{ service: "platform-api", stage: "http", outcome: "failed" },
					) ?? 0) >= 1,
			);
			expect(
				(
					await record(
						"errors-firing",
						true,
						metricValue(
							await collector.query(),
							"agent_platform_operations_total",
							{ service: "platform-api", stage: "http", outcome: "failed" },
						) ?? 0,
					)
				).abnormalErrors,
			).toBe(true);
		} finally {
			await sql`alter table platform.collector_applications rename to agent_applications`;
		}
		expect((await fetch(`${origin()}/api/v2/agent-applications`)).status).toBe(
			200,
		);
		const observedErrors = async () => {
			const value = metricValue(
				await collector.query(),
				"agent_platform_operations_total",
				{
					service: "platform-api",
					stage: "http",
					outcome: "failed",
				},
			);
			if (value === undefined || !Number.isFinite(value))
				throw new Error("Missing observed error counter");
			return value;
		};
		const errorBaseline = await observedErrors();
		await wait(1200);
		const errorDelta = (await observedErrors()) - errorBaseline;
		expect(errorDelta).toBeGreaterThanOrEqual(0);
		expect(
			(await record("errors-recovered", true, errorDelta)).abnormalErrors,
		).toBe(false);
		const oldOrigin = origin();
		await createPlatformApiShutdown(api)();
		api = undefined;
		const available = await fetch(`${oldOrigin}/healthz`, {
			signal: AbortSignal.timeout(1000),
		}).then(
			(r) => r.ok,
			() => false,
		);
		expect(
			(await record("service-firing", available, 0, initialPending))
				.serviceUnavailable,
		).toBe(true);
		api = await startApi();
		await waitForApiResources(initialPending);
		expect(
			(
				await record(
					"service-recovered",
					(
						await fetch(`${origin()}/healthz`)
					).ok,
					0,
				)
			).serviceUnavailable,
		).toBe(false);
		const failuresBeforeDisconnect =
			worker.observabilityStatus().exportFailures;
		await collector.disconnect();
		const failedExportResponse = await fetch(
			`${origin()}/api/v2/agent-applications`,
		);
		expect(failedExportResponse.status).toBe(200);
		expect(await failedExportResponse.json()).toEqual(before);
		expect(
			(
				await events.persist({
					...command,
					adapterEventKey: "collector-event-2",
				})
			).outcome,
		).toBe("accepted");
		expect(
			(
				await events.persist({
					...command,
					adapterEventKey: "collector-event-2",
				})
			).outcome,
		).toBe("replayed");
		await until(
			async () =>
				(worker?.observabilityStatus().exportFailures ?? 0) >
				failuresBeforeDisconnect,
		);
		const exportFailureStatus = worker.observabilityStatus();
		const rows =
			await sql`select count(*)::int as count from platform.conversation_events where execution_id = ${executionId}`;
		expect(rows[0]?.count).toBe(2);
		await collector.reconnect();
		await until(async () => {
			try {
				return count(await collector.query()) === 2;
			} catch {
				return false;
			}
		});
		const finalMetrics = await collector.query();
		const finalTraces = await collector.read();
		for (const text of [finalMetrics, finalTraces, logs]) {
			expect(text).not.toContain("PRIVATE_BODY_SENTINEL");
			expect(text).not.toContain("PRIVATE_CURSOR_SENTINEL");
		}
		await writeFile(
			evidencePath,
			JSON.stringify(
				{
					sourceSha: execFileSync("git", ["rev-parse", "HEAD"], {
						encoding: "utf8",
					}).trim(),
					sourceHashes,
					samples,
					command:
						"pnpm exec vitest run tests/observability/collector.test.ts --maxWorkers=1",
					workingTreeStatus: execFileSync("git", ["status", "--porcelain"], {
						encoding: "utf8",
					}),
					collectorImage,
					collectorImageId: collector.imageId,
					collectedTraceEvidence: traces,
					structuredLogEvidence: logs,
					thresholds,
					alerts,
					exportFailureStatus,
					persistedEvents: rows[0]?.count,
					finalMetrics,
					limitations: [
						"Controlled identity and admissions",
						"Worker lifecycle plus real event transaction only; dispatch not exercised",
						"Backlog seeded in disposable database; production sampler not wired",
						"No Runtime or Connection evidence; AC1-9 not complete",
					],
				},
				null,
				2,
			),
		);
	} catch (error) {
		failures.push(error);
	} finally {
		for (const close of [
			async () => {
				if (api) await createPlatformApiShutdown(api)();
			},
			async () => {
				await worker?.stop();
			},
			() => transaction.close(),
			() => sql.end(),
			() => db.stop(),
			() => collector.stop(),
		]) {
			try {
				await close();
			} catch (error) {
				failures.push(error);
			}
		}
	}
	if (failures.length)
		throw new AggregateError(failures, "Acceptance or cleanup failed");
}, 120_000);
