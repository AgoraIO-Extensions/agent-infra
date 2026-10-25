#!/usr/bin/env node

// #3378：按执行汇总会话分阶段耗时（只读）。输入是 Worker 的 operation 日志与
// tests/stage-latency.sql 导出的时间点；只处理标识与时间，不读取正文。

import { readFile } from "node:fs/promises";

const usage = `Usage: node tests/stage-latency.mjs --logs <worker.log> [--facts <facts.json>] [--json]

  --logs   Worker JSON 日志（例如 kubectl logs deploy/<platform-worker> --since=30m）
  --facts  psql -tA -v minutes=30 -f tests/stage-latency.sql 的输出
  --json   输出 JSON，默认输出文本表`;

/** 阶段与说明；文本输出按此顺序。 */
export const stageLatencyStages = [
	["accepted_to_claim", "受理→认领（首次授权开始）"],
	["drain.authorization", "授权"],
	["drain.prepare", "准备"],
	["drain.route", "路由"],
	["runtime.submit", "提交"],
	["drain.host_read", "读取 Host 事件"],
	["drain.persist", "单事件持久化"],
	["drain.persist_batch", "批量持久化"],
	["drain.ack", "确认游标"],
	["accepted_to_first_text", "受理→首字"],
	["accepted_to_terminal", "受理→终态"],
	["terminal_persist_lag", "Runtime 终态→持久化"],
	["terminal_to_delivered", "终态→渠道送达"],
];

const durationStages = new Set([
	"drain.authorization",
	"drain.prepare",
	"drain.route",
	"drain.host_read",
	"drain.persist",
	"drain.persist_batch",
	"drain.ack",
]);

function time(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** 解析 Worker 日志，返回每个执行的阶段耗时（毫秒）与首次授权开始时间。 */
export function parseWorkerOperations(text) {
	const executions = new Map();
	for (const line of text.split("\n")) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.msg !== "operation" || typeof entry.executionId !== "string")
			continue;
		const durationMs = Number(entry.durationMs);
		const endedAt = time(entry.time);
		if (!Number.isFinite(durationMs) || durationMs < 0 || endedAt === undefined)
			continue;
		const stage =
			entry.stage === "runtime" && entry.operationRef === undefined
				? "runtime.submit"
				: entry.operationRef;
		if (stage !== "runtime.submit" && !durationStages.has(stage)) continue;
		const execution = executions.get(entry.executionId) ?? {
			durations: new Map(),
			authorizationStartedAt: undefined,
		};
		executions.set(entry.executionId, execution);
		const values = execution.durations.get(stage) ?? [];
		values.push(durationMs);
		execution.durations.set(stage, values);
		if (stage === "drain.authorization") {
			const startedAt = endedAt - durationMs;
			if (
				execution.authorizationStartedAt === undefined ||
				startedAt < execution.authorizationStartedAt
			)
				execution.authorizationStartedAt = startedAt;
		}
	}
	return executions;
}

function percentile(sorted, fraction) {
	return sorted[
		Math.min(sorted.length - 1, Math.round(fraction * (sorted.length - 1)))
	];
}

function summary(values) {
	const sorted = [...values].sort((left, right) => left - right);
	return {
		n: sorted.length,
		p50Ms: Math.round(percentile(sorted, 0.5)),
		p90Ms: Math.round(percentile(sorted, 0.9)),
		maxMs: Math.round(sorted.at(-1)),
	};
}

/** 合并日志与数据库时间点，返回各阶段 n/p50/p90/max 与按执行的明细。 */
export function summarizeStageLatency(operations, facts = []) {
	const series = new Map(stageLatencyStages.map(([name]) => [name, []]));
	const rows = new Map();
	const row = (executionId) => {
		const current = rows.get(executionId) ?? { executionId };
		rows.set(executionId, current);
		return current;
	};
	for (const [executionId, execution] of operations) {
		const current = row(executionId);
		for (const [stage, values] of execution.durations) {
			series.get(stage)?.push(...values);
			current[stage] = Math.round(
				values.reduce((sum, value) => sum + value, 0),
			);
		}
	}
	for (const fact of facts) {
		if (typeof fact?.executionId !== "string") continue;
		const current = row(fact.executionId);
		if (typeof fact.channelId === "string") current.channelId = fact.channelId;
		const acceptedAt = time(fact.acceptedAt);
		const between = (name, from, to) => {
			if (from === undefined || to === undefined || to < from) return;
			series.get(name)?.push(to - from);
			current[name] = Math.round(to - from);
		};
		between(
			"accepted_to_claim",
			acceptedAt,
			operations.get(fact.executionId)?.authorizationStartedAt,
		);
		between("accepted_to_first_text", acceptedAt, time(fact.firstTextAt));
		between("accepted_to_terminal", acceptedAt, time(fact.terminalPersistedAt));
		between(
			"terminal_persist_lag",
			time(fact.terminalOccurredAt),
			time(fact.terminalPersistedAt),
		);
		between(
			"terminal_to_delivered",
			time(fact.terminalPersistedAt),
			time(fact.deliveredAt),
		);
	}
	return {
		stages: Object.fromEntries(
			[...series]
				.filter(([, values]) => values.length > 0)
				.map(([name, values]) => [name, summary(values)]),
		),
		executions: [...rows.values()],
	};
}

function formatText(result) {
	const lines = [];
	for (const [name, label] of stageLatencyStages) {
		const value = result.stages[name];
		if (!value) continue;
		lines.push(
			`${label.padEnd(20)} ${name.padEnd(24)} n=${value.n} p50=${(value.p50Ms / 1000).toFixed(1)}s p90=${(value.p90Ms / 1000).toFixed(1)}s max=${(value.maxMs / 1000).toFixed(1)}s`,
		);
	}
	return lines.length > 0 ? lines.join("\n") : "no stage observations";
}

function parseArguments(argv) {
	const options = { json: false };
	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--json") options.json = true;
		else if (argument === "--logs" || argument === "--facts") {
			const value = argv[++index];
			if (!value) throw new Error(usage);
			options[argument.slice(2)] = value;
		} else throw new Error(usage);
	}
	if (!options.logs) throw new Error(usage);
	return options;
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const operations = parseWorkerOperations(
		await readFile(options.logs, "utf8"),
	);
	const factsText = options.facts
		? (await readFile(options.facts, "utf8")).trim()
		: "";
	// psql -tA 会把 begin/rollback 的命令标签一起输出，只取 JSON 那一行。
	const factsLine = factsText.split("\n").find((line) => line.startsWith("["));
	const facts = factsLine ? JSON.parse(factsLine) : [];
	if (!Array.isArray(facts)) throw new Error("facts must be a JSON array");
	const result = summarizeStageLatency(operations, facts);
	process.stdout.write(
		`${options.json ? JSON.stringify(result, null, 2) : formatText(result)}\n`,
	);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	});
}
