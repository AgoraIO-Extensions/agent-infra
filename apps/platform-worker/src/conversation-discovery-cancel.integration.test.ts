import { execFile as execFileCallback } from "node:child_process";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { PostgresConversationDispatchStoreV1 } from "@agent-infra/platform-store";
import postgres from "postgres";
import { expect, it } from "vitest";
import { migratePlatformDatabase } from "../../../packages/platform-store/src/migrate.js";
import {
	type PostgresTestDatabase,
	startPostgresTestDatabase,
} from "../../../packages/platform-store/src/postgres-test.js";
import { createPlatformConversationWorkerV2 } from "./conversation-worker.js";

const execFile = promisify(execFileCallback);
type Client = ReturnType<typeof postgres>;
type Worker = ReturnType<typeof createPlatformConversationWorkerV2>;
type Outcome = {
	outcome: "resolved" | "rejected";
	value?: number | boolean;
	rowCount?: number;
	code?: string | null;
	signalAbortedAtObservation?: boolean;
};

async function observe<T>(
	promise: PromiseLike<T>,
	signal?: AbortSignal,
): Promise<Outcome> {
	try {
		const value = await promise;
		return {
			outcome: "resolved",
			...(typeof value === "number" || typeof value === "boolean"
				? { value }
				: {}),
			...(Array.isArray(value) ? { rowCount: value.length } : {}),
			...(signal ? { signalAbortedAtObservation: signal.aborted } : {}),
		};
	} catch (error) {
		const code = (error as { code?: unknown } | null)?.code;
		return {
			outcome: "rejected",
			code: typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : null,
			...(signal ? { signalAbortedAtObservation: signal.aborted } : {}),
		};
	}
}

it("converges ordinary discovery cancellation and preserves database faults after abort", async () => {
	const sessionId = `discovery-cancel-${randomUUID()}`;
	const previousSession = process.env.AO_SESSION_ID;
	const phases: Record<string, unknown>[] = [];
	const cleanup: { resource: string; result: Outcome }[] = [];
	const serverErrors: { pid: number; code: string }[] = [];
	const clients: Client[] = [];
	const workers: Worker[] = [];
	const closedWorkers = new Set<Worker>();
	let database: PostgresTestDatabase | undefined;
	let store: PostgresConversationDispatchStoreV1 | undefined;
	let lock: Awaited<ReturnType<Client["reserve"]>> | undefined;
	let containerId: string | undefined;
	let callbacks = 0;
	let containerAbsent = false;
	async function clean(resource: string, action: () => unknown) {
		cleanup.push({
			resource,
			result: await observe(Promise.resolve().then(action)),
		});
	}

	async function ownedContainers() {
		const { stdout } = await execFile("docker", [
			"ps",
			"--all",
			"--quiet",
			"--no-trunc",
			"--filter",
			`label=ao.session=${sessionId}`,
		]);
		return stdout.trim().split(/\s+/).filter(Boolean);
	}
	async function identifyContainer() {
		const ids = await ownedContainers();
		if (ids.length !== 1 || !ids[0])
			throw new Error("Owned PostgreSQL identity is not unique");
		const { stdout } = await execFile("docker", ["inspect", ids[0]]);
		const inspected = JSON.parse(stdout)[0];
		if (
			inspected.Id !== ids[0] ||
			inspected.Config.Labels["ao.session"] !== sessionId ||
			!inspected.Name.startsWith("/agent-infra-discovery-cancel-") ||
			inspected.Config.Image !==
				"postgres@sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416"
		)
			throw new Error("Owned PostgreSQL provenance mismatch");
		return ids[0];
	}
	async function readServerErrors() {
		if (!containerId) return;
		const { stdout, stderr } = await execFile("docker", [
			"logs",
			"--tail",
			"2000",
			containerId,
		]);
		serverErrors.length = 0;
		for (const line of `${stdout}\n${stderr}`.split("\n")) {
			const match = line.match(
				/\[(\d+)\]\s+(?:ERROR|FATAL|PANIC):\s+([A-Z0-9]{5}):/,
			);
			if (match?.[1] && match[2])
				serverErrors.push({ pid: Number(match[1]), code: match[2] });
		}
	}
	try {
		process.env.AO_SESSION_ID = sessionId;
		try {
			database = await startPostgresTestDatabase("discovery-cancel");
		} finally {
			if (previousSession === undefined) delete process.env.AO_SESSION_ID;
			else process.env.AO_SESSION_ID = previousSession;
		}
		containerId = await identifyContainer();
		await migratePlatformDatabase(database);
		const sql = postgres(database.databaseUrl, { max: 1 });
		clients.push(sql);
		const raw = postgres(database.databaseUrl, { max: 1 });
		clients.push(raw);
		const observer = postgres(database.databaseUrl, { max: 1 });
		clients.push(observer);
		store = new PostgresConversationDispatchStoreV1(database);
		await sql.unsafe("alter system set log_error_verbosity = 'verbose'");
		await sql`select pg_reload_conf()`;
		async function blockedPid() {
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				const rows = await observer<{ pid: number }[]>`
					select pid from pg_stat_activity
					where datname = current_database() and state = 'active'
						and wait_event_type = 'Lock'
						and query ~ 'select[[:space:]]+id,[[:space:]]+operation[[:space:]]+from[[:space:]]+platform.outbox_items'
				`;
				if (rows.length === 1 && rows[0]) return rows[0].pid;
				if (rows.length > 1)
					throw new Error("Owned discovery PID is ambiguous");
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			throw new Error("Discovery did not reach PostgreSQL lock wait");
		}
		lock = await sql.reserve();
		await lock.unsafe("begin");
		await lock.unsafe(
			"lock table platform.outbox_items in access exclusive mode",
		);

		const query = raw`select id, operation from platform.outbox_items`;
		const rawPending = observe(query);
		const rawPid = await blockedPid();
		query.cancel();
		const rawOutcome = await rawPending;
		phases.push({ phase: "raw_cancel", pid: rawPid, result: rawOutcome });

		const controller = new AbortController();
		const finding = observe(
			store.findDispatchable({ limit: 1, signal: controller.signal }),
		);
		const storePid = await blockedPid();
		controller.abort();
		phases.push({
			phase: "store_cancel",
			pid: storePid,
			result: await finding,
		});

		const existingPids = new Set(
			(
				await observer<{ pid: number }[]>`
				select pid from pg_stat_activity where datname = current_database()
			`
			).map((row) => row.pid),
		);
		const keys = generateKeyPairSync("ed25519");
		const options = {
			databaseUrl: database.databaseUrl,
			workerId: "discovery-cancel-test",
			signing: {
				issuer: "discovery-cancel-test",
				workerId: "discovery-cancel-transport",
				keyId: "discovery-cancel-key",
				privateKey: keys.privateKey,
			},
			directory: {
				async resolveUser() {
					callbacks += 1;
					throw new Error("Empty discovery must not resolve users");
				},
			},
			async resolveRuntimeHost() {
				callbacks += 1;
				throw new Error("Empty discovery must not dispatch to a Host");
			},
			log: () => {},
		};
		const worker = createPlatformConversationWorkerV2(options);
		workers.push(worker);
		const tick = observe(worker.tick());
		const workerPid = await blockedPid();
		const stop = observe(worker.stop());
		const tickOutcome = await tick;
		const stopOutcome = await stop;
		closedWorkers.add(worker);
		phases.push({
			phase: "worker_cancel",
			pid: workerPid,
			tick: tickOutcome,
			stop: stopOutcome,
		});

		const failureController = new AbortController();
		const failingWorker = createPlatformConversationWorkerV2({
			...options,
			signal: failureController.signal,
		});
		workers.push(failingWorker);
		const failingTick = observe(failingWorker.tick(), failureController.signal);
		const failurePid = await blockedPid();
		const terminating = observe(
			observer`select pg_terminate_backend(${failurePid}) as terminated`.then(
				(rows) => rows[0]?.terminated === true,
			),
		);
		// Start the real query; abort and stop before consuming its failure.
		await Promise.resolve();
		failureController.abort();
		const failingStop = observe(failingWorker.stop(), failureController.signal);
		const failureTickOutcome = await failingTick;
		const failureStopOutcome = await failingStop;
		const terminationOutcome = await terminating;
		closedWorkers.add(failingWorker);
		phases.push({
			phase: "backend_termination",
			pid: failurePid,
			termination: terminationOutcome,
			tick: failureTickOutcome,
			stop: failureStopOutcome,
		});
		const remaining = (
			await observer<{ pid: number }[]>`
			select pid from pg_stat_activity where datname = current_database()
		`
		).filter((row) => !existingPids.has(row.pid)).length;
		phases.push({ phase: "closed_worker_connections", remaining });
		await readServerErrors();

		expect(rawOutcome).toEqual({ outcome: "rejected", code: "57014" });
		for (const pid of [rawPid, storePid, workerPid])
			expect(serverErrors).toContainEqual({ pid, code: "57014" });
		expect(terminationOutcome).toEqual({ outcome: "resolved", value: true });
		expect(
			new Set(
				serverErrors
					.filter(({ pid }) => pid === failurePid)
					.map(({ code }) => code),
			),
		).toEqual(new Set(["57P01"]));
		expect(failureTickOutcome.outcome).toBe("rejected");
		expect(failureTickOutcome.signalAbortedAtObservation).toBe(true);
		expect(failureStopOutcome.outcome).toBe("rejected");
		expect(failureStopOutcome.signalAbortedAtObservation).toBe(true);
		expect(callbacks).toBe(0);
		expect(remaining).toBe(0);
		// Same contract as the production Worker's existing in-flight stop unit test.
		expect(stopOutcome).toEqual({ outcome: "resolved" });
		expect(tickOutcome).toEqual({ outcome: "resolved", value: 0 });
	} finally {
		try {
			if (containerId) await clean("safe_logs", readServerErrors);
			if (lock) {
				const ownedLock = lock;
				await clean("lock_rollback", () => ownedLock.unsafe("rollback"));
				await clean("lock_release", () => ownedLock.release());
			}
			for (const worker of workers)
				if (!closedWorkers.has(worker))
					await clean("worker", () => worker.stop());
			if (store) {
				const ownedStore = store;
				await clean("store", () => ownedStore.close());
			}
			for (const client of clients)
				await clean("client", () => client.end({ timeout: 5 }));
			if (database) {
				const ownedDatabase = database;
				await clean("database", () => ownedDatabase.stop());
			}
			const remaining = await ownedContainers();
			// The existing helper swallows removal errors. Recover only this exact PG.
			if (remaining.length > 0) {
				cleanup.push({
					resource: "helper_container_removal",
					result: { outcome: "rejected", code: "OWNED_CONTAINER_REMAINS" },
				});
				const id = await identifyContainer();
				await clean("exact_container_removal", () =>
					execFile("docker", ["rm", "--force", "--volumes", id]),
				);
			}
			containerAbsent = (await ownedContainers()).length === 0;
		} finally {
			console.info(
				JSON.stringify({
					phases,
					serverErrors,
					callbacks,
					cleanup,
					containerAbsent,
				}),
			);
		}
		expect(
			containerAbsent,
			"owned PostgreSQL must be absent after cleanup",
		).toBe(true);
		expect(
			cleanup.every(({ result }) => result.outcome === "resolved"),
			"all resource cleanup must succeed",
		).toBe(true);
	}
}, 120_000);
