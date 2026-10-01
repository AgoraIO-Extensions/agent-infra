import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import {
	startPlatformConversationWorkerFromDeploymentV2,
	startPlatformWorkerFromDeploymentV2,
} from "../../apps/platform-worker/src/index.js";
import { migratePlatformDatabase } from "../../packages/platform-store/src/migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../packages/platform-store/src/postgres-test.js";
import { collectorImage, metricValue, startCollector } from "./collector.js";
import {
	configureWorkerDeployment,
	workerProcessSources,
} from "./worker-deployment.js";

const requireStore = createRequire(
	new URL("../../packages/platform-store/package.json", import.meta.url),
);
const postgres = requireStore(
	"postgres",
) as typeof import("../../packages/platform-store/node_modules/postgres");

const wait = (milliseconds: number) =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function sha256(value: unknown) {
	return createHash("sha256")
		.update(
			typeof value === "string" || value instanceof Uint8Array
				? value
				: JSON.stringify(value),
		)
		.digest("hex");
}

async function bounded<T>(operation: Promise<T>, milliseconds = 10_000) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("Worker queue lifecycle exceeded its bound")),
					milliseconds,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function fingerprint<T extends Record<string, unknown>>(
	rows: readonly T[],
	project: (row: T) => unknown,
) {
	const values = rows
		.map(project)
		.sort((left, right) =>
			JSON.stringify(left).localeCompare(JSON.stringify(right)),
		);
	return {
		count: rows.length,
		sha256: values.length ? sha256(values) : undefined,
	};
}

it("collects real Worker queue samples and preserves durable facts through recovery", async () => {
	// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone evidence output
	const evidencePath = process.env.OBSERVABILITY_WORKER_QUEUE_EVIDENCE;
	if (!evidencePath)
		throw new Error("OBSERVABILITY_WORKER_QUEUE_EVIDENCE is required");
	let collector: Awaited<ReturnType<typeof startCollector>> | undefined;
	let database: PostgresTestDatabase | undefined;
	let sql: ReturnType<typeof postgres> | undefined;
	let worker:
		| Awaited<ReturnType<typeof startPlatformWorkerFromDeploymentV2>>
		| undefined;
	let child: ReturnType<typeof spawn> | undefined;
	let childExit: Promise<unknown[]> | undefined;
	let childDirectory: string | undefined;
	let childOutput = "";
	let resourceReadFailures = 0;
	let publishedSamples = 0;
	const lifecycle: Record<string, unknown>[] = [];
	const output = new PassThrough();
	let logs = "";
	output.on("data", (chunk) => {
		logs += String(chunk);
	});
	const conversationId = randomUUID();
	const executionId = randomUUID();
	const messageId = randomUUID();
	const authorizationId = randomUUID();
	const controlId = randomUUID();
	const auditId = randomUUID();
	const platformAuditId = randomUUID();
	const outboxId = randomUUID();
	const restartOutboxId = randomUUID();
	const traceId = randomUUID();
	const requestId = randomUUID();
	const sentinel = "WORKER_QUEUE_PRIVATE_SENTINEL";
	const sourceFiles = [
		"tests/observability/worker-queue-production.test.ts",
		"tests/observability/worker-deployment.ts",
		"tests/observability/collector.ts",
		"tests/observability/collector.yaml",
		"apps/platform-worker/src/conversation-worker.ts",
		"apps/platform-worker/src/conversation-resource-sampling.test.ts",
		"apps/platform-worker/src/index.ts",
		"packages/observability/src/index.ts",
		"packages/platform-store/src/conversation-query.ts",
		"packages/platform-store/src/observability-snapshot.ts",
		"packages/platform-store/src/conversation-dispatch.ts",
		"pnpm-lock.yaml",
	];
	const readSourceHashes = async () =>
		Object.fromEntries(
			await Promise.all(
				sourceFiles.map(async (name) => [
					name,
					sha256(await readFile(join(repositoryRoot, name))),
				]),
			),
		);
	const observed: {
		phase: string;
		taskWaiting: number | undefined;
		outboxPending: number | undefined;
	}[] = [];
	const cleanupFailures: unknown[] = [];
	let releaseOutboxLock: (() => void) | undefined;
	let heldOutboxLock: Promise<unknown> | undefined;
	let lockPid: number | undefined;
	let bodyFailed = false;
	let bodyError: unknown;
	let evidence: Record<string, unknown> | undefined;
	// Start before assembly/spawn; never extend the window while a Worker lives.
	let ordinaryPollDeadline: number | undefined;
	const beforeNextPoll = async <T>(work: () => Promise<T>) => {
		const deadline = ordinaryPollDeadline;
		const remaining = () =>
			deadline === undefined ? 10_000 : deadline - performance.now();
		if (remaining() <= 0)
			throw new Error("Sampling fixture exceeded its ordinary poll window");
		const result = await bounded(work(), Math.min(10_000, remaining()));
		if (remaining() <= 0)
			throw new Error("Sampling fixture exceeded its ordinary poll window");
		return result;
	};
	const until = async (check: () => Promise<boolean>, attempts = 60) => {
		for (let attempt = 0; attempt < attempts; attempt += 1) {
			if (await beforeNextPoll(check)) return;
			await beforeNextPoll(() => wait(250));
		}
		throw new Error("Timed out waiting for Worker queue metrics");
	};
	try {
		const initialSourceHashes = await readSourceHashes();
		collector = await startCollector();
		database = await startPostgresTestDatabase("441-worker-queue-production");
		sql = postgres(database.databaseUrl);
		await migratePlatformDatabase({ databaseUrl: database.databaseUrl });
		if (!collector || !database || !sql)
			throw new Error("Worker queue production setup is incomplete");
		const activeCollector = collector;
		const activeDatabase = database;
		const activeSql = sql;
		const acquireOutboxLock = () =>
			beforeNextPoll(async () => {
				const release = Promise.withResolvers<void>();
				const ready = Promise.withResolvers<void>();
				releaseOutboxLock = () => release.resolve();
				heldOutboxLock = activeSql.begin(async (transaction) => {
					const [backend] = await transaction`select pg_backend_pid() as pid`;
					lockPid = Number(backend?.pid);
					await transaction`lock table platform.outbox_items in access exclusive mode`;
					ready.resolve();
					await release.promise;
				});
				void heldOutboxLock.catch(ready.reject);
				await ready.promise;
			});
		const releaseOwnedLock = async () => {
			releaseOutboxLock?.();
			const held = heldOutboxLock;
			if (held) await beforeNextPoll(() => held);
			releaseOutboxLock = undefined;
			heldOutboxLock = undefined;
		};
		const pendingSnapshots = () => activeSql<
			{ pid: number; state: string; wait_event_type: string }[]
		>`
			select pid, state, wait_event_type from pg_stat_activity
			where datname = current_database() and pid <> pg_backend_pid()
				and wait_event_type = 'Lock'
				and query like '%count(distinct e.execution_id)%'
				and ${lockPid ?? -1}::int = any(pg_blocking_pids(pid))
		`;
		const waitForPendingSnapshot = async () => {
			let pending: { pid: number; state: string; wait_event_type: string }[] =
				[];
			await until(async () => {
				pending = [...(await pendingSnapshots())];
				return pending.length > 0;
			}, 40);
			return pending;
		};
		configureWorkerDeployment(activeDatabase.databaseUrl, (message) => {
			logs += `${message}\n`;
			if (
				JSON.parse(message).code ===
				"CONVERSATION_RESOURCE_SNAPSHOT_UNAVAILABLE"
			)
				resourceReadFailures++;
		});
		await activeSql`
				insert into platform.conversations
					(id, agent_id, actor_id, channel_id, status, session_generation,
					 authorization_revision)
				values (${conversationId}, 'worker-queue-agent', 'worker-queue-actor',
					'web', 'active', 1, 'worker-queue-revision')
			`;
		await activeSql`
				insert into platform.conversation_executions
					(execution_id, conversation_id, agent_id, actor_id, channel_id,
					 turn_id, status, session_generation, authorization_revision,
					 created_at)
				values (${executionId}, ${conversationId}, 'worker-queue-agent',
					'worker-queue-actor', 'web', 'worker-queue-turn', 'submitted',
					1, 'worker-queue-revision', now())
			`;
		await activeSql`
				insert into platform.conversation_messages
					(message_id, conversation_id, actor_id, role, text, execution_id,
					 status, created_at)
				values (${messageId}, ${conversationId}, 'worker-queue-actor', 'user',
					${sentinel}, ${executionId}, 'submitted', now())
			`;
		await activeSql`
				insert into platform.task_authorization_records
					(id, execution_id, boundary)
				values (${authorizationId}, ${executionId}, ${activeSql.json({
					schemaVersion: 1,
					agentId: "worker-queue-agent",
					actorId: "worker-queue-actor",
					conversationId,
					executionId,
					authorizationRevision: "worker-queue-revision",
				})})
			`;
		await activeSql`
				insert into platform.task_control_records
					(id, execution_id, authorization_record_id, reason)
				values (${controlId}, ${executionId}, ${authorizationId}, 'recovery')
			`;
		await activeSql`
				insert into platform.conversation_audit_events
					(id, conversation_id, execution_id, agent_id, actor_id, action,
					 trace_id, request_id, occurred_at)
				values (${auditId}, ${conversationId}, ${executionId},
					'worker-queue-agent', 'worker-queue-actor', 'queue.accepted',
					${traceId}, ${requestId}, now())
			`;
		await activeSql`
				insert into platform.audit_events
					(id, trace_id, actor_type, actor_id, action, target_type,
					 target_id, outcome)
				values (${platformAuditId}, ${traceId}, 'employee',
					'worker-queue-actor', 'conversation.queue.accepted',
					'conversation', ${conversationId}, 'succeeded')
			`;
		await activeSql`
				insert into platform.outbox_items
					(id, scope_type, scope_id, operation, payload, status, available_at,
					 trace_id)
				values (${outboxId}, 'conversation', ${conversationId},
					'conversation.turn.submit.v1', ${activeSql.json({
						schemaVersion: 1,
						conversationId,
						executionId,
						messageId,
						turnId: "worker-queue-turn",
						sessionGeneration: 1,
					})}, 'pending', now() + interval '1 hour', ${traceId})
			`;
		const facts = async (includeOutbox = true) => {
			const [
				executions,
				messages,
				authorizations,
				controls,
				conversationAudits,
				audits,
				outbox,
			] = await Promise.all([
				activeSql`
						select to_jsonb(e)::text as projection
						from platform.conversation_executions e
						where execution_id = ${executionId}`,
				activeSql`
						select to_jsonb(m)::text as projection, text
						from platform.conversation_messages m
						where message_id = ${messageId}`,
				activeSql`
						select to_jsonb(a)::text as projection
						from platform.task_authorization_records a
						where id = ${authorizationId}`,
				activeSql`
						select to_jsonb(c)::text as projection
						from platform.task_control_records c
						where id = ${controlId}`,
				activeSql`
						select to_jsonb(a)::text as projection
						from platform.conversation_audit_events a
						where id = ${auditId}`,
				activeSql`
						select to_jsonb(a)::text as projection
						from platform.audit_events a
						where id = ${platformAuditId}`,
				includeOutbox
					? activeSql`
						select (to_jsonb(o) - array['status', 'updated_at'])::text as projection, status
						from platform.outbox_items o
						where id = ${outboxId}`
					: Promise.resolve([]),
			]);
			const executionFacts = fingerprint(
				executions as Record<string, unknown>[],
				(row) => row,
			);
			const messageFacts = fingerprint(
				messages as Record<string, unknown>[],
				(row) => ({
					projectionSha256: sha256(row.projection),
					contentSha256: sha256(row.text),
				}),
			);
			const authorizationFacts = fingerprint(
				authorizations as Record<string, unknown>[],
				(row) => row,
			);
			const controlFacts = fingerprint(
				controls as Record<string, unknown>[],
				(row) => row,
			);
			const conversationAuditFacts = fingerprint(
				conversationAudits as Record<string, unknown>[],
				(row) => row,
			);
			const auditFacts = fingerprint(
				audits as Record<string, unknown>[],
				(row) => row,
			);
			const outboxFacts = fingerprint(
				outbox as Record<string, unknown>[],
				(row) => row.projection,
			);
			return {
				executions: executionFacts.count,
				executionSha256: executionFacts.sha256,
				messages: messageFacts.count,
				messageSha256: messageFacts.sha256,
				authorizations: authorizationFacts.count,
				authorizationSha256: authorizationFacts.sha256,
				controls: controlFacts.count,
				controlSha256: controlFacts.sha256,
				conversationAudits: conversationAuditFacts.count,
				conversationAuditSha256: conversationAuditFacts.sha256,
				audits: auditFacts.count,
				auditSha256: auditFacts.sha256,
				outbox: outboxFacts.count,
				outboxSha256: outboxFacts.sha256,
				outboxStatus: outbox[0]?.status,
			};
		};
		const protectedFacts = (value: Awaited<ReturnType<typeof facts>>) => {
			const {
				outbox: _outbox,
				outboxSha256: _outboxSha256,
				outboxStatus: _outboxStatus,
				...rest
			} = value;
			return rest;
		};
		const beforeFacts = await facts();
		const startWorker = () => {
			ordinaryPollDeadline = performance.now() + 25_000;
			const starting = new AbortController();
			return beforeNextPoll(() =>
				startPlatformWorkerFromDeploymentV2({
					startPrimary: () => ({ stop() {} }),
					startWorkload: async () => ({ stop: async () => {} }),
					observabilityOptions: {
						otlpEndpoint: activeCollector.otlpEndpoint,
						metricIntervalMs: 1000,
						output,
					},
					startConversation: async (telemetry) => {
						const conversation =
							await startPlatformConversationWorkerFromDeploymentV2(
								new URL("./worker-deployment.ts", import.meta.url).href,
								starting.signal,
								{
									...telemetry,
									observeResource: (snapshot) => {
										publishedSamples++;
										telemetry.observeResource(snapshot);
									},
								},
							);
						try {
							expect(await beforeNextPoll(() => conversation.tick())).toBe(0);
							return conversation;
						} catch (error) {
							try {
								await conversation.stop();
							} catch (closeError) {
								throw new AggregateError(
									[error, closeError],
									"Initial discovery and cleanup failed",
								);
							}
							throw error;
						}
					},
				}),
			).catch((error) => {
				starting.abort();
				throw error;
			});
		};
		const stopWorker = async (current: NonNullable<typeof worker>) => {
			await beforeNextPoll(() => current.stop());
			ordinaryPollDeadline = undefined;
		};
		worker = await startWorker();
		let activeWorker = worker;
		const metrics = () => beforeNextPoll(() => activeCollector.query());
		await until(async () => {
			const text = await metrics();
			return (
				metricValue(text, "agent_platform_resource_count", {
					service: "platform-worker",
					kind: "task_waiting",
				}) === 1 &&
				metricValue(text, "agent_platform_resource_count", {
					service: "platform-worker",
					kind: "outbox_pending",
				}) === 1
			);
		});
		const nonEmptyMetrics = await metrics();
		observed.push({
			phase: "non-empty",
			taskWaiting: metricValue(
				nonEmptyMetrics,
				"agent_platform_resource_count",
				{
					service: "platform-worker",
					kind: "task_waiting",
				},
			),
			outboxPending: metricValue(
				nonEmptyMetrics,
				"agent_platform_resource_count",
				{
					service: "platform-worker",
					kind: "outbox_pending",
				},
			),
		});
		await acquireOutboxLock();
		await waitForPendingSnapshot();
		observed.push({
			phase: "pending-pg-lock",
			taskWaiting: 1,
			outboxPending: 1,
		});
		await until(async () => {
			const text = await metrics();
			return (
				metricValue(text, "agent_platform_resource_count", {
					service: "platform-worker",
					kind: "task_waiting",
				}) === undefined &&
				metricValue(text, "agent_platform_resource_count", {
					service: "platform-worker",
					kind: "outbox_pending",
				}) === undefined
			);
		}, 80);
		const expiredMetrics = await metrics();
		expect(
			metricValue(expiredMetrics, "agent_platform_resource_count", {
				service: "platform-worker",
				kind: "task_waiting",
			}),
		).toBeUndefined();
		expect(
			metricValue(expiredMetrics, "agent_platform_resource_count", {
				service: "platform-worker",
				kind: "outbox_pending",
			}),
		).toBeUndefined();
		observed.push({
			phase: "expired-missing",
			taskWaiting: undefined,
			outboxPending: undefined,
		});
		expect(resourceReadFailures).toBeGreaterThan(0);
		expect(protectedFacts(await beforeNextPoll(() => facts(false)))).toEqual(
			protectedFacts(beforeFacts),
		);
		// Record the actual pending backend immediately before graceful stop.
		const stopPending = await waitForPendingSnapshot();
		const stopStartedAt = new Date().toISOString();
		await stopWorker(activeWorker);
		worker = undefined;
		const samplesAfterStop = publishedSamples;
		await wait(1200);
		expect(publishedSamples).toBe(samplesAfterStop);
		const stoppedBackends = await activeSql`
			select pid from pg_stat_activity where pid = any(${stopPending.map((row) => row.pid)}::int[])
		`;
		expect(stoppedBackends).toHaveLength(0);
		lifecycle.push({
			phase: "pending-stop",
			stopStartedAt,
			stoppedAt: new Date().toISOString(),
			pending: stopPending,
			lockHeldUntilStopResolved: true,
			remainingBackends: stoppedBackends.length,
		});
		await releaseOwnedLock();
		expect(await facts()).toEqual(beforeFacts);
		worker = await startWorker();
		activeWorker = worker;
		await until(async () => {
			const text = await metrics();
			return (
				metricValue(text, "agent_platform_resource_count", {
					service: "platform-worker",
					kind: "task_waiting",
				}) === 1
			);
		});
		await beforeNextPoll(
			() => activeSql`
			update platform.outbox_items set status = 'succeeded' where id = ${outboxId}
		`,
		);
		await until(async () => {
			const text = await metrics();
			return (
				metricValue(text, "agent_platform_resource_count", {
					service: "platform-worker",
					kind: "task_waiting",
				}) === 0 &&
				metricValue(text, "agent_platform_resource_count", {
					service: "platform-worker",
					kind: "outbox_pending",
				}) === 0
			);
		});
		const zeroMetrics = await metrics();
		observed.push({
			phase: "confirmed-zero",
			taskWaiting: metricValue(zeroMetrics, "agent_platform_resource_count", {
				service: "platform-worker",
				kind: "task_waiting",
			}),
			outboxPending: metricValue(zeroMetrics, "agent_platform_resource_count", {
				service: "platform-worker",
				kind: "outbox_pending",
			}),
		});
		const afterZeroFacts = await beforeNextPoll(() => facts());
		expect(protectedFacts(afterZeroFacts)).toEqual(protectedFacts(beforeFacts));
		expect(afterZeroFacts.outbox).toBe(1);
		expect(afterZeroFacts.outboxSha256).toBe(beforeFacts.outboxSha256);
		expect(afterZeroFacts.outboxStatus).toBe("succeeded");
		await beforeNextPoll(
			() => activeSql`
			update platform.outbox_items set status = 'pending' where id = ${outboxId}
			`,
		);
		expect(await beforeNextPoll(() => facts())).toEqual(beforeFacts);
		await acquireOutboxLock();
		await waitForPendingSnapshot();
		const failuresBefore = activeWorker.observabilityStatus().exportFailures;
		await beforeNextPoll(() => activeCollector.disconnect());
		await until(
			async () =>
				activeWorker.observabilityStatus().exportFailures > failuresBefore,
		);
		const afterExportFailureFacts = protectedFacts(
			await beforeNextPoll(() => facts(false)),
		);
		expect(afterExportFailureFacts).toEqual(protectedFacts(beforeFacts));
		await beforeNextPoll(() => activeCollector.reconnect());
		await until(async () => {
			const text = await metrics().catch(() => undefined);
			if (text === undefined) return false;
			return (
				metricValue(text, "agent_platform_resource_count", {
					service: "platform-worker",
					kind: "task_waiting",
				}) === undefined &&
				metricValue(text, "agent_platform_resource_count", {
					service: "platform-worker",
					kind: "outbox_pending",
				}) === undefined
			);
		}, 80);
		observed.push({
			phase: "export-recovery-missing",
			taskWaiting: undefined,
			outboxPending: undefined,
		});
		await releaseOwnedLock();
		await until(async () => {
			const text = await metrics();
			return (
				metricValue(text, "agent_platform_resource_count", {
					service: "platform-worker",
					kind: "task_waiting",
				}) === 1 &&
				metricValue(text, "agent_platform_resource_count", {
					service: "platform-worker",
					kind: "outbox_pending",
				}) === 1
			);
		});
		observed.push({
			phase: "export-recovery-fresh",
			taskWaiting: 1,
			outboxPending: 1,
		});
		const finalFacts = await beforeNextPoll(() => facts());
		expect(finalFacts).toEqual(beforeFacts);
		await stopWorker(activeWorker);
		worker = undefined;
		await until(async () => {
			const text = await metrics();
			return (
				metricValue(text, "agent_platform_resource_count", {
					service: "platform-worker",
					kind: "task_waiting",
				}) === undefined &&
				metricValue(text, "agent_platform_resource_count", {
					service: "platform-worker",
					kind: "outbox_pending",
				}) === undefined
			);
		}, 80);
		await activeSql`
			insert into platform.outbox_items
				(id, scope_type, scope_id, operation, payload, status, available_at,
					trace_id)
			values (${restartOutboxId}, 'observability', 'worker-queue-restart',
					'observability.restart.probe.v1', ${activeSql.json({
						schemaVersion: 1,
						marker: "restart",
					})}, 'pending', now(), ${traceId})
		`;
		worker = await startWorker();
		const restartedWorker = worker;
		await until(async () => {
			const text = await metrics();
			return (
				metricValue(text, "agent_platform_resource_count", {
					service: "platform-worker",
					kind: "task_waiting",
				}) === 1 &&
				metricValue(text, "agent_platform_resource_count", {
					service: "platform-worker",
					kind: "outbox_pending",
				}) === 2
			);
		});
		observed.push({ phase: "restart-fresh", taskWaiting: 1, outboxPending: 2 });
		await beforeNextPoll(
			() => activeSql`
			delete from platform.outbox_items where id = ${restartOutboxId}
		`,
		);
		await until(async () => {
			const text = await metrics();
			return (
				metricValue(text, "agent_platform_resource_count", {
					service: "platform-worker",
					kind: "task_waiting",
				}) === 1 &&
				metricValue(text, "agent_platform_resource_count", {
					service: "platform-worker",
					kind: "outbox_pending",
				}) === 1
			);
		});
		expect(await beforeNextPoll(() => facts())).toEqual(beforeFacts);
		await stopWorker(restartedWorker);
		worker = undefined;
		// The independent child must settle real PG work and exit naturally while
		// its outbox lock remains held. This is the thin V2 assembly, not CLI proof.
		childDirectory = await mkdtemp(join(tmpdir(), "worker-queue-1064-"));
		const deploymentPath = join(childDirectory, "deployment.mjs");
		const runnerPath = join(childDirectory, "runner.mjs");
		const childSources = workerProcessSources({
			databaseUrl: activeDatabase.databaseUrl,
			collectorEndpoint: activeCollector.otlpEndpoint,
			workerEntrypoint: pathToFileURL(
				join(repositoryRoot, "apps/platform-worker/dist/index.mjs"),
			).href,
			deploymentModule: pathToFileURL(deploymentPath).href,
		});
		await writeFile(deploymentPath, childSources.deployment, { mode: 0o600 });
		await writeFile(runnerPath, childSources.runner, { mode: 0o600 });
		ordinaryPollDeadline = performance.now() + 25_000;
		child = spawn(process.execPath, [runnerPath], {
			cwd: repositoryRoot,
			stdio: ["ignore", "pipe", "pipe"],
		});
		childExit = once(child, "exit");
		const retainChildOutput = (chunk: Buffer) => {
			childOutput += String(chunk);
		};
		child.stdout?.on("data", retainChildOutput);
		child.stderr?.on("data", retainChildOutput);
		await until(
			async () => childOutput.includes("WORKER_QUEUE_CHILD_READY"),
			40,
		);
		await acquireOutboxLock();
		const childPending = await waitForPendingSnapshot();
		const childStopStartedAt = new Date().toISOString();
		expect(child.kill("SIGTERM")).toBe(true);
		const exiting = childExit;
		const [exitCode, exitSignal] = await beforeNextPoll(() => exiting);
		expect(exitCode).toBe(0);
		expect(exitSignal).toBeNull();
		ordinaryPollDeadline = undefined;
		const remainingChildBackends = await activeSql`
			select pid from pg_stat_activity where pid = any(${childPending.map((row) => row.pid)}::int[])
		`;
		expect(remainingChildBackends).toHaveLength(0);
		lifecycle.push({
			phase: "child-natural-exit",
			childStopStartedAt,
			exitedAt: new Date().toISOString(),
			pending: childPending,
			exitCode,
			exitSignal,
			lockHeldUntilExit: true,
			remainingBackends: remainingChildBackends.length,
		});
		await releaseOwnedLock();
		expect(await facts()).toEqual(beforeFacts);
		const traces = await activeCollector.read();
		const finalMetrics = await metrics();
		expect(logs).not.toContain(sentinel);
		expect(traces).not.toContain(sentinel);
		expect(finalMetrics).not.toContain(sentinel);
		expect(childOutput).not.toContain(sentinel);
		const sourceHashes = await readSourceHashes();
		expect(sourceHashes).toEqual(initialSourceHashes);
		const sourceDiff = execFileSync(
			"git",
			["diff", "--binary", "--", ...sourceFiles],
			{ cwd: repositoryRoot, encoding: "buffer" },
		);
		evidence = {
			sourceSha: execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: repositoryRoot,
				encoding: "utf8",
			}).trim(),
			sourceHashes,
			sourceManifestSha256: sha256(sourceHashes),
			sourceWorkingTreeDiffSha256: sha256(sourceDiff),
			sourceWorkingTreeStatus: execFileSync(
				"git",
				["status", "--short", "--", ...sourceFiles],
				{ cwd: repositoryRoot, encoding: "utf8" },
			),
			runner: {
				commandNode: process.execPath,
				nodeVersion: process.version,
				cwd: repositoryRoot,
			},
			command:
				"pnpm exec vitest run tests/observability/worker-queue-production.test.ts --maxWorkers=1",
			collectorImage,
			collectorImageId: activeCollector.imageId,
			observed,
			lifecycle,
			resourceReadFailures,
			publishedSamples,
			nonEmptyFacts: beforeFacts,
			finalFacts,
			exportFailures: {
				before: failuresBefore,
				after: activeWorker.observabilityStatus().exportFailures,
			},
			metricNames: ["agent_platform_resource_count"],
			limitations: [
				"Controlled deployment identity and Runtime host; no Runtime or Connection probe",
				"Child exercises packaged V2 assembly with controlled primary/workload; it is not the formal index CLI handler acceptance",
				"Queue counts consume the bounded #1048 predicate and are not the full Task waiting contract",
				"Local collector and controlled thresholds do not complete #441 AC8 production alert backend/output",
				"#441 AC1-AC9, #504 and #1064 parent obligations remain open",
			],
		};
	} catch (error) {
		bodyFailed = true;
		bodyError = error;
	} finally {
		ordinaryPollDeadline = undefined;
		if (releaseOutboxLock) releaseOutboxLock();
		if (heldOutboxLock) {
			try {
				await bounded(heldOutboxLock);
			} catch (error) {
				cleanupFailures.push(error);
			}
		}
		if (child && child.exitCode === null && child.signalCode === null) {
			try {
				child.kill("SIGTERM");
				if (childExit) await bounded(childExit);
			} catch (error) {
				cleanupFailures.push(error);
				child.kill("SIGKILL");
				try {
					if (childExit) await bounded(childExit, 2000);
				} catch (killError) {
					cleanupFailures.push(killError);
				}
			}
		}
		for (const close of [
			async () => worker?.stop(),
			async () => sql?.end({ timeout: 0 }),
			async () => database?.stop(),
			async () => collector?.stop(),
			async () => childDirectory && rm(childDirectory, { recursive: true }),
		]) {
			try {
				await bounded(close());
			} catch (error) {
				cleanupFailures.push(error);
			}
		}
	}
	if (!bodyFailed && cleanupFailures.length === 0 && evidence)
		await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
	if (bodyFailed && cleanupFailures.length)
		throw new AggregateError(
			[bodyError, ...cleanupFailures],
			"Worker queue production acceptance and cleanup failed",
		);
	if (bodyFailed) throw bodyError;
	if (cleanupFailures.length)
		throw new AggregateError(
			cleanupFailures,
			"Worker queue production cleanup failed",
		);
}, 120_000);
