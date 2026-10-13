#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const CONFIRMATION = "I_HAVE_AUTHORIZED_PLATFORM_TARGET";
const DEFAULTS = Object.freeze({
	conversations: 1,
	concurrency: 2,
	healthPath: "/health",
	requestTimeoutMs: 5_000,
	sse: false,
	sseTimeoutMs: 750,
	tasks: 1,
	users: 1,
});
const LIMITS = Object.freeze({
	conversations: 100,
	concurrency: 50,
	requestTimeoutMs: 60_000,
	sseTimeoutMs: 10_000,
	tasks: 100,
	totalConversations: 500,
	users: 50,
});

const usage = `Usage: node tests/platform-capacity-load.mjs [options]

Required environment (credentials are read only from the environment or token file):
  PLATFORM_LOAD_BASE_URL       Platform API origin (no path, query, or credentials)
  PLATFORM_LOAD_AGENT_ID       Agent under the explicitly assigned test scope
  PLATFORM_LOAD_ENVIRONMENT     Named disposable/approved environment
  PLATFORM_LOAD_MODEL           Model/profile label used by the environment
  PLATFORM_LOAD_IMAGE_DIGEST    Runtime/Platform image digest for this run
  PLATFORM_LOAD_CONFIRM         Must equal ${CONFIRMATION}
  PLATFORM_LOAD_TOKEN or
  PLATFORM_LOAD_TOKEN_FILE      One credential; use PLATFORM_LOAD_TOKENS_FILE for users > 1

Options:
  --users N                    Virtual users (default: ${DEFAULTS.users})
  --conversations N            Conversations per user (default: ${DEFAULTS.conversations})
  --tasks N                    Tasks per conversation (default: ${DEFAULTS.tasks})
  --concurrency N              Concurrent conversations (default: ${DEFAULTS.concurrency})
  --request-timeout-ms N       Per-request timeout (default: ${DEFAULTS.requestTimeoutMs})
  --sse                        Read one bounded SSE frame for each accepted task
  --sse-timeout-ms N           SSE read timeout (default: ${DEFAULTS.sseTimeoutMs})
  --health-path PATH           Preflight path (default: ${DEFAULTS.healthPath})
  --output FILE                Write JSON evidence to an absolute path
  --help                       Show this help

The request body is synthetic and bounded. Response bodies, tokens, prompts, and
SSE data are never written to evidence or logs.
`;

function positiveInteger(value, name, maximum) {
	if (!/^\d+$/.test(value))
		throw new Error(`${name} must be a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum)
		throw new Error(`${name} must be between 1 and ${maximum}`);
	return parsed;
}

function loadSourceSha(env) {
	if (env.PLATFORM_LOAD_SOURCE_SHA) return env.PLATFORM_LOAD_SOURCE_SHA;
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return "unknown";
	}
}

function parseOrigin(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		throw new Error("PLATFORM_LOAD_BASE_URL must be a valid HTTP(S) origin");
	}
	if (
		!/^https?:$/.test(url.protocol) ||
		url.username ||
		url.password ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	)
		throw new Error(
			"PLATFORM_LOAD_BASE_URL must be an HTTP(S) origin without credentials, path, query, or fragment",
		);
	return url.origin;
}

function parseOption(argv, index) {
	const value = argv[index];
	if (value === undefined || value.startsWith("--"))
		throw new Error(`Missing value for ${argv[index - 1]}`);
	return value;
}

export function parseLoadOptions(argv, env = process.env) {
	if (argv.includes("--help")) return { help: true };
	const values = {};
	for (let index = 0; index < argv.length; index += 1) {
		const option = argv[index];
		switch (option) {
			case "--users":
				values.users = parseOption(argv, ++index);
				break;
			case "--conversations":
				values.conversations = parseOption(argv, ++index);
				break;
			case "--tasks":
				values.tasks = parseOption(argv, ++index);
				break;
			case "--concurrency":
				values.concurrency = parseOption(argv, ++index);
				break;
			case "--request-timeout-ms":
				values.requestTimeoutMs = parseOption(argv, ++index);
				break;
			case "--sse":
				values.sse = true;
				break;
			case "--sse-timeout-ms":
				values.sseTimeoutMs = parseOption(argv, ++index);
				break;
			case "--health-path":
				values.healthPath = parseOption(argv, ++index);
				break;
			case "--output":
				values.output = parseOption(argv, ++index);
				break;
			default:
				throw new Error(`Unknown option: ${option}`);
		}
	}

	const baseUrl = parseOrigin(env.PLATFORM_LOAD_BASE_URL ?? "");
	const agentId = env.PLATFORM_LOAD_AGENT_ID?.trim();
	const environment = env.PLATFORM_LOAD_ENVIRONMENT?.trim();
	const model = env.PLATFORM_LOAD_MODEL?.trim();
	const imageDigest = env.PLATFORM_LOAD_IMAGE_DIGEST?.trim();
	if (!agentId) throw new Error("PLATFORM_LOAD_AGENT_ID is required");
	if (!environment) throw new Error("PLATFORM_LOAD_ENVIRONMENT is required");
	if (!model) throw new Error("PLATFORM_LOAD_MODEL is required");
	if (!imageDigest) throw new Error("PLATFORM_LOAD_IMAGE_DIGEST is required");
	if (!/^sha256:[a-f0-9]{64}$/.test(imageDigest))
		throw new Error("PLATFORM_LOAD_IMAGE_DIGEST must be a sha256 digest");
	if (env.PLATFORM_LOAD_CONFIRM !== CONFIRMATION)
		throw new Error(`PLATFORM_LOAD_CONFIRM must equal ${CONFIRMATION}`);
	if (env.PLATFORM_LOAD_TOKEN && env.PLATFORM_LOAD_TOKEN_FILE)
		throw new Error(
			"Set only one of PLATFORM_LOAD_TOKEN and PLATFORM_LOAD_TOKEN_FILE",
		);
	if (
		(env.PLATFORM_LOAD_TOKEN || env.PLATFORM_LOAD_TOKEN_FILE) &&
		env.PLATFORM_LOAD_TOKENS_FILE
	)
		throw new Error(
			"Set only one single-token source and PLATFORM_LOAD_TOKENS_FILE",
		);
	if (
		!env.PLATFORM_LOAD_TOKEN &&
		!env.PLATFORM_LOAD_TOKEN_FILE &&
		!env.PLATFORM_LOAD_TOKENS_FILE
	)
		throw new Error(
			"PLATFORM_LOAD_TOKEN, PLATFORM_LOAD_TOKEN_FILE or PLATFORM_LOAD_TOKENS_FILE is required",
		);

	const users = positiveInteger(
		values.users ?? String(DEFAULTS.users),
		"users",
		LIMITS.users,
	);
	const conversations = positiveInteger(
		values.conversations ?? String(DEFAULTS.conversations),
		"conversations",
		LIMITS.conversations,
	);
	const tasks = positiveInteger(
		values.tasks ?? String(DEFAULTS.tasks),
		"tasks",
		LIMITS.tasks,
	);
	const concurrency = positiveInteger(
		values.concurrency ?? String(DEFAULTS.concurrency),
		"concurrency",
		LIMITS.concurrency,
	);
	const requestTimeoutMs = positiveInteger(
		values.requestTimeoutMs ?? String(DEFAULTS.requestTimeoutMs),
		"request-timeout-ms",
		LIMITS.requestTimeoutMs,
	);
	const sseTimeoutMs = positiveInteger(
		values.sseTimeoutMs ?? String(DEFAULTS.sseTimeoutMs),
		"sse-timeout-ms",
		LIMITS.sseTimeoutMs,
	);
	if (users * conversations > LIMITS.totalConversations)
		throw new Error(
			`users * conversations must be <= ${LIMITS.totalConversations}`,
		);
	if (!/^\/(?:[^?\\#]*)$/.test(values.healthPath ?? DEFAULTS.healthPath))
		throw new Error(
			"health-path must be an absolute path without query or fragment",
		);
	if (values.output !== undefined) {
		if (!isAbsolute(values.output))
			throw new Error("output must be an absolute path outside the repository");
		const outputPath = resolve(values.output);
		const repositoryPath = `${resolve(process.cwd())}/`;
		if (
			outputPath === resolve(process.cwd()) ||
			outputPath.startsWith(repositoryPath)
		)
			throw new Error("output must be an absolute path outside the repository");
	}
	if (users > 1 && !env.PLATFORM_LOAD_TOKENS_FILE)
		throw new Error(
			"users > 1 requires PLATFORM_LOAD_TOKENS_FILE with one token per user",
		);

	return {
		agentId,
		baseUrl,
		concurrency,
		conversations,
		environment,
		healthPath: values.healthPath ?? DEFAULTS.healthPath,
		imageDigest,
		model,
		output: values.output,
		requestTimeoutMs,
		sourceSha: loadSourceSha(env),
		sse: values.sse ?? DEFAULTS.sse,
		sseTimeoutMs,
		tasks,
		tokenFile: env.PLATFORM_LOAD_TOKEN_FILE,
		tokensFile: env.PLATFORM_LOAD_TOKENS_FILE,
		users,
	};
}

async function readSecretFile(path, name) {
	const info = await lstat(path);
	if (!info.isFile()) throw new Error(`${name} must reference a regular file`);
	const value = (await readFile(path, "utf8")).trim();
	if (!value) throw new Error(`${name} must not be empty`);
	return value;
}

async function loadTokens(options, env = process.env) {
	if (options.tokensFile) {
		const raw = await readSecretFile(
			options.tokensFile,
			"PLATFORM_LOAD_TOKENS_FILE",
		);
		const tokens = raw
			.split(/\r?\n/)
			.map((value) => value.trim())
			.filter(Boolean);
		if (tokens.length !== options.users)
			throw new Error(
				`PLATFORM_LOAD_TOKENS_FILE must contain exactly ${options.users} non-empty lines`,
			);
		return tokens;
	}
	return [
		options.tokenFile
			? await readSecretFile(options.tokenFile, "PLATFORM_LOAD_TOKEN_FILE")
			: env.PLATFORM_LOAD_TOKEN,
	];
}

function boundedHash(value) {
	return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function safeError(error) {
	if (error?.name === "AbortError") return "timeout";
	if (error instanceof TypeError) return "network_error";
	return "request_error";
}

function percentile(values, fraction) {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return Number(
		sorted[
			Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
		].toFixed(2),
	);
}

function summaryFor(records) {
	const latencies = records
		.filter((record) => record.durationMs !== null)
		.map((record) => record.durationMs);
	const byOutcome = {};
	for (const record of records) {
		const key = `${record.phase}:${record.outcome}`;
		byOutcome[key] = (byOutcome[key] ?? 0) + 1;
	}
	return {
		byOutcome,
		latencyMs: {
			count: latencies.length,
			p50: percentile(latencies, 0.5),
			p95: percentile(latencies, 0.95),
			p99: percentile(latencies, 0.99),
			max: latencies.length ? Number(Math.max(...latencies).toFixed(2)) : null,
		},
		totalRequests: records.length,
	};
}

async function requestJson({
	fetchImpl,
	method,
	url,
	token,
	body,
	timeoutMs,
	phase,
	idempotencyKey,
}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const started = performance.now();
	const headers = {
		Accept: "application/json",
		Authorization: `Bearer ${token}`,
		...(idempotencyKey === undefined
			? {}
			: { "Idempotency-Key": idempotencyKey }),
	};
	if (body !== undefined) headers["Content-Type"] = "application/json";
	try {
		const response = await fetchImpl(url, {
			method,
			headers,
			signal: controller.signal,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		let payload;
		if (response.ok || response.status === 202) {
			try {
				payload = await response.json();
			} catch {
				payload = undefined;
			}
		}
		return {
			durationMs: Number((performance.now() - started).toFixed(2)),
			phase,
			payload,
			status: response.status,
			outcome: response.ok ? "http_ok" : `http_${response.status}`,
		};
	} catch (error) {
		return {
			durationMs: Number((performance.now() - started).toFixed(2)),
			phase,
			status: null,
			outcome: safeError(error),
		};
	} finally {
		clearTimeout(timer);
	}
}

async function requestSse({ fetchImpl, url, token, timeoutMs }) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const started = performance.now();
	try {
		const response = await fetchImpl(url, {
			headers: {
				Accept: "text/event-stream",
				Authorization: `Bearer ${token}`,
			},
			signal: controller.signal,
		});
		if (!response.ok)
			return {
				durationMs: Number((performance.now() - started).toFixed(2)),
				phase: "sse",
				status: response.status,
				outcome: `http_${response.status}`,
			};
		const reader = response.body?.getReader();
		if (!reader) throw new Error("SSE response has no body");
		try {
			await reader.read();
		} finally {
			await reader.cancel();
		}
		return {
			durationMs: Number((performance.now() - started).toFixed(2)),
			phase: "sse",
			status: response.status,
			outcome: "frame_read",
		};
	} catch (error) {
		return {
			durationMs: Number((performance.now() - started).toFixed(2)),
			phase: "sse",
			status: null,
			outcome: safeError(error),
		};
	} finally {
		clearTimeout(timer);
	}
}

function taskReference(payload) {
	if (
		!payload ||
		typeof payload.conversationId !== "string" ||
		typeof payload.executionId !== "string"
	)
		return null;
	return {
		conversation: boundedHash(payload.conversationId),
		execution: boundedHash(payload.executionId),
	};
}

async function runConversation({
	fetchImpl,
	options,
	token,
	userIndex,
	conversationIndex,
}) {
	const records = [];
	let conversationId;
	const refs = [];
	for (let taskIndex = 0; taskIndex < options.tasks; taskIndex += 1) {
		const idempotencyKey = `platform-load-${Date.now()}-${userIndex}-${conversationIndex}-${taskIndex}`;
		const payload = {
			schemaVersion: 1,
			text: "platform-capacity-probe",
			...(conversationId === undefined ? {} : { conversationId }),
		};
		const submission = await requestJson({
			body: payload,
			fetchImpl,
			method: "POST",
			phase: "submit",
			timeoutMs: options.requestTimeoutMs,
			token,
			idempotencyKey,
			url: `${options.baseUrl}/api/v1/agents/${encodeURIComponent(options.agentId)}/tasks`,
		});
		records.push(submission);
		if (submission.outcome !== "http_ok" || submission.status !== 202) continue;
		const reference = taskReference(submission.payload);
		if (!reference) {
			records.push({
				durationMs: 0,
				phase: "accepted_payload",
				status: submission.status,
				outcome: "invalid_payload",
			});
			continue;
		}
		conversationId = submission.payload.conversationId;
		refs.push({ ...reference, task: taskIndex });
		const path = `/api/v1/conversations/${encodeURIComponent(conversationId)}/tasks/${encodeURIComponent(submission.payload.executionId)}`;
		const readback = await requestJson({
			fetchImpl,
			method: "GET",
			phase: "readback",
			timeoutMs: options.requestTimeoutMs,
			token,
			url: `${options.baseUrl}${path}`,
		});
		if (readback.payload && typeof readback.payload.status === "string")
			refs[refs.length - 1].status = readback.payload.status;
		records.push(readback);
		if (options.sse) {
			records.push(
				await requestSse({
					fetchImpl,
					timeoutMs: options.sseTimeoutMs,
					token,
					url: `${options.baseUrl}${path}/events`,
				}),
			);
		}
	}
	return { records, refs };
}

async function runPool(items, concurrency, worker) {
	const results = [];
	let cursor = 0;
	async function consume() {
		while (cursor < items.length) {
			const index = cursor;
			cursor += 1;
			results[index] = await worker(items[index]);
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(concurrency, items.length) }, () =>
			consume(),
		),
	);
	return results;
}

export async function runCapacityLoad({
	fetchImpl = globalThis.fetch,
	now = () => new Date(),
	options,
	tokens,
}) {
	if (typeof fetchImpl !== "function")
		throw new Error("Global fetch is unavailable");
	const startedAt = now();
	const records = [];
	const preflight = await requestJson({
		fetchImpl,
		method: "GET",
		phase: "preflight",
		timeoutMs: options.requestTimeoutMs,
		token: tokens[0],
		url: `${options.baseUrl}${options.healthPath}`,
	});
	records.push(preflight);
	if (
		preflight.status === null ||
		preflight.status < 200 ||
		preflight.status >= 300
	) {
		return createEvidence({
			endedAt: now(),
			options,
			records,
			refs: [],
			startedAt,
		});
	}
	const work = Array.from(
		{ length: options.users * options.conversations },
		(_, index) => ({
			conversationIndex: index % options.conversations,
			token: tokens[Math.floor(index / options.conversations)],
			userIndex: Math.floor(index / options.conversations),
		}),
	);
	const results = await runPool(work, options.concurrency, (item) =>
		runConversation({ ...item, fetchImpl, options }),
	);
	const refs = results.flatMap((result) => result.refs);
	records.push(...results.flatMap((result) => result.records));
	return createEvidence({
		endedAt: now(),
		options,
		records,
		refs,
		startedAt,
	});
}

function createEvidence({ endedAt, options, records, refs, startedAt }) {
	const duplicateExecutions =
		refs.length - new Set(refs.map((ref) => ref.execution)).size;
	return {
		format: "platform-capacity-load/v1",
		startedAt: startedAt.toISOString(),
		endedAt: endedAt.toISOString(),
		environment: options.environment,
		sourceSha: options.sourceSha,
		imageDigest: options.imageDigest,
		model: options.model,
		target: {
			agentId: options.agentId,
			baseOrigin: options.baseUrl,
		},
		plan: {
			users: options.users,
			conversationsPerUser: options.conversations,
			tasksPerConversation: options.tasks,
			concurrency: options.concurrency,
			sse: options.sse,
		},
		result: {
			acceptedTasks: refs.length,
			duplicateExecutions,
			readbackReferences: refs,
			summary: summaryFor(records),
		},
	};
}

async function writeEvidence(evidence, output) {
	const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
	if (output) {
		await writeFile(resolve(output), serialized, {
			encoding: "utf8",
			mode: 0o600,
		});
		return;
	}
	process.stdout.write(serialized);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
	const options = parseLoadOptions(argv, env);
	if (options.help) {
		process.stdout.write(usage);
		return 0;
	}
	const tokens = await loadTokens(options, env);
	const evidence = await runCapacityLoad({ options, tokens });
	await writeEvidence(evidence, options.output);
	return evidence.result.summary.byOutcome["preflight:http_ok"] === 1 ? 0 : 1;
}

const entrypoint = process.argv[1]
	? new URL(process.argv[1], `file://${process.cwd()}/`).href
	: "";
if (import.meta.url === entrypoint) {
	main().catch((error) => {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 2;
	});
}
