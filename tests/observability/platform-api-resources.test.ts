import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import {
	createPlatformApiShutdown,
	startPlatformApiFromDeployment,
} from "../../apps/platform-api/src/index.js";
import { PostgresConversationQueryV1 } from "../../packages/platform-store/dist/index.mjs";
import { migratePlatformDatabase } from "../../packages/platform-store/src/migrate.js";
import { startPostgresTestDatabase } from "../../packages/platform-store/src/postgres-test.js";
import { collectorImage, metricValue, startCollector } from "./collector.js";
import { configureDatabase } from "./deployment.js";

const requireStore = createRequire(
	new URL("../../packages/platform-store/package.json", import.meta.url),
);
const postgres = requireStore(
	"postgres",
) as typeof import("../../packages/platform-store/node_modules/postgres");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>) {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		if (await check()) return;
		await wait(250);
	}
	throw new Error("Timed out waiting for API resource evidence");
}

type RunningApi = Awaited<ReturnType<typeof startPlatformApiFromDeployment>>;
type BusinessSnapshot = {
	status: number;
	bodySha256: string;
	queueFacts: {
		executions: Array<{
			executionId: string;
			conversationId: string;
			agentId: string;
			status: string;
			sessionGeneration: string;
			authorizationRevision: string;
			deliveryFence: string;
		}>;
		outbox: Array<{
			id: string;
			scopeType: string;
			scopeId: string;
			operation: string;
			status: string;
			attemptCount: number;
			leaseOwner: string | null;
			leaseExpiresAt: string | null;
			deliveryFence: string;
		}>;
	};
};

function origin(running: RunningApi) {
	const address = running.server.address();
	if (!address || typeof address === "string")
		throw new Error("Platform API did not bind a TCP port");
	return `http://127.0.0.1:${address.port}`;
}

async function request(label: string, url: string) {
	try {
		return await fetch(url);
	} catch (error) {
		throw new Error(`HTTP request failed: ${label}`, { cause: error });
	}
}

function findDependencyFailureRecord(logText: string) {
	return logText
		.split("\n")
		.map((line) => {
			try {
				return JSON.parse(line) as Record<string, unknown>;
			} catch {
				return undefined;
			}
		})
		.find(
			(record) =>
				record?.stage === "dependency" &&
				record.outcome === "failed" &&
				record.code === "DEPENDENCY_UNAVAILABLE",
		);
}

async function safeCleanup(
	errors: unknown[],
	label: string,
	action: () => unknown | Promise<unknown>,
) {
	try {
		await action();
		return true;
	} catch (error) {
		errors.push(new Error(`${label} cleanup failed`, { cause: error }));
		return false;
	}
}

async function startApi(
	observabilityOptions: NonNullable<
		Parameters<typeof startPlatformApiFromDeployment>[0]
	>["observabilityOptions"] = {},
) {
	return startPlatformApiFromDeployment({
		moduleSpecifier: new URL("./deployment.ts", import.meta.url).href,
		port: 0,
		log: () => {},
		observabilityOptions,
	});
}

it("accepts formal API queue gauges and isolates Store/exporter failures", async () => {
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: controlled evidence output
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
	const runtimeArtifactHashes = Object.fromEntries(
		await Promise.all(
			[
				"../../apps/platform-api/src/assembly.ts",
				"../../apps/platform-api/src/index.ts",
				"../../packages/platform-store/dist/index.mjs",
			].map(async (path) => [
				path,
				createHash("sha256")
					.update(await readFile(new URL(path, import.meta.url)))
					.digest("hex"),
			]),
		),
	);
	let collector: Awaited<ReturnType<typeof startCollector>> | undefined;
	let db: Awaited<ReturnType<typeof startPostgresTestDatabase>> | undefined;
	let sql: ReturnType<typeof postgres> | undefined;
	let running: RunningApi | undefined;
	let disabled: RunningApi | undefined;
	let restarted: RunningApi | undefined;
	let disabledRead: { mockRestore(): void } | undefined;
	let hungRead: { mockRestore(): void } | undefined;
	let observe: { mockRestore(): void } | undefined;
	let restoreReadResource: (() => void) | undefined;
	let collectorImageId: string | undefined;
	let failureOperationsBefore: number | undefined;
	let failureOperationsAfter: number | undefined;
	let exporterBusinessIsolation:
		| { before: BusinessSnapshot; during: BusinessSnapshot }
		| undefined;
	let readerBusinessIsolation:
		| { before: BusinessSnapshot; during: BusinessSnapshot }
		| undefined;
	const cleanupErrors: unknown[] = [];
	let bodyError: unknown;
	let cleanupError: AggregateError | undefined;
	try {
		collector = await startCollector();
		const activeCollector = collector;
		collectorImageId = activeCollector.imageId;
		const activeReadResource = vi.spyOn(
			PostgresConversationQueryV1.prototype,
			"readResourceSnapshot",
		);
		restoreReadResource = () => activeReadResource.mockRestore();
		db = await startPostgresTestDatabase("441-api-resources");
		const activeDb = db;
		const activeSql = postgres(activeDb.databaseUrl);
		sql = activeSql;
		const output = new PassThrough();
		let logs = "";
		output.on("data", (chunk) => {
			logs += String(chunk);
		});
		await migratePlatformDatabase(activeDb);
		configureDatabase(activeDb.databaseUrl);
		await activeSql`
			insert into platform.conversations
				(id, agent_id, actor_id, channel_id, status, session_generation,
				 authorization_revision)
			values ('resource-conversation', 'resource-agent', 'resource-actor',
				'web', 'active', 1, 'resource-revision')
		`;
		await activeSql`
			insert into platform.conversation_executions
				(execution_id, conversation_id, agent_id, actor_id, channel_id,
				 turn_id, status, session_generation, authorization_revision, created_at)
			values ('resource-execution', 'resource-conversation', 'resource-agent',
				'resource-actor', 'web', 'resource-turn', 'submitted', 1,
				'resource-revision', now())
		`;
		await activeSql`
			insert into platform.conversation_messages
				(message_id, conversation_id, actor_id, role, text, execution_id,
				 status, created_at)
			values ('resource-message', 'resource-conversation', 'resource-actor',
				'user', 'synthetic body', 'resource-execution', 'submitted', now())
		`;
		await activeSql`
			insert into platform.outbox_items
				(id, scope_type, scope_id, operation, payload, status, trace_id)
			values
				('resource-pending', 'conversation', 'resource-conversation',
				 'conversation.turn.submit.v1', ${activeSql.json({
						schemaVersion: 1,
						conversationId: "resource-conversation",
						executionId: "resource-execution",
						messageId: "resource-message",
						turnId: "resource-turn",
						sessionGeneration: 1,
					})}, 'pending', 'resource-trace'),
				('resource-extra-1', 'workload', 'resource-agent',
				 'resource.operation', '{}', 'pending', 'resource-trace'),
				('resource-extra-2', 'workload', 'resource-agent',
				 'resource.operation', '{}', 'pending', 'resource-trace'),
				('resource-extra-3', 'workload', 'resource-agent',
				 'resource.operation', '{}', 'pending', 'resource-trace')
		`;
		running = await startApi({
			otlpEndpoint: activeCollector.otlpEndpoint,
			metricIntervalMs: 1_000,
			output,
		});
		const serviceOrigin = origin(running);
		const readBusinessSnapshot = async (
			label: string,
		): Promise<BusinessSnapshot> => {
			const executionRows = await activeSql`
				select execution_id, conversation_id, agent_id, status,
					session_generation::text, authorization_revision,
					delivery_fence::text
				from platform.conversation_executions
				where execution_id = 'resource-execution'
			`;
			const outboxRows = await activeSql`
				select id, scope_type, scope_id, operation, status,
					attempt_count::int, lease_owner, lease_expires_at::text,
					delivery_fence::text
				from platform.outbox_items
				where id in ('resource-pending', 'resource-extra-1',
					'resource-extra-2', 'resource-extra-3') order by id
			`;
			const queueFacts = {
				executions: executionRows.map((row) => ({
					executionId: String(row.execution_id),
					conversationId: String(row.conversation_id),
					agentId: String(row.agent_id),
					status: String(row.status),
					sessionGeneration: String(row.session_generation),
					authorizationRevision: String(row.authorization_revision),
					deliveryFence: String(row.delivery_fence),
				})),
				outbox: outboxRows.map((row) => ({
					id: String(row.id),
					scopeType: String(row.scope_type),
					scopeId: String(row.scope_id),
					operation: String(row.operation),
					status: String(row.status),
					attemptCount: Number(row.attempt_count),
					leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
					leaseExpiresAt:
						row.lease_expires_at === null ? null : String(row.lease_expires_at),
					deliveryFence: String(row.delivery_fence),
				})),
			};
			expect(queueFacts).toEqual({
				executions: [
					{
						executionId: "resource-execution",
						conversationId: "resource-conversation",
						agentId: "resource-agent",
						status: "submitted",
						sessionGeneration: "1",
						authorizationRevision: "resource-revision",
						deliveryFence: "0",
					},
				],
				outbox: [
					{
						id: "resource-extra-1",
						scopeType: "workload",
						scopeId: "resource-agent",
						operation: "resource.operation",
						status: "pending",
						attemptCount: 0,
						leaseOwner: null,
						leaseExpiresAt: null,
						deliveryFence: "0",
					},
					{
						id: "resource-extra-2",
						scopeType: "workload",
						scopeId: "resource-agent",
						operation: "resource.operation",
						status: "pending",
						attemptCount: 0,
						leaseOwner: null,
						leaseExpiresAt: null,
						deliveryFence: "0",
					},
					{
						id: "resource-extra-3",
						scopeType: "workload",
						scopeId: "resource-agent",
						operation: "resource.operation",
						status: "pending",
						attemptCount: 0,
						leaseOwner: null,
						leaseExpiresAt: null,
						deliveryFence: "0",
					},
					{
						id: "resource-pending",
						scopeType: "conversation",
						scopeId: "resource-conversation",
						operation: "conversation.turn.submit.v1",
						status: "pending",
						attemptCount: 0,
						leaseOwner: null,
						leaseExpiresAt: null,
						deliveryFence: "0",
					},
				],
			});
			const response = await request(
				label,
				`${serviceOrigin}/api/v2/agent-applications`,
			);
			const body = await response.text();
			expect(response.status).toBe(200);
			return {
				status: response.status,
				bodySha256: createHash("sha256").update(body).digest("hex"),
				queueFacts,
			};
		};
		expect(
			(await request("initial health", `${serviceOrigin}/healthz`)).status,
		).toBe(200);
		await until(async () => {
			const metrics = await activeCollector.query();
			return (
				metricValue(metrics, "agent_platform_resource_count", {
					service: "platform-api",
					kind: "task_waiting",
				}) === 1 &&
				metricValue(metrics, "agent_platform_resource_count", {
					service: "platform-api",
					kind: "outbox_pending",
				}) === 4
			);
		});
		expect(activeReadResource).toHaveBeenCalled();
		expect(activeReadResource.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);

		const failedTable = "platform_api_resources_acceptance_applications";
		await activeSql.unsafe(
			`alter table platform.agent_applications rename to ${failedTable}`,
		);
		try {
			const failed = await request(
				"failed application query",
				`${serviceOrigin}/api/v2/agent-applications`,
			);
			expect(failed.status).toBeGreaterThanOrEqual(500);
		} finally {
			await activeSql.unsafe(
				`alter table platform.${failedTable} rename to agent_applications`,
			);
		}
		expect(
			(
				await request(
					"recovered application query",
					`${serviceOrigin}/api/v2/agent-applications`,
				)
			).status,
		).toBe(200);

		const beforeExportFailure = running.observability.status().exportFailures;
		const exporterBusinessBefore = await readBusinessSnapshot(
			"business before exporter failure",
		);
		await activeCollector.disconnect();
		await until(
			async () =>
				running?.observability.status().exportFailures !== beforeExportFailure,
		);
		expect(
			(
				await request(
					"health during exporter failure",
					`${serviceOrigin}/healthz`,
				)
			).status,
		).toBe(200);
		const exporterBusinessDuring = await readBusinessSnapshot(
			"business during exporter failure",
		);
		expect(exporterBusinessDuring).toEqual(exporterBusinessBefore);
		exporterBusinessIsolation = {
			before: exporterBusinessBefore,
			during: exporterBusinessDuring,
		};
		await activeCollector.reconnect();
		await until(async () => {
			try {
				await activeCollector.query();
				return true;
			} catch {
				return false;
			}
		});

		const observeSpy = vi.spyOn(running.observability, "observeResource");
		observe = observeSpy;
		const sentinel = "postgres://secret-body-cursor-credential";
		const failureCallsBefore = activeReadResource.mock.calls.length;
		const dependencyFailureCounterBefore =
			metricValue(
				await activeCollector.query(),
				"agent_platform_operations_total",
				{
					service: "platform-api",
					stage: "dependency",
					outcome: "failed",
				},
			) ?? 0;
		failureOperationsBefore = dependencyFailureCounterBefore;
		const failureLogOffset = logs.length;
		const readerBusinessBefore = await readBusinessSnapshot(
			"business before reader failure",
		);
		let rejectedReaderCalls = 0;
		activeReadResource.mockImplementation(async () => {
			// The single-flight sampler has settled any earlier successful read
			// before invoking this first rejected read; baseline observations here.
			if (rejectedReaderCalls === 0) observeSpy.mockClear();
			rejectedReaderCalls += 1;
			throw new Error(sentinel);
		});
		await until(async () => {
			const metrics = await activeCollector.query();
			const newReadFailure =
				rejectedReaderCalls > 0 &&
				activeReadResource.mock.calls.length > failureCallsBefore;
			const newLog = logs.slice(failureLogOffset);
			const failureRecord = findDependencyFailureRecord(newLog);
			return (
				newReadFailure &&
				(metricValue(metrics, "agent_platform_operations_total", {
					service: "platform-api",
					stage: "dependency",
					outcome: "failed",
				}) ?? 0) > dependencyFailureCounterBefore &&
				failureRecord !== undefined
			);
		});
		const readerBusinessDuring = await readBusinessSnapshot(
			"business during reader failure",
		);
		expect(readerBusinessDuring).toEqual(readerBusinessBefore);
		readerBusinessIsolation = {
			before: readerBusinessBefore,
			during: readerBusinessDuring,
		};
		expect(observeSpy).not.toHaveBeenCalled();
		const failureEvidence = `${await activeCollector.query()}\n${await activeCollector.read()}\n${logs.slice(failureLogOffset)}`;
		const failureRecord = findDependencyFailureRecord(
			logs.slice(failureLogOffset),
		);
		expect(failureRecord).toMatchObject({
			stage: "dependency",
			outcome: "failed",
			code: "DEPENDENCY_UNAVAILABLE",
		});
		expect(failureEvidence).not.toContain(sentinel);
		failureOperationsAfter =
			metricValue(
				await activeCollector.query(),
				"agent_platform_operations_total",
				{
					service: "platform-api",
					stage: "dependency",
					outcome: "failed",
				},
			) ?? 0;
		activeReadResource.mockRestore();
		restoreReadResource = undefined;
		await createPlatformApiShutdown(running)();
		running = undefined;
		observeSpy.mockRestore();
		observe = undefined;

		const disabledReadSpy = vi.spyOn(
			PostgresConversationQueryV1.prototype,
			"readResourceSnapshot",
		);
		disabledRead = disabledReadSpy;
		try {
			disabled = await startApi({ output: new PassThrough() });
			expect(
				(await request("disabled health", `${origin(disabled)}/healthz`))
					.status,
			).toBe(200);
			await wait(1_100);
			expect(disabledReadSpy).not.toHaveBeenCalled();
		} finally {
			if (disabled) {
				if (
					await safeCleanup(cleanupErrors, "disabled API", () =>
						createPlatformApiShutdown(disabled as RunningApi)(),
					)
				)
					disabled = undefined;
			}
			if (
				await safeCleanup(cleanupErrors, "disabled reader spy", () =>
					disabledReadSpy.mockRestore(),
				)
			)
				disabledRead = undefined;
		}

		let aborted: AbortSignal | undefined;
		const hungReadSpy = vi
			.spyOn(PostgresConversationQueryV1.prototype, "readResourceSnapshot")
			.mockImplementation(
				(signal) =>
					new Promise((resolve) => {
						aborted = signal;
						signal.addEventListener(
							"abort",
							() => resolve({ taskWaiting: 99, outboxPending: 99 }),
							{ once: true },
						);
					}),
			);
		hungRead = hungReadSpy;
		try {
			restarted = await startApi({
				otlpEndpoint: activeCollector.otlpEndpoint,
				metricIntervalMs: 1_000,
				output: new PassThrough(),
			});
			const start = performance.now();
			await createPlatformApiShutdown(restarted)();
			restarted = undefined;
			expect(performance.now() - start).toBeLessThan(2_500);
			expect(aborted?.aborted).toBe(true);
		} finally {
			if (restarted) {
				if (
					await safeCleanup(cleanupErrors, "restarted API", () =>
						createPlatformApiShutdown(restarted as RunningApi)(),
					)
				)
					restarted = undefined;
			}
			if (
				await safeCleanup(cleanupErrors, "hung reader spy", () =>
					hungReadSpy.mockRestore(),
				)
			)
				hungRead = undefined;
		}
	} catch (error) {
		bodyError = error;
	} finally {
		if (restarted) {
			if (
				await safeCleanup(cleanupErrors, "restarted API", () =>
					createPlatformApiShutdown(restarted as RunningApi)(),
				)
			)
				restarted = undefined;
		}
		if (disabled) {
			if (
				await safeCleanup(cleanupErrors, "disabled API", () =>
					createPlatformApiShutdown(disabled as RunningApi)(),
				)
			)
				disabled = undefined;
		}
		if (running) {
			if (
				await safeCleanup(cleanupErrors, "running API", () =>
					createPlatformApiShutdown(running as RunningApi)(),
				)
			)
				running = undefined;
		}
		if (
			await safeCleanup(cleanupErrors, "observability spy", () =>
				observe?.mockRestore(),
			)
		)
			observe = undefined;
		if (
			await safeCleanup(cleanupErrors, "disabled reader spy", () =>
				disabledRead?.mockRestore(),
			)
		)
			disabledRead = undefined;
		if (
			await safeCleanup(cleanupErrors, "hung reader spy", () =>
				hungRead?.mockRestore(),
			)
		)
			hungRead = undefined;
		if (
			await safeCleanup(cleanupErrors, "resource reader spy", () =>
				restoreReadResource?.(),
			)
		)
			restoreReadResource = undefined;
		await safeCleanup(cleanupErrors, "Store client", () => sql?.end());
		sql = undefined;
		await safeCleanup(cleanupErrors, "test database", () => db?.stop());
		db = undefined;
		await safeCleanup(cleanupErrors, "collector", () => collector?.stop());
		collector = undefined;
		if (cleanupErrors.length > 0) {
			const errors =
				bodyError === undefined ? cleanupErrors : [bodyError, ...cleanupErrors];
			cleanupError = new AggregateError(
				errors,
				"Observability acceptance cleanup failed",
			);
		}
	}
	if (cleanupError) throw cleanupError;
	if (bodyError !== undefined) throw bodyError;
	if (
		failureOperationsBefore === undefined ||
		failureOperationsAfter === undefined
	)
		throw new Error("Missing dependency failure counter evidence");
	await writeFile(
		evidencePath,
		JSON.stringify(
			{
				sourceSha: execFileSync("git", ["rev-parse", "HEAD"], {
					encoding: "utf8",
				}).trim(),
				sourceHashes,
				runtimeArtifactHashes,
				command:
					"pnpm exec vitest run tests/observability/platform-api-resources.test.ts --maxWorkers=1 --no-file-parallelism",
				workingTreeStatus: execFileSync("git", ["status", "--porcelain"], {
					encoding: "utf8",
				}),
				collectorImage,
				collectorImageId,
				storeFixture: {
					taskWaiting: 1,
					outboxPending: 4,
				},
				failureCounter: {
					before: failureOperationsBefore,
					after: failureOperationsAfter,
					delta: failureOperationsAfter - failureOperationsBefore,
				},
				businessIsolation: {
					exporter: exporterBusinessIsolation,
					reader: readerBusinessIsolation,
				},
				acceptanceCoverage: {
					AC2: "Real reader rejection is linked to a failed counter/log record, remains redacted, and disabled/restart shutdown paths are asserted; missing/undefined, NaN, and full sampler timeout matrix remain in #504.",
					AC3: "Exporter and reader failures preserve the same Store-backed application GET and exact nonempty seeded Execution/outbox facts before/during each failure window; application results are empty and authorization/transaction matrix evidence remains in #504.",
					AC4: "Restarted API aborts an in-flight controlled hung-reader stub within bounded shutdown; no-tail, idempotence, fresh-snapshot restart and port-bind cleanup are supplied by #504 host tests.",
				},
				limitations: [
					"Controlled disposable Store and identity; no production endpoint",
					"Worker/Runtime/Connection/four-template evidence is outside this API-only hunk",
					"Full #1053 and parent #441/#504 ACs remain open until the named run and independent gates",
				],
			},
			null,
			2,
		),
	);
}, 120_000);
