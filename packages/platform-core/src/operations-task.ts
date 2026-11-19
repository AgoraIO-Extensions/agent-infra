import type { OperationsTasksV2 } from "@agent-infra/contracts/pilot";
import { isExactExecutionFailureCodeV1 } from "./execution-failure.js";

type Task = OperationsTasksV2["tasks"][number];
type Evidence = Task["evidence"][number];

export interface OperationsTaskFactV2 {
	kind: string;
	state: string | null;
	at: Date;
	code: string | null;
	operationRef?: string | null;
	attemptRef?: string | null;
	startedAt?: string | null;
	finishedAt?: string | null;
}

const queueCodes = new Set([
	"TASK_WAIT_TIMEOUT",
	"AGENT_UNAVAILABLE",
	"CONVERSATION_UNAVAILABLE",
]);
const operationCodes = new Set([
	"authorization_denied",
	"authorization_unavailable",
	"dependency_unavailable",
	"request_rejected",
	"response_incomplete",
	"operation_failed",
	"persistence_unavailable",
	"interrupted",
	"recovery_unconfirmed",
]);

function instant(input?: string | null): string | null {
	const time = input ? Date.parse(input) : Number.NaN;
	return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

export function projectOperationsTaskV2(
	task: Pick<Task, "executionId" | "status"> & {
		createdAt: Date;
		terminalAt: Date | null;
		unknownSince: Date | null;
	},
	facts: readonly OperationsTaskFactV2[],
	window: { start: string; end: string },
): Task {
	const evidence: Evidence[] = [];
	const start = Date.parse(window.start);
	const end = Date.parse(window.end);
	const operationStarts = new Map<string, string>();
	let unknownStart: string | null = null;
	let ambiguousUnknown = false;
	let waitingSince: string | null = null;
	const add = (
		stage: Evidence["stage"],
		state: Evidence["state"],
		at: Date,
		options: {
			startedAt?: string | null;
			finishedAt?: string | null;
			errorCode?: string | null;
		} = {},
	) => {
		if (at.getTime() < start || at.getTime() >= end) return;
		const startedAt = options.startedAt ?? null;
		const finishedAt = options.finishedAt ?? null;
		const elapsed =
			startedAt && finishedAt
				? Date.parse(finishedAt) - Date.parse(startedAt)
				: null;
		evidence.push({
			stage,
			state,
			observedAt: at.toISOString(),
			startedAt,
			finishedAt,
			durationMs: elapsed !== null && elapsed >= 0 ? elapsed : null,
			errorCode: options.errorCode ?? null,
		});
	};
	add("acceptance", "accepted", task.createdAt);
	for (const fact of facts) {
		const { kind, state, at, code } = fact;
		if (kind === "model" || kind === "tool") {
			if (!fact.operationRef || !fact.attemptRef) continue;
			const key = JSON.stringify([kind, fact.operationRef, fact.attemptRef]);
			if (state === "started") {
				const observedStart = instant(fact.startedAt);
				if (observedStart) operationStarts.set(key, observedStart);
				add(kind, state, at, { startedAt: observedStart });
			}
			if (state === "completed" || state === "failed" || state === "unknown") {
				const pairedStart = operationStarts.get(key) ?? null;
				add(kind, state, at, {
					startedAt:
						pairedStart &&
						(!fact.startedAt || instant(fact.startedAt) === pairedStart)
							? pairedStart
							: null,
					finishedAt: state === "unknown" ? null : instant(fact.finishedAt),
					errorCode:
						state === "failed" && code && operationCodes.has(code)
							? code
							: null,
				});
				if (state !== "unknown") operationStarts.delete(key);
			}
			continue;
		}
		if (kind === "dispatch-failure" || kind === "runtime-error") {
			const allowed =
				code &&
				(isExactExecutionFailureCodeV1(code) ||
					(kind === "runtime-error" &&
						(code === "RUNTIME_EXECUTION_FAILED" ||
							code === "RUNTIME_DEPENDENCY_UNAVAILABLE")));
			add(kind === "dispatch-failure" ? "dispatch" : "runtime", "failed", at, {
				errorCode: allowed ? code : null,
			});
			continue;
		}
		if (kind !== "task.status" && kind !== "execution.status") continue;
		if (state === "unknown") {
			if (unknownStart) {
				ambiguousUnknown = true;
				add("verification", "unknown", new Date(unknownStart), {
					startedAt: unknownStart,
				});
			}
			unknownStart = at.toISOString();
			continue;
		}
		if (
			state !== "waiting" &&
			state !== "submitted" &&
			state !== "processing" &&
			state !== "completed" &&
			state !== "failed" &&
			state !== "cancelled"
		)
			continue;
		if (unknownStart) {
			add(
				"verification",
				"unknown",
				at.getTime() >= end ? new Date(unknownStart) : at,
				{
					startedAt: unknownStart,
					finishedAt: ambiguousUnknown ? null : at.toISOString(),
				},
			);
			unknownStart = null;
			ambiguousUnknown = false;
		}
		if (state === "waiting") {
			waitingSince = at.toISOString();
			add("queue", state, at);
		} else if (state === "submitted") {
			if (waitingSince)
				add("queue", "completed", at, {
					startedAt: waitingSince,
					finishedAt: at.toISOString(),
				});
			waitingSince = null;
			add("dispatch", state, at);
		} else if (state === "processing") {
			waitingSince = null;
			add("execution", state, at);
		} else if (kind === "task.status" && state === "failed") {
			add("queue", state, at, {
				errorCode: code && queueCodes.has(code) ? code : null,
			});
		}
	}
	const open = task.unknownSince?.toISOString() ?? unknownStart;
	if (open) add("verification", "unknown", new Date(open), { startedAt: open });
	if (
		task.terminalAt &&
		(task.status === "completed" ||
			task.status === "failed" ||
			task.status === "cancelled")
	) {
		add("result", task.status, task.terminalAt, {
			finishedAt: task.terminalAt.toISOString(),
		});
	}
	evidence.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
	return { executionId: task.executionId, status: task.status, evidence };
}
