import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout } from "node:timers/promises";

export interface ExecutorProcessGroupV1 {
	readonly leader: number;
	readonly parent: number;
	readonly parentStartTicks: string;
	readonly startTicks: string;
}

interface ProcessStatus {
	readonly state: string;
	readonly parent: number;
	readonly group: number;
	readonly startTicks: string;
}

let reapOrphan: ((pid: number) => void) | undefined;
const nativeServers = new Set<number>();

/** Node owns waitpid for its native servers; only adopted tools are reaped here. */
export function retainExecutorServerV1(pid: number) {
	nativeServers.add(pid);
	return () => {
		nativeServers.delete(pid);
	};
}

/** Orphans remain children of this trusted runner even after setsid and double fork. */
export function trackExecutorDescendantsV1() {
	if (reapOrphan) return;
	if (process.platform !== "linux")
		throw new Error("CODEX_EXECUTOR_DESCENDANTS_UNAVAILABLE");
	const koffi = createRequire(import.meta.url)(
		"koffi",
	) as typeof import("koffi");
	const libc = koffi.load("libc.so.6");
	const set = libc.func("prctl", "int", [
		"int",
		"unsigned long",
		"unsigned long",
		"unsigned long",
		"unsigned long",
	]);
	const get = libc.func("prctl", "int", [
		"int",
		"_Out_ int *",
		"unsigned long",
		"unsigned long",
		"unsigned long",
	]);
	const setChildSubreaper = 36;
	const getChildSubreaper = 37;
	const current = [0];
	if (
		set(setChildSubreaper, 1, 0, 0, 0) !== 0 ||
		get(getChildSubreaper, current, 0, 0, 0) !== 0 ||
		current[0] !== 1
	)
		throw new Error("CODEX_EXECUTOR_DESCENDANTS_UNAVAILABLE");
	const wait = libc.func("waitpid", "int", ["int", "_Out_ int *", "int"]);
	reapOrphan = (pid) => {
		wait(pid, [0], 1);
	};
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

export async function executorProcessStartTicksV1(pid: number) {
	const status = await procStatus(pid);
	if (!status) throw new Error("CODEX_EXECUTOR_PROCESS_IDENTITY_INVALID");
	return status.startTicks;
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
	for (const pid of await executorChildPids(parent)) {
		const status = await procStatus(pid);
		if (status?.parent === parent) result.set(pid, status);
	}
	return result;
}

async function executorChildPids(parent: number) {
	const tasks = await readdir(`/proc/${parent}/task`);
	// Orphans are reparented to the live main thread; read it after the other threads.
	tasks.sort(
		(left, right) =>
			Number(left === String(parent)) - Number(right === String(parent)),
	);
	if (tasks.length > 4096) throw new Error("CODEX_EXECUTOR_STILL_DRAINING");
	const children = new Set<number>();
	for (const task of tasks) {
		const ids = await readFile(`/proc/${parent}/task/${task}/children`, "utf8");
		for (const id of ids.trim().split(/\s+/))
			if (id) {
				children.add(Number(id));
				if (children.size > 4096)
					throw new Error("CODEX_EXECUTOR_STILL_DRAINING");
			}
	}
	return children;
}

/** The platform-owned launch wrapper pauses before exec, so a tool cannot lose its leader before registration. */
export async function waitForExecutorProcessGroupV1(
	parent: number,
	baseline: ReadonlyMap<number, ProcessStatus>,
	deadline: number,
	parentStartTicks?: string,
): Promise<ExecutorProcessGroupV1 | null> {
	trackExecutorDescendantsV1();
	const parentIdentity =
		parentStartTicks ?? (await executorProcessStartTicksV1(parent));
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
			return {
				leader: candidate[0],
				parent,
				parentStartTicks: parentIdentity,
				startTicks: candidate[1].startTicks,
			};
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
		group.parent !== parent ||
		(await procStatus(parent))?.startTicks !== group.parentStartTicks ||
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
		const descendantsExited = await executorDescendantsExited(group);
		try {
			process.kill(-group.leader, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
			if (descendantsExited) return true;
		}
		await setTimeout(20);
	}
	return false;
}

/** Rejected launches have no PGID; still prove the original server's entire descendant scope empty. */
export async function waitForExecutorDescendantsExitV1(
	parent: number,
	parentStartTicks: string,
	deadline: number,
) {
	while (Date.now() < deadline) {
		if (await executorDescendantsExited({ parent, parentStartTicks }))
			return true;
		await setTimeout(20);
	}
	return false;
}

async function executorDescendantsExited(
	group: Pick<ExecutorProcessGroupV1, "parent" | "parentStartTicks"> & {
		leader?: number;
	},
) {
	if (
		!reapOrphan ||
		(await procStatus(group.parent))?.startTicks !== group.parentStartTicks
	)
		return false;
	// Read the native server before its subreaper: an orphan cannot fall between the two checks.
	if (
		group.parent !== process.pid &&
		(await executorChildPids(group.parent)).size
	)
		return false;
	const children = await executorChildPids(process.pid);
	let empty = true;
	for (const pid of children) {
		if (group.parent !== process.pid && pid === group.parent) continue;
		// Even an already-gone PID makes this sample unproven: never discard an exit observed mid-scan.
		empty = false;
		const status = await procStatus(pid);
		if (
			status?.state === "Z" &&
			pid !== group.leader &&
			!nativeServers.has(pid)
		)
			reapOrphan(pid);
	}
	return (
		empty &&
		(await procStatus(group.parent))?.startTicks === group.parentStartTicks
	);
}

/** Signal only this runner's descendants, preserving the private server for native result recovery. */
export async function terminateExecutorDescendantsV1(
	backendPid: number,
	deadline: number,
) {
	if (!reapOrphan) throw new Error("CODEX_EXECUTOR_DESCENDANTS_UNAVAILABLE");
	let visited = 0;
	const reap = reapOrphan;
	const visit = async (parent: number) => {
		if (++visited > 4096 || Date.now() >= deadline)
			throw new Error("CODEX_EXECUTOR_STILL_DRAINING");
		for (const [pid, status] of await executorChildrenV1(parent)) {
			if (pid === backendPid) {
				await visit(pid);
				continue;
			}
			if (nativeServers.has(pid)) continue;
			await visit(pid).catch((error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
			});
			const current = await procStatus(pid);
			if (current?.startTicks !== status.startTicks) continue;
			if (current.state === "Z" && current.parent === process.pid) {
				reap(pid);
			} else {
				try {
					process.kill(pid, "SIGKILL");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
			}
		}
	};
	await visit(process.pid);
}
