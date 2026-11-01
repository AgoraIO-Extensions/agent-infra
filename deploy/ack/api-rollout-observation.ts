import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseAllDocuments } from "yaml";

type Deployment = Record<string, any>;
type Watch = Pick<ChildProcess, "stdout" | "stderr" | "on" | "kill" | "exitCode">;
type Observation = {
	schemaVersion: number; kind: string; sourceSha: string; startedAt: string; finishedAt?: string;
	status: string; windowComplete: boolean; eventCount: number; minimumAvailableReplicas: number | null;
	desiredReplicas: number | null; beforeReplicas: number | null; afterReplicas: number | null;
	uidHash?: string; firstVersionHash?: string; lastVersionHash?: string; failureCode?: string;
	businessVerified: false; httpAvailabilityVerified: false;
};
export class ApiRolloutObservationError extends Error {
	readonly receipt: Observation;
	readonly operationError?: unknown;
	constructor(receipt: Observation, operationError?: unknown) { super(receipt.failureCode); this.receipt = receipt; this.operationError = operationError; }
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const number = (value: string) => value === "" ? 0 : Number(value);
// Output only watch type, identity/version and replica counters; never retain env, annotations or errors.
export const apiWatchOutput = 'jsonpath={.type}{"|"}{.object.metadata.uid}{"|"}{.object.metadata.resourceVersion}{"|"}{.object.metadata.generation}{"|"}{.object.spec.replicas}{"|"}{.object.status.observedGeneration}{"|"}{.object.status.updatedReplicas}{"|"}{.object.status.availableReplicas}{"|"}{.object.status.readyReplicas}{"\\n"}';

export function apiReplicaTarget(rendered: string) {
	const api = parseAllDocuments(rendered).map((document) => { assert.equal(document.errors.length, 0); return document.toJSON(); })
		.filter((item) => item?.kind === "Deployment" && item.metadata?.name === "agent-infra-api");
	assert(api.length === 1);
	const count = api[0].spec?.replicas ?? 1;
	assert(Number.isSafeInteger(count) && count >= 1 && count <= 10);
	return count as number;
}

export async function observeApiRollout<T>(options: {
	sourceSha: string; desiredReplicas: number | null; timeoutMs: number;
	readApi: () => Deployment | null; watchApi: () => Watch;
}, action: () => Promise<T>) {
	const receipt: Observation = { schemaVersion: 1, kind: "ack-api-rollout-observation", sourceSha: options.sourceSha,
		startedAt: new Date().toISOString(), status: "unknown", windowComplete: false, eventCount: 0,
		minimumAvailableReplicas: null, desiredReplicas: options.desiredReplicas, beforeReplicas: null, afterReplicas: null,
		businessVerified: false, httpAvailabilityVerified: false };
	let watcher: Watch | undefined;
	let stopped = false;
	let closed = false;
	let failure: string | undefined;
	let buffer = "";
	const versions = new Set<string>();
	const deadline = Date.now() + options.timeoutMs;
	const waitFor = async (condition: () => boolean) => {
		while (!condition()) {
			assert(!failure, failure);
			assert(!closed && Date.now() < deadline, "API_ROLLOUT_WATCH_INCOMPLETE");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		assert(!failure && !closed && Date.now() < deadline, failure ?? "API_ROLLOUT_WATCH_INCOMPLETE");
	};
	try {
		assert(/^[a-f0-9]{40}$/u.test(options.sourceSha) && options.timeoutMs > 0 && options.timeoutMs <= 3_600_000);
		const before = options.readApi();
		const beforeReplicas = before?.spec?.replicas ?? 1;
		receipt.beforeReplicas = before ? beforeReplicas : null;
		receipt.desiredReplicas ??= beforeReplicas;
		assert(Number.isSafeInteger(receipt.desiredReplicas) && receipt.desiredReplicas! >= 1 && receipt.desiredReplicas! <= 10);
		if (before) {
			assert(before.metadata?.uid && before.metadata.resourceVersion);
			receipt.uidHash = digest(before.metadata.uid);
			watcher = options.watchApi();
			watcher.on("error", () => { failure = "API_ROLLOUT_WATCH_UNAVAILABLE"; });
			watcher.on("close", () => { closed = true; if (!stopped) failure = "API_ROLLOUT_WATCH_INCOMPLETE"; });
			watcher.stderr?.resume();
			watcher.stdout?.on("data", (chunk: Buffer) => {
				buffer += chunk.toString("utf8");
				if (buffer.length > 65_536) { failure = "API_ROLLOUT_WATCH_INVALID"; return; }
				let newline: number;
				while ((newline = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
					const [type, uid, version, ...values] = line.split("|");
					const [generation, declared, observedGeneration, updated, available, ready] = values.map(number);
					if (!["ADDED", "MODIFIED"].includes(type) || uid !== before.metadata.uid || !version ||
						values.length !== 6 || values.some((value) => !/^\d*$/u.test(value)) ||
						![generation, declared, observedGeneration, updated, available, ready].every(Number.isSafeInteger)) {
						failure = "API_ROLLOUT_WATCH_INVALID"; return;
					}
					if (declared !== beforeReplicas && declared !== receipt.desiredReplicas) { failure = "API_ROLLOUT_REPLICA_DRIFT"; return; }
					if (++receipt.eventCount > 20_000) { failure = "API_ROLLOUT_WATCH_LIMIT"; return; }
					receipt.firstVersionHash ??= digest(version);
					receipt.lastVersionHash = digest(version);
					versions.add(version);
					receipt.minimumAvailableReplicas = Math.min(receipt.minimumAvailableReplicas ?? available, available);
					if (available < 1 || ready < 1) failure = "API_ROLLOUT_AVAILABILITY_LOST";
				}
			});
			await waitFor(() => receipt.eventCount > 0);
		}
		const value = await action();
		const after = options.readApi();
		receipt.afterReplicas = after?.spec?.replicas ?? null;
		assert(after?.metadata?.uid && (!before || after.metadata.uid === before.metadata.uid) &&
			receipt.afterReplicas === receipt.desiredReplicas && after.status?.observedGeneration === after.metadata.generation &&
			after.status?.updatedReplicas === receipt.desiredReplicas && after.status?.readyReplicas === receipt.desiredReplicas &&
			after.status?.availableReplicas === receipt.desiredReplicas, "API_ROLLOUT_FINAL_STATE_INVALID");
		if (watcher) {
			await waitFor(() => versions.has(after.metadata.resourceVersion));
			receipt.windowComplete = true;
			receipt.status = "observed-available";
		} else receipt.status = "not-applicable-new-deployment";
		return { value, receipt };
	} catch (error) {
		receipt.status = failure === "API_ROLLOUT_AVAILABILITY_LOST" ? "observed-unavailable" : "unknown";
		receipt.failureCode = failure ?? (error instanceof Error && /^API_ROLLOUT_[A-Z_]+$/u.test(error.message) ? error.message : "API_ROLLOUT_OPERATION_FAILED");
		throw new ApiRolloutObservationError(receipt, error);
	} finally {
		receipt.finishedAt = new Date().toISOString();
		if (watcher && !closed) {
			stopped = true;
			watcher.kill("SIGTERM");
			const end = Date.now() + 2000;
			while (!closed && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
			if (!closed) watcher.kill("SIGKILL");
		}
	}
}

export function apiRolloutTools(kubeconfig: string, namespace: string, timeoutMs: number) {
	assert(kubeconfig && namespace);
	const args = ["--kubeconfig", kubeconfig, "-n", namespace];
	return {
		readApi: () => {
			const value = execFileSync("kubectl", [...args, "get", "deployment", "agent-infra-api", "--ignore-not-found", "-o", "json", "--request-timeout=20s"], { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
			return value.trim() ? JSON.parse(value) : null;
		},
		watchApi: () => spawn("kubectl", [...args, "get", "deployment", "agent-infra-api", "--watch", "--output-watch-events", "-o", apiWatchOutput, `--request-timeout=${Math.ceil(timeoutMs / 1000)}s`], { stdio: ["ignore", "pipe", "pipe"] }),
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [namespace, rendered, output, timeout, separator, command, ...args] = process.argv.slice(2);
	let receipt: Observation | undefined;
	try {
		const match = /^(\d+)(s|m|h)$/u.exec(timeout);
		assert(match && separator === "--" && command && output);
		const timeoutMs = Number(match[1]) * ({ s: 1000, m: 60_000, h: 3_600_000 }[match[2]] ?? 0);
		const tools = apiRolloutTools(process.env.ACK_KUBECONFIG!, namespace, timeoutMs);
		const result = await observeApiRollout({ ...tools, sourceSha: process.env.ACK_SOURCE_SHA!, desiredReplicas: rendered === "live" ? null : apiReplicaTarget(readFileSync(rendered, "utf8")), timeoutMs }, async () => {
			await new Promise<void>((resolve, reject) => {
				const child = spawn(command, args, { stdio: "inherit", timeout: timeoutMs });
				child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("API_ROLLOUT_OPERATION_FAILED")));
			});
			execFileSync("kubectl", ["--kubeconfig", process.env.ACK_KUBECONFIG!, "-n", namespace, "rollout", "status", "deployment/agent-infra-api", `--timeout=${timeout}`], { stdio: ["ignore", "pipe", "pipe"], timeout: timeoutMs });
		});
		receipt = result.receipt;
	} catch (error) {
		if (error instanceof ApiRolloutObservationError) receipt = error.receipt;
		process.stderr.write("ACK_API_ROLLOUT_OBSERVATION_FAILED\n");
		process.exitCode = 1;
	} finally {
		if (receipt) writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
	}
}
