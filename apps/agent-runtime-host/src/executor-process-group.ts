import { readdir, readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";

export interface ExecutorProcessGroupV1 {
	readonly leader: number;
	readonly startTicks: string;
}

interface ProcessStatus {
	readonly state: string;
	readonly parent: number;
	readonly group: number;
	readonly startTicks: string;
}

async function procStatus(pid: number): Promise<ProcessStatus | null> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		const fields = stat
			.slice(stat.lastIndexOf(")") + 2)
			.trim()
			.split(/\s+/);
		const state = fields[0];
		const startTicks = fields[19];
		if (!state || !startTicks || !/^\d+$/.test(startTicks))
			throw new Error("CODEX_EXECUTOR_PROCESS_IDENTITY_INVALID");
		return {
			state,
			parent: Number(fields[1]),
			group: Number(fields[2]),
			startTicks,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

/** Snapshot the private exec-server's direct children before one serialized launch. */
export async function executorChildrenV1(parent: number) {
	if (
		process.platform !== "linux" ||
		!Number.isSafeInteger(parent) ||
		parent <= 1
	)
		throw new Error("CODEX_EXECUTOR_PROCESS_IDENTITY_INVALID");
	const result = new Map<number, ProcessStatus>();
	const entries = await readdir("/proc");
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		const status = await procStatus(pid);
		if (status?.parent === parent) result.set(pid, status);
	}
	return result;
}

/** The platform-owned launch wrapper pauses before exec, so a tool cannot lose its leader before registration. */
export async function waitForExecutorProcessGroupV1(
	parent: number,
	baseline: ReadonlyMap<number, ProcessStatus>,
	deadline: number,
): Promise<ExecutorProcessGroupV1 | null> {
	while (Date.now() < deadline) {
		const candidates = [...(await executorChildrenV1(parent))].filter(
			([pid, status]) =>
				status.state === "T" &&
				status.group === pid &&
				baseline.get(pid)?.startTicks !== status.startTicks,
		);
		if (candidates.length > 1) return null;
		const candidate = candidates[0];
		if (candidate)
			return { leader: candidate[0], startTicks: candidate[1].startTicks };
		await setTimeout(10);
	}
	return null;
}

export async function continueExecutorProcessGroupV1(
	parent: number,
	group: ExecutorProcessGroupV1,
) {
	const status = await procStatus(group.leader);
	if (
		status?.state !== "T" ||
		status.parent !== parent ||
		status.group !== group.leader ||
		status.startTicks !== group.startTicks
	)
		throw new Error("CODEX_EXECUTOR_PROCESS_IDENTITY_INVALID");
	process.kill(group.leader, "SIGCONT");
}

/** A successful signal request is not evidence that any member has exited. */
export async function waitForExecutorProcessGroupExitV1(
	group: ExecutorProcessGroupV1,
	deadline: number,
) {
	if (
		process.platform !== "linux" ||
		!Number.isSafeInteger(group.leader) ||
		group.leader <= 1
	)
		return false;
	while (Date.now() < deadline) {
		try {
			process.kill(-group.leader, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
			return false;
		}
		await setTimeout(20);
	}
	return false;
}
