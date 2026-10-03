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
import type { ConversationOperationFactV2 } from "../../packages/platform-core/src/index.js";
import { PostgresConversationEventTransactionV1 } from "../../packages/platform-store/src/conversation-events.js";
import { migratePlatformDatabase } from "../../packages/platform-store/src/migrate.js";
import { startPostgresTestDatabase } from "../../packages/platform-store/src/postgres-test.js";
import { PostgresScopedPlatformAuditQueryV1 } from "../../packages/platform-store/src/scoped-audit-query.js";
import { insertTaskAuthorization } from "../../packages/platform-store/src/task-authorization.js";
import { startAlertBackend } from "./alert-backend.js";
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

type TracePair = `${string}:${string}`;

function tracePairCounts(text: string, executionId: string) {
	const counts = new Map<TracePair, number>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const record = JSON.parse(line) as {
			resourceSpans?: Array<{
				scopeSpans?: Array<{
					spans?: Array<{
						attributes?: Array<{
							key?: string;
							value?: { stringValue?: string };
						}>;
					}>;
				}>;
			}>;
		};
		for (const resourceSpan of record.resourceSpans ?? [])
			for (const scopeSpan of resourceSpan.scopeSpans ?? [])
				for (const span of scopeSpan.spans ?? []) {
					const attributes = new Map(
						(span.attributes ?? []).map((attribute) => [
							attribute.key,
							attribute.value?.stringValue,
						]),
					);
					if (attributes.get("executionId") !== executionId) continue;
					const operationRef = attributes.get("operationRef");
					const attemptRef = attributes.get("attemptRef");
					if (!operationRef || !attemptRef) continue;
					const pair = `${operationRef}:${attemptRef}` as TracePair;
					counts.set(pair, (counts.get(pair) ?? 0) + 1);
				}
	}
	return counts;
}

function sortedCounts(counts: Map<TracePair, number>) {
	return [...counts.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	);
}
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
	let auditQuery: PostgresScopedPlatformAuditQueryV1 | undefined;
	const thresholds = { pending: 1, errors: 1, sustainMs: 1000 };
	const samples: Parameters<typeof evaluateAlerts>[0][number][] = [];
	const alerts: { phase: string; state: ReturnType<typeof evaluateAlerts> }[] =
		[];
	const failures: unknown[] = [];
	let backend: Awaited<ReturnType<typeof startAlertBackend>> | undefined;
	try {
		await migratePlatformDatabase(db);
		auditQuery = new PostgresScopedPlatformAuditQueryV1({
			databaseUrl: db.databaseUrl,
		});
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
		// Controlled admission uses the original authorization/audit writer.
		// It does not prove a real identity, dispatch or native Execution.
		await sql`insert into platform.agents (id, authorization_revision) values ('agent','auth')`;
		await sql`insert into platform.conversations (id,agent_id,actor_id,channel_id,status,session_generation,authorization_revision) values (${conversationId},'agent','actor','web','active',3,'auth')`;
		await sql`insert into platform.conversation_executions (execution_id,conversation_id,agent_id,actor_id,channel_id,turn_id,status,session_generation,delivery_fence,authorization_revision,model_configuration_revision,model_option_id,reasoning_level,created_at,updated_at) values (${executionId},${conversationId},'agent','actor','web','turn','unknown',3,5,'auth',1,'option-1','medium',now(),now())`;
		await sql.begin((transaction) =>
			insertTaskAuthorization(transaction, {
				executionId,
				boundary: {
					schemaVersion: 1,
					principal: { kind: "user", id: "actor" },
					agentId: "agent",
					channelId: "web",
					identityRevision: "controlled-identity",
					agentAuthorizationRevision: "auth",
					accessSources: [{ kind: "user", userId: "actor" }],
				},
				traceId: randomUUID(),
				requestId: randomUUID(),
			}),
		);
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
		backend = await startAlertBackend(
			collector.name,
			thresholds,
			`${evidencePath}.alerts-cleanup.json`,
		);
		const alertBackend = backend;
		await until(
			async () =>
				(await alertBackend.query('max(up{job="platform"})')).data.result[0]
					?.value[1] === "1",
		);
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
		const backlogMark = await backend.mark();
		await sql`insert into platform.outbox_items (id,scope_type,scope_id,operation,payload,trace_id) values ('collector-backlog','acceptance','collector','acceptance.no-dispatch','{}',${randomUUID()})`;
		await record("backlog-start", true, 0);
		await wait(1100);
		expect((await record("backlog-firing", true, 0)).persistentBacklog).toBe(
			true,
		);
		const backlogFired = await backend.waitFor(
			"PlatformPersistentBacklog",
			"firing",
			backlogMark,
		);
		expect(
			(
				await backend.query(
					'sum(agent_platform_resource_count{service="platform-api",kind="outbox_pending"})',
				)
			).data.result[0]?.value[1],
		).toBe(String(initialPending + 1));
		await sql`delete from platform.outbox_items where id = 'collector-backlog'`;
		expect((await record("backlog-recovered", true, 0)).persistentBacklog).toBe(
			false,
		);
		await backend.waitFor(
			"PlatformPersistentBacklog",
			"resolved",
			backlogFired,
		);
		// Force an actual HTTP query failure in this disposable database only.
		const errorsMark = await backend.mark();
		let errorsFired: number | undefined;
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
			// The actual HTTP failure counter must have two scraped observations.
			for (let attempt = 0; attempt < 3; attempt++) {
				await wait(1100);
				expect(
					(await fetch(`${origin()}/api/v2/agent-applications`)).status,
				).toBeGreaterThanOrEqual(500);
			}
			errorsFired = await backend.waitFor(
				"PlatformHttpErrors",
				"firing",
				errorsMark,
			);
			await backend.query(
				'sum(increase(agent_platform_operations_total{service="platform-api",stage="http",outcome="failed"}[5s]))',
			);
		} finally {
			await sql`alter table platform.collector_applications rename to agent_applications`;
		}
		expect((await fetch(`${origin()}/api/v2/agent-applications`)).status).toBe(
			200,
		);
		if (errorsFired === undefined)
			throw new Error("No HTTP error firing receipt");
		await backend.waitFor("PlatformHttpErrors", "resolved", errorsFired);
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
		const tokenValue = (
			text: string,
			kind: "input" | "output" | "cached_input",
		) =>
			metricValue(text, "agent_platform_model_tokens_total", {
				service: "platform-worker",
				kind,
			});
		expect(tokenValue(await collector.query(), "input")).toBeUndefined();
		const unavailableMark = await backend.mark();
		await collector.disconnect();
		const unavailableFired = await backend.waitFor(
			"PlatformCollectorUnavailable",
			"firing",
			unavailableMark,
		);
		expect(
			(await backend.query('max(up{job="platform"})')).data.result[0]?.value[1],
		).toBe("0");
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
		// Keep the exporter failure proof scoped to the text event above. The
		// operation correlation facts below must be emitted while the collector is
		// connected so every queried pair has a corresponding trace readback.
		await collector.reconnect();
		const rows =
			await sql`select count(*)::int as count from platform.conversation_events where execution_id = ${executionId}`;
		expect(rows[0]?.count).toBe(2);
		// Controlled canonical facts, not native Runtime evidence. The same real
		// event/audit transaction confirms them while the exporter is unavailable.
		const model: ConversationOperationFactV2 = {
			kind: "model",
			operationRef: randomUUID(),
			attemptRef: randomUUID(),
			phase: "intent",
			model: {
				configVersion: "config-1",
				modelOptionId: "option-1",
				modelId: "PRIVATE_MODEL_SENTINEL",
				reasoningLevel: "medium",
			},
		};
		const persistModel = (fact: ConversationOperationFactV2, key: string) =>
			events.persist({
				...command,
				adapterEventKey: key,
				runtimeCursor: `PRIVATE_CURSOR_SENTINEL-${key}`,
				event: { schemaVersion: 2, type: "execution.operation", fact },
			});
		expect((await persistModel(model, "model-intent")).outcome).toBe(
			"accepted",
		);
		expect(
			(await persistModel({ ...model, phase: "started" }, "model-started"))
				.outcome,
		).toBe("accepted");
		const unknown: ConversationOperationFactV2 = {
			...model,
			phase: "unknown",
			usage: { inputTokens: 7 },
		};
		expect((await persistModel(unknown, "model-unknown")).outcome).toBe(
			"accepted",
		);
		expect((await persistModel(unknown, "model-unknown")).outcome).toBe(
			"replayed",
		);
		await until(async () => {
			try {
				const text = await collector.query();
				return count(text) === 5 && tokenValue(text, "input") === 7;
			} catch {
				return false;
			}
		});
		expect(tokenValue(await collector.query(), "output")).toBeUndefined();
		const recovered: ConversationOperationFactV2 = {
			...model,
			phase: "completed",
			usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 0 },
		};
		expect((await persistModel(recovered, "model-recovered")).outcome).toBe(
			"accepted",
		);
		expect((await persistModel(recovered, "model-recovered")).outcome).toBe(
			"replayed",
		);
		await until(async () => {
			const text = await collector.query();
			return (
				tokenValue(text, "input") === 7 &&
				tokenValue(text, "output") === 3 &&
				tokenValue(text, "cached_input") === 0
			);
		});
		const next = { ...model, attemptRef: randomUUID() };
		expect((await persistModel(next, "model-next-intent")).outcome).toBe(
			"accepted",
		);
		expect(
			(await persistModel({ ...next, phase: "started" }, "model-next-started"))
				.outcome,
		).toBe("accepted");
		expect(
			(
				await persistModel(
					{
						...next,
						phase: "completed",
						usage: { inputTokens: 2, outputTokens: 1, cachedInputTokens: 1 },
					},
					"model-next-completed",
				)
			).outcome,
		).toBe("accepted");
		await until(async () => {
			const text = await collector.query();
			return (
				count(text) === 9 &&
				tokenValue(text, "input") === 9 &&
				tokenValue(text, "output") === 4 &&
				tokenValue(text, "cached_input") === 1
			);
		});
		const modelOutcomes = metricValue(
			await collector.query(),
			"agent_platform_operations_total",
			{ service: "platform-worker", stage: "model", outcome: "unknown" },
		);
		expect(modelOutcomes).toBe(1);
		const finalRows =
			await sql`select count(*)::int as count from platform.conversation_events where execution_id = ${executionId}`;
		expect(finalRows[0]?.count).toBe(9);
		const [operationAudits] =
			await sql`select count(*)::int as count, count(distinct details ->> 'authorizationRecordId')::int as bindings
				from platform.audit_events where action = 'execution.operation.observed' and target_id = ${executionId}`;
		expect(operationAudits?.count).toBe(7);
		expect(operationAudits?.bindings).toBe(1);
		if (!auditQuery) throw new Error("Audit query missing");
		const queried = await auditQuery.listAudit(
			{ kind: "administrator", administratorId: "platform-admin" },
			{ limit: 100, filters: { executionId } },
			{ requestId: randomUUID(), traceId: randomUUID() },
		);
		const queriedOperations = queried.items.filter(
			(item) => item.action === "execution.operation.observed",
		);
		expect(queriedOperations).toHaveLength(7);
		expect(
			queriedOperations.every(
				(item) =>
					item.executionId === executionId &&
					item.operation?.fact.operationRef !== undefined &&
					item.operation?.fact.attemptRef !== undefined,
			),
		).toBe(true);
		const queriedPairs = new Set(
			queriedOperations.map(
				(item) =>
					`${item.operation?.fact.operationRef}:${item.operation?.fact.attemptRef}`,
			),
		);
		expect(queriedPairs.size).toBe(2);
		const unrelated = await auditQuery.listAudit(
			{ kind: "administrator", administratorId: "platform-admin" },
			{ limit: 100, filters: { executionId: randomUUID() } },
			{ requestId: randomUUID(), traceId: randomUUID() },
		);
		expect(unrelated.items).toHaveLength(0);
		await expect(
			auditQuery.listAudit(
				{
					kind: "execution",
					principal: { kind: "user", id: "other-actor" },
					user: {
						schemaVersion: 1,
						userId: "other-actor",
						accountStatus: "active",
						organizationIds: [],
						authorizationRevision: "other-revision",
					},
				},
				{ limit: 100, filters: { executionId } },
				{ requestId: randomUUID(), traceId: randomUUID() },
			),
		).rejects.toMatchObject({ code: "access_denied" });
		const finalMetrics = await collector.query();
		const queriedPairCounts = new Map<TracePair, number>();
		for (const item of queriedOperations) {
			const fact = item.operation?.fact;
			if (!fact) throw new Error("Queried operation fact missing");
			const pair = `${fact.operationRef}:${fact.attemptRef}` as TracePair;
			queriedPairCounts.set(pair, (queriedPairCounts.get(pair) ?? 0) + 1);
		}
		let finalTraces = "";
		try {
			await until(async () => {
				finalTraces = await collector.read();
				return (
					JSON.stringify(
						sortedCounts(tracePairCounts(finalTraces, executionId)),
					) === JSON.stringify(sortedCounts(queriedPairCounts))
				);
			});
		} catch (error) {
			await writeFile(
				`${evidencePath}.pair-debug.json`,
				JSON.stringify(
					{
						queried: sortedCounts(queriedPairCounts),
						observed: sortedCounts(tracePairCounts(finalTraces, executionId)),
						traces: finalTraces,
					},
					null,
					2,
				),
			);
			throw error;
		}
		const observedPairCounts = tracePairCounts(finalTraces, executionId);
		// Compare the pair multiset, not independent substring membership: this
		// rejects swapped pairs, duplicate query rows, and unrelated extra traces.
		expect(sortedCounts(observedPairCounts)).toEqual(
			sortedCounts(queriedPairCounts),
		);
		expect(
			[...observedPairCounts.values()].reduce((sum, count) => sum + count, 0),
		).toBe(queriedOperations.length);
		await backend.waitFor(
			"PlatformCollectorUnavailable",
			"resolved",
			unavailableFired,
		);
		const alertBackendEvidence = await backend.evidence();
		for (const sentinel of [
			"PRIVATE_BODY_SENTINEL",
			"PRIVATE_CURSOR_SENTINEL",
		]) {
			expect(JSON.stringify(alertBackendEvidence)).not.toContain(sentinel);
		}
		for (const text of [finalMetrics, finalTraces, logs]) {
			expect(text).not.toContain("PRIVATE_BODY_SENTINEL");
			expect(text).not.toContain("PRIVATE_CURSOR_SENTINEL");
			expect(text).not.toContain("PRIVATE_MODEL_SENTINEL");
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
					alertBackend: alertBackendEvidence,
					exportFailureStatus,
					persistedEvents: finalRows[0]?.count,
					modelUsage: {
						input: tokenValue(finalMetrics, "input"),
						output: tokenValue(finalMetrics, "output"),
						cachedInput: tokenValue(finalMetrics, "cached_input"),
						unknownOutcomes: modelOutcomes,
						controlledFacts: true,
						controlledAuthorization: true,
						operationAudits: operationAudits?.count,
						authorizationBindings: operationAudits?.bindings,
						queriedOperationCount: queriedOperations.length,
						queriedOperationPairs: queriedPairs.size,
						unrelatedExecutionCount: unrelated.items.length,
						queryAuthorizationNegative: true,
					},
					finalMetrics,
					limitations: [
						"Controlled identity and admissions",
						"Worker lifecycle plus real event transaction only; dispatch not exercised",
						"Backlog seeded in disposable database; formal API sampler wired; Worker resource sampler not exercised",
						"Controlled alert backend/webhook only; production capacity and operational destination not accepted",
						"No Runtime or Connection evidence; AC1-9 not complete",
						"Audit query evidence is limited to the same controlled PG transaction and does not prove external Connection or production audit acceptance",
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
			async () => backend?.stop(),
			async () => {
				if (api) await createPlatformApiShutdown(api)();
			},
			async () => {
				await worker?.stop();
			},
			() => transaction.close(),
			async () => {
				await auditQuery?.close();
			},
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
}, 300_000);
